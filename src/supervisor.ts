import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentCancelCause, type AgentStatus, type CancelOptions, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createAssistantMessage, createSystemMessage, LlmAttemptId, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { NativeInbox } from './inbox.js'
import { INSTRUCTIONS, MODEL, RealtimeFailure, reply } from './realtime.js'

export interface Config { credentialRef: string; endpoint: string; timeoutMs?: number }

export class Supervisor implements Agent {
  readonly id
  readonly options = { provider: 'dashscope-realtime', model: MODEL }
  readonly scope
  readonly ctx
  readonly inbox
  readonly events
  private activity: Promise<unknown> = Promise.resolve()
  private abort?: AbortController
  private disposed = false
  private maintenance = false
  private wakeRequested = false
  private turn = 0
  private revision = 0
  status: AgentStatus = 'idle'

  constructor(ctx: Context, readonly session: Session, private config: Config) {
    this.id = session.id
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.events = agentEvents(this.ctx, this)
    this.inbox = new NativeInbox(session, this.ctx, this.events)
  }
  private setStatus(status: AgentStatus) { this.status = status; this.events.emit('agent/status', { status }) }
  send(message: UserMessage, target: InboxTarget, wakeup: boolean) {
    if (this.disposed) throw new Error('Nexus supervisor is disposed')
    this.inbox.append(target, message)
    if (wakeup) { this.wakeRequested = true; this.wake() }
  }
  followup(message: UserMessage) { this.send(message, 'next-turn', true) }
  steer(message: UserMessage) { this.send(message, 'next-step', true) }
  inject(message: UserMessage) { this.send(message, 'next-step', false) }
  cancel(cause: AgentCancelCause, options?: CancelOptions) {
    if (!options?.keepInbox) this.inbox.clear()
    this.abort?.abort(cause)
  }
  async whenIdle() { let observed; do { observed = this.activity; await observed } while (observed !== this.activity) }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.maintenance || this.disposed) throw new Error('Nexus is not available for maintenance')
    this.maintenance = true
    this.abort = new AbortController()
    let operation: Promise<T>
    try { operation = task(this.abort.signal) } catch (error) { operation = Promise.reject(error) }
    const result = operation.finally(() => { this.maintenance = false; this.abort = undefined; this.wake() })
    this.activity = result.catch(() => {})
    return result
  }
  private wake() {
    if (this.disposed || this.maintenance || this.status === 'running' || !this.wakeRequested) return
    this.wakeRequested = false
    this.abort = new AbortController()
    this.setStatus('running')
    const signal = this.abort.signal
    // Keep running synchronous with prompt acceptance, while reserving idle tracking first.
    this.activity = Promise.resolve().then(() => this.drive(signal)).catch(error => {
      this.events.emit('agent/error', { turn: this.turn, step: 0, error })
    }).finally(() => {
      this.abort = undefined
      this.setStatus('idle')
      this.wake()
    })
  }
  private async drive(signal: AbortSignal) {
    do {
      const turn = ++this.turn
      let step = 0
      this.session.append('turn/start', { turn })
      let reason: TurnEndReason | undefined
      try {
        const messages = this.inbox.claim(turn)
        if (!messages.length) continue
        step = 1
        this.session.append('step/start', { turn, step })
        if (!this.session.requestHeader()) {
          this.session.append('request/header', { header: { config: this.options }, reason: 'initial' })
          this.session.append('system/message', { turn, step, message: createSystemMessage(INSTRUCTIONS) }, { surfaceOp: 'append' })
        }
        for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
        await this.request(turn, step, signal)
        // Steering arriving during a text reply gets its nearest subsequent step.
        while (this.inbox.nextStep.length && !signal.aborted) {
          this.session.append('step/end', { turn, step })
          step++
          this.session.append('step/start', { turn, step })
          const steering = this.inbox.claim(turn, 'next-step')
          for (const message of steering) this.session.append('user/message', message, { surfaceOp: 'append' })
          await this.request(turn, step, signal)
        }
        await this.events.serial('agent/turn-stopping', { turn, signal })
      } catch (error) {
        if (signal.aborted) reason = { kind: 'aborted', reason: signal.reason }
        else {
          const failure = { code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN', message: error instanceof RealtimeFailure ? error.message : 'Nexus request failed' }
          reason = { kind: 'error', error: failure }
          this.events.emit('agent/error', { turn, step, error: new Error(failure.message) })
        }
      } finally {
        if (step) this.session.append('step/end', { turn, step })
        this.session.append('turn/end', { turn, reason: reason ?? { kind: 'completed' } })
      }
      if (signal.aborted) break
      this.wakeRequested = false
    } while (this.inbox.nextTurn.length || this.inbox.nextStep.length)
  }
  private async request(turn: number, step: number, signal: AbortSignal) {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    if (!credential) throw new RealtimeFailure('CREDENTIAL_MISSING')
    signal.throwIfAborted()
    const attemptId = LlmAttemptId(`${this.id}:${++this.revision}`)
    const revision = this.revision
    const stream = new AssistantStreamAccumulator()
    let index = 0
    let text = ''
    const push = (chunk: StreamChunk) => {
      const time = Date.now()
      stream.push({ time, chunk })
      this.events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision, index: index++, time, chunk } })
    }
    this.events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId, revision, turn, step } })
    push({ type: 'block-start', index: 0, blockType: 'text' })
    try {
      text = await reply(this.config.endpoint, credential.value, this.session.snapshotEvents(), signal, this.config.timeoutMs ?? 30000, delta => { text += delta; push({ type: 'text-delta', index: 0, text: delta }) })
      push({ type: 'block-end', index: 0, block: { type: 'text', text } })
      push({ type: 'finish', reason: { kind: 'stop' } })
      const event = this.session.append('assistant/message', { turn, step, message: createAssistantMessage({ content: [{ type: 'text', text }], source: this.options }), stream: [...stream.snapshot()] }, { surfaceOp: 'append' })
      this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } } })
    } catch (error) {
      if (text) push({ type: 'block-end', index: 0, block: { type: 'text', text } })
      push({ type: 'finish', reason: { kind: signal.aborted ? 'aborted' : 'error', failure: { code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN', message: 'Nexus request did not complete' } } })
      const event = this.session.append('assistant/attempt', { turn, step, stream: [...stream.snapshot()] })
      this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: event.seq } } })
      throw error
    }
  }
  async stop() {
    this.disposed = true
    this.wakeRequested = false
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
  }
}
