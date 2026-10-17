import { failureTooltip } from './voice-ui.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startHost } from './host-process.mjs'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'

const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (predicate, label, ms = 20000) => { for (const deadline = Date.now() + ms; !(await predicate()); ) { if (Date.now() > deadline) throw new Error(`waiting for ${label}`); await sleep(50) } }
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')
const submit = async (page, words) => { const editor = page.getByRole('textbox').last(); await editor.fill(words); await editor.press('Enter') }
const state = page => page.locator('[data-nexus-voice]').getAttribute('data-state')
const start = page => page.getByRole('button', { name: /^(接通语音|重试)$/ }).click()
const hangup = page => page.getByRole('button', { name: '挂断', exact: true }).click()
const tracks = page => page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))

function instrument() {
  window.__streams = []
  window.__nodes = []
  const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async constraints => { const stream = await request(constraints); window.__streams.push(stream); return stream }
  const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.start = function(when = 0, ...args) { window.__nodes.push({ node: this, when, stopped: false }); return start.call(this, when, ...args) }
  AudioBufferSourceNode.prototype.stop = function(...args) { const item = window.__nodes.find(item => item.node === this); if (item) item.stopped = true; return stop.apply(this, args) }
}

async function open(browser, url, { init, storageState, onSocket, onFrame } = {}) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 900 }, storageState })
  const page = await context.newPage(); page.setDefaultTimeout(20000)
  await page.addInitScript(instrument)
  if (init) await page.addInitScript(init)
  if (onSocket) await page.routeWebSocket(/.*/, socket => { const server = socket.connectToServer(); socket.onMessage(data => server.send(data)); server.onMessage(data => { onFrame?.(String(data)); socket.send(data) }); onSocket(() => { server.close(); socket.close() }) })
  await page.goto(url)
  await until(async () => {
    for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click() }
    if (await page.locator('[data-nexus-voice]').isVisible()) return true
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click({ timeout: 1000 }).catch(() => {})
  }, 'native Nexus entry')
  return page
}

