/**
 * Project identity and the verification commands that already exist.
 *
 * ## Why the plugin reads `package.json` instead of asking the model
 *
 * The document's §0 is the part that decides whether a successor reads on. Its
 * value comes entirely from being *true*: "run `npm run check`" is useful only
 * if that script exists and covers what it claims. A model asked to recall the
 * verification command will produce a plausible one, and a plausible command
 * that does not exist sends the successor debugging the harness instead of the
 * project.
 *
 * So the commands come from disk. The model may describe them; it may not
 * invent them.
 *
 * ## Why `proves` is copied from the source rather than inferred
 *
 * A script named `test:image` proves nothing by its name. When the project
 * documents it (a README line, a `//` comment above a Makefile target), that
 * wording is copied verbatim — it is the only trustworthy statement about what
 * passing means. When nothing documents it, `proves` says so plainly
 * ("脚本名推断"), which is a different fact from "verified by the project".
 */
import { join } from 'node:path'
import type { SessionEventLike } from './contracts.ts'
import type { GitFacts, ProjectCommand } from './handoff-doc.ts'
import type { WorkspaceFiles } from './workspace-fs.ts'
import { readWorkScope, type WorkScope } from './work-scope.ts'

/** Everything the plugin knows about a project before asking the model anything. */
export interface ProjectFacts {
  /** Folder name for the handoff directory; see `projectSlug`. */
  readonly slug: string
  /** Human title: the manifest's `name`, else the folder name. */
  readonly title: string
  readonly cwd: string | undefined
  readonly commands: readonly ProjectCommand[]
  readonly stack: readonly string[]
  readonly git: GitFacts | undefined
  /** Which sub-projects the session actually worked in, most-worked first. */
  readonly scope: readonly WorkScope[]
  /**
   * Absolute path of the directory the session focused on, when there is one.
   *
   * The caller reads git facts from here rather than from the workspace root:
   * a multi-project workspace is often not a repository at all, and "branch
   * unknown" for the one project actually being edited is a worse fact than no
   * fact.
   */
  readonly focusRoot: string | undefined
}

/** Files that identify a stack, in the order they are reported. */
const STACK_MARKERS: readonly { readonly file: string; readonly label: string }[] = [
  { file: 'package.json', label: 'Node' },
  { file: 'pnpm-lock.yaml', label: 'pnpm' },
  { file: 'pnpm-workspace.yaml', label: 'pnpm workspace' },
  { file: 'yarn.lock', label: 'yarn' },
  { file: 'package-lock.json', label: 'npm' },
  { file: 'tsconfig.json', label: 'TypeScript' },
  { file: 'pyproject.toml', label: 'Python' },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'go.mod', label: 'Go' },
  { file: 'Cargo.toml', label: 'Rust' },
  { file: 'pom.xml', label: 'Maven' },
  { file: 'build.gradle', label: 'Gradle' },
  { file: 'Makefile', label: 'Make' },
  { file: 'docker-compose.yml', label: 'Docker Compose' },
  { file: 'Dockerfile', label: 'Docker' },
]

/**
 * Script names that mean "verify", most authoritative first.
 *
 * Ordered by how much a passing run establishes, not alphabetically: a combined
 * `check` beats its parts, and `typecheck` alone is the weakest useful signal.
 */
const VERIFY_SCRIPT_PRIORITY: readonly string[] = [
  'check',
  'test',
  'test:all',
  'test:unit',
  'lint',
  'typecheck',
  'build',
]

/**
 * Read everything observable about the project.
 *
 * Every read is tolerant: a malformed `package.json` costs the script list, not
 * the handoff. The document still gets written, and §0 says the commands could
 * not be read — which is a fact the successor can act on, unlike a crash.
 *
 * ## Why a workspace with no manifest falls back to its sub-projects
 *
 * A common layout is a workspace directory that holds several independent
 * projects (`<workspace>/plugin-a/package.json`, `<workspace>/plugin-b/...`)
 * and has no manifest of its own. Reading only the root then reports "no
 * verification command found" — advice that is not just useless but wrong, since
 * the successor is told to go and invent one. The fallback reads one level down
 * and names each sub-project's commands, which is what a human would have done.
 */
