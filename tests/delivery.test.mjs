import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

const delay = ms => new Promise(accept => setTimeout(accept, ms))
const root = resolve('.')
const TAGS = /\b(?:ok|fail|slow|hold)-\w+|REPORT-\w+-\d+|HOLD-BUSY|SECOND-USER/g

const REAL = {
  prompts: {
    idle: '名为 user-existing 的会话是我自己在用的普通会话，不是你创建的，它正在跑测试。它的结果自动到达你这里后：先用一句话告诉我报告编号和结论；如果报告显示有测试失败，请直接调用 nexus_send_session 让它重跑，text 参数写 report-rerun。现在不需要做任何事，回答“收到”即可。',
    busy: '请回答：9 乘以 7 等于多少？另外，如果在你回答期间有新的工作会话结果自动到达，请在回答里一并带上它的报告编号。',
  },
  reports: {
    idle: 'REPORT-RI-7731: 3 of 41 tests failed in module parser; cause: missing null check in the tokenizer.',
    rerun: 'REPORT-RR-8842: rerun finished, all 41 tests passed.',
    busy: 'REPORT-RB-5524: build artifacts verified, 12 files changed.',
  },
}

async function deliveryProfile(real = false) {
  const home = resolve('.scratch/nexus-v1', `delivery-${real ? 'real' : 'controlled'}-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-delivery')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  const report = resolve(home, 'result.json')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  const wire = []
  let connections = 0
  let followed = false
  server.on('connection', socket => {
    const connection = ++connections
    const items = []
    let answered = 0
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); wire.push({ ...event, connection })
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'conversation.item.create') items.push({ id: event.item.id, role: event.item.role, type: event.item.type, text: event.item.content?.map(part => part.text).join('\n') ?? event.item.output ?? '' })
      if (event.type !== 'response.create') return
      const from = Math.max(answered, items.findLastIndex(item => item.role === 'assistant') + 1)
      const fresh = items.slice(from).map(item => item.text).join('\n')
      answered = items.length
      const respond = () => {
        if (!followed && /Session: review-target[\s\S]*Outcome: completed[\s\S]*FOLLOWUP/.test(fresh)) {
          followed = true // scripted model decision: ask the same session for a second pass
          const item = { type: 'function_call', call_id: 'delivery-follow-1', name: 'nexus_send_session', arguments: JSON.stringify({ sessionId: 'review-target', text: 'ok-secondpass' }) }
          socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', ...item }))
          return socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [item] } }))
        }
        const seen = [...new Set(fresh.match(TAGS) ?? [])]
        socket.send(JSON.stringify({ type: 'response.text.delta', delta: `Processed: ${seen.join(',') || 'nothing'}` }))
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
      }
      if (fresh.includes('HOLD-BUSY')) setTimeout(respond, 2500); else respond()
    })
  })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-delivery-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/delivery-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-delivery-probe\n      name: nexus-delivery-probe\n      config:\n        report: ${JSON.stringify(report)}\n        workspace: ${JSON.stringify(workspace)}\n        real: ${real}\n        realPrompts: ${JSON.stringify(REAL.prompts)}\n        reports: ${real ? JSON.stringify(REAL.reports) : '{}'}\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-delivery-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-delivery-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_DELIVERY_KEY\n    endpoint: ${real ? process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' : `ws://127.0.0.1:${server.address().port}`}\n    timeoutMs: 30000\n`)
  const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-delivery', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_DELIVERY_KEY: real ? process.env.NEXUS_DELIVERY_KEY : 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  try {
    let result
    for (let i = 0; i < 2400; i++) { try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {} if (child.exitCode !== null) break; await delay(100) }
    assert.ok(result, 'no delivery report: ' + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
    assert.equal(result.error, undefined, result.stack)
    assert.ok(result.released)
    if (!real) await writeFile(resolve(home, 'wire.json'), JSON.stringify(wire))
    console.log('delivery evidence:', report)
    return { ...analyze(result), result, wire, home }
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
  const results = events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted.filter(message => message.source.kind === 'nexus-work-result').map(message => ({ message, text: textOf(message), source: message.source, splicedSeq: event.seq })))
  const bySeq = seq => events.find(event => event.seq === seq)
  const turns = events.filter(event => event.type === 'turn/start').map(start => ({ turn: start.data.turn, start: start.seq, end: events.find(event => event.type === 'turn/end' && event.data.turn === start.data.turn)?.seq ?? Infinity }))
  const turnOf = seq => turns.find(turn => seq > turn.start && seq < turn.end)
  const received = entry => events.filter(event => event.type === 'user/message' && event.data.id === entry.message.id)
  const processed = entry => events.find(event => event.type === 'assistant/message' && event.seq > received(entry)[0].seq)
  const find = (session, turn) => results.filter(entry => entry.source.sessionId === session && (turn === undefined || entry.source.turn === turn))
  return { events, results, turns, turnOf, received, processed, find, bySeq }
}

// Every terminal of every other session reaches the model exactly once, and observation, receipt and processing are separate facts.
function assertEveryTerminalDelivered(a, result, wire) {
  for (const worker of result.workers.filter(worker => worker.id !== 'nexus-child')) {
    for (const end of worker.events.filter(event => event.type === 'turn/end')) assert.equal(a.find(worker.id, end.data.turn).length, 1, `${worker.id} turn ${end.data.turn}`)
  }
  assert.equal(a.results.length, result.workers.filter(worker => worker.id !== 'nexus-child').flatMap(worker => worker.events.filter(event => event.type === 'turn/end')).length)
  assert.ok(!a.results.some(entry => entry.source.sessionId === 'nexus-supervisor'), 'supervisor output must not return to itself')
  for (const entry of a.results) {
    assert.equal(entry.message.role, 'user')
    assert.equal(entry.source.form, 'notice')
    assert.notEqual(entry.source.kind, 'user')
    assert.equal(a.received(entry).length, 1, 'one model-visible message per result')
    assert.ok(a.processed(entry), 'a model response follows each received result')
    if (wire) assert.ok(wire.some(event => event.type === 'conversation.item.create' && event.item.id === entry.message.id), 'result reached the model transport')
  }
}

test('official Host relays every work-session terminal to the supervisor: idle wake, failure, interruption, interleave, busy queue and model-chosen follow-up', { timeout: 180000 }, async () => {
  const { result, wire, find, received, processed, results, turnOf, events } = await deliveryProfile()
  const a = { find, received, processed, results }
  assertEveryTerminalDelivered(a, result, wire)
  assert.equal(result.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error').length, 0, 'the supervisor itself never fails')

  // Idle wake on a pre-existing session Nexus never created or dispatched to.
  const idle = find('user-existing', 2)[0]
  assert.match(idle.text, /Outcome: completed/)
  assert.match(idle.text, /Report ok-idle: finished/)
  assert.ok(!/nexus-dispatch/.test(JSON.stringify(result.workers.find(worker => worker.id === 'user-existing').events)))
  assert.match(textOf(processed(idle).data.message), /ok-idle/)
  assert.notEqual(received(idle)[0].data.source.kind, 'user')
  const idleTurn = turnOf(received(idle)[0].seq)
  assert.ok(idleTurn.start > result.marks.idle, 'the idle supervisor opened a new turn for the result')

  // Failure and interruption keep their terminal state and real details.
  const failed = find('failing', 1)[0]
  assert.match(failed.text, /Outcome: failed - TEST_WORKER_FAILURE: .*worker exploded/)
  assert.equal(failed.source.terminal, 'error')
  assert.match(failed.text, /The turn produced no assistant text/)
  const interrupted = find('held', 1)[0]
  assert.match(interrupted.text, /Outcome: interrupted/)
  assert.equal(interrupted.source.terminal, 'aborted')

  // Different sessions with the same turn number remain distinct.
  const mixed = [find('mixed-a', 1), find('mixed-b', 1)]
  assert.deepEqual(mixed.map(list => list.length), [1, 1])
  assert.notEqual(mixed[0][0].message.id, mixed[1][0].message.id)
  assert.ok(find('user-existing', 1).length === 1 && find('failing', 1).length === 1)

  // Busy: the first user input is in flight when the result arrives; a second input queues behind it.
  const busyResult = find('busy', 1)[0]
  const busyTurn = turnOf(busyResult.splicedSeq)
  assert.ok(busyTurn, 'the result was admitted while a supervisor turn was open')
  const firstUser = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && textOf(event.data).includes('HOLD-BUSY'))
  assert.equal(turnOf(firstUser.seq).turn, busyTurn.turn, 'the result joined the turn that was processing the user input')
  const firstReply = events.find(event => event.type === 'assistant/message' && event.seq > firstUser.seq)
  assert.ok(received(busyResult)[0].seq > firstReply.seq, 'the in-flight request finished before the result was handed to the model')
  assert.equal(turnOf(received(busyResult)[0].seq).turn, busyTurn.turn, 'the result entered the model at the next step of the same turn')
  assert.match(textOf(processed(busyResult).data.message), /slow-busy/)
  assert.match(textOf(firstReply.data.message), /HOLD-BUSY/)
  const second = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && textOf(event.data).includes('SECOND-USER'))
  assert.ok(second && turnOf(second.seq).turn > busyTurn.turn)
  assert.match(textOf(events.find(event => event.type === 'assistant/message' && event.seq > second.seq).data.message), /SECOND-USER/)

  // The supervisor's own subagent reaches it through the runtime's settled notice (per activation, not per turn), never twice.
  const child = result.workers.find(worker => worker.id === 'nexus-child')
  assert.equal(child.header.parentSession, 'nexus-supervisor')
  assert.equal(child.events.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(find('nexus-child').length, 0, 'the relay leaves the supervisor own children to the native notice')
  const settled = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled' && event.data.source.senderSessionId === 'nexus-child')
  assert.equal(settled.length, 1)
  assert.match(textOf(settled[0].data), /ok-native/)
  assert.match(textOf(events.find(event => event.type === 'assistant/message' && event.seq > settled[0].seq).data.message), /ok-native/)

  // The scripted model, not the connection, asked for a second pass; the loop ends when the model stops asking.
  assert.equal(find('review-target').length, 2)
  const call = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_send_session')
  assert.ok(call && call.seq > find('review-target', 1)[0].splicedSeq)
  const review = result.workers.find(worker => worker.id === 'review-target')
  assert.equal(review.events.filter(event => event.type === 'turn/end').length, 2)
  assert.ok(review.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch' && textOf(event.data) === 'ok-secondpass'))
  assert.ok(find('review-target', 2)[0].text.includes('ok-secondpass'))
})

test('accurate Realtime model wakes on an idle result and absorbs a busy result without losing the user input', { skip: process.env.NEXUS_REAL_DELIVERY !== '1', timeout: 300000 }, async () => {
  const { result, find, received, processed, results, turnOf, events } = await deliveryProfile(true)
  assertEveryTerminalDelivered({ results, find, received, processed }, result)
  const text = event => event.type === 'assistant/message' ? textOf(event.data.message) : ''
  assert.ok(events.filter(event => event.type === 'assistant/message').every(event => event.data.message.source.model === 'qwen3.8-omni-flash-realtime'))

  // Idle: after the user's first, finished exchange the supervisor sits idle; the report wakes it.
  const idle = find('user-existing', 1)[0]
  assert.match(idle.text, /REPORT-RI-7731/)
  const idleTurn = turnOf(received(idle)[0].seq)
  const idleCalls = events.filter(event => event.type === 'tool/call' && event.seq > idle.splicedSeq && event.seq < idleTurn.end)
  const idleAnswer = events.filter(event => event.type === 'assistant/message' && event.seq > received(idle)[0].seq && event.seq < idleTurn.end).map(text).join('\n')
  assert.ok(idleAnswer.includes('7731') || idleCalls.some(event => event.data.name === 'nexus_send_session' && JSON.parse(event.data.arguments).sessionId === 'user-existing'), 'grounded answer or follow-up action: ' + idleAnswer)
  const rerun = events.find(event => event.type === 'tool/call' && event.data.name === 'nexus_send_session' && JSON.parse(event.data.arguments).sessionId === 'user-existing')
  if (rerun) {
    const second = find('user-existing', 2)[0]
    assert.ok(second, 'the rerun result came back automatically')
    assert.match(second.text, /REPORT-RR-8842/)
    assert.ok(processed(second))
  }

  // Busy: the result is admitted while the supervisor is answering a user question.
  const busy = find('user-busy', 1)[0]
  const busyTurn = turnOf(busy.splicedSeq)
  assert.ok(busyTurn, 'result admitted while a supervisor turn was open')
  const question = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && textOf(event.data).includes('9 乘以 7'))
  assert.equal(turnOf(question.seq).turn, busyTurn.turn)
  const reply = events.filter(event => event.type === 'assistant/message' && event.seq > question.seq).map(text).join('\n')
  assert.match(reply, /63/)
  assert.match(reply, /5524/)
})
