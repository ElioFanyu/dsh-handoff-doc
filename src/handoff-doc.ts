/**
 * The handoff DOCUMENT, instead of the handoff MESSAGE.
 *
 * ## What changed, and why
 *
 * The previous design (`dsh-session-handoff`) rendered one long brief and pasted
 * it into the successor session as its first message. Two problems showed up in
 * real use:
 *
 * 1. **The successor reads for minutes and still does not know what is true.**
 *    A message is prose. It has no expiry, no "this is still valid" marker, and
 *    nothing that stops section 3 ("what is done") from contradicting section 8
 *    ("what is left"). The successor cannot tell a fact from a history lesson,
 *    so it re-derives everything from the log — which is the cost the handoff
 *    was supposed to remove.
 * 2. **It can only grow.** A message has nowhere to put "this was true last
 *    week". Every handoff appends, so the next successor reads the sum of every
 *    previous handoff.
 *
 * This module produces a *file* with a fixed skeleton, a validity window, and a
 * hard rule that it holds only what is still true. History is pushed out to
 * `CHANGELOG.md`, so the document is a snapshot rather than an accumulation.
 *
 * ## The division of labour
 *
 * - **Facts** (cwd, project, script commands, model, occupancy, git state) are
 *   read by this process. The model never restates them, because a model
 *   summarizing its own configuration is a model guessing. They land in §0 and
 *   §6.
 * - **Narrative** (goal, constraints, current facts, blockers, next step,
 *   rejected options, verified/unverified) is written by the outgoing session's
 *   model from the transcript. No program can derive it.
 * - **Budget** is enforced here, not by the model. A model asked to "be brief"
 *   is not a mechanism; `fitToBudget` is.
 *
 * ## Why the skeleton is code, not prompt text
 *
 * The nine-or-ten section headings are a contract with the *successor*, which
 * is told to read §0 first and stop if the document is stale. If the headings
 * were left to the model, a model that invented an eleventh section or dropped
 * §0 would still produce a "successful" handoff whose successor cannot navigate
 * it. Here the headings are constants, the model fills bodies, and a document
 * missing required sections is rejected before any session is created.
 */
import { redactWithReport } from './redaction.ts'
import { focusLooksWrong, scopesInPlay, type WorkScope } from './work-scope.ts'

/** One section of the document: a stable key, the heading, and what goes in it. */
export interface DocSection {
  readonly key: DocSectionKey
  /** `## n. 标题` as rendered. The number is part of the contract. */
  readonly heading: string
  /** Prompt wording: what belongs here, and what must not. */
  readonly instruction: string
  /** True when an empty body is a defect rather than an honest "none". */
  readonly required: boolean
}

export type DocSectionKey =
  | 'selfcheck'
  | 'goal'
  | 'facts'
  | 'blockers'
  | 'next'
  | 'constraints'
  | 'files'
  | 'rejected'
  | 'verified'
  | 'decisions'
  | 'history'

/**
 * The document skeleton, in order.
 *
 * §0 exists because it decides whether the successor reads any further: five
 * lines that say how to check the project and whether the snapshot is still
 * good. A document that starts with "总体目标" forces a full read before the
 * successor can decide it is stale.
 *
 * §9 is a pointer, never content. It is the mechanism that stops the document
 * from growing: history has a home, and it is not here.
 */
export const DOC_SECTIONS: readonly DocSection[] = [
  {
    key: 'selfcheck',
    heading: '## 0. 30 秒自检',
    instruction:
      '程序已经把「命令 + 预期」填在下面了，**不要再抄一遍命令**。'
      + '你只需要补充程序读不到的部分：需要哪些服务/端口/环境变量、跑完应该看到什么关键数字、'
      + '哪一条失败时优先怀疑什么。没有补充就写「无补充」。',
    required: true,
  },
  {
    key: 'goal',
    heading: '## 1. 目标与验收',
    instruction:
      '用户要的最终结果（尽量贴用户原话），以及「怎么算做完」的验收条目，每条可勾选。'
      + '不要写已经完成的过程。',
    required: true,
  },
  {
    key: 'facts',
    heading: '## 2. 当前有效事实',
    instruction:
      '现在仍然成立的架构、口径、参数、路径约定、数据结构。'
      + '判断标准：只写「今天仍然为真」的；凡是「上周改成了…」这种带时间的过程描述，一律不写。',
    required: true,
  },
  {
    key: 'blockers',
    heading: '## 3. 卡点与阻塞',
    instruction: '现在挡住进展的具体问题：报错原文、缺什么、等谁。没有就只写「无」。不要写已解决的坑。',
    required: false,
  },
  {
    key: 'next',
    heading: '## 4. 下一步 + 验证映射',
    instruction:
      '下一条具体动作，以及「改什么 → 必跑什么」的对应关系（改前端跑什么、改后端跑什么）。'
      + '每条都要能被直接执行，不要写「继续完善」这种空话。',
    required: true,
  },
  {
    key: 'constraints',
    heading: '## 5. 硬约束 / 禁忌',
    instruction: '不能碰的东西：不许改的文件、不许引入的依赖、不许用的接口、必须保持的兼容性。',
    required: false,
  },
  {
    key: 'files',
    heading: '## 6. 文件地图',
    instruction:
      '每个文件/目录一行：路径 → 它负责什么。只写职责，不要写行号（行号第二天就过期）。',
    required: true,
  },
  {
    key: 'rejected',
    heading: '## 7. 已否决方案 + 原因',
    instruction:
      '试过并且失败的路，以及为什么失败。写清楚「别再试这个」，否则下一个人会重试一遍。',
    required: false,
  },
  {
    key: 'verified',
    heading: '## 8. 已验证 vs 未验证',
    instruction:
      '分两栏。已验证的写证据（跑过的命令、看到的结果）；未验证的写「怎么验证」。'
      + '不许把「看起来应该没问题」写进已验证。',
    required: true,
  },
  {
    key: 'decisions',
    heading: '## 9. 待用户决策',
    instruction:
      '「已经想好要改、但还没得到用户批准」的事项，一条一行，写明：改什么、为什么、影响范围、'
      + '以及不做的后果。**继任者必须先问用户，不得自行执行。** 没有就只写「无」。'
      + '不要把已批准或已完成的改动写在这里。',
    required: false,
  },
  {
    key: 'history',
    heading: '## 10. 历史',
    instruction: '只写一行指针，指向归档文件。不要在这里写任何历史内容。',
    required: false,
  },
]

/** Sections whose emptiness makes the document unusable, by key. */
export const REQUIRED_SECTIONS: readonly DocSectionKey[] = DOC_SECTIONS.filter(
  (section) => section.required,
).map((section) => section.key)

/**
 * The headings of those sections, for the prompt.
 *
 * Derived rather than typed out so the prompt cannot drift from
 * {@link REQUIRED_SECTIONS}: adding a required section updates both the
 * validator and the "write these first" rule in one edit.
 */
