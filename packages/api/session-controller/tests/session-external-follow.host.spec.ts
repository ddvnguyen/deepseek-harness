/**
 * External-writer follow: a held run of another process overrides its own
 * durable log and the open follow delivers its appends, reports the liveness
 * transition, and settles the interrupted closers when the lease dies.
 */

import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HistoryController } from '@deepseek-ai/dsh-api-session-controller/src/history/controller.ts'
import { WebController } from '@deepseek-ai/dsh-api-session-controller/src/web/controller.ts'
import { SessionPersistenceRevision, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionExternalWriterProbe,
  SessionHandle,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { installSessionReadTestServices } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function event(type: string, seq: SessionSeq, text: string): SessionEvent {
  return {
    type,
    seq,
    time: Number(seq) + 10,
    ...(type === 'user/message' ? {
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    } : type === 'assistant/message' ? {
      // A tool-call-free assistant row satisfies the interrupted-turn
      // recovery; the durable message shape is validated by the store.
      data: { message: { role: 'assistant', content: [] } },
      surfaceOp: 'append',
    } : { data: Number(seq) === 0 ? { turn: 1 } : {} }),
  } as SessionEvent
}

interface ExternalStore {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
  revision: string
  liveWriter: boolean
  owner: string | null
  processId?: number
}

/** Persistence double serving one session's evolving store, with the countable probe. */
function provideExternalPersistence(
  ctx: Context,
  store: ExternalStore,
  hooks: { probes?: (probes: { n: number }) => void; ignoreAbort?: boolean } = {},
): { probes: { n: number }; stopPersistence: () => void } {
  const probes = { n: 0 }
  const persistence = {
    open: (sessionId: SessionId, access: SessionAccess): Promise<SessionHandle> => {
      if (sessionId !== store.header.id) return Promise.reject(new SessionPersistenceNotFoundError(sessionId))
      return Promise.resolve({
        id: sessionId,
        header: store.header,
        inheritedEventCount: SessionLogOffset(0),
        access,
        read: (offset = 0) => Promise.resolve({
          eventState: 'detached',
          events: store.events.slice(offset),
        }),
        append: () => Promise.reject(new Error('test read-only')),
        flush: () => Promise.reject(new Error('test read-only')),
        close: () => Promise.resolve(),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      })
    },
    stat: async (
      _sessionId: SessionId,
      options?: SessionPersistenceStatOptions,
    ): Promise<SessionPersistenceSnapshot | undefined> => {
      if (hooks.ignoreAbort !== true) options?.signal?.throwIfAborted()
      return { header: store.header, revision: SessionPersistenceRevision(store.revision) }
    },
    writeLease: async (): Promise<SessionExternalWriterProbe | undefined> => {
      hooks.probes?.(probes)
      probes.n += 1
      if (!store.liveWriter) return Promise.resolve(undefined)
      return Promise.resolve({ running: true, ...(store.processId === undefined ? {} : { processId: store.processId }),
        ...(store.owner === null ? {} : { owner: store.owner }) })
    },
  }
  const stopPersistence = ctx.provide('sessionPersistence', persistence as never)
  return { probes, stopPersistence }
}

async function setup(
  store: ExternalStore,
  hooks: { probes?: (probes: { n: number }) => void; ignoreAbort?: boolean } = {},
): Promise<{
  ctx: Context
  transport: WebController
  statuses: Array<{ sessionId: SessionId; running: boolean; owner: string | null | undefined }>
  probes: { n: number }
  stopPersistence: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const { probes, stopPersistence } = provideExternalPersistence(ctx, store, hooks)
  const history = new HistoryController(ctx)
  const transport = new WebController(ctx, history, (observation) => { observation[Symbol.dispose]() })
  const statuses: Array<{ sessionId: SessionId; running: boolean; owner: string | null | undefined }> = []
  ctx.on('api-session/status', (sessionId, running, owner) => {
    statuses.push({ sessionId, running, owner })
  })
  return { ctx, transport, statuses, probes, stopPersistence }
}
describe('external-writer follow tail', () => {
  it('rejects a discontinuous external history instead of delivering a skipped event', async () => {
    const store: ExternalStore = {
      header: { version: SESSION_FORMAT_VERSION, id: sid('sparse-external-store'), createdAt: 1, cwd: '/proj', isSeeded: false },
      events: [], revision: 'r1', liveWriter: true, owner: 'bridge-a',
    }
    const { ctx, transport } = await setup(store)
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId: store.header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot' } })
    store.events.length = 2
    store.events[1] = event('user/message', SessionSeq(1), 'missing predecessor')
    store.revision = 'r2'
    await expect(iterator.next()).rejects.toThrow('session event stream skipped seq 0')
    abort.abort()
    await ctx.fiber.dispose()
  })

  it('stops cleanly if persistence is removed while a follow poll is in flight', async () => {
    const store: ExternalStore = {
      header: { version: SESSION_FORMAT_VERSION, id: sid('removed-external-store'), createdAt: 1, cwd: '/proj', isSeeded: false },
      events: [], revision: 'r1', liveWriter: true, owner: 'bridge-a',
    }
    let stopPersistence: () => void = () => {}
    const { ctx, transport, statuses, stopPersistence: stop } = await setup(store, {
      probes: (count) => { if (count.n === 1) stopPersistence() },
    })
    stopPersistence = stop
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId: store.header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot' } })
    const pending = iterator.next()
    await vi.waitFor(() => { expect(statuses).toContainEqual({ sessionId: store.header.id, running: true, owner: 'bridge-a' }) })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it.each([new Error('timer unavailable'), 'timer unavailable'])('keeps the stream cancellable when scheduling fails with %s', async (failure) => {
    const store: ExternalStore = {
      header: { version: SESSION_FORMAT_VERSION, id: sid('poll-scheduler-failure'), createdAt: 1, cwd: '/proj', isSeeded: false },
      events: [], revision: 'r1', liveWriter: true, owner: 'bridge-a',
    }
    const { ctx, transport } = await setup(store)
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId: store.header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot' } })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => { throw failure })
    const pending = iterator.next()
    try {
      for (let step = 0; step < 50 && warn.mock.calls.length === 0; step += 1) await Promise.resolve()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timer unavailable'))
    } finally {
      timer.mockRestore()
      abort.abort()
      await expect(pending).resolves.toMatchObject({ done: true })
      await ctx.fiber.dispose()
    }
  })

  it('stops following when a non-cooperative persistence backend completes after cancellation', async () => {
    const store: ExternalStore = {
      header: { version: SESSION_FORMAT_VERSION, id: sid('abort-external-poll'), createdAt: 1, cwd: '/proj', isSeeded: false },
      events: [], revision: 'r1', liveWriter: true, owner: null,
    }
    const abort = new AbortController()
    const { ctx, transport } = await setup(store, {
      ignoreAbort: true,
      probes: (count) => { if (count.n === 1) abort.abort('cancelled') },
    })
    const iterator = transport.follow({ address: { kind: 'session', sessionId: store.header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot' } })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it.each([new Error('temporary probe refusal'), 'temporary probe refusal'])('survives a transient lease polling failure %s', async (failure) => {
    const store: ExternalStore = {
      header: { version: SESSION_FORMAT_VERSION, id: sid('retry-external-poll'), createdAt: 1, cwd: '/proj', isSeeded: false },
      events: [], revision: 'r1', liveWriter: true, owner: 'bridge-a',
    }
    let refused = false
    const { ctx, transport, statuses, probes } = await setup(store, {
      probes: (count) => {
        if (count.n === 1 && !refused) {
          refused = true
          throw failure
        }
      },
    })
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId: store.header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot' } })
    const pending = iterator.next()
    await vi.waitFor(() => { expect(refused).toBe(true) })
    await vi.waitFor(() => { expect(probes.n).toBeGreaterThan(1) }, { timeout: 5000 })
    expect(statuses).toContainEqual({ sessionId: store.header.id, running: true, owner: 'bridge-a' })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  }, 10000)

  it('does not poll an external lease while following a live local session', async () => {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sid('local-live'),
      createdAt: 1,
      cwd: '/proj',
      isSeeded: false,
      externalOwner: 'bridge-a',
    }
    const store: ExternalStore = {
      header,
      events: [],
      revision: 'r1',
      liveWriter: true,
      owner: 'bridge-a',
    }
    const { ctx, transport, statuses, probes } = await setup(store)
    const session = ctx.sessions.create(header.id, { meta: { cwd: '/proj' } })
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId: header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot' },
    })

    const next = iterator.next()
    session.append('turn/start', { turn: 1 })
    await expect(next).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'turn/start' } },
    })
    expect(probes.n).toBe(0)
    expect(statuses).toEqual([])

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('does not label a prepared writer in this process as external', async () => {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sid('same-process-writer'),
      createdAt: 1,
      cwd: '/proj',
      isSeeded: false,
    }
    const store: ExternalStore = {
      header,
      events: [],
      revision: 'r1',
      liveWriter: true,
      owner: null,
      processId: process.pid,
    }
    const { ctx, transport, statuses, probes } = await setup(store)
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId: header.id } }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot' } })
    const pending = iterator.next()
    await expect.poll(() => probes.n).toBeGreaterThan(0)
    expect(statuses).toEqual([])
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('delivers external appends live, reports the liveness bit, and settles the interrupted closers on death', async () => {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sid('external-held'),
      createdAt: 1,
      cwd: '/proj',
      isSeeded: false,
      externalOwner: 'bridge-a',
    }
    const store: ExternalStore = {
      header,
      events: [event('turn/start', SessionSeq(0), ''), event('user/message', SessionSeq(1), 'held prompt')],
      revision: 'r1',
      liveWriter: true,
      owner: 'bridge-a',
    }
    const { ctx, transport, statuses } = await setup(store)
    const iterator = transport.follow({ address: { kind: 'session', sessionId: header.id } }, new AbortController().signal)
      [Symbol.asyncIterator]()
    const opening = await iterator.next()
    expect(opening.done).toBe(false)
    // The lease probe claims a live writer, so the open final turn stays
    // unbalanced in the opening snapshot.
    const snapshotEvents = (opening.value as { records: readonly { event: { type: string } }[] }).records
    expect(snapshotEvents.map(record => record.event.type)).toEqual(['turn/start', 'user/message'])

    // The held writer durably appends mid-turn.
    store.events.push(event('assistant/message', SessionSeq(2), 'held answer'))
    store.revision = 'r2'

    const appended = await iterator.next()
    expect((appended.value as { event: { type: string } }).event).toMatchObject({ type: 'assistant/message' })

    // The tail reported the live writer as the first transition; it delivered
    // no duplicate of the opening events.
    expect(statuses).toEqual([{ sessionId: header.id, running: true, owner: 'bridge-a' }])

    // The writer is killed mid-turn with no further appends: the revision
    // stays at r2, and the next tick settles the run by delivering the
    // interrupted turn closer.
    store.liveWriter = false

    const closer = await iterator.next()
    expect(closer.done).toBe(false)
    expect(closer.value).toMatchObject({ event: { type: 'turn/end', seq: 3 } })
    expect(statuses).toEqual([
      { sessionId: header.id, running: true, owner: 'bridge-a' },
      { sessionId: header.id, running: false, owner: null },
    ])
    await ctx.fiber.dispose()
  }, 20000)

  it('polls the lease once per interval, not in a busy loop', async () => {
    vi.useFakeTimers()
    try {
      const store: ExternalStore = {
        header: {
          version: SESSION_FORMAT_VERSION,
          id: sid('external-cold'),
          createdAt: 1,
          cwd: '/proj',
          isSeeded: false,
          externalOwner: 'bridge-a',
        },
        events: [event('turn/start', SessionSeq(0), ''), event('user/message', SessionSeq(1), 'settled prompt')],
        revision: 'r1',
        liveWriter: true,
        owner: null,
      }
      const seen: Array<{ n: number }> = []
      const { ctx, transport, probes } = await setup(store, { probes: (count) => { seen.push({ ...count }) } })
      const abort = new AbortController()
      const iterator = transport.follow({ address: { kind: 'session', sessionId: store.header.id } }, abort.signal)
        [Symbol.asyncIterator]()
      const opening = await iterator.next()
      expect(opening.done).toBe(false)

      // The journal stream the client keeps pending: the loop only runs while
      // a next() is outstanding, so keep one hanging for the whole watch.
      const pendingNext = iterator.next()
      // The pending next drives one tick (with its wait timer) synchronously; the counter has advanced one probe past the opening now.
      const afterOpening = probes.n

      // Five full poll intervals: a busy loop would keep probing thousands of
      // times inside the same virtual spans.
      const INTERVAL = 1_050
      for (let i = 0; i < 5; i += 1) {
        const before = probes.n
        await vi.advanceTimersByTimeAsync(INTERVAL)
        const advanced = probes.n - before
        // One probe observed per interval; after spuriously waking (timer
        // + notify, which yield again) it stays at least under 2 per interval.
        expect(advanced).toBeLessThanOrEqual(2)
        expect(advanced).toBeGreaterThanOrEqual(1)
      }
      // Bounded in total: about the number of intervals, not unbounded.
      expect(probes.n).toBeLessThanOrEqual(afterOpening + 5 * 2 + 1)
      expect(seen.length).toBe(probes.n)

      abort.abort()
      await expect(pendingNext).resolves.toMatchObject({ done: true })
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
