import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

const delay = ms => new Promise(accept => setTimeout(accept, ms))
const root = resolve('.')
const TAGS = /THEME-[A-Z]+|task-\w+|HOLD-BUSY|[ABC]-(?:START|CHANGE)/g
const MODEL = 'qwen3.8-omni-flash-realtime'

const REAL_PROMPTS = {
  // Typed by the user directly into the two work sessions.
  site: 'task-site：搭建公司官网首页，配色用蓝色主题 THEME-BLUE。',
  doc: 'task-doc：编写后端 API 参考文档。',
  // Said to Nexus in the main conversation: natural language, no tool, session id or message to send.
  change: '官网首页的配色我改主意了，换成琥珀色吧（主题标记 THEME-AMBER）。做完告诉我结果。',
  steer: '文档里的代码示例改用 THEME-CRIMSON 配色。',
  ask: 'doc-worker 现在的要求是什么？是谁提出的？一句话回答。',
}

// Scripted supervisor model: it only executes the dispatches the scenario names; everything else is acknowledged with the tags it saw.
const scripted = {
  'A-START': ['nexus_send_session', { sessionId: 'alpha', text: 'task-alpha THEME-BLUE' }],
  'A-CHANGE': ['nexus_send_session', { sessionId: 'alpha', text: 'Changed requirement from the user: use THEME-AMBER instead of THEME-BLUE.' }],
  'B-START': ['nexus_send_session', { sessionId: 'beta', text: 'task-beta THEME-BLUE' }],
  'C-START': ['nexus_send_session', { sessionId: 'gamma', text: 'task-gamma THEME-BLUE' }],
}

async function steeringProfile(real = false) {
  const home = resolve('.scratch/nexus-v1', `steering-${real ? 'real' : 'controlled'}-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-steering')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  const report = resolve(home, 'result.json')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  const wire = []
  let connections = 0
  let call = 0
  server.on('connection', socket => {
    const connection = ++connections
    const items = []
    let answered = 0
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); wire.push({ ...event, connection })
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'conversation.item.create') items.push({ role: event.item.role, text: event.item.content?.map(part => part.text).join('\n') ?? event.item.output ?? '' })
      if (event.type !== 'response.create') return
      socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } }))
      // A new connection replays the whole history; only items after the last answer are new to the model.
      const fresh = items.slice(Math.max(answered, items.findLastIndex(item => item.role === 'assistant') + 1)).map(item => item.text).join('\n')
      answered = items.length
      const step = Object.entries(scripted).find(([tag]) => fresh.includes(tag) && !fresh.includes('Automatic work-session result') && !fresh.includes('Direct user input'))
      const respond = () => {
        if (step) {
          const item = { type: 'function_call', call_id: `steer-call-${++call}`, name: step[1][0], arguments: JSON.stringify(step[1][1]) }
          socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', ...item }))
          return socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [item] } }))
        }
        socket.send(JSON.stringify({ type: 'response.text.delta', delta: `Processed: ${[...new Set(fresh.match(TAGS) ?? [])].join(',') || 'nothing'}` }))
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
      }
      if (fresh.includes('HOLD-BUSY')) setTimeout(respond, 2500); else respond()
    })
  })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-steering-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/steering-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-steering-probe\n      name: nexus-steering-probe\n      config:\n        report: ${JSON.stringify(report)}\n        workspace: ${JSON.stringify(workspace)}\n        real: ${real}\n        prompts: ${JSON.stringify(REAL_PROMPTS)}\n        manual: ${JSON.stringify(real ? ['doc-worker'] : ['gamma'])}\n        buildLimitMs: ${real ? 150000 : 30000}\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-steering-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-steering-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_STEERING_KEY\n    endpoint: ${real ? process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' : `ws://127.0.0.1:${server.address().port}`}\n    timeoutMs: 30000\n`)
  const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-steering', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_STEERING_KEY: real ? process.env.NEXUS_STEERING_KEY : 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  try {
    let result
    for (let i = 0; i < 4000; i++) { try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {} if (child.exitCode !== null) break; await delay(100) }
    assert.ok(result, 'no steering report: ' + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
    assert.equal(result.error, undefined, result.stack)
    assert.ok(result.released)
    if (!real) await writeFile(resolve(home, 'wire.json'), JSON.stringify(wire))
    console.log('steering evidence:', report)
    return { ...analyze(result), result, wire }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([new Promise(accept => child.once('exit', accept)), delay(5000)])
    for (const socket of server.clients) socket.terminate()
    await new Promise(accept => server.close(accept))
  }
}

const textOf = message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')

function analyze(result) {
  const events = result.events
  const admitted = kind => events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted.filter(message => message.source.kind === kind).map(message => ({ message, text: textOf(message), source: message.source, splicedSeq: event.seq })))
  const turns = events.filter(event => event.type === 'turn/start').map(start => ({ turn: start.data.turn, start: start.seq, end: events.find(event => event.type === 'turn/end' && event.data.turn === start.data.turn)?.seq ?? Infinity }))
  const turnOf = seq => turns.find(turn => seq > turn.start && seq < turn.end)
  const received = entry => events.find(event => event.type === 'user/message' && event.data.id === entry.message.id)
  const stepOf = seq => events.findLast(event => event.type === 'step/start' && event.seq < seq).data
  const replyAfter = seq => events.find(event => event.type === 'assistant/message' && event.seq > seq)
  const worker = id => result.workers.find(item => item.id === id)
  // Where the worker's own log placed a message: the step that claimed it.
  const placed = (id, predicate) => {
    const log = worker(id).events
    const message = log.find(event => event.type === 'user/message' && predicate(event.data))
    return message && { message, step: log.findLast(event => event.type === 'step/start' && event.seq < message.seq).data }
  }
  const finals = id => worker(id).events.filter(event => event.type === 'assistant/message' && textOf(event.data.message)).map(event => textOf(event.data.message))
  return { events, notices: admitted('nexus-user-input'), results: admitted('nexus-work-result'), turnOf, received, stepOf, replyAfter, worker, placed, finals }
}

