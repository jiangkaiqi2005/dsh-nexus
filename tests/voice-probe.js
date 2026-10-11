import { writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['agents', 'sessionController', 'sessionPersistence', 'llm', 'loader', 'agentDefaultModel', 'tools', 'workspaceRegistry']
const SUPERVISOR = 'nexus-supervisor'
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const exists = path => access(path).then(() => true, () => false)

/**
 * Host-side fixture for the voice scenario: a controlled native worker model that
 * holds its first step until the test releases it, an existing user-created
 * conversation session, a native tool whose execution the test holds open,
 * live status for the test, and the final native logs.
 */
export function apply(ctx, config) {
  const flag = name => resolve(config.dir, name)
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      while (!config.navigation && !(await exists(flag('release')))) { options.signal.throwIfAborted(); await sleep(50) }
      const text = `Docs ready: ${config.marker}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['voice-worker'], new WorkerAdapter())
  // A user-configured native capability that runs until the test releases it.
  ctx.tools.register(defineTool({ name: 'fixture_slow_lookup', description: 'Look up reference material (fixture).', parameters: { query: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, exec) => {
      await writeFile(flag('tool-started'), '')
      while (!(await exists(flag('tool-release')))) { exec.signal.throwIfAborted(); await sleep(50) }
      return 'TOOL-RESULT-77'
    } }))
  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'voice-worker', model: 'worker-model' })
        await ctx.sessionController.create({ sessionId: 'docs', cwd: config.workspace })
        if (config.navigation) {
          for (const [sessionId, cwd, title] of [['docs', config.workspace, '导航工作会话'], ['other-work', resolve(config.workspace, 'other-project'), '另一个项目会话']]) {
            const workspace = await ctx.workspaceRegistry.create(cwd)
            if (sessionId !== 'docs') await ctx.sessionController.create({ sessionId, workspaceId: workspace.id })
            else await workspace.attachSession(sessionId)
            await ctx.sessionController.prompt({ sessionId, requestId: `navigation-${sessionId}`, mode: 'queue', content: [{ type: 'text', text: '准备可导航的工作会话' }] }, new AbortController().signal)
            await ctx.agents.get(sessionId).whenIdle()
            await ctx.sessionController.rename({ sessionId, title })
          }
        }
        while (!stopped && !(await exists(flag('finish')))) {
          const agents = ctx.agents.list().map(agent => {
            const events = agent.session.snapshotEvents()
            return { id: agent.id, status: agent.status, ends: events.filter(event => event.type === 'turn/end').length, users: events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length }
          })
          await writeFile(flag('status.json'), JSON.stringify({ ready: true, agents }))
          await sleep(150)
        }
        if (stopped) return
        for (const agent of ctx.agents.list()) if (agent.id !== SUPERVISOR) await agent.whenIdle()
        const supervisor = ctx.agents.get(SUPERVISOR)
        await supervisor?.whenIdle()
        const workers = ctx.agents.list().filter(agent => agent.id !== SUPERVISOR).map(agent => ({ id: agent.id, header: agent.session.header, events: agent.session.snapshotEvents() }))
        for (const agent of ctx.agents.list()) await ctx.parallel('session/flush', agent.session)
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(SUPERVISOR, 'read')
        const { events } = await reader.read()
        await reader.close()
        // Nexus lines of the Host log, from the logger's own message buffer.
        const logs = ctx.logger.buffer.map(message => message.args.map(String).join(' ')).filter(line => line.startsWith('nexus'))
        await writeFile(flag('result.json'), JSON.stringify({ pid: process.pid, events, workers, logs, released: !ctx.agents.get(SUPERVISOR) }))
      } catch (error) { await writeFile(flag('result.json'), JSON.stringify({ error: String(error), stack: error.stack })) }
    }
    const timer = setTimeout(run, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  })
}
