import { describe, expect, it } from 'vitest'
import {
  archivePrevious,
  hashOf,
  insertEntry,
  readPrevious,
  renderChangelogEntry,
  splitSections,
} from '@src/archive.ts'
import { createMemoryFiles } from '@src/workspace-fs.ts'

const DOC = 'docs/handoff/my-app/HANDOFF.md'
const CHANGELOG = 'docs/handoff/my-app/CHANGELOG.md'
const HISTORY = 'docs/handoff/my-app/history/2026-10.md'

/** A previous document with every section the archiver reads. */
function previousDocument(overrides: Record<string, string> = {}): string {
  const body: Record<string, string> = {
    '0': '- 命令：`npm run check` — 预期：25 ✓ / 82 ✓ / 0 失败',
    '1': '做完插件',
    '2': '插件行由 profile package.json 的 bundles 列表加载',
    '3': '无',
    '4': '改 §0 的自检命令 → 跑 npm test',
    '5': '不改 profile 目录',
    '6': 'src/handoff-doc.ts → 文档骨架',
    '7': '曾按消息投递简报，已否决：无法归档',
    '8': 'npm test 261 ✓',
    '9': '- 见 CHANGELOG.md',
    ...overrides,
  }
  return [
    '# 交接 —— my-app（v0.2.0 / 2026-10-27 最后验证）',
    '',
    ...Object.entries(body).flatMap(([number, text]) => [`## ${number}. 标题${number}`, '', text, '']),
  ].join('\n')
}

function archiveInput(files: ReturnType<typeof createMemoryFiles>, overrides: Record<string, unknown> = {}) {
  return {
    files,
    documentPath: DOC,
    changelogPath: CHANGELOG,
    historyPath: HISTORY,
    at: '2026-10-31T02:00:00.000Z',
    reason: '上下文占用 85% / 已完成 40 turn',
    sourceSessionId: 'session-old',
    ...overrides,
  }
}

describe('splitSections', () => {
  it('keys sections by number and by semantic name', () => {
    const sections = splitSections(previousDocument())
    expect(sections.get('1')).toContain('做完插件')
    expect(sections.get('goal')).toContain('做完插件')
    expect(sections.get('next')).toContain('改 §0')
    expect(sections.get('rejected')).toContain('已否决')
  })

  it('returns text before the first heading as the preamble', () => {
    const sections = splitSections('前言\n## 1. 目标\n目标正文')
    expect(sections.get('preamble')).toBe('前言')
  })

  it('ignores an empty section rather than recording a blank', () => {
    const sections = splitSections('## 1. 目标\n\n## 2. 事实\n有内容')
    expect(sections.has('1')).toBe(false)
    expect(sections.get('facts')).toBe('有内容')
  })
})

describe('renderChangelogEntry', () => {
  it('summarises the goal, the superseded next step, and the durable decisions', () => {
    const entry = renderChangelogEntry({
      previous: previousDocument(),
      at: '2026-10-31T02:00:00.000Z',
      reason: '上下文占用 85%',
      sourceSessionId: 'session-old',
      hash: 'abc123',
    })
    expect(entry).toContain('## 2026-10-31 — 上下文占用 85%')
    expect(entry).toContain('做完插件')
    expect(entry).toContain('改 §0 的自检命令')
    expect(entry).toContain('npm test 261 ✓')
    expect(entry).toContain('已否决方案')
    expect(entry).toContain('content:abc123')
    expect(entry).toContain('history/2026-10.md')
  })

  /*
   * §2 is excluded on purpose: it is the largest section and the least stable,
   * and the new document restates it. Including it is how the changelog becomes
   * a second copy of the handoff file.
   */
  it('does not copy §2 (current facts) into the small file', () => {
    const entry = renderChangelogEntry({
      previous: previousDocument(),
      at: '2026-10-31T02:00:00.000Z',
      reason: 'r',
      sourceSessionId: 's',
      hash: 'h',
    })
    expect(entry).not.toContain('插件行由 profile package.json 的 bundles 列表加载')
  })

  it('omits a carry-over block that was empty instead of printing a stub', () => {
    const entry = renderChangelogEntry({
      previous: previousDocument({ '3': '', '7': '', '5': '', '8': '' }),
      at: '2026-10-31T02:00:00.000Z',
      reason: 'r',
      sourceSessionId: 's',
      hash: 'h',
    })
    expect(entry).not.toContain('当时的卡点')
    expect(entry).not.toContain('已否决方案')
  })

  it('says so when the previous document had no goal, rather than inventing one', () => {
    const entry = renderChangelogEntry({
      previous: '## 1. 目标\n（未提供）',
      at: '2026-10-31T02:00:00.000Z',
      reason: 'r',
      sourceSessionId: 's',
      hash: 'h',
    })
    expect(entry).toContain('（上一版没有写目标）')
  })
})

