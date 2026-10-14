import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessionController', 'workspaceRegistry', 'llm', 'agentDefaultModel', 'jobs', 'schedule']

/** Drive Nexus through the main conversation and observe native archival and owned work. */
export function apply(ctx, config) {
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const holding = options.messages.some(message => message.role === 'user' && message.content.some(part => part.type === 'text' && part.text === 'hold-until-archive'))
      if (holding && !options.messages.some(message => message.role === 'user' && message.content.some(part => part.type === 'text' && part.text === 'continue-after-unarchive'))) await new Promise((_, reject) => {
        if (options.signal.aborted) return reject(options.signal.reason)
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Conversation resumed with retained history.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['archive-worker'], new WorkerAdapter())
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'archive-worker', model: 'worker-model' })
        await ctx.sessionController.create({ sessionId: 'archive-worker', cwd: config.workspace })
        const worker = ctx.agents.get('archive-worker')
        worker.followup(createUserMessage({ content: [{ type: 'text', text: 'hold-until-archive' }], source: { kind: 'user' } }))
        let processExited = false
        const jobId = ctx.jobs.start({ kind: 'bash', label: 'Controlled long-running process', owner: worker.id, run: () => {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
          const done = new Promise(accept => child.once('exit', () => { processExited = true; accept({ status: 'killed' }) }))
          return { cancel: () => child.kill(), done }
        } })
        await ctx.schedule.create(worker.id, { title: 'Archive must stop this reminder', prompt: 'must-not-deliver-after-archive', after_seconds: 3600 })
        const supervisor = ctx.agents.get('nexus-supervisor')
        const prompt = async text => {
          await ctx.sessionController.prompt({ sessionId: supervisor.id, requestId: text, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
          await supervisor.whenIdle()
        }
        const before = { status: worker.status, jobs: ctx.jobs.list(worker.id), schedules: await ctx.schedule.list({ sessionId: worker.id }) }
        await prompt('ARCHIVE-RUNNING')
        if (!ctx.workspaceRegistry.archivedSessionIds.includes(worker.id)) throw new Error('Nexus did not archive the running work session')
        await worker.whenIdle()
        await ctx.jobs.wait(jobId, 10000, worker.id)
        const archived = { ids: [...ctx.workspaceRegistry.archivedSessionIds], status: worker.status, jobs: ctx.jobs.list(worker.id), schedules: await ctx.schedule.list({ sessionId: worker.id }), processExited, state: await ctx.sessionController.inspect(worker.id) }
        await prompt('ARCHIVE-AGAIN')
        await prompt('ARCHIVE-MAIN')
        await prompt('ARCHIVE-MISSING')
        const afterErrors = [...ctx.workspaceRegistry.archivedSessionIds]
        await ctx.workspaceRegistry.unarchiveSession(worker.id)
        await ctx.sessionController.prompt({ sessionId: worker.id, requestId: 'resume', mode: 'queue', content: [{ type: 'text', text: 'continue-after-unarchive' }] }, new AbortController().signal)
        await worker.whenIdle()
        const restored = { ids: [...ctx.workspaceRegistry.archivedSessionIds], state: await ctx.sessionController.inspect(worker.id) }
        const call = await supervisor.startCall({ audio: () => {}, flush: () => {}, state: () => {}, failed: code => { throw new Error(code) } }, new AbortController().signal)
        call.end()
        await supervisor.whenIdle()
        await writeFile(config.report, JSON.stringify({ before, archived, afterErrors, restored, supervisor: await ctx.sessionController.inspect(supervisor.id) }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack })) }
    }, 1500)
    return () => clearTimeout(timer)
  })
}
