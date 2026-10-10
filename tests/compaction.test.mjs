import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, symlink, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { chromium } from 'playwright'
import { startHost } from './host-process.mjs'

const root = resolve('.')
const delay = ms => new Promise(accept => setTimeout(accept, ms))
const USAGE = { total_tokens: 1239, input_tokens: 1234, output_tokens: 5, input_token_details: { cached_tokens: 1000, text_tokens: 1234, audio_tokens: 0 }, output_token_details: { text_tokens: 5, audio_tokens: 0 } }
const CHECKPOINT = '[Context source: {"kind":"compact-checkpoint"'

/** One server conversation item as text. */
const itemText = item => item.type === 'function_call_output' ? `[output ${item.call_id}] ${item.output}` : `${item.role}: ${item.content?.[0]?.text ?? ''}`
/** One second of 24 kHz PCM16 silence, as model audio. */
const SECOND = Buffer.alloc(48000).toString('base64')

/**
 * A controlled Realtime endpoint that records every request's replayed items and
 * every connection's items. It dispatches a follow-up to the worker once a work
 * result follows a compaction checkpoint, and reports fixed usage on every
 * response.done. On a voice connection each reply also speaks one second. The
 * first audio input of a connection is reported as speech that is never
 * committed, or with speech: 'commit' as a transcribed utterance the server
 * answers silently. opening maps a connection index to 'delay' (its session
 * acknowledgement arrives 1.5 s late) or 'reject' (it closes on configuration).
 */
async function endpoint({ opening = {}, speech } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  const requests = []
  const requestConnections = []
  const connections = []
  const closed = []
  let dispatched = false
  server.on('connection', socket => {
    const index = connections.length
    const items = []
    connections.push(items)
    socket.on('close', () => { closed[index] = true })
    let voice = false
    let spoke = false
    const send = event => socket.send(JSON.stringify(event))
    send({ type: 'session.created' })
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'session.update') {
        voice = event.session.modalities.includes('audio')
        if (opening[index] === 'reject') return socket.close()
        const updated = () => send({ type: 'session.updated', session: event.session })
        if (opening[index] === 'delay') setTimeout(updated, 1500)
        else updated()
      }
      if (event.type === 'conversation.item.create') items.push(event.item)
      if (event.type === 'input_audio_buffer.append' && !spoke) {
        spoke = true
        send({ type: 'input_audio_buffer.speech_started', item_id: `speech-${index}` })
        send({ type: 'input_audio_buffer.speech_stopped', item_id: `speech-${index}` })
        if (speech === 'commit') {
          const item = `speech-${index}`
          send({ type: 'input_audio_buffer.committed', item_id: item })
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: 'SPOKEN-DURING-REBUILD' })
          const id = `resp-${crypto.randomUUID()}`
          send({ type: 'response.created', response: { id } })
          send({ type: 'response.done', response: { id, status: 'completed', usage: USAGE } })
        }
      }
      if (event.type !== 'response.create') return
      const texts = items.map(itemText)
      requests.push(texts)
      requestConnections.push(index)
      const id = `resp-${crypto.randomUUID()}`
      send({ type: 'response.created', response: { id } })
      const last = texts.at(-1) ?? ''
      if (!dispatched && /Automatic work-session result/.test(last) && /AFTER-COMPACTION-WORK/.test(last) && texts.some(item => item.includes(CHECKPOINT))) {
        dispatched = true
        const call = { call_id: `call-${id}`, name: 'nexus_send_session', arguments: JSON.stringify({ sessionId: 'compaction-worker', text: 'FOLLOW-UP-AFTER-COMPACTION' }) }
        send({ type: 'response.function_call_arguments.done', response_id: id, ...call })
        return send({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'function_call', ...call }], usage: USAGE } })
      }
      send({ type: 'response.text.delta', response_id: id, delta: last.startsWith('[output') ? 'Dispatched the follow-up.' : `ack c${index}` })
      if (voice) send({ type: 'response.audio.delta', response_id: id, delta: SECOND })
      send({ type: 'response.done', response: { id, status: 'completed', usage: USAGE } })
    })
  })
  return { server, requests, requestConnections, connections, closed, url: `ws://127.0.0.1:${server.address().port}` }
}

