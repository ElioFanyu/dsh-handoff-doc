/**
 * Orchestration: turn a model narrative into two files and one message.
 *
 * This is the step the coordinator calls where it used to call "summarize".
 * The shape of the result changed with the design:
 *
 * - Before: `{ brief }` — one string, delivered as a message.
 * - Now: `{ documentPath, message }` — a file written to disk, plus a short
 *   pointer message that tells the successor where to look and what order to
 *   read in.
 *
 * ## Why the file is written before the session is created
 *
 * The coordinator creates the new session only after this resolves. So a write
 * failure aborts the handoff with the old session intact and zero side effects
 * on the new one — the same "no half-done handoff" rule as before, applied to a
 * new kind of artifact. It also means the archive (which rewrites CHANGELOG) has
 * already happened, so a retry sees a consistent workspace.
 *
 * ## Why the pointer message is short and repeatable
 *
 * The successor pays for its first message on every turn that keeps it in
 * context. The old brief cost thousands of tokens *and* could not be updated
 * afterwards. A pointer costs ~200 tokens and the document behind it can be
 * re-read selectively, revised, or replaced by the next handoff.
 */
import { archivePrevious, readPrevious } from './archive.ts'
import {
  DOC_SECTIONS,
  documentIsUsable,
  docPaths,
  fitToBudget,
  monthOf,
  projectSlug,
  renderDocument,
  renderPointer,
  validityOf,
  type DocFacts,
  type DocNarrative,
  type PendingInputFacts,
  type PreviousDoc,
} from './handoff-doc.ts'
import type { WorkspaceFiles } from './workspace-fs.ts'

/** Everything one document write needs. */
export interface WriteHandoffInput {
  readonly files: WorkspaceFiles
  /** Workspace-relative root for handoff files, e.g. `docs/handoff`. */
  readonly root: string
  /** Project folder name; from `projectSlug` unless the user pinned one. */
  readonly project: string
  readonly narrative: DocNarrative
  /** Facts already read; `createdAt` decides the month and the header date. */
  readonly facts: DocFacts
  readonly version: string
  readonly reason: string
  /** Hard cap for the rendered document. */
  readonly budgetChars: number
  /** When false, the previous document is left alone and simply overwritten. */
  readonly archive: boolean
  /**
   * The human's instruction for the successor (`/handoff 推送 GitHub`).
   *
   * Carried into the pointer message only. It must never enter the document:
   * the document is a snapshot of what is true, and an instruction from the
   * user is not a fact about the workspace — it would also compete for the
   * character budget and could be dropped by `fitToBudget`.
   */
  readonly instruction?: string | undefined
}

/** What the caller reports to the user and hands to the new session. */
export interface WriteHandoffResult {
  readonly ok: boolean
  readonly documentPath: string
  readonly absolutePath: string
  /** The short message delivered to the successor. */
  readonly message: string
  readonly bytes: number
  readonly redactions: readonly string[]
  /** Sections the budget forced out; empty when the document fits. */
  readonly dropped: readonly string[]
  readonly archive: {
    readonly archived: boolean
    readonly changelogUpdated: boolean
    readonly historyUpdated: boolean
    readonly skippedDuplicate: boolean
    readonly warnings: readonly string[]
  }
  readonly error?: string
}

/**
 * Write the document, archive the previous one, and build the pointer.
 *
 * The only refusal here is an unusable narrative — missing a required section.
 * Every filesystem failure is reported, not thrown, except the document write
 * itself: a handoff whose document did not land must fail, because the new
 * session would otherwise be pointed at a stale file.
 */
