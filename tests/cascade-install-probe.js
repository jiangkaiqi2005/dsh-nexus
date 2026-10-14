import { access, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { apply as installedApply } from 'dsh-nexus'

export const inject = ['agents', 'sessionController', 'sessionPersistence', 'llm', 'loader', 'agentDefaultModel', 'workspaceRegistry']
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const exists = path => access(path).then(() => true, () => false)
const textOf = message => message.content?.map(part => part.text ?? '').join('\n') ?? ''

/** Only external scripted LLMs; worker file actions use the official native tools. */
export function apply(ctx, config) {
  const flag = name => resolve(config.dir, name)
  const requests = [], workers = []
  class SupervisorAdapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'normal', name: 'normal' }] }
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' } } }
    async *stream(options) {
      requests.push({ model: options.model, provider: options.provider, reasoningEffort: options.reasoningEffort, messages: structuredClone(options.messages), tools: options.tools })
      const last = options.messages.findLast(message => message.role === 'tool' || message.role === 'user' && !['nexus-runtime', 'nexus-voice'].includes(message.source?.kind))
      const words = textOf(last)
      let call
      if (last.role === 'user' && words.includes('SCENARIO-START')) call = { name: 'nexus_send_session', arguments: { sessionId: 'repair', text: '修复数字格式化错误，修好后跑测试。' } }
      if (last.role === 'user' && words.includes('ZERO-WORD')) call = { name: 'nexus_send_session', arguments: { sessionId: 'repair', text: 'ZERO-WORD：零必须显示 zero，继续修复并跑测试。' } }
      if (last.source?.kind === 'nexus-work-result' && words.includes('REPAIR-PASS')) call = { name: 'nexus_send_session', arguments: { sessionId: 'review', text: '独立审查修复和 ZERO-WORD 要求，运行测试。' } }
      if (last.role === 'user' && words.includes('ARCHIVE-WORK')) call = { name: 'nexus_archive_session', arguments: { sessionId: 'repair' } }
      if (call) {
        const block = { type: 'tool-call', id: `install-${crypto.randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const answer = words.includes('REVIEW-PASS') ? 'SCENARIO-COMPLETE：修复和独立审查通过，零显示 zero。' : words.includes('TEXT-CONTINUE') ? 'TEXT-CONTINUED：挂断后继续工作。' : words.includes('archived') ? 'ARCHIVE-COMPLETE：工作会话已归档。' : '派活确认。等待工作结果。'
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: answer }; yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  class WorkerAdapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'worker', name: 'worker' }] }
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 128000 } } }
    async *stream(options) {
      const repair = options.sessionId === 'repair', tools = options.messages.filter(message => message.role === 'tool')
      if (repair && !tools.length) while (!(await exists(flag('release')))) { options.signal.throwIfAborted(); await sleep(50) }
      const requirement = options.messages.filter(message => message.role === 'user').map(textOf).join('\n')
      let call
      if (!tools.length) call = { name: 'read', arguments: { file_path: resolve(config.workspace, 'format.mjs') } }
      else if (repair && tools.length === 2) call = { name: 'write', arguments: { file_path: resolve(config.workspace, 'format.mjs'), content: requirement.includes('ZERO-WORD') ? "export const format = value => value === 0 ? 'zero' : String(value)\n" : 'export const format = value => String(value)\n' } }
      else if (tools.length === 1 || repair && tools.length === 3) call = { name: 'pwsh', arguments: { command: `Set-Location -LiteralPath '${config.workspace.replace(/'/g, "''")}'; node --test format.test.mjs`, description: 'Run acceptance workspace tests' } }
      if (call) {
        const block = { type: 'tool-call', id: `worker-${crypto.randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const passed = /fail\s+0/.test(textOf(tools.at(-1)))
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: `${repair ? 'REPAIR' : 'REVIEW'}-${passed ? 'PASS' : 'FAIL'}: native tests checked.` } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['install-supervisor'], new SupervisorAdapter())
  ctx.llm.registerAdapter(['install-worker'], new WorkerAdapter())
  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'install-worker', model: 'worker' })
        for (const [sessionId, title] of [['repair', '级联修复'], ['review', '级联审查']]) {
          await ctx.sessionController.create({ sessionId, cwd: config.workspace })
          const worker = ctx.agents.get(sessionId); workers.push(worker)
          await ctx.sessionController.selectModel({ sessionId, provider: 'install-worker', model: 'worker' })
          // This disposable fixture uses fixed local commands; native WinACL cannot provision here.
          setSandboxMode(worker.session, 'danger-full-access')
          await ctx.sessionController.rename({ sessionId, title })
        }
        await ctx.agentDefaultModel.saveSelection({ provider: 'install-supervisor', model: 'normal', reasoningEffort: 'high' })
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus'), supervisor = ctx.agents.get('nexus-supervisor')
        const modulePath = fileURLToPath(import.meta.resolve('dsh-nexus'))
        const activation = { modulePath, buildHash: createHash('sha256').update(await readFile(modulePath)).digest('hex'), installed: entry.fiber.runtime.callback === installedApply, agentScopeMatches: scopeOf(supervisor.ctx) === supervisor }
        while (!stopped && !(await exists(flag('finish')))) { await writeFile(flag('ready.json'), JSON.stringify({ ...activation, agents: [supervisor, ...workers].map(agent => ({ id: agent.id, status: agent.status, events: agent.session.snapshotEvents() })), archived: [...ctx.workspaceRegistry.archivedSessionIds] })); await sleep(100) }
        if (stopped) return
        for (const agent of [supervisor, ...workers]) await agent.whenIdle()
        const workerReports = workers.map(agent => ({ id: agent.id, header: agent.session.header, events: agent.session.snapshotEvents() }))
        for (const agent of [supervisor, ...workers]) await ctx.parallel('session/flush', agent.session)
        await entry.update({ ...entry.options, disabled: true }); await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(supervisor.id, 'read'), { events } = await reader.read(); await reader.close()
        await writeFile(flag('result.json'), JSON.stringify({ ...activation, requests, workers: workerReports, events, archived: [...ctx.workspaceRegistry.archivedSessionIds], source: await readFile(resolve(config.workspace, 'format.mjs'), 'utf8') }))
      } catch (error) { await writeFile(flag('result.json'), JSON.stringify({ error: String(error), stack: error.stack })) }
    }
    const timer = setTimeout(run, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  })
}
