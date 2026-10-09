import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'llm', 'loader', 'agentDefaultModel', 'tools', 'subagents']
export function apply(ctx, config) {
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const task = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(part => part.type === 'text' && /^(run-|hold-|steered-|Existing user context)/.test(part.text)).at(-1)?.text ?? ''
      if (task.startsWith('hold')) await new Promise((accept, reject) => {
        const timer = setTimeout(accept, 6000)
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) }, { once: true })
      })
      if (task) await writeFile(resolve(config.workspace, `${options.sessionId}.txt`), task)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Worker executed: ${task}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['dispatch-worker'], new WorkerAdapter())
  ctx.tools.register(defineTool({ name: 'fixture_native_capability', description: 'Native user-configured test capability outside Nexus dispatch operations.', parameters: { value: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => args.value }))
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'fixture_native_capability' && exec.arguments.value === 'denied-by-native-policy' ? { action: 'deny', reason: 'Native fixture deployment policy denied this operation.' } : next())
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'dispatch-worker', model: 'worker-model' })
        const existing = await ctx.sessionController.create({ sessionId: 'user-existing', cwd: config.workspace })
        const worker = ctx.agents.get(existing.sessionId)
        worker.followup(createUserMessage({ content: [{ type: 'text', text: 'Existing user context ANCHOR-19' }], source: { kind: 'user' } }))
        await worker.whenIdle()
        let coldChildPrepared = false
        let deepColdPrepared = false
        if (config.deepCold) {
          const root = await ctx.agents.create({ sessionId: 'deep-root', meta: { cwd: config.workspace }, agentOptions: { provider: 'dispatch-worker', model: 'worker-model' } })
          await ctx.subagents.startContinuable({ provider: 'spawn', childId: 'deep-parent', label: 'Existing cold subagent parent', request: { parent: root.agent, maxDepth: 2, prompt: [{ type: 'text', text: 'run-initial-parent' }] }, signal: new AbortController().signal })
          const parent = ctx.agents.get('deep-parent')
          await parent.whenIdle()
          await ctx.subagents.startContinuable({ provider: 'spawn', childId: 'deep-grandchild', label: 'Existing cold grandchild', request: { parent, maxDepth: 2, prompt: [{ type: 'text', text: 'run-initial-grandchild' }] }, signal: new AbortController().signal })
          await ctx.agents.get('deep-grandchild').whenIdle()
          await ctx.subagents.drainContinuableChildren(root.agent, ['deep-parent'])
          await root.agent.whenIdle()
          deepColdPrepared = !!ctx.agents.get('deep-root') && !ctx.agents.get('deep-parent') && !ctx.agents.get('deep-grandchild')
        } else if (!config.real) {
          const parent = await ctx.agents.create({ sessionId: 'cold-parent', meta: { cwd: config.workspace }, agentOptions: { provider: 'dispatch-worker', model: 'worker-model' } })
          await ctx.subagents.startContinuable({ provider: 'spawn', childId: 'cold-child', label: 'Existing non-Nexus child', request: { parent: parent.agent, prompt: [{ type: 'text', text: 'run-initial-child' }] }, signal: new AbortController().signal })
          await ctx.agents.get('cold-child').whenIdle()
          await ctx.subagents.drainContinuableChildren(parent.agent, ['cold-child'])
          await parent.agent.whenIdle()
          await parent.dispose()
          coldChildPrepared = !ctx.agents.get('cold-parent') && !ctx.agents.get('cold-child')
          for (const id of ['busy-worker', 'stop-worker']) {
            await ctx.sessionController.create({ sessionId: id, cwd: config.workspace })
            ctx.agents.get(id).followup(createUserMessage({ content: [{ type: 'text', text: `hold-${id}` }], source: { kind: 'user' } }))
          }
        }
        const agent = ctx.agents.get('nexus-supervisor')
        await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'dispatch-targets', mode: 'queue', content: [{ type: 'text', text: config.prompt }] }, new AbortController().signal)
        await agent.whenIdle()
        if (config.real) {
          await ctx.sessionController.prompt({ sessionId: agent.id, requestId: 'dispatch-failure', mode: 'queue', content: [{ type: 'text', text: '这是工具失败回填的集成测试。请务必实际调用nexus_send_session，参数sessionId为missing-target，text为failure-test；即使你知道它不存在也要调用，以便检查真实错误回填。收到工具错误后用文字说明这个实际失败，不要创建替代会话。' }] }, new AbortController().signal)
          await agent.whenIdle()
        }
        // Worker terminals wake the supervisor too: settle until nothing is running and nothing new is logged.
        for (let stable = 0, last = -1; stable < 3; await new Promise(accept => setTimeout(accept, 250))) {
          for (const current of ctx.agents.list()) await current.whenIdle()
          const total = ctx.agents.list().reduce((sum, current) => sum + current.session.seq, 0)
          if (total === last && ctx.agents.list().every(current => current.status === 'idle')) stable++
          else { stable = 0; last = total }
        }
        const workers = ctx.agents.list().filter(current => current !== agent).map(current => ({ id: current.id, ownedByNexus: ctx.agents.isOwnedBy(current.id, agent), header: current.session.header, events: current.session.snapshotEvents(), status: current.status }))
        if (config.deepCold) for (const id of ['deep-parent', 'deep-grandchild']) {
          const state = await ctx.sessionController.inspect(id)
          workers.push({ id, header: state.meta, events: state.events, ownedByNexus: false, status: ctx.agents.get(id)?.status ?? 'inactive' })
        }
        if (!config.real && !config.deepCold && !workers.some(item => item.id === 'cold-child')) { const state = await ctx.sessionController.inspect('cold-child'); workers.push({ id: state.meta.id, header: state.meta, events: state.events, ownedByNexus: false, status: 'inactive' }) }
        for (const current of ctx.agents.list()) await ctx.parallel('session/flush', current.session)
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(agent.id, 'read')
        const { events } = await reader.read()
        await reader.close()
        await writeFile(config.report, JSON.stringify({ pid: process.pid, events, workers, coldChildPrepared, deepColdPrepared, released: !ctx.agents.get(agent.id) }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack })) }
    }, 1800)
    return () => clearTimeout(timer)
  })
}
