/**
 * The two measurements this plugin acts on.
 *
 * An earlier design keyed only on cumulative spend, which answers "how much has
 * this cost". Users actually watch the other number: "how full is the context
 * right now". They are different quantities, and a session can be cheap but
 * nearly full (a long tool-output-heavy turn) or expensive but half empty
 * (frequent compaction). Both are measured here, and the trigger decides which
 * one the user asked for.
 *
 * Neither function throws: measurement happens on the event hot path, and a
 * service that misbehaves must degrade the trigger, not the session.
 */
import { readProjectionHit, sessionEvents, type SessionEventLike, type SessionLike } from './contracts.ts'
import type {
  SessionProjectionsLike,
  TokenMeterLike,
} from './contracts.ts'
import type { MeasureQuality } from './types.ts'

/** Context occupancy: the share of the model window the current surface occupies. */
export interface ContextOccupancy {
  readonly quality: MeasureQuality
  /** Tokens currently visible to the model. Zero when measurement failed. */
  readonly used: number
  /** The routed model's window, when it reports one. */
  readonly window: number | undefined
  /** `used / window`, or `undefined` when the window is unknown. */
  readonly percent: number | undefined
  /** Where `used` came from: real provider usage, a heuristic, or nothing. */
  readonly baseline: 'usage' | 'estimated' | 'none'
  /**
   * Which accessor produced `used`.
   *
   * `contextPressure` is the projection the composer's own meter reads, so this
   * is what makes the plugin's number agree with the number the user sees.
   * `meter-surface` is the older heuristic replay, kept as the fallback for a
   * deployment that folds no projection. Optional so a caller that only cares
   * about the numbers (tests, older fixtures) need not fill it in.
   */
  readonly source?: 'contextPressure' | 'meter-surface' | 'none'
  /** Populated only when measurement failed. */
  readonly error?: string
  /**
   * Why `percent` is absent, when it is.
   *
   * Five different situations used to collapse into one status sentence,
   * "未知（模型未上报上下文窗口）" — and two of them were actively wrong:
   *
   * - A session that is not loaded into this process has no handle to read at
   *   all, so nothing can be said about its window. That is not the model
   *   failing to report one.
   * - A loaded session with a known window but an empty surface printed
   *   "0 / 1000000 tokens · 未知（模型未上报上下文窗口）" — the line contradicts
   *   itself by showing the window it claims not to have.
   *
   * Naming the cause keeps the report diagnosable from the output alone, the
   * same rule `source` follows. Optional so older callers/fixtures compile.
   */
  readonly reason?: OccupancyReason
}

/**
 * Why an occupancy could not be expressed as a percentage.
 *
 * `no-session` is about this host's memory, `no-source` about the deployment's
 * services, and `empty-surface` about the conversation itself. Reporting one as
 * another is what made a missing session look like a model that hides its
 * context window.
 */
export type OccupancyReason =
  /** The session handle could not be resolved (not loaded in this process). */
  | 'no-session'
  /** Neither `sessionProjections` nor `tokenMeter` exists on this deployment. */
  | 'no-source'
  /** Sources answered, but the model-visible surface is empty. */
  | 'empty-surface'
  /** Tokens were measured, but the routed model reports no window. */
  | 'no-window'
  /** A source threw; `error` carries its message. */
  | 'error'

/** Cumulative spend: total tokens billed across the whole session. */
export interface CumulativeUsage {
  readonly quality: MeasureQuality
  readonly tokens: number
  readonly source: 'projection' | 'meter' | 'none'
  readonly error?: string
}

const EMPTY_CONTEXT: ContextOccupancy = {
  quality: 'unavailable',
  used: 0,
  window: undefined,
  percent: undefined,
  baseline: 'none',
  source: 'none',
}

