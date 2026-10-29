// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-external' as SessionId

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: async (_workspaceId: unknown, beforeOpen: (id: SessionId) => void) => { beforeOpen(SID) },
    openSession: () => {},
    openNamed: async (_workspaceId: unknown, sessionId: SessionId | undefined) => sessionId,
  } as never)
  runtime.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)
  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()
  return { runtime, feature }
}

function externalBlockStore(
  runtime: SlotTestRuntime,
): ObservableSnapshot<ComposerBlock | undefined> {
  const definition = runtime.factoryOf('conversation.content')
  return ((definition.inject as unknown as (
    sessionId: SessionId | undefined,
  ) => { hooks: { composerBlock: ObservableSnapshot<ComposerBlock | undefined> } })(SID)).hooks.composerBlock
}

describe('external-writer composer blocks', () => {
  it('raises and clears the read-only block from external status frames, ignoring agent transitions', async () => {
    const b = await bench()
    const block = externalBlockStore(b.runtime)
    expect(block.getSnapshot()).toBeUndefined()

    // Agent-driven running transitions (owner undefined) raise nothing.
    b.runtime.remote.emit('api-session/status', [SID, true, undefined])
    expect(block.getSnapshot()).toBeUndefined()

    // Live external writer with a recorded label: read-only, named.
    b.runtime.remote.emit('api-session/status', [SID, true, 'Multica run M-142'])
    expect(block.getSnapshot()).toEqual({ reason: '此会话由 Multica run M-142 负责，无法在此发送' })

    // The holder releases the lease: the composer unblocks.
    b.runtime.remote.emit('api-session/status', [SID, false, null])
    expect(block.getSnapshot()).toBeUndefined()

    // An anonymous re-acquisition raises the generic copy.
    b.runtime.remote.emit('api-session/status', [SID, true, null])
    expect(block.getSnapshot()).toEqual({ reason: '此会话由外部进程负责，无法在此发送' })

    await b.runtime.dispose()
  })
})
