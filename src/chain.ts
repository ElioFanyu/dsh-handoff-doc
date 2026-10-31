/**
 * The handoff chain, on disk: which session handed off to which, and when.
 *
 * ## Why this cannot live in memory
 *
 * The coordinator already remembers "session A created session B" in a Map, and
 * refusing a second handoff from A depends on that memory. It was written to
 * stop a real problem — one session ran `/handoff` twice, ten minutes and 221
 * tool calls apart, leaving two live successors holding contradictory documents.
 *
 * Then the guard failed anyway: the Map is per-process, so a restart between two
 * handoffs erases it, and the very next `/handoff` was allowed. That happened
 * three times in one afternoon. A guard that a restart defeats is not a guard,
 * it is a coincidence.
 *
 * ## Shape
 *
 * Append-only JSON Lines at `docs/handoff/.dsh-handoff-doc.chain.jsonl`. One
 * record per *successful* handoff. Append-only rather than a rewritten object
 * because concurrent sessions in one workspace must not clobber each other, and
 * because the chain is history: the successor's question is "was I already
 * handed off, and by whom", which a log answers directly.
 *
 * Every read is tolerant. A missing file means "no handoffs yet"; a corrupt line
 * is skipped rather than thrown. A broken audit trail must never be able to
 * block the operation it is auditing — the same rule the failure log follows.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Workspace-relative location; sibling of the failure log. */
const CHAIN_PATH = 'docs/handoff/.dsh-handoff-doc.chain.jsonl'

/** One completed handoff. */
export interface ChainLink {
  /** The session that handed off; it must never hand off again. */
  readonly from: string
  /** The session that took over. */
  readonly to: string
  /** ISO timestamp, for ordering and for the successor's "how long ago". */
  readonly at: string
  /** Workspace-relative document path, so the chain explains itself. */
  readonly document?: string
}

/** Absolute path of the chain file for a workspace root. */
export function chainPath(workspace: string): string {
  return join(workspace, CHAIN_PATH)
}

/**
 * Append one link.
 *
 * Failures are swallowed and reported as `undefined`: the handoff itself has
 * already succeeded by the time this runs, and telling the user "your handoff
 * worked but the audit line did not" helps nobody. The in-memory map still
 * covers this process.
 */
export async function appendChainLink(
  workspace: string,
  link: ChainLink,
): Promise<string | undefined> {
  try {
    const file = chainPath(workspace)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(link)}\n`, 'utf8')
    return file
  } catch {
    return undefined
  }
}

/**
 * Every link on record, oldest first.
 *
 * Blank lines and unparseable lines are skipped. A record without both ids is
 * dropped: a half-written line cannot answer "who handed off to whom", and
 * guessing would be worse than ignoring it.
 */
export async function readChain(workspace: string): Promise<readonly ChainLink[]> {
  let raw: string
  try {
    raw = await readFile(chainPath(workspace), 'utf8')
  } catch {
    return []
  }
  const links: ChainLink[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const value = JSON.parse(trimmed) as Partial<ChainLink>
      if (typeof value.from !== 'string' || typeof value.to !== 'string') continue
      links.push({
        from: value.from,
        to: value.to,
        at: typeof value.at === 'string' ? value.at : '',
        ...(typeof value.document === 'string' ? { document: value.document } : {}),
      })
    } catch {
      // A truncated line (killed mid-write) is not worth reporting.
    }
  }
  return links
}

/**
 * The session this one was handed off to, if any.
 *
 * Used at entry to refuse a second handoff. Takes the *latest* link whose
 * `from` matches, so if a session somehow appears twice the newest answer wins.
 */
export async function handoffTargetOf(
  workspace: string,
  sessionId: string,
): Promise<string | undefined> {
  const links = await readChain(workspace)
  let found: string | undefined
  for (const link of links) if (link.from === sessionId) found = link.to
  return found
}

/**
 * The ordered session ids in this workspace, oldest first, with duplicates
 * collapsed.
 *
 * The successor needs a readable chain rather than a list of pairs: "a → b → c"
 * answers "where am I" in one line, which is the only question it has.
 */
export function chainSessions(links: readonly ChainLink[]): readonly string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const link of links) {
    for (const id of [link.from, link.to]) {
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
    }
  }
  return order
}
