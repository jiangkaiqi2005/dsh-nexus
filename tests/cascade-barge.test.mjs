import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startHost } from './host-process.mjs'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'

const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (predicate, label, ms = 15000) => { for (const deadline = Date.now() + ms; !(await predicate()); ) { if (Date.now() > deadline) throw new Error(`waiting for ${label}`); await sleep(50) } }
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')
async function tapHost(endpoint, asrEndpoint, run, { observeCapture = false, preparePage } = {}) {
  const dir = resolve('.scratch/cascade-voice', `05-barge-${Date.now()}`)
  const profile = resolve(dir, 'profiles/spoken'), probe = resolve(dir, 'probe')
  for (const path of [probe, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  await copyFile(resolve('tests/cascade-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-spoken-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: spoken-probe\n      name: nexus-spoken-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        scenario: tap\n`)
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-spoken-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-spoken-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_SPOKEN_KEY\n    endpoint: ws://127.0.0.1:1\n    ttsEndpoint: ${endpoint}\n    asrEndpoint: ${asrEndpoint}\n    timeoutMs: 10000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
  let output = '', browser, page
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'spoken', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: dir, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_SPOKEN_KEY: 'host-only-fixture-key', DEEPSEEK_API_KEY: '', DSH_TELEMETRY: '0' } }, async child => { child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data }); return {} })
  try {
    let url; await until(() => { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return url }, 'Host URL')
    await until(() => readFile(resolve(dir, 'ui-ready')).then(() => true, () => false), 'registered default model')
    browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } }); page.setDefaultTimeout(15000)
    await page.addInitScript(() => { window.__pcmMarkers = []; const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args) { window.__pcmMarkers.push(Math.round(this.buffer.getChannelData(0)[0] * 32768)); return start.apply(this, args) } })
    if (observeCapture) await page.addInitScript(() => {
      const NativeContext = window.AudioContext
      window.AudioContext = class extends NativeContext { constructor(options) { super(options); if (options?.sampleRate === 16000) window.__captureContext = this } }
    })
    if (preparePage) await preparePage(page)
    const downlink = []; page.on('websocket', socket => socket.on('framereceived', frame => downlink.push(String(frame.payload))))
    await page.goto(url)
    await until(async () => { for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click() } return page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).isVisible() }, 'native UI')
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    await run(page, dir, downlink)
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
const connected = page => page.getByRole('status').filter({ hasText: '已接通 Nexus' }).waitFor()

async function endpoints(run, { holdFinish = false } = {}) {
  const requests = [], tasks = [], responses = []
  const http = createServer(async (request, response) => {
    for await (const chunk of request) {} // WAV shape is covered by ticket 04.
    requests.push(Date.now())
    response.end(JSON.stringify(responses.shift() ?? { output: { text: '' } }))
  })
  await new Promise(accept => http.listen(0, '127.0.0.1', accept))
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => ws.once('listening', accept))
  ws.on('connection', socket => {
    const task = { socket, sentences: [], canceled: false, finished: false, index: 0 }; tasks.push(task)
    const send = (event, payload = {}) => { if (socket.readyState === 1) socket.send(JSON.stringify({ header: { event, task_id: task.id, attributes: {} }, payload })) }
    task.segment = (text, seconds, marker) => {
      send('result-generated', { output: { type: 'sentence-begin', sentence: { index: task.index, words: [] }, original_text: text } })
      const pcm = Buffer.alloc(seconds * 48000); for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(marker, offset)
      for (let offset = 0; offset < pcm.length; offset += 12000) if (socket.readyState === 1) {
        send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: task.index, words: [] } } })
        socket.send(pcm.subarray(offset, offset + 12000))
      }
      send('result-generated', { output: { type: 'sentence-end', sentence: { index: task.index++, words: [] }, original_text: text }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    }
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); task.id = event.header.task_id
      if (event.header.action === 'run-task') send('task-started')
      if (event.header.action === 'continue-task') {
        const text = event.payload.input.text; task.sentences.push(text)
        if (text === '第一句。') task.segment(text, 0.25, 1001)
        else if (text === 'Second sentence!') { task.segment('Second ', 0.25, 1002); task.segment('sentence!', 3, 1003) }
        else task.segment(text, 0.25, 2000 + task.sentences.length)
      }
      if (event.header.action === 'finish-task') { task.canceled = event.payload.input.directive === 'cancel'; if (!holdFinish || tasks.indexOf(task) !== 0 || task.canceled) { task.finished = true; send('task-finished') } }
    })
  })
  try { return await run({ requests, tasks, responses, asr: `http://127.0.0.1:${http.address().port}`, tts: `ws://127.0.0.1:${ws.address().port}` }) }
  finally { for (const socket of ws.clients) socket.terminate(); await new Promise(accept => ws.close(accept)); http.closeAllConnections(); await new Promise(accept => http.close(accept)) }
}

