import test from 'node:test'
import { openSettings } from './native-settings.mjs'
import assert from 'node:assert/strict'
import { mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startHost } from './host-process.mjs'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const of = (events, type) => events.filter(event => event.type === type)
async function scenario(name, { model, nexus = '', endpoint = 'ws://127.0.0.1:1', interact } = {}) {
  const dir = resolve('.scratch/cascade-voice', `02-${name}-${Date.now()}`)
  const profile = resolve(dir, 'profiles/cascade')
  const probe = resolve(dir, 'probe')
  for (const path of [probe, resolve(profile, 'node_modules')]) await mkdir(path, { recursive: true })
  await copyFile(resolve('tests/cascade-probe.js'), resolve(probe, 'index.js'))
  await writeFile(resolve(probe, 'package.json'), JSON.stringify({ name: 'nexus-cascade-probe', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(resolve(probe, 'patch.yml'), `- insert:\n    - id: cascade-probe\n      name: nexus-cascade-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        scenario: ${name}\n${model ? `        model: ${model}\n` : ''}`)
  await symlink(resolve('.'), resolve(profile, 'node_modules/dsh-nexus'), 'junction')
  await symlink(probe, resolve(profile, 'node_modules/nexus-cascade-probe'), 'junction')
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus', 'nexus-cascade-probe'] } } }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_CASCADE_UNUSED\n    endpoint: ${endpoint}\n    timeoutMs: ${interact ? 3000 : 300}\n${nexus}${interact ? '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n' : ''}`)
  let output = ''
  const host = await startHost(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'cascade', '--port', '0', '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: dir, DSH_AGENTS_HOME: resolve(dir, 'agents'), NEXUS_CASCADE_UNUSED: interact ? 'fixture-not-a-secret' : '', DEEPSEEK_API_KEY: '', DSH_TELEMETRY: '0' } }, async child => {
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    return {}
  })
  try {
    if (interact) {
      let url
      for (const deadline = Date.now() + 15000; !url && Date.now() < deadline; ) { url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; if (!url) await sleep(100) }
      assert.ok(url)
      for (const deadline = Date.now() + 15000; ; ) {
        try { await readFile(resolve(dir, 'ui-ready')); break } catch { if (Date.now() > deadline) throw new Error('controlled default model was not ready'); await sleep(50) }
      }
      await interact(url, dir)
      await writeFile(resolve(dir, 'ui-finish'), '')
    }
    let report
    for (const deadline = Date.now() + 45000; !report && Date.now() < deadline; ) {
      try { report = JSON.parse(await readFile(resolve(dir, 'report.json'), 'utf8')) } catch { await sleep(100) }
    }
    assert.ok(report, output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-4000))
    assert.equal(report.error, undefined, report.stack)
    console.log('cascade evidence:', dir)
    return report
  } finally { await host.close(); await writeFile(resolve(dir, 'host.log'), output.replace(/\?token=\S+/g, '?token=[redacted]')) }
}

test('default cascade uses each current native default model and reasoning, streams text and persists actual attribution and cached usage', { timeout: 60000 }, async () => {
  const report = await scenario('basic')
  assert.deepEqual(report.requests.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [
    { provider: 'cascade-primary', model: 'normal', reasoningEffort: 'high' },
    { provider: 'cascade-secondary', model: 'other', reasoningEffort: 'low' },
  ])
  const replies = of(report.persisted, 'assistant/message')
  assert.deepEqual(replies.map(event => event.data.message.source.provider), ['cascade-primary', 'cascade-secondary'])
  assert.deepEqual(replies.map(event => event.data.message.source.model), ['normal', 'other'])
  assert.ok(replies.every(event => event.data.usage.cacheReadTokens === 200 && event.data.usage.cacheWriteTokens === 25))
  assert.ok(replies.every(event => event.data.message.content.some(block => block.type === 'reasoning')))
  assert.ok(replies.every(event => event.data.message.source.replayState.response.fixture === 'native'))
  assert.ok(of(report.persisted, 'request/header').every(event => event.data.header.config.reasoningEffort === (event.data.header.config.provider === 'cascade-primary' ? 'high' : 'low')))
  assert.ok(report.streams.some(frame => frame.type === 'chunk' && frame.chunk.type === 'text-delta' && frame.chunk.text === 'CASCADE'))
  assert.equal(report.callError, undefined)
})

test('cascade reads and dispatches native work sessions with structured tool history, then wakes on the real worker result', { timeout: 60000 }, async () => {
  const report = await scenario('tools')
  const calls = of(report.persisted, 'tool/call')
  assert.deepEqual(calls.map(event => event.data.name), ['nexus_list_sessions', 'nexus_read_session', 'nexus_send_session'])
  assert.equal(report.requests[0].provider, 'cascade-primary')
  assert.equal(report.requests[0].reasoningEffort, 'high')
  assert.ok(report.requests.slice(1).every(request => request.provider === 'cascade-secondary' && request.model === 'other' && request.reasoningEffort === 'low'))
  const firstTurn = of(report.persisted, 'turn/start')[0].data.turn
  assert.ok(of(report.persisted, 'request/header').some(event => event.data.header.config.provider === 'cascade-secondary' && event.seq < of(report.persisted, 'turn/end').find(event => event.data.turn === firstTurn).seq), 'default switch takes effect at the next tool step in the same turn')
  const results = of(report.persisted, 'tool/result')
  assert.ok(results.every(event => !event.data.message.isError))
  for (const call of calls) {
    assert.ok(report.requests.some(request => request.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.id === call.data.callId)) && request.messages.some(message => message.role === 'tool' && message.toolCallId === call.data.callId)))
  }
  assert.ok(report.requests[0].tools.some(tool => tool.name === 'nexus_archive_session'), 'ticket 01 native archive capability remains available')
  assert.ok(report.requests[0].messages.some(message => message.role === 'system' && /nexus_archive_session/.test(textOf(message))), 'ticket 01 cleanup guidance remains in the prompt')
  assert.ok(of(report.worker, 'user/message').some(event => event.data.source.kind === 'user' && event.data.source.via === 'nexus' && textOf(event.data) === 'CASCADE-WORK'))
  const workerEnd = of(report.worker, 'turn/end').at(-1)
  assert.equal(workerEnd.data.reason.kind, 'completed')
  const returned = of(report.persisted, 'user/message').find(event => event.data.source.kind === 'nexus-work-result')
  assert.ok(returned)
  assert.ok(report.requests.some(request => request.messages.some(message => message.source?.kind === 'nexus-work-result' && /CASCADE-WORK-DONE/.test(textOf(message)))))
  assert.ok(of(report.persisted, 'assistant/message').some(event => textOf(event.data.message) === 'WORK-RESULT-RECEIVED'))
})

