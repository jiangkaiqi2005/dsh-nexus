import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'

export const TTS_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
export const TTS_MODEL = 'qwen-audio-3.1-tts-flash'
export const TTS_VOICE = 'longanhuan_v3.1'
export type SpeechActivity = 'thinking' | 'reading' | 'idle' | 'failed' | 'recording' | 'recognizing' | 'unheard'
export interface SpeechLink { audio(audio: string, replyId?: string): void; flush(replyId?: string): void; activity?(state: SpeechActivity, code?: string): void }
export interface Playback { replyId: string; samples: number }
interface SpeechOptions { endpoint: string; model: string; voice: string; timeoutMs: number; credential(): Promise<string | undefined> }

/** One reply's incremental text and short-lived DashScope inference task. Model work never waits for it. */
class SpokenReply {
  readonly done: Promise<void>
  readonly taskId = randomUUID()
  samples = 0
  played = 0
  completed = false
  private submitted: string[] = []
  private recognized = ''
  private boundaries: { text: string; samples: number }[] = []
  private settle!: () => void
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private text = ''
  private sentences: string[] = []
  private ended = false
  private stopped = false
  private opening = false
  private started = false
  private sentFinish = false
  private allowed = false

  constructor(previous: Promise<void>, private options: SpeechOptions, private link: SpeechLink) {
    this.done = new Promise(resolve => { this.settle = resolve })
    void previous.then(() => { this.allowed = true; this.pump() })
  }
  append(delta: string) {
    if (this.stopped) return
    this.text += delta
    // Chinese/English sentence ends and newlines, retaining punctuation in the spoken text.
    let boundary: RegExpExecArray | null
    while ((boundary = /[。！？!?\n]|\.(?=\s|$)/.exec(this.text))) {
      const end = boundary.index + boundary[0].length
      const sentence = this.text.slice(0, end).trim()
      this.text = this.text.slice(end)
      if (sentence) this.sentences.push(sentence)
    }
    this.pump()
  }
  finish() {
    if (this.stopped) return
    if (this.text.trim()) this.sentences.push(this.text.trim())
    this.text = ''
    this.ended = true
    this.pump()
  }
  cancel() {
    if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) this.send('finish-task', { input: { directive: 'cancel' } })
    this.stop()
    this.link.flush(this.taskId)
    this.link.activity?.('idle')
  }
  heard() { return this.boundaries.filter(item => item.samples <= this.played).map(item => item.text) }
  private stop() {
    if (this.stopped) return
    this.stopped = true
    this.sentences = []
    clearTimeout(this.timer)
    if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate()
    else this.socket?.close()
    this.settle()
  }
  private fail(code: string) {
    if (this.stopped) return
    if (this.socket?.readyState === WebSocket.OPEN) this.send('finish-task', { input: { directive: 'cancel' } })
    this.stop()
    this.link.flush(this.taskId)
    this.link.activity?.('failed', code)
  }
  private timeout() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fail('TTS_TIMEOUT'), this.options.timeoutMs)
  }
  private send(action: string, payload: object) {
    this.socket!.send(JSON.stringify({ header: { action, task_id: this.taskId, streaming: 'duplex' }, payload }))
  }
  private pump() {
    if (this.stopped || !this.allowed) return
    if (!this.opening) {
      if (!this.sentences.length) {
        if (this.ended) { this.stop(); this.link.activity?.('idle') }
        return
      }
      this.opening = true
      this.timeout()
      void this.open().catch(() => this.fail('TTS_CONNECTION_FAILED'))
    }
    if (!this.started) return
    for (const text of this.sentences.splice(0)) { this.submitted.push(text); this.send('continue-task', { input: { text } }); this.timeout() }
    if (this.ended && !this.sentFinish) { this.sentFinish = true; this.send('finish-task', { input: {} }); this.timeout() }
  }
  private async open() {
    const credential = await this.options.credential()
    if (this.stopped) return
    if (!credential) return this.fail('TTS_CREDENTIAL_MISSING')
    const socket = this.socket = new WebSocket(this.options.endpoint, { headers: { Authorization: `Bearer ${credential}` }, handshakeTimeout: this.options.timeoutMs })
    socket.on('error', () => this.fail('TTS_CONNECTION_FAILED'))
    socket.on('close', () => this.fail('TTS_CONNECTION_CLOSED'))
    socket.on('open', () => {
      if (this.stopped) return
      this.send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: this.options.model, parameters: { text_type: 'PlainText', voice: this.options.voice, format: 'pcm', sample_rate: 24000 }, input: {} })
      this.timeout()
    })
    socket.on('message', (data, binary) => {
      if (this.stopped) return
      this.timeout()
      if (binary) {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        if (bytes.length % 2) return this.fail('TTS_PROTOCOL_ERROR')
        this.samples += bytes.length / 2
        this.link.activity?.('reading')
        for (let offset = 0; offset < bytes.length; offset += 32768) this.link.audio(bytes.subarray(offset, offset + 32768).toString('base64'), this.taskId)
        return
      }
      let event
      try { event = JSON.parse(data.toString()) } catch { return this.fail('TTS_PROTOCOL_ERROR') }
      if (event.header?.task_id !== this.taskId) return this.fail('TTS_PROTOCOL_ERROR')
      if (event.header.event === 'task-started') { this.started = true; this.pump() }
      else if (event.header.event === 'task-failed') this.fail('TTS_SYNTHESIS_FAILED')
      else if (event.header.event === 'result-generated' && event.payload?.output?.type === 'sentence-end') {
        // The provider may split our sentence again at commas and send multiple PCM frames.
        // Only a matching, complete submitted sentence gets a heard boundary; never estimate it.
        const text = event.payload.output.sentence?.original_text
        if (typeof text === 'string') {
          this.recognized += text.replace(/\s/g, '')
          while (this.submitted.length && this.recognized.startsWith(this.submitted[0].replace(/\s/g, ''))) {
            const sentence = this.submitted.shift()!
            this.recognized = this.recognized.slice(sentence.replace(/\s/g, '').length)
            this.boundaries.push({ text: sentence, samples: this.samples })
          }
        }
      }
      else if (event.header.event === 'task-finished') { this.completed = true; this.stop(); this.link.activity?.('idle') }
    })
  }
}

