import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, symlink, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { startHost } from './host-process.mjs'

const delay = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (predicate, label, limit = 45000) => { for (const start = Date.now(); !(await predicate()); await delay(100)) if (Date.now() - start > limit) throw new Error(`timeout waiting for ${label}`) }
const json = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }

async function profile(endpoint, autoVoice = false) {
  const home = resolve('.scratch/nexus-v1', `startup-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-startup')
  const probe = resolve(home, 'probe')
  for (const dir of [probe, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  await copyFile(resolve('tests/startup-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-startup-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-startup-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-startup-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_STARTUP_KEY\n    endpoint: ${endpoint}\n    timeoutMs: 2000\n${autoVoice ? '    autoVoice: true\n' : ''}- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
  let cycle = 0
  return {
    home,
    async start() {
      const dir = resolve(home, `cycle-${++cycle}`)
      await mkdir(dir)
      await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: nexus-startup-probe\n      name: nexus-startup-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n`)
      return startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-startup', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_STARTUP_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' } }, async child => {
        let output = ''
        child.stdout.on('data', data => { output += data; writeFile(resolve(dir, 'host.txt'), output.replace(/\?token=\S+/g, '?token=[redacted]')) })
        child.stderr.on('data', data => { output += data; writeFile(resolve(dir, 'host.txt'), output.replace(/\?token=\S+/g, '?token=[redacted]')) })
        let url
        await until(() => { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return url }, 'official Host URL')
        let ready
        try { await until(async () => { ready = await json(resolve(dir, 'ready.json')); return ready?.supervisor }, 'supervisor ready') }
        catch (error) { await writeFile(resolve(dir, 'host.txt'), output.replace(/\?token=\S+/g, '?token=[redacted]')); throw error }
        const pid = ready.pid
        return { url, pid, dir, async finish() { await writeFile(resolve(dir, 'finish'), ''); await until(async () => !!(await json(resolve(dir, 'finished.json'))), 'durable close'); await writeFile(resolve(dir, 'host.txt'), output.replace(/\?token=\S+/g, '?token=[redacted]')) } }
      })
    },
  }
}

function observe() {
  window.__requests = 0
  window.__streams = []
  const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async constraints => { window.__requests++; const stream = await request(constraints); window.__streams.push(stream); return stream }
}

async function pageFor(browser, url, init = observe) {
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  await (Array.isArray(init) ? page.addInitScript(...init) : page.addInitScript(init))
  await page.goto(url)
  await until(async () => {
    for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
    return page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).isVisible()
  }, 'normal Harness entrance')
  await dismissOnboarding(page)
  return page
}

async function dismissOnboarding(page) {
  // First-run native onboarding can mount after the sidebar becomes visible.
  for (let start = Date.now(); Date.now() - start < 2500; await delay(100)) {
    for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
  }
}

async function setting(page) {
  await until(async () => {
    for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 1000 }).catch(() => {})
    return page.getByRole('dialog', { name: '设置', exact: true }).isVisible()
  }, 'native settings panel')
  const toggle = page.getByRole('checkbox', { name: /启动 Harness 后自动进入 Nexus 语音/ })
  await until(async () => {
    for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
    await page.getByRole('button', { name: 'Nexus', exact: true }).click({ timeout: 1000 }).catch(() => {})
    return toggle.isVisible()
  }, 'Nexus setting')
  return toggle
}

