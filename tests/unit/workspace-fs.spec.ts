import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  OutsideWorkspaceError,
  createMemoryFiles,
  createWorkspaceFiles,
  resolveInside,
} from '@src/workspace-fs.ts'

describe('resolveInside', () => {
  it('resolves a relative path under the root', () => {
    /*
     * `resolve` is platform-aware: on Windows a rooted-but-driveless path like
     * `/work/proj` gains the current drive, so the expectation must go through
     * the same `resolve` rather than assuming a separator or a drive letter.
     */
    expect(resolveInside('/work/proj', 'docs/a.md')).toBe(resolve('/work/proj', 'docs/a.md'))
  })

  /*
   * The check is `relative()`, not a string prefix: `C:\work\proj2` starts with
   * `C:\work\proj` but is a different directory. A prefix test would let a
   * project slug of `../proj2` write outside the workspace.
   */
  it('refuses a path that escapes the root', () => {
    expect(() => resolveInside('/work/proj', '../other/file.md')).toThrow(OutsideWorkspaceError)
    expect(() => resolveInside('/work/proj', 'docs/../../file.md')).toThrow(OutsideWorkspaceError)
  })

  it('refuses an absolute path outside the root', () => {
    expect(() => resolveInside('/work/proj', '/etc/passwd')).toThrow(OutsideWorkspaceError)
  })

  it('names the refusal so the caller can report it', () => {
    try {
      resolveInside('/work/proj', '../x')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(OutsideWorkspaceError)
      expect((error as OutsideWorkspaceError).message).toContain('工作区之外')
    }
  })
})

describe('createWorkspaceFiles (real disk)', () => {
  async function workspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'handoff-doc-'))
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it('writes and reads back a nested file, creating parents', async () => {
    const ws = await workspace()
    try {
      const files = createWorkspaceFiles(ws.root)
      await files.write('docs/handoff/p/HANDOFF.md', '# 交接\n')
      expect(await files.read('docs/handoff/p/HANDOFF.md')).toBe('# 交接\n')
      expect(await files.exists('docs/handoff/p/HANDOFF.md')).toBe(true)
      expect(await files.exists('docs/handoff/p/NOPE.md')).toBe(false)
    } finally {
      await ws.cleanup()
    }
  })

  it('returns undefined for a missing file instead of throwing', async () => {
    const ws = await workspace()
    try {
      const files = createWorkspaceFiles(ws.root)
      expect(await files.read('nope.md')).toBeUndefined()
      expect(await files.list('nope')).toEqual([])
    } finally {
      await ws.cleanup()
    }
  })

  it('replaces a file atomically, leaving no temp files behind', async () => {
    const ws = await workspace()
    try {
      const files = createWorkspaceFiles(ws.root)
      await files.write('a.md', 'one')
      await files.write('a.md', 'two')
      expect(await readFile(join(ws.root, 'a.md'), 'utf8')).toBe('two')
      expect(await files.list('.')).toEqual(['a.md'])
    } finally {
      await ws.cleanup()
    }
  })

  it('refuses to write outside the root', async () => {
    const ws = await workspace()
    try {
      const files = createWorkspaceFiles(ws.root)
      await expect(files.write('../escape.md', 'x')).rejects.toThrow(OutsideWorkspaceError)
    } finally {
      await ws.cleanup()
    }
  })

  it('lists directory names, not full paths', async () => {
    const ws = await workspace()
    try {
      const files = createWorkspaceFiles(ws.root)
      await mkdir(join(ws.root, 'history'), { recursive: true })
      await writeFile(join(ws.root, 'history', '2026-10.md'), 'x', 'utf8')
      expect(await files.list('history')).toEqual(['2026-10.md'])
    } finally {
      await ws.cleanup()
    }
  })
})

describe('createMemoryFiles', () => {
  it('records writes in order', async () => {
    const files = createMemoryFiles({})
    await files.write('b.md', 'b')
    await files.write('a.md', 'a')
    expect(files.writes.map((entry) => entry.path)).toEqual(['b.md', 'a.md'])
  })

  it('lists entries one level deep', async () => {
    const files = createMemoryFiles({ 'd/a.md': '', 'd/e/b.md': '', 'other.md': '' })
    expect(await files.list('d')).toEqual(['a.md', 'e'])
  })

  it('builds absolute paths from the declared root', () => {
    expect(createMemoryFiles({}, '/w').absolute('a.md')).toBe('/w/a.md')
  })
})
