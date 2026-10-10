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
 * @param options.utterances - per utterance index: { transcript, call } | { transcript, text } (the
 *   transcript trails the response) | { hold: true } (committed, then nothing).
 * @param options.result - how a work result is answered: 'speak', 'silent' (empty response), 'hold' (never),
 *   or 'stall' (the response starts and never finishes).
 */
const UTTERANCES = {
  1: { transcript: 'UTT-ONE 请让文档会话开始编写接口文档。', call: { name: 'nexus_send_session', arguments: { sessionId: 'docs', text: 'DOC-TASK write the API reference' } } },
  2: { transcript: 'UTT-TWO 另外，一加一等于几？', text: 'VOICE-SECOND 一加一等于二。' },
}
function controlledModel({ withhold = false, utterances = UTTERANCES, result = 'speak' } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const wire = []
  const log = { connections: 0, closed: 0, utterances: [], appendedBytes: 0, voicedFrames: 0, responses: [], held: [] }
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
    let audio = true
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
      // The model chose to say nothing.
      if (!text) return send({ type: 'response.done', response: { id, status: 'completed', output: [] } })
      if (!audio) {
        send({ type: 'response.text.delta', response_id: id, delta: text })
        send({ type: 'response.text.done', response_id: id, text })
        return send({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text }] }] } })
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
      const plan = utterances[index] ?? { transcript: `UTT-${index}`, text: `VOICE-${index}` }
      if (plan.hold) return
      if (plan.call) {
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: plan.transcript })
        respond({ call: plan.call })
      } else {
        // The transcript may trail the response it belongs to.
        respond({ text: plan.text })
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: plan.transcript })
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
      if (event.type === 'session.update') audio = event.session.modalities.includes('audio')
      if (event.type === 'session.update' && !withhold) send({ type: 'session.updated', session: event.session })
      if (event.type === 'conversation.item.create') items.push(event.item.type === 'function_call_output' ? `[function_call_output ${event.item.call_id}] ${event.item.output}` : event.item.content?.map(part => part.text).join('\n') ?? '')
      if (event.type === 'response.create') {
        const fresh = items.slice(answered).join('\n')
        answered = items.length
        if (fresh.includes('TEXT-AFTER-CALL')) return respond({ text: 'TEXT-REPLY' })
        if (fresh.includes('Automatic work-session result') && audio && result !== 'speak') {
          log.held.push({ connection, result })
          if (result === 'stall') {
            send({ type: 'response.created', response: { id: `stall-${connection}`, status: 'in_progress' } })
            return send({ type: 'response.audio_transcript.delta', response_id: `stall-${connection}`, delta: 'STALL' })
          }
          return result === 'silent' ? respond({}) : undefined
        }
        respond({ text: fresh.includes('Automatic work-session result') ? 'RESULT-HEARD 文档会话已完成。' : fresh.includes('function_call_output') ? 'DOC-DISPATCHED 已安排文档会话。' : 'HOST-REPLY' })
      }
    })
  })
  return { server, wire, log, ready: new Promise(accept => server.once('listening', accept)) }
}