export const REQUIRED_HEADINGS: readonly string[] = DOC_SECTIONS.filter(
  (section) => section.required,
).map((section) => section.heading.replace(/^##\s*/, ''))

/**
 * How many required sections must carry real content.
 *
 * All of them, unlike the old brief's "at least 3 of 9". The old rule was a
 * compromise with a model that had only been shown configuration facts; here
 * the model is shown the transcript AND told exactly what each section is for,
 * and a document missing §2 or §4 is not a weaker handoff — it is a document
 * whose successor must redo the work. Refusing early is cheaper than a
 * successor that discovers the gap after creating a session.
 */
export const MIN_REQUIRED_FILLED = REQUIRED_SECTIONS.length

/** Narrative as returned by the model, keyed by section. */
export type DocNarrative = Partial<Record<DocSectionKey, string>>

/**
 * Program-read facts about the project and the session.
 *
 * Everything here is observable, so none of it is left to the model. `project`
 * and `commands` in particular are what make §0 useful: "run npm test" is only
 * a self-check if something established that `npm test` exists and what it
 * covers.
 */
export interface DocFacts {
  /** The project this document is about; also the folder name under the root. */
  readonly project: string
  readonly cwd: string | undefined
  /** Verification commands found on disk, most specific first. */
  readonly commands: readonly ProjectCommand[]
  readonly stack: readonly string[]
  /**
   * Sub-projects the session worked in, most-worked first.
   *
   * Empty for a single-project workspace (the root manifest case), where there
   * is nothing to rank and every command is equally in scope.
   */
  readonly scope?: readonly WorkScope[]
  readonly agentPreset: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly contextWindow: number | undefined
  readonly permissionPreset: string | undefined
  readonly permissionError?: string
  readonly planMode: 'on' | 'off' | 'unknown'
  readonly turnCount: number
  readonly occupancyPercent: number | undefined
  readonly occupancyQuality: 'exact' | 'estimated' | 'unavailable'
  /** Branch and HEAD, when the project is a git work tree. */
  readonly git?: GitFacts
  readonly sourceSessionId: string
  readonly createdAt: number
  /** Unanswered question or trailing assistant message, program-detected. */
  readonly pendingInput?: PendingInputFacts
}

/** One runnable command found in the project, with what it is expected to prove. */
export interface ProjectCommand {
  /** The exact shell line, e.g. `npm run check`. */
  readonly command: string
  /** Where it came from: `package.json#scripts.check`, `Makefile`, … */
  readonly origin: string
  /** What passing it establishes, in the words of the source when available. */
  readonly proves: string
  /**
   * The command's own definition, when the source has one.
   *
   * Kept apart from `proves` so the matrix can stay one line per command while
   * §0 still shows what the script actually does. Concatenating the two into
   * one string produced a sentence with two parentheticals and no way to
   * shorten it without losing the evidence.
   */
  readonly definition?: string
}

/** Git state that changes what "the current state" means. */
export interface GitFacts {
  readonly branch: string | undefined
  readonly head: string | undefined
  readonly dirty: boolean
  readonly changedFiles: number
}

/** See `session-summary.ts`'s `PendingInput`; the same two certainties apply. */
export interface PendingInputFacts {
  readonly kind: 'question' | 'unanswered-assistant'
  readonly detail?: string
}

/** Where the document and its archive live, relative to the workspace. */
export interface DocPaths {
  /** `docs/handoff` by default. */
  readonly root: string
  /** `<root>/<project>/HANDOFF.md` */
  readonly document: string
  /** `<root>/<project>/CHANGELOG.md` */
  readonly changelog: string
  /** `<root>/<project>/history/YYYY-MM.md` */
  readonly historyOf: (month: string) => string
}

/** Derive the three paths from the configured root and the project slug. */
export function docPaths(root: string, project: string): DocPaths {
  const base = `${trimSlashes(root)}/${project}`
  return {
    root: trimSlashes(root),
    document: `${base}/HANDOFF.md`,
    changelog: `${base}/CHANGELOG.md`,
    historyOf: (month: string) => `${base}/history/${month}.md`,
  }
}

function trimSlashes(path: string): string {
  return path.replace(/^[./\\]+/, '').replace(/[/\\]+$/, '')
}

/** The ISO month used for history rotation. */
export function monthOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7)
}

/**
 * Turn a workspace path into a folder name a human recognises.
 *
 * The folder must answer "which project does this apply to" at a glance, so it
 * is the last path segment, lowercased and slugified. A path that yields
 * nothing usable falls back to `workspace` rather than producing `//` or an
 * empty segment that would silently write to the root.
 */
export function projectSlug(cwd: string | undefined): string {
  if (cwd === undefined) return 'workspace'
  const normalised = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const last = normalised.split('/').filter((part) => part.length > 0).at(-1) ?? ''
  // A drive root (`D:`) or a single letter is not a project name.
  if (/^[a-z]:$/i.test(last)) return 'workspace'
  const slug = last
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length === 0 ? 'workspace' : slug
}

/**
 * The document's header block.
 *
 * Two lines do the work: the version/date line, which the successor compares
 * against the current commit, and the validity line, which says when this stops
 * being true. Both are program-rendered — a model asked to remember its own
 * expiry date is a model inventing one.
 */
export function renderHeader(facts: DocFacts, version: string): string {
  const date = new Date(facts.createdAt).toISOString().slice(0, 10)
  const validUntil = validityOf(facts)
  return [
    `# 交接 —— ${facts.project}（${version} / ${date} 最后验证）`,
    '',
    `> 有效期：${validUntil}`,
    '> 只写「现在仍然成立」的内容；过程与历史一律进 CHANGELOG.md，本文件不允许追加。',
    '> 结构固定：先读 §0，自检不过就停下重写本文件，不要继续读下文。',
  ].join('\n')
}

/**
 * The validity sentence.
 *
 * It names a concrete trigger instead of a date, because a date is either too
 * early (rewriting a valid document) or too late (trusting a stale one). The
 * git HEAD is the sharpest available trigger: if HEAD moved, §2 and §8 are
 * probably wrong, and the successor can check it in one command.
 */
export function validityOf(facts: DocFacts): string {
  if (facts.git?.head !== undefined) {
    return `到下一次提交为止（本文件对应 HEAD ${facts.git.head.slice(0, 8)}${
      facts.git.branch === undefined ? '' : ` @ ${facts.git.branch}`
    }）；HEAD 变化即失效，必须整份重写，不得追加。`
  }
  return '到下一次功能变更 / 发版为止。过期必须整份重写，不得追加。'
}

/**
 * The prompt that asks the outgoing model to fill the sections.
 *
 * Written as a specification with an explicit refusal clause, because the
 * failure mode being fixed is not "the model wrote too little" — it is "the
 * model wrote a narrative". The negative rules are the load-bearing part:
 * no history, no line numbers, no "we discussed", no invented verification.
 */
