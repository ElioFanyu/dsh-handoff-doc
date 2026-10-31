# 会话交接记录 —— 旧会话传递信息 + 本会话操作明细

> 记录时间：2026-10-31T19:22–19:27（+08:00）
> 工作范围：`dsh-handoff-doc`（工作区 `D:\Workspace\DeepSeek Harness`）
> 基线：`main` @ `89e595e7`，7 个未提交改动，版本 `0.2.0`
> 性质：**过程记录与信息留档**。它不是交接文档本身（交接文档是 `docs/handoff/dsh-handoff-doc/HANDOFF.md`），
> 也不具备交接文档的有效期语义；下一份交接文档重写时不会自动带上本文件的内容。

## 零、为什么要写这份文件

旧会话在上下文将满时把状态压成了一份 `HANDOFF.md`，新会话（本会话）只拿到那份快照。
本文件的用途是补上快照**不承载**的两样东西：

1. **旧会话传过来的信息全貌** —— 快照里的结论、以及快照里刻意裁掉的背景与来龙去脉，汇总在一处。
2. **本会话接收后实际做了什么** —— 逐条命令、逐条结果、踩到的坑与修正，便于之后复算或追责。

区别于另外三份文件：

| 文件 | 内容 | 写入方式 |
| --- | --- | --- |
| `docs/handoff/dsh-handoff-doc/HANDOFF.md` | 当下成立的快照 | 每次整份重写 |
| `docs/handoff/dsh-handoff-doc/CHANGELOG.md` | 每版交接的差异摘要 | 只追加 |
| `history/2026-10.md` | 月度全文归档 | 只追加 |
| **本文件** | 一次「接手」的过程记录 | 只写一次，不重写 |

---

## 一、旧会话传递过来的信息

旧会话 id：`session-4ece971d-c6f9-446f-9ed1-1945d2360d47`，交接生成于 `2026-10-31T11:22:18.115Z`，
当时上下文占用 22%、已完成 6 turn。以下是其快照的要点，按「结论 → 依据 → 边界」整理。

### 1.1 目标与口径（最重要的一条）

用户要的结果：**交接文档是「当下成立的快照」，新会话只读这一份就能继续干活，不读旧对话、不靠猜。**

用户明确过的口径：交接文档交接的是**「当前会话下一步要做的内容」**，不是「会话所在目录里的所有项目」。
上下文将满时，产物必须让新会话无损接手同一件事；把无关项目、已完成过程塞进去，
等于**凭空派活**，并且让文件无限膨胀。

这条口径是后面一大串设计决定（工作范围推断、§0 只列主战场命令、§1 只留未完成项）的唯一源头。

### 1.2 仍未做完的验收条目（旧会话移交时）

- 真实端到端透传：在**已工作过的真实会话**里输入 `/handoff 推送 GitHub`，触发后全程不再输入。
  验收看四点：指针含工作范围段与「关于附言的范围」、没动其它仓库、没有真的 push、
  产物落在 `docs/handoff/dsh-handoff-doc/` 而不是 `docs/handoff/deepseek-harness/`。
- 交接后文件真的落在 `docs/handoff/dsh-handoff-doc/`：此前只验了路径推导，没验过落盘。
- §0 形状：新 `HANDOFF.md` 的 §0 只列主战场命令，并有「本次未涉及」一行。
- 设置卡渲染肉眼确认：设置 → 通用 → Advanced 能看到「文档输出上限」与「交接文档上限（字符）」；
  把前者临时改 `4000` 看警告出现，改回 `26000` 后消失。
- 重启后完整迁移复跑：落盘 → 建新会话 → 投指针，全链路真跑一次。
- 发版：`version` 仍是 `0.2.0`，多次功能变更未 bump。
- 阈值冲突定性：决定调整阈值还是明确接受那条常驻警告。

### 1.3 旧会话认定的关键事实（机制层面）

- **输出目录按「会话实际工作的项目」命名**，不是工作区文件夹名。
  `resolveProject(pinned, cwd, focus)` 优先级：用户 pin 名 > 焦点子项目 > 工作区名。
  焦点由 `focusFromEvents(events, await listSubProjects(files))` 得出，**必须在读 facts 之前算**，因为它决定输出路径。
