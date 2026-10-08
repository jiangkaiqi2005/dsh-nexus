import { writeFile } from 'node:fs/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'llm', 'loader']
export function apply(ctx, config) {
  class WorkerAdapter extends LlmAdapter {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Ordinary worker reply' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ordinary worker reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['nexus-test-worker'], new WorkerAdapter())
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let worker
      try {
        const agent = ctx.agents.get('nexus-supervisor')
        if (!agent) throw new Error('Nexus agent missing')
        let duplicateRejected = false
        try { ctx.agents.enter(agent, undefined) } catch { duplicateRejected = true }
        let writerRejected = false
        try { await ctx.sessionPersistence.open(agent.id, 'write') } catch { writerRejected = true }
        worker = await ctx.agents.create({ sessionId: 'ordinary-worker', meta: { cwd: process.cwd() }, agentOptions: { provider: 'nexus-test-worker', model: 'ordinary-model' } })
        const prompt = (sessionId, requestId, text) => ctx.sessionController.prompt({ sessionId, requestId, content: [{ type: 'text', text }], mode: 'followup' }, new AbortController().signal)
        await prompt(worker.agent.id, 'worker-input', 'Hello worker')
        await worker.agent.whenIdle()
        await prompt(agent.id, 'nexus-test-input', config.prompt)
        await agent.whenIdle()
        await prompt(agent.id, 'nexus-test-input', config.prompt)
        await agent.whenIdle()
        await ctx.parallel('session/flush', agent.id)
        const workerEvents = worker.agent.session.snapshotEvents()
        const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-nexus')
        if (!entry) throw new Error('Nexus loader entry missing')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const released = !ctx.agents.get(agent.id) && !ctx.sessions.get(agent.id)
        const handle = await ctx.sessionPersistence.open(agent.id, 'write')
        const { events } = await handle.read()
        await handle.close()
        await writeFile(config.report, JSON.stringify({ agentId: agent.id, sessionId: agent.session.id, duplicateRejected, writerRejected, released, workerIsSupervisor: worker.agent === agent, workerModel: worker.agent.options.model, workerEvents, events }))
      } catch (error) {
        await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack }))
      } finally { await worker?.dispose() }
    }, 1500)
    return () => clearTimeout(timer)
  })
}
