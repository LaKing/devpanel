import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents, runDir } from '../server/runtime/store.mjs'
import { modulesErrors, modulesTarget } from '../server/infrastructure.mjs'
import { failedModuleTests, failedModulesWords, gateReason, gatingResult, inconclusiveBase } from '../server/runtime/baseline-failures.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { checkSummary } from '../server/runtime/check-summary.mjs'
import { affectedModules, affectedModulesNotice, changedModules, countsForClosure, exitedOnItsOwn, failedFilters, failedInTests, lintFiles, moduleChecksums, moduleOf, modulesDrive, modulesSelftestFailures, revisionFiles } from '../server/runtime/modules-tier.mjs'
import { fingerprint, workspaceProjection } from '../server/runtime/fingerprint.mjs'

export const name = 'modules tier — module mapping, the union with the triage list, unlisted, checksums and changed modules, the drive\'s order, its recording, no base drive, and the coding playbooks\' default'

const sh = promisify(execFile)
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const entry = (p, status, contentHash = `sha256:${p}`, mode = '100644') => ({ path: p, status, mode, contentHash: status === 'deleted' ? null : contentHash })
const COLLECTIONS = ['@*', '*-modules']
const declared = (extra = {}) => ({
  collections: ['@*'],
  lint: { id: 'lint', run: 'lint-it {{files}}' },
  load: { id: 'load', run: 'load-it' },
  restart: { id: 'restart', run: 'restart-it' },
  ready: { id: 'ready', run: 'ready-it' },
  test: { id: 'module-selftest', run: 'selftest-it {{filter}}', report: 'selftest' },
  ...extra
})

/*
 * An Implementation run whose playbook target is a modules tier of `kind: local`
 * (the engine expands it the same way whatever the kind). The worker adds a
 * module file and a core file each round; `onAudit` sees each auditor prompt.
 */
