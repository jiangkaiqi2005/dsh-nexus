import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, symlink, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

const root = resolve('.')
const cli = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function profileTurn(scenario) {
  const home = resolve('.scratch/nexus-v1', scenario + '-' + Date.now())
  const profile = resolve(home, 'profiles/nexus-test')
  const report = resolve(home, 'result.json')
  const fixture = resolve(home, 'probe')
  const real = scenario === 'real'
  const prompt = real ? '请只回复“Nexus 已接入”，不要输出其他文字。' : 'Hello Nexus'
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(resolve => server.once('listening', resolve))
  const wire = []
  let connections = 0
  server.on('connection', socket => {
    const connection = ++connections
    if (scenario === 'closed') return socket.close()
    if (scenario === 'timeout') return
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); wire.push({ ...event, connection })
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } }))
        socket.send(JSON.stringify({ type: 'response.text.delta', delta: 'Nexus profile reply' }))
        socket.send(JSON.stringify({ type: 'response.done', response: { status: scenario === 'failed' ? 'failed' : 'completed' } }))
      }
    })
  })
  await mkdir(fixture, { recursive: true })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-verification-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-verification-probe\n      name: nexus-verification-probe\n      config:\n        report: ${JSON.stringify(report)}\n        prompt: ${JSON.stringify(prompt)}\n        scenario: ${scenario}\n        module: ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)}\n`)
  await copyFile(resolve('tests/probe.js'), resolve(fixture, 'index.js'))
  await mkdir(resolve(profile, 'node_modules'), { recursive: true })
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-verification-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-verification-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  disabled: ${scenario === 'late-conflict' || scenario.startsWith('storage-')}\n  config:\n    voiceMode: realtime\n    credentialRef: ${real ? process.env.NEXUS_REAL_CREDENTIAL_REF ?? 'Qiyu_API_KEY' : scenario === 'missing' ? 'NEXUS_MISSING_KEY' : 'NEXUS_TEST_KEY'}\n    endpoint: ${real ? process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' : `ws://127.0.0.1:${server.address().port}`}\n    timeoutMs: ${real ? 30000 : 500}\n`)
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_TEST_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' }
  delete env.NEXUS_MISSING_KEY
  const child = spawn(process.execPath, [cli, '--profile', 'nexus-test', '--port', '0', '--no-open'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  try {
    let result
    for (let i = 0; i < 450; i++) { try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {} if (child.exitCode !== null) break; await delay(100) }
    assert.ok(result, `profile did not produce a report (exitCode=${child.exitCode}, signalCode=${child.signalCode}): ` + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-6000))
    assert.equal(result.error, undefined, result.stack)
    if (scenario === 'late-conflict' || scenario.startsWith('storage-')) return { ...result, wire, report }
    // The ordinary worker's finished turn is delivered to the supervisor first; every scenario
    // assertion below concerns the events and wire after that settled baseline.
    const all = result.events
    assert.ok(Number.isSafeInteger(result.baseline))
    assert.ok(all.some(event => event.type === 'user/message' && event.seq < result.baseline && event.data.source.kind === 'nexus-work-result'))
    result.events = all.filter(event => event.seq >= result.baseline)
    result.turnOffset = all.filter(event => event.type === 'turn/start' && event.seq < result.baseline).length
    assert.equal(result.agentId, result.sessionId)
    assert.equal(result.workerIsSupervisor, false)
    assert.equal(result.workerModel, 'ordinary-model')
    assert.ok(result.workerEvents.some(event => event.type === 'assistant/message' && event.data.message.content[0].text === 'Ordinary worker reply'))
    assert.ok(result.duplicateRejected)
    assert.ok(result.writerRejected)
    assert.ok(result.released)
    if (!['cancel-retain', 'cancel-replace', 'stop-before-wake', 'stopping-steer', 'stopping-cancel'].includes(scenario)) {
      assert.equal(result.events.filter(event => event.type === 'turn/start').length, 1)
      assert.equal(result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1)
      assert.ok(result.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.content[0].text === prompt))
    }
    assert.deepEqual(all.map(event => event.seq), Array.from({ length: all.length }, (_, index) => index))
    // The supervisor opens one connection per requesting turn, so the pre-baseline turns own the first connections.
    const opened = all.filter(event => event.type === 'step/start' && event.data.step === 1 && event.seq < result.baseline).length
    const early = wire.filter(event => event.connection <= opened)
    if (!['missing', 'closed', 'timeout', 'real'].includes(scenario)) assert.ok(early.some(event => event.type === 'conversation.item.create' && event.item.content?.[0]?.text.includes('Automatic work-session result')), 'pre-baseline connections carried the worker result')
    return { ...result, all, wire: wire.filter(event => event.connection > opened), report }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)])
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}

test('official profile records a text turn, preserves the ordinary factory and releases identity and writer', { timeout: 60000 }, async () => {
  const result = await profileTurn('success')
  assert.ok(result.events.some(event => event.type === 'assistant/message' && event.data.message.content[0].text === 'Nexus profile reply'))
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.deepEqual(result.wire.find(event => event.type === 'session.update').session.modalities, ['text'])
  assert.ok(result.wire.some(event => event.type === 'conversation.item.create' && event.item.content[0].text === 'Hello Nexus'))
})

