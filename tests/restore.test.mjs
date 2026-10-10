import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, symlink, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

const root = resolve('.')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function restartedProfile(scenario) {
  const home = resolve('.scratch/nexus-v1', 'restore-' + scenario + '-' + Date.now())
  const profile = resolve(home, 'profiles/nexus-restore')
  const fixture = resolve(home, 'probe')
  const real = scenario === 'real'
  const code = '晨星' + Math.floor(Math.random() * 1000000)
  const first = real ? `请记住我的测试暗号是${code}。只回复已记住。` : 'My restart code is ORCHID-72. Remember it.'
  const second = real ? '我刚才给你的测试暗号是什么？只回复暗号。' : 'What was my restart code?'
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const requests = []
  server.on('connection', socket => {
    const history = []
    let answered = 0
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'conversation.item.create') history.push(event.item)
      if (event.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } }))
        // A request whose new items are only automatic worker results or mirrored worker input is not a scenario prompt; one that also carries other input is.
        const fresh = history.slice(Math.max(answered, history.findLastIndex(item => item.role === 'assistant') + 1)).filter(item => !item.content?.[0]?.text.includes('Current runtime context'))
        answered = history.length
        if (fresh.length && fresh.every(item => item.type === 'message' && item.role === 'user' && /Automatic work-session result|Direct user input in a work session/.test(item.content[0].text))) {
          socket.send(JSON.stringify({ type: 'response.text.delta', delta: 'Result noted.' }))
          return socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
        }
        requests.push(history)
        if (scenario === 'active-exit' && requests.length === 2) return
        const remembered = history.some(item => item.content.some(part => part.text === first))
        socket.send(JSON.stringify({ type: 'response.text.delta', delta: remembered ? 'ORCHID-72' : 'Missing history' }))
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
      }
    })
  })
  await mkdir(resolve(profile, 'node_modules'), { recursive: true })
  await mkdir(fixture, { recursive: true })
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-restore-probe'), 'junction')
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-restore-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/restore-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-restore-probe'] } } }))
  const reports = []
  let child
  try {
    for (const phase of [1, 2, ...(scenario === 'interrupt' ? [3] : [])]) {
      const report = resolve(home, `phase-${phase}.json`)
      await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-restore-probe\n      name: nexus-restore-probe\n      config:\n        scenario: ${scenario}\n        phase: ${phase}\n        prompt: ${JSON.stringify(phase === 1 ? first : second)}\n        report: ${JSON.stringify(report)}\n`)
      await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  disabled: ${scenario === 'race' && phase === 2}\n  config:\n    credentialRef: NEXUS_RESTORE_KEY\n    endpoint: ${real ? process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' : `ws://127.0.0.1:${server.address().port}`}\n    timeoutMs: 30000\n`)
      child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-restore', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_RESTORE_KEY: real ? process.env.NEXUS_RESTORE_KEY : 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      let result
      for (let i = 0; i < 500; i++) {
        try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {}
        if (child.exitCode !== null) break
        await delay(100)
      }
      assert.ok(result, 'no restart report: ' + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-3500))
      assert.equal(result.error, undefined, result.stack)
      reports.push(result)
      if (result.crashReady) child.kill('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)])
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'previous Host must exit before launching its replacement')
      if (!result.crashReady) assert.equal(child.exitCode, 0)
    }
    await writeFile(resolve(home, 'result.json'), JSON.stringify({ reports, requests }))
    console.log('restart evidence:', home)
    return { reports, requests, code, second }
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL')
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}

