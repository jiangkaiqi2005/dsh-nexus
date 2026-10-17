import test from 'node:test'
import { openSettings } from './native-settings.mjs'
import assert from 'node:assert/strict'
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startHost } from './host-process.mjs'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { voiceFixture } from './voice-audio.mjs'

const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (predicate, label, ms = 15000) => { for (const deadline = Date.now() + ms; !(await predicate()); ) { if (Date.now() > deadline) throw new Error(`waiting for ${label}`); await sleep(50) } }
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')
const tone = Buffer.alloc(48000); for (let i = 0; i < 24000; i++) tone.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2)
async function tapHost(endpoint, asrEndpoint, run, { real = false, captureFile, observeCapture = false } = {}) {
  const dir = resolve('.scratch/cascade-voice', `04-tap-${Date.now()}`)
  const profile = resolve(dir, 'profiles/spoken'), probe = resolve(dir, 'probe')
  for (const path of [probe, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  await copyFile(resolve('tests/cascade-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-spoken-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: spoken-probe\n      name: nexus-spoken-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        scenario: tap\n`)
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-spoken-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-spoken-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: ${real ? process.env.NEXUS_REAL_CREDENTIAL_REF ?? 'DASHSCOPE_API_KEY' : 'NEXUS_SPOKEN_KEY'}\n    endpoint: ws://127.0.0.1:1\n    ttsEndpoint: ${endpoint}\n    asrEndpoint: ${asrEndpoint}\n    timeoutMs: 10000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n`)
  let output = '', browser, page
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'spoken', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: dir, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_SPOKEN_KEY: 'host-only-fixture-key', DEEPSEEK_API_KEY: '', DSH_TELEMETRY: '0' } }, async child => { child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data }); return {} })
  try {
    let url; await until(() => { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return url }, 'Host URL')
    await until(() => readFile(resolve(dir, 'ui-ready')).then(() => true, () => false), 'registered default model')
    browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(captureFile ? [`--use-file-for-fake-audio-capture=${captureFile}%noloop`] : [])] })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } }); page.setDefaultTimeout(15000)
    if (observeCapture) await page.addInitScript(() => {
      const NativeContext = window.AudioContext
      window.AudioContext = class extends NativeContext { constructor(options) { super(options); if (options?.sampleRate === 16000) window.__captureContext = this } }
    })
    const downlink = []; page.on('websocket', socket => socket.on('framereceived', frame => downlink.push(String(frame.payload))))
    await page.goto(url)
    await until(async () => { for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click() } return page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).isVisible() }, 'native UI')
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    await run(page, dir)
    assert.ok(!downlink.join('').includes('host-only-fixture-key'), 'Host credential never appears in browser frames')
    await writeFile(resolve(dir, 'ui-finish'), '')
    let report; await until(async () => { try { report = JSON.parse(await readFile(resolve(dir, 'report.json'), 'utf8')); return true } catch { return false } }, 'native report')
    assert.equal(report.error, undefined, report.stack)
    console.log('tap evidence:', dir)
    return report
  } catch (error) { if (page) { await page.screenshot({ path: resolve(dir, 'failure.png') }); await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()) } throw error }
  finally { await browser?.close(); await host.close(); await writeFile(resolve(dir, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]')) }
}
const submit = async (page, words) => { const editor = page.getByRole('textbox').last(); await editor.fill(words); await editor.press('Enter') }
const connected = page => page.getByRole('status').filter({ hasText: /已接通 · 点按说话|通话中 · 自动听写/ }).waitFor()

async function endpoints(run) {
  const requests = [], tasks = [], responses = []
  const http = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), auth: request.headers.authorization, path: request.url, at: Date.now() })
    const next = responses.shift() ?? { output: { choices: [{ message: { content: [{ text: '听写一句' }] } }] } }
    if (typeof next === 'function') return next(response)
    response.writeHead(next.status ?? 200, { 'content-type': 'application/json' }); response.end(JSON.stringify(next))
  })
  await new Promise(accept => http.listen(0, '127.0.0.1', accept))
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => ws.once('listening', accept))
  ws.on('connection', socket => {
    let id; const send = event => socket.send(JSON.stringify({ header: { event, task_id: id } }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); id = event.header.task_id
      if (event.header.action === 'run-task') { tasks.push(event.payload); send('task-started') }
      if (event.header.action === 'continue-task') socket.send(tone)
      if (event.header.action === 'finish-task') send('task-finished')
    })
  })
  try { return await run({ requests, tasks, responses, asr: `http://127.0.0.1:${http.address().port}`, tts: `ws://127.0.0.1:${ws.address().port}` }) }
  finally { for (const socket of ws.clients) socket.terminate(); await new Promise(accept => ws.close(accept)); http.closeAllConnections(); await new Promise(accept => http.close(accept)) }
}
const record = async (page, milliseconds = 350) => { await page.getByRole('button', { name: /^点按(?:说话|插话)$/ }).click(); await page.getByRole('status').filter({ hasText: '正在听' }).waitFor(); await sleep(milliseconds); await page.getByRole('button', { name: '结束录音', exact: true }).click() }

