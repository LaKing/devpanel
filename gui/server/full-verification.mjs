import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './runtime/clock.mjs'
import { hostSettings } from './config/host-settings.mjs'
import { loadConfig, resolvePlaybook } from './config/load.mjs'
import { hostConfigSelection } from './config/host-config.mjs'
import { releasePlan, TARGET_MISSING } from './config/release-plan.mjs'
import { projectInfrastructure } from './infrastructure.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { stagedReleasePassed } from './runtime/run-result.mjs'
import { failureFingerprints, selftestReport } from './runtime/baseline-failures.mjs'
import { poolIdOf, poolMembers } from './runtime/module-pool.mjs'
import { startProjectAction } from './project-actions.mjs'
import { projectDiscovery, projectPath, projectsRoot, readProjectDirs, resolveProjectPath } from './project-path.mjs'
import { cycleRecords, driveFiles, DRIVE_DIR, fullTierRanOf, fullVerificationDrive, instanceCycleTarget, notOnInstanceOf, readReports, suiteRanOf } from './runtime/full-verification-drive.mjs'
import { flakyHistoryLines, judgeRerun, rerunCommands, rerunPlan, rerunSettings, RERUN_DIR } from './runtime/full-verification-rerun.mjs'
import { fill, instanceName } from './runtime/instance-drive.mjs'
import { runChecks } from './runtime/checks.mjs'
import { recordDrive } from './runtime/selftest-history.mjs'
import { destroyRunInstances } from './runtime/stage-instances.mjs'
import { gitWorktreeProvider } from './runtime/launch.mjs'
import { gitStoreDir } from './runtime/git-store.mjs'
import { cycleSnapshotCoverage, deliveriesOf as projectDeliveries, NOT_MATERIALIZED } from './staging-coverage.mjs'
import { deliveryCounts } from './verification-trigger.mjs'
import { checkoutsOf, committedBeyond, followedViews, forgetRef, MOTION_WINDOW_MS, motionOf, movingPaths, readCheckouts, readGit, SHOWN_PATHS, snapshotCheckouts, snapshotDiff, snapshotRecord, testedViews, viewReader } from './runtime/full-verification-snapshot.mjs'

/*
 * The full verification (docs/tactical-playbooks.md "Full verification cycles",
 * execution-contract.md "Full verification freeze").
 *
 * On request (POST /api/verification/start), once `fullVerification.afterDeliveries`
 * deliveries happened on one stage (verification-trigger.mjs), and at the host settings'
 * `fullVerification.at` in its `timeZone` when given, a cycle:
 *   1. decides its scope from one reading of the configuration (readCycleConfig, cycleScope:
 *      the projects with infrastructure.staging and their whole module pools; a listing or
 *      configuration it cannot read refuses the cycle, FULL_VERIFICATION_SCOPE_UNREADABLE,
 *      before anything is frozen) and closes admission for the writing runs of those projects
 *      (supervisor.freeze): none starts, continues or delivers, and every live one pauses at
 *      its next step boundary as `full-verification`; read-only runs (no delivery, no release,
 *      not in place) go on, and a run of a project outside the scope is never touched;
 *   2. waits until no writing run or delivery of the scope is left in this process (supervisor.busy);
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
 *      A framework (a project others name with `framework:`) one of whose pool instances is
 *      driven in the cycle waits for them; when an instance entry's snapshot materialized
 *      its checkout it gets no drive of its own and its entry is derived from those entries
 *      (deriveEntry: `mode: 'derived'`, green only when every one is green, settled, ran its
 *      whole suite and established coverage; its deliveries read through their copies of it),
 *      otherwise it is driven as any other;
 *      Each entry records the delivered runs its snapshot covered;
 *      Each entry records whether its checkouts were moving around the snapshot
 *      (snapshotMotion, snapshotDuringEdits; information, no verdict reads it);
 *   4. waits until those runs settle and handles the outcome while admission is still
 *      closed: every stage green, each green entry's checkouts are snapshotted again and
 *      compared with what it tested; a pool any of whose checkouts moved runs no
 *      checkpoint (outcome.bump.withheld, outcome.committed false). Otherwise each
 *      framework's `checkpoint` runs with --minor and then each instance's `checkpoint`
 *      (runtime/module-pool.mjs poolMembers order), stopping at the first that fails, and
 *      every attempt's commit is compared with the tested bytes (step.afterCommit,
 *      outcome.bump.untestedCommitted; reported, never reverted); any stage red, no action
 *      runs and one issue opens per red project with its failing tests and their excerpts;
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
 * The projects a cycle verifies, and so the only ones its freeze holds (supervisor.freeze): every project with a stage
 * the cycle drives (infrastructure.staging, not declared verified through its instances, not refused up front by the
 * configuration: HOST_HAS_INSTANCES, FULL_SUITE_UNDECLARED, a release stage without a staging release target), and
 * the whole module pool
 * of each (its framework, resolved through poolIdOf, and every instance naming it). A pool with no driven stage (an
 * instances-only framework whose members have no staging) is not verified, so it is not in the scope.
 * `infras` maps project -> infrastructure (null: none, {error}: invalid), `config` the projects' configuration
 * (null: pools unknown). Sorted ids.
 */
export function cycleScope ({ infras, config }) {
  const scope = new Set()
  // A stage refused up front (a release to a host with dynamic instances, an instance stage without a full suite) verifies
  // nothing: it neither enters the scope nor brings its pool in (verifiable, the delivery trigger's own predicate).
  const hosts = protectedHosts(new Map([...infras].filter(([, infra]) => !infra?.error)))
  for (const [id, infra] of infras) {
    if (!infra?.staging || infra.error) continue
    const stage = stageOf(id, infra)
    if (!verifiable(stage, infra, hosts)) continue
    // A release stage with no configured staging release target is refused by the Deployment resolution
    // (TARGET_MISSING): the same release-plan check, on the same reading, keeps it and its pool out.
    if (stage.mode !== 'instance' && targetMissing(infra)) continue
    scope.add(id)
    const pool = config ? poolIdOf(id, config) : null
    if (!pool) continue
    scope.add(pool)
    for (const member of poolMembers(pool, config)) scope.add(member)
  }
  return [...scope].sort()
}

/**
 * Everything a cycle decides from, read once and together: the project listing (project-path.mjs readProjectDirs,
 * uncached), one load of the configuration in the host-config directory chosen now (hostConfigSelection), each listed
 * project's infrastructure from that same load, and every read that failed for another reason than absence
 * (`unreadable`: [{path, code}]), which refuses the cycle. A project file that loads but fails its schema is kept as
 * `{ error }` (a red INFRASTRUCTURE_INVALID entry), as before.
 */