async function scenario ({ target, sizing = null, onAudit = null, extra = null }) {
  const state = { engine: null, prompts: [], authorPrompts: [] }
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      state.authorPrompts.push({ round, prompt })
      const ws = state.engine.run.workspace.path
      await fs.mkdir(path.join(ws, '@c/a'), { recursive: true })
      await fs.mkdir(path.join(ws, 'lib'), { recursive: true })
      await fs.writeFile(path.join(ws, '@c/a/x.mjs'), `export const round = ${round}\n`)
      await fs.writeFile(path.join(ws, 'lib/core.mjs'), 'export {}\n')
      await fs.writeFile(path.join(ws, `round-${round}.txt`), 'work\n')
      await extra?.(ws)
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      state.prompts.push({ role, round, prompt })
      await onAudit?.(round, state)
      return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement: 'required', target })}\n`)
  if (sizing) {
    const file = path.join(f.issuePath, 'issue.json')
    const meta = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...meta, sizing }, null, 2) + '\n')
  }
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, events, f, prompts: state.prompts, authorPrompts: state.authorPrompts }
}

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  try {
    t.section('module mapping: <collection>/<module>/ for a declared collection, every other path core')
    t.eq('a file in a module', moduleOf('@boilerplate/documentation/changelog.txt', COLLECTIONS), '@boilerplate/documentation')
    t.eq('a wildcard collection', moduleOf('app-modules/shop/index.mjs', COLLECTIONS), 'app-modules/shop')
    t.eq('deeper files are the same module', moduleOf('@c/a/b/c/d.mjs', COLLECTIONS), '@c/a')
    t.eq('a file directly in a collection is core', moduleOf('@c/README.md', COLLECTIONS), null)
    t.eq('an undeclared top-level directory is core', moduleOf('runtime/lib/x.mjs', COLLECTIONS), null)
    t.eq('a root file is core', moduleOf('package.json', COLLECTIONS), null)

    t.section('affected modules: the triage list ∪ the modules of the changed paths; unlisted, core (the root too), notInTree')
    {
      const entries = [
        entry('@c/a/x.mjs', 'modified'), entry('@c/b/y.vue', 'added'), entry('@c/z/unchanged.mjs', 'unchanged'),
        entry('x-modules/m/f.txt', 'deleted'), entry('lib/core.mjs', 'modified'), entry('README.md', 'modified')
      ]
      const checksums = moduleChecksums(revisionFiles(entries), COLLECTIONS)
      const a = affectedModules({ triage: ['@c/a', '@c/listed/'], entries, collections: COLLECTIONS, checksums })
      t.eq('the modules of the changed paths, a deletion included', a.fromPaths, ['@c/a', '@c/b', 'x-modules/m'])
      t.eq('the union with the triage list', a.modules, ['@c/a', '@c/b', '@c/listed', 'x-modules/m'])
      t.eq('changed modules the triage did not list are unlisted', a.unlisted, ['@c/b', 'x-modules/m'])
      t.eq('a listed module the tree does not hold is recorded, not dropped', a.notInTree, ['@c/listed'])
      t.eq('core: the directories of the changed non-module paths, the root as .', a.core, { paths: 2, dirs: ['.', 'lib'] })
      t.eq('an unchanged module is not affected', a.modules.includes('@c/z'), false)
      t.eq('lint gets the changed .mjs/.vue files that still exist', lintFiles(entries), ['@c/a/x.mjs', '@c/b/y.vue', 'lib/core.mjs'])
      const none = affectedModules({ triage: [], entries: [entry('@c/a/x.mjs', 'modified')], collections: COLLECTIONS, checksums })
      t.eq('with no triage list every changed module is unlisted and there is no core', [none.unlisted, none.core], [['@c/a'], null])
      t.ok('the auditor is told the unlisted modules, and that nothing is refused', /did not list: "@c\/b", "x-modules\/m".*refuses nothing/.test(affectedModulesNotice({ fingerprint: 'sha256:x', modules: { changed: ['@c/a'] }, affectedModules: a })))
    }

    t.section('checksums: per module over path, mode and content; changed is checksum inequality')
    {
      const base = [entry('@c/a/x.mjs', 'unchanged', 'sha256:1'), entry('@c/a/y.mjs', 'unchanged', 'sha256:2'), entry('@c/b/z.mjs', 'unchanged', 'sha256:3'), entry('lib/core.mjs', 'unchanged', 'sha256:4')]
      const sums = moduleChecksums(revisionFiles(base), COLLECTIONS)
      t.eq('one checksum per module, none for core', Object.keys(sums), ['@c/a', '@c/b'])
      t.ok('a sha256', /^sha256:[a-f0-9]{64}$/.test(sums['@c/a']))
      t.eq('the order of entries does not matter', moduleChecksums(revisionFiles([...base].reverse()), COLLECTIONS), sums)
      const edit = (i, change) => base.map((e, j) => j === i ? { ...e, ...change } : e)
      t.eq('a content change changes only its module', changedModules(sums, moduleChecksums(revisionFiles(edit(0, { contentHash: 'sha256:9' })), COLLECTIONS)), ['@c/a'])
      t.eq('a mode-only change counts', changedModules(sums, moduleChecksums(revisionFiles(edit(2, { mode: '100755' })), COLLECTIONS)), ['@c/b'])
      t.eq('an added file counts', changedModules(sums, moduleChecksums(revisionFiles([...base, entry('@c/b/new.mjs', 'added')]), COLLECTIONS)), ['@c/b'])
      t.eq('a deleted file counts', changedModules(sums, moduleChecksums(revisionFiles(edit(1, { status: 'deleted', contentHash: null })), COLLECTIONS)), ['@c/a'])
      t.eq('a new module and a removed one count', changedModules(sums, moduleChecksums(revisionFiles([...base.slice(0, 2), entry('@c/n/a.mjs', 'added')]), COLLECTIONS)), ['@c/b', '@c/n'])
      t.eq('a core change changes no module', changedModules(sums, moduleChecksums(revisionFiles(edit(3, { contentHash: 'sha256:8' })), COLLECTIONS)), [])
    }

    t.section('the drive: lint, load, restart, ready, a test per module then per core directory, browser runs, finalizers')
    {
      const affected = { modules: ['@c/a', '@c/b'], core: { paths: 2, dirs: ['.', 'lib'] } }
      const target = { kind: 'ssh', tier: 'modules', modules: declared({ browser: { id: 'browser', run: 'browse-it {{filter}}' }, finallyCommands: [{ id: 'collect', run: 'collect-it' }] }), compareBaseline: true }
      const { target: drive, plan } = modulesDrive(target, { affected, files: ['@c/a/x.mjs', 'lib/core.mjs'] })
      t.eq('the order', drive.commands.map((c) => c.id), ['lint', 'load', 'restart', 'ready', 'module-selftest-1', 'module-selftest-2', 'module-selftest-3', 'module-selftest-4', 'browser-1', 'browser-2'])
      t.eq('the finalizers last', drive.finallyCommands.map((c) => c.id), ['collect'])
      t.eq('lint names each file as one quoted argument', drive.commands[0].run, "lint-it '@c/a/x.mjs' 'lib/core.mjs'")
      t.eq('each test its filter; the root gets the default filter', drive.commands.slice(4, 8).map((c) => c.run), ["selftest-it '@c/a'", "selftest-it '@c/b'", "selftest-it '.'", "selftest-it 'lib'"])
      t.eq('browser runs for the modules only', drive.commands.slice(8).map((c) => c.run), ["browse-it '@c/a'", "browse-it '@c/b'"])
      t.eq('the plan maps commands to modules and core', plan.tests.map((x) => [x.id, x.slot, x.module ?? `core:${x.core}`]), [['module-selftest-1', 'test', '@c/a'], ['module-selftest-2', 'test', '@c/b'], ['module-selftest-3', 'test', 'core:.'], ['module-selftest-4', 'test', 'core:lib'], ['browser-1', 'browser', '@c/a'], ['browser-2', 'browser', '@c/b']])
      t.eq('tier modules, no baseline', [drive.tier, drive.compareBaseline], ['modules', undefined])
      const rooted = modulesDrive({ ...target, modules: declared({ rootFilter: 'core' }) }, { affected: { modules: [], core: { paths: 1, dirs: ['.'] } }, files: [] })
      t.eq('a root change runs the declared root filter; no files, no lint', rooted.target.commands.map((c) => c.run), ['load-it', 'restart-it', 'ready-it', "selftest-it 'core'"])
      t.eq('and says why lint is absent', rooted.plan.lint, { files: [], skipped: 'no-changed-files' })
    }

    t.section('a hostile module path reaches the selftest CLI as one argument, runs nothing, and is never refused')
    {
      const dir = await temp('devpanel-modules-hostile-')
      const out = path.join(dir, 'args')
      const printer = path.join(dir, 'print')
      await fs.writeFile(printer, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done >> '${out}'\n`, { mode: 0o755 })
      // No separator in it: a module is one directory under its collection. The command runs in `dir`.
      const hostile = `@c/it's "a" $(touch pwned) \`touch pwned2\` $& b`
      const dashed = '-rf lib'
      const affected = affectedModules({ triage: [], entries: [entry(`${hostile}/x.mjs`, 'added'), entry(`${dashed}/y.txt`, 'added')], collections: ['@*'], checksums: {} })
      t.eq('the hostile module is affected', affected.modules, [hostile])
      const { target: drive, plan } = modulesDrive({ kind: 'local', tier: 'modules', modules: declared({ test: { id: 'module-selftest', run: `${printer} selftest {{filter}}` } }) }, { affected, files: [] })
      t.eq('every module and core directory has its command', plan.tests.length, 2)
      t.eq('a filter a program could read as an option is recorded, still run', plan.unusualFilters, [dashed])
      for (const c of drive.commands.filter((x) => x.id.startsWith('module-selftest-'))) await sh('/bin/sh', ['-c', c.run], { cwd: dir })
      const args = (await fs.readFile(out, 'utf8')).split('\0').filter(Boolean)
      t.eq('each filter arrived as exactly one argument, byte for byte', args, ['selftest', hostile, 'selftest', dashed])
      t.eq('nothing in it ran', [await fs.access(path.join(dir, 'pwned')).then(() => true, () => false), await fs.access(path.join(dir, 'pwned2')).then(() => true, () => false)], [false, false])
    }

    t.section('the issue page shows the latest revision\'s changed modules')
    {
      const view = await fs.readFile(new URL('../src/views/IssueView.vue', import.meta.url), 'utf8')
      t.ok('the Candidate block lists run.revisions.at(-1).modules.changed', /Changed modules<\/span>[^\n]*run\.revisions\.at\(-1\)\.modules\.changed/.test(view))
      t.ok('and the modules the triage did not list', /Not in the triage list<\/span>[^\n]*affectedModules\.unlisted/.test(view))
      const api = await fs.readFile(new URL('../server/runs-api.mjs', import.meta.url), 'utf8')
      t.ok('the run detail serves the revision records whole, modules included', /revisions: run\.revisions,/.test(api))
    }

    t.section('gating: no base, so a failing test blocks; a failed test in a passing report blocks too')
    {
      const run = { workspace: { baseCommit: 'b' } }
      const check = (result, modules = {}) => ({ tier: 'modules', result, commands: [{ id: 'module-selftest-1', required: true, passed: result === 'passed' }], modules: { selftestFailures: [], ...modules } })
      t.eq('a clean pass passes', gatingResult(check('passed'), run), 'passed')
      t.eq('a failed command fails, with no baseline-known path', gatingResult({ ...check('failed'), baselineComparison: { failures: { verdict: 'baseline-known', sourceRevision: 'b' } } }, run), 'failed')
      const failing = check('passed', { selftestFailures: [{ command: 'collect', test: '@c/a: works' }] })
      t.eq('a failed test named in the report fails the pass', gatingResult(failing, run), 'failed')
      t.ok('and says why', /names failed tests: collect: @c\/a: works.*no base/.test(gateReason(failing, run)), gateReason(failing, run))
      t.eq('an unreadable report fails it too', gatingResult(check('passed', { reportUnreadable: [{ command: 'collect', error: 'x' }] }), run), 'failed')
      t.eq('unavailable stays unavailable', gatingResult(check('unavailable'), run), 'unavailable')
      const shown = await modulesSelftestFailures({ runDir: os.tmpdir(), target: { commands: [], finallyCommands: [{ id: 'collect', report: 'selftest', required: false }] }, check: { result: 'passed', dir: 'x', commands: [{ id: 'collect', passed: false, required: false }] } })
      t.eq('a passing drive that showed no report is unreadable', [shown.failures, shown.unreadable.map((u) => u.error)], [[], ['no selftest report was read']])
      t.eq('and gates failed', gatingResult(check('passed', { reportUnreadable: shown.unreadable }), run), 'failed')
      t.ok('a modules record counts for closure, a smoke never', countsForClosure({ tier: 'modules' }) && countsForClosure({}) && !countsForClosure({ tier: 'smoke' }))
    }

    t.section('configuration: the modules tier\'s rules')
    {
      const target = (modules, extra = {}) => ({ kind: 'ssh', modules, ...extra })
      t.eq('a well-formed declaration has no errors', modulesErrors(target(declared())), [])
      t.ok('lint must take {{files}}', modulesErrors(target(declared({ lint: { id: 'lint', run: 'lint-it' } }))).some((e) => /modules.lint.run must hold \{\{files\}\} exactly once/.test(e)))
      t.ok('test must take {{filter}} as a word of its own', modulesErrors(target(declared({ test: { id: 'module-selftest', run: 'selftest-it x{{filter}}' } }))).some((e) => /modules.test.run/.test(e)))
      t.ok('test must name a program, not a shell', modulesErrors(target(declared({ test: { id: 'module-selftest', run: 'sh -c {{filter}}' } }))).some((e) => /modules.test.run/.test(e)))
      t.ok('ids are unique', modulesErrors(target(declared({ ready: { id: 'load', run: 'x' } }))).some((e) => /unique/.test(e)))
      t.ok('every command is required', modulesErrors(target(declared({ load: { id: 'load', run: 'x', required: false } }))).some((e) => /required/.test(e)))
      t.ok('not with tiers', modulesErrors(target(declared(), { tiers: { smoke: ['x'] } })).some((e) => /tiers/.test(e)))
      t.ok('not with a baseline', modulesErrors(target(declared(), { compareBaseline: true })).some((e) => /no base drive/.test(e)))
      t.ok('not with timing: approved', modulesErrors(target(declared(), { timing: 'approved' })).some((e) => /every revision/.test(e)))
      const { report, ...unreported } = declared().test
      t.ok('a declaration must collect a selftest report', modulesErrors(target(declared({ test: unreported }))).some((e) => /no command declares report: selftest/.test(e)))
      t.eq('a finalizer may collect it instead', modulesErrors(target(declared({ test: unreported, finallyCommands: [{ id: 'collect', run: 'x', report: 'selftest' }] }))), [])
      t.ok('no declared id may be a generated test id', modulesErrors(target(declared({ load: { id: 'module-selftest-1', run: 'x' } }))).some((e) => /module-selftest-1 is the id a generated module-selftest command takes/.test(e)))
      t.ok('nor a generated browser id', modulesErrors(target(declared({ browser: { id: 'browser', run: 'browse-it {{filter}}' }, finallyCommands: [{ id: 'browser-2', run: 'x' }] }))).some((e) => /browser-2/.test(e)))
      t.ok('test and browser cannot share an id', modulesErrors(target(declared({ browser: { id: 'module-selftest', run: 'browse-it {{filter}}' } }))).some((e) => /different ids/.test(e)))
    }

    t.section('the coding playbooks resolve to the modules tier on a Boilerplate project; Deployment and Staging keep no check target')
    {
      const f = await engineFixture({ playbook: 'implementation' })
      const infra = (modules) => ({
        kind: 'boilerplate', orientation: 'o',
        staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage', workdir: '/tmp' }, projectRoot: '/opt/stage', files: {} },
        deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:production', workdir: '/opt' }, projectRoot: '/opt/production', files: {} }],
        testDrive: { commands: [{ id: 'boot', run: 'true' }, { id: 'deep', run: 'true' }], tiers: { smoke: ['boot'] }, timing: 'approved', ...(modules ? { modules } : {}) }
      })
      const write = (value) => fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true }).then(() => fs.writeFile(path.join(f.configRoot, 'projects/devpanel-project.yaml'), YAML.stringify({ id: 'devpanel-project', infrastructure: value })))
      for (const [label, modules] of [['undeclared', null], ['declared', declared()]]) {
        await write(infra(modules))
        for (const playbook of ['implementation', 'plan-and-implement', 'prompt', 'refactoring']) {
          const r = await resolvePlaybook(playbook, { root: f.configRoot, projectId: 'devpanel-project' })
          const target = r.resolved?.checks?.target
          t.ok(`${label}: ${playbook} resolves`, r.ok, JSON.stringify(r.errors))
          t.eq(`${label}: ${playbook} gets the modules tier beside the reviews, never smoke/full`, [target?.tier, target?.timing, target?.tiers, target?.baselineCache, Boolean(target?.modules)], ['modules', 'every-revision', undefined, undefined, Boolean(modules)])
          t.eq(`${label}: ${playbook} target is modulesTarget`, target, modulesTarget(infra(modules)))
        }
        if (modules) {
          const { report, ...unreported } = modules.test
          await write(infra({ ...modules, test: unreported }))
          const refused = await resolvePlaybook('implementation', { root: f.configRoot, projectId: 'devpanel-project' })
          t.ok('declared: a project modules tier without a selftest report is refused', !refused.ok, JSON.stringify(refused.errors?.map((e) => e.message)))
          await write(infra(modules))
        }
        const staging = await resolvePlaybook('deployment', { root: f.configRoot, projectId: 'devpanel-project' })
        t.eq(`${label}: a deployment to staging has no check target`, staging.resolved?.checks?.target ?? null, null)
        const deployment = await resolvePlaybook('deployment', { root: f.configRoot, projectId: 'devpanel-project', runOptions: { releaseId: 'staged', environment: 'production' } })
        t.eq(`${label}: deployment has no check target`, deployment.resolved?.checks?.target ?? null, null)
        t.eq(`${label}: the smoke and full tiers stay on the project`, deployment.resolved?.infrastructure?.testDrive?.tiers, { smoke: ['boot'] })
      }
    }

    t.section('an engine run: the drive beside the reviews, in order, recorded; a failed test blocks with no base drive; unlisted told to the auditor')
    {
      const dir = await temp('devpanel-modules-run-')
      const log = path.join(dir, 'log')
      const printer = path.join(dir, 'print')
      await fs.writeFile(printer, `#!/bin/sh\n{ printf '%s' "$1"; shift; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >> '${log}'\n`, { mode: 0o755 })
      // The first revision's report names a failed test with a passing exit; the second's is clean.
      const report = `echo "== runtime/selftest.report"; if [ -f round-0.txt ] && [ ! -f round-1.txt ]; then echo '{"tests":[{"test":"@c/a: works","error":"boom"}]}'; else echo '{"tests":[{"test":"@c/a: works"}]}'; fi`
      const target = { kind: 'local', retryFailed: 0, modules: {
        collections: ['@*'],
        lint: { id: 'lint', run: `${printer} lint {{files}}` }, load: { id: 'load', run: `${printer} load` }, restart: { id: 'restart', run: `${printer} restart` },
        ready: { id: 'ready', run: `${printer} ready` }, test: { id: 'module-selftest', run: `${printer} test {{filter}}` },
        finallyCommands: [{ id: 'collect', run: report, report: 'selftest' }]
      } }
      const { engine, events, f, prompts } = await scenario({ target, sizing: { affectedModules: ['@c/listed'] } })
      const [first, second] = engine.run.revisions
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
      t.eq('the failed test cost one round, with every reviewer approving', engine.run.revisions.length, 2)
      const history = engine.run.checkHistory.filter((h) => h.revision === first.fingerprint)
      t.eq('the first revision\'s drive exited cleanly but gated failed on its report', [history.at(-1)?.tier, history.at(-1)?.result, history.at(-1)?.gating], ['modules', 'passed', 'failed'])
      t.eq('no base drive, ever', (engine.run.baselineChecks ?? []).length, 0)
      const checksDir = path.join(runDir(f.issuePath, engine.runId), 'checks')
      t.eq('and no base directory', (await fs.readdir(checksDir)).filter((n) => n.startsWith('base-')), [])
      t.eq('a drive ran on every revision, with no smoke or full', events.filter((e) => e.type === 'checks-started').map((e) => [e.revision, e.tier]), [[first.fingerprint, 'modules'], [second.fingerprint, 'modules']])
      t.eq('beside the reviews, not after approval', engine.snapshot.checks.target.timing ?? 'every-revision', 'every-revision')
      const closing = engine.run.checkResults.filter((c) => c.revision === second.fingerprint)
      t.eq('the closing revision holds one modules record, with no baseline comparison', closing.map((c) => [c.tier, c.result, c.baselineComparison]), [['modules', 'passed', undefined]])
      t.eq('closure counted it', engine.run.closure?.conditions?.checksSatisfied, true)
      const lines = (await fs.readFile(log, 'utf8')).trim().split('\n')
      const drives = lines.reduce((all, line) => { if (line.startsWith('lint')) all.push([]); all.at(-1).push(line); return all }, [])
      t.eq('two drives, each in the tier\'s order: lint, load, restart, ready, the modules\' tests, then core', drives.at(-1), [
        'lint [@c/a/x.mjs] [lib/core.mjs]', 'load', 'restart', 'ready', 'test [@c/a]', 'test [@c/listed]', 'test [.]', 'test [lib]'])
      t.eq('recorded on the check: the affected modules, the lint files, the command → module map', [closing[0]?.modules?.lint?.files, closing[0]?.modules?.tests?.map((x) => x.module ?? `core:${x.core}`), closing[0]?.modules?.selftestFailures],
        [['@c/a/x.mjs', 'lib/core.mjs'], ['@c/a', '@c/listed', 'core:.', 'core:lib'], []])
      t.ok('the report was read from its log', await fs.access(path.join(runDir(f.issuePath, engine.runId), closing[0].dir, 'collect.stdout')).then(() => true, () => false))
      t.eq('the base checksums are recorded once', Object.keys(engine.run.modules?.base?.checksums ?? { missing: 1 }), [])
      t.eq('each revision carries its modules: changed from checksum inequality', [first.modules?.changed, Object.keys(second.modules?.checksums ?? {})], [['@c/a'], ['@c/a']])
      t.ok('the checksums differ between the revisions', first.modules.checksums['@c/a'] !== second.modules.checksums['@c/a'])
      t.eq('affectedModules on the revision: union, unlisted, notInTree, core', [second.affectedModules?.modules, second.affectedModules?.unlisted, second.affectedModules?.notInTree, second.affectedModules?.core?.dirs],
        [['@c/a', '@c/listed'], ['@c/a'], ['@c/listed'], ['.', 'lib']])
      t.ok('the auditor was told what the triage did not list', prompts.some((p) => p.prompt.includes('Changed modules the triage did not list: "@c/a"')), prompts.map((p) => p.role).join(','))
      await releaseWorkspace(engine)
    }

    t.section('no second drive for tests that ran and failed; a failed load, restart or ready, a timeout or ssh keeps the retry')
    {
      const target = { modules: declared({ browser: { id: 'browser-check', run: 'browse {{filter}}' } }) }
      const cmd = (id, extra = {}) => ({ id, required: true, passed: false, exitCode: 1, signal: null, timedOut: false, ...extra })
      const failed = (...commands) => ({ result: 'failed', commands: [{ id: 'load', required: true, passed: true, exitCode: 0 }, ...commands] })
      t.eq('a failed module selftest', failedInTests(target, failed(cmd('module-selftest-2'))), true)
      t.eq('a failed browser run', failedInTests(target, failed(cmd('browser-check-1'))), true)
      t.eq('a failed ready', failedInTests(target, failed(cmd('ready'))), false)
      t.eq('a failed lint', failedInTests(target, failed(cmd('lint'))), false)
      t.eq('a test beside a failed restart', failedInTests(target, failed(cmd('restart'), cmd('module-selftest-1'))), false)
      t.eq('a test that timed out', failedInTests(target, failed(cmd('module-selftest-1', { timedOut: true, exitCode: null }))), false)
      t.eq('a test killed by a signal', failedInTests(target, failed(cmd('module-selftest-1', { signal: 'SIGKILL', exitCode: null }))), false)
      t.eq('ssh\'s own exit', failedInTests(target, failed(cmd('module-selftest-1', { exitCode: 255 }))), false)
      t.eq('a failed optional collector alone is no test failure', failedInTests(target, failed(cmd('collect', { required: false }))), false)
      t.eq('a drive that failed with no command record', failedInTests(target, { result: 'failed', commands: [] }), false)
      t.eq('a passed drive', failedInTests(target, { result: 'passed', commands: [] }), false)

      const dir = await temp('devpanel-modules-retry-')
      const collect = { id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[{"test":"@c/a: works"}]}\'', report: 'selftest' }
      const ok = path.join(dir, 'ok')
      const later = path.join(dir, 'later')
      await fs.writeFile(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      await fs.writeFile(later, '#!/bin/sh\ntest -f round-1.txt\n', { mode: 0o755 })
      const base = { collections: ['@*'], lint: { id: 'lint', run: `${ok} {{files}}` }, load: { id: 'load', run: 'true' }, restart: { id: 'restart', run: 'true' } }
      // Default retryFailed (1). The test fails on the first revision's bytes and passes on the second's.
      const tests = await scenario({ target: { kind: 'local', modules: { ...base, ready: { id: 'ready', run: 'true' },
        test: { id: 'module-selftest', run: `${later} {{filter}}` }, finallyCommands: [collect] } } })
      t.eq('the run completes on the second revision', [tests.engine.run.status, tests.engine.run.revisions.length], ['completed', 2], tests.engine.run.blockedReason)
      t.eq('no rerun of the failed tests', tests.events.filter((e) => e.type === 'checks-retry').length, 0)
      t.eq('the skip is an event naming the test command', tests.events.filter((e) => e.type === 'checks-retry-skipped').map((e) => [e.reason, e.commands.map((c) => c.command)]), [['tests-failed', ['module-selftest-1', 'module-selftest-2', 'module-selftest-3']]])
      t.eq('one drive per revision on the record', tests.engine.run.checkHistory.map((h) => [h.result, h.runs.length]), [['failed', 1], ['passed', 1]])
      await releaseWorkspace(tests.engine)

      // ready fails once, whatever the bytes: infrastructure, so the same revision is driven again and passes.
      const infra = await scenario({ target: { kind: 'local', modules: { ...base, ready: { id: 'ready', run: `if [ -f '${dir}/ready' ]; then exit 0; fi; touch '${dir}/ready'; exit 1` },
        test: { id: 'module-selftest', run: `${ok} {{filter}}` }, finallyCommands: [collect] } } })
      t.eq('one revision, completed', [infra.engine.run.status, infra.engine.run.revisions.length], ['completed', 1], infra.engine.run.blockedReason)
      t.eq('the failed ready was retried once', infra.events.filter((e) => e.type === 'checks-retry').length, 1)
      t.eq('and the pass is recorded flaky, two drives', [infra.engine.run.checkResults.at(-1).flaky, infra.engine.run.checkHistory.at(-1).runs.length], [true, 2])
      await releaseWorkspace(infra.engine)
    }

    t.section('a test that fails on its own exit does not hide the others: every module of the drive runs, all failures are told together, and what failed runs first next time')
    {
      const dir = await temp('devpanel-modules-all-')
      const collect = { id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[{"test":"@c/a: works"}]}\'', report: 'selftest' }
      const ok = path.join(dir, 'ok')
      await fs.writeFile(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const base = { collections: ['@*'], lint: { id: 'lint', run: `${ok} {{files}}` }, load: { id: 'load', run: 'true' }, restart: { id: 'restart', run: 'true' }, ready: { id: 'ready', run: 'true' } }
      const flat = (prompt) => prompt.replace(/\s+/g, '')
      // The root filter passes; the module and lib fail on the first revision's bytes (exit 1) and pass on the second's.
      const tester = path.join(dir, 'tester')
      await fs.writeFile(tester, '#!/bin/sh\n[ "$1" = . ] && exit 0\ntest -f round-1.txt\n', { mode: 0o755 })
      const all = await scenario({ target: { kind: 'local', modules: { ...base, test: { id: 'module-selftest', run: `${tester} {{filter}}` }, finallyCommands: [collect] } } })
      t.eq('the run completes on the second revision', [all.engine.run.status, all.engine.run.revisions.length], ['completed', 2], all.engine.run.blockedReason)
      t.eq('the first drive failed in both failing filters, in one drive', all.events.filter((e) => e.type === 'checks-retry-skipped').map((e) => e.commands.map((c) => c.command)), [['module-selftest-1', 'module-selftest-3']])
      t.eq('the history keeps what failed', all.engine.run.checkHistory.map((h) => [h.result, h.modules.failedFilters]), [['failed', ['@c/a', 'lib']], ['passed', []]])
      const second = flat(all.authorPrompts.find((p) => p.round === 1)?.prompt ?? '')
      t.ok('the author is told every failed module of the drive', second.includes('"module":"@c/a"') && second.includes('"core":"lib"') && second.includes('"notRun":[]'), second.slice(second.indexOf('"failed"'), second.indexOf('"failed"') + 400))
      const last = all.engine.run.checkResults.at(-1)
      t.eq('the next drive runs what failed first', [last.modules.tests.map((x) => x.filter), last.modules.failedFirst], [['@c/a', 'lib', '.'], ['@c/a', 'lib']])
      await releaseWorkspace(all.engine)

      // An exit that is not the test's own (here a shell's word for SIGKILL) leaves the instance in doubt: the rest do not run.
      const killed = path.join(dir, 'killed')
      await fs.writeFile(killed, '#!/bin/sh\ntest -f round-1.txt || exit 137\n', { mode: 0o755 })
      const stop = await scenario({ target: { kind: 'local', modules: { ...base, test: { id: 'module-selftest', run: `${killed} {{filter}}` }, finallyCommands: [collect] } } })
      t.eq('completed on the second revision', [stop.engine.run.status, stop.engine.run.revisions.length], ['completed', 2], stop.engine.run.blockedReason)
      t.eq('that failure keeps the retry', [stop.events.filter((e) => e.type === 'checks-retry').length, stop.events.filter((e) => e.type === 'checks-retry-skipped').length], [1, 0])
      const told = flat(stop.authorPrompts.find((p) => p.round === 1)?.prompt ?? '')
      t.ok('and the author is told which modules never ran', /"notRun":\[\{"core":"\.","slot":"test","command":"module-selftest-2"\},\{"core":"lib","slot":"test","command":"module-selftest-3"\}\]/.test(told), told.slice(told.indexOf('"notRun"'), told.indexOf('"notRun"') + 300))
      await releaseWorkspace(stop.engine)

      t.eq('exit 1 is the test\'s own', exitedOnItsOwn({ exitCode: 1, signal: null, timedOut: false }), true)
      t.eq('124 to 255 are not', [124, 125, 126, 127, 137, 255].map((exitCode) => exitedOnItsOwn({ exitCode, signal: null, timedOut: false })), [false, false, false, false, false, false])
      t.eq('nor a command that reported the drive unavailable', exitedOnItsOwn({ exitCode: 1, unavailable: 'no snapshot' }), false)
    }

    t.section('{{filters}}: one test command receives every affected module and core directory, each as an argument of its own')
    {
      const affected = { modules: ['@c/a', '@c/b'], core: { paths: 2, dirs: ['.', 'lib'] } }
      const target = { kind: 'ssh', tier: 'modules', modules: declared({ test: { id: 'module-selftest', run: 'selftest-it stage {{filters}}', report: 'selftest' }, browser: { id: 'browser', run: 'browse-it {{filters}}' } }) }
      const { target: drive, plan } = modulesDrive(target, { affected, files: [], failedFirst: ['lib', '@c/b', 'gone'] })
      t.eq('one test and one browser command', drive.commands.map((c) => c.id), ['load', 'restart', 'ready', 'module-selftest-1', 'browser-1'])
      t.eq('every filter quoted on its own, what failed before first', drive.commands.slice(3).map((c) => c.run), ["selftest-it stage '@c/b' 'lib' '@c/a' '.'", "browse-it '@c/b' '@c/a'"])
      t.eq('the plan names what the command covers', plan.tests[0], { id: 'module-selftest-1', slot: 'test', filters: ['@c/b', 'lib', '@c/a', '.'], modules: ['@c/b', '@c/a'], core: ['lib', '.'] })
      t.eq('and what ran first', plan.failedFirst, ['@c/b', 'lib'])
      t.eq('nothing affected, no command', modulesDrive(target, { affected: { modules: [], core: null }, files: [] }).target.commands.map((c) => c.id), ['load', 'restart', 'ready'])
      const one = modulesDrive({ ...target, modules: declared() }, { affected, files: [] })
      t.eq('{{filter}} still expands per filter, each continuing past a failed sibling', one.target.commands.slice(3).map((c) => [c.id, c.ownFailureContinues]), [1, 2, 3, 4].map((n) => [`module-selftest-${n}`, true]))
      t.eq('the declaration is valid', modulesErrors({ ...target, tier: undefined }), [])
      const scaled = (test) => modulesDrive({ ...target, modules: declared({ test }) }, { affected, files: [] }).target.commands[3]
      t.eq('a per-filter share scales the one command\'s timeout', [scaled({ id: 'module-selftest', run: 's {{filters}}', timeoutSeconds: 600, timeoutSecondsPerFilter: 300 }).timeoutSeconds, scaled({ id: 'module-selftest', run: 's {{filters}}', timeoutSecondsPerFilter: 100 }).timeoutSeconds, 'timeoutSecondsPerFilter' in scaled({ id: 'module-selftest', run: 's {{filters}}', timeoutSecondsPerFilter: 100 })], [1800, 1300, false])
      t.ok('which only the {{filters}} form takes', modulesErrors({ kind: 'ssh', modules: declared({ test: { id: 'module-selftest', run: 'selftest-it {{filter}}', report: 'selftest', timeoutSecondsPerFilter: 60 } }) }).some((e) => /timeoutSecondsPerFilter applies only/.test(e)))
      t.eq('the framework\'s script line is accepted', modulesErrors({ kind: 'ssh', modules: declared({ test: { id: 'module-selftest', run: '@boilerplate/tooling/stage-module-selftest.sh /opt/stage.example.invalid APP {{filters}}', report: 'selftest', timeoutSeconds: 600, timeoutSecondsPerFilter: 600 } }) }), [])
      t.ok('but not behind an interpreter word', modulesErrors({ kind: 'ssh', modules: declared({ test: { id: 'module-selftest', run: 'bash @boilerplate/tooling/stage-module-selftest.sh /opt/stage.example.invalid APP {{filters}}', report: 'selftest' } }) }).some((e) => /modules.test.run must name a program/.test(e)))
      t.ok('{{filters}} must be a word of its own', modulesErrors({ kind: 'ssh', modules: declared({ test: { id: 'module-selftest', run: 'selftest-it x{{filters}}', report: 'selftest' } }) }).some((e) => /modules.test.run/.test(e)))
      t.ok('not both forms in one template', modulesErrors({ kind: 'ssh', modules: declared({ test: { id: 'module-selftest', run: 'selftest-it {{filter}} {{filters}}', report: 'selftest' } }) }).some((e) => /modules.test.run/.test(e)))
      t.ok('only test and browser take it', modulesErrors({ kind: 'ssh', modules: declared({ load: { id: 'load', run: 'load-it {{filters}}' } }) }).some((e) => /only test and browser take/.test(e)))

      const cmd = (id, exitCode) => ({ id, required: true, passed: exitCode === 0, exitCode, signal: null, timedOut: false })
      const check = { tier: 'modules', result: 'failed', commands: [cmd('ready', 0), cmd('module-selftest-1', 1)], modules: { tests: plan.tests, selftestFailures: [{ command: 'module-selftest-1', test: 'a/saves' }, { command: 'module-selftest-1', test: 'x/y', module: '@c/b' }] } }
      t.eq('its failed modules are read off the failed tests', failedModuleTests(check).failed.map((f) => [f.module, f.by]), [['@c/b', 'test-names'], ['@c/a', 'test-names']])
      t.eq('and every filter is named when no test says which', failedModuleTests({ ...check, modules: { tests: plan.tests, selftestFailures: [] } }).failed.map((f) => [f.filters, f.undetermined]), [[['@c/b', 'lib', '@c/a', '.'], true]])
      t.eq('all of them run first in the next drive', failedFilters(check), ['@c/b', 'lib', '@c/a', '.'])
      t.ok('the gate names the modules', /failed modules of this drive: @c\/b \(module-selftest-1, exit 1, read off the failed tests' names\), @c\/a/.test(gateReason(check, {})), gateReason(check, {}))
      t.eq('the browser command that never ran is said so', failedModulesWords(check).includes('not run, outcome unknown: one of @c/b, @c/a (browser-1)'), true, failedModulesWords(check))
      const summary = checkSummary(check).modules
      t.eq('the seats get the same reading', [summary.tested, summary.failed.length, summary.notRun.length, /EVERY failing module/.test(summary.note)], [['@c/b', 'lib', '@c/a', '.'], 2, 1, true])

      // The whole path: one command, a report behind a failing exit, the module read from the report.
      const dir = await temp('devpanel-modules-filters-')
      const tester = path.join(dir, 'tester')
      await fs.writeFile(tester, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\necho '== runtime/selftest.report'\nif [ -f round-1.txt ]; then echo '{"tests":[{"test":"a/saves"}]}'; exit 0; fi\necho '{"tests":[{"test":"a/saves","error":"boom"},{"test":"lib/ok"}]}'\nexit 1\n`, { mode: 0o755 })
      const okLint = path.join(dir, 'ok')
      await fs.writeFile(okLint, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const run = await scenario({ target: { kind: 'local', modules: { collections: ['@*'], lint: { id: 'lint', run: `${okLint} {{files}}` }, load: { id: 'load', run: 'true' }, restart: { id: 'restart', run: 'true' }, ready: { id: 'ready', run: 'true' },
        test: { id: 'module-selftest', run: `${tester} {{filters}}`, report: 'selftest' } } } })
      t.eq('completed on the second revision', [run.engine.run.status, run.engine.run.revisions.length], ['completed', 2], run.engine.run.blockedReason)
      t.eq('the one command got every filter as its own argument', (await fs.readFile(path.join(dir, 'args'), 'utf8')).trim().split('\n'), ['@c/a', '.', 'lib'])
      t.eq('one test command per drive', run.engine.run.checkResults.at(-1).commands.map((c) => c.id), ['lint', 'load', 'restart', 'ready', 'module-selftest-1'])
      const told = (run.authorPrompts.find((p) => p.round === 1)?.prompt ?? '').replace(/\s+/g, '')
      t.ok('the author is told the failed module and test, read from the failed command\'s report', told.includes('"module":"@c/a"') && told.includes('"test":"a/saves"') && told.includes('"by":"test-names"'), told.slice(told.indexOf('"failed"'), told.indexOf('"failed"') + 400))
      await releaseWorkspace(run.engine)
    }

    t.section('every command passed but a selftest report could not be read: inconclusive, no author round, said in words')
    {
      const check = (result, modules) => ({ tier: 'modules', result, modules })
      t.eq('an unreadable report behind a pass is inconclusive', inconclusiveBase(check('passed', { selftestFailures: [], reportUnreadable: [{ command: 'collect', error: 'x' }] }), {}), true)
      t.eq('a named failed test is not', inconclusiveBase(check('passed', { selftestFailures: [{ command: 'collect', test: 't' }], reportUnreadable: [{ command: 'collect', error: 'x' }] }), {}), false)
      t.eq('a failed drive is not', inconclusiveBase(check('failed', { selftestFailures: [], reportUnreadable: [{ command: 'collect', error: 'x' }] }), {}), false)
      t.eq('it still gates failed', gatingResult(check('passed', { selftestFailures: [], reportUnreadable: [{ command: 'collect', error: 'x' }] }), {}), 'failed')

      // The collector prints no report line: what the staging script did on 2026-11-07.
      const ok = path.join(await temp('devpanel-modules-unread-'), 'ok')
      await fs.writeFile(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const target = { kind: 'local', modules: { collections: ['@*'], lint: { id: 'lint', run: `${ok} {{files}}` }, load: { id: 'load', run: 'true' }, restart: { id: 'restart', run: 'true' }, ready: { id: 'ready', run: 'true' },
        test: { id: 'module-selftest', run: `${ok} {{filter}}` }, finallyCommands: [{ id: 'collect', run: 'echo "3 tests, 0 failed"', report: 'selftest' }] } }
      const { engine, events } = await scenario({ target })
      t.eq('stopped as inconclusive, not as a failed check', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked checks-inconclusive')
      t.eq('the author got no round for it', engine.run.steps.filter((s) => s.stepId === 'implement').length, 1)
      t.eq('the record: passed, gated failed, inconclusive', engine.run.checkHistory.map((h) => [h.result, h.gating, h.inconclusive]), [['passed', 'failed', true]])
      t.eq('no rerun either', events.filter((e) => e.type === 'checks-retry').length, 0)
      const said = explainRun(engine.run)
      t.ok('the explanation names the unreadable report and that no test failed', /selftest report could not be read/.test(said.headline) && /selftest report unreadable: collect/i.test(said.detail) && /No test is known to have failed/.test(said.detail), JSON.stringify(said))
      await releaseWorkspace(engine)
    }

    t.section('a refresh under other collections (and a browser command) reads the revision\'s modules again')
    {
      const modules = {
        collections: ['@*'], lint: { id: 'lint', run: 'ls {{files}}' }, load: { id: 'load', run: 'true' }, restart: { id: 'restart', run: 'true' }, ready: { id: 'ready', run: 'true' },
        test: { id: 'module-selftest', run: 'ls -d {{filter}}' },
        finallyCommands: [{ id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[]}\'', report: 'selftest' }]
      }
      let probe = null
      const { engine } = await scenario({
        target: { kind: 'local', retryFailed: 0, modules },
        extra: async (ws) => { await fs.mkdir(path.join(ws, 'app-modules/a'), { recursive: true }); await fs.writeFile(path.join(ws, 'app-modules/a/x.mjs'), 'export {}\n') },
        // During the run, while the revision and its worktree stand: what a refresh of the project's changed declaration drives.
        onAudit: async (round, state) => {
          if (probe) return
          const e = state.engine
          const recorded = e.run.revisions.at(-1)
          const before = { modules: recorded.affectedModules?.modules, core: recorded.affectedModules?.core?.dirs }
          const ws = e.run.workspace
          const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: e.baseline ?? new Map(), projection: workspaceProjection(ws) })
          const drive = e.modulesDriveFor({ kind: 'local', modules: { ...modules, collections: ['*-modules'], browser: { id: 'browser', run: 'ls -d {{filter}}' } } }, fp)
          probe = { before, drive, recorded: structuredClone(e.run.revisions.at(-1)), base: structuredClone(e.run.modules.base) }
        }
      })
      t.eq('under @* the module file was core', [probe?.before.modules, probe?.before.core], [['@c/a'], ['.', 'app-modules/a', 'lib']])
      t.eq('under *-modules app-modules/a is the affected module', probe?.drive.affected.modules, ['app-modules/a'])
      t.eq('its test and browser commands are generated, in tier order', probe?.drive.target.commands.map((c) => c.id), ['lint', 'load', 'restart', 'ready', 'module-selftest-1', 'module-selftest-2', 'module-selftest-3', 'module-selftest-4', 'browser-1'])
      t.eq('the browser command runs app-modules/a', probe?.drive.target.commands.at(-1).run, "ls -d 'app-modules/a'")
      t.eq('the revision\'s modules are read again', [probe?.recorded.modules?.changed, Object.keys(probe?.recorded.modules?.checksums ?? {}), probe?.recorded.modules?.collections], [['app-modules/a'], ['app-modules/a'], ['*-modules']])
      t.eq('and the base\'s, under the new collections', probe?.base.collections, ['*-modules'])
      await releaseWorkspace(engine).catch(() => {})
    }

    t.section('a Boilerplate project without a modules tier: unavailable on each revision, nothing driven, closure blocked')
    {
      const dir = await temp('devpanel-modules-undeclared-')
      const marker = path.join(dir, 'ssh-called')
      const ssh = path.join(dir, 'ssh')
      await fs.writeFile(ssh, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })
      const saved = process.env.DEVPANEL_SSH_BIN
      process.env.DEVPANEL_SSH_BIN = ssh
      try {
        const target = { kind: 'ssh', tier: 'modules', timing: 'every-revision', ssh: { hostRef: 'ssh-config:stage.invalid', workdir: '/tmp' }, commands: [{ id: 'boot', run: 'true' }] }
        const { engine, events } = await scenario({ target })
        const record = engine.run.checkResults.at(-1)
        t.eq('the check is unavailable, tier modules', [record?.tier, record?.result], ['modules', 'unavailable'])
        t.ok('saying why', /declares no testDrive\.modules/.test(record?.error ?? ''), record?.error)
        t.eq('no drive started', events.filter((e) => e.type === 'checks-started').length, 0)
        t.eq('SSH was never called', await fs.access(marker).then(() => true, () => false), false)
        t.eq('the reviews were not sent back for it', engine.run.revisions.length, 1)
        t.ok('closure is not met under required checks', engine.run.status !== 'completed' && engine.run.closure?.conditions?.checksSatisfied === false, `${engine.run.status} ${engine.run.blockedReason}`)
        // Refresh checks with the project's modules tier declared since: the drive selects from that declaration.
        const ws = engine.run.workspace
        const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline ?? new Map(), projection: workspaceProjection(ws) })
        const drive = engine.modulesDriveFor({ ...target, modules: declared() }, fp)
        t.eq('a refreshed declaration selects the module and core tests', drive.plan.tests.map((x) => x.module ?? `core:${x.core}`), ['@c/a', 'core:.', 'core:lib'])
        t.eq('in the tier order', drive.target.commands.map((c) => c.id), ['lint', 'load', 'restart', 'ready', 'module-selftest-1', 'module-selftest-2', 'module-selftest-3'])
        t.eq('and the revision record gets its modules', [engine.run.revisions.at(-1).modules?.changed, engine.run.revisions.at(-1).affectedModules?.modules], [['@c/a'], ['@c/a']])
        await releaseWorkspace(engine).catch(() => {})
      } finally {
        if (saved === undefined) delete process.env.DEVPANEL_SSH_BIN
        else process.env.DEVPANEL_SSH_BIN = saved
      }
    }
  } finally {
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
