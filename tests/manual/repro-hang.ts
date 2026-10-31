/**
 * Reproduce "handoff under a tight budget hangs", and time every phase.
 *
 * The report was: a bash command ran 10 minutes and printed only its banner.
 * That is consistent with either a real hang or a legitimate 15-minute wait for
 * a step boundary — and those need opposite fixes, so this measures instead of
 * guessing.
 *
 * Each case installs the plugin with a stub context and prints a timestamped
 * line as it progresses, so the phase that stalls is visible in the output.
 */
import { apply } from '../../lib/index.js'
import { CONFIG_DEFAULTS } from '../../lib/index.js'

const started = Date.now()
const mark = (label: string): void => {
  console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`)
}

/** A document body long enough that a small budget cannot finish it. */
const BODY = [
  '## 0. 30 秒自检',
  '无补充',
  '## 1. 目标与验收',
  '做插件',
  '## 2. 当前有效事实',
  Array.from({ length: 200 }, (_, i) => `- 事实 ${i} 一段比较长的当前有效事实描述`).join('\n'),
  '## 3. 卡点与阻塞',
  '无',
].join('\n')

interface StubOptions {
  /** How the fake `whenIdle` behaves. */
  readonly idle: 'immediate' | 'never'
  /** How the fake stream ends. */
  readonly finish: 'stop' | 'length' | 'never'
}

function install(options: StubOptions): {
  run: () => Promise<{ kind: string; text: string }>
  followups: string[]
} {
  const followups: string[] = []
  const agent = {
    id: 'src',
    session: {
      id: 'src',
      header: { cwd: process.cwd(), agentPreset: 'coder' },
      requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 100_000 }),
      snapshotEvents: () => [
        { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
        { type: 'turn/start', seq: 2, data: {} },
      ],
    },
    whenIdle: () =>
      options.idle === 'immediate' ? Promise.resolve() : new Promise<void>(() => {}),
    followup: async () => {},
  }
  const dst = {
    id: 'dst',
    session: { id: 'dst', header: { cwd: process.cwd() }, snapshotEvents: () => [] },
    followup: async (m: { content: Array<{ text: string }> }) => {
      followups.push(m.content[0]!.text)
    },
  }

  const commands: Array<{ handler: (i: unknown) => Promise<{ kind: string; text: string }> }> = []
  const ctx = {
    get: (name: string) => {
      if (name === 'commands') return { register: (d: never) => { commands.push(d); return () => {} } }
      if (name === 'agents') return { get: (id: string) => (id === 'dst' ? dst : agent) }
      if (name === 'sessions') return { get: () => agent.session }
      if (name === 'llm') {
        return {
          stream: () => {
            mark('llm.stream called')
            return (async function* () {
              yield { type: 'text-delta', text: BODY }
              mark('llm sent text-delta')
              if (options.finish === 'never') {
                // Never yields a finish chunk: the consumer waits forever.
                await new Promise<void>(() => {})
              }
              yield { type: 'finish', reason: { kind: options.finish } }
              mark(`llm sent finish(${options.finish})`)
            })()
          },
        }
      }
      if (name === 'sessionController') {
        return {
          create: async () => {
            mark('sessionController.create')
            return { sessionId: 'dst' }
          },
          selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
        }
      }
      return undefined
    },
    on: () => () => {},
    effect: (cb: () => () => void) => cb(),
    inject: (_d: readonly string[], cb: () => void) => cb(),
    logger: { info: (m: string) => mark('log: ' + m), warn: () => {}, error: () => {} },
  }

  apply(ctx as never, {
    ...CONFIG_DEFAULTS,
    // Short bounds so a stall is visible in seconds, not minutes.
    stepWaitTimeoutMs: 3_000,
    actionDeadlineMs: 8_000,
    summaryMaxTokens: 4_000,
    archiveSourceAfterHandoff: false,
  })
  return {
    run: () => commands[0]!.handler({ agent, rawInput: '' }),
    followups,
  }
}

async function caseOf(name: string, options: StubOptions): Promise<void> {
  console.log(`\n=== ${name} ===`)
  const installed = install(options)
  mark('plugin installed, calling /handoff')
  const result = await installed.run()
  mark(`returned: ${result.kind}`)
  console.log('  text:', result.text.split('\n')[0])
  console.log('  followups:', installed.followups.length)
}

await caseOf('A. tight budget, stream ends with length', { idle: 'immediate', finish: 'length' })
await caseOf('B. tight budget, stream ends with stop', { idle: 'immediate', finish: 'stop' })
await caseOf('C. agent never becomes idle', { idle: 'never', finish: 'stop' })
await caseOf('D. stream never sends finish', { idle: 'immediate', finish: 'never' })

mark('all cases done')
process.exit(0)
