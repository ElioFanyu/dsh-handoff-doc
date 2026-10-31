# 会话交接记录 —— 旧会话传递信息 + 接手后操作明细

> 记录时间：2026-10-31T19:51–20:00（+08:00）
> 记录会话：`session-2e92a320-3f79-4cdb-9bbd-5de03364f472`
> 工作范围：`dsh-handoff-doc`（工作区 `D:\Workspace\DeepSeek Harness`）
> 基线：`main` @ `89e595e7`，版本 `0.2.0`
> 性质：**过程记录与信息留档**。它不是交接文档本身（交接文档是 `docs/handoff/dsh-handoff-doc/HANDOFF.md`），
> 不具备交接文档的有效期语义；下一份交接文档重写时不会自动带上本文件的内容。

## 零、这份文件解决什么问题

旧会话在上下文将满时把状态压成一份 `HANDOFF.md`，本会话接手时只拿到那份快照。快照是**结论**，
不含**过程**。本文件补上快照不承载的两样东西：

1. **旧会话传过来的信息全貌** —— 快照里的结论，以及快照刻意裁掉的来龙去脉，汇总在一处。
2. **本会话接手后实际做了什么** —— 逐条命令、逐条结果、踩到的坑，便于之后复算或追责。

与另外几份文件的分工：

| 文件 | 内容 | 写入方式 |
| --- | --- | --- |
| `docs/handoff/dsh-handoff-doc/HANDOFF.md` | 当下成立、可继续干活的快照 | 每次整份重写 |
| `docs/handoff/dsh-handoff-doc/CHANGELOG.md` | 每版交接的差异摘要 | 只追加（插件自动） |
| `docs/handoff/dsh-handoff-doc/history/<YYYY-MM>.md` | 月度全文归档 | 只追加（插件自动） |
| `docs/record-2026-10-31-handoff-takeover.md` | **上一轮**接手（`session-badafdee`）的过程记录 | 只写一次 |
| **本文件** | **本轮**接手（`session-2e92a320`）的过程记录 | 只写一次，不重写 |

> 上一轮那份记录（`record-2026-10-31-handoff-takeover.md`）**不改动**。它是另一段接手的账，
> 里面「7 个未提交改动 / 441 用例 / 端口 2171」等数字属于那个时点，不能拿来覆盖本文件。

---

## 一、旧会话传递过来的信息

### 1.1 交接链（必须先理清，否则数字对不上）

工作区里已发生过多次交接，快照只写最后一跳，容易误读。实际链条：

| 跳 | 会话 | 产物 | 快照里记的时间 |
| --- | --- | --- | --- |
| 第 1 跳 | 更早的会话 → `session-4ece971d` | `HANDOFF.md` 第 1 版 | 2026-10-31T11:22:18.115Z |
| 第 2 跳 | `session-4ece971d` → `session-badafdee` | 快照 + 手写记录 `record-2026-10-31-handoff-takeover.md` | 2026-10-31T11:50:17.912Z |
| 第 3 跳 | `session-4ece971d` → **本会话** `session-2e92a320` | 本会话读到的 `HANDOFF.md`（`89e595e7`） | 同上（快照未变，只换了接手人） |

本会话拿到的快照顶部写着「本文件对应 HEAD `89e595e7` @ main」。§3「残局」明确记着：
`session-84d6a487` 与 `session-badafdee` 都是**历史继任者**，其产物只作历史参考，
**不要拿它们的结论覆盖快照**。本文件同样遵循这一条：只做汇总，不取代快照。

### 1.2 目标与口径（整条设计线的源头）

用户要的结果：**交接文档是「当下成立的快照」，新会话只读这一份就能继续干活，不读旧对话、不靠猜。**

用户明确过的口径：交接文档交接的是**「当前会话下一步要做的内容」**，不是「会话所在目录里的所有项目」。
上下文将满时，产物必须让新会话无损接手同一件事；把无关项目、已完成过程塞进去，
等于**凭空派活**，并让文件无限膨胀。

