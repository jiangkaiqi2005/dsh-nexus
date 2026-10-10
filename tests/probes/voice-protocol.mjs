// Real-endpoint protocol probe for ticket 07 (barge-in, cancel, truncate, tool continuation, contention).
// Run from the repo root through with-key.mjs (NEXUS_PROBE_KEY). Logs event metadata only: no audio, no key.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const require = createRequire(resolve('package.json'))
const WebSocket = require('ws')
const { voiceFixture } = await import(pathToFileURL(resolve('tests/voice-audio.mjs')).href)
const ZH = 'Microsoft Huihui Desktop'
const out = process.argv[2]
const only = process.argv[3]
const delay = ms => new Promise(r => setTimeout(r, ms))
const key = process.env.NEXUS_PROBE_KEY
const endpoint = process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'

async function speech(text) {
  const { path } = await voiceFixture([{ silence: 0.3 }, { text, voice: ZH }, { silence: 0.3 }])
  return readFileSync(path).subarray(44)
}

function connect(label, tools = []) {
  const url = new URL(endpoint); url.searchParams.set('model', 'qwen3.8-omni-flash-realtime')
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } })
  const t0 = Date.now()
  const log = []
  const waiters = []
  let queue = Buffer.alloc(0)
  let pump
  const send = event => { log.push({ t: Date.now() - t0, dir: 'c2s', ...summarize(event) }); ws.send(JSON.stringify({ event_id: `ev_${Math.random().toString(36).slice(2)}`, ...event })) }
  const summarize = event => {
    const copy = JSON.parse(JSON.stringify(event))
    if (copy.type === 'input_audio_buffer.append') return { type: copy.type, bytes: Buffer.from(copy.audio, 'base64').length }
    if (copy.type === 'response.audio.delta') { copy.bytes = Buffer.from(copy.delta, 'base64').length; delete copy.delta }
    if (copy.session?.instructions) copy.session.instructions = `[${copy.session.instructions.length} chars]`
    return copy
  }
  ws.on('message', bytes => {
    const event = JSON.parse(bytes.toString())
    const entry = { t: Date.now() - t0, dir: 's2c', ...summarize(event) }
    log.push(entry)
    for (const waiter of [...waiters]) if (waiter.pred(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event) }
  })
  const opened = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  return {
    log, t0,
    async open(extra = {}) {
      await opened
      const created = this.wait(e => e.type === 'session.created', 15000)
      await created
      send({ type: 'session.update', session: { modalities: ['text', 'audio'], instructions: 'You are a helpful assistant in a live voice call. Answer in Chinese.', turn_detection: { type: 'server_vad' }, tools, voice: 'Tina', input_audio_format: 'pcm16', output_audio_format: 'pcm24', input_audio_transcription: { model: 'gummy-realtime-v1' }, ...extra } })
      await this.wait(e => e.type === 'session.updated', 15000)
      // Continuous capture: queued speech, else silence, at real-time pace.
      pump = setInterval(() => {
        let chunk
        if (queue.length) { chunk = queue.subarray(0, 3200); queue = queue.subarray(3200) } else chunk = Buffer.alloc(3200)
        if (ws.readyState === 1) ws.send(JSON.stringify({ event_id: `a_${Math.random().toString(36).slice(2)}`, type: 'input_audio_buffer.append', audio: chunk.toString('base64') }))
      }, 100)
    },
    say(pcm) { queue = Buffer.concat([queue, pcm]); log.push({ t: Date.now() - t0, dir: 'note', note: `speech queued ${pcm.length / 32000}s` }) },
    send,
    note(note) { log.push({ t: Date.now() - t0, dir: 'note', note }) },
    wait(pred, ms = 30000) {
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve }
        waiters.push(waiter)
        setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) { waiters.splice(i, 1); resolve(undefined) } }, ms)
      })
    },
    close() { clearInterval(pump); ws.close() },
  }
}

const results = {}
const userText = text => ({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })

async function bargeIn() {
  const c = connect('barge')
  await c.open()
  const interrupt = await speech('好了好了，先停一下。一加一等于几？')
  c.send(userText('请用中文讲一个大约一分钟长的故事，关于一只小猫去森林冒险，要讲得详细一些。'))
  c.send({ type: 'response.create' })
  const created = await c.wait(e => e.type === 'response.created')
  const first = await c.wait(e => e.type === 'response.audio.delta')
  c.note('first audio delta')
  await delay(3000)
  c.say(interrupt)
  const started = await c.wait(e => e.type === 'input_audio_buffer.speech_started', 15000)
  c.note('speech_started seen')
  const done = await c.wait(e => e.type === 'response.done' && e.response?.id === created?.response?.id, 20000)
  const second = await c.wait(e => e.type === 'response.done' && e.response?.id !== created?.response?.id, 30000)
  await delay(1500)
  // Undocumented: does the endpoint accept conversation.item.truncate?
  const assistantItem = done?.response?.output?.find(item => item.role === 'assistant')?.id
  c.send({ type: 'conversation.item.truncate', item_id: assistantItem ?? 'unknown', content_index: 0, audio_end_ms: 1000 })
  await delay(3000)
  c.note('response.cancel with no active response')
  c.send({ type: 'response.cancel' })
  await delay(3000)
  c.close()
  results.barge = { log: c.log, firstResponse: created?.response?.id, firstDoneStatus: done?.response?.status, secondDoneStatus: second?.response?.status, sawSpeech: !!started }
}

