import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, interruptedTurnClosers, type Session } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { Supervisor, type Config } from './supervisor.js'
import { ResultRelay } from './results.js'

export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'credentials', 'workspaceRegistry', 'agentPresets', 'sessionController', 'tools', 'systemPrompt']
export const SUPERVISOR_ID = SessionId('nexus-supervisor')

export async function apply(ctx: Context, config: Config) {
  if (!config.credentialRef || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialRef)) throw new Error('Nexus requires a Host credential reference')
  const endpoint = new URL(config.endpoint)
  if (!['wss:', 'ws:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Nexus requires a WebSocket endpoint without embedded credentials')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error('Nexus timeout must be a positive integer')
  return ctx.effect(async function* () {
    let session: Session | undefined
    let handle: SessionHandle
    let storedCount = 0
    try { handle = await ctx.sessionPersistence.open(SUPERVISOR_ID, 'write') }
    catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      session = ctx.sessions.prepare(SUPERVISOR_ID, { meta: { agentPreset: 'nexus', cwd: process.cwd() } })
      handle = await ctx.sessionPersistence.create(session.header)
    }
    // Own the writer before scope/registry setup can fail; transfer cleanup below.
    let startupOwnsWriter = true
    yield () => { if (startupOwnsWriter) return handle.close() }
    if (!session) {
      // The dedicated, unregistered preset makes generic cold activation fail
      // before its default factory can claim this identity during our setup.
      if (handle.header.agentPreset !== 'nexus') throw new Error('Nexus refuses a supervisor identity owned by another preset')
      const restored = await handle.read()
      const closers = interruptedTurnClosers(restored.events)
      if (closers.length) await handle.append(closers)
      storedCount = restored.events.length + closers.length
      session = ctx.sessions.prepare(SUPERVISOR_ID, {
        seed: [...restored.events, ...closers], meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount, eventState: restored.eventState,
      })
    }
    const agent = new Supervisor(ctx, session, config)
    yield agent.scope.rawDispose
    if (!storedCount) session.append('model/selection', agent.options)
    // Restore seeds do not publish live events; store only their new suffix.
    const suffix = session.snapshotEvents(SessionLogOffset(storedCount))
    if (suffix.length) await handle.append(suffix)
    await handle.flush()
    yield ctx.sessions.enter(session)
    yield ctx.agents.enter(agent, undefined)
    // Reverse teardown: stop/idle → close durable writer → registry → session → scope.
    yield () => handle.close()
    startupOwnsWriter = false
    yield () => agent.stop()
    // Observe only after the supervisor can accept inbox work; disposed first on teardown.
    yield new ResultRelay(ctx, agent).start()
    // The native blank-session composer requires durable Workspace membership.
    const workspace = await ctx.workspaceRegistry.create(session.header.cwd ?? process.cwd(), 'Nexus')
    await workspace.attachSession(session.id)
    ctx.sessions.announce(session)
    await ctx.agents.announce(agent, storedCount ? 'resume' : 'startup')
  }, 'nexus supervisor')
}
