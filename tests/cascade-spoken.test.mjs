import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startHost } from './host-process.mjs'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { failureTooltip } from './voice-ui.mjs'

const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const until = async (predicate, label, ms = 15000) => { for (const deadline = Date.now() + ms; !(await predicate()); ) { if (Date.now() > deadline) throw new Error(`waiting for ${label}`); await sleep(50) } }
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')
const tone = Buffer.alloc(48000); for (let i = 0; i < 24000; i++) tone.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2)
async function spokenHost(endpoint, run, { real = false, observePlayback = false } = {}) {
  const dir = resolve('.scratch/cascade-voice', `03-spoken-${Date.now()}`)
  const profile = resolve(dir, 'profiles/spoken'), probe = resolve(dir, 'probe')
  for (const path of [probe, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  await copyFile(resolve('tests/cascade-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-spoken-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: spoken-probe\n      name: nexus-spoken-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        scenario: spoken\n`)
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-spoken-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-spoken-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: ${real ? process.env.NEXUS_REAL_CREDENTIAL_REF ?? 'DASHSCOPE_API_KEY' : 'NEXUS_SPOKEN_KEY'}\n    endpoint: ws://127.0.0.1:1\n    ttsEndpoint: ${endpoint}\n    timeoutMs: 10000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
  let output = '', browser, page
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'spoken', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: dir, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_SPOKEN_KEY: 'host-only-fixture-key', DEEPSEEK_API_KEY: '', DSH_TELEMETRY: '0' } }, async child => { child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data }); return {} })
  try {
    let url; await until(() => { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return url }, 'Host URL')
    await until(() => readFile(resolve(dir, 'ui-ready')).then(() => true, () => false), 'registered default model')
    browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } }); page.setDefaultTimeout(15000)
    if (observePlayback) await page.addInitScript(() => {
      window.__spokenPlayback = []
      const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop
      AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
        const marker = Math.round(this.buffer.getChannelData(0)[0] * 32768)
        const entry = { node: this, marker, when: Math.max(when, this.context.currentTime), duration: this.buffer.duration, ended: false, stopped: false }
        window.__spokenPlayback.push(entry); this.addEventListener('ended', () => { entry.ended = true })
        return start.call(this, when, ...rest)
      }
      AudioBufferSourceNode.prototype.stop = function (...args) { const entry = window.__spokenPlayback.find(item => item.node === this); if (entry) entry.stopped = true; return stop.apply(this, args) }
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
    if (report.persisted.some(event => event.type === 'assistant/message' && textOf(event.data.message).startsWith('FAIL。'))) assert.ok(downlink.join('').includes('TTS_SYNTHESIS_FAILED'))
    console.log('spoken evidence:', dir)
    return report
  } catch (error) { if (page) { await page.screenshot({ path: resolve(dir, 'failure.png') }); await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()) } throw error }
  finally { await browser?.close(); await host.close(); await writeFile(resolve(dir, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]')) }
}
const submit = async (page, words) => { const editor = page.getByRole('textbox').last(); await editor.fill(words); await editor.press('Enter') }
const connected = page => until(async () => await page.locator('[data-nexus-voice]').getAttribute('data-state') === 'live', 'call live')

test('cascade call receives its first PCM sentence while the native supervisor is still generating, and stops only audio on hangup', { timeout: 90000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => server.once('listening', accept))
  const tasks = []; const auth = []
  server.on('connection', (socket, request) => {
    auth.push(request.headers.authorization)
    let task; const send = (event, payload = {}) => socket.send(JSON.stringify({ header: { event, task_id: task.id, attributes: {} }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.header.action === 'run-task') { task = { id: event.header.task_id, run: event.payload, sentences: [], finished: false, cancelled: false }; tasks.push(task); send('task-started') }
      if (event.header.action === 'continue-task') {
        task.sentences.push(event.payload.input.text)
        send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: task.sentences.length - 1, words: [] } } }); socket.send(tone)
      }
      if (event.header.action === 'finish-task') { task.cancelled = event.payload.input.directive === 'cancel'; task.finished = !task.cancelled; send('task-finished') }
    })
  })
  try {
    const report = await spokenHost(`ws://127.0.0.1:${server.address().port}`, async (page, dir) => {
      await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
      assert.equal(tasks.length, 0, 'media readiness does not start any model connection')
      await submit(page, 'HOLD-SPEECH')
      await page.getByRole('status').filter({ hasText: '思考中' }).waitFor()
      await writeFile(resolve(dir, 'release-first-sentence'), '')
      await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > 0, 'first PCM at browser')
      await page.getByRole('status').filter({ hasText: '正在朗读' }).waitFor()
      assert.deepEqual(tasks[0].sentences, ['第一句。'])
      assert.equal(tasks[0].finished, false, 'model is gated before second sentence')
      await page.screenshot({ path: resolve(dir, 'first-sentence.png') })
      await page.getByRole('button', { name: '挂断', exact: true }).click()
      await writeFile(resolve(dir, 'release-model'), '')
      await page.getByText('第一句。Second sentence!\n最后一句', { exact: true }).waitFor()
      await submit(page, 'AFTER-HANGUP'); await page.getByText('CASCADE-REPLY', { exact: true }).waitFor()
      assert.equal(tasks.length, 1); await until(() => tasks[0].cancelled, 'cancelled TTS')
    })
    assert.deepEqual(auth, ['Bearer host-only-fixture-key'])
    assert.equal(tasks[0].run.model, 'qwen-audio-3.1-tts-flash'); assert.deepEqual(tasks[0].run.parameters, { text_type: 'PlainText', voice: 'longanhuan_v3.1', format: 'pcm', sample_rate: 24000 })
    assert.ok(report.requests[0].messages.some(message => message.role === 'system' && /brief|concise|short/i.test(textOf(message))))
    assert.equal(report.persisted.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    assert.ok(!JSON.stringify(report.streams).includes('host-only-fixture-key'))
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) }
})

