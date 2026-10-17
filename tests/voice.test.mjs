import { failureTooltip } from './voice-ui.mjs'
import { openSettings } from './native-settings.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, symlink, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import WebSocket, { WebSocketServer } from 'ws'
import { voiceFixture } from './voice-audio.mjs'
import { startHost } from './host-process.mjs'

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
 * deltas, function calls answered on the same connection). Barge-in follows the
 * exact model as probed (docs/research/realtime-protocol.md): speech onset cancels
 * a response still being generated with a cancelled response.done before
 * speech_started, a response.create received while the user speaks is absorbed
 * into the user's turn, and one received during a response is queued behind it.
 * @param options.utterances - per utterance index: { transcript, call } | { transcript, text } (the
 *   transcript trails the response) | { transcript, text, paced: n } (n audio deltas, one per 150 ms) |
 *   { transcript, text, burst: n } (n audio deltas at once) | { hold: true } (committed, then nothing).
 *   late: true on an utterance replays packets of the response its onset cancelled during its own response;
 *   strayError: true sends, after its speech_started, the error the endpoint gives a cancel with no active response;
 *   uncancelled: true lets its onset leave the response being generated running; slow: ms delays the answer to
 *   its commit, which is dropped (folded) when the user starts speaking again meanwhile. A text with a call
 *   is spoken and then ends in that call.
 * @param options.result - how a work result is answered: 'speak', 'silent' (empty response), 'hold' (never),
 *   or 'stall' (the response starts and never finishes).
 * @param options.speechDelayMs - how long after the onset speech_started is reported (the real endpoint lags).
 * @param options.onOnset - called with the utterance index at each speech onset.
 */
const UTTERANCES = {
  1: { transcript: 'UTT-ONE 请让文档会话开始编写接口文档。', call: { name: 'nexus_send_session', arguments: { sessionId: 'docs', text: 'DOC-TASK write the API reference' } } },
  2: { transcript: 'UTT-TWO 另外，一加一等于几？', text: 'VOICE-SECOND 一加一等于二。' },
}
function controlledModel({ withhold = false, utterances = UTTERANCES, result = 'speak', speechDelayMs = 0, onOnset, dispatchReply, onRequest, handshakeDelay = () => 0 } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const wire = []
  const log = { connections: 0, closed: 0, utterances: [], appendedBytes: 0, voicedFrames: 0, responses: [], held: [], cancelled: [], late: [], absorbed: 0, onsets: 0, folded: [] }
  server.on('connection', socket => {
    const connection = ++log.connections
    socket.on('close', () => log.closed++)
    const send = event => { wire.push({ direction: 's2c', connection, at: Date.now(), ...event, ...(event.delta && event.type === 'response.audio.delta' ? { delta: '[audio]' } : {}) }); if (socket.readyState === 1) socket.send(JSON.stringify(event)) }
    const items = []
    let answered = 0
    let responses = 0
    let speaking = false
    let voiced = 0
    let quiet = 0
    let pending = Buffer.alloc(0)
    let audio = true
    /** The response the endpoint is still generating, the requests queued behind it, and a cancelled one whose packets arrive late. */
    let current
    const queued = []
    let late
    /** Reports a detected onset that has not been reported yet. */
    let started
    const finish = () => { current = undefined; queued.shift()?.() }
    const respond = ({ text, call, paced, burst }) => {
      if (current) return queued.push(() => respond({ text, call, paced, burst }))
      const id = `resp-${connection}-${++responses}`
      const record = { connection, id, text, call: call?.name, deltas: 0, at: Date.now() }
      log.responses.push(record)
      send({ type: 'response.created', response: { id, status: 'in_progress', modalities: audio ? ['text', 'audio'] : ['text'] } })
      if (late) {
        const old = late
        late = undefined
        log.late.push(old)
        send({ type: 'response.audio.delta', response_id: old, delta: tone(0.4) })
        send({ type: 'response.audio_transcript.delta', response_id: old, delta: 'LATE-TEXT' })
        send({ type: 'response.done', response: { id: old, status: 'completed', output: [] } })
      }
      const item = call && { type: 'function_call', call_id: call.id ?? `call-${id}`, name: call.name, arguments: JSON.stringify(call.arguments) }
      if (item && !text) {
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
      const count = paced ?? burst ?? 2
      let said = ''
      const delta = index => {
        const words = count > 2 ? `${index ? ' ' : `${text} `}part-${index + 1}` : index ? '' : text
        if (words) { said += words; send({ type: 'response.audio_transcript.delta', response_id: id, delta: words }) }
        send({ type: 'response.audio.delta', response_id: id, delta: tone(0.4) })
        record.deltas++
      }
      const done = () => {
        send({ type: 'response.audio_transcript.done', response_id: id, transcript: said })
        send({ type: 'response.audio.done', response_id: id })
        // A spoken reply may end in a tool call.
        if (item) send({ type: 'response.function_call_arguments.done', response_id: id, item_id: `item-${id}`, ...item })
        send({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'audio', transcript: said }] }, ...(item ? [item] : [])] } })
      }
      if (!paced) { for (let index = 0; index < count; index++) delta(index); return done() }
      let index = 0
      const timer = setInterval(() => {
        if (index < count) return delta(index++)
        clearInterval(timer)
        done()
        finish()
      }, 150)
      current = { id, said: () => said, cancel: () => clearInterval(timer) }
    }
    const onset = () => {
      speaking = true
      log.onsets++
      const index = log.utterances.length + 1
      onOnset?.(index)
      const timer = setTimeout(() => started(), speechDelayMs)
      started = () => {
        clearTimeout(timer)
        started = undefined
        // The exact model cancels a response it is still generating and reports that before speech_started;
        // uncancelled lets it run to completion instead, as an endpoint may for a response it is finishing.
        if (current && utterances[index]?.uncancelled) log.responses.find(response => response.id === current.id).atOnset = log.responses.find(response => response.id === current.id).deltas
        else if (current) {
          const { id, cancel, said } = current
          cancel()
          log.cancelled.push(id)
          send({ type: 'response.audio_transcript.done', response_id: id, transcript: said() })
          send({ type: 'response.audio.done', response_id: id })
          send({ type: 'response.done', response: { id, status: 'cancelled', status_details: { type: 'cancelled', reason: 'turn_detected' }, output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'audio', transcript: said() }] }] } })
          if (utterances[index]?.late) late = id
          finish()
        }
        send({ type: 'input_audio_buffer.speech_started', item_id: `audio-item-${index}` })
        if (utterances[index]?.strayError) send({ type: 'error', error: { type: 'invalid_request_error', message: 'Conversation has none active response' } })
      }
    }
    const utterance = () => {
      const index = log.utterances.length + 1
      const itemId = `audio-item-${index}`
      // speech_started always precedes the end of the speech it reports.
      started?.()
      log.utterances.push({ connection, itemId, at: Date.now() })
      send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
      send({ type: 'input_audio_buffer.committed', item_id: itemId })
      send({ type: 'conversation.item.created', item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_audio' }] } })
      const plan = utterances[index] ?? { transcript: `UTT-${index}`, text: `VOICE-${index}` }
      if (plan.hold) {
        if (plan.transcript) send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: plan.transcript })
        return
      }
      const answer = () => {
        if (plan.call || plan.paced || plan.burst) {
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: plan.transcript })
          respond(plan)
        } else {
          // The transcript may trail the response it belongs to.
          respond({ text: plan.text })
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: plan.transcript })
        }
      }
      if (!plan.slow) return answer()
      // As probed: the endpoint does not answer a commit by itself once the user speaks again before it starts the response.
      setTimeout(() => {
        if (log.onsets <= index) return answer()
        log.folded.push(index)
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: plan.transcript })
      }, plan.slow)
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
          if (!speaking) { voiced = loud ? voiced + 1 : 0; if (voiced >= 3) { quiet = 0; onset() } }
          else { quiet = loud ? 0 : quiet + 1; if (quiet >= 35) { speaking = false; voiced = 0; utterance() } }
        }
        return
      }
      wire.push({ direction: 'c2s', connection, at: Date.now(), ...event })
      // withhold: the endpoint got the request but never confirmed the voice session.
      if (event.type === 'session.update') audio = event.session.modalities.includes('audio')
      if (event.type === 'session.update' && !withhold) {
        const wait = handshakeDelay(connection)
        if (wait) setTimeout(() => send({ type: 'session.updated', session: event.session }), wait)
        else send({ type: 'session.updated', session: event.session })
      }
      if (event.type === 'conversation.item.create') items.push(event.item.type === 'function_call_output' ? `[function_call_output ${event.item.call_id}] ${event.item.output}` : event.item.content?.map(part => part.text).join('\n') ?? '')
      if (event.type === 'response.cancel' && current) { const old = current; old.cancel(); log.cancelled.push(old.id); send({ type: 'response.done', response: { id: old.id, status: 'cancelled', output: [] } }); current = undefined; setTimeout(() => send({ type: 'response.audio.delta', response_id: old.id, delta: tone(0.4) }), 200) }
      if (event.type === 'response.create') {
        if (onRequest?.({ connection, socket, send, items, audio, respond })) return
        // A request that arrives while the user speaks is absorbed into the user's turn.
        if (speaking) { log.absorbed++; return }
        const fresh = items.slice(answered).join('\n')
        answered = items.length
        if (fresh.includes('AFTER-HANGUP-TOOL') && !fresh.includes('TOOL-RESULT-77')) return respond({ call: { name: 'fixture_slow_lookup', arguments: { query: 'API' } } })
        if (dispatchReply && audio && fresh.includes('function_call_output')) return respond(dispatchReply)
        if (fresh.includes('TEXT-AFTER-CALL')) return respond({ text: 'TEXT-REPLY' })
        if (fresh.includes('Automatic work-session result') && audio && result !== 'speak') {
          log.held.push({ connection, result })
          if (result === 'stall') {
            send({ type: 'response.created', response: { id: `stall-${connection}`, status: 'in_progress' } })
            return send({ type: 'response.audio_transcript.delta', response_id: `stall-${connection}`, delta: 'STALL' })
          }
          return result === 'silent' ? respond({}) : undefined
        }
        respond({ text: fresh.includes('Automatic work-session result') ? 'RESULT-HEARD 文档会话已完成。' : fresh.includes('TOOL-RESULT-77') ? 'TOOL-CONTINUED 资料查到了。' : fresh.includes('function_call_output') ? 'DOC-DISPATCHED 已安排文档会话。' : 'HOST-REPLY' })
      }
    })
  })
  return { server, wire, log, ready: new Promise(accept => server.once('listening', accept)) }
}

