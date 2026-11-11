import { isSelftestReport } from './runtime/baseline-failures.mjs'
import { reservedEnvironmentErrors } from './config/release-plan.mjs'
import { CREATE_ID, DESTROY_ID, START_ID, SYNC_ID, namesInstance, takesChanged } from './runtime/instance-drive.mjs'

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

export function infrastructureErrors (infra) {
  if (!infra) return []
  const environments = [infra.staging, ...infra.deployments]
  const errors = []
  if (new Set(environments.map(e => e.id)).size !== environments.length) errors.push('environment ids must be unique')
  errors.push(...reservedEnvironmentErrors(infra))
  for (const e of infra.deployments) if (e.fullVerification) errors.push(`${e.id}: fullVerification applies to the staging environment only`)
  if (infra.deployments.some(e => e.ssh.hostRef === infra.staging.ssh.hostRef)) errors.push('staging and deployment containers must have different SSH host references')
  if (!infra.testDrive.commands.some(c => c.required !== false)) errors.push('testDrive needs at least one required command')
  const commands = [...infra.testDrive.commands, ...(infra.testDrive.finallyCommands ?? [])]
  if (new Set(commands.map(c => c.id)).size !== commands.length) errors.push('testDrive command ids must be unique')
  errors.push(...confinedCommandErrors(infra.testDrive))
  // `needs` names earlier commands; finalizers always run, so they need nothing.
  infra.testDrive.commands.forEach((c, i) => {
    for (const id of c.needs ?? []) if (!infra.testDrive.commands.slice(0, i).some(e => e.id === id)) errors.push(`${c.id}: needs must name an earlier command (${id})`)
  })
  for (const c of infra.testDrive.finallyCommands ?? []) if (c.needs) errors.push(`${c.id}: finallyCommands always run and cannot declare needs`)
  errors.push(...reportingErrors(infra.testDrive))
  errors.push(...tierErrors(infra.testDrive))
  // The project's tiers and baseline are the full verification; the modules tier stands beside them.
  errors.push(...modulesErrors({ modules: infra.testDrive.modules, confinement: infra.testDrive.confinement }))
  for (const name of infra.testDrive.baselineCache?.stagingFiles ?? []) if (!infra.staging.files?.[name]) errors.push(`testDrive.baselineCache.stagingFiles: ${name} is not in infrastructure.staging.files`)
  const deployment = [...(infra.stagingDeployment?.commands ?? []), ...(infra.stagingDeployment?.diagnostics ?? [])]
  if (new Set(deployment.map(c => c.id)).size !== deployment.length) errors.push('stagingDeployment command ids must be unique')
  if (deployment.some(c => c.required === false)) errors.push('stagingDeployment commands must all be required')
  for (const e of environments) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(e.ssh.workdir) || e.ssh.workdir.split('/').includes('..')) errors.push(`${e.id}: SSH workdir must be an absolute shell-safe path without parent traversal`)
  }
  for (const id of Object.keys(infra.release?.targets ?? {})) if (!environments.some(e => e.id === id)) errors.push(`release target ${id} is not a declared environment`)
  return errors
}

/** `reportsUnavailable` decides a drive's result, so it means nothing on a command that decides none. */
function reportingErrors (target) {
  return [
    ...target.commands.filter((c) => c.reportsUnavailable && c.required === false).map((c) => `${c.id}: reportsUnavailable applies to a required command`),
    ...(target.finallyCommands ?? []).filter((c) => c.reportsUnavailable).map((c) => `${c.id}: reportsUnavailable does not apply to finallyCommands`)
  ]
}

/**
 * A smoke tier is a subset of the target that must run on its own: every id
 * exists, and what a smoke command needs or joins is in the smoke tier too.
 * Tiers defer the full drive to the approved revision, so every-revision
 * timing contradicts them.
 */
