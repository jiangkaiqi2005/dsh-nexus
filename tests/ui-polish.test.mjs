import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { startHost } from './host-process.mjs'
import { failureTooltip } from './voice-ui.mjs'

const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (check, label, ms = 20000) => { for (const deadline = Date.now() + ms; !(await check()); ) { if (Date.now() > deadline) throw new Error(`waiting for ${label}`); await sleep(50) } }
const voice = page => page.locator('[data-nexus-voice]')
const status = page => voice(page).getByRole('status')
const button = (page, name) => page.getByRole('button', { name, exact: true })
const submit = async (page, text) => { const editor = page.getByRole('textbox').last(); await editor.fill(text); await editor.press('Enter') }

// Real Host, real Nexus client; only the external ASR/TTS/LLM are controlled.
async function fixture(run, { credential = true } = {}) {
  const dir = resolve('.scratch/ui-polish', `01-${Date.now()}`), profile = resolve(dir, 'profiles/polish'), probe = resolve(dir, 'probe')
  for (const path of [probe, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  await copyFile(resolve('tests/cascade-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-polish-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: polish-probe\n      name: nexus-polish-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        scenario: tap\n`)
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-polish-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-polish-probe'] } } }))
  const responses = [], requests = [], tasks = []
  const http = createServer(async (request, response) => { for await (const chunk of request) {} requests.push(Date.now()); const next = responses.shift() ?? { output: { text: '' } }; if (typeof next === 'function') return next(response); response.writeHead(next.status ?? 200); response.end(JSON.stringify(next)) })
  await new Promise(accept => http.listen(0, '127.0.0.1', accept))
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => ws.once('listening', accept))
  const tone = Buffer.alloc(24000 * 2 * 3); for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2)
  ws.on('connection', socket => {
    const task = { text: [] }; tasks.push(task)
    const send = (event, payload = {}) => socket.readyState === 1 && socket.send(JSON.stringify({ header: { event, task_id: task.id }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); task.id = event.header.task_id
      if (event.header.action === 'run-task') send('task-started')
      if (event.header.action === 'continue-task') { const text = event.payload.input.text; task.text.push(text); if (text.startsWith('FAIL')) return send('task-failed', { message: 'fixture failure' }); send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: 0, words: [] } } }); socket.send(tone) }
      if (event.header.action === 'finish-task') send('task-finished')
    })
  })
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_POLISH_KEY\n    endpoint: ws://127.0.0.1:1\n    ttsEndpoint: ws://127.0.0.1:${ws.address().port}\n    asrEndpoint: http://127.0.0.1:${http.address().port}\n    timeoutMs: 10000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
  let output = '', browser, page
  const pageErrors = [], downlink = []
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'polish', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: dir, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_POLISH_KEY: credential ? 'host-only-polish-key' : '', DSH_TELEMETRY: '0' } }, async child => { child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data }); return {} })
  try {
    let url; await until(() => { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return url }, 'Host URL')
    await until(() => readFile(resolve(dir, 'ui-ready')).then(() => true, () => false), 'controlled model ready')
    browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
    const open = async (scheme = 'dark') => {
      page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 860 }, colorScheme: scheme, deviceScaleFactor: 1 }); page.setDefaultTimeout(15000)
      page.on('pageerror', error => pageErrors.push(String(error)))
      page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
      page.on('websocket', socket => socket.on('framereceived', frame => { const data = String(frame.payload); if (!data.includes('"type":"audio"')) downlink.push(data) }))
      await page.addInitScript(() => {
        window.__duplicateVoice = false
        new MutationObserver(() => { if (document.querySelectorAll('[data-nexus-voice]').length > 1) window.__duplicateVoice = true }).observe(document, { childList: true, subtree: true })
        const NativeContext = window.AudioContext
        window.AudioContext = class extends NativeContext { constructor(options) { super(options); if (options?.sampleRate === 16000) window.__capture = this } }
      })
      await page.goto(url)
      await until(async () => { for (const label of ['继续', '稍后配置']) { const item = button(page, label); if (await item.isVisible()) await item.click() }; if (await voice(page).isVisible()) return true; await button(page, '打开 Nexus').click({ timeout: 1000 }).catch(() => {}) }, 'Nexus composer')
      return page
    }
    await run({ open, browser, dir, responses, requests, tasks })
    await writeFile(resolve(dir, 'ui-finish'), '')
    let report; await until(async () => { try { report = JSON.parse(await readFile(resolve(dir, 'report.json'), 'utf8')); return true } catch { return false } }, 'native journal')
    assert.equal(report.error, undefined, report.stack)
    console.log('ui polish evidence:', dir)
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {}); await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {}); await writeFile(resolve(dir, 'failure.json'), JSON.stringify({ pageErrors, downlink }, null, 2)) }; throw error }
  finally { await browser?.close(); await host.close(); for (const socket of ws.clients) socket.terminate(); await new Promise(accept => ws.close(accept)); http.closeAllConnections(); await new Promise(accept => http.close(accept)); await writeFile(resolve(dir, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]')) }
}

test('Nexus settings show native groups, keep advanced details folded and persist edits through the new controls', { timeout: 90000 }, async () => fixture(async ({ open, dir }) => {
  const page = await open()
  const settings = async () => { await button(page, '设置').click(); await button(page, 'Nexus').click(); await page.getByText('上下文压缩', { exact: true }).waitFor() }
  await settings()
  for (const name of ['通话', '语音服务', '上下文压缩']) assert.equal(await page.getByText(name, { exact: true }).isVisible(), true)
  const advanced = button(page, '高级：识别与合成端点、型号'), more = button(page, '了解更多')
  assert.equal(await advanced.getAttribute('aria-expanded'), 'false')
  assert.equal(await more.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.getByRole('textbox', { name: '识别端点', exact: true }).count(), 0)
  const out = process.env.NEXUS_SETTINGS_SHOTS === '1' ? resolve('docs/ui-polish/verification/shots') : resolve(dir, 'shots')
  await mkdir(out, { recursive: true })
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme })
    await page.waitForTimeout(250)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: resolve(out, `${colorScheme}-settings.png`) })
    await advanced.click(); await more.click()
    await page.getByText('上下文压缩', { exact: true }).scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: resolve(out, `${colorScheme}-settings-expanded.png`) })
    const note = page.locator('.nx-set-note')
    assert.match(await note.allTextContents().then(text => text.join('')), /预算、摘要模型与思考强度立即生效/)
    assert.match(await note.allTextContents().then(text => text.join('')), /摘要无法让请求低于固定开销/)
    await note.last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(out, `${colorScheme}-settings-more.png`) })
    await advanced.click(); await more.click()
    await page.getByText('Nexus', { exact: true }).last().scrollIntoViewIfNeeded()
  }
  await page.getByRole('tab', { name: 'Realtime', exact: true }).click()
  await until(async () => await page.getByRole('tab', { name: 'Realtime', exact: true }).getAttribute('aria-selected') === 'true' && await page.getByRole('switch', { name: '启动后自动接通', exact: true }).isEnabled(), 'mode saved')
  const auto = page.getByRole('switch', { name: '启动后自动接通', exact: true })
  assert.equal(await auto.isChecked(), false)
  await auto.click(); await until(async () => await auto.isChecked() && await auto.isEnabled(), 'automatic voice saved')
  await advanced.click()
  const edits = { '识别端点': 'https://example.invalid/asr', '识别型号': 'fixture-asr', '合成端点': 'wss://example.invalid/tts', '合成型号': 'fixture-tts', '合成音色': 'fixture-voice' }
  for (const [name, value] of Object.entries(edits)) {
    const input = page.getByRole('textbox', { name, exact: true })
    await input.fill(` ${value} `)
    if (name.includes('端点')) await input.press('Enter'); else await input.blur()
    await until(async () => await input.isEnabled() && await input.inputValue() === value, `${name} saved`)
  }
  await page.keyboard.press('Escape'); await settings()
  assert.equal(await page.getByRole('tab', { name: 'Realtime', exact: true }).getAttribute('aria-selected') === 'true', true)
  assert.equal(await auto.isChecked(), true)
  assert.equal(await advanced.getAttribute('aria-expanded'), 'false')
  assert.equal(await more.getAttribute('aria-expanded'), 'false')
  await advanced.click()
  for (const [name, value] of Object.entries(edits)) assert.equal(await page.getByRole('textbox', { name, exact: true }).inputValue(), value)
  assert.equal(await page.getByRole('alert').count(), 0)
}))

