/**
 * A durable crash log for the failures the UI cannot show in full.
 *
 * ## Why this exists
 *
 * A `/handoff` failure reaches the user as one red line in the conversation,
 * truncated at whatever the surface feels like showing. The message that
 * actually matters — which section was missing, how many characters the model
 * produced, which setting to raise — is longer than that line, and the stack is
 * not shown at all. So a user reporting "it failed" hands over a fragment, and
 * whoever debugs it starts by guessing which failure mode it was.
 *
 * ## Why a file and not just the console
 *
 * The host's console scrolls away and is not attached to a session. A file
 * survives a restart, can be opened by the user, and is the one artefact worth
 * asking for when something goes wrong. It is written next to the handoff
 * documents so it is found by the same people who read them.
 *
 * ## Why it never throws
 *
 * Logging is diagnostic, not part of the handoff. A read-only workspace, a
 * locked file, a full disk — all of these must cost the log entry and nothing
 * else. Every entry point swallows its own failure.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One recorded failure, already flattened for a log line. */
export interface FailureRecord {
  /** Where it happened: `handoff`, `migrate`, `narrative`, … */
  readonly where: string
  readonly error: unknown
  /** Short facts about the moment, e.g. `{ maxTokens: 20000, chars: 8421 }`. */
  readonly context?: Readonly<Record<string, unknown>> | undefined
  readonly sessionId?: string | undefined
}

/** Bound each field so one runaway error cannot produce a megabyte line. */
const MAX_MESSAGE_CHARS = 4_000
const MAX_STACK_CHARS = 8_000

/**
 * Append one failure to `<workspace>/docs/handoff/.dsh-handoff-doc.log`.
 *
 * `workspace` is the session's cwd — the workspace root, not the handoff
 * directory — because the log describes the run, not one project's document.
 *
 * Returns the absolute path it wrote to, or `undefined` when logging failed —
 * the caller uses that to tell the user where to look, and says nothing when
 * there is no file to point at.
 */
export async function recordFailure(
  workspace: string,
  record: FailureRecord,
): Promise<string | undefined> {
  try {
    const file = join(workspace, 'docs/handoff/.dsh-handoff-doc.log')
    await mkdir(dirname(file), { recursive: true })
    const block = [
      `=== ${new Date().toISOString()} ${record.where} ===`,
      ...(record.sessionId === undefined ? [] : [`session: ${record.sessionId}`]),
      ...(record.context === undefined
        ? []
        : [`context: ${safeJson(record.context)}`]),
      `message: ${clip(messageOf(record.error), MAX_MESSAGE_CHARS)}`,
      ...(stackOf(record.error) === undefined
        ? []
        : [`stack:\n${clip(stackOf(record.error)!, MAX_STACK_CHARS)}`]),
      '',
    ].join('\n')
    await appendFile(file, block, 'utf8')
    return file
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.trim().length === 0 ? '(empty message)' : error.message
  const text = String(error).trim()
  return text.length === 0 ? '(non-error thrown)' : text
}

function stackOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const stack = error.stack
  return stack === undefined || stack.trim().length === 0 ? undefined : stack
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断，原长 ${text.length}）`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '(无法序列化)'
  }
}
