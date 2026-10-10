import { writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'

export const inject = ['agents', 'loader', 'sessionPersistence']

export function apply(ctx, config) {
  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      while (!stopped) {
        await writeFile(resolve(config.dir, 'ready.json'), JSON.stringify({ pid: process.pid, supervisor: !!ctx.agents.get('nexus-supervisor') }))
        if (await access(resolve(config.dir, 'finish')).then(() => true, () => false)) break
        await new Promise(accept => setTimeout(accept, 100))
      }
      if (stopped) return
      const entry = [...ctx.loader.entries()].find(item => item.options.name === 'dsh-nexus')
      await entry.update({ ...entry.options, disabled: true })
      await ctx.loader.await()
      const reader = await ctx.sessionPersistence.open('nexus-supervisor', 'read')
      const { events } = await reader.read()
      await reader.close()
      await writeFile(resolve(config.dir, 'finished.json'), JSON.stringify({ pid: process.pid, events }))
    }
    run().catch(error => writeFile(resolve(config.dir, 'error.json'), JSON.stringify({ error: String(error), stack: error.stack })))
    return () => { stopped = true }
  })
}
