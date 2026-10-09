import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent, type AgentCancelCause, type AgentStatus, type CancelOptions, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createAssistantMessage, createSystemMessage, createUserMessage, createToolResultMessage, LlmAttemptId, type StreamChunk, type UserMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { NativeInbox } from './inbox.js'
import { INSTRUCTIONS, MODEL, RealtimeConnection, RealtimeFailure, VOICE_INSTRUCTIONS, type Response, type ServerTurn } from './realtime.js'
import { registerWorkSessions } from './work-sessions.js'
import { renderPrompt, renderContextSnapshot, type SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ToolExecutionResult, ToolRuntime } from '@deepseek-ai/dsh-tools'

export interface Config { credentialRef: string; endpoint: string; timeoutMs?: number }

/** The client end of a call: where model audio goes and how a failed model connection is reported. */
export interface CallLink { audio(delta: string): void; failed(code: string): void }
/** A live call as its Remote stream holds it. */
export interface LiveCall { append(audio: string): void; end(): void }

/** Settle with the promise, or reject as soon as the turn is cancelled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
/** How long a committed utterance waits for its transcript once its reply has settled. */
const TRANSCRIPT_GRACE_MS = 3000

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
  private composing?: Promise<void>
  private tools!: ToolRuntime
  private prompt!: SystemPrompt
  private connection?: RealtimeConnection
  private call?: { abort: AbortController; connection?: RealtimeConnection }
  private readonly voiceTurns: ServerTurn[] = []
  status: AgentStatus = 'idle'

  constructor(ctx: Context, readonly session: Session, private config: Config) {
    this.id = session.id
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.events = agentEvents(this.ctx, this)
    this.inbox = new NativeInbox(session, this.ctx, this.events)
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start') this.turn = Math.max(this.turn, event.data.turn)
    }
    // Stream attempts are transient; the durable cursor keeps new ids distinct
    // from attempts emitted by earlier process instances.
    this.revision = session.seq
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
    this.wakeRequested = false
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
        signal.throwIfAborted()
        // A committed utterance opens its own turn; the server is already answering it.
        const voice = this.voiceTurns.shift()
        const messages = voice ? [] : this.inbox.claim(turn)
        if (!voice && !messages.length) continue
        step = 1
        this.session.append('step/start', { turn, step })
        let toolsPending = voice ? await this.request(turn, step, signal, [await this.utterance(voice, signal)], voice) : await this.request(turn, step, signal, messages)
        // Stopping listeners may add steering for another step of this turn.
        while (true) {
          signal.throwIfAborted()
          if (!toolsPending && !this.inbox.nextStep.length) {
            await this.events.serial('agent/turn-stopping', { turn, signal })
            signal.throwIfAborted()
            if (!this.inbox.nextStep.length) break
          }
          this.session.append('step/end', { turn, step })
          step++
          this.session.append('step/start', { turn, step })
          const steering = this.inbox.claim(turn, 'next-step')
          toolsPending = await this.request(turn, step, signal, steering)
        }
      } catch (error) {
        if (signal.aborted) reason = { kind: 'aborted', reason: signal.reason }
        else {
          const failure = { code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN', message: error instanceof RealtimeFailure ? error.message : 'Nexus request failed' }
          reason = { kind: 'error', error: failure }
          this.events.emit('agent/error', { turn, step, error: new Error(failure.message) })
        }
      } finally {
        if (this.connection !== this.call?.connection) this.connection?.close()
        this.connection = undefined
        if (step) this.session.append('step/end', { turn, step })
        this.session.append('turn/end', { turn, reason: reason ?? { kind: 'completed' } })
      }
      if (signal.aborted) break
      this.wakeRequested = false
    } while (this.inbox.nextTurn.length || this.inbox.nextStep.length || this.voiceTurns.length)
  }
  /** The user's words of one committed utterance, recorded as the user's own input. */
  private async utterance(voice: ServerTurn, signal: AbortSignal) {
    const settled = voice.response.then(() => {}, () => {}).then(() => new Promise<undefined>(resolve => setTimeout(resolve, TRANSCRIPT_GRACE_MS)))
    const transcript = await abortable(Promise.race([voice.transcript, settled]), signal)
    return createUserMessage({ content: [{ type: 'text', text: transcript ?? '[Voice input; the endpoint returned no transcription]' }], source: { kind: 'user' } })
  }
  private compose() {
    // Preset retention audits the settled Host loader; compose at first work
    // rather than awaiting that loader from its own plugin activation.
    return this.composing ??= (async () => {
      await this.ctx.agentPresets.mount(this.ctx)
      const tools = this.ctx.agentPresets.serviceFor(this, 'tools') ?? this.ctx.get('tools')
      const prompt = this.ctx.agentPresets.serviceFor(this, 'systemPrompt') ?? this.ctx.get('systemPrompt')
      if (!tools || !prompt) throw new Error('The selected native preset must provide tools and systemPrompt')
      this.tools = this.ctx.reflect.trace(tools)
      this.prompt = this.ctx.reflect.trace(prompt)
      registerWorkSessions(this.ctx, this, this.tools)
    })().catch(error => { this.composing = undefined; throw error })
  }
  private surface() {
    const surface = new Set(this.session.surface.nodes)
    return this.session.snapshotEvents().filter(event => surface.has(event.seq))
  }
  /**
   * Connect the same model with audio for one client: utterances its VAD
   * commits become native turns, and later supervisor requests use this
   * connection while the call lasts. Resolves once the model accepted the
   * voice session and the native context.
   */
  async startCall(link: CallLink, signal: AbortSignal): Promise<LiveCall> {
    if (this.disposed) throw new RealtimeFailure('UNAVAILABLE')
    if (this.call) throw new RealtimeFailure('CALL_BUSY')
    const call: { abort: AbortController; connection?: RealtimeConnection } = { abort: new AbortController() }
    this.call = call
    const end = () => {
      signal.removeEventListener('abort', end)
      if (this.call !== call) return
      this.call = undefined
      call.abort.abort()
      call.connection?.close()
    }
    signal.addEventListener('abort', end, { once: true })
    try {
      await this.compose()
      const assembly = await this.prompt.assemble(assembleContextFor(this, call.abort.signal))
      const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
      if (!credential) throw new RealtimeFailure('CREDENTIAL_MISSING')
      call.abort.signal.throwIfAborted()
      const connection = new RealtimeConnection(this.config.endpoint, credential.value, call.abort.signal, this.config.timeoutMs ?? 30000, {
        audio: link.audio,
        committed: turn => { this.voiceTurns.push(turn); this.wakeRequested = true; this.wake() },
        failed: error => { end(); link.failed(error.code) },
      })
      await connection.open(this.surface(), assembly.tools, `${VOICE_INSTRUCTIONS}\n\n${renderPrompt(assembly)}`)
      call.connection = connection
      return { append: audio => connection.appendAudio(audio), end }
    } catch (error) {
      end()
      throw error instanceof RealtimeFailure ? error : call.abort.signal.aborted ? new RealtimeFailure('ABORTED') : error
    }
  }
  private async request(turn: number, step: number, signal: AbortSignal, inputs: readonly UserMessage[], voice?: ServerTurn) {
    if (!this.session.surface.nodes.some(seq => this.session.eventAt(seq)?.type === 'system/message')) this.session.append('system/message', { turn, step, message: createSystemMessage(INSTRUCTIONS) }, { surfaceOp: 'append' })
    for (const message of inputs) this.session.append('user/message', message, { surfaceOp: 'append' })
    await this.compose()
    signal.throwIfAborted()
    // A turn keeps the connection it started on; a live call serves the turns that start during it.
    if (voice) this.connection = voice.connection
    this.connection ??= this.call?.connection
    for (const message of voice ? inputs : []) this.connection?.markPresent(message.id)
    const assembly = await this.prompt.assemble(assembleContextFor(this, signal))
    const instructions = `${this.connection?.voice ? VOICE_INSTRUCTIONS : INSTRUCTIONS}\n\n${renderPrompt(assembly)}`
    const previous = this.session.requestHeader()
    const header = { config: this.options, tools: assembly.tools }
    this.session.append('request/header', { header, reason: !previous ? 'initial' : JSON.stringify(previous) === JSON.stringify(header) ? 'series' : 'change' })
    const system = this.session.surface.nodes.map(seq => this.session.eventAt(seq)).find(event => event?.type === 'system/message')
    if (!system || JSON.stringify(system.data.message.content) !== JSON.stringify([{ type: 'text', text: instructions }])) {
      this.session.append('system/message', { turn, step, message: createSystemMessage(instructions) }, system ? { surfaceOp: { op: 'replace', startSeq: system.seq, endSeq: system.seq }, sourceEventSeqs: [system.seq] } : { surfaceOp: 'append' })
    }
    const context = renderContextSnapshot(assembly)
    const retained = this.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'nexus-runtime')
    if (context && (!retained || retained.type !== 'user/message' || JSON.stringify(retained.data.content) !== JSON.stringify([{ type: 'text', text: context }]))) this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: context }], source: { kind: 'nexus-runtime', form: 'snapshot' } }), { surfaceOp: 'append' })
    if (!this.connection) {
      const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
      if (!credential) throw new RealtimeFailure('CREDENTIAL_MISSING')
      signal.throwIfAborted()
      this.connection = new RealtimeConnection(this.config.endpoint, credential.value, signal, this.config.timeoutMs ?? 30000)
    }
    const connection = this.connection
    const attemptId = LlmAttemptId(`${this.id}:${++this.revision}`)
    const revision = this.revision
    const stream = new AssistantStreamAccumulator()
    let index = 0
    let text = ''
    let calls: ToolCallBlock[] = []
    const push = (chunk: StreamChunk) => {
      const time = Date.now()
      stream.push({ time, chunk })
      this.events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision, index: index++, time, chunk } })
    }
    this.events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId, revision, turn, step } })
    push({ type: 'block-start', index: 0, blockType: 'text' })
    try {
      const onText = (delta: string) => { text += delta; push({ type: 'text-delta', index: 0, text: delta }) }
      let response: Response
      if (voice) { voice.listen(onText); response = await abortable(voice.response, signal) }
      else response = await abortable(connection.request(this.surface(), onText, assembly.tools, instructions), signal)
      text = response.text
      if (connection.voice && !text && !response.calls.length) {
        // The model chose not to answer aloud; nothing is recorded as said.
        this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'abandoned' } } })
        return false
      }
      calls = response.calls
      push({ type: 'block-end', index: 0, block: { type: 'text', text } })
      for (const [offset, call] of response.calls.entries()) {
        push({ type: 'block-start', index: offset + 1, blockType: 'tool-call' })
        push({ type: 'tool-call-delta', index: offset + 1, id: call.id, name: call.name, argumentsDelta: call.arguments })
        push({ type: 'block-end', index: offset + 1, block: call })
      }
      push({ type: 'finish', reason: { kind: response.calls.length ? 'tool-calls' : 'stop' } })
      const message = createAssistantMessage({ content: [...(text ? [{ type: 'text' as const, text }] : []), ...response.calls], source: this.options })
      connection.markPresent(message.id)
      const event = this.session.append('assistant/message', { turn, step, message, stream: [...stream.snapshot()] }, { surfaceOp: 'append' })
      this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } } })
    } catch (error) {
      if (text) push({ type: 'block-end', index: 0, block: { type: 'text', text } })
      push({ type: 'finish', reason: { kind: signal.aborted ? 'aborted' : 'error', failure: { code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN', message: 'Nexus request did not complete' } } })
      const event = this.session.append('assistant/attempt', { turn, step, stream: [...stream.snapshot()] })
      this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: event.seq } } })
      throw error
    }
    let concluded = false
    for (const call of calls) concluded = (await this.execute(call, turn, step, signal)) || concluded
    return calls.length > 0 && !concluded
  }
  private async execute(call: ToolCallBlock, turn: number, step: number, signal: AbortSignal) {
    this.session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    let result: ToolExecutionResult | undefined
    let args: unknown
    try { args = JSON.parse(call.arguments) }
    catch {
      result = { isError: true, error: { message: 'Tool arguments must be valid JSON.', info: { name: 'ToolArgumentsError', code: 'INVALID_ARGUMENTS' } }, content: [{ type: 'text', text: 'Tool arguments must be valid JSON.' }] }
    }
    result ??= await this.ctx.agents.withInitiator(this, () => this.tools.execute({ callId: call.id, name: call.name, arguments: args, agent: this, signal }))
    this.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: call.id, content: result.content, isError: result.isError }), ...(result.isError && result.error.info ? { error: result.error.info } : {}), ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append' })
    for (const message of result.additionalContexts ?? []) this.session.append('user/message', message, { surfaceOp: 'append' })
    return result.concludesTurn === true
  }
  async stop() {
    this.disposed = true
    this.wakeRequested = false
    if (this.call) { const call = this.call; this.call = undefined; call.abort.abort(); call.connection?.close() }
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
  }
}