export function buildDocPrompt(input: {
  facts: DocFacts
  transcript: string
  /** What the previous document said, so the model does not restate history. */
  previous?: PreviousDoc | undefined
  /** Character budget for the whole document, so the model can size sections. */
  budgetChars: number
}): string {
  const { facts, transcript } = input
  const factsLine = [
    `项目=${facts.project}`,
    `目录=${facts.cwd ?? '未知'}`,
    `技术栈=${facts.stack.length === 0 ? '未识别' : facts.stack.join('/')}`,
    `模型=${facts.provider ?? '?'}/${facts.model ?? '?'}`,
    `已完成 turn=${facts.turnCount}`,
    facts.git === undefined
      ? '版本控制=非 git'
      : `git=${facts.git.branch ?? '?'}@${(facts.git.head ?? '?').slice(0, 8)}${
          facts.git.dirty ? `（有 ${facts.git.changedFiles} 个未提交改动）` : '（工作区干净）'
        }`,
  ].join('，')

  const commandLines =
    facts.commands.length === 0
      ? ['（项目里没有发现可识别的验证命令，§0 请如实写「尚未建立验证命令」并给出建议）']
      : facts.commands.map((entry) => `- \`${entry.command}\`（来自 ${entry.origin}）→ 证明：${entry.proves}`)

  const lines: string[] = [
    '你要写一份「交接文档」，交给同一工作区里的新会话。',
    '新会话看不到你现在的对话，只会拿到这份文档的路径。文档写得越像规范，接手越快；写得越像回忆录，接手越慢。',
    '',
    '## 硬性规则（违反则整份作废，重新生成）',
    '',
    '1. **只写现在仍然成立的事实。** 判断标准：这句话今天是否为真。凡是「之前是…后来改成…」「我们讨论过…」「第一版曾经…」一律删掉。',
    '2. **本文件是快照，不是日志，每次交接都整份重写。** 历史不进这里，§10 只写一行指向 CHANGELOG.md 的指针。',
    /*
     * The rule the model reliably ignores without being told twice.
     *
     * Writing "done" items feels like progress, and it is the single thing that
     * makes the document grow without bound across handoffs: §1 fills up with
     * ticked acceptance items, §8 fills up with this session's test runs, and
     * the successor pays for all of it on every turn. Finished work is already
     * archived in CHANGELOG.md; repeating it here is duplication, not history.
     */
    '3. **已完成的内容一律不写。** 这条最容易被违反：',
    '   - §1 只写「还没做完的」验收条目。已经打勾的项删掉——它们已完成，继任者不需要再验一遍。',
    '   - §8 的「已验证」只写**继任者仍然需要依赖**的证据（例如「改了 X 必须跑 Y」）；',
    '   - 上一段会话跑过的测试、看过的输出，属于过程，写进 CHANGELOG.md 而不是这里。',
    '   - 判断标准：继任者接手后再读一遍，这条信息还能改变他的动作吗？不能就删。',
    /*
     * The rule above, plus "先写必需小节", is exactly the combination that made
     * a live handoff fail: told to drop completed material, the model also
     * dropped §4 and returned a document that was refused for a missing section.
     * The two rules are not in conflict — deleting §1's ticked items and omitting
     * §4 entirely are different acts — but a model under space pressure will
     * conflate them unless the boundary is drawn explicitly.
     */
    '   - **本条只删内容，不删小节。** 十一个小标题一个都不能少；§4「下一步」永远要写，',
    '     哪怕只是「当前没有待办，接手先跑 §0」。删掉整节会被校验器拒绝，交接直接失败。',
    '4. **不写行号。** 行号第二天就过期。写职责，不写位置。',
    '5. **不编造验证结果。** 只有你真的执行过、并看到输出的，才能写进 §8 的「已验证」；否则写进「未验证」并给出验证方法。',
    '6. **不要用「未知」糊弄。** 对话记录里有线索就必须写出具体内容；只有记录里确实没有时，才写「未知」并说明缺什么。',
    '7. **不写密钥、令牌、密码、连接串的值。** 需要引用时只写键名。',
    /*
     * A document that states its own size is wrong the moment it is written.
     *
     * A live document said "本文件自身 16792 字符" while the file on disk was
     * 17634: the number was measured mid-generation, before archiving and before
     * the program appended its own §0 lines. The successor cannot tell a stale
     * measurement from a real limit, and `fitToBudget` already knows the true
     * size — writing a copy by hand only creates a fact that expires instantly.
     */
    '8. **不要写本文件自身的字符数或大小。** 你不会算对：文件在你写完之后还会被程序追加内容。'
      + '篇幅约束只按第 9 条理解，不要把它写进正文。',
    '9. **§0 必须能直接照做。** 写命令和预期输出，不写「建议先检查一下环境」。',
    '10. **总长控制在约 ' + Math.round(input.budgetChars / 1000) + ' 千字符以内。** 超了会被程序截断，截断发生在你最需要保留的段落上。',
    /*
     * The human's aside often asks for something the document rules forbid
     * ("record everything we did in detail"). The aside outranks §4 of the
     * *pointer*, not the document's own contract, so the prompt has to resolve
     * the collision rather than let the model guess: keep the required sections,
     * drop the process. Stated here because the instruction never reaches this
     * prompt — it only travels on the pointer.
     */
    '   - 若某条要求会让文档变长（例如「详细记录所有操作」），**必需小节优先**：',
    '     先保证十一个标题齐全、§0/§1/§2/§4/§6/§8 各有一句可执行内容，再用剩余篇幅写细节。',
    '     写不完的细节，宁可概括成「详见 CHANGELOG」，也不要牺牲小节完整性。',
    /*
     * Order of operations, stated as a rule rather than a suggestion.
     *
     * The failure this prevents is repeatable: a model writing top-to-bottom
     * spends its length on §0–§3, reaches §4 with nothing left, and stops. The
     * handoff is then refused for a missing required section, so the successor
     * gets no session at all — far worse than a thin document. One line of
     * prompt removes that whole failure mode.
     */
    '11. **先写必需小节，再补可选小节。** 必需小节是：' + REQUIRED_HEADINGS.join('、') + '。',
    '   若篇幅快用完，**先保证这些小节各有一句可执行的内容**，宁可让可选小节只写「无」。',
    '   任何必需小节为空，整份交接会被拒绝、新会话不会建立——这比写得简短更糟。',
    '',
    '## 输出格式',
    '',
    '严格使用下面的标题（`## ` + 编号 + `. ` + 标题），顺序固定，一节都不能少：',
    '',
    ...DOC_SECTIONS.map((section) => `${section.heading}\n（${section.instruction}）`),
    '',
    '## 程序已读到的事实（这些由程序写入文档，你不要重复抄写）',
    factsLine,
    '',
    '可用的验证命令：',
    ...commandLines,
    '',
  ]

  if (input.previous !== undefined) {
    lines.push(
      '## 上一份交接文档的要点（用于判断哪些还需要保留）',
      '',
      '下面是上一份文档的内容。**不要把它的历史部分抄进来**：它里面仍然成立的条目，改写进对应小节；',
      '已经完成或已经失效的条目，直接丢弃（它们已经在 CHANGELOG.md 里了）。',
      '',
      input.previous.text,
      '',
    )
  }

  lines.push(
    '## 对话记录（从旧到新，工具输出已截断）',
    transcript,
    '',
    '现在直接输出文档正文，从 `## 0. 30 秒自检` 开始，不要写任何前言。',
  )

  return lines.join('\n')
}

/** A previous document, as read from disk. */
export interface PreviousDoc {
  readonly text: string
  /** Which month it was archived into, for the pointer in §9. */
  readonly month: string
}

/**
 * Split model output into sections.
 *
 * Tolerant about formatting and strict about keys: a model that writes
 * `### 2. 当前有效事实` or `**2. 当前有效事实**` still lands in the right
 * section, because the failure being guarded against is cosmetic drift, not
 * misclassification. Matching is on the heading *number* first — that is the
 * part a model reproduces reliably — then on the title text.
 */