test('cancel before admission preserves queued and steering input when keepInbox is set', { timeout: 60000 }, async () => {
  const result = await profileTurn('cancel-retain')
  assert.equal(result.pending.queued.length, 1)
  assert.equal(result.pending.steering.length, 1)
  assert.equal(result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 0)
  assert.equal(result.events.filter(event => event.type === 'step/start').length, 0)
  assert.deepEqual(result.events.filter(event => event.type === 'turn/end').map(event => event.data.reason), [{ kind: 'aborted', reason: { kind: 'user' } }])
  assert.equal(result.wire.length, 0)
})

test('new input after cancel runs in a fresh turn instead of the cancelled wake', { timeout: 60000 }, async () => {
  const result = await profileTurn('cancel-replace')
  assert.deepEqual(result.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['aborted', 'completed'])
  assert.deepEqual(result.events.filter(event => event.type === 'step/start').map(event => event.data), [{ turn: 2 + result.turnOffset, step: 1 }])
  assert.deepEqual(result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').map(event => event.data.content[0].text), ['Hello Nexus'])
  assert.equal(result.events.filter(event => event.type === 'assistant/message').length, 1)
  assert.equal(result.pending.queued.length + result.pending.steering.length, 0)
})

test('stop before admission records an aborted empty turn without a model call', { timeout: 60000 }, async () => {
  const result = await profileTurn('stop-before-wake')
  assert.deepEqual(result.events.filter(event => event.type === 'turn/end').map(event => event.data.reason), [{ kind: 'aborted', reason: { kind: 'disposed' } }])
  assert.equal(result.events.filter(event => event.type === 'step/start').length, 0)
  assert.equal(result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 0)
  assert.equal(result.wire.length, 0)
})

test('turn-stopping steering continues at the next step of the same turn', { timeout: 60000 }, async () => {
  const result = await profileTurn('stopping-steer')
  assert.equal(result.events.filter(event => event.type === 'turn/start').length, 1)
  assert.deepEqual(result.events.filter(event => event.type === 'step/start').map(event => event.data), [{ turn: 1 + result.turnOffset, step: 1 }, { turn: 1 + result.turnOffset, step: 2 }])
  assert.deepEqual(result.events.filter(event => event.type === 'assistant/message').map(event => [event.data.turn, event.data.step]), [[1 + result.turnOffset, 1], [1 + result.turnOffset, 2]])
  assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
})

test('cancel at turn-stopping records an aborted terminal even after a model reply', { timeout: 60000 }, async () => {
  const result = await profileTurn('stopping-cancel')
  assert.equal(result.events.filter(event => event.type === 'assistant/message').length, 1)
  assert.deepEqual(result.events.filter(event => event.type === 'turn/end').map(event => event.data.reason), [{ kind: 'aborted', reason: { kind: 'user' } }])
})

test('late native session publication rejects Nexus startup and releases its acquired writer', { timeout: 60000 }, async () => {
  const result = await profileTurn('late-conflict')
  assert.match(result.startupError, /nexus-supervisor.*already exists/)
  assert.ok(result.competitorPreserved)
  assert.equal(result.supervisorPublished, false)
  assert.equal(result.header.id, 'nexus-supervisor')
  assert.deepEqual(result.events, [])
  assert.equal(result.wire.length, 0)
})

for (const [scenario, error] of [['owned', 'SessionAlreadyOwnedError'], ['corrupt', 'SessionPersistenceCorruptionError']]) {
  test(`official profile rejects ${scenario} supervisor storage without creating or replacing its record`, { timeout: 60000 }, async () => {
    const result = await profileTurn(`storage-${scenario}`)
    assert.equal(result.startupErrorName, error)
    assert.equal(result.supervisorPublished, false)
    assert.equal(result.preserved, true, 'the owned log or malformed artifact remains unchanged')
    assert.equal(result.wire.length, 0, 'failed activation never calls the model')
    console.log('storage refusal evidence:', result.report)
  })
}

for (const [scenario, code] of [['missing', 'CREDENTIAL_MISSING'], ['closed', 'CONNECTION_CLOSED'], ['timeout', 'TIMEOUT'], ['failed', 'RESPONSE_FAILED']]) {
  test(`official profile reports ${code} without a completed turn or fake assistant`, { timeout: 60000 }, async () => {
    const result = await profileTurn(scenario)
    const reason = result.events.findLast(event => event.type === 'turn/end').data.reason
    assert.equal(reason.kind, 'error')
    assert.equal(reason.error.code, code)
    assert.equal(result.events.filter(event => event.type === 'assistant/message').length, 0)
    if (scenario === 'failed') assert.ok(result.events.some(event => event.type === 'assistant/attempt'))
  })
}

test('real DashScope text-only turn through the official Host profile', { skip: process.env.NEXUS_REAL_TEST !== '1', timeout: 60000 }, async () => {
  const result = await profileTurn('real')
  const reason = result.events.findLast(event => event.type === 'turn/end').data.reason
  assert.equal(reason.kind, 'completed', JSON.stringify(reason))
  const message = result.events.find(event => event.type === 'assistant/message').data.message
  assert.equal(message.source.model, 'qwen3.8-omni-flash-realtime')
  assert.match(message.content[0].text, /Nexus.*已接入/)
  console.log('real native log:', result.report)
})
