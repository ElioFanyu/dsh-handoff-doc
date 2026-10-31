/**
 * Plugin configuration — the single settings surface.
 *
 * `cordis.patch.yml` seeds these defaults and the Configuration card writes
 * through the host's settings form. Every limit here exists to bound a real
 * failure mode (a runaway handoff loop, a document that costs more to read than
 * it saves); none is symmetry for its own sake.
 *
 * ## The five document fields, and why each is a setting
 *
 * The document design has policy the previous design did not: where the file
 * goes, how large it may get, and whether the previous one is archived. Each is
 * a genuine trade-off a user can be on either side of:
 *
 * - `handoffDir` — a team with a `docs/` convention and a team with a `notes/`
 *   convention both need their files where they already look.
 * - `handoffProjectFolder` — auto-derived from the workspace path, but a
 *   monorepo or a checkout directory named `src` needs a stable override.
 * - `handoffDocMaxChars` — the whole point of the redesign is a bounded read.
 *   Too low loses facts; too high recreates the problem.
 * - `archivePreviousHandoff` — off is legitimate when comparing two handoffs,
 *   and it is the switch that turns this back into "a file that only grows".
 * - `reusePreviousHandoff` — the prompt carries the previous document so the
 *   model can prune it instead of rediscovering everything from the transcript.
 */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Master switch for threshold-driven handoff. Off means manual only. */
  autoHandoffEnabled: boolean
  /** Which metric triggers automatic handoff. */
  autoHandoffTrigger: 'context' | 'cumulative' | 'either'
  /** Context occupancy (surface tokens ÷ window) that requests a handoff, in percent. */
  autoHandoffAtContextPercent: number
  /** Cumulative spend that requests a handoff, in tokens. Only used by `cumulative`/`either`. */
  autoHandoffThreshold: number
  /** Enable in-place compaction before the context is full. */
  autoCompactEnabled: boolean
  /** Context occupancy that requests a compaction, in percent. Must sit below the handoff threshold. */
  autoCompactAtContextPercent: number
  /** Minimum gap between two measurements of the same session, in milliseconds. */
  evaluateIntervalMs: number
  /** Hysteresis band: occupancy must fall this far below a threshold before it re-arms. */
  contextRearmDeltaPercent: number
  /** Cumulative tokens that must accrue after an action before it re-arms. */
  rearmDeltaTokens: number
  /** Automatic actions allowed per session, handoff and compaction shared. */
  maxAutoActionsPerSession: number
  /**
   * Output budget for the model that writes the document sections.
   *
   * 4096 was inherited from the message design and is far too small here: a
   * real ten-section document is ~7000 Chinese characters, which is ~5000
   * tokens, and the first live handoff was cut off mid-§4 because the budget ran
   * out. The default document budget is 24000 characters, which needs about
   * 18000 output tokens by the pessimistic conversion below, so 20000 leaves a
   * little headroom rather than being exactly at the edge.
   */
  summaryMaxTokens: number
  /** How long waiting for the step boundary is considered slow. Advisory only: it never interrupts. */
  stepWaitTimeoutMs: number
  /** Hard deadline for one action. Expiry releases the latch and marks a failure; it never cancels work. */
  actionDeadlineMs: number
  /** Scroll the browser to the new session once a handoff completes. */
  openNewSessionOnHandoff: boolean
  /**
   * Archive (and stop) the source session once the document is delivered.
   *
   * On by default: a session whose task moved elsewhere otherwise keeps showing
   * in the sidebar as if it were still the active one. Turning it off leaves it
   * running and visible, which is what you want when comparing the two.
   */
  archiveSourceAfterHandoff: boolean
  /** Workspace-relative directory that holds every project's handoff folder. */
  handoffDir: string
  /**
   * Folder name for this project, under `handoffDir`.
   *
   * Empty means "derive it from the workspace path" — the last segment, so
   * `D:/work/my-app` becomes `docs/handoff/my-app/`. A non-empty value pins it,
   * which is what a monorepo or a generically-named checkout needs.
   */
  handoffProjectFolder: string
  /**
   * Hard cap on the rendered document, in characters.
   *
   * 24000 characters is roughly 6k tokens — a read a successor can do in one
   * turn and still have room to work. Above this the document starts competing
   * with the task for the context window, which is the failure this whole
   * design exists to avoid.
   */
  handoffDocMaxChars: number
  /**
   * Move the previous document into CHANGELOG.md + history before replacing it.
   *
   * This is the mechanism that keeps HANDOFF.md a snapshot. Turning it off
   * makes each handoff overwrite the last with no record of what changed.
   */
  archivePreviousHandoff: boolean
  /** Keep the previous document's text in the summarization prompt, so the model can prune it. */
  reusePreviousHandoff: boolean
}