async function voiceHost(scenario, { endpoint, credentialRef = 'NEXUS_VOICE_KEY', key = 'fixture-not-a-secret', timeoutMs = 30000 } = {}) {
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
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: ${credentialRef}\n    endpoint: ${endpoint}\n    timeoutMs: ${timeoutMs}\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
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
    home, url, status, workspace,
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
  if (init) await (Array.isArray(init) ? page.addInitScript(...init) : page.addInitScript(init))
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
/** In-page observation only: records each capture stream and every call-bar state; delays the listed microphone requests. */
const instrument = delays => {
  const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  window.__streams = []
  window.__states = []
  // Gateway frames that carry a call failure code, observed whether or not the call bar is still mounted.
  window.__failures = []
  const Socket = window.WebSocket
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', event => {
        const text = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : ''
        for (const match of text.matchAll(/"state":"failed","code":"([A-Z_]+)"/g)) window.__failures.push(match[1])
      })
    }
  }
  new MutationObserver(() => { const bar = document.querySelector('[data-nexus-voice]'); const state = bar?.getAttribute('data-state'); const code = state === 'failed' ? bar.querySelector('[role=status]')?.textContent.match(/(([A-Z_]+))/)?.[1] : undefined; const entry = code ? state + ':' + code : state; if (entry && entry !== window.__states.at(-1)) window.__states.push(entry) }).observe(document, { subtree: true, attributes: true, childList: true })
  navigator.mediaDevices.getUserMedia = async constraints => { const stream = await request(constraints); window.__streams.push(stream); await new Promise(accept => setTimeout(accept, delays.shift() ?? 0)); return stream }
}
const trackStates = page => page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))

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
  const granting = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: [...fake, '--use-fake-ui-for-media-stream', '--autoplay-policy=document-user-activation-required'] })
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
    // Browser-enforced autoplay policy: a start without user activation leaves the audio output suspended.
    // Opening Nexus takes real clicks and Playwright evaluation counts as a gesture, so a second context reopens
    // Nexus from the first one's stored UI state, and a page timer presses the call button with no gesture.
    ;({ context } = await openNexus(granting, host.url))
    const stored = await context.storageState()
    await context.close()
    context = await granting.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 900 }, storageState: stored })
    const page = await context.newPage()
    await page.addInitScript(() => { const timer = setInterval(() => { const button = document.querySelector('[data-nexus-voice] button'); if (!button) return; clearInterval(timer); window.__activated = navigator.userActivation.hasBeenActive; button.click() }, 100) })
    await page.goto(host.url)
    // No Playwright call touches the page until the timer has pressed the button.
    await delay(10000)
    bar = page.locator('[data-nexus-voice]')
    states.playback = await settled(bar, 'playback-blocked')
    assert.equal(await page.evaluate(() => window.__activated), false, 'the call was started without user activation')
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
    // Keep the native record of a failed real run for diagnosis.
    const record = await host.finish().catch(() => undefined)
    if (record) await writeFile(resolve(host.home, 'output/failure-events.json'), JSON.stringify(record, null, 1))
    throw error
  } finally {
    await browser.close()
    await host.close()
  }
})

