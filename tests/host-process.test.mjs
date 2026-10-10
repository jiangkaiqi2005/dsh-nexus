import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startHost } from './host-process.mjs'

const delay = ms => new Promise(accept => setTimeout(accept, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

for (const scenario of ['close', 'readiness-failure', 'root-exit', 'root-exit-success', 'root-exit-inherited-pipes']) {
  test(`test Host cleanup removes only its process tree: ${scenario}`, { timeout: 20000 }, async () => {
    await mkdir(resolve('.scratch/nexus-v1'), { recursive: true })
    const dir = await mkdtemp(resolve('.scratch/nexus-v1/process-cleanup-'))
    const report = resolve(dir, 'pid.json')
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    const marker = 'owned-中文-"quoted"'
    const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:${scenario === 'root-exit-inherited-pipes' ? "['ignore','inherit','inherit']" : "'ignore'"},detached:process.platform==='win32'}); console.log(${JSON.stringify(marker)}); writeFileSync(${JSON.stringify(report)},JSON.stringify({root:process.pid,leaf:leaf.pid})); ${scenario.startsWith('root-exit') ? `leaf.unref(); process.exit(${scenario === 'root-exit-success' ? 0 : 1})` : 'setInterval(()=>{},1000)'}`
    let pids
    let host
    try {
      const start = () => startHost(process.execPath, ['-e', source], {}, async child => {
        let output = ''
        child.stdout.on('data', bytes => { output += bytes })
        for (const begin = Date.now(); !pids || !output.includes(marker); await delay(25)) {
          try { pids = JSON.parse(await readFile(report, 'utf8')) } catch {}
          if (Date.now() - begin > 5000) throw new Error('fixture did not start')
        }
        assert.ok(output.includes(marker), 'quoted arguments and UTF-8 output survive the launcher')
        if (scenario.startsWith('root-exit')) {
          for (let i = 0; i < 100 && alive(pids.root); i++) await delay(25)
          assert.equal(alive(pids.root), false, 'root exited before readiness')
          if (process.platform === 'win32') {
            for (let i = 0; i < 200 && child.exitCode === null; i++) await delay(25)
            assert.equal(child.exitCode, scenario === 'root-exit-success' ? 0 : 1, 'launcher preserves the completed root status')
          }
        }
        if (scenario !== 'close' && scenario !== 'root-exit-success') throw new Error('readiness fixture failed')
        return {}
      })
      if (scenario !== 'close' && scenario !== 'root-exit-success') await assert.rejects(start, /readiness fixture failed/)
      else { host = await start(); await host.close() }
      for (let i = 0; i < 40 && (alive(pids.root) || alive(pids.leaf)); i++) await delay(25)
      assert.equal(alive(pids.root), false, 'owned Host root exited')
      assert.equal(alive(pids.leaf), false, 'owned descendant exited')
      assert.equal(alive(sibling.pid), true, 'another test or user process is untouched')
    } finally {
      await host?.close()
      // Also contain the red test: only fixture PIDs reported by our own child.
      for (const pid of [pids?.root, pids?.leaf, sibling.pid]) {
        if (!pid || !alive(pid)) continue
        if (process.platform === 'win32') await new Promise(accept => spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('close', accept))
        else process.kill(pid, 'SIGKILL')
      }
    }
  })
}