- **工作范围机制**：`work-scope.ts` 扫 `tool/call`，统计子项目目录被点名次数。规则：一次调用只计一次
  （跨目录 `grep` 会刷很多遍）；只看 `arguments` / `command` / `path` / `file_path`，**不看 `tool/result`**
  （输出里的路径不是「干过活」的证据）；路径边界匹配（`plugin-a-old` 不算 `plugin-a`，两侧的 `.` 算边界）；
  排除 `ask_user_question` / `job_*`；候选目录来自 `listSubProjects`，不为不存在的目录编造。
- **候选目录判据**：`package.json`、`.git/HEAD`、`README.md` 三者之一。
  这是踩过坑的：`dsh-recovery` 是 Electron 应用，有 `.git`、有源码、没有 manifest，
  曾因此从候选里消失，导致一次 281 次调用的交接被归档到只被点名 2 次的
  `docs/handoff/dsh-connect-volcengine/`，指针还让继任者去跑无关项目的检查。
- **焦点可信度由 `focusLooksWrong` 判定**：焦点调用数占总量 <10% 且总调用 ≥10 时判为可疑。
  含义是「候选扫描很可能漏了真项目」，不是「这次没干活」。可疑时指针与 §0 都改口写「无法可靠判定」并撤掉命令清单。
- **`scopesInPlay` 阈值**：最高分须 ≥2 次调用才算 focus（`FOCUS_FLOOR = 2`，防一次 `ls` 根就钦点）；
  次要项须达 focus 的 25% 且 ≥2 次才算「本次也涉及」。无 focus 返回空数组，退回目录序。
- **范围有两个要改的地方，缺一不可**：§0 / §4 的渲染（该跑哪个项目的检查）与**指针消息**
  （附言里「推送 GitHub」指哪个项目）。只修前者会让继任者扫遍工作区去推无关仓库。
- **`parseDoc` 标题判定（当前实现，别再放宽）**：`#` 开头的行为标题；`**短标题**` 必须在行首、
  粗体部分 ≤30 字、允许同行带正文；编号行（`N. …`）**不单独成立**——先按标题文本匹配已知小节，
  匹配不上才看编号，且要求编号属于本文件小节**并且**标题部分 ≤12 字；形似标题但匹配不上的行保留在当前小节内。
- **两个预算口径，换算常量 `TOKENS_PER_CHAR = 1`**（中文一字一 token，不是 0.75）：
  `handoffDocMaxChars` 是最终文件**字符**数（默认 24000，范围 2000–120000）；
  `summaryMaxTokens` 是模型单次可生成 token 数（默认 26000，范围 256–65536）。
  警戒线是 `summaryMaxTokens < handoffDocMaxChars`。常量在两处生效且必须一致：
  `src/settings.ts#validateSettings` 与 `src/client/protocol.ts#localWarnings`。
- **设置项用户可见名以 `src/client/card.ts` 的 `Advanced` 行为准**：
  `summaryMaxTokens` =「文档输出上限」，`handoffDocMaxChars` =「交接文档上限（字符）」。
- 截断识别：`llm.stream` 的 `finish` 事件里 `reason.kind === 'length'` 表示被 `maxTokens` 截断，
  与 `error` / `aborted` 分开处理。
- 归档幂等：`archivePrevious` 用内容哈希 `content:<16 hex>` 判重，先归档后覆盖；
  缺必需小节时 `writeHandoff` 提前返回（`archived:false`），不归档、不污染 CHANGELOG。
- 磁盘写唯一入口是 `workspace-fs.ts`：用 `relative()` 判越界、临时文件 + `rename` 原子落盘。
- 安装形态：`~/.dsh/profiles/desktop/node_modules/dsh-handoff-doc` 是 `link:` 指向源码，
  `tsdown` 产出 `lib/index.js` 后安装副本立即一致，无需重装；**宿主侧改动必须重启宿主**才生效。
- 三份文件分工：`HANDOFF.md` 每次整份重写；`CHANGELOG.md` 只追加；`history/<YYYY-MM>.md` 是月度全文。
- 完整事件日志在 `~/.dsh/sessions/--D-Workspace-DeepSeek~0020Harness--/<sessionId>/session.v4.jsonl.zstd`
  （zstd JSONL）；`~/.dsh/storages/session_projcache/sessions/*.json` 只有投影行、**没有 `tool/call`**，不能用来验 scope。

