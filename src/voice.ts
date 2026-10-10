import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RealtimeFailure } from './realtime.js'
import type { Supervisor } from './supervisor.js'

declare module '@deepseek-ai/cordis' {
  interface Context { nexusVoice: VoiceController }
}

/** Host-to-client items of one call: actual call state, and model audio (base64 PCM16, 24 kHz mono). */
export type VoiceFrame =
  | { type: 'state'; state: 'connecting' | 'live' }
  | { type: 'state'; state: 'failed'; code: string }
  | { type: 'audio'; audio: string }
/** Client-to-Host items: captured microphone audio (base64 PCM16, 16 kHz mono). */
export type VoiceUplink = { type: 'audio'; audio: string }

/** Unbounded single-consumer frame queue ended by the call. */
class Frames implements AsyncIterable<VoiceFrame> {
  private items: VoiceFrame[] = []
  private wake?: () => void
  private ended = false
  push(frame: VoiceFrame) { if (!this.ended) { this.items.push(frame); this.wake?.() } }
  end() { this.ended = true; this.wake?.() }
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

  constructor(ctx: Context) { super(ctx, 'nexusVoice') }

  attach(supervisor: Supervisor) {
    this.supervisor = supervisor
    return () => { if (this.supervisor === supervisor) this.supervisor = undefined }
  }

  /**
   * Hold one call: report the actual state, forward captured audio to the model and model audio to the client.
   * @param signal - the client's end of the call.
   */
  @Remote({ mode: 'stream' })
  async *call(signal: AbortSignal): AsyncGenerator<VoiceFrame> {
    const frames = new Frames()
    signal.addEventListener('abort', () => frames.end(), { once: true })
    yield { type: 'state', state: 'connecting' }
    const supervisor = this.supervisor
    let live
    try {
      if (!supervisor) throw new RealtimeFailure('UNAVAILABLE')
      live = await supervisor.startCall({ audio: audio => frames.push({ type: 'audio', audio }), failed: code => { frames.push({ type: 'state', state: 'failed', code }); frames.end() } }, signal)
    } catch (error) {
      if (!signal.aborted) yield { type: 'state', state: 'failed', code: error instanceof RealtimeFailure ? error.code : 'UNKNOWN' }
      return
    }
    try {
      yield { type: 'state', state: 'live' }
      const uplink = this.ctx.invocation!.uplink<VoiceUplink>()
      const pump = (async () => { for await (const item of uplink) if (item.type === 'audio' && typeof item.audio === 'string') live.append(item.audio) })()
      pump.catch(() => frames.end())
      yield* frames
    } finally {
      live.end()
    }
  }
}
