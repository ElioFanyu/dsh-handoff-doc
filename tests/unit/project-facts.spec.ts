import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { focusFromEvents, listSubProjects, readProjectFacts, stackFromDeps } from '@src/project-facts.ts'
import { createMemoryFiles } from '@src/workspace-fs.ts'

const MANIFEST = JSON.stringify({
  name: 'my-app',
  scripts: {
    check: 'tsc --noEmit && vitest run && tsdown',
    test: 'vitest run',
    'test:image': 'vitest run tests/image',
    lint: 'eslint .',
    dev: 'vite',
    start: 'node server.js',
  },
})

describe('readProjectFacts', () => {
  it('takes the project title from the manifest', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': MANIFEST }),
      cwd: '/w/my-app',
      slug: 'my-app',
    })
    expect(facts.title).toBe('my-app')
    expect(facts.slug).toBe('my-app')
  })

  it('falls back to the slug when there is no manifest', async () => {
    const facts = await readProjectFacts({ files: createMemoryFiles({}), cwd: '/w/x', slug: 'x' })
    expect(facts.title).toBe('x')
    expect(facts.commands).toEqual([])
  })

  it('detects the stack from marker files', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'package.json': MANIFEST,
        'pnpm-lock.yaml': '',
        'tsconfig.json': '{}',
      }),
      cwd: '/w/p',
      slug: 'p',
    })
    expect(facts.stack).toContain('Node')
    expect(facts.stack).toContain('pnpm')
    expect(facts.stack).toContain('TypeScript')
  })

  /*
   * A `dev`/`start` script is not a check: running it starts a server and never
   * exits. In a §0 self-check that is actively harmful, so it is filtered out
   * even though the manifest lists it.
   */
  it('keeps verification scripts and drops dev/start servers', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': MANIFEST }),
      cwd: '/w/p',
      slug: 'p',
    })
    const commands = facts.commands.map((entry) => entry.command)
    expect(commands).toContain('npm run check')
    expect(commands).toContain('npm run test')
    expect(commands).toContain('npm run test:image')
    expect(commands).not.toContain('npm run dev')
    expect(commands).not.toContain('npm run start')
  })

  it('orders the most authoritative check first', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': MANIFEST }),
      cwd: '/w/p',
      slug: 'p',
    })
    expect(facts.commands[0]!.command).toBe('npm run check')
  })

  it('uses the package manager named by the lock file', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': MANIFEST, 'pnpm-lock.yaml': '' }),
      cwd: '/w/p',
      slug: 'p',
    })
    expect(facts.commands.map((entry) => entry.command)).toContain('pnpm run check')
  })

  it('copies the script body as evidence of what passing means', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': MANIFEST }),
      cwd: '/w/p',
      slug: 'p',
    })
    const check = facts.commands.find((entry) => entry.command === 'npm run check')!
    expect(check.origin).toBe('package.json#scripts.check')
    // The expectation is a sentence; the script body is separate evidence, so
    // §0 can print one line of "what passing means" and one of "what runs".
    expect(check.proves).toBe('全部检查通过（通常是类型 + 测试的组合）')
    expect(check.definition).toBe('tsc --noEmit && vitest run && tsdown')
  })

  it('prefers the README wording when the project documents a command', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'package.json': MANIFEST,
        'README.md': ['# app', '', '| 命令 | 说明 |', '| --- | --- |', '| `npm run test` | 测试全绿，覆盖交接链路 |'].join('\n'),
      }),
      cwd: '/w/p',
      slug: 'p',
    })
    const test = facts.commands.find((entry) => entry.command === 'npm run test')!
    expect(test.proves).toContain('README 原文')
    expect(test.proves).toContain('覆盖交接链路')
  })

  it('reads Makefile targets that look like checks', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ Makefile: 'test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\nrun:\n\tgo run .\n' }),
      cwd: '/w/p',
      slug: 'p',
    })
    const commands = facts.commands.map((entry) => entry.command)
    expect(commands).toContain('make test')
    expect(commands).toContain('make lint')
    expect(commands).not.toContain('make run')
  })

  it('survives a malformed manifest without losing the handoff', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': '{ not json' }),
      cwd: '/w/p',
      slug: 'p',
    })
    expect(facts.commands).toEqual([])
    expect(facts.title).toBe('p')
  })

  it('de-duplicates a command found by two sources', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        'Makefile': 'test:\n\tvitest run\n',
      }),
      cwd: '/w/p',
      slug: 'p',
    })
    expect(facts.commands.filter((entry) => entry.command.endsWith('test'))).toHaveLength(2)
    expect(new Set(facts.commands.map((entry) => entry.command)).size).toBe(facts.commands.length)
  })

  it('passes through the git facts it was given', async () => {
    const git = { branch: 'main', head: 'abc', dirty: true, changedFiles: 3 }
    const facts = await readProjectFacts({ files: createMemoryFiles({}), cwd: '/w/p', slug: 'p', git })
    expect(facts.git).toEqual(git)
  })
})

