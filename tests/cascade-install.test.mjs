import test from 'node:test'
import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { startHost } from './host-process.mjs'

const root = resolve('.')
const cli = 'D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd'
const sleep = ms => new Promise(accept => setTimeout(accept, ms))
const redact = output => output.replace(/\?token=\S+/g, '?token=[redacted]')
const json = path => readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const textOf = message => message.content?.map(part => part.text ?? '').join('\n') ?? ''
async function until(check, label) { for (const begin = Date.now(); Date.now() - begin < 60000; await sleep(100)) { const value = await check(); if (value) return value }; throw new Error(`Timed out: ${label}`) }

async function command(args, env, log) {
  const host = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" ${args.map(arg => `"${arg}"`).join(' ')}"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
    let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    let timer, code
    try { code = await Promise.race([new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('official CLI command timed out')), 180000) })]) }
    finally { clearTimeout(timer); await writeFile(log, redact(output)) }
    assert.equal(code, 0, redact(output).slice(-4000)); return {}
  })
  await host.close()
}

test('Desktop installed cascade bundle runs tap dispatch, interruption, native repair/review, hangup text results and archival in a clean profile', { skip: process.env.NEXUS_DESKTOP_SMOKE !== '1', timeout: 300000 }, async t => {
  if (process.platform !== 'win32' || !(await access(cli).then(() => true, () => false))) return t.skip('official Desktop CLI is not installed')
  await mkdir(resolve('.scratch/cascade-voice'), { recursive: true })
  const dir = await mkdtemp(resolve('.scratch/cascade-voice/06-installed-')), home = resolve(dir, 'home'), profile = resolve(home, 'profiles/nexus-cascade'), workspace = resolve(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(resolve(workspace, 'format.mjs'), "export const format = value => value ? String(value) : 'missing'\n")
  await writeFile(resolve(workspace, 'format.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { format } from './format.mjs'\ntest('latest zero wording', () => { assert.equal(format(0), 'zero'); assert.equal(format(12), '12') })\n")
  const asrRequests = [], tasks = [], inputs = ['SCENARIO-START：让已有修复会话修复错误，随后独立审查。', 'ZERO-WORD：零必须显示 zero。']
  const http = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    asrRequests.push({ auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.end(JSON.stringify({ output: { text: inputs.shift() ?? '' } }))
  })
  await new Promise(accept => http.listen(0, '127.0.0.1', accept)); t.after(() => { http.closeAllConnections(); return new Promise(accept => http.close(accept)) })
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(accept => ws.once('listening', accept))
  t.after(async () => { for (const socket of ws.clients) socket.terminate(); await new Promise(accept => ws.close(accept)) })
  ws.on('connection', socket => {
    const task = { text: [], canceled: false, index: 0 }; tasks.push(task)
    const send = (event, payload = {}) => socket.readyState === 1 && socket.send(JSON.stringify({ header: { event, task_id: task.id }, payload }))
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()); task.id = event.header.task_id
      if (event.header.action === 'run-task') { task.payload = event.payload; send('task-started') }
      if (event.header.action === 'continue-task') {
        const text = event.payload.input.text; task.text.push(text)
        send('result-generated', { output: { type: 'sentence-begin', sentence: { index: task.index, words: [] }, original_text: text } })
        send('result-generated', { output: { type: 'sentence-synthesis', sentence: { index: task.index, words: [] } } })
        const pcm = Buffer.alloc(4 * 24000 * 2); for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(Math.sin(offset / 20) * 8000), offset)
        socket.send(pcm)
        send('result-generated', { output: { type: 'sentence-end', sentence: { index: task.index++, words: [] }, original_text: text } })
      }
      if (event.header.action === 'finish-task') { task.canceled = event.payload.input.directive === 'cancel'; if (task.canceled || tasks.indexOf(task) > 0) send('task-finished') }
    })
  })
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(dir, 'agents'), DSH_TELEMETRY: '0', NEXUS_INSTALL_KEY: 'host-only-install-key' }; delete env.NODE_TEST_CONTEXT
  await command(['--profile', 'nexus-cascade', '--from-default-profile', 'web', '--dump-default-config'], env, resolve(dir, 'initialize.log'))
  const packed = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm pack --json --pack-destination "${dir}"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
    let output = ''; child.stdout.on('data', data => { output += data })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) }); assert.equal(code, 0)
    const manifest = JSON.parse(output)[0]; await writeFile(resolve(dir, 'pack.json'), JSON.stringify(manifest, null, 2))
    return { tgz: resolve(dir, manifest.filename), manifest }
  }); await packed.close()
  const tgzHash = hash(await readFile(packed.tgz)); await writeFile(resolve(dir, 'bundle.sha256'), tgzHash)
  if (process.env.NEXUS_DELIVERY_BUNDLE) assert.equal(tgzHash, hash(await readFile(process.env.NEXUS_DELIVERY_BUNDLE)), 'smoke tests exactly the final delivery bytes')
  await command(['plugin', '--profile', 'nexus-cascade', 'add', packed.tgz], env, resolve(dir, 'install.log'))
  const installedManifest = []
  for (const file of packed.manifest.files) {
    assert.match(file.path, /^(?:README(?:\.zh-CN)?\.md|package\.json|client\.js|typert\.js|icon\.svg|cordis\.patch\.yml|locale\/(?:en|zh)\.json|dist\/[a-z-]+\.(?:js|d\.ts))$/)
    const sha256 = hash(await readFile(resolve(profile, 'node_modules/dsh-nexus', file.path))); assert.equal(sha256, hash(await readFile(resolve(root, file.path))), file.path)
    installedManifest.push({ path: file.path, sha256 })
  }
  await writeFile(resolve(dir, 'installed-manifest.json'), JSON.stringify(installedManifest, null, 2))
  assert.deepEqual((await json(resolve(profile, 'package.json'))).dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-nexus'])
  assert.match(await readFile(resolve(profile, 'pnpm-workspace.yaml'), 'utf8'), /autoInstallPeers: false/)
  assert.equal(await access(resolve(profile, 'node_modules/@deepseek-ai/dsh-agent')).then(() => true, () => false), false, 'no duplicate native Host agent SDK installed as a peer')
  const fixture = resolve(profile, 'node_modules/nexus-cascade-install-probe'); await mkdir(fixture)
  await copyFile(resolve('tests/cascade-install-probe.js'), resolve(fixture, 'index.js'))
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name: 'nexus-cascade-install-probe', version: '1.0.0', type: 'module', exports: './index.js' }))
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: nexus\n  config:\n    credentialRef: NEXUS_INSTALL_KEY\n    endpoint: ws://127.0.0.1:1\n    ttsEndpoint: ws://127.0.0.1:${ws.address().port}\n    asrEndpoint: http://127.0.0.1:${http.address().port}\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-models\n  name: "@deepseek-ai/dsh-client-ui-settings-models"\n  config:\n    credentialOnboarding: false\n- insert:\n    - id: cascade-install-probe\n      name: nexus-cascade-install-probe\n      config:\n        dir: ${JSON.stringify(dir)}\n        workspace: ${JSON.stringify(workspace)}\n`)
  let output = ''
  const host = await startHost(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cli}" --profile nexus-cascade --port 0 --no-open"`], { cwd: root, env, windowsVerbatimArguments: true }, async child => {
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    try { return await until(async () => { const failure = await json(resolve(dir, 'result.json')); if (failure?.error) throw new Error(failure.stack); const state = await json(resolve(dir, 'ready.json')), url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; return state && url && { ...state, url } }, 'official packed Host activation') }
    catch (error) { await writeFile(resolve(dir, 'host.log'), redact(output)); throw new Error(`${error}\n${redact(output).slice(-4000)}`) }
  }); t.after(() => host.close())
  assert.equal(host.installed, true); assert.equal(host.agentScopeMatches, true); assert.ok(host.modulePath.startsWith(profile)); assert.equal(host.buildHash, hash(await readFile(resolve(root, 'dist/index.js'))))
  const browser = await chromium.launch({ channel: process.env.NEXUS_TEST_BROWSER ?? 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }); t.after(() => browser.close())
  const page = await browser.newPage({ locale: 'zh-CN' }); const wire = []
  await page.addInitScript(() => {
    window.__streams = []; window.__nodes = []
    const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async constraints => { const stream = await request(constraints); window.__streams.push(stream); return stream }
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.start = function(when = 0, ...args) { window.__nodes.push({ node: this, when, stopped: false }); return start.call(this, when, ...args) }
    AudioBufferSourceNode.prototype.stop = function(...args) { const item = window.__nodes.find(item => item.node === this); if (item) item.stopped = true; return stop.apply(this, args) }
  })
  page.on('websocket', socket => socket.on('framereceived', frame => wire.push(String(frame.payload))))
  try {
    await page.goto(host.url); const bar = page.locator('[data-nexus-voice]')
    await until(async () => { for (const name of ['继续']) { const button = page.getByRole('button', { name, exact: true }); if (await button.isVisible()) await button.click() }; if (await bar.isVisible()) return true; await page.getByRole('button', { name: /打开 Nexus|Open Nexus/ }).click({ timeout: 1000 }).catch(() => {}) }, 'native Nexus entry')
    assert.equal(await bar.getAttribute('data-state'), 'idle'); assert.equal(await page.evaluate(() => window.__streams.length), 0)
    await bar.getByRole('button', { name: '接通语音', exact: true }).click(); await until(async () => await bar.getAttribute('data-state') === 'live', 'prepared cascade media')
    const record = async () => { await bar.getByRole('button', { name: /^点按(?:说话|插话)$/ }).click(); await sleep(350); await bar.getByRole('button', { name: '结束录音', exact: true }).click() }
    await record(); await until(async () => (await json(resolve(dir, 'ready.json')))?.agents.find(agent => agent.id === 'repair')?.status === 'running', 'actual dispatched native worker')
    await until(async () => Number(await bar.getAttribute('data-played-samples')) >= 96000, 'actual PCM confirmation')
    await bar.getByRole('button', { name: /^点按(?:说话|插话)$/ }).click()
    assert.ok(await page.evaluate(() => window.__nodes.every(item => item.stopped || item.node.context.currentTime >= item.when + item.node.buffer.duration)), 'local playback stopped immediately')
    await until(() => tasks[0].canceled, 'synthesis canceled'); await sleep(350); await bar.getByRole('button', { name: '结束录音', exact: true }).click()
    await until(async () => (await json(resolve(dir, 'ready.json')))?.agents.find(agent => agent.id === 'repair')?.events.some(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event).includes('ZERO-WORD')), 'voice steer delivered to running worker')
    await bar.getByRole('button', { name: '挂断', exact: true }).click(); await until(async () => await bar.getAttribute('data-state') === 'idle', 'hung up')
    assert.ok(await page.evaluate(() => window.__streams.flatMap(stream => stream.getTracks()).every(track => track.readyState === 'ended')))
    const taskCount = tasks.length
    const input = async words => { const editor = page.getByRole('textbox').last(); await editor.fill(words); await editor.press('Enter') }
    await input('TEXT-CONTINUE'); await page.getByText('TEXT-CONTINUED：挂断后继续工作。', { exact: true }).waitFor()
    await writeFile(resolve(dir, 'release'), '')
    await page.getByText('SCENARIO-COMPLETE：修复和独立审查通过，零显示 zero。', { exact: true }).waitFor({ timeout: 60000 })
    await input('ARCHIVE-WORK：归档已完成的修复会话。')
    await until(async () => (await json(resolve(dir, 'ready.json')))?.archived.includes('repair'), 'native archived state')
    await until(async () => (await json(resolve(dir, 'ready.json')))?.agents.every(agent => agent.status === 'idle'), 'all native turns settled')
    assert.equal(tasks.length, taskCount, 'hangup leaves no subsequent synthesis'); assert.ok(!wire.join('').includes('host-only-install-key'))
    await page.screenshot({ path: resolve(dir, 'scenario.png') }); await writeFile(resolve(dir, 'scenario.yml'), await page.locator('body').ariaSnapshot())
    await writeFile(resolve(dir, 'finish'), '')
    const result = await until(() => json(resolve(dir, 'result.json')), 'durable journal'); assert.equal(result.error, undefined, result.stack)
    assert.match(result.source, /value === 0 \? 'zero'/); assert.ok(result.archived.includes('repair'))
    assert.ok(result.requests.every(request => request.provider === 'install-supervisor' && request.model === 'normal' && request.reasoningEffort === 'high'))
    assert.ok(result.requests.some(request => request.messages.some(message => message.role === 'tool')), 'structured tool results remain native')
    assert.ok(result.events.filter(event => event.type === 'assistant/message').every(event => event.data.message.source.provider === 'install-supervisor' && event.data.message.source.model === 'normal'))
    assert.ok(result.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-voice' && textOf(event.data).includes('Complete sentences heard:')))
    assert.ok(result.events.some(event => event.type === 'user/message' && event.data.source.kind === 'nexus-work-result' && textOf(event.data).includes('REVIEW-PASS')))
    assert.ok(result.events.some(event => event.type === 'tool/call' && event.data.name === 'nexus_archive_session'))
    assert.ok(result.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
    const repair = result.workers.find(worker => worker.id === 'repair'), review = result.workers.find(worker => worker.id === 'review')
    const tests = repair.events.filter(event => event.type === 'tool/result' && /tests 1\b/.test(textOf(event.data.message)))
    assert.equal(tests.length, 2); assert.match(textOf(tests[0].data.message), /fail 1\b/); assert.match(textOf(tests[0].data.message), /\[exit code: 1\]/); assert.match(textOf(tests[1].data.message), /fail 0\b/)
    for (const worker of [repair, review]) { assert.equal(worker.header.origin, undefined); assert.ok(worker.events.some(event => event.type === 'tool/call' && event.data.name === 'pwsh')); assert.ok(worker.events.some(event => event.type === 'assistant/message' && textOf(event.data.message).includes(`${worker.id.toUpperCase()}-PASS`))) }
    assert.equal(asrRequests.length, 2); assert.ok(asrRequests.every(request => request.auth === 'Bearer host-only-install-key' && request.body.model === 'qwen-audio-3.1-asr-flash' && request.body.input.messages[0].content[0].audio.startsWith('data:audio/wav;base64,')))
    await writeFile(resolve(dir, 'wire.json'), JSON.stringify({ tasks: tasks.map(({ text, canceled, payload }) => ({ text, canceled, payload })), asrRequests: asrRequests.map(request => ({ model: request.body.model, wavBytes: Buffer.from(request.body.input.messages[0].content[0].audio.split(',')[1], 'base64').length })) }, null, 2))
    console.log('installed cascade evidence:', dir, 'tgz SHA256:', tgzHash)
  } catch (error) { await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {}); await writeFile(resolve(dir, 'failure.yml'), await page.locator('body').ariaSnapshot()).catch(() => {}); throw error }
  finally { await browser.close(); await host.close(); await writeFile(resolve(dir, 'host.log'), redact(output)) }
})
