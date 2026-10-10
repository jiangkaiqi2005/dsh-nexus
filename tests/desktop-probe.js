import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { apply as installedApply } from 'dsh-nexus'

export const inject = ['agents', 'sessions', 'sessionPersistence', 'loader']

/** Observe activation and read the journal through the native persistence API. */
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopped = false
    const timer = setTimeout(async () => {
      try {
        const agent = ctx.agents.get('nexus-supervisor')
        if (!agent) throw new Error('Nexus supervisor is not active')
        const initial = agent.session.snapshotEvents()
        if (config.phase === 1) {
          await writeFile(config.ready, JSON.stringify({ id: agent.id, pid: process.pid }))
          // Input enters through the official native composer, not this fixture's caller scope.
          while (!stopped && !agent.session.snapshotEvents().some(event => event.type === 'turn/end')) await new Promise(accept => setTimeout(accept, 100))
          if (stopped) return
          await agent.whenIdle()
        }
        const status = agent.status
        await ctx.parallel('session/flush', agent.session)
        const events = agent.session.snapshotEvents()
        const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
        const modulePath = fileURLToPath(import.meta.resolve('dsh-nexus'))
        const buildHash = createHash('sha256').update(await readFile(modulePath)).digest('hex')
        const loadedApplyMatchesInstalled = entry.fiber.runtime.callback === installedApply
        const agentScopeMatches = scopeOf(agent.ctx) === agent
        await entry.update({ ...entry.options, disabled: true })
        await ctx.loader.await()
        const reader = await ctx.sessionPersistence.open(agent.id, 'read')
        const header = reader.header
        const { events: persisted } = await reader.read()
        await reader.close()
        await writeFile(config.report, JSON.stringify({ pid: process.pid, id: agent.id, model: agent.options.model, status, modulePath, buildHash, loadedApplyMatchesInstalled, agentScopeMatches, header, initial, events, persisted, released: !ctx.agents.get(agent.id) && !ctx.sessions.get(agent.id) }))
      } catch (error) { await writeFile(config.report, JSON.stringify({ error: String(error), stack: error.stack, details: { ...error } })) }
    }, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  })
}
