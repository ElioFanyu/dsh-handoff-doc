import { describe, expect, it } from 'vitest'
import { redact, redactWithReport } from '@src/redaction.ts'
import { readPendingInput, renderTranscript, type SessionFacts } from '@src/session-summary.ts'

import {
  DOC_SECTIONS,
  MIN_REQUIRED_FILLED,
  REQUIRED_HEADINGS,
  REQUIRED_SECTIONS,
  buildDocPrompt,
  docPaths,
  documentIsUsable,
  fitToBudget,
  monthOf,
  missingRequired,
  parseDoc,
  projectSlug,
  renderDocument,
  renderPointer,
  validityOf,
  type DocFacts,
} from '@src/handoff-doc.ts'

describe('redact', () => {
  it('removes provider tokens', () => {
    expect(redact('key is sk-abcdefghijklmnopqrstuvwx now')).toBe('key is [redacted: token] now')
    expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe('[redacted: token]')
    expect(redact('glpat-abcdefghijklmnopqrst')).toBe('[redacted: token]')
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted: token]')
  })

  it('removes a private key block as one unit', () => {
    const text = [
      'before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA...',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ].join('\n')
    const out = redact(text)
    expect(out).not.toContain('MIIEowIBAAKCAQEA')
    expect(out).toContain('[redacted: private key]')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('keeps the scheme and masks the password in a connection string', () => {
    expect(redact('postgres://admin:hunter2secret@db.local:5432/app')).toBe(
      'postgres://admin:[redacted]@db.local:5432/app',
    )
  })

  it('masks secret-looking environment assignments', () => {
    expect(redact('OPENAI_API_KEY=sk-live-verysecretvalue')).toBe('OPENAI_API_KEY=[redacted]')
    expect(redact('DB_PASSWORD: "correct horse battery"')).toBe('DB_PASSWORD=[redacted]')
    expect(redact('GITHUB_TOKEN=gh_whatever_long_enough')).toBe('GITHUB_TOKEN=[redacted]')
  })

  it('leaves ordinary prose, paths and code alone', () => {
    const text =
      'Next I will add src/session-handoff/trigger.ts and run npm test. The token counter is in measure.ts, key idea: watermark.'
    expect(redact(text)).toBe(text)
  })

  it('masks authorization headers but keeps the scheme', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe(
      'Authorization: Bearer [redacted]',
    )
  })

  it('masks jwts and long hex/base64 blobs', () => {
    expect(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop')).toBe(
      '[redacted: jwt]',
    )
    expect(redact('a'.repeat(32) + '0f'.repeat(16))).toContain('[redacted')
  })

  it('reports which rules fired', () => {
    const report = redactWithReport('sk-abcdefghijklmnopqrstuvwx and plain text')
    expect(report.applied).toContain('known-token-prefix')
    expect(report.text).not.toContain('sk-abcdef')
  })

  it('is idempotent enough to re-run without corrupting output', () => {
    const once = redact('token: sk-abcdefghijklmnopqrstuvwx')
    expect(redact(once)).toBe(once)
  })
})

/** A complete, usable narrative, so each test can vary exactly one section. */
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
    verified: 'npm test 261 ✓（2026-10-31）',
    history: '- 见 CHANGELOG.md',
  }
  return { ...base, ...overrides }
}

function facts(overrides: Partial<DocFacts> = {}): DocFacts {
  return {
    project: 'my-app',
    cwd: 'D:/work/my-app',
    commands: [
      { command: 'npm run check', origin: 'package.json#scripts.check', proves: '全部检查通过' },
      { command: 'npm test', origin: 'package.json#scripts.test', proves: '测试全绿' },
    ],
    stack: ['Node', 'TypeScript'],
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
    createdAt: Date.UTC(2026, 9, 27, 12, 0, 0),
    ...overrides,
  }
}

