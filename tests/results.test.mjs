import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ResultRelay } from '../dist/results.js'
import { INSTRUCTIONS, VOICE_INSTRUCTIONS } from '../dist/realtime.js'

// Controlled relay-level checks over real native Session events. The Host-level
// delivery test proves the same relay against a live supervisor.
const header = (id, extra = {}) => ({ version: 4, id, createdAt: 1, isSeeded: false, cwd: 'E:/work', ...extra })
const session = (id, extra) => Session.create(SessionId(id), undefined, header(id, extra))
const turn = (target, number, { text, reason = { kind: 'completed' } } = {}) => {
  target.append('turn/start', { turn: number })
  target.append('step/start', { turn: number, step: 1 })
  if (text !== undefined) target.append('assistant/message', { turn: number, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'worker' } }) }, { surfaceOp: 'append' })
  target.append('step/end', { turn: number, step: 1 })
  return target.append('turn/end', { turn: number, reason })
}
const supervisor = (id = 'sup') => {
  const target = { id, session: session(id), delivered: [], fail: false, steer(message) { if (this.fail) throw new Error('supervisor unavailable'); this.delivered.push(message) } }
  return target
}
const relay = target => new ResultRelay({ logger: { warn() {} }, on: () => () => {} }, target)
const textOf = message => message.content.map(part => part.text).join('\n')

test('every terminal carries session, turn, outcome and the real final content', () => {
  const target = supervisor()
  const worker = session('w1')
  const r = relay(target)
  for (const [number, options] of [
    [1, { text: 'first answer' }],
    [2, { text: 'tests failed: A', reason: { kind: 'error', error: { code: 'RATE', message: 'provider said no' } } }],
    [3, { reason: { kind: 'aborted', reason: { kind: 'user' } } }],
    [4, { text: 'partial work', reason: { kind: 'interrupted' } }],
  ]) r.observe(worker, turn(worker, number, options))
  const [done, failed, aborted, interrupted] = target.delivered
  assert.match(textOf(done), /Session: w1 \(ordinary session\), workspace: E:\/work\nTurn: 1 \(terminal event seq \d+\)\nOutcome: completed\n/)
  assert.match(textOf(done), /Final content:\nfirst answer/)
  assert.match(textOf(failed), /Outcome: failed - RATE: provider said no/)
  assert.match(textOf(failed), /tests failed: A/)
  assert.doesNotMatch(textOf(failed), /first answer/, 'only the closing turn is quoted')
  assert.match(textOf(aborted), /Outcome: interrupted - cancelled \(user\)/)
  assert.match(textOf(aborted), /The turn produced no assistant text/)
  assert.match(textOf(interrupted), /Outcome: interrupted - .*recovery/)
  assert.deepEqual(target.delivered.map(message => [message.source.kind, message.source.form, message.source.sessionId, message.source.turn, message.source.terminal]), [
    ['nexus-work-result', 'notice', 'w1', 1, 'completed'], ['nexus-work-result', 'notice', 'w1', 2, 'error'],
    ['nexus-work-result', 'notice', 'w1', 3, 'aborted'], ['nexus-work-result', 'notice', 'w1', 4, 'interrupted'],
  ])
  assert.ok(target.delivered.every(message => message.role === 'user' && message.source.kind !== 'user'))
})

test('duplicates, snapshot replay and live events interleave without a second delivery', () => {
  const target = supervisor()
  const a = session('a')
  const b = session('b')
  const r = relay(target)
  const endA = turn(a, 1, { text: 'A done' })
  r.observe(a, endA)
  r.observe(a, endA) // duplicate feed
  // A reconnect replays A's whole snapshot while B is finishing live.
  const replay = a.snapshotEvents()
  const endB = turn(b, 1, { text: 'B done' })
  for (const [index, event] of replay.entries()) { r.observe(a, event); if (index === 2) r.observe(b, endB) }
  r.observe(b, endB)
  for (const event of replay) r.observe(a, event)
  // A turn that first appears inside a replayed snapshot is still delivered once.
  const endA2 = turn(a, 2, { text: 'A second' })
  for (const event of a.snapshotEvents()) r.observe(a, event)
  r.observe(a, endA2)
  assert.deepEqual(target.delivered.map(message => [message.source.sessionId, message.source.turn]).sort(), [['a', 1], ['a', 2], ['b', 1]])
  assert.match(textOf(target.delivered.find(message => message.source.sessionId === 'b')), /B done/)
  assert.equal(new Set(target.delivered.map(message => message.id)).size, 3)
})

