/** The DSH_SESSION_OWNER environment stamp lands on freshly created session headers. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function makeCoreContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('DSH_SESSION_OWNER stamping', () => {
  it('stamps created sessions with the environment label', async () => {
    vi.stubEnv('DSH_SESSION_OWNER', 'Multica run M-142')
    const ctx = await makeCoreContext()
    contexts.push(ctx)
    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'owned', sessionId: SessionId('owned-session'), model: 'mock' }],
    })
    expect(ctx.agents.get(SessionId('owned-session'))?.session.header.externalOwner).toBe('Multica run M-142')
  })

  it('an explicit caller label wins over the environment, and an absent environment stamps nothing', async () => {
    vi.stubEnv('DSH_SESSION_OWNER', 'Multica run env')
    const ctx = await makeCoreContext()
    contexts.push(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const handle = await ctx.agents.create({
      sessionId: SessionId('explicit-session'),
      meta: { externalOwner: 'Multica run explicit' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(handle.agent.session.header.externalOwner).toBe('Multica run explicit')

    const bare = await makeCoreContext()
    contexts.push(bare)
    await bare.plugin(AgentLoop, { agents: [] })
    vi.unstubAllEnvs()
    const bareHandle = await bare.agents.create({
      sessionId: SessionId('bare-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(bareHandle.agent.session.header.externalOwner).toBeUndefined()
  })
})
