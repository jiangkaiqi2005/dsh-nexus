import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime account of one finished work-session turn; neither a user nor a Nexus dispatch. */
    'nexus-work-result': { kind: 'nexus-work-result'; form: 'notice'; summary: string; sessionId: string; turn: number; terminal: string; terminalSeq: number }
    /** Mirror of input the user entered directly into a work session; neither said in the main conversation nor a Nexus dispatch. */
    'nexus-user-input': { kind: 'nexus-user-input'; form: 'notice'; summary: string; sessionId: string; messageId: string; target: InboxTarget; digest: string }
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

/** Within conversation sessions, user-kind input is the user's own, whichever Host entry carried it; Nexus dispatches, agent messages and results carry their own kinds. */
const isDirectUserInput = (message: UserMessage) => message.source.kind === 'user'

const digestOf = (message: UserMessage) => createHash('sha256').update(JSON.stringify(message.content)).digest('hex').slice(0, 16)

/**
 * Observes every other conversation session's turn terminals and the user's
 * direct input to them, and hands both to the supervisor as native waking inbox messages.
 * Observation, inbox admission and model processing remain separate facts in
 * the supervisor's own log.
 */
export class ResultRelay {
  private delivered = new Set<string>()
  private inputs = new Set<string>()

  constructor(private ctx: Context, private target: ResultTarget) {
    // Rebuild identity from messages ever admitted, so a restart cannot repeat them.
    for (const event of target.session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      for (const message of event.data.inserted) {
        if (message.source.kind === 'nexus-work-result') this.delivered.add(key(message.source.sessionId, message.source.turn))
        if (message.source.kind === 'nexus-user-input') {
          this.inputs.add(inputKey(message.source.sessionId, message.source.messageId))
          this.delivered.add(inputKey(message.source.sessionId, message.source.messageId, message.source.digest))
        }
      }
    }
  }

  start() {
    return this.ctx.on('session/event', (session, event) => {
      try { this.observe(session, event) }
      catch (error) { this.ctx.logger.warn(`nexus result relay: ${String(error)}`) }
    })
  }

  /** Admit one terminal at most once per session and turn, and each version of a direct user input once. */
  observe(session: Session, event: SessionEvent) {
    // Nexus manages conversation sessions only: subagent sessions belong to the agent that spawned them.
    if (session.id === this.target.id || session.header.origin === 'subagent') return
    // Admission rather than the later claim: the supervisor learns of a change before older results of that session arrive.
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) if (isDirectUserInput(message)) this.relayInput(session, event.data.target, message)
      return
    }
    if (event.type !== 'turn/end') return
    const id = key(session.id, event.data.turn)
    if (this.delivered.has(id)) return
    this.delivered.add(id)
    try { this.target.steer(this.message(session, event)) }
    catch (error) { this.delivered.delete(id); throw error }
  }

  /** Moving a queued input to steering re-inserts the same content and is not repeated; an edit changes the content and is mirrored again. */
  private relayInput(session: Session, target: InboxTarget, input: UserMessage) {
    const digest = digestOf(input)
    const id = inputKey(session.id, input.id, digest)
    if (this.delivered.has(id)) return
    const edited = this.inputs.has(inputKey(session.id, input.id))
    const text = input.content.map(part => part.type === 'text' ? part.text : `[${part.type} attachment]`).join('\n')
    const lines = [
      'Direct user input in a work session. The user entered this into that work session itself, not into this conversation; it is not your dispatch and not an automatic result.',
      `Session: ${describe(session)}`,
      target === 'next-step'
        ? 'Admitted as native steering: a running work agent reads it at its next step boundary (a tool already running is not interrupted); an idle one starts a turn with it.'
        : 'Admitted as a queued prompt: the work agent reads it when its next turn starts, immediately when idle.',
      ...(edited ? ['The user edited this pending message; this content replaces the earlier version.'] : []),
      `User message: ${input.id}`,
      `Content:\n${bound(text)}`,
      'The input is already in that session queue and need not be resent; the user may still edit or remove a queued input before the work agent reads it.',
      'Treat it as the current user requirement for that session and update your later arrangements (dispatches, reviews, reports) to follow it, rather than only restating it.',
    ]
    this.delivered.add(id)
    this.inputs.add(inputKey(session.id, input.id))
    try {
      this.target.steer(createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'nexus-user-input', form: 'notice', summary: boundContextSummary(`user to ${session.id}: ${text}`), sessionId: session.id, messageId: input.id, target, digest },
      }))
    } catch (error) {
      this.delivered.delete(id)
      if (!edited) this.inputs.delete(inputKey(session.id, input.id))
      throw error
    }
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
    const lines = [
      'Automatic work-session result. This is a runtime report of a finished turn, not an instruction from the user.',
      `Session: ${describe(session)}`,
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
const inputKey = (sessionId: string, messageId: string, digest?: string) => `${sessionId}\u0000input\u0000${messageId}${digest === undefined ? '' : `\u0000${digest}`}`
const describe = (session: Session) => `${session.id} (ordinary session)${session.header.cwd ? `, workspace: ${session.header.cwd}` : ''}`
