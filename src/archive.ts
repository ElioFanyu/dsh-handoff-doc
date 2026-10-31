/**
 * Rotation: what makes this a snapshot instead of a growing log.
 *
 * ## The rule this module enforces
 *
 * Before a new document replaces the old one, the old one's *changes* move into
 * `CHANGELOG.md`. Without this step the new document is written on top of the
 * old and the only copy of "how we got here" is gone — which is exactly how a
 * handoff file grows back into a 3000-line log, one append at a time.
 *
 * The previous plugin had no such step. Its brief was delivered as a message,
 * so "archiving" was impossible by construction: messages are append-only.
 *
 * ## Why the archive is a rewrite of a section, not an append of a blob
 *
 * Dumping the old document into CHANGELOG under a heading is easy and useless:
 * after five handoffs the changelog holds five near-identical documents and
 * nobody can diff them. So the archive keeps a *summary* — the goal line, what
 * changed since the previous handoff, and the section headers that carry
 * decisions — and the full text goes to the monthly history file.
 *
 * Two destinations, two purposes:
 *
 * - `CHANGELOG.md` — small, newest first, one entry per handoff, read by humans
 *   scanning "what happened lately".
 * - `history/YYYY-MM.md` — the full previous document, verbatim, read by
 *   someone who needs the detail. Rotated by month so neither file grows
 *   without bound.
 *
 * ## Why archiving is idempotent by content hash
 *
 * A handoff can be retried after a delivery failure. Archiving the same
 * document twice would produce two identical changelog entries and teach the
 * reader to ignore the file. The hash of the archived text is recorded in the
 * entry, so a repeat is a no-op.
 */
import { createHash } from 'node:crypto'
import type { WorkspaceFiles } from './workspace-fs.ts'

/** What the archive needs to know about the outgoing document. */
export interface ArchiveInput {
  readonly files: WorkspaceFiles
  /** Workspace-relative path of the previous document. */
  readonly documentPath: string
  /** Workspace-relative path of the changelog. */
  readonly changelogPath: string
  /** Workspace-relative path of this month's history file. */
  readonly historyPath: string
  /** `YYYY-MM-DD` or a full ISO timestamp; recorded in the entry. */
  readonly at: string
  /** Why the handoff happened, for the entry header. */
  readonly reason: string
  /** The source session, so an entry can be traced back to a log. */
  readonly sourceSessionId: string
}

/** What the archive did, so the caller can report it instead of assuming. */
export interface ArchiveResult {
  /** False when there was nothing to archive (first handoff for the project). */
  readonly archived: boolean
  readonly changelogUpdated: boolean
  readonly historyUpdated: boolean
  /** Set when a previous entry with the same content was already present. */
  readonly skippedDuplicate: boolean
  /** Non-fatal problems, reported rather than thrown. */
  readonly warnings: readonly string[]
  /** Characters of the previous document that were archived. */
  readonly archivedChars: number
}

/**
 * Move the previous document's changes into the changelog, then let the caller
 * overwrite the document.
 *
 * The order matters: this runs BEFORE the new document is written, so a failure
 * here leaves the old document in place and the handoff can be retried. Running
 * it after would mean a failed archive loses the only copy.
 */
export async function archivePrevious(input: ArchiveInput): Promise<ArchiveResult> {
  const warnings: string[] = []
  const previous = await input.files.read(input.documentPath)
  if (previous === undefined || previous.trim().length === 0) {
    return {
      archived: false,
      changelogUpdated: false,
      historyUpdated: false,
      skippedDuplicate: false,
      warnings,
      archivedChars: 0,
    }
  }

  const hash = hashOf(previous)
  const changelog = (await input.files.read(input.changelogPath)) ?? CHANGELOG_PREAMBLE
  if (changelog.includes(`content:${hash}`)) {
    return {
      archived: false,
      changelogUpdated: false,
      historyUpdated: false,
      skippedDuplicate: true,
      warnings,
      archivedChars: previous.length,
    }
  }

  const entry = renderChangelogEntry({
    previous,
    at: input.at,
    reason: input.reason,
    sourceSessionId: input.sourceSessionId,
    hash,
  })

  // 1. Full text into the monthly history file (append-only, newest last).
  let historyUpdated = false
  try {
    const history = (await input.files.read(input.historyPath)) ?? historyPreamble(input.historyPath)
    await input.files.write(
      input.historyPath,
      `${history.trimEnd()}\n\n${renderHistoryBlock(previous, input.at, input.sourceSessionId, hash)}\n`,
    )
    historyUpdated = true
  } catch (error) {
    warnings.push(`写入月度历史失败（不影响交接）：${messageOf(error)}`)
  }

  // 2. The summary entry into the changelog (newest first).
  let changelogUpdated = false
  try {
    await input.files.write(input.changelogPath, insertEntry(changelog, entry))
    changelogUpdated = true
  } catch (error) {
    warnings.push(`写入 CHANGELOG 失败（不影响交接）：${messageOf(error)}`)
  }

  return {
    archived: changelogUpdated || historyUpdated,
    changelogUpdated,
    historyUpdated,
    skippedDuplicate: false,
    warnings,
    archivedChars: previous.length,
  }
}

const CHANGELOG_PREAMBLE = [
  '# CHANGELOG —— 交接归档',
  '',
  '> 由 `dsh-handoff-doc` 在每次交接时自动写入：交接文档的上一版在这里留下「改了什么」。',
  '> 最新在上。完整原文按月份归档在 `history/<YYYY-MM>.md`。',
  '> 手工补写时保持同样格式即可，不要改动已有条目。',
  '',
].join('\n')