test('voice call races: hanging up during the microphone request or rapidly restarting keeps only the call the user wants', { timeout: 180000 }, async () => {
  const model = controlledModel()
  await model.ready
  const capture = await voiceFixture([{ silence: 120 }])
  const host = await voiceHost('races', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  try {
    // Controlled in page: the first real capture stream arrives 1.5 s late, like a pending permission prompt; every call-bar state is recorded.
    const { page, bar } = await openNexus(browser, host.url, [instrument, [1500]])
    const start = () => bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    const hangup = () => bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    const tracks = () => trackStates(page)
    // Hang up while the microphone request is pending.
    await start()
    assert.equal(await state(bar), 'requesting-mic')
    await hangup()
    await delay(3000)
    assert.equal(await state(bar), 'idle')
    assert.equal(model.log.connections, 0, 'a call hung up before the microphone arrived never reaches the model')
    assert.deepEqual(await tracks(), ['ended'], 'the late microphone stream is released')
    // Hang up and immediately call again: the new call stays live.
    await start()
    await until(async () => (await state(bar)) === 'live', 'first live call')
    // Hang up and call again one task later, as close as the page allows.
    await bar.evaluate(async element => { element.querySelector('button').click(); await new Promise(accept => setTimeout(accept, 0)); element.querySelector('button').click() })
    await until(async () => (await state(bar)) === 'live', 'second live call')
    await until(() => model.log.closed === 1, 'first call closed')
    const appended = connection => model.wire.filter(event => event.type === 'input_audio_buffer.append' && event.connection === connection).length
    const sent = appended(2)
    await delay(3000)
    assert.equal(await state(bar), 'live', 'the ended call does not tear down the new one')
    assert.deepEqual(await page.evaluate(() => window.__states), ['idle', 'requesting-mic', 'idle', 'requesting-mic', 'connecting', 'live', 'idle', 'requesting-mic', 'connecting', 'live'], 'no state from an ended call leaks into the next')
    assert.ok(appended(2) > sent, 'the new call keeps sending audio')
    assert.deepEqual([model.log.connections, model.log.closed], [2, 1])
    assert.deepEqual(await tracks(), ['ended', 'ended', 'live'])
    await hangup()
    await until(() => model.log.closed === 2, 'second call closed')
    assert.deepEqual(await tracks(), ['ended', 'ended', 'ended'])
  } catch (error) {
    console.log(host.output().slice(-4000))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})

const supervisorOf = async host => (await host.status())?.agents?.find(agent => agent.id === 'nexus-supervisor')
const sessionUpdate = (model, connection) => model.wire.find(event => event.connection === connection && event.type === 'session.update')

test('voice call creates a new work session, may stay silent on its result, and later text turns use a text connection', { timeout: 240000 }, async () => {
  const create = { name: 'nexus_create_session', arguments: { text: 'NEW-TASK write the deployment guide' } }
  const model = controlledModel({ utterances: { 1: { transcript: 'UTT-NEW 新建一个会话编写部署说明。', call: create } }, result: 'silent' })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请新建一个会话编写部署说明。', voice: ZH }, { silence: 60 }])
  const host = await voiceHost('create', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  create.arguments.cwd = host.workspace
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    await until(async () => (await state(bar)) === 'live', 'live call')
    const created = async () => (await host.status())?.agents?.find(agent => !['nexus-supervisor', 'docs'].includes(agent.id))
    await until(async () => (await created())?.status === 'running', 'new worker running')
    await until(() => model.log.responses.some(response => response.text?.startsWith('DOC-DISPATCHED')), 'dispatch acknowledged')
    await until(async () => Number(await bar.getAttribute('data-played-samples')) >= REPLY_SAMPLES, 'spoken acknowledgement', 15000)
    await host.release()
    await until(() => model.log.held.length === 1, 'result answered silently')
    await until(async () => { const own = await supervisorOf(host); return own?.status === 'idle' && own.ends === 2 }, 'result turn completed')
    await delay(1000)
    assert.equal(Number(await bar.getAttribute('data-played-samples')), REPLY_SAMPLES, 'nothing is played for a result the model kept quiet about')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')
    const editor = page.getByRole('textbox').last()
    await editor.fill('TEXT-AFTER-CALL 现在进展如何？')
    await editor.press('Enter')
    await until(() => model.log.responses.some(response => response.text === 'TEXT-REPLY'), 'text turn after the call')

    const result = await host.finish()
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const inTurn = turn => events.filter(event => event.seq > events.find(item => item.type === 'turn/start' && item.data.turn === turn).seq && turnOf(event.seq) === turn)
    // The spoken request created a new conversation session in the named workspace, which really ran.
    const spoken = events.find(event => event.type === 'user/message' && textOf(event.data).includes('UTT-NEW'))
    assert.equal(spoken.data.source.kind, 'user')
    const call = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_create_session')
    assert.equal(turnOf(call.seq), turnOf(spoken.seq))
    assert.equal(events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId).data.message.isError, false)
    const worker = result.workers.find(item => item.header.cwd === host.workspace && item.id !== 'docs')
    assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch' && textOf(event.data).includes('NEW-TASK')))
    assert.equal(worker.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    // The voice turn records the instructions the voice connection actually holds, never the text-only ones.
    const voiceTurn = inTurn(turnOf(spoken.seq))
    const systems = voiceTurn.filter(event => event.type === 'system/message').map(event => textOf(event.data.message))
    assert.ok(systems.length && systems.every(text => text.includes('live voice call')), 'no text-only instructions are recorded for a voice turn')
    assert.equal(systems.at(-1), sessionUpdate(model, 1).session.instructions)
    // The result reached the model, which chose silence: no assistant message, nothing played, turn completed.
    const notice = events.find(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === worker.id)
    const afterNotice = inTurn(turnOf(notice.seq)).filter(event => event.seq > notice.seq)
    assert.ok(!afterNotice.some(event => event.type === 'assistant/message'))
    assert.equal(afterNotice.find(event => event.type === 'turn/end').data.reason.kind, 'completed')
    // After hanging up, a typed message is answered on a new text-only connection.
    const typed = events.find(event => event.type === 'user/message' && textOf(event.data).includes('TEXT-AFTER-CALL'))
    const reply = events.find(event => event.type === 'assistant/message' && textOf(event.data.message) === 'TEXT-REPLY')
    assert.equal(turnOf(typed.seq), turnOf(reply.seq))
    // Switching back to text is recorded too: the text turn's instructions are the text-only ones.
    const textSystems = events.filter(event => event.type === 'system/message' && turnOf(event.seq) === turnOf(typed.seq)).map(event => textOf(event.data.message))
    assert.ok(textSystems.length && textSystems.at(-1).includes('This connection is text-only.'))
    const textConnection = model.log.responses.find(response => response.text === 'TEXT-REPLY').connection
    assert.notEqual(textConnection, 1)
    assert.deepEqual(sessionUpdate(model, textConnection).session.modalities, ['text'])
    assert.equal(sessionUpdate(model, textConnection).session.turn_detection, null)
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    console.log('voice create evidence:', host.home)
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    // Keep the native record of a failed real run for diagnosis.
    const record = await host.finish().catch(() => undefined)
    if (record) await writeFile(resolve(host.home, 'output/failure-events.json'), JSON.stringify(record, null, 1))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})

test('voice hang-up keeps no unheard utterance, continues a pending result in text, and a stopping Host ends the call', { timeout: 240000 }, async () => {
  const model = controlledModel({ utterances: { 1: { hold: true }, 2: UTTERANCES[1] }, result: 'hold' })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 4 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('hangup', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  let page
  try {
    const opened = await openNexus(browser, host.url, [instrument, []])
    page = opened.page
    const bar = opened.bar
    const start = async () => { await bar.getByRole('button', { name: /接通语音|Start voice/ }).click(); await until(async () => (await state(bar)) === 'live', 'live call') }
    const hangup = async () => { await bar.getByRole('button', { name: /挂断|Hang up/ }).click(); await until(async () => (await state(bar)) === 'idle', 'call ended') }
    // 1. The model committed an utterance but neither transcribed nor answered it before the hang-up.
    await start()
    await until(() => model.log.utterances.length === 1, 'first utterance committed')
    await hangup()
    await delay(5000)
    assert.equal((await supervisorOf(host)).ends, 0, 'an unheard, unanswered utterance opens no turn')
    // 2. A result is being answered on the call when the user hangs up: the step continues in text.
    await start()
    await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'docs worker running')
    await host.release()
    await until(() => model.log.held.length === 1, 'result request pending on the call')
    await hangup()
    await until(() => model.log.responses.some(response => response.text?.startsWith('RESULT-HEARD')), 'result answered in text')
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'supervisor idle')
    // 3. A Host that stops during a call ends it: the supervisor session becomes unavailable and its
    // call bar unmounts, so the end is observed through the released microphone and recorded states.
    await start()
    const result = await host.finish()
    await until(async () => (await trackStates(page)).every(track => track === 'ended'), 'microphone released when the Host stopped', 15000)
    // The bar may unmount with the session before it renders the failure; the Host's failure frame is what counts.
    await until(async () => (await page.evaluate(() => window.__failures)).includes('UNAVAILABLE'), 'Host sent the call an UNAVAILABLE failure', 15000)
    const history = await page.evaluate(() => window.__states)
    console.log('call states across the Host stop:', JSON.stringify(history), JSON.stringify(await page.evaluate(() => window.__failures)))
    assert.ok(['live', 'failed:UNAVAILABLE'].includes(history.at(-1)))

    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    assert.ok(!events.some(event => event.type === 'user/message' && /no transcription/.test(textOf(event.data))), 'no placeholder input is recorded')
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1)
    const notice = events.find(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === 'docs')
    const heard = events.find(event => event.type === 'assistant/message' && textOf(event.data.message).startsWith('RESULT-HEARD'))
    assert.equal(turnOf(heard.seq), turnOf(notice.seq))
    assert.ok(events.some(event => event.type === 'assistant/attempt' && turnOf(event.seq) === turnOf(notice.seq)), 'the interrupted voice attempt stays on record')
    const textConnection = model.log.responses.find(response => response.text?.startsWith('RESULT-HEARD')).connection
    assert.deepEqual(sessionUpdate(model, textConnection).session.modalities, ['text'])
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    console.log('voice hang-up evidence:', host.home)
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    // Keep the native record of a failed real run for diagnosis.
    const record = await host.finish().catch(() => undefined)
    if (record) await writeFile(resolve(host.home, 'output/failure-events.json'), JSON.stringify(record, null, 1))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})

test('accurate Realtime voice call: real model creates a new work session from speech and it executes', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 420000 }, async () => {
  // Real model and real client code; the speech is offline SAPI audio fed through Chromium's fake capture device.
  const capture = await voiceFixture([{ silence: 5 }, { text: '请新建一个工作会话，就用 docs 会话所在的工作区，让它编写一份部署说明。', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('real-create', { endpoint: process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', key: process.env.NEXUS_VOICE_KEY })
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  const created = async () => (await host.status())?.agents?.find(agent => !['nexus-supervisor', 'docs'].includes(agent.id))
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    await until(async () => (await state(bar)) === 'live', 'live call', 30000)
    await until(async () => (await created())?.status === 'running', 'new worker running', 120000)
    await host.release()
    // The result may join the running turn or open a new one; wait until the worker finished and the supervisor settled.
    await until(async () => (await created())?.ends >= 1, 'new worker finished', 120000)
    await delay(3000)
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'supervisor settled', 120000)
    const played = Number(await bar.getAttribute('data-played-samples'))
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')

    const result = await host.finish()
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const spoken = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const calls = events.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, arguments: event.data.arguments, turn: turnOf(event.seq) }))
    const create = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_create_session')
    const worker = result.workers.find(item => item.id !== 'docs')
    const summary = {
      transcript: spoken && textOf(spoken.data),
      calls,
      createResult: create && events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === create.data.callId)?.data.message,
      worker: worker && { id: worker.id, cwd: worker.header.cwd, dispatched: worker.events.filter(event => event.type === 'user/message').map(event => [event.data.source.kind, textOf(event.data)]), end: worker.events.findLast(event => event.type === 'turn/end')?.data.reason.kind },
      replies: events.filter(event => event.type === 'assistant/message').map(event => ({ turn: turnOf(event.seq), text: textOf(event.data.message), model: event.data.message.source.model })),
      played,
      turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    }
    await writeFile(resolve(host.home, 'output/summary.json'), JSON.stringify(summary, null, 2))
    console.log('real voice create summary:', JSON.stringify(summary))
    assert.match(summary.transcript, /新建|工作会话/)
    assert.ok(create, 'the model created a new session itself')
    assert.equal(turnOf(create.seq), turnOf(spoken.seq))
    assert.equal(summary.createResult.isError, false)
    assert.equal(worker.header.cwd, host.workspace, 'created in the workspace the user named')
    assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch'))
    assert.equal(summary.worker.end, 'completed')
    assert.ok(played > 0, 'the client played real model audio')
    for (const reply of summary.replies) assert.equal(reply.model, MODEL)
    assert.ok(summary.turnEnds.every(kind => kind === 'completed'))
    console.log('real voice create evidence:', host.home)
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    // Keep the native record of a failed real run for diagnosis.
    const record = await host.finish().catch(() => undefined)
    if (record) await writeFile(resolve(host.home, 'output/failure-events.json'), JSON.stringify(record, null, 1))
    throw error
  } finally {
    await browser.close()
    await host.close()
  }
})