### 1.4 旧会话标出的卡点

- 真实端到端透传未做。`POST /handoff` 不接受 `instruction`，必须在输入框敲 `/handoff <正文>`；
  真跑会迁移当前会话。必须在**已工作过的会话**上做——空会话没有 `tool/call`，scope 为空，测不到范围机制。
  **用户已选择自己手动跑，不要代替他触发。**
- 设置卡浏览器渲染未肉眼确认：只有 `state.warnings` 数据源实证，无截图、无真实点击。
- 重启后完整迁移未复跑：idle、端口、产物一致性已验；真实迁移会掐断当前会话。
- 阈值配置自相矛盾（**配置项，不是代码缺陷**）：profile 里 `autoHandoffAtContextPercent=40`、
  `autoCompactAtContextPercent=60`、`autoCompactEnabled=true`，于是 `/state.warnings` 常驻
  「压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。」`autoHandoffEnabled=false` 时只是警告；
  一旦开启自动交接，压缩 60% 高于交接 40%，压缩刚结束就会立刻触发交接。

### 1.5 旧会话已否决的方案（25 条，别再试）

按主题归并：

- **归因错误类**：把「缺 §4」归因为「没收到 finish chunk」/「预算不够」/「推理吃预算」（全错，白改三轮，真因是解析器）；
  把「调大 `summaryMaxTokens`」当成缺节的解药（因果错误）。
- **解析器放宽类**：接受任意以 `**` 开头的行作标题（§4 正文被整行吞掉）；编号行只凭数字成标题
  （`3. 若失败…` 把 §4 切两半，长度阈值也挡不住）。
- **范围判定类**：用工作区文件夹名做交接目录（`deepseek-harness` 是容器不是项目名）；
  只修 §0 不修指针；用存在性判断决定「是否涉及」；扫描 `tool/result`；按调用次数排序全部子项目；
  只扔候选清单不承认扫描可能不全；把工作范围计数当可人工复算的确定值（要复核就用 `readWorkScope` 本身）；
  用 `package.json` 作为「是不是项目目录」的唯一标志；用 `session-*.json` 验工作范围。
- **产物与投递类**：把整份简报当消息投递（无法归档，逐次叠加）；让模型自己控制长度 / 从 §0 顺序写到 §9；
  把必需小节清单在提示词里手写一遍（会与校验器漂移）；把 `/handoff` 未知参数当语法错误拒绝；
  把指令写进文档正文（指令属于指针消息）；把所有兄弟项目的 check 都写进 §0 / 按目录序取前 3 条命令。
- **流程类**：在全新空会话里验端到端透传；在 handoff 进行中往会话里发消息（含「继续」）；
  把 `archiveSourceAfterHandoff: false` 当故障去改；在会话进行中代替用户触发 `/handoff`。
- **环境类**：用 `lib/client.js` 在 Node 里跑 `localWarnings`（`window is not defined`）；
  把探针放 `/tmp` 并相对 import（`ERR_MODULE_NOT_FOUND`）；把宿主 `/api/*` 的 401 当插件故障；
  用字符串前缀判路径越界；在 `apply()` 里快照服务引用；用 `node -e` 改含中文与反斜杠的 TS；
  用 `| head -c` 判 curl 成功；用 `wc -c` 判 24000；用 HTTPS remote 推 GitHub（`CRYPT_E_REVOCATION_OFFLINE`）；
  把文档里写死的会话 id、端口当当前值。
- **脱敏类**：把 `env-assignment` 脱敏当成「名字里有 TOKEN 就当密钥」——原规则对
  `TOKENS_PER_CHAR = 1` 这类常量赋值也命中，并把值吞到行尾。**修法**：值必须 ≥8 个 ASCII 字符
  且不含空白/中文标点才命中；已加回归测试，别再放宽回「任意非空白串」。
- **路径边界类**：只把 `.` 加进 `namesDirectory` 的前边界（`.dsh-handoff-doc.raw.md` 两侧都可能是点）。

### 1.6 旧会话的验证证据（继任者仍需依赖）

- 全量检查基线：23 测试文件 / **441** 用例全绿、两次 `Build complete`、exit 0。
  **`tests/manual/*.spec.ts` 会被 vitest 计入**，残留探针会让数字变成 34/454。