export function parseDoc(raw: string): DocNarrative {
  const text = raw.replace(/\r\n/g, '\n')
  const byHeading = new Map<string, DocSectionKey>()
  const byNumber = new Map<string, DocSectionKey>()
  const knownNumbers = new Set<number>()
  for (const section of DOC_SECTIONS) {
    byHeading.set(normaliseTitle(section.heading.replace(/^#+\s*/, '')), section.key)
    const number = /^(\d+)\./.exec(section.heading.replace(/^#+\s*/, ''))?.[1]
    if (number !== undefined) {
      byNumber.set(number, section.key)
      knownNumbers.add(Number(number))
    }
  }

  const found = new Map<DocSectionKey, string[]>()
  let current: DocSectionKey | undefined

  for (const line of text.split('\n')) {
    const heading = matchHeading(line)
    if (heading !== undefined) {
      /*
       * A numbered line only opens a section when its text matches a known
       * title, either exactly or as a shortened form of it.
       *
       * §4's body is a numbered list whose items look exactly like section
       * openers (`1. 重启宿主`, `3. 若失败，按这个判据读证据：`). Matching on
       * the number alone is what emptied §4 of a real document, so the number
       * is now only consulted after the title itself failed to match *and* the
       * line is short enough to be a heading rather than a sentence.
       */
      const byTitle = byHeading.get(normaliseTitle(heading.title))
      const key = byTitle ?? matchShortenedNumbered(heading.title, byNumber, knownNumbers)
      if (key !== undefined) {
        current = key
        if (!found.has(key)) found.set(key, [])
        if (heading.remainder.length > 0) found.get(key)!.push(heading.remainder)
        continue
      }
      // A heading we do not know: keep it inside the current section rather
      // than dropping it. Losing content is worse than a stray subheading.
    }
    if (current !== undefined) found.get(current)!.push(line)
  }

  const narrative: DocNarrative = {}
  for (const section of DOC_SECTIONS) {
    const body = found.get(section.key)
    if (body === undefined) continue
    const value = body.join('\n').trim()
    if (value.length > 0) narrative[section.key] = value
  }
  return narrative
}

/** Lowercase, strip numbering, punctuation and whitespace, for heading matching. */
function normaliseTitle(title: string): string {
  return title
    .replace(/^\d+\s*[.、)]\s*/, '')
    .replace(/[*`#]/g, '')
    .replace(/[：:]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * Match `3. 卡点与阻塞` when the title was reworded but the number survived.
 *
 * Deliberately narrow. A numbered list item and a numbered heading are the same
 * shape, so this only fires when the line is short enough to be a title (a
 * sentence is not) *and* its number is one of this document's sections. Without
 * the length cap, `3. 若失败，按这个判据读证据：` would open a new section and
 * cut §4 in half — which is exactly the bug this guards.
 */
function matchShortenedNumbered(
  title: string,
  byNumber: ReadonlyMap<string, DocSectionKey>,
  knownNumbers: ReadonlySet<number>,
): DocSectionKey | undefined {
  const numbered = /^(\d{1,2})\s*[.、)]\s*(\S.*)$/.exec(title)
  if (numbered === null) return undefined
  const number = Number(numbered[1])
  if (!knownNumbers.has(number)) return undefined
  const rest = numbered[2]!.trim()
  // A title, not a sentence: section headings here are a few words.
  if (rest.length > 12) return undefined
  return byNumber.get(String(number))
}

/** Recognise `## 标题`, `### **标题**`, and `**标题**：正文`. */
/**
 * Decide whether a line starts a section.
 *
 * ## Why this is strict about shape
 *
 * Every non-empty line used to be a candidate heading, and any line beginning
 * with `**` was taken as one. That quietly broke §4 of a real document: its body
 * opens with a numbered list whose first item is bold —
 * `1. **重启 dsh 桌面宿主**（…）` — so the first body line was read as a heading
 * titled with the whole sentence. §4's body became empty, the section counted as
 * missing, and the handoff was refused with "模型没有写完必需小节（缺：§4）"
 * while the model had written §4 perfectly.
 *
 * That failure is expensive to diagnose because the error points at the model,
 * the budget, and the reasoning effort — everything except the parser.
 *
 * So a heading must look like a heading:
 *   - `#`-prefixed, or
 *   - `**Bold**` occupying the whole line (optionally followed by a colon), or
 *   - `N. Title` / `N、Title` at the start of a line.
 *
 * A bold run *inside* a sentence no longer qualifies, and neither does ordinary
 * prose. Unknown-but-heading-shaped lines are still kept inside the current
 * section by the caller, so nothing is lost by being conservative here.
 */
function matchHeading(
  line: string,
  knownNumbers: ReadonlySet<number> = new Set(),
): { title: string; remainder: string } | undefined {  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined

  const hashes = /^#{1,6}\s+(.+)$/.exec(trimmed)
  if (hashes !== null) {
    const title = hashes[1]!.trim()
    return title.length > 0 ? { title, remainder: '' } : undefined
  }

  /*
   * `**标题**` must start the line, and what follows it is body text.
   *
   * `**1. 目标与验收**：做一个插件` is a heading with its first line inline —
   * models write this and it is unambiguous. But `1. **重启宿主**（说明）` is a
   * numbered list item whose emphasis happens to come first, and reading that as
   * a heading is what emptied §4 of a real document. The distinguishing feature
   * is the leading number: a heading's own numbering comes *before* the bold run.
   */
  const bold = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/.exec(trimmed)
  if (bold !== null) {
    const title = bold[1]!.trim()
    const remainder = (bold[2] ?? '').trim()
    /*
     * Length is the discriminator between a title and an emphasised sentence
     * fragment. Section titles here are a handful of characters; a bolded run
     * that long is prose, and treating it as a heading would silently close the
     * section it appears in — which is exactly how §4 disappeared.
     */
    if (title.length > 0 && title.length <= 30) return { title, remainder }
    return undefined
  }

  /*
   * `N. 标题` is never accepted on its own.
   *
   * §4's body is a numbered list, and its items look exactly like section
   * openers: `1. 重启宿主`, `3. 若失败，按这个判据读证据：`. No length or shape
   * test separates those from `3. 卡点与阻塞`, so a numbered line only becomes a
   * heading when its text also matches a known section title (the caller checks
   * that). Guessing from the number alone is what shredded §4 of a real
   * document.
   */
  return undefined
}

/** Which required sections are still empty. */
export function missingRequired(narrative: DocNarrative): readonly DocSectionKey[] {
  return REQUIRED_SECTIONS.filter((key) => {
    const value = narrative[key]
    return typeof value !== 'string' || value.trim().length === 0
  })
}

/**
 * Does §9 carry proposals the successor must ask about before acting?
 *
 * "无" and its variants are the explicit empty answer the prompt asks for, so
 * they must not count as a pending decision — otherwise every handoff would
 * begin with a warning and the warning would stop meaning anything. Anything
 * else counts, because a false "ask the user first" costs one question while a
 * false negative costs an unapproved change.
 *
 * The empty answer is allowed a trailing parenthetical: writers explain *why*
 * there is nothing pending ("无（上一轮的 A/B 已获批准）"), and that explanation
 * is not itself a proposal. Only the leading marker decides, and it must be
 * followed by nothing but punctuation or a bracketed remark — 「无，但要改 X」
 * stays positive because content follows outside the brackets.
 */
export function hasOpenDecisions(narrative: DocNarrative | undefined): boolean {
  const body = narrative?.decisions
  if (typeof body !== 'string') return false
  const trimmed = body.trim()
  if (trimmed.length === 0) return false
  /*
   * Only these shapes count as "nothing pending":
   *   无 / 无。 / 无（说明） / 无（说明）。 / none / n/a
   * A comma never qualifies — 「无，但要改 X」 carries real content after it.
   */
  return !/^(?:无|没有|暂无|none|n\/a)\s*(?:[。.．!！]|（[^）]*）[。.．!！]?|\([^)]*\)[。.．!！]?)?\s*$/i.test(
    trimmed,
  )
}

/**
 * Reject a document that cannot be used.
 *
 * The successor is told "read §0, then §2, then §4". A document missing §4 has
 * no next action; one missing §2 has no current facts, so the successor falls
 * back to reading the log — which is precisely the cost this design removes.
 * Failing here costs one retry; failing later costs a session.
 */
export function documentIsUsable(narrative: DocNarrative): { ok: boolean; missing: readonly DocSectionKey[] } {
  const missing = missingRequired(narrative)
  return { ok: missing.length === 0, missing }
}

/**
 * Render the final document.
 *
 * Facts go in program-side, in §0 and §2's header lines, because the model must
 * not be the source of truth about its own configuration. The model's §0 body
 * is appended after them rather than replacing them, so a model that forgot to
 * mention the branch cannot delete the branch line.
 */
export function renderDocument(input: {
  facts: DocFacts
  narrative: DocNarrative
  version: string
  /** Archive target for the §9 pointer, e.g. `CHANGELOG.md`. */
  archivePointer: string
}): { text: string; redactions: readonly string[] } {
  const { facts, narrative } = input
  const applied = new Set<string>()

  const clean = (body: string): string => {
    const result = redactWithReport(body)
    for (const rule of result.applied) applied.add(rule)
    return stripSelfSize(result.text).trim()
  }

  const sectionBody = (key: DocSectionKey, fallback: string): string => {
    const raw = narrative[key]
    const text = raw === undefined ? '' : clean(raw)
    return text.length === 0 ? fallback : text
  }

  const parts: string[] = [renderHeader(facts, input.version), '']

  // ---- §0 ------------------------------------------------------------------
  /*
   * The model's body goes FIRST, the program's command list after it.
   *
   * Reversed from the obvious order on purpose: the model is asked only for
   * what the program cannot read (ports, expected numbers, which failure means
   * what), and putting its prose first means a reader hits the useful part
   * immediately instead of scrolling past a list of commands they could have
   * got from `package.json`.
   */
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'selfcheck')!.heading,
    '',
    /*
     * The program's own warning goes ABOVE the model's prose: it is the fact the
     * successor must not miss, and the model may write "无补充" (as it does when
     * it has nothing to add). A warning that only the model could supply would
     * be exactly the wrong place for it.
     */
    ...scopeWarning(facts),
    sectionBody('selfcheck', '无补充'),
    '',
    '### 命令与环境（程序读取）',
    '',
    ...selfCheckLines(facts),
    '',
  )

  // ---- §1 ------------------------------------------------------------------
  parts.push(DOC_SECTIONS.find((s) => s.key === 'goal')!.heading, '', sectionBody('goal', '（未提供）'), '')

  // ---- §2 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'facts')!.heading,
    '',
    ...factLines(facts),
    '',
    sectionBody('facts', '（未提供）'),
    '',
  )

  // ---- §3 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'blockers')!.heading,
    '',
    sectionBody('blockers', '无'),
    '',
  )

  // ---- §4 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'next')!.heading,
    '',
    sectionBody('next', '（未提供：接手前必须先确定下一条动作）'),
    '',
    '### 验证映射（程序读取，按改动范围取用）',
    '',
    ...verificationMatrix(facts),
    '',
  )

  // ---- §5 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'constraints')!.heading,
    '',
    sectionBody('constraints', '（模型未列出额外禁忌；§5 之外仍受本文件与项目自身规范约束。）'),
    '',
  )

  // ---- §6 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'files')!.heading,
    '',
    sectionBody('files', '（未提供）'),
    '',
  )

  // ---- §7 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'rejected')!.heading,
    '',
    sectionBody('rejected', '（暂无记录。若重试了某条路并失败，补写到这里。）'),
    '',
  )

  // ---- §8 ------------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'verified')!.heading,
    '',
    sectionBody('verified', '（未提供：接手后必须自行验证，不得假设上一段会话验证过。）'),
    '',
  )

  // ---- §9 ------------------------------------------------------------------
  /*
   * The pending-decision channel.
   *
   * A session often ends with work it has *decided* to do but was never allowed
   * to do — "I recommend fixing X and Y; which do you want?" — and that question
   * used to die with the session. The successor then read §4, saw a task, and
   * executed a change the human had never approved. Carrying the open question
   * across the boundary is the whole point of this section, so it renders even
   * when empty: an explicit「无」is a fact, and its absence is not.
   */
  parts.push(DOC_SECTIONS.find((s) => s.key === 'decisions')!.heading, '', sectionBody('decisions', '无'), '')

  // ---- §10 -----------------------------------------------------------------
  parts.push(
    DOC_SECTIONS.find((s) => s.key === 'history')!.heading,
    '',
    `- 上一轮详细改动：\`${input.archivePointer}\``,
    '- 月度历史：`history/<YYYY-MM>.md`',
    '- 本文件不保留历史；需要追溯时按月份翻上面两处。',
    '',
  )

  if (applied.size > 0) {
    parts.push(
      '---',
      '',
      `> 生成时已替换 ${applied.size} 类敏感信息（${[...applied].join('、')}）。需要原始值请回到来源文件重新读取。`,
      '',
    )
  }

  return { text: parts.join('\n').replace(/\n{3,}/g, '\n\n'), redactions: [...applied] }
}

