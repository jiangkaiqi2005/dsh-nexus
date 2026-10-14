import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { RealtimeConnection, Response, ServerTurn } from './realtime.js'

/** One supervisor step, keeping the native conversation and incremental text available to its model. */
export interface ModelRequest {
  surface: readonly SessionEvent[]
  tools: ToolSchema[]
  instructions: string
  signal: AbortSignal
  onText(delta: string, time?: number): void
}

/** Realtime also answers server-started utterances, whose already-produced text is replayed to the listener. */
export function requestRealtime(connection: RealtimeConnection, request: ModelRequest, voice?: ServerTurn): Promise<Response> {
  request.signal.throwIfAborted()
  if (voice) { voice.listen(request.onText); return voice.response }
  return connection.request(request.surface, request.onText, request.tools, request.instructions)
}