test('only conversation sessions are relayed: no supervisor feedback, no subagent sessions, user forks included', () => {
  const target = supervisor()
  const r = relay(target)
  const self = target.session
  r.observe(self, turn(self, 1, { text: 'my own reply' }))
  // Subagent sessions (origin subagent) belong to the agent that spawned them, the supervisor's own children included.
  const child = session('child', { origin: 'subagent', parentSession: SessionId('sup') })
  r.observe(child, turn(child, 1, { text: 'child first turn' }))
  r.observe(child, turn(child, 2, { reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter registered' } } }))
  const foreign = session('foreign-child', { origin: 'subagent', parentSession: SessionId('other-parent') })
  r.observe(foreign, turn(foreign, 1, { text: 'child of someone else' }))
  assert.equal(target.delivered.length, 0)
  // A conversation the user forked records parentSession but no subagent origin; it is still a conversation session.
  const fork = session('user-fork', { parentSession: SessionId('w1') })
  r.observe(fork, turn(fork, 1, { text: 'forked conversation reply' }))
  assert.deepEqual(target.delivered.map(message => [message.source.sessionId, message.source.turn]), [['user-fork', 1]])
  assert.match(textOf(target.delivered[0]), /Session: user-fork \(ordinary session\)[\s\S]*forked conversation reply/)
})

test('large closing text is bounded and keeps the head and the conclusion', () => {
  const target = supervisor()
  const worker = session('big')
  relay(target).observe(worker, turn(worker, 1, { text: `HEAD-${'x'.repeat(40000)}-CONCLUSION` }))
  const text = textOf(target.delivered[0])
  assert.ok(text.length < 7000)
  assert.match(text, /HEAD-/)
  assert.match(text, /-CONCLUSION/)
  assert.match(text, /characters omitted; read the session/)
})

test('a restarted relay rebuilds delivered identity from the supervisor log', () => {
  const target = supervisor()
  const worker = session('w')
  const end = turn(worker, 1, { text: 'once' })
  relay(target).observe(worker, end)
  const [message] = target.delivered
  target.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [message] })
  const restarted = relay(target)
  restarted.observe(worker, end)
  const later = turn(worker, 2, { text: 'twice' })
  restarted.observe(worker, later)
  assert.deepEqual(target.delivered.map(item => item.source.turn), [1, 2])
})

test('a supervisor that cannot accept the message does not consume the result', () => {
  const target = supervisor()
  const worker = session('w')
  const r = relay(target)
  const end = turn(worker, 1, { text: 'retry me' })
  target.fail = true
  assert.throws(() => r.observe(worker, end), /unavailable/)
  target.fail = false
  r.observe(worker, end)
  assert.equal(target.delivered.length, 1)
})

test('start subscribes to the native session event feed and contains delivery errors', () => {
  const target = supervisor()
  const handlers = []
  const warnings = []
  const r = new ResultRelay({ logger: { warn: message => warnings.push(message) }, on: (name, handler) => { handlers.push([name, handler]); return () => {} } }, target)
  r.start()
  assert.equal(handlers[0][0], 'session/event')
  const worker = session('w')
  target.fail = true
  assert.doesNotThrow(() => handlers[0][1](worker, turn(worker, 1, { text: 'x' })))
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(warnings[0], /undefined/)
})

// Direct user input to work sessions (ticket 05): admitted inbox insertions carrying the Host prompt rpcId.
const userInput = (text, rpcId = `rpc-${text}`) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })
const admit = (target, inbox, message) => target.append('agent/inbox/spliced', { target: inbox, start: 0, removedCount: 0, inserted: [message] })

