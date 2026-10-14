import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, copyFile, symlink, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { startHost } from './host-process.mjs'

const root = resolve('.')
const delay = ms => new Promise(accept => setTimeout(accept, ms))

test('official Host discovers registered projects across cwd and dispatches to their native workspace', { timeout: 90000 }, async t => {
  await mkdir(resolve('.scratch/nexus-v1'), { recursive: true })
  const dir = await mkdtemp(resolve('.scratch/nexus-v1/workspace-discovery-'))
  const home = resolve(dir, 'home')
  const profile = resolve(home, 'profiles/nexus-workspace')
  const fixture = resolve(dir, 'probe')
  const supervisorCwd = resolve(dir, 'supervisor')
  const target = resolve(dir, 'folder-with-unrelated-name')
  const empty = resolve(dir, 'empty')
  const report = resolve(dir, 'result.json')
  for (const path of [fixture, supervisorCwd, target, empty, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) })
  await new Promise(accept => server.once('listening', accept))
  const wire = []
  let callCount = 0
  let connections = 0
  server.on('connection', socket => {
    const connection = ++connections
    const history = []
    let scenario
    let stage = 0
    const send = event => socket.send(JSON.stringify(event))
    const reply = text => { send({ type: 'response.text.delta', delta: text }); send({ type: 'response.done', response: { status: 'completed' } }) }
    const call = (name, args) => {
      const item = { type: 'function_call', call_id: `workspace-call-${++callCount}`, name, arguments: JSON.stringify(args) }
      send({ type: 'response.function_call_arguments.done', ...item })
      send({ type: 'response.done', response: { status: 'completed', output: [item] } })
    }
    send({ type: 'session.created' })
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      wire.push({ connection, ...event })
      if (event.type === 'session.update') send({ type: 'session.updated', session: event.session })
      if (event.type === 'conversation.item.create') history.push(event.item)
      if (event.type !== 'response.create') return
      send({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } })
      if (!scenario) scenario = history.slice(history.findLastIndex(item => item.role === 'assistant') + 1).findLast(item => item.role === 'user' && /WORKSPACE-/.test(item.content?.[0]?.text))?.content[0].text
      if (!scenario) return reply('Work result received.')
      if (stage++ === 0) return call('nexus_list_workspaces', {})
      const answer = JSON.parse(history.findLast(item => item.type === 'function_call_output').output)
      if (scenario.startsWith('WORKSPACE-DISPATCH') && stage === 2 && !answer.isError) {
        const projects = JSON.parse(answer.content[0].text).items
        const project = projects.find(item => item.title === 'dsh-nexus')
        if (project) return call('nexus_create_session', { cwd: project.path, text: 'run-workspace-discovery' })
      }
      reply(answer.isError ? 'Query failed; no target guessed.' : 'Native project lookup completed.')
    })
  })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-workspace-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/workspace-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-workspace-probe\n      name: nexus-workspace-probe\n      config:\n        report: ${JSON.stringify(report)}\n        target: ${JSON.stringify(target)}\n        empty: ${JSON.stringify(empty)}\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-workspace-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-workspace-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    voiceMode: realtime\n    credentialRef: NEXUS_WORKSPACE_FIXTURE_KEY\n    endpoint: ws://127.0.0.1:${server.address().port}\n`)
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_WORKSPACE_FIXTURE_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' }
  let output = ''
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-workspace', '--port', '0', '--no-open'], { cwd: supervisorCwd, env }, async child => {
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    for (const start = Date.now(); Date.now() - start < 60000; await delay(100)) {
      try { return { result: JSON.parse(await readFile(report, 'utf8')) } } catch {}
      if (child.exitCode !== null) break
    }
    throw new Error(`No workspace report (exit ${child.exitCode}): ` + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
  })
  t.after(() => host.close())
  const result = host.result
  await writeFile(resolve(dir, 'wire.json'), JSON.stringify(wire))
  await writeFile(resolve(dir, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]'))
  console.log('workspace discovery evidence:', dir)
  assert.equal(result.error, undefined, result.stack)
  const schemas = wire.filter(event => event.type === 'session.update')
  const text = schemas.find(event => !event.session.modalities.includes('audio'))
  const voice = schemas.find(event => event.session.modalities.includes('audio'))
  for (const update of [text, voice]) {
    assert.ok(update?.session.tools.some(tool => tool.name === 'nexus_list_workspaces'), 'project query is available in text and voice')
    assert.match(update.session.instructions, /first call nexus_list_workspaces/)
    assert.match(update.session.instructions, /returned absolute path as cwd in nexus_create_session/)
    assert.match(update.session.instructions, /unknown or ambiguous, ask the user/)
    assert.match(update.session.instructions, /Do not use glob.*web_search/)
    assert.match(update.session.instructions, /explicit absolute directory remains usable/)
  }
  const results = result.events.filter(event => event.type === 'tool/result')
  const queries = result.events.filter(event => event.type === 'tool/call' && event.data.name === 'nexus_list_workspaces')
  const answers = queries.map(query => results.find(event => event.data.message.toolCallId === query.data.callId).data.message)
  assert.equal(answers[0].isError, false, 'registered-project query must succeed')
  const first = JSON.parse(answers[0].content[0].text).items
  assert.deepEqual(first.find(item => item.id === result.targetId), { id: result.targetId, title: '侧栏登记项目', path: target })
  assert.ok(first.some(item => item.id === result.emptyId && item.title === '空白项目' && item.path === empty))
  assert.deepEqual(result.after, result.before, 'lookup does not create, rename or remove projects or sessions')
  const second = JSON.parse(answers[1].content[0].text).items
  assert.equal(second.find(item => item.id === result.targetId).title, 'dsh-nexus', 'next lookup sees the native rename')
  assert.equal(answers[2].isError, true)
  assert.match(answers[2].content[0].text, /Workspace registry fixture failure/)
  assert.equal(result.header.cwd, supervisorCwd)
  assert.equal(result.workers.length, 1)
  const worker = result.workers[0]
  assert.equal(worker.header.cwd, target)
  assert.equal(worker.header.origin, undefined)
  assert.equal(worker.header.parentSession, undefined)
  assert.ok(result.final.workspaces.find(item => item.id === result.targetId).sessionIds.includes(worker.id), 'created session belongs to the registered project')
  assert.deepEqual(result.final.workspaces.find(item => item.id === result.emptyId), result.before.workspaces.find(item => item.id === result.emptyId))
  assert.deepEqual(await readdir(empty), [], 'blank registered project remains blank')
  assert.ok(worker.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.via === 'nexus' && event.data.content[0].text === 'run-workspace-discovery'))
  assert.equal(worker.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(await readFile(resolve(target, 'workspace-task.txt'), 'utf8'), 'run-workspace-discovery')
  assert.match(worker.events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, /Executed in target workspace/)
  assert.ok(result.released)
})