这条口径直接派生出：工作范围推断、§0 只列主战场命令、§1 只留未完成项、§8 只留仍需依赖的证据。

### 1.3 快照里仍标「未做完」的验收条目

- 真实端到端透传：在**已工作过的真实会话**里输入 `/handoff 推送 GitHub`，触发后全程不再输入。
  验收四点：指针含「本会话的工作范围：`dsh-handoff-doc`」与「关于附言的范围」、没动其它仓库、
  没有真的 push、产物落在 `docs/handoff/dsh-handoff-doc/` 而非 `docs/handoff/deepseek-harness/`。
- 目录命名：文件真的落在 `docs/handoff/dsh-handoff-doc/`。
- §0 形状：新快照 §0 只列主战场命令，并有一行「本次未涉及」。
- 设置卡渲染肉眼确认：设置 → 通用 → Advanced 能看到「文档输出上限」与「交接文档上限（字符）」；
  前者临时改 `4000` 看警告出现，改回 `26000` 后消失。
- 重启后完整迁移复跑：落盘 → 建新会话 → 投指针，全链路真跑一次。
- 发版：`version` 仍是 `0.2.0`，多次功能变更未 bump。
- 阈值冲突定性：调阈值 或 明确接受那条常驻警告。

### 1.4 关键机制事实（结论层，照抄自快照 §2）

- **输出目录按「会话实际工作的项目」命名**，不是工作区文件夹名。
  `resolveProject(pinned, cwd, focus)` 优先级：用户 pin 名 > 焦点子项目 > 工作区名。
  焦点由 `focusFromEvents(events, await listSubProjects(files))` 得出，**必须在读 facts 之前算**。
- **工作范围机制**：`work-scope.ts` 扫 `tool/call`，统计子项目目录被点名次数。规则：一次调用只计一次；
  只看 `arguments` / `command` / `path` / `file_path`，**不看 `tool/result`**；
  路径边界匹配（`plugin-a-old` 不算 `plugin-a`，两侧的 `.` 算边界）；
  排除 `ask_user_question` / `job_*`；候选目录来自 `listSubProjects`，不为不存在的目录编造。
- **候选目录判据**：`package.json`、`.git/HEAD`、`README.md` 三者之一。
  （踩过的坑：`dsh-recovery` 有 `.git`、有源码、无 manifest，曾因此消失，导致 281 次调用的交接
  被归档到只被点名 2 次的 `docs/handoff/dsh-connect-volcengine/`。）
- **焦点可信度 `focusLooksWrong`**：焦点调用数占总总量 <10% 且总量 ≥10 判为可疑——含义是
  「候选扫描很可能漏了真项目」，不是「这次没干活」。可疑时指针与 §0 都改口写「无法可靠判定」并撤掉命令清单。短会话豁免。
- **`scopesInPlay` 阈值**：最高分须 ≥2 次调用才算 focus（`FOCUS_FLOOR = 2`）；
  次要项须达 focus 的 25% 且 ≥2 次才算「本次也涉及」。无 focus 返回空数组，退回目录序。
- **范围要改两处，缺一不可**：§0 / §4 的渲染 + **指针消息**（附言里「推送 GitHub」指哪个项目）。
- **`parseDoc` 标题判定（别再放宽）**：`#` 开头为标题；`**短标题**` 必须在行首、粗体 ≤30 字、允许同行带正文；
  编号行（`N. …`）**不单独成立**——先按标题文本匹配已知小节，匹配不上才看编号，且要求编号属于本文件
  并且标题部分 ≤12 字；形似标题但匹配不上的行保留在当前小节内，不丢内容。
