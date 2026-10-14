import type { Context, Volatile } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent, type AgentCancelCause, type AgentStatus, type CancelOptions, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createAssistantMessage, createSystemMessage, createUserMessage, createToolResultMessage, isHarnessError, LlmAttemptId, type LlmCallConfig, type StreamChunk, type UserMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { canonicalHeader, type Session, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { NativeInbox } from './inbox.js'
import { requestCascade, requestRealtime, type ModelResponse } from './model-request.js'
import { CASCADE_VOICE_INSTRUCTIONS, INSTRUCTIONS, MODEL, RealtimeConnection, RealtimeFailure, VOICE_INSTRUCTIONS, type Cut, type ServerTurn } from './realtime.js'
import { MANUAL_FAILURES, RETAIN_SHARE, USEFUL_SHARE, compactableRange, summaryTarget, withSummaryModel } from './compaction.js'
import { registerWorkSessions } from './work-sessions.js'
import { renderPrompt, renderContextSnapshot, type SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ToolExecutionResult, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { CascadeCall, type SpeechActivity } from './speech.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A call fact that is not the user's words: speech the model answered without a transcript, or a
     * spoken reply whose playback the user's speech stopped, with how much of it was played.
     */
    'nexus-voice': { kind: 'nexus-voice'; form: 'notice'; summary: string }
    'nexus-connection': { kind: 'nexus-connection'; form: 'notice'; summary: string }
  }
}

/**
 * compactionBudget: estimated request tokens above which the main conversation compacts between turns.
 * summaryModel: `provider/model` that writes compaction summaries; empty is DeepSeek Flash (`DEFAULT_SUMMARY_MODEL`).
 * summaryReasoningEffort: reasoning effort of summaries; empty takes the lowest the summary model offers, `model-default` sends none.
 */
export interface Config { credentialRef: string; endpoint: string; timeoutMs?: number; voiceMode: Volatile<'cascade' | 'realtime'>; ttsEndpoint: Volatile<string>; ttsModel: Volatile<string>; ttsVoice: Volatile<string>; compactionBudget: Volatile<number>; summaryModel: Volatile<string>; summaryReasoningEffort: Volatile<string> }

/** The client end of a call: where model audio goes, when its playback must stop, and how a failed model connection is reported. */
export interface CallLink { audio(delta: string, replyId?: string): void; flush(replyId?: string): void; state(state: 'connecting' | 'live'): void; failed(code: string): void; activity?(state: SpeechActivity, code?: string): void }
/** A live call as its Remote stream holds it; played reports the samples played before the client stopped at a flush. */
export interface LiveCall { mode?: 'cascade' | 'realtime'; append(audio: string): void; played(samples: number): void; hangup(samples: number): void; end(): void }

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
/** The record of a spoken reply the user stopped while it played. */
function cutNotice({ text, heard, total, ended }: Cut) {
  const excerpt = text ? ` "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"` : ''
  return createUserMessage({ content: [{ type: 'text', text: `[The user ${ended ? 'ended the call during' : 'started speaking over'} your spoken reply${excerpt}, which stopped it: about ${heard.toFixed(1)} s of its ${total.toFixed(1)} s of audio were played; the rest was not heard.]` }], source: { kind: 'nexus-voice', form: 'notice', summary: 'interrupted playback' } })
}

const isCheckpoint = (event: SessionEvent | undefined) => event?.type === 'user/message' && isCompactCheckpointSource(event.data.source)

/** One live call: its model connection, and how it ends. */
interface Call {
  readonly abort: AbortController
  connection?: RealtimeConnection
  /** The log length when the current connection replayed the native conversation. */
  since: number
  /** A new connection being opened, for a failed transport or a compacted conversation. */
  recovering?: Promise<void>
  /**
   * Open a new connection. Given the current one, it stays in use until the new one has replayed the
   * conversation, and is replaced only if nothing was said, answered or recorded meanwhile.
   */
  reconnect(previous?: RealtimeConnection): void
  /** End the call; a failure code is reported to the client, whose stream is still open. */
  end(failure?: string): void
}

