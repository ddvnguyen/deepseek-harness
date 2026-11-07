/** Web opening aggregation over one observation and a shared transforming buffer. */

import type { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { readColdSessionLog, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { HistoryController } from '../history/controller.ts'
import { addressId, rejectNotFound } from '../history.ts'
import { EventListener, ListenerBuffer } from '../history/listener.ts'
import { history, projections, resolveHistoryRequest, validateObservationAddress } from '../history/controller.ts'
import type { SessionFollowFrame, SessionFollowRequest } from '../types.ts'

/** Combines opening data and consumes transformed listener output from one queue. */
export class WebController {

  /**
   * @param ctx - Host context carrying Session queries and identity projections.
   * @param historyController - passive reading and listener construction.
   * @param promote - background activation requested before an opening snapshot is delivered.
   */
  constructor(
    private readonly ctx: Context,
    private readonly historyController: HistoryController,
    private readonly promote: (observation: SessionObservation) => void,
  ) {}

  /**
   * Open a history snapshot and follow uncovered history and assistant notifications.
   * @param request - Session identity, page budget, assistant output and optional activation (default false).
   * @param signal - cancellation for opening and streaming.
   * @returns an opening snapshot followed by uncovered queued increments.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const sessionId = addressId(request.address)
    const spec = resolveHistoryRequest(request)
    using queue = new ListenerBuffer<SessionFollowFrame>(this.ctx, signal)
    using listener = new EventListener(this.ctx, sessionId, signal, queue)
    const streams = this.historyController.streamsListener
    using assistantListener = request.assistantStream === true
      ? streams.bind(sessionId, signal, queue)
      : undefined
    using observation = await this.historyController.usingObservation({ sessionId, projection: true }, signal)
      .catch((error: unknown) => {
        if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
        throw error
      })
    validateObservationAddress(request.address, observation)
    const followsExternalOwner = observation.source === 'prepared'
    const snapshotRevision = observation.revision
    let opening: SessionFollowFrame = {
      type: 'snapshot',
      header: { ...observation.header },
      projections: projections(observation),
      ...history(observation, spec),
    }
    listener.setCursor(opening.cursor)
    if (assistantListener !== undefined) {
      const { baseline: assistantStream, ordinal } = assistantListener.snapshot()
      opening = { ...opening, assistantStream }
      assistantListener.setOrdinalCut(ordinal)
    }
    // Increments come from the queue, so the opening ends this lease in every branch;
    // activation continues on its own retained lease. Promotion starts before the opening is
    // delivered, so a consumer that stops after the snapshot still gets the activation it asked for.
    if (request.activate === true && !signal.aborted
      && observation.header.origin !== 'subagent' && observation.source === 'prepared') {
      const promotion = observation.retain()
      observation[Symbol.dispose]()
      try {
        this.promote(promotion)
      } catch (error: unknown) {
        promotion[Symbol.dispose]()
        throw error
      }
    } else {
      observation[Symbol.dispose]()
    }
    yield opening
    if (!followsExternalOwner) {
      yield* queue.items()
      return
    }
    const tailAbort = new AbortController()
    const abortTail = (): void => { tailAbort.abort(signal.reason) }
    signal.addEventListener('abort', abortTail, { once: true })
    const tail = this.followExternalWriter(
      sessionId, listener, opening.cursor + 1, snapshotRevision, tailAbort.signal,
    ).catch((error: unknown) => {
      if (!tailAbort.signal.aborted) {
        this.ctx.logger.warn(`external session follow "${sessionId}" stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    try {
      yield* queue.items()
    } finally {
      signal.removeEventListener('abort', abortTail)
      tailAbort.abort()
      await tail
    }
  }

  private async followExternalWriter(
    sessionId: SessionId,
    listener: EventListener,
    nextSeq: number,
    initialRevision: SessionPersistenceRevision | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    let revision = initialRevision
    let running = false
    let initialized = false
    while (!signal.aborted) {
      if (this.ctx.sessions.get(sessionId) !== undefined) return
      try {
        const probe = await persistence.writeLease(sessionId, { signal })
        const snapshot = await persistence.stat(sessionId, { signal })
        const probeRunning = probe?.running === true
        const changed = snapshot?.revision !== revision
        const transitioned = probeRunning !== running
        if (changed || transitioned) {
          nextSeq = await this.appendPersistedSuffix(sessionId, listener, nextSeq, signal) + 1
        }
        if (transitioned || (!initialized && probeRunning)) {
          this.ctx.emit(
            'api-session/status',
            sessionId,
            probeRunning,
            probeRunning ? probe.owner ?? null : null,
          )
        }
        revision = snapshot?.revision
        running = probeRunning
        initialized = true
        if (!running) return
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') return
        this.ctx.logger.warn(
          `external session follow "${sessionId}" poll failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await waitForPoll(signal)
    }
  }

  private async appendPersistedSuffix(
    sessionId: SessionId,
    listener: EventListener,
    nextSeq: number,
    signal: AbortSignal,
  ): Promise<number> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return nextSeq - 1
    const log = await readColdSessionLog(persistence, sessionId, signal)
    const appended: SessionEvent[] = []
    const cursor = log.events.at(-1)?.seq ?? -1
    for (let seq = nextSeq; seq <= cursor; seq += 1) {
      const event = log.events[seq]
      if (event !== undefined) appended.push(event)
    }
    if (appended.length > 0) listener.appendExternal(appended)
    return cursor
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 1_000)
    const abort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Session follow was aborted', { cause: signal.reason })
}
