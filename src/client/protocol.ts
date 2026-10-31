/**
 * Shared, React-free contract between the two halves of this plugin.
 *
 * Restating it here (rather than importing host types) keeps the browser bundle
 * free of Node imports and lets a client test build the same objects a host
 * test asserts on.
 */

/** Route prefix; must equal `ROUTE_PREFIX` in the host entry. */
export const ROUTE_PREFIX = '/dsh-handoff-doc'

/** The status snapshot the card polls. Mirrors `StatePayload` on the host. */
export interface HandoffState {
  readonly ok: boolean
  readonly sessionId: string
  readonly phase: string
  readonly busy: boolean
  readonly latched: boolean
  readonly waitingForStep: boolean
  readonly slowWarning: boolean
  readonly cancelRequested: boolean
  readonly kind: string | undefined
  readonly newSessionId: string | undefined
  readonly occupancy: {
    readonly quality: string
    readonly used: number
    readonly window: number | undefined
    readonly percent: number | undefined
  }
  readonly cumulative: { readonly tokens: number; readonly source: string; readonly quality: string }
  readonly thresholds: {
    readonly handoffPercent: number
    readonly compactPercent: number
    readonly cumulative: number
    readonly enabled: boolean
    readonly compactEnabled: boolean
  }
  /**
   * Whether the browser should jump to the new session on completion.
   *
   * Carried in the state payload because the follower is the only component
   * that can act on it, and it never reads the settings card.
   */
  readonly openNewSession: boolean
  readonly autoActions: number
  readonly maxAutoActions: number
  readonly persistence: 'durable' | 'memory'
  readonly lastText: string | undefined
  readonly lastFailure: string | undefined
  readonly warnings: readonly string[]
}

/** The settings card's form values; a subset of the plugin Config. */
export interface HandoffSettings {
  autoHandoffEnabled: boolean
  autoHandoffTrigger: 'context' | 'cumulative' | 'either'
  autoHandoffAtContextPercent: number
  autoHandoffThreshold: number
  autoCompactEnabled: boolean
  autoCompactAtContextPercent: number
  evaluateIntervalMs: number
  contextRearmDeltaPercent: number
  rearmDeltaTokens: number
  maxAutoActionsPerSession: number
  summaryMaxTokens: number
  stepWaitTimeoutMs: number
  actionDeadlineMs: number
  openNewSessionOnHandoff: boolean
  /** Archive and stop the source session once the document is delivered. */
  archiveSourceAfterHandoff: boolean
  /** Workspace-relative directory holding every project's handoff folder. */
  handoffDir: string
  /** Project folder name under `handoffDir`; empty derives it from the workspace. */
  handoffProjectFolder: string
  /** Hard cap on the rendered document, in characters. */
  handoffDocMaxChars: number
  /** Move the previous document into CHANGELOG + history before replacing it. */
  archivePreviousHandoff: boolean
  /** Feed the previous document to the model so it can prune rather than restate. */
  reusePreviousHandoff: boolean
}

/** Defaults shown before the host answers. */
export const DEFAULT_SETTINGS: HandoffSettings = {
  autoHandoffEnabled: false,
  autoHandoffTrigger: 'context',
  autoHandoffAtContextPercent: 85,
  autoHandoffThreshold: 2_000_000,
  autoCompactEnabled: false,
  autoCompactAtContextPercent: 70,
  evaluateIntervalMs: 5000,
  contextRearmDeltaPercent: 10,
  rearmDeltaTokens: 200_000,
  maxAutoActionsPerSession: 3,
  summaryMaxTokens: 26_000,
  stepWaitTimeoutMs: 900_000,
  actionDeadlineMs: 1_800_000,
  openNewSessionOnHandoff: true,
  archiveSourceAfterHandoff: true,
  handoffDir: 'docs/handoff',
  handoffProjectFolder: '',
  handoffDocMaxChars: 24_000,
  archivePreviousHandoff: true,
  reusePreviousHandoff: true,
}

/**
 * The cross-field rule, restated for the browser.
 *
 * The host enforces it on save; the card mirrors it so the reason appears next
 * to the Save button instead of as a rejected write after the fact.
 */
export function blockingReason(settings: HandoffSettings): string | undefined {
  if (
    settings.autoHandoffEnabled &&
    settings.autoCompactEnabled &&
    settings.autoCompactAtContextPercent >= settings.autoHandoffAtContextPercent
  ) {
    return '压缩阈值必须低于交接阈值，否则压缩刚结束就会立刻触发交接。'
  }
  return undefined
}

/**
 * Warnings the card can raise without the host.
 *
 * Mirrors `validateSettings` on the host: a low threshold is a legitimate
 * choice, so the warning fires only below 20% and only while automation is on.
 * Duplicating a different rule here is what made 40% complain about "阈值偏小".
 */
export function localWarnings(settings: HandoffSettings): readonly string[] {
  const warnings: string[] = []
  if (settings.autoHandoffEnabled && settings.autoHandoffAtContextPercent < 20) {
    warnings.push('阈值低于 20%：会话可能发几条消息就被交接，新会话的时间大多花在读交接文档上。')
  }
  if (settings.evaluateIntervalMs > 60_000) {
    warnings.push('评估间隔超过 1 分钟，上下文可能在这期间撞满窗口。')
  }
  if (settings.handoffDocMaxChars < 6_000) {
    warnings.push('交接文档上限低于 6000 字符：§2 / §4 会被截断，接手会话可能看不到完整的当前事实。')
  }
  /*
   * The output budget and the document budget are different limits and both can
   * cut a document: summaryMaxTokens caps what the model may GENERATE,
   * handoffDocMaxChars caps what gets WRITTEN. If the output budget is smaller,
   * the model is cut off before the last sections exist and the handoff fails
   * with "missing required section" — which names the symptom, not the cause.
   *
   * The conversion assumes CJK-heavy prose — one token per character, not the
   * 0.75 an English estimate would give. Under-estimating silently lets a
   * document that cannot fit sail past the warning and fail mid-§4 with
   * "missing required section", which names the symptom instead of the cause.
   *
   * Kept identical to `TOKENS_PER_CHAR` in `settings.ts`: the two halves warn
   * about the same thing, and a drifting constant would make the card and the
   * host disagree about whether a configuration is safe.
   */
  const needed = Math.ceil(settings.handoffDocMaxChars * 1)
  if (settings.summaryMaxTokens < needed) {
    warnings.push(
      `输出上限 ${settings.summaryMaxTokens} tokens 可能不足以写完 ${settings.handoffDocMaxChars} 字符的文档`
        + `（约需 ${needed}）。模型会在后面的小节被截断，交接会因「缺少必需小节」失败。`,
    )
  }
  if (settings.handoffDocMaxChars > 60_000) {
    warnings.push('交接文档上限超过 60000 字符：接手会话读一次就要花掉可观上下文，失去「快照」的意义。')
  }
  if (!settings.archivePreviousHandoff) {
    warnings.push('已关闭归档：每次交接都会直接覆盖上一版，CHANGELOG 里不会留下「改了什么」。')
  }
  return warnings
}

/** Build a URL for one host route. */
export function routeUrl(base: string, action: string): string {
  return `${base}${ROUTE_PREFIX}/${action}`
}