test('startup voice: native default and save, new Host cycles, hangup and pages never repeat automatic capture', { timeout: 180000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const wire = []
  server.on('connection', socket => {
    const connection = wire.filter(event => event.type === 'connected').length + 1
    wire.push({ type: 'connected', connection })
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => { const event = JSON.parse(bytes.toString()); wire.push({ ...event, ...(event.audio ? { audio: '[audio]' } : {}), connection }); if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session })) })
  })
  await new Promise(accept => server.once('listening', accept))
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) })
  const fixture = await profile(`ws://127.0.0.1:${server.address().port}`)
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  t.after(() => browser.close())
  let host = await fixture.start()
  t.after(() => host.close())
  const pids = [host.pid]
  let page = await pageFor(browser, host.url)
  assert.equal(await page.evaluate(() => window.__requests), 0)
  const toggle = await setting(page)
  assert.equal(await toggle.isChecked(), false)
  await toggle.click()
  await until(() => toggle.isChecked(), 'setting saved')
  assert.equal(await page.evaluate(() => window.__requests), 0, 'enabling is for the next startup')
  await page.context().close()
  await host.finish()
  await host.close()
  host = await fixture.start()
  pids.push(host.pid)
  console.log('startup: enabled Host restarted', host.pid)
  assert.notEqual(pids[0], pids[1], 'a real new Host process owns the next cycle')
  page = await pageFor(browser, host.url)
  let bar = page.locator('[data-nexus-voice]')
  await until(async () => await bar.getAttribute('data-state') === 'live', 'automatic voice without navigating or dialing')
  assert.equal(await page.evaluate(() => window.__requests), 1)
  console.log('startup: automatic call live')
  await bar.getByRole('button', { name: '挂断', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState))), ['ended'])
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
  await until(async () => await bar.getAttribute('data-state') === 'idle', 'return to text')
  assert.equal(await page.evaluate(() => window.__requests), 1)
  await page.reload()
  await dismissOnboarding(page)
  console.log('startup: hung up and switched sessions')
  await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
  await until(async () => await bar.getAttribute('data-state') === 'idle', 'reload stays text')
  console.log('startup: reload remains text')
  assert.equal(await page.evaluate(() => window.__requests), 0)
  const second = await pageFor(browser, host.url)
  await second.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
  await until(async () => await second.locator('[data-nexus-voice]').getAttribute('data-state') === 'idle', 'duplicate client stays text')
  assert.equal(await second.evaluate(() => window.__requests), 0)
  await second.context().close()
  await bar.getByRole('button', { name: '接通语音', exact: true }).click()
  await until(async () => await bar.getAttribute('data-state') === 'live', 'manual reconnect')
  await bar.getByRole('button', { name: '挂断', exact: true }).click()
  await page.context().close()
  await host.finish()
  await host.close()
  host = await fixture.start()
  pids.push(host.pid)
  assert.equal(new Set(pids).size, pids.length)
  const contenders = await Promise.all([pageFor(browser, host.url), pageFor(browser, host.url)])
  assert.deepEqual((await Promise.all(contenders.map(candidate => candidate.evaluate(() => window.__requests)))).sort(), [0, 1], 'concurrent clients share one automatic attempt on the new launch')
  page = (await contenders[0].evaluate(() => window.__requests)) ? contenders[0] : contenders[1]
  await contenders.find(candidate => candidate !== page).context().close()
  bar = page.locator('[data-nexus-voice]')
  await until(async () => await bar.getAttribute('data-state') === 'live', 'next real restart has a fresh automatic cycle')
  await bar.getByRole('button', { name: '挂断', exact: true }).click()
  const disable = await setting(page)
  await disable.click()
  await until(async () => !(await disable.isChecked()), 'disabled setting saved')
  await page.context().close()
  await host.finish()
  await host.close()
  host = await fixture.start()
  pids.push(host.pid)
  page = await pageFor(browser, host.url)
  assert.equal(await (await setting(page)).isChecked(), false)
  assert.equal(await page.evaluate(() => window.__requests), 0)
  await host.finish()
  await writeFile(resolve(fixture.home, 'evidence.json'), JSON.stringify({ pids, wire }))
  console.log(`startup evidence: ${fixture.home}`)
})

for (const [failure, expected] of [['permission', 'mic-denied'], ['device', 'no-device'], ['playback', 'playback-blocked'], ['model', 'failed']]) {
  test(`startup voice: ${failure} failure is real, consumed once and manually recoverable`, { timeout: 90000 }, async t => {
    let rejectModel = failure === 'model'
    let connections = 0
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    server.on('connection', socket => {
      connections++
      if (rejectModel) return socket.close()
      socket.send(JSON.stringify({ type: 'session.created' }))
      socket.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session })) })
    })
    await new Promise(accept => server.once('listening', accept))
    t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) })
    const fixture = await profile(`ws://127.0.0.1:${server.address().port}`, true)
    const host = await fixture.start()
    t.after(() => host.close())
    assert.equal(connections, 0, 'Host waits for an actual media client')
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
    t.after(() => browser.close())
    const page = await pageFor(browser, host.url, [kind => {
      window.__failure = kind
      window.__attempts = 0
      window.__requests = 0
      window.__streams = []
      const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.__requests++
        if (window.__failure === 'permission') throw new DOMException('fixture denied permission', 'NotAllowedError')
        if (window.__failure === 'device') throw new DOMException('fixture no device', 'NotFoundError')
        const stream = await request(constraints)
        window.__streams.push(stream)
        return stream
      }
      const Audio = window.AudioContext
      window.AudioContext = class extends Audio {
        constructor(options) { super(options); if (options?.sampleRate === 24000) window.__attempts++ }
        get state() { return window.__failure === 'playback' ? 'suspended' : super.state }
      }
    }, failure])
    const bar = page.locator('[data-nexus-voice]')
    await until(async () => await bar.getAttribute('data-state') === expected, 'actual automatic failure')
    assert.equal(await page.evaluate(() => window.__attempts), 1)
    assert.equal(await page.evaluate(() => window.__requests), failure === 'playback' ? 0 : 1)
    assert.deepEqual(await page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState))), failure === 'model' ? ['ended'] : [])
    await delay(1000)
    assert.equal(await page.evaluate(() => window.__attempts), 1, 'no automatic retry')
    // The existing manual entry works once the external condition is repaired.
    rejectModel = false
    await page.evaluate(() => { window.__failure = undefined })
    await bar.getByRole('button', { name: '接通语音', exact: true }).click()
    await until(async () => await bar.getAttribute('data-state') === 'live', 'manual repair')
    await bar.getByRole('button', { name: '挂断', exact: true }).click()
    await page.reload()
    await dismissOnboarding(page)
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    await until(async () => await bar.getAttribute('data-state') === 'idle', 'failed attempt stays consumed on refresh')
    assert.equal(await page.evaluate(() => window.__attempts), 0)
    assert.equal(await page.evaluate(() => window.__requests), 0)
    await host.finish()
    await writeFile(resolve(fixture.home, 'failure.json'), JSON.stringify({ failure, expected, pid: host.pid, connections }))
    console.log(`startup ${failure} evidence: ${fixture.home}`)
  })
}
