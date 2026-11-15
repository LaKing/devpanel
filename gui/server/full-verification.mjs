import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './runtime/clock.mjs'
import { hostSettings } from './config/host-settings.mjs'
import { loadConfig, resolvePlaybook } from './config/load.mjs'
import { TARGET_MISSING } from './config/release-plan.mjs'
import { projectInfrastructure } from './infrastructure.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { stagedReleasePassed } from './runtime/run-result.mjs'
import { failureFingerprints, selftestReport } from './runtime/baseline-failures.mjs'
import { poolMembers } from './runtime/module-pool.mjs'
import { startProjectAction } from './project-actions.mjs'
import { projectPath, projectsRoot, resolveProjectPath } from './project-path.mjs'
import { cycleRecords, driveFiles, DRIVE_DIR, fullTierRanOf, fullVerificationDrive, instanceCycleTarget, notOnInstanceOf, readReports, suiteRanOf } from './runtime/full-verification-drive.mjs'
import { flakyHistoryLines, judgeRerun, rerunCommands, rerunPlan, rerunSettings, RERUN_DIR } from './runtime/full-verification-rerun.mjs'
import { fill, instanceName } from './runtime/instance-drive.mjs'
import { runChecks } from './runtime/checks.mjs'
import { recordDrive } from './runtime/selftest-history.mjs'
import { destroyRunInstances } from './runtime/stage-instances.mjs'
import { gitWorktreeProvider } from './runtime/launch.mjs'
import { gitStoreDir } from './runtime/git-store.mjs'
import { cycleSnapshotCoverage, deliveriesOf as projectDeliveries } from './staging-coverage.mjs'
import { deliveryCounts } from './verification-trigger.mjs'

/*
 * The full verification (docs/tactical-playbooks.md "The daily full
 * verification", execution-contract.md "Full verification freeze").
 *
 * On request (POST /api/verification/start), once `fullVerification.afterDeliveries`
 * deliveries happened on one stage (verification-trigger.mjs), and at the host settings'
 * `fullVerification.at` in its `timeZone` when given, a cycle:
 *   1. closes admission for writing runs (supervisor.freeze): none starts, continues or
 *      delivers, and every live one pauses at its next step boundary as `full-verification`;
 *      read-only runs (no delivery, no release, not in place) go on;
 *   2. waits until no writing run or delivery is left in this process (supervisor.busy);
 *   3. verifies every configured stage, one at a time per staging host and hosts side by
 *      side, against the previous green cycle of the same mode
 *      (runtime/full-verification-drive.mjs):
 *      - on a stage host with dynamic instances (a project there declares
 *        `testDrive.modules.instance`) it starts no run: it snapshots the development
 *        checkout, drives `modules.instance.fullSuite` on an instance of its own (counted
 *        against testDrive.maxInstances, waited for), keeps what the instance produced
 *        under issues/.verification/<date>/<cycle id>/<project>/ and destroys it however
 *        the drive ends. When the suite failed on named tests alone, each failed test runs
 *        again alone on that instance before it is destroyed (runtime/full-verification-rerun.mjs):
 *        one that passes alone is flaky (recorded, in the selftest history, the event and an
 *        issue) and does not make the entry red. Nothing is ever released to, loaded into or restarted on the base
 *        instance of such a host: a project there without an instance is refused
 *        (HOST_HAS_INSTANCES), one without a full suite too (FULL_SUITE_UNDECLARED);
 *      - elsewhere it starts one Deployment run (environment staging, `fullVerification`)
 *        in the project's run home issues/<project>/.verification-<date>/, which releases
 *        the development checkout as it stands and drives the full check tier on it;
 *      a project with no infrastructure, or whose staging declares
 *      `fullVerification: instances`, is recorded as verified through its instances.
 *      Each entry records the delivered runs its snapshot covered;
 *   4. waits until those runs settle and handles the outcome while admission is still
 *      closed: every stage green, each framework's `checkpoint` runs with --minor and
 *      then each instance's `checkpoint` (runtime/module-pool.mjs poolMembers order),
 *      stopping at the first that fails; any stage red, no action runs and one issue
 *      opens per red project with its failing tests and their excerpts;
 *   5. opens admission and resumes the runs it paused;
 *   6. writes issues/.verification/<date>/cycle.json at every step, and tells the
 *      top-level supervisor (`onEnded`) the outcome and where the evidence is. The cycle
 *      resolves no issue.
 */

export const HOUR = 60 * 60 * 1000
/** Failing tests shown in a red issue's body; every one is in its failing-tests attachment. */
export const SHOWN_FAILURES = 30
const EXCERPT_CHARS = 2000
const STACK_LINES = 20
const LIVE = ['pending', 'preflighting', 'running', 'stopping']
const SETTLED_CYCLE = ['ended', 'interrupted', 'failed']

/** The zone's local wall-clock parts of an instant. */
function localParts (ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
  return parts
}

