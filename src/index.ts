import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Supervisor, type Config } from './supervisor.js'

export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'credentials']
export const SUPERVISOR_ID = SessionId('nexus-supervisor')

export async function apply(ctx: Context, config: Config) {
  if (!config.credentialRef || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialRef)) throw new Error('Nexus requires a Host credential reference')
  const endpoint = new URL(config.endpoint)
  if (!['wss:', 'ws:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Nexus requires a WebSocket endpoint without embedded credentials')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error('Nexus timeout must be a positive integer')
  return ctx.effect(async function* () {
    const session = ctx.sessions.prepare(SUPERVISOR_ID, { meta: { agentPreset: 'nexus', cwd: process.cwd() } })
    const handle = await ctx.sessionPersistence.create(session.header)
    // Own the writer before scope/registry setup can fail; transfer cleanup below.
    let startupOwnsWriter = true
    yield () => { if (startupOwnsWriter) return handle.close() }
    const agent = new Supervisor(ctx, session, config)
    yield agent.scope.rawDispose
    yield ctx.sessions.enter(session)
    yield ctx.agents.enter(agent, undefined)
    // Reverse teardown: stop/idle → close durable writer → registry → session → scope.
    yield () => handle.close()
    startupOwnsWriter = false
    yield () => agent.stop()
    if (session.seq) await handle.append(session.snapshotEvents())
    await handle.flush()
    ctx.sessions.announce(session)
    await ctx.agents.announce(agent, 'startup')
  }, 'nexus supervisor')
}