test('voice call whose response stalls fails the call instead of hanging the supervisor', { timeout: 180000 }, async () => {
  const model = controlledModel({ result: 'stall' })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('stall', { endpoint: `ws://127.0.0.1:${model.server.address().port}`, timeoutMs: 3000 })
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  let page
  try {
    const opened = await openNexus(browser, host.url, [instrument, []])
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    await until(async () => (await state(bar)) === 'live', 'live call')
    await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'docs worker running')
    await host.release()
    // The model starts answering the result and never finishes; the user then types during the call.
    await until(() => model.log.held.length === 1, 'result response stalled')
    const editor = page.getByRole('textbox').last()
    await editor.fill('TEXT-DURING-STALL 还在吗？')
    await editor.press('Enter')
    await until(async () => (await page.evaluate(() => window.__states)).includes('failed:TIMEOUT'), 'call failed on the unanswering connection', 30000)
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'supervisor not left waiting', 30000)
    assert.ok((await trackStates(page)).every(track => track === 'ended'), 'microphone released')
    const result = await host.finish()
    const typed = result.events.find(event => event.type === 'user/message' && textOf(event.data).includes('TEXT-DURING-STALL'))
    assert.ok(typed, 'the typed input stays on record')
    console.log('voice stall evidence:', host.home)
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})