test('cascade speaks complete Chinese and English sentences in order, preserves text after TTS failure and reads native work reports', { timeout: 120000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => server.once('listening', accept))
  const tasks = []
  server.on('connection', socket => {
    let task; const send = (event, payload = {}) => socket.send(JSON.stringify({ header: { event, task_id: task.id }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.header.action === 'run-task') { task = { id: event.header.task_id, model: event.payload.model, voice: event.payload.parameters.voice, sentences: [], finished: false }; tasks.push(task); send('task-started') }
      if (event.header.action === 'continue-task') {
        task.sentences.push(event.payload.input.text)
        if (event.payload.input.text.startsWith('FAIL')) {
          // Provider bodies may echo secrets. Only an accurate fixed error code may leave the Host.
          send('task-failed', { message: 'bad host-only-fixture-key', error_code: 'fixture' })
          return
        }
        // More than one audio binary per sentence: server boundaries differ from continue-task boundaries.
        send('result-generated', { output: { type: 'sentence-begin', sentence: { index: task.sentences.length - 1, words: [] }, original_text: event.payload.input.text } })
        for (let i = 0; i < 2; i++) { send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: task.sentences.length - 1, words: [] } } }); socket.send(tone.subarray(0, 4800)) }
        send('result-generated', { output: { type: 'sentence-end', sentence: { index: task.sentences.length - 1, words: [] }, original_text: event.payload.input.text }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
      }
      if (event.header.action === 'finish-task') { task.finished = true; send('task-finished') }
    })
  })
  try {
    const report = await spokenHost(`ws://127.0.0.1:${server.address().port}`, async (page, dir) => {
      await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
      await submit(page, 'SENTENCES')
      await until(() => tasks[0]?.finished, 'complete sentence task')
      assert.deepEqual(tasks[0].sentences, ['第一句。', 'Second sentence!', 'Third?', 'Fourth.', '第五行', '尾句'])
      await page.getByText('第一句。Second sentence!Third?Fourth.\n第五行\n尾句', { exact: true }).waitFor()
      const before = tasks.length
      await submit(page, 'FAIL-SPEECH')
      await page.getByText('FAIL。文字仍然完整。', { exact: true }).waitFor()
      await page.getByRole('status').filter({ hasText: '朗读失败，文字已保留' }).waitFor(); assert.equal(await page.locator('[data-nexus-voice]').getAttribute('data-activity'), 'failed')
      await failureTooltip(page, 'TTS_SYNTHESIS_FAILED')
      await connected(page)
      assert.equal(tasks.length, before + 1)
      await page.screenshot({ path: resolve(dir, 'tts-failure-connected.png') })
      // The next reply gets a fresh healthy task, with configurable model and voice saved in native settings.
      await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: 'Nexus', exact: true }).click()
      const model = page.getByRole('textbox', { name: '语音合成型号', exact: true }); const voice = page.getByRole('textbox', { name: '语音合成音色', exact: true })
      assert.equal(await model.inputValue(), 'qwen-audio-3.1-tts-flash'); assert.equal(await voice.inputValue(), 'longanhuan_v3.1')
      await model.fill('fixture-tts'); await model.press('Tab'); await until(() => model.isDisabled().then(value => !value), 'saved model')
      await voice.fill('fixture-voice'); await voice.press('Tab'); await until(() => voice.isDisabled().then(value => !value), 'saved voice')
      await page.keyboard.press('Escape'); await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
      await submit(page, 'BLOCK-ONLY'); await page.getByText('TEXT ONLY.', { exact: true }).waitFor()
      await until(() => tasks.some(task => task.sentences.includes('TEXT ONLY.') && task.finished), 'spoken reply with only a final native text block')
      await submit(page, 'MIXED-BLOCKS'); await page.getByText('BLOCK ONE.BLOCK TWO.', { exact: true }).waitFor()
      await until(() => tasks.some(task => task.sentences.includes('BLOCK TWO.') && task.finished), 'mixed final-only and streamed native text blocks')
      assert.deepEqual(tasks.find(task => task.sentences.includes('BLOCK ONE.')).sentences, ['BLOCK ONE.', 'BLOCK TWO.'], 'each text block is spoken once in message order')
      await submit(page, 'DISPATCH-SPEECH')
      await page.getByText('WORK-RESULT-RECEIVED', { exact: true }).waitFor()
      await until(() => tasks.some(task => task.sentences.includes('WORK-RESULT-RECEIVED') && task.finished), 'spoken work report')
      assert.ok(tasks.slice(before + 1).every(task => task.model === 'fixture-tts' && task.voice === 'fixture-voice'))
      assert.ok(!tasks.some(task => task.sentences.some(sentence => /nexus_send_session|HOLD-WORK|CASCADE-WORK/.test(sentence))), 'tool calls are not read')
      await submit(page, 'SLOW-TOOL')
      await until(() => readFile(resolve(dir, 'tool-started')).then(() => true, () => false), 'native tool executing')
      await until(() => tasks.some(task => task.sentences.includes('正在查询。')), 'tool reply spoken before completion')
      await page.getByRole('button', { name: '挂断', exact: true }).click()
      const whileTool = tasks.length
      const previousReplies = await page.getByText('CASCADE-REPLY', { exact: true }).count()
      await writeFile(resolve(dir, 'release-tool'), '')
      await until(async () => await page.getByText('CASCADE-REPLY', { exact: true }).count() > previousReplies, 'text continuation after the in-flight tool')
      assert.equal(tasks.length, whileTool, 'hangup does not cancel the native tool or synthesize its continuation')
      await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
      // A real native worker turn outlives hangup, and its result wakes the same text supervisor.
      await submit(page, 'HANGUP-WORK')
      await until(() => readFile(resolve(dir, 'worker-held')).then(() => true, () => false), 'started worker')
      await page.getByRole('button', { name: '挂断', exact: true }).click()
      const count = tasks.length
      await writeFile(resolve(dir, 'release-worker'), '')
      await until(async () => await page.getByText('WORK-RESULT-RECEIVED', { exact: true }).count() === 2, 'work report after hangup')
      assert.equal(tasks.length, count)
      await page.screenshot({ path: resolve(dir, 'work-report-after-hangup.png') })
    })
    const replies = report.persisted.filter(event => event.type === 'assistant/message')
    assert.ok(replies.some(event => textOf(event.data.message) === 'FAIL。文字仍然完整。'))
    assert.ok(report.persisted.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    assert.equal(report.worker.filter(event => event.type === 'turn/end').length, 2)
    assert.ok(report.persisted.some(event => event.type === 'tool/result' && textOf(event.data.message) === 'LOOKUP-COMPLETED' && !event.data.message.isError))
    const lastRequest = report.requests.at(-1)
    assert.equal(lastRequest.provider, 'cascade-primary')
    assert.ok(lastRequest.messages.some(message => message.role === 'system' && /text-only/.test(textOf(message))), 'hangup returns the supervisor to text instructions')
    assert.ok(!JSON.stringify(report.streams).includes('host-only-fixture-key'))
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) }
})

