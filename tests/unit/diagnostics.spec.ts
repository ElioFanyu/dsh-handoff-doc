import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordFailure } from '@src/diagnostics.ts'

const roots: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-log-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('recordFailure', () => {
  /*
   * The conversation surface truncates a failure to one red line, so the file
   * is the only place the whole message survives. It has to create its own
   * directory: the first failure may well happen before any handoff document
   * exists.
   */
  it('writes the message and the stack, creating the directory', async () => {
    const root = await workspace()
    const error = new Error('模型输出在写到 8421 字符时中断')
    const path = await recordFailure(root, { where: 'handoff', error, sessionId: 's1' })

    expect(path).toBe(join(root, 'docs/handoff/.dsh-handoff-doc.log'))
    const text = await readFile(path!, 'utf8')
    expect(text).toContain('handoff')
    expect(text).toContain('session: s1')
    expect(text).toContain('模型输出在写到 8421 字符时中断')
    expect(text).toContain('stack:')
  })

  it('appends rather than overwrites, so earlier failures survive', async () => {
    const root = await workspace()
    await recordFailure(root, { where: 'first', error: new Error('一') })
    await recordFailure(root, { where: 'second', error: new Error('二') })
    const text = await readFile(join(root, 'docs/handoff/.dsh-handoff-doc.log'), 'utf8')
    expect(text).toContain('first')
    expect(text).toContain('second')
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  })

  it('records the context that makes a failure diagnosable', async () => {
    const root = await workspace()
    await recordFailure(root, {
      where: 'narrative',
      error: new Error('x'),
      context: { maxTokens: 20_000, chars: 8_421 },
    })
    const text = await readFile(join(root, 'docs/handoff/.dsh-handoff-doc.log'), 'utf8')
    expect(text).toContain('"maxTokens":20000')
    expect(text).toContain('"chars":8421')
  })

  /*
   * Logging is diagnostic, not part of the handoff. A workspace it cannot
   * write to must cost the log entry and nothing else — the caller needs the
   * original error, not a second one from the logger.
   */
  it('returns undefined instead of throwing when it cannot write', async () => {
    const path = await recordFailure('\u0000not-a-real-path', {
      where: 'handoff',
      error: new Error('x'),
    })
    expect(path).toBeUndefined()
  })

  it('tolerates a thrown non-Error', async () => {
    const root = await workspace()
    const path = await recordFailure(root, { where: 'handoff', error: 'plain string' })
    const text = await readFile(path!, 'utf8')
    expect(text).toContain('plain string')
    // No stack to record, and no empty `stack:` header left behind.
    expect(text).not.toContain('stack:')
  })
})
