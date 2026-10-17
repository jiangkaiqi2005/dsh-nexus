import { writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'llm', 'loader', 'agentDefaultModel', 'jobs', 'sessionTitle']
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const SUPERVISOR = 'nexus-supervisor'
const THEME = /THEME-[A-Z]+/g

export function apply(ctx, config) {
  const released = new Set()
  const textOf = message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  // The requested theme: the newest user-role input that names one; a token first introduced there wins over ones it only repeats (“use AMBER instead of BLUE”).
  const themes = messages => messages.filter(message => message.role === 'user').reduce((seen, message) => {
    const named = textOf(message).match(THEME) ?? []
    const fresh = named.filter(token => !seen.includes(token))
    return named.length ? [...seen.filter(token => !named.includes(token)), ...named.filter(token => !fresh.includes(token)), ...fresh] : seen
  }, [])
  // Controlled native worker: step 1 is a long model step that ends in a native read; the step after the tool
  // reports the latest theme any user-role input asked for. Its later behaviour is what the steering changed.
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const messages = options.messages
      if (config.background) {
        const input = messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
        const after = messages.slice(messages.indexOf(input) + 1)
        const results = after.filter(message => message.role === 'tool')
        const stopping = input && textOf(input).includes('STOP-BACKGROUND')
        let call
        if (options.purpose === 'session-title') {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '后台计时工作' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (!stopping && !results.length) call = { name: 'pwsh', arguments: { command: "Start-Sleep -Seconds 45; Write-Output 'TIMER-DONE'", description: 'Start the controlled background timer', run_in_background: true } }
        if (stopping && !results.length) call = { name: 'job_list', arguments: {} }
        if (stopping && results.length === 1) call = { name: 'job_kill', arguments: { job_id: textOf(results[0]).match(/pwsh-[0-9a-f]+/)?.[0], reason: 'User asked to stop the timer' } }
        if (stopping && results.length === 2) call = { name: 'job_output', arguments: { job_id: textOf(results[0]).match(/pwsh-[0-9a-f]+/)?.[0], wait: true } }
        if (stopping && results.length === 3) call = { name: 'job_list', arguments: {} }
        if (call) {
          const block = { type: 'tool-call', id: `timer-${crypto.randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const text = stopping ? `Timer verified: ${textOf(results.at(-1))}` : 'Timer started in the background; the worker turn is complete.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const last = messages.findLast(message => message.role === 'assistant' || message.role === 'tool')
      if (last?.role !== 'tool') {
        const agent = ctx.agents.get(options.sessionId)
        const manual = config.manual.includes(options.sessionId)
        for (const start = Date.now(); !released.has(options.sessionId) && !(!manual && agent?.inbox.nextStep.length) && Date.now() - start < config.buildLimitMs; await sleep(20)) options.signal.throwIfAborted()
        const call = { type: 'tool-call', id: `build-${options.sessionId}-${messages.length}`, name: 'read', arguments: JSON.stringify({ file_path: resolve(config.workspace, 'spec.txt') }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const started = themes(messages.slice(0, messages.lastIndexOf(messages.findLast(message => message.role === 'assistant')))).at(-1)
      const theme = themes(messages).at(-1) ?? 'THEME-NONE'
      await writeFile(resolve(config.workspace, `${options.sessionId}.txt`), theme)
      const text = `Built ${options.sessionId} with ${theme} (the build step began with ${started ?? 'no theme'})`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['steer-worker'], new WorkerAdapter())
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      const marks = {}
      try {
        await writeFile(resolve(config.workspace, 'spec.txt'), 'Build the page using the theme the user asks for.')
        await ctx.agentDefaultModel.saveSelection({ provider: 'steer-worker', model: 'worker-model' })
        const supervisor = ctx.agents.get(SUPERVISOR)
        const prompt = (sessionId, text, requestId, mode = 'queue') => ctx.sessionController.prompt({ sessionId, requestId, mode, content: [{ type: 'text', text }] }, new AbortController().signal)
        const create = async sessionId => { await ctx.sessionController.create({ sessionId, cwd: config.workspace }); return ctx.agents.get(sessionId) }
        const until = async (predicate, label, limit = 120000) => { for (const start = Date.now(); !predicate(); await sleep(15)) if (Date.now() - start > limit) throw new Error(`timeout waiting for ${label}`) }
        const ended = (agent, turns) => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length >= turns
        // Settle the supervisor and every worker except those deliberately held in their first step.
        const quiet = async (held = []) => {
          let stable = 0
          let last = -1
          while (stable < 3) {
            const active = ctx.agents.list().filter(agent => !held.includes(agent.id))
            for (const agent of active) await agent.whenIdle()
            await sleep(250)
            const total = active.reduce((sum, agent) => sum + agent.session.seq, 0)
            if (total === last && active.every(agent => agent.status === 'idle')) stable++
            else { stable = 0; last = total }
          }
        }
        if (config.background) {
          const timerWorker = await create('timer-worker')
          // The disposable profile runs only this fixed local timer; avoid the host's unavailable Windows ACL sandbox.
          setSandboxMode(timerWorker.session, 'danger-full-access')
          ctx.sessionTitle.rename(timerWorker.session, '已有后台计时会话')
          await prompt(SUPERVISOR, 'TIMER-START 给已有后台计时会话设置计时', 'timer-start')
          await until(() => ended(timerWorker, 1), 'timer start turn')
          await quiet()
          marks.beforeStop = ctx.jobs.list(timerWorker.id)
          await prompt(SUPERVISOR, 'TIMER-CANCEL-AGENT 仅停止会话当前执行轮次', 'timer-cancel')
          await quiet()
          marks.afterStop = ctx.jobs.list(timerWorker.id)
          await prompt(SUPERVISOR, 'TIMER-STOP 让已有后台计时会话取消计时并核实', 'timer-stop')
          await until(() => ended(timerWorker, 2), 'worker cancelled timer')
          await quiet()
          marks.afterGuidance = ctx.jobs.list(timerWorker.id)
        } else if (config.real) {
          const site = await create('site-worker')
          const doc = await create('doc-worker')
          // The user starts both sessions personally; Nexus learns their tasks only from the mirrored input.
          await prompt('site-worker', config.prompts.site, 'real-site-task')
          await prompt('doc-worker', config.prompts.doc, 'real-doc-task')
          await until(() => site.status === 'running' && doc.status === 'running', 'both workers running')
          await quiet(['site-worker', 'doc-worker'])
          marks.change = supervisor.session.seq
          await prompt(SUPERVISOR, config.prompts.change, 'real-change')
          await until(() => ended(site, 1), 'site worker result', config.buildLimitMs + 60000)
          await quiet(['doc-worker'])
          marks.steer = supervisor.session.seq
          await prompt('doc-worker', config.prompts.steer, 'real-direct-steer', 'steer')
          await quiet(['doc-worker'])
          marks.ask = supervisor.session.seq
          await prompt(SUPERVISOR, config.prompts.ask, 'real-ask')
          await quiet(['doc-worker'])
          marks.release = supervisor.session.seq
          released.add('doc-worker')
          await until(() => ended(doc, 1), 'doc worker result')
          await quiet()
        } else {
          const alpha = await create('alpha')
          const beta = await create('beta')
          const gamma = await create('gamma')
          // A: the user changes the requirement in the main conversation; Nexus steers the running worker.
          await prompt(SUPERVISOR, 'A-START dispatch alpha', 'a-start')
          await until(() => alpha.status === 'running', 'alpha running')
          await quiet(['alpha'])
          marks.aChange = supervisor.session.seq
          await prompt(SUPERVISOR, 'A-CHANGE the user now wants THEME-AMBER for alpha', 'a-change')
          await until(() => ended(alpha, 1), 'alpha result')
          await quiet()
          // B: the user steers a running worker directly while Nexus is idle.
          await prompt(SUPERVISOR, 'B-START dispatch beta', 'b-start')
          await until(() => beta.status === 'running', 'beta running')
          await quiet(['beta'])
          marks.bSteer = supervisor.session.seq
          await prompt('beta', 'Use THEME-CRIMSON instead of THEME-BLUE', 'beta-steer', 'steer')
          await until(() => ended(beta, 1), 'beta result')
          await quiet()
          // C: Nexus is busy with the user; the user queues a new requirement in a worker whose older turn then finishes.
          await prompt(SUPERVISOR, 'C-START dispatch gamma', 'c-start')
          await until(() => gamma.status === 'running', 'gamma running')
          await quiet(['gamma'])
          marks.busyStart = supervisor.session.seq
          await prompt(SUPERVISOR, 'HOLD-BUSY how is the work going?', 'c-hold')
          await until(() => supervisor.status === 'running', 'supervisor running')
          await prompt('gamma', 'Then rebuild it with THEME-JADE', 'gamma-queue')
          released.add('gamma')
          await until(() => ended(gamma, 2), 'gamma two turns')
          await quiet()
        }
        for (const current of ctx.agents.list()) await current.whenIdle()
        const workers = ctx.agents.list().filter(current => current !== supervisor).map(current => ({ id: current.id, header: current.session.header, events: current.session.snapshotEvents() }))
        const artifacts = {}
        for (const worker of workers) artifacts[worker.id] = await readFile(resolve(config.workspace, `${worker.id}.txt`), 'utf8').catch(() => null)
        for (const current of ctx.agents.list()) await ctx.parallel('session/flush', current.session)
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(SUPERVISOR, 'read')
        const { events } = await reader.read()
        await reader.close()
        await writeFile(config.report, JSON.stringify({ pid: process.pid, events, workers, artifacts, marks, released: !ctx.agents.get(SUPERVISOR) }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack })) }
    }, 1800)
    return () => clearTimeout(timer)
  })
}