- **两个预算口径**，换算常量 `TOKENS_PER_CHAR = 1`（中文一字一 token，不是 0.75）：
  `handoffDocMaxChars` = 最终文件**字符**数（默认 24000，范围 2000–120000）；
  `summaryMaxTokens` = 模型单次可生成 token 数（默认 26000，范围 256–65536）。
  警戒线 `summaryMaxTokens < handoffDocMaxChars`；常量两处生效且必须一致：
  `src/settings.ts#validateSettings` 与 `src/client/protocol.ts#localWarnings`。
- **设置项可见名以 `src/client/card.ts` 的 `Advanced` 行为准**：`summaryMaxTokens` =「文档输出上限」，
  `handoffDocMaxChars` =「交接文档上限（字符）」。
- **文档骨架由代码定义**：`DOC_SECTIONS` 管十节标题与写作要求，`REQUIRED_SECTIONS` 管必需小节，
  `REQUIRED_HEADINGS` 由它派生。必需小节是 §0/§1/§2/§4/§6/§8，缺一即拒。
- **截断识别**：`llm.stream` 的 `finish` 事件 `reason.kind === 'length'` 表示被 `maxTokens` 截断，
  与 `error` / `aborted` 分开处理。
- **归档幂等**：`archivePrevious` 用内容哈希 `content:<16 hex>` 判重，先归档后覆盖；
  缺必需小节时 `writeHandoff` 提前返回（`archived:false`），不归档、不污染 CHANGELOG。
- **磁盘写唯一入口** `workspace-fs.ts`：`relative()` 判越界、临时文件 + `rename` 原子落盘。
- **安装形态**：`~/.dsh/profiles/desktop/node_modules/dsh-handoff-doc` 是 `link:` 指向源码，
  `tsdown` 产出 `lib/index.js` 后安装副本立即一致，无需重装；**宿主侧改动必须重启宿主**才生效。
- **三份文件分工**：`HANDOFF.md` 每次整份重写、`CHANGELOG.md` 只追加、`history/<YYYY-MM>.md` 月度全文。
- **完整事件日志**在 `~/.dsh/sessions/--D-Workspace-DeepSeek~0020Harness--/<sessionId>/session.v4.jsonl.zstd`；
  `~/.dsh/storages/session_projcache/sessions/*.json` 只有投影行、**没有 `tool/call`**，不能用来验 scope。

### 1.5 旧会话标出的卡点

- **真实端到端透传未做**：`POST /handoff` 不接受 `instruction`，必须在输入框敲 `/handoff <正文>`；
  真跑会迁移当前会话。必须在**已工作过的会话**上做（空会话没有 `tool/call`，scope 为空）。
  **用户已选择自己手动跑，不要代替他触发。**
- **设置卡浏览器渲染未肉眼确认**：只有 `state.warnings` 数据源实证，无截图、无真实点击。
- **重启后完整迁移未复跑**：idle、端口、产物一致性已验；真实迁移会掐断当前会话。
- **阈值配置自相矛盾（配置项，不是代码缺陷）**：profile 里 `autoHandoffAtContextPercent=40`、
  `autoCompactAtContextPercent=60`、`autoCompactEnabled=true`，于是 `/state.warnings` 常驻
  「压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。」
  `autoHandoffEnabled=false` 时只是警告；**一旦开启自动交接，压缩 60% 高于交接 40%，压缩刚结束就会立刻触发交接**。
  要开自动交接，先把压缩阈值降到 40 以下，或把交接阈值提到 60 以上。
- **重复交接守卫只在内存里**：`newSessions` 是 `Coordinator` 私有 Map，宿主重启即清空。
  能挡「同一进程内第二次 `/handoff`」，挡不住「交接 → 重启 → 再交接」。
  **别把 `newSessionId === undefined` 当成「没交接过」的证据。**
- **残局：两个并存的历史继任者** `session-84d6a487` / `session-badafdee`，均非当前活跃继任者。

### 1.6 已否决的方案（上一轮 25 条 + 快照新增，按主题归并，别再试）

