import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

const delay = ms => new Promise(accept => setTimeout(accept, ms))
const root = resolve('.')

async function dispatchProfile(real = false) {
  const home = resolve('.scratch/nexus-v1', `dispatch-${real ? 'real' : 'controlled'}-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-dispatch')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  const report = resolve(home, 'result.json')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  const wire = []
  const plan = [
    ['nexus_list_sessions', {}], ['nexus_read_session', { sessionId: 'user-existing' }],
    ['nexus_send_session', { sessionId: 'user-existing', text: 'run-existing' }],
    ['nexus_create_session', { cwd: workspace, text: 'run-new' }],
    ['nexus_send_session', { sessionId: 'missing-target', text: 'must-fail' }],
    ['nexus_read_session', '{bad json'], ['fixture_native_capability', { value: 'full-native-ability' }],
    ['nexus_send_session', { sessionId: 'busy-worker', text: 'steered-task' }],
    ['nexus_stop_session', { sessionId: 'stop-worker' }],
    ['fixture_native_capability', { value: 'denied-by-native-policy' }],
    ['read', { file_path: resolve(workspace, 'user-existing.txt') }],
    ['nexus_read_session', { sessionId: 'cold-child' }],
    ['nexus_send_session', { sessionId: 'cold-child', text: 'run-cold-child' }],
  ]
  let request = 0
  let connections = 0
  const produced = new Map()
  server.on('connection', socket => {
    const connection = ++connections
    const history = []
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); wire.push({ ...event, connection })
      if (event.type === 'conversation.item.create' && event.item.type === 'function_call_output') assert.equal(produced.get(event.item.call_id), connection, 'tool result must answer its original connection call')
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'conversation.item.create') history.push(event.item)
      if (event.type === 'response.create') {
        const next = plan[request++]
        if (next) {
          const [name, args] = next
          const item = { type: 'function_call', call_id: `dispatch-call-${request}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
          produced.set(item.call_id, connection)
          socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', ...item }))
          socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [item] } }))
        } else {
          assert.ok(history.some(item => item.type === 'function_call_output' && item.call_id === 'dispatch-call-5' && JSON.parse(item.output).isError))
          socket.send(JSON.stringify({ type: 'response.text.delta', delta: 'Dispatch accepted, one target failed; completion requires worker records.' }))
          socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
        }
      }
    })
  })
  const prompt = real ? `请实际使用工具完成测试：先列出工作会话，读取已有普通会话user-existing的上下文，向它发送任务“run-existing-real”；再在工作区${workspace}新建普通会话并发送任务“run-new-real”；随后尝试向不存在的missing-target发送任务（预期失败）。以工具结果为据，简短说明哪些派活已接受及哪个失败，不要将接受说成完成。` : 'Dispatch to existing and new native sessions; exercise steering, stopping, failure and full configured capabilities.'
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-dispatch-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/dispatch-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-dispatch-probe\n      name: nexus-dispatch-probe\n      config:\n        report: ${JSON.stringify(report)}\n        workspace: ${JSON.stringify(workspace)}\n        real: ${real}\n        prompt: ${JSON.stringify(prompt)}\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-dispatch-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-dispatch-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_DISPATCH_KEY\n    endpoint: ${real ? process.env.NEXUS_REAL_ENDPOINT ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' : `ws://127.0.0.1:${server.address().port}`}\n    timeoutMs: 30000\n`)
  const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-dispatch', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, NEXUS_DISPATCH_KEY: real ? process.env.NEXUS_DISPATCH_KEY : 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  try {
    let result
    for (let i = 0; i < 1800; i++) { try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {} if (child.exitCode !== null) break; await delay(100) }
    assert.ok(result, 'no dispatch report: ' + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
    assert.equal(result.error, undefined, result.stack)
    assert.equal(result.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed', JSON.stringify(result.events.findLast(event => event.type === 'turn/end').data.reason))
    assert.ok(result.released)
    if (!real) { assert.equal(connections, 1); await writeFile(resolve(home, 'wire.json'), JSON.stringify(wire)) }
    for (const call of result.events.filter(event => event.type === 'tool/call')) {
      const answer = result.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
      assert.ok(answer)
      assert.deepEqual([answer.data.turn, answer.data.step], [call.data.turn, call.data.step])
    }
    const existing = result.workers.find(item => item.id === 'user-existing')
    assert.equal(existing.ownedByNexus, false)
    assert.equal(existing.header.parentSession, undefined)
    assert.ok(existing.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.content[0].text.includes('ANCHOR-19')))
    assert.ok(existing.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch' && event.data.content[0].text === (real ? 'run-existing-real' : 'run-existing')))
    const created = result.workers.find(item => item.id.startsWith('session-'))
    assert.ok(created)
    assert.equal(created.header.cwd.toLowerCase(), workspace.toLowerCase())
    for (const worker of [existing, created]) {
      assert.equal(worker.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
      assert.match(worker.events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, /Worker executed: run-/)
      assert.match(await readFile(resolve(workspace, `${worker.id}.txt`), 'utf8'), /run-/)
    }
    console.log('dispatch evidence:', report)
    return { ...result, wire }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([new Promise(accept => child.once('exit', accept)), delay(5000)])
    for (const socket of server.clients) socket.terminate()
    await new Promise(accept => server.close(accept))
  }
}

test('official Host native dispatch, complete capabilities, source, steering, cancellation and failed call continuation', { timeout: 120000 }, async () => {
  const result = await dispatchProfile()
  const tools = result.wire.find(event => event.type === 'session.update').session.tools
  assert.ok(tools.some(tool => tool.name === 'fixture_native_capability'))
  assert.ok(tools.some(tool => !tool.name.startsWith('nexus_') && tool.name !== 'fixture_native_capability'))
  assert.ok(result.wire.filter(event => event.type === 'session.update').every(event => JSON.stringify(event.session.modalities) === '["text"]'))
  const results = result.events.filter(event => event.type === 'tool/result')
  assert.deepEqual(results.filter(event => event.data.message.isError).map(event => event.data.message.toolCallId), ['dispatch-call-5', 'dispatch-call-6', 'dispatch-call-10'])
  assert.ok(results.find(event => event.data.message.toolCallId === 'dispatch-call-11').data.message.content.some(part => part.type === 'text' && part.text.includes('run-existing')))
  assert.ok(results.some(event => event.data.message.content[0].text === 'full-native-ability'))
  const busy = result.workers.find(item => item.id === 'busy-worker')
  assert.ok(busy.events.some(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step' && event.data.inserted.some(message => message.source.kind === 'nexus-dispatch')))
  assert.match(busy.events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, /steered-task/)
  const stopped = result.workers.find(item => item.id === 'stop-worker')
  assert.equal(stopped.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  assert.ok(result.coldChildPrepared)
  const child = result.workers.find(item => item.id === 'cold-child')
  assert.equal(child.header.parentSession, 'cold-parent')
  assert.equal(child.ownedByNexus, false)
  assert.ok(child.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch' && event.data.content[0].text === 'run-cold-child'))
  assert.equal(child.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(await readFile(resolve(child.header.cwd, 'cold-child.txt'), 'utf8'), 'run-cold-child')
})

test('accurate Realtime model dispatches existing and new native workers and reports a failed target', { skip: process.env.NEXUS_REAL_DISPATCH !== '1', timeout: 240000 }, async () => {
  const result = await dispatchProfile(true)
  for (const name of ['nexus_list_sessions', 'nexus_read_session', 'nexus_send_session', 'nexus_create_session']) assert.ok(result.events.some(event => event.type === 'tool/call' && event.data.name === name), name)
  assert.ok(result.events.some(event => event.type === 'tool/result' && event.data.message.isError))
  const final = result.events.findLast(event => event.type === 'assistant/message').data.message
  assert.equal(final.source.model, 'qwen3.8-omni-flash-realtime')
  assert.ok(final.content.some(part => part.type === 'text' && part.text.length))
})
