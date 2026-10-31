import { describe, expect, it } from 'vitest'
import { requestNarrative } from '@src/index.ts'
import { DOC_SECTIONS, missingRequired } from '@src/handoff-doc.ts'

/** A complete, usable response: every required section present. */
const COMPLETE = DOC_SECTIONS.map((section) => `${section.heading}\n内容-${section.key}`).join('\n\n')

/** An async iterable that yields the given chunks, like `llm.stream` does. */
async function* chunks(items: unknown[]) {
  for (const item of items) yield item
}

describe('requestNarrative (llm.stream)', () => {
  it('concatenates text deltas into the document sections', async () => {
    const llm = {
      stream: () =>
        chunks([
          { type: 'text-delta', text: '## 1. 目标与验收\n做插件\n' },
          { type: 'text-delta', text: '## 4. 下一步 + 验证映射\n跑测试\n' },
          { type: 'text-delta', text: COMPLETE },
          { type: 'finish', reason: { kind: 'stop' } },
        ]),
    }
    const parsed = await requestNarrative(llm as never, 'p', 16_000, {
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    /*
     * A section that appears twice keeps both bodies in order rather than
     * discarding the second: a model that restates a heading midway should not
     * cost the content that followed it.
     */
    expect(parsed.goal).toContain('做插件')
    expect(parsed.next).toContain('跑测试')
    expect(missingRequired(parsed)).toHaveLength(0)
  })

  it('requires an explicit provider and model on the request', async () => {
    let seen: Record<string, unknown> | undefined
    const llm = {
      stream: (options: Record<string, unknown>) => {
        seen = options
        return chunks([
          { type: 'text-delta', text: COMPLETE },
          { type: 'finish', reason: { kind: 'stop' } },
        ])
      },
    }
    await requestNarrative(llm as never, 'p', 777, { provider: 'p1', model: 'm1' })
    expect(seen).toMatchObject({ provider: 'p1', model: 'm1', maxTokens: 777 })
  })

  /*
   * The failure that actually happened, and the reason this test exists.
   *
   * `summaryMaxTokens` was 4096 — inherited from the message design — while a
   * real ten-section document needs about 5000. The model was cut off inside §4
   * and the user was told "缺少必需小节 4. 下一步 + 验证映射": a message that names
   * the symptom and sends the reader looking for a parsing bug that does not
   * exist. The finish reason now distinguishes the two cases.
   */
  it('reports a maxTokens cut-off as truncation, naming the budget', async () => {
    const llm = {
      stream: () =>
        chunks([
          {
            type: 'text-delta',
            text:
              '## 0. 30 秒自检\n无补充\n## 1. 目标与验收\n做插件\n'
              + '## 2. 当前有效事实\n事实\n## 3. 卡点与阻塞\n无\n## 4. 下一步 + 验证映',
          },
          { type: 'finish', reason: { kind: 'length' } },
        ]),
    }
    const error = await requestNarrative(llm as never, 'p', 4096, {
      provider: 'a',
      model: 'b',
    }).catch((caught: Error) => caught)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('4096 token 上限截断')
    expect(message).toContain('4. 下一步 + 验证映射')
    // It must name the setting to raise, not just the symptom.
    expect(message).toContain('文档输出上限')
  })

  it('reports a model that simply skipped a section as a different failure', async () => {
    const llm = {
      stream: () =>
        chunks([
          { type: 'text-delta', text: '## 0. 30 秒自检\n无补充\n## 1. 目标与验收\n做插件' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]),
    }
    await expect(
      requestNarrative(llm as never, 'p', 16_000, { provider: 'a', model: 'b' }),
    ).rejects.toThrow('模型没有写完必需小节')
  })

  it('accepts a complete response without complaint', async () => {
    const llm = {
      stream: () =>
        chunks([
          { type: 'text-delta', text: COMPLETE },
          { type: 'finish', reason: { kind: 'stop' } },
        ]),
    }
    const parsed = await requestNarrative(llm as never, 'p', 16_000, { provider: 'a', model: 'b' })
    expect(missingRequired(parsed)).toHaveLength(0)
  })

  it('turns a failed finish chunk into a thrown error', async () => {
    const llm = {
      stream: () =>
        chunks([
          { type: 'text-delta', text: 'partial' },
          { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded' } } },
        ]),
    }
    await expect(
      requestNarrative(llm as never, 'p', 100, { provider: 'a', model: 'b' }),
    ).rejects.toThrow('quota exceeded')
  })

  it('fails clearly when the service has no stream method', async () => {
    await expect(
      requestNarrative({} as never, 'p', 100, { provider: 'a', model: 'b' }),
    ).rejects.toThrow('没有 stream 方法')
  })
})
