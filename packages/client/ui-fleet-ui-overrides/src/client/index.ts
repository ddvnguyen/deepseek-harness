/**
 * ui-fleet-ui-overrides client entry: registers every UI override on the
 * dsh web slot system —
 *
 * 1. FleetStatsLine into `conversation.composer.dock` (same cell id as the
 *    shipped StatsLine, so it shadows it) — shows context size instead of
 *    the input/output token figures.
 * 2. FleetContextMeter into `conversation.input.right` (same cell id as the
 *    shipped ring, `context-meter`) — the context-occupancy ring restored
 *    with a hover-open breakdown panel (system / tools / messages) in place
 *    of the click-open one and of the empty occupant that removed the ring.
 * 3. ContextSummaryRow into `trajectory.context.summary` — sticky context
 *    header on the Trajectory view (slot declared by DSH ui-trajectory).
 * 4. Global CSS injection (side-effect import of styles.module.css) — hides
 *    the Chat/Trajectory tab bar and slims the session header.
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-conversation's SlotMap merge ('conversation.composer.dock',
// 'conversation.input.right') and its LocaleNamespaceMap merge ('conversation')
// into this program so the register calls and the `t: TranslateNS<'conversation'>`
// seat type-check; ui-trajectory merges the 'trajectory.context.summary' row
// (added by the parallel DSH-fork change); ui-settings rides the settings-
// family seam.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { FleetContextMeter } from './FleetContextMeter.tsx'
import { FleetStatsLine } from './FleetStatsLine.tsx'
import { ContextSummaryRow } from './ContextSummaryRow.tsx'
// Side-effect import: the client bundler extracts module CSS and injects a
// plugin-owned <style> tag at factory execution (removed on unload), which
// is what ships the global tab-hiding / header-slimming rules below.
import './styles.module.css'

/** Required services: the slot registry only. */
export const inject = ['slots']

/**
 * Register all overrides. Shadowing cells (the StatsLine and the ContextMeter
 * ring) register at priority -1 — the slot registry renders a cell's LOWEST-
 * priority live entry, and a second registration at the same cell + same
 * priority (0) would throw. The core registers its entries during boot and
 * plugins load after, so -1 guarantees the override wins in any order; order
 * 0 is kept on the stats entry to preserve the shipped cell's display slot.
 */
export function apply(ctx: ClientContext): void {
  // Listen for click-to-Trajectory from the context ring. The tab bar is
  // hidden via CSS but the buttons remain in the DOM — clicking one calls
  // actions.setView('trajectory') through its onClick handler.
  if (typeof window !== 'undefined') {
    window.addEventListener('fleet:open-trajectory', () => {
      const tabs = document.querySelectorAll('[role="tab"]')
      for (const tab of tabs) {
        if (tab.textContent?.toLowerCase().includes('trajectory')) {
          (tab as HTMLElement).click()
          break
        }
      }
    })
    window.addEventListener('fleet:close-trajectory', () => {
      const tabs = document.querySelectorAll('[role="tab"]')
      for (const tab of tabs) {
        if (tab.textContent?.toLowerCase().includes('chat')) {
          (tab as HTMLElement).click()
          break
        }
      }
    })
  }

  // Hide the original DSH ContextMeter and reposition ours.
  // The original is hardcoded in InputBar after the model selector; our
  // FleetContextMeter is in the rightItems slot (before the model selector).
  // Move our meter to after the model selector to match the original position.
  if (typeof window !== 'undefined') {
    const positionMeter = () => {
      // Find our meter
      const fleetMeter = document.querySelector('[data-fleet-meter]')
      if (!fleetMeter) return
      const trailing = fleetMeter.closest('[class*="trailing"]')
      if (!trailing) return
      // Find the original ContextMeter and hide it
      const spans = trailing.querySelectorAll(':scope > span')
      for (const span of spans) {
        if (span !== fleetMeter && span.querySelector('button > svg circle')) {
          ;(span as HTMLElement).style.display = 'none'
        }
      }
      // Move our meter to after the model selector (second-to-last before stop button)
      const children = Array.from(trailing.children)
      const lastChild = children[children.length - 1]
      if (lastChild && fleetMeter.nextElementSibling !== lastChild) {
        trailing.insertBefore(fleetMeter, lastChild)
      }
    }
    const observer = new MutationObserver(positionMeter)
    observer.observe(document.body, { childList: true, subtree: true })
    positionMeter()
  }

  // Override StatsLine (same cell id 'stats'; this entry wins the cell).
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'stats',
    order: 0,
    priority: -1,
  }, FleetStatsLine))

  // The context-occupancy ring: replaces the empty occupant that removed the
  // ring with the fleet hover meter. The locale seat rides the conversation
  // namespace so the ring/panel labels localize with the rest of the
  // composer; priority -1 keeps the fleet entry winning the cell if the core
  // ever registers its own meter here (same shadowing rule as the stats line).
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'context-meter',
    order: 0,
    locale: 'conversation',
    priority: -1,
  }, FleetContextMeter))

  // Trajectory context summary. The inject waits for the declaration, so
  // this registers whenever the slot becomes live — safe both before the
  // DSH-fork change lands (no-op) and after (row mounts on the trajectory).
  ctx.slots.inject('trajectory.context.summary', () => ctx.slots.register({
    name: 'trajectory.context.summary',
    id: 'context-summary',
  }, ContextSummaryRow))
}
