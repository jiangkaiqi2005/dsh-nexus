import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId, SessionLogOffset, interruptedTurnClosers, type Session } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-title'
import { Supervisor, type Config as SupervisorConfig } from './supervisor.js'
import { ResultRelay } from './results.js'
import { VoiceController } from './voice.js'
import { SUMMARY_MODEL } from './compaction.js'
import { TTS_ENDPOINT, TTS_MODEL, TTS_VOICE } from './speech.js'

export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'credentials', 'workspaceRegistry', 'agentPresets', 'sessionController', 'tools', 'systemPrompt', 'commands', 'tokenMeter', 'sessionTitle', 'llm', 'agentDefaultModel']
export const SUPERVISOR_ID = SessionId('nexus-supervisor')

export interface Config extends SupervisorConfig { autoVoice: Volatile<boolean> }
export const Config = z.object({
  credentialRef: z.string().required(),
  endpoint: z.string().required(),
  timeoutMs: z.number().step(1).min(1),
  autoVoice: z.boolean().default(false).volatile(),
  voiceMode: z.union(['cascade', 'realtime']).default('cascade').volatile(),
  ttsEndpoint: z.string().pattern(/^wss?:\/\/[^\s@]+$/).default(TTS_ENDPOINT).volatile(),
  ttsModel: z.string().min(1).default(TTS_MODEL).volatile(),
  ttsVoice: z.string().min(1).default(TTS_VOICE).volatile(),
  compactionBudget: z.number().step(1).min(1).default(128000).volatile(),
  summaryModel: z.string().pattern(SUMMARY_MODEL).default('').volatile(),
  summaryReasoningEffort: z.string().default('').volatile(),
})

// Keep the launch choice and its consumption through plugin reactivation in this Host.
const STARTUP = Symbol.for('dsh-nexus.startup')
type StartupProcess = NodeJS.Process & { [STARTUP]?: { enabled: boolean; attempted: boolean } }

export async function apply(ctx: Context, config: Config) {
  if (!config.credentialRef || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialRef)) throw new Error('Nexus requires a Host credential reference')
  const endpoint = new URL(config.endpoint)
  if (!['wss:', 'ws:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Nexus requires a WebSocket endpoint without embedded credentials')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error('Nexus timeout must be a positive integer')
  const startup = (process as StartupProcess)[STARTUP] ??= { enabled: config.autoVoice?.get() ?? false, attempted: false }
  const voice = new VoiceController(ctx, startup)
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
    // The main session is named Nexus unless the user named it: an automatic title (fallback or provider) is replaced.
    // The native rename records a user title, which also keeps first prompts from deriving another fallback.
    if (ctx.sessionTitle.get(session)?.source.kind !== 'user') ctx.sessionTitle.rename(session, 'Nexus')
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
    // Media clients may claim startup only after the native session and Host are ready.
    yield voice.attach(agent)
  }, 'nexus supervisor')
}