test('user steering: main-conversation change and direct worker steering reach the next native step, keep their sources and interleave with older results', { timeout: 240000 }, async () => {
  const { result, events, notices, results, turnOf, received, stepOf, replyAfter, worker, placed, finals } = await steeringProfile()
  assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))

  // Exactly the two direct user inputs are mirrored; Nexus dispatches (alpha, and the three task starts) never are.
  assert.deepEqual(notices.map(entry => [entry.source.sessionId, entry.source.target]), [['beta', 'next-step'], ['gamma', 'next-turn']])
  for (const entry of notices) {
    assert.equal(entry.message.role, 'user')
    assert.equal(entry.source.form, 'notice')
    assert.ok(received(entry), 'the notice entered the model context')
    assert.ok(replyAfter(received(entry).seq), 'the supervisor answered after the notice')
  }

  // A: the main-conversation change became Nexus native steering, claimed at the next step of the same running worker turn.
  const change = events.find(event => event.type === 'tool/call' && event.seq > result.marks.aChange)
  assert.deepEqual([change.data.name, JSON.parse(change.data.arguments).sessionId], ['nexus_send_session', 'alpha'])
  assert.equal(JSON.parse(events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === change.data.callId).data.message.content[0].text).delivery, 'steer')
  const alphaSteer = placed('alpha', message => message.source.kind === 'nexus-dispatch' && textOf(message).includes('THEME-AMBER'))
  assert.deepEqual(alphaSteer.step, { turn: 1, step: 2 })
  assert.ok(worker('alpha').events.some(event => event.type === 'tool/result' && event.data.turn === 1 && event.data.step === 1 && !event.data.message.isError), 'the running native tool finished; steering did not interrupt it')
  assert.deepEqual(finals('alpha'), ['Built alpha with THEME-AMBER (the build step began with THEME-BLUE)'])
  assert.equal(result.artifacts.alpha, 'THEME-AMBER')
  assert.match(results.find(entry => entry.source.sessionId === 'alpha').text, /THEME-AMBER/)

  // B: the user steered beta directly while Nexus was idle: the mirror woke Nexus in a new turn, with the user's real message identity.
  const betaSteer = placed('beta', message => message.source.kind === 'user' && textOf(message).includes('THEME-CRIMSON'))
  assert.equal(betaSteer.message.data.source.rpcId, 'beta-steer')
  assert.deepEqual(betaSteer.step, { turn: 1, step: 2 })
  const betaNotice = notices[0]
  assert.equal(betaNotice.source.messageId, betaSteer.message.data.id)
  assert.match(betaNotice.text, /^Direct user input in a work session\.[\s\S]*Session: beta \(ordinary session\)[\s\S]*Admitted as native steering[\s\S]*Use THEME-CRIMSON instead of THEME-BLUE/)
  assert.ok(turnOf(betaNotice.splicedSeq) === undefined && betaNotice.splicedSeq >= result.marks.bSteer, 'admitted while the supervisor was idle')
  assert.ok(turnOf(received(betaNotice).seq).start > result.marks.bSteer, 'the idle supervisor opened a turn for it')
  assert.match(textOf(replyAfter(received(betaNotice).seq).data.message), /THEME-CRIMSON/)
  assert.deepEqual(finals('beta'), ['Built beta with THEME-CRIMSON (the build step began with THEME-BLUE)'])
  assert.equal(result.artifacts.beta, 'THEME-CRIMSON')
  const betaResult = results.find(entry => entry.source.sessionId === 'beta')
  assert.ok(betaNotice.splicedSeq < betaResult.splicedSeq, 'the requirement precedes the result it shaped')

  // C: Nexus was busy answering the user; the user queued a new requirement in gamma, whose older turn then finished.
  const hold = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && textOf(event.data).includes('HOLD-BUSY'))
  const busyTurn = turnOf(hold.seq)
  const gammaNotice = notices[1]
  const [oldResult, newResult] = results.filter(entry => entry.source.sessionId === 'gamma')
  assert.deepEqual([oldResult.source.turn, newResult.source.turn], [1, 2])
  assert.equal(turnOf(gammaNotice.splicedSeq)?.turn, busyTurn.turn, 'the direct input was admitted while the supervisor was busy')
  assert.equal(turnOf(oldResult.splicedSeq)?.turn, busyTurn.turn, 'the older result also arrived during the busy turn')
  assert.ok(gammaNotice.splicedSeq < oldResult.splicedSeq && oldResult.splicedSeq < newResult.splicedSeq)
  const holdReply = replyAfter(hold.seq)
  assert.match(textOf(holdReply.data.message), /HOLD-BUSY/)
  assert.ok(received(gammaNotice).seq > holdReply.seq && received(oldResult).seq > holdReply.seq, 'neither displaced the in-flight user request')
  assert.equal(turnOf(received(gammaNotice).seq).turn, busyTurn.turn)
  assert.equal(turnOf(received(oldResult).seq).turn, busyTurn.turn)
  assert.ok(stepOf(received(gammaNotice).seq).step > 1, 'joined the busy turn at a later step')
  assert.match(gammaNotice.text, /Admitted as a queued prompt[\s\S]*Then rebuild it with THEME-JADE/)
  assert.match(oldResult.text, /not an instruction from the user[\s\S]*Built gamma with THEME-BLUE/)
  assert.match(newResult.text, /Turn: 2[\s\S]*Built gamma with THEME-JADE/)
  assert.ok(received(newResult) && replyAfter(received(newResult).seq))
  assert.deepEqual(finals('gamma'), ['Built gamma with THEME-BLUE (the build step began with THEME-BLUE)', 'Built gamma with THEME-JADE (the build step began with THEME-JADE)'])
  assert.deepEqual(placed('gamma', message => message.source.kind === 'user' && textOf(message).includes('THEME-JADE')).step, { turn: 2, step: 1 })
  assert.equal(result.artifacts.gamma, 'THEME-JADE')
})