test('cascade tap recording uploads Host-authenticated WAV and sends recognized text through the native supervisor to PCM playback', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, requests, tasks }) => {
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await record(page); await page.getByText('听写一句', { exact: true }).waitFor()
    await page.getByText('CASCADE-REPLY', { exact: true }).waitFor()
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > 0, 'reply PCM')
    await page.screenshot({ path: resolve(dir, 'tap-reply.png') }); await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  assert.equal(requests.length, 1); assert.equal(requests[0].auth, 'Bearer host-only-fixture-key')
  const body = requests[0].body; assert.equal(body.model, 'qwen-audio-3.1-asr-flash')
  assert.deepEqual(body.parameters, { format: 'wav', sample_rate: 16000, asr_options: { language: 'zh', enable_itn: false } })
  assert.equal(body.input.messages[0].role, 'user')
  const data = body.input.messages[0].content[0].audio; assert.ok(data.startsWith('data:audio/wav;base64,'))
  const wav = Buffer.from(data.split(',')[1], 'base64'); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), wav.length - 44); assert.ok(wav.length > 44)
  const input = report.persisted.filter(event => event.type === 'user/message' && event.data.source.kind === 'user'); assert.equal(input.length, 1); assert.equal(textOf(input[0].data), '听写一句')
  assert.equal(report.requests[0].provider, 'cascade-primary'); assert.equal(report.persisted.filter(event => event.type === 'turn/end').length, 1); assert.equal(tasks.length, 1)
}))

test('cascade recognition failures and empty results show unheard without native input or a supervisor round', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, requests, tasks, responses }) => {
  responses.push({ output: { text: '   ' } }, { status: 400, code: 'ASR_RESPONSE_HAVE_NO_WORDS' }, { status: 500, message: 'host-only-fixture-key' }, { output: {} })
  const report = await tapHost(tts, asr, async page => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    for (let i = 0; i < 4; i++) { await record(page); await page.getByRole('status').filter({ hasText: '没听清' }).waitFor(); assert.equal(requests.length, i + 1) }
    await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  assert.equal(report.requests.length, 0); assert.equal(tasks.length, 0)
  assert.equal(report.persisted.filter(event => event.type === 'user/message').length, 0); assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 0)
}))

test('cascade recognized speech steers a running native supervisor in the same turn and exposes recognizing while the HTTP request is pending', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, responses }) => {
  let complete
  responses.push(response => { complete = () => response.end(JSON.stringify({ output: { sentence: { text: 'STEER-NEW' } } })) })
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'HOLD'); await until(() => readFile(resolve(dir, 'model-started')).then(() => true, () => false), 'native running supervisor')
    await record(page); await page.getByRole('status').filter({ hasText: '识别中' }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^点按(?:说话|插话)$/ }).isDisabled(), true)
    await until(() => complete, 'held HTTP request'); complete()
    await page.getByText('STEER-NEW', { exact: true }).waitFor()
    await writeFile(resolve(dir, 'release-model'), '')
    await page.getByText('STEER-APPLIED', { exact: true }).waitFor(); await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  const inputs = report.persisted.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  assert.deepEqual(inputs.map(event => textOf(event.data)), ['HOLD', 'STEER-NEW'])
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 1); assert.equal(report.persisted.filter(event => event.type === 'step/start').length, 2)
  assert.ok(report.requests[1].messages.some(message => message.role === 'user' && textOf(message) === 'STEER-NEW'))
}))

