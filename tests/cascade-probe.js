import { access, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'sessionProjections', 'llm', 'loader', 'agentDefaultModel', 'tokenMeter', 'tools']
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const exists = path => access(path).then(() => true, () => false)

/** Controlled external LLM providers loaded into an isolated official Host. No supervisor internals are inspected. */
export function apply(ctx, config) {
  const report = { requests: [], streams: [], summaries: [] }
  const flag = name => resolve(config.dir, name)
  if (config.scenario === 'spoken') ctx.tools.register(defineTool({ name: 'fixture_spoken_lookup', description: 'Controlled external lookup held while the user hangs up.', parameters: { hold: { type: 'boolean', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async (args, exec) => {
    if (!args.hold) return 'QUEUE-LOOKUP-COMPLETED'
    await writeFile(flag('tool-started'), '')
    for (const deadline = Date.now() + 20000; !(await exists(flag('release-tool'))); ) { exec.signal.throwIfAborted(); if (Date.now() > deadline) throw new Error('tool gate timeout'); await sleep(25) }
    return 'LOOKUP-COMPLETED'
  } }))
  const usage = { inputTokens: 100, outputTokens: 8, cacheReadTokens: 200, cacheWriteTokens: 25, totalTokens: 333, reasoningTokens: 2 }
  class SupervisorAdapter extends LlmAdapter {
    async listModels(provider) { return ['normal', 'other'].map(id => ({ provider, id, name: id })) }
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 128000 }, reasoning: { efforts: ['high', 'low'].map(id => ({ id, name: id })), defaultEffort: 'high' } }
    }
    async *stream(options) {
      report.requests.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, tools: options.tools, messages: structuredClone(options.messages), sessionId: options.sessionId })
      if (options.model === 'broken') throw new LlmError('Fixture model request failed', 'FIXTURE_FAILED')
      if (options.model === 'no-tools') throw new LlmError('Fixture model does not support tools', 'UNSUPPORTED_TOOLS')
      if (options.model === 'signed-out') throw new LlmError('Fixture provider is not signed in', 'MISSING_CREDENTIAL')
      const last = options.messages.findLast(message => message.role === 'tool' || message.role === 'user' && message.source?.kind !== 'nexus-runtime')
      const words = textOf(last)
      let tool
      if (config.scenario === 'spoken' && ['SLOW-TOOL', 'QUEUE-SPEECH'].includes(words)) tool = { name: 'fixture_spoken_lookup', arguments: { hold: words === 'SLOW-TOOL' } }
      if (config.scenario === 'spoken' && ['DISPATCH-SPEECH', 'HANGUP-WORK'].includes(words)) tool = { name: 'nexus_send_session', arguments: { sessionId: 'cascade-worker', text: words === 'HANGUP-WORK' ? 'HOLD-WORK' : 'CASCADE-WORK' } }
      if (config.scenario === 'tools' && (last.role === 'tool' || words === 'DISPATCH')) {
        const count = options.messages.filter(message => message.role === 'tool').length
        if (count === 0) tool = { name: 'nexus_list_sessions', arguments: {} }
        if (count === 1) tool = { name: 'nexus_read_session', arguments: { sessionId: 'cascade-worker' } }
        if (count === 2) tool = { name: 'nexus_send_session', arguments: { sessionId: 'cascade-worker', text: 'CASCADE-WORK' } }
      }
      if (tool) {
        if (tool.name === 'fixture_spoken_lookup') { yield { type: 'block-start', index: 1, blockType: 'text' }; yield { type: 'text-delta', index: 1, text: words === 'QUEUE-SPEECH' ? 'QUEUE-FIRST。' : '正在查询。' }; yield { type: 'block-end', index: 1, block: { type: 'text', text: words === 'QUEUE-SPEECH' ? 'QUEUE-FIRST。' : '正在查询。' } } }
        const block = { type: 'tool-call', id: `cascade-${crypto.randomUUID()}`, name: tool.name, arguments: JSON.stringify(tool.arguments) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        if (tool.name === 'nexus_list_sessions') await ctx.agentDefaultModel.saveSelection({ provider: 'cascade-secondary', model: 'other', reasoningEffort: 'low' })
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { fixture: 'native' }, blocks: [{ tool: tool.name }] } }
        return
      }
      const answer = words === 'SENTENCES' ? '第一句。Second sentence!Third?Fourth.\n第五行\n尾句' : words === 'FAIL-SPEECH' ? 'FAIL。文字仍然完整。' : last.source?.kind === 'nexus-work-result' ? 'WORK-RESULT-RECEIVED' : words.includes('STEER-NEW') ? 'STEER-APPLIED' : 'CASCADE-REPLY'
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'fixture reasoning' } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      if (words === 'MIXED-BLOCKS') {
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'BLOCK ONE.' } }
        yield { type: 'block-start', index: 2, blockType: 'text' }
        yield { type: 'text-delta', index: 2, text: 'BLOCK ' }; yield { type: 'text-delta', index: 2, text: 'TWO.' }
        yield { type: 'block-end', index: 2, block: { type: 'text', text: 'BLOCK TWO.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      if (words === 'BLOCK-ONLY') { yield { type: 'block-end', index: 1, block: { type: 'text', text: 'TEXT ONLY.' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (words === 'QUEUE-LOOKUP-COMPLETED') {
        yield { type: 'text-delta', index: 1, text: 'QUEUED ' }
        await writeFile(flag('queue-next-started'), '')
        for (const deadline = Date.now() + 15000; !(await exists(flag('release-queue-model'))); ) { if (Date.now() > deadline) throw new Error('queued model gate timeout'); await sleep(25) }
        yield { type: 'text-delta', index: 1, text: 'SECOND.' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'QUEUED SECOND.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (words === 'HOLD-SPEECH') {
        await writeFile(flag('model-started'), '')
        for (const deadline = Date.now() + 15000; !(await exists(flag('release-first-sentence'))); ) { if (Date.now() > deadline) throw new Error('first sentence gate timeout'); await sleep(25) }
        yield { type: 'text-delta', index: 1, text: '第一句。' }
        for (const deadline = Date.now() + 15000; !(await exists(flag('release-model'))); ) { if (Date.now() > deadline) throw new Error('remaining text gate timeout'); await sleep(25) }
        yield { type: 'text-delta', index: 1, text: 'Second sentence!\n最后一句' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: '第一句。Second sentence!\n最后一句' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 1, text: answer.slice(0, 7) }
      if (words === 'HOLD') {
        await writeFile(flag('model-started'), '')
        for (const deadline = Date.now() + 10000; !(await exists(flag('release-model'))); ) {
          options.signal.throwIfAborted()
          if (Date.now() > deadline) throw new Error('fixture model was not released')
          await sleep(25)
        }
      }
      yield { type: 'text-delta', index: 1, text: answer.slice(7) }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: answer } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { fixture: 'native' }, blocks: [{ reasoning: true }, { text: true }] } }
    }
  }
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      if (options.messages.some(message => message.role === 'user' && textOf(message) === 'HOLD-WORK')) {
        await writeFile(flag('worker-held'), '')
        for (const deadline = Date.now() + 20000; !(await exists(flag('release-worker'))); ) { if (Date.now() > deadline) throw new Error('worker gate timeout'); await sleep(25) }
      }
      await sleep(200)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CASCADE-WORK-DONE' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  class SummaryAdapter extends LlmAdapter {
    async *stream(options) {
      report.summaries.push({ model: options.model, purpose: options.purpose })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CASCADE-SUMMARY: the user asked to remember KESTREL-9.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['cascade-primary', 'cascade-secondary'], new SupervisorAdapter())
  ctx.llm.registerAdapter(['cascade-worker-model'], new WorkerAdapter())
  ctx.llm.registerAdapter(['cascade-summary'], new SummaryAdapter())
  ctx.on('agent/assistant-stream', ({ agent, frame }) => { if (agent.id === 'nexus-supervisor') report.streams.push(structuredClone(frame)) })
  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      try {
        let agent = ctx.agents.get('nexus-supervisor')
        if (!agent) throw new Error('supervisor missing')
        const settle = async () => { for (let stable = 0, seq = -1; stable < 3; ) { for (const item of ctx.agents.list()) await item.whenIdle(); await sleep(50); stable = seq === agent.session.seq ? stable + 1 : 0; seq = agent.session.seq } }
        const prompt = (words, mode = 'followup') => ctx.sessionController.prompt({ sessionId: agent.id, requestId: crypto.randomUUID(), mode, content: [{ type: 'text', text: words }] }, new AbortController().signal)
        await ctx.agentDefaultModel.saveSelection({ provider: 'cascade-primary', model: config.model ?? 'normal', reasoningEffort: 'high' })
        report.config = structuredClone([...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus').options.config)
        if (['ui', 'spoken'].includes(config.scenario)) {
          if (config.scenario === 'spoken') await ctx.agents.create({ sessionId: 'cascade-worker', meta: { cwd: config.dir }, agentOptions: { provider: 'cascade-worker-model', model: 'worker' } })
          await writeFile(flag('ui-ready'), '')
          for (const deadline = Date.now() + 60000; !(await exists(flag('ui-finish'))); ) { if (stopped) return; if (Date.now() > deadline) throw new Error('UI scenario did not finish'); await sleep(50) }
          await settle()
        } else if (config.scenario === 'restore') {
          await prompt('BEFORE-RESTORE'); await settle()
          report.beforeRestore = agent.session.snapshotEvents()
          const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
          await entry.update({ ...entry.options, disabled: true }); await ctx.loader.await()
          await entry.update({ ...entry.options, disabled: false }); await ctx.loader.await()
          agent = ctx.agents.get('nexus-supervisor')
          if (!agent) throw new Error('restored supervisor missing')
          await ctx.agentDefaultModel.saveSelection({ provider: 'cascade-secondary', model: 'other', reasoningEffort: 'low' })
          await prompt('AFTER-RESTORE'); await settle()
        } else if (config.scenario === 'tools') {
          await ctx.agents.create({ sessionId: 'cascade-worker', meta: { cwd: config.dir }, agentOptions: { provider: 'cascade-worker-model', model: 'worker' } })
          await prompt('DISPATCH'); await settle()
          report.worker = ctx.agents.get('cascade-worker').session.snapshotEvents()
        } else if (config.scenario === 'steer') {
          await prompt('HOLD')
          for (const deadline = Date.now() + 10000; !(await exists(flag('model-started'))); ) { if (Date.now() > deadline) throw new Error('no streaming request started'); await sleep(25) }
          report.streamBeforeRelease = report.streams.some(frame => frame.type === 'chunk' && frame.chunk.type === 'text-delta')
          report.runningBeforeSteer = agent.status
          await ctx.agentDefaultModel.saveSelection({ provider: 'cascade-secondary', model: 'other', reasoningEffort: 'low' })
          await prompt('STEER-NEW', 'steer')
          await writeFile(flag('release-model'), '')
          await settle()
        } else if (config.scenario === 'compaction') {
          await prompt('Remember KESTREL-9'); await settle()
          for (let i = 0; i < 7; i++) { await prompt(`LONG-${i} ${'x'.repeat(7200)}`); await settle() }
          await prompt('AFTER-COMPACTION'); await settle()
        } else {
          if (config.model === 'unavailable') await ctx.agentDefaultModel.saveSelection({ provider: 'cascade-unavailable', model: 'missing' })
          await prompt('HELLO'); await settle()
          if (config.scenario === 'basic') {
            await ctx.agentDefaultModel.saveSelection({ provider: 'cascade-secondary', model: 'other', reasoningEffort: 'low' })
            await prompt('SWITCHED'); await settle()
            try { const live = await agent.startCall({ audio() {}, flush() {}, state() {}, failed() {} }, new AbortController().signal); live.end() } catch (error) { report.callError = error.code }
          }
        }
        if (config.scenario === 'spoken') report.worker = ctx.agents.get('cascade-worker').session.snapshotEvents()
        await ctx.parallel('session/flush', agent.session)
        report.events = agent.session.snapshotEvents()
        report.tokenUsage = ctx.sessionProjections.stateOf(agent.session, 'tokenUsage')
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true }); await ctx.loader.await()
        const handle = await ctx.sessionPersistence.open(agent.id, 'read')
        report.persisted = (await handle.read()).events
        await handle.close()
      } catch (error) { report.error = String(error); report.stack = error.stack }
      if (!stopped) await writeFile(flag('report.json'), JSON.stringify(report))
    }
    const timer = setTimeout(run, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  })
}