/**
 * The one warning that has to survive even when the model adds nothing.
 *
 * When the scope detector cannot see the project this session actually worked
 * in, the document is named after the wrong one and §0 lists the wrong
 * commands. The model often writes "无补充" to §0, so this line is injected by
 * the program rather than left to the narrative — it is the difference between a
 * successor that re-checks and one that runs a stranger's test suite.
 */
function scopeWarning(facts: DocFacts): readonly string[] {
  const scope = facts.scope ?? []
  const focus = scope.find((entry) => entry.focus)
  if (focus === undefined || !focusLooksWrong(scope)) return []
  return [
    `- ⚠ **工作范围无法可靠判定**：得分最高的候选是 \`${focus.directory}\`，但本次 ${focus.totalCalls} 次工具调用里它只被点名 ${focus.calls} 次。`,
    '  这通常意味着候选目录扫描漏掉了真正的项目（例如没有 `package.json` 的仓库）。',
    '  **先自行确认再动手**：`git -C <候选目录> status --porcelain` 有未提交改动、且 `git log --oneline -1` 与交接时间吻合的那一个，才是真正的工作项目。',
    '',
  ]
}

/**
 * Remove a model-written claim about this document's own size.
 *
 * The prompt forbids it, but the prompt is advice and this failure is quiet: a
 * document that says "本文件自身 16792 字符" while the file is 17634 characters
 * teaches the successor that numbers here are approximate. That lesson is worse
 * than the number being wrong, and it repeats on every regeneration because the
 * model measures mid-generation, before §0's program lines exist.
 *
 * Deleting rather than correcting, because even here the final length is
 * unknown — §0 has not been appended yet. The one component that knows the true
 * size is `fitToBudget`, and it does not publish.
 *
 * Matched narrowly: a self-reference ("本文件" / "本文") plus a number plus a
 * unit. Ordinary prose about a *budget* ("上限 24000 字符") must survive,
 * because that is a real setting rather than a measurement of this file.
 */
export function stripSelfSize(body: string): string {
  const pattern =
    /本(?:文件|文)(?:自身|本身|当前|总共)?\s*(?:约|共|有|为)?\s*[0-9][0-9,，]*\s*(?:个)?\s*(?:字符|字|字节|bytes|chars)/gi
  return body.replace(pattern, '本文件（长度由程序维护，勿在此声明）')
}

