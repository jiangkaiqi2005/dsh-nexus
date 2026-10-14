export const ASR_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
export const ASR_MODEL = 'qwen-audio-3.1-asr-flash'
const MAX_BYTES = 16000 * 2 * 60
interface RecognitionOptions { endpoint: string; model: string; timeoutMs: number; credential(): Promise<string | undefined> }
type InputActivity = 'recording' | 'recognizing' | 'unheard'

/** Whole-utterance capture and recognition owned by one media call, never by a supervisor turn. */
export class Recording {
  private chunks?: Buffer[]
  private bytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private request?: AbortController
  private ended = false
  phase?: InputActivity
  constructor(private options: () => RecognitionOptions, private activity: () => void, private deliver: (text: string) => void) {}
  start() {
    if (this.ended || this.chunks || this.request) return
    this.chunks = []; this.bytes = 0; this.phase = 'recording'; this.activity()
    this.timer = setTimeout(() => this.finish(), 60000)
  }
  append(audio: string) {
    if (!this.chunks) return
    const bytes = Buffer.from(audio, 'base64')
    if (bytes.length % 2) { this.clear(); this.phase = 'unheard'; this.activity(); return }
    const bounded = bytes.subarray(0, MAX_BYTES - this.bytes)
    this.chunks.push(bounded); this.bytes += bounded.length
    if (this.bytes === MAX_BYTES) this.finish()
  }
  finish() {
    if (!this.chunks || this.ended) return
    const pcm = Buffer.concat(this.chunks, this.bytes)
    this.clear()
    if (!pcm.length) { this.phase = 'unheard'; this.activity(); return }
    const request = this.request = new AbortController()
    this.phase = 'recognizing'; this.activity()
    const options = this.options()
    this.timer = setTimeout(() => request.abort(), options.timeoutMs)
    void this.recognize(pcm, options, request.signal).then(text => {
      if (this.ended || request.signal.aborted) return
      this.phase = text ? undefined : 'unheard'; this.activity()
      if (text) this.deliver(text)
    }).catch(() => {
      if (this.ended) return
      // Provider responses and thrown errors may contain credentials. Only a fixed status leaves Host.
      this.phase = 'unheard'; this.activity()
    }).finally(() => { if (this.request === request) { clearTimeout(this.timer); this.request = undefined } })
  }
  end() { this.ended = true; this.clear(); this.request?.abort(); this.request = undefined; this.phase = undefined }
  private clear() { clearTimeout(this.timer); this.chunks = undefined; this.bytes = 0 }
  private async recognize(pcm: Buffer, options: RecognitionOptions, signal: AbortSignal): Promise<string> {
    const credential = await options.credential()
    signal.throwIfAborted()
    if (!credential) throw new Error('ASR_CREDENTIAL_MISSING')
    const header = Buffer.alloc(44)
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    const response = await fetch(options.endpoint, { method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: options.model, input: { messages: [{ role: 'user', content: [{ audio: `data:audio/wav;base64,${Buffer.concat([header, pcm]).toString('base64')}` }] }] },
      parameters: { format: 'wav', sample_rate: 16000, asr_options: { language: 'zh', enable_itn: false } },
    }) })
    const body = await response.text()
    if (response.status === 400 && body.includes('ASR_RESPONSE_HAVE_NO_WORDS')) return ''
    if (!response.ok) throw new Error('ASR_FAILED')
    const value = JSON.parse(body)
    const choices = value?.output?.choices
    const content = choices?.[0]?.message?.content
    const text = Array.isArray(choices) && choices.length
      ? Array.isArray(content) ? content.find(item => typeof item?.text === 'string')?.text : undefined
      : value?.output?.text ?? value?.output?.sentence?.text ?? value?.text
    if (typeof text !== 'string') throw new Error('ASR_RESPONSE_INVALID')
    return text.trim()
  }
}
