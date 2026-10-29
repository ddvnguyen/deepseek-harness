/** One-shot cold session read through the handle-based persistence seam. */

import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionExternalWriterProbe, SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence'

/** A stored session log balanced for read-only viewing. */
export interface ColdSessionLog {
  /** Aliasing state of the persisted events; synthetic closers are locally owned. */
  readonly eventState: SessionSeedEventState
  /** The stored header, fixed when the read handle opened. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffset
  /**
   * Whether the read saw a live external writer ({@link SessionPersistence.writeLease}):
   * true means the stored events were returned unbalanced — the open final
   * turn belongs to that live writer, so a reused cache entry must probe
   * again before every reuse.
   */
  readonly liveWriter: boolean
  /** Stored events plus deterministic in-memory closers for an interrupted final turn; nothing is written back. */
  readonly events: SessionEvent[]
}

/**
 * Read one complete stored session log without taking ownership or mutating
 * storage: open a read handle, read the validated contiguous log, close the
 * handle, and append `interruptedTurnClosers` so a log whose writer crashed
 * mid-turn folds as a balanced transcript. A live external writer keeps the
 * read untouched: when the lease probe ({@link SessionPersistence.writeLease})
 * still reports a live writer, the open final turn stays open — it belongs to
 * that writer's in-flight turn, not an exit. Backend failures propagate
 * unmapped — each caller owns its error taxonomy.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the stored session to read.
 * @param signal - optional cancellation for the open and read work.
 * @returns an adoptable seed in a caller-owned outer array, ready for in-place Session restoration.
 */
export async function readColdSessionLog(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await persistence.open(sessionId, 'read', options)
  let read: SessionHandleReadResult
  try {
    read = await handle.read(0, undefined, options)
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // The read failure is the actionable cause; a close failure on the same broken handle adds nothing.
    }
    throw error
  }
  await handle.close()
  const { events } = read
  // A throwaway probe failure leaves liveness unanswerable, not settled: the
  // call falls back to today's balanced read rather than discarding the log
  // the open handle already served.
  let writer: SessionExternalWriterProbe | undefined
  try {
    writer = await persistence.writeLease(sessionId, options)
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    writer = undefined
  }
  const liveWriter = writer?.running === true
  return {
    eventState: read.eventState,
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    liveWriter,
    events: liveWriter
      ? [...events]
      : [...events, ...interruptedTurnClosers(events)],
  }
}