/**
 * Sub-project directories in this workspace, before any command is read.
 *
 * Split out because the **directory name** depends on which sub-project the
 * session worked in, while the facts that reveal it need the slug first. Listing
 * directories is the cheap step that breaks that cycle.
 */
export async function listSubProjects(files: WorkspaceFiles): Promise<readonly string[]> {
  const names = await files.list('.')
  const found: string[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'lib') continue
    if (await files.exists(`${name}/package.json`)) found.push(name)
  }
  return found
}

/**
 * The sub-project the session focused on, or `undefined` when it did not.
 *
 * Used to name the handoff directory after the project rather than after the
 * workspace folder: `docs/handoff/dsh-handoff-doc/` says what the handoff is
 * about, while `docs/handoff/deepseek-harness/` names the container the session
 * happened to sit in.
 */
export function focusFromEvents(
  events: readonly SessionEventLike[] | undefined,
  candidates: readonly string[],
): WorkScope | undefined {
  return readWorkScope(events, candidates).find((entry) => entry.focus)
}

export async function readProjectFacts(input: {
  files: WorkspaceFiles
  cwd: string | undefined
  slug: string
  /** Injected so tests need not run git. */
  readonly git?: GitFacts | undefined
  /**
   * The session's own log, used only to rank sub-projects by attention.
   *
   * Optional: a caller without a log (a manual script, a test) gets the old
   * behaviour, where sub-projects are reported in directory order.
   */
  readonly events?: readonly SessionEventLike[] | undefined
}): Promise<ProjectFacts> {
  const { files } = input

  const stack: string[] = []
  for (const marker of STACK_MARKERS) {
    if (await files.exists(marker.file)) stack.push(marker.label)
  }

  const manifest = await readManifest(files)
  const scripts = await readScripts(files, manifest)
  const makeTargets = await readMakeTargets(files)
  const readme = await readReadme(files)

  const rootCommands = rankCommands([...scripts, ...makeTargets], readme)
  /*
   * Rank sub-projects by what the session touched, then fall back to directory
   * order. `scope` is empty whenever the log names no sub-project, which keeps
   * this identical to the old behaviour for a workspace that was never worked
   * in — and for every caller that does not pass a log.
   */
  const subCommands =
    rootCommands.length > 0 ? [] : await readSubprojectCommands(files, input.events)

  const commands = rootCommands.length > 0 ? rootCommands : subCommands

  /*
   * A workspace with no manifest of its own has no stack of its own either, and
   * "未识别技术栈" then reads as a defect. Fall back to the stacks of its
   * sub-projects, which is the honest answer to "what is in here".
   */
  const effectiveStack =
    stack.length > 0 ? stack : commands.length > 0 ? await readSubprojectStack(files) : []

  const scope =
    rootCommands.length > 0 ? [] : readWorkScope(input.events, subProjectNames(commands))
  const focus = scope.find((entry) => entry.focus)

  return {
    slug: input.slug,
    title: manifest?.name ?? input.slug,
    cwd: input.cwd,
    commands,
    stack: effectiveStack,
    git: input.git,
    scope,
    focusRoot:
      focus === undefined || input.cwd === undefined ? undefined : join(input.cwd, focus.directory),
  }
}

/**
 * Sub-project directory names referenced by a command list.
 *
 * Read back out of the `cd <dir> && ` prefix the command already carries, so
 * the scope candidates are exactly the directories that produced a command.
 * Nothing is parsed from the log itself: a directory earns a scope only if it
 * is a project the document would otherwise talk about.
 */
