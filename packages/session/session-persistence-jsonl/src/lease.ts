/**
 * Cross-process write-ownership lock for one session's artifact directory,
 * held for the whole life of a write handle. The arbiter is the kernel:
 * POSIX takes a non-blocking `flock(2)` via native system support on `session.lock`
 * beside the log, and Windows holds a named kernel semaphore derived from
 * that path — never a file lock or handle, so readers, searches, and
 * directory removal proceed freely while the lock is held. Contention maps
 * to `SessionAlreadyOwnedError`; the kernel releases the lock when the
 * holder's descriptor or last object handle closes, including on any process
 * death, so a crashed holder never blocks a successor. A live but wedged
 * holder keeps the lock until its process exits: there is deliberately no
 * expiry that could expropriate a stalled writer whose resumed appends would
 * tear the log.
 * A POSIX lock names an inode, not a path, so after locking the holder
 * verifies the locked inode is still the file at the lock path and retries
 * otherwise: an unlinked-and-recreated lock file carries a fresh inode, and
 * a lock on the orphaned one proves nothing. Removing a live session's lock
 * file therefore forfeits exclusion on POSIX (nothing in the harness does
 * so); Windows has no lock file at all. Readers never touch the lock.
 * The lock is acquired at write-open of an existing artifact and, for a
 * created session, only right before its first materializing write — an
 * unmaterialized session has no filesystem footprint. Release never removes
 * the POSIX lock file: every acquired lock belongs to a materialized or
 * materializing session, and the surviving file keeps the stable inode later
 * lockers verify against. The browser worker stubs the native flock entry to
 * immediate success: it is single-process, so the in-process write claim
 * already excludes every writer.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/lease
 */

import { mkdir, open, readFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import type { SessionExternalWriterProbe } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** Base name of the kernel lock file inside a session's artifact directory. */
export const LEASE_FILENAME = 'session.lock'

/**
 * The holder record a release writes into the surviving lock file. The file
 * and inode both stay (see {@link SessionWriteLease.release}); the marker is
 * what turns the reader-side lease probe into a settled "not running" instead
 * of a grace-window guess.
 */
export const LEASE_RELEASE_RECORD = '0\n'

/**
 * Process environment variable whose single-line value names the external
 * producer of this harness process (for example an external run bridge: an
 * opaque label such as "Multica run M-142"). The bridge sets it; the harness
 * only records it — in the lock file it acquires and as the additive
 * `externalOwner` session header field its create path stamps.
 */
const SESSION_OWNER_ENV = 'DSH_SESSION_OWNER'

/** Bounded owner label: long enough for a run identifier, short enough to stay one line. */
const OWNER_LABEL_MAX = 100

/** How long a record-less lock file's fresh mtime may still claim a live holder. */
const LEASE_MTIME_GRACE_MS = 60_000

/** Highest probe-eligible PID: positive, at most int32 (matching the atomic-write lock contract). */
const OWNER_PID_MAX = 0x7fffffff

/** The held kernel lock: a POSIX descriptor or a Win32 semaphore handle. */
type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

/** Whether a flock failure means another descriptor holds the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // flock(2) reports EAGAIN; some libcs spell it EWOULDBLOCK.
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * The single-line owner label of this process's {@link SESSION_OWNER_ENV}, or
 * undefined without a usable value: collapse forbidden line separators to
 * spaces, trim, and cap the length so a hostile value can never split the
 * record across lines.
 */
function sessionOwnerLabel(): string | undefined {
  const raw = process.env[SESSION_OWNER_ENV]
  if (raw === undefined) return undefined
  const label = raw.replace(/[\v\f\n\r\u2028\u2029]+/gu, ' ').trim().slice(0, OWNER_LABEL_MAX)
  return label === '' ? undefined : label
}

/** The full lock record this process acquires with: `<pid>\\n` plus the optional owner label line. */
function holderRecord(): string {
  const label = sessionOwnerLabel()
  return label === undefined
    ? `${process.pid}\n`
    : `${process.pid}\n${label}\n`
}

/**
 * Parse one acquired-holder record. The first line is the decimal PID; a
 * second line is the owner label. Returns undefined when no PID line exists
 * (a torn write proves nothing about its holder).
 */
function parseHolderRecord(record: string): { pid: number; owner: string | undefined } | undefined {
  const newline = record.indexOf('\n')
  if (newline < 0) return undefined
  const pidLine = record.slice(0, newline)
  if (!/^\d+$/.test(pidLine)) return undefined
  const pid = Number(pidLine)
  const owner = record.slice(newline + 1).split('\n', 1)[0]
  return { pid, owner: owner === '' ? undefined : owner }
}

/**
 * One held write lock. Constructed only by {@link SessionWriteLease.acquire};
 * `release` closes the descriptor or handle, which is what releases the lock.
 */
export class SessionWriteLease {
  private released = false

  private constructor(private readonly held: HeldLock) {}

  /**
   * Acquire the session directory's kernel write lock.
   * @param dir - the session's artifact directory (created if absent).
   * @param id - the session the lock guards, for error identities.
   * @returns the held lock.
   * @throws {SessionAlreadyOwnedError} while another holder keeps the lock.
   */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    const path = join(dir, LEASE_FILENAME)
    // Owner-only like materializePosix's directories: the lock may create the
    // session directory first, and both creators must agree on the mode.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      let handle: number
      try {
        handle = await acquireLockHandleWin32(path)
      } catch (error: unknown) {
        // Sharing violation: another handle already holds the write exclusion.
        if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') throw new SessionAlreadyOwnedError(id)
        throw error
      }
      return new SessionWriteLease({ kind: 'win32', handle })
    }
    /* v8 ignore stop */
    // Bounded retry: locking an inode a releasing creator just unlinked (or a
    // recreated path) re-opens the fresh file; steady state needs one pass.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Append mode, never truncate: a contending opener whose flock still
      // fails must not erase the live holder's record mid-probe.
      const handle = await open(path, 'a')
      try {
        try {
          await tryLockExclusive(handle.fd)
        } catch (error: unknown) {
          if (isLockContention(error)) throw new SessionAlreadyOwnedError(id)
          throw error
        }
        const held = await handle.stat({ bigint: true })
        const current = await stat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          // Under the held exclusion the file content is ours to own: replace
          // any residue with this holder's exact record (`<pid>` plus the
          // optional owner label). Truncate first; after it the zero-length
          // file makes append-mode and positional writes agree.
          await handle.truncate(0)
          await handle.write(holderRecord(), 0)
          return new SessionWriteLease({ kind: 'posix', handle })
        }
      } catch (error: unknown) {
        await handle.close()
        throw error
      }
      // The locked inode is no longer the file at the lock path: start over
      // against whatever now stands there.
      await handle.close()
    }
    throw new SessionAlreadyOwnedError(id)
  }

  /**
   * Release the kernel lock by closing its descriptor or handle. Before that
   * point the POSIX record is replaced with {@link LEASE_RELEASE_RECORD} so
   * the reader-side lease probe settles on "not running" instead of riding
   * the mtime grace; the write is best-effort (a failed marker write still
   * releases the kernel lock, and the probe then falls back to the pid and
   * mtime rules). The POSIX lock file is never removed: every acquired lock
   * belongs to a materialized or materializing session, and keeping the file
   * preserves the stable inode later lockers verify against. Idempotent.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (this.held.kind === 'win32') {
      await releaseLockHandleWin32(this.held.handle)
      return
    }
    /* v8 ignore stop */
    try {
      await this.held.handle.truncate(0)
      await this.held.handle.write(LEASE_RELEASE_RECORD, 0)
    } catch {
      // The marker only improves the probe; the closing close() releases the
      // kernel lock regardless.
    }
    await this.held.handle.close()
  }
}