test('disconnect recovery: accepted text and incomplete calls survive a broken model connection without executing an unfinished tool', { timeout: 120000 }, async t => {
  const model = controlledModel({ onRequest({ connection, socket, send, respond }) {
    if (connection === 1) {
      send({ type: 'response.created', response: { id: 'broken-text', status: 'in_progress' } })
      send({ type: 'response.text.delta', response_id: 'broken-text', delta: 'PARTIAL-NOT-COMPLETE' })
      send({ type: 'response.function_call_arguments.done', response_id: 'broken-text', call_id: 'unfinished-call', name: 'fixture_slow_lookup', arguments: '{"query":"API"}' })
      socket.close()
    } else {
      // Events bearing the previous connection's unfinished response id must not revive its tool.
      send({ type: 'response.text.delta', response_id: 'broken-text', delta: 'LATE-NOT-A-REPLY' })
      send({ type: 'response.function_call_arguments.done', response_id: 'broken-text', call_id: 'unfinished-call', name: 'fixture_slow_lookup', arguments: '{"query":"API"}' })
      send({ type: 'response.done', response: { id: 'broken-text', status: 'completed', output: [{ type: 'function_call', call_id: 'unfinished-call', name: 'fixture_slow_lookup', arguments: '{"query":"API"}' }] } })
      respond({ text: 'RECOVERED-TEXT' })
    }
    return true
  } })
  await model.ready
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); await new Promise(accept => model.server.close(accept)) })
  const host = await voiceHost('disconnect-text', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true })
  t.after(() => browser.close())
  const { page } = await openNexus(browser, host.url)
  await page.getByRole('textbox').last().fill('TEXT-BEFORE-DISCONNECT 请保留这个目标。')
  await page.getByRole('textbox').last().press('Enter')
  await until(() => model.log.responses.some(response => response.text === 'RECOVERED-TEXT'), 'same turn recovered', 15000)
  await until(async () => (await supervisorOf(host))?.status === 'idle', 'recovery idle')
  const result = await host.finish()
  const replay = model.wire.filter(event => event.connection === 2 && event.type === 'conversation.item.create').map(event => JSON.stringify(event.item)).join('\n')
  assert.match(replay, /TEXT-BEFORE-DISCONNECT/)
  assert.match(replay, /unfinished-call/)
  assert.match(replay, /not executed/)
  assert.equal(result.events.filter(event => event.type === 'tool/call').length, 0)
  assert.ok(!result.events.some(event => event.type === 'assistant/message' && textOf(event.data.message).includes('LATE-NOT-A-REPLY')))
  assert.equal(result.events.filter(event => event.type === 'user/message' && textOf(event.data).includes('TEXT-BEFORE-DISCONNECT')).length, 1)
  assert.ok(result.events.some(event => event.type === 'assistant/attempt'))
  assert.ok(result.events.some(event => event.type === 'assistant/message' && textOf(event.data.message) === 'RECOVERED-TEXT'))
  assert.ok(result.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
  await writeFile(resolve(host.home, 'wire.json'), JSON.stringify(model.wire))
  console.log('disconnect text evidence:', host.home)
})

test('disconnect recovery: a live call rebuilds context while a native tool runs, and a repeated completed call is never executed twice', { timeout: 120000 }, async t => {
  const seen = new Map()
  const model = controlledModel({ handshakeDelay: connection => connection === 2 ? 700 : 0, onRequest({ connection, respond }) {
    const count = (seen.get(connection) ?? 0) + 1
    seen.set(connection, count)
    if ((connection === 1 || connection === 2) && count === 1) respond({ ...(connection === 2 ? { text: 'REPEATED-CALL' } : {}), call: { id: 'stable-lookup', name: 'fixture_slow_lookup', arguments: { query: 'API' } } })
    else respond({ text: 'NETWORK-TOOL-CONTINUED' })
    return true
  } })
  const capture = await voiceFixture([{ silence: 60 }])
  await controlledCall(t, 'disconnect-tool', model, capture, async ({ host, page, bar }) => {
    await page.getByRole('textbox').last().fill('LOOKUP-BEFORE-NETWORK 查询资料。')
    await page.getByRole('textbox').last().press('Enter')
    await until(async () => { try { await readFile(resolve(host.home, 'tool-started')); return true } catch { return false } }, 'tool started')
    const old = [...model.server.clients][0]
    old.close()
    await until(async () => (await state(bar)) === 'connecting', 'actual recovery state')
    await until(async () => (await state(bar)) === 'live' && model.log.connections === 2, 'call recovered')
    assert.equal((await trackStates(page)).length, 1, 'network recovery keeps the existing microphone choice')
    await writeFile(resolve(host.home, 'tool-release'), '')
    await until(() => model.log.responses.some(response => response.connection === 2 && response.text === 'NETWORK-TOOL-CONTINUED'), 'completed result continued')
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'tool recovery idle')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    const result = await host.finish()
    assert.equal(result.events.filter(event => event.type === 'tool/call' && event.data.callId === 'stable-lookup').length, 1)
    assert.equal(result.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'stable-lookup').length, 1)
    const replay = model.wire.filter(event => event.connection === 2 && event.type === 'conversation.item.create').map(event => JSON.stringify(event.item)).join('\n')
    assert.match(replay, /LOOKUP-BEFORE-NETWORK/)
    assert.match(replay, /TOOL-RESULT-77/)
    assert.ok(model.wire.some(event => event.connection === 2 && event.item?.type === 'function_call_output' && event.item.call_id === 'stable-lookup'), 'repeated call receives the existing result')
    assert.ok(result.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    await writeFile(resolve(host.home, 'wire.json'), JSON.stringify(model.wire))
    console.log('disconnect native tool evidence:', host.home)
  })
})

test('disconnect failure: an endpoint that also breaks the rebuilt request leaves an error turn and all unexecuted call facts', { timeout: 120000 }, async t => {
  const model = controlledModel({ onRequest({ connection, socket, send }) {
    const id = `unanswered-${connection}`
    send({ type: 'response.created', response: { id, status: 'in_progress' } })
    send({ type: 'response.function_call_arguments.done', response_id: id, call_id: `unexecuted-${connection}`, name: 'fixture_slow_lookup', arguments: '{"query":"API"}' })
    socket.close()
    return true
  } })
  await model.ready
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); await new Promise(accept => model.server.close(accept)) })
  const host = await voiceHost('disconnect-unavailable', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true })
  t.after(() => browser.close())
  const { page } = await openNexus(browser, host.url)
  await page.getByRole('textbox').last().fill('OFFLINE-INPUT 保留失败事实。')
  await page.getByRole('textbox').last().press('Enter')
  await until(async () => (await supervisorOf(host))?.ends === 1, 'failed turn settled')
  const result = await host.finish()
  assert.equal(model.log.connections, 2, 'one bounded reconstruction, no endless hidden retry')
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error')
  assert.equal(result.events.filter(event => event.type === 'tool/call').length, 0)
  const notices = result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-connection').map(event => textOf(event.data)).join('\n')
  assert.match(notices, /unexecuted-1/)
  assert.match(notices, /unexecuted-2/)
  assert.equal(result.events.filter(event => event.type === 'assistant/message').length, 0, 'failed connection never becomes an invented answer')
  await writeFile(resolve(host.home, 'wire.json'), JSON.stringify(model.wire))
  console.log('unavailable model evidence:', host.home)
})

for (const ending of ['hangup', 'reload']) {
  test(`disconnect lifecycle: ${ending} during model recovery stays in text and never reopens the microphone`, { timeout: 120000 }, async t => {
    const model = controlledModel({ handshakeDelay: connection => connection === 2 ? 2000 : 0 })
    const capture = await voiceFixture([{ silence: 60 }])
    await controlledCall(t, 'disconnect-' + ending, model, capture, async ({ host, page, bar }) => {
      ;[...model.server.clients][0].close()
      await until(async () => (await state(bar)) === 'connecting', 'reconnecting call')
      if (ending === 'hangup') await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      else await page.reload()
      await until(async () => (await state(bar)) === 'idle', 'voice remains off')
      await delay(2300)
      assert.equal(await state(bar), 'idle')
      assert.ok((await trackStates(page)).every(track => track === 'ended'))
      assert.equal(await audible(page), 0)
      const voiceCount = model.wire.filter(event => event.type === 'session.update' && event.session.modalities.includes('audio')).length
      await page.getByRole('textbox').last().fill('TEXT-AFTER-CALL 保持文字。')
      await page.getByRole('textbox').last().press('Enter')
      await until(() => model.log.responses.some(response => response.text === 'TEXT-REPLY'), 'text after recovery ended')
      assert.equal(model.wire.filter(event => event.type === 'session.update' && event.session.modalities.includes('audio')).length, voiceCount)
      const result = await host.finish()
      assert.ok(result.events.some(event => event.type === 'assistant/message' && textOf(event.data.message) === 'TEXT-REPLY'))
      await writeFile(resolve(host.home, 'wire.json'), JSON.stringify(model.wire))
      console.log('disconnect end evidence:', ending, host.home)
    })
  })
}