export function tierErrors (target) {
  const smoke = target?.tiers?.smoke
  if (!smoke) return []
  const errors = []
  const all = [...(target.commands ?? []), ...(target.finallyCommands ?? [])]
  for (const id of smoke) if (!all.some(c => c.id === id)) errors.push(`tiers.smoke: ${id} is not a command of the target`)
  for (const c of all.filter(c => smoke.includes(c.id))) {
    for (const id of [...(c.needs ?? []), ...(c.join ? [c.join] : [])]) if (!smoke.includes(id)) errors.push(`tiers.smoke: ${c.id} needs ${id}, which is not in the smoke tier`)
  }
  if (target.timing === 'every-revision') errors.push('tiers run the full drive on the approved revision; timing: every-revision contradicts them')
  errors.push(...targetedErrors(target, all))
  return errors
}

// Words the shell would treat as anything but a plain word: no quote, expansion, operator, glob, comment or newline can be spelled in them.
const TEMPLATE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/
// The command is a path or a name, and with no `=` it cannot be an assignment that leaves the first name as the command.
// `@` is plain to the shell and begins every Boilerplate framework collection (`@boilerplate/tooling/<script>`).
const TEMPLATE_COMMAND = /^[A-Za-z0-9_.@/][A-Za-z0-9_.@/-]*$/
// Shell builtins and reserved words: some evaluate an argument (`eval`, `let`, `test -v 'a[$(x)]'`), and none runs a test suite.
const SHELL_WORDS = '. alias bg bind break builtin caller case cd command compgen complete compopt continue coproc declare dirs disown do done echo elif else enable esac eval exec exit export false fc fg fi for function getopts hash help history if in jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return select set shift shopt source suspend test then time times trap true type typeset ulimit umask unalias unset until wait while'.split(' ')
// Programs whose purpose is to run their arguments.
const RUNNERS = 'env nohup nice ionice setsid stdbuf timeout sudo doas su xargs chroot flock watch parallel sh bash dash ash zsh ksh fish busybox'.split(' ')
const NOT_A_TEST_COMMAND = new Set([...SHELL_WORDS, ...RUNNERS])

/**
 * Why a template is not `command word... {{tests}} word...`, or null. Validation
 * accepts only this form instead of reading shell syntax: single spaces between
 * plain words, a literally named command, and `{{tests}}` as a word of its own.
 * Nothing in it can change how the shell reads the generated quotes, so each name
 * reaches the command as one argument. A script takes anything more complex. What
 * a called program does with its arguments cannot be seen from here
 * (docs/project-infrastructure.md "The targeted tier").
 */
function templateProblem (run, placeholder = 'tests', { instance = false } = {}) {
  const slot = `{{${placeholder}}}`
  // The instance placeholders stand for a root and a name the engine builds from plain characters only.
  const plain = (word) => TEMPLATE_WORD.test(word) || (instance && ['{{instance}}', '{{instanceName}}'].includes(word))
  const count = run.split(slot).length - 1
  if (count !== 1) return `must hold ${slot} exactly once, found ${count}`
  const [command, ...words] = run.split(' ')
  if (!TEMPLATE_COMMAND.test(command)) return `must start with a literally named command, not ${JSON.stringify(command)}: anything more complex belongs in a script`
  if (NOT_A_TEST_COMMAND.has(command.slice(command.lastIndexOf('/') + 1))) return `must name a program that takes the tests as arguments; ${command} is a shell word or runs its arguments`
  for (const word of words) {
    if (word !== slot && !plain(word)) return `must be plain words separated by single spaces, with ${slot} as a word of its own, not ${JSON.stringify(word)}: anything more complex belongs in a script`
  }
  return null
}

/**
 * A targeted tier is a subset of the target that must run on its own and must
 * be able to prove what it ran: its template takes over one required command,
 * and what it needs or joins is in the tier, with a selftest report among it.
 */
