/**
 * The global `main` panels a plugin has asked the right Sidebar to render
 * beside.
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
 */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The set no panel is in; shared so an unhosted product allocates nothing per read. */
const NO_PANELS: ReadonlySet<string> = new Set()

/** Hosted panels and the opt-in that moves the set. */
export class HostedPanels {
  /** Panels whose main panel hosts the column; a stable snapshot between changes. */
  readonly source: ObservableSnapshot<ReadonlySet<string>>
  /** The writable face the claims publish through; only `host` writes it. */
  private readonly store: SnapshotStore<ReadonlySet<string>>
  /** Live claims per panel id; a panel is hosted while its count is positive. */
  private readonly claims = new Map<string, number>()

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
    const claims = (this.claims.get(panelId) ?? 0) + 1
    this.claims.set(panelId, claims)
    if (claims === 1) this.publish()
    let released = false
    return () => {
      // A disposer that runs twice must not release someone else's claim.
      if (released) return
      released = true
      const remaining = (this.claims.get(panelId) ?? 0) - 1
      if (remaining > 0) {
        this.claims.set(panelId, remaining)
        return
      }
      this.claims.delete(panelId)
      this.publish()
    }
  }

  private publish(): void {
    this.store.set(new Set(this.claims.keys()))
  }
}