/**
 * The configuration contract.
 *
 * Three facts drove this shape, each measured rather than assumed:
 *
 * 1. **Cordis validates through Standard Schema.** `resolveConfig` calls
 *    `Config['~standard'].validate(raw)` and requires a *synchronous* result of
 *    `{ value }` or `{ issues }`. A bare JSON Schema object fails with
 *    `Cannot read properties of undefined (reading 'validate')`.
 * 2. **The settings page needs a schemastery instance, not a JSON object.**
 *    `dsh-settings` reads `schema.meta`, walks `schema.dict`, and calls
 *    `schema.toJSON()` to project the form. A plain object yields
 *    `status: "unsupported"`: the row exists, but its Configuration page never
 *    appears.
 * 3. **`schemastery` must be a real dependency.** It is not in a minimal
 *    composition, and in a full profile it is only *hoisted* by some other
 *    plugin — relying on that would break the day that plugin is uninstalled.
 *    It supplies `~standard` itself, so one declaration satisfies all three.
 */
export const Config: Schema<Config> = Schema.object({
  autoHandoffEnabled: Schema.boolean().default(false),
  autoHandoffTrigger: Schema.union(['context', 'cumulative', 'either']).default('context'),
  autoHandoffAtContextPercent: Schema.number().min(1).max(100).step(1).default(85),
  autoHandoffThreshold: Schema.number().min(0).step(1).default(2_000_000),
  autoCompactEnabled: Schema.boolean().default(false),
  autoCompactAtContextPercent: Schema.number().min(1).max(99).step(1).default(70),
  evaluateIntervalMs: Schema.number().min(1000).step(1).default(5_000),
  contextRearmDeltaPercent: Schema.number().min(0).max(50).step(1).default(10),
  rearmDeltaTokens: Schema.number().min(0).step(1).default(200_000),
  maxAutoActionsPerSession: Schema.number().min(1).max(10).step(1).default(3),
  summaryMaxTokens: Schema.number().min(256).step(1).default(26_000),
  stepWaitTimeoutMs: Schema.number().min(1000).step(1).default(900_000),
  actionDeadlineMs: Schema.number().min(1000).step(1).default(1_800_000),
  openNewSessionOnHandoff: Schema.boolean().default(true),
  archiveSourceAfterHandoff: Schema.boolean().default(true),
  handoffDir: Schema.string().default('docs/handoff'),
  handoffProjectFolder: Schema.string().default(''),
  handoffDocMaxChars: Schema.number().min(2_000).max(120_000).step(500).default(24_000),
  archivePreviousHandoff: Schema.boolean().default(true),
  reusePreviousHandoff: Schema.boolean().default(true),
})

/**
 * The default value of every field, read from the schema itself.
 *
 * One source of truth: the Configuration page, the Loader's defaults, and this
 * object all derive from the `Config` declaration above.
 */
export const CONFIG_DEFAULTS: Config = Object.fromEntries(
  Object.entries(Config.dict ?? {}).map(([name, field]) => [
    name,
    (field as { meta?: { default?: unknown } }).meta?.default,
  ]),
) as unknown as Config

/**
 * Fill a partial row config from the defaults.
 *
 * The Loader applies `default` for a well-formed row; this exists so a row that
 * omits a field (an older patch, or a hand-written profile) still hands the
 * plugin's own code a complete object.
 */
export function withDefaults(config: Partial<Config> | undefined): Config {
  return { ...CONFIG_DEFAULTS, ...(config ?? {}) }
}

/** A warning that does not block saving, with the field it concerns. */
export interface SettingWarning {
  readonly field: keyof Config
  readonly message: string
}

/**
 * Cross-field validation.
 *
 * `blocking` stops a save; `warnings` are advisory and surface both in the
 * Settings card and in `/handoff status`, so a configuration is never silently
 * accepted while being obviously wrong.
 */
