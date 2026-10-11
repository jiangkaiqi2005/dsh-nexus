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

/**
 * Automatic compaction is skipped when the span it would replace is under this share of the measured
 * request: the fixed supervisor prompt and the retained tail dominate, so the summary would barely shrink
 * the request and the next turn would re-summarize the checkpoint again. In user acceptance a compaction
 * of ~5% of the request (budget 8000, below the ~10k fixed prompt) ran 98.8 s and left the next request
 * larger, while one of ~85% shrank it from 65k to 10k tokens.
 */
export const USEFUL_SHARE = 0.25

/** The summary model setting: `provider/model`, or empty for {@link DEFAULT_SUMMARY_MODEL}. */
export const SUMMARY_MODEL = /^(?:|[^/\s]+\/\S+)$/

/**
 * The summary model unless the user picks another (user ruling 2026-10-10): DeepSeek Flash on the route
 * Harness itself defaults to (`agent-default-model` in `@deepseek-ai/dsh-base`). It is not replaced by
 * another model when unavailable; the compaction then fails as recorded.
 */
export const DEFAULT_SUMMARY_MODEL: ModelTarget = { provider: 'deepseek-official', model: 'deepseek-flash' }

export function summaryTarget(setting: string | undefined): ModelTarget {
  const slash = setting?.indexOf('/') ?? -1
  return setting && slash > 0 ? { provider: setting.slice(0, slash), model: setting.slice(slash + 1) } : { ...DEFAULT_SUMMARY_MODEL }
}

/** The summary reasoning-effort setting that sends no effort, leaving the summary model's own default. */
export const MODEL_DEFAULT_EFFORT = 'model-default'
const NO_THINKING = /^(?:none|off|disabled?)$/i

/** One reasoning effort a model offers, as `LlmModelReasoningInfo.efforts` lists them. */
export interface ReasoningEffort { id: string; name: string }

/** The lowest effort among those offered: one that turns thinking off, then minimal, then low. */
export function lowestEffort(efforts: readonly ReasoningEffort[]): ReasoningEffort | undefined {
  const named = (pattern: RegExp) => efforts.find(effort => pattern.test(effort.id) || pattern.test(effort.name))
  return named(NO_THINKING) ?? named(/^minimal$/i) ?? named(/^low$/i)
}

/**
 * The reasoning effort a summary is written with: the setting when the summary model offers it, otherwise
 * the lowest the model offers. None — the model's own default — when the setting asks for it, when the
 * model offers no efforts, or when none of its efforts is a low one.
 */
export function summaryEffort(setting: string, efforts: readonly ReasoningEffort[] = []): string | undefined {
  if (!efforts.length || setting === MODEL_DEFAULT_EFFORT) return undefined
  if (efforts.some(effort => effort.id === setting)) return setting
  return lowestEffort(efforts)?.id
}

/** The parts of `@deepseek-ai/dsh-compaction-basic` 0.2.0-rc.2 this module relies on beyond the abstract engine. */
interface SummaryPolicy { summarizationProvider?: string; summarizationModel?: string }
interface BasicEngine {
  /** The engine's documented sole subclass hook (`BasicCompactionEngine.summarize`), used by every compaction path. */
  summarize(input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown>
  /** Resolved service config; its summarization fields, top level or per model policy, outrank the routed target. */
  config: SummaryPolicy & { modelPolicies: readonly SummaryPolicy[] }
}

/**
 * The native engine with its summary written by `target` instead of the conversation's own
 * route. The supervisor's Realtime route has no Host model adapter, so the native summarizer
 * cannot use it; every other step — range checks, the log-recorded bracket, the checkpoint
 * and its framing, persistence — stays the engine's own. The engine itself is not changed.
 * Summarization fields of the engine's own config are cleared for these calls, so the Nexus
 * setting decides the summary model; its other policy fields (such as maxTokens) still apply.
 * The summary runs at the reasoning effort `effort` resolves to by `summaryEffort` for that model.
 * Depends on `BasicCompactionEngine` internals of 0.2.0-rc.2: re-verify on Harness upgrades.
 */
export function withSummaryModel(engine: CompactionEngine, target: () => ModelTarget, effort: () => string): CompactionEngine {
  const native = engine as unknown as Partial<BasicEngine>
  // The engine's own context: read through a service, `ctx` is the reader's context, which cannot reach the engine's injected services.
  const ctx = Object.getOwnPropertyDescriptor(engine, 'ctx')?.value
  if (typeof native.summarize !== 'function' || !native.config || !ctx) throw new Error('Nexus compaction requires the native basic compaction engine')
  const { summarize, config } = native as BasicEngine
  // A policy's fields fall through (`??`) to the top level; the top level is resolved config, where an empty pair, not undefined, means "summarize with the routed target".
  const cleared = { summarizationProvider: undefined, summarizationModel: undefined }
  const summarizer = Object.create(engine, {
    ctx: { value: ctx },
    config: { value: { ...config, summarizationProvider: '', summarizationModel: '', modelPolicies: config.modelPolicies.map(policy => ({ ...policy, ...cleared })) } },
  })
  return Object.create(engine, {
    summarize: {
      value: async (input: unknown, agent: { session: Session }, signal?: AbortSignal) => {
        const config = target()
        const info = await ctx.llm.resolveModelInfo(config.provider, config.model, signal)
        const reasoningEffort = summaryEffort(effort(), info.reasoning?.efforts)
        const header = reasoningEffort === undefined ? config : { ...config, reasoningEffort }
        // Only the fields the summarizer routes with; mutations still go through the real session.
        const session = { id: agent.session.id, requestHeader: () => ({ config: header }), toolHistory: () => agent.session.toolHistory() }
        // The native summarizer streams with the header's provider and model only, so the effort joins the call it streams.
        const self = reasoningEffort === undefined ? summarizer : Object.create(summarizer, {
          ctx: { value: Object.create(ctx, { llm: { value: { stream: (options: object) => ctx.llm.stream({ ...options, reasoningEffort }) } } }) },
        })
        return summarize.call(self, input, { session, options: config }, signal)
      },
    },
  })
}

/**
 * The span automatic compaction replaces, as the native selection: from the first node after a
 * leading system message up to a priced recent tail of at least `retain` tokens, never cutting
 * between a tool call and its result, with its priced tokens. Null when nothing before that tail can be compacted.
 * Mirrors the range selection of `@deepseek-ai/dsh-compaction-basic` 0.2.0-rc.2, which is not exported.
 */
export function compactableRange(session: Session, measurement: TokenMeasurement, retain: number) {
  const nodes = measurement.nodes
  if (!nodes.length) return null
  const first = session.eventAt(nodes[0].seq)?.type === 'system/message' ? 1 : 0
  let kept = 0
  let keepFrom = nodes.length
  do {
    kept += nodes[--keepFrom].tokens
  } while (keepFrom > first && kept < retain)
  while (keepFrom > first && !toolPairingBalancedBefore(session, nodes[keepFrom].seq)) keepFrom--
  if (keepFrom <= first) return null
  let tokens = 0
  for (let i = first; i < keepFrom; i++) tokens += nodes[i].tokens
  return { start: nodes[first].seq, end: nodes[keepFrom - 1].seq, tokens }
}

/** The native `/compact` command's reports of expected failures, by failure code, as `@deepseek-ai/dsh-command-compact` 0.2.0-rc.2 words them. */
export const MANUAL_FAILURES: Record<string, string> = {
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed: 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.',
  summary: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.',
  commit: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
}