async function toolBarge() {
  const tools = [{ type: 'function', name: 'lookup_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
  const c = connect('tool', tools)
  await c.open()
  const question = await speech('顺便问一下，一加一等于几？')
  c.send(userText('请调用 lookup_weather 工具查询北京的天气。'))
  c.send({ type: 'response.create' })
  const call = await c.wait(e => e.type === 'response.function_call_arguments.done')
  await c.wait(e => e.type === 'response.done')
  c.note('tool call done; user speaks before the output')
  c.say(question)
  const committed = await c.wait(e => e.type === 'input_audio_buffer.committed', 20000)
  const auto = await c.wait(e => e.type === 'response.done', 30000)
  c.note('user turn answered; now the old tool output + response.create')
  c.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call?.call_id, output: JSON.stringify({ weather: '晴，25度' }) } })
  c.send({ type: 'response.create' })
  const continued = await c.wait(e => e.type === 'response.created' || e.type === 'error', 20000)
  const continuedDone = continued?.type === 'response.created' ? await c.wait(e => e.type === 'response.done', 30000) : undefined
  let fallback
  if (!continued || continued.type === 'error') {
    c.note('continuation not answered; try plain user text carrying the result')
    c.send(userText('[工具结果] lookup_weather(北京) 返回：晴，25度。'))
    c.send({ type: 'response.create' })
    fallback = await c.wait(e => e.type === 'response.created' || e.type === 'error', 20000)
    if (fallback?.type === 'response.created') await c.wait(e => e.type === 'response.done', 30000)
  }
  await delay(1000)
  c.close()
  results.toolBarge = { log: c.log, callId: call?.call_id, committed: !!committed, autoStatus: auto?.response?.status, continued: continued?.type, continuedStatus: continuedDone?.response?.status, fallback: fallback?.type }
}

async function toolOutputDuringSpeech() {
  // The Host's tool finishes while the user's new utterance is being answered: output sent right after the user turn is committed.
  const tools = [{ type: 'function', name: 'lookup_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
  const c = connect('tool-immediate', tools)
  await c.open()
  c.send(userText('请调用 lookup_weather 工具查询上海的天气。'))
  c.send({ type: 'response.create' })
  const call = await c.wait(e => e.type === 'response.function_call_arguments.done')
  await c.wait(e => e.type === 'response.done')
  c.note('output immediately, no user turn in between')
  c.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call?.call_id, output: JSON.stringify({ weather: '多云，22度' }) } })
  c.send({ type: 'response.create' })
  const created = await c.wait(e => e.type === 'response.created' || e.type === 'error', 20000)
  const done = await c.wait(e => e.type === 'response.done', 30000)
  c.close()
  results.toolImmediate = { log: c.log, created: created?.type, status: done?.response?.status }
}

async function contention() {
  const c = connect('contention')
  await c.open()
  const hello = await speech('你好，请简单介绍一下你自己。')
  c.say(hello)
  const auto = await c.wait(e => e.type === 'response.created', 30000)
  c.note('auto response created; host sends response.create now')
  c.send(userText('HOST-NOTE: 这是一条系统通知，请简短确认。'))
  c.send({ type: 'response.create' })
  const next = await c.wait(e => (e.type === 'response.created' && e.response?.id !== auto?.response?.id) || e.type === 'error', 30000)
  const after = await c.wait(e => e.type === 'response.done' && e.response?.id !== auto?.response?.id, 30000)
  await delay(3000)
  // A Host request sent while the user is still speaking.
  const longer = await speech('请告诉我今天适合做什么运动，我想出去走一走，顺便晒晒太阳。')
  c.say(longer)
  const started = await c.wait(e => e.type === 'input_audio_buffer.speech_started', 20000)
  await delay(500)
  c.note('host response.create while the user speaks')
  c.send(userText('HOST-NOTE-2: 第二条系统通知。'))
  c.send({ type: 'response.create' })
  await c.wait(e => e.type === 'input_audio_buffer.committed', 20000)
  await delay(15000)
  c.close()
  results.contention = { log: c.log, second: next?.type, secondError: next?.type === 'error' ? next.error : undefined, afterStatus: after?.response?.status, started: !!started }
}

async function queuedBarge() {
  // Fix round 1: a Host response.create queued behind an active reply when the user starts speaking,
  // and a notice item created while the user speaks (before the commit).
  const c = connect('queued')
  await c.open()
  const interrupt = await speech('好了好了，先停一下。一加一等于几？')
  c.send(userText('请用中文讲一个大约一分钟长的故事，关于一只小猫去森林冒险，要讲得详细一些。'))
  c.send({ type: 'response.create' })
  const first = await c.wait(e => e.type === 'response.created')
  await c.wait(e => e.type === 'response.audio.delta')
  await delay(1000)
  c.note('queued host response.create behind the active reply')
  c.send(userText('HOST-QUEUED: 请只回答“收到排队通知”。'))
  c.send({ type: 'response.create' })
  await delay(500)
  c.say(interrupt)
  await c.wait(e => e.type === 'input_audio_buffer.speech_started', 15000)
  c.note('notice item while the user speaks')
  c.send(userText('NOTICE-DURING-SPEECH: 用户只听到了故事的开头。'))
  await c.wait(e => e.type === 'input_audio_buffer.committed', 20000)
  await delay(25000)
  c.close()
  const created = c.log.filter(e => e.type === 'response.created').map(e => e.response?.id)
  const done = c.log.filter(e => e.type === 'response.done').map(e => [e.response?.id, e.response?.status, e.response?.status_details?.reason])
  results.queuedBarge = { log: c.log, first: first?.response?.id, created, done }
}

for (const [name, run] of Object.entries({ bargeIn, toolBarge, toolOutputDuringSpeech, contention, queuedBarge })) {
  if (only && only !== name) continue
  try { await run() } catch (error) { results[name + 'Error'] = String(error?.stack ?? error) }
  writeFileSync(out, JSON.stringify(results, null, 1))
}
console.log('probe done', Object.keys(results))