describe('parseDoc', () => {
  it('splits the ten sections the prompt asks for', () => {
    const raw = DOC_SECTIONS.map((section) => `${section.heading}\n内容-${section.key}`).join('\n\n')
    const parsed = parseDoc(raw)
    for (const section of DOC_SECTIONS) expect(parsed[section.key]).toBe(`内容-${section.key}`)
  })

  it('tolerates bold headings, extra hashes and trailing colons', () => {
    const parsed = parseDoc('**1. 目标与验收**：做一个插件\n\n### 4. 下一步 + 验证映射\n先读文档')
    expect(parsed.goal).toBe('做一个插件')
    expect(parsed.next).toBe('先读文档')
  })

  it('matches on the section number when the title was reworded', () => {
    const parsed = parseDoc('## 2. 现在的架构\n只写仍然成立的')
    expect(parsed.facts).toBe('只写仍然成立的')
  })

  it('keeps an unknown subheading inside the current section instead of dropping it', () => {
    const parsed = parseDoc('## 1. 目标与验收\n目标\n### 子标题\n细节')
    expect(parsed.goal).toContain('细节')
  })

  it('drops prose before the first heading rather than mislabelling it', () => {
    const parsed = parseDoc('前言不该出现\n## 1. 目标与验收\n真正的目标')
    expect(parsed.goal).toBe('真正的目标')
    expect(parsed.selfcheck).toBeUndefined()
  })
})

describe('documentIsUsable', () => {
  it('rejects a document missing any required section', () => {
    const parsed = parseDoc('## 1. 目标与验收\n只有目标')
    const verdict = documentIsUsable(parsed)
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toContain('selfcheck')
    expect(verdict.missing).toContain('next')
  })

  it('accepts a document with every required section filled', () => {
    const parsed = parseDoc(
      DOC_SECTIONS.map((section) => `${section.heading}\n内容-${section.key}`).join('\n\n'),
    )
    expect(documentIsUsable(parsed).ok).toBe(true)
    expect(missingRequired(parsed)).toHaveLength(0)
  })

  /*
   * The old design accepted 3 of 9 sections. This one does not, deliberately:
   * a document missing §2 or §4 leaves the successor with nothing to act on,
   * and it cannot tell the difference between "nothing to say" and "the model
   * skipped it". The count is asserted so lowering it is a visible decision.
   */
  it('requires every section marked required, not a sample', () => {
    expect(MIN_REQUIRED_FILLED).toBe(REQUIRED_SECTIONS.length)
    expect(REQUIRED_SECTIONS).toContain('selfcheck')
    expect(REQUIRED_SECTIONS).toContain('next')
  })

  it('treats a whitespace-only section as missing', () => {
    const parsed = parseDoc(`## 0. 30 秒自检\n   \n## 1. 目标与验收\n目标`)
    expect(missingRequired(parsed)).toContain('selfcheck')
  })
})

describe('buildDocPrompt', () => {
  it('names every section and states the negative rules', () => {
    const prompt = buildDocPrompt({ facts: facts(), transcript: '记录', budgetChars: 24_000 })
    for (const section of DOC_SECTIONS) expect(prompt).toContain(section.heading)
    expect(prompt).toContain('只写现在仍然成立的事实')
    expect(prompt).toContain('本文件是快照，不是日志')
    expect(prompt).toContain('不写行号')
    expect(prompt).toContain('不编造验证结果')
    expect(prompt).toContain('不写密钥、令牌、密码、连接串的值')
  })

  it('tells the model to finish the required sections before the optional ones', () => {
    /*
     * Regression guard for a real, repeatable failure: a model writing
     * top-to-bottom spent its length on §0–§3, reached §4 with nothing left,
     * and the handoff was refused for a missing required section — the
     * successor never got a session at all. The prompt must state the order.
     */
    const prompt = buildDocPrompt({ facts: facts(), transcript: '记录', budgetChars: 24_000 })
    expect(prompt).toContain('先写必需小节')
    // Every required section must be named, derived from the same list the
    // validator uses so the two cannot drift.
    for (const heading of REQUIRED_HEADINGS) expect(prompt).toContain(heading)
    expect(prompt).toContain('整份交接会被拒绝')
  })

  it('shows the commands found on disk so the model does not invent them', () => {
    const prompt = buildDocPrompt({ facts: facts(), transcript: '记录', budgetChars: 24_000 })
    expect(prompt).toContain('`npm run check`（来自 package.json#scripts.check）')
    expect(prompt).toContain('证明：全部检查通过')
  })

  it('says so plainly when no command was found', () => {
    const prompt = buildDocPrompt({
      facts: facts({ commands: [] }),
      transcript: '记录',
      budgetChars: 24_000,
    })
    expect(prompt).toContain('没有发现可识别的验证命令')
  })

  it('includes the previous document and tells the model to prune it', () => {
    const prompt = buildDocPrompt({
      facts: facts(),
      transcript: '记录',
      previous: { text: '## 2. 当前有效事实\n旧事实', month: '2026-10' },
      budgetChars: 24_000,
    })
    expect(prompt).toContain('旧事实')
    expect(prompt).toContain('不要把它的历史部分抄进来')
  })

  it('carries the transcript, so the model is not asked to guess', () => {
    const prompt = buildDocPrompt({ facts: facts(), transcript: '[用户] 做一个交接插件', budgetChars: 24_000 })
    expect(prompt).toContain('[用户] 做一个交接插件')
  })

  it('states the character budget in thousands', () => {
    const prompt = buildDocPrompt({ facts: facts(), transcript: '记录', budgetChars: 24_000 })
    expect(prompt).toContain('约 24 千字符')
  })
})