test('native running steer reaches the next step of the same cascade turn with a new default model', { timeout: 60000 }, async () => {
  const report = await scenario('steer')
  assert.equal(report.runningBeforeSteer, 'running')
  assert.equal(report.streamBeforeRelease, true, 'incremental text is published before the model finishes')
  assert.deepEqual(report.requests.map(request => [request.provider, request.model, request.reasoningEffort]), [['cascade-primary', 'normal', 'high'], ['cascade-secondary', 'other', 'low']])
  assert.ok(report.requests[1].messages.some(message => message.role === 'user' && textOf(message) === 'STEER-NEW'))
  assert.equal(of(report.persisted, 'turn/start').length, 1)
  assert.equal(of(report.persisted, 'step/start').length, 2)
  assert.ok(of(report.persisted, 'assistant/message').some(event => textOf(event.data.message) === 'STEER-APPLIED'))
})

for (const [model, code] of [['broken', 'FIXTURE_FAILED'], ['no-tools', 'UNSUPPORTED_TOOLS'], ['signed-out', 'MISSING_CREDENTIAL'], ['unavailable', 'NO_ADAPTER']]) {
  test(`cascade default ${model} records an honest failure without changing the route`, { timeout: 60000 }, async () => {
    const report = await scenario('failure', { model })
    const end = of(report.persisted, 'turn/end').at(-1)
    assert.equal(end.data.reason.kind, 'error')
    assert.equal(end.data.reason.error.code, code)
    assert.equal(of(report.persisted, 'assistant/message').length, 0)
    assert.ok(report.requests.every(request => request.provider === 'cascade-primary' && request.model === model), 'no fallback request is sent to another route')
    if (model !== 'unavailable') {
      assert.equal(report.requests.length, 1)
      const attempt = of(report.persisted, 'assistant/attempt').at(-1)
      assert.equal(attempt.data.stream.find(record => record.chunk?.type === 'finish').chunk.reason.failure.code, code)
    }
  })
}