function targetedErrors (target, all) {
  const targeted = target.tiers.targeted
  if (!targeted) return []
  const errors = []
  const command = (target.commands ?? []).find(c => c.id === targeted.command)
  if (!command) errors.push(`tiers.targeted: ${targeted.command} is not a command of the target (a finalizer cannot take the template)`)
  else if (command.service === true) errors.push(`tiers.targeted: ${targeted.command} is a service and cannot take the template`)
  else if (command.required === false) errors.push(`tiers.targeted: ${targeted.command} is not required, so its failure would gate nothing`)
  for (const id of targeted.always) if (!all.some(c => c.id === id)) errors.push(`tiers.targeted: ${id} is not a command of the target`)
  const ids = [...targeted.always, targeted.command]
  const selected = all.filter(c => ids.includes(c.id))
  for (const c of selected) {
    for (const id of [...(c.needs ?? []), ...(c.join ? [c.join] : [])]) if (!ids.includes(id)) errors.push(`tiers.targeted: ${c.id} needs ${id}, which is not in the targeted tier`)
  }
  if (!selected.some(c => isSelftestReport(c.report))) errors.push('tiers.targeted: no command of the tier declares report: selftest, so nothing could prove the named tests ran')
  const problem = templateProblem(targeted.run)
  if (problem) errors.push(`tiers.targeted.run ${problem}`)
  return errors
}

/** The modules tier's slots in drive order (`modules-tier.mjs` expands test and browser per filter). */
export const MODULE_SLOTS = ['lint', 'load', 'restart', 'ready', 'test', 'browser']

/**
 * A modules tier (`modules`, docs/project-infrastructure.md "The modules tier"):
 * the templates take their placeholder once in the targeted tier's plain-word
 * form, so every file and filter reaches its program as one argument (test and
 * browser take `{{filter}}`, one command per filter, or `{{filters}}`, one
 * command with every filter as an argument of its own); every slot
 * is required and none is a service; and it carries no tiers or baseline, which
 * belong to the full verification.
 */
export function modulesErrors (target) {
  const modules = target?.modules
  if (!modules) return []
  const errors = []
  const slots = MODULE_SLOTS.filter((slot) => modules[slot]).map((slot) => ({ slot, ...modules[slot] }))
  const all = [...slots, ...(modules.finallyCommands ?? [])]
  if (new Set(all.map((c) => c.id)).size !== all.length) errors.push('modules: command ids must be unique')
  for (const c of slots) {
    if (c.required === false) errors.push(`modules.${c.slot}: every command of the modules tier is required`)
    if (c.service === true) errors.push(`modules.${c.slot}: a modules command cannot be a service (the stage instance is the project's own)`)
    if (c.needs || c.join) errors.push(`modules.${c.slot}: the modules tier runs in a fixed order; needs and join do not apply`)
  }
  for (const c of all) {
    const multi = ['test', 'browser'].includes(c.slot) && typeof c.run === 'string' && c.run.includes('{{filters}}')
    if (c.timeoutSecondsPerFilter !== undefined && !multi) errors.push(`${c.slot ? `modules.${c.slot}` : c.id}: timeoutSecondsPerFilter applies only to a test or browser template holding {{filters}}`)
  }
  for (const c of modules.finallyCommands ?? []) if (c.needs) errors.push(`${c.id}: finallyCommands always run and cannot declare needs`)
  // The selftest report is the tier's evidence: a drive that collects none could pass unexamined.
  if (!all.some((c) => isSelftestReport(c.report))) errors.push('modules: no command declares report: selftest (the test slot or a finalizer), so nothing would show which tests ran or failed')
  // Test and browser expand to `<id>-<n>`: no declared id may be one of those, or a log would overwrite another's.
  const expanding = ['test', 'browser'].filter((slot) => modules[slot]).map((slot) => modules[slot].id)
  if (modules.browser && modules.browser.id === modules.test.id) errors.push('modules: test and browser need different ids, they expand to the same <id>-<n>')
  for (const c of all) {
    for (const id of expanding) if (new RegExp(`^${id}-[0-9]+$`).test(c.id)) errors.push(`modules: ${c.id} is the id a generated ${id} command takes (${id}-<n>); rename one`)
  }
  const placeholder = { lint: 'files', test: 'filter', browser: 'filter' }
  for (const c of slots) {
    if (placeholder[c.slot]) {
      // test and browser take one filter per command, or every filter in one command ({{filters}}); never both.
      const multi = placeholder[c.slot] === 'filter' && typeof c.run === 'string' && c.run.includes('{{filters}}')
      const problem = templateProblem(c.run, multi ? 'filters' : placeholder[c.slot], { instance: Boolean(modules.instance) })
      if (problem) errors.push(`modules.${c.slot}.run ${problem}`)
    } else if (/\{\{(files|filters?|tests)\}\}/.test(c.run)) errors.push(`modules.${c.slot}.run: only lint takes {{files}} and only test and browser take {{filter}} or {{filters}}`)
  }
  errors.push(...instanceErrors(modules, all))
  if (target.tiers) errors.push('modules and tiers do not go on one target: the modules tier is the per-revision check, tiers are the full verification')
  if (target.compareBaseline || target.baselineCache) errors.push('the modules tier has no base drive: compareBaseline and baselineCache do not apply')
  if (target.timing === 'approved') errors.push('the modules tier runs on every revision beside the reviews; timing: approved contradicts it')
  errors.push(...confinedCommandErrors({ commands: slots.map(({ slot, ...c }) => c), finallyCommands: modules.finallyCommands, confinement: target.confinement }).filter((e) => !e.startsWith('testDrive.confinement is set')))
  return errors
}

