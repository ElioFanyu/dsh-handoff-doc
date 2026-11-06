/**
 * What this plugin reads about a session before writing the document.
 *
 * This module is the successor of the old brief renderer. The brief itself
 * moved to `handoff-doc.ts` — it is now a file with a fixed skeleton rather
 * than a message. What stayed is everything the *document* also needs and that
 * only this process can observe:
 *
 * - **Facts** (cwd, preset, model, permission, plan mode, occupancy, spend) are
 *   read here, never asked of the model. A model summarizing its own
 *   configuration is a model guessing.
 * - **The transcript**, rendered for the prompt. Without it the model writes
 *   "未知" in every section — the first real handoff of the previous design
 *   proved that, because the transcript was not being sent.
 * - **`readPendingInput`**, which detects that the session may not have been
 *   finished talking. No document section has a natural home for "waiting for
 *   the user", so this is carried program-side into both the document and the
 *   pointer message.
 */
import { foldUsageFromEvents, percentOf, type ContextOccupancy, type CumulativeUsage } from './measure.ts'
import {
  readProjectionHit,
  sessionEvents,
  type SessionEventLike,
  type SessionLike,
  type SessionProjectionsLike,
} from './contracts.ts'

/**
 * Evidence that the outgoing session may not have been finished talking.
 *
 * `question` — the host still holds an unanswered `ask_user_question` call.
 * Certain: it comes from the durable `userQuestions` projection.
 *
 * `unanswered-assistant` — the last surface event is an assistant message with
 * nothing after it. Suggestive only: it says the assistant spoke last, not that
 * it was asking. Wording must stay conditional.
 */
export interface PendingInput {
  readonly kind: 'question' | 'unanswered-assistant'
  /** The outstanding question texts, when the host recorded them. */
  readonly detail?: string
}

/** Facts about the outgoing session, read by the plugin rather than the model. */
export interface SessionFacts {
  readonly cwd: string | undefined
  readonly agentPreset: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly contextWindow: number | undefined
  readonly permissionPreset: string | undefined
  /**
   * Why the permission preset could not be read, when it could not.
   *
   * Present means "we tried and failed", which is a different fact from "this
   * deployment has no presets". The document reports which one it is: printing a
   * bare "未知" is how a broken read passed for a healthy default.
   */
  readonly permissionError?: string
  readonly planMode: 'on' | 'off' | 'unknown'
  readonly occupancy: ContextOccupancy
  readonly cumulative: CumulativeUsage
  readonly turnCount: number
}

/** Read the facts this process can observe directly. */
export function readSessionFacts(input: {
  session: SessionLike | undefined
  occupancy: ContextOccupancy
  cumulative: CumulativeUsage
  events?: readonly { type: string }[] | undefined
}): SessionFacts {
  const header = input.session?.header
  let requestContext: { provider?: string; model?: string; contextWindow?: number } | undefined
  try {
    requestContext = input.session?.requestContext?.()
  } catch {
    requestContext = undefined
  }
  const headerConfig = safely(() => input.session?.requestHeader?.()?.config)

  const turnCount = (input.events ?? []).filter((event) => event.type === 'turn/start').length

  return {
    cwd: header?.cwd,
    agentPreset: header?.agentPreset,
    provider: requestContext?.provider ?? headerConfig?.provider,
    model: requestContext?.model ?? headerConfig?.model,
    contextWindow: requestContext?.contextWindow,
    permissionPreset: undefined, // filled by the caller, which owns the services
    planMode: 'unknown',
    occupancy: input.occupancy,
    cumulative: input.cumulative,
    turnCount,
  }
}

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Decide whether the outgoing session looks like it was waiting for the user.
 *
 * Two sources, most certain first:
 *
 * 1. **The `userQuestions` projection.** When the session asked through the
 *    host's own `ask_user_question` tool, the durable projection still lists
 *    the call as active until an answer batch settles it. That is a fact, not a
 *    guess. Raw state shape (`dsh-user-questions/lib/index.js`): the view lives
 *    under `state.questions`, itself `{ active, settled }`, and each active
 *    entry is `{ callId, questions: [{ question, header?, … }], state }`.
 * 2. **The last surface event.** When it is an `assistant/message` and nothing
 *    followed, the assistant spoke last — which may mean it asked a plain-text
 *    question. This is suggestive only, so the wording says "可能".
 *
 * Every read is contained: a projection that is absent, throws, or has an
 * unexpected shape must degrade to the event check rather than fail the
 * handoff. A handoff is more valuable than this annotation.
 */
export function readPendingInput(
  session: SessionLike | undefined,
  projections: SessionProjectionsLike | undefined,
  events?: readonly SessionEventLike[] | undefined,
): PendingInput | undefined {
  const fromProjection = readOpenQuestions(session, projections)
  if (fromProjection !== undefined) return fromProjection

  const list = events ?? sessionEvents(session)
  // Walk backwards: the newest surface event decides how the session ended.
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index]
    if (event === undefined) continue
    if (event.type === 'user/message' || event.type === 'tool/result') return undefined
    if (event.type === 'assistant/message') return { kind: 'unanswered-assistant' }
  }
  return undefined
}