test('call bar stays in Nexus, pill navigates back, and only one voice control is ever mounted', { timeout: 90000 }, async () => fixture(async ({ open }) => {
  const page = await open()
  assert.equal(await page.locator('.nx-a-bar').count(), 1)
  assert.equal(await status(page).textContent(), '语音未接通')
  await button(page, '接通语音').click(); await until(async () => await voice(page).getAttribute('data-state') === 'live', 'live')
  await submit(page, 'HELLO'); await page.getByText('CASCADE-REPLY', { exact: true }).waitFor()
  await button(page, '新建会话').last().click()
  await page.locator('.nx-a-pill').waitFor()
  assert.equal(await voice(page).count(), 1)
  await page.locator('.nx-a-pill-main').click()
  await page.locator('.nx-a-bar').waitFor()
  assert.equal(await page.locator('.nx-a-pill').count(), 0)
  await button(page, '设置').click()
  await page.locator('.nx-a-pill').waitFor()
  assert.equal(await voice(page).count(), 1)
  if (process.env.NEXUS_UI_SHOTS === '1') { await mkdir(resolve('docs/ui-polish/verification/shots'), { recursive: true }); await page.mouse.move(0, 0); await page.screenshot({ path: resolve('docs/ui-polish/verification/shots/dark-pill-settings.png') }) }
  await page.locator('.nx-a-pill-main').click()
  await page.locator('.nx-a-bar').waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.evaluate(() => window.__duplicateVoice), false)
  await button(page, '挂断').click()
}))