- **归因错误**：把「缺 §4」归因为「没收到 finish chunk」/「预算不够」/「推理吃预算」（全错，白改三轮，真因是解析器）；
  把「调大 `summaryMaxTokens`」当缺节的解药（因果错误）。
- **解析器放宽**：接受任意以 `**` 开头的行作标题（§4 正文被整行吞掉）；编号行只凭数字成标题。
- **范围判定**：用工作区文件夹名做交接目录；只修 §0 不修指针；用存在性判断决定「是否涉及」；
  扫描 `tool/result`；按调用次数排序全部子项目；只扔候选清单不承认扫描可能不全；
  用 `package.json` 作为「是不是项目目录」的唯一标志；用 `session-*.json` 验工作范围；
  把工作范围计数当可人工复算的确定值（要复核就用 `readWorkScope` 本身）。
- **产物与投递**：把整份简报当消息投递；让模型自己控制长度 / 从 §0 顺序写到 §9；
  在提示词里手写一遍必需小节清单；把 `/handoff` 未知参数当语法错误拒绝；
  把指令写进文档正文（属于指针消息）；把所有兄弟项目 check 都写进 §0 / 按目录序取前 3 条命令。
- **流程**：在全新空会话里验端到端透传；在 handoff 进行中往会话里发消息（含「继续」）；
  在会话进行中代替用户触发 `/handoff`；把 `archiveSourceAfterHandoff: false` 当故障去改。
- **环境**：用 `lib/client.js` 在 Node 里跑 `localWarnings`（`window is not defined`）；
  探针放 `/tmp` 并相对 import（`ERR_MODULE_NOT_FOUND`）；把宿主 `/api/*` 的 401 当插件故障；
  用字符串前缀判路径越界；在 `apply()` 里快照服务引用；用 `node -e` 改含中文与反斜杠的 TS；
  用 `| head -c` 判 curl 成功；用 `wc -c` 判 24000；用 HTTPS remote 推 GitHub（`CRYPT_E_REVOCATION_OFFLINE`）；
  把文档里写死的会话 id / 端口当当前值。
- **脱敏**：把 `env-assignment` 当成「名字里有 TOKEN 就当密钥」——原规则对 `TOKENS_PER_CHAR = 1`
  这类常量赋值也命中并把值吞到行尾。修法：值须 ≥8 个 ASCII 字符且不含空白/中文标点。已加回归测试，别再放宽。
- **路径边界**：只把 `.` 加进 `namesDirectory` 的前边界（只修前边界仍会漏，两侧都放行才是当前实现）。

### 1.7 旧会话的硬约束（本会话照办的部分）

- 不在会话进行中代替用户触发 `/handoff`。
- 不动 `dsh-desktop-bridge`、`dsh-obsidian`（本次未涉及的两个项目）。
- 不写 profile 目录；不把 `archiveSourceAfterHandoff: false` 改回 `true`。
- 不从工作区根 `git push`（根不是仓库）；用 SSH remote。
- 交接被拒时先读 `docs/handoff/.dsh-handoff-doc.raw.md`，再判断是模型问题还是解析问题。

---

## 二、本会话接手后所做的全部操作

时间窗：2026-10-31T19:51–20:00（+08:00）。工作目录 `D:\Workspace\DeepSeek Harness`。
**没有触发 `/handoff`、没有改源码、没有删改任何既有文档**（只新增本文件）。

### 2.1 读取顺序：只读 §0，没有整份通读

按交接要求：先读 §0「30 秒自检」并按里面的命令跑；通过后读 §2 / §3 / §4。
因附言要写「旧会话传递过来的信息」，才按需补读 §5–§8 与 §1，**始终没有一次性通读全文**。

| 步骤 | 动作 |
| --- | --- |
| 1 | 读 `HANDOFF.md` 第 1–120 行（§0–§4 前半） |
| 2 | 读第 121–244 行（§4 后半–§10） |
| 3 | 读既有记录 `docs/record-2026-10-31-handoff-takeover.md`（全 311 行，作为旧信息源） |

