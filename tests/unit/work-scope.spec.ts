import { describe, expect, it } from 'vitest'
import { focusLooksWrong, readWorkScope, scopesInPlay } from '@src/work-scope.ts'
import type { SessionEventLike } from '@src/contracts.ts'

const SUB = { type: 'tool/call' } as const

function call(name: string, args: unknown): SessionEventLike {
  return { type: SUB.type, seq: 1, data: { name, arguments: JSON.stringify(args) } }
}

function bash(command: string): SessionEventLike {
  return { type: 'tool/call', seq: 1, data: { name: 'ops_bash', arguments: JSON.stringify({ command }) } }
}

const CANDIDATES = ['plugin-a', 'plugin-b', 'plugin-c']

describe('readWorkScope', () => {
  it('counts the directories the session named, most-named first', () => {
    const scope = readWorkScope(
      [
        bash('sed -n 1,80p plugin-a/src/index.ts'),
        bash('cd plugin-a && npm run check'),
        bash('ls plugin-b'),
      ],
      CANDIDATES,
    )
    expect(scope.map((entry) => entry.directory)).toEqual(['plugin-a', 'plugin-b'])
    expect(scope[0]!.calls).toBe(2)
    expect(scope[1]!.calls).toBe(1)
  })

  it('marks the leader as the focus once it clears the floor', () => {
    const scope = readWorkScope(
      [bash('cd plugin-a && npm test'), bash('cat plugin-a/package.json'), bash('ls plugin-b')],
      CANDIDATES,
    )
    expect(scope.find((entry) => entry.focus)?.directory).toBe('plugin-a')
  })

  /*
   * A single `ls` of the workspace root names every sibling. Without the floor,
   * whichever directory the listing happened to name first would be declared
   * the focus, and the successor would be pointed at a project the session
   * never opened.
   */
  it('refuses to name a focus from a single listing', () => {
    const scope = readWorkScope([bash('ls plugin-a plugin-b plugin-c')], CANDIDATES)
    expect(scope.find((entry) => entry.focus)).toBeUndefined()
    // Still reported, so the caller can say they were merely observed.
    expect(scope.map((entry) => entry.directory).sort()).toEqual(['plugin-a', 'plugin-b', 'plugin-c'])
  })

  it('counts one call once, however many times the directory appears in it', () => {
    const noisy = bash('grep -rn "plugin-a" plugin-a/src plugin-a/tests plugin-a/docs')
    const scope = readWorkScope([noisy, noisy], CANDIDATES)
    expect(scope).toHaveLength(1)
    expect(scope[0]!.calls).toBe(2)
  })

  it('does not match a directory whose name merely starts with the candidate', () => {
    const scope = readWorkScope([bash('cd plugin-a-old && npm test')], CANDIDATES)
    expect(scope).toEqual([])
  })

  /*
   * This plugin's own artifacts are hidden files: `.dsh-handoff-doc.raw.md` and
   * `.dsh-handoff-doc.log`. Reading the raw output is the documented first step
   * when a handoff is refused, so a dot before the name is a real boundary.
   * Rejecting it undercounted a live session by one call and sent a successor
   * looking for a discrepancy that did not exist.
   */
  it('treats a leading dot as a boundary, so hidden artifacts count', () => {
    const scope = readWorkScope(
      [bash("node -e \"readFileSync('.plugin-a.raw.md','utf8')\"")],
      CANDIDATES,
    )
    expect(scope[0]!.directory).toBe('plugin-a')
    expect(scope[0]!.calls).toBe(1)
  })

  it('reads windows-style paths', () => {
    const scope = readWorkScope(
      [bash('cd D:\\Work\\w\\plugin-b && npm run check'), bash('cat D:\\Work\\w\\plugin-b\\package.json')],
      CANDIDATES,
    )
    expect(scope[0]!.directory).toBe('plugin-b')
  })

  /*
   * A directory named only in output is not evidence of work: an error message
   * can mention paths the session never touched, and `ask_user_question` text
   * is the user's words rather than the session's actions.
   */
  it('ignores results and non-action tools', () => {
    const events: SessionEventLike[] = [
      { type: 'tool/result', seq: 2, data: { message: { content: [{ text: 'plugin-a' }] } } },
      call('ask_user_question', { question: 'plugin-b 要改吗' }),
    ]
    expect(readWorkScope(events, CANDIDATES)).toEqual([])
  })

  it('reports the total so a caller can weigh the share', () => {
    const scope = readWorkScope([bash('ls plugin-a'), bash('echo hi')], CANDIDATES)
    expect(scope[0]!.totalCalls).toBe(2)
  })

  it('returns nothing without events, candidates, or a match', () => {
    expect(readWorkScope(undefined, CANDIDATES)).toEqual([])
    expect(readWorkScope([], CANDIDATES)).toEqual([])
    expect(readWorkScope([bash('ls plugin-a')], [])).toEqual([])
    expect(readWorkScope([bash('ls nothing-here')], CANDIDATES)).toEqual([])
  })
})

describe('scopesInPlay', () => {
  const scope = (entries: [string, number, boolean][], totalCalls = 100) =>
    entries.map(([directory, calls, focus]) => ({ directory, calls, totalCalls, focus }))

  it('keeps the focus and drops an incidental glance', () => {
    const play = scopesInPlay(scope([['a', 40, true], ['b', 2, false]]))
    expect(play.map((entry) => entry.directory)).toEqual(['a'])
  })

  /*
   * The reason this is not a presence test: a `grep` across the workspace names
   * every project, and telling the successor to verify all of them before
   * starting is exactly the bug being fixed here.
   */
  it('keeps a project worked in comparably hard', () => {
    const play = scopesInPlay(scope([['a', 40, true], ['b', 15, false], ['c', 3, false]]))
    expect(play.map((entry) => entry.directory)).toEqual(['a', 'b'])
  })

  it('never keeps a secondary below the floor, however small the focus', () => {
    // A quarter of 4 is 1, which would let a single glance through.
    const play = scopesInPlay(scope([['a', 4, true], ['b', 1, false]]))
    expect(play.map((entry) => entry.directory)).toEqual(['a'])
  })

  it('stays empty when there is no focus', () => {
    expect(scopesInPlay(scope([['a', 1, false], ['b', 1, false]]))).toEqual([])
    expect(scopesInPlay([])).toEqual([])
  })
})

describe('focusLooksWrong', () => {
  const scope = (entries: [string, number, boolean][], totalCalls: number) =>
    entries.map(([directory, calls, focus]) => ({ directory, calls, totalCalls, focus }))

  /*
   * The failure this exists for: a 268-call session whose real project was
   * invisible to the candidate scan. The best remaining candidate had been
   * named twice, so it became "the project" and the handoff was filed under it.
   */
  it('flags a focus that accounts for almost none of the session', () => {
    expect(focusLooksWrong(scope([['wrong', 2, true], ['other', 1, false]], 268))).toBe(true)
  })

  it('trusts a focus that carries most of the work', () => {
    expect(focusLooksWrong(scope([['real', 266, true], ['wrong', 2, false]], 268))).toBe(false)
  })

  it('trusts a focus in a short session, where two of three is normal', () => {
    expect(focusLooksWrong(scope([['a', 2, true], ['b', 1, false]], 3))).toBe(false)
  })

  it('does not flag when there is no focus, or the total is unknown', () => {
    expect(focusLooksWrong([])).toBe(false)
    expect(focusLooksWrong(scope([['a', 1, false]], 100))).toBe(false)
  })
})