describe('stackFromDeps', () => {
  it('names the frameworks it recognises', () => {
    expect(stackFromDeps(['react', 'typescript', 'vitest'])).toEqual(['React', 'TypeScript', 'Vitest/Jest'])
  })

  it('says nothing when nothing is recognised', () => {
    expect(stackFromDeps(['left-pad'])).toEqual([])
  })
})

/*
 * A workspace that holds several independent projects and has no manifest of
 * its own is a common layout — this very repository is one. Reading only the
 * root then reports "no verification command found", which tells the successor
 * to go and invent one: advice that is not merely useless but wrong.
 */
describe('readProjectFacts — workspace with no root manifest', () => {
  /*
   * Order is a recommendation: the successor is told to run §0's commands
   * before anything else, so whichever project this session actually worked in
   * belongs at the top. Without a log the order stays directory order, which is
   * stable and matches the editor.
   */
  it('puts the project named by the session log first', async () => {
    const files = createMemoryFiles({
      'plugin-a/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
      'plugin-b/package.json': JSON.stringify({ scripts: { check: 'tsc && vitest run' } }),
    })
    const events = [
      { type: 'tool/call', seq: 1, data: { name: 'ops_bash', arguments: '{"command":"cd plugin-b && npm test"}' } },
      { type: 'tool/call', seq: 2, data: { name: 'ops_bash', arguments: '{"command":"ls plugin-b/src"}' } },
    ]
    const facts = await readProjectFacts({ files, cwd: '/w', slug: 'w', events })
    expect(facts.commands[0]!.command).toBe('cd plugin-b && npm run check')
    expect(facts.scope.find((entry) => entry.focus)?.directory).toBe('plugin-b')
    expect(facts.focusRoot).toBe(join('/w', 'plugin-b'))
  })

  it('keeps directory order when no log names a project', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'plugin-a/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
        'plugin-b/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
      }),
      cwd: '/w',
      slug: 'w',
      events: [],
    })
    expect(facts.commands[0]!.command).toBe('cd plugin-a && npm run check')
    expect(facts.scope).toEqual([])
    expect(facts.focusRoot).toBeUndefined()
  })

  it('has no scope when the root manifest supplies the commands', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({ 'package.json': JSON.stringify({ scripts: { check: 'tsc' } }) }),
      cwd: '/w',
      slug: 'w',
      events: [
        { type: 'tool/call', seq: 1, data: { name: 'ops_bash', arguments: '{"command":"ls"}' } },
      ],
    })
    // One project, one scope: ranking would invent a distinction that does not
    // exist, and the flat matrix is the better shape.
    expect(facts.scope).toEqual([])
    expect(facts.focusRoot).toBeUndefined()
  })

  it('reads one level down and names each sub-project', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'plugin-a/package.json': JSON.stringify({ name: 'a', scripts: { check: 'tsc', test: 'vitest run' } }),
        'plugin-b/package.json': JSON.stringify({ name: 'b', scripts: { check: 'tsc && vitest run' } }),
      }),
      cwd: '/w',
      slug: 'w',
    })
    const commands = facts.commands.map((entry) => entry.command)
    expect(commands).toContain('cd plugin-a && npm run check')
    expect(commands).toContain('cd plugin-b && npm run check')
    // One per sub-project, so a two-project workspace still fits §0's budget.
    expect(commands).toHaveLength(2)
  })

  it('puts the cd first, because the successor stands in the workspace root', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'plugin-a/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
      }),
      cwd: '/w',
      slug: 'w',
    })
    expect(facts.commands[0]!.command.startsWith('cd plugin-a && ')).toBe(true)
    expect(facts.commands[0]!.origin).toBe('plugin-a/package.json#scripts.check')
  })

  it('prefers the root manifest when there is one', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
        'plugin-a/package.json': JSON.stringify({ scripts: { check: 'other' } }),
      }),
      cwd: '/w',
      slug: 'w',
    })
    expect(facts.commands.map((entry) => entry.command)).toEqual(['npm run check'])
  })

  it('skips dependency and build directories', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'node_modules/x/package.json': JSON.stringify({ scripts: { check: 'no' } }),
        'dist/package.json': JSON.stringify({ scripts: { check: 'no' } }),
        '.hidden/package.json': JSON.stringify({ scripts: { check: 'no' } }),
      }),
      cwd: '/w',
      slug: 'w',
    })
    expect(facts.commands).toEqual([])
  })

  it('caps the list so §0 cannot become a directory listing', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 20; i += 1) {
      files[`p${i}/package.json`] = JSON.stringify({ scripts: { check: 'tsc', test: 'vitest' } })
    }
    const facts = await readProjectFacts({ files: createMemoryFiles(files), cwd: '/w', slug: 'w' })
    expect(facts.commands.length).toBeLessThanOrEqual(6)
  })
})

