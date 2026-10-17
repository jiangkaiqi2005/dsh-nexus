import test from 'node:test'
import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { startHost } from './host-process.mjs'
import { voiceFixture } from './voice-audio.mjs'

const root = resolve('.')
const cli = 'D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd'
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const redact = output => output.replace(/\?token=\S+/g, '?token=[redacted]')
async function until(check, label) {
  for (const begin = Date.now(); Date.now() - begin < 60000; await sleep(100)) { const value = await check(); if (value) return value }
  throw new Error(`Timed out: ${label}`)
}
const json = path => readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)

async function command(args, env, log) {
  const child = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" ${args.map(arg => `"${arg}"`).join(' ')}"`], { cwd: root, env, windowsVerbatimArguments: true }, async process => {
    let output = ''
    process.stdout.on('data', data => { output += data })
    process.stderr.on('data', data => { output += data })
    let timer
    let code
    try {
      code = await Promise.race([
        new Promise((accept, reject) => { process.once('error', reject); process.once('close', accept) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('official CLI command timed out')), 180000) }),
      ])
    } finally { clearTimeout(timer); await writeFile(log, redact(output)) }
    assert.equal(code, 0, redact(output).slice(-4000))
    return {}
  })
  await child.close()
}

/** Local scripted endpoint: PCM onset causes a predetermined requirement change, not speech recognition. */
function model() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const wire = []
  const log = { voicedFrames: 0, changed: false, reviewed: false }
  server.on('connection', socket => {
    const items = []
    let audio = false
    let answered = 0
    let voiceStarted = false
    const send = event => { wire.push({ direction: 's2c', ...event, ...(event.type === 'response.audio.delta' ? { delta: '[audio]' } : {}) }); if (socket.readyState === 1) socket.send(JSON.stringify(event)) }
    const respond = ({ text, call }) => {
      const id = `response-${crypto.randomUUID()}`
      send({ type: 'response.created', response: { id, status: 'in_progress' } })
      if (call) {
        const item = { type: 'function_call', call_id: `${call.name}-${crypto.randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        send({ type: 'response.function_call_arguments.done', response_id: id, ...item })
        return send({ type: 'response.done', response: { id, status: 'completed', output: [item] } })
      }
      send({ type: audio ? 'response.audio_transcript.delta' : 'response.text.delta', response_id: id, delta: text })
      if (audio) send({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(24000, 1).toString('base64') })
      send({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text }] }] } })
    }
    send({ type: 'session.created' })
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'input_audio_buffer.append') {
        const pcm = Buffer.from(event.audio, 'base64')
        let sum = 0
        for (let offset = 0; offset < pcm.length; offset += 2) sum += pcm.readInt16LE(offset) ** 2
        if (Math.sqrt(sum / (pcm.length / 2)) > 600) log.voicedFrames++
        wire.push({ direction: 'c2s', type: event.type, bytes: pcm.length })
        if (log.voicedFrames >= 3 && !voiceStarted) {
          voiceStarted = true
          send({ type: 'input_audio_buffer.speech_started', item_id: 'change' })
          send({ type: 'input_audio_buffer.speech_stopped', item_id: 'change' })
          send({ type: 'input_audio_buffer.committed', item_id: 'change' })
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'change', transcript: 'ZERO-WORD：改要求，零必须显示 zero。' })
          log.changed = true
          respond({ call: { name: 'nexus_send_session', arguments: { sessionId: 'repair', text: 'ZERO-WORD：用户改要求，零必须显示 zero，继续修复并跑测试。' } } })
        }
        return
      }
      wire.push({ direction: 'c2s', ...event })
      if (event.type === 'session.update') { audio = event.session.modalities.includes('audio'); send({ type: 'session.updated', session: event.session }) }
      if (event.type === 'conversation.item.create') items.push(event.item.type === 'function_call_output' ? event.item.output : event.item.content?.map(part => part.text).join('\n') ?? '')
      if (event.type === 'response.create') {
        const fresh = items.slice(answered).join('\n')
        answered = items.length
        if (fresh.includes('SCENARIO-START') && !fresh.includes('delivery')) return respond({ call: { name: 'nexus_send_session', arguments: { sessionId: 'repair', text: '修复数字格式化错误，修好后跑测试。' } } })
        if (fresh.includes('REPAIR-PASS') && !log.reviewed) {
          log.reviewed = true
          return respond({ call: { name: 'nexus_send_session', arguments: { sessionId: 'review', text: '审查修复与 ZERO-WORD 要求，独立跑测试后报告。' } } })
        }
        respond({ text: fresh.includes('REVIEW-PASS') ? 'SCENARIO-COMPLETE：修复与独立审查均通过，零显示 zero，原生测试通过。' : fresh.includes('TEXT-CONTINUE') ? 'TEXT-CONTINUED：按最新零显示 zero 要求等待审查结果。' : audio ? 'VOICE-CHANGE-ACK：新要求已交给执行中的修复会话。' : 'DISPATCH-ACK：已收到工具执行结果。' })
      }
    })
  })
  return { server, wire, log, ready: new Promise(accept => server.once('listening', accept)) }
}