/** YYYY-MM-DD in the zone. */
export function localDate (ms, timeZone) {
  const p = localParts(ms, timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

const offsetAt = (ms, timeZone) => {
  const p = localParts(ms, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** The instant a local date and HH:MM name in the zone: the earlier of an ambiguous time, the shifted one of a skipped time. */
function zonedInstant (year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const candidates = [...new Set([offsetAt(wall - 12 * HOUR, timeZone), offsetAt(wall + 12 * HOUR, timeZone)])].map((o) => wall - o)
  const exact = candidates.filter((t) => { const p = localParts(t, timeZone); return p.hour === hour && p.minute === minute && p.day === day })
  return exact.length ? Math.min(...exact) : Math.max(...candidates)
}

/** The first instant after `nowMs` at which the zone's clock reads `at`. */
export function nextTrigger ({ at, timeZone }, nowMs) {
  const [hour, minute] = at.split(':').map(Number)
  const today = localParts(nowMs, timeZone)
  for (let day = 0; day < 3; day++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + day))
    const t = zonedInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, timeZone)
    if (t > nowMs) return t
  }
  throw new Error(`no ${at} in ${timeZone} within three days of ${new Date(nowMs).toISOString()}`)
}

/**
 * What a project is to the cycle: a stage to release to, a stage verified on a dynamic
 * instance of the cycle's own (`mode: 'instance'`, its staging declares
 * testDrive.modules.instance), or verified through its instances.
 */
export function stageOf (project, infra) {
  if (!infra) return { project, stage: null, verifiedThrough: 'instances', reason: 'the project has no infrastructure' }
  if (infra.staging?.fullVerification === 'instances') return { project, stage: infra.staging.id, verifiedThrough: 'instances', reason: 'its staging declares fullVerification: instances' }
  const host = infra.staging.ssh?.hostRef ?? infra.staging.id
  return infra.testDrive?.modules?.instance ? { project, stage: infra.staging.id, host, mode: 'instance' } : { project, stage: infra.staging.id, host }
}

/**
 * The staging hosts that have dynamic instances, each with the projects that declare them: no cycle releases there.
 * Read from every project's infrastructure (project -> infra), a project verified through its instances included:
 * its declaration makes the host's base instance people's as much as any other's.
 */
export function protectedHosts (infras) {
  const hosts = new Map()
  for (const [project, infra] of infras) {
    if (!infra?.staging || !infra.testDrive?.modules?.instance) continue
    const host = infra.staging.ssh?.hostRef ?? infra.staging.id
    hosts.set(host, [...(hosts.get(host) ?? []), project])
  }
  return hosts
}

/** The refusal of a release to a host with dynamic instances, or null. */
const hostRefusal = (entry, hosts) => entry.mode !== 'instance' && hosts.has(entry.host)
  ? { code: 'HOST_HAS_INSTANCES', message: `${entry.host} has dynamic stage instances (declared by ${hosts.get(entry.host).join(', ')}); its base instance is never released to, loaded into or restarted. Declare testDrive.modules.instance with a fullSuite for ${entry.project}.` }
  : null

/** Whether an entry can be verified at all, so its deliveries may start a cycle (verification-trigger.mjs). */
const verifiable = (entry, infra, hosts) => Boolean(entry.stage && !entry.verifiedThrough && !hostRefusal(entry, hosts) && (entry.mode !== 'instance' || infra?.testDrive?.modules?.instance?.fullSuite))

/** A run id for one cycle drive: names the instance, the snapshot ref and the drive's DEVPANEL_RUN_ID. */
export const driveIdOf = (cycleId, project) => `fv-${String(cycleId).replace(/[^A-Za-z0-9]+/g, '-')}-${String(project).replace(/[^A-Za-z0-9]+/g, '-')}`.toLowerCase()

/**
 * The failing tests of a stage's full check, each with its basis: a failure the previous green
 * drive does not have (`new`), a failure no comparison could judge (`unjudged`: no or an incomplete
 * baseline; for a failed command, the failures its own output names, `parsed` from
 * baseline-failures.mjs failureFingerprints), or a failed required command nothing narrower names
 * (`command`). Unstable failures are ignored by the gate and are not listed.
 */
export function failingTestsOf (check, parsed = []) {
  const out = []
  const seen = new Set()
  const add = ({ command, test, message = null, context = null }, basis) => {
    const key = `${command}\u0000${test}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ command, test, basis, ...(message ? { message } : {}), ...(context ? { context } : {}) })
  }
  const namedIn = (command) => parsed.filter((f) => f.command === command && f.test && f.test !== '(command)')
  // Named failures from a command's own output always take precedence over a whole-command entry, whatever
  // the comparison said ('passes on the base', a timeout, an exit code that differs): its reason stays as context.
  const addNamedFirst = (f, basis) => {
    const named = f.test === '(command)' ? namedIn(f.command) : []
    if (named.length) named.forEach((n) => add({ ...n, context: f.message }, basis))
    else add(f, basis)
  }
  for (const f of check?.selftest?.newFailures ?? []) add(f, 'new')
  // Failed here and passed only alone in the previous green cycle (full-verification-drive.mjs): never inherited.
  for (const f of check?.flakyAgain ?? []) add(f, 'flaky-again')
  for (const f of check?.selftest?.unjudged ?? []) add(f, 'unjudged')
  for (const f of check?.failures?.newFailures ?? []) addNamedFirst(f, 'new')
  if (check?.result?.result === 'failed' && check.gating !== 'passed') {
    // A failed command no comparison named (no baseline, an unreadable or differing base): what its output names, else the command.
    for (const c of (check.result.commands ?? []).filter((c) => c.required !== false && !c.passed && !out.some((f) => f.command === c.id))) {
      const named = namedIn(c.id)
      if (named.length) named.forEach((f) => add(f, 'unjudged'))
      else add({ command: c.id, test: '(command)', message: `exit ${c.exitCode ?? c.signal ?? 'none'}${c.timedOut ? ' (timed out)' : ''}` }, 'command')
    }
  }
  return out
}

/** The failed entry of a named test in a selftest report (the walk selftestStates makes). */
function reportEntry (report, test) {
  let found = null
  const walk = (o) => {
    if (found) return
    if (Array.isArray(o)) return o.forEach(walk)
    if (!o || typeof o !== 'object') return
    if (o.test === test && !o.skipped && (o.error || o.stack)) { found = o; return }
    Object.values(o).forEach(walk)
  }
  walk(report)
  return found
}

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/**
 * A failing test's excerpt: its own selftest-report entry (error and the start of its stack),
 * else the lines around its name in the command's log, else the command's stderr tail.
 */
export async function excerptOf ({ runDir, dir, command, test, commands = [] }) {
  const base = path.join(runDir ?? '', dir ?? '')
  const clip = (text, source) => ({ source, text: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}\n… (excerpt cut at ${EXCERPT_CHARS} characters; the whole log is ${path.join(dir ?? '', `${command}.log`)} in the run directory)` : text })
  const read = (name) => (runDir ? fs.readFile(path.join(base, name), 'utf8').catch(() => null) : null)
  if (test !== '(command)') {
    // Read directly: readReport gives nothing for a report command that did not pass.
    const stdout = await read(`${command}.stdout`)
    const parsed = stdout === null ? null : selftestReport(stdout)
    const entry = parsed?.report ? reportEntry(parsed.report, test) : null
    if (entry) {
      const stack = entry.stack ? asText(entry.stack).split('\n').slice(0, STACK_LINES).join('\n') : null
      return clip([entry.error ? asText(entry.error) : null, stack].filter(Boolean).join('\n'), 'selftest report')
    }
    const lines = (await read(`${command}.log`))?.split('\n') ?? []
    const at = lines.findIndex((l) => l.includes(test))
    if (at >= 0) return clip(lines.slice(Math.max(0, at - 5), at + 6).join('\n'), 'log')
  }
  const stderr = commands.find((c) => c.id === command)?.stderr
  if (stderr) return clip(stderr, 'stderr tail')
  const log = test === '(command)' ? await read(`${command}.log`) : null
  if (log) return clip(log.split('\n').slice(-20).join('\n'), 'log tail')
  return { source: null, text: null }
}

/** A Markdown fence longer than any backtick run in the text. */
function fenced (text) {
  const fence = '`'.repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1)
  return `${fence}text\n${text}\n${fence}`
}

const failureBlock = (f) => [`### \`${f.command}: ${f.test}\` (${f.basis})`, '', ...(f.message ? [f.message, ''] : []),
  ...(f.context ? [`The command against the previous green drive: ${f.context}.`, ''] : []),
  f.excerpt?.text ? `${fenced(f.excerpt.text)}\n_From the ${f.excerpt.source}._` : 'No excerpt found: neither the selftest report, the log nor the stderr tail names it.', ''].join('\n')

const plural = (n, one, many) => (n === 1 ? one : many)

/** The flaky tests of an entry, apart from its failing ones: failed in the whole suite, passed when rerun alone. */
const flakySection = (flaky) => ['## Flaky: failed in the whole suite, passed alone on the same instance', '',
  'These do not make the stage red; each is recorded in the project\'s selftest history as a failure and a pass on one tree.', '',
  ...flaky.map((f) => `- \`${f.command}: ${f.test}\` (rerun in \`${f.dir ?? 'unknown'}\`)`), ''].join('\n')

/** Why an entry's failed tests were or were not rerun, in a line. */
const rerunLine = (rerun) => !rerun ? null
  : rerun.state === 'ran' ? `- Rerun of failed tests alone: ${rerun.tests.length} rerun, ${rerun.tests.filter((t) => t.rerun === 'passed').length} passed alone (flaky), ${rerun.tests.filter((t) => t.rerun !== 'passed').length} failed again or not observed`
    : rerun.state === 'skipped' ? `- Rerun of failed tests alone: not done, ${rerun.reason}: ${rerun.message}`
      : `- Rerun of failed tests alone: ${rerun.state}${rerun.error ? ` (${rerun.error})` : ''}`

/** Every failing test with its excerpt, in parts of at most `maxBytes`, split only between tests. */
export function failureAttachments ({ name, failures, unread = [], flaky = [], maxBytes }) {
  const head = (i, n) => `# Failing tests: ${name}${n > 1 ? ` (part ${i} of ${n})` : ''}\n\nAll ${failures.length} failing ${plural(failures.length, 'test', 'tests')} with ${plural(failures.length, 'its excerpt', 'their excerpts')}.\n\n`
  const blocks = failures.map(failureBlock)
  if (flaky.length) blocks.push(flakySection(flaky))
  if (unread.length) blocks.push(['## Reports that could not be read', '', ...unread.map((u) => `- \`${u.command}\`: ${u.reason}`), ''].join('\n'))
  const headroom = Buffer.byteLength(head(9999, 9999))
  const parts = []
  let current = []
  let bytes = headroom
  for (const block of blocks) {
    const size = Buffer.byteLength(block) + 1
    if (current.length && bytes + size > maxBytes) { parts.push(current); current = []; bytes = headroom }
    current.push(block)
    bytes += size
  }
  if (current.length) parts.push(current)
  return parts.map((blocksOf, i) => ({ name: parts.length === 1 ? 'failing-tests.md' : `failing-tests-${i + 1}.md`, text: head(i + 1, parts.length) + blocksOf.join('\n') }))
}