/** Run one scenario in an isolated official Host and return the probe report with the endpoint's requests. */
async function scenario(name, { steps, nexus = '', defaultModel, model: endpointOptions } = {}) {
  const home = resolve('.scratch/nexus-v1', `compaction-${name}-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-compaction')
  const fixture = resolve(home, 'probe')
  for (const dir of [fixture, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const model = await endpoint(endpointOptions)
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-compaction-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/compaction-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-compaction-probe\n      name: nexus-compaction-probe\n      config:\n        dir: ${JSON.stringify(home)}\n        steps: ${JSON.stringify(steps)}\n${defaultModel ? `        defaultModel: ${JSON.stringify(defaultModel)}\n` : ''}`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-compaction-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-compaction-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_COMPACTION_KEY\n    endpoint: ${model.url}\n    timeoutMs: 5000\n${nexus}`)
  let output = ''
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-compaction', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_COMPACTION_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' } }, async child => {
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    return {}
  })
  try {
    let report
    for (let i = 0; i < 1200 && !report; i++) {
      try { report = JSON.parse(await readFile(resolve(home, 'report.json'), 'utf8')) } catch { await delay(100) }
    }
    assert.ok(report, 'no probe report: ' + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-3000))
    assert.equal(report.error, undefined, report.stack)
    const connections = model.connections.map(items => items.map(itemText))
    const { requests, requestConnections, closed } = model
    await writeFile(resolve(home, 'requests.json'), JSON.stringify({ requests, requestConnections, connections, closed }))
    console.log(`compaction ${name} evidence:`, home)
    return { ...report, requests, requestConnections, connections, closed }
  } finally {
    await host.close()
    for (const socket of model.server.clients) socket.terminate()
    await new Promise(accept => model.server.close(accept))
  }
}

const of = (events, type) => events.filter(event => event.type === type)
const sourceOf = event => event.type === 'user/message' ? event.data.source.kind : undefined
const userText = event => event.data.content.map(part => part.text).join('')

test('the main conversation compacts natively between turns once it exceeds the Nexus budget', { timeout: 180000 }, async () => {
  const report = await scenario('auto', {
    nexus: '    compactionBudget: 12000\n    summaryModel: nexus-test-summary/configured-sum\n',
    steps: [{ prompt: 'Remember the codename KESTREL-9.' }, { summarizationOverride: true }, { long: 7 }, { worker: 'AFTER-COMPACTION-WORK' }],
  })
  const { events, requests } = report
  const starts = of(events, 'compaction/start')
  assert.ok(starts.length >= 1, 'an over-budget conversation compacts automatically')
  const [start] = starts
  const summary = events.find(event => event.type === 'compaction/summary' && event.data.compactionId === start.data.compactionId)
  const end = events.find(event => event.type === 'compaction/end' && event.data.compactionId === start.data.compactionId)
  const checkpoint = events.find(event => sourceOf(event) === 'compact-checkpoint' && event.data.source.compactionId === start.data.compactionId)
  assert.equal(end.data.error, undefined)
  assert.ok(start.seq < summary.seq && summary.seq < checkpoint.seq && checkpoint.seq < end.seq)
  // Between turns: the bracket follows the turn's last step and closes before the turn does.
  const turn = start.data.turn
  assert.equal(typeof turn, 'number')
  const turnEnd = events.find(event => event.type === 'turn/end' && event.data.turn === turn)
  assert.equal(turnEnd.data.reason.kind, 'completed')
  assert.ok(end.seq < turnEnd.seq)
  assert.ok(events.filter(event => event.seq > events.find(item => item.type === 'turn/start' && item.data.turn === turn).seq && event.seq < start.seq).at(-1).type === 'step/end', 'no step is open while compacting')
  // The configured summary model wrote it, also over summarization fields of the native engine's own config, and the summarizer saw the conversation.
  assert.equal(report.overridden, 'broken')
  assert.deepEqual([summary.data.provider, summary.data.model], ['nexus-test-summary', 'configured-sum'])
  assert.ok(report.summaries.every(call => call.model === 'configured-sum'))
  assert.equal(report.summaries[0].purpose, 'compaction')
  assert.equal(report.summaries[0].sessionId, 'nexus-supervisor')
  assert.match(report.summaries[0].input, /KESTREL-9/)
  // The original records remain in the log.
  assert.ok(events.some(event => sourceOf(event) === 'user' && userText(event).startsWith('LONG-1 ')))
  assert.ok(summary.data.shadowedSeqs.some(seq => sourceOf(events[seq]) === 'user' && userText(events[seq]).startsWith('LONG-1 ')))
  // The next request replays the summary and recent originals, not the shadowed span.
  const after = requests.find(items => items.some(item => item.includes(CHECKPOINT)))
  assert.ok(after, 'a request after compaction replays the checkpoint')
  assert.ok(after.some(item => item.includes('SUMMARY-1')))
  assert.ok(!after.some(item => item.startsWith('user: LONG-1 ')), 'the shadowed prompt is not replayed')
  const retained = events.filter(event => sourceOf(event) === 'user' && userText(event).startsWith('LONG-') && event.seq < start.seq && !summary.data.shadowedSeqs.includes(event.seq))
  assert.ok(retained.length >= 1, 'recent originals are retained')
  for (const event of retained) assert.ok(after.indexOf(`user: ${userText(event)}`) > after.findIndex(item => item.includes(CHECKPOINT)), 'the summary stands before the retained originals')
  assert.ok(after.some(item => item.includes('Current runtime context')), 'the runtime context is still replayed')
  // After compaction the supervisor still takes in a work result and dispatches.
  const dispatch = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_send_session')
  assert.ok(dispatch && dispatch.seq > end.seq)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === dispatch.data.callId)
  assert.equal(result.data.message.isError, false)
  assert.ok(report.worker.some(event => event.type === 'user/message' && userText(event) === 'FOLLOW-UP-AFTER-COMPACTION'))
  // Every supervisor reply records the model's reported usage.
  const replies = of(events, 'assistant/message')
  assert.ok(replies.length >= 8)
  for (const reply of replies) {
    // The endpoint's input_tokens include its cached tokens; native counts are disjoint.
    assert.deepEqual(reply.data.usage, { inputTokens: 234, outputTokens: 5, totalTokens: 1239, cacheReadTokens: 1000 })
    assert.ok(reply.data.stream.some(record => record.chunk?.type === 'usage'))
  }
  assert.equal(report.contextPressure.pressureTokens, 1234)
  assert.equal(report.contextPressure.contextWindow, 12000)
  assert.equal(report.tokenUsage.totals.outputTokens, 5 * replies.length)
})

test('/compact is listed before the first turn and compacts with the default model between turns', { timeout: 180000 }, async () => {
  const report = await scenario('manual', {
    defaultModel: { provider: 'nexus-test-summary', model: 'default-sum' },
    steps: [
      { command: '/compact' },
      { prompt: 'Remember the codename KESTREL-9.' }, { summarizationOverride: true }, { prompt: 'Second request.' }, { prompt: 'Third request.' },
      { command: '/compact' }, { command: '/compact now' },
      { prompt: 'After manual compaction.' },
    ],
  })
  const { events, requests, commands } = report
  assert.ok(report.commandsAtStart.includes('compact'), 'listed before the native preset binds')
  assert.deepEqual(commands[0].result, { kind: 'success', text: 'No compactable history yet.' })
  assert.equal(of(events, 'compaction/start').length, 1)
  const [start] = of(events, 'compaction/start')
  const summary = of(events, 'compaction/summary')[0]
  const end = of(events, 'compaction/end')[0]
  const checkpoint = events.find(event => sourceOf(event) === 'compact-checkpoint')
  // A standalone transaction between turns, attributed to the command that started it.
  assert.equal(start.data.turn, null)
  assert.equal(end.data.error, undefined)
  assert.equal(start.data.sourceCommandId, commands[1].commandId)
  assert.equal(checkpoint.data.source.sourceCommandId, commands[1].commandId)
  const turnBoundaries = events.filter(event => event.type === 'turn/start' || event.type === 'turn/end')
  assert.equal(turnBoundaries.filter(event => event.seq < start.seq).at(-1).type, 'turn/end')
  assert.ok(turnBoundaries.filter(event => event.seq > start.seq && event.seq < end.seq).length === 0)
  // The default model of ordinary sessions wrote it, also over summarization fields of the native engine's own config.
  assert.equal(report.overridden, 'broken')
  assert.deepEqual([summary.data.provider, summary.data.model], ['nexus-test-summary', 'default-sum'])
  assert.match(commands[1].result.text, /^Compacted \d+ history items \(~\d+ tokens\)\.$/)
  assert.equal(commands[1].result.kind, 'success')
  assert.equal(commands[1].result.sourceEventSeq, summary.seq)
  assert.deepEqual(commands[2].result, { kind: 'error', text: 'Usage: /compact (no arguments)' })
  // The next turn replays the summary instead of the shadowed span; the original stays in the log.
  const after = requests.at(-1)
  assert.ok(after.some(item => item.includes(CHECKPOINT) && item.includes('SUMMARY-1')))
  assert.ok(!after.includes('user: Remember the codename KESTREL-9.'))
  assert.ok(events.some(event => sourceOf(event) === 'user' && userText(event) === 'Remember the codename KESTREL-9.'))
  assert.ok(after.includes('user: After manual compaction.'))
  assert.ok(of(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
})

test('a failed summary records the attempt and keeps the whole conversation', { timeout: 180000 }, async () => {
  const report = await scenario('failure', {
    nexus: '    compactionBudget: 12000\n    summaryModel: nexus-test-summary/broken\n',
    steps: [{ prompt: 'Remember the codename KESTREL-9.' }, { long: 7 }, { command: '/compact' }, { prompt: 'After failed compaction.' }],
  })
  const { events, requests, commands } = report
  const starts = of(events, 'compaction/start')
  const ends = of(events, 'compaction/end')
  assert.ok(starts.some(event => typeof event.data.turn === 'number'), 'automatic compaction was attempted')
  assert.ok(starts.some(event => event.data.turn === null), 'manual compaction was attempted')
  assert.equal(ends.length, starts.length)
  for (const end of ends) assert.match(end.data.error, /\S/)
  // No summary, no checkpoint: nothing is invented and nothing is shadowed.
  assert.equal(of(events, 'compaction/summary').length, 0)
  assert.ok(!events.some(event => sourceOf(event) === 'compact-checkpoint'))
  assert.ok(report.summaries.length >= starts.length && report.summaries.every(call => call.model === 'broken'))
  assert.deepEqual(commands[0].result, { kind: 'error', text: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.' })
  assert.ok(of(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
  // The next request still replays the whole conversation.
  const after = requests.at(-1)
  assert.ok(after.includes('user: Remember the codename KESTREL-9.'))
  for (let i = 1; i <= 7; i++) assert.ok(after.some(item => item.startsWith(`user: LONG-${i} `)))
  assert.ok(!after.some(item => item.includes(CHECKPOINT)))
})

test('during a call a compaction rebuilds the model connection at a turn boundary, keeping playback accounting', { timeout: 180000 }, async () => {
  const report = await scenario('call', {
    nexus: '    compactionBudget: 12000\n    summaryModel: nexus-test-summary/configured-sum\n',
    steps: [
      { call: 'start' }, { prompt: 'Remember the codename KESTREL-9.' }, { long: 7 },
      { until: 'rebuilt' }, { speak: true }, { prompt: 'After the cut.' },
      { call: 'end' }, { call: 'start' }, { call: 'end' },
    ],
  })
  const { events, connections, link } = report
  const start = of(events, 'compaction/start')[0]
  const checkpoint = events.find(event => sourceOf(event) === 'compact-checkpoint')
  assert.ok(start && checkpoint, 'the conversation compacted during the call')
  // The first call connection replayed the original conversation; the rebuilt one replays the checkpoint instead.
  assert.ok(connections[0].includes('user: Remember the codename KESTREL-9.'))
  const rebuilt = connections[1]
  assert.ok(rebuilt.findIndex(item => item.includes(CHECKPOINT)) === 0, 'the rebuilt connection opens with the summary')
  assert.ok(!rebuilt.includes('user: Remember the codename KESTREL-9.'))
  // The call stayed live throughout: the new connection replaced the old one only once it had replayed the conversation, and nothing the client was playing was flushed.
  assert.deepEqual(link.states, [])
  assert.deepEqual(link.failed, [])
  assert.equal(report.flushesBeforeSpeech, 0)
  // Speech on the rebuilt connection stopped audio delivered before the rebuild: the cut is recorded truthfully.
  const cuts = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice' && event.data.source.summary === 'interrupted playback')
  assert.ok(cuts.some(event => /"ack c0".*about 0\.5 s of its 1\.0 s/.test(userText(event))), 'the cut of the first connection reply is recorded')
  // The rebuild happened between turns: no turn was open when the new connection replayed the conversation.
  assert.ok(of(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
  // A fresh call also replays the compacted conversation.
  const fresh = connections.at(-1)
  assert.ok(fresh.some(item => item.includes(CHECKPOINT)))
  assert.ok(!fresh.includes('user: Remember the codename KESTREL-9.'))
  assert.ok(fresh.some(item => item.startsWith('user: [Context source: {"kind":"nexus-voice"')))
})

const until = async (predicate, label, limit = 45000) => { for (const start = Date.now(); !(await predicate()); await delay(100)) if (Date.now() - start > limit) throw new Error(`timeout waiting for ${label}`) }
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }

test('the Nexus conversation lists /compact on first open; budget and summary model are set in Nexus settings, apply at once and survive a restart', { timeout: 240000 }, async t => {
  const home = resolve('.scratch/nexus-v1', `compaction-ui-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-compaction')
  const fixture = resolve(home, 'probe')
  for (const dir of [fixture, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const model = await endpoint()
  t.after(async () => { for (const socket of model.server.clients) socket.terminate(); await new Promise(accept => model.server.close(accept)) })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-compaction-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/compaction-probe.js'), resolve(fixture, 'index.js'))
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-compaction-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-compaction-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_COMPACTION_KEY\n    endpoint: ${model.url}\n    timeoutMs: 5000\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
  const cycle = async (report, steps) => {
    await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-compaction-probe\n      name: nexus-compaction-probe\n      config:\n        dir: ${JSON.stringify(home)}\n        report: ${report}\n        live: true\n        steps: ${JSON.stringify(steps)}\n`)
    let output = ''
    const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-compaction', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_COMPACTION_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' } }, async child => {
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      return {}
    })
    let url
    await until(() => (url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]), 'official Host URL')
    return { host, url, output: () => output.replace(/\?token=\S+/g, '?token=[redacted]') }
  }
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true })
  t.after(() => browser.close())
  const open = async url => {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } })
    await page.goto(url)
    await until(async () => {
      for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
      return page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).isVisible()
    }, 'normal Harness entrance')
    // First-run native onboarding can mount after the sidebar becomes visible.
    for (let start = Date.now(); Date.now() - start < 2500; await delay(100)) {
      for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
    }
    return page
  }
  const settings = async page => {
    await until(async () => {
      for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click().catch(() => {}) }
      await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 1000 }).catch(() => {})
      await page.getByRole('button', { name: 'Nexus', exact: true }).click({ timeout: 1000 }).catch(() => {})
      return page.getByRole('spinbutton', { name: /主会话压缩预算/ }).isVisible()
    }, 'Nexus settings')
    return { budget: page.getByRole('spinbutton', { name: /主会话压缩预算/ }), summary: page.getByRole('combobox', { name: /压缩摘要模型/ }) }
  }
  const evidence = resolve(home, 'browser')
  await mkdir(evidence)
  let page
  let current = await cycle('report-1.json', [{ wait: 'settings-saved' }, { prompt: 'Remember the codename KESTREL-9.' }, { long: 7 }, { config: true }])
  t.after(() => current.host.close())
  try {
    page = await open(current.url)
    // Before any turn: the native composer's command list already offers /compact.
    await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click()
    const editor = page.getByRole('textbox').last()
    await editor.click()
    await editor.pressSequentially('/comp')
    // The client presents the native command, localized by its definition identity.
    await page.getByRole('option', { name: /compact/ }).waitFor({ timeout: 15000 })
    await page.screenshot({ path: resolve(evidence, 'compact-listed.png') })
    await editor.press('Escape')
    await editor.fill('')
    // Nexus settings: defaults, then the user's values.
    const fields = await settings(page)
    assert.equal(await fields.budget.inputValue(), '128000')
    assert.equal(await fields.summary.inputValue(), '')
    await until(async () => (await fields.summary.locator('option').allTextContents()).some(text => text.includes('ui-sum')), 'model catalog in the summary model choice')
    await fields.budget.fill('12000')
    await fields.budget.press('Enter')
    await until(async () => !(await fields.budget.isDisabled()) && await fields.budget.inputValue() === '12000', 'budget saved')
    await fields.summary.selectOption('nexus-test-summary/ui-sum')
    await until(async () => !(await fields.summary.isDisabled()) && await fields.summary.inputValue() === 'nexus-test-summary/ui-sum', 'summary model saved')
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.screenshot({ path: resolve(evidence, 'settings-saved.png') })
    await writeFile(resolve(home, 'settings-saved'), '')
    let report
    await until(async () => (report = await readJson(resolve(home, 'report-1.json'))), 'first cycle report', 120000)
    assert.equal(report.error, undefined, report.stack)
    // The same process compacted at the new budget with the chosen summary model.
    assert.equal(report.config.compactionBudget, 12000)
    assert.equal(report.config.summaryModel, 'nexus-test-summary/ui-sum')
    const summary = report.events.find(event => event.type === 'compaction/summary')
    assert.ok(summary, 'the new budget triggers compaction without a restart')
    assert.deepEqual([summary.data.provider, summary.data.model], ['nexus-test-summary', 'ui-sum'])
    await page.close()
    await current.host.close()
    // A new Host process keeps the values.
    current = await cycle('report-2.json', [{ config: true }])
    let restarted
    await until(async () => (restarted = await readJson(resolve(home, 'report-2.json'))), 'second cycle report')
    assert.equal(restarted.error, undefined, restarted.stack)
    assert.equal(restarted.config.compactionBudget, 12000)
    assert.equal(restarted.config.summaryModel, 'nexus-test-summary/ui-sum')
    page = await open(current.url)
    const kept = await settings(page)
    await until(async () => await kept.budget.inputValue() === '12000' && await kept.summary.inputValue() === 'nexus-test-summary/ui-sum', 'settings after restart')
    await page.screenshot({ path: resolve(evidence, 'settings-restarted.png') })
    console.log('compaction ui evidence:', home)
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: resolve(evidence, 'failure.png') }).catch(() => {})
      await writeFile(resolve(evidence, 'failure.yml'), await page.locator('body').ariaSnapshot().catch(() => ''))
    }
    await writeFile(resolve(evidence, 'host.txt'), current.output())
    throw error
  }
})

test('during a call a replacement connection that cannot open leaves the call on its connection, which never receives the summary as a new item', { timeout: 180000 }, async () => {
  const report = await scenario('call-rejected', {
    nexus: '    compactionBudget: 12000\n    summaryModel: nexus-test-summary/configured-sum\n',
    model: { opening: { 1: 'reject', 2: 'reject' } },
    steps: [
      { call: 'start' }, { prompt: 'Remember the codename KESTREL-9.' }, { long: 7 },
      { prompt: 'After failed rebuild.' }, { prompt: 'After rebuild.' }, { until: 'rebuilt' }, { prompt: 'Final.' }, { call: 'end' },
    ],
  })
  const { events, requests, requestConnections, connections, closed, link } = report
  assert.ok(of(events, 'compaction/start').length >= 1)
  // Two replacements failed to open; neither ended the call or answered anything.
  assert.deepEqual(link.failed, [])
  assert.deepEqual(link.states, [])
  assert.ok(closed[1] && closed[2])
  assert.ok(!requestConnections.includes(1) && !requestConnections.includes(2))
  // The call kept answering on its connection, whose server conversation keeps the originals and gets no checkpoint item.
  const kept = requests.findIndex(items => items.includes('user: After failed rebuild.'))
  assert.equal(requestConnections[kept], 0)
  assert.ok(requests[kept].includes('user: Remember the codename KESTREL-9.'))
  assert.ok(!connections[0].some(item => item.includes(CHECKPOINT)))
  // A later boundary replaced it with a connection that replays the summary.
  const rebuilt = connections.length - 1
  assert.ok(rebuilt >= 3)
  assert.equal(connections[rebuilt].findIndex(item => item.includes(CHECKPOINT)), 0)
  assert.ok(!connections[rebuilt].includes('user: Remember the codename KESTREL-9.'))
  assert.equal(requestConnections[requests.findIndex(items => items.includes('user: Final.'))], rebuilt)
  assert.ok(of(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
})

test('during a call speech while a replacement opens keeps the old connection; a silent answer records its usage', { timeout: 180000 }, async () => {
  const report = await scenario('call-speech', {
    nexus: '    compactionBudget: 12000\n    summaryModel: nexus-test-summary/configured-sum\n',
    model: { opening: { 1: 'delay' }, speech: 'commit' },
    steps: [
      { call: 'start' }, { speakOnRebuild: true }, { prompt: 'Remember the codename KESTREL-9.' }, { long: 7 },
      { until: 'rebuilt' }, { prompt: 'After rebuild.' }, { call: 'end' },
    ],
  })
  const { events, requests, requestConnections, connections, closed, link } = report
  assert.equal(report.spokeOnRebuild, true)
  // The utterance arrived on the old connection while the replacement was opening, so the replacement was discarded unused.
  assert.ok(closed[1])
  assert.ok(!requestConnections.includes(1))
  assert.deepEqual(link.failed, [])
  assert.deepEqual(link.states, [])
  const spoken = events.find(event => sourceOf(event) === 'user' && userText(event) === 'SPOKEN-DURING-REBUILD')
  assert.ok(spoken, 'the utterance is recorded')
  // The model answered it silently: no message, but the reported usage is kept as a content-free attempt.
  const attempt = events.find(event => event.type === 'assistant/attempt' && event.seq > spoken.seq)
  assert.ok(attempt, 'the silent answer is settled')
  assert.deepEqual(attempt.data.stream.find(record => record.chunk.type === 'usage').chunk.usage, { inputTokens: 234, outputTokens: 5, totalTokens: 1239, cacheReadTokens: 1000 })
  assert.equal(report.tokenUsage.totals.outputTokens, 5 * (of(events, 'assistant/message').length + of(events, 'assistant/attempt').length))
  // The next boundary rebuilt the call from the conversation that includes the utterance.
  const rebuilt = connections[2]
  assert.equal(rebuilt.findIndex(item => item.includes(CHECKPOINT)), 0)
  assert.ok(rebuilt.includes('user: SPOKEN-DURING-REBUILD'))
  assert.equal(requestConnections[requests.findIndex(items => items.includes('user: After rebuild.'))], 2)
  assert.ok(of(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
})

test('during a call a replacement discarded once the agent is idle is retried at once, not at the next turn', { timeout: 180000 }, async () => {
  const report = await scenario('call-discarded', {
    nexus: '    compactionBudget: 12000\n    summaryModel: nexus-test-summary/configured-sum\n',
    model: { opening: { 1: 'delay' } },
    // The manual compaction runs between turns while the first replacement opens, so no turn ends after it is discarded.
    steps: [{ call: 'start' }, { prompt: 'Remember the codename KESTREL-9.' }, { long: 6 }, { command: '/compact' }, { until: 'rebuilt' }, { prompt: 'After rebuild.' }, { call: 'end' }],
  })
  const { events, requests, requestConnections, connections, closed, link, commands } = report
  assert.equal(commands[0].result.kind, 'success')
  const starts = of(events, 'compaction/start')
  assert.ok(starts.some(event => typeof event.data.turn === 'number') && starts.some(event => event.data.turn === null))
  // The first replacement replayed the conversation before the manual checkpoint: it was discarded unused.
  assert.ok(closed[1])
  assert.ok(!requestConnections.includes(1))
  assert.equal(connections[1].filter(item => item.includes(CHECKPOINT)).length, 1)
  // Its retry replays the latest checkpoint before the next prompt.
  assert.equal(connections[2].findIndex(item => item.includes(CHECKPOINT)), 0)
  assert.ok(connections[2][0].includes(`SUMMARY-${report.summaries.length}`))
  assert.equal(requestConnections[requests.findIndex(items => items.includes('user: After rebuild.'))], 2)
  assert.deepEqual(link.failed, [])
  assert.deepEqual(link.states, [])
  assert.ok(of(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
})
