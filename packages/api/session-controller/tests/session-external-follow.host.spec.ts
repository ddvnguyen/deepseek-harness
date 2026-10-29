/**
 * External-writer follow: a held run of another process overrides its own
 * durable log and the open follow delivers its appends, reports the liveness
 * transition, and settles the interrupted closers when the lease dies.
 */

import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionHistoryController } from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
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
}

/** Persistence double serving one session's evolving store, with the countable probe. */
function provideExternalPersistence(ctx: Context, store: ExternalStore): void {
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
      options?.signal?.throwIfAborted()
      return { header: store.header, revision: SessionPersistenceRevision(store.revision) }
    },
    writeLease: async (): Promise<SessionExternalWriterProbe | undefined> => {
      if (!store.liveWriter) return Promise.resolve(undefined)
      return Promise.resolve(store.owner === null ? { running: true } : { running: true, owner: store.owner })
    },
  }
  ctx.provide('sessionPersistence', persistence as never)
}

async function setup(store: ExternalStore): Promise<{
  ctx: Context
  transport: SessionHistoryController
  statuses: Array<{ sessionId: SessionId; running: boolean; owner: string | null | undefined }>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  provideExternalPersistence(ctx, store)
  const transport = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
  const statuses: Array<{ sessionId: SessionId; running: boolean; owner: string | null | undefined }> = []
  ctx.on('api-session/status', (sessionId, running, owner) => {
    statuses.push({ sessionId, running, owner })
  })
  return { ctx, transport, statuses }
}
describe('external-writer follow tail', () => {
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
})