export async function readCycleConfig ({ root, projectsDir = projectsRoot(), discovery = projectDiscovery(), env = process.env, load = loadConfig } = {}) {
  const listing = await readProjectDirs(projectsDir, discovery)
  const selection = hostConfigSelection({ root, env })
  const config = await load({ root, hostDir: selection.dir })
  const infras = new Map()
  for (const { id } of listing.projects) infras.set(id, await projectInfrastructure(id, { config }).catch((error) => ({ error: error.message })))
  const unreadable = [...listing.unreadable, ...selection.unreadable, ...(config.unreadable ?? []).filter((u) => u.category === 'projects').map((u) => ({ path: u.dir, code: u.code }))]
  return { projects: listing.projects.map((p) => p.id), infras, config: config.projects, unreadable }
}

/** Whether a release stage has no configured staging release target (the Deployment resolution's TARGET_MISSING). */
const targetMissing = (infra) => releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'staging' } }).blockers.some((b) => b.reason === TARGET_MISSING)

/** The refusal of a cycle whose scope cannot be decided: nothing is frozen, nothing recorded. */
const scopeUnreadable = (unreadable) => Object.assign(new Error(`the full verification cannot decide which projects it verifies, so it does not start: ${unreadable.map((u) => u.message ?? `${u.path} could not be read (${u.code ?? 'error'})`).join('; ')}`), { status: 503, code: 'FULL_VERIFICATION_SCOPE_UNREADABLE', unreadable })

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

/**
 * The verdict of a framework entry derived from instance entries: green only when every one is green, settled, ran
 * its whole suite and established coverage; else red, each one that is not named with why.
 */
export function derivedVerdict (sources) {
  const red = []
  for (const s of sources) {
    const reason = s.state === 'refused' ? `refused${s.refusal ? `: ${s.refusal.code ? `${s.refusal.code}: ` : ''}${s.refusal.message}` : ''}`
      : s.state === 'interrupted' ? 'interrupted'
        : s.state !== 'settled' ? `not settled (${s.state ?? 'pending'})`
          : s.verdict === 'incomplete' ? `incomplete${s.incomplete ? `: ${s.incomplete.reason}` : ''}`
            : s.verdict !== 'green' ? `red${s.check?.failingTests?.length ? ` on ${s.check.failingTests.length} failing ${plural(s.check.failingTests.length, 'test', 'tests')}` : ''}`
              : !s.suiteRan ? 'its whole suite did not run'
                : s.coverageEstablished !== true ? 'its coverage is not established'
                  : null
    if (reason) red.push({ project: s.project, verdict: s.verdict ?? null, state: s.state ?? null, reason })
  }
  return { verdict: sources.length && !red.length ? 'green' : 'red', red }
}

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

const failureBlock = (f) => [`### \`${f.command}: ${f.test}\` (${f.basis})`, '', ...(f.from ? [`From the instance entry of \`${f.from.project}\`${f.from.driveId ? ` (drive \`${f.from.driveId}\`)` : f.from.runId ? ` (run \`${f.from.runId}\`)` : ''}.`, ''] : []), ...(f.message ? [f.message, ''] : []),
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
    `The full verification ${record.id} found ${entry.project} red on ${stage}. The cycle opened this issue with that cycle's evidence; no version was bumped.`, '',
    `- Cycle: \`${record.id}\` (record \`issues/.verification/${record.date}/cycle.json\`)`,
    entry.mode === 'derived' ? `- No drive of its own: the entry is derived from the instance entries of this cycle whose snapshots materialized ${entry.project}'s checkout (${entry.derived?.rule ?? 'every one green'}).`
      : entry.mode === 'instance' ? `- Drive: \`${entry.driveId}\` on stage instance \`${entry.instance?.name ?? 'none created'}\`${entry.instance?.destroyed ? (entry.instance.destroyed.passed ? ' (destroyed)' : ` (its destroy failed: ${entry.instance.destroyed.error})`) : ''}; evidence \`${entry.evidence?.dir ?? entry.runDir ?? 'none'}\`` : entry.runId ? `- Run: \`${entry.runId}\` in \`${entry.runHome}\`` : '- Run: none started']
  if (entry.derived) {
    lines.push('- Derived from:')
    for (const f of entry.derived.from) {
      const bad = entry.derived.red.find((r) => r.project === f.project)
      lines.push(`  - \`${f.project}\` on ${f.stage ?? 'its stage'}: ${bad ? bad.reason : 'green'}${f.driveId ? `, drive \`${f.driveId}\`` : f.runId ? `, run \`${f.runId}\`` : ''}; evidence \`${f.evidence ?? 'none'}\``)
    }
    if (entry.derived.unmaterialized?.total) lines.push(`- Framework paths no instance's snapshot held (untested): ${entry.derived.unmaterialized.total}, first ${entry.derived.unmaterialized.paths.map((p) => `\`${p}\``).join(', ')}`)
  }
  if (entry.incomplete) lines.push(`- Incomplete: ${entry.incomplete.reason}: ${entry.incomplete.message}`)
  if (entry.status) lines.push(`- Run status: ${entry.status}${entry.blockedReason ? ` (${entry.blockedReason})` : ''}${entry.release ? `; release ${entry.release.status}` : ''}`)
  if (entry.refusal) lines.push(`- Not started: ${entry.refusal.code ? `${entry.refusal.code}: ` : ''}${entry.refusal.message}`)
  if (entry.check) {
    lines.push(`- Full check: ${entry.check.result ?? 'no result'}, gate ${entry.check.gating}${entry.check.baseline?.cycleId ? `, compared with cycle ${entry.check.baseline.cycleId}` : ', no previous green cycle to compare with'}`)
    if (entry.check.selftestVerdict) lines.push(`- Selftest comparison: ${entry.check.selftestVerdict}${entry.check.selftestReason ? ` (${entry.check.selftestReason})` : ''}`)
  }
  if (rerunLine(entry.rerun)) lines.push(rerunLine(entry.rerun))
  const moving = entry.snapshotDuringEdits ? movingPaths(entry.snapshotMotion) : []
  if (entry.snapshotDuringEdits) {
    const m = entry.snapshotMotion
    lines.push(`- Snapshot taken during edits: ${m.during?.total ?? 0} ${plural(m.during?.total ?? 0, 'path', 'paths')} changed while it was read, ${m.recent?.total ?? 0} within ${Math.round((m.windowMs ?? 0) / 60000)} minutes before it (newest change ${m.newest?.at ?? 'unknown'}${m.newest ? ` in \`${m.newest.path}\`` : ''}). The failures may come from a half-done change; the verdict was not changed.`)
  }
  lines.push('')
  if (moving.length) lines.push('## Moving paths at snapshot time', '', ...moving.map((p) => `- \`${p.checkout}\`: \`${p.path}\``), ...(moving.length >= SHOWN_PATHS ? ['', `The first ${moving.length} are shown; the cycle record's \`snapshotMotion\` has the totals.`] : []), '')
  if (failures.length) {
    lines.push(entry.derived ? `## Failing tests of the instance entries it is derived from (${failures.length})` : `## Failing tests (${failures.length})`, '')
    if (failures.length > SHOWN_FAILURES) lines.push(`The first ${SHOWN_FAILURES} are shown here; every one is in the attachment named below.`, '')
    for (const f of failures.slice(0, SHOWN_FAILURES)) lines.push(failureBlock(f))
  } else lines.push('## Failing tests', '', entry.derived ? 'The instance entries it is derived from name no failing test; the lines above say why each is not green.' : 'The check names no failing test; the run status above says why the stage is red.', '')
  if (unread.length) lines.push('## Reports that could not be read', '', ...unread.map((u) => `- \`${u.command}\`: ${u.reason}`), '')
  if (flaky.length) lines.push(flakySection(flaky))
  if (parts.length) lines.push(`All ${failures.length} failing ${plural(failures.length, 'test', 'tests')} with ${plural(failures.length, 'its excerpt', 'their excerpts')}: ${parts.map((p) => `\`${p.name}\``).join(', ')} on the report step (000).`, '')
  return lines.join('\n')
}

const report = ({ project, stage }) => `# Full verification of ${project} on ${stage}