test('Host finishes recording after 60 wall-clock seconds even when microphone capture stops without an end button', { timeout: 110000 }, async () => endpoints(async ({ asr, tts, requests, responses }) => {
  responses.push({ output: { text: '自动结束这句' } })
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    const started = Date.now(); await page.getByRole('button', { name: /^点按(?:说话|插话)$/ }).click()
    await page.getByRole('status').filter({ hasText: '正在听' }).waitFor(); await sleep(500)
    await page.evaluate(() => window.__captureContext.suspend())
    await until(() => requests.length === 1, 'Host wall-clock recording deadline', 65000)
    const elapsed = requests[0].at - started; assert.ok(elapsed >= 59000 && elapsed < 65000, `Host ended at ${elapsed} ms`)
    // With capture suspended, the short WAV cannot have reached the 60-second sample limit.
    const wav = Buffer.from(requests[0].body.input.messages[0].content[0].audio.split(',')[1], 'base64'); assert.ok(wav.length > 44 && wav.length < 16000 * 2 * 5)
    await page.getByText('自动结束这句', { exact: true }).waitFor()
    await page.screenshot({ path: resolve(dir, 'automatic-end.png') }); await page.getByRole('button', { name: '挂断', exact: true }).click()
  }, { observeCapture: true })
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 1)
}))

test('hangup and client disconnect abort recognition and discard partial capture without committing late ASR words', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, requests, responses, tasks }) => {
  let response, lost = 0
  const hold = item => { response = item; item.on('close', () => { lost++ }) }
  responses.push(hold, hold)
  const report = await tapHost(tts, asr, async page => {
    const connect = async () => { await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page) }
    await connect(); await record(page); await until(() => response, 'in-flight ASR')
    await page.getByRole('button', { name: '挂断', exact: true }).click(); await until(() => lost === 1, 'aborted ASR HTTP')
    response.end(JSON.stringify({ output: { text: 'LATE-WORDS-MUST-NOT-COMMIT' } }))
    await connect(); await page.getByRole('button', { name: /^点按(?:说话|插话)$/ }).click(); await sleep(350); await page.getByRole('button', { name: '挂断', exact: true }).click()
    await connect(); await record(page); await until(() => requests.length === 2, 'second recognition request')
    await page.reload(); await until(() => lost === 2, 'disconnect aborted recognition')
    response.end(JSON.stringify({ output: { text: 'DISCONNECTED-LATE-WORDS' } }))
  })
  assert.equal(requests.length, 2); assert.equal(tasks.length, 0); assert.equal(report.requests.length, 0)
  assert.equal(report.persisted.filter(event => event.type === 'user/message').length, 0); assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 0)
}))

test('Nexus settings persist the recognition model and endpoint used by the next tap', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, requests, responses }) => {
  responses.push({ text: '设置生效' })
  await tapHost(tts, asr, async (page, dir) => {
    await openSettings(page); await page.getByRole('button', { name: 'Nexus', exact: true }).click(); await page.getByRole('button', { name: '高级：识别与合成端点、型号', exact: true }).click()
    const model = page.getByRole('textbox', { name: '识别型号', exact: true }), endpoint = page.getByRole('textbox', { name: '识别端点', exact: true })
    assert.equal(await model.inputValue(), 'qwen-audio-3.1-asr-flash'); assert.equal(await endpoint.inputValue(), asr)
    await model.fill('fixture-asr-model'); await model.blur(); await until(async () => !(await model.isDisabled()), 'saved model')
    await endpoint.fill(asr + '/recognize'); await endpoint.blur(); await until(async () => !(await endpoint.isDisabled()), 'saved endpoint')
    await page.screenshot({ path: resolve(dir, 'asr-settings.png') }); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page); await record(page)
    await page.getByText('设置生效', { exact: true }).waitFor(); await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  assert.equal(requests.length, 1); assert.equal(requests[0].body.model, 'fixture-asr-model'); assert.equal(requests[0].path, '/recognize')
}))

test('opt-in real ASR hears a synthesized utterance and its native cascade reply reaches browser playback', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 120000 }, async () => {
  const sample = await voiceFixture([{ silence: 2 }, { text: '你好，请回答一句话。', voice: 'Microsoft Huihui Desktop' }, { silence: 3 }])
  const report = await tapHost(process.env.NEXUS_REAL_TTS_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', process.env.NEXUS_REAL_ASR_ENDPOINT ?? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await record(page, Math.ceil(sample.seconds * 1000))
    await page.getByText('CASCADE-REPLY', { exact: true }).waitFor({ timeout: 60000 })
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > 0, 'real recognized reply PCM', 60000)
    await page.screenshot({ path: resolve(dir, 'real-asr-reply.png') }); await page.getByRole('button', { name: '挂断', exact: true }).click()
  }, { real: true, captureFile: sample.path })
  const inputs = report.persisted.filter(event => event.type === 'user/message' && event.data.source.kind === 'user'); assert.equal(inputs.length, 1); assert.ok(textOf(inputs[0].data).trim()); assert.equal(report.persisted.filter(event => event.type === 'turn/end').length, 1)
})
