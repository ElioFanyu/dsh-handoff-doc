/**
 * dsh-handoff-doc — host half.
 *
 * A long session is handed to a fresh session in the same workspace once the
 * context is nearly full (or the spend passes a threshold, if the user prefers
 * that metric). The switch happens at a step boundary: this half never
 * interrupts a running step, a tool call, or a shell command.
 *
 * ## Layering
 *
 * - `measure.ts`   — the two numbers the trigger acts on
 * - `trigger.ts`   — when an automatic action may fire (pure, unit-tested)
 * - `graceful-stop.ts` — the latch and the `agent/pre-step` veto
 * - `session-summary.ts` / `redaction.ts` — the brief
 * - `session-migration.ts` — create, inherit, deliver
 * - `compact-handler.ts` — the in-place alternative
 * - `coordinator.ts` — one action at a time, the phase machine
 * - `monitor.ts` — the event bridge
 * - `command.ts` / `routes.ts` — the two ways a human reaches any of it
 *
 * ## Startup rules
 *
 * 1. **Services are read lazily.** The loader assembles sibling rows
 *    concurrently and `sessionController` owns ten dependencies, so it often
 *    appears after this row does. Reading it once here would report a healthy
 *    deployment as broken.
 * 2. **Nothing is registered outside `ctx.effect`.** An unload must leave no
 *    listener, timer, route, or latch behind.
 * 3. **The plugin must be harmless by default.** Automatic actions are off in
 *    the shipped patch; installing this row adds a command and a card.
 */

import type { Context } from '@deepseek-ai/cordis'
import { readServices, INJECT } from './services.ts'
import { Config, CONFIG_DEFAULTS, validateSettings, withDefaults, type Config as ConfigShape } from './settings.ts'
import { HumanInputBuffer, LatchRegistry, decidePreStep, humanTexts, waitForBoundary } from './graceful-stop.ts'
import { Coordinator } from './coordinator.ts'
import { Monitor, compactRunner } from './monitor.ts'
import { renderStatus, parseCommandArgs, runCommand } from './command.ts'
import {
  readPendingInput,
  readSessionFacts,
  renderTranscript,
  type PendingInput,
  type SessionFacts,
} from './session-summary.ts'
import {
  DOC_SECTIONS,
  buildDocPrompt,
  docPaths,
  missingRequired,
  parseDoc,
  validityOf,
  type DocFacts,
  type DocNarrative,
} from './handoff-doc.ts'
import { previousDocument, resolveProject, writeHandoff } from './handoff-writer.ts'
import { focusFromEvents, listSubProjects, readProjectFacts } from './project-facts.ts'
import { createWorkspaceFiles } from './workspace-fs.ts'
import { recordFailure } from './diagnostics.ts'
import { readGitFacts } from './git-facts.ts'
import {
  deliverBrief,
  migrateSession,
  planModeFor,
  PLUGIN_SOURCE_KIND,
  readPermissionPreset,
  snapshotSource,
} from './session-migration.ts'
import { readContextOccupancy, readCumulativeUsage, percentOf } from './measure.ts'
import {
  isLoopbackRequest,
  readJsonBody,
  sendJson,
  sessionIdFromUrl,
  statePayload,
} from './routes.ts'
import { sessionEvents, type AgentLike, type LlmLike, type SessionLike } from './contracts.ts'
import type { ActionResult, HandoffArtifact } from './types.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The session a handoff belongs to, for the duration of one action.
 *
 * The coordinator hands the `migrate` callback only a brief, so the source id
 * has to travel beside it. A shared mutable field would be wrong: automatic
 * triggers and manual commands can interleave, and a stale value would migrate
 * the wrong session. `AsyncLocalStorage` carries the id across every `await` of
 * one action without leaking into a concurrent one.
 */
const sourceScope = new AsyncLocalStorage<string>()


/** Stable plugin name; must match the row inserted by `cordis.patch.yml`. */
export const name = 'dsh-handoff-doc'

/** Optional host services; see `services.ts` for why these are declared. */
export const inject = INJECT

/** Route prefix for the status/action channel used by the settings card. */
export const ROUTE_PREFIX = '/dsh-handoff-doc'

/** Entry id under which the settings card writes; equals the patch row id. */
export const SETTINGS_ENTRY = 'dsh-handoff-doc'

/*
 * `validateSettings` is re-exported alongside `Config`.
 *
 * The settings card and `/handoff status` both need the cross-field rule, and a
 * host test that only imports the plugin's entry point should be able to assert
 * the same rule the runtime enforces. Exporting it here keeps one import path
 * for "what this plugin's configuration contract is".
 */
export { Config, CONFIG_DEFAULTS, withDefaults, validateSettings }

