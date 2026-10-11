import { writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessionController', 'sessionPersistence', 'sessionProjections', 'llm', 'loader', 'commands', 'agentDefaultModel', 'tokenMeter', 'agentPresets']
const SUPERVISOR = 'nexus-supervisor'
const WORKER = 'compaction-worker'
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const exists = path => access(path).then(() => true, () => false)
const text = message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')

/**
 * Host-side fixture for main-conversation compaction: a controlled summary model
 * (model "broken" fails; some models offer reasoning efforts), a controlled native worker, and one scenario driven
 * through native entry points, reporting the persisted supervisor log.
 */
// Reasoning efforts of the fixture summary models in adapter-preferred order; a model not listed offers none.
const EFFORTS = { 'configured-sum': ['high', 'low', 'off'], 'default-sum': ['high', 'low'], 'ui-sum': ['high', 'medium', 'low'] }

export function apply(ctx, config) {
  const summaries = []
  class SummaryAdapter extends LlmAdapter {
    async listModels(provider) { return ['configured-sum', 'default-sum', 'ui-sum', 'broken'].map(id => ({ provider, id, name: `Fixture ${id}` })) }
    async resolveModel(provider, id) {
      const efforts = EFFORTS[id]?.map(effort => ({ id: effort, name: effort[0].toUpperCase() + effort.slice(1) }))
      return { provider, id, name: `Fixture ${id}`, ...efforts ? { reasoning: { efforts, defaultEffort: 'high' } } : {} }
    }
    async *stream(options) {
      const input = options.messages.map(message => text(message)).join('\n')
      summaries.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, purpose: options.purpose, sessionId: options.sessionId, input })
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
  // Warnings the supervisor logs (the isolated Host does not print them; exporters take only info and errors by default).
  const warnings = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { if (message.type === 'warn' && typeof message.args[0] === 'string' && message.args[0].startsWith('nexus:')) warnings.push(message.args[0]) } })
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
        // A recording client end of a call: its states, flushes and the audio delivered by the first connection and by later ones
        // (the supervisor's private call state, observed by this fixture only).
        const link = report.link = { states: [], flushes: 0, failed: [], samples: [0, 0] }
        let firstConnection
        const callLink = {
          audio: delta => { link.samples[agent.call?.connection === firstConnection ? 0 : 1] += Buffer.byteLength(delta, 'base64') >> 1 },
          flush: () => { link.flushes++ },
          state: state => link.states.push(state),
          failed: code => link.failed.push(code),
        }
        let live
        for (const step of config.steps) {
          if (stopped) return
          // A browser step outside the Host signals its completion with a file.
          if (step.wait) while (!(await exists(resolve(config.dir, step.wait)))) { if (stopped) return; await sleep(100) }
          if (step.config) report.config = structuredClone([...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus').options.config)
          if (step.prompt) await prompt(SUPERVISOR, step.prompt)
          if (step.long) for (let i = 0; i < step.long; i++) await prompt(SUPERVISOR, `LONG-${report.pressure.length} ${'x'.repeat(7200)}`)
          if (step.worker) {
            if (!ctx.agents.get(WORKER)) await ctx.agents.create({ sessionId: WORKER, meta: { cwd: process.cwd() }, agentOptions: { provider: 'nexus-test-worker', model: 'worker-model' } })
            await prompt(WORKER, step.worker)
          }
          if (step.command) (report.commands ??= []).push(await command(step.command))
          if (step.list) report.commandsLater = ctx.commands.list(agent).map(item => item.name)
          if (step.call === 'start') { live = await agent.startCall(callLink, new AbortController().signal); firstConnection ??= agent.call.connection }
          // Native summarization fields as a user could configure them for the preset's engine, top level and for each summary route.
          if (step.summarizationOverride) {
            const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
            const broken = { summarizationProvider: 'nexus-test-summary', summarizationModel: 'broken' }
            engine.config = { ...engine.config, ...broken, modelPolicies: [...engine.config.modelPolicies, ...['configured-sum', 'default-sum'].map(model => ({ provider: 'nexus-test-summary', model, ...broken }))] }
            report.overridden = engine.config.summarizationModel
          }
          // The user starts speaking as soon as a call rebuild begins (the supervisor's private call state, observed by this fixture only).
          if (step.speakOnRebuild) {
            const watch = setInterval(() => { if (agent.call?.recovering) { clearInterval(watch); report.spokeOnRebuild = true; live.append(Buffer.alloc(3200).toString('base64')) } }, 5)
          }
          if (step.call === 'end') { live.end(); await settle() }
          if (step.until === 'rebuilt') for (const deadline = Date.now() + 15000; agent.call?.connection === firstConnection && Date.now() < deadline; ) await sleep(20)
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
        report.warnings = warnings
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