/**
 * Read the `contextPressure` projection the composer's meter also reads.
 *
 * Returns `undefined` when the unit is not registered on this deployment, which
 * is not an error: the meter replay below is the documented fallback.
 *
 * ## Two faces, and the shape each one carries
 *
 * The registry exposes the current `snapshot()` face and the deprecated
 * `stateOf()` face, and they return **different shapes** for this unit — which
 * is why both are handled here rather than in a caller:
 *
 * - `snapshot()` yields the unit's WIRE view (`contextPressureProjectionDefinition
 *   .wire.view` in `dsh-token-meter`): `{ contextWindow?, pressureTokens?,
 *   projectedTokens? }`. `projectedTokens` is already computed by the host.
 * - `stateOf()` yields the RAW state, whose schema is `.strict()` over
 *   `contextWindow`, `pressureTokens`, `surfaceTokens`, `sampledSurfaceTokens`,
 *   and `claim`. **There is no `projectedTokens` field in it at all**, so a
 *   raw-only host requires the derivation below.
 *
 * Reading the wire view first is both faster and more faithful: it is the exact
 * value the composer's own meter renders, so the two numbers agree by
 * construction instead of by a re-implemented formula.
 *
 * ## Why the derivation is still kept
 *
 * The host's own formula is
 *
 *     projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
 *
 * A host that only has the raw face (an older build, or a fixture) still needs
 * it, and matching the formula rather than reading a field keeps the two
 * numbers equal. An earlier version of this function read `state.projectedTokens`,
 * which is always `undefined` on the raw face: the projected reading never
 * applied and every occupancy was reported as `exact` from a stale sample.
 */
function readPressureProjection(
  session: SessionLike,
  projections: SessionProjectionsLike | undefined,
): { used: number; baseline: 'usage' | 'estimated'; window?: number } | undefined {
  const hit = readProjectionHit(projections, session, 'contextPressure')
  if (hit === undefined) return undefined

  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined

  /* ---- wire face: the host already projected the sample forward. ---- */
  if (hit.wire !== null && typeof hit.wire === 'object') {
    const wire = hit.wire as {
      pressureTokens?: unknown
      projectedTokens?: unknown
      contextWindow?: unknown
    }
    const wirePressure = num(wire.pressureTokens)
    const wireProjected = num(wire.projectedTokens)

    /*
     * Same precedence as the UI: a reading that can be projected forward wins,
     * because it answers "how full will the NEXT request be" — which is the
     * question a handoff threshold is actually asking.
     *
     * A wire view with no usable count is **not** second-guessed through the
     * deprecated face: the host derives the wire view from the same raw state
     * (`wire.view` spreads `pressureTokens` whenever it exists), so re-reading
     * raw to recover a field the host chose not to publish would only invent a
     * number. `undefined` here means "this unit has nothing to say", and the
     * caller falls back to the meter, which is the documented behaviour.
     */
    const wireUsed = wireProjected ?? wirePressure
    if (wireUsed === undefined || wireUsed <= 0) return undefined
    const window = num(wire.contextWindow)
    return {
      used: wireUsed,
      /*
       * `pressureTokens` is a provider-reported prompt size, so using it
       * alone rests on real usage. `projectedTokens` adds the surface delta
       * since that sample, which demotes it to an estimate — the same
       * demotion the UI makes.
       */
      baseline: wireProjected === undefined ? 'usage' : 'estimated',
      ...(window === undefined ? {} : { window }),
    }
  }

  /* ---- raw face: derive `projectedTokens` with the host's own formula. ---- */
  const state = hit.raw
  if (state === null || typeof state !== 'object') return undefined
  const record = state as {
    pressureTokens?: unknown
    surfaceTokens?: unknown
    sampledSurfaceTokens?: unknown
    contextWindow?: unknown
  }

  const pressure = num(record.pressureTokens)
  const surface = num(record.surfaceTokens)
  const sampled = num(record.sampledSurfaceTokens)

  /*
   * All three inputs are required: with any of them missing the sample cannot be
   * moved forward, and silently treating the gap as zero would under-report
   * occupancy.
   */
  const projected =
    pressure !== undefined && surface !== undefined && sampled !== undefined
      ? Math.max(0, pressure + surface - sampled)
      : undefined

  const used = projected ?? pressure
  if (used === undefined || !Number.isFinite(used) || used <= 0) return undefined

  const window = num(record.contextWindow)
  return {
    used,
    /* The same demotion as the wire face, for the same reason. */
    baseline: projected === undefined ? 'usage' : 'estimated',
    ...(window === undefined ? {} : { window }),
  }
}

