import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const MODEL = 'qwen3.8-omni-flash-realtime'
export const INSTRUCTIONS = 'You are Nexus, the single supervisor of DeepSeek Harness. Understand the user and respond honestly. User instructions take priority. Do not claim tools or work executed without actual results. This initial version supports text conversation only.'

export class RealtimeFailure extends Error {
  constructor(readonly code: string, detail?: string) { super(`Nexus Realtime: ${code}${detail ? ` (${detail})` : ''}`) }
}

function errorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  return ['code', 'type', 'param'].flatMap(field => {
    const value = (error as Record<string, unknown>)[field]
    return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? [`${field}=${value}`] : []
  }).join(', ')
}

/** Host-only text transport. Every connection rebuilds context from native facts. */
export function reply(endpoint: string, key: string, history: readonly SessionEvent[], signal: AbortSignal, timeoutMs: number, onText: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint)
    url.searchParams.set('model', MODEL)
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } })
    let settled = false
    let submitted = false
    let text = ''
    const send = (event: object) => ws.send(JSON.stringify({ event_id: randomUUID(), ...event }))
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      ws.close()
      error ? reject(error) : resolve(text)
    }
    const abort = () => finish(new RealtimeFailure('ABORTED'))
    const timer = setTimeout(() => finish(new RealtimeFailure('TIMEOUT')), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    ws.on('unexpected-response', (_request, response) => { response.resume(); finish(new RealtimeFailure(`HTTP_${response.statusCode}`)) })
    ws.on('error', () => finish(new RealtimeFailure('CONNECTION_FAILED')))
    ws.on('close', () => { if (!settled) finish(new RealtimeFailure('CONNECTION_CLOSED')) })
    ws.on('message', bytes => {
      if (settled) return
      try {
        const event = JSON.parse(bytes.toString())
        if (event.type === 'session.created') send({ type: 'session.update', session: {
          modalities: ['text'], instructions: INSTRUCTIONS, turn_detection: null,
          // The configured DashScope endpoint requires these even for text-only responses.
          voice: 'Tina', input_audio_format: 'pcm16', output_audio_format: 'pcm24',
          input_audio_transcription: { model: 'gummy-realtime-v1' },
        } })
        if (event.type === 'session.updated' && !submitted) {
          if (event.session?.modalities?.length !== 1 || event.session.modalities[0] !== 'text') throw new RealtimeFailure('TEXT_MODE_REJECTED')
          submitted = true
          for (const item of history) {
            if (item.type !== 'user/message' && item.type !== 'assistant/message') continue
            const message = item.type === 'user/message' ? item.data : item.data.message
            const content = message.content.filter(part => part.type === 'text').map(part => ({ type: message.role === 'user' ? 'input_text' : 'text', text: part.text }))
            if (content.length === 0) continue
            send({ type: 'conversation.item.create', item: { id: message.id, type: 'message', role: message.role, content } })
          }
          send({ type: 'response.create' })
        }
        if (event.type === 'response.text.delta') { text += event.delta; onText(event.delta) }
        if (event.type === 'response.text.done' && !text && typeof event.text === 'string') { text = event.text; onText(event.text) }
        if (event.type === 'error') finish(new RealtimeFailure('RESPONSE_ERROR', errorDetail(event.error)))
        if (event.type === 'response.audio.delta') finish(new RealtimeFailure('UNEXPECTED_AUDIO'))
        if (event.type === 'response.done') {
          if (event.response?.status !== 'completed') finish(new RealtimeFailure('RESPONSE_FAILED'))
          else if (!text) finish(new RealtimeFailure('EMPTY_RESPONSE'))
          else finish()
        }
      } catch (error) { finish(error instanceof RealtimeFailure ? error : new RealtimeFailure('INVALID_EVENT')) }
    })
  })
}