### 2.2 §0 自检（结果：通过，未过期）

| 检查项 | 命令 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| HEAD | `git log --oneline -3` | `89e595e` | 与文档一致 |
| 分支 | `git branch --show-current` | `main` | 一致 |
| 脏文件面 | `git status --porcelain` | 11 个 `M` + 1 个 `??` | 与 §3 的「12 个未提交改动」一致（其中 11 个改动 + 1 个未跟踪记录文件） |
| 远端 | `git ls-remote origin main` | `89e595e7fa1a933e9d20f63d9fae8c47243110ee` | 与本地 HEAD 相同，说明未提交改动一个都没推上去 |
| 全量检查 | `npm run check` | 23 文件 / **453** 用例全绿；`Build complete` ×2；exit 0 | 与 §0 关键数字完全一致 |

**结论：交接文档有效，可以继续干活。**

`npm run check` 展开为 `typecheck && test && build`（来自 `package.json#scripts.check`）。
build 阶段两次 `Build complete`：`[CJS] lib\client.js 39.95 kB`（502ms）与
`[ESM] lib\index.js 213.53 kB + index.d.ts 15.80 kB`（551ms）。

### 2.3 改动面盘点

`git status --porcelain` 的 12 项：

```
 M package.json
 M src/coordinator.ts
 M src/handoff-doc.ts
 M src/handoff-writer.ts
 M src/project-facts.ts
 M src/redaction.ts
 M src/work-scope.ts
 M tests/unit/coordinator.spec.ts
 M tests/unit/project-facts.spec.ts
 M tests/unit/summary.spec.ts
 M tests/unit/work-scope.spec.ts
?? docs/record-2026-10-31-handoff-takeover.md
```

`git diff --numstat`（合计 **638 insertions / 40 deletions**，比上一轮记录的 314/23 又长了一截）：

| 文件 | + | − |
| --- | --- | --- |
| `package.json` | 2 | 5 |
| `src/coordinator.ts` | 28 | 0 |
| `src/handoff-doc.ts` | 208 | 25 |
| `src/handoff-writer.ts` | 2 | 0 |
| `src/project-facts.ts` | 35 | 1 |
| `src/redaction.ts` | 10 | 1 |
| `src/work-scope.ts` | 50 | 2 |
| `tests/unit/coordinator.spec.ts` | 32 | 0 |
| `tests/unit/project-facts.spec.ts` | 24 | 3 |
| `tests/unit/summary.spec.ts` | 203 | 2 |
| `tests/unit/work-scope.spec.ts` | 44 | 1 |

> 与上一轮记录的差异：上一轮是 7 个文件 / 314+ / 23−，本轮是 11 个改动 / 638+ / 40−。
> 多出来的部分来自上一轮之后的新增工作（`coordinator.ts` 的重复交接守卫、
> `handoff-doc.ts` 的 §9 待决策通道与 `stripSelfSize`、`package.json` 的 R16/R7 收拾），
> 以及 `tests/unit/coordinator.spec.ts` 这个新增改动。**别把两轮的数字混用。**

`git log --oneline -8`（11 条历史中最新 8 条）：

```
89e595e fix: 解析器把 §4 正文的粗体列表项当成标题，导致 §4 被判为空
ee3465a fix: 缺节时记录结束原因与原始输出，不再猜是预算问题
30a4172 fix: token/字符换算按中文改为 1:1，默认输出上限提到 26000
ace230c feat: 失败消息带可折叠详情，同时保留日志与 /last-error
de4457f feat: 失败时写日志文件，并提供 /last-error 取完整错误
423b0ab fix: 截断检测在真实宿主上从未生效，且缺节不再误报为「模型没写完」
fe3e92f feat: 交接目录按会话实际工作的项目命名，并禁止写已完成内容
433ae43 fix: 指针消息带上工作范围，附言里的「推送 GitHub」不再指错仓库
```