for (const mode of ['transcribed', 'untranscribed', 'timeout']) {
  const transcribed = mode === 'transcribed'
  const timeout = mode === 'timeout'
  test(`disconnect recovery: committed speech ${transcribed ? 'keeps its received transcription' : timeout ? 'records unavailable words after an unanswered commit times out' : 'records unavailable words honestly'} before the endpoint answers`, { timeout: 120000 }, async t => {
    const model = controlledModel({ utterances: { 1: { hold: true, ...(transcribed ? { transcript: 'SPEECH-BEFORE-DISCONNECT 请保留目标。' } : {}) } } })
    const capture = await voiceFixture([{ silence: 1.5 }, { text: '请保留目标。', voice: ZH }, { silence: 30 }])
    await controlledCall(t, 'disconnect-speech-' + mode, model, capture, async ({ host, page, bar }) => {
      await until(() => model.log.utterances.length === 1, 'speech committed')
      if (!timeout) [...model.server.clients][0].close()
      await until(() => model.log.responses.some(response => response.connection === 2 && response.text === 'HOST-REPLY'), 'interrupted input continued', 15000)
      await until(async () => (await supervisorOf(host))?.status === 'idle', 'speech recovery idle')
      if (timeout) {
        await until(async () => (await state(bar)) === 'failed', 'unanswering call failed')
        assert.equal(await bar.getByRole('status').textContent(), '连不上语音服务'); await failureTooltip(page, 'TIMEOUT')
        assert.ok((await trackStates(page)).every(track => track === 'ended'))
      } else await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      const result = await host.finish()
      const replay = model.wire.filter(event => event.connection === 2 && event.type === 'conversation.item.create').map(event => JSON.stringify(event.item)).join('\n')
      const input = result.events.find(event => event.type === 'user/message' && (transcribed ? textOf(event.data).includes('SPEECH-BEFORE-DISCONNECT') : event.data.source.summary === 'untranscribed interrupted input'))
      assert.ok(input)
      assert.equal(input.data.source.kind, transcribed ? 'user' : 'nexus-voice')
      assert.match(replay, transcribed ? /SPEECH-BEFORE-DISCONNECT/ : /words are unavailable/)
      assert.ok(result.events.some(event => event.type === 'assistant/attempt'), 'the lost response is recorded as an attempt')
      assert.ok(result.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
      console.log('interrupted speech evidence:', mode, host.home)
    }, { timeoutMs: timeout ? 2500 : 30000 })
  })
}

test('disconnect lifecycle: another client cannot acquire media, closing the owner keeps background text and manual reentry', { timeout: 120000 }, async t => {
  const model = controlledModel()
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 60 }])
  await controlledCall(t, 'disconnect-client-close', model, capture, async ({ host, page, bar, browser }) => {
    await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'worker running before close')
    const second = await openNexus(browser, host.url, [instrument, []])
    await second.bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
    await until(async () => (await state(second.bar)) === 'failed', 'second client rejected')
    assert.equal(await second.bar.getByRole('status').textContent(), '另一个窗口正在通话'); await failureTooltip(second.page, 'CALL_BUSY')
    assert.equal((await trackStates(second.page)).length, 0, 'second client never captures')
    assert.equal(await audible(second.page), 0)
    // Hiding the page leaves its call alive; closing its actual context ends the media owner.
    await second.page.bringToFront()
    assert.equal(await state(bar), 'live')
    await page.context().close()
    await host.release()
    await until(() => model.log.responses.some(response => response.text?.startsWith('RESULT-HEARD') && response.connection > 1), 'Host text work after page closed')
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'background text settled')
    assert.equal((await trackStates(second.page)).length, 0)
    await second.bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
    await until(async () => (await state(second.bar)) === 'live', 'manual reentry')
    const connection = model.log.connections
    const replay = model.wire.filter(event => event.connection === connection && event.type === 'conversation.item.create').map(event => JSON.stringify(event.item)).join('\n')
    assert.match(replay, /DOC-READY-42/)
    await second.bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    const result = await host.finish()
    assert.equal(result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === 'docs').length, 1)
    assert.ok(result.events.some(event => event.type === 'assistant/message' && textOf(event.data.message).startsWith('RESULT-HEARD')))
    assert.equal(result.workers.find(worker => worker.id === 'docs').events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    await writeFile(resolve(host.home, 'wire.json'), JSON.stringify(model.wire))
    console.log('closed client evidence:', host.home)
  })
})

async function voiceHost(scenario, { endpoint, credentialRef = 'NEXUS_VOICE_KEY', key = 'fixture-not-a-secret', timeoutMs = 30000, navigation = false } = {}) {
  const home = resolve('.scratch/nexus-v1', `voice-${scenario}-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-voice')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules'), resolve(home, 'output')]) await mkdir(dir, { recursive: true })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-voice-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/voice-probe.js'), resolve(fixture, 'index.js'))
  if (navigation) await mkdir(resolve(workspace, 'other-project'), { recursive: true })
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-voice-probe\n      name: nexus-voice-probe\n      config:\n        dir: ${JSON.stringify(home)}\n        workspace: ${JSON.stringify(workspace)}\n        marker: DOC-READY-42\n        navigation: ${navigation}\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-voice-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-voice-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    voiceMode: realtime\n    credentialRef: ${credentialRef}\n    endpoint: ${endpoint}\n    timeoutMs: ${timeoutMs}\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n`)
  return startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-voice', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), [credentialRef]: key, DSH_TELEMETRY: '0' } }, async child => {
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
    }
  })
}

/** Open the native UI, enter Nexus and return the call bar of the main conversation. */
async function openNexus(browser, url, init, preparePage) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  if (init) await (Array.isArray(init) ? page.addInitScript(...init) : page.addInitScript(init))
  await preparePage?.(page)
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
/**
 * In-page observation only: records each capture stream, every call-bar state, call failure and flush frames
 * on the gateway socket, and every scheduled playback node with its stop time; delays the listed microphone requests.
 */
const instrument = delays => {
  const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  window.__streams = []
  window.__states = []
  // Gateway frames that carry a call failure code, observed whether or not the call bar is still mounted.
  window.__failures = []
  window.__flushes = 0
  window.__nodes = []
  const start = AudioBufferSourceNode.prototype.start
  const stop = AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) { window.__nodes.push({ node: this, when: Math.max(when, this.context.currentTime), duration: this.buffer?.duration ?? 0 }); return start.call(this, when, ...rest) }
  AudioBufferSourceNode.prototype.stop = function (...args) { const entry = window.__nodes.find(item => item.node === this); if (entry && entry.stoppedAt === undefined) entry.stoppedAt = this.context.currentTime; return stop.apply(this, args) }
  const Socket = window.WebSocket
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', event => {
        const text = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : ''
        for (const match of text.matchAll(/"state":"failed","code":"([A-Z_]+)"/g)) window.__failures.push(match[1])
        window.__flushes += text.match(/"type":"flush"/g)?.length ?? 0
      })
    }
  }
  new MutationObserver(() => { const bar = document.querySelector('[data-nexus-voice]'); const state = bar?.getAttribute('data-state'); const code = state === 'failed' ? window.__failures.at(-1) : undefined; const entry = code ? state + ':' + code : state; if (entry && entry !== window.__states.at(-1)) window.__states.push(entry) }).observe(document, { subtree: true, attributes: true, childList: true })
  navigator.mediaDevices.getUserMedia = async constraints => { const stream = await request(constraints); window.__streams.push(stream); await new Promise(accept => setTimeout(accept, delays.shift() ?? 0)); return stream }
}
const trackStates = page => page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))
/** Scheduled playback nodes that are still audible now: started, not stopped and not yet finished. */
const audible = page => page.evaluate(() => window.__nodes.filter(item => item.stoppedAt === undefined && item.node.context.currentTime < item.when + item.duration).length)

