/**
 * The two `sessionProjections` read faces, and why both must work.
 *
 * On the DSH 0.2.2 line the registry exposes:
 *
 * - `snapshot(session, keys)` — the current face. Each value is already run
 *   through its unit's `wire.view()`, and it is what the shipped consumers read.
 * - `stateOf(session, key)` — the deprecated registry-level read. It logs
 *   "sessionProjections.stateOf(...) is deprecated" once per key and returns the
 *   unit's RAW state.
 *
 * This plugin used to read only the second one. The tests below pin the
 * compatibility layer so a host with only the current face keeps working, a host
 * with only the old face keeps working, and the *shape* difference between the
 * two is never again mistaken for the same thing.
 *
 * Each fixture is built from the host's own unit definitions
 * (`dsh-token-meter` and `dsh-user-questions`), not invented:
 *
 * | unit             | `snapshot()` (wire)              | `stateOf()` (raw)                    |
 * | ---------------- | -------------------------------- | ------------------------------------ |
 * | `contextPressure`| `{ contextWindow?, pressureTokens?, projectedTokens? }` | `{ contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }` |
 * | `tokenUsage`     | `{ uncachedInputTokens, outputTokens, … }` | `{ totals: { … }, last }`   |
 * | `userQuestions`  | `{ active, settled }`            | `{ inheritedEventCount, timed, questions: { active, settled } }` |
 */
import { describe, expect, it, vi } from 'vitest'
import {
  readProjectionHit,
  type ProjectionSnapshotCutLike,
  type SessionLike,
  type SessionProjectionsLike,
} from '../../src/contracts.ts'
import { readContextOccupancy, readCumulativeUsage } from '../../src/measure.ts'
import { readPendingInput } from '../../src/session-summary.ts'

const session = { id: 's1' } as unknown as SessionLike

/**
 * A registry with ONLY the current `snapshot()` face.
 *
 * `stateOf` is deliberately absent: this is the face the host keeps, and a read
 * that silently needed `stateOf` would be a read that breaks on the next host.
 */
function snapshotOnly(values: Record<string, unknown>): SessionProjectionsLike {
  return {
    snapshot: (_session, keys): ProjectionSnapshotCutLike => ({
      asOfSeq: 42,
      values: Object.fromEntries(
        (keys ?? Object.keys(values)).flatMap((key) =>
          Object.hasOwn(values, key) ? [[key, values[key]]] : [],
        ),
      ),
    }),
  }
}

/** A registry with ONLY the deprecated `stateOf()` face, as an older host has. */
function stateOfOnly(states: Record<string, unknown>): SessionProjectionsLike {
  return {
    stateOf: (_session, key) => states[key],
  }
}

/** A registry exposing both faces, recording that `stateOf` was consulted. */
function bothFaces(
  values: Record<string, unknown>,
  states: Record<string, unknown>,
): { registry: SessionProjectionsLike; stateOfCalls: () => number } {
  const stateOf = vi.fn((_session: SessionLike, key: string) => states[key])
  return {
    registry: {
      snapshot: (_session, keys) => ({
        values: Object.fromEntries(
          (keys ?? Object.keys(values)).flatMap((key) =>
            Object.hasOwn(values, key) ? [[key, values[key]]] : [],
          ),
        ),
      }),
      stateOf,
    },
    stateOfCalls: () => stateOf.mock.calls.length,
  }
}

describe('readProjectionHit — one reader, two faces', () => {
  it('prefers the current snapshot face when the unit is present', () => {
    const hit = readProjectionHit(snapshotOnly({ contextPressure: { pressureTokens: 100 } }), session, 'contextPressure')
    expect(hit).toEqual({ wire: { pressureTokens: 100 }, raw: undefined })
  })

  it('reads the deprecated face only when snapshot did not answer', () => {
    const hit = readProjectionHit(stateOfOnly({ contextPressure: { surfaceTokens: 5 } }), session, 'contextPressure')
    expect(hit).toEqual({ wire: undefined, raw: { surfaceTokens: 5 } })
  })

  it('never consults the deprecated face on a host that has both', () => {
    // This is the whole point of the compatibility layer: a 0.2.2 host should
    // not emit the registry's per-key deprecation warning because of this plugin.
    const { registry, stateOfCalls } = bothFaces(
      { contextPressure: { pressureTokens: 100 } },
      { contextPressure: { pressureTokens: 999 } },
    )
    const hit = readProjectionHit(registry, session, 'contextPressure')
    expect(hit?.wire).toEqual({ pressureTokens: 100 })
    expect(stateOfCalls()).toBe(0)
  })

  it('falls back to the deprecated face when snapshot throws', () => {
    const registry: SessionProjectionsLike = {
      snapshot: () => {
        throw new Error('unit blew up')
      },
      stateOf: () => ({ surfaceTokens: 7 }),
    }
    expect(readProjectionHit(registry, session, 'contextPressure')).toEqual({
      wire: undefined,
      raw: { surfaceTokens: 7 },
    })
  })

  it('answers undefined when the unit is absent from a working snapshot', () => {
    const registry: SessionProjectionsLike = {
      snapshot: () => ({ values: {} }),
      stateOf: () => undefined,
    }
    expect(readProjectionHit(registry, session, 'contextPressure')).toBeUndefined()
  })

  it('answers undefined when the deployment has no projections at all', () => {
    expect(readProjectionHit(undefined, session, 'contextPressure')).toBeUndefined()
  })

  it('does not treat an inherited key as a hit', () => {
    // `Object.hasOwn` rather than `in`: a prototype-polluted or inherited name
    // must not read as a registered unit.
    const polluted = { values: Object.create({ contextPressure: { pressureTokens: 1 } }) }
    const registry: SessionProjectionsLike = { snapshot: () => polluted as never }
    expect(readProjectionHit(registry, session, 'contextPressure')).toBeUndefined()
  })
})

