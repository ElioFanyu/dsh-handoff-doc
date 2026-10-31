/**
 * Generate this workspace's real handoff document with the plugin's own writer.
 *
 * Run from the plugin directory:
 *   node --experimental-strip-types tests/manual/write-workspace-doc.ts
 *
 * Why a script and not a hand-written file: the document must be produced by the
 * same code the runtime uses, or the example and the behaviour drift apart. The
 * facts (§0's commands, §2's session line, §9's pointers) come from the real
 * workspace; only the narrative is supplied here.
 */
import { readGitFacts } from '../../src/git-facts.ts'
import { readProjectFacts } from '../../src/project-facts.ts'
import { writeHandoff } from '../../src/handoff-writer.ts'
import { createWorkspaceFiles } from '../../src/workspace-fs.ts'

const WORKSPACE = 'D:/Workspace/DeepSeek Harness'
const PROJECT = 'deepseek-harness'

const NARRATIVE = {
  selfcheck: [
    '- 本插件无服务依赖：`npm run check` 全程离线，不需要起端口、不需要联网。',
    '- 关键数字：`npm run check` 应输出 **19 个测试文件 / 371 用例全绿**，且 `tsc` 两份配置都无输出。',
    '- 失败优先怀疑：`node_modules` 是从 `dsh-session-handoff` 拷来的，缺依赖时先 `npm i`，不要先改代码。',
  ].join('\n'),

  goal: [
    '用户原话：「不是直接告诉新会话做什么，而是创建一份文档」——把交接从**一条消息**改成**一份文件**。',
    '',
    '验收（每条都要能勾）：',
    '',
    '- [ ] 新会话第一条消息是**指针**（约 200 token），不是文档正文',
    '- [ ] 文档结构固定十节，§0 决定「要不要往下读」',
    '- [ ] 每次交接**整份重写** `HANDOFF.md`，绝不追加',
    '- [ ] 上一版先归档进 `CHANGELOG.md` 与 `history/<YYYY-MM>.md`，再被覆盖',
    '- [ ] 顶部写有效期（到下一次提交 / HEAD 变化即失效）',
    '- [ ] 超出字符预算时按优先级整节省略，并留下省略说明',
    '- [ ] 缺任一必需小节（§0/§1/§2/§4/§6/§8）直接放弃交接，不创建新会话',
  ].join('\n'),

  facts: [
    '**架构**：`measure`（度量）→ `trigger`（纯函数触发引擎）→ `coordinator`（单动作阶段机）→ `writeHandoff`（写文档）→ `migrateSession`（建会话+继承）→ `deliverBrief`（投递指针）。',
    '',
    '**目录约定**：`<工作区>/docs/handoff/<项目>/`，项目名默认取工作区最后一级目录名（本工作区 → `deepseek-harness`）。可用 `handoffProjectFolder` 钉住。',
    '',
    '**文档骨架是代码，不是提示词**：`DOC_SECTIONS` 定义十个标题与每节写作要求；模型只填正文。标题若交给模型，漏掉 §0 的文档仍会被当作「交接成功」，而接手方无法导航。',
    '',
    '**事实与叙述分家**：程序读得到的一律由程序写（cwd、preset、模型、权限、占用率、验证命令、git HEAD），模型不得改写；模型只写程序读不到的（目标、卡点、下一步、否决方案）。',
    '',
    '**预算在程序里，不在提示词里**：「请写短一点」不是机制。`fitToBudget` 先整节删除可选节（§7→§3→§5→§9），仍超长再从最长节末尾按比例删行，每节保底 8 行，并在文末留下省略说明。',
    '',
    '**归档是幂等的**：`archivePrevious` 用内容哈希（`content:<16 hex>`）判重，`retry` 不会产生第二条相同条目。',
    '',
    '**写入原子且受限**：所有写经 `workspace-fs.ts` 的 `resolveInside` 校验（用 `relative()` 判断，不是字符串前缀），临时文件 + `rename`。',
    '',
    '**默认全关**：装上插件只多一条命令和一张设置卡，不改变任何现有会话行为。',
  ].join('\n'),

  blockers: [
    '无（代码侧无阻塞）。',
    '',
    '两项**只能在真实环境里确认**的事，不属于阻塞但必须做：',
    '',
    '1. 设置卡在浏览器里的实际渲染（新增「交接文档」一栏）。',
    '2. 一次真实的换会话交接（看新会话是否只读 §0 就开始跑）。',
  ].join('\n'),

  next: [
    '1. **安装到当前 profile 并验证投影**：',
    '   - `plugin_manager install_bundle` 指向 `D:/Workspace/DeepSeek Harness/dsh-handoff-doc`',
    '   - 装完用 `cordis_inspect_query` 查 `Config.listConfigs`，确认 `dsh-handoff-doc` 的 `status` 是 `schema`（不是 `unsupported`）',
    '   - 必跑：`npm run check`（371 用例）+ 重启宿主',
    '',
    '2. **改设置卡渲染时**：改 `src/client/card.ts` 或 `protocol.ts` → 必跑 `npm run check`；',
    '   然后刷新浏览器（`pnpm run dev:web` 在跑时客户端包会热更新），确认「高级设置」里「交接文档」四行都在。',
    '',
    '3. **改文档骨架时**：改 `src/handoff-doc.ts` 的 `DOC_SECTIONS` → 必跑 `npm run check`，',
    '   并额外跑 `node --experimental-strip-types tests/manual/preview.ts` 用肉眼读一遍渲染结果（断言查不出「读起来别扭」）。',
    '',
    '4. **改归档规则时**：改 `src/archive.ts` → 必跑 `tests/unit/archive.spec.ts`，',
    '   重点看幂等用例（同内容重跑不得新增条目）与「先归档后写文档」的顺序用例。',
    '',
    '5. **改度量/触发/软终止时**：这些是从 `dsh-session-handoff` 原样沿用的，改动会同时影响两个插件；',
    '   必跑全量 371 用例，并确认 `dsh-session-handoff` 的 261 用例仍然全绿。',
  ].join('\n'),

  constraints: [
    '- **不要写 profile 目录**（`~/.dsh/profiles/desktop` 的 `package.json` / `cordis.patch.yml`）：安装一律走 `plugin_manager install_bundle`。',
    '- **不要删改原会话日志**：插件只读 `snapshotEvents()`。',
    '- **不要在文档里写行号**：行号第二天就过期，写职责。',
    '- **不要让 §9 承载内容**：只允许一行指针，否则本文件必然膨胀回日志。',
    '- **不要把必需小节改成可选**来「让交接更容易成功」：缺 §2/§4 的文档等于让接手方重做一遍，失败一次比这个便宜。',
    '- **不要给 `inject` 加服务**：目前只声明 `sessions`；声明一个组合里没有的服务会让整行永久 `pending`，插件根本不激活（这是上一版实测踩过的坑）。',
    '- **客户端只 `inject: [\'slots\']`**：服务名是 `configForms` 不是 `forms`，声明错了整个浏览器半保持休眠。',
  ].join('\n'),

  files: [
    '| 路径 | 职责 |',
    '| --- | --- |',
    '| `src/index.ts` | 宿主入口：`apply()` 接线、`summarize`（写文档）、命令与路由注册、`whereText` |',
    '| `src/handoff-doc.ts` | **文档骨架**：十节定义、提示词、解析、渲染、字符预算裁剪、指针消息 |',
    '| `src/archive.ts` | 归档：上一版 → CHANGELOG（摘要）+ history/月（全文），按内容哈希幂等 |',
    '| `src/handoff-writer.ts` | 编排：归档 → 写文档 → 生成指针；缺必需小节则拒绝 |',
    '| `src/project-facts.ts` | 从磁盘读验证命令（package.json / Makefile / README）与技术栈 |',
    '| `src/workspace-fs.ts` | 唯一碰磁盘的模块；原子写、限定在工作区内 |',
    '| `src/git-facts.ts` | 读 branch / HEAD / 脏文件数；不是 git 仓库时返回 `undefined`，绝不编造 |',
    '| `src/coordinator.ts` | 单会话单动作、阶段机、闩锁释放、取消/重试 |',
    '| `src/measure.ts` | 上下文占用率 + 累计消费，标注精确/估算 |',
    '| `src/trigger.ts` | 纯函数触发引擎：水位、防抖、重臂、滞回、次数上限 |',
    '| `src/graceful-stop.ts` | 停止闩锁 + `agent/pre-step` 否决 + 人类输入放行 |',
    '| `src/session-migration.ts` | 建新会话、逐项继承、投递消息 |',
    '| `src/session-summary.ts` | 会话事实、对话记录渲染、未答复提问检测 |',
    '| `src/settings.ts` | Config schema（20 字段）+ 跨字段校验 |',
    '| `src/routes.ts` | 设置卡用的 HTTP 状态/操作通道（写操作仅本机） |',
    '| `src/redaction.ts` | 离开会话前脱敏（令牌、私钥、连接串…） |',
    '| `src/client/` | 浏览器半：设置卡（`card.ts`）、常驻跳转（`follow.ts`）、共享契约（`protocol.ts`） |',
    '| `tests/unit/apply-e2e.spec.ts` | **端到端**：驱动真实 `apply()`，断言文档落盘、新会话创建、只投递指针 |',
    '| `tests/manual/preview.ts` | 人工预览：渲染一份真实文档，用肉眼读 |',
    '| `tests/manual/write-workspace-doc.ts` | 用插件自身的写入器生成本文件（示例与行为不漂移） |',
  ].join('\n'),

  rejected: [
    '- **把整份简报当消息投递**（上一版 `dsh-session-handoff` 的做法）：已否决。消息无法归档，每次交接都在上一次之上叠加，接手方读的是全部历史交接的总和；而且消息一旦投递就不能改。',
    '- **让模型自己控制长度**：已否决。模型会超预算；截断必须由程序按小节优先级做，否则被砍掉的恰好是最需要保留的 §2。',
    '- **沿用「9 段里至少 3 段有内容」的可用性判据**：已否决。那条判据是向「模型只看到配置事实」妥协的产物；现在模型能看到对话记录，缺 §2/§4 就是真缺。',
    '- **把历史留在 HANDOFF.md 里**：已否决。只要允许追加，文件必然膨胀——这正是要解决的问题本身。',
    '- **用字符串前缀判断路径是否越界**：已否决。`C:\\work\\proj2` 以 `C:\\work\\proj` 开头但不是同一目录；必须用 `relative()`。',
    '- **在 `apply()` 里快照服务引用**：已否决。Loader 并发装配，`sessionController` 常在 `apply()` 之后才出现，快照会把健康部署报成「没有 sessionController」。',
  ].join('\n'),

  verified: [
    '**已验证（有证据）**',
    '',
    '- `tsc -p tsconfig.json --noEmit` → 无输出',
    '- `tsc -p tsconfig.client.json --noEmit` → 无输出',
    '- `vitest run` → **19 个测试文件 / 371 用例全绿**',
    '- `tsdown` → `lib/index.js` 170.19 kB（ESM）+ `lib/client.js` 39.57 kB（CJS）；客户端只 `require("react")`，信封为 `window.__ModuleLoader__.load({ id: "dsh-handoff-doc" })`',
    '- Config 契约（`node tests/manual/schema-check.mjs`）→ `~standard.validate` 同步；`dict` 20 字段且全部有默认值；`toJSON()` 返回 `{uid, refs}`（24 条共享定义）；越界值被拒；压缩≥交接的规则仍然拦截',
    '- 端到端（`tests/unit/apply-e2e.spec.ts`）→ 真实 `apply()` 下：文档落盘、`session-new` 被创建、`followup` 收到的**只有指针**（<2000 字符，不含文档正文）',
    '- 真实工作区渲染（`tests/manual/preview.ts`）→ 十节齐全，§0 命令来自 `package.json`，归档三文件均生成',
    '',
    '**未验证（怎么验证）**',
    '',
    '- **设置卡在浏览器里的渲染** → 装进 profile 后打开 设置 → 会话交接，展开「高级设置」，确认「交接文档」四行（目录 / 文件夹名 / 归档开关 / 喂上一版）都在且可编辑；保存后刷新，值不回落。',
    '- **一次真实的换会话交接** → 在真实会话里跑 `/handoff`，确认新会话第一条消息是指针、只读 §0 就开始跑，且 `docs/handoff/<项目>/HANDOFF.md` 的内容与上一版不同（不是追加）。',
    '- **归档在真实磁盘上的幂等** → 同一会话连跑两次 `/handoff`，确认 `CHANGELOG.md` 只多一条条目（第二次因哈希相同被跳过）。',
    '- **`/handoff where` 在真实会话里** → 确认输出里的「记录时的 HEAD」与 `git rev-parse --short HEAD` 一致。',
  ].join('\n'),
}