test('direct user input in a work session reaches the supervisor under its own source, steering and queued alike', () => {
  const target = supervisor()
  const worker = session('w')
  const r = relay(target)
  const steer = userInput('switch to THEME-AMBER')
  const queued = userInput('afterwards write the summary')
  r.observe(worker, admit(worker, 'next-step', steer))
  r.observe(worker, admit(worker, 'next-turn', queued))
  assert.deepEqual(target.delivered.map(message => [message.role, message.source.kind, message.source.form, message.source.sessionId, message.source.messageId, message.source.target]), [
    ['user', 'nexus-user-input', 'notice', 'w', steer.id, 'next-step'], ['user', 'nexus-user-input', 'notice', 'w', queued.id, 'next-turn'],
  ])
  assert.match(textOf(target.delivered[0]), /^Direct user input in a work session\. The user entered this into that work session itself, not into this conversation; it is not your dispatch and not an automatic result\.\nSession: w \(ordinary session\), workspace: E:\/work\nAdmitted as native steering/)
  assert.match(textOf(target.delivered[0]), new RegExp(`User message: ${steer.id}\nContent:\nswitch to THEME-AMBER\n`))
  assert.match(textOf(target.delivered[1]), /Admitted as a queued prompt[\s\S]*afterwards write the summary/)
  assert.match(target.delivered[0].source.summary, /^user to w: switch to THEME-AMBER/)
})

test('a mirrored user input tells the supervisor the work agent carries it out: not to perform, answer or repeat it, only to adjust its own arrangements', () => {
  const target = supervisor()
  const worker = session('w')
  relay(target).observe(worker, admit(worker, 'next-turn', userInput('发个你好，不要发其他的任何信息')))
  const text = textOf(target.delivered[0])
  assert.match(text, /\nContent:\n发个你好，不要发其他的任何信息\n/)
  assert.match(text, /addressed to the agent of that work session, which carries it out; its outcome reaches you later as an automatic work-session result\./)
  assert.match(text, /Do not carry out or answer its content yourself, and do not repeat it back\./)
  assert.match(text, /explicit user instruction it takes priority over your earlier dispatches: adjust your own arrangements only where it changes them \(for example stop or redirect another session[^)]*\); otherwise acknowledge briefly or stay silent\.$/)
  assert.doesNotMatch(text, /Treat it as the current user requirement/)
  // The standing instructions, text and voice alike, frame the same source the same way.
  for (const instructions of [INSTRUCTIONS, VOICE_INSTRUCTIONS]) {
    assert.match(instructions, /source nexus-user-input mirror what the user typed directly into a work session: they are explicit user instructions addressed to the agent of that session, which already has them \(no need to resend\) and carries them out; its outcome reaches you later as an automatic work-session result\. Do not carry out, answer or repeat their content yourself\. They take priority over your earlier dispatches: adjust your own arrangements only where they change them/)
    assert.match(instructions, /otherwise acknowledge briefly or stay silent\./)
  }
})

test('only the user own input to conversation sessions is mirrored: no supervisor feedback, Nexus dispatch, agent message, subagent session, claim or replayed notice', () => {
  const target = supervisor()
  const worker = session('w')
  const child = session('child', { origin: 'subagent', parentSession: SessionId('parent') })
  const r = relay(target)
  r.observe(target.session, admit(target.session, 'next-turn', userInput('said to Nexus itself')))
  r.observe(worker, admit(worker, 'next-step', createUserMessage({ content: [{ type: 'text', text: 'dispatched' }], source: { kind: 'nexus-dispatch', sessionId: 'sup', callId: 'c1' } })))
  r.observe(worker, admit(worker, 'next-step', createUserMessage({ content: [{ type: 'text', text: 'from an adjacent agent' }], source: { kind: 'agent-message', senderSessionId: 'other' } })))
  r.observe(child, admit(child, 'next-turn', createUserMessage({ content: [{ type: 'text', text: 'delegated by the parent agent' }], source: { kind: 'user' } })))
  r.observe(child, admit(child, 'next-step', userInput('typed into the subagent composer')))
  r.observe(worker, worker.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }))
  r.observe(worker, worker.append('user/message', userInput('a claimed copy is not a new admission'), { surfaceOp: 'append' }))
  assert.equal(target.delivered.length, 0)
  // User input from any Host entry counts, not only the browser prompt RPC (an SDK, ACP or headless entry carries no rpcId).
  r.observe(worker, admit(worker, 'next-step', createUserMessage({ content: [{ type: 'text', text: 'from the SDK entry' }], source: { kind: 'user' } })))
  assert.equal(target.delivered.length, 1)
  assert.match(textOf(target.delivered[0]), /Session: w \(ordinary session\)[\s\S]*from the SDK entry/)
})

