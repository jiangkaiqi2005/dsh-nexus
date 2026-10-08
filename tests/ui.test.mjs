import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const root = resolve('.')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('Nexus footer opens an enabled native composer and sends to the fixed supervisor', { timeout: 60000 }, async () => {
  const home = resolve('.scratch/nexus-v1', 'ui-' + Date.now())
  const profile = resolve(home, 'profiles/nexus-ui')
  const artifacts = resolve(home, 'output/playwright')
  const report = resolve(home, 'result.json')
  const fixture = resolve(home, 'probe')
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  let modelRequests = 0
  await new Promise(resolve => server.once('listening', resolve))
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'response.create') {
        modelRequests++
        socket.send(JSON.stringify({ type: 'response.text.delta', delta: 'Nexus UI reply' }))
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
      }
    })
  })
  await mkdir(resolve(profile, 'node_modules'), { recursive: true })
  await mkdir(artifacts, { recursive: true })
  await mkdir(fixture, { recursive: true })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-ui-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-ui-probe\n      name: nexus-ui-probe\n      config:\n        report: ${JSON.stringify(report)}\n`)
  await writeFile(resolve(fixture, 'index.js'), `import { writeFile } from 'node:fs/promises'
export const inject = ['agents', 'sessionPersistence']
export function apply(ctx, config) {
  ctx.on('session/event', async (session, event) => {
    if (session.id !== 'nexus-supervisor' || event.type !== 'turn/end') return
    try {
      await ctx.parallel('session/flush', session)
      const handle = await ctx.sessionPersistence.open(session.id, 'read')
      const {events} = await handle.read()
      await handle.close()
      await writeFile(config.report, JSON.stringify({id:session.id, header:handle.header, events}))
    } catch (error) { await writeFile(config.report, JSON.stringify({error:String(error)})) }
  })
}`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-ui-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-ui-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_UI_KEY\n    endpoint: ws://127.0.0.1:${server.address().port}\n    timeoutMs: 5000\n`)
  const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-ui', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, NEXUS_UI_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  let browser
  let page
  try {
    let url
    for (let i = 0; i < 100; i++) { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; if (url) break; await delay(100) }
    assert.ok(url, 'official Host did not start')
    browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } })
    await page.goto(url)
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByRole('button', { name: '稍后配置', exact: true }).click()
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    await page.screenshot({ path: resolve(artifacts, 'nexus-open.png') })
    await writeFile(resolve(artifacts, 'nexus-open.yml'), await page.locator('body').ariaSnapshot())
    const editor = page.getByRole('textbox').last()
    assert.equal(await editor.getAttribute('contenteditable'), 'true', 'Nexus must accept text without switching to a new worker workspace')
    assert.match(await page.getByRole('button', { name: /选择模型/ }).innerText(), /qwen3\.8-omni-flash-realtime/)
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    assert.equal(await editor.getAttribute('contenteditable'), 'true')
    assert.equal(modelRequests, 0, 'opening Nexus must not start a model request')
    await editor.fill('Hello Nexus from the native UI')
    await editor.press('Enter')
    await page.getByText('Nexus UI reply', { exact: true }).waitFor({ timeout: 15000 })
    await page.screenshot({ path: resolve(artifacts, 'nexus-reply.png') })
    let result
    for (let i = 0; i < 100; i++) { try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {} await delay(100) }
    assert.ok(result, 'native UI turn did not flush a terminal record')
    assert.equal(result.error, undefined)
    assert.equal(result.id, 'nexus-supervisor')
    assert.equal(result.header.agentPreset, 'nexus')
    assert.ok(result.events.some(event => event.type === 'user/message' && event.data.content[0].text === 'Hello Nexus from the native UI'))
    assert.ok(result.events.some(event => event.type === 'assistant/message' && event.data.message.source.model === 'qwen3.8-omni-flash-realtime'))
    assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.equal(modelRequests, 1)
    const header = result.events.find(event => event.type === 'request/header')
    const turn = result.events.find(event => event.type === 'turn/start')
    assert.ok(header.seq > turn.seq, 'request header belongs to the real admitted turn')
    console.log('native UI evidence:', home)
  } catch (error) {
    if (page) {
      await page.screenshot({ path: resolve(artifacts, 'failure.png') })
      const snapshot = await page.locator('body').ariaSnapshot()
      await writeFile(resolve(artifacts, 'failure.yml'), snapshot)
      console.log(snapshot)
    }
    throw error
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)])
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
})