export function validateSettings(config: Config): {
  blocking: string | undefined
  warnings: readonly SettingWarning[]
} {
  const warnings: SettingWarning[] = []

  if (
    config.autoHandoffEnabled &&
    config.autoCompactEnabled &&
    config.autoCompactAtContextPercent >= config.autoHandoffAtContextPercent
  ) {
    return {
      blocking:
        '压缩阈值必须低于交接阈值：否则上下文刚压缩完又会立刻触发交接，形成来回抖动。请调低压缩阈值或调高交接阈值。',
      warnings,
    }
  }

  if (
    config.autoCompactEnabled &&
    !config.autoHandoffEnabled &&
    config.autoHandoffAtContextPercent <= config.autoCompactAtContextPercent
  ) {
    warnings.push({
      field: 'autoCompactAtContextPercent',
      message: '压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。',
    })
  }

  /*
   * A low threshold is a legitimate choice, not a mistake.
   *
   * 40% is a perfectly reasonable handoff point for a cheap model with a big
   * window, so warning at 50% told users their deliberate configuration was
   * wrong. The warning now fires only where the behaviour gets genuinely
   * pathological — below 20%, a session is handed over after a handful of
   * messages and the new session spends its budget re-reading the document.
   */
  if (config.autoHandoffAtContextPercent < 20 && config.autoHandoffEnabled) {
    warnings.push({
      field: 'autoHandoffAtContextPercent',
      message: '阈值低于 20%：会话可能发几条消息就被交接，新会话的时间大多花在读交接文档上。',
    })
  }

  if (config.evaluateIntervalMs > 60_000) {
    warnings.push({
      field: 'evaluateIntervalMs',
      message: '评估间隔超过 1 分钟，上下文可能在两次测量之间就撞满窗口。',
    })
  }

  /*
   * The document budget is the whole point of the redesign, so an unusable
   * value is called out rather than silently clamped. A very small cap truncates
   * required sections; a very large one recreates the long-read problem.
   */
  if (config.handoffDocMaxChars < 6_000) {
    warnings.push({
      field: 'handoffDocMaxChars',
      message: '交接文档上限低于 6000 字符：§2 / §4 会被截断，接手会话可能看不到完整的当前事实。',
    })
  }
  if (config.handoffDocMaxChars > 60_000) {
    warnings.push({
      field: 'handoffDocMaxChars',
      message: '交接文档上限超过 60000 字符：接手会话读一次就要花掉可观上下文，失去「快照」的意义。',
    })
  }

  if (!config.archivePreviousHandoff) {
    warnings.push({
      field: 'archivePreviousHandoff',
      message: '已关闭归档：每次交接都会直接覆盖上一版，CHANGELOG 里不会留下「改了什么」。',
    })
  }

  if (config.handoffDir.trim().length === 0) {
    warnings.push({
      field: 'handoffDir',
      message: '交接目录为空，将回退到 docs/handoff。',
    })
  }

  /*
   * The output budget and the document budget must agree.
   *
   * These are different limits and both can cut a document: `summaryMaxTokens`
   * limits what the model may GENERATE, `handoffDocMaxChars` limits what gets
   * WRITTEN. If the output budget is smaller than the document budget, the model
   * is cut off before the last sections exist — and the handoff then fails with
   * "missing required section", which names the symptom and not the cause. That
   * is exactly how the first live handoff failed: 4096 output tokens against a
   * document that needed ~5000.
   *
   * The conversion is deliberately pessimistic (1 Chinese character ≈ 1 token,
   * ASCII ≈ 0.3) so the warning fires before the failure does.
   */
  /*
   * Chinese costs a token per character; 0.75 was an English assumption.
   *
   * This document is written in Chinese, where one character is roughly one
   * token (a CJK glyph is not split into word pieces the way Latin text is).
   * Estimating 0.75 per character under-counts by a quarter, so a 24000-character
   * budget was reported as needing 18000 tokens when it really needs ~24000: the
   * warning stayed silent, the model ran out inside §4, and the handoff failed
   * for "missing required section" — the exact failure this warning exists to
   * prevent.
   */
  const neededOutputTokens = Math.ceil(config.handoffDocMaxChars * TOKENS_PER_CHAR)
  if (config.summaryMaxTokens < neededOutputTokens) {
    warnings.push({
      field: 'summaryMaxTokens',
      message:
        `输出上限 ${config.summaryMaxTokens} tokens 可能不足以写完 ${config.handoffDocMaxChars} 字符的文档`
        + `（约需 ${neededOutputTokens}）。模型会在后面的小节被截断，交接会因「缺少必需小节」失败。`
        + `建议调到 ${Math.ceil(neededOutputTokens / 1000) * 1000} 以上。`,
    })
  }

  return { blocking: undefined, warnings }
}

/**
 * Tokens per character for the output estimate, one source of truth.
 *
 * 1.0 assumes CJK-heavy prose, which is what this document is. Being pessimistic
 * is the point: over-estimating produces an unnecessary warning, under-estimating
 * produces a failed handoff that the user cannot diagnose from the message.
 */
export const TOKENS_PER_CHAR = 1

/** True when the configured mode keys automatic handoff on context occupancy. */
export function triggerUsesContext(mode: Config['autoHandoffTrigger']): boolean {
  return mode === 'context' || mode === 'either'
}

/** True when the configured mode keys automatic handoff on cumulative spend. */
export function triggerUsesCumulative(mode: Config['autoHandoffTrigger']): boolean {
  return mode === 'cumulative' || mode === 'either'
}
