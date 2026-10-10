import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, copyFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const delay = ms => new Promise(accept => setTimeout(accept, ms))
const root = resolve('.')
const textOf = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
const isDispatch = source => source.kind === 'user' && source.via === 'nexus'

// Ticket 13 (ADR 0004): dispatches are user messages marked as coming through Nexus, Nexus-created sessions are
// named natively, existing titles stay, dispatches never come back as user steering, and the main session is Nexus.
test('dispatch as marked user input: native naming, unchanged existing titles, no relay of either dispatch form across restarts, main session named Nexus', { timeout: 240000 }, async () => {
  const home = resolve('.scratch/nexus-v1', `titles-${Date.now()}`)
  const profile = resolve(home, 'profiles/nexus-titles')
  const fixture = resolve(home, 'probe')
  const workspace = resolve(home, 'workspace')
  for (const dir of [fixture, workspace, resolve(profile, 'node_modules')]) await mkdir(dir, { recursive: true })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  const sent = []
  const plans = {
    'PHASE-ONE dispatch': () => [
      ['nexus_create_session', { cwd: workspace, text: 'run-titled-new: 实现登录页并写测试' }],
      ['nexus_send_session', { sessionId: 'titled-idle', text: 'run-idle followup from Nexus' }],
      ['nexus_send_session', { sessionId: 'titled-busy', text: 'steered-busy change from Nexus' }],
    ],
    // The probe names the session Nexus created in phase one.
    'PHASE-TWO dispatch': prompt => [['nexus_send_session', { sessionId: prompt.split(' ').at(-1), text: 'run-new phase two from Nexus' }]],
  }
  server.on('connection', socket => {
    const history = []
    let answered = 0
    let queue = []
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      if (event.type === 'conversation.item.create') history.push(event.item)
      if (event.type !== 'response.create') return
      socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp-${crypto.randomUUID()}`, status: 'in_progress' } }))
      const fresh = history.slice(Math.max(answered, history.findLastIndex(item => item.role === 'assistant') + 1)).filter(item => !item.content?.[0]?.text.includes('Current runtime context'))
      answered = history.length
      const prompt = fresh.flatMap(item => item.type === 'message' && item.role === 'user' ? [item.content[0].text] : []).find(text => Object.keys(plans).some(key => text.startsWith(key)))
      if (prompt) queue = plans[Object.keys(plans).find(key => prompt.startsWith(key))](prompt)
      const next = fresh.length && queue.length && !fresh.every(item => item.type === 'message' && /Automatic work-session result|Direct user input in a work session/.test(item.content[0].text)) ? queue.shift() : undefined
      if (next) {
        const item = { type: 'function_call', call_id: `title-call-${sent.length + 1}`, name: next[0], arguments: JSON.stringify(next[1]) }
        sent.push(item)
        socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', ...item }))
        return socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [item] } }))
      }
      socket.send(JSON.stringify({ type: 'response.text.delta', delta: 'Noted.' }))
      socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
    })
  })
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-titles-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await copyFile(resolve('tests/titles-probe.js'), resolve(fixture, 'index.js'))
  await symlink(root, resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(fixture, resolve(profile, 'node_modules/nexus-titles-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-titles-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_TITLES_KEY\n    endpoint: ws://127.0.0.1:${server.address().port}\n    timeoutMs: 30000\n`)
  const reports = []
  const ui = {}
  try {
    for (const phase of [1, 2, 3]) {
      const report = resolve(home, `phase-${phase}.json`)
      await writeFile(resolve(fixture, 'patch.yml'), `- insert:\n    - id: nexus-titles-probe\n      name: nexus-titles-probe\n      config:\n        report: ${JSON.stringify(report)}\n        workspace: ${JSON.stringify(workspace)}\n        phase: ${phase}\n`)
      const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-titles', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_TITLES_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      try {
        let result
        for (let i = 0; i < 1200; i++) { try { result = JSON.parse(await readFile(report, 'utf8')); break } catch {} if (child.exitCode !== null) break; await delay(100) }
        assert.ok(result, `no phase ${phase} report (exit ${child.exitCode}, signal ${child.signalCode}): ` + output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
        assert.equal(result.error, undefined, result.stack)
        reports.push(result)
      } finally {
        child.kill('SIGTERM')
        await Promise.race([new Promise(accept => child.once('exit', accept)), delay(5000)])
      }
    }
    // A fourth Host without the probe serves the native web client: sidebar titles and how dispatches are shown.
    await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus'] } } }))
    const child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'nexus-titles', '--port', '0', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), NEXUS_TITLES_KEY: 'fixture-not-a-secret', DSH_TELEMETRY: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    let browser
    let page
    try {
      let url
      for (let i = 0; i < 300 && !url; i++) { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; await delay(100) }
      assert.ok(url, 'official Host did not start for the web client')
      browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true })
      page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } })
      await page.goto(url)
      const tree = page.getByRole('tree', { name: '会话' })
      // First-run dialogs arrive one after another; dismiss them until the sidebar has been free of them for a while.
      for (let begin = Date.now(), clear = 0; clear < 10; await delay(200)) {
        if (Date.now() - begin > 45000) throw new Error('the sidebar did not become usable')
        clear = (await tree.getByRole('treeitem', { name: /^我的管家/ }).isVisible()) ? clear + 1 : 0
        for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) { clear = 0; await button.click({ timeout: 1000 }).catch(() => {}) } }
      }
      await tree.getByRole('treeitem', { name: /^workspace/ }).click()
      await tree.getByRole('treeitem', { name: /^未分组/ }).click()
      await tree.getByRole('treeitem', { name: /^Title run-titled-new: 实现登录页并写测/ }).waitFor()
      ui.sidebar = await tree.ariaSnapshot()
      await tree.getByRole('treeitem', { name: /^Title run-titled-new/ }).click()
      await page.getByText('Worker executed: run-new phase two from Nexus', { exact: true }).waitFor()
      ui.created = await page.locator('body').ariaSnapshot()
      await page.screenshot({ path: resolve(home, 'ui-created.png') })
      await tree.getByRole('treeitem', { name: /^未命名/ }).click()
      await page.getByRole('button', { name: /^收到执行请求/ }).waitFor()
      ui.legacy = await page.locator('body').ariaSnapshot()
      await page.screenshot({ path: resolve(home, 'ui-legacy.png') })
    } catch (error) {
      if (page) await writeFile(resolve(home, 'ui-failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {})
      throw error
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
      await Promise.race([new Promise(accept => child.once('exit', accept)), delay(5000)])
    }
    await writeFile(resolve(home, 'result.json'), JSON.stringify({ reports, sent, ui }))
    console.log('title evidence:', home)
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise(accept => server.close(accept))
  }
  const [one, two, three] = reports

  // Native web client (the Desktop UI code, headless): sidebar titles, and a dispatch shown as the user's own message
  // where an older nexus-dispatch record still shows as a collapsed execution request.
  assert.match(ui.sidebar, /treeitem "我的管家/)
  assert.match(ui.sidebar, /treeitem "Title run-titled-new: 实现登录页并写测/)
  assert.match(ui.sidebar, /treeitem "Title Existing idle task/)
  assert.match(ui.sidebar, /treeitem "Title hold-busy existing task/)
  assert.match(ui.sidebar, /treeitem "未命名/, 'the older untitled session is not backfilled')
  assert.match(ui.created, /text: "?run-titled-new: 实现登录页并写测试 \d/)
  assert.match(ui.created, /text: "?\d+:\d+ run-new phase two from Nexus \d/)
  assert.doesNotMatch(ui.created, /收到执行请求/)
  assert.match(ui.legacy, /button "收到执行请求/)
  const worker = (report, id) => report.workers.find(item => item.id === id)
  const titles = events => events.filter(event => event.type === 'session/title').map(event => [event.data.title, event.data.source.kind])

  // Main session: created as Nexus; an older fallback title becomes Nexus on restart; a user rename survives a restart.
  assert.deepEqual([one.startup.title?.title, one.startup.title?.source.kind], ['Nexus', 'user'])
  assert.deepEqual([two.startup.title?.title, two.startup.title?.source.kind], ['Nexus', 'user'])
  assert.deepEqual([three.startup.title?.title, three.startup.title?.source.kind], ['我的管家', 'user'])
  assert.ok(three.startup.quiet, 'the restored supervisor appends nothing at startup, its user title included')
  assert.deepEqual(titles(three.events), [['Nexus', 'user'], ['PHASE-ONE dispatch', 'fallback'], ['Nexus', 'user'], ['我的管家', 'user']])
  assert.equal(three.listed.find(item => item.sessionId === 'nexus-supervisor').title, '我的管家', 'the session list (sidebar source) shows the user title')

  // The new session: untitled until the dispatch (a user message with the Nexus marker), then native fallback and model titles.
  const created = one.workers.find(item => item.id.startsWith('session-'))
  const createCall = sent.find(item => item.name === 'nexus_create_session')
  const dispatchText = JSON.parse(createCall.arguments).text
  const dispatchEvent = created.events.find(event => event.type === 'user/message' && isDispatch(event.data.source))
  assert.equal(textOf(dispatchEvent.data), dispatchText, 'the dispatch text is delivered verbatim, without a relay prefix')
  assert.deepEqual(dispatchEvent.data.source, { kind: 'user', via: 'nexus', supervisorId: 'nexus-supervisor', callId: createCall.call_id })
  assert.ok(!created.events.some(event => event.type === 'session/title' && event.seq < dispatchEvent.seq), 'no title before the dispatch')
  assert.deepEqual(titles(created.events), [['run-titled-new: 实现登录页并写测', 'fallback'], ['Title run-titled-new: 实现登录页并写测', 'provider']])
  assert.equal(one.listed.find(item => item.sessionId === created.id).title, 'Title run-titled-new: 实现登录页并写测')
  assert.deepEqual(one.received[created.id][0], [dispatchText], 'the work model receives exactly the dispatched text as the user request')
  // A later dispatch after a restart reaches the now titled session and leaves its title alone.
  assert.ok(worker(three, created.id).events.some(event => event.type === 'user/message' && isDispatch(event.data.source) && textOf(event.data) === 'run-new phase two from Nexus'))
  assert.deepEqual(titles(worker(three, created.id).events), titles(created.events))

  // Existing sessions: idle and running both accept the dispatch, and their titles do not change.
  for (const [id, text, delivery] of [['titled-idle', 'run-idle followup from Nexus', 'followup'], ['titled-busy', 'steered-busy change from Nexus', 'steer']]) {
    const events = worker(three, id).events
    assert.deepEqual(titles(events), titles(worker(one, id).events))
    assert.equal(titles(events).length, 2, `${id} keeps its one native title pair`)
    const call = sent.find(item => item.name === 'nexus_send_session' && JSON.parse(item.arguments).sessionId === id)
    const result = one.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.call_id)
    assert.equal(JSON.parse(textOf(result.data.message)).delivery, delivery)
    assert.ok(events.some(event => event.type === 'user/message' && isDispatch(event.data.source) && textOf(event.data) === text))
    assert.match(textOf(events.findLast(event => event.type === 'assistant/message').data.message), new RegExp(`Worker executed: ${text}`))
  }
  // The older, untitled Nexus session is not backfilled.
  const legacy = worker(three, 'legacy-worker').events
  assert.ok(legacy.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-dispatch'))
  assert.deepEqual(titles(legacy), [])

  // Relay: across three Host runs the supervisor mirrored exactly the user's own inputs to work sessions, each once, and every work turn once.
  const admitted = three.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)
  const mirrored = admitted.filter(message => message.source.kind === 'nexus-user-input').map(message => `${message.source.sessionId}#${message.source.messageId}`)
  const direct = three.workers.flatMap(item => item.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && !isDispatch(event.data.source)).map(event => ({ id: `${item.id}#${event.data.id}`, text: textOf(event.data) })))
  assert.deepEqual(direct.map(item => item.text).sort(), ['Existing idle task', 'hold-busy existing task', 'user-direct ONE: make it blue', 'user-direct TWO: and add a footer'])
  assert.deepEqual([...mirrored].sort(), direct.map(item => item.id).sort())
  const dispatchIds = new Set(three.workers.flatMap(item => item.events.filter(event => event.type === 'user/message' && (isDispatch(event.data.source) || event.data.source.kind === 'nexus-dispatch')).map(event => event.data.id)))
  assert.equal(dispatchIds.size, 5, 'three phase-one dispatches, one phase-two dispatch and the older logged dispatch')
  assert.ok(!mirrored.some(key => dispatchIds.has(key.split('#')[1])))
  const results = admitted.filter(message => message.source.kind === 'nexus-work-result').map(message => `${message.source.sessionId}#${message.source.turn}`)
  assert.equal(new Set(results).size, results.length, 'no work result is delivered twice')
  assert.ok(results.includes('legacy-worker#1'))
})