test('voice navigation: changing working conversation or project preserves the call and accessible hangup control', { timeout: 120000 }, async t => {
  const model = controlledModel({ utterances: {} })
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const capture = await voiceFixture([{ silence: 45 }])
  const host = await voiceHost('navigation', { endpoint: `ws://127.0.0.1:${model.server.address().port}`, navigation: true })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  const { page, bar } = await openNexus(browser, host.url, [instrument, []])
  try {
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
    await until(async () => await state(bar) === 'live', 'navigation call live')
    const voiceConnection = model.log.connections
    const closedBefore = model.log.closed
    const tree = page.getByRole('tree', { name: '会话' })
    const worker = tree.getByRole('treeitem', { name: /^导航工作会话/ })
    if (!(await worker.isVisible())) await tree.getByRole('treeitem', { name: /^workspace/ }).click()
    await worker.click()
    await delay(500)
    await writeFile(resolve(host.home, 'output/navigation-first.yml'), await page.locator('body').ariaSnapshot())
    assert.equal(await bar.count(), 1, 'the call and its controls must remain visible in a work conversation')
    assert.equal(await state(bar), 'live', 'changing conversation must not hang up Nexus')
    assert.deepEqual(await trackStates(page), ['live'])
    const editor = page.getByRole('textbox').last()
    await editor.fill('WORKER-NAV-DIRECT 用户直接在工作会话输入')
    await editor.press('Enter')
    await until(() => model.wire.some(event => event.connection === voiceConnection && event.type === 'conversation.item.create' && event.item.content?.[0]?.text?.includes('WORKER-NAV-DIRECT')), 'direct input mirrored on the same voice call')
    const other = tree.getByRole('treeitem', { name: /^另一个项目会话/ })
    if (!(await other.isVisible())) await tree.getByRole('treeitem', { name: /^other-project/ }).click()
    await other.click()
    assert.equal(await state(bar), 'live')
    assert.equal(model.log.closed, closedBefore, 'navigation never closes the active model connection')
    assert.equal(model.log.connections, voiceConnection, 'navigation does not reconnect the voice model')
    await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
    assert.equal(await state(bar), 'live', 'the empty conversation view retains global call controls')
    await openSettings(page)
    assert.equal(await state(bar), 'live', 'settings retain global call controls')
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
    assert.ok(await bar.getByRole('button', { name: /挂断|Hang up/ }).isVisible(), 'collapsed navigation cannot hide the hangup control')
    await page.screenshot({ path: resolve(host.home, 'output/navigation-live.png') })
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(() => model.log.closed > closedBefore, 'explicit hangup closes the model connection')
    assert.deepEqual(await trackStates(page), ['ended'])
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click()
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    assert.equal(await state(bar), 'idle', 'returning to Nexus after explicit hangup never reopens the microphone')
    await host.finish()
    console.log('voice navigation evidence:', host.home)
  } catch (error) {
    await page.screenshot({ path: resolve(host.home, 'output/navigation-failure.png') }).catch(() => {})
    await writeFile(resolve(host.home, 'output/navigation-failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {})
    console.log('voice navigation evidence:', host.home, 'capture tracks:', await trackStates(page))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
})

test('voice call: client audio reaches the Host-held model, which speaks, dispatches work and keeps talking while it runs', { timeout: 240000 }, async t => {
  const model = controlledModel()
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 9 }, { text: '另外，一加一等于几？', voice: ZH }, { silence: 40 }])
  const host = await voiceHost('controlled', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    assert.equal(await state(bar), 'idle')
    assert.equal(model.log.connections, 0, 'opening Nexus does not connect the voice model')
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
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
    assert.ok(docs.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.via === 'nexus' && textOf(event.data).includes('DOC-TASK')))
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

test('voice call states: no device, denied permission and blocked playback never reach the model; a sent request is not live', { timeout: 180000 }, async t => {
  const model = controlledModel({ withhold: true })
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const host = await voiceHost('states', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  // Always the fake capture device: the physical microphone is never opened.
  const fake = ['--use-fake-device-for-media-stream']
  const granting = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: [...fake, '--use-fake-ui-for-media-stream', '--autoplay-policy=document-user-activation-required'] })
  t.after(() => granting.close())
  const denying = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: [...fake, '--deny-permission-prompts'] })
  t.after(() => denying.close())
  const start = bar => bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
  const settled = async (bar, expected) => { await until(async () => (await state(bar)) === expected, `state ${expected}`, 15000); return bar.getByRole('status').textContent() }
  const states = {}
  try {
    // Browser-enforced denial (real Chromium permission path, no OS prompt).
    let { context, bar } = await openNexus(denying, host.url)
    await start(bar)
    states.denied = await settled(bar, 'mic-denied'); await failureTooltip(context.pages()[0], 'NotAllowedError')
    await context.close()
    // Simulated in page: no capture device present.
    ;({ context, bar } = await openNexus(granting, host.url, () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')) }))
    await start(bar)
    states.noDevice = await settled(bar, 'no-device'); await failureTooltip(context.pages()[0], 'NotFoundError')
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
    states.playback = await settled(bar, 'playback-blocked'); await failureTooltip(page, 'suspended')
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
    assert.deepEqual(states, { denied: '麦克风权限被拒绝', noDevice: '没有可用的麦克风', playback: '浏览器暂不允许播放声音', connecting: '正在接通…' })
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

test('accurate Realtime voice call: real model hears synthesized speech, dispatches work, keeps talking and receives the result', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 420000 }, async t => {
  // Real model and real client code; the speech is offline SAPI audio fed through Chromium's fake capture device.
  const capture = await voiceFixture([{ silence: 5 }, { text: '请让现有的 docs 会话开始编写接口文档。', voice: ZH }, { silence: 14 }, { text: '另外，一加一等于几？', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('real', { endpoint: process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', key: process.env.NEXUS_VOICE_KEY })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  const supervisor = async () => (await host.status())?.agents?.find(agent => agent.id === 'nexus-supervisor')
  const docs = async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
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
    assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.via === 'nexus'))
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

test('voice call races: hanging up during the microphone request or rapidly restarting keeps only the call the user wants', { timeout: 180000 }, async t => {
  const model = controlledModel()
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const capture = await voiceFixture([{ silence: 120 }])
  const host = await voiceHost('races', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  let page
  try {
    // Controlled in page: the first real capture stream arrives 1.5 s late, like a pending permission prompt; every call-bar state is recorded.
    const opened = await openNexus(browser, host.url, [instrument, [1500]])
    page = opened.page
    const bar = opened.bar
    const start = () => bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
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
    const previousControlConnected = await page.evaluate(async () => { const previous = document.querySelector('[data-nexus-voice] [aria-label="挂断"]'); previous.click(); await new Promise(accept => setTimeout(accept, 0)); const connected = previous.isConnected; document.querySelector('[data-nexus-voice] button').click(); return connected })
    console.log('rapid restart: previous control still connected:', previousControlConnected)
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
    if (page) {
      await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
      await writeFile(resolve(host.home, 'output/failure-ui.json'), JSON.stringify({
        client: await page.evaluate(() => ({ state: document.querySelector('[data-nexus-voice]')?.getAttribute('data-state'), states: window.__states, failures: window.__failures, tracks: window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState)) })),
        model: { connections: model.log.connections, closed: model.log.closed }, wire: model.wire.map(({ type, connection, at }) => ({ type, connection, at })),
      }, null, 2)).catch(() => {})
      await writeFile(resolve(host.home, 'output/failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {})
    }
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

test('voice call creates a new work session, may stay silent on its result, and later text turns use a text connection', { timeout: 240000 }, async t => {
  const create = { name: 'nexus_create_session', arguments: { text: 'NEW-TASK write the deployment guide' } }
  const model = controlledModel({ utterances: { 1: { transcript: 'UTT-NEW 新建一个会话编写部署说明。', call: create } }, result: 'silent' })
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请新建一个会话编写部署说明。', voice: ZH }, { silence: 60 }])
  const host = await voiceHost('create', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  create.arguments.cwd = host.workspace
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
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
    assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.via === 'nexus' && textOf(event.data).includes('NEW-TASK')))
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

test('voice hang-up keeps no unheard utterance, continues a pending result in text, and a stopping Host ends the call', { timeout: 240000 }, async t => {
  const model = controlledModel({ utterances: { 1: { hold: true }, 2: UTTERANCES[1] }, result: 'hold' })
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 4 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('hangup', { endpoint: `ws://127.0.0.1:${model.server.address().port}` })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  let page
  try {
    const opened = await openNexus(browser, host.url, [instrument, []])
    page = opened.page
    const bar = opened.bar
    const start = async () => { await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click(); await until(async () => (await state(bar)) === 'live', 'live call') }
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
    // The polished UI subscribes synchronously, so disposal's idle notification
    // can be observed before the slot unmounts. It must follow the real failure.
    if (history.at(-1) === 'idle') assert.deepEqual(history.slice(-2), ['failed:UNAVAILABLE', 'idle'])
    else assert.ok(['live', 'failed:UNAVAILABLE'].includes(history.at(-1)))

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

test('accurate Realtime voice call: real model creates a new work session from speech and it executes', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 420000 }, async t => {
  // Real model and real client code; the speech is offline SAPI audio fed through Chromium's fake capture device.
  const capture = await voiceFixture([{ silence: 5 }, { text: '请新建一个工作会话，就用 docs 会话所在的工作区，让它编写一份部署说明。', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('real-create', { endpoint: process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', key: process.env.NEXUS_VOICE_KEY })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  const created = async () => (await host.status())?.agents?.find(agent => !['nexus-supervisor', 'docs'].includes(agent.id))
  let page
  try {
    const opened = await openNexus(browser, host.url)
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
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
    assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.via === 'nexus'))
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

test('voice call whose response stalls fails the call instead of hanging the supervisor', { timeout: 180000 }, async t => {
  const model = controlledModel({ result: 'stall' })
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); if (model.server.listening) await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 90 }])
  const host = await voiceHost('stall', { endpoint: `ws://127.0.0.1:${model.server.address().port}`, timeoutMs: 3000 })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  let page
  try {
    const opened = await openNexus(browser, host.url, [instrument, []])
    page = opened.page
    const bar = opened.bar
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
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

/** Run one call: Host, endpoint (controlled, or a relay to the real one with key) and a headless Edge whose fake microphone plays the capture. */
async function controlledCall(t, scenario, model, capture, run, { key, beforeStart, preparePage, timeoutMs } = {}) {
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); await new Promise(accept => model.server.close(accept)) })
  await model.ready
  const host = await voiceHost(scenario, { endpoint: `ws://127.0.0.1:${model.server.address().port}`, key, timeoutMs })
  t.after(() => host.close())
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  let page
  try {
    const opened = await openNexus(browser, host.url, [instrument, []], preparePage)
    page = opened.page
    await beforeStart?.({ host, page, bar: opened.bar })
    await opened.bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
    await until(async () => (await state(opened.bar)) === 'live', 'live call')
    await run({ host, page, bar: opened.bar, browser })
    await writeFile(resolve(host.home, 'wire.json'), JSON.stringify({ wire: model.wire, log: model.log }))
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(host.home, 'output/failure.png') }).catch(() => {})
    console.log(host.output().slice(-4000))
    console.log('controlled model:', JSON.stringify(model.log.responses), JSON.stringify({ cancelled: model.log.cancelled, late: model.log.late, absorbed: model.log.absorbed }))
    await writeFile(resolve(host.home, 'wire.json'), JSON.stringify({ wire: model.wire, log: model.log })).catch(() => {})
    // A failed observation must still release the workers/tools this fixture owns before durable cleanup.
    await host.release()
    await writeFile(resolve(host.home, 'tool-release'), '')
    const record = await host.finish().catch(() => undefined)
    if (record) await writeFile(resolve(host.home, 'output/failure-events.json'), JSON.stringify(record, null, 1))
    throw error
  } finally {
    await browser.close()
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
}
const CUT = /about (\d+(?:\.\d+)?) s of its (\d+(?:\.\d+)?) s of audio were played/

test('voice barge-in: speech stops the reply and its queued audio, late packets and an unrelated endpoint error change nothing, the record marks what was cut, and normal exchange resumes', { timeout: 300000 }, async t => {
  const model = controlledModel({ utterances: {
    1: { transcript: 'UTT-ONE 请详细介绍一下接口文档的结构。', text: 'LONG-ONE', paced: 40 },
    2: { transcript: 'UTT-TWO 先停一下。', text: 'VOICE-TWO 好的。', paced: 4, late: true, strayError: true },
    3: { transcript: 'UTT-THREE 一加一等于几？', text: 'LONG-THREE', burst: 20 },
    4: { transcript: 'UTT-FOUR 好的，谢谢。', text: 'VOICE-FOUR 不客气。' },
    5: { transcript: 'UTT-FIVE 最后，现在进展如何？', text: 'VOICE-FIVE 一切正常。' },
  } })
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请详细介绍一下接口文档的结构。', voice: ZH }, { silence: 2.5 }, { text: '先停一下。', voice: ZH }, { silence: 3.5 }, { text: '一加一等于几？', voice: ZH }, { silence: 3 }, { text: '好的，谢谢。', voice: ZH }, { silence: 3.5 }, { text: '最后，现在进展如何？', voice: ZH }, { silence: 20 }])
  await controlledCall(t, 'barge', model, capture, async ({ host, page, bar }) => {
    // At an onset, what is still queued must go silent long before it would have finished playing.
    const interrupted = async (onsets, label) => {
      await until(() => model.log.onsets >= onsets, label, 90000)
      await until(async () => (await audible(page)) === 0, `${label}: playback stopped`, 1500)
      // Nodes stopped before their scheduled end: audio that was queued or playing when the user spoke.
      return page.evaluate(() => window.__nodes.filter(item => item.stoppedAt !== undefined && item.stoppedAt < item.when + item.duration).length)
    }
    // Utterance 2 starts while reply 1 is still being generated and played.
    const queuedFirst = await interrupted(2, 'second onset')
    // Utterance 4 starts after reply 3 finished generating but while it is still playing.
    const queuedFourth = await interrupted(4, 'fourth onset')
    await until(() => model.log.responses.some(response => response.text?.startsWith('VOICE-FIVE')), 'fifth reply', 60000)
    await until(async () => { const own = await supervisorOf(host); return own?.status === 'idle' && own.ends >= 5 }, 'five turns completed', 60000)
    await delay(2500)
    const scheduled = Number(await bar.getAttribute('data-played-samples'))
    const stillPlaying = await audible(page)
    assert.equal(await state(bar), 'live')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')

    const result = await host.finish()
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const user = text => events.find(event => event.type === 'user/message' && textOf(event.data).includes(text))
    const replyIn = turn => events.filter(event => event.type === 'assistant/message' && turnOf(event.seq) === turn)
    const noticesIn = turn => events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice' && turnOf(event.seq) === turn)
    const turns = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].map(name => turnOf(user(`UTT-${name}`).seq))

    // The endpoint cancelled the first reply on speech onset and its late packets arrived during reply 2.
    const first = model.log.responses.find(response => response.text === 'LONG-ONE')
    assert.deepEqual(model.log.cancelled, [first.id])
    assert.deepEqual(model.log.late, [first.id])
    assert.ok(first.deltas < 40, 'the first reply was still being generated when the user spoke')
    // The client stopped everything it had queued at each interruption and played no late packet.
    assert.ok(queuedFirst > 0 && queuedFourth > queuedFirst, `audio was queued when the user spoke: ${queuedFirst}, ${queuedFourth}`)
    assert.ok(await page.evaluate(() => window.__flushes) >= 2)
    assert.equal(stillPlaying, 0)
    assert.equal(scheduled, 9600 * model.log.responses.reduce((sum, response) => sum + response.deltas, 0), 'every delta of the live replies and nothing else was scheduled')
    // Turn 1 records only what arrived before the interruption, marked as interrupted.
    const [cut] = replyIn(turns[0])
    assert.equal(cut.data.interrupted, true)
    assert.match(textOf(cut.data.message), /^LONG-ONE part-1/)
    assert.ok(!events.some(event => event.type === 'assistant/message' && textOf(event.data.message).includes('LATE-TEXT')), 'late text of the cancelled reply is not recorded')
    // The playback notice reached the model while the user spoke, before the endpoint answered the utterance;
    // turn 2 records it as the server holds it: the user's words, the notice, then the complete reply 2.
    const noticeSent = text => model.wire.find(event => event.type === 'conversation.item.create' && event.item.content?.[0]?.text.includes('speaking over your spoken reply "' + text))
    assert.ok(noticeSent('LONG-ONE').at < model.log.responses.find(response => response.text?.startsWith('VOICE-TWO')).at, 'the first notice preceded the reply to utterance 2')
    assert.ok(noticeSent('LONG-THREE').at < model.log.responses.find(response => response.text?.startsWith('VOICE-FOUR')).at, 'the second notice preceded the reply to utterance 4')
    const [notice] = noticesIn(turns[1])
    assert.ok(notice.seq > user('UTT-TWO').seq && notice.seq < replyIn(turns[1])[0].seq)
    const [, heard, total] = textOf(notice.data).match(CUT).map(Number)
    assert.ok(heard > 0 && heard < total && Math.abs(total - first.deltas * 0.4) < 0.05, `heard ${heard} of ${total}`)
    assert.equal(textOf(replyIn(turns[1])[0].data.message), 'VOICE-TWO 好的。 part-1 part-2 part-3 part-4')
    assert.equal(replyIn(turns[1])[0].data.interrupted, undefined)
    // Reply 3 completed on the server and was cut while playing: recorded whole, the cut noted in turn 4.
    assert.equal(replyIn(turns[2])[0].data.interrupted, undefined)
    const [later] = noticesIn(turns[3])
    const [, heardLater, totalLater] = textOf(later.data).match(CUT).map(Number)
    assert.ok(heardLater > 0 && heardLater < 7 && Math.abs(totalLater - 8) < 0.05, `heard ${heardLater} of ${totalLater}`)
    assert.match(textOf(later.data), /LONG-THREE/)
    // The unrelated endpoint error left the call up and is on the Host log.
    assert.ok(result.logs.some(line => /nexus voice: endpoint error left the call up: .*invalid_request_error/.test(line)), JSON.stringify(result.logs))
    // Normal exchange resumed: replies 4 and 5 were heard whole, no further notices.
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice').length, 2)
    assert.match(textOf(replyIn(turns[4])[0].data.message), /^VOICE-FIVE/)
    for (const event of events.filter(event => event.type === 'assistant/message')) assert.equal(event.data.message.source.model, MODEL)
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    console.log('voice barge-in evidence:', host.home, JSON.stringify({ heard, total, heardLater, totalLater, scheduled }))
  })
})

test('voice interleaving: a tool that finishes while the user speaks, and a work result requested while the user speaks, keep their identities and are answered after the user turn', { timeout: 300000 }, async t => {
  let host
  // Onsets release held work, so it finishes while the endpoint hears the user but before it reports speech_started.
  const release = { 2: () => writeFile(resolve(host.home, 'tool-release'), ''), 4: () => host.release() }
  const model = controlledModel({ speechDelayMs: 2000, onOnset: index => { release[index]?.().catch(() => {}) }, utterances: {
    1: { transcript: 'UTT-ONE 请查一下资料。', call: { name: 'fixture_slow_lookup', arguments: { query: 'API' } } },
    2: { transcript: 'UTT-TWO 一加一等于几？', text: 'VOICE-WHILE-TOOL 一加一等于二。' },
    3: { ...UTTERANCES[1], transcript: 'UTT-THREE 请让文档会话开始编写接口文档。' },
    4: { transcript: 'UTT-FOUR 另外，现在几点了？', text: 'VOICE-FOUR 现在是下午。' },
  } })
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请查一下资料。', voice: ZH }, { silence: 2.5 }, { text: '一加一等于几？', voice: ZH }, { silence: 6 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 6 }, { text: '另外，现在几点了？', voice: ZH }, { silence: 30 }])
  await controlledCall(t, 'interleave', model, capture, async context => {
    host = context.host
    const { bar } = context
    // The tool of utterance 1 is still running when utterance 2 starts; it finishes during that speech.
    await until(async () => { try { await readFile(resolve(host.home, 'tool-started')); return true } catch { return false } }, 'tool running')
    await until(() => model.log.responses.some(response => response.text?.startsWith('VOICE-WHILE-TOOL')), 'utterance answered', 60000)
    await until(() => model.log.responses.some(response => response.text?.startsWith('TOOL-CONTINUED')), 'tool continuation', 30000)
    // Utterance 3 dispatches docs; utterance 4's onset releases it, so the result is requested while the user speaks.
    await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'docs worker running', 60000)
    await until(() => model.log.responses.some(response => response.text?.startsWith('RESULT-HEARD')), 'result answered', 90000)
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'supervisor idle', 30000)
    assert.equal(await state(bar), 'live')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')

    const result = await host.finish()
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const user = text => events.find(event => event.type === 'user/message' && textOf(event.data).includes(text))
    const reply = text => events.find(event => event.type === 'assistant/message' && textOf(event.data.message).includes(text))
    const response = text => model.log.responses.find(item => item.text?.startsWith(text))
    // The tool of turn 1 kept its identity: call, result and continuation in turn 1, answered on the original call id.
    const call = events.find(event => event.type === 'tool/call' && event.data.name === 'fixture_slow_lookup')
    const output = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    assert.equal(output.data.message.isError, false)
    assert.match(JSON.stringify(output.data.message.content), /TOOL-RESULT-77/)
    const one = turnOf(user('UTT-ONE').seq)
    assert.deepEqual([turnOf(call.seq), turnOf(output.seq), turnOf(reply('TOOL-CONTINUED').seq)], [one, one, one])
    // Utterance 2 got its own turn and reply. The tool output reached the endpoint while the user spoke, so its
    // request was absorbed; the Host asked again once utterance 2 was answered, and the continuation followed it.
    const two = turnOf(user('UTT-TWO').seq)
    assert.notEqual(two, one)
    assert.equal(turnOf(reply('VOICE-WHILE-TOOL').seq), two)
    const outputSent = model.wire.find(event => event.type === 'conversation.item.create' && event.item.type === 'function_call_output' && event.item.call_id === call.data.callId)
    assert.ok(outputSent.at < response('VOICE-WHILE-TOOL').at, 'the tool output was sent while the user was speaking')
    assert.ok(model.log.responses.indexOf(response('VOICE-WHILE-TOOL')) < model.log.responses.indexOf(response('TOOL-CONTINUED')))
    // The result request also reached the endpoint while the user spoke and was asked again after the user's turn.
    assert.equal(model.log.absorbed, 2, 'the tool continuation and the result request each arrived while the user was speaking')
    assert.ok(model.log.responses.indexOf(response('VOICE-FOUR')) < model.log.responses.indexOf(response('RESULT-HEARD')))
    const notice = events.find(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === 'docs')
    assert.match(textOf(notice.data), /DOC-READY-42/)
    assert.equal(turnOf(reply('RESULT-HEARD').seq), turnOf(notice.seq))
    assert.equal(turnOf(reply('VOICE-FOUR').seq), turnOf(user('UTT-FOUR').seq))
    assert.notEqual(turnOf(notice.seq), turnOf(user('UTT-FOUR').seq))
    // Native turns follow input identity, so they are not in speaking order; the record keeps the order in which
    // the replies were actually generated in its stream chunk times, not the time each turn recorded them.
    const spokenAt = text => { const first = reply(text).data.stream.find(item => item.type === 'text-chunks' || item.chunk?.type === 'text-delta'); return first.time0 ?? first.time }
    // Millisecond chunk times can tie; strict protocol response order is asserted above.
    assert.ok(spokenAt('VOICE-WHILE-TOOL') <= spokenAt('TOOL-CONTINUED'), 'reply 2 was generated no later than the tool continuation of turn 1')
    assert.ok(spokenAt('VOICE-FOUR') <= spokenAt('RESULT-HEARD'), 'the reply to utterance 4 was generated no later than the result reply')
    assert.ok(Math.abs(spokenAt('VOICE-WHILE-TOOL') - response('VOICE-WHILE-TOOL').at) < 1000)
    // The Host cancelled no work: docs finished its dispatched turn normally.
    const docs = result.workers.find(worker => worker.id === 'docs')
    assert.equal(docs.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    for (const event of events.filter(event => event.type === 'assistant/message')) assert.equal(event.data.message.source.model, MODEL)
    console.log('voice interleave evidence:', host.home)
  })
})

test('voice edge timing: a reply the endpoint completes after the user spoke keeps its tool call, and an utterance folded into the next one gets no reply of another', { timeout: 300000 }, async t => {
  const model = controlledModel({ utterances: {
    1: { transcript: 'UTT-ONE 请列出所有会话。', text: 'LIST-FIRST', paced: 12, call: { name: 'nexus_list_sessions', arguments: {} } },
    2: { transcript: 'UTT-TWO 等一下。', text: 'VOICE-TWO 好。', uncancelled: true },
    3: { transcript: 'UTT-THREE 那个，', text: 'NEVER-SAID', slow: 1500 },
    4: { transcript: 'UTT-FOUR 一加一等于几？', text: 'VOICE-FOUR 二。' },
  } })
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请列出所有会话。', voice: ZH }, { silence: 1.4 }, { text: '等一下。', voice: ZH }, { silence: 4 }, { text: '那个，', voice: ZH }, { silence: 1 }, { text: '一加一等于几？', voice: ZH }, { silence: 15 }])
  await controlledCall(t, 'edge', model, capture, async ({ host, page, bar }) => {
    await until(() => model.log.responses.some(response => response.text?.startsWith('VOICE-FOUR')), 'fourth reply', 90000)
    await until(async () => { const own = await supervisorOf(host); return own?.status === 'idle' && own.ends >= 4 }, 'four turns completed', 60000)
    await delay(2500)
    const scheduled = Number(await bar.getAttribute('data-played-samples'))
    assert.equal(await audible(page), 0)
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'call ended')

    const result = await host.finish()
    const events = result.events
    const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const user = text => events.find(event => event.type === 'user/message' && textOf(event.data).includes(text))
    const replyIn = turn => events.filter(event => event.type === 'assistant/message' && turnOf(event.seq) === turn)
    // Reply 1 was still being generated when utterance 2 started, and the endpoint completed it with its tool call.
    const first = model.log.responses.find(response => response.text === 'LIST-FIRST')
    assert.ok(first.atOnset < first.deltas, `reply 1 was being generated at the onset: ${first.atOnset} of ${first.deltas}`)
    const one = turnOf(user('UTT-ONE').seq)
    const [spoken, continued] = replyIn(one)
    assert.equal(spoken.data.interrupted, undefined)
    assert.match(textOf(spoken.data.message), /^LIST-FIRST part-1/)
    // The completed call is answered, not dropped: it ran in turn 1 and its output was continued there.
    const call = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_list_sessions')
    assert.ok(call && spoken.data.message.content.some(part => part.type === 'tool-call' && part.id === call.data.callId))
    const output = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    assert.equal(output.data.message.isError, false)
    assert.ok(model.wire.some(event => event.type === 'conversation.item.create' && event.item.type === 'function_call_output' && event.item.call_id === call.data.callId))
    assert.deepEqual([turnOf(call.seq), turnOf(output.seq)], [one, one])
    assert.match(textOf(continued.data.message), /^DOC-DISPATCHED/)
    // Its audio after the onset was not played, and the notice of what was heard precedes the reply to utterance 2.
    const total = model.log.responses.reduce((sum, response) => sum + response.deltas, 0)
    assert.equal(scheduled, 9600 * (total - (first.deltas - first.atOnset)))
    const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice')
    assert.equal(notices.length, 1)
    assert.equal(turnOf(notices[0].seq), turnOf(user('UTT-TWO').seq))
    assert.match(textOf(replyIn(turnOf(user('UTT-TWO').seq))[0].data.message), /^VOICE-TWO/)
    // Utterance 3 was folded into utterance 4 by the endpoint: it has no reply, and the reply to 4 is not recorded as its.
    assert.deepEqual(model.log.folded, [3])
    assert.ok(!model.log.responses.some(response => response.text === 'NEVER-SAID'))
    assert.equal(replyIn(turnOf(user('UTT-THREE').seq)).length, 0)
    assert.equal(textOf(replyIn(turnOf(user('UTT-FOUR').seq))[0].data.message), 'VOICE-FOUR 二。')
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    console.log('voice edge evidence:', host.home)
  })
})

/**
 * A recording relay between the Host and the real endpoint: it forwards both ways unchanged and keeps
 * the shape of what was exchanged (event types, ids, statuses, item texts, timestamps), never audio or
 * request headers, so a real run can show what reached the model and when.
 */
function relay(endpoint) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const wire = []
  const log = { connections: 0, responses: [], cancelled: [], late: [], absorbed: 0 }
  const record = (connection, direction, data) => {
    const event = JSON.parse(data.toString())
    if (event.type === 'input_audio_buffer.append') return
    const entry = { connection, direction, at: Date.now(), type: event.type }
    if (event.session) entry.session = { modalities: event.session.modalities, model: event.session.model }
    if (event.response_id) entry.response_id = event.response_id
    if (event.call_id) entry.call_id = event.call_id
    if (event.name) entry.name = event.name
    if (event.type === 'response.audio.delta') entry.bytes = Buffer.byteLength(event.delta, 'base64')
    if (event.item) entry.item = { type: event.item.type, role: event.item.role, call_id: event.item.call_id, text: event.item.content?.map(part => part.text ?? '').join('\n').slice(0, 4000) }
    if (event.item_id) entry.item_id = event.item_id
    if (event.transcript) entry.transcript = event.transcript
    if (event.response) entry.response = { id: event.response.id, status: event.response.status, reason: event.response.status_details?.reason, modalities: event.response.modalities }
    if (event.error) entry.error = event.error
    if (event.type === 'response.created') log.responses.push({ id: event.response.id, at: entry.at })
    if (event.type === 'response.done' && event.response.status === 'cancelled') log.cancelled.push(event.response.id)
    wire.push(entry)
  }
  server.on('connection', (socket, request) => {
    const connection = ++log.connections
    const url = new URL(endpoint)
    for (const [name, value] of new URL(request.url, 'http://relay').searchParams) url.searchParams.set(name, value)
    const upstream = new WebSocket(url, { headers: { Authorization: request.headers.authorization } })
    const pending = []
    upstream.on('open', () => { for (const data of pending.splice(0)) upstream.send(data) })
    upstream.on('message', data => { record(connection, 's2c', data); if (socket.readyState === 1) socket.send(data.toString()) })
    upstream.on('close', () => socket.close())
    upstream.on('error', () => socket.close())
    socket.on('message', data => { record(connection, 'c2s', data); if (upstream.readyState === 1) upstream.send(data.toString()); else pending.push(data.toString()) })
    socket.on('close', () => upstream.close())
  })
  return { server, wire, log, ready: new Promise(accept => server.once('listening', accept)) }
}

// Real model and real client code through the relay; the speech is offline SAPI audio fed through Chromium's fake
// capture device. The gap after the first request decides whether the user speaks while the long reply is still
// being generated (the endpoint cancels it) or after it was generated, while it plays (only playback stops).
for (const [scenario, gap, generating] of [['real-barge', 7, false], ['real-barge-generating', 2, true]]) {
  test(`accurate Realtime voice call: the user speaks over a long reply ${generating ? 'still being generated' : 'at the seven-second gap'}; playback stops, the model is told what was heard before it answers, and the question is answered`, { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 420000 }, async t => {
    const capture = await voiceFixture([{ silence: 5 }, { text: '请详细讲一讲长城的历史，多讲一些细节。', voice: ZH }, { silence: gap }, { text: '先停一下，一加一等于几？', voice: ZH }, { silence: 20 }, { text: '好的，谢谢你。', voice: ZH }, { silence: 25 }])
    const model = relay(process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime')
    await controlledCall(t, scenario, model, capture, async ({ host, page, bar }) => {
      const began = Date.now()
      // The interruption: the Host flushes the client, which must go silent at once.
      await until(async () => (await page.evaluate(() => window.__flushes)) >= 1, 'first flush', 90000)
      await until(async () => (await audible(page)) === 0, 'playback stopped at the interruption', 1500)
      const cutNodes = await page.evaluate(() => window.__nodes.filter(item => item.stoppedAt !== undefined && item.stoppedAt < item.when + item.duration).length)
      // Wait past the end of the capture until every utterance was handled.
      await delay(Math.max(0, began + 30000 + gap * 1000 - Date.now()))
      await until(async () => { const own = await supervisorOf(host); return own?.users >= 3 && own.status === 'idle' }, 'last utterance handled', 120000)
      await delay(8000)
      await until(async () => (await audible(page)) === 0, 'last reply played out', 30000)
      const client = { flushes: Number(await bar.getAttribute('data-flushes')), discarded: Number(await bar.getAttribute('data-discarded-samples')), scheduled: Number(await bar.getAttribute('data-played-samples')), cutNodes }
      assert.equal(await state(bar), 'live')
      await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      await until(async () => (await state(bar)) === 'idle', 'call ended')
      await page.screenshot({ path: resolve(host.home, 'output/voice-call.png') })

      const result = await host.finish()
      const events = result.events
      const turnOf = seq => events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
      const voiced = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice' && event.data.source.summary === 'interrupted playback')
      const replies = events.filter(event => event.type === 'assistant/message')
      // On the wire: the notice the Host sent, and the endpoint events around it.
      const noticeSent = model.wire.find(event => event.direction === 'c2s' && event.type === 'conversation.item.create' && event.item.text.includes('speaking over'))
      const onset = noticeSent && model.wire.findLast(event => event.direction === 's2c' && event.type === 'input_audio_buffer.speech_started' && event.at <= noticeSent.at)
      const between = noticeSent && onset ? model.wire.filter(event => event.direction === 's2c' && event.type === 'response.created' && event.at >= onset.at && event.at <= noticeSent.at) : []
      const summary = {
        transcripts: voiced.map(event => ({ turn: turnOf(event.seq), text: textOf(event.data) })),
        replies: replies.map(event => ({ turn: turnOf(event.seq), text: textOf(event.data.message), interrupted: event.data.interrupted ?? false, model: event.data.message.source.model })),
        notices: notices.map(event => ({ turn: turnOf(event.seq), text: textOf(event.data) })),
        client,
        wire: { cancelled: model.log.cancelled, noticeSentAfterOnsetMs: noticeSent && onset ? noticeSent.at - onset.at : undefined, responsesStartedBeforeNotice: between.length, nextResponseAfterNoticeMs: noticeSent ? model.wire.find(event => event.direction === 's2c' && event.type === 'response.created' && event.at > noticeSent.at)?.at - noticeSent.at : undefined },
        turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
      }
      await writeFile(resolve(host.home, 'output/summary.json'), JSON.stringify(summary, null, 2))
      console.log('real voice barge-in summary:', JSON.stringify(summary))
      // The model heard all three requests.
      assert.match(textOf(voiced[0].data), /长城/)
      const question = voiced.find(event => /一加一|1\s*\+\s*1|几/.test(textOf(event.data)))
      assert.ok(question, 'the interrupting question was transcribed')
      assert.match(textOf(voiced.at(-1).data), /谢谢/)
      // The long reply was stopped: the client discarded queued audio.
      const long = replies.find(event => turnOf(event.seq) === turnOf(voiced[0].seq))
      assert.ok(long, 'the long reply is on record')
      assert.ok(client.flushes >= 1 && client.discarded > 0 && client.cutNodes > 0)
      if (generating) {
        // The endpoint cancelled the reply it was generating; the record keeps the delivered prefix, marked interrupted.
        assert.ok(model.log.cancelled.length >= 1, 'the endpoint cancelled the reply being generated')
        assert.equal(long.data.interrupted, true)
      }
      // The model was told what was heard before it answered the interruption: the notice went out after the onset
      // and before any response started, and the record keeps it with the interrupting speech.
      assert.ok(noticeSent && onset, 'the notice was sent during the interrupting speech')
      assert.equal(between.length, 0, 'no response started between the onset and the notice')
      const [notice] = notices
      assert.ok(notice && notice.seq > long.seq, 'the notice is recorded after the long reply')
      const [, heard, total] = textOf(notice.data).match(CUT).map(Number)
      assert.ok(heard < total, `heard ${heard} of ${total}`)
      // The interrupting question got its own answer, and the conversation went on normally afterwards.
      const answer = replies.find(event => turnOf(event.seq) === turnOf(question.seq))
      assert.ok(answer && textOf(answer.data.message), 'the new question was answered')
      assert.ok(notice.seq < answer.seq, 'the notice precedes the answer')
      const last = replies.find(event => turnOf(event.seq) === turnOf(voiced.at(-1).seq))
      assert.ok(last && !last.data.interrupted, 'the last reply was not interrupted')
      assert.ok(!notices.some(event => turnOf(event.seq) === turnOf(voiced.at(-1).seq)), 'nothing was cut before the last utterance')
      for (const reply of summary.replies) assert.equal(reply.model, MODEL)
      assert.ok(summary.turnEnds.every(kind => kind === 'completed'))
      console.log('real voice barge-in evidence:', host.home)
    }, { key: process.env.NEXUS_VOICE_KEY })
  })
}


for (const [scenario, plan] of [['generating', { text: 'DISPATCH-LONG', paced: 60 }], ['playing', { text: 'DISPATCH-LONG', burst: 40 }]]) {
  test('hangup text continuation: ' + scenario + ' stops media, preserves heard facts, dispatch and results, and reconnects only by hand', { timeout: 240000 }, async t => {
    const model = controlledModel({ utterances: { 1: UTTERANCES[1] }, dispatchReply: plan })
    const capture = await voiceFixture([{ silence: 1.5 }, { text: '请让文档会话开始编写接口文档。', voice: ZH }, { silence: 60 }])
    await controlledCall(t, 'hangup-' + scenario, model, capture, async ({ host, page, bar }) => {
      await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'worker running')
      await until(async () => Number(await bar.getAttribute('data-played-samples')) >= 24000, 'long reply playing')
      assert.ok(await audible(page) > 0)
      await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      await until(async () => (await state(bar)) === 'idle', 'hung up')
      await until(async () => (await trackStates(page)).every(value => value === 'ended'), 'capture ended')
      assert.equal(await audible(page), 0, 'all queued and playing nodes stopped')
      await until(() => model.log.closed >= 1, 'voice endpoint closed')
      const bytes = model.log.appendedBytes
      const nodes = await page.evaluate(() => window.__nodes.length)
      await delay(700)
      assert.equal(model.log.appendedBytes, bytes)
      assert.equal(await page.evaluate(() => window.__nodes.length), nodes, 'late old audio schedules no nodes')
      if (scenario === 'generating') assert.ok(model.wire.some(event => event.type === 'response.cancel'), 'active voice generation cancelled')
      await host.release()
      await until(() => model.log.responses.some(response => response.text?.startsWith('RESULT-HEARD')), 'result handled in text')
      const textarea = page.getByRole('textbox').last()
      await textarea.fill('AFTER-HANGUP-TOOL 请查一下资料。')
      await textarea.press('Enter')
      await until(async () => { try { await readFile(resolve(host.home, 'tool-started')); return true } catch { return false } }, 'text tool executing')
      await writeFile(resolve(host.home, 'tool-release'), '')
      await until(() => model.log.responses.some(response => response.text?.startsWith('TOOL-CONTINUED')), 'text tool continued')
      await until(async () => (await supervisorOf(host))?.status === 'idle', 'text idle')
      const textConnections = model.wire.filter(event => event.type === 'session.update' && !event.session.modalities.includes('audio')).map(event => event.connection)
      assert.ok(textConnections.length > 0)
      for (const connection of textConnections) {
        assert.deepEqual(model.wire.find(event => event.type === 'session.update' && event.connection === connection).session.modalities, ['text'])
        for (const event of model.wire.filter(event => event.connection === connection && event.type === 'response.created')) assert.deepEqual(event.response.modalities, ['text'])
        assert.ok(!model.wire.some(event => event.connection === connection && event.type.startsWith('response.audio.')))
      }
      // Page lifecycle after hangup does not request media or connect another voice session.
      const connections = model.log.connections
      await page.getByRole('button', { name: /新建会话|New session/, exact: true }).last().click()
      await until(async () => !(await bar.isVisible()), 'switched conversation')
      await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
      await until(async () => (await state(bar)) === 'idle', 'returned to voice off')
      assert.ok((await trackStates(page)).every(value => value === 'ended'))
      assert.equal(model.log.connections, connections)
      await page.reload()
      await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
      await until(async () => (await state(bar)) === 'idle', 'remounted idle')
      await delay(500)
      assert.equal((await trackStates(page)).length, 0)
      assert.equal(model.log.connections, connections)
      await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
      await until(async () => (await state(bar)) === 'live', 'manually reconnected')
      const last = model.log.connections
      const replay = model.wire.filter(event => event.connection === last && event.type === 'conversation.item.create').map(event => JSON.stringify(event.item)).join('\n')
      assert.match(replay, /UTT-ONE/)
      assert.match(replay, /DOC-READY-42/)
      assert.match(replay, /TOOL-RESULT-77/)
      assert.match(replay, /rest was not heard/)
      await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      const result = await host.finish()
      const events = result.events
      assert.ok(events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice' && /rest was not heard/.test(textOf(event.data))))
      assert.ok(events.some(event => event.type === 'tool/call' && event.data.name === 'fixture_slow_lookup'))
      assert.equal(result.workers.find(worker => worker.id === 'docs').events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
      for (const event of events.filter(event => event.type === 'assistant/message')) assert.equal(event.data.message.source.model, MODEL)
      assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
      console.log('hangup text evidence:', host.home)
    })
  })
}


const textOnlyConnection = (model, connection) => model.wire.some(event => event.connection === connection && event.type === 'session.update' && JSON.stringify(event.session.modalities) === '["text"]')

test('accurate Realtime hangup: text-dispatched work continues through a voice call, text-only results and tools in the same conversation, then manual reconnect replays its facts', { skip: process.env.NEXUS_REAL_VOICE !== '1', timeout: 420000 }, async t => {
  const capture = await voiceFixture([{ silence: 5 }, { text: '另外，一加一等于几？', voice: ZH }, { silence: 90 }])
  const model = relay(process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime')
  await controlledCall(t, 'real-hangup', model, capture, async ({ host, page, bar }) => {
    assert.equal((await host.status()).agents.find(agent => agent.id === 'docs').status, 'running')
    await until(async () => Number(await bar.getAttribute('data-played-samples')) > 0, 'real spoken exchange during work', 60000)
    const voiceConnection = model.log.connections
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'real hung up')
    await until(async () => (await trackStates(page)).every(state => state === 'ended'), 'real fake capture released')
    assert.equal(await audible(page), 0)
    await host.release()
    await until(() => model.wire.some(event => event.direction === 'c2s' && event.type === 'conversation.item.create' && event.item.text?.includes('DOC-READY-42') && textOnlyConnection(model, event.connection)), 'work result reached text-only model', 120000)
    await until(async () => (await supervisorOf(host))?.status === 'idle' && (await host.status())?.agents?.find(agent => agent.id === 'docs')?.ends >= 1, 'work result processed in text', 120000)
    assert.ok(model.wire.some(event => event.connection > voiceConnection && textOnlyConnection(model, event.connection) && event.direction === 's2c' && event.type === 'response.function_call_arguments.done' && event.name === 'nexus_read_session'), 'work result triggered an actual text-only read after hangup')
    const editor = page.getByRole('textbox').last()
    await editor.fill('请现在调用 nexus_read_session 读取 docs 的会话记录，告诉我刚刚的最终结果标记。')
    await editor.press('Enter')
    await until(async () => (await supervisorOf(host))?.status === 'running', 'text request running', 15000)
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'text tool chain settled', 120000)
    const textConnections = [...new Set(model.wire.filter(event => event.connection > voiceConnection && event.type === 'session.update' && JSON.stringify(event.session.modalities) === '["text"]').map(event => event.connection))]
    assert.ok(textConnections.length > 0)
    for (const connection of textConnections) {
      const incoming = model.wire.filter(event => event.connection === connection && event.direction === 's2c')
      const responses = incoming.filter(event => event.type === 'response.created')
      assert.ok(responses.length)
      for (const response of responses) assert.deepEqual(response.response.modalities, ['text'])
      assert.ok(!incoming.some(event => event.type.startsWith('response.audio.')), 'text response generated no output audio')
    }
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
    await until(async () => (await state(bar)) === 'live', 'real manual reconnect', 30000)
    const connection = model.log.connections
    const replay = model.wire.filter(event => event.connection === connection && event.direction === 'c2s' && event.type === 'conversation.item.create').map(event => event.item.text).join('\n')
    assert.match(replay, /接口文档/)
    assert.match(replay, /DOC-READY-42/)
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await state(bar)) === 'idle', 'manual call ended')
    const client = { state: await state(bar), tracks: await trackStates(page), audible: await audible(page) }
    const result = await host.finish()
    const events = result.events
    const readIds = model.wire.filter(event => textConnections.includes(event.connection) && event.direction === 's2c' && event.type === 'response.function_call_arguments.done' && event.name === 'nexus_read_session').map(event => event.call_id)
    const read = events.filter(event => event.type === 'tool/call' && event.data.name === 'nexus_read_session' && readIds.includes(event.data.callId))
    assert.ok(read.length && read.some(event => events.some(output => output.type === 'tool/result' && output.data.message.toolCallId === event.data.callId && !output.data.message.isError)), 'real text-only read tool executed successfully')
    assert.ok(read.every(event => model.wire.some(output => textConnections.includes(output.connection) && output.direction === 'c2s' && output.type === 'conversation.item.create' && output.item.call_id === event.data.callId)), 'each post-hangup text tool result returned on its original call id')
    const work = events.find(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && event.data.source.sessionId === 'docs')
    assert.match(textOf(work.data), /DOC-READY-42/)
    const replies = events.filter(event => event.type === 'assistant/message')
    assert.ok(replies.some(event => event.seq > work.seq && /DOC-READY-42/.test(textOf(event.data.message))))
    for (const event of replies) assert.equal(event.data.message.source.model, MODEL)
    assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    const summary = { model: MODEL, textConnections, tools: read.map(event => ({ name: event.data.name, arguments: event.data.arguments })), replies: replies.map(event => textOf(event.data.message)), turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), client }
    await writeFile(resolve(host.home, 'output/summary.json'), JSON.stringify(summary, null, 2))
    console.log('real hangup evidence:', host.home, JSON.stringify(summary))
  }, { key: process.env.NEXUS_VOICE_KEY, beforeStart: async ({ host, page }) => {
    const editor = page.getByRole('textbox').last()
    await editor.fill('请调用 nexus_send_session，把编写接口文档的任务交给现有 docs 会话。它完成后，先读取它的会话记录，再向我说明最终结果。')
    await editor.press('Enter')
    await until(async () => (await host.status())?.agents?.find(agent => agent.id === 'docs')?.status === 'running', 'real text dispatch admitted', 120000)
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'dispatch text turn completed', 60000)
  } })
})


test('hangup during a native tool keeps it running, and a rapid manual reconnect receives its one result without executing it again', { timeout: 180000 }, async t => {
  const model = controlledModel({ utterances: { 1: { transcript: 'UTT-ONE 请查一下API资料。', call: { name: 'fixture_slow_lookup', arguments: { query: 'API' } } } } })
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请查一下API资料。', voice: ZH }, { silence: 30 }])
  await controlledCall(t, 'hangup-tool', model, capture, async ({ host, page, bar }) => {
    await until(async () => { try { await readFile(resolve(host.home, 'tool-started')); return true } catch { return false } }, 'native tool pending')
    await page.evaluate(async () => { document.querySelector('[data-nexus-voice] [aria-label="挂断"]').click(); await new Promise(accept => setTimeout(accept, 0)); document.querySelector('[data-nexus-voice] button').click() })
    await until(async () => (await state(bar)) === 'live' && model.log.connections === 2, 'rapid manually reconnected')
    await writeFile(resolve(host.home, 'tool-release'), '')
    await until(() => model.log.responses.some(response => response.connection === 2 && response.text?.startsWith('TOOL-CONTINUED')), 'same tool result on new call')
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'tool turn completed')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    const result = await host.finish()
    const calls = result.events.filter(event => event.type === 'tool/call' && event.data.name === 'fixture_slow_lookup')
    assert.equal(calls.length, 1, 'reconnect did not rerun the native tool')
    const output = result.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === calls[0].data.callId)
    assert.equal(output.length, 1)
    assert.equal(output[0].data.message.isError, false)
    assert.ok(result.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    assert.ok((await trackStates(page)).every(state => state === 'ended'))
    console.log('hangup native tool evidence:', host.home)
  })
})

test('hangup idle playback then immediately reconnect preserves its notice before another native turn records it', { timeout: 180000 }, async t => {
  const model = controlledModel({ utterances: { 1: { transcript: 'UTT-ONE 请介绍接口文档。', text: 'LONG-IDLE-REPLY', burst: 40 } } })
  const capture = await voiceFixture([{ silence: 1.5 }, { text: '请介绍接口文档。', voice: ZH }, { silence: 30 }])
  await controlledCall(t, 'hangup-idle-notice', model, capture, async ({ host, page, bar }) => {
    await until(async () => Number(await bar.getAttribute('data-played-samples')) >= 384000 && (await supervisorOf(host))?.status === 'idle', 'generated idle reply still playing')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
    await until(async () => (await state(bar)) === 'live' && model.log.connections === 2, 'immediate manual reconnect', 15000)
    const replay = model.wire.filter(event => event.connection === 2 && event.type === 'conversation.item.create').map(event => JSON.stringify(event.item)).join('\n')
    assert.match(replay, /ended the call during/)
    assert.match(replay, /rest was not heard/)
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    const editor = page.getByRole('textbox').last()
    await editor.fill('TEXT-AFTER-CALL 请继续文字。')
    await editor.press('Enter')
    await until(() => model.log.responses.some(response => response.text === 'TEXT-REPLY'), 'notice recorded with next text turn')
    await until(async () => (await supervisorOf(host))?.status === 'idle', 'text complete')
    const result = await host.finish()
    assert.equal(result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice').length, 1, 'repeated hangup kept one notice')
    console.log('hangup pending notice evidence:', host.home)
  })
})

for (const scenario of ['flush-pending', 'several-flushes-pending', 'played-in-transit', 'played-consumed']) {
  test('hangup playback accounting: ' + scenario + ' preserves each unplayed tail exactly once', { timeout: 180000 }, async t => {
    const model = controlledModel()
    const capture = await voiceFixture([{ silence: 60 }])
    const down = [], up = []
    let blockedDown = false, blockedUp = false
    const pending = scenario.includes('pending')
    const emit = event => {
      model.wire.push({ direction: 's2c', connection: 1, at: Date.now(), ...event, ...(event.type === 'response.audio.delta' ? { delta: '[audio]' } : {}) })
      for (const socket of model.server.clients) if (socket.readyState === 1) socket.send(JSON.stringify(event))
    }
    const reply = index => {
      const id = `batch-${index}`
      emit({ type: 'input_audio_buffer.speech_stopped' })
      emit({ type: 'input_audio_buffer.committed', item_id: id })
      emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: `INPUT-${index}` })
      emit({ type: 'response.created', response: { id, status: 'in_progress', modalities: ['text', 'audio'] } })
      emit({ type: 'response.audio_transcript.delta', response_id: id, delta: `BATCH-${index}` })
      emit({ type: 'response.audio.delta', response_id: id, delta: tone(1) })
      emit({ type: 'response.done', response: { id, status: 'completed', output: [] } })
    }
    const release = queue => { for (const [socket, data] of queue.splice(0)) socket.send(data) }
    await controlledCall(t, 'hangup-' + scenario, model, capture, async ({ host, page, bar }) => {
      reply(1)
      await until(() => audible(page).then(count => count > 0), 'first batch playing')
      // Preserve real pending playback while native turn-stopping listeners finish; a one-second
      // node can otherwise end before the supervisor becomes idle. Then fix the accounting clock.
      const playback = await page.evaluate(async () => {
        const first = window.__nodes[0], context = first.node.context
        first.ended = false; first.node.addEventListener('ended', () => { first.ended = true })
        await context.suspend()
        const pending = { state: context.state, time: context.currentTime, end: first.when + first.duration }
        Object.defineProperty(context, 'currentTime', { get: () => first.when + 0.2, configurable: true })
        return pending
      })
      assert.equal(playback.state, 'suspended'); assert.ok(playback.time < playback.end, 'native PCM is paused before its end')
      await until(async () => { const agent = await supervisorOf(host); return agent?.status === 'idle' && agent.ends >= 1 }, 'first batch completed with pending playback')
      assert.equal(await page.evaluate(() => window.__nodes[0].ended), false, 'the native node did not naturally finish while waiting for idle')
      emit({ type: 'input_audio_buffer.speech_started' })
      if (pending) await until(() => down.length > 0, 'flush held before client consumption')
      else await until(async () => Number(await bar.getAttribute('data-flushes')) === 1, 'client consumed flush')
      if (scenario === 'played-in-transit') await until(() => up.length > 0, 'played report held in transport')
      if (scenario === 'played-consumed') await until(() => model.wire.some(event => event.type === 'conversation.item.create' && JSON.stringify(event.item).includes('rest was not heard')), 'played report accounted by Host')
      if (scenario === 'several-flushes-pending') {
        reply(2)
        emit({ type: 'input_audio_buffer.speech_started' })
        reply(3)
        await until(() => down.filter(([, data]) => String(data).includes('"type":"flush"')).length === 2, 'two pending flush batches')
      } else if (!pending) {
        reply(2)
        await until(async () => (await supervisorOf(host))?.status === 'idle' && (await page.evaluate(() => window.__nodes.length)) === 2, 'second batch reached client')
        await page.evaluate(() => { const last = window.__nodes.at(-1); Object.defineProperty(last.node.context, 'currentTime', { get: () => last.when + 0.3, configurable: true }) })
      }
      await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      assert.equal(await audible(page), 0)
      if (scenario === 'played-in-transit') {
        await until(() => up.some(([, data]) => String(data).includes('"type":"hangup"')), 'hangup queued behind played')
        blockedUp = false
        release(up) // Preserve real WebSocket FIFO: played reaches the Host before hangup.
      }
      await until(() => model.log.closed === 1, 'old model closed')
      blockedDown = false
      release(down)
      const editor = page.getByRole('textbox').last()
      await editor.fill('TEXT-AFTER-CALL 请继续。')
      await editor.press('Enter')
      await until(() => model.log.responses.some(response => response.text === 'TEXT-REPLY'), 'text continuation recorded notices')
      await until(async () => (await supervisorOf(host))?.status === 'idle', 'text continuation idle')
      await bar.getByRole('button', { name: /接通语音|Start voice|重试|Retry/ }).click()
      await until(async () => (await state(bar)) === 'live', 'manual reconnect')
      await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
      const result = await host.finish()
      const notices = result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice').map(event => textOf(event.data))
      const expected = scenario === 'several-flushes-pending' ? [0.2, 0, 0] : pending ? [0.2] : [0.2, 0.3]
      assert.equal(notices.length, expected.length, 'each batch is accounted once, including repeated hangup')
      for (let index = 0; index < expected.length; index++) {
        assert.match(notices[index], new RegExp(`BATCH-${index + 1}.*about ${expected[index].toFixed(1)} s of its 1.0 s`))
        assert.equal(model.wire.filter(event => event.connection === 3 && event.type === 'conversation.item.create' && JSON.stringify(event.item).includes(`BATCH-${index + 1}`) && JSON.stringify(event.item).includes('rest was not heard')).length, 1, 'manual replay retains one notice per batch')
      }
      console.log('hangup pending batch evidence:', host.home, JSON.stringify({ scenario, notices }))
    }, { preparePage: scenario === 'played-consumed' ? undefined : page => page.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer()
      server.onMessage(data => {
        if (pending && String(data).includes('"type":"flush"')) blockedDown = true
        if (blockedDown) down.push([socket, data]); else socket.send(data)
      })
      socket.onMessage(data => {
        if (scenario === 'played-in-transit' && String(data).includes('"type":"played"')) blockedUp = true
        if (blockedUp) up.push([server, data]); else server.send(data)
      })
    }) })
  })
}
