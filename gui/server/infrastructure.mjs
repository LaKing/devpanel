import { runProcess } from './runtime/process.mjs'

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

export function infrastructureErrors (infra) {
  if (!infra) return []
  const environments = [infra.staging, ...infra.deployments]
  const errors = []
  if (new Set(environments.map(e => e.id)).size !== environments.length) errors.push('environment ids must be unique')
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
  errors.push(...tierErrors(infra.testDrive))
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

export async function projectInfrastructure (project, { root } = {}) {
  const { loadConfig } = await import('./config/load.mjs')
  const config = await loadConfig({ root })
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
  const { sshConnection } = await import('./runtime/ssh.mjs')
  const ssh = await sshConnection(env.ssh)
  const timeout = AbortSignal.timeout(20000)
  const result = await runProcess({ ...ssh, args: [...ssh.args, command], signal: signal ? AbortSignal.any([signal, timeout]) : timeout, maxBuffer: 65536 })
  return { project, environment, resource, at: new Date().toISOString(), exitCode: result.code,
    available: result.code === 0 && !result.cancelled, stdout: result.stdout.slice(-32768), stderr: result.stderr.slice(-4096) }
}
