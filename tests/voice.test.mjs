import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, symlink, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { voiceFixture } from './voice-audio.mjs'

const root = resolve('.')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const MODEL = 'qwen3.8-omni-flash-realtime'
const ZH = 'Microsoft Huihui Desktop'
const textOf = message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
const until = async (predicate, label, limit = 60000) => { for (const start = Date.now(); !(await predicate()); await delay(100)) if (Date.now() - start > limit) throw new Error(`timeout waiting for ${label}`) }

/** 24 kHz PCM16 tone standing in for model speech in the controlled endpoint. */
const tone = seconds => { const samples = Math.round(seconds * 24000); const pcm = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2); return pcm.toString('base64') }
/** Each scripted spoken reply carries two 0.4 s deltas. */
const REPLY_SAMPLES = 2 * 9600

/**
 * Controlled DashScope voice endpoint: an energy VAD over the PCM16 the Host
 * actually forwards decides utterance boundaries, then scripted events follow
 * the real protocol (committed item, input transcription, audio and transcript
 * deltas, function calls answered on the same connection).
 */
function controlledModel({ withhold = false } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const wire = []
  const log = { connections: 0, closed: 0, utterances: [], appendedBytes: 0, voicedFrames: 0, responses: [] }
  server.on('connection', socket => {
    const connection = ++log.connections
    socket.on('close', () => log.closed++)
    const send = event => socket.send(JSON.stringify(event))
    const items = []
    let answered = 0
    let responses = 0
    let speaking = false
    let voiced = 0
    let quiet = 0
    let pending = Buffer.alloc(0)
    const respond = ({ text, call }) => {
      const id = `resp-${connection}-${++responses}`
      log.responses.push({ connection, id, text, call: call?.name })
      send({ type: 'response.created', response: { id, status: 'in_progress' } })
      if (call) {
        const item = { type: 'function_call', call_id: `call-${id}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        send({ type: 'response.output_item.added', response_id: id, item: { id: `item-${id}`, ...item } })
        send({ type: 'response.function_call_arguments.done', response_id: id, item_id: `item-${id}`, ...item })
        return send({ type: 'response.done', response: { id, status: 'completed', output: [item] } })
      }
      send({ type: 'response.audio_transcript.delta', response_id: id, delta: text })
      send({ type: 'response.audio.delta', response_id: id, delta: tone(0.4) })
      send({ type: 'response.audio.delta', response_id: id, delta: tone(0.4) })
      send({ type: 'response.audio_transcript.done', response_id: id, transcript: text })
      send({ type: 'response.audio.done', response_id: id })
      send({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'audio', transcript: text }] }] } })
    }
    const utterance = () => {
      const index = log.utterances.length + 1
      const itemId = `audio-item-${index}`
      log.utterances.push({ connection, itemId, at: Date.now() })
      send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
      send({ type: 'input_audio_buffer.committed', item_id: itemId })
      send({ type: 'conversation.item.created', item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_audio' }] } })
      if (index === 1) {
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: 'UTT-ONE 请让文档会话开始编写接口文档。' })
        respond({ call: { name: 'nexus_send_session', arguments: { sessionId: 'docs', text: 'DOC-TASK write the API reference' } } })
      } else {
        // The transcript may trail the response it belongs to.
        respond({ text: index === 2 ? 'VOICE-SECOND 一加一等于二。' : `VOICE-${index}` })
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: index === 2 ? 'UTT-TWO 另外，一加一等于几？' : `UTT-${index}` })
      }
    }
    send({ type: 'session.created', session: { id: `session-${connection}` } })
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'input_audio_buffer.append') {
        const pcm = Buffer.from(event.audio, 'base64')
        log.appendedBytes += pcm.length
        wire.push({ connection, type: event.type, bytes: pcm.length })
        pending = Buffer.concat([pending, pcm])
        for (; pending.length >= 640; pending = pending.subarray(640)) {
          let sum = 0
          for (let i = 0; i < 640; i += 2) sum += pending.readInt16LE(i) ** 2
          const loud = Math.sqrt(sum / 320) > 600
          if (loud) log.voicedFrames++
          if (!speaking) { voiced = loud ? voiced + 1 : 0; if (voiced >= 3) { speaking = true; quiet = 0; send({ type: 'input_audio_buffer.speech_started' }) } }
          else { quiet = loud ? 0 : quiet + 1; if (quiet >= 35) { speaking = false; voiced = 0; utterance() } }
        }
        return
      }
      wire.push({ connection, ...event })
      // withhold: the endpoint got the request but never confirmed the voice session.
      if (event.type === 'session.update' && !withhold) send({ type: 'session.updated', session: event.session })
      if (event.type === 'conversation.item.create') items.push(event.item.type === 'function_call_output' ? `[function_call_output ${event.item.call_id}] ${event.item.output}` : event.item.content?.map(part => part.text).join('\n') ?? '')
      if (event.type === 'response.create') {
        const fresh = items.slice(answered).join('\n')
        answered = items.length
        respond({ text: fresh.includes('Automatic work-session result') ? 'RESULT-HEARD 文档会话已完成。' : fresh.includes('function_call_output') ? 'DOC-DISPATCHED 已安排文档会话。' : 'HOST-REPLY' })
      }
    })
  })
  return { server, wire, log, ready: new Promise(accept => server.once('listening', accept)) }
}

async function voiceHost(scenario, { endpoint, credentialRef = 'NEXUS_VOICE_KEY', key = 'fixture-not-a-secret' } = {}) {
  const home = resolve('.scratch/nexus-v1', `voice-${scenario}-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-voice')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules'), resolve(home, 'output')]) await mkdir(dir, { recursive: true })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-voice-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/voice-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-voice-probe\n      name: nexus-voice-probe\n      config:\n        dir: ${JSON.stringify(home)}\n        workspace: ${JSON.stringify(workspace)}\n        marker: DOC-READY-42\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-voice-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-voice-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: ${credentialRef}\n    endpoint: ${endpoint}\n    timeoutMs: 30000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
  const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-voice', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), [credentialRef]: key, DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 300 && !url; i++) { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; if (!url) await delay(100) }
  assert.ok(url, 'official Host did not start: ' + output.slice(-3000))
  // The probe rewrites status.json continuously; retry reads that catch a partial write.
  const status = async () => { for (let i = 0; i < 20; i++) { try { return JSON.parse(await readFile(resolve(home, 'status.json'), 'utf8')) } catch { await delay(25) } } }
  await until(async () => (await status())?.ready, 'probe ready')
  return {
    home, url, status,
    output: () => output.replace(/\?token=\S+/g, '?token=[redacted]'),
    async finish() {
      await writeFile(resolve(home, 'finish'), '')
      let result
      await until(async () => { try { result = JSON.parse(await readFile(resolve(home, 'result.json'), 'utf8')); return true } catch { return child.exitCode !== null } }, 'native report', 60000)
      assert.ok(result, 'no native report: ' + output.slice(-3000))
      assert.equal(result.error, undefined, result.stack)
      return result
    },
    release: () => writeFile(resolve(home, 'release'), ''),
    async close() { child.kill('SIGTERM'); await Promise.race([new Promise(accept => child.once('exit', accept)), delay(5000)]) },
  }
}

/** Open the native UI, enter Nexus and return the call bar of the main conversation. */
async function openNexus(browser, url, init) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  if (init) await page.addInitScript(init)
  await page.goto(url)
  // Preview and setup dialogs may appear at any point while the UI loads; dismiss them until Nexus opens.
  const nexus = page.getByRole('button', { name: /打开 Nexus|Open Nexus/ })
  const dialogs = [page.getByRole('button', { name: '继续', exact: true }), page.getByRole('button', { name: '稍后配置', exact: true })]
  const bar = page.locator('[data-nexus-voice]')
  for (const begin = Date.now(); !(await bar.isVisible()); ) {
    if (Date.now() - begin > 45000) { console.log(await page.locator('body').ariaSnapshot()); throw new Error('Nexus call bar did not open') }
    for (const dialog of dialogs) if (await dialog.isVisible()) await dialog.click({ timeout: 2000 }).catch(() => {})
    await nexus.click({ timeout: 1000 }).catch(() => {})
    await delay(200)
  }
  return { context, page, bar }
}

const state = bar => bar.getAttribute('data-state')

test('voice call: client audio reaches the Host-held model, which speaks, dispatches work and keeps talking while it runs', { timeout: 240000 }, async () => {
  const model = controlledModel()
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 9 }, { text: '另外，一加一等于几？', voice: ZH }, { silence: 40 }])
  const host = await voiceHost('controlled', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    assert.equal(await state(bar), 'idle')
    assert.equal(model.log.connections, 0, 'opening Nexus does not connect the voice model')
    await bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    await until(async () => (await state(bar)) === 'live', 'live call')
    const update = model.wire.find(event => event.type === 'session.update')
    assert.deepEqual(update.session.modalities, ['text', 'audio'])
    assert.equal(update.session.turn_detection.type, 'server_vad')
    assert.equal(update.session.input_audio_format, 'pcm16')
    assert.ok(update.session.tools.some(tool => tool.name === 'nexus_send_session'), 'the same model holds the dispatch tools')

    // Utterance 1 → native tool call dispatches the existing docs session, which keeps running.
    await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'docs worker running')
    // Utterance 2 arrives and is answered while the worker is still executing.
    await until(() => model.log.responses.some(response => response.text?.startsWith('VOICE-SECOND')), 'second utterance answered')
    await until(async () => Number(await bar.getAttribute('data-played-samples')) >= 2 * REPLY_SAMPLES, 'client scheduled both spoken replies', 15000)
    const busy = (await host.status()).agents.find(agent => agent.id === 'docs')
    assert.deepEqual([busy.status, busy.ends], ['running', 0], 'the second exchange happened while the work was still executing')
    await host.release()
    await until(() => model.log.responses.some(response => response.text?.startsWith('RESULT-HEARD')), 'result delivered to the voice model')
    await until(async () => Number(await bar.getAttribute('data-played-samples')) >= 3 * REPLY_SAMPLES, 'client scheduled the spoken result', 15000)
    assert.equal(await state(bar), 'live')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')
    await page.screenshot({ path: resolve(host.home, 'output/voice-call.png') })

    const result = await host.finish()
    await writeFile(resolve(host.home, 'wire.json'), JSON.stringify({ wire: model.wire, log: model.log }))
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const user = text => events.find(event => event.type === 'user/message' && textOf(event.data).includes(text))
    const reply = text => events.find(event => event.type === 'assistant/message' && textOf(event.data.message).includes(text))

    // The voice model received the real captured speech as two utterances on one connection.
    assert.equal(model.log.connections, 1)
    assert.equal(model.log.utterances.length, 2)
    assert.ok(model.log.appendedBytes > 2 * 16000 * 5, 'continuous 16 kHz PCM16 capture reached the model')
    // Utterance 1: transcript, tool call, native tool execution and spoken continuation in one native turn.
    const first = user('UTT-ONE')
    assert.equal(first.data.source.kind, 'user')
    const call = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_send_session')
    const output = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    assert.equal(output.data.message.isError, false)
    const dispatched = reply('DOC-DISPATCHED')
    assert.deepEqual([turnOf(call.seq), turnOf(output.seq), turnOf(dispatched.seq)], [turnOf(first.seq), turnOf(first.seq), turnOf(first.seq)])
    assert.ok(first.seq < call.seq && call.seq < output.seq && output.seq < dispatched.seq)
    assert.ok(model.wire.some(event => event.type === 'conversation.item.create' && event.item.type === 'function_call_output' && event.item.call_id === call.data.callId), 'tool output answered the original call on the voice connection')
    // Utterance 2 has its own turn and reply, even though its transcript trailed the response.
    const second = user('UTT-TWO')
    const answer = reply('VOICE-SECOND')
    assert.equal(turnOf(second.seq), turnOf(answer.seq))
    assert.ok(turnOf(second.seq) > turnOf(first.seq) && second.seq < answer.seq)
    // The finished work reached the model during the call.
    const notice = events.find(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === 'docs')
    assert.match(textOf(notice.data), /DOC-READY-42/)
    assert.ok(notice.seq > answer.seq)
    const heard = reply('RESULT-HEARD')
    assert.ok(heard.seq > notice.seq && turnOf(heard.seq) === turnOf(notice.seq))
    assert.ok(model.wire.some(event => event.type === 'conversation.item.create' && event.item.content?.[0]?.text?.includes('DOC-READY-42')))
    for (const event of events.filter(event => event.type === 'assistant/message')) assert.equal(event.data.message.source.model, MODEL)
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    // The worker really executed the dispatched task with Nexus as its source.
    const docs = result.workers.find(worker => worker.id === 'docs')
    assert.ok(docs.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch' && textOf(event.data).includes('DOC-TASK')))
    assert.equal(docs.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.ok(result.released)
    console.log('voice evidence:', host.home)
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    console.log('controlled model:', JSON.stringify(model.log.responses), 'played', await page?.locator('[data-nexus-voice]').getAttribute('data-played-samples').catch(() => undefined))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})