/** The report of a red project's issue: the cycle, the run, why it is red, the first failing tests. */
export function redIssueReport ({ record, entry, name, stage, failures, unread = [], flaky = [], parts = [] }) {
  const lines = [`# ${name}`, '',
    `The daily full verification ${record.id} found ${entry.project} red on ${stage}. The cycle opened this issue with that cycle's evidence; no version was bumped.`, '',
    `- Cycle: \`${record.id}\` (record \`issues/.verification/${record.date}/cycle.json\`)`,
    entry.mode === 'instance' ? `- Drive: \`${entry.driveId}\` on stage instance \`${entry.instance?.name ?? 'none created'}\`${entry.instance?.destroyed ? (entry.instance.destroyed.passed ? ' (destroyed)' : ` (its destroy failed: ${entry.instance.destroyed.error})`) : ''}; evidence \`${entry.evidence?.dir ?? entry.runDir ?? 'none'}\`` : entry.runId ? `- Run: \`${entry.runId}\` in \`${entry.runHome}\`` : '- Run: none started']
  if (entry.incomplete) lines.push(`- Incomplete: ${entry.incomplete.reason}: ${entry.incomplete.message}`)
  if (entry.status) lines.push(`- Run status: ${entry.status}${entry.blockedReason ? ` (${entry.blockedReason})` : ''}${entry.release ? `; release ${entry.release.status}` : ''}`)
  if (entry.refusal) lines.push(`- Not started: ${entry.refusal.code ? `${entry.refusal.code}: ` : ''}${entry.refusal.message}`)
  if (entry.check) {
    lines.push(`- Full check: ${entry.check.result ?? 'no result'}, gate ${entry.check.gating}${entry.check.baseline?.cycleId ? `, compared with cycle ${entry.check.baseline.cycleId}` : ', no previous green cycle to compare with'}`)
    if (entry.check.selftestVerdict) lines.push(`- Selftest comparison: ${entry.check.selftestVerdict}${entry.check.selftestReason ? ` (${entry.check.selftestReason})` : ''}`)
  }
  if (rerunLine(entry.rerun)) lines.push(rerunLine(entry.rerun))
  lines.push('')
  if (failures.length) {
    lines.push(`## Failing tests (${failures.length})`, '')
    if (failures.length > SHOWN_FAILURES) lines.push(`The first ${SHOWN_FAILURES} are shown here; every one is in the attachment named below.`, '')
    for (const f of failures.slice(0, SHOWN_FAILURES)) lines.push(failureBlock(f))
  } else lines.push('## Failing tests', '', 'The check names no failing test; the run status above says why the stage is red.', '')
  if (unread.length) lines.push('## Reports that could not be read', '', ...unread.map((u) => `- \`${u.command}\`: ${u.reason}`), '')
  if (flaky.length) lines.push(flakySection(flaky))
  if (parts.length) lines.push(`All ${failures.length} failing ${plural(failures.length, 'test', 'tests')} with ${plural(failures.length, 'its excerpt', 'their excerpts')}: ${parts.map((p) => `\`${p.name}\``).join(', ')} on the report step (000).`, '')
  return lines.join('\n')
}

const report = ({ project, stage }) => `# Daily full verification of ${project} on ${stage}

This is the panel's daily full verification, not a reported problem. Release the project's development
checkout as it stands to the staging environment \`${stage}\` and assess that release as for any staging
release. After the release, the engine drives the project's full check tier on the same snapshot and
compares it with the previous green cycle; a new failure stops the run on its own.

Nothing is to be changed, delivered or opened: no source edit, no version bump, no issue. Accept the
release when the release evidence shows it healthy; reject it, with the evidence, when it does not.
`

/**
 * The scheduler and the cycle. `supervisor` is the run supervisor (freeze, thaw,
 * busy, start, resume, isActive); `issues` the issue store (listProjects,
 * listIssues, ensureRunHome); everything time-based runs on `clock`.
 */
