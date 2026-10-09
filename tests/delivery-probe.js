import { writeFile } from 'node:fs/promises'
import { LlmAdapter, HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'llm', 'loader', 'agentDefaultModel', 'tools', 'subagents']
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const SUPERVISOR = 'nexus-supervisor'

export function apply(ctx, config) {
  const gates = new Map()
  const gate = tag => {
    let entry = gates.get(tag)
    if (!entry) { entry = {}; entry.promise = new Promise(accept => { entry.open = accept }); gates.set(tag, entry) }
    return entry
  }
  // Native worker adapter: the outcome of each turn is chosen by the task text.
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const task = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(part => part.type === 'text' && /^(ok|fail|slow|hold|report)-/.test(part.text)).at(-1)?.text ?? ''
      const [kind, ...rest] = task.split('-')
      if (kind === 'hold') await new Promise((accept, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
      if (kind === 'slow') await gate(rest.join('-')).promise
      if (kind === 'fail') throw new HarnessError('worker exploded', 'TEST_WORKER_FAILURE')
      const text = config.reports[rest.join('-')] ?? `Report ${task}: finished`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['delivery-worker'], new WorkerAdapter())
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      const marks = {}
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'delivery-worker', model: 'worker-model' })
        const supervisor = ctx.agents.get(SUPERVISOR)
        const prompt = (text, requestId) => ctx.sessionController.prompt({ sessionId: SUPERVISOR, requestId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
        const create = async sessionId => { await ctx.sessionController.create({ sessionId, cwd: config.workspace }); return ctx.agents.get(sessionId) }
        const task = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        const until = async (predicate, label, limit = 60000) => { for (const start = Date.now(); !predicate(); await sleep(15)) if (Date.now() - start > limit) throw new Error(`timeout waiting for ${label}`) }
        const quiet = async () => {
          let stable = 0
          let last = -1
          while (stable < 3) {
            for (const agent of ctx.agents.list()) await agent.whenIdle()
            await sleep(250)
            const total = ctx.agents.list().reduce((sum, agent) => sum + agent.session.seq, 0)
            if (total === last && ctx.agents.list().every(agent => agent.status === 'idle')) stable++
            else { stable = 0; last = total }
          }
        }
        if (config.real) {
          const existing = await create('user-existing')
          await prompt(config.realPrompts.idle, 'real-idle-setup')
          await supervisor.whenIdle()
          marks.idleStart = supervisor.session.seq
          task(existing, 'report-idle')
          await quiet()
          marks.busyStart = supervisor.session.seq
          const busy = await create('user-busy')
          task(busy, 'slow-busy')
          await until(() => busy.status === 'running', 'busy worker')
          await prompt(config.realPrompts.busy, 'real-busy')
          await until(() => supervisor.status === 'running', 'supervisor running')
          gate('busy').open()
          await quiet()
        } else {
          const existing = await create('user-existing')
          task(existing, 'ok-seed')
          await quiet()

          marks.idle = supervisor.session.seq
          task(existing, 'ok-idle')
          await quiet()

          const failing = await create('failing')
          task(failing, 'fail-boom')
          await quiet()

          const held = await create('held')
          task(held, 'hold-stop')
          await until(() => held.status === 'running', 'held worker')
          await ctx.sessionController.cancel({ sessionId: 'held' })
          await quiet()

          // Two workers whose first turns (same turn number) end together.
          const mixedA = await create('mixed-a')
          const mixedB = await create('mixed-b')
          task(mixedA, 'slow-mix')
          task(mixedB, 'slow-mix')
          await until(() => mixedA.status === 'running' && mixedB.status === 'running', 'mixed workers')
          gate('mix').open()
          await quiet()

          // Busy supervisor: a user input is in flight, the result arrives, then a second input queues.
          const busy = await create('busy')
          task(busy, 'slow-busy')
          await until(() => busy.status === 'running', 'busy worker')
          marks.busyStart = supervisor.session.seq
          await prompt('HOLD-BUSY first user input', 'busy-1')
          await until(() => supervisor.status === 'running', 'supervisor running')
          gate('busy').open()
          await until(() => busy.status === 'idle' && busy.session.snapshotEvents().some(event => event.type === 'turn/end'), 'busy end')
          await prompt('SECOND-USER queued while busy', 'busy-2')
          await quiet()

          // The model, not the connection, chooses the follow-up (see the scripted decision in the fixture).
          const review = await create('review-target')
          task(review, 'ok-FOLLOWUP')
          await quiet()

          // A native continuable child of the supervisor itself: the runtime's own settled notice is its route.
          await ctx.subagents.startContinuable({ provider: 'spawn', childId: 'nexus-child', label: 'Nexus native child', request: { parent: supervisor, agentOptions: { provider: 'delivery-worker', model: 'worker-model' }, prompt: [{ type: 'text', text: 'ok-native' }] }, signal: new AbortController().signal })
          await quiet()
        }

        for (const current of ctx.agents.list()) await current.whenIdle()
        const workers = ctx.agents.list().filter(current => current !== supervisor).map(current => ({ id: current.id, header: current.session.header, events: current.session.snapshotEvents(), status: current.status }))
        if (!config.real && !workers.some(item => item.id === 'nexus-child')) { const state = await ctx.sessionController.inspect('nexus-child'); workers.push({ id: 'nexus-child', header: state.meta, events: state.events, status: 'inactive' }) }
        for (const current of ctx.agents.list()) await ctx.parallel('session/flush', current.session)
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(SUPERVISOR, 'read')
        const { events } = await reader.read()
        await reader.close()
        await writeFile(config.report, JSON.stringify({ pid: process.pid, events, workers, marks, released: !ctx.agents.get(SUPERVISOR) }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack })) }
    }, 1800)
    return () => clearTimeout(timer)
  })
}