function historyPreamble(path: string): string {
  const month = /(\d{4}-\d{2})\.md$/.exec(path)?.[1] ?? '当月'
  return [
    `# ${month} 交接历史（完整原文）`,
    '',
    '> 每次交接时，被替换掉的那一份交接文档原文追加在这里。按时间正序，最新的在最下面。',
    '',
  ].join('\n')
}

/**
 * Insert a new entry directly under the changelog preamble.
 *
 * Entries are `## ` headings, so the insertion point is the first `## `. A file
 * a human edited by hand keeps its structure as long as it follows that rule —
 * and if it does not, the entry goes after the preamble, which is still valid
 * markdown and still findable.
 */
export function insertEntry(changelog: string, entry: string): string {
  const lines = changelog.split('\n')
  const firstEntry = lines.findIndex((line) => /^##\s/.test(line))
  const insertAt = firstEntry < 0 ? lines.length : firstEntry
  const head = lines.slice(0, insertAt)
  const tail = lines.slice(insertAt)
  // Keep exactly one blank line between the new entry and what follows.
  while (head.length > 0 && head.at(-1)!.trim().length === 0) head.pop()
  const headText = head.join('\n')
  const tailText = tail.join('\n').trimStart()
  return `${headText}\n\n${entry.trimEnd()}\n${tailText.length === 0 ? '' : `\n${tailText}\n`}`
}

/** One changelog entry: the goal, what changed, and the decisions that survive. */
export function renderChangelogEntry(input: {
  previous: string
  at: string
  reason: string
  sourceSessionId: string
  hash: string
}): string {
  const sections = splitSections(input.previous)
  const goal = firstMeaningful(sections.get('goal')) ?? '（上一版没有写目标）'
  const next = firstMeaningful(sections.get('next')) ?? '（未记录）'
  const date = input.at.slice(0, 10)

  const lines: string[] = [
    `## ${date} — ${input.reason}`,
    '',
    `- 归档时间：${input.at}`,
    `- 原会话：\`${input.sourceSessionId}\``,
    `- 内容指纹：content:${input.hash}`,
    '',
    '**上一版目标**',
    '',
    goal,
    '',
    '**上一版的下一步**（被本次交接取代）',
    '',
    next,
    '',
  ]

  /*
   * The parts worth keeping in a *small* file: the decisions a future reader
   * would otherwise re-litigate. §2 is excluded deliberately — it is the
   * largest section and the least stable, and its whole point is that the new
   * document restates it.
   */
  const carryOver: Array<[string, string]> = [
    ['verified', '已验证（当时）'],
    ['rejected', '已否决方案'],
    ['blockers', '当时的卡点'],
    ['constraints', '硬约束'],
  ]
  for (const [key, title] of carryOver) {
    const body = sections.get(key)
    if (body === undefined || body.trim().length === 0) continue
    lines.push(`**${title}**`, '', clamp(body.trim(), 1_200), '')
  }

  lines.push(`> 完整原文见 \`history/${date.slice(0, 7)}.md\`（指纹 content:${input.hash}）。`, '')
  return lines.join('\n')
}

/** One history block: the document verbatim, fenced so it cannot break the file. */
export function renderHistoryBlock(previous: string, at: string, sourceSessionId: string, hash: string): string {
  const fence = '````'
  return [
    `## ${at}`,
    '',
    `- 原会话：\`${sourceSessionId}\``,
    `- 内容指纹：content:${hash}`,
    '',
    `${fence}markdown`,
    previous.trimEnd(),
    fence,
  ].join('\n')
}

/**
 * Split a rendered document into its sections by `## n. 标题`.
 *
 * Keys are the section numbers (`0`…`9`), because a number is stable across
 * rewording while a title is not. Text before the first heading is returned
 * under `preamble`.
 */
export function splitSections(document: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = document.split('\n')
  let key = 'preamble'
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    if (text.length > 0 && !result.has(key)) result.set(key, text)
    buffer = []
  }

  for (const line of lines) {
    const heading = /^##\s+(\d+)\./.exec(line.trim())
    if (heading !== null) {
      flush()
      key = heading[1]!
      continue
    }
    buffer.push(line)
  }
  flush()

  // Alias the numeric keys to their semantic names so callers can ask either way.
  const aliases: Record<string, string> = {
    '0': 'selfcheck',
    '1': 'goal',
    '2': 'facts',
    '3': 'blockers',
    '4': 'next',
    '5': 'constraints',
    '6': 'files',
    '7': 'rejected',
    '8': 'verified',
    '9': 'history',
  }
  for (const [number, name] of Object.entries(aliases)) {
    const body = result.get(number)
    if (body !== undefined && !result.has(name)) result.set(name, body)
  }
  return result
}

/** First non-empty, non-placeholder line of a section body. */
function firstMeaningful(body: string | undefined): string | undefined {
  if (body === undefined) return undefined
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (/^（未提供/.test(trimmed)) continue
    if (/^（上一版/.test(trimmed)) continue
    if (trimmed === '无') continue
    return trimmed
  }
  return undefined
}

/** A stable content hash, short enough to read in a changelog entry. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，完整内容见 history）`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the previous document, if there is one, with the month it belongs to.
 *
 * The month comes from the previous document's own header date when it has one
 * — a document written in September and archived in October belongs to
 * September's history — and falls back to the archive time.
 */
export async function readPrevious(
  files: WorkspaceFiles,
  documentPath: string,
  fallbackMonth: string,
): Promise<{ text: string; month: string } | undefined> {
  const text = await files.read(documentPath)
  if (text === undefined || text.trim().length === 0) return undefined
  const headerDate = /最后验证）|（v[\d.]+ \/ (\d{4}-\d{2}-\d{2})/.exec(text)
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text.slice(0, 400))
  const month = headerDate?.[2]?.slice(0, 7) ?? iso?.[0]?.slice(0, 7) ?? fallbackMonth
  return { text, month }
}