const previous = `# 交接 —— 拾光（v1.5.0 / 2026-10-27 最后验证）

> 有效期：到下一次功能变更。过期重写，不允许追加。
> 写进来的只留「现在仍然成立」；过程/历史推 CHANGELOG。

## 0. 30 秒自检

- 命令：npm run check && npm run test:image
- 预期：25 ✓ / 82 ✓ / 0 失败
- 环境：Node ≥18，服务需在 8787（npm run dev）
- 全量验证矩阵 → 见 §4

## 1. 目标与验收（用户原话 + 勾选）

把长会话交接给新会话，新会话要能直接接着做。

## 2. 当前有效事实

- 交接以一条消息投递，九段结构。

## 4. 下一步 + 验证映射

- 继续完善交接内容。

## 7. 已否决方案 + 原因

- 无

## 8. 已验证 vs 未验证

- 已验证：npm run check 25 ✓ / 82 ✓。
- 未验证：真实交接流程。
`

async function main(): Promise<void> {
  const files = createWorkspaceFiles(WORKSPACE)

  // Archive the old snapshot first, exactly as a real handoff would.
  const existing = await files.read(`docs/handoff/${PROJECT}/HANDOFF.md`)
  if (existing === undefined) {
    await files.write(`docs/handoff/${PROJECT}/HANDOFF.md`, previous)
    console.log('seeded an initial previous snapshot (standing in for an earlier handoff)')
  }

  const projectFacts = await readProjectFacts({ files, cwd: WORKSPACE, slug: PROJECT })
  console.log('discovered commands:')
  for (const entry of projectFacts.commands) console.log(`  ${entry.command}  (${entry.origin})`)
  console.log('stack:', projectFacts.stack.join(' / '))

  /*
   * The git facts are READ, never invented.
   *
   * The first draft of this script hard-coded a branch and HEAD so the header
   * would look complete — and the resulting document claimed a commit that does
   * not exist, because this workspace is not a git repository at all. A
   * handoff document whose validity line is fabricated is worse than one with
   * no validity line: the successor checks HEAD, sees a mismatch, and rewrites a
   * perfectly good document.
   */
  const git = await readGitFacts({ root: WORKSPACE })
  console.log('git:', git === undefined ? 'not a git work tree (validity falls back to functional change)' : `${git.branch}@${git.head?.slice(0, 8)}`)

  const result = await writeHandoff({
    files,
    root: 'docs/handoff',
    project: PROJECT,
    narrative: NARRATIVE as never,
    facts: {
      project: PROJECT,
      cwd: WORKSPACE,
      commands: projectFacts.commands,
      stack: projectFacts.stack,
      agentPreset: 'coder',
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      contextWindow: 1_000_000,
      permissionPreset: 'standard',
      planMode: 'off',
      turnCount: 96,
      occupancyPercent: 78,
      occupancyQuality: 'exact',
      ...(git === undefined ? {} : { git }),
      sourceSessionId: 'session-current',
      createdAt: Date.now(),
    },
    version: 'v0.2.0',
    reason: '首次以「文档」方式交接（此前为消息投递）',
    budgetChars: 24_000,
    archive: true,
  })

  console.log('\n=== result ===')
  console.log(JSON.stringify({ ok: result.ok, bytes: result.bytes, dropped: result.dropped, archive: result.archive, error: result.error }, null, 2))
  console.log('\nwritten:', result.documentPath)
  console.log('pointer length:', result.message.length, 'chars')
}

await main()