describe('rankOf — sub-project commands keep their priority', () => {
  /*
   * A sub-project command carries a `cd` prefix. Without stripping it, every
   * such command ranked last and the priority list did nothing — which is how
   * `build` ended up ahead of `check` in §0 of this repository's own document.
   */
  it('ranks a prefixed check above a prefixed build', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'plugin/package.json': JSON.stringify({
          scripts: { build: 'tsdown', test: 'vitest run', check: 'tsc && vitest run' },
        }),
      }),
      cwd: '/w',
      slug: 'w',
    })
    // One per sub-project: `check` runs the tests, so listing both would spend
    // §0's three lines on the same evidence.
    expect(facts.commands.map((entry) => entry.command)).toEqual(['cd plugin && npm run check'])
  })
})

describe('readProjectFacts — stack for a manifest-less workspace', () => {
  it('reports the stacks of its sub-projects instead of "unrecognised"', async () => {
    const facts = await readProjectFacts({
      files: createMemoryFiles({
        'a/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
        'a/tsconfig.json': '{}',
        'a/pnpm-lock.yaml': '',
        'b/package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
        'b/tsconfig.json': '{}',
      }),
      cwd: '/w',
      slug: 'w',
    })
    // Deduplicated: two sub-projects that are both Node + TypeScript say it once.
    expect(facts.stack.filter((label) => label === 'Node')).toHaveLength(1)
    expect(facts.stack).toContain('TypeScript')
    expect(facts.stack).toContain('pnpm')
  })

  it('says nothing when there is genuinely nothing to detect', async () => {
    const facts = await readProjectFacts({ files: createMemoryFiles({}), cwd: '/w', slug: 'w' })
    expect(facts.stack).toEqual([])
  })
})

/*
 * Naming the output folder needs the focus before the facts are read, so these
 * two are what a caller reaches for first: list the candidates, ask the log
 * which one it kept touching.
 */
describe('listSubProjects / focusFromEvents', () => {
  it('lists only directories that hold a manifest', async () => {
    const names = await listSubProjects(
      createMemoryFiles({
        'plugin-a/package.json': '{}',
        'plugin-b/package.json': '{}',
        'docs/README.md': 'x',
        'node_modules/x/package.json': '{}',
      }),
    )
    expect([...names].sort()).toEqual(['plugin-a', 'plugin-b'])
  })

  it('returns the focus when one project dominates the log', () => {
    const events = [
      { type: 'tool/call', seq: 1, data: { name: 'ops_bash', arguments: '{"command":"cd plugin-b && npm test"}' } },
      { type: 'tool/call', seq: 2, data: { name: 'ops_bash', arguments: '{"command":"ls plugin-b/src"}' } },
      { type: 'tool/call', seq: 3, data: { name: 'ops_bash', arguments: '{"command":"ls plugin-a"}' } },
    ]
    expect(focusFromEvents(events, ['plugin-a', 'plugin-b'])?.directory).toBe('plugin-b')
  })

  it('returns nothing when no project was worked in, so the caller keeps the workspace name', () => {
    expect(focusFromEvents(undefined, ['plugin-a'])).toBeUndefined()
    expect(focusFromEvents([], ['plugin-a'])).toBeUndefined()
  })
})
