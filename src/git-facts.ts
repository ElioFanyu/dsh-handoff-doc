/**
 * Git state, read without a library and without ever failing the handoff.
 *
 * ## Why this is its own module
 *
 * It was first written inside `index.ts`, which made it unreachable from a
 * script that wanted git facts without booting the whole host entry: importing
 * the entry pulls in the coordinator, the monitor and every host contract. A
 * three-subprocess helper does not belong behind that door.
 *
 * ## Why `undefined` is the right answer for "not a repository"
 *
 * A workspace without git is normal — this repository's own parent directory is
 * one. The document then falls back to a functional-change validity window,
 * which is honest. Throwing, or inventing a HEAD, would either fail a good
 * handoff or produce a validity line that makes the successor rewrite a
 * perfectly valid document.
 */
import type { GitFacts } from './handoff-doc.ts'

/** How long any one git call may take before it is abandoned. */
const GIT_TIMEOUT_MS = 3_000

/**
 * Read branch, HEAD and dirtiness.
 *
 * Three short subprocesses, run concurrently after a single cheap probe. Every
 * failure — not installed, not a repository, hung, permission denied — is an
 * `undefined` result rather than an error, because a handoff must not depend on
 * version control being present or fast.
 */
export async function readGitFacts(input: { root: string }): Promise<GitFacts | undefined> {
  const { execFile } = await import('node:child_process')

  const run = (args: readonly string[]): Promise<string | undefined> =>
    new Promise((resolve) => {
      try {
        execFile(
          'git',
          [...args],
          { cwd: input.root, timeout: GIT_TIMEOUT_MS, windowsHide: true },
          (error, stdout) => {
            resolve(error !== null ? undefined : stdout.trim())
          },
        )
      } catch {
        resolve(undefined)
      }
    })

  // The probe: `--is-inside-work-tree` prints exactly `true` or `false`, so it
  // distinguishes "not a repo" from "git missing" without parsing an error.
  if ((await run(['rev-parse', '--is-inside-work-tree'])) !== 'true') return undefined

  const [branch, head, status] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['rev-parse', 'HEAD']),
    run(['status', '--porcelain']),
  ])

  const changed =
    status === undefined || status.length === 0
      ? []
      : status.split('\n').filter((line) => line.trim().length > 0)

  return {
    branch: branch === undefined || branch.length === 0 ? undefined : branch,
    head: head === undefined || head.length === 0 ? undefined : head,
    dirty: changed.length > 0,
    changedFiles: changed.length,
  }
}
