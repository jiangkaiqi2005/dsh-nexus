import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BlockAssembler, LlmError, type AssistantMessage, type GenerateOptions, type PreparedLlmCall, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { RealtimeConnection, Response, ServerTurn } from './realtime.js'

/** One supervisor step, keeping the native conversation and incremental text available to its model. */
export interface ModelRequest {
  surface: readonly SessionEvent[]
  tools: ToolSchema[]
  instructions: string
  signal: AbortSignal
  onText(delta: string, time?: number): void
  onChunk?(chunk: StreamChunk): void
}

export interface ModelResponse extends Response { message?: AssistantMessage }

/** Realtime also answers server-started utterances, whose already-produced text is replayed to the listener. */
export function requestRealtime(connection: RealtimeConnection, request: ModelRequest, voice?: ServerTurn): Promise<Response> {
  request.signal.throwIfAborted()
  if (voice) { voice.listen(request.onText); return voice.response }
  return connection.request(request.surface, request.onText, request.tools, request.instructions)
}

/** The native service owns provider translation, reasoning, tool schemas and cache accounting. */
export async function requestCascade(call: PreparedLlmCall, options: GenerateOptions, request: ModelRequest): Promise<ModelResponse> {
  const assembler = new BlockAssembler()
  const spoken = new Map<number, string>()
  for await (const chunk of call.stream(options)) {
    request.signal.throwIfAborted()
    assembler.push(chunk)
    request.onChunk?.(chunk)
    if (chunk.type === 'text-delta') {
      spoken.set(chunk.index, (spoken.get(chunk.index) ?? '') + chunk.text)
      request.onText(chunk.text)
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const prefix = spoken.get(chunk.index) ?? ''
      if (chunk.block.text.startsWith(prefix)) request.onText(chunk.block.text.slice(prefix.length))
      spoken.delete(chunk.index)
    }
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message, finish.failure.code)
  const message = assembler.message({ provider: call.config.provider, model: call.config.model, ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) })
  if (!message.content.length) throw new LlmError('Nexus default model returned no content', 'EMPTY_RESPONSE')
  return { message, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''), calls: message.content.filter(block => block.type === 'tool-call'), usage: assembler.usage, settledAt: Date.now() }
}