describe('insertEntry', () => {
  it('puts the newest entry directly under the preamble', () => {
    const changelog = '# CHANGELOG\n\n> 说明\n\n## 2026-10-01 — 旧\n\n旧内容\n'
    const result = insertEntry(changelog, '## 2026-10-31 — 新\n\n新内容\n')
    expect(result.indexOf('2026-10-31')).toBeLessThan(result.indexOf('2026-10-01'))
    expect(result).toContain('> 说明')
  })

  it('appends when the file has no entries yet', () => {
    expect(insertEntry('# CHANGELOG\n', '## e\n')).toContain('## e')
  })

  it('keeps a hand-edited structure intact', () => {
    const changelog = '# CHANGELOG\n\n手工写的说明\n\n## 2026-09-01 — 九月\n'
    const result = insertEntry(changelog, '## 2026-10-31 — 十月\n')
    expect(result).toContain('手工写的说明')
    expect(result.indexOf('十月')).toBeLessThan(result.indexOf('九月'))
  })
})

describe('archivePrevious', () => {
  it('does nothing on the first handoff of a project', async () => {
    const files = createMemoryFiles({})
    const result = await archivePrevious(archiveInput(files))
    expect(result.archived).toBe(false)
    expect(files.writes).toHaveLength(0)
  })

  it('writes the summary to CHANGELOG and the full text to the monthly history', async () => {
    const files = createMemoryFiles({ [DOC]: previousDocument() })
    const result = await archivePrevious(archiveInput(files))
    expect(result.archived).toBe(true)
    expect(result.changelogUpdated).toBe(true)
    expect(result.historyUpdated).toBe(true)

    const changelog = files.snapshot()[CHANGELOG]!
    const history = files.snapshot()[HISTORY]!
    expect(changelog).toContain('做完插件')
    expect(changelog).toContain('交接归档')
    // The full text lives in history, fenced so it cannot break the file.
    expect(history).toContain('````markdown')
    expect(history).toContain('## 2. 标题2')
    expect(history).toContain('session-old')
  })

  /*
   * A retried handoff must not produce a second identical entry: that teaches
   * the reader to ignore the file, which is the same failure as not writing it.
   */
  it('is idempotent by content hash, so a retry adds nothing', async () => {
    const files = createMemoryFiles({ [DOC]: previousDocument() })
    await archivePrevious(archiveInput(files))
    const writesAfterFirst = files.writes.length
    const second = await archivePrevious(archiveInput(files))
    expect(second.skippedDuplicate).toBe(true)
    expect(second.archived).toBe(false)
    expect(files.writes.length).toBe(writesAfterFirst)
  })

  it('does not re-archive a document whose hash is already recorded', async () => {
    const doc = previousDocument()
    const files = createMemoryFiles({
      [DOC]: doc,
      [CHANGELOG]: `# CHANGELOG\n\n## 2026-10-30 — 早先\n\n- 内容指纹：content:${hashOf(doc)}\n`,
    })
    const result = await archivePrevious(archiveInput(files))
    expect(result.skippedDuplicate).toBe(true)
    expect(files.writes).toHaveLength(0)
  })

  it('appends a second archive to the same month instead of replacing it', async () => {
    const files = createMemoryFiles({ [DOC]: previousDocument() })
    await archivePrevious(archiveInput(files))
    await files.write(DOC, previousDocument({ '1': '第二个目标' }))
    await archivePrevious(archiveInput(files, { at: '2026-10-31T05:00:00.000Z' }))

    const history = files.snapshot()[HISTORY]!
    expect(history).toContain('做完插件')
    expect(history).toContain('第二个目标')
    expect(history.split('## 2026-10-31').length - 1).toBe(2)
  })

  it('reports a changelog write failure as a warning instead of throwing', async () => {
    const failing = createMemoryFiles({ [DOC]: previousDocument() })
    const broken = {
      ...failing,
      read: failing.read,
      exists: failing.exists,
      list: failing.list,
      absolute: failing.absolute,
      write: async (path: string, content: string) => {
        if (path === CHANGELOG) throw new Error('EACCES')
        await failing.write(path, content)
      },
    }
    const result = await archivePrevious(archiveInput(broken))
    expect(result.changelogUpdated).toBe(false)
    // The history file still received the full text, so nothing is lost.
    expect(result.historyUpdated).toBe(true)
    expect(result.warnings.join(' ')).toContain('CHANGELOG')
  })
})

describe('readPrevious', () => {
  it('returns nothing when there is no previous document', async () => {
    expect(await readPrevious(createMemoryFiles({}), DOC, '2026-10')).toBeUndefined()
  })

  it('takes the month from the document header, not from the archive time', async () => {
    const files = createMemoryFiles({
      [DOC]: '# 交接 —— my-app（v0.2.0 / 2026-09-28 最后验证）\n\n> 有效期：x\n',
    })
    const previous = await readPrevious(files, DOC, '2026-10')
    expect(previous?.month).toBe('2026-09')
  })

  it('falls back to the given month when the header has no date', async () => {
    const files = createMemoryFiles({ [DOC]: '# 交接\n\n没有日期' })
    expect((await readPrevious(files, DOC, '2026-10'))?.month).toBe('2026-10')
  })
})

describe('hashOf', () => {
  it('is stable and short enough to read', () => {
    expect(hashOf('abc')).toBe(hashOf('abc'))
    expect(hashOf('abc')).not.toBe(hashOf('abd'))
    expect(hashOf('abc')).toHaveLength(16)
  })
})