for (const scheme of ['dark', 'light']) test(`${scheme} real call scenes match the prototype crop and expose microphone/playback levels and recording deadline`, { timeout: 90000 }, async () => fixture(async ({ open, dir }) => {
  const page = await open(scheme)
  const out = process.env.NEXUS_UI_SHOTS === '1' ? resolve('docs/ui-polish/verification/shots') : resolve(dir, 'shots')
  await mkdir(out, { recursive: true })
  const measurements = []
  const shot = async scene => {
    const composer = page.locator('[contenteditable=true]').last(), box = await composer.boundingBox()
    const clip = scene === 'pill-recording' ? undefined : { x: 200, y: Math.max(0, box.y - 190), width: 1160, height: 330 }
    const control = await voice(page).boundingBox()
    measurements.push({ scene, clip, control, status: await status(page).textContent() })
    if (scene !== 'pill-recording') {
      assert.equal(control.height, 44)
      const card = await composer.evaluate(element => { while (element && getComputedStyle(element).borderTopLeftRadius === '0px') element = element.parentElement; const box = element.getBoundingClientRect(); return { x: box.x, width: box.width } })
      assert.ok(Math.abs(control.x - card.x) < 1 && Math.abs(control.width - card.width) < 1, 'bar aligns with the actual input card, before and after messages')
    }
    await page.mouse.move(0, 0)
    await page.screenshot({ path: resolve(out, `${scheme}-${scene}.png`), clip })
  }
  await shot('bar-off')
  await page.evaluate(() => { window.__requestMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')) })
  await button(page, '接通语音').click(); await until(async () => await voice(page).getAttribute('data-state') === 'mic-denied', 'denied')
  await shot('bar-mic-denied')
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__requestMic })
  await button(page, '重试').click(); await until(async () => await voice(page).getAttribute('data-state') === 'live', 'live')
  await shot('bar-ready')
  // Make the main session nonempty so Harness creates another session instead of reusing this blank one.
  await submit(page, 'HELLO'); await page.getByText('CASCADE-REPLY', { exact: true }).waitFor()
  await until(async () => await voice(page).getAttribute('data-activity') === 'idle', 'reply finished')
  await button(page, '点按说话').click()
  assert.equal(await page.locator('.nx-side-dot-rec').count(), 1)
  await until(async () => /0:0[3-9] \/ 1:00/.test(await page.locator('.nx-timer').textContent()), 'real recording timer')
  const scales = () => page.locator('.nx-bars i').evaluateAll(bars => bars.map(bar => bar.style.transform))
  await until(async () => (await scales()).some(scale => scale !== 'scaleY(0.08)'), 'microphone energy')
  await shot('bar-recording')
  await page.evaluate(() => window.__capture.suspend())
  await until(async () => (await scales()).every(scale => scale === 'scaleY(0.08)'), 'suspended input becomes silent')
  await page.evaluate(() => window.__capture.resume())
  await button(page, '新建会话').last().click(); await page.locator('.nx-a-pill').waitFor()
  await shot('pill-recording')
  assert.equal(await voice(page).count(), 1)
  await page.locator('.nx-a-pill-main').click(); await page.locator('.nx-a-bar').waitFor()
  // Fake only the wall clock, not Call state, audio, timers or the Host recording deadline.
  const now = Date.now(); await page.clock.setFixedTime(now + 51000)
  await page.locator('.nx-timer-late').waitFor()
  assert.match(await page.locator('.nx-timer-late').textContent(), /0:5\d \/ 1:00/)
  await page.clock.setSystemTime(Date.now())
  await button(page, '结束录音').click(); await status(page).filter({ hasText: '没听清' }).waitFor()
  assert.equal(await status(page).locator('.nx-info').count(), 0, 'unheard without a code retains the prototype appearance')
  await shot('bar-unheard')
  await submit(page, 'HOLD-SPEECH'); await status(page).filter({ hasText: '思考中' }).waitFor()
  await shot('bar-thinking')
  await writeFile(resolve(dir, 'release-first-sentence'), '')
  await status(page).filter({ hasText: '正在朗读' }).waitFor()
  await until(async () => (await scales()).some(scale => scale !== 'scaleY(0.08)'), 'playback energy')
  await shot('bar-reading')
  assert.equal(await button(page, '点按插话').isEnabled(), true)
  assert.equal(await page.evaluate(() => window.__duplicateVoice), false)
  await button(page, '挂断').click(); await writeFile(resolve(dir, 'release-model'), '')
  await writeFile(resolve(dir, `${scheme}-measurements.json`), JSON.stringify(measurements, null, 2))
}))