/**
 * A modules tier on a stage instance of its own (`modules.instance`, instance-drive.mjs):
 * create, start and destroy must name the instance they act on, the tier's own commands
 * name it too (one that named a fixed instance would test something else), and the tier is
 * unstructured, since creating an instance reads the candidate and manages units, which
 * neither command kind allows. Without `instance` no command may hold the placeholders.
 */
function instanceErrors (modules, all) {
  const instance = modules.instance
  if (!instance) return all.filter((c) => namesInstance(c.run)).map((c) => `${c.slot ? `modules.${c.slot}` : c.id}: {{instance}} and {{instanceName}} need modules.instance; without it the tier runs on the one fixed instance its commands name`)
  const errors = []
  if (instance.root.split('/').includes('..')) errors.push('modules.instance.root must not hold parent traversal')
  for (const step of ['create', 'start', 'destroy']) if (!namesInstance(instance[step].run)) errors.push(`modules.instance.${step}.run must name the instance: {{instanceName}} or {{instance}}`)
  if (instance.gc && namesInstance(instance.gc.run)) errors.push('modules.instance.gc.run removes what no run holds on the stage host; it names no instance')
  const sync = instance.syncDependencies
  if (sync) {
    if (!namesInstance(sync.run) || !takesChanged(sync.run)) errors.push('modules.instance.syncDependencies.run must name the owner ({{instanceName}}) and hold {{changed}} exactly once, as a word of its own: the revision\'s changed manifest paths')
    if (!namesInstance(sync.revert.run)) errors.push('modules.instance.syncDependencies.revert.run must name the owner: {{instanceName}}')
    if (!instance.create.unavailableExitCodes?.length) errors.push('modules.instance.syncDependencies needs create.unavailableExitCodes: the sync runs when create answers one of them')
    if (sync.busyExitCodes?.some((code) => sync.unavailableExitCodes?.includes(code))) errors.push('modules.instance.syncDependencies: an exit status is either a wait (busyExitCodes) or a refusal (unavailableExitCodes), not both')
  }
  if (instance.start.staleExitCodes?.some((code) => instance.start.busyExitCodes?.includes(code))) errors.push('modules.instance.start: an exit status is either a wait (busyExitCodes) or a stale instance (staleExitCodes), not both')
  for (const c of all) if ([CREATE_ID, START_ID, SYNC_ID, DESTROY_ID].includes(c.id)) errors.push(`modules: ${c.id} is the id of the engine's own instance command; rename it`)
  for (const slot of ['load', 'restart', 'ready', 'test']) if (!namesInstance(modules[slot].run)) errors.push(`modules.${slot}.run must name the instance ({{instance}} or {{instanceName}}): with modules.instance every drive runs on the run's own instance`)
  if (all.some((c) => c.kind)) errors.push('modules.instance needs an unstructured tier (no command kinds): creating an instance reads the candidate and manages units')
  return errors
}

/**
 * The structural rules of confined commands (0e) the schema cannot say:
 * candidate options only on candidate commands, a join names an EARLIER
 * candidate service in a private network, and a target is either wholly
 * structured or wholly unconfined (a mix would label a run by its weakest
 * command anyway, and hides which one it is).
 */
