/**
 * The only module that touches the disk.
 *
 * Everything else in this plugin takes a `WorkspaceFiles` and asks it questions.
 * Two reasons, both learned from the previous plugin's archive step:
 *
 * 1. **Tests must not need a workspace.** The archiving rules (what moves to
 *    CHANGELOG, how a month rotates, whether a rewrite is allowed) are the part
 *    most likely to be wrong, and they are pure functions over text. An
 *    in-memory implementation makes them testable without a temp directory.
 * 2. **Writes must be atomic and confined.** A handoff rewrites a file the
 *    successor is about to read. A half-written HANDOFF.md is worse than the
 *    old one, so every write goes through a temp file and a rename, and every
 *    path is resolved inside the workspace root — a project slug that somehow
 *    contains `..` must not be able to write outside it.
 */
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** Relative-path file operations, all confined to one workspace root. */
export interface WorkspaceFiles {
  /** The workspace root this instance is confined to. */
  readonly root: string
  /** File contents, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>
  /** Replace a file's contents, creating parents. Atomic. */
  write(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Names inside a directory; empty when it does not exist. */
  list(path: string): Promise<readonly string[]>
  /** Absolute path for a workspace-relative one. */
  absolute(path: string): string
}

/** Thrown when a caller asks for a path outside the root. */
export class OutsideWorkspaceError extends Error {
  readonly requested: string
  readonly root: string

  constructor(requested: string, root: string) {
    super(`拒绝写入工作区之外的路径：${requested}（工作区 ${root}）`)
    this.name = 'OutsideWorkspaceError'
    this.requested = requested
    this.root = root
  }
}

/**
 * Resolve one relative path against the root, refusing to escape.
 *
 * `relative()` is the check rather than a string prefix: `C:\work\proj2` starts
 * with `C:\work\proj` but is a different directory, and a prefix test would let
 * it through.
 */
export function resolveInside(root: string, path: string): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, normalize(path))
  const rel = relative(absoluteRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new OutsideWorkspaceError(path, absoluteRoot)
  return target
}

/** The real filesystem, confined to `root`. */
export function createWorkspaceFiles(root: string): WorkspaceFiles {
  const absoluteRoot = resolve(root)
  return {
    root: absoluteRoot,
    absolute(path: string): string {
      return resolveInside(absoluteRoot, path)
    },
    async read(path: string): Promise<string | undefined> {
      try {
        return await readFile(resolveInside(absoluteRoot, path), 'utf8')
      } catch {
        return undefined
      }
    },
    async write(path: string, content: string): Promise<void> {
      const target = resolveInside(absoluteRoot, path)
      await mkdir(dirname(target), { recursive: true })
      /*
       * Temp file then rename. `rename` is atomic within one filesystem, so a
       * reader either sees the old document or the new one — never a prefix of
       * the new one. The temp name carries the pid so two concurrent handoffs
       * (different sessions, same workspace) cannot collide.
       */
      const temp = join(dirname(target), `.${process.pid}-${Date.now()}.tmp`)
      try {
        await writeFile(temp, content, 'utf8')
        await rename(temp, target)
      } catch (error) {
        await unlink(temp).catch(() => undefined)
        throw error
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(resolveInside(absoluteRoot, path))
        return true
      } catch {
        return false
      }
    },
    async list(path: string): Promise<readonly string[]> {
      try {
        const { readdir } = await import('node:fs/promises')
        return await readdir(resolveInside(absoluteRoot, path))
      } catch {
        return []
      }
    },
  }
}

/** An in-memory `WorkspaceFiles`, for tests. Records writes in order. */
export function createMemoryFiles(initial: Record<string, string> = {}, root = '/workspace'): WorkspaceFiles & {
  readonly writes: readonly { readonly path: string; readonly content: string }[]
  snapshot(): Record<string, string>
} {
  const files = new Map<string, string>(Object.entries(initial))
  const writes: { path: string; content: string }[] = []
  return {
    root,
    writes,
    absolute(path: string): string {
      return `${root}/${path}`
    },
    async read(path: string): Promise<string | undefined> {
      return files.get(path)
    },
    async write(path: string, content: string): Promise<void> {
      files.set(path, content)
      writes.push({ path, content })
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path)
    },
    async list(path: string): Promise<readonly string[]> {
      // `.` (and an empty path) mean the root itself, which has no prefix.
      const root = path === '.' || path === '' || path === './'
      const prefix = root ? '' : path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (prefix.length > 0 && !key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const first = rest.split('/')[0]
        if (first !== undefined && first.length > 0) names.add(first)
      }
      return [...names]
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(files)
    },
  }
}

/** True when `path` names a directory-ish entry (used only for display). */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(sep)
}