export function apply(ctx: Context, config: ConfigShape): void {
  const host = ctx as unknown as {
    get(name: string): unknown
    on(event: string, listener: (...args: unknown[]) => unknown): () => void
    effect(callback: () => () => void, label?: string): void
    logger?: { info?(message: string): void; warn?(message: string): void; error?(message: unknown): void }
  }

  const log = (message: string): void => {
    try {
      host.logger?.info?.(message)
    } catch {
      // Logging must never break an action.
    }
  }

  // Live configuration: the settings card rewrites the plugin row, and the
  // loader re-applies `config`. Holding the current value lets a long-running
  // action see the newest thresholds without re-registration.
  let live = config

  const latches = new LatchRegistry()

  /**
   * Human text observed while an action was in flight.
   *
   * The latch lets human messages through rather than rejecting the step (a
   * rejected step claims the messages but never persists or re-queues them, so
   * the user's words would vanish). Once the task moves, those words belong to
   * the successor session, and this buffer is what carries them there.
   */
  const humanInput = new HumanInputBuffer()

  /** Resolve the session log for an id, without waking an agent. */
  /**
   * The session log for one id.
   *
   * `ctx.sessions` stores Session objects; the agent is a separate registry.
   *
   * Prefers the live agent's own `session` when an agent exists: that object is
   * guaranteed to be the host's Session instance, whereas the store lookup can
   * return a different handle depending on the composition. `permissionPresets.
   * current` walks the log through `snapshotEvents`, and only a real Session
   * instance has it — the mismatch is what made every handoff report
   * "权限：回退" with no explanation.
   */
  const sessionOf = (sessionId: string): SessionLike | undefined => {
    try {
      const services = readServices(host)
      const fromAgent = services.agents?.get?.(sessionId)?.session
      if (fromAgent !== undefined) return fromAgent
      return services.sessions?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * The live agent for one id.
   *
   * `ctx.agents` is the agent registry. A session with no live agent (restored
   * but not resumed) has no `whenIdle`/`followup`; callers must cope.
   */
  const agentOf = (sessionId: string): AgentLike | undefined => {
    try {
      return readServices(host).agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Ask the outgoing model for the document sections, write the file, and
   * return the short pointer that leads to it.
   *
   * The signature and name are inherited from the brief design, and the
   * coordinator still treats the result as "one string to deliver". What
   * changed is what that string is: a ~200-token pointer to a file rather than
   * a multi-thousand-token brief. The document itself never enters the new
   * session's context unless the successor chooses to read it, and it can be
   * re-read selectively, revised, or replaced by the next handoff.
   */
  const summarize = async (
    agent: AgentLike,
    signal?: AbortSignal,
    instruction?: string,
  ): Promise<HandoffArtifact> => {
    const services = readServices(host)
    const session = agent.session
    const events = sessionEvents(session)

    let facts: SessionFacts = readSessionFacts({
      session,
      occupancy: readContextOccupancy(session, services.tokenMeter, services.sessionProjections),
      cumulative: readCumulativeUsage(session, services.sessionProjections, services.tokenMeter),
      events,
    })
    facts = withObservedServices(facts, services, agent)
    /*
     * Did the session end while waiting for the user?
     *
     * Set here rather than inside `readSessionFacts` because it needs the
     * projections service. Kept as a spread so the fields
     * `withObservedServices` already filled (permission preset, plan mode)
     * survive — rebuilding the object would silently reset them.
     */
    const pendingInput = readPendingInput(session, services.sessionProjections, events)

    if (services.llm === undefined) {
      throw new Error('当前部署没有 llm 服务，无法生成交接文档')
    }

    /*
     * The summarising call must name a route.
     *
     * `llm.stream` does not choose a default provider or model; they are
     * required fields. The outgoing session's own route is the right one — the
     * model that did the work is the one that can describe it — and it is read
     * from the same facts the document reports, with the deployment default as
     * a fallback when the session never recorded a request.
     */
    const route = summaryRoute(facts, services)
    if (route === undefined) {
      throw new Error('原会话没有记录模型路由，也没有部署默认模型，无法生成交接文档')
    }

    /*
     * Read the project from disk before the model speaks.
     *
     * §0's value is that its commands are real. The model may describe them; it
     * may not invent them, because a plausible `npm run check` that does not
     * exist sends the successor debugging the harness instead of the project.
     */
    const cwd = facts.cwd
    if (cwd === undefined) {
      throw new Error('原会话没有工作目录，无法确定交接文档的位置')
    }
    const files = createWorkspaceFiles(cwd)
    /*
     * The folder is named after the project the session worked in, not after the
     * workspace folder it happened to sit in.
     *
     * The scope must be computed first because it decides the output path.
     * Listing sub-projects is the cheap step; only their names are needed to see
     * which one the log kept naming.
     */
    const focus = focusFromEvents(events, await listSubProjects(files))
    const project = resolveProject(live.handoffProjectFolder, cwd, focus?.directory)
    /*
     * Project facts come first, because reading them is what decides which
     * directory the git facts should describe.
     *
     * In a multi-project workspace the root is usually not a repository, so
     * reading git there reports "unknown" for a session that was editing one
     * repo all along. The focus directory is where the work happened; its
     * branch and HEAD are the ones that make the document's validity check
     * meaningful.
     */
    const projectFacts = await readProjectFacts({
      files,
      cwd,
      slug: project,
      events,
    })
    const git = await readGitFacts(
      projectFacts.focusRoot === undefined ? files : createWorkspaceFiles(projectFacts.focusRoot),
    )
    const projectFactsWithGit = { ...projectFacts, git }

    const createdAt = Date.now()
    const docFacts: DocFacts = {
      project,
      cwd,
      commands: projectFactsWithGit.commands,
      stack: projectFactsWithGit.stack,
      ...(projectFactsWithGit.scope.length === 0 ? {} : { scope: projectFactsWithGit.scope }),
      agentPreset: facts.agentPreset,
      provider: facts.provider,
      model: facts.model,
      contextWindow: facts.contextWindow,
      permissionPreset: facts.permissionPreset,
      ...(facts.permissionError === undefined ? {} : { permissionError: facts.permissionError }),
      planMode: facts.planMode,
      turnCount: facts.turnCount,
      occupancyPercent: percentOf(facts.occupancy),
      occupancyQuality: facts.occupancy.quality,
      ...(projectFactsWithGit.git === undefined ? {} : { git: projectFactsWithGit.git }),
      sourceSessionId: agent.id,
      createdAt,
      ...(pendingInput === undefined ? {} : { pendingInput: toDocPending(pendingInput) }),
    }

    const root = live.handoffDir.trim().length === 0 ? 'docs/handoff' : live.handoffDir
    const previous = live.reusePreviousHandoff
      ? await previousDocument(files, root, project, createdAt)
      : undefined

    /*
     * Send the transcript, not just the facts.
     *
     * The model cannot describe work it was never shown. The first real handoff
     * of the previous design proved this: with only configuration facts in the
     * prompt, every section came back "未知" and the receiving session had to
     * rediscover everything.
     */
    const narrative = await requestNarrative(
      services.llm,
      buildDocPrompt({
        facts: docFacts,
        transcript: renderTranscript(events),
        ...(previous === undefined ? {} : { previous }),
        budgetChars: live.handoffDocMaxChars,
      }),
      live.summaryMaxTokens,
      route,
      signal,
    )

    const written = await writeHandoff({
      files,
      root,
      project,
      narrative,
      facts: docFacts,
      version: versionOf(docFacts),
      reason: `上下文占用 ${docFacts.occupancyPercent === undefined ? '未知' : `${docFacts.occupancyPercent}%`} / 已完成 ${docFacts.turnCount} turn`,
      budgetChars: live.handoffDocMaxChars,
      archive: live.archivePreviousHandoff,
      ...(instruction === undefined ? {} : { instruction }),
    })

    /*
     * A refused document is a refused handoff.
     *
     * The successor is told to read the file; pointing it at a document that is
     * missing §2 or §4 leaves it with nothing to act on and no way to know. The
     * old session stays exactly as it is, which costs one retry.
     */
    if (!written.ok) throw new Error(written.error ?? '写入交接文档失败')

    log(
      `dsh-handoff-doc: 交接文档已写入 ${written.documentPath}（${written.bytes} 字节）${
        written.archive.archived ? '，上一版已归档' : ''
      }`,
    )

    return {
      brief: written.message,
      redactions: written.redactions,
      documentPath: written.documentPath,
      bytes: written.bytes,
      ...(written.dropped.length === 0 ? {} : { dropped: written.dropped }),
      archive: written.archive,
    }
  }

  /** Fill the fields that live on services rather than on the session. */
  const withObservedServices = (
    facts: SessionFacts,
    services: ReturnType<typeof readServices>,
    agent: AgentLike,
  ): SessionFacts => {
    /*
     * Capture the failure, never swallow it.
     *
     * This used to be `try { current(...) } catch { undefined }`, which made a
     * throwing read indistinguishable from "this session has no preset". The
     * brief then printed a bare "未知" and nobody could tell that the plugin
     * had actually failed to look.
     */
    const permissionRead = readPermissionPreset(agent.session, services.permissionPresets)
    const plan = planModeFor(agent, services.agentPresets)
    return {
      ...facts,
      permissionPreset: permissionRead.value,
      ...(permissionRead.error === undefined ? {} : { permissionError: permissionRead.error }),
      planMode: plan === undefined ? 'unknown' : plan.active ? 'on' : 'off',
    }
  }

  /*
   * The most recent failure, kept in memory for `GET /last-error`.
   *
   * A file is the durable record; this is the copy the user can read without
   * leaving the UI. It is deliberately small and last-write-wins — a history of
   * failures belongs in the log file, not in the process.
   */
  let lastFailure: HandoffFailure | undefined

  const coordinator = new Coordinator({
    latches,
    summarize,
    compact: compactRunner({
      services: () => readServices(host),
      waitIdle: async (agent) => {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
      },
    }),
    migrate: async (brief) => migrateFor(brief, host, agentOf, sessionOf),
    /*
     * Forward mid-flight human input to the successor.
     *
     * `followup` is the same delivery path the brief uses, so the forwarded text
     * is framed as plugin input rather than as something the user typed into the
     * new session — which is what it is: a message they typed into the OLD one.
     */
    drainHumanInput: (sessionId) => humanInput.drain(sessionId),
    discardHumanInput: (sessionId) => humanInput.forget(sessionId),
    reroute: async (newSessionId, text) => {
      const target = agentOf(newSessionId)
      if (target === undefined || typeof target.followup !== 'function') return false
      try {
        await target.followup(
          {
            role: 'user',
            source: { kind: PLUGIN_SOURCE_KIND },
            content: [{ type: 'text', text }],
          } as never,
          { source: { kind: PLUGIN_SOURCE_KIND } } as never,
        )
        return true
      } catch {
        return false
      }
    },
    waitIdle: async (agent) => {
      if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    },
    /*
     * Retire the source session after its work has moved.
     *
     * `archiveSession({ stopActivity: true })` is the host's own "stop this
     * session's work" path: it writes the durable archive first, and only then
     * asks the stop providers, whose `agent/pre-step` gate reads that archive
     * set — so every wake the stops induce is already blocked. That ordering is
     * exactly the "start the new session, then stop the old one" sequence, and
     * it uses the host's mechanism instead of inventing one.
     *
     * The log is retained: archiving hides a session from the active list, it
     * does not delete history.
     */
    retire: async (sessionId, newSessionId) => {
      /*
       * Archiving the source is a preference, not a law.
       *
       * It defaults on because a session whose task moved otherwise sits in the
       * sidebar as if it were still the one to continue in. Turning it off keeps
       * the old session visible and running, which is what you want when
       * comparing the two or when the brief needs a second look.
       */
      if (!live.archiveSourceAfterHandoff) {
        log(`dsh-handoff-doc: 旧会话 ${sessionId} 保持运行（设置要求不归档）`)
        return
      }
      const registry = readServices(host).workspaceRegistry
      if (registry === undefined) {
        throw new Error('当前部署没有 workspaceRegistry，无法归档旧会话')
      }
      if (typeof registry.archiveSession !== 'function') {
        throw new Error('当前部署的 workspaceRegistry 不支持归档会话')
      }
      await registry.archiveSession(sessionId, { stopActivity: true })
      log(
        `dsh-handoff-doc: 旧会话 ${sessionId} 已归档${newSessionId === undefined ? '' : `（接手：${newSessionId}）`}`,
      )
    },
    now: () => Date.now(),
    log,
  })

  coordinator.activityCheck = (sessionId: string) => {
    const session = sessionOf(sessionId)
    const events = sessionEvents(session)
    // A session is worth handing over once it has either a human message or a
    // completed turn; an untouched new session has neither.
    return events.some((event) => event.type === 'user/message' || event.type === 'turn/start')
  }

  const applyBounds = (next: ConfigShape): void => {
    coordinator.configure({
      stepWaitMs: next.stepWaitTimeoutMs,
      actionDeadlineMs: next.actionDeadlineMs,
    })
  }
  applyBounds(live)

  const monitor = new Monitor({
    services: () => readServices(host),
    config: () => live,
    coordinator,
    latches,
    agentOf,
    sessionOf,
    summarize,
    migrate: async (brief) => migrateFor(brief, host, agentOf, sessionOf),
    runAction: (request) => sourceScope.run(request.sessionId, () => coordinator.run(request)),
    now: () => Date.now(),
    log,
  })

  /**
   * Run one MANUAL action, clearing the in-flight flag however it ends.
   *
   * The flag is what stops the trigger engine from proposing a second action
   * while one runs, so every manual entry point sets it. Clearing it is the
   * other half, and only the automatic path had that: `settle()` is called from
   * `Monitor.execute()` alone, so a manual handoff left `pending` true for the
   * rest of the session's life — and `evaluate()` bails out on `pending`. With
   * `archiveSourceAfterHandoff: false` (which keeps the old session alive) that
   * meant one manual `/handoff` silently disabled automatic handoff forever.
   *
   * Automatic bookkeeping is deliberately NOT run here: a manual action must
   * not consume the per-session cap or move rearm gates, which describe
   * threshold crossings rather than user intent.
   */
  const runManual = async (
    sessionId: string,
    request: { kind: 'handoff'; detail?: string; reason?: 'manual'; instruction?: string },
  ): Promise<ActionResult> => {
    monitor.markPending(sessionId)
    try {
      // Scoped to this action: a concurrent automatic handoff for another
      // session keeps its own id.
      return await sourceScope.run(sessionId, () =>
        coordinator.run({
          sessionId,
          agent: agentOf(sessionId),
          kind: request.kind,
          reason: request.reason ?? 'manual',
          automatic: false,
          ...(request.detail === undefined ? {} : { detail: request.detail }),
          ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
        }),
      )
    } finally {
      monitor.releasePending(sessionId)
    }
  }

  const statusText = (sessionId: string): string => {
    const services = readServices(host)
    const status = coordinator.statusOf(sessionId)
    const session = sessionOf(sessionId)
    const validation = validateSettings(live)
    return renderStatus({
      phase: status.phase,
      busy: status.busy,
      latched: status.latched,
      waitingForStep: status.waitingForStep,
      slowWarning: status.slowWarning,
      newSessionId: status.newSessionId,
      occupancy: readContextOccupancy(session, services.tokenMeter, services.sessionProjections),
      cumulative: readCumulativeUsage(session, services.sessionProjections, services.tokenMeter),
      thresholds: {
        handoffPercent: live.autoHandoffAtContextPercent,
        compactPercent: live.autoCompactAtContextPercent,
        cumulative: live.autoHandoffThreshold,
        enabled: live.autoHandoffEnabled,
        compactEnabled: live.autoCompactEnabled,
      },
      autoActions: monitor.autoActionsOf(sessionId),
      maxAutoActions: live.maxAutoActionsPerSession,
      lastText: status.lastResult?.text,
      lastFailure: status.lastFailure?.message,
      warnings: validation.warnings.map((warning) => warning.message),
      /*
       * `readServices` always returns an object, so the old
       * `readServices(host) === undefined ? 'memory' : 'durable'` was always
       * `'durable'` and the "settings apply to this process only" warning in
       * `renderStatus` was unreachable. Durability is a question about whether
       * the deployment can PERSIST a settings change, which is the config
       * editor, not the service reader.
       */
      persistence: readServices(host).configEditor === undefined ? 'memory' : 'durable',
    })
  }

  /**
   * Answer "where is the document, and is it still valid".
   *
   * The document is now a file on disk, which creates a question the message
   * design could not have: is the file the successor will read the current one,
   * or a leftover from an earlier handoff? The answer is read from disk — the
   * header's date and the git HEAD recorded in the validity line — rather than
   * from memory, because memory is lost on restart and the file is not.
   */
  const whereText = async (sessionId: string): Promise<string> => {
    const session = sessionOf(sessionId)
    const cwd = safely(() => session?.header?.cwd)
    if (cwd === undefined) {
      return '## 交接文档\n- 无法确定当前会话的工作目录，因此无法定位交接文档。'
    }
    const files = createWorkspaceFiles(cwd)
    /*
     * Same folder rule as the writer, or `where` would report a path the
     * handoff never wrote to. The session's own log supplies the focus; a
     * session whose log is unreadable falls back to the workspace name.
     */
    const focus = focusFromEvents(safely(() => sessionEvents(session)), await listSubProjects(files))
    const project = resolveProject(live.handoffProjectFolder, cwd, focus?.directory)
    const root = live.handoffDir.trim().length === 0 ? 'docs/handoff' : live.handoffDir
    const paths = docPaths(root, project)

    const existing = await files.read(paths.document)
    const changelog = await files.exists(paths.changelog)
    const lines = ['## 交接文档', `- 项目：${project}`, `- 路径：\`${paths.document}\``, `- 绝对路径：\`${files.absolute(paths.document)}\``]

    if (existing === undefined) {
      lines.push('- 状态：**尚未生成**（第一次交接时创建）')
    } else {
      const firstLine = existing.split('\n')[0] ?? ''
      const date = /(\d{4}-\d{2}-\d{2})/.exec(firstLine)?.[1]
      const head = /HEAD ([0-9a-f]{8})/.exec(existing)?.[1]
      lines.push(`- 状态：已存在，${existing.length} 字符${date === undefined ? '' : `，最后验证 ${date}`}`)
      if (head !== undefined) lines.push(`- 记录时的 HEAD：${head}（当前 HEAD 不同即说明已过期）`)
      lines.push('- 接手顺序：只读 §0 自检 → 通过则读 §2 / §3 / §4；不通过先整份重写。')
    }

    lines.push(`- 归档：${changelog ? `\`${paths.changelog}\` 已存在` : '尚无归档（还没有被覆盖过）'}`)
    lines.push(`- 目录上限：${live.handoffDocMaxChars} 字符${live.archivePreviousHandoff ? '，交接时归档上一版' : '，**不归档**（直接覆盖）'}`)
    return lines.join('\n')
  }

  host.effect(() => {
    log('dsh-handoff-doc: 已挂载（自动动作默认关闭）')

    // ---- step veto --------------------------------------------------------
    const offPreStep = host.on('agent/pre-step', (...args: unknown[]) => {
      const payload = args[0] as
        | { agent?: AgentLike; messages?: readonly { source?: { kind?: string } }[] }
        | undefined
      const next = args[args.length - 1] as (() => Promise<unknown>) | undefined
      const agentId = payload?.agent?.id
      if (agentId === undefined || typeof next !== 'function') return next?.()
      if (!latches.isLatched(agentId)) return next()

      const decision = decidePreStep(true, payload?.messages as never)
      if (decision === undefined) {
        /*
         * The latch yielded to human input, which means the batch is about to
         * become a real step in THIS session.
         *
         * Two things follow, and both need the text: abort the handoff if it has
         * not committed to a new session yet (the user is clearly still working
         * here), and record the text so a handoff that DOES complete forwards it
         * to the successor. Recording happens first so the forward has the text
         * even if the abort wins the race.
         */
        humanInput.capture(agentId, humanTexts(payload?.messages as never))
        if (coordinator.abortForHumanInput(agentId)) {
          log(`dsh-handoff-doc: 收到人类输入，已取消 ${agentId} 的交接，原会话继续`)
        }
        return next()
      }
      log(`dsh-handoff-doc: 拒绝启动下一个 Step（${agentId}），等待交接`)
      return decision
    })

    // ---- session events ---------------------------------------------------
    const offEvent = host.on('session/event', (...args: unknown[]) => {
      const sessionId = (args[0] as { id?: string } | undefined)?.id
      const event = args[1] as { type?: string; seq?: number } | undefined
      if (sessionId === undefined || event?.type === undefined || event.seq === undefined) return
      try {
        monitor.onSessionEvent(sessionId, event as never)
      } catch (error) {
        host.logger?.error?.(error)
      }
    })

    const offDisposed = host.on('session/disposed', (...args: unknown[]) => {
      const sessionId = (args[0] as { id?: string } | undefined)?.id
      if (sessionId !== undefined) {
        monitor.forget(sessionId)
        /*
         * Drop any text captured for this session.
         *
         * `HumanInputBuffer` used to be cleared only by a SUCCESSFUL handoff
         * (`drain` inside `reroutePending`), and its own `forget()` was never
         * called from here — only the coordinator was forgotten. A handoff that
         * was cancelled or failed therefore kept whatever the user typed
         * mid-flight, and the NEXT successful handoff for that session would
         * forward stale words to an unrelated successor.
         */
        humanInput.forget(sessionId)
      }
    })

    /*
     * The command and the HTTP channel are registered only once their services
     * exist.
     *
     * `apply()` is called as soon as the services in `inject` are ready — which
     * for this plugin means `sessions` only. `commands` and `webServer` are
     * owned by other bundles that activate later, so reading them here returns
     * `undefined` and the registrations are silently skipped: the plugin is
     * "running", the row is "enabled", and `/handoff` does nothing and the
     * status route 404s.
     *
     * `ctx.inject` starts a child fiber that waits for exactly those services.
     * When they arrive the callback runs and its registrations ride that
     * fiber's lifetime, so unloading still cleans up.
     */
    const registerLater = (services: readonly string[], label: string, run: () => (() => void) | undefined): void => {
      try {
        const injector = (ctx as unknown as { inject?: (deps: readonly string[], cb: () => void) => unknown }).inject
        if (typeof injector === 'function') {
          injector.call(ctx, services, () => {
            try {
              const disposer = run()
              if (disposer !== undefined) ctx.effect(() => disposer, label)
            } catch (error) {
              host.logger?.error?.(error)
            }
          })
          return
        }
      } catch (error) {
        host.logger?.error?.(error)
      }
      // A context without `inject` (tests, or an older Cordis): run eagerly and
      // degrade exactly as before.
      const disposer = run()
      if (disposer !== undefined) ctx.effect(() => disposer, label)
    }

    // ---- command ----------------------------------------------------------
    registerLater(['commands'], 'dsh-handoff-doc: /handoff', () => {
      const commands = readServices(host).commands
      if (commands === undefined) {
        log('dsh-handoff-doc: 没有 commands 服务，/handoff 命令不可用')
        return undefined
      }
      return commands.register({
        name: 'handoff',
        description: '把当前会话交接成一份交接文档并交给新会话（status / where / cancel / retry）',
        input: { hint: 'status | where | cancel | retry' },
        handler: async (invocation) => {
          const agent = invocation.agent
          const sessionId = agent?.id
          const raw = invocation.rawInput ?? ''

          if (sessionId === undefined) {
            return { kind: 'error', text: '无法确定当前会话，/handoff 不可用。' }
          }

          try {
            const outcome = await runCommand(parseCommandArgs(raw), sessionId, {
              handoff: async (id, detail, instruction) =>
                runManual(id, {
                  kind: 'handoff',
                  ...(detail === undefined ? {} : { detail }),
                  ...(instruction === undefined ? {} : { instruction }),
                }),
              cancel: (id) => coordinator.requestCancel(id),
              status: statusText,
              where: whereText,
              retry: async (id) =>
                runManual(id, { kind: 'handoff', detail: '手动 retry' }),
            })
            return outcome.ok
              ? { kind: 'success', text: outcome.text }
              : {
                  kind: 'error',
                  text: await withLogHint({
                    text: outcome.text,
                    cwd: safely(() => sessionOf(sessionId)?.header?.cwd),
                    sessionId,
                    where: 'handoff',
                    detail: failureDetail(live, outcome.text),
                    onRecord: (failure) => {
                      lastFailure = failure
                    },
                  }),
                }
          } catch (error) {
            /*
             * The text must be non-empty: `dsh-commands` validates a handler's
             * result (`normalizeResult`) and throws
             * `command "handoff" error text must be a non-empty string` when it
             * is blank — and it throws it *inside* the registry, after this
             * handler has already returned, so the user sees an internal
             * failure instead of the reason. `new Error()` with no argument has
             * `message === ''`, so an empty message is reachable.
             */
            return {
              kind: 'error',
              text: await withLogHint({
                text: errorText(error),
                cwd: safely(() => sessionOf(sessionId)?.header?.cwd),
                sessionId,
                where: 'handoff',
                error,
                detail: failureDetail(live, errorText(error)),
                onRecord: (failure) => {
                  lastFailure = failure
                },
              }),
            }
          }
        },
      })
    })

    // ---- HTTP channel -----------------------------------------------------
    registerLater(['webServer'], 'dsh-handoff-doc: routes', () => {
      const webServer = host.get('webServer') as
        | { register(route: { kind: 'prefix'; path: string; handler: unknown }): () => void }
        | undefined
      if (webServer === undefined) {
        log('dsh-handoff-doc: 没有 webServer 服务，设置页的状态通道不可用')
        return undefined
      }
      const handler = async (
        req: {
          url?: string
          method?: string
          socket?: { remoteAddress?: string }
          headers?: Record<string, string | string[] | undefined>
        } & AsyncIterable<Uint8Array>,
        res: Parameters<typeof sendJson>[0],
      ): Promise<void> => {
        const path = (req.url ?? '').split('?')[0] ?? ''
        const action = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
        const loopback = isLoopbackRequest(req.socket?.remoteAddress)

        try {
          /*
           * Read the row's current configuration.
           *
           * The Configuration page needs the persisted values, not the
           * defaults: the browser mirror is unavailable to this bundle, so
           * reading through it silently produced defaults and the page kept
           * showing 85% after the user had saved 40%. This is the read half of
           * the save route below, and both use `live`, which is the value the
           * Loader actually applied.
           */
          if (action === 'config' && (req.method ?? 'GET') === 'GET') {
            sendJson(res, 200, { ok: true, settings: live })
            return
          }

          if (action === 'state' && (req.method ?? 'GET') === 'GET') {
            const sessionId = sessionIdFromUrl(req.url)
            if (sessionId === undefined) {
              sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
              return
            }
            const services = readServices(host)
            const validation = validateSettings(live)
            sendJson(
              res,
              200,
              statePayload(sessionId, {
                statusOf: (id) => coordinator.statusOf(id),
                occupancyOf: (id) => monitor.occupancyOf(id),
                cumulativeOf: (id) => monitor.cumulativeOf(id),
                autoActionsOf: (id) => monitor.autoActionsOf(id),
                settings: live,
                warnings: () => {
                  const warnings = validation.warnings.map((w) => w.message)
                  if (live.autoHandoffEnabled && services.tokenMeter === undefined) {
                    warnings.push('当前部署没有 tokenMeter，无法测量上下文占用率')
                  }
                  return warnings
                },
                // Same rule as the status report: durable means the deployment
                // can persist a settings write, i.e. it has a config editor.
                persistence: services.configEditor === undefined ? 'memory' : 'durable',
              }),
            )
            return
          }

          if ((req.method ?? 'GET') !== 'POST') {
            sendJson(res, 405, { ok: false, error: '方法不允许' })
            return
          }

          /*
           * The last failure, in full, for copying.
           *
           * The conversation surface truncates the red line, so the readable
           * copy has to come from somewhere else. Reading it over HTTP is
           * cheaper for the user than finding a log file, and it is the same
           * text that went to disk — useful when the file could not be written.
           */
          if (action === 'last-error' && (req.method ?? 'GET') === 'GET') {
            const last = lastFailure
            if (last === undefined) {
              sendJson(res, 200, { ok: true, error: null })
              return
            }
            sendJson(res, 200, { ok: true, error: last })
            return
          }

          // Mutating verbs are loopback-only: they can create sessions.
          if (!loopback) {
            sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
            return
          }

          /*
           * Persist settings through the host's own config editor.
           *
           * The Configuration page cannot write through the browser mirror on
           * this build, so the card posts here instead. `configEditor.edit`
           * applies the change through the normal Loader path, which means the
           * schema still validates it and the row is re-applied — the same two
           * things a hand-edited profile file would go through.
           *
           * Handled before the `sessionId` check because settings are global to
           * the plugin, not to a conversation.
           */
          if (action === 'settings') {
            const patch = (await readJsonBody(req)) as { settings?: unknown }
            const next = patch.settings
            if (next === null || typeof next !== 'object') {
              sendJson(res, 400, { ok: false, error: '缺少 settings 对象' })
              return
            }
            const editor = readServices(host).configEditor
            if (editor?.edit === undefined || editor.configuration === undefined) {
              sendJson(res, 400, { ok: false, error: '当前部署没有 configEditor，无法保存设置' })
              return
            }
            try {
              const entries = editor.configuration()
              const row = entries.find(
                (entry) =>
                  entry.entry?.id === 'include:dsh-handoff-doc' ||
                  entry.entry?.id === 'dsh-handoff-doc',
              )
              if (row?.entry === undefined) {
                sendJson(res, 404, { ok: false, error: '找不到本插件的配置行' })
                return
              }
              const desired = next as Record<string, unknown>
              await editor.edit(row.entry, (current) => ({ ...current, ...desired }))
              sendJson(res, 200, { ok: true, text: '设置已保存，立即生效。' })
            } catch (error) {
              sendJson(res, 500, {
                ok: false,
                error: `保存失败：${error instanceof Error ? error.message : String(error)}`,
              })
            }
            return
          }

          const body = (await readJsonBody(req)) as { sessionId?: unknown }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          if (sessionId === undefined) {
            sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }

          if (action === 'handoff' || action === 'retry') {
            const result = await runManual(sessionId, {
              kind: 'handoff',
              detail: action === 'retry' ? '手动 retry' : '手动 handoff',
            })
            sendJson(res, 200, result)
            return
          }

          if (action === 'cancel') {
            const accepted = coordinator.requestCancel(sessionId)
            sendJson(res, 200, {
              ok: accepted,
              phase: coordinator.statusOf(sessionId).phase,
              text: accepted ? '已请求取消，将在下一个安全检查点停止。' : '当前没有进行中的动作。',
            })
            return
          }

          sendJson(res, 404, { ok: false, error: '未知操作' })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    })

    // ---- teardown ---------------------------------------------------------
    return () => {
      log('dsh-handoff-doc: 卸载')
      offPreStep?.()
      offEvent?.()
      offDisposed?.()
      monitor.dispose()
    }
  }, 'dsh-handoff-doc')

  /** Keep the live config in step with the loader when the row is re-applied. */
  Object.assign(live, config)
}

/**
 * Run the migration.
 *
 * The snapshot is read first, while the source agent is still alive: Plan mode
 * and the permission preset live on per-agent services that disappear with the
 * agent. Everything after the create is best-effort and reported item by item.
 */
async function migrateFor(
  brief: string,
  host: { get(name: string): unknown },
  agentOf: (id: string) => AgentLike | undefined,
  sessionOf: (id: string) => SessionLike | undefined,
): Promise<ActionResult> {
  // The source id travels with the action, not in shared mutable state.
  const sourceSessionId = sourceScope.getStore()
  if (sourceSessionId === undefined) {
    return {
      ok: false,
      phase: 'failed',
      text: '内部错误：交接动作缺少来源会话 id，已放弃且未创建任何会话。',
      error: 'missing-source',
    }
  }
  const sourceSession = sessionOf(sourceSessionId)
  const services = readServices(host)
  const sourceAgent = agentOf(sourceSessionId)

  const defaultModel = safely(() => services.agentDefaultModel?.currentSelection())

  const source = snapshotSource({
    session: sourceSession,
    sessionId: sourceSessionId,
    agent: sourceAgent,
    permissionPresets: services.permissionPresets,
    approval: services.approval,
    agentPresets: services.agentPresets,
    defaultModel,
  })

  const result = await migrateSession(
    { source, brief },
    {
      sessionController: services.sessionController,
      workspaceRegistry: services.workspaceRegistry,
      permissionPresets: services.permissionPresets,
      approval: services.approval,
      agentPresets: services.agentPresets,
      defaultModel,
      resolveAgent: agentOf,
    },
  )

  return {
    ok: result.ok,
    phase: result.ok ? 'completed' : 'failed',
    text: result.ok
      ? `已创建新会话 ${result.newSessionId ?? ''} 并投递简报。`
      : `交接未完成：${result.error ?? '未知原因'}`,
    ...(result.newSessionId === undefined ? {} : { newSessionId: result.newSessionId }),
    inherited: result.inherited,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * A never-empty description of one thrown value.
 *
 * `dsh-commands` rejects a blank `CommandResult.text` with a `TypeError` raised
 * inside the registry, so returning `error.message` verbatim turns
 * `throw new Error()` into an internal command failure. The fallback names the
 * operation instead of the (absent) message.
 */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().length > 0 ? message : '命令执行失败（未提供原因）'
}

/**
 * Record a failure to disk and append the diagnostic block to the message.
 *
 * ## Why the message becomes multi-line
 *
 * The conversation surface renders a command's outcome through
 * `GenericCommandCard`, and its disclosure only exists when the text contains a
 * newline: `body = text.includes('\n') ? text : null`. A single-line error gets
 * no expansion affordance at all — it is clipped to whatever the row can show
 * and the rest is unreachable. So the short reason stays on the first line
 * (that is the collapsed summary) and everything else follows after a newline,
 * where the host's own expand control reveals it in a `<pre>`.
 *
 * ## Why the log file still exists
 *
 * The expanded `<pre>` is plain text with no copy button and no way to get it
 * out of the window. The file is what a user can attach to a report, and
 * `GET /last-error` is what works when the file cannot be written. Three
 * surfaces for one failure, because each one fails differently.
 *
 * `cwd` is passed in because the session lookup lives inside `apply()`.
 */
async function withLogHint(input: {
  text: string
  cwd: string | undefined
  sessionId: string
  where: string
  error?: unknown
  /** Facts worth keeping: budgets, character counts, which sections were missing. */
  detail?: Readonly<Record<string, unknown>> | undefined
  /** Records the failure for `GET /last-error`, when the plugin is mounted. */
  onRecord?: (failure: HandoffFailure) => void
}): Promise<string> {
  const { text, cwd } = input
  const at = Date.now()
  const path = cwd === undefined
    ? undefined
    : await recordFailure(cwd, {
        where: input.where,
        error: input.error ?? new Error(text),
        sessionId: input.sessionId,
        ...(input.detail === undefined ? {} : { context: input.detail }),
      })
  /*
   * Recorded even when the file could not be written: a read-only workspace
   * must not cost the user the only readable copy of the failure.
   */
  input.onRecord?.({
    at,
    where: input.where,
    sessionId: input.sessionId,
    message: text,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(path === undefined ? {} : { logPath: path }),
  })
  return `${text}\n${diagnosticBlock({ at, where: input.where, sessionId: input.sessionId, detail: input.detail, logPath: path })}`
}

/**
 * The lines after the first one: everything the clipped row cannot show.
 *
 * Plain text, not markdown — the host renders this inside `<pre>`, so `**bold**`
 * would appear literally. Key/value lines read fine there and stay copyable.
 */
export function diagnosticBlock(input: {
  at: number
  where: string
  sessionId: string
  detail: Readonly<Record<string, unknown>> | undefined
  logPath: string | undefined
}): string {
  const lines = ['', '--- 详细信息 ---', `时间：${new Date(input.at).toISOString()}`]
  lines.push(`阶段：${input.where}`)
  lines.push(`会话：${input.sessionId}`)
  for (const [key, value] of Object.entries(input.detail ?? {})) {
    lines.push(`${key}：${formatValue(value)}`)
  }
  lines.push(
    input.logPath === undefined
      ? '日志文件：写入失败（工作区不可写），完整堆栈未保存'
      : `日志文件：${input.logPath}`,
  )
  lines.push('完整错误也可用 GET /dsh-handoff-doc/last-error 取回')
  return lines.join('\n')
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join('、')
  if (value === null || value === undefined) return '无'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '(无法序列化)'
    }
  }
  return String(value)
}

/**
 * The settings that decide whether a handoff can succeed.
 *
 * Always included, not only when they look suspicious: the two budgets are what
 * a reader needs to judge "was this a budget problem", and asking them to go
 * read the config page to find out turns one failure into two steps.
 */
export function failureDetail(settings: { summaryMaxTokens: number; handoffDocMaxChars: number }, text: string): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    文档输出上限: `${settings.summaryMaxTokens} tokens`,
    '交接文档上限（字符）': settings.handoffDocMaxChars,
  }
  /*
   * Pull the numbers back out of the message rather than re-deriving them: the
   * message is what the user saw, and the block must describe that same run.
   */
  const produced = /写到 (\d+) 字符/.exec(text)
  if (produced !== null) detail['已产出字符'] = Number(produced[1])
  const missing = /缺：([^）]+)/.exec(text)
  if (missing !== null) detail['缺少小节'] = missing[1]!.trim()
  return detail
}

/** One recorded failure, as returned by `GET /last-error`. */
export interface HandoffFailure {
  readonly at: number
  readonly where: string
  readonly sessionId: string
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
  readonly logPath?: string
}

/**
 * Ask the model for the nine sections.
 *
 * `llm.stream` rather than a `generate` helper: the service exposes only the
 * streaming API, and it requires an explicit provider/model route. The prompt
 * carries the section structure, and no `purpose` is passed — that union is
 * closed on this build and only accepts the harness' own two values.
 */
export async function requestNarrative(
  llm: LlmLike,
  prompt: string,
  maxTokens: number,
  route: { provider: string; model: string },
  signal?: AbortSignal,
): Promise<DocNarrative> {
  const stream = llm.stream
  if (typeof stream !== 'function') {
    throw new Error('当前 llm 服务没有 stream 方法，无法生成交接文档')
  }

  const chunks = stream.call(llm, {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    /*
     * The action's deadline must reach the adapter. Without it a request that
     * never answers keeps `summarize` pending past `actionDeadlineMs`, so
     * `run()`'s `finally` never releases the latch and the session cannot
     * start its next step. `LlmStreamOptionsLike` already declares `signal`.
     */
    ...(signal === undefined ? {} : { signal }),
  })

  let text = ''
  let failure: string | undefined
  /*
   * Why the stream ended, which is not the same as why it errored.
   *
   * A `finish` with `reason.kind === 'length'` means the model was cut off by
   * `maxTokens`, not that it declined. The first live handoff failed exactly
   * this way: §0–§3 came back complete, the budget ran out inside §4, and the
   * user was told "缺少必需小节 §4" — a message that names the symptom and sends
   * the reader looking for a parsing bug that does not exist. Carrying the
   * finish reason out lets the caller say what actually happened.
   */
  let truncated = false
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'finish') {
      const reason = (chunk as { reason?: { kind?: string; failure?: { message?: string } } }).reason
      if (reason?.kind === 'length' || reason?.kind === 'max_tokens') truncated = true
      if (reason?.kind === 'error' || reason?.kind === 'aborted') {
        failure = reason.failure?.message ?? reason.kind
      }
    }
  }

  if (signal?.aborted === true && text.trim().length === 0) {
    throw new Error('生成交接文档超时，已放弃本次交接')
  }
  if (failure !== undefined) throw new Error(`模型调用失败：${failure}`)

  /*
   * A missing required section means the output budget ran out, even when no
   * `finish` chunk says so.
   *
   * This build's `llm.stream` yields a `finish` chunk only for `error` and
   * `aborted` — a normal end, including one cut off by `maxTokens`, just ends
   * the iteration. So the `kind === 'length'` check above can never fire here,
   * and a real truncation used to surface as "the model did not finish §4",
   * pointing the reader at a parsing bug instead of at the setting to raise.
   *
   * The document is written in a fixed order with the required sections first,
   * so "a required section is missing at the end" is the observable signature
   * of running out of room. Treat it as truncation whenever output was actually
   * produced; an empty response stays a plain failure.
   */
  const narrative = parseDoc(text)
  /*
   * A truncated response is reported as truncation, with the budget named.
   *
   * Throwing here (rather than returning a partial narrative that the caller
   * then rejects for "missing sections") is what turns a confusing failure into
   * an actionable one: the user is told the model ran out of output budget and
   * which setting to raise, not that section 4 could not be found.
   */
  const missing = missingRequired(narrative)
  if (missing.length > 0) {
    const names = missing
      .map((key) => DOC_SECTIONS.find((section) => section.key === key)?.heading.replace(/^##\s*/, '') ?? key)
      .join('、')
    /*
     * Output that stops short of a required section is a budget problem, whether
     * or not the stream said so.
     *
     * Three ways a real truncation has arrived here:
     *   1. `finish` with `kind === 'length'` — the documented shape;
     *   2. no `finish` chunk at all — a normal end that ran out of room;
     *   3. `finish` with `kind === 'stop'` — an adapter reporting the provider's
     *      natural stop even though its own `maxTokens` cut the text.
     *
     * Only case 3 kept the misleading wording, and it is the one that happened:
     * the message blamed the model for not finishing §4 while the setting was
     * genuinely too small. Distinguishing them buys nothing — the user's next
     * action is identical in all three, and the alternative is a message that
     * sends them hunting for a parser bug that does not exist.
     */
    const produced = text.length
    if (produced > 0) {
      throw new Error(
        `模型输出在写到 ${produced} 字符时停止，必需小节没写完（缺：${names}）。`
        + `这通常是输出预算不够：请把设置里的「文档输出上限」从 ${maxTokens} 调大`
        + `（例如 ${Math.ceil((maxTokens * 1.5) / 1000) * 1000}），或把「交接文档上限（字符）」调小，然后 /handoff retry。`,
      )
    }
    throw new Error(`模型没有返回任何内容（缺：${names}）。已放弃本次交接，可 /handoff retry。`)
  }

  return narrative
}

/**
 * The route used to summarize.
 *
 * Prefers the session's own provider/model — the model that did the work is the
 * one that can describe it — and falls back to the deployment default when the
 * session never recorded a request.
 */
function summaryRoute(
  facts: SessionFacts,
  services: ReturnType<typeof readServices>,
): { provider: string; model: string } | undefined {
  if (facts.provider !== undefined && facts.model !== undefined) {
    return { provider: facts.provider, model: facts.model }
  }
  try {
    const fallback = services.agentDefaultModel?.currentSelection()
    return fallback === undefined ? undefined : { provider: fallback.provider, model: fallback.model }
  } catch {
    return undefined
  }
}

void deliverBrief
void waitForBoundary
export { readGitFacts }

/**
 * The version label in the document header.
 *
 * `v<plugin version> / <date>` mirrors the shape the user asked for
 * ("v1.5.0 / 2026-10-27 最后验证"). The plugin version is the honest answer to
 * "which tooling produced this document" — a reader comparing two handoffs from
 * different plugin versions needs that, and the date alone cannot say it.
 */
export function versionOf(facts: DocFacts): string {
  const head = facts.git?.head
  const short = head === undefined ? '' : ` · ${head.slice(0, 8)}`
  return `v${PLUGIN_VERSION}${short}`
}

/** Bumped when the document skeleton changes, so old files are recognisable. */
export const PLUGIN_VERSION = '0.2.0'

/** Map the session-side pending-input fact onto the document's own shape. */
export function toDocPending(pending: PendingInput): {
  readonly kind: 'question' | 'unanswered-assistant'
  readonly detail?: string
} {
  return pending.kind === 'question'
    ? { kind: 'question', ...(pending.detail === undefined ? {} : { detail: pending.detail }) }
    : { kind: 'unanswered-assistant' }
}