export async function writeHandoff(input: WriteHandoffInput): Promise<WriteHandoffResult> {
  const paths = docPaths(input.root, input.project)
  const month = monthOf(input.facts.createdAt)

  const usable = documentIsUsable(input.narrative)
  if (!usable.ok) {
    return {
      ok: false,
      documentPath: paths.document,
      absolutePath: input.files.absolute(paths.document),
      message: '',
      bytes: 0,
      redactions: [],
      dropped: [],
      archive: {
        archived: false,
        changelogUpdated: false,
        historyUpdated: false,
        skippedDuplicate: false,
        warnings: [],
      },
      error: `交接文档缺少必需小节：${usable.missing
        .map((key) => DOC_SECTIONS.find((section) => section.key === key)?.heading.replace(/^##\s*/, '') ?? key)
        .join('、')}。已放弃本次交接，原会话未受影响。`,
    }
  }

  /*
   * Archive first, write second.
   *
   * A failure to archive is a warning; a failure to write is fatal. Doing it in
   * this order means a fatal write leaves the old document AND its archive
   * intact, so the workspace is never in a state where history was consumed but
   * the new document never arrived.
   */
  const archive = input.archive
    ? await archivePrevious({
        files: input.files,
        documentPath: paths.document,
        changelogPath: paths.changelog,
        historyPath: paths.historyOf(month),
        at: new Date(input.facts.createdAt).toISOString(),
        reason: input.reason,
        sourceSessionId: input.facts.sourceSessionId,
      })
    : {
        archived: false,
        changelogUpdated: false,
        historyUpdated: false,
        skippedDuplicate: false,
        warnings: [],
        archivedChars: 0,
      }

  const rendered = renderDocument({
    facts: input.facts,
    narrative: input.narrative,
    version: input.version,
    archivePointer: paths.changelog,
  })

  const fitted = fitToBudget(rendered.text, input.budgetChars)

  try {
    await input.files.write(paths.document, fitted.text)
  } catch (error) {
    return {
      ok: false,
      documentPath: paths.document,
      absolutePath: input.files.absolute(paths.document),
      message: '',
      bytes: 0,
      redactions: rendered.redactions,
      dropped: fitted.dropped,
      archive,
      error: `写入交接文档失败：${messageOf(error)}。原会话未受影响。`,
    }
  }

  const message = renderPointer({
    documentPath: paths.document,
    absolutePath: input.files.absolute(paths.document),
    project: input.project,
    validUntil: validityOf(input.facts),
    commands: input.facts.commands,
    ...(input.facts.scope === undefined ? {} : { scope: input.facts.scope }),
    ...(input.facts.pendingInput === undefined ? {} : { pendingInput: input.facts.pendingInput }),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
  })

  return {
    ok: true,
    documentPath: paths.document,
    absolutePath: input.files.absolute(paths.document),
    message,
    bytes: Buffer.byteLength(fitted.text, 'utf8'),
    redactions: rendered.redactions,
    dropped: fitted.dropped,
    archive,
  }
}

/** Read the previous document so the prompt can show it and the model can prune it. */
export async function previousDocument(
  files: WorkspaceFiles,
  root: string,
  project: string,
  now: number,
): Promise<PreviousDoc | undefined> {
  const paths = docPaths(root, project)
  return readPrevious(files, paths.document, monthOf(now))
}

/**
 * Resolve the project folder name.
 *
 * Priority: an explicit pin, then the sub-project the session worked in, then
 * the workspace folder.
 *
 * The middle step is the one that matters here. A workspace holding several
 * repositories has a name that says nothing about the work (`deepseek-harness`
 * is a container, not a project), so a handoff for a session that only touched
 * `dsh-handoff-doc` used to land in `docs/handoff/deepseek-harness/` beside every
 * other project's handoffs. Naming the folder after the focus makes the path
 * itself answer "which project is this about".
 */
export function resolveProject(
  pinned: string,
  cwd: string | undefined,
  focus?: string | undefined,
): string {
  const trimmed = pinned.trim()
  if (trimmed.length > 0) {
    // A pinned name is still slugified: it becomes a directory name.
    return projectSlug(`/${trimmed}`)
  }
  if (focus !== undefined && focus.trim().length > 0) return projectSlug(`/${focus.trim()}`)
  return projectSlug(cwd)
}

/** Facts plus the two program-observed extras the writer needs. */
export function withPending(facts: DocFacts, pending: PendingInputFacts | undefined): DocFacts {
  return pending === undefined ? facts : { ...facts, pendingInput: pending }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
