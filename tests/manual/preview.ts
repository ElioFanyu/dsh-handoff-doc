/**
 * Produce a realistic handoff document on disk, for visual review.
 *
 * Not a test: this exists so the rendered output can be read as a human would
 * read it, which is the one thing assertions cannot check. Run with
 * `npx vitest run tests/manual/preview.spec.ts` or `node` after a build.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHandoff } from '../../src/handoff-writer.ts'
import { readProjectFacts } from '../../src/project-facts.ts'
import { createWorkspaceFiles } from '../../src/workspace-fs.ts'

const NARRATIVE = {
  selfcheck: [
    '- 需要服务：本地 8787（`npm run dev`）。没起服务时 `test:image` 会全红——那是环境问题，不是代码问题。',
    '- 关键数字：`check` 应输出 25 ✓ / 82 ✓ / 0 失败；数字对不上先查是不是漏了构建。',
    '- 失败优先怀疑：`pnpm` 与 `npm` 混用（本项目锁的是 pnpm）。',
  ].join('\n'),
  goal: [
    '用户原话：「把交接做成一份文件，而不是一条消息」。',
    '',
    '- [ ] 新会话能只看 §0 + §2 + §4 就开工',
    '- [ ] 每次交接后 HANDOFF.md 不膨胀（旧版进 CHANGELOG）',
    '- [ ] 文档顶部有有效期，过期必须整份重写',
  ].join('\n'),
  facts: [
    '- 交接链路：`measure` → `trigger` → `coordinator` → `writeHandoff` → `migrateSession`',
    '- 文档路径：`docs/handoff/<项目>/HANDOFF.md`，归档在 `CHANGELOG.md` 与 `history/<YYYY-MM>.md`',
    '- 新会话收到的第一条消息是**指针**（约 200 token），不是文档正文',
    '- 文档骨架由 `DOC_SECTIONS` 定义，模型只填正文；缺必需小节直接放弃交接',
  ].join('\n'),
  blockers: '无',
  next: [
    '1. 在 `handoff-doc.ts` 的 §0 里加入「需要服务」的检测（8787 端口是否在监听）',
    '2. 跑 `npm run check`，确认 25 ✓ / 82 ✓',
    '3. 若改了 §0 的命令行，同步更新 `project-facts.ts` 的 `VERIFY_SCRIPT_PRIORITY`',
  ].join('\n'),
  constraints: [
    '- 不要写 profile 目录（`~/.dsh/profiles/desktop`）',
    '- 不要删改原会话日志',
    '- 交接文档里不出现行号',
  ].join('\n'),
  files: [
    '- `src/handoff-doc.ts` → 文档骨架、提示词、渲染、预算裁剪',
    '- `src/archive.ts` → 旧版归档进 CHANGELOG 与月度 history',
    '- `src/handoff-writer.ts` → 编排：归档 → 写文档 → 生成指针消息',
    '- `src/project-facts.ts` → 从磁盘读验证命令与技术栈',
    '- `src/workspace-fs.ts` → 唯一碰磁盘的模块，写入原子且限定在工作区内',
  ].join('\n'),
  rejected: [
    '- **把整份简报当消息投递**：已否决。消息无法归档，每次交接都在累加，接手会话越读越久。',
    '- **让模型自己控制长度**：已否决。模型会超；截断必须由程序按小节优先级做。',
  ].join('\n'),
  verified: [
    '已验证（有证据）：',
    '- `npm run check` → 25 ✓ / 82 ✓ / 0 失败',
    '- `npm test` → 354 用例全绿',
    '',
    '未验证（怎么验证）：',
    '- 真实浏览器里的设置卡渲染 → 打开 设置 → 会话交接，确认新增「交接文档」一栏',
    '- 一次真实交接（换会话）→ 看新会话是否只读 §0 就开始跑',
  ].join('\n'),
}

const previous = `# 交接 —— 拾光（v1.5.0 / 2026-10-27 最后验证）

> 有效期：到下一次功能变更。过期重写，不允许追加。

## 0. 30 秒自检

- 命令：npm run check && npm run test:image
- 预期：25 ✓ / 82 ✓ / 0 失败

## 1. 目标与验收

把交接做成文件。

## 2. 当前有效事实

旧架构：简报作为消息投递。

## 4. 下一步 + 验证映射

改交接链路。

## 7. 已否决方案 + 原因

- 曾试图让模型自己控制长度，失败。

## 8. 已验证 vs 未验证

已验证：npm run check。
`

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'handoff-preview-'))
  try {
    // A tiny project so §0 is generated from real files rather than invented.
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify(
        {
          name: '拾光',
          scripts: {
            check: 'tsc --noEmit && vitest run',
            test: 'vitest run',
            'test:image': 'vitest run tests/image',
            dev: 'vite',
          },
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(join(root, 'tsconfig.json'), '{}', 'utf8')
    await writeFile(join(root, 'pnpm-lock.yaml'), '', 'utf8')
    await writeFile(
      join(root, 'README.md'),
      ['# 拾光', '', '| 命令 | 说明 |', '| --- | --- |', '| `npm run check` | 25 ✓ / 82 ✓ / 0 失败 |'].join('\n'),
      'utf8',
    )

    const files = createWorkspaceFiles(root)
    await files.write('docs/handoff/shiguang/HANDOFF.md', previous)

    const projectFacts = await readProjectFacts({ files, cwd: root, slug: 'shiguang' })

    const result = await writeHandoff({
      files,
      root: 'docs/handoff',
      project: 'shiguang',
      narrative: NARRATIVE as never,
      facts: {
        project: 'shiguang',
        cwd: root,
        commands: projectFacts.commands,
        stack: projectFacts.stack,
        agentPreset: 'coder',
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
        contextWindow: 1_000_000,
        permissionPreset: 'standard',
        planMode: 'off',
        turnCount: 42,
        occupancyPercent: 86,
        occupancyQuality: 'exact',
        git: { branch: 'main', head: '9f3c1ab77d2e4c0a', dirty: true, changedFiles: 4 },
        sourceSessionId: 'session-891322e6',
        createdAt: Date.UTC(2026, 9, 31, 2, 0, 0),
      },
      version: 'v0.2.0',
      reason: '上下文占用 86% / 已完成 42 turn',
      budgetChars: 24_000,
      archive: true,
    })

    console.log('=== RESULT ===')
    console.log(JSON.stringify({ ok: result.ok, bytes: result.bytes, dropped: result.dropped, archive: result.archive }, null, 2))

    console.log('\n=== HANDOFF.md ===')
    console.log(await readFile(join(root, 'docs/handoff/shiguang/HANDOFF.md'), 'utf8'))

    console.log('\n=== CHANGELOG.md ===')
    console.log(await readFile(join(root, 'docs/handoff/shiguang/CHANGELOG.md'), 'utf8'))

    console.log('\n=== history/2026-10.md (head) ===')
    const history = await readFile(join(root, 'docs/handoff/shiguang/history/2026-10.md'), 'utf8')
    console.log(history.slice(0, 600))

    console.log('\n=== POINTER MESSAGE ===')
    console.log(result.message)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main()