test('cascade compacts the same native main conversation between turns and sends the structured summary on its next request', { timeout: 90000 }, async () => {
  const report = await scenario('compaction', { nexus: '    compactionBudget: 19000\n    summaryModel: cascade-summary/summary\n' })
  const start = of(report.persisted, 'compaction/start')[0]
  assert.ok(start)
  const end = of(report.persisted, 'compaction/end').find(event => event.data.compactionId === start.data.compactionId)
  assert.equal(end.data.error, undefined)
  assert.ok(report.summaries.every(summary => summary.purpose === 'compaction' && summary.model === 'summary'))
  const turnEnd = of(report.persisted, 'turn/end').find(event => event.data.turn === start.data.turn)
  assert.ok(start.seq < end.seq && end.seq < turnEnd.seq)
  assert.ok(report.requests.at(-1).messages.some(message => message.source?.kind === 'compact-checkpoint' && /CASCADE-SUMMARY/.test(textOf(message))))
  assert.ok(of(report.persisted, 'assistant/message').at(-1).data.message.source.provider.startsWith('cascade-'))
})

test('cascade restores the same native conversation and replay data before requesting the current default model', { timeout: 60000 }, async () => {
  const report = await scenario('restore')
  assert.deepEqual(report.persisted.slice(0, report.beforeRestore.length), report.beforeRestore)
  assert.deepEqual(report.requests.map(request => request.provider), ['cascade-primary', 'cascade-secondary'])
  const resumed = report.requests[1].messages
  assert.ok(resumed.some(message => message.role === 'user' && textOf(message) === 'BEFORE-RESTORE'))
  assert.ok(resumed.some(message => message.role === 'assistant' && message.source.provider === 'cascade-primary' && message.source.replayState.response.fixture === 'native'))
  assert.equal(of(report.persisted, 'turn/start').length, 2)
  assert.equal(of(report.persisted, 'turn/end').at(-1).data.reason.kind, 'completed')
})

