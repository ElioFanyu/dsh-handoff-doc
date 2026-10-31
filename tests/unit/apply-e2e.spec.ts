/**
 * Prove the installed `apply()` wires the document path end to end.
 *
 * Not a unit test of any one function: it drives the real `apply()` with a
 * fake Cordis context, calls the registered `/handoff` command, and asserts
 * that a document actually landed on disk with the right shape. That is the one
 * claim no per-module test can make, and the previous plugin's worst defects
 * (a command that silently did nothing, a route that 404'd) were exactly of
 * this kind.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '@src/index.ts'
import { CONFIG_DEFAULTS } from '@src/settings.ts'

/** A Cordis-like context that records what the plugin registers. */
function fakeContext(services: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const disposers: Array<() => void> = []
  const commands: Array<Record<string, unknown>> = []

  const ctx = {
    get: (name: string) => services[name],
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      const disposer = () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
      disposers.push(disposer)
      return disposer
    },
    effect: (callback: () => () => void) => {
      disposers.push(callback())
    },
    inject: (_deps: readonly string[], callback: () => void) => callback(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    commands: {
      register: (definition: Record<string, unknown>) => {
        commands.push(definition)
        return () => undefined
      },
    },
  }
  return { ctx, listeners, commands, disposeAll: () => disposers.reverse().forEach((fn) => fn()) }
}