function subProjectNames(commands: readonly ProjectCommand[]): readonly string[] {
  const names: string[] = []
  for (const command of commands) {
    const match = /^cd\s+(\S+)\s*&&/.exec(command.command)
    if (match === null) continue
    const name = match[1]!
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Distinct stack labels found one level down.
 *
 * Deduplicated and capped: three sub-projects that are all `Node + TypeScript`
 * should say that once, not three times.
 */
async function readSubprojectStack(files: WorkspaceFiles): Promise<readonly string[]> {
  const names = await files.list('.')
  const labels = new Set<string>()
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'lib') continue
    for (const marker of STACK_MARKERS) {
      if (labels.size >= 6) return [...labels]
      if (await files.exists(`${name}/${marker.file}`)) labels.add(marker.label)
    }
  }
  return [...labels]
}

/** How deep to look for sub-project manifests. One level is a layout; two is a guess. */
const SUBPROJECT_SCAN_DEPTH = 1

/**
 * Commands from one level of sub-directories, each labelled with its project.
 *
 * Bounded by the directory count and by a per-project command cap, so a
 * workspace with two hundred folders cannot turn §0 into a listing. Ordering is
 * directory order, which is stable and matches what the user sees in an editor.
 */
async function readSubprojectCommands(
  files: WorkspaceFiles,
  events?: readonly SessionEventLike[] | undefined,
): Promise<readonly ProjectCommand[]> {
  if (SUBPROJECT_SCAN_DEPTH < 1) return []
  const found: ProjectCommand[] = []

  for (const name of await listSubProjects(files)) {
    const manifest = await readManifestIn(files, name)
    if (manifest === undefined) continue
    const scripts = await readScriptsIn(files, manifest, name)
    /*
     * One command per sub-project: `check` already runs the tests, so listing
     * both spends §0's three lines on the same evidence. `check` ranks first,
     * so the one kept is the most informative.
     */
    for (const command of scripts.slice(0, 1)) found.push(command)
  }

  /*
   * Directory order is the fallback, not the answer.
   *
   * The successor is told to run §0's commands before doing anything, so their
   * order is a recommendation. With no signal it must be stable and match what
   * the user sees in an editor; with a log it must put the project this session
   * actually worked in first.
   */
  const ordered = orderByScope(found, events)
  return ordered.slice(0, 6)
}

/**
 * Put the session's focus first, then the untouched projects in directory order.
 *
 * Only the focus is moved. Demoting by usage *count* would reshuffle the list
 * between two handoffs of the same session for no benefit; what matters is
 * which project the successor should check first, and after that a stable
 * order is easier to diff than a ranking.
 */
function orderByScope(
  commands: readonly ProjectCommand[],
  events: readonly SessionEventLike[] | undefined,
): readonly ProjectCommand[] {
  const scope = readWorkScope(events, subProjectNames(commands))
  const focus = scope.find((entry) => entry.focus)
  if (focus === undefined) return commands
  const isFocus = (command: ProjectCommand): boolean =>
    new RegExp(`^cd\\s+${escapeRegExp(focus.directory)}\\s*&&`).test(command.command)
  return [...commands.filter(isFocus), ...commands.filter((command) => !isFocus(command))]
}

/** A manifest inside a sub-directory, if it has one. */
async function readManifestIn(files: WorkspaceFiles, directory: string): Promise<Manifest | undefined> {
  const raw = await files.read(`${directory}/package.json`)
  if (raw === undefined) return undefined
  return parseManifest(raw)
}

/** Scripts of a sub-project, with the directory in the command and the origin. */
async function readScriptsIn(
  files: WorkspaceFiles,
  manifest: Manifest,
  directory: string,
): Promise<ProjectCommand[]> {
  const packageManager = (await files.exists(`${directory}/pnpm-lock.yaml`))
    ? 'pnpm'
    : (await files.exists(`${directory}/yarn.lock`))
      ? 'yarn'
      : 'npm'

  const commands: ProjectCommand[] = []
  for (const [name, body] of Object.entries(manifest.scripts)) {
    if (!isVerifyScript(name)) continue
    commands.push({
      // `cd` first: the successor is standing in the workspace root, and a bare
      // `npm run check` there would run the wrong project or nothing at all.
      command: `cd ${directory} && ${packageManager} run ${name}`,
      origin: `${directory}/package.json#scripts.${name}`,
      proves: describeScript(name),
      definition: oneLine(body),
    })
  }
  /*
   * Ranked, not manifest order.
   *
   * `Object.entries` follows the file's key order, which put `build` ahead of
   * `check` in this very repository. The successor reads the first two lines of
   * §0, so the most authoritative check must be first — a build passing says far
   * less than `check` passing.
   */
  return commands.sort((a, b) => rankOf(a) - rankOf(b))
}