test('a queued input moved to steering is mirrored once; an edit is mirrored again; a restart neither repeats nor forgets', () => {
  const target = supervisor()
  const worker = session('w')
  const r = relay(target)
  const original = userInput('use THEME-AMBER', 'rpc-edit')
  r.observe(worker, admit(worker, 'next-turn', original))
  r.observe(worker, admit(worker, 'next-step', original)) // queue → steer moves the same message
  r.observe(worker, admit(worker, 'next-step', original)) // duplicate feed
  const edited = { ...original, content: [{ type: 'text', text: 'use THEME-CRIMSON instead' }] }
  r.observe(worker, admit(worker, 'next-turn', edited))
  assert.equal(target.delivered.length, 2)
  assert.doesNotMatch(textOf(target.delivered[0]), /edited/)
  assert.match(textOf(target.delivered[1]), /The user edited this pending message; this content replaces the earlier version\.[\s\S]*THEME-CRIMSON/)
  assert.equal(target.delivered[1].source.messageId, original.id)
  for (const message of target.delivered) target.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [message] })
  const restarted = relay(target)
  restarted.observe(worker, admit(worker, 'next-step', edited))
  restarted.observe(worker, admit(worker, 'next-step', original))
  assert.equal(target.delivered.length, 2)
  restarted.observe(worker, admit(worker, 'next-turn', { ...original, content: [{ type: 'text', text: 'third version' }] }))
  assert.equal(target.delivered.length, 3)
  assert.match(textOf(target.delivered[2]), /The user edited this pending message[\s\S]*third version/)
})

test('a new requirement and an older result interleave in admission order with distinct sources', () => {
  const target = supervisor()
  const worker = session('w')
  const r = relay(target)
  worker.append('turn/start', { turn: 1 })
  worker.append('step/start', { turn: 1, step: 1 })
  r.observe(worker, admit(worker, 'next-turn', userInput('next, use THEME-AMBER')))
  worker.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'built THEME-BLUE' }], source: { provider: 'test', model: 'worker' } }) }, { surfaceOp: 'append' })
  worker.append('step/end', { turn: 1, step: 1 })
  r.observe(worker, worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.deepEqual(target.delivered.map(message => message.source.kind), ['nexus-user-input', 'nexus-work-result'])
  assert.match(textOf(target.delivered[1]), /not an instruction from the user[\s\S]*built THEME-BLUE/)
})

test('a supervisor that cannot accept a mirrored input does not consume it', () => {
  const target = supervisor()
  const worker = session('w')
  const r = relay(target)
  const event = admit(worker, 'next-step', userInput('retry me'))
  target.fail = true
  assert.throws(() => r.observe(worker, event), /unavailable/)
  target.fail = false
  r.observe(worker, event)
  assert.equal(target.delivered.length, 1)
  assert.doesNotMatch(textOf(target.delivered[0]), /edited/)
})

// Dispatches are user messages carrying the Nexus marker (ticket 13, ADR 0004); older logs hold the nexus-dispatch source.
const dispatch = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', via: 'nexus', supervisorId: 'sup', callId: `call-${text}` } })
const legacyDispatch = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'nexus-dispatch', sessionId: 'sup', callId: `call-${text}` } })

test('a Nexus dispatch is not mirrored as direct user input in either form; the user typing into the same session still is, across a restart', () => {
  const target = supervisor()
  const worker = session('w')
  const r = relay(target)
  r.observe(worker, admit(worker, 'next-turn', dispatch('build the login page')))
  r.observe(worker, admit(worker, 'next-step', dispatch('also add a logout button')))
  r.observe(worker, admit(worker, 'next-step', legacyDispatch('older dispatch on disk')))
  assert.equal(target.delivered.length, 0)
  const typed = userInput('use THEME-AMBER for the page')
  r.observe(worker, admit(worker, 'next-step', typed))
  assert.deepEqual(target.delivered.map(message => [message.source.kind, message.source.messageId]), [['nexus-user-input', typed.id]])
  for (const message of target.delivered) target.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [message] })
  const restarted = relay(target)
  for (const event of worker.snapshotEvents()) restarted.observe(worker, event)
  restarted.observe(worker, admit(worker, 'next-turn', dispatch('after restart')))
  restarted.observe(worker, admit(worker, 'next-turn', legacyDispatch('legacy after restart')))
  assert.equal(target.delivered.length, 1)
})