/**
 * Read the host's unanswered-question list, tolerating any malformation.
 *
 * The `userQuestions` unit reports the same `{ active, settled }` object through
 * both registry faces — its wire view IS `state.questions`
 * (`userQuestionProjectionDefinition.wire.view`) and its raw state nests that
 * object under `questions` — so the compatibility layer's answer is normalized
 * once here instead of at each face.
 */
function readOpenQuestions(
  session: SessionLike | undefined,
  projections: SessionProjectionsLike | undefined,
): PendingInput | undefined {
  if (session === undefined || projections === undefined) return undefined

  const hit = readProjectionHit(projections, session, 'userQuestions')
  if (hit === undefined) return undefined

  /* `wire` is the questions object itself; `raw` nests it under `questions`. */
  const questions =
    hit.wire !== undefined
      ? hit.wire
      : (hit.raw as { questions?: unknown } | undefined)?.questions
  if (questions === null || typeof questions !== 'object') return undefined
  const active = (questions as { active?: unknown }).active
  if (!Array.isArray(active) || active.length === 0) return undefined

  const texts: string[] = []
  for (const entry of active) {
    if (entry === null || typeof entry !== 'object') continue
    const asked = (entry as { questions?: unknown }).questions
    if (!Array.isArray(asked)) continue
    for (const question of asked) {
      if (question === null || typeof question !== 'object') continue
      const text = (question as { question?: unknown }).question
      if (typeof text === 'string' && text.trim().length > 0) texts.push(text.trim())
    }
  }
  const detail = texts.slice(0, 3).join(' / ')
  return { kind: 'question', ...(detail.length === 0 ? {} : { detail }) }
}

/**
 * Render the conversation itself into the prompt.
 *
 * Without this the model only sees configuration facts and a list of headings,
 * so every section comes back "未知" — and the document is worthless precisely
 * when it matters. The first real handoff produced exactly that: nine sections
 * of "unknown" because the transcript was never sent.
 *
 * The transcript is bounded by characters, keeping the most recent turns, since
 * what the session is doing now matters more than how it started. Tool traffic
 * is collapsed: arguments and results are truncated, because the document needs
 * to know *what* was done, not the full output of every command.
 */
export function renderTranscript(
  events: readonly SessionEventLike[] | undefined,
  budgetChars = 24_000,
): string {
  if (events === undefined || events.length === 0) return '（没有可读的对话记录）'

  const lines: string[] = []
  for (const event of events) {
    const line = renderEvent(event)
    if (line !== undefined) lines.push(line)
  }

  // Keep the tail: recent activity is what the successor must continue.
  let total = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const next = total + lines[i]!.length + 1
    if (next > budgetChars) break
    total = next
    start = i
  }

  const kept = lines.slice(start)
  const omitted = start
  return (omitted > 0 ? `（省略较早的 ${omitted} 条记录）\n` : '') + kept.join('\n')
}

/** One compact line per meaningful event; everything else is dropped. */
function renderEvent(event: SessionEventLike): string | undefined {
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const text = blocksToText(data['message'] ?? data)
    return text.length === 0 ? undefined : `[用户] ${truncate(text, 600)}`
  }
  if (event.type === 'assistant/message') {
    const message = data['message'] as { content?: unknown } | undefined
    const text = blocksToText(message)
    return text.length === 0 ? undefined : `[助手] ${truncate(text, 900)}`
  }
  if (event.type === 'tool/call') {
    const name = typeof data['name'] === 'string' ? data['name'] : '?'
    const args = typeof data['arguments'] === 'string' ? data['arguments'] : ''
    return `[工具 ${name}] ${truncate(args, 240)}`
  }
  if (event.type === 'tool/result') {
    const message = data['message'] as { content?: unknown } | undefined
    const text = blocksToText(message)
    return `[工具结果] ${truncate(text, 240)}`
  }
  return undefined
}

/** Flatten a message's content blocks into plain text. */
function blocksToText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (typeof record['text'] === 'string') return record['text']
      if (typeof record['arguments'] === 'string') return record['arguments']
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Fallback facts for a session whose agent already went away.
 *
 * The document must still be writable from the durable log alone: `cwd` and
 * preset come from the header, spend from folding the log. Occupancy cannot be
 * recomputed without the meter, and the document says so instead of inventing
 * it.
 */
export function factsFromLog(
  session: SessionLike | undefined,
  events: readonly { type: string; data?: Record<string, unknown> }[] | undefined,
): SessionFacts {
  const header = session?.header
  return {
    cwd: header?.cwd,
    agentPreset: header?.agentPreset,
    provider: undefined,
    model: undefined,
    contextWindow: undefined,
    permissionPreset: undefined,
    planMode: 'unknown',
    occupancy: {
      quality: 'unavailable',
      used: 0,
      window: undefined,
      percent: undefined,
      baseline: 'none',
    },
    cumulative: {
      quality: events === undefined ? 'unavailable' : 'estimated',
      tokens: foldUsageFromEvents(events as never),
      source: events === undefined ? 'none' : 'projection',
    },
    turnCount: (events ?? []).filter((event) => event.type === 'turn/start').length,
  }
}

/** Re-exported so a caller formatting an occupancy need not import `measure`. */
export { percentOf }
