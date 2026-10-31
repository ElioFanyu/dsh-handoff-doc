import { describe, expect, it } from 'vitest'
import { writeHandoff, previousDocument, resolveProject } from '@src/handoff-writer.ts'
import { DOC_SECTIONS, type DocFacts } from '@src/handoff-doc.ts'
import { createMemoryFiles } from '@src/workspace-fs.ts'

function narrative(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    selfcheck: 'npm run check → 25 ✓ / 82 ✓ / 0 失败',
    goal: '做一个交接文档插件',
    facts: '插件行由 profile package.json 的 bundles 列表加载',
    blockers: '无',
    next: '改 §0 的自检命令 → 跑 npm test',
    constraints: '不改 profile 目录',
    files: 'src/handoff-doc.ts → 文档骨架与渲染',
    rejected: '曾按消息投递简报，已否决：无法归档',
    verified: 'npm test 261 ✓',
    history: '- 见 CHANGELOG.md',
  }
  return { ...base, ...overrides }
}

function facts(overrides: Partial<DocFacts> = {}): DocFacts {
  return {
    project: 'my-app',
    cwd: 'D:/work/my-app',
    commands: [{ command: 'npm run check', origin: 'package.json#scripts.check', proves: '全部检查通过' }],
    stack: ['Node'],
    agentPreset: 'coder',
    provider: 'deepseek',
    model: 'deepseek-chat',
    contextWindow: 200_000,
    permissionPreset: 'standard',
    planMode: 'off',
    turnCount: 12,
    occupancyPercent: 85,
    occupancyQuality: 'exact',
    git: { branch: 'main', head: 'abcdef1234567890', dirty: false, changedFiles: 0 },
    sourceSessionId: 'session-old',
    createdAt: Date.UTC(2026, 9, 31, 2, 0, 0),
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  const files = createMemoryFiles({}, 'D:/work/my-app')
  return {
    files,
    root: 'docs/handoff',
    project: 'my-app',
    narrative: narrative() as never,
    facts: facts(),
    version: 'v0.2.0',
    reason: '上下文占用 85%',
    budgetChars: 24_000,
    archive: true,
    ...overrides,
  }
}

describe('writeHandoff', () => {
  it('writes HANDOFF.md under <root>/<project> and returns the pointer message', async () => {
    const options = input()
    const result = await writeHandoff(options)

    expect(result.ok).toBe(true)
    expect(result.documentPath).toBe('docs/handoff/my-app/HANDOFF.md')
    expect(result.absolutePath).toBe('D:/work/my-app/docs/handoff/my-app/HANDOFF.md')

    const written = options.files.snapshot()['docs/handoff/my-app/HANDOFF.md']!
    expect(written).toContain('# 交接 —— my-app')
    for (const section of DOC_SECTIONS) expect(written).toContain(section.heading)

    // The message points at the file; it is not the file.
    expect(result.message).toContain('docs/handoff/my-app/HANDOFF.md')
    expect(result.message).not.toContain('插件行由 profile package.json')
    expect(result.bytes).toBeGreaterThan(1_000)
  })

  /*
   * The refusal is the load-bearing behaviour: a document missing §4 gives the
   * successor no action, and it cannot tell that from "nothing to do". Failing
   * before a session is created costs one retry; failing after costs a session.
   */
  it('refuses a narrative that is missing a required section, and writes nothing', async () => {
    const options = input({ narrative: narrative({ next: '' }) as never })
    const result = await writeHandoff(options)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少必需小节')
    expect(result.error).toContain('4. 下一步')
    expect(options.files.writes).toHaveLength(0)
  })

  it('reports the archive instead of assuming it happened', async () => {
    const files = createMemoryFiles(
      { 'docs/handoff/my-app/HANDOFF.md': '# 交接 —— my-app（v0.1.0 / 2026-10-01 最后验证）\n\n## 1. 目标\n旧目标\n' },
      'D:/work/my-app',
    )
    const result = await writeHandoff(input({ files }))
    expect(result.ok).toBe(true)
    expect(result.archive.archived).toBe(true)
    expect(result.archive.changelogUpdated).toBe(true)
    expect(files.snapshot()['docs/handoff/my-app/CHANGELOG.md']).toContain('旧目标')
  })

  it('leaves the previous document alone when archiving is off', async () => {
    const previous = '# 交接\n\n## 1. 目标\n旧目标\n'
    const files = createMemoryFiles({ 'docs/handoff/my-app/HANDOFF.md': previous }, 'D:/work/my-app')
    const result = await writeHandoff(input({ files, archive: false }))
    expect(result.ok).toBe(true)
    expect(result.archive.archived).toBe(false)
    // Overwritten, not archived: no changelog was created.
    expect(files.snapshot()['docs/handoff/my-app/CHANGELOG.md']).toBeUndefined()
    expect(files.snapshot()['docs/handoff/my-app/HANDOFF.md']).not.toContain('旧目标')
  })

  it('fails the handoff when the document cannot be written', async () => {
    const files = createMemoryFiles({}, 'D:/work/my-app')
    const broken = {
      ...files,
      read: files.read,
      exists: files.exists,
      list: files.list,
      absolute: files.absolute,
      write: async () => {
        throw new Error('EACCES: permission denied')
      },
    }
    const result = await writeHandoff(input({ files: broken }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('EACCES')
    expect(result.error).toContain('原会话未受影响')
  })

  it('archives before writing, so a failed write never consumes the history', async () => {
    const previous = '# 交接\n\n## 1. 目标\n旧目标\n'
    const files = createMemoryFiles({ 'docs/handoff/my-app/HANDOFF.md': previous }, 'D:/work/my-app')
    const order: string[] = []
    const recording = {
      ...files,
      read: files.read,
      exists: files.exists,
      list: files.list,
      absolute: files.absolute,
      write: async (path: string, content: string) => {
        order.push(path)
        if (path.endsWith('HANDOFF.md')) throw new Error('disk full')
        await files.write(path, content)
      },
    }
    const result = await writeHandoff(input({ files: recording }))
    expect(result.ok).toBe(false)
    // The archive landed first: the old document's content is preserved.
    expect(order[0]).toBe('docs/handoff/my-app/history/2026-10.md')
    expect(files.snapshot()['docs/handoff/my-app/CHANGELOG.md']).toContain('旧目标')
  })

  it('reports sections the budget forced out', async () => {
    const long = Array.from({ length: 900 }, (_, i) => `- 事实 ${i} 比较长的当前有效事实描述文字`).join('\n')
    const options = input({ narrative: narrative({ facts: long }) as never, budgetChars: 6_000 })
    const result = await writeHandoff(options)
    expect(result.ok).toBe(true)
    /*
     * The budget is in characters; `bytes` counts UTF-8 bytes, and this
     * document is Chinese (~3 bytes/char). Assert the character count, which is
     * what the setting and `fitToBudget` actually control.
     */
    const text = options.files.snapshot()[result.documentPath]!
    expect(text.length).toBeLessThanOrEqual(6_200)
    expect(result.dropped.length).toBeGreaterThan(0)
  })

  it('carries a pending question into the pointer message', async () => {
    const result = await writeHandoff(
      input({ facts: facts({ pendingInput: { kind: 'question', detail: '要不要改名？' } }) }),
    )
    expect(result.message).toContain('要不要改名？')
  })

  it('honours a non-default root', async () => {
    const result = await writeHandoff(input({ root: 'notes/handoff' }))
    expect(result.documentPath).toBe('notes/handoff/my-app/HANDOFF.md')
  })

  it('uses the archive month from the handoff time', async () => {
    const files = createMemoryFiles(
      { 'docs/handoff/my-app/HANDOFF.md': '# 交接\n\n## 1. 目标\n旧目标\n' },
      'D:/work/my-app',
    )
    await writeHandoff(input({ files }))
    expect(Object.keys(files.snapshot())).toContain('docs/handoff/my-app/history/2026-10.md')
  })
})

describe('previousDocument', () => {
  it('returns the previous document with its month', async () => {
    const files = createMemoryFiles({
      'docs/handoff/my-app/HANDOFF.md': '# 交接 —— my-app（v0.1.0 / 2026-09-01 最后验证）\n',
    })
    const previous = await previousDocument(files, 'docs/handoff', 'my-app', Date.UTC(2026, 9, 31))
    expect(previous?.month).toBe('2026-09')
    expect(previous?.text).toContain('v0.1.0')
  })

  it('returns nothing for a project with no history', async () => {
    expect(await previousDocument(createMemoryFiles({}), 'docs/handoff', 'p', 0)).toBeUndefined()
  })
})

describe('resolveProject', () => {
  it('derives the folder from the workspace when nothing is pinned', () => {
    expect(resolveProject('', 'D:/Workspace/DeepSeek Harness')).toBe('deepseek-harness')
  })

  it('slugifies a pinned name so it is always a safe directory', () => {
    expect(resolveProject('My App v2', 'D:/x/y')).toBe('my-app-v2')
  })

  it('falls back to the workspace when the pin is blank', () => {
    expect(resolveProject('   ', 'D:/x/y')).toBe('y')
  })

  /*
   * The folder name is the only thing telling a reader which project a handoff
   * belongs to. A workspace of many repositories has a name that answers nothing
   * — `deepseek-harness` is a container — so the sub-project the session worked
   * in must win over it.
   */
  it('names the folder after the project the session worked in', () => {
    expect(resolveProject('', 'D:/Workspace/DeepSeek Harness', 'dsh-handoff-doc')).toBe(
      'dsh-handoff-doc',
    )
  })

  it('lets an explicit pin beat the focus, because a pin is a decision', () => {
    expect(resolveProject('my-app', 'D:/w/hub', 'plugin-a')).toBe('my-app')
  })

  it('ignores a blank focus instead of writing a nameless folder', () => {
    expect(resolveProject('', 'D:/w/hub', '   ')).toBe('hub')
    expect(resolveProject('', 'D:/w/hub', undefined)).toBe('hub')
  })
})