test('clean bundled profile completes controlled repair, voice steering, review and hangup text scenario', { skip: process.env.NEXUS_DESKTOP_SMOKE !== '1', timeout: 300000 }, async t => {
  if (process.platform !== 'win32' || !(await access(cli).then(() => true, () => false))) return t.skip('official Desktop CLI is not installed')
  await mkdir(resolve('.scratch/nexus-v1'), { recursive: true })
  const dir = await mkdtemp(resolve('.scratch/nexus-v1/ticket11-scenario-'))
  const home = resolve(dir, 'home')
  const profile = resolve(home, 'profiles/nexus-scenario')
  const workspace = resolve(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(resolve(workspace, 'format.mjs'), "export const format = value => value ? String(value) : 'missing'\n")
  await writeFile(resolve(workspace, 'format.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { format } from './format.mjs'\ntest('latest zero wording', () => { assert.equal(format(0), 'zero'); assert.equal(format(12), '12') })\n")
  const endpoint = model()
  await endpoint.ready
  t.after(async () => { for (const socket of endpoint.server.clients) socket.terminate(); await new Promise(accept => endpoint.server.close(accept)) })
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(dir, 'agents'), DSH_TELEMETRY: '0', NEXUS_SCENARIO_KEY: 'fixture-not-a-secret' }
  // The owned Host's native pwsh tool must be able to run a separate node:test suite.
  delete env.NODE_TEST_CONTEXT
  await command(['--profile', 'nexus-scenario', '--from-default-profile', 'web', '--dump-default-config'], env, resolve(dir, 'initialize.log'))
  const packed = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm pack --json --pack-destination "${dir}"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
    let output = ''
    child.stdout.on('data', data => { output += data })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    assert.equal(code, 0)
    const manifest = JSON.parse(output)[0]
    await writeFile(resolve(dir, 'pack.json'), JSON.stringify(manifest))
    return { tgz: resolve(dir, manifest.filename), manifest }
  })
  await packed.close()
  await command(['plugin', '--profile', 'nexus-scenario', 'add', packed.tgz], env, resolve(dir, 'install.log'))
  const hashes = []
  for (const file of packed.manifest.files) {
    assert.match(file.path, /^(?:README(?:\.zh-CN)?\.md|package\.json|client\.js|typert\.js|icon\.svg|cordis\.patch\.yml|locale\/(?:en|zh)\.json|dist\/[a-z-]+\.(?:js|d\.ts))$/)
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    const installed = hash(await readFile(resolve(profile, 'node_modules/dsh-nexus', file.path)))
    assert.equal(installed, hash(await readFile(resolve(root, file.path))), `${file.path} installed from this final bundle`)
    hashes.push({ path: file.path, sha256: installed })
  }
  await writeFile(resolve(dir, 'installed-manifest.json'), JSON.stringify(hashes, null, 2))
  const manifestPath = resolve(profile, 'package.json')
  const manifest = await json(manifestPath)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus'])
  assert.match(await readFile(resolve(profile, 'pnpm-workspace.yaml'), 'utf8'), /autoInstallPeers: false/)
  const fixture = resolve(profile, 'node_modules/nexus-scenario-probe')
  await mkdir(fixture)
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-scenario-probe', type: 'module', exports: './index.js' }))
  await copyFile(resolve('tests/scenario-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    voiceMode: realtime\n    credentialRef: NEXUS_SCENARIO_KEY\n    endpoint: ws://127.0.0.1:${endpoint.server.address().port}\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n- insert:\n    - id: scenario-probe\n      name: nexus-scenario-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        workspace: ${JSON.stringify(workspace)}\n`)
  let output = ''
  const host = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" --profile nexus-scenario --port 0 --no-open"`], { cwd: workspace, env, windowsVerbatimArguments: true }, async child => {
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const ready = await until(async () => { const state = await json(resolve(dir, 'ready.json')); const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return state && url && { ...state, url } }, 'official Host activation')
    assert.equal(ready.installed, true)
    return ready
  })
  t.after(() => host.close())
  const capture = await voiceFixture([{ silence: 2 }, { text: '修改要求，零必须显示零这个英文词。', voice: 'Microsoft Huihui Desktop' }, { silence: 90 }])
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${capture.path}%noloop`] })
  t.after(() => browser.close())
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__streams = []
    const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await request(constraints); window.__streams.push(stream); return stream }
  })
  try {
    await page.goto(host.url)
    const bar = page.locator('[data-nexus-voice]')
    await until(async () => {
      for (const name of ['继续', '稍后配置']) { const button = page.getByRole('button', { name, exact: true }); if (await button.isVisible()) await button.click() }
      if (await bar.isVisible()) return true
      await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click({ timeout: 1000 }).catch(() => {})
    }, 'native Nexus entry')
    assert.equal(await bar.getAttribute('data-state'), 'idle')
    assert.equal(await page.evaluate(() => window.__streams.length), 0, 'clean install defaults to no microphone')
    await sleep(1500)
    const skip = page.getByRole('button', { name: '稍后配置', exact: true })
    if (await skip.isVisible()) await skip.click()
    const input = async text => { await page.locator('[contenteditable="true"]').last().fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click() }
    await input('SCENARIO-START：让已有修复会话修复报错，完成后交给已有审查会话审查。')
    await until(async () => (await json(resolve(dir, 'ready.json')))?.agents.some(agent => agent.id === 'repair' && agent.status === 'running'), 'existing repair running')
    await bar.getByRole('button', { name: /接通语音|Start voice/ }).click()
    await until(async () => (await bar.getAttribute('data-state')) === 'live', 'voice live')
    await until(async () => (await json(resolve(dir, 'ready.json')))?.agents.find(agent => agent.id === 'repair')?.events.some(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event).includes('ZERO-WORD')), 'voice requirement admitted to running worker')
    assert.ok(endpoint.log.changed)
    assert.ok(endpoint.log.voicedFrames >= 3)
    await until(async () => (await bar.getAttribute('data-played-samples')) > 0, 'voice reply played')
    await bar.getByRole('button', { name: /挂断|Hang up/ }).click()
    await until(async () => (await bar.getAttribute('data-state')) === 'idle', 'hangup')
    assert.ok((await page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks().map(track => track.readyState)))).every(state => state === 'ended'))
    const audioBefore = endpoint.wire.filter(event => event.type === 'response.audio.delta').length
    await input('TEXT-CONTINUE：挂断后继续，保留刚才改的要求。')
    await until(async () => (await page.locator('body').innerText()).includes('TEXT-CONTINUED'), 'native text continuation')
    await writeFile(resolve(dir, 'release'), '')
    await until(async () => (await page.locator('body').innerText()).includes('SCENARIO-COMPLETE'), 'final text report')
    await until(async () => (await json(resolve(dir, 'ready.json')))?.agents.every(agent => agent.status === 'idle'), 'all native turns settled')
    assert.equal(endpoint.wire.filter(event => event.type === 'response.audio.delta').length, audioBefore, 'no generated audio after hangup')
    await page.screenshot({ path: resolve(dir, 'scenario.png') })
    await writeFile(resolve(dir, 'scenario.yml'), await page.locator('body').ariaSnapshot())
    await writeFile(resolve(dir, 'finish'), '')
    const result = await until(() => json(resolve(dir, 'result.json')), 'durable native journal')
    assert.equal(result.error, undefined, result.stack)
    assert.ok(result.events.filter(event => event.type === 'assistant/message').every(event => event.data.message.source.provider === 'dashscope-realtime' && event.data.message.source.model === 'qwen3.8-omni-flash-realtime'))
    assert.ok(result.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    assert.match(result.source, /value === 0 \? 'zero'/)
    assert.deepEqual(result.workers.map(worker => worker.id).sort(), ['repair', 'review'])
    const repair = result.workers.find(worker => worker.id === 'repair')
    const review = result.workers.find(worker => worker.id === 'review')
    const repairTests = repair.events.filter(event => event.type === 'tool/result' && /tests 1\b/.test(event.data.message.content[0]?.text ?? ''))
    assert.equal(repairTests.length, 2)
    assert.match(repairTests[0].data.message.content[0].text, /fail 1\b/)
    assert.match(repairTests[0].data.message.content[0].text, /\[exit code: 1\]/)
    assert.match(repairTests[1].data.message.content[0].text, /fail 0\b/)
    const change = repair.events.find(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('ZERO-WORD'))
    assert.equal(change.data.source.kind, 'user')
    assert.equal(change.data.source.via, 'nexus')
    const changeStep = repair.events.findLast(event => event.type === 'step/start' && event.seq < change.seq)
    assert.ok(changeStep.data.step > 1, 'running worker consumes the new instruction in a later native step')
    for (const worker of [repair, review]) {
      assert.equal(worker.header.origin, undefined, 'existing ordinary conversations')
      assert.ok(worker.events.some(event => event.type === 'tool/call' && event.data.name === 'pwsh'))
      assert.ok(worker.events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data.message.content).includes(`${worker.id.toUpperCase()}-PASS`)))
      assert.ok(worker.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    }
    const receipts = result.events.filter(event => event.type === 'tool/result').map(event => JSON.parse(event.data.message.content[0].text))
    assert.ok(receipts.some(receipt => receipt.sessionId === 'repair' && receipt.delivery === 'steer'))
    assert.ok(result.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && JSON.stringify(event.data.content).includes('REVIEW-PASS')))
    assert.ok(result.events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data.message.content).includes('SCENARIO-COMPLETE')))
    await writeFile(resolve(dir, 'wire.json'), JSON.stringify({ log: endpoint.log, wire: endpoint.wire }))
    console.log('Clean scenario evidence:', dir)
  } catch (error) {
    await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {})
    await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {})
    await writeFile(resolve(dir, 'wire.json'), JSON.stringify({ log: endpoint.log, wire: endpoint.wire }))
    throw error
  } finally {
    await browser.close()
    await host.close()
    await writeFile(resolve(dir, 'host.log'), redact(output))
  }
})
