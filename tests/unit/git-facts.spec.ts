import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGitFacts } from '@src/git-facts.ts'

/*
 * These run against real directories, because the whole point of this module is
 * what it does when `git` says no. A mock would assert the mock.
 */
describe('readGitFacts', () => {
  it('returns undefined outside a git work tree instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'handoff-nogit-'))
    try {
      // A fresh temp directory is not a repository (and may not even be under one).
      expect(await readGitFacts({ root })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns undefined for a directory that does not exist', async () => {
    // `git` fails with ENOENT; the handoff must degrade, not fail.
    expect(await readGitFacts({ root: join(tmpdir(), 'handoff-definitely-missing-xyz') })).toBeUndefined()
  })

  /*
   * The failure this guards against: a document whose validity line names a HEAD
   * that does not exist. The successor compares, sees a mismatch, and rewrites a
   * perfectly good document — the fabricated line is worse than no line.
   */
  it('never invents a HEAD when there is no repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'handoff-nogit-'))
    try {
      const facts = await readGitFacts({ root })
      expect(facts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
