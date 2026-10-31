/**
 * Which part of the workspace the session actually worked on.
 *
 * ## Why this exists
 *
 * The handoff document is for *the successor of this session*, not for the
 * directory the session happened to sit in. When the workspace root holds
 * several independent projects and has no manifest of its own, reading one
 * level down finds every sibling's `check` script and puts them all into §0 —
 * a session that never opened `desktop-bridge` still sends its successor to
 * run that project's checks before starting work.
 *
 * That is the failure this module corrects. The session's own log already
 * says what it worked on: every tool call that names a directory is evidence,
 * and the distribution is not subtle (in the session that built this plugin,
 * the plugin's own directory was named by 106% of tool calls while a sibling
 * reached 5%). The plugin should read that signal instead of treating the
 * whole workspace as equally relevant.
 *
 * ## Why rank rather than filter
 *
 * Dropping the siblings entirely would be wrong in the other direction: a
 * handoff for a change that spans two projects must still tell the successor
 * to verify both. So nothing is removed — the scopes are *ordered*, and the
 * ones the session never touched are reported as untouched rather than
 * presented as the first thing to run.
 *
 * ## Why the signal is debounced, not thresholded on one call
 *
 * A single `ls` of the workspace root names every sibling. Counting raw
 * mentions would rank whatever was listed most often, so:
 *
 * - only calls whose payload looks like a *path or command* count;
 * - one call counts once per scope, however many times the name appears;
 * - a scope must clear a small floor before it is called the focus, so a
 *   session that only `ls`-ed the root reports no focus instead of picking
 *   the alphabetically first directory.
 */
import type { SessionEventLike } from './contracts.ts'

/** One directory the session appears to have worked in. */
export interface WorkScope {
  /** Workspace-relative directory name, e.g. `dsh-handoff-doc`. */
  readonly directory: string
  /** Tool calls that named this directory. */
  readonly calls: number
  /** Calls of every kind seen, so the consumer can weigh the share. */
  readonly totalCalls: number
  /** True for the highest-scoring directory, when it clears the floor. */
  readonly focus: boolean
}

/** Tool names whose arguments are not paths and should not be scanned. */
const IGNORED_TOOLS = new Set(['ask_user_question', 'job_list', 'job_output', 'job_kill'])

/** Below this many naming calls, a directory is listed but not called the focus. */
const FOCUS_FLOOR = 2

/**
 * Directories one level down that the session named, most-named first.
 *
 * `candidates` is the set the caller already discovered on disk (the same list
 * the sub-project scan used), which keeps this function from inventing scope
 * names for directories that are not projects.
 */
export function readWorkScope(
  events: readonly SessionEventLike[] | undefined,
  candidates: readonly string[],
): readonly WorkScope[] {
  if (events === undefined || events.length === 0 || candidates.length === 0) return []

  const counts = new Map<string, number>()
  let totalCalls = 0

  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data ?? {}
    const name = typeof data['name'] === 'string' ? data['name'] : ''
    if (IGNORED_TOOLS.has(name)) continue
    totalCalls += 1

    const text = searchableText(data)
    if (text.length === 0) continue

    // Once per call, not once per occurrence: `grep` across a directory names
    // it in every result line, and that is one act of attention, not fifty.
    for (const candidate of candidates) {
      if (namesDirectory(text, candidate)) counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
    }
  }

  if (counts.size === 0) return []

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const top = ranked[0]
  const focused = top !== undefined && top[1] >= FOCUS_FLOOR
  return ranked.map(([directory, calls], index) => ({
    directory,
    calls,
    totalCalls,
    focus: focused && index === 0,
  }))
}

/**
 * The parts of a tool call worth scanning for directory names.
 *
 * Arguments are usually a JSON string; reading it as text rather than parsing
 * keeps a malformed payload from costing the signal. Results are excluded —
 * the *call* is what the session chose to do, and a directory named only in
 * output (a listing, an error) is not evidence of work.
 */
function searchableText(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['arguments', 'command', 'path', 'file_path']) {
    const value = data[key]
    if (typeof value === 'string') parts.push(value)
  }
  return parts.join('\n').split('\\').join('/')
}

/**
 * The scopes the successor should actually be told to verify, focus first.
 *
 * Reading a directory once is not working in it: a `grep` across the workspace,
 * or a single `ls` to see what is there, leaves a trace in the counts without
 * meaning the project is part of this change. Telling the successor to run such
 * a project's checks before starting work is the original defect in miniature.
 *
 * So a secondary scope qualifies only when it was worked in comparably hard —
 * a quarter of the focus's attention, and never fewer than the floor that
 * separates "observed" from "worked in". A genuinely cross-project change
 * clears that bar on both sides; an incidental look does not.
 *
 * Returns `[]` when there is no focus, because then the log does not say what
 * the session worked on and inventing a shortlist would be worse than none.
 */
export function scopesInPlay(scope: readonly WorkScope[]): readonly WorkScope[] {
  const focus = scope.find((entry) => entry.focus)
  if (focus === undefined) return []
  const bar = Math.max(FOCUS_FLOOR, Math.ceil(focus.calls * 0.25))
  return [focus, ...scope.filter((entry) => !entry.focus && entry.calls >= bar)]
}

/**
 * Does this text name the directory as a path segment?
 *
 * Boundaries matter: `dsh-handoff-doc-old` must not count as
 * `dsh-handoff-doc`, and neither must a mention inside a longer word.
 */
function namesDirectory(text: string, directory: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(directory, from)
    if (at < 0) return false
    const before = at === 0 ? '' : text[at - 1] ?? ''
    const after = text[at + directory.length] ?? ''
    const startsOk = before === '' || /[\s"'`/=:(,[]/.test(before)
    const endsOk = after === '' || /[\s"'`/):,\]|;]/.test(after)
    if (startsOk && endsOk) return true
    from = at + 1
  }
}