test('tap stops locally before Host acknowledgement and records only complete heard sentences even after synthesis finished', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, tasks }) => {
  const held = []; let blocked = false, lateAudio
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'SENTENCES'); await until(() => tasks[0]?.finished, 'finished provider task')
    await until(async () => page.evaluate(() => window.__playback.length >= 4), 'queued multi-frame PCM')
    await sleep(700); blocked = true
    await page.getByRole('button', { name: '开始录音', exact: true }).click()
    assert.ok(await page.evaluate(() => window.__playback.every(item => item.stopped || item.node.context.currentTime >= item.when + item.node.buffer.duration)), 'all pending playback stops without Host roundtrip')
    await until(() => held.length, 'held start recording uplink')
    blocked = false; for (const release of held.splice(0)) release()
    await sleep(300); await page.getByRole('button', { name: '结束录音', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '没听清' }).waitFor()
    const count = await page.evaluate(() => window.__playback.length); lateAudio(); await sleep(250); assert.equal(await page.evaluate(() => window.__playback.length), count, 'late interrupted PCM never resumes after the gate opens')
    await page.screenshot({ path: resolve(dir, 'barge-empty-asr.png') }); await page.getByRole('button', { name: '挂断', exact: true }).click()
  }, { preparePage: async page => {
    await page.addInitScript(() => {
      window.__playback = []
      const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop
      AudioBufferSourceNode.prototype.start = function(when = 0, ...args) { const item = { node: this, when, stopped: false }; window.__playback.push(item); return start.call(this, when, ...args) }
      AudioBufferSourceNode.prototype.stop = function(...args) { const item = window.__playback.find(item => item.node === this); if (item) item.stopped = true; return stop.apply(this, args) }
    })
    await page.routeWebSocket(/.*/, socket => { const server = socket.connectToServer(); socket.onMessage(data => { if (blocked && String(data).includes('start-recording')) held.push(() => server.send(data)); else server.send(data) }); server.onMessage(data => { if (String(data).includes('"type":"audio"')) lateAudio = () => socket.send(data); socket.send(data) }) })
  } })
  const cuts = report.persisted.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice')
  assert.equal(cuts.length, 1); assert.match(textOf(cuts[0].data), /Complete sentences heard: "第一句。"/)
  assert.ok(!textOf(cuts[0].data).includes('Second'), 'provider subsegment is not mistaken for a complete Nexus sentence')
  assert.equal(cuts[0].data.source.form, 'notice'); assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 1)
}))

test('barge-in cancels only synthesis, keeps an executing native tool and delivers ASR as steering in the same turn', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, tasks, responses }) => {
  responses.push({ output: { text: 'STEER-NEW' } })
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'BARGE-TOOL'); await until(() => readFile(resolve(dir, 'tool-started')).then(() => true, () => false), 'native tool running')
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) >= 84000, 'long reply queued')
    await sleep(700); await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await until(() => tasks[0].canceled, 'provider received media cancellation')
    await sleep(350); await page.getByRole('button', { name: '结束录音', exact: true }).click()
    await page.getByText('STEER-NEW', { exact: true }).waitFor()
    await writeFile(resolve(dir, 'release-tool'), '')
    await page.getByText('STEER-APPLIED', { exact: true }).waitFor()
    await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  const result = report.persisted.find(event => event.type === 'tool/result')
  assert.ok(result); assert.equal(result.data.message.isError, false); assert.equal(textOf(result.data.message), 'LOOKUP-COMPLETED')
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 1)
  assert.ok(report.requests[1].messages.some(message => message.role === 'tool' && textOf(message) === 'LOOKUP-COMPLETED'))
  assert.ok(report.requests[1].messages.some(message => message.role === 'user' && message.source?.kind === 'user' && textOf(message) === 'STEER-NEW'))
  const cuts = report.requests[1].messages.filter(message => message.source?.kind === 'nexus-voice')
  assert.equal(cuts.length, 1); assert.match(textOf(cuts[0]), /Complete sentences heard: "第一句。"/)
}, { holdFinish: true }))

