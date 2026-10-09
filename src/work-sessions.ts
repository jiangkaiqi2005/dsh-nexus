import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nexus-dispatch': { kind: 'nexus-dispatch'; sessionId: string; callId: string }
    'nexus-runtime': { kind: 'nexus-runtime'; form: 'snapshot' }
  }
}

/**
 * Add conversation-session operations to the caller's existing native capability set.
 * Nexus manages conversation sessions only; subagent sessions belong to the agent that spawned them.
 */
export function registerWorkSessions(ctx: Context, supervisor: Agent, tools: ToolRuntime) {
  const output = { schema: { type: 'json' } as const, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  const sessionId = { type: 'string', required: true, description: 'Target native conversation session identity.' } as const
  const text = { type: 'string', required: true, description: 'Task or guidance to deliver, preserving the user requirements.' } as const
  /** Inspect a target without activating it, refusing the supervisor itself and subagent sessions. */
  const conversation = async (id: string, signal: AbortSignal) => {
    if (id === supervisor.id) throw new Error('Use the main conversation to address Nexus itself')
    const state = await ctx.sessionController.inspect(SessionId(id), signal)
    if (state.meta.origin === 'subagent') throw new Error(`Session "${id}" is a subagent session owned by the agent of ${state.meta.parentSession ?? 'its parent'}; Nexus manages conversation sessions only`)
    return state
  }
  const resolve = async (id: string) => {
    const live = ctx.agents.get(SessionId(id))
    if (live) return live
    const target = await ctx.sessionController.resolveAgent(SessionId(id))
    if ('error' in target) throw target.error
    return target.agent
  }
  const send = (agent: Agent, message: string, callId: string) => {
    const input = createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'nexus-dispatch', sessionId: supervisor.id, callId } })
    const delivery = agent.status === 'running' ? 'steer' : 'followup'
    agent[delivery](input)
    return { sessionId: agent.id, messageId: input.id, delivery, accepted: true, completed: false }
  }
  tools.register(defineTool({ name: 'nexus_list_sessions', description: 'List all native conversation sessions, including existing user-created sessions, without activating them. Subagent sessions are not listed.', parameters: {}, output,
    execute: async (_args, exec) => JSON.parse(JSON.stringify({ items: (await ctx.sessionController.list({}, exec.signal)).items.filter(item => item.sessionId !== supervisor.id && item.origin !== 'subagent') })) as JsonValue,
  }))
  tools.register(defineTool({ name: 'nexus_read_session', description: 'Read native conversation session state and a bounded history page. Use beforeSeq to read earlier context when hasMore is true.', parameters: { sessionId, beforeSeq: { type: 'integer' } }, output,
    execute: async (args, exec) => {
      const id = SessionId(args.sessionId)
      const state = await conversation(id, exec.signal)
      const throughSeq = state.events.length - 1
      const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId: id }, throughSeq, ...(args.beforeSeq === undefined ? {} : { beforeSeq: args.beforeSeq }), maxMessages: 30 }, exec.signal)
      return JSON.parse(JSON.stringify({ sessionId: id, header: state.meta, status: ctx.agents.get(id)?.status ?? 'inactive', throughSeq, ...page })) as JsonValue
    },
  }))
  tools.register(defineTool({ name: 'nexus_create_session', description: 'Create a native conversation session in an explicit absolute workspace directory and start its task. Acceptance is not completion. Uses the normal worker factory and selected preset.', parameters: { cwd: { type: 'string', required: true }, text, agentPreset: { type: 'string' } }, output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const workspace = await ctx.workspaceRegistry.create(args.cwd)
      exec.signal.throwIfAborted()
      const created = await ctx.sessionController.create({ workspaceId: workspace.id, ...(args.agentPreset ? { agentPreset: args.agentPreset } : {}) })
      exec.signal.throwIfAborted()
      return send(await resolve(created.sessionId), args.text, exec.callId)
    },
  }))
  tools.register(defineTool({ name: 'nexus_send_session', description: 'Deliver a task to any existing conversation session. Idle agents wake; running agents receive native next-step steering. Acceptance is not completion.', parameters: { sessionId, text }, output,
    execute: async (args, exec) => {
      await conversation(args.sessionId, exec.signal)
      const agent = await resolve(args.sessionId)
      exec.signal.throwIfAborted()
      return send(agent, args.text, exec.callId)
    },
  }))
  tools.register(defineTool({ name: 'nexus_stop_session', description: 'Request native cancellation of a conversation session current turn while retaining its queued input. Use only when the goal calls for stopping; acceptance is not completion.', parameters: { sessionId }, output,
    execute: async (args, exec) => {
      await conversation(args.sessionId, exec.signal)
      const agent = await resolve(args.sessionId)
      exec.signal.throwIfAborted()
      agent.cancel({ kind: 'hook', reason: `Nexus ${supervisor.id} tool ${exec.callId}` }, { keepInbox: true })
      return { sessionId: agent.id, accepted: true, completed: false }
    },
  }))
}