export class Supervisor implements Agent {
  readonly id
  private mode: 'cascade' | 'realtime'
  private model?: LlmCallConfig
  get options(): LlmCallConfig { return this.mode === 'realtime' ? { provider: 'dashscope-realtime', model: MODEL } : this.model ?? this.ctx.agentDefaultModel.currentSelection() }
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
  private call?: Call
  private cascadeCall?: CascadeCall
  private readonly voiceTurns: ServerTurn[] = []
  /** Automatic compaction was skipped as useless and warned about; cleared once the request is within budget or compacts. */
  private uselessWarned = false
  /** Notices of playback the user's speech stopped: already sent to the model, recorded with the next turn's input. */
  private readonly notices: UserMessage[] = []
  /** Call connections the user hung up; their unfinished requests continue on a text connection. */
  private readonly hungUp = new WeakSet<RealtimeConnection>()
  status: AgentStatus = 'idle'

  constructor(ctx: Context, readonly session: Session, private config: Config) {
    this.mode = config.voiceMode.get()
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
    // Shadows the preset's /compact for this agent, so it is listed before the preset binds at first work.
    this.ctx.commands.register({ definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'), name: 'compact', description: 'Compact older conversation history', handler: invocation => this.compactCommand(invocation) })
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
    const result = operation.finally(() => { this.maintenance = false; this.abort = undefined; this.refreshCall(); this.wake() })
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
      // A committed utterance opens its own turn; the server is already answering it.
      // An unheard commit the user abandoned leaves no record; endpoint failure retains its unavailable-input fact.
      const server = this.voiceTurns.shift()
      const said = server && await this.utterance(server, signal).catch(() => undefined)
      if (server && !said && !signal.aborted) continue
      const voice = server && said && { server, said }
      const turn = ++this.turn
      let step = 0
      this.session.append('turn/start', { turn })
      let reason: TurnEndReason | undefined
      try {
        signal.throwIfAborted()
        const input = voice ? [voice.said] : this.inbox.claim(turn)
        if (!input.length) continue
        step = 1
        this.session.append('step/start', { turn, step })
        // A notice follows the utterance it was sent during, as the server holds them; otherwise it precedes the input.
        let toolsPending = await this.request(turn, step, signal, voice ? [...input, ...this.notices.splice(0)] : [...this.notices.splice(0), ...input], voice)
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
          const failure = { code: error instanceof RealtimeFailure || isHarnessError(error) ? error.code : 'UNKNOWN', message: error instanceof RealtimeFailure || isHarnessError(error) ? error.message : 'Nexus request failed' }
          reason = { kind: 'error', error: failure }
          this.events.emit('agent/error', { turn, step, error: new Error(failure.message) })
        }
      } finally {
        if (this.connection !== this.call?.connection) this.connection?.close()
        this.connection = undefined
        if (step) this.session.append('step/end', { turn, step })
        // After the turn's last step: no reply is being produced and no tool runs.
        if (step && !reason && !signal.aborted) await this.compactOverBudget(signal)
        if (!reason && signal.aborted) reason = { kind: 'aborted', reason: signal.reason }
        this.session.append('turn/end', { turn, reason: reason ?? { kind: 'completed' } })
      }
      if (signal.aborted) break
      this.refreshCall()
      this.wakeRequested = false
    } while (this.inbox.nextTurn.length || this.inbox.nextStep.length || this.voiceTurns.length)
  }
  /**
   * The native input of one committed utterance: the user's own words when transcribed.
   * Speech the model answered without a transcript is recorded as a Nexus notice, not
   * as words the user said; an unheard commit abandoned by the client gives undefined.
   */
  private async utterance(voice: ServerTurn, signal: AbortSignal): Promise<UserMessage | undefined> {
    const answered = voice.response.then(() => true, () => false)
    const settled = answered.then(() => new Promise<undefined>(resolve => setTimeout(resolve, TRANSCRIPT_GRACE_MS)))
    const transcript = await abortable(Promise.race([voice.transcript, settled]), signal)
    if (transcript) return createUserMessage({ content: [{ type: 'text', text: transcript }], source: { kind: 'user' } })
    if (!(await answered)) {
      if (this.hungUp.has(voice.connection) || !(voice.connection.failure instanceof RealtimeFailure) || !['CONNECTION_CLOSED', 'CONNECTION_FAILED', 'TIMEOUT'].includes(voice.connection.failure.code)) return undefined
      return createUserMessage({ content: [{ type: 'text', text: '[The endpoint committed audio input, but its connection failed before a transcription or complete answer arrived. The words are unavailable; do not invent them.]' }], source: { kind: 'nexus-voice', form: 'notice', summary: 'untranscribed interrupted input' } })
    }
    return createUserMessage({ content: [{ type: 'text', text: '[The user spoke during the call; the endpoint returned no transcription of it.]' }], source: { kind: 'nexus-voice', form: 'notice', summary: 'untranscribed voice input' } })
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
  /** The preset's native compaction engine, with summaries written by the configured summary model. */
  private compaction() {
    const engine = this.ctx.agentPresets.serviceFor(this, 'compaction')
    if (!engine) throw new Error('The selected native preset must provide compaction')
    return withSummaryModel(engine, () => summaryTarget(this.config.summaryModel.get()), () => this.config.summaryReasoningEffort.get())
  }
  /**
   * Natively compact older history once the conversation exceeds the Nexus budget, keeping a recent
   * share verbatim. A failure keeps the whole conversation; the attempt stays in the log.
   */
  private async compactOverBudget(signal: AbortSignal) {
    const budget = this.config.compactionBudget.get()
    const measurement = this.ctx.tokenMeter.measure(this.session)
    if (measurement.totalTokens <= budget) { this.uselessWarned = false; return }
    const range = compactableRange(this.session, measurement, Math.floor(budget * RETAIN_SHARE))
    if (!range) return
    if (range.tokens < measurement.totalTokens * USEFUL_SHARE) {
      if (!this.uselessWarned) this.ctx.logger.warn(`nexus: automatic compaction skipped: the compactable history (~${range.tokens} tokens) is under ${USEFUL_SHARE * 100}% of the request (~${measurement.totalTokens} tokens); a compaction budget (${budget}) close to the fixed supervisor prompt cannot be reached by summarizing`)
      this.uselessWarned = true
      return
    }
    this.uselessWarned = false
    try { await this.compaction().compactRegion(range.start, range.end, this, signal) }
    catch (error) {
      if (!signal.aborted) this.ctx.logger.warn(`nexus: automatic compaction failed; the conversation is kept whole: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** `/compact` of the main conversation, as the native command but with the configured summary model. */
  private async compactCommand({ rawInput, signal, commandId }: CommandInvocation): Promise<CommandResult> {
    if (rawInput.trim()) return { kind: 'error', text: 'Usage: /compact (no arguments)' }
    try {
      await this.compose()
      const result = await this.compaction().compactNow(this, signal, commandId)
      if (!result) return { kind: 'success', text: 'No compactable history yet.' }
      return { kind: 'success', text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`, sourceEventSeq: result.summarySeq }
    } catch (error) {
      if (signal.aborted) return { kind: 'error', text: MANUAL_FAILURES.cancelled }
      // By name: the Host's error class can be another module instance than ours.
      const failure = error as { name?: unknown; code?: unknown }
      if (failure?.name === 'ManualCompactionError' && typeof failure.code === 'string' && MANUAL_FAILURES[failure.code]) return { kind: 'error', text: MANUAL_FAILURES[failure.code] }
      throw error
    }
  }
  /**
   * A live call's server conversation still holds history compacted after its connection replayed it.
   * Between turns, while nothing is said or answered, a new connection replays the compacted conversation.
   */
  private refreshCall() {
    const call = this.call
    const connection = call?.connection
    if (!call || !connection || call.recovering || this.voiceTurns.length || !connection.quiet) return
    if (this.session.surface.nodes.some(seq => seq >= call.since && isCheckpoint(this.session.eventAt(seq)))) call.reconnect(connection)
  }
  /** The model-visible events in surface order; a compaction checkpoint stands where the history it replaced stood. */
  private surface() {
    return this.session.surface.nodes.flatMap(seq => this.session.eventAt(seq) ?? [])
  }
  /**
   * Connect the same model with audio for one client: utterances its VAD
   * commits become native turns, and later supervisor requests use this
   * connection while the call lasts. Resolves once the model accepted the
   * voice session and the native context.
   */
  async startCall(link: CallLink, signal: AbortSignal): Promise<LiveCall> {
    signal.throwIfAborted()
    if (this.disposed) throw new RealtimeFailure('UNAVAILABLE')
    if (this.call || this.cascadeCall) throw new RealtimeFailure('CALL_BUSY')
    this.mode = this.config.voiceMode.get()
    this.model = undefined
    if (this.mode === 'cascade') {
      const call = this.cascadeCall = new CascadeCall(() => ({
        endpoint: this.config.ttsEndpoint.get(), model: this.config.ttsModel.get(), voice: this.config.ttsVoice.get(), timeoutMs: this.config.timeoutMs ?? 30000,
        credential: async () => (await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef)))?.value,
      }), link)
      const end = () => { signal.removeEventListener('abort', end); call.end(); if (this.cascadeCall === call) this.cascadeCall = undefined }
      signal.addEventListener('abort', end, { once: true })
      return { mode: 'cascade', append() {}, played() {}, hangup: end, end }
    }
    const call: Call = {
      abort: new AbortController(),
      since: 0,
      reconnect: previous => {
        let discarded = false
        const recovering: Promise<void> = connect(previous)
          .then(replaced => { discarded = !replaced; if (!previous && this.call === call) link.state('live') })
          .catch(failure => {
            // A replacement that could not open leaves the call on its connection; the next boundary tries again.
            if (previous && this.call === call && call.connection === previous) return this.ctx.logger.warn(`nexus voice: the compacted conversation could not be replayed on a new connection: ${failure instanceof Error ? failure.message : String(failure)}`)
            call.end(failure instanceof RealtimeFailure ? failure.code : 'CONNECTION_FAILED')
          })
          .finally(() => {
            if (call.recovering !== recovering) return
            call.recovering = undefined
            // A turn ending later retries a discarded replacement; between turns no boundary follows, so retry now.
            if (discarded && this.status === 'idle' && !this.maintenance) this.refreshCall()
          })
        call.recovering = recovering
      },
      end: failure => {
        signal.removeEventListener('abort', hangUp)
        if (this.call !== call) return
        this.call = undefined
        call.abort.abort()
        call.connection?.close()
        if (failure) link.failed(failure)
      },
    }
    const lostPlayback = (connection: RealtimeConnection) => {
      if (connection.unconfirmedPlayback) this.notices.push(createUserMessage({ content: [{ type: 'text', text: '[The audio transport closed; pending playback stopped. The final client playback acknowledgement is unavailable, so do not assume the complete spoken reply was heard.]' }], source: { kind: 'nexus-voice', form: 'notice', summary: 'unconfirmed playback after disconnect' } }))
    }
    const hangUp = () => { if (this.call !== call) return; if (call.connection) { lostPlayback(call.connection); this.hungUp.add(call.connection); call.connection.hangup() } call.end() }
    let recovered = false
    let accepted = false
    /** Resolves false when a replacement for `previous` was discarded. */
    const connect = async (previous?: RealtimeConnection): Promise<boolean> => {
      const exchanges = previous?.exchanges
      const assembly = await this.prompt.assemble(assembleContextFor(this, call.abort.signal))
      const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
      if (!credential) throw new RealtimeFailure('CREDENTIAL_MISSING')
      call.abort.signal.throwIfAborted()
      const connection = new RealtimeConnection(this.config.endpoint, credential.value, call.abort.signal, this.config.timeoutMs ?? 30000, {
        audio: link.audio,
        flush: link.flush,
        // The model learns what was heard before it answers the speech that stopped the playback.
        cut: cut => { const notice = cutNotice(cut); this.notices.push(notice); connection.insert(notice) },
        committed: turn => { this.voiceTurns.push(turn); this.wakeRequested = true; this.wake() },
        ignored: error => this.ctx.logger.info(`nexus voice: endpoint error left the call up: ${error.message}`),
        failed: error => {
          // A replacement still opening fails through its open; the call keeps its connection.
          if (call.connection !== connection) return
          lostPlayback(connection)
          // Only a live call recovers transport failure; the user's end aborts this owner first.
          if (!accepted || recovered || this.call !== call || !['CONNECTION_CLOSED', 'CONNECTION_FAILED'].includes(error.code)) return call.end(error.code)
          recovered = true
          link.flush()
          link.state('connecting')
          call.reconnect()
        },
      })
      if (!previous) call.connection = connection
      const since = this.session.seq
      const surface = this.session.surface.nodes.join()
      try { await connection.open(this.surface(), assembly.tools, `${VOICE_INSTRUCTIONS}\n\n${renderPrompt(assembly)}`) }
      catch (error) { connection.close(); throw error }
      if (previous) {
        // Its replay lacks whatever was said, answered or recorded while it opened: keep the call as it is.
        if (call.connection !== previous || !previous.quiet || previous.exchanges !== exchanges || this.voiceTurns.length || this.session.surface.nodes.join() !== surface) { connection.close(); return false }
        // The call stays live throughout; audio the client may still be playing is accounted for on the new connection, nothing is flushed.
        connection.takeOver(previous.retire())
        call.connection = connection
      }
      call.since = since
      // Notices can be waiting for a native turn when the user reconnects immediately after hanging up.
      for (const notice of this.notices) connection.insert(notice)
      return true
    }
    this.call = call
    signal.addEventListener('abort', hangUp, { once: true })
    try {
      await this.compose()
      await connect()
      accepted = true
      return { append: audio => call.connection?.appendAudio(audio), played: samples => call.connection?.played(samples), hangup: samples => { if (call.connection) { this.hungUp.add(call.connection); call.connection.hangup(samples) } call.end() }, end: hangUp }
    } catch (error) {
      call.end()
      throw error instanceof RealtimeFailure ? error : call.abort.signal.aborted ? new RealtimeFailure('ABORTED') : error
    }
  }
  /** @param voice - the utterance whose server-started reply answers this step, with its native input. */
  private async request(turn: number, step: number, signal: AbortSignal, inputs: readonly UserMessage[], voice?: { server: ServerTurn; said: UserMessage }, recovered = false): Promise<boolean> {
    // A turn keeps the connection it started on; a live call serves the turns that start during it.
    if (this.connection && (this.hungUp.has(this.connection) || this.connection.failure)) this.connection = undefined
    if (this.call?.recovering) await abortable(this.call.recovering, signal)
    if (voice) this.connection = voice.server.connection
    this.connection ??= this.call?.connection
    const callInstructions = this.cascadeCall ? CASCADE_VOICE_INSTRUCTIONS : this.connection?.voice ? VOICE_INSTRUCTIONS : INSTRUCTIONS
    if (!this.session.surface.nodes.some(seq => this.session.eventAt(seq)?.type === 'system/message')) this.session.append('system/message', { turn, step, message: createSystemMessage(callInstructions) }, { surfaceOp: 'append' })
    for (const message of inputs) this.session.append('user/message', message, { surfaceOp: 'append' })
    await this.compose()
    signal.throwIfAborted()
    const cascade = this.mode === 'cascade'
    const prepared = cascade ? await this.ctx.llm.prepareCall(this.ctx.agentDefaultModel.currentSelection(), signal) : undefined
    const selection = prepared?.config ?? this.options
    if (cascade) {
      this.model = selection
      const selected = this.session.snapshotEvents().findLast(event => event.type === 'model/selection')
      if (!selected || JSON.stringify(selected.data) !== JSON.stringify(selection)) this.session.append('model/selection', selection)
    }
    // The utterance itself is already in the server conversation.
    if (voice) this.connection?.markPresent(voice.said.id)
    const assembly = await this.prompt.assemble(assembleContextFor(this, signal))
    // A server-started voice reply answers the instructions its connection already holds.
    const instructions = voice ? voice.server.connection.instructions : `${callInstructions}\n\n${renderPrompt(assembly)}`
    const previous = this.session.requestHeader()
    const header = prepared ? canonicalHeader({ config: selection, tools: assembly.tools, adapterDefaults: prepared.adapterDefaults }) : { config: selection, tools: assembly.tools }
    this.session.append('request/header', { header, reason: !previous ? 'initial' : JSON.stringify(previous) === JSON.stringify(header) ? 'series' : 'change' })
    // The Nexus budget is the capacity the main conversation is kept within.
    const contextWindow = this.config.compactionBudget.get()
    const routed = this.session.requestContext()
    if (routed?.provider !== selection.provider || routed.model !== selection.model || routed.contextWindow !== contextWindow) this.session.append('request/context', { provider: selection.provider, model: selection.model, contextWindow })
    const system = this.session.surface.nodes.map(seq => this.session.eventAt(seq)).find(event => event?.type === 'system/message')
    if (!system || JSON.stringify(system.data.message.content) !== JSON.stringify([{ type: 'text', text: instructions }])) {
      this.session.append('system/message', { turn, step, message: createSystemMessage(instructions) }, system ? { surfaceOp: { op: 'replace', startSeq: system.seq, endSeq: system.seq }, sourceEventSeqs: [system.seq] } : { surfaceOp: 'append' })
    }
    const context = renderContextSnapshot(assembly)
    const retained = this.surface().findLast(event => event.type === 'user/message' && event.data.source.kind === 'nexus-runtime')
    if (context && (!retained || retained.type !== 'user/message' || JSON.stringify(retained.data.content) !== JSON.stringify([{ type: 'text', text: context }]))) this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: context }], source: { kind: 'nexus-runtime', form: 'snapshot' } }), { surfaceOp: 'append' })
    if (!cascade && !this.connection) {
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
    let requestedTools = false
    let finished = false
    // Chunk times are when the model produced them, also for a reply received before its turn recorded it.
    const push = (chunk: StreamChunk, time = Date.now()) => {
      if (chunk.type === 'finish') finished = true
      stream.push({ time, chunk })
      this.events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision, index: index++, time, chunk } })
    }
    this.events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId, revision, turn, step } })
    // The text block starts with its first delta, so a replayed reply keeps its chunk times in order.
    let begun = false
    const begin = (time?: number) => { if (!begun) { begun = true; push({ type: 'block-start', index: 0, blockType: 'text' }, time) } }
    const speech = cascade ? this.cascadeCall?.reply() : undefined
    try {
      const onText = (delta: string, time?: number) => { text += delta; speech?.append(delta); if (!cascade) { begin(time); push({ type: 'text-delta', index: 0, text: delta }, time) } }
      const request = { surface: this.surface(), onText, tools: assembly.tools, instructions, signal, onChunk: push }
      const response: ModelResponse = await abortable(prepared
        ? requestCascade(prepared, { ...selection, messages: this.session.deriveMessages(), toolHistory: this.session.toolHistory(), tools: assembly.tools, sessionId: this.id, signal }, request)
        : requestRealtime(connection!, request, voice?.server), signal)
      text = response.text
      speech?.finish()
      /** A response that leaves no message: its reported usage stays as a content-free attempt, as native settlements do. */
      const settleEmpty = () => {
        if (!response.usage) return this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'abandoned' } } })
        const event = this.session.append('assistant/attempt', { turn, step, stream: [...stream.snapshot()] })
        this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: event.seq } } })
      }
      if (connection?.voice && !text && !response.calls.length) {
        // The model chose not to answer aloud; nothing is recorded as said.
        if (response.usage) {
          push({ type: 'usage', usage: response.usage }, response.settledAt)
          push({ type: 'finish', reason: { kind: 'stop' } }, response.settledAt)
        }
        settleEmpty()
        return false
      }
      const completed = new Set(this.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message.toolCallId] : []))
      calls = cascade ? response.calls : response.calls.filter(call => !completed.has(call.id))
      requestedTools = response.calls.length > 0
      if (calls.length !== response.calls.length) this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `[The model repeated completed tool calls; reuse their native results without executing them again: ${response.calls.filter(call => completed.has(call.id)).map(call => call.id).join(', ')}.]` }], source: { kind: 'nexus-connection', form: 'notice', summary: 'reused completed tool results' } }), { surfaceOp: 'append' })
      if (!cascade) {
        begin(response.settledAt)
        push({ type: 'block-end', index: 0, block: { type: 'text', text } }, response.settledAt)
        for (const [offset, call] of calls.entries()) {
          push({ type: 'block-start', index: offset + 1, blockType: 'tool-call' }, response.settledAt)
          push({ type: 'tool-call-delta', index: offset + 1, id: call.id, name: call.name, argumentsDelta: call.arguments }, response.settledAt)
          push({ type: 'block-end', index: offset + 1, block: call }, response.settledAt)
        }
        if (response.usage) push({ type: 'usage', usage: response.usage }, response.settledAt)
        push({ type: 'finish', reason: response.interrupted ? { kind: 'aborted', failure: { code: 'INTERRUPTED', message: 'The user started speaking; the reply stopped' } } : { kind: response.calls.length ? 'tool-calls' : 'stop' } }, response.settledAt)
      }
      if (!text && !calls.length && !response.message?.content.length) {
        settleEmpty()
        return response.calls.length > 0
      }
      const message = response.message ?? createAssistantMessage({ content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls], source: selection })
      connection?.markPresent(message.id)
      // Cancelled streams retain the delivered prefix; a commit folded into later speech may be empty.
      const event = this.session.append('assistant/message', { turn, step, message, stream: [...stream.snapshot()], ...(response.usage ? { usage: response.usage } : {}), ...(response.interrupted ? { interrupted: true as const } : {}) }, { surfaceOp: 'append' })
      this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } } })
    } catch (error) {
      speech?.cancel()
      if (!cascade) {
        begin()
        if (text) push({ type: 'block-end', index: 0, block: { type: 'text', text } })
        push({ type: 'finish', reason: { kind: signal.aborted ? 'aborted' : 'error', failure: { code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN', message: 'Nexus request did not complete' } } })
      } else if (!finished) push({ type: 'finish', reason: { kind: signal.aborted ? 'aborted' : 'error', failure: { code: isHarnessError(error) ? error.code : 'UNKNOWN', message: isHarnessError(error) ? error.message : 'Nexus request did not complete' } } })
      const event = this.session.append('assistant/attempt', { turn, step, stream: [...stream.snapshot()] })
      this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision, index, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: event.seq } } })
      // Hanging up does not drop what the call was answering: the step continues in text.
      if (!signal.aborted && connection && this.hungUp.has(connection)) { this.connection = undefined; return this.request(turn, step, signal, this.notices.splice(0)) }
      if (!signal.aborted && connection && error instanceof RealtimeFailure && ['CONNECTION_CLOSED', 'CONNECTION_FAILED', 'TIMEOUT'].includes(error.code)) {
        const pending = connection.unfinishedCalls.map(call => `${call.id}: ${call.name} ${call.arguments}`).join('\n')
        const notice = createUserMessage({ content: [{ type: 'text', text: `[Model connection interrupted (${error.code}); the previous response did not complete.${pending ? ` These tool calls were not executed because their response never completed:\n${pending}` : ''} Continue from the native input and completed tool results; do not claim the interrupted response completed.]` }], source: { kind: 'nexus-connection', form: 'notice', summary: 'interrupted model response' } })
        this.session.append('user/message', notice, { surfaceOp: 'append' })
        if (!recovered) {
          this.connection = undefined
          if (this.call?.recovering) await abortable(this.call.recovering, signal)
          return this.request(turn, step, signal, this.notices.splice(0), undefined, true)
        }
      }
      throw error
    }
    let concluded = false
    for (const call of calls) concluded = (await this.execute(call, turn, step, signal)) || concluded
    return requestedTools && !concluded
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
    this.call?.end('UNAVAILABLE')
    this.cascadeCall?.end()
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
  }
}
