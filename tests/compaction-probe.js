import { writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessionController', 'sessionPersistence', 'sessionProjections', 'llm', 'loader', 'commands', 'agentDefaultModel', 'tokenMeter']
const SUPERVISOR = 'nexus-supervisor'
const WORKER = 'compaction-worker'
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const exists = path => access(path).then(() => true, () => false)
const text = message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')

/**
 * Host-side fixture for main-conversation compaction: a controlled summary model
 * (model "broken" fails), a controlled native worker, and one scenario driven
 * through native entry points, reporting the persisted supervisor log.
 */
export function apply(ctx, config) {
  const summaries = []
  class SummaryAdapter extends LlmAdapter {
    async listModels(provider) { return ['configured-sum', 'default-sum', 'ui-sum', 'broken'].map(id => ({ provider, id, name: `Fixture ${id}` })) }
    async *stream(options) {
      const input = options.messages.map(message => text(message)).join('\n')
      summaries.push({ provider: options.provider, model: options.model, purpose: options.purpose, sessionId: options.sessionId, input })
      if (options.model === 'broken') throw new Error('fixture summary model unavailable')
      const summary = `SUMMARY-${summaries.length}: the user sent long numbered prompts; work results arrive as automatic work-session reports.`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: summary }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const reply = `Worker done: ${text(options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user'))}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['nexus-test-summary'], new SummaryAdapter())
  ctx.llm.registerAdapter(['nexus-test-worker'], new WorkerAdapter())
  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      const report = { pressure: [] }
      try {
        let agent
        while (!(agent = ctx.agents.get(SUPERVISOR))) await sleep(50)
        report.commandsAtStart = ctx.commands.list(agent).map(command => command.name)
        const settle = async () => {
          await sleep(300)
          for (let quiet = 0; quiet < 3; ) {
            const busy = ctx.agents.list().some(item => item.status !== 'idle')
            quiet = busy ? 0 : quiet + 1
            for (const item of ctx.agents.list()) await item.whenIdle()
            await sleep(100)
          }
        }
        const prompt = async (sessionId, words) => {
          await ctx.sessionController.prompt({ sessionId, requestId: `probe-${Date.now()}-${Math.random()}`, content: [{ type: 'text', text: words }], mode: 'followup' }, new AbortController().signal)
          await settle()
          report.pressure.push(ctx.tokenMeter.measure(agent.session).totalTokens)
        }
        const command = line => ctx.commands.execute(agent, line, [], new AbortController().signal)
        if (config.defaultModel) await ctx.agentDefaultModel.saveSelection(config.defaultModel)
        // A recording client end of a call: its states, flushes and the audio of each connection generation.
        const link = report.link = { states: [], flushes: 0, failed: [], samples: [0] }
        const callLink = {
          audio: delta => { link.samples[link.samples.length - 1] += Buffer.byteLength(delta, 'base64') >> 1 },
          flush: () => { link.flushes++ },
          state: state => { link.states.push(state); if (state === 'connecting') link.samples.push(0) },
          failed: code => link.failed.push(code),
        }
        let live
        for (const step of config.steps) {
          if (stopped) return
          // A browser step outside the Host signals its completion with a file.
          if (step.wait) while (!(await exists(resolve(config.dir, step.wait)))) { if (stopped) return; await sleep(100) }
          if (step.config) report.config = structuredClone([...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus').options.config)
          if (step.prompt) await prompt(SUPERVISOR, step.prompt)
          if (step.long) for (let i = 0; i < step.long; i++) await prompt(SUPERVISOR, `LONG-${report.pressure.length} ${'x'.repeat(2400)}`)
          if (step.worker) {
            if (!ctx.agents.get(WORKER)) await ctx.agents.create({ sessionId: WORKER, meta: { cwd: process.cwd() }, agentOptions: { provider: 'nexus-test-worker', model: 'worker-model' } })
            await prompt(WORKER, step.worker)
          }
          if (step.command) (report.commands ??= []).push(await command(step.command))
          if (step.list) report.commandsLater = ctx.commands.list(agent).map(item => item.name)
          if (step.call === 'start') live = await agent.startCall(callLink, new AbortController().signal)
          if (step.call === 'end') { live.end(); await settle() }
          if (step.until === 'rebuilt') while (link.states.at(-1) !== 'live') await sleep(20)
          if (step.speak) {
            // Speech on the rebuilt connection stops playback; the client heard half of the first connection's last reply.
            const flushes = link.flushes
            live.append(Buffer.alloc(3200).toString('base64'))
            while (link.flushes === flushes) await sleep(20)
            report.flushesBeforeSpeech = flushes
            live.played(link.samples[0] - 12000)
            await sleep(200)
          }
        }
        await settle()
        report.tokenUsage = ctx.sessionProjections.stateOf(agent.session, 'tokenUsage')
        report.contextPressure = ctx.sessionProjections.stateOf(agent.session, 'contextPressure')
        report.summaries = summaries
        const worker = ctx.agents.get(WORKER)
        report.worker = worker?.session.snapshotEvents()
        // A Host that lives on for another cycle keeps the plugin enabled and reports the live log.
        for (const item of ctx.agents.list()) await ctx.parallel('session/flush', item.session)
        if (config.live) report.events = agent.session.snapshotEvents()
        else {
          const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
          await entry.update({ ...entry.options, disabled: true })
          await ctx.loader.await()
          const reader = await ctx.sessionPersistence.open(SUPERVISOR, 'read')
          report.events = (await reader.read()).events
          await reader.close()
        }
      } catch (error) {
        report.error = String(error)
        report.stack = error.stack
      }
      await writeFile(resolve(config.dir, config.report ?? 'report.json'), JSON.stringify(report))
    }
    run()
    return () => { stopped = true }
  })
}
