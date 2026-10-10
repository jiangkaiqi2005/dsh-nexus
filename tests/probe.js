import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

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
        if (config.scenario.startsWith('storage-')) {
          const session = ctx.sessions.prepare('nexus-supervisor', { meta: { agentPreset: 'nexus', cwd: process.cwd() } })
          session.append('model/selection', { provider: 'storage-fixture', model: 'preserved-model' })
          const handle = await ctx.sessionPersistence.create(session.header)
          let artifact
          let malformed
          try {
            await handle.append(session.snapshotEvents())
            await handle.flush()
            if (config.scenario === 'storage-corrupt') {
              await handle.close()
              const sessions = resolve(process.env.DSH_HOME, 'sessions')
              const path = (await readdir(sessions, { recursive: true })).find(path => path.endsWith('nexus-supervisor/session.v4.jsonl.zstd') || path.endsWith('nexus-supervisor\\session.v4.jsonl.zstd'))
              if (!path) throw new Error('isolated fixture artifact missing')
              artifact = resolve(sessions, path)
              malformed = zstdCompressSync(Buffer.from('{"malformed":true}\n'))
              await writeFile(artifact, malformed)
            }
            const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-nexus')
            await entry.update({ ...entry.options, disabled: false })
            await ctx.loader.await()
            let startupErrorName
            try { await entry.fiber.await() } catch (error) { startupErrorName = error.name }
            const supervisorPublished = !!ctx.agents.get('nexus-supervisor')
            await entry.update({ ...entry.options, disabled: true })
            await ctx.loader.await()
            const preserved = artifact ? (await readFile(artifact)).equals(malformed) : JSON.stringify((await handle.read()).events) === JSON.stringify(session.snapshotEvents())
            await writeFile(config.report, JSON.stringify({ startupErrorName, supervisorPublished, preserved }))
          } finally { await handle.close() }
          return
        }
        if (config.scenario === 'late-conflict') {
          const { apply: nexusApply } = await import(config.module)
          const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-nexus')
          let competitor
          let detach
          let scheduled = false
          const unlisten = ctx.on('internal/status', fiber => {
            if (fiber.runtime?.callback !== nexusApply || scheduled) return
            scheduled = true
            // Loading has queued its callback; interleave publication at its first async I/O.
            queueMicrotask(() => queueMicrotask(() => {
              competitor = ctx.sessions.prepare('nexus-supervisor')
              detach = ctx.sessions.enter(competitor)
            }))
          })
          await entry.update({ ...entry.options, disabled: false })
          await ctx.loader.await()
          unlisten()
          let startupError
          try { await entry.fiber.await() } catch (error) { startupError = String(error) }
          await entry.update({ ...entry.options, disabled: true })
          await ctx.loader.await()
          const competitorPreserved = !!competitor && ctx.sessions.get(competitor.id) === competitor
          detach?.()
          // A never-flushed failed create may leave no log; reacquire the native writer.
          const replacement = await ctx.sessionPersistence.create(competitor.header)
          await replacement.flush()
          await replacement.close()
          const handle = await ctx.sessionPersistence.open('nexus-supervisor', 'write')
          const { events } = await handle.read()
          const header = handle.header
          await handle.close()
          await writeFile(config.report, JSON.stringify({ startupError, competitorPreserved, supervisorPublished: !!ctx.agents.get('nexus-supervisor'), header, events }))
          return
        }
        const agent = ctx.agents.get('nexus-supervisor')
        if (!agent) throw new Error('Nexus agent missing')
        let duplicateRejected = false
        try { ctx.agents.enter(agent, undefined) } catch { duplicateRejected = true }
        let writerRejected = false
        try { await ctx.sessionPersistence.open(agent.id, 'write') } catch { writerRejected = true }
        worker = await ctx.agents.create({ sessionId: 'ordinary-worker', meta: { cwd: process.cwd() }, agentOptions: { provider: 'nexus-test-worker', model: 'ordinary-model' } })
        const prompt = (sessionId, requestId, text) => ctx.sessionController.prompt({ sessionId, requestId, content: [{ type: 'text', text }], mode: 'followup' }, new AbortController().signal)
        const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        await prompt(worker.agent.id, 'worker-input', 'Hello worker')
        await worker.agent.whenIdle()
        // The worker's finished turn reaches the supervisor; settle that before the scenario starts.
        await agent.whenIdle()
        const baseline = agent.session.seq
        if (config.scenario === 'cancel-retain') {
          agent.followup(message('Queued before cancel'))
          agent.steer(message('Steering before cancel'))
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          await agent.whenIdle()
        } else if (config.scenario === 'cancel-replace') {
          agent.followup(message('Discarded before cancel'))
          agent.cancel({ kind: 'user' })
          agent.followup(message(config.prompt))
          await agent.whenIdle()
        } else if (config.scenario === 'stop-before-wake') {
          agent.followup(message(config.prompt))
          await agent.stop()
        } else {
          if (['stopping-steer', 'stopping-cancel'].includes(config.scenario)) {
            let added = false
            ctx.on('agent/turn-stopping', ({ agent: current }) => {
              if (current !== agent || added) return
              added = true
              if (config.scenario === 'stopping-cancel') agent.cancel({ kind: 'user' })
              else agent.steer(message('Clarification at turn stopping'))
            })
          }
          await prompt(agent.id, 'nexus-test-input', config.prompt)
          await agent.whenIdle()
          await prompt(agent.id, 'nexus-test-input', config.prompt)
          await agent.whenIdle()
        }
        const pending = { queued: [...agent.inbox.nextTurn], steering: [...agent.inbox.nextStep] }
        await ctx.parallel('session/flush', agent.session)
        const workerEvents = worker.agent.session.snapshotEvents()
        const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-nexus')
        if (!entry) throw new Error('Nexus loader entry missing')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const released = !ctx.agents.get(agent.id) && !ctx.sessions.get(agent.id)
        const handle = await ctx.sessionPersistence.open(agent.id, 'write')
        const { events } = await handle.read()
        await handle.close()
        await writeFile(config.report, JSON.stringify({ baseline, agentId: agent.id, sessionId: agent.session.id, duplicateRejected, writerRejected, released, workerIsSupervisor: worker.agent === agent, workerModel: worker.agent.options.model, workerEvents, events, pending }))
      } catch (error) {
        await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack }))
      } finally { await worker?.dispose() }
    }, 1500)
    return () => clearTimeout(timer)
  })
}