最新提交时间：`2026-10-31 15:10:59 +0800`。

### 2.4 端口探测（上一轮记的 2171 已失效）

快照明确写「宿主端口每次启动都变」，本轮实测确认：

| 端口 | `/dsh-handoff-doc/config` | 说明 |
| --- | --- | --- |
| `6738` | **200** | 当前宿主（URL 由运行环境给出） |
| `2171` | `000` | 上一轮记录的端口，本次无监听 |
| `2172` | `000` | 无监听 |

> 探测时用 `curl -s -o /dev/null -w "%{http_code}"` 拿到了 `000`，但 `for` 循环最后一条是 000，
> 整条命令因此返回 exit 7。**这是 curl 的「连接失败」退出码，不是脚本错误**；
> 判断插件是否可用要看 `-w` 输出的状态码，不要看外层 exit code。

### 2.5 活宿主读数（端口 6738，本会话 id）

`GET /dsh-handoff-doc/config` → 200，`settings` 字段实读：

```
summaryMaxTokens=26000           handoffDocMaxChars=24000
autoHandoffEnabled=false         autoHandoffAtContextPercent=40
autoCompactEnabled=true          autoCompactAtContextPercent=60
archiveSourceAfterHandoff=false  openNewSessionOnHandoff=true
handoffDir=docs/handoff          handoffProjectFolder=""
archivePreviousHandoff=true      reusePreviousHandoff=true
autoHandoffTrigger=context       autoHandoffThreshold=2000000
maxAutoActionsPerSession=3       evaluateIntervalMs=5000
```

> 坑：这个接口返回的是 `{"ok":true,"settings":{…}}`，**字段在 `settings` 下面**，
> 直接按顶层 key 取值会全是 `undefined`（本轮第一次就踩了，第二次修正）。

`GET /dsh-handoff-doc/state?sessionId=session-2e92a320-…` → 200：

```
phase=idle  busy=false  latched=false  waitingForStep=false  cancelRequested=false
occupancy: estimated, used=42796, window=1000000, percent=4.28%
cumulative: tokens=268289, source=projection, quality=exact
thresholds: handoffPercent=40, compactPercent=60, cumulative=2000000, enabled=false, compactEnabled=true
persistence=durable  autoActions=0  maxAutoActions=3  openNewSession=true
warnings: ["压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。"]
```

结论：宿主存活、插件已加载、协调器空闲且未闩锁。**`/state.warnings` 仍常驻阈值冲突，
与快照 §3 的定性一致（配置组合问题，非代码缺陷）。**

### 2.6 文档与产物盘点（字符数用 `String.length`，不是字节）

| 文件 | 字符 | 字节 | 行 |
| --- | --- | --- | --- |
| `docs/handoff/dsh-handoff-doc/HANDOFF.md` | **18517** | 31961 | 245 |
| `docs/record-2026-10-31-handoff-takeover.md` | 13277 | 22840 | 312 |
| `docs/fix-2026-10-31-section4-matrix.md` | 2986 | 5194 | 95 |

- 快照 `HANDOFF.md` 为 18517 字符，**低于 `handoffDocMaxChars = 24000`**，可用。
  注意上一轮记录实测是 17634 字符、快照 §8 自述 16792——**三个数字都对不上，且都在预算内**。
  这说明「文件自身大小」这类自述数字不可信也不重要；**不要为它单独重写快照**。
- `git ls-files docs` → 仓库内只有 `docs/fix-2026-10-31-section4-matrix.md` 被跟踪；
  `docs/record-2026-10-31-handoff-takeover.md` 至今**未跟踪**（本轮一并提交）。