for (const scenario of ['normal', 'reload', 'race', 'interrupt', 'active-exit']) {
  test(`official Host new-process restore: ${scenario}`, { timeout: 120000 }, async () => {
    const { reports, requests, second: secondPrompt } = await restartedProfile(scenario)
    const [first, second, third] = reports
    assert.notEqual(first.pid, second.pid)
    assert.equal(second.id, 'nexus-supervisor')
    assert.equal(second.model, 'qwen3.8-omni-flash-realtime')
    assert.equal(second.initialStatus, 'idle')
    assert.ok(second.released)
    assert.deepEqual(second.events, second.persisted)
    assert.deepEqual(second.before.slice(0, first.events.length), first.events)
    assert.deepEqual(second.events.map(event => event.seq), second.events.map((_, index) => index))
    assert.equal(second.events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, 'ORCHID-72')
    // Each phase's worker prompt is mirrored once and its turn relayed once, each waking the supervisor once
    // (the fixture worker answers only after the mirror is handled); nothing else runs on its own.
    // Interrupt: the recovered "Pending clarification" joins the phase-2 mirror turn, so that request counts as a prompt.
    // Active-exit: the unanswered interrupted input is replayed beside the phase-2 mirror, so that request counts too.
    assert.equal(requests.length, ['interrupt', 'active-exit'].includes(scenario) ? 4 : 2)
    const recall = requests.find(history => history.some(item => item.role === 'user' && item.content[0].text === secondPrompt))
    assert.ok(recall?.some(item => item.role === 'assistant' && item.content[0].text === 'ORCHID-72'), 'the new-process prompt carries the previous process history')
    if (scenario === 'interrupt') assert.ok(requests[1].some(item => item.role === 'user' && item.content[0].text === 'Pending clarification'))
    if (scenario === 'active-exit') assert.ok(requests[2].some(item => item.role === 'user' && item.content[0].text === 'Interrupted active request'))
    const turnOf = seq => second.events.findLast(event => event.type === 'turn/start' && event.seq < seq).data.turn
    const results = second.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result')
    const exited = ['interrupt', 'active-exit'].includes(scenario)
    assert.deepEqual(results.map(event => [event.data.source.turn, turnOf(event.seq)]), [[1, 2], [2, exited ? 6 : 5]])
    const mirrors = second.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'nexus-user-input')
    assert.deepEqual(mirrors.map(event => [event.data.source.sessionId, turnOf(event.seq)]), [['restore-worker', 1], ['restore-worker', exited ? 5 : 4]], 'one mirror per phase; the restart does not repeat the first')
    assert.deepEqual(second.events.filter(event => event.type === 'turn/start').map(event => event.data.turn), exited ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6])
    assert.ok(second.models.every(model => model === 'qwen3.8-omni-flash-realtime'))
    if (scenario === 'race') assert.match(second.raceError, /Unknown agent preset: nexus/)
    if (scenario === 'active-exit') assert.equal(second.before.findLast(event => event.type === 'turn/end').data.reason.kind, 'interrupted')
    if (scenario === 'interrupt') {
      assert.equal(second.before.findLast(event => event.type === 'turn/end').data.reason.kind, 'interrupted')
      assert.deepEqual(second.before.filter(event => event.type === 'tool/result').map(event => event.data.error.code), ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'])
      assert.equal(third.before.filter(event => event.type === 'tool/result').length, 2, 'second restart must not add duplicate repair')
      assert.deepEqual(third.before.slice(0, second.events.length), second.events)
      assert.ok(third.before.slice(second.events.length).every(event => event.type === 'session/end-seed'))
    }
  })
}

test('real DashScope recalls previous-process context after Host restart', { skip: process.env.NEXUS_REAL_TEST !== '1', timeout: 120000 }, async () => {
  const { reports, code } = await restartedProfile('real')
  const [first, second] = reports
  assert.notEqual(first.pid, second.pid)
  assert.equal(first.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.ok(first.events.some(event => event.type === 'assistant/message' && event.data.message.source.model === 'qwen3.8-omni-flash-realtime'))
  assert.deepEqual(second.before.slice(0, first.events.length), first.events)
  assert.ok(second.before.slice(first.events.length).every(event => event.type === 'session/end-seed'))
  assert.ok(first.released && second.released)
  assert.equal(second.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(second.events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, code)
})
