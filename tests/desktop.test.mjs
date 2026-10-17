import test from 'node:test'
import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { startHost } from './host-process.mjs'

const root = resolve('.')
const cli = 'D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd'
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const redact = output => output.replace(/\?token=\S+/g, '?token=[redacted]')

async function command(args, env, log) {
  const host = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" ${args.map(arg => `"${arg}"`).join(' ')}"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const completed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code)) })
    let timer
    let code
    try {
      code = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop CLI command timed out')), 180000) })])
    } finally { clearTimeout(timer) }
    await writeFile(log, redact(output))
    assert.equal(code, 0, redact(output).slice(-4000))
    return {}
  })
  await host.close()
}

test('Desktop bundled CLI activates the packed Nexus, queries registered projects and restores its native journal', { skip: process.env.NEXUS_DESKTOP_SMOKE !== '1', timeout: 300000 }, async t => {
  if (process.platform !== 'win32' || !(await access(cli).then(() => true, () => false))) return t.skip('official Desktop dsh.cmd is not installed')
  await mkdir(resolve('.scratch/nexus-v1'), { recursive: true })
  const dir = await mkdtemp(resolve('.scratch/nexus-v1/desktop-smoke-'))
  const home = resolve(dir, 'home')
  const profile = resolve(home, 'profiles/nexus-desktop-smoke')
  const fixture = resolve(profile, 'node_modules/nexus-desktop-probe')
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) })
  await new Promise(accept => server.once('listening', accept))
  let requests = 0
  const wire = []
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      wire.push(event)
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } }))
        requests++
        if (requests === 1) {
          const item = { type: 'function_call', call_id: 'desktop-workspaces', name: 'nexus_list_workspaces', arguments: '{}' }
          socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', ...item }))
          return socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [item] } }))
        }
        socket.send(JSON.stringify({ type: 'response.text.delta', delta: 'DESKTOP-RESTORE-ACK' }))
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
      }
    })
  })
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(dir, 'agents'), DSH_TELEMETRY: '0', NEXUS_DESKTOP_FIXTURE_KEY: 'fixture-not-a-secret' }
  // npm pack uses the current build; install the tgz with Desktop's own plugin manager.
  const packed = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm pack --json --pack-destination "${dir}"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    assert.equal(code, 0, redact(output))
    return { tgz: resolve(dir, JSON.parse(output)[0].filename) }
  })
  await packed.close()
  // Let the official manager initialize its pnpm settings before installing peers.
  await command(['plugin', '--profile', 'nexus-desktop-smoke', 'add', packed.tgz], env, resolve(dir, 'install.log'))
  const manifestPath = resolve(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus']
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.match(await readFile(resolve(profile, 'pnpm-workspace.yaml'), 'utf8'), /autoInstallPeers: false/)
  const expectedBuildHash = createHash('sha256').update(await readFile(resolve('dist/index.js'))).digest('hex')
  await mkdir(fixture, { recursive: true })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-desktop-probe', version: '1.0.0', type: 'module', exports: './index.js' }))
  await copyFile(resolve('tests/desktop-probe.js'), resolve(fixture, 'index.js'))
  const reports = []
  for (const phase of [1, 2]) {
    const report = resolve(dir, `phase-${phase}.json`)
    const ready = resolve(dir, 'ready.json')
    await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    voiceMode: realtime\n    credentialRef: NEXUS_DESKTOP_FIXTURE_KEY\n    endpoint: ws://127.0.0.1:${server.address().port}\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n- insert:\n    - id: nexus-desktop-probe\n      name: nexus-desktop-probe\n      config:\n        phase: ${phase}\n        report: ${JSON.stringify(report)}\n        ready: ${JSON.stringify(ready)}\n`)
    let output = ''
    let host
    try {
      host = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" --profile nexus-desktop-smoke --port 0 --no-open"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
        child.stdout.on('data', data => { output += data })
        child.stderr.on('data', data => { output += data })
        for (const begin = Date.now(); Date.now() - begin < 60000; await delay(100)) {
          if (/did not activate/.test(output)) break
          try {
            if (phase === 2) return { report: JSON.parse(await readFile(report, 'utf8')) }
            JSON.parse(await readFile(ready, 'utf8'))
            const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
            if (url) return { url }
          } catch {}
          if (child.exitCode !== null) break
        }
        throw new Error('Desktop activation produced no report: ' + redact(output).slice(-4000))
      })
      let result = host.report
      if (phase === 1) {
        const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true })
        let page
        try {
          const context = await browser.newContext({ locale: 'zh-CN' })
          page = await context.newPage()
          await page.goto(host.url)
          const bar = page.locator('[data-nexus-voice]')
          for (const begin = Date.now(); !(await bar.isVisible()); await delay(200)) {
            if (Date.now() - begin > 45000) throw new Error('native Nexus composer did not open')
            for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click() }
            await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click({ timeout: 1000 }).catch(() => {})
          }
          // The first-run model dialog may arrive after the Nexus view.
          await delay(1500)
          const skip = page.getByRole('button', { name: '稍后配置', exact: true })
          if (await skip.isVisible()) await skip.click()
          const editor = page.locator('[contenteditable="true"]').last()
          await editor.fill('DESKTOP-RESTORE-MARKER')
          await page.getByRole('button', { name: '发送消息', exact: true }).click()
          for (const begin = Date.now(); !result; await delay(100)) {
            try { result = JSON.parse(await readFile(report, 'utf8')) } catch {}
            if (Date.now() - begin > 60000) throw new Error('native Desktop input did not produce a journal report')
          }
          await page.screenshot({ path: resolve(dir, 'native-input.png') })
          await writeFile(resolve(dir, 'native-input.yml'), await page.locator('body').ariaSnapshot())
        } catch (error) {
          if (page) {
            await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {})
            await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {})
          }
          throw error
        } finally { await browser.close() }
      }
      assert.doesNotMatch(output, /did not activate/)
      assert.equal(result.error, undefined, result.stack)
      assert.equal(result.id, 'nexus-supervisor')
      assert.ok(result.loadedApplyMatchesInstalled, 'the official loader activates the installed tgz')
      assert.ok(result.modulePath.startsWith(profile), 'the plugin comes from this isolated profile')
      assert.equal(result.buildHash, expectedBuildHash, 'installed tgz contains the current build')
      assert.ok(result.agentScopeMatches, 'native Host services recognize the supervisor scope')
      assert.equal(result.status, 'idle')
      assert.equal(result.model, 'qwen3.8-omni-flash-realtime')
      assert.ok(result.released)
      assert.deepEqual(result.events, result.persisted)
      reports.push(result)
    } finally {
      await host?.close()
      await writeFile(resolve(dir, `host-${phase}.log`), redact(output))
    }
  }
  const [first, second] = reports
  assert.notEqual(first.pid, second.pid)
  assert.equal(first.header.agentPreset, 'nexus')
  assert.ok(first.events.some(event => event.type === 'model/selection' && event.data.model === 'qwen3.8-omni-flash-realtime'))
  assert.equal(first.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.ok(first.events.some(event => event.type === 'assistant/message' && event.data.message.content[0]?.text === 'DESKTOP-RESTORE-ACK'))
  assert.deepEqual(second.header, first.header)
  assert.deepEqual(second.events.slice(0, first.events.length), first.events)
  assert.ok(second.events.slice(first.events.length).every(event => event.type === 'session/end-seed'))
  assert.equal(second.events.filter(event => event.type === 'user/message' && event.data.content[0]?.text === 'DESKTOP-RESTORE-MARKER').length, 1)
  assert.equal(second.events.filter(event => event.type === 'turn/start').length, 1, 'restart stays idle without replaying the saved input')
  assert.equal(requests, 2, 'one query and its continuation; restore makes no unsolicited model request')
  assert.ok(wire.find(event => event.type === 'session.update').session.tools.some(tool => tool.name === 'nexus_list_workspaces'))
  const query = first.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'desktop-workspaces').data.message
  assert.equal(query.isError, false)
  assert.ok(JSON.parse(query.content[0].text).items.some(item => item.path === first.header.cwd && item.id && item.title))
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ cli, tgz: packed.tgz, requests, reports, wire }))
  console.log('Desktop activation evidence:', dir)
})
