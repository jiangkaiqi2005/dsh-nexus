import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RealtimeFailure } from './realtime.js'
import type { Supervisor } from './supervisor.js'
import type { SpeechActivity } from './speech.js'

declare module '@deepseek-ai/cordis' {
  interface Context { nexusVoice: VoiceController }
}

/**
 * Host-to-client items of one call: actual call state, model audio (base64 PCM16, 24 kHz mono), and
 * flush: the user started speaking, so audio still queued or playing stops and is discarded.
 */
export type VoiceFrame =
  | { type: 'state'; state: 'ready' | 'connecting' | 'live'; mode?: 'cascade' | 'realtime' }
  | { type: 'state'; state: 'failed'; code: string }
  | { type: 'audio'; audio: string; replyId?: string }
  | { type: 'flush'; replyId?: string }
  | { type: 'activity'; state: SpeechActivity; code?: string }
/**
 * Client-to-Host items: captured microphone audio (base64 PCM16, 16 kHz mono), and the answer to
 * each flush or hangup: how many samples of the audio received since the previous flush were played.
 */
export type VoiceUplink = { type: 'ready' } | { type: 'audio'; audio: string } | { type: 'played' | 'hangup'; samples: number }

/** Unbounded single-consumer frame queue ended by the call. */
class Frames implements AsyncIterable<VoiceFrame> {
  private items: VoiceFrame[] = []
  private wake?: () => void
  private ended = false
  push(frame: VoiceFrame) { if (!this.ended) { this.items.push(frame); this.wake?.() } }
  end(discard = false) { if (discard) this.items = []; this.ended = true; this.wake?.() }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) { yield this.items.shift()!; continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/**
 * The client-facing call endpoint: the Nexus client captures and plays audio,
 * while the Host keeps the model connection and tool execution. One logical
 * Remote stream is one call; it ends when the client ends the stream.
 */
export class VoiceController extends TypertRemoteService {
  private supervisor?: Supervisor
  private ready: Promise<void>
  private markReady!: () => void
  private owner?: symbol

  constructor(ctx: Context, private startup: { enabled: boolean; attempted: boolean }) {
    super(ctx, 'nexusVoice')
    this.ready = new Promise(resolve => { this.markReady = resolve })
  }

  attach(supervisor: Supervisor) {
    this.supervisor = supervisor
    this.markReady()
    return () => { if (this.supervisor === supervisor) this.supervisor = undefined }
  }

  /** Claim this Host launch's sole automatic attempt before any client requests media. */
  @Remote
  async claimStartup(signal: AbortSignal): Promise<boolean> {
    if (!this.startup.enabled) return false
    await new Promise<void>(resolve => {
      const done = () => { signal.removeEventListener('abort', done); resolve() }
      if (signal.aborted) return done()
      signal.addEventListener('abort', done, { once: true })
      void this.ready.then(done)
    })
    if (signal.aborted || this.startup.attempted || !this.supervisor) return false
    this.startup.attempted = true
    return true
  }

  /**
   * Hold one call: report the actual state, forward captured audio to the model and model audio to the client.
   * @param signal - the client's end of the call.
   */
  @Remote({ mode: 'stream' })
  async *call(signal: AbortSignal): AsyncGenerator<VoiceFrame> {
    if (this.owner) { yield { type: 'state', state: 'failed', code: 'CALL_BUSY' }; return }
    const owner = this.owner = Symbol()
    const frames = new Frames()
    signal.addEventListener('abort', () => frames.end(true), { once: true })
    const supervisor = this.supervisor
    let live
    const incoming = this.ctx.invocation!.uplink<VoiceUplink>()[Symbol.asyncIterator]()
    try {
      if (!supervisor) throw new RealtimeFailure('UNAVAILABLE')
      // Reserve the sole media owner before the client asks for microphone or playback.
      yield { type: 'state', state: 'ready' }
      const ready = await incoming.next()
      if (signal.aborted || ready.done || ready.value.type !== 'ready') return
      yield { type: 'state', state: 'connecting' }
      live = await supervisor.startCall({ audio: (audio, replyId) => frames.push({ type: 'audio', audio, ...(replyId ? { replyId } : {}) }), flush: replyId => frames.push({ type: 'flush', ...(replyId ? { replyId } : {}) }), activity: (state, code) => frames.push({ type: 'activity', state, ...(code ? { code } : {}) }), state: state => frames.push({ type: 'state', state }), failed: code => { frames.push({ type: 'state', state: 'failed', code }); frames.end() } }, signal)
      yield { type: 'state', state: 'live', ...(live.mode ? { mode: live.mode } : {}) }
      const pump = (async () => {
        for (let next = await incoming.next(); !next.done; next = await incoming.next()) {
          const item = next.value
          if (item.type === 'audio' && typeof item.audio === 'string') live.append(item.audio)
          else if (item.type === 'played' && Number.isSafeInteger(item.samples) && item.samples >= 0) live.played(item.samples)
          else if (item.type === 'hangup') { live.hangup(item.samples); frames.end(true); return }
        }
      })()
      pump.catch(() => frames.end())
      yield* frames
    } catch (error) {
      if (!signal.aborted) yield { type: 'state', state: 'failed', code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN' }
    } finally {
      live?.end()
      if (this.owner === owner) this.owner = undefined
    }
  }
}