/** The program-read part of §0: what to run, and what "good" looks like. */
export function selfCheckLines(facts: DocFacts): readonly string[] {  const lines: string[] = []
  /*
   * Which commands are actually this session's.
   *
   * §0 exists to tell the successor what to run before touching anything, so a
   * command for a project this session never opened is not a self-check — it is
   * work invented for the successor. When the scope is known, the untouched
   * projects lose their slots to the ones that were worked in, and are then
   * reported once as untouched rather than dropped: a change that spans two
   * projects must still mention both.
   */
  const scope = facts.scope ?? []
  const focus = scope.find((entry) => entry.focus)
  const focusPrefix = focus === undefined ? undefined : `cd ${focus.directory} && `
  const inPlay = scopesInPlay(scope)
  const inPlayPrefixes = inPlay.map((entry) => `cd ${entry.directory} && `)
  /*
   * A focus that accounts for almost none of the session is a failed search, not
   * a finding. Saying so here — in §0, before the command list — is what stops a
   * successor from running the wrong project's checks while believing they are
   * the self-check. This is the §2/§0 counterpart of the pointer warning.
   */
  const scopeSuspect = focusLooksWrong(scope)

  const primary = facts.commands.filter((entry) => isVerification(entry.command))
  /*
   * Three tiers, and the order is the message: the project this session worked
   * in, then any other it worked in comparably hard, then — only when there is
   * room left in §0's budget — the rest. A project observed twice by a `grep`
   * is not a self-check, and spending a command slot on it is the defect this
   * ranking exists to fix.
   */
  const inScope =
    focusPrefix === undefined
      ? primary
      : [
          ...primary.filter((entry) => entry.command.startsWith(focusPrefix)),
          ...primary.filter(
            (entry) =>
              !entry.command.startsWith(focusPrefix) &&
              inPlayPrefixes.some((prefix) => entry.command.startsWith(prefix)),
          ),
          ...primary.filter(
            (entry) =>
              !inPlayPrefixes.some((prefix) => entry.command.startsWith(prefix)),
          ),
        ]

  if (inScope.length === 0) {
    lines.push(
      '- 命令：项目里尚未发现可识别的验证命令 → 接手第一件事是建立一条（哪怕是 `npm test`）。',
    )
  } else if (scopeSuspect) {
    /*
     * The command list below is untrustworthy: the project it was built around
     * holds almost none of the session's calls. Naming the commands anyway, with
     * the warning above them, would be worse than omitting them — the successor
     * runs the first line it sees and calls it a self-check.
     */
    lines.push(
      '- 命令：**未能可靠判定该跑哪些项目的检查**（见上一行的告警）。',
      '  → 先用 `git status --porcelain` 找出真正有改动的仓库，再在它下面跑该仓库的验证命令。',
    )
  } else {
    /*
     * Cut the list at the point where the remaining commands belong to projects
     * the session merely glanced at. Room is left for them only when nothing in
     * scope exists, which cannot happen here — the flat single-project case has
     * no prefixes at all and keeps its three slots.
     */
    const room = focusPrefix === undefined ? 3 : inPlay.length
    for (const entry of inScope.slice(0, room)) {
      lines.push(`- 命令：\`${entry.command}\` — 预期：${entry.proves}`)
      // The definition on its own line, so the expectation reads as a sentence
      // and the evidence stays available without being crammed into it.
      if (entry.definition !== undefined) {
        lines.push(`  - 实际执行：\`${entry.definition}\`（来自 ${entry.origin}）`)
      }
    }
  }

  /*
   * The projects this session did not touch, in one line.
   *
   * Named with the count of tool calls that reached them, because "0 calls" is
   * the fact that justifies skipping them — and because a successor that
   * inherits an unrelated failure needs to know these were never exercised.
   */
  const untouched = scope.filter(
    (entry) => !entry.focus && !inPlay.some((play) => play.directory === entry.directory),
  )
  if (focus !== undefined && untouched.length > 0) {
    lines.push(
      `- 本次未涉及：${untouched
        .map((entry) => `\`${entry.directory}\`（${entry.calls}/${entry.totalCalls} 次工具调用）`)
        .join('、')} —— 它们各自的 check 不在本次交接范围内`,
    )
  }
  lines.push(
    `- 环境：${facts.stack.length === 0 ? '未识别技术栈' : facts.stack.join(' / ')}${
      facts.cwd === undefined ? '' : `，工作目录 \`${facts.cwd}\``
    }`,
  )
  if (facts.git !== undefined) {
    /*
     * "as of the handoff" is not pedantry: the successor creates files too, and
     * a bare count then reads as a promise that the tree is still that size. A
     * live record reported "7 个未提交改动" minutes after that record itself had
     * become the eighth. Naming the moment costs three characters and stops the
     * successor from auditing a number that was never wrong.
     */
    lines.push(
      `- 版本：${facts.git.branch ?? '?'} @ ${(facts.git.head ?? '?').slice(0, 8)}${
        facts.git.dirty
          ? `（交接时 ${facts.git.changedFiles} 个未提交改动；此后新增的文件不计入）`
          : '（工作区干净）'
      }`,
    )
  }
  lines.push('- 全量验证矩阵 → 见 §4')
  return lines
}

/** True when a command looks like a check rather than a build or a server. */
function isVerification(command: string): boolean {
  return /\b(test|check|lint|typecheck|spec|verify|validate)\b/i.test(command)
}

/** The program-read part of §2: the session facts the model must not restate. */
export function factLines(facts: DocFacts): readonly string[] {
  const permission =
    facts.permissionPreset !== undefined
      ? facts.permissionPreset
      : facts.permissionError !== undefined
        ? `读取失败（${facts.permissionError}）`
        : '未知'
  const occupancy =
    facts.occupancyPercent === undefined
      ? '不可用（模型未上报窗口）'
      : `${facts.occupancyPercent}%（${facts.occupancyQuality === 'exact' ? '精确' : '估算'}）`

  return [
    `- 会话事实（程序读取，勿改写）：preset=${facts.agentPreset ?? '默认'}，模型=${
      facts.provider ?? '?'
    }/${facts.model ?? '?'}${facts.contextWindow === undefined ? '' : `（窗口 ${facts.contextWindow}）`}，`
      + `权限=${permission}，Plan=${facts.planMode === 'unknown' ? '未知' : facts.planMode === 'on' ? '开启' : '关闭'}，`
      + `已完成 turn=${facts.turnCount}，交接时上下文占用=${occupancy}`,
    `- 上一段会话：\`${facts.sourceSessionId}\`，生成于 ${new Date(facts.createdAt).toISOString()}`,
    ...(facts.pendingInput === undefined ? [] : [pendingLine(facts.pendingInput)]),
  ]
}

/**
 * The two certainties of "the session may not have finished talking".
 *
 * Same distinction as the old brief: a recorded open question is a fact, and
 * "the assistant spoke last" is only suggestive. Stating the second as a fact
 * would be a guess dressed as a measurement.
 */
function pendingLine(pending: PendingInputFacts): string {
  if (pending.kind === 'question') {
    return `- ⚠ 未答复提问：${pending.detail ?? '（问题内容未记录）'}（系统仍登记为未答复）`
  }
  return '- ⚠ 原会话最后一条是助手发言，其后没有用户消息——可能仍在等用户回话，交接不等于已获得执行 §4 的许可'
}

/**
 * The scope a command covers, i.e. the answer to "if I change this, which
 * check am I expected to run?".
 *
 * Read off `origin`, which the discovery layer already labels per project
 * (`dsh-handoff-doc/package.json#scripts.check`) and leaves bare for a root
 * manifest (`package.json#scripts.check`). Deriving the scope from the same
 * field that produced the command keeps the two from drifting; re-parsing
 * `command` would instead couple this to the `cd <dir> && …` spelling.
 *
 * `undefined` means "the workspace root" — a single project with no
 * sub-projects has only one scope, and naming it adds a heading that tells the
 * reader nothing.
 */