/** The parts of `package.json` this plugin reads. */
interface Manifest {
  readonly name: string | undefined
  readonly scripts: Readonly<Record<string, string>>
  /** Dependencies, for stack detection when no lock file is present. */
  readonly deps: readonly string[]
}

async function readManifest(files: WorkspaceFiles): Promise<Manifest | undefined> {
  const raw = await files.read('package.json')
  if (raw === undefined) return undefined
  return parseManifest(raw)
}

/**
 * Parse a manifest, tolerating any malformation.
 *
 * A broken manifest must not cost the handoff; §0 will say no commands were
 * found, which is true and actionable.
 */
function parseManifest(raw: string): Manifest | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown
      scripts?: unknown
      dependencies?: unknown
      devDependencies?: unknown
    }
    const scripts: Record<string, string> = {}
    if (parsed.scripts !== null && typeof parsed.scripts === 'object') {
      for (const [key, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
        if (typeof value === 'string') scripts[key] = value
      }
    }
    const deps = [
      ...Object.keys((parsed.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...Object.keys((parsed.devDependencies as Record<string, unknown> | undefined) ?? {}),
    ]
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      scripts,
      deps,
    }
  } catch {
    return undefined
  }
}

/** Turn npm scripts into commands, keeping the exact script body as evidence. */
async function readScripts(files: WorkspaceFiles, manifest: Manifest | undefined): Promise<ProjectCommand[]> {
  if (manifest === undefined) return []
  const packageManager = (await files.exists('pnpm-lock.yaml'))
    ? 'pnpm'
    : (await files.exists('yarn.lock'))
      ? 'yarn'
      : 'npm'

  const commands: ProjectCommand[] = []
  for (const [name, body] of Object.entries(manifest.scripts)) {
    /*
     * Only verification-shaped scripts. A `dev`/`start` script is not a
     * check — running it starts a server and never exits, which in a §0
     * self-check is actively harmful.
     */
    if (!isVerifyScript(name)) continue
    commands.push({
      // `npm run <name>` works for every script including `test`; mixing the
      // bare `npm test` shorthand in would make the list inconsistent for no
      // benefit, and a copied line is what the successor will paste.
      command: `${packageManager} run ${name}`,
      origin: `package.json#scripts.${name}`,
      // The script body is the project's own statement of what it does, so it
      // travels as evidence rather than being paraphrased into `proves`.
      proves: describeScript(name),
      definition: oneLine(body),
    })
  }
  return commands
}

/** Verification-shaped script names, including `test:*` families. */
function isVerifyScript(name: string): boolean {
  return /^(check|test|lint|typecheck|types|build|verify|validate)(:[\w-]+)?$/i.test(name)
}

/** A plain-language reading of a script name, never an invented guarantee. */
function describeScript(name: string): string {
  if (/^check$/i.test(name)) return '全部检查通过（通常是类型 + 测试的组合）'
  if (/^test$/i.test(name)) return '测试全绿'
  if (/^test:/i.test(name)) return `该子集测试全绿（${name.slice(5)}）`
  if (/^lint$/i.test(name)) return '无 lint 错误'
  if (/^typecheck$|^types$/i.test(name)) return '类型检查通过'
  if (/^build$/i.test(name)) return '构建产物可生成'
  return '该脚本成功退出'
}

