import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { apply as titleProvider } from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerWorkSessionTitles } from '../dist/work-session-titles.js'

// Controlled native-service seam complements titles.test.mjs's actual Nexus tool, Host and persisted restarts.
async function scenario({ budget = 64, tracked = true, userFirst = false, fail = false, pinned = false } = {}) {
  const ctx = new Context()
  const fibers = [ctx.plugin(SessionStore), ctx.plugin(SessionProjectionRegistry), ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 160 }), ctx.plugin(LlmRuntime)]
  fibers.push(ctx.plugin({ inject: ['sessionTitle', 'llm', 'sessions'], apply: titleProvider }, { targetWords: 6, targetCjkCharacters: 12, maxInputBytes: 32000, maxOutputTokens: budget, timeoutMs: 1000, provider: 'title-fixture', model: 'reasoning-model' }))
  await Promise.all(fibers.map(fiber => fiber.await()))
  const requests = []
  const logs = []
  ctx.logger.exporter({ export: message => { for (const value of message.args) if (typeof value === 'string' && value.startsWith('nexus title budget: ')) logs.push(JSON.parse(value.slice('nexus title budget: '.length))) } })
  class ReasoningAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push({ purpose: options.purpose, provider: options.provider, model: options.model, maxTokens: options.maxTokens })
      if (options.purpose === 'session-title' && (fail || options.maxTokens < 512)) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Reasoning exhausted the budget before any visible title.' } }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '登录页实现与测试' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['title-fixture'], new ReasoningAdapter())
  const track = registerWorkSessionTitles(ctx)
  const session = ctx.sessions.prepare('worker')
  ctx.sessions.enter(session)
  if (tracked) track(session, 'create-call')
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '实现登录页并写测试，遵守现有项目约定' }], source: userFirst ? { kind: 'user' } : { kind: 'user', via: 'nexus', supervisorId: 'nexus-supervisor', callId: 'create-call' } }), { surfaceOp: 'append' })
  if (pinned) ctx.sessionTitle.rename(session, '用户自己的标题')
  const errors = []
  try {
    // The real native first-prompt provider supplies framing, output validation and acceptance.
    for (let i = 0; i < 2; i++) {
      try { await ctx.sessionTitle.refresh(session) } catch (error) { errors.push(String(error)) }
    }
    for await (const _chunk of ctx.llm.stream({ provider: 'title-fixture', model: 'reasoning-model', maxTokens: 64, messages: [], sessionId: session.id, signal: new AbortController().signal })) {}
    return { requests, logs, errors, title: ctx.sessionTitle.get(session), events: session.snapshotEvents() }
  } finally { await ctx.fiber.dispose() }
}

test('native model naming gets room for unadvertised reasoning; later refresh and worker requests stay native', async () => {
  const result = await scenario()
  assert.equal(result.title.source.kind, 'provider')
  assert.equal(result.title.title, '登录页实现与测试')
  assert.deepEqual(result.requests, [
    { purpose: 'session-title', provider: 'title-fixture', model: 'reasoning-model', maxTokens: 4096 },
    { purpose: 'session-title', provider: 'title-fixture', model: 'reasoning-model', maxTokens: 64 },
    { purpose: undefined, provider: 'title-fixture', model: 'reasoning-model', maxTokens: 64 },
  ])
  assert.deepEqual(result.logs, [{ sessionId: 'worker', titleProvider: 'session-title-first-prompt-llm', messageSeq: 0, callId: 'create-call', originalMaxTokens: 64, maxTokens: 4096 }])
  assert.equal(result.events.filter(event => event.type === 'session/title-llm-request').length, 2, 'one native request event per actual call')
  assert.ok(!result.events.some(event => event.type.startsWith('nexus/')), 'no unknown plugin event can obstruct restoration')
})

test('larger configured budgets are preserved', async () => {
  const result = await scenario({ budget: 8192 })
  assert.equal(result.title.source.kind, 'provider')
  assert.deepEqual(result.requests.slice(0, 2).map(request => request.maxTokens), [8192, 8192])
  assert.deepEqual(result.logs, [])
})

test('ordinary or old marked sessions and user-first new sessions keep the native naming policy', async () => {
  for (const options of [{ tracked: false }, { userFirst: true }, { pinned: true }]) {
    const result = await scenario(options)
    assert.deepEqual(result.requests.slice(0, 2).map(request => request.maxTokens), [64, 64])
    assert.deepEqual(result.logs, [])
  }
})

test('continued model failure keeps a truthful fallback rather than manufacturing a title', async () => {
  const result = await scenario({ fail: true })
  assert.equal(result.title.source.kind, 'fallback')
  assert.ok(!result.events.some(event => event.type === 'session/title' && event.data.source.kind === 'provider'))
  assert.equal(result.errors.length, 2)
  assert.equal(result.logs.length, 1)
})
