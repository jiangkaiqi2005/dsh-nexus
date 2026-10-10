import { toolPairingBalancedBefore, type CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

/** A provider route and model id. */
export interface ModelTarget { provider: string; model: string }

/**
 * Of the Nexus budget, the recent conversation kept verbatim by automatic compaction,
 * as the native policy keeps 0.16 of a model window below its 0.8 pressure threshold.
 */
export const RETAIN_SHARE = 0.2

/** The summary model setting: `provider/model`, or empty to follow the default model of ordinary sessions. */
export const SUMMARY_MODEL = /^(?:|[^/\s]+\/\S+)$/

export function summaryTarget(setting: string | undefined, fallback: ModelTarget): ModelTarget {
  const slash = setting?.indexOf('/') ?? -1
  return setting && slash > 0 ? { provider: setting.slice(0, slash), model: setting.slice(slash + 1) } : { provider: fallback.provider, model: fallback.model }
}

interface Summarizer { summarize(input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown> }

/**
 * The native engine with its summary written by `target` instead of the conversation's own
 * route. The supervisor's Realtime route has no Host model adapter, so the native summarizer
 * cannot use it; every other step — range checks, the log-recorded bracket, the checkpoint
 * and its framing, persistence — stays the engine's own. The engine itself is not changed.
 */
export function withSummaryModel(engine: CompactionEngine, target: () => ModelTarget): CompactionEngine {
  const native = engine as unknown as Partial<Summarizer>
  if (typeof native.summarize !== 'function') return engine
  const summarize = native.summarize
  return Object.create(engine, {
    summarize: {
      value: (input: unknown, agent: { session: Session }, signal?: AbortSignal) => {
        const config = target()
        // Only the fields the summarizer routes with; mutations still go through the real session.
        const session = { id: agent.session.id, requestHeader: () => ({ config }), toolHistory: () => agent.session.toolHistory() }
        return summarize.call(engine, input, { session, options: config }, signal)
      },
    },
  })
}

/**
 * The span automatic compaction replaces, as the native selection: from the first node after a
 * leading system message up to a priced recent tail of at least `retain` tokens, never cutting
 * between a tool call and its result. Null when nothing before that tail can be compacted.
 */
export function compactableRange(session: Session, measurement: TokenMeasurement, retain: number) {
  const nodes = measurement.nodes
  if (!nodes.length) return null
  const first = session.eventAt(nodes[0].seq)?.type === 'system/message' ? 1 : 0
  let kept = 0
  let keepFrom = nodes.length
  do kept += nodes[--keepFrom].tokens
  while (keepFrom > first && kept < retain)
  while (keepFrom > first && !toolPairingBalancedBefore(session, nodes[keepFrom].seq)) keepFrom--
  return keepFrom > first ? { start: nodes[first].seq, end: nodes[keepFrom - 1].seq } : null
}

/** The native `/compact` command's reports of expected failures, by failure code. */
export const MANUAL_FAILURES: Record<string, string> = {
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed: 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.',
  summary: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.',
  commit: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
}
