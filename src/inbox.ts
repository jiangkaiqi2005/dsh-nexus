import type { Inbox, InboxTarget, AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'

/** Uses the Host's standard inbox projection; mutations remain native log facts. */
export class NativeInbox implements Inbox {
  constructor(private session: Session, private ctx: Context, private events: AgentEventDispatch) {}
  private state() {
    const state = this.ctx.sessionProjections.stateOf(this.session, 'inbox')
    if (!state) throw new Error('Nexus requires the native inbox projection')
    return state
  }
  get nextTurn() { return this.state()['next-turn'] }
  get nextStep() { return this.state()['next-step'] }
  clear() { this.splice('next-step', 0, this.nextStep.length, []); this.splice('next-turn', 0, this.nextTurn.length, []) }
  append(target: InboxTarget, message: UserMessage) { this.splice(target, this.state()[target].length, 0, [message]) }
  prepend(target: InboxTarget, message: UserMessage) { this.splice(target, 0, 0, [message]) }
  replace(id: MessageId, message: UserMessage) { return this.edit(id, [message]) }
  remove(id: MessageId) { return this.edit(id, []) }
  private edit(id: MessageId, inserted: UserMessage[]) {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.state()[target].findIndex(message => message.id === id)
      if (index >= 0) { this.splice(target, index, 1, inserted); return true }
    }
    return false
  }
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]) { return this.mutate(target, start, deleteCount, inserted, true) }
  claim(turn: number, target: InboxTarget = 'next-turn') {
    const messages = [...this.mutate('next-step', 0, this.nextStep.length, [], false), ...(target === 'next-turn' ? this.mutate('next-turn', 0, 1, [], false) : [])]
    for (const message of messages) this.events.emit('agent/inbox/claimed', { message, turn })
    return messages
  }
  private mutate(target: InboxTarget, start: number, count: number, inserted: UserMessage[], discard: boolean) {
    const current = this.state()[target]
    const offset = Number.isNaN(start) ? 0 : Math.trunc(start)
    const actualStart = offset < 0 ? Math.max(current.length + offset, 0) : Math.min(offset, current.length)
    const removedCount = Math.min(Math.max(Number.isNaN(count) ? 0 : Math.trunc(count), 0), current.length - actualStart)
    if (!removedCount && !inserted.length) return []
    const candidate = current.toSpliced(actualStart, removedCount, ...inserted)
    const other = this.state()[target === 'next-turn' ? 'next-step' : 'next-turn']
    const identities = [...candidate, ...other].map(message => message.id)
    if (new Set(identities).size !== identities.length) throw new Error('Nexus inbox message identity is already pending')
    const removed = current.slice(actualStart, actualStart + removedCount)
    this.session.append('agent/inbox/spliced', { target, start: actualStart, removedCount, inserted, ...(discard && removedCount ? { outcome: 'canceled' as const } : {}) })
    if (discard) for (const message of removed) this.events.emit('agent/inbox/discarded', { message })
    for (const message of inserted) this.events.emit('agent/inbox/inserted', { message })
    return removed
  }
}
