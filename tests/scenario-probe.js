import { access, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { apply as installedApply } from 'dsh-nexus'

export const inject = ['agents', 'sessionController', 'sessionPersistence', 'llm', 'loader', 'agentDefaultModel']
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const exists = path => access(path).then(() => true, () => false)
const textOf = message => message.content?.map(part => part.text ?? '').join('\n') ?? ''

/** Scripted worker models; all file and command actions go through native tools. */
export function apply(ctx, config) {
  const flag = name => resolve(config.dir, name)
  class WorkerAdapter extends LlmAdapter {
    async *stream(options) {
      const repair = options.sessionId === 'repair'
      const tools = options.messages.filter(message => message.role === 'tool')
      if (repair && !tools.length) {
        while (!(await exists(flag('release')))) { options.signal.throwIfAborted(); await sleep(50) }
      }
      const requirement = options.messages.filter(message => message.role === 'user').map(textOf).join('\n')
      let call
      if (!tools.length) call = { name: 'read', arguments: { file_path: resolve(config.workspace, 'format.mjs') } }
      else if (repair && tools.length === 2) call = { name: 'write', arguments: { file_path: resolve(config.workspace, 'format.mjs'), content: requirement.includes('ZERO-WORD') ? "export const format = value => value === 0 ? 'zero' : String(value)\n" : 'export const format = value => String(value)\n' } }
      else if (tools.length === 1 || repair && tools.length === 3) call = { name: 'pwsh', arguments: { command: `Set-Location -LiteralPath '${config.workspace.replace(/'/g, "''")}'; node --test format.test.mjs`, description: 'Run the acceptance workspace tests' } }
      if (call) {
        const block = { type: 'tool-call', id: `scenario-${crypto.randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const passed = /fail\s+0/.test(textOf(tools.at(-1)))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${repair ? 'REPAIR' : 'REVIEW'}-${passed ? 'PASS' : 'FAIL'}: zero requirement checked with native tools.` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['scenario-worker'], new WorkerAdapter())
  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      try {
        await ctx.agentDefaultModel.saveSelection({ provider: 'scenario-worker', model: 'worker' })
        for (const [sessionId, title] of [['repair', '已有修复会话'], ['review', '已有审查会话']]) {
          await ctx.sessionController.create({ sessionId, cwd: config.workspace })
          // Only these disposable fixture workers run the fixed local test command;
          // this machine cannot provision the native Windows ACL sandbox.
          setSandboxMode(ctx.agents.get(sessionId).session, 'danger-full-access')
          await ctx.sessionController.rename({ sessionId, title })
        }
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        while (!stopped && !(await exists(flag('finish')))) {
          await writeFile(flag('ready.json'), JSON.stringify({ pid: process.pid, installed: entry.fiber.runtime.callback === installedApply, agents: ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status, events: agent.session.snapshotEvents() })) }))
          await sleep(100)
        }
        if (stopped) return
        for (const agent of ctx.agents.list()) await agent.whenIdle()
        const workers = ctx.agents.list().filter(agent => agent.id !== 'nexus-supervisor').map(agent => ({ id: agent.id, header: agent.session.header, events: agent.session.snapshotEvents() }))
        for (const agent of ctx.agents.list()) await ctx.parallel('session/flush', agent.session)
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open('nexus-supervisor', 'read')
        const { events } = await reader.read()
        await reader.close()
        await writeFile(flag('result.json'), JSON.stringify({ pid: process.pid, workers, events, source: await readFile(resolve(config.workspace, 'format.mjs'), 'utf8') }))
      } catch (error) { await writeFile(flag('result.json'), JSON.stringify({ error: String(error), stack: error.stack })) }
    }
    const timer = setTimeout(run, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  })
}