- 解析器能吃掉真实长文档：`docs/handoff/.dsh-handoff-doc.raw.md`（12246 字符 / 20805 字节）
  跑 `parseDoc` + `missingRequired` → 十节全解析、缺失为零。
- 无 manifest 的项目能被发现：对 `session-9134bbe8` 的真实日志（281 次调用）复算，
  候选含 `dsh-recovery` 时焦点 `dsh-recovery 266/281`；退化为旧候选清单时焦点
  `dsh-connect-volcengine 2/281` 且 `focusLooksWrong === true`。
- 工作范围计数口径：用 `readWorkScope` 对真实日志复算 → `dsh-handoff-doc 55/57`，与人工计数一致
  （差异来源是 `.dsh-handoff-doc.raw.md` 的前导点）。
- 脱敏不损坏常量句；构建产物与安装副本一致；活宿主上 `/config` 与 `/state` 可读（`phase=idle`）。

### 1.7 旧会话最后一条是助手发言

快照里有一行明确警告：**原会话最后一条是助手发言，其后没有用户消息——可能仍在等用户回话，
交接不等于已获得执行 §4 的许可。** 本会话因此先只做只读采集，未执行会改变状态的 §4 动作。

---

## 二、本会话接收后所做的全部操作

时间窗：2026-10-31T19:22:55 ~ 19:27（+08:00）。全部为**只读**操作 + 一次临时探针（已删除），
**没有触发 `/handoff`、没有改源码、没有提交、没有推送**。

### 2.1 检查前置条件（是否过期）

- 工具：`ops_grep` 只抓 `#` 标题行 → 拿到 14 个标题，确认小节编号与文档目的一致（§0–§9）。
- **未整份通读**：只按交接要求读 §0 → §2 → §3 → §4，随后按需读 §6 尾部、§7、§8、§9。

### 2.2 §0 自检（结果：通过）

| 检查项 | 命令 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| HEAD | `git rev-parse --short=8 HEAD` | `89e595e7` | 与文档一致 |
| 分支 | `git rev-parse --abbrev-ref HEAD` | `main` | 一致 |
| 脏文件数 | `git status --porcelain` | 7 个 `M` | 与 §3 一致 |
| 全量检查 | `npm run check` | 23 文件 / 441 用例；`Build complete` ×2；exit 0 | 与 §0 一致 |

七个未提交文件：`src/handoff-doc.ts`、`src/project-facts.ts`、`src/redaction.ts`、`src/work-scope.ts`、
`tests/unit/project-facts.spec.ts`、`tests/unit/summary.spec.ts`、`tests/unit/work-scope.spec.ts`。

`npm run check` 展开为 `typecheck && test && build`（来自 `package.json#scripts.check`）。

### 2.3 仓库与产物盘点

- `git log --oneline -12` → 11 条历史，最新 `89e595e7 fix: 解析器把 §4 正文的粗体列表项当成标题，导致 §4 被判为空`；
  其下依次是缺节记录结束原因、1:1 换算、失败消息可折叠、失败日志与 `/last-error`、截断检测修复、
  目录按项目命名、指针带工作范围、§4 按范围取命令、提示文案用真实标签名、`0.2.0` 首个提交。
- `git diff --numstat`：`src/handoff-doc.ts` +76/−15、`src/project-facts.ts` +35/−1、`src/redaction.ts` +10/−1、
  `src/work-scope.ts` +50/−2、三个测试文件分别 +24/−3、+75/−0、+44/−1；合计 **314 insertions / 23 deletions**。
- 未提交改动里可见的新符号：`scopeWarning`、`selfCheckLines`、`looksLikeProject`、
  `PLAUSIBLE_FOCUS_SHARE`、`focusLooksWrong`——对应「可疑范围两处出口」与「无 manifest 项目可被发现」两组修复。
- 新增/改动的测试用例（从 diff 提取，共 11 条 `it` + 1 个 `describe`）：
  目录只要有任一项目标志就算候选、完全无 manifest 的项目能被看见、短字面量常量赋值不脱敏、
  §0 在范围解释不了会话时告警、指针在同样场景下告警而非断言、前导点算边界使隐藏产物计入、
  `focusLooksWrong` 组四条（可疑焦点告警 / 健康焦点信任 / 短会话豁免 / 无焦点或总量未知不告警）。