test('one tap over several completed replies still queued creates one notice in playback order', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, tasks }) => {
  const report = await tapHost(tts, asr, async page => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'SENTENCES'); await until(() => tasks[0]?.finished, 'first synthesis done')
    await submit(page, 'BLOCK-ONLY'); await until(() => tasks[1]?.finished, 'second synthesis done')
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) >= 114000, 'both replies queued at client')
    await sleep(600); await page.getByRole('button', { name: '开始录音', exact: true }).click(); await sleep(300); await page.getByRole('button', { name: '结束录音', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '没听清' }).waitFor(); await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  const cuts = report.persisted.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice')
  assert.equal(cuts.length, 1); assert.match(textOf(cuts[0].data), /Complete sentences heard: "第一句。"/)
  assert.ok(!textOf(cuts[0].data).includes('Second') && !textOf(cuts[0].data).includes('TEXT ONLY'))
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 2)
}))

test('barge-in during streamed model text stops the spoken tail but preserves the complete native assistant reply', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, tasks }) => {
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'HOLD-SPEECH'); await until(() => readFile(resolve(dir, 'model-started')).then(() => true, () => false), 'streaming model held')
    await writeFile(resolve(dir, 'release-first-sentence'), '')
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > 0, 'first streamed sentence arrived')
    await page.getByRole('button', { name: '开始录音', exact: true }).click(); await until(() => tasks[0].canceled, 'streamed reply speech canceled')
    const count = Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples'))
    await writeFile(resolve(dir, 'release-model'), '')
    await page.getByText('第一句。Second sentence!\n最后一句', { exact: true }).waitFor()
    await sleep(300); await page.getByRole('button', { name: '结束录音', exact: true }).click(); await page.getByRole('status').filter({ hasText: '没听清' }).waitFor()
    assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')), count)
    await page.getByRole('button', { name: '挂断', exact: true }).click()
  })
  const assistant = report.persisted.find(event => event.type === 'assistant/message')
  assert.equal(textOf(assistant.data.message), '第一句。Second sentence!\n最后一句'); assert.equal(assistant.data.interrupted, undefined)
  assert.equal(report.persisted.find(event => event.type === 'turn/end').data.reason.kind, 'completed')
}, { holdFinish: true }))

