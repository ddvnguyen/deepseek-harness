/**
 * The global `main` panels a plugin has asked the right Sidebar to render
 * beside, and the Session it named for that column.
 *
 * The column follows the Conversation: while a global panel fills the main
 * column no Session is on screen, so the panel seat draws nothing and every
 * command on `ctx.sidebarRight` has no surface to act on. A plugin that wants
 * the column next to its own panel opts in with
 * `ctx.sidebarRight.hostPanel(panelId)`, and both gates that read the panel —
 * the service's on-screen Session and the root seat's visibility — read this
 * one source, so hosting, releasing and a second host all land in one commit.
 *
 * Claims are counted, not merely present: two plugins may host the same panel,
 * and either one's disposer leaves the other's claim standing. Releasing the
 * last claim while the panel is active hides the column exactly as a panel that
 * was never hosted does.
 *
 * A hosted panel fills the main column, so no Conversation names its Workspace:
 * the column would otherwise show whatever Session the Conversation last
 * selected. `ctx.sidebarRight.selectHostedSession` names that Session instead,
 * and both the service's on-screen Session and the root seat's retained views
 * read this one source, so a name set or withdrawn settles in one commit. The
 * name applies only while a panel that hosts the column is active; with the
 * Conversation in the main column the column keeps following the selection.
 */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The set no panel is in; shared so an unhosted product allocates nothing per read. */
const NO_PANELS: ReadonlySet<string> = new Set()

/** Hosted panels and the opt-in that moves the set. */
export class HostedPanels {
  /** Panels whose main panel hosts the column; a stable snapshot between changes. */
  readonly source: ObservableSnapshot<ReadonlySet<string>>
  /** The writable face the claims publish through; only `host` writes it. */
  private readonly store: SnapshotStore<ReadonlySet<string>>
  /**
   * The live claims per panel id; a panel is hosted while its cell counts one.
   * Every disposer holds its panel's cell, so releasing a claim reads the count
   * it shares with the other claims rather than a lookup that assumes an entry.
   */
  private readonly claims = new Map<string, { count: number }>()

  constructor() {
    this.store = createSnapshotStore<ReadonlySet<string>>(NO_PANELS)
    this.source = this.store
  }

  /**
   * Ask the column to render beside a global `main` panel.
   * @param panelId - the panel's `main` registration key.
   * @returns a disposer releasing this claim; other claims on the panel keep theirs.
   */
  host(panelId: string): () => void {
    let claim = this.claims.get(panelId)
    if (claim === undefined) {
      claim = { count: 0 }
      this.claims.set(panelId, claim)
    }
    claim.count += 1
    if (claim.count === 1) this.publish()
    let released = false
    return () => {
      // A disposer that runs twice must not release someone else's claim.
      if (released) return
      released = true
      claim.count -= 1
      if (claim.count > 0) return
      this.claims.delete(panelId)
      this.publish()
    }
  }

  private publish(): void {
    this.store.set(new Set(this.claims.keys()))
  }
}

/** The Session a plugin named for the hosted column, and the name's withdrawal. */
export class HostedSession {
  /** The named Session, or `undefined`; a stable snapshot between changes. */
  readonly source: ObservableSnapshot<SessionId | undefined>
  /** The writable face the name publishes through. */
  private readonly store: SnapshotStore<SessionId | undefined>

  constructor() {
    this.store = createSnapshotStore<SessionId | undefined>(undefined)
    this.source = this.store
  }

  /**
   * Name the Session the hosted column shows.
   * @param sessionId - Session whose Workspace the hosted panel edits.
   * @returns a disposer withdrawing this name while it is still the one in force.
   */
  select(sessionId: SessionId): () => void {
    this.store.set(sessionId)
    let released = false
    return () => {
      // A disposer that runs twice must not withdraw a later plugin's name.
      if (released) return
      released = true
      if (this.store.getSnapshot() === sessionId) this.store.set(undefined)
    }
  }
}
