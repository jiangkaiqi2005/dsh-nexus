import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { startHost } from './host-process.mjs'

const delay = ms => new Promise(accept => setTimeout(accept, ms))

test('Nexus archives running work with native stops, protects the main conversation and preserves reversible history', { timeout: 120000 }, async t => {
  const root = resolve('.')
  const home = resolve('.scratch/cascade-voice', `archive-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-archive')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  const report = resolve(home, 'result.json')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(accept => server.close(accept)) })
  const wire = []
  server.on('connection', socket => {
    const history = []
    const called = new Set()
    const send = event => socket.send(JSON.stringify(event))
    send({ type: 'session.created' })
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); wire.push(event)
      if (event.type === 'session.update') send({ type: 'session.updated', session: event.session })
      if (event.type === 'conversation.item.create') history.push(event.item)
      if (event.type !== 'response.create') return
      send({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } })
      const command = history.findLast(item => item.role === 'user' && /^ARCHIVE-/.test(item.content?.[0]?.text))?.content[0].text
      if (command && !called.has(command)) {
        called.add(command)
        const sessionId = command === 'ARCHIVE-MAIN' ? 'nexus-supervisor' : command === 'ARCHIVE-MISSING' ? 'missing-session' : 'archive-worker'
        const item = { type: 'function_call', call_id: command, name: 'nexus_archive_session', arguments: JSON.stringify({ sessionId }) }
        send({ type: 'response.function_call_arguments.done', ...item })
        return send({ type: 'response.done', response: { status: 'completed', output: [item] } })
      }
      send({ type: 'response.text.delta', delta: 'Native archive result received.' })
      send({ type: 'response.done', response: { status: 'completed' } })
    })
  })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-archive-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/archive-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: archive-schedule\n      name: '@deepseek-ai/dsh-schedule'\n    - id: nexus-archive-probe\n      name: nexus-archive-probe\n      config:\n        report: ${JSON.stringify(report)}\n        workspace: ${JSON.stringify(workspace)}\n`)
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-archive-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-archive-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_ARCHIVE_FIXTURE_KEY\n    endpoint: ws://127.0.0.1:${server.address().port}\n`)
  let output = ''
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-archive', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_ARCHIVE_FIXTURE_KEY: 'fixture-not-a-secret', DEEPSEEK_API_KEY: '', DSH_TELEMETRY: '0' } }, async child => {
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    for (const start = Date.now(); Date.now() - start < 90000; await delay(100)) {
      try { return { result: JSON.parse(await readFile(report, 'utf8')) } } catch {}
      if (child.exitCode !== null) break
    }
    await writeFile(resolve(home, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]'))
    throw new Error('No archive report: ' + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
  })
  t.after(() => host.close())
  await writeFile(resolve(home, 'wire.json'), JSON.stringify(wire))
  await writeFile(resolve(home, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]'))
  console.log('archive evidence:', home)
  const result = host.result
  assert.equal(result.error, undefined, result.stack)
  assert.equal(result.before.status, 'running')
  assert.equal(result.before.jobs[0].status, 'running')
  assert.equal(result.before.schedules.length, 1)
  assert.deepEqual(result.archived.ids, ['archive-worker'])
  assert.equal(result.archived.status, 'idle')
  assert.equal(result.archived.state.events.find(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  assert.equal(result.archived.jobs[0].status, 'killed')
  assert.equal(result.archived.processExited, true)
  assert.deepEqual(result.archived.schedules, [])
  const answers = result.supervisor.events.filter(event => event.type === 'tool/result').map(event => event.data.message)
  for (const id of ['ARCHIVE-RUNNING', 'ARCHIVE-AGAIN']) {
    const answer = answers.find(message => message.toolCallId === id)
    assert.equal(answer.isError, false)
    assert.deepEqual(JSON.parse(answer.content[0].text), { sessionId: 'archive-worker', archived: true })
  }
  for (const id of ['ARCHIVE-MAIN', 'ARCHIVE-MISSING']) assert.equal(answers.find(message => message.toolCallId === id).isError, true)
  assert.match(answers.find(message => message.toolCallId === 'ARCHIVE-MAIN').content[0].text, /main conversation/)
  assert.match(answers.find(message => message.toolCallId === 'ARCHIVE-MISSING').content[0].text, /missing-session/)
  assert.deepEqual(result.afterErrors, ['archive-worker'])
  assert.deepEqual(result.restored.ids, [])
  assert.ok(result.restored.state.events.some(event => event.type === 'user/message' && event.data.content[0].text === 'hold-until-archive'))
  assert.equal(result.restored.state.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.match(result.restored.state.events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, /Conversation resumed/)
  for (const audio of [false, true]) {
    const update = wire.find(event => event.type === 'session.update' && event.session.modalities.includes('audio') === audio)
    assert.ok(update?.session.tools.some(tool => tool.name === 'nexus_archive_session'))
    assert.match(update.session.instructions, /clean up.*nexus_archive_session/)
    assert.match(update.session.instructions, /do not ask work sessions to delete.*data/i)
    assert.match(update.session.instructions, /only supports archiving.*not deletion/)
  }
})
