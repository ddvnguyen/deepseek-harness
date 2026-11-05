/**
 * The two hosted-column sources, on their own (M-159).
 *
 * The apply spec covers them through the plugin; these cover the one rule the
 * plugin relies on and cannot easily arrange twice — a disposer that is called
 * again, or called after a newer claim replaced it, must leave the newer state
 * standing. Both classes publish one snapshot, so the assertions read that
 * snapshot rather than any internal map.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostedPanels, HostedSession } from '../src/client/hosted.ts'

describe('HostedPanels', () => {
  it('counts claims per panel and releases only the last one', () => {
    const hosted = new HostedPanels()
    const first = hosted.host('mmx')
    const second = hosted.host('mmx')
    expect([...hosted.source.getSnapshot()]).toEqual(['mmx'])
    // The first release leaves the second claim's host standing.
    first()
    expect([...hosted.source.getSnapshot()]).toEqual(['mmx'])
    second()
    expect([...hosted.source.getSnapshot()]).toEqual([])
  })

  it('does not release a second time when a disposer is called again', () => {
    const hosted = new HostedPanels()
    const release = hosted.host('mmx')
    const other = hosted.host('other')
    release()
    release()
    // The repeat call must not take `other`, the panel nobody released, away.
    expect([...hosted.source.getSnapshot()]).toEqual(['other'])
    other()
    expect([...hosted.source.getSnapshot()]).toEqual([])
  })

  it('hosts a panel again after its last claim was released', () => {
    const hosted = new HostedPanels()
    hosted.host('mmx')()
    expect([...hosted.source.getSnapshot()]).toEqual([])
    const again = hosted.host('mmx')
    expect([...hosted.source.getSnapshot()]).toEqual(['mmx'])
    again()
    expect([...hosted.source.getSnapshot()]).toEqual([])
  })
})

const OLD = 's-1' as SessionId
const NEW = 's-2' as SessionId

describe('HostedSession', () => {
  it('names one Session at a time and lets the last name win', () => {
    const hosted = new HostedSession()
    expect(hosted.source.getSnapshot()).toBeUndefined()
    const older = hosted.select(OLD)
    expect(hosted.source.getSnapshot()).toBe(OLD)
    const newer = hosted.select(NEW)
    expect(hosted.source.getSnapshot()).toBe(NEW)
    // Withdrawing the name that already lost changes nothing.
    older()
    expect(hosted.source.getSnapshot()).toBe(NEW)
    newer()
    expect(hosted.source.getSnapshot()).toBeUndefined()
  })

  it('ignores a disposer called after it already withdrew its name', () => {
    const hosted = new HostedSession()
    const first = hosted.select(OLD)
    first()
    const second = hosted.select(NEW)
    // The stale disposer must not withdraw the name that replaced it.
    first()
    expect(hosted.source.getSnapshot()).toBe(NEW)
    second()
    expect(hosted.source.getSnapshot()).toBeUndefined()
  })
})
