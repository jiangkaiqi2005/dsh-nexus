import { writeFile } from 'node:fs/promises'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'sessionTitle', 'llm', 'loader', 'agentDefaultModel']
export function apply(ctx, config) {
  const sleep = ms => new Promise(accept => setTimeout(accept, ms))
  // What each work agent's model actually received as human text, per session, in request order.
  const received = {}
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      let text
      if (options.purpose === 'session-title') {
        const framed = options.messages[0].content[0].text
        text = `Title ${JSON.parse(framed.slice(framed.indexOf('['))).at(0).text.slice(0, 24)}`
      } else {
        const human = options.messages.filter(message => message.role === 'user' && message.source.kind === 'user').map(message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
        ;(received[options.sessionId] ??= []).push(human)
        const task = human.at(-1) ?? ''
        // A held turn runs until steering is pending, so a dispatch meets a running agent.
        if (task.startsWith('hold-')) for (const start = Date.now(); !ctx.agents.get(options.sessionId)?.inbox.nextStep.length && Date.now() - start < 20000; await sleep(20)) options.signal.throwIfAborted()
        text = `Worker executed: ${task}`
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['title-worker'], new WorkerAdapter())
  const until = async (check, what, limit = 20000) => {
    for (const start = Date.now(); !check(); await sleep(50)) if (Date.now() - start > limit) throw new Error(`timed out waiting for ${what}`)
  }
  const settle = async () => {
    for (let stable = 0, last = -1; stable < 3; await sleep(250)) {
      for (const current of ctx.agents.list()) await current.whenIdle()
      const total = ctx.agents.list().reduce((sum, current) => sum + current.session.seq, 0)
      if (total === last && ctx.agents.list().every(current => current.status === 'idle')) stable++
      else { stable = 0; last = total }
    }
  }
  const prompt = (sessionId, requestId, text) => ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
  const titled = id => ctx.sessionTitle.get(ctx.agents.get(id).session)?.source.kind === 'provider'
  const resolveLive = async id => ctx.agents.get(id) ?? (await ctx.sessionController.resolveAgent(id)).agent
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        await until(() => ctx.agents.get('nexus-supervisor'), 'the supervisor')
        const agent = ctx.agents.get('nexus-supervisor')
        const startup = { title: ctx.sessionTitle.get(agent.session) ?? null, seq: agent.session.seq }
        await sleep(300)
        startup.quiet = agent.session.seq === startup.seq
        await ctx.agentDefaultModel.saveSelection({ provider: 'title-worker', model: 'worker-model' })
        if (config.phase === 1) {
          await ctx.sessionController.create({ sessionId: 'titled-idle', cwd: config.workspace })
          await prompt('titled-idle', 'idle-first', 'Existing idle task')
          await ctx.sessionController.create({ sessionId: 'titled-busy', cwd: config.workspace })
          await prompt('titled-busy', 'busy-first', 'hold-busy existing task')
          // An untitled session dispatched to before ADR 0004: its only input is the older nexus-dispatch source.
          await ctx.sessionController.create({ sessionId: 'legacy-worker', cwd: config.workspace })
          ctx.agents.get('legacy-worker').followup(createUserMessage({ content: [{ type: 'text', text: 'run-legacy older dispatch' }], source: { kind: 'nexus-dispatch', sessionId: 'nexus-supervisor', callId: 'legacy-call' } }))
          await until(() => titled('titled-idle') && titled('titled-busy') && ctx.agents.get('titled-busy').status === 'running', 'existing titles and a running busy worker')
          await ctx.agents.get('legacy-worker').whenIdle()
          await ctx.agents.get('titled-idle').whenIdle()
          await agent.whenIdle()
          await prompt(agent.id, 'phase-1', 'PHASE-ONE dispatch')
          await agent.whenIdle()
          await settle()
          const created = ctx.agents.list().find(current => current.id.startsWith('session-'))
          await until(() => created && titled(created.id), 'the native title of the created session')
          // The user also types into the session Nexus created: that is mirrored, the dispatch is not.
          await prompt(created.id, 'user-direct-1', 'user-direct ONE: make it blue')
          await settle()
          // Older Desktop logs end in a fallback title derived from an early test message to Nexus.
          const early = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user')
          agent.session.append('session/title', { title: 'PHASE-ONE dispatch', messageSeqs: [early.seq], source: { kind: 'fallback' } })
        } else if (config.phase === 2) {
          const created = (await ctx.sessionController.list({})).items.find(item => item.sessionId.startsWith('session-'))
          await resolveLive(created.sessionId)
          await prompt(agent.id, 'phase-2', `PHASE-TWO dispatch ${created.sessionId}`)
          await agent.whenIdle()
          await settle()
          await prompt(created.sessionId, 'user-direct-2', 'user-direct TWO: and add a footer')
          await settle()
          await ctx.sessionController.rename({ sessionId: agent.id, title: '我的管家' })
        } else {
          await prompt(agent.id, 'phase-3', 'PHASE-THREE hello')
          await agent.whenIdle()
          await settle()
        }
        const listed = (await ctx.sessionController.list({})).items.map(item => ({ sessionId: item.sessionId, title: item.projections?.values?.title ?? null, lastPromptAt: item.projections?.values?.sessionListMetadata?.lastPromptAt ?? null }))
        const workers = []
        for (const id of ['titled-idle', 'titled-busy', 'legacy-worker', ...listed.filter(item => item.sessionId.startsWith('session-')).map(item => item.sessionId)]) {
          const state = await ctx.sessionController.inspect(id)
          workers.push({ id, header: state.meta, events: state.events })
        }
        const final = { title: ctx.sessionTitle.get(agent.session) ?? null }
        for (const current of ctx.agents.list()) await ctx.parallel('session/flush', current.session)
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(agent.id, 'read')
        const { events } = await reader.read()
        await reader.close()
        await writeFile(config.report, JSON.stringify({ phase: config.phase, startup, final, events, workers, listed, received }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack })) }
    }, 1800)
    return () => clearTimeout(timer)
  })
}