/**
 * Read context occupancy for one session.
 *
 * ## Why the projection comes first
 *
 * The composer's meter (`dsh-client-ui-conversation`) reads the
 * `contextPressure` projection and computes `projected ?? pressureTokens` over
 * `contextWindow`. This plugin used to price the surface by itself
 * (`tokenMeter.measure().surfaceTokens`, a ~4-chars-per-token replay), so the
 * two disagreed on the SAME session: 27% in the composer versus 32% in
 * `/handoff status`, a gap that moves with how much Chinese and code the
 * conversation holds.
 *
 * Two numbers describing one session is a defect regardless of which is more
 * accurate: the user cannot tell whether a handoff is imminent. Reading the same
 * projection the UI reads makes the plugin agree by construction, and keeps the
 * provider-reported usage instead of discarding it for a guess.
 *
 * `contextWindow` still comes from the session's request context when the
 * projection does not carry one, so switching to a model with a smaller window
 * changes the denominator immediately.
 */
export function readContextOccupancy(
  session: SessionLike | undefined,
  tokenMeter: TokenMeterLike | undefined,
  projections?: SessionProjectionsLike,
): ContextOccupancy {
  if (session === undefined) {
    /*
     * No session handle: this process does not have the session loaded.
     *
     * This is the case the old status line called "模型未上报上下文窗口", which
     * points the reader at the model when the real answer is "this host cannot
     * see this session". A session restored in the browser but never resumed,
     * or any session from a previous process, lands here.
     */
    return { ...EMPTY_CONTEXT, reason: 'no-session' }
  }

  const fromProjection = readPressureProjection(session, projections)

  let measured: { surfaceTokens?: number; baseline?: { kind?: string } } | undefined
  if (fromProjection === undefined && tokenMeter !== undefined) {
    try {
      measured = tokenMeter.measure(session)
    } catch (error) {
      return {
        ...EMPTY_CONTEXT,
        quality: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
        reason: 'error',
      }
    }
  } else if (fromProjection === undefined) {
    // No projection and no meter: nothing can be measured on this deployment.
    return { ...EMPTY_CONTEXT, reason: 'no-source' }
  }

  const used =
    fromProjection !== undefined
      ? fromProjection.used
      : typeof measured?.surfaceTokens === 'number'
        ? measured.surfaceTokens
        : 0

  const baselineKind = fromProjection !== undefined ? fromProjection.baseline : (measured?.baseline?.kind ?? 'none')
  const baseline: ContextOccupancy['baseline'] =
    baselineKind === 'usage' || baselineKind === 'estimated' || baselineKind === 'none'
      ? baselineKind
      : 'none'

  let window: number | undefined = fromProjection?.window
  if (window === undefined) {
    try {
      window = session.requestContext?.()?.contextWindow
    } catch {
      window = undefined
    }
  }

  /*
   * Fall back to the durable log.
   *
   * `requestContext()` reports the CURRENT request envelope, which is absent for
   * an idle session or one restored without resuming. The model and its window
   * are still recorded in the `request/context` event that established them, so
   * without this fallback an idle session reports "model did not report a
   * context window" while the composer's own meter is happily showing a
   * percentage — two numbers disagreeing about the same session.
   */
  if (window === undefined) {
    window = windowFromEvents(sessionEvents(session))
  }

  // A window of zero or a negative value is a broken report, not a full context.
  const usableWindow =
    typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined

  if (used <= 0) {
    /*
     * Sources answered and the surface is empty.
     *
     * `window` is deliberately kept: a fresh session legitimately occupies
     * nothing of a known window, and hiding the window made the status line
     * print "0 / 1000000 tokens · 未知（模型未上报上下文窗口）" — a sentence that
     * denies the number it just displayed.
     */
    return {
      ...EMPTY_CONTEXT,
      quality: 'unavailable',
      window: usableWindow,
      baseline,
      source: fromProjection === undefined ? 'meter-surface' : 'contextPressure',
      reason: 'empty-surface',
    }
  }

  return {
    quality: baseline === 'usage' ? 'exact' : 'estimated',
    used,
    window: usableWindow,
    percent: usableWindow === undefined ? undefined : used / usableWindow,
    baseline,
    source: fromProjection === undefined ? 'meter-surface' : 'contextPressure',
    ...(usableWindow === undefined ? { reason: 'no-window' as const } : {}),
  }
}