test('voice call states: no device, denied permission and blocked playback never reach the model; a sent request is not live', { timeout: 180000 }, async () => {
  const model = controlledModel({ withhold: true })
  await model.ready
  const host = await voiceHost('states', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  // Always the fake capture device: the physical microphone is never opened.
  const fake = ['--use-fake-device-for-media-stream']
  const granting = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: [...fake, '--use-fake-ui-for-media-stream'] })
  const denying = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: [...fake, '--deny-permission-prompts'] })
  const start = bar => bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
  const settled = async (bar, expected) => { await until(async () => (await state(bar)) === expected, `state ${expected}`, 15000); return bar.getByRole('status').textContent() }
  const states = {}
  try {
    // Browser-enforced denial (real Chromium permission path, no OS prompt).
    let { context, bar } = await openNexus(denying, host.url)
    await start(bar)
    states.denied = await settled(bar, 'mic-denied')
    await context.close()
    // Simulated in page: no capture device present.
    ;({ context, bar } = await openNexus(granting, host.url, () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')) }))
    await start(bar)
    states.noDevice = await settled(bar, 'no-device')
    await context.close()
    // Simulated in page: the audio output never becomes ready.
    ;({ context, bar } = await openNexus(granting, host.url, () => {
      Object.defineProperty(AudioContext.prototype, 'state', { get: () => 'suspended' })
      AudioContext.prototype.resume = () => new Promise(() => {})
    }))
    await start(bar)
    states.playback = await settled(bar, 'playback-blocked')
    await context.close()
    assert.equal(model.log.connections, 0, 'failed device states never open the model connection')
    // The request reached the model, which has not confirmed the voice session: still connecting, not live.
    ;({ context, bar } = await openNexus(granting, host.url))
    await start(bar)
    await until(() => model.wire.some(event => event.type === 'session.update'), 'session request sent')
    await delay(3000)
    assert.equal(await state(bar), 'connecting')
    states.connecting = await bar.getByRole('status').textContent()
    assert.equal(model.wire.filter(event => event.type === 'input_audio_buffer.append').length, 0, 'no captured audio leaves before the call is live')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'hung up while connecting')
    await until(() => model.log.closed === 1, 'model connection closed with the call')
    await context.close()
    assert.deepEqual(states, { denied: '麦克风权限被拒绝 (NotAllowedError)', noDevice: '没有可用的麦克风 (NotFoundError)', playback: '音频播放未就绪 (suspended)', connecting: '正在接通…' })
    console.log('voice states evidence:', host.home, JSON.stringify(states))
  } catch (error) {
    console.log(host.output().slice(-4000))
    throw error
  } finally {
    await granting.close()
    await denying.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})