function scopeOf(entry: ProjectCommand): string | undefined {
  const directory = /^([^/]+)\/package\.json(?:#|$)/.exec(entry.origin)
  if (directory !== null) return directory[1]
  // `Makefile` and other root-level sources carry no directory at all.
  return undefined
}

/**
 * The §4 matrix: which command to run for which kind of change.
 *
 * The left column is the **scope** — the directory whose change demands that
 * command — not what passing it proves. The previous order put `proves` on the
 * left, which made every line in a multi-package workspace start with the same
 * sentence ("全部检查通过…") and left the heading's promise of a change scope
 * unfulfilled. What passing proves is already stated in the command line's own
 * `→` clause here and again in §0, so repeating it first only buried the one
 * fact §4 exists to add.
 */
export function verificationMatrix(facts: DocFacts): readonly string[] {
  if (facts.commands.length === 0) {
    return ['- 项目未提供验证命令；改动后至少手工复现一次目标行为，并把命令补进项目。']
  }
  const scoped = facts.commands.some((entry) => scopeOf(entry) !== undefined)
  if (!scoped) {
    // One project, one scope: a flat list reads better than a group per command.
    const lines: string[] = ['- 改动后必跑：']
    for (const entry of facts.commands) {
      lines.push(`  - \`${entry.command}\` → ${entry.proves}`)
    }
    return [...lines, ...trailingRules(facts)]
  }
  const focus = facts.scope?.find((entry) => entry.focus)
  const inPlay = new Set(scopesInPlay(facts.scope ?? []).map((entry) => entry.directory))
  const groups = new Map<string, ProjectCommand[]>()
  for (const entry of facts.commands) {
    const scope = scopeOf(entry) ?? '（工作区根）'
    const bucket = groups.get(scope)
    if (bucket === undefined) groups.set(scope, [entry])
    else bucket.push(entry)
  }
  /*
   * Put the session's own project first, and the ones it merely glanced at last.
   *
   * The matrix answers "I changed X, what must I run?" — so the project the
   * session worked in is the only heading a successor usually needs. The others
   * keep their commands (a change that spans two projects must still verify
   * both) but stop occupying the top of the list, and the trailing rule says
   * plainly which were never exercised.
   */
  const ordered = [...groups.entries()].sort((a, b) => {
    if (focus === undefined) return 0
    const rank = (scope: string): number =>
      scope === focus.directory ? 0 : inPlay.has(scope) ? 1 : 2
    return rank(a[0]) - rank(b[0])
  })
  const lines: string[] = ['- 改动范围 → 必跑：']
  for (const [scope, entries] of ordered) {
    /*
     * The annotation only means something when there is a focus to contrast
     * with. Without one the log named no project, and "本次未涉及" on every
     * heading would claim a distinction the session never made.
     */
    const note =
      focus === undefined
        ? ''
        : scope === focus.directory
          ? '（本次工作范围）'
          : inPlay.has(scope)
            ? ''
            : '（本次未涉及）'
    lines.push(`  - **${scope}**${note}`)
    for (const entry of entries) {
      lines.push(`    - \`${entry.command}\` → ${entry.proves}`)
    }
  }
  return [...lines, ...trailingRules(facts)]
}

/** The two standing rules that follow the matrix, shared by both shapes. */
function trailingRules(facts: DocFacts): readonly string[] {
  const lines: string[] = []
  const offline = facts.commands.filter((entry) => !/\b(dev|start|serve)\b/i.test(entry.command))
  lines.push(
    `- 离线可跑：${offline.length === 0 ? '无' : offline.map((entry) => `\`${entry.command}\``).join('、')}`,
  )
  lines.push(
    '- 需要服务/联网的项：凡涉及启动服务、调用外部 API、读取真实凭证的验证，先确认环境再跑；失败先怀疑环境，不要改代码。',
  )
  return lines
}

/**
 * Shrink a document to a character budget, dropping the least valuable
 * sections first.
 *
 * A model told "stay under N characters" overshoots; a hard truncate cuts the
 * middle of whatever section happens to be longest, which is usually §2 (the
 * one that matters). So this drops whole *optional* sections in a fixed order,
 * then shortens the longest remaining bodies line by line, and never removes a
 * required section entirely.
 *
 * The budget exists because the successor pays for every character on every
 * turn it keeps the document in context. A document that costs 8k tokens to
 * read has failed at its one job.
 */
export function fitToBudget(text: string, budgetChars: number): { text: string; dropped: readonly string[] } {
  if (text.length <= budgetChars) return { text, dropped: [] }

  const dropped: string[] = []
  // Optional sections, least valuable first. §7 is history-adjacent and §3 is
  // usually "无"; §5 and §8 are kept longest because they prevent damage.
  const droppable: DocSectionKey[] = ['rejected', 'blockers', 'constraints', 'history']
  let current = text

  for (const key of droppable) {
    if (current.length <= budgetChars) break
    const section = DOC_SECTIONS.find((entry) => entry.key === key)!
    const trimmed = removeSection(current, section.heading)
    if (trimmed.length < current.length) {
      current = trimmed
      dropped.push(section.heading.replace(/^##\s*/, ''))
    }
  }

  if (current.length <= budgetChars) {
    return { text: withBudgetNote(current, dropped), dropped }
  }

  /*
   * Still too long: cut lines from the end of the longest sections, keeping
   * their headings. Losing the tail of §2 is recoverable (the successor can
   * re-read the files); losing the heading would hide that the section exists.
   *
   * The shrink target excludes the note's own length, which is only known once
   * `dropped` is final — so the note is measured first, and the shrink runs
   * against the remaining space.
   */
  const note = budgetNote(dropped)
  const shrunk = shrinkSections(current, Math.max(0, budgetChars - note.length))
  return { text: withBudgetNote(shrunk, dropped), dropped }
}

/** Remove one `## ` section by its heading, up to the next `## ` heading. */
function removeSection(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading.trim())
  if (start < 0) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\d+\./.test(lines[i]!.trim())) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

/**
 * Trim the longest sections until the whole fits, never below 8 lines each.
 *
 * Removes a *chunk* proportional to the overflow from the largest section, not
 * one line at a time: a section 2000 lines long needs ~1800 removals to reach a
 * small budget, and a per-line loop either takes that many passes or stops at
 * its guard and returns an oversized document. The chunk shrinks each pass, so
 * the last few lines are still removed individually.
 */
function shrinkSections(text: string, budgetChars: number): string {
  const lines = text.split('\n')
  const groups: Array<{ start: number; end: number }> = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^##\s+\d+\./.test(lines[i]!.trim())) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s+\d+\./.test(lines[j]!.trim())) {
        end = j
        break
      }
    }
    groups.push({ start: i, end })
  }

  let current = lines
  for (let pass = 0; pass < 200; pass += 1) {
    const size = current.join('\n').length
    if (size <= budgetChars) break

    const live = groups
      .map((group) => ({
        group,
        bodyLines: group.end - group.start - 1,
        length: current.slice(group.start, group.end).join('\n').length,
      }))
      .filter((entry) => entry.bodyLines > 8)
      .sort((a, b) => b.length - a.length)

    const victim = live[0]
    if (victim === undefined) break

    /*
     * Remove enough lines to close roughly the whole gap, scaled by this
     * section's share of the text — but never its last 8 body lines, which is
     * where the section's actual content usually lives.
     */
    const overflow = size - budgetChars
    const perLine = Math.max(1, Math.ceil(victim.length / Math.max(1, victim.bodyLines)))
    const wanted = Math.ceil(overflow / perLine)
    const removable = Math.max(0, victim.bodyLines - 8)
    const drop = Math.min(removable, Math.max(1, wanted))

    // Drop from the bottom of the body, keeping the heading and the first lines.
    const from = victim.group.end - drop
    current = [...current.slice(0, from), ...current.slice(victim.group.end)]
    for (const group of groups) {
      if (group.start >= from) group.start -= drop
      if (group.end > from) group.end -= drop
    }
  }
  return current.join('\n')
}

/** Record what was dropped, so a truncated document never looks complete. */
function withBudgetNote(text: string, dropped: readonly string[]): string {
  const note = budgetNote(dropped)
  return note.length === 0 ? text : `${text}\n${note}`
}

/** The truncation footnote, or `''` when nothing was dropped. */
function budgetNote(dropped: readonly string[]): string {
  if (dropped.length === 0) return ''
  return `---\n\n> 为控制在预算内，已省略：${dropped.join('、')}。需要这些内容请从上一段会话或 CHANGELOG 恢复。\n`
}

/**
 * The message delivered to the successor session.
 *
 * Deliberately short. It names the file, states the reading order, and gives
 * the stop condition. Everything the successor needs is in the file — putting
 * it here as well is what made the old design expensive: the same content paid
 * for twice, and the message version was the one that could not be updated.
 *
 * The absolute path is included because the new session's cwd is the same
 * workspace but a relative path invites it to guess.
 */