test('native Nexus settings default to cascade and switch modes only on the next call', { timeout: 90000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(accept => server.once('listening', accept))
  let modelRequests = 0
  server.on('connection', socket => {
    const send = event => socket.send(JSON.stringify(event))
    send({ type: 'session.created' })
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'session.update') send({ type: 'session.updated', session: event.session })
      if (event.type === 'response.create') {
        const id = `ui-${++modelRequests}`
        send({ type: 'response.created', response: { id } })
        send({ type: 'response.text.delta', response_id: id, delta: `REALTIME-REPLY-${modelRequests}` })
        send({ type: 'response.done', response: { id, status: 'completed' } })
      }
    })
  })
  let browser
  try {
    const report = await scenario('ui', {
      endpoint: `ws://127.0.0.1:${server.address().port}`,
      interact: async (url, dir) => {
        browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
        const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1360, height: 900 } })
        page.setDefaultTimeout(15000)
        await page.goto(url)
        const until = async (predicate, description) => { for (const deadline = Date.now() + 15000; !(await predicate()); ) { if (Date.now() > deadline) throw new Error(`waiting for ${description}`); await sleep(100) } }
        await until(async () => {
          for (const label of ['继续', '稍后配置']) { const button = page.getByRole('button', { name: label, exact: true }); if (await button.isVisible()) await button.click() }
          return page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).isVisible()
        }, 'native app ready')
        await writeFile(resolve(dir, 'ui-start.yml'), await page.locator('body').ariaSnapshot())
        const open = async () => { await page.keyboard.press('Escape'); await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click() }
        const settings = async () => {
          await openSettings(page)
          await page.getByRole('button', { name: 'Nexus', exact: true }).click()
          return page.getByRole('tablist', { name: '语音模式', exact: true })
        }
        const saveMode = async mode => { const choice = await settings(); const tab = choice.getByRole('tab', { name: mode === 'cascade' ? '级联' : 'Realtime', exact: true }); await tab.click(); await until(async () => await tab.isEnabled() && await tab.getAttribute('aria-selected') === 'true', 'mode saved') }
        const submit = async (words, expected) => {
          const previous = await page.getByText(expected, { exact: true }).count()
          const editor = page.getByRole('textbox').last()
          await editor.fill(words); await editor.press('Enter')
          try { await until(async () => await page.getByText(expected, { exact: true }).count() > previous, expected) }
          catch (error) {
            await page.screenshot({ path: resolve(dir, 'ui-failure.png') })
            await writeFile(resolve(dir, 'ui-failure.yml'), await page.locator('body').ariaSnapshot())
            await writeFile(resolve(dir, 'ui-finish'), '')
            await sleep(1000)
            throw error
          }
        }
        const initial = await settings()
        assert.equal(await initial.getByRole('tab', { name: '级联', exact: true }).getAttribute('aria-selected'), 'true')
        await page.screenshot({ path: resolve(dir, 'settings-default.png') })
        await open()
        await submit('UI-CASCADE', 'CASCADE-REPLY')
        await page.getByRole('button', { name: '接通语音', exact: true }).click()
        await page.getByRole('status').filter({ hasText: /已接通 · 点按说话|通话中 · 自动听写/ }).waitFor()
        assert.equal(modelRequests, 0)
        await page.getByRole('button', { name: '挂断', exact: true }).click()
        await saveMode('realtime'); await open()
        await page.getByRole('button', { name: '接通语音', exact: true }).click()
        await page.getByRole('status').filter({ hasText: /已接通 · 点按说话|通话中 · 自动听写/ }).waitFor()
        await submit('UI-REALTIME-A', 'REALTIME-REPLY-1')
        await saveMode('cascade'); await open()
        await page.getByRole('status').filter({ hasText: /已接通 · 点按说话|通话中 · 自动听写/ }).waitFor()
        await submit('UI-REALTIME-B', 'REALTIME-REPLY-2')
        await page.getByRole('button', { name: '挂断', exact: true }).click()
        await submit('UI-REALTIME-C', 'REALTIME-REPLY-3')
        await page.getByRole('button', { name: '接通语音', exact: true }).click()
        await page.getByRole('status').filter({ hasText: /已接通 · 点按说话|通话中 · 自动听写/ }).waitFor()
        await submit('UI-CASCADE-AGAIN', 'CASCADE-REPLY')
        await page.screenshot({ path: resolve(dir, 'cascade-after-switch.png') })
        await writeFile(resolve(dir, 'ui.yml'), await page.locator('body').ariaSnapshot())
      },
    })
    assert.equal(modelRequests, 3)
    assert.equal(report.requests.length, 2)
    const replies = of(report.persisted, 'assistant/message')
    assert.deepEqual(replies.map(event => event.data.message.source.provider), ['cascade-primary', 'dashscope-realtime', 'dashscope-realtime', 'dashscope-realtime', 'cascade-primary'])
    assert.ok(report.requests.at(-1).messages.some(message => message.role === 'assistant' && textOf(message) === 'REALTIME-REPLY-3'), 'both modes keep one native conversation')
  } finally {
    await browser?.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise(accept => server.close(accept))
  }
})
