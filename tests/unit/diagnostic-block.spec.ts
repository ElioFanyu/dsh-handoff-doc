import { describe, expect, it } from 'vitest'
import { diagnosticBlock, failureDetail } from '@src/index.ts'

/*
 * The host renders a command outcome through `GenericCommandCard`, whose
 * disclosure is created only when the text contains a newline:
 *
 *   const body = text !== void 0 && text.includes('\n') ? text : null
 *
 * A single-line error therefore has no expand affordance and stays clipped.
 * These tests pin the contract that makes the host's own control appear, so a
 * later "tidy up the message" change cannot silently remove it.
 */
describe('diagnosticBlock', () => {
  const base = {
    at: Date.UTC(2026, 9, 31, 6, 0, 0),
    where: 'handoff',
    sessionId: 'session-1',
    logPath: 'D:/w/docs/handoff/.dsh-handoff-doc.log',
  }

  it('starts with a newline so the host treats the text as multi-line', () => {
    // The block is appended to the summary line; the leading newline is what
    // separates them and what makes `text.includes('\n')` true.
    expect(diagnosticBlock({ ...base, detail: undefined }).startsWith('\n')).toBe(true)
  })

  it('carries the facts a reader needs, one per line', () => {
    const block = diagnosticBlock({
      ...base,
      detail: { 文档输出上限: '20000 tokens', 已产出字符: 8421 },
    })
    expect(block).toContain('handoff')
    expect(block).toContain('session-1')
    expect(block).toContain('文档输出上限：20000 tokens')
    expect(block).toContain('已产出字符：8421')
    expect(block).toContain(base.logPath!)
  })

  it('says so when the log could not be written, instead of pointing nowhere', () => {
    const block = diagnosticBlock({ ...base, logPath: undefined, detail: undefined })
    expect(block).toContain('写入失败')
    expect(block).not.toContain('日志文件：undefined')
  })

  it('offers the HTTP copy as a second route to the full error', () => {
    const block = diagnosticBlock({ ...base, detail: undefined })
    expect(block).toContain('/dsh-handoff-doc/last-error')
  })

  /*
   * The host puts this inside `<pre>`, so markdown would render literally.
   * Plain key/value lines are the only shape that reads correctly there.
   */
  it('uses plain text, because the host renders it inside a pre element', () => {
    const block = diagnosticBlock({ ...base, detail: { 缺少小节: '4. 下一步 + 验证映射' } })
    expect(block).not.toContain('**')
    expect(block).toContain('缺少小节：4. 下一步 + 验证映射')
  })
})

describe('failureDetail', () => {
  const settings = { summaryMaxTokens: 20_000, handoffDocMaxChars: 24_000 }

  it('always reports both budgets, since they decide whether a failure was budget-related', () => {
    const detail = failureDetail(settings, '随便一个错误')
    expect(detail['文档输出上限']).toBe('20000 tokens')
    expect(detail['交接文档上限（字符）']).toBe(24_000)
  })

  it('reads the produced length and the missing sections back out of the message', () => {
    const detail = failureDetail(
      settings,
      '模型输出在写到 8421 字符时停止，必需小节没写完（缺：4. 下一步 + 验证映射）。',
    )
    expect(detail['已产出字符']).toBe(8421)
    expect(detail['缺少小节']).toBe('4. 下一步 + 验证映射')
  })

  it('omits fields the message does not mention rather than guessing', () => {
    const detail = failureDetail(settings, '模型调用失败：网络错误')
    expect(detail).not.toHaveProperty('已产出字符')
    expect(detail).not.toHaveProperty('缺少小节')
  })
})