export function confinedCommandErrors (testDrive) {
  const errors = []
  const all = [...(testDrive.commands ?? []), ...(testDrive.finallyCommands ?? [])]
  const kinded = all.filter(c => c.kind)
  if (kinded.length && kinded.length !== all.length) errors.push(`testDrive mixes confined and unconfined commands (${all.filter(c => !c.kind).map(c => c.id).join(', ')} without a kind)`)
  const seen = new Map()
  for (const c of all) {
    if (/^devpanel-probe-/.test(c.id ?? '')) errors.push(`${c.id}: the devpanel-probe- prefix is reserved for the engine's confinement probe`)
    const options = ['network', 'service', 'join', 'unprivilegedPorts', 'lifetimeSeconds', 'startedMarker', 'startedTimeoutSeconds'].filter(k => c[k] !== undefined && c[k] !== false)
    if (c.kind !== 'candidate' && options.length) errors.push(`${c.id}: ${options.join(', ')} apply to kind: candidate only`)
    if (c.join) {
      const target = seen.get(c.join)
      if (!target || target.kind !== 'candidate' || target.service !== true || target.network) errors.push(`${c.id}: join must name an earlier candidate service without network (${c.join})`)
      if (c.network) errors.push(`${c.id}: a joining command shares the service's private network; network cannot be set`)
    }
    if (c.startedMarker !== undefined && c.service !== true) errors.push(`${c.id}: startedMarker applies to a service: true command`)
    if (c.startedTimeoutSeconds !== undefined && c.startedMarker === undefined) errors.push(`${c.id}: startedTimeoutSeconds bounds a startedMarker, and none is declared`)
    if (c.unprivilegedPorts && c.network) errors.push(`${c.id}: unprivilegedPorts needs a private network`)
    seen.set(c.id, c)
  }
  if (kinded.length === 0 && testDrive.confinement) errors.push('testDrive.confinement is set but no command declares a kind')
  return errors
}

export function stagingTarget (infra) {
  return { kind: 'ssh', materialize: 'archive', ssh: infra.staging.ssh,
    commands: infra.testDrive.commands, ...(infra.testDrive.finallyCommands ? { finallyCommands: infra.testDrive.finallyCommands } : {}),
    ...(infra.testDrive.confinement ? { confinement: infra.testDrive.confinement } : {}),
    ...(infra.testDrive.compareBaseline ? { compareBaseline: true } : {}),
    // A test drive costs ~20 minutes, so by default only an approved revision
    // pays for one; `retryFailed` absent means the engine's default of one retry.
    timing: infra.testDrive.timing ?? 'approved',
    ...(Number.isInteger(infra.testDrive.retryFailed) ? { retryFailed: infra.testDrive.retryFailed } : {}),
    // Only when off: an unset project keeps its target hash, so its baselines stay valid.
    ...(infra.testDrive.classifyUnstable === false ? { classifyUnstable: false } : {}),
    // Smoke beside the reviews, the full drive after approval (tierErrors
    // refuses every-revision timing with tiers).
    ...(infra.testDrive.tiers ? { tiers: infra.testDrive.tiers } : {}),
    // The staging files are named in the project; the target carries paths.
    ...(infra.testDrive.baselineCache ? { baselineCache: (({ stagingFiles = [], ...rest }) => ({ ...rest, files: stagingFiles.map((n) => infra.staging.files?.[n]).filter(Boolean) }))(infra.testDrive.baselineCache) } : {}),
    // The command-level fence (0e) is only as strong as its probe; the target
    // names the project root so the probe can prove it invisible.
    ...(infra.staging.projectRoot ? { projectRoot: infra.staging.projectRoot } : {}) }
}

/**
 * The check target of every playbook that records revisions on a Boilerplate
 * project (every project with `infrastructure`): the modules tier, beside the
 * reviews, never the smoke/full drive (those stay on the project for the full
 * verification). Without `testDrive.modules` the target has no `modules` and
 * the engine records each revision's check as unavailable, naming why.
 */
