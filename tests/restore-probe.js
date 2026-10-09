import { writeFile } from 'node:fs/promises'
import { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'llm', 'loader']
export function apply(ctx, config) {
  class WorkerAdapter extends LlmAdapter {
    async *stream() {
      // The prompt that started this turn was mirrored to the supervisor; answer after it handled that, so turns stay deterministic.
      await ctx.agents.get('nexus-supervisor')?.whenIdle()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ordinary worker reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['nexus-restore-worker'], new WorkerAdapter())
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let worker
      try {
        const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-nexus')
        let raceError
        if (config.phase === 2 && config.scenario === 'race') {
          const early = await ctx.sessionController.resolveAgent('nexus-supervisor')
          if ('error' in early) raceError = String(early.error)
          else if (early.agent.options.model !== 'qwen3.8-omni-flash-realtime') throw new Error('default worker stole supervisor identity')
          const loading = entry.update({ ...entry.options, disabled: false })
          const concurrent = await ctx.sessionController.resolveAgent('nexus-supervisor')
          if ('agent' in concurrent && concurrent.agent.options.model !== 'qwen3.8-omni-flash-realtime') throw new Error('default worker won initialization race')
          await loading
          await ctx.loader.await()
          await entry.fiber.await()
        }
        const agent = ctx.agents.get('nexus-supervisor')
        if (!agent) throw new Error('supervisor missing')
        const before = agent.session.snapshotEvents()
        const initialStatus = agent.status
        const models = []
        ctx.on('agent/created', ({ agent: current }) => { if (current.id === agent.id) models.push(current.options.model) })
        if (config.phase !== 1) {
          // Startup and navigation never drain the recovered inbox by themselves.
          await new Promise(resolve => setTimeout(resolve, 150))
          if (agent.session.snapshotEvents().length !== before.length) throw new Error('restored supervisor automatically ran work')
        }
        if (config.phase === 1) worker = await ctx.agents.create({ sessionId: 'restore-worker', meta: { cwd: process.cwd() }, agentOptions: { provider: 'nexus-restore-worker', model: 'ordinary-model' } })
        else worker = await ctx.agents.resume({ resumeSessionId: 'restore-worker', agentOptions: { provider: 'nexus-restore-worker', model: 'ordinary-model' } })
        const prompt = (target, text, suffix = '') => ctx.sessionController.prompt({ sessionId: target.id, requestId: `restore-${config.phase}${suffix}`, content: [{ type: 'text', text }], mode: 'followup' }, new AbortController().signal)
        await prompt(worker.agent, 'Hello ordinary worker')
        await worker.agent.whenIdle()
        // The worker's finished turn reaches the supervisor; settle it before the scenario starts.
        await agent.whenIdle()
        if (config.phase === 1) {
          await prompt(agent, config.prompt)
          await agent.whenIdle()
          if (config.scenario === 'active-exit') {
            await prompt(agent, 'Interrupted active request', '-active')
            await new Promise(resolve => setTimeout(resolve, 200))
            if (agent.status !== 'running') throw new Error('active-exit fixture did not have an active driver')
            await ctx.parallel('session/flush', agent.session)
            await worker.dispose()
            worker = undefined
            await writeFile(config.report, JSON.stringify({ phase: 1, pid: process.pid, events: agent.session.snapshotEvents(), activeExit: true }))
            process.emit('SIGTERM')
            return
          }
          if (config.scenario === 'interrupt') {
            const turn = Math.max(...agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)) + 1
            agent.session.append('turn/start', { turn })
            agent.session.append('step/start', { turn, step: 1 })
            agent.session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: agent.options, content: [
              { type: 'tool-call', id: 'started-call', name: 'fixture.sideEffect', arguments: '{}' },
              { type: 'tool-call', id: 'unstarted-call', name: 'fixture.read', arguments: '{}' },
            ] }), stream: [] }, { surfaceOp: 'append' })
            agent.session.append('tool/call', { turn, step: 1, callId: 'started-call', name: 'fixture.sideEffect', arguments: '{}' })
            agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Pending clarification' }], source: { kind: 'user' } }))
            await ctx.parallel('session/flush', agent.session)
            await writeFile(config.report, JSON.stringify({ phase: 1, pid: process.pid, events: agent.session.snapshotEvents(), crashReady: true }))
            // Parent terminates this isolated process after the durable open-tail report.
            return
          }
        } else {
          const resolved = await ctx.sessionController.resolveAgent(agent.id)
          if (resolved.agent !== agent) throw new Error('entry did not resolve the same supervisor')
          await prompt(agent, config.prompt)
          await agent.whenIdle()
          if (config.scenario === 'reload') {
            const oldEvents = agent.session.snapshotEvents()
            await entry.update({ ...entry.options, disabled: true })
            await ctx.loader.await()
            if (ctx.agents.get(agent.id) || ctx.sessions.get(agent.id)) throw new Error('unload retained identity')
            const released = await ctx.sessionPersistence.open(agent.id, 'write')
            await released.close()
            await entry.update({ ...entry.options, disabled: false })
            await ctx.loader.await()
            await entry.fiber.await()
            const replacement = ctx.agents.get(agent.id)
            if (replacement === agent || replacement.status !== 'idle') throw new Error('reload did not restore idle driver')
            const restored = replacement.session.snapshotEvents()
            if (JSON.stringify(restored.slice(0, oldEvents.length)) !== JSON.stringify(oldEvents) || restored.slice(oldEvents.length).some(event => event.type !== 'session/end-seed')) throw new Error('reload duplicated history')
          }
        }
        const current = ctx.agents.get(agent.id)
        const events = current.session.snapshotEvents()
        await worker.dispose()
        worker = undefined
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const released = !ctx.agents.get(agent.id) && !ctx.sessions.get(agent.id)
        const handle = await ctx.sessionPersistence.open(agent.id, 'write')
        const persisted = await handle.read()
        await handle.close()
        await writeFile(config.report, JSON.stringify({ phase: config.phase, pid: process.pid, id: agent.id, model: current.options.model, initialStatus, before, events, persisted: persisted.events, released, raceError, models }))
        process.emit('SIGTERM')
      } catch (error) {
        await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack }))
        await worker?.dispose()
        await ctx.root.fiber.dispose()
        process.exit(1)
      }
    }, 1000)
    return () => clearTimeout(timer)
  })
}