async function lifecycle(run, { autoVoice = false, denying = false, blocked = false } = {}) {
  const dir = resolve('.scratch/cascade-voice', `06-lifecycle-${Date.now()}`)
  const profile = resolve(dir, 'profiles/lifecycle'), probe = resolve(dir, 'probe')
  for (const path of [probe, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  await copyFile(resolve('tests/cascade-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-lifecycle-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: lifecycle-probe\n      name: nexus-lifecycle-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        scenario: spoken\n`)
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-lifecycle-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-lifecycle-probe'] } } }))
  const requests = [], tasks = [], responses = []
  const http = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks).toString())); const reply = responses.shift() ?? { output: { text: '' } }; response.writeHead(reply.status ?? 200); response.end(JSON.stringify(reply)) })
  await new Promise(accept => http.listen(0, '127.0.0.1', accept))
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => ws.once('listening', accept))
  ws.on('connection', socket => {
    const task = { text: [], index: 0 }; tasks.push(task)
    const send = (event, payload = {}) => socket.readyState === 1 && socket.send(JSON.stringify({ header: { event, task_id: task.id }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); task.id = event.header.task_id
      if (event.header.action === 'run-task') send('task-started')
      if (event.header.action === 'continue-task') {
        const text = event.payload.input.text; task.text.push(text)
        if (text.startsWith('FAIL')) return send('task-failed', { message: 'unavailable' })
        send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: task.index, words: [] } } })
        socket.send(Buffer.alloc(24000, 1))
        send('result-generated', { output: { type: 'sentence-end', sentence: { index: task.index++, words: [] }, original_text: text } })
      }
      if (event.header.action === 'finish-task') send('task-finished')
    })
  })
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    autoVoice: ${autoVoice}\n    credentialRef: NEXUS_LIFECYCLE_KEY\n    endpoint: ws://127.0.0.1:1\n    ttsEndpoint: ws://127.0.0.1:${ws.address().port}\n    asrEndpoint: http://127.0.0.1:${http.address().port}\n    timeoutMs: 5000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n`)
  let output = '', browser, page
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'lifecycle', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: dir, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_LIFECYCLE_KEY: 'host-only-lifecycle-key', DSH_TELEMETRY: '0' } }, async child => { child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data }); return {} })
  try {
    let url; await until(() => { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return url }, 'Host URL')
    await until(() => readFile(resolve(dir, 'ui-ready')).then(() => true, () => false), 'native default model')
    browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', ...(denying ? ['--deny-permission-prompts'] : ['--use-fake-ui-for-media-stream']), ...(blocked ? ['--autoplay-policy=document-user-activation-required'] : [])] })
    const sockets = [], frames = []
    page = await open(browser, url, { onSocket: close => sockets.push(close), onFrame: data => frames.push(data) })
    await run({ page, browser, url, dir, tasks, requests, responses, disconnect: () => { assert.ok(sockets.length > 0, 'actual remote transport is routed'); for (const close of sockets) close() } })
    assert.ok(frames.length > 0, 'actual remote downlink was observed')
    assert.ok(!frames.join('').includes('host-only-lifecycle-key'))
    await writeFile(resolve(dir, 'ui-finish'), '')
    let report; await until(async () => { try { report = JSON.parse(await readFile(resolve(dir, 'report.json'), 'utf8')); return true } catch { return false } }, 'native persisted report')
    assert.equal(report.error, undefined, report.stack)
    console.log('cascade lifecycle evidence:', dir)
    return report
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {}); await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {}) } throw error }
  finally { await browser?.close(); await host.close(); for (const socket of ws.clients) socket.terminate(); await new Promise(accept => ws.close(accept)); http.closeAllConnections(); await new Promise(accept => http.close(accept)); await writeFile(resolve(dir, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]')) }
}

test('cascade startup attempts once; hangup, refresh and session navigation never reopen media; manual reconnect keeps native context', { timeout: 90000 }, async () => {
  const report = await lifecycle(async ({ page, dir, tasks, requests }) => {
    await until(async () => await state(page) === 'live', 'automatic cascade live')
    assert.equal((await tracks(page)).length, 1)
    assert.deepEqual([tasks.length, requests.length], [0, 0], 'connecting alone requests no model speech service')
    await submit(page, 'REMEMBER-LIFECYCLE'); await page.getByText('CASCADE-REPLY', { exact: true }).waitFor()
    await hangup(page); await until(async () => await state(page) === 'idle', 'manual hangup')
    assert.deepEqual(await tracks(page), ['ended'])
    await page.reload(); await until(async () => await state(page) === 'idle', 'refresh off'); await sleep(300)
    assert.deepEqual(await tracks(page), [])
    await page.getByRole('button', { name: '新建会话', exact: true }).last().click(); await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click(); assert.deepEqual(await tracks(page), [])
    await start(page); await until(async () => await state(page) === 'live', 'manual reconnect')
    await submit(page, 'AFTER-RECONNECT'); await until(() => readFile(resolve(dir, 'ui-ready')).then(() => true), 'native ready')
    await sleep(400); await hangup(page)
  }, { autoVoice: true })
  const last = report.requests.at(-1)
  assert.ok(last.messages.some(message => message.role === 'user' && textOf(message) === 'REMEMBER-LIFECYCLE'))
  assert.ok(last.messages.some(message => message.role === 'assistant' && textOf(message) === 'CASCADE-REPLY'))
  assert.ok(last.messages.some(message => message.role === 'user' && textOf(message) === 'AFTER-RECONNECT'))
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 2)
})