test('microphone errors stay friendly and persistent, retain the raw code in Tooltip and recover via Retry', { timeout: 90000 }, async () => fixture(async ({ open }) => {
  const page = await open()
  await page.evaluate(() => { window.__requestMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')) })
  await button(page, '接通语音').click()
  await until(async () => await voice(page).getAttribute('data-state') === 'mic-denied', 'denied')
  assert.equal(await status(page).textContent(), '麦克风权限被拒绝')
  await status(page).locator('.nx-info').hover()
  await page.getByRole('tooltip').filter({ hasText: 'NotAllowedError' }).waitFor()
  assert.match(await page.getByRole('tooltip').textContent(), /允许麦克风后重试/)
  await page.mouse.move(0, 0)
  await sleep(4200)
  assert.equal(await status(page).textContent(), '麦克风权限被拒绝')
  assert.equal(await page.locator('.nx-side-dot-error').count(), 1)
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__requestMic })
  await button(page, '重试').click()
  await until(async () => await voice(page).getAttribute('data-state') === 'live', 'retry live')
  assert.equal(await page.locator('.nx-side-dot-live').count(), 1)
  await button(page, '挂断').click()
}))

test('unheard and synthesis failure expire after four seconds and new activity replaces them immediately', { timeout: 90000 }, async () => fixture(async ({ open, responses, dir }) => {
  const page = await open()
  await button(page, '接通语音').click(); await until(async () => await voice(page).getAttribute('data-state') === 'live', 'live')
  const record = async () => { await button(page, '点按说话').click(); await sleep(350); await button(page, '结束录音').click(); await status(page).filter({ hasText: '没听清' }).waitFor() }
  responses.push({ output: { text: '' } })
  await record()
  const start = Date.now()
  await sleep(3300); assert.equal(await status(page).textContent(), '没听清，请再说一次')
  await until(async () => await status(page).textContent() === '已接通 · 点按说话', 'notice expired', 2000)
  assert.ok(Date.now() - start >= 3700 && Date.now() - start < 5100)
  await record(); await button(page, '点按说话').click()
  assert.match(await status(page).textContent(), /正在听/)
  await button(page, '结束录音').click(); await status(page).filter({ hasText: '没听清' }).waitFor()
  await submit(page, 'FAIL-SPEECH'); await status(page).filter({ hasText: '朗读失败，文字已保留' }).waitFor()
  const failureStart = Date.now()
  await failureTooltip(page, 'TTS_SYNTHESIS_FAILED')
  await page.getByText('FAIL。文字仍然完整。', { exact: true }).waitFor()
  const out = process.env.NEXUS_UI_SHOTS === '1' ? resolve('docs/ui-polish/verification/shots') : resolve(dir, 'shots')
  await mkdir(out, { recursive: true })
  const box = await page.locator('[contenteditable=true]').last().boundingBox()
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: resolve(out, `${colorScheme}-bar-tts-failed.png`), clip: { x: 200, y: Math.max(0, box.y - 190), width: 1160, height: 330 } })
  }
  await sleep(Math.max(0, 3300 - (Date.now() - failureStart))); assert.equal(await status(page).textContent(), '朗读失败，文字已保留')
  await until(async () => await status(page).textContent() === '已接通 · 点按说话', 'TTS notice expired', 2000)
  assert.ok(Date.now() - failureStart >= 3700 && Date.now() - failureStart < 5100)
  assert.equal(await status(page).locator('.nx-info').count(), 0, 'the expired failure code disappears with its notice')
  await button(page, '挂断').click()
}))