/** A `llm` service that streams a complete, well-formed document. */
function fakeLlm() {
  const prompts: string[] = []
  const body = [
    '## 0. 30 秒自检',
    '需要 8787 端口。',
    '## 1. 目标与验收',
    '- [ ] 交接成文件',
    '## 2. 当前有效事实',
    '文档写在 docs/handoff 下。',
    '## 3. 卡点与阻塞',
    '无',
    '## 4. 下一步 + 验证映射',
    '跑 npm run check。',
    '## 5. 硬约束 / 禁忌',
    '不写 profile。',
    '## 6. 文件地图',
    'src/handoff-doc.ts → 骨架',
    '## 7. 已否决方案 + 原因',
    '按消息投递，已否决。',
    '## 8. 已验证 vs 未验证',
    '已验证：npm test。未验证：浏览器渲染。',
    '## 9. 历史',
    '- 见 CHANGELOG.md',
  ].join('\n')

  return {
    prompts,
    stream(options: { messages: Array<{ content: Array<{ text: string }> }> }) {
      prompts.push(options.messages[0]!.content[0]!.text)
      return (async function* () {
        yield { type: 'text-delta', text: body }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

describe('apply — the document path, end to end', () => {
  let root: string
  let llm: ReturnType<typeof fakeLlm>
  let command: { handler: (invocation: unknown) => Promise<{ kind: string; text: string }> }
  let agent: Record<string, unknown>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'handoff-e2e-'))

    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { check: 'tsc && vitest run', test: 'vitest run' } }),
      'utf8',
    )

    llm = fakeLlm()
    agent = {
      id: 'session-demo',
      session: {
        id: 'session-demo',
        header: { cwd: root, agentPreset: 'coder' },
        requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat', contextWindow: 100_000 }),
        snapshotEvents: () => [
          { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '做一个交接文档' }] } } },
          { type: 'turn/start', seq: 2, data: {} },
        ],
      },
      whenIdle: async () => undefined,
      followup: async () => undefined,
    }

    const fake = fakeContext({
      sessions: { get: () => agent.session },
      agents: { get: () => agent },
      llm,
      commands: undefined,
    })

    /*
     * A minimal but real-shaped session controller.
     *
     * The migration creates the successor session, selects its model, and
     * delivers the pointer through `agent.followup`. Faking only these three
     * members is enough to prove the wiring; inventing more would test the fake.
     */
    const created: string[] = []
    const delivered: string[] = []
    const newAgent = {
      id: 'session-new',
      session: { id: 'session-new', header: { cwd: root }, snapshotEvents: () => [] },
      followup: async (message: { content: Array<{ text: string }> }) => {
        delivered.push(message.content[0]!.text)
      },
    }
    const sessionController = {
      create: async () => {
        created.push('session-new')
        return { sessionId: 'session-new' }
      },
      selectModel: async () => ({ selected: { provider: 'deepseek', model: 'deepseek-chat' } }),
    }

    // `registerLater` looks the service up on `ctx`; give it the registry.
    ;(fake.ctx as unknown as { get: (name: string) => unknown }).get = (name: string) => {
      if (name === 'commands') return fake.ctx.commands
      if (name === 'agents') return { get: (id: string) => (id === 'session-new' ? newAgent : agent) }
      if (name === 'sessions') return { get: () => agent.session }
      if (name === 'llm') return llm
      if (name === 'sessionController') return sessionController
      return undefined
    }
    ;(globalThis as { __e2e?: unknown }).__e2e = { created, delivered }

    apply(fake.ctx as never, {
      ...CONFIG_DEFAULTS,
      // Keep the action bounded so a wiring mistake fails instead of hanging.
      stepWaitTimeoutMs: 1_000,
      actionDeadlineMs: 20_000,
      archiveSourceAfterHandoff: false,
    })

    command = fake.commands[0] as never
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers /handoff with the document hint', () => {
    expect(command).toBeDefined()
    expect((command as unknown as { name: string }).name).toBe('handoff')
    expect((command as unknown as { input: { hint: string } }).input.hint).toContain('where')
  })

  it('writes the document, creates the successor, and delivers a pointer', async () => {
    const result = await command.handler({ agent, rawInput: '' })
    expect(result.kind).toBe('success')

    // The project folder comes from the temp directory's own name.
    const dir = (await import('node:fs/promises')).readdir(join(root, 'docs/handoff'))
    const project = (await dir)[0]!
    const written = await readFile(join(root, 'docs/handoff', project, 'HANDOFF.md'), 'utf8')

    expect(written).toContain('# 交接 ——')
    expect(written).toContain('## 0. 30 秒自检')
    expect(written).toContain('## 4. 下一步 + 验证映射')
    expect(written).toContain('`npm run check`')
    // The result reports where it went, not just that it succeeded.
    expect(result.text).toContain('docs/handoff')
    expect(result.text).toContain('HANDOFF.md')

    /*
     * The delivery is the point: the successor must receive the POINTER, not
     * the document body. A regression here is silent — the handoff still
     * "succeeds" while the successor pays for the whole file on every turn.
     */
    const e2e = (globalThis as { __e2e?: { created: string[]; delivered: string[] } }).__e2e!
    expect(e2e.created).toContain('session-new')
    expect(e2e.delivered).toHaveLength(1)
    expect(e2e.delivered[0]).toContain('HANDOFF.md')
    expect(e2e.delivered[0]).toContain('只读 §0')
    expect(e2e.delivered[0]).not.toContain('文档写在 docs/handoff 下')
    expect(e2e.delivered[0]!.length).toBeLessThan(2_000)
  })

  it('gives the model the transcript and the discovered commands', () => {
    const prompt = llm.prompts[0]!
    expect(prompt).toContain('[用户] 做一个交接文档')
    expect(prompt).toContain('`npm run check`（来自 package.json#scripts.check）')
    expect(prompt).toContain('本文件是快照，不是日志')
  })

  it('answers /handoff where with the path and the state', async () => {
    const result = await command.handler({ agent, rawInput: 'where' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('docs/handoff')
    expect(result.text).toContain('HANDOFF.md')
    expect(result.text).toContain('状态：已存在')
  })

  it('answers /handoff status without needing a handoff to run', async () => {
    const result = await command.handler({ agent, rawInput: 'status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('## 会话交接状态')
  })

  it('accepts trailing text as an instruction rather than rejecting it', async () => {
    /*
     * `bogus` used to be a syntax error. It is now free text for the successor,
     * so the command is no longer a client-side rejection — it runs the handoff
     * and the outcome (not a "未知子命令" complaint) is what comes back.
     */
    const result = await command.handler({ agent, rawInput: 'bogus' })
    expect(String((result as { text?: string }).text ?? '')).not.toContain('未知子命令')
  })
})