export function modulesTarget (infra) {
  const modules = infra.testDrive.modules
  return { kind: 'ssh', materialize: 'archive', ssh: infra.staging.ssh, tier: 'modules', timing: 'every-revision',
    commands: modules ? MODULE_SLOTS.filter((slot) => modules[slot]).map((slot) => modules[slot]) : [],
    ...(modules ? { modules } : {}),
    ...(modules?.finallyCommands ? { finallyCommands: modules.finallyCommands } : {}),
    ...(infra.testDrive.confinement ? { confinement: infra.testDrive.confinement } : {}),
    ...(Number.isInteger(infra.testDrive.retryFailed) ? { retryFailed: infra.testDrive.retryFailed } : {}),
    ...(infra.staging.projectRoot ? { projectRoot: infra.staging.projectRoot } : {}) }
}

/**
 * A project's own local checks (projects/<id>.yaml `checks`): the structural
 * rules the schema cannot say. They run on this host through the local check
 * fence, so the SSH test drive's confinement options mean nothing here, and a
 * project names one check mechanism, never both.
 */
export function localChecksErrors (project) {
  const checks = project?.checks
  if (!checks) return []
  const errors = []
  if (project.infrastructure) errors.push('declare checks either as infrastructure.testDrive (SSH staging) or as checks (local), not both')
  if (!checks.commands.some(c => c.required !== false)) errors.push('checks needs at least one required command')
  const all = [...checks.commands, ...(checks.finallyCommands ?? [])]
  if (new Set(all.map(c => c.id)).size !== all.length) errors.push('checks command ids must be unique')
  checks.commands.forEach((c, i) => {
    for (const id of c.needs ?? []) if (!checks.commands.slice(0, i).some(e => e.id === id)) errors.push(`${c.id}: needs must name an earlier command (${id})`)
  })
  for (const c of checks.finallyCommands ?? []) if (c.needs) errors.push(`${c.id}: finallyCommands always run and cannot declare needs`)
  errors.push(...reportingErrors(checks))
  for (const c of all) {
    const options = ['kind', 'network', 'service', 'join', 'unprivilegedPorts', 'lifetimeSeconds', 'startedMarker', 'startedTimeoutSeconds'].filter(k => c[k] !== undefined)
    if (options.length) errors.push(`${c.id}: ${options.join(', ')} belong to an SSH test drive; local checks run through the local check fence`)
  }
  errors.push(...tierErrors(checks))
  return errors
}

/** The `kind: local` check target of a project's own checks. */
export function localTarget (checks) {
  return { kind: 'local', commands: checks.commands,
    ...(checks.finallyCommands ? { finallyCommands: checks.finallyCommands } : {}),
    ...(checks.confinement ? { confinement: checks.confinement } : {}),
    ...(checks.compareBaseline ? { compareBaseline: true } : {}),
    // Absent timing is the engine's every-revision: a local check is cheap.
    ...(checks.timing ? { timing: checks.timing } : {}),
    ...(Number.isInteger(checks.retryFailed) ? { retryFailed: checks.retryFailed } : {}),
    ...(checks.classifyUnstable === false ? { classifyUnstable: false } : {}),
    ...(checks.tiers ? { tiers: checks.tiers } : {}) }
}