test('missing synthesis credential stays distinct from unheard, including after later model activity', { timeout: 90000 }, async () => fixture(async ({ open, requests, tasks }) => {
  const page = await open()
  await button(page, '接通语音').click(); await until(async () => await voice(page).getAttribute('data-state') === 'live', 'live')
  // The current Host drops ASR error codes; drive the real TTS credential
  // error, which does carry its original code.
  await submit(page, 'HELLO'); await page.getByText('CASCADE-REPLY', { exact: true }).waitFor()
  await status(page).filter({ hasText: '未配置 DashScope 凭据' }).waitFor()
  await status(page).locator('.nx-info').hover()
  await page.getByRole('tooltip').filter({ hasText: 'TTS_CREDENTIAL_MISSING' }).waitFor()
  await page.mouse.move(0, 0)
  await sleep(4200)
  assert.equal(await status(page).textContent(), '未配置 DashScope 凭据')
  await submit(page, 'BLOCK-ONLY'); await page.getByText('TEXT ONLY.', { exact: true }).waitFor()
  assert.equal(await status(page).textContent(), '未配置 DashScope 凭据')
  assert.deepEqual([requests.length, tasks.length], [0, 0])
  await button(page, '重试').click()
  await status(page).filter({ hasText: '已接通 · 点按说话' }).waitFor()
  await button(page, '挂断').click()
}, { credential: false }))