test('opt-in real DashScope TTS reads one native cascade reply through the browser', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 90000 }, async () => {
  const report = await spokenHost(process.env.NEXUS_REAL_TTS_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', async (page, dir) => {
    await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
    await submit(page, 'SENTENCES')
    await until(async () => Number(await page.locator('[data-nexus-voice]').getAttribute('data-played-samples')) > 0, 'real PCM', 60000)
    await page.getByText('第一句。Second sentence!Third?Fourth.\n第五行\n尾句', { exact: true }).waitFor()
    await page.screenshot({ path: resolve(dir, 'real-tts-reading.png') })
    await page.getByRole('button', { name: '挂断', exact: true }).click()
  }, { real: true })
  assert.ok(report.persisted.some(event => event.type === 'assistant/message'))
})

test('queued spoken replies preserve order while native tool and next model step run, with reading then thinking states', { timeout: 90000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => server.once('listening', accept))
  const tasks = []
  let releaseFirst
  server.on('connection', socket => {
    let task; const send = (event, payload = {}) => socket.send(JSON.stringify({ header: { event, task_id: task.id }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.header.action === 'run-task') { task = { id: event.header.task_id, sentences: [] }; tasks.push(task); send('task-started') }
      if (event.header.action === 'continue-task') { task.sentences.push(event.payload.input.text); send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: 0, words: [] } } }); socket.send(tone) }
      if (event.header.action === 'finish-task') {
        if (task.sentences.includes('QUEUE-FIRST。') && !event.payload.input.directive) releaseFirst = () => send('task-finished')
        else send('task-finished')
      }
    })
  })
  try {
    const report = await spokenHost(`ws://127.0.0.1:${server.address().port}`, async (page, dir) => {
      await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
      await submit(page, 'QUEUE-SPEECH')
      await until(() => readFile(resolve(dir, 'queue-next-started')).then(() => true, () => false), 'next native model step while TTS remains open')
      await page.getByRole('status').filter({ hasText: '正在朗读' }).waitFor()
      assert.equal(tasks.length, 1); assert.deepEqual(tasks[0].sentences, ['QUEUE-FIRST。'])
      await until(() => typeof releaseFirst === 'function', 'first TTS finish request')
      releaseFirst()
      await page.getByRole('status').filter({ hasText: '思考中' }).waitFor()
      await writeFile(resolve(dir, 'release-queue-model'), '')
      await until(() => tasks.length === 2 && tasks[1].sentences.includes('QUEUED SECOND.'), 'second reply in spoken order')
      await page.getByRole('status').filter({ hasText: '正在朗读' }).waitFor()
      await page.screenshot({ path: resolve(dir, 'queued-replies.png') })
      await page.getByRole('button', { name: '挂断', exact: true }).click()
    })
    assert.ok(report.persisted.some(event => event.type === 'tool/result' && textOf(event.data.message) === 'QUEUE-LOOKUP-COMPLETED'))
    assert.deepEqual(report.persisted.filter(event => event.type === 'assistant/message').map(event => textOf(event.data.message)), ['QUEUE-FIRST。', 'QUEUED SECOND.'])
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) }
})