describe('readContextOccupancy — the wire face carries projectedTokens already', () => {
  it('reads projectedTokens straight from the wire view', () => {
    // The host computed 274_086 + 6_000 - 0 = 280_086 for us.
    const result = readContextOccupancy(
      session,
      { measure: () => ({ totalTokens: 1, surfaceTokens: 999_999 }) },
      snapshotOnly({
        contextPressure: {
          contextWindow: 1_000_000,
          pressureTokens: 274_086,
          projectedTokens: 280_086,
        },
      }),
    )
    expect(result.used).toBe(280_086)
    expect(result.percent).toBeCloseTo(0.280086)
    expect(result.baseline).toBe('estimated')
    expect(result.source).toBe('contextPressure')
  })

  it('reports exact usage when the wire view has only pressureTokens', () => {
    // The host omits `projectedTokens` when `sampledSurfaceTokens` is absent.
    const result = readContextOccupancy(
      session,
      undefined,
      snapshotOnly({ contextPressure: { contextWindow: 1_000_000, pressureTokens: 250_000 } }),
    )
    expect(result.used).toBe(250_000)
    expect(result.baseline).toBe('usage')
    expect(result.quality).toBe('exact')
  })

  it('still derives projectedTokens from the raw face', () => {
    // An older host publishes no wire view; the host's own formula must be
    // re-applied, exactly as before this compatibility layer existed.
    const result = readContextOccupancy(
      session,
      undefined,
      stateOfOnly({
        contextPressure: {
          pressureTokens: 274_086,
          surfaceTokens: 6_000,
          sampledSurfaceTokens: 0,
          contextWindow: 1_000_000,
        },
      }),
    )
    expect(result.used).toBe(280_086)
    expect(result.baseline).toBe('estimated')
  })

  it('never second-guesses a wire view through the deprecated face', () => {
    // The host derives the wire view from the same raw state, so a wire view
    // with no usable count means the unit itself has nothing to say. Re-reading
    // raw here would invent a number the host deliberately withheld; the
    // documented fallback is the meter.
    const registry: SessionProjectionsLike = {
      snapshot: () => ({ values: { contextPressure: { contextWindow: 1_000_000 } } }),
      stateOf: () => ({
        pressureTokens: 100_000,
        surfaceTokens: 0,
        sampledSurfaceTokens: 0,
        contextWindow: 1_000_000,
      }),
    }
    const result = readContextOccupancy(
      session,
      { measure: () => ({ totalTokens: 900, surfaceTokens: 900, baseline: { kind: 'estimated' } }) },
      registry,
    )
    expect(result.used).toBe(900)
    expect(result.source).toBe('meter-surface')
  })

  it('uses the meter when neither face answers', () => {
    const result = readContextOccupancy(
      session,
      { measure: () => ({ totalTokens: 500, surfaceTokens: 500, baseline: { kind: 'estimated' } }) },
      snapshotOnly({}),
    )
    expect(result.used).toBe(500)
    expect(result.source).toBe('meter-surface')
  })
})

describe('readCumulativeUsage — wire is the bucket, raw nests it under totals', () => {
  const buckets = { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 }

  it('reads the bare bucket object a wire view produces', () => {
    const result = readCumulativeUsage(session, snapshotOnly({ tokenUsage: buckets }), undefined)
    expect(result.tokens).toBe(38)
    expect(result.source).toBe('projection')
    expect(result.quality).toBe('exact')
  })

  it('reads the nested totals a raw state produces', () => {
    const result = readCumulativeUsage(session, stateOfOnly({ tokenUsage: { totals: buckets, last: null } }), undefined)
    expect(result.tokens).toBe(38)
    expect(result.source).toBe('projection')
  })

  it('falls back to the meter when the projection totals are empty', () => {
    const result = readCumulativeUsage(
      session,
      snapshotOnly({ tokenUsage: { uncachedInputTokens: 0, outputTokens: 0 } }),
      { measure: () => ({ totalTokens: 4_200, surfaceTokens: 10 }) },
    )
    expect(result.source).toBe('meter')
    expect(result.tokens).toBe(4_200)
  })

  it('reports unavailable when nothing can answer', () => {
    const result = readCumulativeUsage(session, snapshotOnly({}), undefined)
    expect(result).toEqual({ quality: 'unavailable', tokens: 0, source: 'none' })
  })
})

describe('readPendingInput — wire is the questions object, raw nests it', () => {
  const outstanding = {
    active: [{ callId: 'c1', questions: [{ question: '要不要改名？' }], state: 'continued' }],
    settled: [],
  }

  it('reads the questions object a wire view produces', () => {
    expect(readPendingInput(session, snapshotOnly({ userQuestions: outstanding }))).toEqual({
      kind: 'question',
      detail: '要不要改名？',
    })
  })

  it('reads the questions object a raw state nests under `questions`', () => {
    const raw = { inheritedEventCount: 0, timed: false, questions: outstanding }
    expect(readPendingInput(session, stateOfOnly({ userQuestions: raw }))).toEqual({
      kind: 'question',
      detail: '要不要改名？',
    })
  })

  it('says nothing when the wire view holds no active question', () => {
    expect(
      readPendingInput(session, snapshotOnly({ userQuestions: { active: [], settled: [] } })),
    ).toBeUndefined()
  })

  it('degrades to the event log when neither face answers', () => {
    expect(
      readPendingInput(session, snapshotOnly({}), [{ type: 'assistant/message', seq: 1 }] as never),
    ).toEqual({ kind: 'unanswered-assistant' })
  })
})