/**
 * Probe whether an external process plausibly still holds the write lock on
 * one session directory. Decision order (the same contract
 * `packages/util/atomic-write` pins for its own `<pid>` records):
 *
 * 1. the release marker — released, not running;
 * 2. a positive int32 PID record — the primary rule: `process.kill(pid, 0)`
 *    alive (or alive-under-another-user) means running, `ESRCH` means the
 *    holder exited and the session is not running;
 * 3. a missing, torn, or invalid-pid record — means nothing (its holder may
 *    be about to write it, or died before finishing) — fall back to the lock
 *    file's mtime: inside {@link LEASE_MTIME_GRACE_MS}, running; otherwise
 *    not.
 *
 * A removed or unreadable lock file proves nothing and reports
 * `undefined`; Windows reports `undefined` — its lock has no file, so
 * external liveness is unanswerable there and consumers fall back to
 * today's read-only behavior.
 * @param dir - the session's artifact directory.
 * @returns the live external-writer probe, or `undefined` when the lease is
 *   released, expired, or unanswerable.
 */
export async function externalWriterLeaseProbe(
  dir: string,
): Promise<SessionExternalWriterProbe | undefined> {
  let record: string
  try {
    record = await readFile(join(dir, LEASE_FILENAME), 'utf8')
  } catch {
    // Absent (released-by-successor creation, Windows semaphore, or
    // never-materialized session) or unreadable: no live external writer is
    // proven.
    return undefined
  }
  if (record === LEASE_RELEASE_RECORD) return undefined
  const held = parseHolderRecord(record)
  if (held !== undefined) {
    const { pid, owner } = held
    if (pid > 0 && pid <= OWNER_PID_MAX) {
      const ownerRecord = owner === undefined ? {} : { owner }
      if (pid === process.pid) return { running: true, ...ownerRecord }
      try {
        process.kill(pid, 0)
        return { running: true, ...ownerRecord }
      } catch (error) {
        // A proven death settles the decision; every other refusal (EPERM:
        // alive under another user; misconfigured signal rights) leaves the
        // holder standing.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
        return { running: true, ...ownerRecord }
      }
    }
  }
  // No usable holder record: ride the mtime grace. Torn, pid-less, or
  // invalidated records still mean an acquisition was (or may be) in flight
  // recently; age settles it.
  const lockNanoTimestamp = BigInt(Date.now()) * 1_000_000n
  try {
    const lockIdentity = await stat(join(dir, LEASE_FILENAME), { bigint: true })
    const ageNs = lockNanoTimestamp - lockIdentity.mtimeNs
    if (ageNs <= BigInt(LEASE_MTIME_GRACE_MS) * 1_000_000n) {
      return { running: true }
    }
    return undefined
  } catch {
    return undefined
  }
}