export function infrastructureBrief (infra) {
  if (!infra) return 'No project infrastructure is configured. Do not invent container names, access methods or test results.'
  return `Project infrastructure (operator configuration):
${JSON.stringify(infra, null, 2)}
Orient yourself using the configured documentation and source ownership before editing. Work on the candidate in your isolated worktree; do not substitute the live checkout or deployment code for the candidate.
Staging is the test-drive environment. Deployment containers are inspection-only during authoring: do not deploy, restart, install into, or mutate them. Never copy instance secrets, runtime state or business data between environments.
SSH hostRef uses ssh-config:<destination> or a named env:/file: reference resolved by devpanel. Credentials stay on the host; never print them. Environment files are named diagnostic resources, not source for the patch.
The engine uploads and verifies the exact candidate in a fresh directory under staging.ssh.workdir and runs testDrive commands there after each recorded revision. finallyCommands collect logs and stop the test instance even on failure. Commands must run the uploaded candidate, keep it unchanged, and clean up their own processes. A command with kind: candidate runs as the unit user inside an allow-list (the candidate directory, read-only /usr, /etc and /sys, an empty home with only testDrive.confinement paths) in its own transient unit — no host secrets, other projects or the shared instance are visible, and it has no network unless it declares network: true; service: true starts the application and the engine stops it after the finalizers (with startedMarker, the start command passes only once the unit is active and that file exists, within startedTimeoutSeconds, default 120); join: <service> enters that running service's own fenced view and private network (readiness, selftests). kind: privileged (unit management, the journal) sees the host but not the candidate. A check result records its confinement level. Do not run the live-checkout deployment script as a candidate test.
Inspect recorded checks and command logs before making verification claims. Do not assume the project cannot run locally means it cannot be tested: use staging. Report access failures as unavailable, not passed. Remote inspection is allowed via the configured access; automated candidate staging mutation belongs to the configured test drive. If stagingDeployment.enabled is true, explicitly requested shared-stage deployment is a separate supervisor deploy_staging operation, outside authoring playbooks. Analysis cannot deploy. The staging and deployment playbooks perform installed infrastructure.release target commands with verified checkpoints and recovery; production promotes an exact successful staging release. Participants inspect the receipts; only the engine runs release mutations. The legacy shared-stage operation remains available for its explicitly requested scope. Do not reinterpret a shared deployment request as an isolated candidate test. Local tooling restrictions still apply.
Committing the live checkout is an operator/supervisor project action (checkpoint.sh), never something a participant runs from a worktree: author in the worktree and let delivery and integration carry the candidate.${brokerBrief(infra)}`
}

/** When an environment declares a database, seats read it through the broker (Phase 3). */
function brokerBrief (infra) {
  const envs = [infra.staging, ...(infra.deployments ?? [])].filter((e) => e?.database)
  if (!envs.length) return ''
  return `
Broker (devpanel MCP server): ${envs.map((e) => e.id).join(', ')} declare a database. Read environment state with the tools inspect_environment {environment, resource} and db_query {environment, query: {op, database, collection, filter, projection, sort, limit, skip, field, pipeline}} — never over SSH, and never by reading database files. db_query is read-only and allow-listed (find, count, distinct, aggregate, listCollections; no $where/$function/$out/$merge); results are capped and truncation is marked. Staging is granted to the project; a production environment answers only under an operator's grant on this issue. Every call is recorded as run evidence, and its results belong to the whole run.`
}

/** `config`: a configuration already loaded (or being loaded), for a reader asking about many projects. */
export async function projectInfrastructure (project, { root, config: loaded = null } = {}) {
  const { loadConfig } = await import('./config/load.mjs')
  const config = await (loaded ?? loadConfig({ root }))
  const errors = config.errors.filter(e => e.file?.endsWith(`/projects/${project}.yaml`))
  if (errors.length) throw new Error(errors.map(e => e.message).join('; '))
  return config.projects.get(project)?.infrastructure ?? null
}

/** Bounded diagnostics: callers choose an operator-declared resource, never shell text. */
export async function inspectEnvironment ({ project, environment, resource = 'status' }, { root, signal } = {}) {
  const infra = await projectInfrastructure(project, { root })
  const env = infra && [infra.staging, ...infra.deployments].find(e => e.id === environment)
  if (!env) throw Object.assign(new Error('Unknown configured environment'), { status: 400 })
  const file = Object.hasOwn(env.files, resource) ? env.files[resource] : null
  const command = resource === 'status' ? env.statusCommand : file ? `tail -c 32768 -- ${quote(file)}` : null
  if (!command) throw Object.assign(new Error('Unknown configured diagnostic resource'), { status: 400 })
  // Imported here: reading a project's infrastructure, as npm run overview does, loads nothing that spawns.
  const [{ sshConnection }, { runProcess }] = await Promise.all([import('./runtime/ssh.mjs'), import('./runtime/process.mjs')])
  const ssh = await sshConnection(env.ssh)
  const timeout = AbortSignal.timeout(20000)
  const result = await runProcess({ ...ssh, args: [...ssh.args, command], signal: signal ? AbortSignal.any([signal, timeout]) : timeout, maxBuffer: 65536 })
  return { project, environment, resource, at: new Date().toISOString(), exitCode: result.code,
    available: result.code === 0 && !result.cancelled, stdout: result.stdout.slice(-32768), stderr: result.stderr.slice(-4096) }
}
