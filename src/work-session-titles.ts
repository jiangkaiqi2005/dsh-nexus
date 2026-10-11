import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-title-llm'

/** Leave native title generation intact, giving only newly dispatched conversations room for reasoning. */
export function registerWorkSessionTitles(ctx: Context) {
  const created = new WeakMap<Session, string>()
  ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'session-title' || options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    const callId = session && created.get(session)
    if (!session || callId === undefined) return next()
    const events = session.snapshotEvents()
    const request = events.findLast(event => event.type === 'session/title-llm-request')
    const first = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const title = ctx.sessionTitle.get(session)
    if (request?.type !== 'session/title-llm-request' || request.data.titleProvider !== 'session-title-first-prompt-llm'
      || first?.type !== 'user/message' || !('via' in first.data.source) || first.data.source.via !== 'nexus'
      || !('callId' in first.data.source) || first.data.source.callId !== callId
      || request.data.messageSeqs.length !== 1 || request.data.messageSeqs[0] !== first.seq
      || options.messages.length !== request.data.messages.length
      || options.messages.some((message, index) => message.id !== request.data.messages[index]?.id)
      || events.some(event => event.type === 'session/title' && event.data.source.kind !== 'fallback')
      || title?.source.kind !== 'fallback') return next()
    // Consume the eligibility before re-entering the public waterfall; later refreshes are native requests.
    created.delete(session)
    if (options.maxTokens === undefined || options.maxTokens >= 4096) return next()
    // The native request event predates this waterfall. Keep the actual dispatch policy auditable without another request event.
    ctx.logger.info(`nexus title budget: ${JSON.stringify({ sessionId: session.id, titleProvider: request.data.titleProvider, messageSeq: first.seq, callId, originalMaxTokens: options.maxTokens, maxTokens: 4096 })}`)
    return ctx.llm.stream({ ...options, maxTokens: 4096 })
  })
  return (session: Session, callId: string) => { created.set(session, callId) }
}