export function createFullVerification ({
  supervisor,
  issues,
  clock = systemClock,
  settings = () => hostSettings().fullVerification,
  configRoot = process.env.DEVPANEL_CONFIG_ROOT,
  verificationDir = path.join(issues.ISSUES_DIR, '.verification'),
  resolve = (playbookId, options) => resolvePlaybook(playbookId, options),
  infrastructureOf = (project) => projectInfrastructure(project, { root: configRoot }),
  readRun = (issuePath, runId) => fs.readFile(path.join(issuePath, 'runs', runId, 'run.json'), 'utf8').then(JSON.parse),
  emit = null,
  /** The projects' configuration (`framework:` declarations), read when a green cycle bumps. */
  projectsConfig = async () => (await loadConfig({ root: configRoot })).projects,
  /** Run a project action to its end; resolves with its operation record (project-actions.mjs). */
  runAction = async ({ project, actionId, args }) => (await startProjectAction({ project, actionId, args, root: configRoot, actor: 'full-verification', emit: emitAction ?? (() => {}) })).done,
  emitAction = null,
  /** A project's version: its root `version` file's first line, else package.json's version, else null. */
  versionOf = async (project) => {
    const dir = projectPath(project, projectsRoot())
    const file = await fs.readFile(path.join(dir, 'version'), 'utf8').catch(() => null)
    if (file?.trim()) return file.trim().split('\n')[0].trim()
    return fs.readFile(path.join(dir, 'package.json'), 'utf8').then((t) => JSON.parse(t).version ?? null, () => null)
  },
  maxAttachmentBytes = issues.MAX_FILE_BYTES ?? 25 * 1024 * 1024,
  pollMs = 5000,
  log = console,
  // A cycle on a stage instance (runInstanceStage): the snapshot of a project's checkout and its release,
  // the drive (runtime/checks.mjs runChecks underneath), the destroy of the drive's instances, the coverage
  // of its snapshot, and the project's checkout.
  provision = (args) => gitWorktreeProvider.create(args),
  releaseWorkspace = (workspace) => gitWorktreeProvider.release(workspace),
  drive = undefined,
  destroyInstances = (driveId, options) => destroyRunInstances(driveId, options),
  coverageOf = (args) => cycleSnapshotCoverage({ ...args, listIssues: (p, o) => issues.listIssues(p, o), listHomes: (p) => issues.listRunHomes?.(p) ?? [] }),
  projectPathOf = (project) => resolveProjectPath(project),
  // The delivery trigger (verification-trigger.mjs): how many deliveries a stage takes, and a project's deliveries.
  afterDeliveries = () => hostSettings().verificationTrigger.afterDeliveries,
  deliveriesOf = async (project) => projectDeliveries({ project, projectPath: await projectPathOf(project).catch(() => null), listIssues: (p, o) => issues.listIssues(p, o), listHomes: (p) => issues.listRunHomes?.(p) ?? [] }),
  deliveryPollMs = 15 * 60 * 1000,
  /** Told when a cycle ended (the top-level supervisor's verification-ended event); never throws into the cycle. */
  onEnded = null
} = {}) {
  let cancel = null
  let cancelDeliveries = null
  let deliveryCheckRunning = null
  let lastDeliveryCheck = null
  let current = null
  let running = null
  let stopped = false

  const wait = (ms) => new Promise((resolve) => clock.after(ms, resolve))
  const changed = (record) => emit?.({ type: 'verification:changed', id: record.id, state: record.state })

  async function write (record) {
    await writeJson(path.join(verificationDir, record.date, 'cycle.json'), record)
    changed(record)
  }

  /** Keep an earlier cycle of the same date as cycle.<n>.json; cycle.json is always the latest. */
  async function rotate (date) {
    const dir = path.join(verificationDir, date)
    await fs.mkdir(dir, { recursive: true })
    const names = await fs.readdir(dir)
    const kept = names.filter((n) => /^cycle\.\d+\.json$/.test(n)).length
    if (names.includes('cycle.json')) {
      await fs.rename(path.join(dir, 'cycle.json'), path.join(dir, `cycle.${kept + 1}.json`))
      return kept + 2
    }
    return kept + 1
  }

  async function latestRecord () {
    const dates = (await fs.readdir(verificationDir).catch(() => [])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    for (const date of dates) {
      const record = await fs.readFile(path.join(verificationDir, date, 'cycle.json'), 'utf8').then(JSON.parse, () => null)
      if (record) return record
    }
    return null
  }

  /** Whether a scheduled cycle already ran for this local date (once per date). */
  async function scheduledOn (date) {
    const names = await fs.readdir(path.join(verificationDir, date)).catch(() => [])
    for (const n of names.filter((x) => /^cycle(\.\d+)?\.json$/.test(x))) {
      const record = await fs.readFile(path.join(verificationDir, date, n), 'utf8').then(JSON.parse, () => null)
      if (record?.trigger === 'schedule') return true
    }
    return false
  }

  // ------------------------------------------------------------ the schedule

  function readSettings () {
    try { return settings() } catch (error) { log.warn?.(`[devpanel] full verification: the host settings could not be read: ${error.message}`); return null }
  }

  /** Arm the next wake: the trigger when it is within the hour, else an hour from now to read the settings again. */
  function arm () {
    cancel?.()
    cancel = null
    if (stopped) return
    const s = readSettings()
    if (!s) { cancel = clock.after(HOUR, arm); return }
    const next = nextTrigger(s, clock.now())
    const delay = next - clock.now()
    cancel = delay <= HOUR ? clock.after(delay, () => fire(s, next)) : clock.after(HOUR, arm)
  }

  async function fire (armed, at) {
    const s = readSettings()
    // Edited since it was armed: the next wake follows the new block, or none.
    if (!s || s.at !== armed.at || s.timeZone !== armed.timeZone) return arm()
    arm()
    const date = localDate(at, s.timeZone)
    if (await scheduledOn(date)) return
    await startCycle({ trigger: 'schedule', by: 'schedule', scheduledFor: new Date(at).toISOString() })
      .catch((error) => log.warn?.(`[devpanel] the scheduled full verification did not start: ${error.message}`))
  }

  // ----------------------------------------------------- the delivery trigger

  /** Each project's infrastructure, as the cycle reads it; a project whose configuration cannot be read is left out here. */
  async function readStages () {
    const entries = []
    const infras = new Map()
    for (const p of await issues.listProjects()) {
      const id = p.id ?? p
      const infra = await infrastructureOf(id).catch(() => undefined)
      if (infra === undefined) continue
      infras.set(id, infra)
      entries.push(stageOf(id, infra))
    }
    return { entries, infras }
  }

  /** The stages a cycle can verify, with their projects: what the delivery trigger counts, per stage host. */
  async function countableStages () {
    const { entries, infras } = await readStages()
    const hosts = protectedHosts(infras)
    const stages = new Map()
    for (const e of entries.filter((x) => verifiable(x, infras.get(x.project), hosts))) {
      const s = stages.get(e.host) ?? { host: e.host, stage: e.stage, projects: [] }
      s.projects.push(e.project)
      stages.set(e.host, s)
    }
    return [...stages.values()]
  }

  /**
   * Count each stage's deliveries (verification-trigger.mjs) and start a cycle when one is due.
   * Coalesced: a check asked for while one runs gets that one. Never throws.
   */
  function deliveryCheck () {
    if (deliveryCheckRunning) return deliveryCheckRunning
    deliveryCheckRunning = (async () => {
      const threshold = afterDeliveries()
      if (!threshold || running || supervisor.frozen?.()) return lastDeliveryCheck
      const counts = await deliveryCounts({ stages: await countableStages(), deliveriesOf, records: await cycleRecords(verificationDir), threshold })
      lastDeliveryCheck = { at: clock.iso(), threshold, stages: counts.map(({ runs, ...c }) => ({ ...c, runs: runs.map((r) => ({ project: r.project, issueId: r.issueId, runId: r.runId, at: r.at })) })) }
      const due = counts.find((c) => c.due)
      if (due && !running) {
        await startCycle({ trigger: 'deliveries', by: 'deliveries', deliveries: { host: due.host, stage: due.stage, count: due.count, threshold, runs: due.runs.map((r) => ({ project: r.project, issueId: r.issueId, runId: r.runId, at: r.at })) } })
      }
      return lastDeliveryCheck
    })().catch((error) => { log.warn?.(`[devpanel] the full verification's delivery check failed: ${error.message}`); return null })
      .finally(() => { deliveryCheckRunning = null })
    return deliveryCheckRunning
  }

  /** The delivery check every `deliveryPollMs`, beside the one after each run's end (noteRunEnded). */
  function armDeliveries () {
    cancelDeliveries?.()
    cancelDeliveries = null
    if (stopped) return
    cancelDeliveries = clock.after(deliveryPollMs, () => { armDeliveries(); deliveryCheck() })
  }

  // --------------------------------------------------------------- the cycle

  /** Start a cycle and return a copy of its record as frozen; the cycle goes on in the background. */
  async function startCycle ({ trigger, by = null, scheduledFor = null, deliveries = null }) {
    if (running) throw Object.assign(new Error(`a full verification cycle is already running (${current.id})`), { status: 409, code: 'FULL_VERIFICATION_RUNNING', cycleId: current.id })
    const s = readSettings()
    const timeZone = s?.timeZone ?? 'UTC'
    const date = localDate(clock.now(), timeZone)
    const record = {
      id: null, date, trigger, by, scheduledFor, ...(deliveries ? { deliveries } : {}), schedule: s ? { at: s.at, timeZone: s.timeZone } : null, timeZone,
      state: 'frozen', verdict: null, frozenAt: clock.iso(), seatsIdleAt: null, startedAt: null, endedAt: null,
      asked: [], waitingOn: [], projects: [], resumed: [], heldForOperator: [], refused: [], outcome: null, error: null
    }
    running = true
    current = record
    try {
      record.id = `${date}.${await rotate(date)}`
      record.asked = await supervisor.freeze(record.id)
      await write(record)
    } catch (error) {
      running = null
      current = null
      supervisor.thaw(record.id)
      throw error
    }
    // The record as it stood when admission closed; the cycle goes on changing its own copy.
    const frozen = structuredClone(record)
    running = cycle(record).catch((error) => log.warn?.(`[devpanel] full verification ${record.id} failed: ${error.message}`)).finally(() => { running = null })
    return frozen
  }

  async function cycle (record) {
    try {
      // No run of an issue left in this process: no seat turn is running.
      for (;;) {
        const busy = supervisor.busy()
        if (!busy.length) break
        if (JSON.stringify(busy) !== JSON.stringify(record.waitingOn)) { record.waitingOn = busy; await write(record) }
        await wait(pollMs)
      }
      record.waitingOn = []
      record.seatsIdleAt = clock.iso()
      record.state = 'running'
      record.startedAt = clock.iso()
      const projects = await issues.listProjects()
      const infras = new Map()
      for (const p of projects) {
        const id = p.id ?? p
        const infra = await infrastructureOf(id).catch((error) => ({ error: error.message }))
        if (!infra?.error) infras.set(id, infra)
        record.projects.push(infra?.error ? { project: id, stage: null, verdict: 'red', refusal: { code: 'INFRASTRUCTURE_INVALID', message: infra.error } } : stageOf(id, infra))
      }
      // A host with dynamic instances is protected whole: no project's entry releases there.
      const protectedOnes = protectedHosts(infras)
      if (protectedOnes.size) record.protectedHosts = Object.fromEntries(protectedOnes)
      for (const entry of record.projects.filter((e) => e.stage && !e.verifiedThrough && !e.verdict)) {
        const refusal = hostRefusal(entry, protectedOnes) ?? (entry.mode === 'instance' && !infras.get(entry.project)?.testDrive?.modules?.instance?.fullSuite
          ? { code: 'FULL_SUITE_UNDECLARED', message: `${entry.project} runs on dynamic stage instances but declares no testDrive.modules.instance.fullSuite: the whole suite has no instance command, and the base instance is never used instead` }
          : null)
        if (refusal) Object.assign(entry, { state: 'refused', verdict: 'red', refusal, coverageEstablished: false })
      }
      await write(record)
      const hosts = new Map()
      for (const entry of record.projects.filter((e) => e.stage && !e.verifiedThrough && !e.verdict)) hosts.set(entry.host, [...(hosts.get(entry.host) ?? []), entry])
      // One stage at a time per staging host; hosts side by side (drive slots and instance slots still decide each drive).
      await Promise.all([...hosts.values()].map(async (entries) => {
        for (const entry of entries) await (entry.mode === 'instance' ? runInstanceStage(record, entry, infras.get(entry.project)) : runStage(record, entry, protectedOnes))
      }))
      // Every entry that is not verified through its instances counts, a project whose
      // configuration could not be read included: one red entry makes the cycle red.
      const judged = record.projects.filter((e) => !e.verifiedThrough)
      record.verdict = judged.some((e) => e.verdict !== 'green') ? 'red' : judged.length ? 'green' : 'no-stages'
    } catch (error) {
      record.error = error.message
      record.verdict = 'red'
    } finally {
      // The outcome is handled while admission is still closed, so no run delivers into a checkout
      // the bump commits. It never throws: admission always reopens after it.
      await outcome(record)
      record.state = 'resuming'
      supervisor.thaw(record.id)
      await write(record).catch(() => {})
      await resumeFrozen(record).catch((error) => { record.error ??= `resuming: ${error.message}` })
      record.state = record.error ? 'failed' : 'ended'
      record.endedAt = clock.iso()
      // Owed to the top-level supervisor until it was told, so a restart in between still tells it (announcePending).
      record.announce = 'pending'
      await write(record).catch((error) => log.warn?.(`[devpanel] the full verification record ${record.id} could not be written: ${error.message}`))
      await announce(record)
    }
  }

  /**
   * Tell the top-level supervisor that a cycle ended (verification-ended), once: the record says it is owed
   * (`announce: 'pending'`) until a delivery succeeded, then `delivered` with `announcedAt`. Nothing it does can fail
   * the cycle; without a listener the notice stays owed.
   */
  async function announce (record) {
    if (!onEnded || record.announce !== 'pending') return false
    // The file that holds this cycle now: cycle.json, or the cycle.<n>.json a later cycle of its date rotated it to.
    const file = await recordFileOf(record).catch(() => null)
    try {
      await onEnded(endedNotice(record, file))
    } catch (error) {
      log.warn?.(`[devpanel] the end of full verification ${record.id} could not be announced: ${error.message}`)
      return false
    }
    Object.assign(record, { announce: 'delivered', announcedAt: clock.iso() })
    await writeRecord(record).catch((error) => log.warn?.(`[devpanel] the announcement of full verification ${record.id} could not be recorded: ${error.message}`))
    return true
  }

  /** The file holding a cycle's record, found by its id among its date's cycle.json and cycle.<n>.json; null when none does. */
  async function recordFileOf (record) {
    for (const name of await fs.readdir(path.join(verificationDir, record.date)).catch(() => [])) {
      if (!/^cycle(\.\d+)?\.json$/.test(name)) continue
      const file = path.join(verificationDir, record.date, name)
      const onDisk = await fs.readFile(file, 'utf8').then(JSON.parse, () => null)
      if (onDisk?.id === record.id) return file
    }
    return null
  }

  /** Write a record back to the file it was read from (cycle.json, or an earlier cycle.<n>.json of its date). */
  async function writeRecord (record) {
    const file = await recordFileOf(record)
    if (file) { await writeJson(file, record); changed(record); return }
    await write(record)
  }

  /** What the top-level supervisor is told when a cycle ended: its outcome, the file its record is in and where each entry's evidence is. */
  function endedNotice (record, file = null) {
    const runIds = (list) => (list ?? []).map((c) => c.runId)
    return {
      cycleId: record.id, date: record.date, trigger: record.trigger, by: record.by, state: record.state, verdict: record.verdict, error: record.error ?? null,
      record: file ?? path.join(verificationDir, record.date, 'cycle.json'),
      outcome: {
        bump: record.outcome?.bump ? { chain: record.outcome.bump.chain.map((s) => ({ project: s.project, args: s.args, status: s.status, versionAfter: s.versionAfter ?? null })), failed: record.outcome.bump.failed ?? null } : null,
        issues: (record.outcome?.issues ?? []).map((i) => ({ project: i.project, issueId: i.issueId, name: i.name })),
        reason: record.outcome?.reason ?? null,
        flaky: (record.outcome?.flaky ?? []).map((i) => ({ project: i.project, issueId: i.issueId, noted: i.noted === true }))
      },
      projects: record.projects.map((e) => ({
        project: e.project, stage: e.stage ?? null, mode: e.mode ?? null, verdict: e.verdict ?? null, refusal: e.refusal?.code ?? null, incomplete: e.incomplete?.reason ?? null,
        instance: e.instance?.name ?? null, evidence: e.evidence?.dir ?? e.runDir ?? null, coverageEstablished: e.coverageEstablished === true,
        flaky: (e.flaky ?? []).map((f) => ({ command: f.command, test: f.test })), rerun: e.rerun ? { state: e.rerun.state, reason: e.rerun.reason ?? e.rerun.outcome ?? null } : null,
        covered: e.coverageEstablished ? runIds(e.coverage?.covered) : [],
        stillCounting: [...(e.coverageEstablished ? [] : runIds(e.coverage?.covered)), ...runIds(e.coverage?.indeterminate), ...runIds(e.coverage?.notShipped)]
      })),
      next: 'The cycle resolved no issue. Its evidence (selftest report, project log, browser-check report) stays under each entry\'s evidence directory; an issue whose only open item is a pending live verification of a covered run may be settled from it, by you, with a disposition naming that evidence.'
    }
  }

  /** An entry's full check as the record keeps it; `parsed` names the failures each failed command's own output names. */
  const checkRecord = (check, parsed) => ({
    dir: check.result?.dir ?? null, result: check.result?.result ?? null, gating: check.gating, baseline: check.baseline ?? null, baseCommit: check.baseCommit ?? null, files: check.files ?? {},
    newFailures: [...(check.selftest?.newFailures ?? []), ...(check.failures?.newFailures ?? [])].map((f) => ({ command: f.command, test: f.test })),
    failingTests: failingTestsOf(check, parsed),
    ...(check.flakyAgain?.length ? { flakyAgain: check.flakyAgain } : {}),
    selftestVerdict: check.selftest?.verdict ?? null,
    selftestReason: check.selftest?.reason ?? null,
    unread: (check.selftest?.unread ?? []).map((u) => ({ command: u.command, reason: u.reason })),
    failedCommands: (check.result?.commands ?? []).filter((c) => !c.passed).map((c) => ({ id: c.id, exitCode: c.exitCode ?? null, timedOut: c.timedOut === true, log: c.log ?? null, stderr: c.stderr ?? null })),
    ...((check.result?.skipped ?? []).length ? { skipped: check.result.skipped.map((s) => ({ id: s.id, reason: s.reason })) } : {})
  })

  /** The failures a failed drive's commands name in their own output, for the commands no comparison judged. */
  const parsedFailures = (runDir, check) => check?.result?.result === 'failed'
    ? failureFingerprints({ runDir, check: check.result, target: { commands: (check.result.commands ?? []).map((c) => ({ id: c.id, required: c.required })) } }).catch(() => [])
    : []

  const pick = (coverage) => coverage && !coverage.error
    ? { basis: coverage.basis ?? null, covered: coverage.covered ?? [], indeterminate: coverage.indeterminate ?? [], notShipped: coverage.notShipped ?? [] }
    : coverage?.error ? { error: coverage.error, covered: [], indeterminate: [], notShipped: [] } : null

  /**
   * A stage on a host with dynamic instances: no run, no release. The cycle snapshots the project's
   * development checkout (gitWorktreeProvider, as a run's working-tree base, under the delivery locks),
   * reads which delivered runs that snapshot covers, drives the full suite on an instance of its own
   * (runChecks takes an instance slot of testDrive.maxInstances, waiting for one, and creates it from
   * the snapshot) and always destroys what the drive id holds and releases the snapshot, however it ended.
   * Everything the instance produced stays in the drive's directory under the cycle record.
   */
  async function runInstanceStage (record, entry, infra) {
    const suite = infra.testDrive.modules.instance.fullSuite
    const driveId = driveIdOf(record.id, entry.project)
    const home = path.join(verificationDir, record.date, record.id, entry.project)
    const target = instanceCycleTarget(infra, instanceName(driveId))
    Object.assign(entry, { state: 'starting', driveId, runDir: home, recordFile: 'drive.json', startedAt: clock.iso(), instance: { name: target.stageInstance.name, root: target.stageInstance.root } })
    let workspace = null
    let projectDir = null
    try {
      await fs.mkdir(home, { recursive: true })
      const resolution = await resolve('deployment', { root: configRoot, runOptions: { environment: 'staging' }, projectId: entry.project })
      if (!resolution.ok) throw Object.assign(new Error(resolution.errors.map((e) => `${e.field}: ${e.message}`).join('; ')), { code: 'CONFIGURATION_INVALID' })
      const resolved = resolution.resolved
      projectDir = await projectPathOf(entry.project)
      // The candidate: the development checkout as it stands now, as a run's working-tree base takes it.
      workspace = await provision({ projectPath: projectDir, runId: driveId, root: home, clock,
        // Always the tree as it stands, uncommitted deliveries included, whatever base the project's runs take (`head`, a commit).
        policy: { ...(resolved.workspace ?? {}), base: 'working-tree', requireCleanBase: false, selection: resolved.fence?.selection ?? 0, repository: resolved.fence?.repository ?? 0, store: gitStoreDir(entry.project), nested: hostSettings().nestedRepositories } })
      Object.assign(entry, { workspace: { path: workspace.path, repository: workspace.repository ?? null }, snapshot: { baseCommit: workspace.baseCommit ?? null, base: workspace.base ?? null }, snapshotAt: clock.iso(), state: 'running' })
      await write(record)
      const records = await cycleRecords(verificationDir)
      const counting = (await deliveryCounts({ stages: [{ host: entry.host, stage: entry.stage, projects: [entry.project] }], deliveriesOf, records, threshold: 0 }).catch(() => [{ runs: null }]))[0].runs
      entry.coverage = pick(await Promise.resolve().then(() => coverageOf({ project: entry.project, projectPath: projectDir, snapshotPath: workspace.path, snapshotAt: entry.snapshotAt, candidates: counting?.map((r) => r.runId) ?? null }))
        .catch((error) => ({ error: error.message })))
      await write(record)
      const check = await fullVerificationDrive({ target, workspace, runDir: home, runId: driveId, project: entry.project, stage: entry.stage, verificationDir, clock, mode: 'instance', ...(drive ? { drive } : {}),
        onDriveWait: async (w) => {
          if (w.phase === 'start') entry.waiting = { reason: w.reason, since: w.from }
          else { entry.waits = [...(entry.waits ?? []), { reason: entry.waiting?.reason ?? null, from: w.from, to: w.to }]; delete entry.waiting }
          await write(record).catch(() => {})
        } })
      await fs.writeFile(path.join(home, 'drive.json'), JSON.stringify({ driveId, cycleId: record.id, project: entry.project, fullVerification: { check } }, null, 2))
      const suiteRan = await suiteRanOf({ runDir: home, check: check.result, target, suiteId: suite.test.id })
      const notOnInstance = await notOnInstanceOf({ runDir: home, check: check.result, target })
      const incomplete = infra.testDrive.modules.browser && !suite.browser
        ? { reason: 'BROWSER_CHECKS_UNBOUND', message: 'the project declares browser checks (testDrive.modules.browser) but modules.instance.fullSuite.browser names no whole browser run on an instance, so they did not run' }
        : null
      const reports = [...target.commands, ...(target.finallyCommands ?? [])].filter((c) => c.report).map((c) => c.id)
      Object.assign(entry, {
        state: 'settled', endedAt: clock.iso(),
        instance: { ...entry.instance, ...(check.result?.stageInstance ?? {}) },
        check: { ...checkRecord(check, await parsedFailures(home, check)), notOnInstance },
        suiteRan,
        browser: suite.browser ? 'declared' : incomplete ? 'unbound' : 'not-declared',
        evidence: { dir: path.join(home, check.result?.dir ?? DRIVE_DIR), files: Object.keys(await driveFiles(home, check.result)).sort(), selftestReports: reports, browser: suite.browser ? [suite.browser.id] : [], collectors: (target.finallyCommands ?? []).map((c) => c.id) },
        ...(incomplete ? { incomplete } : {}),
        verdict: incomplete ? 'incomplete' : check.gating === 'passed' ? 'green' : 'red'
      })
      // Before the finally below destroys the instance: each failed test alone on it (full-verification-rerun.mjs).
      if (entry.verdict !== 'green') {
        await rerunFailed(record, { entry, infra, check, target, home, driveId, workspace })
        if (entry.rerun?.state === 'ran') await fs.writeFile(path.join(home, 'drive.json'), JSON.stringify({ driveId, cycleId: record.id, project: entry.project, fullVerification: { check, rerun: entry.rerun } }, null, 2))
      }
    } catch (error) {
      Object.assign(entry, { state: 'refused', verdict: 'red', refusal: { code: error.code ?? null, status: error.status ?? null, message: error.message } })
    } finally {
      // Only a drive whose whole suite ran proves the deliveries its snapshot holds (verification-trigger.mjs).
      entry.coverageEstablished = Boolean(entry.suiteRan) && entry.verdict !== 'incomplete' && entry.state === 'settled'
      const destroyed = await Promise.resolve().then(() => destroyInstances(driveId, { reason: 'cycle-ended', clock })).catch((error) => [{ name: entry.instance.name, passed: false, error: error.message }])
      const mine = (destroyed ?? []).find((d) => d?.name === entry.instance.name)
      entry.instance = { ...entry.instance, destroyed: mine ? { passed: mine.passed, at: mine.at ?? clock.iso(), ...(mine.error ? { error: mine.error } : {}) } : (entry.instance.destroyed ?? { passed: true, at: clock.iso(), held: false }) }
      if (workspace) await Promise.resolve().then(() => releaseWorkspace({ ...workspace, projectPath: projectDir })).then(() => { entry.workspace.released = true }, (error) => { entry.workspace.retained = error.message })
    }
    entry.endedAt ??= clock.iso()
    entry.durationMs = Math.max(0, Date.parse(entry.endedAt) - Date.parse(entry.startedAt))
    await write(record)
  }

  /**
   * A red or incomplete instance entry: rerun each failed test alone on the instance the suite used, before it is
   * destroyed, when rerunPlan allows it (full-verification-rerun.mjs); else record why not. One drive per command
   * (`checks/full-verification-rerun-<n>/`), with no load or restart: the instance is still this process's, so the
   * drive is not fresh and runs only the rerun and the collectors. Every test passed alone: the entry is green and
   * names its flaky tests, which leave their lines in the project's selftest history. Never throws: a rerun that
   * breaks leaves the entry as the suite left it.
   */
  async function rerunFailed (record, { entry, infra, check, target, home, driveId, workspace }) {
    const settings = rerunSettings(infra)
    try {
      const reports = check.result ? await readReports({ runDir: home, check: check.result, target }) : []
      const plan = rerunPlan({ settings, incomplete: Boolean(entry.incomplete), check, suiteRan: entry.suiteRan, suiteId: infra.testDrive.modules.instance.fullSuite.test.id,
        reports, baseFailed: check.baseFailed ?? null, previousFlaky: check.baseline?.flaky ?? [] })
      const bound = settings.maxTests ?? null
      if (plan.skip) { entry.rerun = { state: 'skipped', ...plan.skip, bound, ...(plan.reported !== undefined ? { reported: plan.reported } : {}) }; return }
      entry.rerun = { state: 'running', bound, reported: plan.reported, tests: [], drives: [] }
      await write(record).catch(() => {})
      for (const [i, group] of rerunCommands(plan.tests, settings).entries()) {
        const rerunTarget = { ...target, commands: [fill(group.command, target.stageInstance)] }
        const result = await (drive ?? runChecks)({ target: rerunTarget, revision: null, base: true, dirName: `${RERUN_DIR}-${i + 1}`, baseCommit: workspace.baseCommit, workspacePath: workspace.path, gitDir: workspace.gitDir ?? null, runDir: home, clock, runId: driveId })
        const judged = judgeRerun({ drive: result, command: rerunTarget.commands[0], tests: group.tests, reports: await readReports({ runDir: home, check: result, target: rerunTarget }), target: rerunTarget })
        entry.rerun.drives.push({ dir: result.dir ?? null, command: group.command.id, result: result.result ?? null, at: result.at ?? clock.iso(), tests: group.tests.map((t) => t.test) })
        entry.rerun.tests.push(...judged.map((t) => ({ ...t, first: 'failed', dir: result.dir ?? null })))
      }
      const flaky = entry.rerun.tests.filter((t) => t.rerun === 'passed')
      Object.assign(entry.rerun, { state: 'ran', outcome: flaky.length === entry.rerun.tests.length ? 'all-passed' : 'some-not-passed' })
      if (flaky.length) {
        entry.flaky = flaky.map(({ command, test, module, dir }) => ({ command, test, ...(module ? { module } : {}), dir }))
        try {
          const dir = path.join(issues.ISSUES_DIR, entry.project, '.selftest-history')
          for (const line of flakyHistoryLines({ project: entry.project, driveId, flaky, suiteCheck: check.result, rerunAt: entry.rerun.drives.at(-1)?.at, baseCommit: workspace.baseCommit, at: clock.iso() })) await recordDrive(dir, line, { now: clock.now() })
        } catch (error) {
          entry.rerun.historyError = error.message
        }
      }
      if (entry.rerun.outcome === 'all-passed') entry.verdict = 'green'
    } catch (error) {
      entry.rerun = { ...(entry.rerun ?? {}), state: 'failed', error: error.message }
      delete entry.flaky
    }
  }

  async function runStage (record, entry, hosts = new Map()) {
    // Never a release to a host with dynamic instances, whoever asks.
    const refused = hostRefusal(entry, hosts)
    if (refused) {
      Object.assign(entry, { state: 'refused', verdict: 'red', refusal: refused, coverageEstablished: false })
      await write(record)
      return
    }
    entry.state = 'starting'
    entry.mode = 'release'
    try {
      const home = await issues.ensureRunHome(entry.project, record.date, report(entry))
      entry.issueId = home.id
      entry.runHome = home.path
      const runOptions = { environment: 'staging', fullVerification: true }
      const resolution = await resolve('deployment', { root: configRoot, runOptions, projectId: entry.project })
      if (!resolution.ok) throw Object.assign(new Error(resolution.errors.map((e) => `${e.field}: ${e.message}`).join('; ')), { code: 'CONFIGURATION_INVALID' })
      const blockers = resolution.resolved.liveExecution?.blockers ?? []
      if (blockers.length) throw Object.assign(new Error(blockers.map((b) => b.reason).join('; ')), { code: blockers.some((b) => b.reason === TARGET_MISSING) ? 'TARGET_MISSING' : 'NOT_LAUNCHABLE' })
      const started = await supervisor.start({ project: entry.project, issueId: home.id, playbookId: 'deployment', expectConfigHash: resolution.resolved.configHash, runOptions, configRoot, cycle: record.id })
      Object.assign(entry, { runId: started.runId, runDir: path.join(home.path, 'runs', started.runId), state: 'running', startedAt: clock.iso() })
      await write(record)
      let run = null
      for (;;) {
        run = await readRun(home.path, started.runId).catch(() => null)
        if (run && !LIVE.includes(run.status) && !supervisor.isActive(entry.project, home.id)) break
        await wait(pollMs)
      }
      const check = run.fullVerification?.check ?? null
      // The failures each failed command's own output names (the parser the baseline comparison uses),
      // for a command no comparison judged; an unreadable output names none.
      const parsed = await parsedFailures(entry.runDir, check)
      Object.assign(entry, {
        state: 'settled', status: run.status, outcome: run.outcome ?? null, blockedReason: run.blockedReason ?? null,
        release: run.release ? { status: run.release.status, environment: run.release.environment ?? null } : null,
        endedAt: run.endedAt ?? clock.iso(),
        check: check ? checkRecord(check, parsed) : null,
        verdict: stagedReleasePassed(run.release, run) && check?.gating === 'passed' ? 'green' : 'red',
        // What the release's snapshot carried (staging-coverage.mjs stagingRunCoverage, on the run's record).
        snapshotAt: run.startedAt ?? entry.startedAt,
        coverage: pick(run.release?.coverage)
      })
      // The released snapshot was tested only when its full drive ran every required command to an answer of its own
      // (no skip, timeout, signal or unavailable) and a selftest report parsed out of a report command's output.
      entry.suiteRan = check?.result ? await fullTierRanOf({ runDir: entry.runDir, check: check.result, selftest: check.selftest }) : null
      if (entry.verdict === 'red') entry.rerun = { state: 'skipped', reason: 'release-mode', message: 'a release-mode stage has no instance of the cycle\'s own to rerun a failed test on' }
      entry.coverageEstablished = Boolean(run.release?.status === 'completed' && entry.suiteRan)
    } catch (error) {
      Object.assign(entry, { state: 'refused', verdict: 'red', refusal: { code: error.code ?? null, status: error.status ?? null, message: error.message }, coverageEstablished: false })
    }
    entry.durationMs = entry.startedAt ? Math.max(0, Date.parse(entry.endedAt ?? clock.iso()) - Date.parse(entry.startedAt)) : null
    await write(record)
  }

  // ------------------------------------------------------------ the outcome

  /** Bump or open issues, by the verdict; recorded as `record.outcome`. Never throws. */
  async function outcome (record) {
    record.state = 'outcome'
    record.outcome = { verdict: record.verdict, startedAt: clock.iso(), endedAt: null }
    await write(record).catch(() => {})
    try {
      if (record.verdict === 'green') await bump(record)
      else if (record.verdict === 'red') await openIssues(record)
      else record.outcome.reason = 'no stage was verified: nothing to bump and nothing red'
    } catch (error) {
      record.outcome.error = error.message
    }
    // After the checkpoint chain or the red issues: the flaky tests of every entry not red, never silent.
    await noteFlaky(record).catch((error) => { record.outcome.flakyError = error.message })
    record.outcome.endedAt = clock.iso()
    await write(record).catch(() => {})
  }

  /**
   * Every stage green: each framework's checkpoint with --minor, then each of its instances'
   * checkpoints (poolMembers: the framework first, instances by id), one at a time. The first
   * step that does not complete stops every later one.
   */
  async function bump (record) {
    const result = { chain: [], failed: null, notRun: [], versions: {} }
    record.outcome.bump = result
    const projects = await projectsConfig()
    const frameworks = [...new Set([...projects.values()].map((p) => p.framework).filter((id) => id && projects.has(id)))].sort()
    const steps = frameworks.flatMap((framework) => poolMembers(framework, projects).map((project, i) => ({ project, framework, args: i === 0 ? ['--minor'] : [] })))
    if (!steps.length) { result.reason = 'no project names a framework (framework: in projects/<id>.yaml), so there is nothing to bump'; return }
    for (const [i, s] of steps.entries()) {
      const step = { project: s.project, framework: s.framework, action: 'checkpoint', args: s.args, status: 'running', versionBefore: await versionOf(s.project).catch(() => null), startedAt: clock.iso() }
      result.chain.push(step)
      await write(record).catch(() => {})
      try {
        const operation = await runAction({ project: s.project, actionId: 'checkpoint', args: s.args })
        Object.assign(step, { operationId: operation?.id ?? null, status: operation?.status ?? 'failed', exitCode: operation?.exitCode ?? null })
        if (step.status !== 'completed') step.reason = operation?.error ?? (operation?.timedOut ? 'the action reached its deadline' : `the action ended ${step.status}${step.exitCode != null ? ` with exit code ${step.exitCode}` : ''}`)
      } catch (error) {
        Object.assign(step, { status: 'refused', reason: error.message, code: error.status ?? null })
      }
      step.versionAfter = await versionOf(s.project).catch(() => null)
      step.endedAt = clock.iso()
      if (step.status !== 'completed') {
        result.failed = { project: s.project, reason: step.reason }
        result.notRun = steps.slice(i + 1).map((n) => ({ project: n.project, framework: n.framework, args: n.args }))
        break
      }
      if (step.versionAfter === step.versionBefore) step.unchanged = true
      result.versions[s.project] = step.versionAfter
    }
  }

  /** Any stage red: one new issue per red project, holding that cycle's failing tests, excerpts and run. */
  async function openIssues (record) {
    const out = []
    record.outcome.issues = out
    // The first cycle of a date names its issues by the date; a later one by its id, in the date's place: an issue's
    // id is a slug of the name's beginning (issues.js slugify) and one id opens once a day, so an id at the name's
    // end was cut off and the later cycle's issue was refused as already opened.
    const later = Number(record.id.split('.').pop()) > 1
    // An incomplete entry (declared browser checks with no instance command) is not green either: it gets its issue.
    for (const entry of record.projects.filter((e) => !e.verifiedThrough && ['red', 'incomplete'].includes(e.verdict))) {
      const stage = entry.stage ?? 'configuration'
      const name = `Full verification ${later ? record.id : record.date}: ${entry.project} red on ${stage}`
      const item = { project: entry.project, stage, name, runId: entry.runId ?? null, issueId: null, failingCount: 0, attachments: [] }
      out.push(item)
      try {
        const failures = []
        // After a rerun only the tests that failed again (or whose rerun proved nothing) fail; the flaky ones are named apart.
        const failing = entry.rerun?.state === 'ran'
          ? entry.rerun.tests.filter((t) => t.rerun !== 'passed').map((t) => ({ command: t.command, test: t.test, basis: t.rerun === 'failed' ? 'failed-twice' : 'not-observed',
            message: t.rerun === 'failed' ? `Failed in the whole suite and again alone on the same instance (rerun in ${t.dir}).` : `Failed in the whole suite; its rerun alone proved nothing: ${t.why} (rerun in ${t.dir}).` }))
          : entry.check?.failingTests ?? []
        for (const f of failing) failures.push({ ...f, excerpt: await excerptOf({ runDir: entry.runDir, dir: entry.check.dir, command: f.command, test: f.test, commands: entry.check.failedCommands ?? [] }) })
        const unread = entry.check?.unread ?? []
        const flaky = entry.flaky ?? []
        item.failingCount = failures.length
        if (flaky.length) item.flaky = flaky.map((f) => `${f.command}: ${f.test}`)
        const parts = failures.length || unread.length || flaky.length ? failureAttachments({ name, failures, unread, flaky, maxBytes: maxAttachmentBytes }) : []
        const issue = await issues.createIssue(entry.project, {
          input: redIssueReport({ record, entry, name, stage, failures, unread, flaky, parts }),
          openedBy: { user: 'engine', from: { project: entry.project, runId: entry.runId ?? null, via: 'full-verification', cycle: record.id } }
        })
        item.issueId = issue?.id ?? null
        for (const part of parts) {
          try {
            await issues.addStepFile(entry.project, item.issueId, '000', part.name, Buffer.from(part.text, 'utf8'))
            item.attachments.push(part.name)
          } catch (error) {
            item.error = `${item.error ? `${item.error}; ` : ''}${part.name} could not be attached: ${error.message}`
          }
        }
      } catch (error) {
        item.error = `${item.error ? `${item.error}; ` : ''}${error.message}`
      }
      await write(record).catch(() => {})
    }
  }

  /**
   * The flaky tests of every entry that is not red (a red one names them in its issue): a note on the project's open
   * flaky-test issue (openedBy.from.subject 'flaky-tests', open, no disposition), else a new one. Recorded as
   * `record.outcome.flaky`.
   */
  async function noteFlaky (record) {
    const entries = record.projects.filter((e) => !e.verifiedThrough && e.verdict !== 'red' && e.flaky?.length)
    if (!entries.length) return
    const out = []
    record.outcome.flaky = out
    const later = Number(record.id.split('.').pop()) > 1
    for (const entry of entries) {
      const name = `Full verification ${later ? record.id : record.date}: flaky tests in ${entry.project}`
      const item = { project: entry.project, issueId: null, noted: false, tests: entry.flaky.map((f) => `${f.command}: ${f.test}`) }
      out.push(item)
      try {
        const blocks = []
        for (const f of entry.flaky) {
          const excerpt = await excerptOf({ runDir: entry.runDir, dir: entry.check?.dir, command: f.command, test: f.test, commands: entry.check?.failedCommands ?? [] })
          blocks.push(failureBlock({ ...f, basis: 'flaky', message: `Failed in the whole suite, passed when rerun alone on the same instance (rerun in ${f.dir}).`, excerpt }))
        }
        const text = [`# ${name}`, '',
          `The full verification ${record.id} found ${entry.flaky.length} ${plural(entry.flaky.length, 'test', 'tests')} of ${entry.project} that failed in the whole suite on ${entry.stage} and passed when rerun alone on the same instance. They did not make the stage red (the entry reads ${entry.verdict}). Each is recorded in issues/${entry.project}/.selftest-history/ as a failure and a pass on one tree, so the unstable classification sees it.`, '',
          `- Cycle: \`${record.id}\` (record \`issues/.verification/${record.date}/cycle.json\`)`,
          `- Drive: \`${entry.driveId}\` on stage instance \`${entry.instance?.name ?? 'none'}\`; evidence \`${entry.runDir}\``, '',
          `## Flaky tests (${entry.flaky.length})`, '', ...blocks].join('\n')
        const open = (await issues.listIssues(entry.project)).find((i) => i.openedBy?.from?.via === 'full-verification' && i.openedBy.from.subject === 'flaky-tests' && (i.status ?? 'open') === 'open' && !i.disposition && !i.archived)
        if (open) {
          await issues.createEngineNote(entry.project, open.id, { name: 'flaky-tests', text, invocationId: `full-verification:${record.id}:flaky` })
          Object.assign(item, { issueId: open.id, noted: true })
        } else {
          const issue = await issues.createIssue(entry.project, { input: text, openedBy: { user: 'engine', from: { project: entry.project, runId: null, via: 'full-verification', cycle: record.id, subject: 'flaky-tests' } } })
          Object.assign(item, { issueId: issue?.id ?? null, name })
        }
      } catch (error) {
        item.error = error.message
      }
      await write(record).catch(() => {})
    }
  }

  /**
   * Resume every run of an issue or a run home the freeze paused; one where an operator's pause was
   * pending as well stays paused for that operator. Refusals are recorded, never retried.
   */
  async function resumeFrozen (record) {
    for (const p of await issues.listProjects()) {
      const project = p.id ?? p
      // The issues, and the run homes: a run of an earlier cycle this cycle froze is resumed the same way.
      const holders = [...await issues.listIssues(project).catch(() => []), ...(issues.listRunHomes ? await issues.listRunHomes(project).catch(() => []) : [])]
      for (const issue of holders) {
        const latest = issue.latestRun
        if (latest?.status !== 'paused') continue
        const run = await readRun(issue.path, latest.runId).catch(() => null)
        if (run?.pause?.kind !== 'full-verification') continue
        const named = { project, issueId: issue.id, runId: latest.runId }
        if (run.pause.manualPending) { record.heldForOperator.push(named); continue }
        try {
          await supervisor.resume({ ...named, actor: 'service', origin: 'full-verification' })
          record.resumed.push(named)
        } catch (error) {
          record.refused.push({ ...named, reason: error.message })
        }
      }
    }
  }

  return {
    /** Arm the schedule and the delivery trigger. Absent `fullVerification.at`: the timer only reads the settings again hourly. */
    start () { stopped = false; arm(); armDeliveries() },
    stop () { stopped = true; cancel?.(); cancel = null; cancelDeliveries?.(); cancelDeliveries = null },
    /** "Full verification now": the same freeze, stages and record as the other triggers. */
    startNow: ({ by = 'operator' } = {}) => startCycle({ trigger: 'hand', by }),
    /**
     * Deliver every end still owed to the top-level supervisor (a cycle recover() marked interrupted, or one whose
     * announcement failed), once each; called when the supervisor exists. Returns the cycle ids told.
     */
    async announcePending () {
      const told = []
      for (const record of (await cycleRecords(verificationDir)).reverse()) {
        if (record.announce === 'pending' && SETTLED_CYCLE.includes(record.state) && await announce(record)) told.push(record.id)
      }
      return told
    },
    /** A run ended: it may have delivered, so count the stages' deliveries again (coalesced). */
    noteRunEnded: () => deliveryCheck(),
    deliveryCheck,
    /**
     * A cycle the previous process left unfinished is marked interrupted; the runs it paused are
     * resumed, and what its instance drives left is destroyed and released (the sweep at the panel's
     * start removes an instance whose owner died as well).
     */
    async recover () {
      const record = await latestRecord()
      if (record && !SETTLED_CYCLE.includes(record.state)) {
        // Ended by recovery: owed to the top-level supervisor like any end, told once it exists (announcePending).
        Object.assign(record, { state: 'interrupted', endedAt: clock.iso(), error: 'the service stopped before the cycle ended; its runs were not resumed automatically', announce: 'pending' })
        for (const entry of (record.projects ?? []).filter((e) => e.driveId)) {
          if (entry.state !== 'settled' && entry.state !== 'refused') Object.assign(entry, { state: 'interrupted', verdict: entry.verdict ?? 'red', coverageEstablished: false })
          if (!entry.instance?.destroyed) {
            const destroyed = await Promise.resolve().then(() => destroyInstances(entry.driveId, { reason: 'cycle-interrupted', clock })).catch((error) => [{ name: entry.instance?.name, passed: false, error: error.message }])
            const mine = (destroyed ?? []).find((d) => d?.name === entry.instance?.name)
            entry.instance = { ...(entry.instance ?? {}), destroyed: mine ? { passed: mine.passed, at: clock.iso(), ...(mine.error ? { error: mine.error } : {}) } : { passed: true, at: clock.iso(), held: false } }
          }
          if (entry.workspace && !entry.workspace.released && !entry.workspace.retained) {
            const projectDir = await projectPathOf(entry.project).catch(() => null)
            await Promise.resolve().then(() => releaseWorkspace({ ...entry.workspace, projectPath: projectDir })).then(() => { entry.workspace.released = true }, (error) => { entry.workspace.retained = error.message })
          }
        }
        await write(record)
      }
      const resumed = { id: record?.id ?? null, resumed: [], heldForOperator: [], refused: [] }
      await resumeFrozen(resumed)
      return resumed
    },
    async latest () {
      const s = readSettings()
      return {
        schedule: s ? { at: s.at, timeZone: s.timeZone, next: new Date(nextTrigger(s, clock.now())).toISOString() } : null,
        active: Boolean(running),
        frozen: supervisor.frozen?.() ?? null,
        deliveries: lastDeliveryCheck,
        cycle: running ? current : await latestRecord()
      }
    },
    /** For tests: the cycle in progress settles. */
    settle: () => Promise.resolve(running)
  }
}