export function renderPointer(input: {
  documentPath: string
  absolutePath: string
  project: string
  validUntil: string
  commands: readonly ProjectCommand[]
  /**
   * Which sub-projects this session actually worked in.
   *
   * Without it the pointer is silent about scope, and the successor is handed a
   * bare instruction like `推送 GitHub` with a whole workspace in front of it.
   * It then scans every repository, finds the one with an unpushed commit, and
   * concludes that is what the instruction meant — a real misread observed in
   * this very workspace, where the session had only touched `dsh-handoff-doc`.
   */
  scope?: readonly WorkScope[] | undefined
  pendingInput?: PendingInputFacts | undefined
  /** The human's own instruction for the successor; never part of the document. */
  instruction?: string | undefined
  /**
   * Whether the previous document carried unfinished proposals in §9.
   *
   * The successor must be told to ask rather than act, and the pointer is the
   * first thing it reads — a sentence inside §9 is reached only after it has
   * already decided what to do. Passed in rather than re-parsed so the two
   * halves cannot disagree about what "pending" means.
   */
  hasPendingDecisions?: boolean | undefined
}): string {
  const focus = input.scope?.find((entry) => entry.focus)
  /*
   * A focus that accounts for almost none of the session's calls is not a
   * finding, it is a failed search. Saying so is the difference between a
   * successor that re-checks the scope and one that trusts a wrong project name
   * — the failure that filed a 268-call Electron session under a directory it
   * had named twice.
   */
  const scopeSuspect = focusLooksWrong(input.scope ?? [])
  /*
   * The pointer's own "run this first" list obeys the same rule as §0: the
   * project this session worked in comes first, and a project it only glanced
   * at does not get a slot. Otherwise the successor reads two commands at the
   * top of the message and treats both as its business.
   */
  const inPlay = scopesInPlay(input.scope ?? [])
  const inPlayPrefixes = inPlay.map((entry) => `cd ${entry.directory} && `)
  const ordered =
    focus === undefined
      ? input.commands
      : [
          ...input.commands.filter((entry) => entry.command.startsWith(`cd ${focus.directory} && `)),
          ...input.commands.filter(
            (entry) =>
              !entry.command.startsWith(`cd ${focus.directory} && `) &&
              inPlayPrefixes.some((prefix) => entry.command.startsWith(prefix)),
          ),
        ]
  const primary = ordered.filter((entry) => isVerification(entry.command)).slice(0, 2)
  const lines: string[] = [
    `# 交接：${input.project}`,
    '',
    `上一段会话已把当前状态写成一份交接文档，请先读它再动手：`,
    '',
    `- 文档：\`${input.documentPath}\``,
    `- 绝对路径：\`${input.absolutePath}\``,
    `- 有效期：${input.validUntil}`,
    ...(focus === undefined
      ? []
      : scopeSuspect
        ? [
            `- ⚠ 工作范围无法可靠判定：得分最高的候选是 ${focus.directory}，`,
            `  但它在本次 ${focus.totalCalls} 次工具调用里只被点名 ${focus.calls} 次。`,
            '  这通常意味着候选目录扫描漏掉了真正的项目（例如没有 package.json 的仓库）。',
            '  **动手前先自行确认**：`git -C <候选目录> status --porcelain` 有未提交改动、',
            '  或 `git log --oneline -1` 与交接时间吻合的那一个，才是真正的工作项目。',
          ]
        : [
            `- 本会话的工作范围：\`${focus.directory}\`（${focus.calls}/${focus.totalCalls} 次工具调用）`,
            `  未涉及的项目：${
              input.scope?.filter((entry) => !entry.focus).length === 0
                ? '（无）'
                : input.scope!
                    .filter((entry) => !entry.focus)
                    .map((entry) => `\`${entry.directory}\``)
                    .join('、')
            }`,
        ]),
    '',
    '**读取顺序（不要整份通读）：**',
    '',
    '1. 只读 §0「30 秒自检」，照着跑里面的命令。',
    '2. 自检通过 → 读 §2（当前有效事实）、§3（卡点）、§4（下一步），然后从 §4 的第一条动作开始。',
    '3. 自检不通过，或 §0 标注的有效期已过 → **不要继续读**，先告诉用户「交接文档已过期」，',
    '   然后整份重写该文件（不得追加），重写完再开工。',
    '',
    '§1 / §5 / §6 / §7 / §8 只在需要时按需查看，不必顺序通读。',
  ]

  if (primary.length > 0) {
    lines.push('', '开工前先跑：', ...primary.map((entry) => `- \`${entry.command}\` → ${entry.proves}`))
  }

  if (input.pendingInput !== undefined) {
    lines.push('', '**注意：**')
    lines.push(
      input.pendingInput.kind === 'question'
        ? `上一段会话有一个未答复的提问：${input.pendingInput.detail ?? '（内容未记录）'}。先向用户确认，不要自行决定。`
        : '上一段会话最后一条是助手发言，其后没有用户消息。它可能仍在等用户回话——§4 的动作在执行前先向用户确认。',
    )
  }

  lines.push(
    '',
    '**不要做的事：** 不要重复 §1 里已经验收通过的项；不要重试 §7 里已否决的方案；',
    '不要把 §8「未验证」当成已验证。',
    '',
  )

  /*
   * The one instruction that outranks §4's task list.
   *
   * A session can end with work it has decided on but has not been allowed to
   * do. Previously that question vanished at the boundary and the successor read
   * §4 as a work order, executing a change the human had never approved. Stated
   * before the reading order so it is in effect when §4 is read, not after.
   */
  if (input.hasPendingDecisions === true) {
    lines.push(
      '**§9「待用户决策」不是待办事项。** 里面每一条都是上一个会话**已经想好但还没获准**的改动。',
      '动手前必须先逐条问用户要不要做；用户没明确同意，就一条都不要执行。',
      '',
    )
  }

  lines.push('读完 §0 后，用一句话报告自检结果，再开始 §4。')

  /*
   * The user's own instruction, carried beside the pointer rather than inside
   * the document.
   *
   * It belongs here because it is the one thing the successor must know that
   * cannot be derived from the workspace: `继续 §4，做完之后推送 GitHub` is not
   * a fact about the code. Putting it in §4 instead would make it compete for
   * the document budget and, worse, invite `fitToBudget` to drop it — the
   * instruction would vanish exactly when the document was long.
   *
   * Placed last so the reading order above still comes first: the successor
   * self-checks, reads the document, and only then learns what the human wants
   * changed about the default plan.
   */
  if (input.instruction !== undefined && input.instruction.trim() !== '') {
    lines.push(
      '',
      '**用户的附言（优先级高于 §4 的默认动作）：**',
      '',
      input.instruction.trim(),
      '',
      '若这段附言与 §4 冲突，以附言为准，并在动工前一句话说明冲突在哪。',
      /*
       * Scope the instruction, because prose like `推送 GitHub` does not name a
       * repository.
       *
       * The successor stands in a workspace that may hold a dozen independent
       * repositories, several with unpushed commits of their own. Left
       * unqualified, "push to GitHub" invites it to enumerate them and pick one
       * — which is how an instruction about this session's project turns into a
       * question about an unrelated repository. The session's own scope answers
       * it without guessing.
       */
      ...(focus === undefined || scopeSuspect
        ? [
            '',
            '**关于附言的范围：** 本会话的 work scope 无法可靠判定，所以附言里未点名的对象需要先向用户确认，不要自行推断。',
          ]
        : [
            '',
            `**关于附言的范围：** 附言里未点名的对象，默认指本会话的工作范围 \`${focus.directory}\`。` +
              `工作区里的其它仓库即使有未提交/未推送的内容，也不属于这次交接，不要动它们；` +
              `确实需要处理别的仓库时，先向用户确认。`,
          ]),
    )
  }

  return lines.join('\n')
}
