import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime account of one finished work-session turn; neither a user nor a Nexus dispatch. */
    'nexus-work-result': { kind: 'nexus-work-result'; form: 'notice'; summary: string; sessionId: string; turn: number; terminal: string; terminalSeq: number }
  }
}

/** The part of the supervisor the relay needs; delivery uses the native waking steer path. */
export interface ResultTarget {
  readonly id: string
  readonly session: Session
  steer(message: UserMessage): void
}

const HEAD = 2500
const TAIL = 3500

/** Bound large closing text without copying a whole transcript into the supervisor context. */
function bound(text: string) {
  if (text.length <= HEAD + TAIL) return text
  return `${text.slice(0, HEAD)}\n[... ${text.length - HEAD - TAIL} characters omitted; read the session for the full record ...]\n${text.slice(-TAIL)}`
}

function outcome(event: Extract<SessionEvent, { type: 'turn/end' }>) {
  const reason = event.data.reason
  switch (reason.kind) {
    case 'completed': return { label: 'completed', detail: '' }
    case 'error': return { label: 'failed', detail: `${reason.error.code}: ${reason.error.message}` }
    case 'aborted': return { label: 'interrupted', detail: `cancelled (${reason.reason.kind})` }
    case 'interrupted': return { label: 'interrupted', detail: 'the turn was left open by a process exit and closed on recovery' }
    default: return { label: reason.kind, detail: '' }
  }
}

/**
 * Observes every other session's turn terminals and hands them to the
 * supervisor as native waking inbox messages. Observation, inbox admission and
 * model processing remain separate facts in the supervisor's own log.
 */
export class ResultRelay {
  private delivered = new Set<string>()

  constructor(private ctx: Context, private target: ResultTarget) {
    // Rebuild identity from messages ever admitted, so a restart cannot repeat them.
    for (const event of target.session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      for (const message of event.data.inserted) if (message.source.kind === 'nexus-work-result') this.delivered.add(key(message.source.sessionId, message.source.turn))
    }
  }

  start() {
    return this.ctx.on('session/event', (session, event) => {
      try { this.observe(session, event) }
      catch (error) { this.ctx.logger.warn(`nexus result relay: ${String(error)}`) }
    })
  }

  /** Admit one terminal at most once per session and turn. */
  observe(session: Session, event: SessionEvent) {
    // The supervisor's own children are relayed as well: their native subagent-settled notice settles a whole activation without turn or failure identity.
    if (event.type !== 'turn/end' || session.id === this.target.id) return
    const id = key(session.id, event.data.turn)
    if (this.delivered.has(id)) return
    this.delivered.add(id)
    try { this.target.steer(this.message(session, event)) }
    catch (error) { this.delivered.delete(id); throw error }
  }

  private message(session: Session, end: Extract<SessionEvent, { type: 'turn/end' }>) {
    const turn = end.data.turn
    let final: { id: string; text: string } | undefined
    for (let seq = end.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq))
      if (!event) continue
      if (event.type === 'turn/start' && event.data.turn === turn) break
      if (!final && event.type === 'assistant/message' && event.data.turn === turn) {
        const text = event.data.message.content.flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n')
        if (text) final = { id: event.data.message.id, text }
      }
    }
    const result = outcome(end)
    const subagent = session.header.origin === 'subagent'
    const lines = [
      'Automatic work-session result. This is a runtime report of a finished turn, not an instruction from the user.',
      `Session: ${session.id} (${subagent ? `subagent of ${session.header.parentSession ?? 'unknown'}` : 'ordinary session'})${session.header.cwd ? `, workspace: ${session.header.cwd}` : ''}`,
      `Turn: ${turn} (terminal event seq ${end.seq})`,
      `Outcome: ${result.label}${result.detail ? ` - ${result.detail}` : ''}`,
      final ? `Last assistant message: ${final.id}\nFinal content:\n${bound(final.text)}` : 'The turn produced no assistant text.',
      'Use nexus_read_session for earlier records of this session.',
    ]
    return createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: { kind: 'nexus-work-result', form: 'notice', summary: `${session.id} turn ${turn} ${result.label}`, sessionId: session.id, turn, terminal: end.data.reason.kind, terminalSeq: end.seq },
    })
  }
}

const key = (sessionId: string, turn: number) => `${sessionId}\u0000${turn}`