- **两个 `docs/` 不是同一个目录，容易看错**：
  - 仓库内的 `dsh-handoff-doc/docs/` —— 只放了 `fix-*.md` 与手写记录，可以提交。
  - 工作区根的 `D:\Workspace\DeepSeek Harness\docs\handoff\` —— 交接产物在这里，
    **在仓库之外**，根本不在 `dsh-handoff-doc` 的版本控制范围内
    （`git check-ignore -v docs/handoff` 返回 1，说明它不是被忽略，而是路径压根不在仓库里）。
  - 所以「提交 GitHub」不可能把这批交接产物带上，也不需要为它们加 `.gitignore`。
- 仓库 `.gitignore` 只忽略 `node_modules/`、`lib/`、编辑器垃圾、`*.tsbuildinfo`。

### 2.7 测试目录状态

`ls tests/manual/` → `preview.ts`、`probe-hang2.mjs`、`probe-idle.mjs`、`repro-hang.ts`、
`schema-check.mjs`、`write-workspace-doc.ts`——**没有任何 `.spec.ts` 残留**，
所以 vitest 计数是干净的 23 文件 / 453 用例（若残留探针会变成 34/466）。

`ls tests/**/*.spec.ts | wc -l` → 23，与测试输出一致。

### 2.8 本会话的操作边界

- 未执行 §4 第一条（端到端透传）：需用户手动在真实会话敲 `/handoff`，且会掐断当前会话。
- 未改阈值、未改版本号、未改任何源码或既有文档。
- 未触碰 `dsh-desktop-bridge`、`dsh-obsidian`、`docs/handoff/dsh-connect-volcengine/`。
- 未读原会话完整事件日志（zstd JSONL）：环境无 `zstd` 可执行文件；要复算 scope 走 `readWorkScope`。

### 2.9 附言触发的后续动作（写完本文档之后）

附言要求「创建文档保存…所有操作…然后提交 GitHub」，所以写完之后继续做了提交与推送，
并按「HEAD 一变就失效」的规则重写了交接文档。按时间顺序：

1. **先问范围再动手**：仓库里除本文档外，还有 11 个已改未提交的源码/测试文件（`638+/40−`）。
   提交范围会直接改变推上去的内容，**没有猜**，用 `ask_user_question` 问了三选一。
   用户选择 **「文档 + 那 11 个改动一起提交」**。
2. **`git add -A` → 复核 staged**：13 项（11 改 + 2 新增文档），合计 `1313+/40−`，
   `lib/`、`node_modules/` 没有被带进来。
3. **拆成两笔提交**（`git reset` 后分组 `add`）：
   - `96709ec fix: 收紧范围判定与解析健壮性，补齐 §9 待决策通道` —— `package.json` + `src/` + `tests/`
   - `3e74e96 docs: 补记两轮会话交接的过程记录` —— `docs/`（两份手写记录，含此前从未入库的 takeover 记录）
   理由：源码改动与文档记录是两件事，混一笔以后不好回滚、也不好 blame。
4. **提交后复跑 `npm run check`** → 仍 23 文件 / 453 用例、`Build complete` ×2、exit 0。
   即「提交进去的确实是过检查的版本」。
5. **推送**：`GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push origin main` → `89e595e..3e74e96  main -> main`。
6. **核对远端**：`git ls-remote origin main` = `3e74e96b645338e05206b46732bfe208265e1659`，与本地 `HEAD` 一致。
7. **重写交接文档**：HEAD 从 `89e595e7` 变 `3e74e96b`，按交接文件自己的有效期规则（「HEAD 变化即失效，
   必须整份重写，不得追加」）已失效。问过用户，用户选「现在就重写」，于是**整份重写**（非追加）：
   - 版本行改 `v0.2.0 · 3e74e96b`；§3 删掉「12 个未提交改动」这条卡点（现已干净）；
     §8 把「未提交改动是否可推」换成已推送证据，并记录字符数漂移这个坑。
   - 新增两条实操坑：`/config` 字段在 `settings` 子对象下；不能拿 curl 的 exit code 判端口可用。
   - 新增「两个 `docs/` 是不同目录」这条事实。
8. **验证重写后的文件本身**：按 §4 要求在 `tests/manual/` 写临时探针跑 `parseDoc` + `missingRequired`
   → **11/11 节全解析、`missingRequired` 为空、19396 字符 < 24000**。探针用完即删，
   删后复跑 vitest 仍 23 / 453，基线未被污染。

**本轮踩到的坑（都记下来，别再踩）**：

- 探针第一版写 `Object.keys(DOC_SECTIONS)`，结果 `sections=0/11` 而 `missing=none`——
  `DOC_SECTIONS` 是**数组**不是对象，要用 `DOC_SECTIONS.map(s => s.key)`。
  `sections=0` 与 `missing=none` 同时出现，就是「两边都没对上却互相掩盖」的错；
  **看到 `0/N` 先怀疑探针本身，别急着怀疑文档。**
- 探针传相对路径时 `vite-node` 把 cwd 解析成 `D:\Workspace\docs\…`（少了 `DeepSeek Harness` 一层），
  报 `ENOENT`。**传绝对路径。**
- `git check-ignore -v docs/handoff` 返回 1 曾被误读成「被忽略」，实际是「路径不在仓库里」。
  两者结论完全不同，要靠 `git ls-files` 交叉确认。
- `for` 循环探端口时最后一条是 `000`，整条命令 exit 7（curl 连接失败码），
  看着像脚本挂了，其实是预期结果。

---

## 三、本轮新增的结论

1. **交接文档仍然有效**：HEAD、脏文件面、测试基线（453）、远端 HEAD 四项全部对得上，未过期。
2. **端口已换代**：从上一轮的 `2171` 变成 `6738`，再次印证「端口每次启动都变，不要抄文档里的值」。
3. **`/config` 的字段在 `settings` 子对象下**，不在顶层——本轮新增的实操坑，已记入。
4. **改动面已扩大到 11 个文件 / 638+/40−**（上一轮是 7 / 314+/23−），比快照 §3 的 12 项计数更细。
5. **快照 §8 的自述大小第三次对不上**（自述 16792 / 上轮 17634 / 本轮 18517），三者都远低于 24000，
   不影响可用性，也不该触发重写。
6. **两个 `docs/` 是不同目录**：仓库内的 `dsh-handoff-doc/docs/` 才归版本控制；
   工作区根的 `docs/handoff/` 在仓库之外，交接产物从未也无需入库。
7. **已提交并推送**：两笔提交 `96709ec`（源码）+ `3e74e96`（文档），远端 `main` 已推进到 `3e74e96b`，
   工作区干净。交接文档因 HEAD 变化已按规则整份重写并复验通过（19396 字符 / 11 节 / 零缺失）。

## 四、仍然悬着的事（与快照一致，本轮未推进）

- 真实端到端透传未跑（需用户手动触发，会掐断会话）。
- 设置卡渲染未肉眼确认（需真实点击）。
- 重启后完整迁移未复跑。
- `version` 仍为 `0.2.0`。
- 阈值冲突未定性（调阈值 或 明确接受警告）。
- 重复交接守卫仍未跨重启。

## 五、环境快照（仅供本次复算，勿当常量抄）

- 工作区：`D:\Workspace\DeepSeek Harness`（**不是 git 仓库、也没有 `package.json`**，只是装多个仓库的容器）
- 仓库：`dsh-handoff-doc`，remote `origin git@github.com:ElioFanyu/dsh-handoff-doc.git`（SSH）
- 会话：`session-2e92a320-3f79-4cdb-9bbd-5de03364f472`
- 宿主：`http://127.0.0.1:6738`（每次启动都变）
- 预设 standard；模型 `workbuddy/deepseek-v4.1-flash`（窗口 1000000）；权限 `danger-full-access`；Plan 关闭
- Node `v26.13.0`；tsdown `v0.22.14`

---

> 本文件由接手会话（`session-2e92a320`，2026-10-31）手工写入，非插件产物；插件不会读取或覆盖它。
