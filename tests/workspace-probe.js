import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'llm', 'agentDefaultModel', 'loader']

/** Exercise the model tools and inspect their effects through public native services. */
export function apply(ctx, config) {
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const task = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).findLast(part => part.type === 'text' && part.text.startsWith('run-'))?.text
      const state = await ctx.sessionController.inspect(options.sessionId)
      await writeFile(resolve(state.meta.cwd, 'workspace-task.txt'), task)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Executed in target workspace: ${task}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['workspace-worker'], new WorkerAdapter())
  const snapshot = async () => ({
    workspaces: ctx.workspaceRegistry.list().map(item => ({ id: item.id, title: item.title, path: item.path, createdAt: item.createdAt, updatedAt: item.updatedAt, sessionIds: [...item.sessionIds] })),
    sessions: (await ctx.sessionController.list({})).items.map(({ sessionId, cwd, origin, parentSession }) => ({ sessionId, cwd, origin, parentSession })),
  })
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'workspace-worker', model: 'worker-model' })
        const target = await ctx.workspaceRegistry.create(config.target, '侧栏登记项目')
        const empty = await ctx.workspaceRegistry.create(config.empty, '空白项目')
        const agent = ctx.agents.get('nexus-supervisor')
        const prompt = async text => {
          await ctx.sessionController.prompt({ sessionId: agent.id, requestId: text, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
          await agent.whenIdle()
        }
        const before = await snapshot()
        await prompt('WORKSPACE-READ-ONLY')
        const after = await snapshot()
        await target.setTitle('dsh-nexus')
        const renamed = await snapshot()
        await prompt('WORKSPACE-DISPATCH 按侧栏登记项目 dsh-nexus 新建普通会话并执行任务')
        for (let stable = 0, last = -1; stable < 3; await new Promise(accept => setTimeout(accept, 100))) {
          for (const current of ctx.agents.list()) await current.whenIdle()
          const total = ctx.agents.list().reduce((sum, current) => sum + current.session.seq, 0)
          if (total === last && ctx.agents.list().every(current => current.status === 'idle')) stable++
          else { stable = 0; last = total }
        }
        // Open a real voice connection to verify the same model capability and role guidance.
        const signal = new AbortController()
        const call = await agent.startCall({ audio: () => {}, failed: code => { throw new Error(code) } }, signal.signal)
        call.end()
        // Fault injection at the external registry service boundary: errors must reach the model.
        const list = ctx.workspaceRegistry.list
        ctx.workspaceRegistry.list = () => { throw new Error('Workspace registry fixture failure') }
        try { await prompt('WORKSPACE-QUERY-FAILURE') } finally { ctx.workspaceRegistry.list = list }
        const workers = []
        for (const current of ctx.agents.list().filter(current => current !== agent)) {
          const state = await ctx.sessionController.inspect(current.id)
          workers.push({ id: current.id, header: state.meta, events: state.events })
        }
        const final = await snapshot()
        await ctx.parallel('session/flush', agent.session)
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(agent.id, 'read')
        const header = reader.header
        const { events } = await reader.read()
        await reader.close()
        await writeFile(config.report, JSON.stringify({ before, after, renamed, final, targetId: target.id, emptyId: empty.id, workers, header, events, released: !ctx.agents.get(agent.id) }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack })) }
    }, 1500)
    return () => clearTimeout(timer)
  })
}