for (const ending of ['close', 'disconnect']) test(`cascade sole media owner rejects another page before capture; ${ending} preserves Host text work and reentry`, { timeout: 90000 }, async () => {
  const report = await lifecycle(async ({ page, browser, url, dir, tasks, disconnect }) => {
    assert.deepEqual(await tracks(page), [], 'automatic media defaults off')
    await start(page); await until(async () => await state(page) === 'live', 'cascade live')
    await submit(page, 'HANGUP-WORK'); await until(() => readFile(resolve(dir, 'worker-held')).then(() => true, () => false), 'native worker running')
    const second = await open(browser, url); await start(second); await until(async () => await state(second) === 'failed', 'second page rejected')
    assert.equal(await second.locator('[data-nexus-voice]').getByRole('status').textContent(), '另一个窗口正在通话'); await failureTooltip(second, 'CALL_BUSY'); assert.deepEqual(await tracks(second), []); assert.equal(await second.evaluate(() => window.__nodes.length), 0)
    if (ending === 'close') await page.context().close()
    else { await page.context().setOffline(true); disconnect(); await until(async () => (await tracks(page)).every(state => state === 'ended'), 'disconnected capture released') }
    await sleep(200); const before = tasks.length
    await writeFile(resolve(dir, 'release-worker'), '')
    await second.getByText('WORK-RESULT-RECEIVED', { exact: true }).waitFor(); assert.equal(tasks.length, before, 'Host completion is text only')
    await start(second); await until(async () => await state(second) === 'live', 'released owner permits manual reentry')
    await submit(second, 'AFTER-RECONNECT'); await sleep(400); await hangup(second)
    await second.screenshot({ path: resolve(dir, `${ending}-text-result.png`) })
  })
  assert.ok(report.requests.at(-1).messages.some(message => message.source?.kind === 'nexus-work-result' && textOf(message).includes('CASCADE-WORK-DONE')))
  assert.equal(report.worker.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(report.persisted.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result').length, 1)
})

test('cascade microphone denial and absent device report accurate failures before external requests', { timeout: 90000 }, async () => {
  for (const denying of [true, false]) {
    const report = await lifecycle(async ({ page, browser, url, tasks, requests }) => {
      if (!denying) { await page.context().close(); page = await open(browser, url, { init: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('No microphone', 'NotFoundError')) } }) }
      await start(page); await until(async () => await state(page) === (denying ? 'mic-denied' : 'no-device'), 'accurate device failure')
      assert.match(await page.getByRole('status').textContent(), denying ? /麦克风权限被拒绝/ : /没有可用的麦克风/)
      assert.deepEqual([tasks.length, requests.length], [0, 0]); assert.deepEqual(await tracks(page), [])
    }, { denying })
    assert.equal(report.requests.length, 0); assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 0)
  }
})

test('cascade browser autoplay refusal never reports live or requests microphone, ASR or TTS', { timeout: 90000 }, async () => {
  const report = await lifecycle(async ({ page, browser, url, tasks, requests }) => {
    const stored = await page.context().storageState(); await page.context().close()
    const context = await browser.newContext({ locale: 'zh-CN', storageState: stored }); const unattended = await context.newPage()
    await unattended.addInitScript(instrument)
    await unattended.addInitScript(() => { const timer = setInterval(() => { const button = document.querySelector('[data-nexus-voice] button'); if (button) { clearInterval(timer); window.__activated = navigator.userActivation.hasBeenActive; button.click() } }, 100) })
    await unattended.goto(url); await sleep(4000)
    await until(async () => await state(unattended) === 'playback-blocked', 'browser playback refusal')
    assert.equal(await unattended.evaluate(() => window.__activated), false); assert.deepEqual(await tracks(unattended), [])
    assert.deepEqual([tasks.length, requests.length], [0, 0]); await unattended.screenshot({ path: resolve('.scratch/cascade-voice/06-playback-blocked.png') })
  }, { blocked: true })
  assert.equal(report.requests.length, 0)
})

test('cascade unavailable speech services expose unheard or reply synthesis failure while text and the prepared call remain usable', { timeout: 90000 }, async () => {
  const report = await lifecycle(async ({ page, tasks, responses }) => {
    await start(page); await until(async () => await state(page) === 'live', 'media prepared')
    responses.push({ status: 503, message: 'unavailable' })
    await page.getByRole('button', { name: /^点按(?:说话|插话)$/ }).click(); await sleep(350); await page.getByRole('button', { name: '结束录音', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '没听清' }).waitFor(); assert.equal(await state(page), 'live')
    await submit(page, 'FAIL-SPEECH'); await page.getByRole('status').filter({ hasText: '朗读失败，文字已保留' }).waitFor()
    await page.getByText('FAIL。文字仍然完整。', { exact: true }).waitFor(); assert.equal(await state(page), 'live')
    await submit(page, 'RECOVER-SPEECH'); await until(() => tasks.length === 2, 'next reply synthesis recovers'); await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > 0, 'next reply PCM')
    await hangup(page)
  })
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 2, 'ASR failure creates no turn')
  assert.ok(report.persisted.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
})
