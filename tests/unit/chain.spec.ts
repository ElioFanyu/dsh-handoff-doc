import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendChainLink,
  chainPath,
  chainSessions,
  handoffTargetOf,
  readChain,
} from '@src/chain.ts'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-chain-'))
})

describe('the durable handoff chain', () => {
  /*
   * The guard this exists for used to live in a Map, so a restart between two
   * `/handoff` calls erased it and the very next call was allowed. That happened
   * three times in one afternoon; the file is the part that survives.
   */
  it('records a link and reads it back after "a restart"', async () => {
    const path = await appendChainLink(workspace, {
      from: 'session-a',
      to: 'session-b',
      at: '2026-10-31T11:00:00.000Z',
      document: 'docs/handoff/p/HANDOFF.md',
    })
    expect(path).toBeDefined()
    expect(await handoffTargetOf(workspace, 'session-a')).toBe('session-b')
    // A fresh read is what a restarted process does; nothing is cached.
    expect(await readChain(workspace)).toHaveLength(1)
  })

  it('returns nothing for a session that has not handed off', async () => {
    await appendChainLink(workspace, { from: 'session-a', to: 'session-b', at: 'x' })
    expect(await handoffTargetOf(workspace, 'session-z')).toBeUndefined()
  })

  it('reports no chain for a workspace that never handed off', async () => {
    expect(await readChain(workspace)).toEqual([])
    expect(await handoffTargetOf(workspace, 'anyone')).toBeUndefined()
  })

  it('lets the newest answer win when a session appears twice', async () => {
    await appendChainLink(workspace, { from: 'a', to: 'b', at: '1' })
    await appendChainLink(workspace, { from: 'a', to: 'c', at: '2' })
    expect(await handoffTargetOf(workspace, 'a')).toBe('c')
  })

  /*
   * A truncated line means the process died mid-write. Ignoring it is the right
   * call: a half-written record cannot say who handed off to whom, and guessing
   * would be worse than treating it as absent.
   */
  it('skips corrupt lines instead of throwing', async () => {
    await appendChainLink(workspace, { from: 'a', to: 'b', at: '1' })
    await writeFile(chainPath(workspace), '{"from":"a","to":\nnot json\n\n', { flag: 'a' })
    const links = await readChain(workspace)
    expect(links).toHaveLength(1)
    expect(links[0]!.to).toBe('b')
  })

  it('derives an ordered chain with duplicates collapsed', async () => {
    const links = [
      { from: 'a', to: 'b', at: '1' },
      { from: 'b', to: 'c', at: '2' },
      { from: 'c', to: 'd', at: '3' },
    ]
    expect(chainSessions(links)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('writes one JSON object per line, append-only', async () => {
    await appendChainLink(workspace, { from: 'a', to: 'b', at: '1' })
    await appendChainLink(workspace, { from: 'b', to: 'c', at: '2' })
    const raw = await readFile(chainPath(workspace), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })
})