test('a later TTS failure stops only its own PCM while an earlier successful reply finishes playback and the next reply recovers', { timeout: 90000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => server.once('listening', accept))
  const tasks = []
  const labelledTone = (seconds, marker) => { const bytes = Buffer.alloc(seconds * 48000); for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(marker + Math.round(Math.sin(i / 10) * 100), i * 2); return bytes }
  server.on('connection', socket => {
    let task; const send = (event, payload = {}) => socket.send(JSON.stringify({ header: { event, task_id: task.id }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.header.action === 'run-task') { task = { id: event.header.task_id, order: tasks.length, failed: false }; tasks.push(task); send('task-started') }
      if (event.header.action === 'continue-task') {
        if (task.failed) return
        send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: 0, words: [] } } })
        socket.send(labelledTone(task.order === 0 ? 6 : task.order === 1 ? 2 : 1, task.order === 0 ? 1000 : task.order === 1 ? 5000 : 9000))
        if (task.order === 1) { task.failed = true; send('task-failed', { error_code: 'fixture', message: 'second reply failed' }) }
      }
      if (event.header.action === 'finish-task') send('task-finished')
    })
  })
  const playback = page => page.evaluate(() => window.__spokenPlayback.map(item => ({ marker: item.marker, ended: item.ended, stopped: item.stopped, audible: !item.stopped && item.node.context.currentTime >= item.when && item.node.context.currentTime < item.when + item.duration })))
  const first = nodes => nodes.filter(node => node.marker < 2000)
  const failed = nodes => nodes.filter(node => node.marker > 4000 && node.marker < 6000)
  const recovery = nodes => nodes.filter(node => node.marker > 8000)
  try {
    const report = await spokenHost(`ws://127.0.0.1:${server.address().port}`, async (page, dir) => {
      await page.getByRole('button', { name: '接通语音', exact: true }).click(); await connected(page)
      await submit(page, 'BLOCK-ONLY'); await page.getByText('TEXT ONLY.', { exact: true }).waitFor()
      await until(async () => first(await playback(page)).some(node => node.audible), 'first reply actually playing')
      await submit(page, 'FAIL-SPEECH'); await page.getByText('FAIL。文字仍然完整。', { exact: true }).waitFor()
      await page.getByRole('status').filter({ hasText: '朗读失败，文字已保留' }).waitFor(); assert.equal(await page.locator('[data-nexus-voice]').getAttribute('data-activity'), 'failed'); await connected(page)
      await failureTooltip(page, 'TTS_SYNTHESIS_FAILED')
      const afterFailure = await playback(page)
      assert.ok(first(afterFailure).some(node => node.audible), 'the previous successful reply remains audible')
      assert.ok(first(afterFailure).every(node => !node.stopped), 'none of the prior reply nodes were stopped')
      assert.ok(failed(afterFailure).length > 0 && failed(afterFailure).every(node => node.stopped), 'already delivered failed PCM alone was stopped')
      await page.screenshot({ path: resolve(dir, 'isolated-tts-failure.png') })
      await submit(page, 'BLOCK-ONLY')
      await until(async () => recovery(await playback(page)).length > 0, 'fresh reply received after failure')
      await until(async () => first(await playback(page)).every(node => node.ended), 'complete natural playback of the previous reply')
      assert.ok(first(await playback(page)).every(node => !node.stopped), 'previous reply finished without truncation')
      await until(async () => recovery(await playback(page)).some(node => node.audible), 'next reply plays after the retained audio')
      assert.equal(await page.locator('[data-nexus-voice]').getAttribute('data-state'), 'live')
      await page.getByRole('button', { name: '挂断', exact: true }).click()
      assert.ok(recovery(await playback(page)).filter(node => !node.ended).every(node => node.stopped), 'hangup still stops all remaining playback')
    }, { observePlayback: true })
    assert.equal(tasks.length, 3)
    assert.ok(report.persisted.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) }
})