test('accurate Realtime voice call: real model hears synthesized speech, dispatches work, keeps talking and receives the result', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 420000 }, async () => {
  // Real model and real client code; the speech is offline SAPI audio fed through Chromium's fake capture device.
  const capture = await voiceFixture([{ silence: 5 }, { text: '请让现有的 docs 会话开始编写接口文档。', voice: ZH }, { silence: 14 }, { text: '另外，一加一等于几？', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('real', { endpoint: process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', key: process.env.NEXUS_VOICE_KEY })
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  const supervisor = async () => (await host.status())?.agents?.find(agent => agent.id === 'nexus-supervisor')
  const docs = async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    await until(async () => (await state(bar)) === 'live', 'live call', 30000)
    await until(async () => (await docs())?.status === 'running', 'docs worker running', 90000)
    // The second utterance gets its own completed native turn while the worker still runs.
    await until(async () => { const own = await supervisor(); return own?.users >= 2 && own.status === 'idle' }, 'second utterance handled', 90000)
    const busy = await docs()
    assert.deepEqual([busy.status, busy.ends], ['running', 0], 'the second exchange happened while the work was still executing')
    const playedBefore = Number(await bar.getAttribute('data-played-samples'))
    assert.ok(playedBefore > 24000, 'the client scheduled at least a second of real model audio')
    const endsBefore = (await supervisor()).ends
    await host.release()
    await until(async () => { const own = await supervisor(); return own.ends > endsBefore && own.status === 'idle' }, 'result turn completed', 120000)
    await delay(3000)
    const played = Number(await bar.getAttribute('data-played-samples'))
    assert.equal(await state(bar), 'live')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')
    await page.screenshot({ path: resolve(host.home, 'output/voice-call.png') })

    const result = await host.finish()
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const voiced = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const call = events.find(event => event.type === 'tool/call' && /^nexus_(send|create)_session$/.test(event.data.name))
    const output = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call?.data.callId)
    const notice = events.find(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === 'docs')
    const after = events.filter(event => event.seq > notice?.seq && turnOf(event.seq) === turnOf(notice?.seq))
    const summary = {
      transcripts: voiced.map(event => textOf(event.data)),
      call: call && { name: call.data.name, arguments: call.data.arguments, turnOfFirstUtterance: turnOf(call.seq) === turnOf(voiced[0].seq), isError: output?.data.message.isError },
      replies: events.filter(event => event.type === 'assistant/message').map(event => ({ turn: turnOf(event.seq), text: textOf(event.data.message), model: event.data.message.source.model })),
      noticeTurn: notice && { turn: turnOf(notice.seq), afterNotice: after.map(event => event.type), end: after.find(event => event.type === 'turn/end')?.data.reason.kind },
      played: { beforeResult: playedBefore, total: played },
      turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    }
    await writeFile(resolve(host.home, 'output/summary.json'), JSON.stringify(summary, null, 2))
    console.log('real voice summary:', JSON.stringify(summary))
    // The model heard the speech: both utterances arrived as real input transcripts, not the fallback.
    assert.ok(voiced.length >= 2)
    assert.ok(voiced.every(event => !textOf(event.data).includes('no transcription')))
    assert.match(textOf(voiced[0].data), /文档|docs/i)
    assert.match(textOf(voiced.at(-1).data), /一加一|1\s*\+\s*1|几/)
    // The same model dispatched the existing docs worker from the first utterance's turn.
    assert.ok(call, 'the model called a dispatch tool')
    assert.equal(output.data.message.isError, false)
    assert.ok(summary.call.turnOfFirstUtterance)
    const worker = result.workers.find(item => item.id === 'docs')
    assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch'))
    assert.equal(worker.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    // The finished work reached the model during the call; speaking about it was the model's choice.
    assert.match(textOf(notice.data), /DOC-READY-42/)
    assert.equal(summary.noticeTurn.end, 'completed')
    for (const reply of summary.replies) assert.equal(reply.model, MODEL)
    assert.ok(summary.turnEnds.every(kind => kind === 'completed'))
    console.log('real voice evidence:', host.home)
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    throw error
  } finally {
    await browser.close()
    await host.close()
  }
})