for (const ending of ['empty', 'auto', 'hangup', 'disconnect']) test(`recording buffers a newly generated reply until ${ending === 'auto' ? 'the Host 60-second limit' : ending}, with no replay of interrupted audio`, { timeout: ending === 'auto' ? 110000 : 90000 }, async () => endpoints(async ({ asr, tts, tasks, requests, responses }) => {
  responses.push({ output: { text: '' } })
  const report = await tapHost(tts, asr, async (page, dir, downlink) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'BARGE-TOOL'); await until(() => readFile(resolve(dir, 'tool-started')).then(() => true, () => false), 'running lookup')
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) >= 84000, 'queued first reply')
    const started = Date.now(); await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '录音中' }).waitFor(); await until(() => tasks[0].canceled, 'canceled old speech')
    const audioFrames = () => (downlink.join('').match(/"type":"audio"/g) ?? []).length
    await sleep(100); const before = audioFrames(), scheduled = Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples'))
    await writeFile(resolve(dir, 'release-tool'), '')
    await until(() => tasks[1]?.finished, 'new reply synthesized while recording')
    await sleep(300); assert.equal(audioFrames(), before, 'Host sends no new PCM while recording')
    assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')), scheduled)
    const markers = await page.evaluate(() => window.__pcmMarkers.length)
    if (ending === 'auto') { await page.evaluate(() => window.__captureContext.suspend()); await until(() => requests.length, 'automatic Host recording end', 65000); assert.ok(requests[0] - started >= 59000 && requests[0] - started < 65000) }
    else if (ending === 'empty') await page.getByRole('button', { name: '结束录音', exact: true }).click()
    else if (ending === 'hangup') await page.getByRole('button', { name: '挂断', exact: true }).click()
    else await page.reload()
    if (['empty', 'auto'].includes(ending)) {
      await page.getByRole('status').filter({ hasText: '没听清' }).waitFor()
      await until(() => audioFrames() > before, 'buffer released despite empty ASR')
      await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > scheduled, 'buffer played')
      assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) - scheduled, 12000, 'only new reply PCM is released')
      assert.deepEqual(await page.evaluate(offset => window.__pcmMarkers.slice(offset), markers), [2001, 2002], 'buffered sentences keep their original playback order')
      // A second empty recording must not release the same buffered reply again.
      await sleep(350); await page.getByRole('button', { name: '开始录音', exact: true }).click(); await sleep(250); await page.getByRole('button', { name: '结束录音', exact: true }).click(); await page.getByRole('status').filter({ hasText: '没听清' }).waitFor()
      assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) - scheduled, 12000)
      await page.getByRole('button', { name: '挂断', exact: true }).click()
    } else { await sleep(350); assert.equal(audioFrames(), before, 'ending call discards all buffered PCM') }
    await page.screenshot({ path: resolve(dir, `buffer-${ending}.png`) })
  }, { observeCapture: ending === 'auto' })
  assert.ok(report.persisted.some(event => event.type === 'tool/result' && !event.data.message.isError && textOf(event.data.message) === 'LOOKUP-COMPLETED'))
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 1, 'empty or abandoned recording creates no user round')
}, { holdFinish: true }))

test('a new reply whose PCM is already in transport when local recording starts survives the delayed Host control frame', { timeout: 90000 }, async () => endpoints(async ({ asr, tts, tasks }) => {
  let hold = false, release, firstNewPCM, releaseEnd
  const pendingPCM = []
  const report = await tapHost(tts, asr, async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'BARGE-TOOL'); await until(() => readFile(resolve(dir, 'tool-started')).then(() => true, () => false), 'native tool held')
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) >= 84000, 'old reply queued')
    hold = true; await page.getByRole('button', { name: '开始录音', exact: true }).click(); await until(() => release, 'Host recording control held')
    const before = Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples'))
    const markers = await page.evaluate(() => window.__pcmMarkers.length)
    await writeFile(resolve(dir, 'release-tool'), '')
    await until(() => tasks[1]?.finished && firstNewPCM, 'new reply traversed transport before start control')
    await sleep(150); assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')), before, 'client defers in-flight new PCM while locally recording')
    hold = false; release(); await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-flushes')) > 0, 'old reply flushed after transport delay')
    await page.getByRole('button', { name: '结束录音', exact: true }).click(); await until(() => releaseEnd, 'end recording control held')
    for (const deliver of pendingPCM.splice(0)) deliver()
    await sleep(150); assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')), before, 'in-flight tail stays behind earlier deferred PCM until Host confirms recording ended')
    releaseEnd(); await page.getByRole('status').filter({ hasText: '没听清' }).waitFor()
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > before, 'in-transit new reply resumes')
    assert.equal(Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) - before, 12000)
    assert.deepEqual(await page.evaluate(offset => window.__pcmMarkers.slice(offset), markers), [2001, 2002], 'packets delayed across both button boundaries keep playback order')
    await page.screenshot({ path: resolve(dir, 'transport-barge.png') }); await page.getByRole('button', { name: '挂断', exact: true }).click()
  }, { preparePage: page => page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(data => { if (hold && String(data).includes('start-recording')) release = () => server.send(data); else if (String(data).includes('end-recording')) releaseEnd = () => server.send(data); else server.send(data) })
    server.onMessage(data => {
      if (tasks[1]?.id && String(data).includes(tasks[1].id) && String(data).includes('"type":"audio"')) {
        if (firstNewPCM) { pendingPCM.push(() => socket.send(data)); return }
        firstNewPCM = true
      }
      socket.send(data)
    })
  }) })
  assert.equal(report.persisted.filter(event => event.type === 'turn/start').length, 1)
}))