- 产物目录实况：
  - `docs/handoff/dsh-handoff-doc/HANDOFF.md` — 30738 字节 / **17634 字符**
  - 同级 `CHANGELOG.md` — 71697 字节 / 38946 字符
  - 同级 `history/2026-10.md` — 210185 字节 / 122766 字符
  - `docs/handoff/.dsh-handoff-doc.raw.md` — 20805 字节（被拒时落盘的模型原文）
  - `docs/handoff/.dsh-handoff-doc.log` — 3878 字节
  - `docs/handoff/dsh-connect-volcengine/HANDOFF.md` — 11986 字节（旧缺陷遗留的错误目录，未删改）
- `git remote -v` → `origin git@github.com:ElioFanyu/dsh-handoff-doc.git`（SSH）。
- `git ls-remote origin main` → `89e595e7fa1a933e9d20f63d9fae8c47243110ee`。
  **远端 HEAD 与本地 HEAD 相同，说明 7 个未提交改动确实一个都没推上去。**

### 2.4 活宿主读数（端口 2171）

端口探测：`2171 → 200`（插件路由可直接访问）；`2172 / 2173 → 401`（宿主 `/api/*` 需要凭证，属正常鉴权）；
`2170 / 3000 / 4173` 无监听。**端口每次启动都变，此处只对本次启动有效。**

`GET /dsh-handoff-doc/config`（重点字段）：

```
summaryMaxTokens=26000     handoffDocMaxChars=24000
autoHandoffEnabled=false   autoHandoffAtContextPercent=40
autoCompactEnabled=true    autoCompactAtContextPercent=60
archiveSourceAfterHandoff=false   openNewSessionOnHandoff=true
handoffDir=docs/handoff    handoffProjectFolder=""
archivePreviousHandoff=true   reusePreviousHandoff=true
```

`GET /dsh-handoff-doc/state?sessionId=session-badafdee-a1c6-4a29-9c81-04b550fb40cb`：

```
phase=idle  busy=false  latched=false  waitingForStep=false  cancelRequested=false
occupancy: estimated, used=38702, window=1000000, percent=3.87%
cumulative: tokens=218751, source=projection, quality=exact
thresholds: handoffPercent=40, compactPercent=60, cumulative=2000000, enabled=false, compactEnabled=true
warnings: ["压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。"]
```

结论：宿主存活、插件已加载、协调器空闲且未闩锁，**当前可安全开跑**（但本轮不触发）。

### 2.5 代码结构核对（只读）

- `src/handoff-doc.ts` 的导出清单（按源码顺序）：`DOC_SECTIONS`、`REQUIRED_SECTIONS`、`REQUIRED_HEADINGS`、
  `MIN_REQUIRED_FILLED`、`docPaths`、`monthOf`、`projectSlug`、`renderHeader`、`validityOf`、`buildDocPrompt`、
  `parseDoc`、`missingRequired`、`documentIsUsable`、`renderDocument`、`selfCheckLines`、`factLines`、
  `verificationMatrix`、`fitToBudget`、`renderPointer`。
- `src/work-scope.ts`：`readWorkScope(events, candidates)`、
  `scopesInPlay(scope)`（bar = `max(FOCUS_FLOOR, ceil(focus.calls * 0.25))`）、
  `focusLooksWrong(scope)`（`focus.totalCalls < 10` 豁免，否则 `calls/totalCalls < 0.1` 判可疑）。
- `package.json#scripts`：`build` / `test` / `typecheck` / `check`。

### 2.6 临时探针：验证两份真实文档的解析完整性

§4 写着「改本文件后必做：用 `parseDoc` + `missingRequired` 跑一遍本文件，要求十节齐全、`missingRequired` 为空」。
本轮虽未改交接文档，但需要为「旧文档是否仍然可用」提供证据，故跑了一次探针。

**第一次尝试失败**（记录在此，避免下次重踩）：探针写成 `sections.filter(...)`，
报 `TypeError: sections.filter is not a function`。
原因：`parseDoc(raw)` 返回的是 `DocNarrative` —— 一个**按小节 key 索引的对象**，不是数组。
（临时用 `npx vite-node` 运行；`vite-node@6.0.0` 是 npx 临时拉取的，未写入 `package.json`。）

