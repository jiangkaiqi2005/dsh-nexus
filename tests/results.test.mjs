import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ResultRelay } from '../dist/results.js'

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

test('the supervisor never feeds back; its own children and other subagents are relayed per turn', () => {
  const target = supervisor()
  const r = relay(target)
  const self = target.session
  r.observe(self, turn(self, 1, { text: 'my own reply' }))
  const child = session('child', { origin: 'subagent', parentSession: SessionId('sup') })
  r.observe(child, turn(child, 1, { text: 'child first turn' }))
  r.observe(child, turn(child, 2, { reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter registered' } } }))
  const foreign = session('foreign-child', { origin: 'subagent', parentSession: SessionId('other-parent') })
  r.observe(foreign, turn(foreign, 1, { text: 'child of someone else' }))
  assert.deepEqual(target.delivered.map(message => [message.source.sessionId, message.source.turn]), [['child', 1], ['child', 2], ['foreign-child', 1]])
  assert.match(textOf(target.delivered[0]), /subagent of sup\)[\s\S]*child first turn/)
  assert.match(textOf(target.delivered[1]), /Turn: 2 [\s\S]*Outcome: failed - NO_ADAPTER: no adapter registered/)
  assert.match(textOf(target.delivered[2]), /subagent of other-parent/)
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