test('accurate Realtime model applies a natural-language change to the affected worker only and absorbs a direct worker steer', { skip: process.env.NEXUS_REAL_STEERING !== '1', timeout: 600000 }, async () => {
  const { result, events, notices, results, received, replyAfter, worker, placed, finals } = await steeringProfile(true)
  const assistant = events.filter(event => event.type === 'assistant/message')
  assert.ok(assistant.length && assistant.every(event => event.data.message.source.model === MODEL))
  assert.ok(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
  const text = (from, to = Infinity) => assistant.filter(event => event.seq > from && event.seq < to).map(event => textOf(event.data.message)).join('\n')
  const dispatched = id => worker(id).events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch')
  console.log('real assistant texts:', JSON.stringify(assistant.map(event => [event.seq, textOf(event.data.message)])))
  console.log('real tool calls:', JSON.stringify(events.filter(event => event.type === 'tool/call').map(event => [event.seq, event.data.name, event.data.arguments])))

  // Both tasks were the user's own input to the sessions, mirrored to Nexus; later the user steered doc-worker directly.
  assert.deepEqual(notices.map(entry => entry.source.sessionId), ['site-worker', 'doc-worker', 'doc-worker'])
  for (const entry of notices) assert.ok(received(entry) && replyAfter(received(entry).seq))

  // The natural-language change named no tool, session or message: the model chose site-worker, steered it, and left doc-worker alone.
  const siteSteer = placed('site-worker', message => message.source.kind === 'nexus-dispatch' && textOf(message).includes('THEME-AMBER'))
  assert.ok(siteSteer, 'the model relayed the changed requirement to the affected session')
  assert.equal(siteSteer.step.turn, 1)
  assert.ok(siteSteer.step.step > 1, 'claimed at a later native step of the running turn')
  assert.ok(!dispatched('doc-worker').some(event => textOf(event.data).includes('AMBER')), 'the unrelated session was not steered with the change')
  assert.match(finals('site-worker').at(-1), /^Built site-worker with THEME-AMBER \(the build step began with THEME-BLUE\)$/)
  assert.equal(result.artifacts['site-worker'], 'THEME-AMBER')
  const siteResult = results.find(entry => entry.source.sessionId === 'site-worker')
  assert.ok(received(siteResult))
  assert.match(text(received(siteResult).seq, result.marks.steer), /AMBER|琥珀/, 'the model reported the changed outcome')

  // Direct steer: Nexus answered from the mirror before doc-worker's result existed.
  const docSteer = placed('doc-worker', message => message.source.kind === 'user' && message.source.rpcId === 'real-direct-steer')
  assert.equal(notices[2].source.messageId, docSteer.message.data.id)
  assert.ok(docSteer.step.step > 1)
  const docResult = results.find(entry => entry.source.sessionId === 'doc-worker')
  assert.ok(docResult.splicedSeq >= result.marks.release, 'the doc-worker result arrived only after the question was answered')
  assert.match(text(result.marks.ask, result.marks.release), /CRIMSON/, 'the answer came from the mirrored direct steer')
  assert.match(finals('doc-worker').at(-1), /^Built doc-worker with THEME-CRIMSON /)
  assert.equal(result.artifacts['doc-worker'], 'THEME-CRIMSON')
  assert.ok(received(docResult) && replyAfter(received(docResult).seq))
  console.log('doc-worker Nexus dispatches:', JSON.stringify(dispatched('doc-worker').map(event => textOf(event.data))))
})