/** A media-only call. Short-lived reply tasks run in spoken order independently of the supervisor. */
export class CascadeCall {
  private replies = new Set<SpokenReply>()
  private tail = Promise.resolve()
  private ended = false
  private generating = 0
  private recording = false
  private buffered: { audio: string; replyId: string }[] = []
  constructor(private options: () => SpeechOptions, private link: SpeechLink, private cut: (heard: string[], ended: boolean, confirmed: boolean) => void) {}
  setRecording(recording: boolean) {
    this.recording = recording
    if (!recording && !this.ended) for (const frame of this.buffered.splice(0)) this.link.audio(frame.audio, frame.replyId)
  }
  played(playback: Playback[]) {
    for (const item of playback) for (const reply of this.replies) if (reply.taskId === item.replyId) {
      reply.played = Math.min(reply.samples, Math.max(reply.played, item.samples))
      if (reply.completed && reply.played === reply.samples) this.replies.delete(reply)
    }
  }
  interrupt(playback: Playback[], ended = false, confirmed = true) {
    this.played(playback)
    const interrupted = new Set(playback.map(item => item.replyId))
    const heard: string[] = []
    let cut = false
    for (const reply of this.replies) {
      if (!ended && !interrupted.has(reply.taskId)) continue
      if (reply.samples && (!reply.completed || reply.played < reply.samples)) { cut = true; heard.push(...reply.heard()) }
      reply.cancel()
      this.replies.delete(reply)
    }
    this.buffered = ended ? [] : this.buffered.filter(frame => !interrupted.has(frame.replyId))
    if (cut) this.cut(heard, ended, confirmed)
  }
  reply() {
    if (this.ended) return undefined
    this.link.activity?.('thinking')
    this.generating++
    let generating = true
    const complete = () => { if (generating) { generating = false; this.generating-- } }
    const reply = new SpokenReply(this.tail, this.options(), {
      audio: (audio, replyId) => { if (this.recording) this.buffered.push({ audio, replyId: replyId! }); else this.link.audio(audio, replyId) },
      flush: replyId => { this.buffered = this.buffered.filter(frame => frame.replyId !== replyId); this.link.flush(replyId) },
      activity: (state, code) => this.link.activity?.(state === 'idle' && this.generating ? 'thinking' : state, code),
    })
    this.replies.add(reply)
    this.tail = reply.done
    void reply.done.then(() => { if (!reply.completed || reply.played === reply.samples) this.replies.delete(reply) })
    return { append: (delta: string) => reply.append(delta), finish: () => { complete(); reply.finish() }, cancel: () => { complete(); reply.cancel() } }
  }
  end() {
    if (this.ended) return
    this.ended = true
    this.interrupt([], true, false)
    this.link.flush()
  }
}