**修正后**改为遍历 `DOC_SECTIONS` 的 key 去查 `narrative[key]`，结果：

| 文件 | 字符数 | 解析到的小节 | 缺失必需小节 |
| --- | --- | --- | --- |
| `docs/handoff/dsh-handoff-doc/HANDOFF.md` | 17634 | 10 / 10 | 无 |
| `docs/handoff/.dsh-handoff-doc.raw.md` | 12246 | 10 / 10 | 无 |

十节 key 顺序：`selfcheck, goal, facts, blockers, next, constraints, files, rejected, verified, history`。
两个文件都远低于 `handoffDocMaxChars = 24000`。

**清理**：探针文件 `tests/manual/probe-handoff-doc-verify.ts` 已删除；
`tests/manual/` 现仅剩既有的人工预览/探针脚本（`preview.ts`、`probe-hang2.mjs`、`probe-idle.mjs`、
`repro-hang.ts`、`schema-check.mjs`、`write-workspace-doc.ts`，均无 `.spec.ts` 后缀）。
删除后复跑 `npx vitest run` → **23 文件 / 441 用例全绿**，基线未被污染。

### 2.7 本会话的操作边界

- 未执行 §4 第一条（端到端透传）：它需要用户在真实会话里手动敲 `/handoff`，且会掐断当前会话。
- 未执行 §4 其余动作：改阈值、改版本号、提交/推送，均会改变状态，且与「只做记录」的附言无关。
- 未触碰 `dsh-desktop-bridge`、`dsh-obsidian` 与 `dsh-connect-volcengine/HANDOFF.md`。
- 未读原会话的完整事件日志（`session.v4.jsonl.zstd`，1190760 字节）：
  环境里没有 `zstd` 可执行文件（`zstd -dc | wc -l` 返回 0，即命令不存在），
  需要复算 scope 时应走插件的 `readWorkScope`，不要手写正则。

---

## 三、本轮新增的结论

1. **交接文档仍然有效**：HEAD、脏文件面、测试基线三项全部与快照一致，未过期。
2. **两份真实文档的解析完整性再次确认**：17634 字符与 12246 字符两份都是 10/10 节、零缺失。
   这是自 `89e595e7`（修 §4 粗体列表误判）之后第一次对**当前快照文件本身**复跑，之前验的是 raw 与旧版。
3. **远端未推进**：`git ls-remote origin main` = 本地 HEAD，7 个未提交改动确实只在工作区里。
4. **宿主健康**：端口 2171 上 `/config` 与 `/state` 均 200，`phase=idle`、未闩锁、占用 3.87%。
5. **`/state.warnings` 仍常驻阈值冲突**，与旧快照 §3 判断一致（配置组合问题，非代码缺陷）。
6. **发现快照 §8 一处自述数字不准**：`HANDOFF.md` §8 写「本文件自身 16792 字符」，
   实测当前文件为 **17634 字符**（`String.length`）。两者都远低于 24000，不影响可用性，
   也不会导致交接被拒；下次重写该文件时按实测值更新即可，**不要为了这一个数字单独重写整份快照**。

---

## 四、仍然悬着的事（与旧快照一致，本轮未推进）

- 真实端到端透传未跑（需用户手动触发，会掐断会话）。
- 设置卡渲染未肉眼确认（需真实点击）。
- 重启后完整迁移未复跑。
- `version` 仍为 `0.2.0`。
- 7 个未提交改动未提交、未推送。
- 阈值冲突未定性（调阈值 或 明确接受警告）。

## 五、环境快照（仅供本次复算，勿当常量抄）

- 工作区：`D:\Workspace\DeepSeek Harness`（**不是 git 仓库、也没有 `package.json`**，只是装多个仓库的容器）
- 会话：`session-badafdee-a1c6-4a29-9c81-04b550fb40cb`
- 预设 standard；模型 `workbuddy/deepseek-v4.1-flash`（窗口 1000000）；权限 `danger-full-access`；Plan 关闭
- 宿主端口：`2171`（每次启动都变）
- Obsidian MCP：本工作区另有 `obsidian` MCP 服务，本轮未使用

---

> 本文件由接手会话（2026-10-31）手工写入，非插件产物；插件不会读取或覆盖它。