This is the panel's full verification (a cycle after a number of deliveries, on request, or at a
configured time), not a reported problem. Release the project's development
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
  infrastructureOf: injectedInfrastructureOf = null,
  readRun = (issuePath, runId) => fs.readFile(path.join(issuePath, 'runs', runId, 'run.json'), 'utf8').then(JSON.parse),
  emit = null,
  /** The projects' configuration (`framework:` declarations). */
  projectsConfig: injectedProjectsConfig = null,
  /*
   * What a cycle decides from, read once (readCycleConfig): the project list, each project's infrastructure and
   * the projects' configuration from one load, and what could not be read. A caller that injects
   * infrastructureOf/projectsConfig (the tests' fakes) gets inputs built from those, with nothing unreadable.
   */
  cycleInputs: injectedCycleInputs = null,
  // The projects root the issue store and supervisor read (issues.js PROJECTS_DIR, fixed at load), never a later reading.
  projectsDir = issues.PROJECTS_DIR,
  discovery = undefined,
  env = process.env,
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
  coverageOf = ({ views, ...args }) => cycleSnapshotCoverage({ ...args, ...(views ? viewReader(views) : {}), listIssues: (p, o) => issues.listIssues(p, o), listHomes: (p) => issues.listRunHomes?.(p) ?? [] }),
  projectPathOf = (project) => resolveProjectPath(project),
  // The delivery trigger (verification-trigger.mjs): how many deliveries a stage takes, and a project's deliveries.
  afterDeliveries = () => hostSettings().verificationTrigger.afterDeliveries,
  deliveriesOf = async (project) => projectDeliveries({ project, projectPath: await projectPathOf(project).catch(() => null), listIssues: (p, o) => issues.listIssues(p, o), listHomes: (p) => issues.listRunHomes?.(p) ?? [] }),
  deliveryPollMs = 15 * 60 * 1000,
  /** Told when a cycle ended (the top-level supervisor's verification-ended event); never throws into the cycle. */
  onEnded = null,
  // What the cycle knows of the bytes it tested (runtime/full-verification-snapshot.mjs): a reading of the checkouts a
  // snapshot of `projectDir` reads (plus `extra`), the window before a snapshot in which a change means it was moving,
  // where a snapshot lives, a checkout's HEAD, and a commit compared with the tested views of its checkout.
  readMotion = async ({ projectDir, policy = {}, extra = [] }) => readCheckouts([projectDir, ...await snapshotCheckouts(projectDir, policy), ...extra]),
  motionWindowMs = MOTION_WINDOW_MS,
  recordSnapshot = (args) => snapshotRecord(args),
  compareSnapshots = (args) => snapshotDiff(args),
  headOf = async (checkout) => (await readGit(['-C', checkout, 'rev-parse', 'HEAD'])).trim(),
  compareCommit = (args) => committedBeyond(args)
} = {}) {
  const infrastructureOf = injectedInfrastructureOf ?? ((project) => projectInfrastructure(project, { root: configRoot }))
  const projectsConfig = injectedProjectsConfig ?? (async () => (await loadConfig({ root: configRoot })).projects)
  const cycleInputs = injectedCycleInputs ?? (injectedInfrastructureOf || injectedProjectsConfig
    ? async () => {
      const projects = (await issues.listProjects()).map((p) => p.id ?? p)
      const infras = new Map()
      for (const id of projects) infras.set(id, await Promise.resolve().then(() => infrastructureOf(id)).catch((error) => ({ error: error.message })))
      return { projects, infras, config: await Promise.resolve().then(() => projectsConfig()).catch(() => null), unreadable: [] }
    }
    : () => readCycleConfig({ root: configRoot, projectsDir: projectsDir ?? projectsRoot(), discovery: discovery === undefined ? projectDiscovery() : discovery, env }))
  // The inputs of the cycle running now (one at a time): its stages and its checkpoint chain read them, never a later reading.
  let activeInputs = null
  let cancel = null
  let cancelDeliveries = null
  let deliveryCheckRunning = null
  let lastDeliveryCheck = null
  let current = null
  let running = null
  let stopped = false
  // Per project, how its entry's snapshot was taken (checkout, policy, where): the recheck before the chain takes it again.
  const snapshotInputs = new Map()

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

  /**
   * The newest cycle record. With `strict` (latest(), what the pages show) a listing or a newest record that exists
   * but cannot be read throws (503) instead of falling back to an older cycle; only a missing one is passed over.
   */
  async function latestRecord ({ strict = false } = {}) {
    const unreadable = (what, error) => Object.assign(new Error(`${what} cannot be read: ${error.message}`), { status: 503 })
    const listed = await fs.readdir(verificationDir).catch((error) => {
      if (strict && error.code !== 'ENOENT') throw unreadable('the verification directory', error)
      return []
    })
    const dates = listed.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    for (const date of dates) {
      const record = await fs.readFile(path.join(verificationDir, date, 'cycle.json'), 'utf8').then(JSON.parse, (error) => {
        if (strict && error.code !== 'ENOENT') throw unreadable(`the cycle record of ${date}`, error)
        return null
      })
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
    // The scope, decided before anything is frozen or recorded: inputs that cannot be read refuse the cycle.
    let inputs
    try { inputs = await cycleInputs() } catch (error) { throw scopeUnreadable([{ path: null, code: error.code ?? null, message: error.message }]) }
    if (inputs.unreadable?.length) throw scopeUnreadable(inputs.unreadable)
    if (running) throw Object.assign(new Error(`a full verification cycle is already running (${current.id})`), { status: 409, code: 'FULL_VERIFICATION_RUNNING', cycleId: current.id })
    const s = readSettings()
    const timeZone = s?.timeZone ?? 'UTC'
    const date = localDate(clock.now(), timeZone)
    const record = {
      id: null, date, trigger, by, scheduledFor, ...(deliveries ? { deliveries } : {}), schedule: s ? { at: s.at, timeZone: s.timeZone } : null, timeZone,
      state: 'frozen', verdict: null, frozenAt: clock.iso(), seatsIdleAt: null, startedAt: null, endedAt: null,
      scope: { projects: cycleScope(inputs), decidedAt: clock.iso() },
      asked: [], waitingOn: [], projects: [], resumed: [], heldForOperator: [], leftPaused: [], refused: [], outcome: null, error: null
    }
    running = true
    current = record
    try {
      record.id = `${date}.${await rotate(date)}`
      record.asked = await supervisor.freeze(record.id, { projects: record.scope.projects })
      await write(record)
    } catch (error) {
      running = null
      current = null
      supervisor.thaw(record.id)
      // Not active any more: a page that read it active must hear so.
      if (record.id) changed(record)
      throw error
    }
    // The record as it stood when admission closed; the cycle goes on changing its own copy.
    const frozen = structuredClone(record)
    activeInputs = inputs
    // Clearing `running` changes what latest() reports (active), so it is announced like any write,
    // whatever became of the cycle's own last write or its announcement.
    running = cycle(record, inputs).catch((error) => log.warn?.(`[devpanel] full verification ${record.id} failed: ${error.message}`)).finally(() => { running = null; changed(record) })
    return frozen
  }

  async function cycle (record, inputs) {
    snapshotInputs.clear()
    try {
      // No run of an issue left in this process: no seat turn is running.
      for (;;) {
        if (stopped) throw new Error('full verification stopped while waiting for active runs to settle')
        const busy = supervisor.busy()
        if (!busy.length) break
        if (JSON.stringify(busy) !== JSON.stringify(record.waitingOn)) { record.waitingOn = busy; await write(record) }
        await wait(pollMs)
      }
      record.waitingOn = []
      record.seatsIdleAt = clock.iso()
      record.state = 'running'
      record.startedAt = clock.iso()
      // The stages come from the inputs the scope was decided from (startCycle), never a later reading.
      const infras = new Map()
      for (const id of inputs.projects) {
        const infra = inputs.infras.get(id)
        if (!infra?.error) infras.set(id, infra)
        record.projects.push(infra?.error ? { project: id, stage: null, verdict: 'red', refusal: { code: 'INFRASTRUCTURE_INVALID', message: infra.error } } : stageOf(id, infra))
      }
      // A host with dynamic instances is protected whole: no project's entry releases there.
      const protectedOnes = protectedHosts(infras)
      if (protectedOnes.size) record.protectedHosts = Object.fromEntries(protectedOnes)
      const drivable = (e) => e.stage && !e.verifiedThrough && !e.verdict
      // A framework one of whose pool instances is driven in this cycle waits for them: its entry may be derived from
      // theirs (deriveEntry). Unreadable projects' configuration: nothing is deferred, everything is driven as before.
      const config = inputs.config
      const pools = new Map()
      if (config) {
        for (const entry of record.projects.filter(drivable)) {
          const instances = poolMembers(entry.project, config).slice(1).filter((id) => record.projects.some((e) => e.project === id && drivable(e)))
          if (!config.get(entry.project)?.framework && instances.length) {
            Object.assign(entry, { state: 'deferred', derivation: { state: 'pending', instances } })
            pools.set(entry.project, instances)
          }
        }
      }
      // The scope gate: a stage the frozen reading left out of the scope is never started in this cycle, whatever the
      // configuration says later; it is refused with the reason that reading gave (TARGET_MISSING), else as outside the freeze.
      const inScope = new Set(record.scope?.projects ?? [])
      const refusalOf = (entry) => hostRefusal(entry, protectedOnes) ?? (entry.mode === 'instance' && !infras.get(entry.project)?.testDrive?.modules?.instance?.fullSuite
        ? { code: 'FULL_SUITE_UNDECLARED', message: `${entry.project} runs on dynamic stage instances but declares no testDrive.modules.instance.fullSuite: the whole suite has no instance command, and the base instance is never used instead` }
        : null) ?? (record.scope && !inScope.has(entry.project)
        ? (entry.mode !== 'instance' && targetMissing(infras.get(entry.project))
            ? { code: 'TARGET_MISSING', message: `${TARGET_MISSING} (staging): read when the cycle froze, so this stage stays out of this cycle whatever the configuration says now` }
            : { code: 'OUTSIDE_FREEZE_SCOPE', message: `${entry.project} was not in this cycle's scope when it froze, so its stage is not started in this cycle` })
        : null)
      for (const entry of record.projects.filter((e) => drivable(e) && e.state !== 'deferred')) {
        const refusal = refusalOf(entry)
        if (refusal) Object.assign(entry, { state: 'refused', verdict: 'red', refusal, coverageEstablished: false })
      }
      await write(record)
      const runOne = (entry) => entry.mode === 'instance' ? runInstanceStage(record, entry, infras.get(entry.project)) : runStage(record, entry, protectedOnes)
      const hosts = new Map()
      for (const entry of record.projects.filter((e) => drivable(e) && e.state !== 'deferred')) hosts.set(entry.host, [...(hosts.get(entry.host) ?? []), entry])
      // One stage at a time per staging host; hosts side by side (drive slots and instance slots still decide each drive).
      await Promise.all([...hosts.values()].map(async (entries) => {
        for (const entry of entries) await runOne(entry)
      }))
      // Then each deferred framework: derived from the instance entries whose snapshot materialized its checkout, or,
      // when none did, refused or driven exactly as it would have been.
      for (const [framework, instances] of [...pools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const entry = record.projects.find((e) => e.project === framework)
        const dir = await Promise.resolve().then(() => projectPathOf(framework)).catch(() => null)
        const checkouts = dir ? [dir, await fs.realpath(dir).catch(() => dir)] : []
        const sources = record.projects.filter((e) => instances.includes(e.project) && (e.snapshot?.links ?? []).some((l) => checkouts.includes(l.owner)))
        if (sources.length) { await deriveEntry(record, entry, sources, checkouts); continue }
        delete entry.state
        entry.derivation = { state: 'not-derived', instances, reason: `no instance entry of this cycle has a snapshot that materializes ${framework}'s checkout, so it is driven itself` }
        const refusal = refusalOf(entry)
        if (refusal) { Object.assign(entry, { state: 'refused', verdict: 'red', refusal, coverageEstablished: false }); await write(record); continue }
        await runOne(entry)
      }
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
      await resumeFrozen(record, { scope: record.scope?.projects ?? null }).catch((error) => { record.error ??= `resuming: ${error.message}` })
      activeInputs = null
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
        bump: record.outcome?.bump ? { chain: record.outcome.bump.chain.map((s) => ({ project: s.project, args: s.args, status: s.status, versionAfter: s.versionAfter ?? null, afterCommit: s.afterCommit?.state ?? null })), failed: record.outcome.bump.failed ?? null } : null,
        // A green cycle commits only what it tested: false when a pool's checkpoints were withheld, a step failed or none ran.
        committed: record.outcome?.committed === true,
        withheld: (record.outcome?.bump?.withheld ?? []).map((w) => ({ framework: w.framework, members: w.members, moved: w.moved })),
        untestedCommitted: record.outcome?.bump?.untestedCommitted ?? [],
        issues: (record.outcome?.issues ?? []).map((i) => ({ project: i.project, issueId: i.issueId, name: i.name })),
        reason: record.outcome?.reason ?? null,
        flaky: (record.outcome?.flaky ?? []).map((i) => ({ project: i.project, issueId: i.issueId, noted: i.noted === true }))
      },
      projects: record.projects.map((e) => ({
        project: e.project, stage: e.stage ?? null, mode: e.mode ?? null, verdict: e.verdict ?? null, refusal: e.refusal?.code ?? null, incomplete: e.incomplete?.reason ?? null,
        instance: e.instance?.name ?? null, evidence: e.evidence?.dir ?? e.runDir ?? null, coverageEstablished: e.coverageEstablished === true,
        flaky: (e.flaky ?? []).map((f) => ({ command: f.command, test: f.test })), rerun: e.rerun ? { state: e.rerun.state, reason: e.rerun.reason ?? e.rerun.outcome ?? null } : null,
        snapshotDuringEdits: e.snapshotDuringEdits ?? null,
        ...(e.snapshotDuringEdits ? { movingPaths: movingPaths(e.snapshotMotion), newestChangeAt: e.snapshotMotion?.newest?.at ?? null } : {}),
        recheck: e.recheck?.state ?? null,
        commitWithheld: Boolean(e.commitWithheld),
        // A framework entry derived from instance entries of this cycle (deriveEntry): which, and which of them were not green.
        derived: e.derived ? { from: e.derived.from.map((f) => f.project), red: e.derived.red.map((r) => ({ project: r.project, reason: r.reason })), unmaterialized: e.derived.unmaterialized?.total ?? 0 } : null,
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

  /**
   * Whether the checkouts were moving around the snapshot (AC: snapshotDuringEdits): the newest change among the
   * changed paths, those changed within the window before it, those that differ between the two readings. A reading
   * that failed leaves it unknown (null). No verdict reads it.
   */
  function noteMotion (entry, before, after, extra = {}) {
    if (!before || before.error || !after || after.error) {
      entry.snapshotMotion = { error: before?.error ?? after?.error ?? 'no reading after the snapshot', ...extra }
      entry.snapshotDuringEdits = null
      return
    }
    entry.snapshotMotion = { ...motionOf({ before, after, windowMs: motionWindowMs }), ...extra }
    entry.snapshotDuringEdits = entry.snapshotMotion.moving
  }

  /** An entry's snapshot as the record keeps it, with where it lives so a later comparison needs nothing from memory. */
  const snapshotOf = async ({ workspace, policy, projectDir }) => ({
    baseCommit: workspace.baseCommit ?? null, base: workspace.base ?? null,
    ...(workspace.baseCommit ? await Promise.resolve().then(() => recordSnapshot({ workspace, policy, projectDir })).catch((error) => ({ recordError: error.message })) : {})
  })

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
      // Always the tree as it stands, uncommitted deliveries included, whatever base the project's runs take (`head`, a commit).
      const policy = { ...(resolved.workspace ?? {}), base: 'working-tree', requireCleanBase: false, selection: resolved.fence?.selection ?? 0, repository: resolved.fence?.repository ?? 0, store: gitStoreDir(entry.project), nested: hostSettings().nestedRepositories }
      // A reading of the checkouts the snapshot reads, just before and just after it: was somebody editing them?
      const before = await readMotion({ projectDir, policy }).catch((error) => ({ error: error.message }))
      // The candidate: the development checkout as it stands now, as a run's working-tree base takes it.
      workspace = await provision({ projectPath: projectDir, runId: driveId, root: home, clock, policy })
      const after = await readMotion({ projectDir, policy, extra: (workspace.symlinks?.owners ?? []).map((o) => o.owner?.path).filter(Boolean) }).catch((error) => ({ error: error.message }))
      noteMotion(entry, before, after)
      Object.assign(entry, { workspace: { path: workspace.path, repository: workspace.repository ?? null }, snapshot: await snapshotOf({ workspace, policy, projectDir }), snapshotAt: clock.iso(), state: 'running' })
      snapshotInputs.set(entry.project, { projectDir, policy, root: home, runId: driveId })
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
      await writeJson(path.join(home, 'drive.json'), { driveId, cycleId: record.id, project: entry.project, fullVerification: { check } })
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
        if (entry.rerun?.state === 'ran') await writeJson(path.join(home, 'drive.json'), { driveId, cycleId: record.id, project: entry.project, fullVerification: { check, rerun: entry.rerun } })
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
    // What the freeze decided this stage is, before this function marks it a release.
    const frozen = { host: entry.host, stage: entry.stage, mode: entry.mode ?? 'release' }
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
      // The run takes its snapshot as it provisions: the readings go around that (before the start, and at the first
      // poll that shows its workspace), with the policy the run's provisioning uses (launch.mjs provisionRun).
      const resolved = resolution.resolved
      const policy = { ...(resolved.workspace ?? {}), selection: resolved.fence?.selection ?? 0, repository: resolved.fence?.repository ?? 0, store: gitStoreDir(entry.project), nested: hostSettings().nestedRepositories }
      const projectDir = await Promise.resolve().then(() => projectPathOf(entry.project)).catch(() => null)
      const before = projectDir ? await readMotion({ projectDir, policy }).catch((error) => ({ error: error.message })) : { error: 'the project checkout could not be named' }
      let after = null
      // The last step before the start, after every awaited reading: the target and a fresh, complete protected-host read.
      await releaseGuard(entry, frozen, resolution.resolved, hosts)
      const started = await supervisor.start({ project: entry.project, issueId: home.id, playbookId: 'deployment', expectConfigHash: resolution.resolved.configHash, runOptions, configRoot, cycle: record.id })
      Object.assign(entry, { runId: started.runId, runDir: path.join(home.path, 'runs', started.runId), state: 'running', startedAt: clock.iso() })
      await write(record)
      let run = null
      let readFailures = 0
      for (;;) {
        if (stopped) throw new Error('full verification stopped while waiting for stage run')
        run = await readRun(home.path, started.runId).catch(() => null)
        if (!run) {
          if (++readFailures >= 30 && !supervisor.isActive(entry.project, home.id)) throw new Error(`stage run ${started.runId} record could not be read`)
        } else {
          readFailures = 0
        }
        if (run?.workspace && !after && projectDir && !before.error) after = await readMotion({ projectDir, policy, extra: (run.workspace.symlinks?.owners ?? []).map((o) => o.owner?.path).filter(Boolean) }).catch((error) => ({ error: error.message }))
        if (run && !LIVE.includes(run.status) && !supervisor.isActive(entry.project, home.id)) break
        await wait(pollMs)
      }
      noteMotion(entry, before, after ?? { error: 'the run recorded no workspace, so there is no reading after its snapshot' }, { basis: 'around-run-provisioning' })
      if (run.workspace?.baseCommit && projectDir) {
        entry.snapshot = await snapshotOf({ workspace: run.workspace, policy, projectDir })
        snapshotInputs.set(entry.project, { projectDir, policy, root: path.join(verificationDir, record.date, record.id, entry.project), runId: driveIdOf(record.id, entry.project) })
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

  /**
   * Before a release starts: the staging target the Deployment run is bound to (its resolved configuration, pinned by
   * expectConfigHash) must be the one the freeze decided (STAGE_DRIFTED otherwise), and a fresh, complete reading of
   * every project must show its host unprotected; a reading that cannot establish that declines it (STAGE_UNVERIFIABLE).
   * The hash binds the resolved configuration only, not where an installed release script sends what it releases.
   */
  async function releaseGuard (entry, frozen, resolved, hosts) {
    const actual = stageOf(entry.project, resolved.infrastructure ?? null)
    if (actual.verifiedThrough || actual.host !== frozen.host || actual.stage !== frozen.stage || (actual.mode ?? 'release') !== frozen.mode) {
      throw Object.assign(new Error(`the staging target changed since the freeze (${frozen.stage} on ${frozen.host} → ${actual.verifiedThrough ? `verified through its instances: ${actual.reason}` : `${actual.stage} on ${actual.host}`}); not released, the next cycle reads the new configuration`), { code: 'STAGE_DRIFTED' })
    }
    const unverifiable = (why) => Object.assign(new Error(`whether ${frozen.host} has dynamic stage instances cannot be established: ${why}; not released`), { code: 'STAGE_UNVERIFIABLE' })
    let fresh
    try { fresh = await cycleInputs() } catch (error) { throw unverifiable(`the configuration could not be read (${error.message})`) }
    if (fresh.unreadable?.length) throw unverifiable(`could not read ${fresh.unreadable.map((u) => `${u.path ?? '?'} (${u.code ?? 'error'})`).join(', ')}`)
    const broken = [...fresh.infras].filter(([, infra]) => infra?.error)
    if (broken.length) throw unverifiable(`the configuration of ${broken.map(([id]) => id).join(', ')} is invalid`)
    const now = new Map(hosts)
    for (const [host, projects] of protectedHosts(fresh.infras)) now.set(host, [...new Set([...(now.get(host) ?? []), ...projects])])
    const refusal = hostRefusal(entry, now)
    if (refusal) throw Object.assign(new Error(refusal.message), { code: refusal.code })
  }

  /**
   * A framework entry derived from the instance entries whose snapshots materialized its checkout (`sources`): no
   * resolve, snapshot, instance, drive or run home of its own. Its verdict is derivedVerdict's; its deliveries are read
   * through the instances' copies of its checkout (viewReader), a path no copy held leaving a delivery indeterminate
   * (`not-materialized`). It has no snapshot, so its recheck reads no-snapshot and its commits are compared with the
   * instances' copies; otherwise it takes part in judging, the checkpoint chain and the red issues as a driven entry does.
   */
  async function deriveEntry (record, entry, sources, checkouts) {
    Object.assign(entry, { mode: 'derived', state: 'deriving', startedAt: clock.iso() })
    delete entry.derivation
    await write(record).catch(() => {})
    const { verdict, red } = derivedVerdict(sources)
    try {
      const snapshotAt = sources.map((s) => s.snapshotAt).filter(Boolean).sort()[0] ?? null
      const views = [...new Set(checkouts)].flatMap((checkout) => testedViews(checkout, entry.project, sources))
      const counting = (await deliveryCounts({ stages: [{ host: entry.host, stage: entry.stage, projects: [entry.project] }], deliveriesOf, records: await cycleRecords(verificationDir), threshold: 0 }).catch(() => [{ runs: null }]))[0].runs
      const coverage = pick(await Promise.resolve().then(() => coverageOf({ project: entry.project, projectPath: checkouts[0] ?? null, snapshotAt, candidates: counting?.map((r) => r.runId) ?? null, views }))
        .catch((error) => ({ error: error.message })))
      const unmaterialized = [...new Set((coverage?.indeterminate ?? []).filter((c) => c.reason === NOT_MATERIALIZED).flatMap((c) => c.paths ?? []))]
      Object.assign(entry, {
        state: 'settled',
        derived: {
          rule: 'green only when every instance entry it is derived from is green, settled, ran its whole suite and established coverage',
          from: sources.map((s) => ({ project: s.project, stage: s.stage ?? null, host: s.host ?? null, mode: s.mode ?? null, verdict: s.verdict ?? null, state: s.state ?? null, suiteRan: Boolean(s.suiteRan), coverageEstablished: s.coverageEstablished === true,
            driveId: s.driveId ?? null, runId: s.runId ?? null, evidence: s.evidence?.dir ?? s.runDir ?? null, links: (s.snapshot?.links ?? []).filter((l) => views.some((v) => v.at === l.path)).map((l) => ({ path: l.path, prefix: l.prefix })) })),
          red,
          unmaterialized: { paths: unmaterialized.slice(0, SHOWN_PATHS), total: unmaterialized.length }
        },
        verdict,
        snapshotAt,
        coverage,
        suiteRan: sources.every((s) => Boolean(s.suiteRan)),
        coverageEstablished: sources.every((s) => s.coverageEstablished === true) && Boolean(coverage) && !coverage.error
      })
    } catch (error) {
      Object.assign(entry, { state: 'refused', verdict: 'red', refusal: { code: 'DERIVATION_FAILED', message: error.message }, coverageEstablished: false })
    }
    entry.endedAt = clock.iso()
    entry.durationMs = Math.max(0, Date.parse(entry.endedAt) - Date.parse(entry.startedAt))
    await write(record)
  }

  // ------------------------------------------------------------ the outcome

  /** Bump or open issues, by the verdict; recorded as `record.outcome`. Never throws. */
  async function outcome (record) {
    record.state = 'outcome'
    record.outcome = { verdict: record.verdict, committed: false, startedAt: clock.iso(), endedAt: null }
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
    const result = { chain: [], failed: null, notRun: [], versions: {}, withheld: [], untestedCommitted: [] }
    record.outcome.bump = result
    const projects = activeInputs?.config ?? await projectsConfig()
    const named = [...new Set([...projects.values()].map((p) => p.framework).filter((id) => id && projects.has(id)))].sort()
    // Only a pool the cycle verified is checkpointed: every member in its scope, which holds a pool only when one of its
    // members has a stage this cycle drives (cycleScope); any other pool is outside the freeze and never reaches the action.
    const scope = record.scope ? new Set(record.scope.projects) : null
    const frameworks = scope ? named.filter((f) => poolMembers(f, projects).every((m) => scope.has(m))) : named
    for (const framework of named.filter((f) => !frameworks.includes(f))) result.notVerified = [...(result.notVerified ?? []), { framework, members: poolMembers(framework, projects), reason: 'no member of this pool has a stage this cycle drives, so it is outside the freeze and not checkpointed' }]
    const allSteps = frameworks.flatMap((framework) => poolMembers(framework, projects).map((project, i) => ({ project, framework, args: i === 0 ? ['--minor'] : [] })))
    if (!allSteps.length) { result.reason = named.length ? 'no pool this cycle verified names a framework, so there is nothing to bump' : 'no project names a framework (framework: in projects/<id>.yaml), so there is nothing to bump'; return }
    // Before any checkpoint: every green entry's checkouts snapshotted again and compared with what it tested.
    const green = record.projects.filter((e) => !e.verifiedThrough && e.verdict === 'green')
    for (const entry of green) await recheck(record, entry)
    await write(record).catch(() => {})
    const checkoutOf = async (project) => {
      const dir = await Promise.resolve().then(() => projectPathOf(project)).catch(() => null)
      return dir ? fs.realpath(dir).catch(() => dir) : null
    }
    const moved = green.filter((e) => ['moved', 'failed'].includes(e.recheck?.state))
    const withheld = new Set()
    for (const framework of frameworks) {
      const members = poolMembers(framework, projects)
      const memberCheckouts = (await Promise.all(members.map(checkoutOf))).filter(Boolean)
      // An entry concerns the pool when it is a member's, or its snapshot read a member's checkout (a framework linked in).
      const concerned = moved.filter((e) => members.includes(e.project) || (e.recheck.checkouts ?? []).some((c) => memberCheckouts.includes(c)))
      if (!concerned.length) continue
      withheld.add(framework)
      result.withheld.push({ framework, members, moved: concerned.map((e) => ({ project: e.project, state: e.recheck.state, ...(e.recheck.error ? { error: e.recheck.error } : {}), checkouts: e.recheck.moved ?? [] })) })
      for (const e of record.projects.filter((x) => members.includes(x.project) && !x.verifiedThrough)) {
        e.commitWithheld = { framework, at: clock.iso() }
        // AC3: a withheld cycle retires only the deliveries whose bytes the tested snapshot held (staging-coverage.mjs covered).
        if (e.coverage) e.coverage.retires = { rule: 'covered-only', reason: 'commit withheld: only the deliveries whose bytes the tested snapshot held are retired; the indeterminate ones keep counting', runIds: (e.coverage.covered ?? []).map((c) => c.runId) }
      }
    }
    const steps = allSteps.filter((s) => !withheld.has(s.framework))
    for (const [i, s] of steps.entries()) {
      const checkout = await checkoutOf(s.project)
      const step = { project: s.project, framework: s.framework, action: 'checkpoint', args: s.args, status: 'running', versionBefore: await versionOf(s.project).catch(() => null), headBefore: checkout ? await headOf(checkout).catch(() => null) : null, startedAt: clock.iso() }
      result.chain.push(step)
      await write(record).catch(() => {})
      try {
        const operation = await runAction({ project: s.project, actionId: 'checkpoint', args: s.args })
        Object.assign(step, { operationId: operation?.id ?? null, status: operation?.status ?? 'failed', exitCode: operation?.exitCode ?? null })
        if (step.status !== 'completed') step.reason = operation?.error ?? (operation?.timedOut ? 'the action reached its deadline' : `the action ended ${step.status}${step.exitCode != null ? ` with exit code ${step.exitCode}` : ''}`)
      } catch (error) {
        Object.assign(step, { status: 'refused', reason: error.message, code: error.status ?? null })
      } finally {
        step.versionAfter = await versionOf(s.project).catch(() => null)
        // However the attempt ended: what it committed, against what was tested (approach (a)); reported, never reverted.
        await afterCommit(record, step, checkout)
      }
      step.endedAt = clock.iso()
      if (step.status !== 'completed') {
        result.failed = { project: s.project, reason: step.reason }
        result.notRun = steps.slice(i + 1).map((n) => ({ project: n.project, framework: n.framework, args: n.args }))
        break
      }
      if (step.versionAfter === step.versionBefore) step.unchanged = true
      result.versions[s.project] = step.versionAfter
    }
    record.outcome.committed = !withheld.size && result.chain.length > 0 && result.chain.length === steps.length && result.chain.every((s) => s.status === 'completed')
    if (withheld.size) record.outcome.commitWithheld = true
  }

  /**
   * The entry's checkouts snapshotted again with the policy that took its snapshot (a ref of its own, removed after)
   * and compared: the same commit, else the same tree, else the changed paths by the checkout owning them. A recheck
   * that cannot be made counts as moved (failed). An entry that took no snapshot has nothing to compare (no-snapshot).
   */
  async function recheck (record, entry) {
    const input = snapshotInputs.get(entry.project)
    const at = clock.iso()
    if (!entry.snapshot?.baseCommit) { entry.recheck = { at, state: 'no-snapshot', reason: 'the entry recorded no snapshot of its own; its commits are still compared with every tested view' }; return }
    if (!input) { entry.recheck = { at, state: 'failed', error: 'how the snapshot was taken is not known in this process' }; return }
    const checkouts = await Promise.all(checkoutsOf(input.projectDir, entry.snapshot).map((c) => fs.realpath(c).catch(() => c)))
    let workspace = null
    const runId = `${input.runId}-recheck`
    try {
      await fs.mkdir(input.root, { recursive: true })
      workspace = await provision({ projectPath: input.projectDir, runId, root: input.root, clock, policy: input.policy })
      if (workspace.baseCommit === entry.snapshot.baseCommit) entry.recheck = { at, state: 'unchanged', commit: workspace.baseCommit, checkouts }
      else {
        const diff = await compareSnapshots({ repository: entry.snapshot.repository, from: entry.snapshot.baseCommit, to: workspace.baseCommit, projectDir: input.projectDir, links: entry.snapshot.links ?? [] })
        entry.recheck = diff.sameTree ? { at, state: 'unchanged', headMoved: true, commit: workspace.baseCommit, checkouts } : { at, state: 'moved', commit: workspace.baseCommit, checkouts, moved: diff.moved }
      }
    } catch (error) {
      entry.recheck = { at, state: 'failed', error: error.message, checkouts }
    } finally {
      if (workspace) await Promise.resolve().then(() => releaseWorkspace({ ...workspace, projectPath: input.projectDir })).catch(() => {})
      if (workspace && entry.snapshot.repository) await forgetRef(entry.snapshot.repository, `refs/devpanel/base/${runId}`)
    }
  }

  /**
   * A checkpoint attempt's commit compared with every tested view of its checkout (runtime/full-verification-snapshot.mjs
   * committedBeyond): untested paths are recorded on the step and in outcome.bump.untestedCommitted. A HEAD that cannot
   * be read is recorded as such and counted, never taken as clean.
   */
  async function afterCommit (record, step, checkout, { observedBy = null } = {}) {
    const by = observedBy ? { observedBy } : {}
    try {
      if (!checkout) throw new Error('the project checkout could not be named')
      const head = await headOf(checkout)
      if (step.headBefore && head === step.headBefore) { step.afterCommit = { state: 'no-commit', ...by }; return }
      step.afterCommit = { ...await compareCommit({ checkout, commit: head, headBefore: step.headBefore ?? null, views: [...testedViews(checkout, step.project, record.projects), ...followedViews(checkout, step.project, record.projects)], versionBefore: step.versionBefore ?? null, versionAfter: step.versionAfter ?? null }), ...by }
    } catch (error) {
      step.afterCommit = { state: 'unreadable', error: error.message, ...by }
    }
    const a = step.afterCommit
    if (a.state === 'unreadable' || a.state === 'incomparable' || (a.state === 'compared' && a.untested.total)) {
      const bumpRecord = record.outcome?.bump
      if (bumpRecord) {
        bumpRecord.untestedCommitted = [...(bumpRecord.untestedCommitted ?? []).filter((u) => u.project !== step.project),
          { project: step.project, state: a.state, commit: a.commit ?? null, paths: a.untested?.paths ?? [], total: a.untested?.total ?? null, ...(a.error ? { error: a.error } : {}) }]
      }
    }
  }

  /** An entry's failing tests with their excerpts: after a rerun only the tests that failed again (or whose rerun proved nothing); the flaky ones are named apart. */
  async function failuresOf (entry) {
    const failing = entry.rerun?.state === 'ran'
      ? entry.rerun.tests.filter((t) => t.rerun !== 'passed').map((t) => ({ command: t.command, test: t.test, basis: t.rerun === 'failed' ? 'failed-twice' : 'not-observed',
        message: t.rerun === 'failed' ? `Failed in the whole suite and again alone on the same instance (rerun in ${t.dir}).` : `Failed in the whole suite; its rerun alone proved nothing: ${t.why} (rerun in ${t.dir}).` }))
      : entry.check?.failingTests ?? []
    const out = []
    for (const f of failing) out.push({ ...f, excerpt: await excerptOf({ runDir: entry.runDir, dir: entry.check.dir, command: f.command, test: f.test, commands: entry.check.failedCommands ?? [] }) })
    return out
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
        // A derived entry's failures are those of the instance entries it is derived from that are not green, each named with its entry.
        const sources = entry.derived ? record.projects.filter((e) => entry.derived.red.some((r) => r.project === e.project)) : [entry]
        const failures = []
        for (const source of sources) failures.push(...(await failuresOf(source)).map((f) => (entry.derived ? { ...f, from: { project: source.project, driveId: source.driveId ?? null, runId: source.runId ?? null } } : f)))
        const unread = sources.flatMap((source) => (source.check?.unread ?? []).map((u) => (entry.derived ? { ...u, command: `${source.project}: ${u.command}` } : u)))
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
  /**
   * Resume the runs paused as full-verification. At a cycle's end (`scope`) only those of its scope: a pause of a
   * project outside it, left by an earlier cycle, is named in `leftPaused` and left to recover() at the next start or
   * to an operator's resume. Without a scope (recover()), every such pause, as before.
   */
  async function resumeFrozen (record, { scope = null } = {}) {
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
        if (scope && !scope.includes(project)) { (record.leftPaused ??= []).push({ ...named, cycleId: run.pause.cycleId ?? null, reason: 'outside this cycle\'s scope' }); continue }
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
        // A framework entry waiting for its instances or being derived from them has no instance, workspace or run home.
        for (const entry of (record.projects ?? []).filter((e) => !e.driveId && ['deferred', 'deriving'].includes(e.state))) {
          Object.assign(entry, { state: 'interrupted', verdict: 'red', coverageEstablished: false })
        }
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
        // A checkpoint the stop interrupted may have committed: what it committed is compared now, as after any attempt.
        for (const step of (record.outcome?.bump?.chain ?? []).filter((s) => s.status === 'running')) {
          Object.assign(step, { status: 'interrupted', reason: 'the service stopped while the action ran', versionAfter: await versionOf(step.project).catch(() => null), endedAt: clock.iso() })
          const dir = await Promise.resolve().then(() => projectPathOf(step.project)).catch(() => null)
          await afterCommit(record, step, dir ? await fs.realpath(dir).catch(() => dir) : null, { observedBy: 'recovery' })
          record.outcome.committed = false
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
        cycle: running ? current : await latestRecord({ strict: true })
      }
    },
    /** For tests: the cycle in progress settles. */
    settle: () => Promise.resolve(running)
  }
}