/** `Makefile` targets that look like checks. */
async function readMakeTargets(files: WorkspaceFiles): Promise<ProjectCommand[]> {
  const raw = await files.read('Makefile')
  if (raw === undefined) return []
  const commands: ProjectCommand[] = []
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z][\w.-]*)\s*:(?!=)/.exec(line)
    if (match === null) continue
    const target = match[1]!
    if (!/^(test|check|lint|verify|ci)/i.test(target)) continue
    commands.push({
      command: `make ${target}`,
      origin: 'Makefile',
      proves: `${describeScript(target)}（目标名推断，Makefile 未写说明）`,
    })
  }
  return commands
}

/**
 * README text, used only to copy a project's own description of a command.
 *
 * Bounded: a 200 kB README is not worth parsing, and the first 20 kB is where
 * a "Commands" section lives when one exists.
 */
async function readReadme(files: WorkspaceFiles): Promise<string | undefined> {
  for (const name of ['README.md', 'README.MD', 'readme.md', 'README']) {
    const raw = await files.read(name)
    if (raw !== undefined) return raw.slice(0, 20_000)
  }
  return undefined
}

/**
 * Order the commands and drop duplicates.
 *
 * Priority is by script name, then by discovery order. A duplicate command
 * (the same line from two sources) keeps its first, most specific origin.
 */
function rankCommands(commands: readonly ProjectCommand[], readme: string | undefined): readonly ProjectCommand[] {
  const seen = new Set<string>()
  const unique: ProjectCommand[] = []
  for (const command of commands) {
    if (seen.has(command.command)) continue
    seen.add(command.command)
    unique.push(readme === undefined ? command : withReadmeWording(command, readme))
  }

  return unique.sort((a, b) => rankOf(a) - rankOf(b))
}

/** Lower is more authoritative. */
function rankOf(command: ProjectCommand): number {
  /*
   * Strip a leading `cd <dir> && ` before reading the script name: sub-project
   * commands carry their directory, and without this every one of them would
   * rank last and the ordering above would silently do nothing.
   */
  const name = command.command
    .replace(/^cd\s+\S+\s*&&\s*/, '')
    .replace(/^(npm|pnpm|yarn|make)\s+(run\s+)?/, '')
  const index = VERIFY_SCRIPT_PRIORITY.indexOf(name)
  return index < 0 ? VERIFY_SCRIPT_PRIORITY.length + 1 : index
}

/**
 * Replace an inferred description with the project's own words, when it has
 * any.
 *
 * Looks for the command on a line of the README and takes the surrounding text
 * as the description. This is the difference between "脚本名推断" and a sentence
 * the project wrote about what passing proves — and it is the only case where
 * the plugin is allowed to trust prose over structure.
 */
function withReadmeWording(command: ProjectCommand, readme: string): ProjectCommand {
  const needle = command.command
  for (const line of readme.split('\n')) {
    if (!line.includes(needle)) continue
    // Strip markdown decoration and the command itself; keep what is left.
    const cleaned = line
      .replace(/`/g, '')
      .replace(/^[\s|>*\-+]+/, '')
      .replace(new RegExp(escapeRegExp(needle), 'g'), '')
      .replace(/^[\s|:—-]+|[\s|]+$/g, '')
      .trim()
    if (cleaned.length < 6 || cleaned.length > 160) continue
    // A table row's remaining cells are usually the description.
    return { ...command, proves: `${cleaned}（README 原文）` }
  }
  return command
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 120)}…`
}

/**
 * Stack labels from dependencies, for projects with no lock file.
 *
 * Only used to make §0's environment line less vague; a wrong guess costs a
 * word, not an action.
 */
export function stackFromDeps(deps: readonly string[]): readonly string[] {
  const labels: string[] = []
  if (deps.includes('react')) labels.push('React')
  if (deps.includes('vue')) labels.push('Vue')
  if (deps.includes('typescript')) labels.push('TypeScript')
  if (deps.includes('vitest') || deps.includes('jest')) labels.push('Vitest/Jest')
  return labels
}
