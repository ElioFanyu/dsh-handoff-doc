import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  blockingReason,
  localWarnings,
  routeUrl,
  type HandoffSettings,
} from '@src/client/protocol'

function settings(overrides: Partial<HandoffSettings> = {}): HandoffSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('DEFAULT_SETTINGS', () => {
  it('ships automation off, so installing the plugin changes nothing', () => {
    expect(DEFAULT_SETTINGS.autoHandoffEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.autoCompactEnabled).toBe(false)
  })

  it('defaults to an archiving, bounded document', () => {
    expect(DEFAULT_SETTINGS.handoffDir).toBe('docs/handoff')
    expect(DEFAULT_SETTINGS.handoffProjectFolder).toBe('')
    expect(DEFAULT_SETTINGS.handoffDocMaxChars).toBe(24_000)
    expect(DEFAULT_SETTINGS.archivePreviousHandoff).toBe(true)
    expect(DEFAULT_SETTINGS.reusePreviousHandoff).toBe(true)
  })
})

describe('blockingReason', () => {
  it('rejects a compaction threshold at or above the handoff threshold', () => {
    expect(
      blockingReason(
        settings({ autoHandoffEnabled: true, autoCompactEnabled: true, autoHandoffAtContextPercent: 70, autoCompactAtContextPercent: 70 }),
      ),
    ).toContain('压缩阈值必须低于交接阈值')
  })

  it('allows a compaction threshold below the handoff threshold', () => {
    expect(
      blockingReason(
        settings({ autoHandoffEnabled: true, autoCompactEnabled: true, autoHandoffAtContextPercent: 85, autoCompactAtContextPercent: 70 }),
      ),
    ).toBeUndefined()
  })
})

describe('localWarnings', () => {
  it('stays quiet about a deliberate low threshold until it gets pathological', () => {
    expect(localWarnings(settings({ autoHandoffEnabled: true, autoHandoffAtContextPercent: 40 }))).toEqual([])
    expect(
      localWarnings(settings({ autoHandoffEnabled: true, autoHandoffAtContextPercent: 15 })).join(' '),
    ).toContain('低于 20%')
  })

  /*
   * The document budget is the whole point of this design, so an unusable value
   * is called out in the card as well as on the host — the same rule in both
   * places, so saving cannot be rejected for a reason the card did not show.
   */
  it('warns about a budget too small to hold the required sections', () => {
    expect(localWarnings(settings({ handoffDocMaxChars: 3_000 })).join(' ')).toContain('低于 6000 字符')
  })

  it('warns about a budget that recreates the long read', () => {
    expect(localWarnings(settings({ handoffDocMaxChars: 80_000 })).join(' ')).toContain('超过 60000 字符')
  })

  it('says plainly that disabling archiving loses the record of change', () => {
    expect(localWarnings(settings({ archivePreviousHandoff: false })).join(' ')).toContain('不会留下「改了什么」')
  })
})

describe('routeUrl', () => {
  it('joins the origin, the prefix and the action', () => {
    expect(routeUrl('http://127.0.0.1:8589', 'state')).toBe(
      'http://127.0.0.1:8589/dsh-handoff-doc/state',
    )
  })
})

describe('the output budget and the document budget must agree', () => {
  /*
   * The first live handoff failed because `summaryMaxTokens` was 4096 while the
   * document needed ~5000 tokens: the model was cut off inside §4 and the user
   * was told "缺少必需小节", which names the symptom and hides the cause.
   */
  it('ships a default output budget large enough for the default document', () => {
    // ~0.75 tokens per Chinese character is the pessimistic conversion the host
    // validation uses; the default document is 24000 characters.
    const needed = Math.ceil(DEFAULT_SETTINGS.handoffDocMaxChars * 0.75)
    expect(DEFAULT_SETTINGS.summaryMaxTokens).toBeGreaterThanOrEqual(needed)
  })

  it('warns when the output budget is too small for the document budget', () => {
    const warnings = localWarnings(settings({ summaryMaxTokens: 4_096, handoffDocMaxChars: 24_000 }))
    expect(warnings.join(' ')).toContain('可能不足以写完')
  })

  it('stays quiet when the two budgets agree', () => {
    // 24000 characters needs ~18000 tokens; 20000 clears it.
    const warnings = localWarnings(settings({ summaryMaxTokens: 20_000, handoffDocMaxChars: 24_000 }))
    expect(warnings.join(' ')).not.toContain('可能不足以写完')
  })
})