/**
 * Read cumulative spend.
 *
 * Prefers the `tokenUsage` projection because it folds the durable log, so the
 * number is reconstructable after a restart. Falls back to the meter's total,
 * which re-prices the surface heuristically. A failed projection read is
 * *not* fatal: the meter still answers.
 *
 * The same unit reports `totals` through both faces — its wire view IS
 * `state.totals` (`tokenUsageProjectionDefinition.wire.view`) and its raw state
 * carries the same object under `totals` — so either answer is read the same
 * way. The wire view is a bare bucket object, the raw state is `{ totals, last }`.
 */
export function readCumulativeUsage(
  session: SessionLike | undefined,
  projections: SessionProjectionsLike | undefined,
  tokenMeter: TokenMeterLike | undefined,
): CumulativeUsage {
  if (session === undefined) {
    return { quality: 'unavailable', tokens: 0, source: 'none' }
  }

  if (projections !== undefined) {
    try {
      const hit = readProjectionHit(projections, session, 'tokenUsage')
      /*
       * `wire` is the bucket object itself; `raw` nests it under `totals`.
       * Normalizing here keeps the caller from having to know which face
       * answered, which is the whole point of the compatibility layer.
       */
      const totals = (
        hit?.wire !== undefined && hit.wire !== null && typeof hit.wire === 'object'
          ? hit.wire
          : (hit?.raw as { totals?: unknown } | undefined)?.totals
      ) as
        | {
            uncachedInputTokens?: number
            outputTokens?: number
            readTokens?: number
            writeTokens?: number
            cacheReadTokens?: number
            cacheWriteTokens?: number
          }
        | undefined

      if (totals !== undefined && totals !== null) {
        const sum =
          (totals.uncachedInputTokens ?? 0) +
          (totals.outputTokens ?? 0) +
          (totals.cacheReadTokens ?? totals.readTokens ?? 0) +
          (totals.cacheWriteTokens ?? totals.writeTokens ?? 0)
        if (sum > 0) {
          return { quality: 'exact', tokens: sum, source: 'projection' }
        }
      }
    } catch {
      // Projection key not registered on this deployment, or it threw while
      // folding. Either way the meter below is the documented fallback.
    }
  }

  if (tokenMeter !== undefined) {
    try {
      const measured = tokenMeter.measure(session)
      if (measured.totalTokens > 0) {
        return { quality: 'estimated', tokens: measured.totalTokens, source: 'meter' }
      }
    } catch (error) {
      return {
        quality: 'unavailable',
        tokens: 0,
        source: 'none',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { quality: 'unavailable', tokens: 0, source: 'none' }
}

/**
 * Fold cumulative spend straight from the log, with no services at all.
 *
 * Used by the handoff brief, which must still describe the session when the
 * projection and meter are both absent. Summing `assistant/message.usage` over
 * the log is exactly what the projection does, only slower and recomputed.
 */
export function foldUsageFromEvents(events: readonly SessionEventLike[] | undefined): number {
  if (events === undefined) return 0
  let total = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.['usage'] as
      | {
          inputTokens?: number
          outputTokens?: number
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      | undefined
    if (usage === undefined) continue
    total +=
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
  }
  return total
}

/** Render an occupancy ratio as whole percent, or `undefined` when unknown. */
export function percentOf(occupancy: ContextOccupancy): number | undefined {
  if (occupancy.percent === undefined) return undefined
  return Math.round(occupancy.percent * 100)
}

/**
 * The last context window the log recorded for this session.
 *
 * Scans backwards because the newest `request/context` wins: switching models
 * changes both the provider and the window, and an older event describes a model
 * the session is no longer on.
 */
export function windowFromEvents(
  events: readonly SessionEventLike[] | undefined,
): number | undefined {
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/context') continue
    const value = event.data?.['contextWindow']
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}