describe('renderDocument', () => {
  it('renders the header, the validity line and all ten sections', () => {
    const { text } = renderDocument({
      facts: facts(),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'docs/handoff/my-app/CHANGELOG.md',
    })
    expect(text).toContain('# 交接 —— my-app（v0.2.0 / 2026-10-27 最后验证）')
    expect(text).toContain('> 有效期：')
    expect(text).toContain('HEAD abcdef12')
    for (const section of DOC_SECTIONS) expect(text).toContain(section.heading)
  })

  it('puts the program-read commands in §0 after the model supplement', () => {
    const { text } = renderDocument({
      facts: facts(),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    const selfcheck = text.slice(text.indexOf('## 0. 30 秒自检'), text.indexOf('## 1. 目标与验收'))
    expect(selfcheck).toContain('- 命令：`npm run check`')
    expect(selfcheck).toContain('- 环境：Node / TypeScript')
    expect(selfcheck).toContain('main @ abcdef12（工作区干净）')
    expect(selfcheck).toContain('### 命令与环境（程序读取）')
    /*
     * The model's supplement comes first: it is asked only for what the program
     * cannot read (ports, expected numbers), so its prose is the part a reader
     * needs before the command list they could get from package.json.
     */
    expect(selfcheck.indexOf('25 ✓')).toBeLessThan(selfcheck.indexOf('### 命令与环境'))
  })

  it('renders the verification matrix in §4 from the discovered commands', () => {
    const { text } = renderDocument({
      facts: facts(),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('### 验证映射')
    // A single-project workspace has one scope, so the matrix stays flat and
    // leads with the command: there is no "which change" to distinguish.
    expect(text).toContain('改动后必跑：')
    expect(text).toContain('`npm run check` → 全部检查通过')
    expect(text).toContain('离线可跑：`npm run check`、`npm test`')
  })

  it('groups the matrix by package when the workspace has sub-projects', () => {
    const { text } = renderDocument({
      facts: facts({
        commands: [
          { command: 'cd a && npm run check', origin: 'a/package.json#scripts.check', proves: '全部检查通过' },
          { command: 'cd b && npm run check', origin: 'b/package.json#scripts.check', proves: '全部检查通过' },
        ],
      }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    // The left column must answer "I changed a/b — what do I run?", which is
    // what the heading promises. Identical `proves` text alone cannot.
    expect(text).toContain('改动范围 → 必跑：')
    expect(text).toContain('**a**')
    expect(text).toContain('**b**')
    expect(text).toContain('`cd a && npm run check` → 全部检查通过')
  })

  /*
   * The document is for this session's successor, not for every project that
   * happens to sit beside it. When the log says which one was worked in, §0
   * must lead with that project's command and say plainly that the others were
   * not part of this handoff.
   */
  it('leads §0 with the project the session worked in', () => {
    const { text } = renderDocument({
      facts: facts({
        commands: [
          { command: 'cd b && npm run check', origin: 'b/package.json#scripts.check', proves: '全部检查通过' },
          { command: 'cd a && npm run check', origin: 'a/package.json#scripts.check', proves: '全部检查通过' },
        ],
        scope: [
          { directory: 'a', calls: 9, totalCalls: 12, focus: true },
          { directory: 'b', calls: 1, totalCalls: 12, focus: false },
        ],
      }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    const selfcheck = text.slice(text.indexOf('## 0. 30 秒自检'), text.indexOf('## 1. 目标与验收'))
    /*
     * §0 is a list of things to run *first*, so a project the session glanced
     * at once must not take a line there — that is the defect this change
     * exists to fix. It stays in §4's matrix, where the full map belongs.
     */
    expect(selfcheck).toContain('`cd a && npm run check`')
    expect(selfcheck).not.toContain('`cd b && npm run check`')
    expect(selfcheck).toContain('本次未涉及：`b`（1/12 次工具调用）')
    expect(text.slice(text.indexOf('## 4.'))).toContain('`cd b && npm run check`')
  })

  it('gives §0 two lines when the change really spans two projects', () => {
    const { text } = renderDocument({
      facts: facts({
        commands: [
          { command: 'cd a && npm run check', origin: 'a/package.json#scripts.check', proves: '全部检查通过' },
          { command: 'cd b && npm run check', origin: 'b/package.json#scripts.check', proves: '全部检查通过' },
        ],
        scope: [
          { directory: 'a', calls: 9, totalCalls: 12, focus: true },
          { directory: 'b', calls: 7, totalCalls: 12, focus: false },
        ],
      }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    const selfcheck = text.slice(text.indexOf('## 0. 30 秒自检'), text.indexOf('## 1. 目标与验收'))
    // Both were worked in, so both are §0's business; order still leads with
    // the one that got more attention.
    expect(selfcheck).toContain('`cd a && npm run check`')
    expect(selfcheck).toContain('`cd b && npm run check`')
    expect(selfcheck.indexOf('cd a && npm run check')).toBeLessThan(
      selfcheck.indexOf('cd b && npm run check'),
    )
    expect(selfcheck).not.toContain('本次未涉及')
  })

  it('puts the worked-in project first in the §4 matrix', () => {
    const { text } = renderDocument({
      facts: facts({
        commands: [
          { command: 'cd b && npm run check', origin: 'b/package.json#scripts.check', proves: '全部检查通过' },
          { command: 'cd a && npm run check', origin: 'a/package.json#scripts.check', proves: '全部检查通过' },
        ],
        scope: [
          { directory: 'a', calls: 9, totalCalls: 12, focus: true },
          { directory: 'b', calls: 1, totalCalls: 12, focus: false },
        ],
      }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('**a**（本次工作范围）')
    expect(text.indexOf('**a**')).toBeLessThan(text.indexOf('**b**'))
  })

  it('keeps both commands even when one project was never touched', () => {
    const { text } = renderDocument({
      facts: facts({
        commands: [
          { command: 'cd a && npm run check', origin: 'a/package.json#scripts.check', proves: '全部检查通过' },
          { command: 'cd b && npm run check', origin: 'b/package.json#scripts.check', proves: '全部检查通过' },
        ],
        scope: [
          { directory: 'a', calls: 9, totalCalls: 12, focus: true },
          { directory: 'b', calls: 0, totalCalls: 12, focus: false },
        ],
      }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    // A change that spans two projects must still tell the successor to verify
    // both; demoting is not deleting.
    expect(text).toContain('`cd b && npm run check`')
  })

  it('says nothing about scope when the log named no project', () => {
    const { text } = renderDocument({
      facts: facts({
        commands: [
          { command: 'cd a && npm run check', origin: 'a/package.json#scripts.check', proves: '全部检查通过' },
          { command: 'cd b && npm run check', origin: 'b/package.json#scripts.check', proves: '全部检查通过' },
        ],
        scope: [],
      }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).not.toContain('本次未涉及')
    expect(text).not.toContain('本次工作范围')
  })

  it('writes the archive pointer into §9 and no history content', () => {
    const { text } = renderDocument({
      facts: facts(),
      narrative: narrative({ history: '（模型试图写历史）我们上周改成了新架构' }) as never,
      version: 'v0.2.0',
      archivePointer: 'docs/handoff/my-app/CHANGELOG.md',
    })
    const history = text.slice(text.indexOf('## 9. 历史'))
    expect(history).toContain('docs/handoff/my-app/CHANGELOG.md')
    expect(history).not.toContain('我们上周改成了新架构')
  })

  it('falls back to an honest placeholder instead of dropping an empty section', () => {
    const { text } = renderDocument({
      facts: facts(),
      narrative: narrative({ blockers: '' }) as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('## 3. 卡点与阻塞\n\n无')
  })

  it('redacts narrative bodies and says how many rules fired', () => {
    const { text, redactions } = renderDocument({
      facts: facts(),
      narrative: narrative({ facts: '密钥是 sk-abcdefghijklmnopqrstuvwx' }) as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).not.toContain('sk-abcdefghijklmnop')
    expect(redactions.length).toBeGreaterThan(0)
    expect(text).toContain('已替换')
  })

  it('reports a failed permission read with its reason, not a bare unknown', () => {
    const { text } = renderDocument({
      facts: facts({ permissionPreset: undefined, permissionError: 'snapshotEvents is not a function' }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('权限=读取失败（snapshotEvents is not a function）')
  })

  it('says the occupancy is unmeasurable instead of claiming zero percent', () => {
    const { text } = renderDocument({
      facts: facts({ occupancyPercent: undefined, occupancyQuality: 'unavailable' }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('交接时上下文占用=不可用（模型未上报窗口）')
  })

  it('carries a program-detected pending question as a fact', () => {
    const { text } = renderDocument({
      facts: facts({ pendingInput: { kind: 'question', detail: '要不要改名？' } }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('未答复提问：要不要改名？')
  })

  it('keeps the weaker pending case conditional', () => {
    const { text } = renderDocument({
      facts: facts({ pendingInput: { kind: 'unanswered-assistant' } }),
      narrative: narrative() as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    })
    expect(text).toContain('可能仍在等用户回话')
  })
})

describe('validityOf', () => {
  it('keys validity on HEAD when the project is a git work tree', () => {
    expect(validityOf(facts())).toContain('到下一次提交为止')
    expect(validityOf(facts())).toContain('HEAD 变化即失效')
  })

  it('falls back to a functional-change window without git', () => {
    const noGit: DocFacts = { ...facts() }
    delete (noGit as { git?: unknown }).git
    expect(validityOf(noGit)).toContain('到下一次功能变更 / 发版为止')
  })
})

describe('projectSlug', () => {
  it('uses the last path segment', () => {
    expect(projectSlug('D:/Workspace/DeepSeek Harness')).toBe('deepseek-harness')
    expect(projectSlug('/home/me/my_app.v2')).toBe('my_app.v2')
  })

  it('falls back to a usable name instead of an empty folder', () => {
    expect(projectSlug(undefined)).toBe('workspace')
    expect(projectSlug('/')).toBe('workspace')
    expect(projectSlug('D:\\')).toBe('workspace')
  })

  it('keeps non-latin names readable', () => {
    expect(projectSlug('/work/拾光')).toBe('拾光')
  })
})

describe('docPaths', () => {
  it('nests the project folder under the configured root', () => {
    const paths = docPaths('docs/handoff', 'my-app')
    expect(paths.document).toBe('docs/handoff/my-app/HANDOFF.md')
    expect(paths.changelog).toBe('docs/handoff/my-app/CHANGELOG.md')
    expect(paths.historyOf('2026-10')).toBe('docs/handoff/my-app/history/2026-10.md')
  })

  it('normalises leading and trailing slashes', () => {
    expect(docPaths('/docs/handoff/', 'p').document).toBe('docs/handoff/p/HANDOFF.md')
  })
})

describe('monthOf', () => {
  it('uses the UTC month of the timestamp', () => {
    expect(monthOf(Date.UTC(2026, 9, 27))).toBe('2026-10')
  })
})

describe('fitToBudget', () => {
  /** ~30k characters: large enough that every budget in this block bites. */
  function longDocument(): string {
    return renderDocument({
      facts: facts(),
      narrative: narrative({
        facts: Array.from({ length: 1200 }, (_, i) => `- 事实 ${i} 这是一条比较长的当前有效事实描述`).join('\n'),
        rejected: '试过 X，失败，别再试',
      }) as never,
      version: 'v0.2.0',
      archivePointer: 'CHANGELOG.md',
    }).text
  }

  it('leaves a document that already fits untouched', () => {
    const text = 'short'
    expect(fitToBudget(text, 100)).toEqual({ text, dropped: [] })
  })

  it('drops whole optional sections before touching required ones', () => {
    const text = longDocument()
    expect(text.length).toBeGreaterThan(20_000)
    const result = fitToBudget(text, 12_000)
    expect(result.text.length).toBeLessThanOrEqual(12_000)
    expect(result.dropped).toContain('7. 已否决方案 + 原因')
    // Required sections survive, heading and all.
    expect(result.text).toContain('## 2. 当前有效事实')
    expect(result.text).toContain('## 4. 下一步 + 验证映射')
  })

  it('records what it dropped so a truncated document never looks complete', () => {
    const result = fitToBudget(longDocument(), 12_000)
    expect(result.text).toContain('为控制在预算内，已省略')
  })

  it('shrinks bodies rather than deleting required sections when still too long', () => {
    const result = fitToBudget(longDocument(), 4_000)
    expect(result.text.length).toBeLessThanOrEqual(4_200)
    for (const key of REQUIRED_SECTIONS) {
      const section = DOC_SECTIONS.find((entry) => entry.key === key)!
      expect(result.text).toContain(section.heading)
    }
  })
})

describe('renderPointer', () => {
  it('names the file and the reading order instead of pasting the content', () => {
    const message = renderPointer({
      documentPath: 'docs/handoff/my-app/HANDOFF.md',
      absolutePath: 'D:/work/my-app/docs/handoff/my-app/HANDOFF.md',
      project: 'my-app',
      validUntil: '到下一次提交为止',
      commands: [{ command: 'npm run check', origin: 'package.json', proves: '全部检查通过' }],
    })
    expect(message).toContain('docs/handoff/my-app/HANDOFF.md')
    expect(message).toContain('D:/work/my-app/docs/handoff/my-app/HANDOFF.md')
    expect(message).toContain('只读 §0「30 秒自检」')
    expect(message).toContain('不要继续读')
    expect(message).toContain('`npm run check` → 全部检查通过')
  })

  it('carries the user instruction beside the pointer, last and explicitly ranked', () => {
    /*
     * The instruction must reach the successor without entering the document.
     * It also has to outrank §4 when the two disagree, otherwise the human's
     * sentence silently loses to the plan the model wrote.
     */
    const message = renderPointer({
      documentPath: 'docs/handoff/my-app/HANDOFF.md',
      absolutePath: 'D:/work/my-app/docs/handoff/my-app/HANDOFF.md',
      project: 'my-app',
      validUntil: '到下一次提交为止',
      commands: [{ command: 'npm run check', origin: 'package.json', proves: '全部检查通过' }],
      instruction: '做完之后推送 GitHub',
    })
    expect(message).toContain('做完之后推送 GitHub')
    expect(message).toContain('优先级高于 §4')
    // Still a pointer: the instruction must not multiply the message size.
    expect(message.length).toBeLessThan(1500)
  })

  it('omits the instruction block entirely when there is no instruction', () => {
    const message = renderPointer({
      documentPath: 'docs/handoff/p/HANDOFF.md',
      absolutePath: '/w/docs/handoff/p/HANDOFF.md',
      project: 'p',
      validUntil: 'v',
      commands: [],
    })
    expect(message).not.toContain('用户的附言')
  })

  it('stays short: a pointer that repeats the document defeats the design', () => {
    const message = renderPointer({
      documentPath: 'docs/handoff/p/HANDOFF.md',
      absolutePath: '/w/docs/handoff/p/HANDOFF.md',
      project: 'p',
      validUntil: '到下一次提交为止',
      commands: [],
    })
    expect(message.length).toBeLessThan(1_600)
  })

  it('carries the do-not-decide clause when a question is pending', () => {
    const message = renderPointer({
      documentPath: 'docs/handoff/p/HANDOFF.md',
      absolutePath: '/w/docs/handoff/p/HANDOFF.md',
      project: 'p',
      validUntil: 'x',
      commands: [],
      pendingInput: { kind: 'question', detail: '要不要改名？' },
    })
    expect(message).toContain('要不要改名？')
    expect(message).toContain('先向用户确认，不要自行决定')
  })
})

describe('renderTranscript', () => {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      data: { message: { role: 'user', content: [{ type: 'text', text: '做一个交接插件' }] } },
    },
    {
      type: 'assistant/message',
      seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '先看现状' }] } },
    },
    { type: 'tool/call', seq: 3, data: { name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'text', text: 'a b c' }] } } },
    { type: 'turn/start', seq: 5, data: {} },
  ]

  it('renders the conversation, not just metadata', () => {
    const text = renderTranscript(events)
    expect(text).toContain('[用户] 做一个交接插件')
    expect(text).toContain('[助手] 先看现状')
    expect(text).toContain('[工具 bash]')
  })

  it('drops events that carry no readable content', () => {
    expect(renderTranscript(events)).not.toContain('turn/start')
  })

  it('keeps the most recent lines when over budget', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: 'user/message',
      seq: i + 1,
      data: { message: { role: 'user', content: [{ type: 'text', text: '消息' + i + 'x'.repeat(60) }] } },
    }))
    const text = renderTranscript(many, 800)
    expect(text).toContain('消息59')
    expect(text).toContain('省略较早的')
    expect(text).not.toContain('消息0x')
  })

  it('says so when there is nothing to render', () => {
    expect(renderTranscript(undefined)).toContain('没有可读的对话记录')
  })

  it('reaches the prompt so the model is not asked to guess', () => {
    const prompt = buildDocPrompt({
      facts: facts(),
      transcript: renderTranscript(events),
      budgetChars: 24_000,
    })
    expect(prompt).toContain('[用户] 做一个交接插件')
    expect(prompt).toContain('不要用「未知」糊弄')
  })
})

/*
 * "Waiting for the user" has no home in the document skeleton either, so it is
 * detected instead of described. The raw `userQuestions` state shape is copied
 * from `dsh-user-questions/lib/index.js`: the view lives under
 * `state.questions`; each active entry is `{ callId, questions: [{ question, … }], state }`.
 * Asking `stateOf()` for it returns the RAW state — never the wire view.
 */
describe('readPendingInput — is the outgoing session still waiting?', () => {
  const anySession = { id: 's1' } as never

  function projectionsWith(state: unknown) {
    return {
      stateOf: () => state,
    } as never
  }

  it('reports an unanswered ask_user_question as a certain fact', () => {
    const pending = readPendingInput(
      anySession,
      projectionsWith({
        questions: { active: [{ callId: 'c1', questions: [{ question: '要不要改名？' }] }], settled: [] },
      }),
    )
    expect(pending).toEqual({ kind: 'question', detail: '要不要改名？' })
  })

  it('joins at most three outstanding questions', () => {
    const pending = readPendingInput(
      anySession,
      projectionsWith({
        questions: {
          active: [
            { questions: [{ question: 'a' }, { question: 'b' }] },
            { questions: [{ question: 'c' }, { question: 'd' }] },
          ],
        },
      }),
    )
    expect(pending?.detail).toBe('a / b / c')
  })

  it('falls back to the event log when the projection is absent', () => {
    const pending = readPendingInput(anySession, undefined, [
      { type: 'user/message', seq: 1 },
      { type: 'assistant/message', seq: 2 },
    ] as never)
    expect(pending).toEqual({ kind: 'unanswered-assistant' })
  })

  it('says nothing when the user spoke last', () => {
    expect(
      readPendingInput(anySession, undefined, [
        { type: 'assistant/message', seq: 1 },
        { type: 'user/message', seq: 2 },
      ] as never),
    ).toBeUndefined()
  })

  it('says nothing when a tool result closed the exchange', () => {
    expect(
      readPendingInput(anySession, undefined, [
        { type: 'assistant/message', seq: 1 },
        { type: 'tool/result', seq: 2 },
      ] as never),
    ).toBeUndefined()
  })

  it('degrades to the event check when the projection throws', () => {
    const throwing = {
      stateOf: () => {
        throw new Error('no such unit')
      },
    } as never
    expect(readPendingInput(anySession, throwing, [{ type: 'assistant/message', seq: 1 }] as never)).toEqual({
      kind: 'unanswered-assistant',
    })
  })

  it('ignores a malformed state instead of throwing', () => {
    expect(readPendingInput(anySession, projectionsWith({ questions: 'nope' }), [])).toBeUndefined()
    expect(readPendingInput(anySession, projectionsWith({ questions: { active: 'nope' } }), [])).toBeUndefined()
    expect(readPendingInput(anySession, projectionsWith(null), [])).toBeUndefined()
  })
})

/** A sanity check that the old `SessionFacts` shape still compiles where used. */
const _factsShape: SessionFacts | undefined = undefined
void _factsShape
