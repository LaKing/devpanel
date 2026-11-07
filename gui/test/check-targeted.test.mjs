import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { engineFixture, scriptFor, blocking, simulateProcessDeath } from './fakes/fixture.mjs'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { tierTarget } from '../server/runtime/baseline-cache.mjs'
import { selectTargeted, usableTestName } from '../server/runtime/targeted-tier.mjs'
import { tierErrors, stagingTarget, localTarget } from '../server/infrastructure.mjs'
import { runMetrics } from '../server/runtime/run-metrics.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { ignoredSelftests } from '../server/runtime/selftest-history.mjs'
import { checkSummary } from '../server/runtime/check-summary.mjs'
import { acceptableCheck } from '../server/runtime/run-control.mjs'
import { overlappingSections } from './helpers.mjs'

export const name = 'targeted tier — named tests on a repair revision instead of its smoke; only the full drive closes, and a full failure after a targeted pass is on the record'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
// Set up with the helper scripts: the template runs a script that records its arguments in named.txt.
let TEMPLATE = null
let IGNORING_TEMPLATE = null
const ALL_TESTS = "printf '%s\\n' core/a core/b > named.txt"
/** A selftest report over the tests in named.txt: each failing while its condition holds in the candidate. */
const collect = (fails = {}) => `echo "== runtime/selftest.report"; printf '{"tests":['; s=''; while IFS= read -r n; do e=''; ${Object.entries(fails).map(([test, when]) => `if [ "$n" = '${test}' ] && { ${when}; }; then e=',"error":"x"'; fi;`).join(' ')} printf '%s{"test":"%s"%s}' "$s" "$n" "$e"; s=','; done < named.txt; printf ']}\\n'`
const ONLY_ROUND_0 = '[ -f round-0.txt ] && [ ! -f round-1.txt ]'
const ONLY_ROUND_1 = '[ -f round-1.txt ] && [ ! -f round-2.txt ]'

const localDrive = ({ fails = {}, targeted = {}, declare = true, report = null, selftests = ALL_TESTS } = {}) => ({
  kind: 'local', retryFailed: 0,
  tiers: { smoke: ['boot'], ...(declare ? { targeted: { command: 'selftests', run: TEMPLATE, always: ['boot', 'collect'], ...targeted } } : {}) },
  commands: [{ id: 'boot', run: 'true' }, { id: 'selftests', run: selftests }, { id: 'collect', run: report ?? collect(fails), report: 'selftest' }, { id: 'deep', run: 'true' }]
})

/*
 * `findings[round]` are the reviewer's blocking findings of that round, approval
 * when there are none. `unchanged` rounds leave the author's candidate as it was.
 * `prepare` gets the engine before it drives.
 */
async function scenario ({ target, findings = {}, unchanged = new Set(), hooks = null, prepare = null }) {
  const state = { engine: null, audits: [] }
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      if (!unchanged.has(round)) await fs.writeFile(path.join(state.engine.run.workspace.path, `round-${round}.txt`), 'work\n')
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      const rev = revision(prompt)
      const run = state.engine.run
      state.audits.push({ role, round, revision: rev, prompt, checksRunning: Boolean(state.engine.checksInFlight), targetedOnRecord: (run.checkHistory ?? []).some((h) => h.revision === rev && h.tier === 'targeted') })
      const own = findings[round] ?? []
      return fence({ verdict: own.length ? 'changes-needed' : 'approved', artifactRevision: rev, findings: own, priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  f.state = state
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement: 'required', target })}\n`)
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  if (hooks) Object.assign(engine.hooks, hooks)
  prepare?.(engine)
  await (hooks ? engine.drive().catch(() => {}) : engine.drive())
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, events, f, audits: state.audits, resolved: resolved.resolved }
}

const started = (events, tier) => events.filter((e) => e.type === 'checks-started' && e.tier === tier).map((e) => e.revision)
const revisions = (engine) => engine.run.revisions.map((r) => r.fingerprint)
const targetedOf = (engine, rev) => engine.run.checkResults.filter((c) => c.revision === rev && c.tier === 'targeted').at(-1)
const naming = (id, failingTests) => ({ ...blocking(id), failingTests })

export default async function (t) {
  const sections = []
  const helpers = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-targeted-bin-')))
  const script = async (dir, name, body) => {
    await fs.writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path.join(dir, name)
  }
  const recordArgs = (file) => `: > ${file}; for t in "$@"; do printf '%s\\n' "$t" >> ${file}; done`
  TEMPLATE = `${await script(helpers, 'named', recordArgs('named.txt'))} {{tests}}`
  IGNORING_TEMPLATE = `${await script(helpers, 'ignoring', "printf 'core/a\\n' > named.txt")} {{tests}}`

  sections.push(['AC-1: the declaration is resolved with the playbook and carried by a project\'s targets', async (t) => {
    const { engine, resolved } = await scenario({ target: localDrive() })
    t.eq('the resolved playbook holds it', resolved.checks.target.tiers.targeted, { command: 'selftests', run: TEMPLATE, always: ['boot', 'collect'] })
    await releaseWorkspace(engine)
    const tiers = { smoke: ['a'], targeted: { command: 'a', run: 'x {{tests}}', always: [] } }
    const commands = [{ id: 'a', run: 'x', report: 'selftest' }]
    t.eq('a project\'s staging target carries it', stagingTarget({ staging: { ssh: { hostRef: 'env:X', workdir: '/w' } }, testDrive: { commands, tiers } }).tiers.targeted, tiers.targeted)
    t.eq('a project\'s local checks carry it', localTarget({ commands, tiers }).tiers.targeted, tiers.targeted)
  }])

  sections.push(['AC-1: what cannot work is refused', async (t) => {
    const refused = (targeted, extra = {}) => tierErrors({
      tiers: { smoke: ['boot'], targeted: { command: 'selftests', run: 'x {{tests}}', always: ['boot', 'collect'], ...targeted } },
      commands: [{ id: 'boot', run: 'true' }, { id: 'selftests', run: 'x', ...extra }, { id: 'collect', run: 'x', report: 'selftest' }, { id: 'svc', run: 'x', kind: 'candidate', service: true }, { id: 'needy', run: 'x', needs: ['boot'] }, { id: 'quiet', run: 'x' }],
      finallyCommands: [{ id: 'end', run: 'x' }]
    })
    t.eq('a sound declaration passes', refused({}), [])
    t.ok('an unknown command', refused({ command: 'nope' }).some((e) => e.includes('nope')))
    t.ok('a finalizer', refused({ command: 'end' }).some((e) => e.includes('finalizer')))
    t.ok('a service', refused({ command: 'svc' }).some((e) => e.includes('service')))
    t.ok('an optional command', refused({}, { required: false }).some((e) => e.includes('not required')))
    t.ok('an unknown id in always', refused({ always: ['boot', 'collect', 'gone'] }).some((e) => e.includes('gone')))
    t.ok('a need outside the tier', refused({ always: ['collect', 'needy'] }).some((e) => e.includes('needs boot')))
    t.ok('no selftest report in the tier', refused({ always: ['boot'] }).some((e) => e.includes('report: selftest')))
    t.ok('no placeholder', refused({ run: 'x' }).some((e) => e.includes('exactly once')))
    t.ok('two placeholders', refused({ run: 'x {{tests}} {{tests}}' }).some((e) => e.includes('exactly once')))
    t.ok('inside quotes', refused({ run: 'x "--only {{tests}}"' }).some((e) => e.startsWith('tiers.targeted.run')))
    const f = await engineFixture({ playbook: 'implementation' })
    await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement: 'required', target: localDrive({ targeted: { command: 'nope' } }) })}\n`)
    t.eq('config validation refuses it', (await resolvePlaybook('implementation', { root: f.configRoot, projectId: 'devpanel-project' })).ok, false)
  }])

  sections.push(['a template is a literally named command and plain words: everything else is refused, and no accepted form runs what a name says', async (t) => {
    const run = promisify(execFile)
    const errors = (template) => tierErrors({
      tiers: { smoke: ['s'], targeted: { command: 's', run: template, always: [] } },
      commands: [{ id: 's', run: 'x', report: 'selftest' }]
    })
    const refusedForms = [
      // The two of the second repair's audit, then the first repair's.
      "printf ignored; \\\n# it's\nprintf ' {{tests}} '", '$MISSING_RUNNER {{tests}}', "printf '%s\\n' \\{{tests}}",
      // A word that is not plain, before or after the placeholder.
      'x \\{{tests}}', 'x \\\n{{tests}}', "x 'a' {{tests}}", 'x "a" {{tests}}', 'x "{{tests}}"', "x '{{tests}}'", 'x --only={{tests}}', 'x {{tests}}y', 'x ${{tests}}',
      'x $A {{tests}}', 'x ${A} {{tests}}', 'x `y` {{tests}}', 'x $(y) {{tests}}', 'x * {{tests}}', 'x ~ {{tests}}', 'x # {{tests}}', 'x {{tests}} # y', 'x {{tests}} > out', 'x > {{tests}}',
      'x {{tests}} | y', 'x {{tests}}; y', 'x {{tests}} && y', 'x; y {{tests}}', 'x | y {{tests}}', 'x && y {{tests}}', 'x & y {{tests}}', '(x {{tests}})', '{ x {{tests}}; }',
      'x <<EOF\n{{tests}}\nEOF', 'x\n{{tests}}', 'x\ty {{tests}}', 'x  {{tests}}', ' x {{tests}}', 'x {{tests}} ',
      // Anything but a literally named program as the command.
      '{{tests}}', '{{tests}} x', 'A=1 x {{tests}}', 'A={{tests}}', '/bin/{{tests}}', '$X/y {{tests}}', '${HOME}/y {{tests}}', '~/y {{tests}}', '-x {{tests}}',
      'eval {{tests}}', 'eval x {{tests}}', '. {{tests}}', 'source {{tests}}', 'exec {{tests}}', 'command {{tests}}', 'let {{tests}}', 'test -v {{tests}}', 'printf -v {{tests}}', 'time {{tests}}', 'if {{tests}}',
      'env {{tests}}', 'env A=1 {{tests}}', '/usr/bin/env {{tests}}', 'xargs {{tests}}', 'sudo {{tests}}', 'nohup {{tests}}', 'sh {{tests}}', 'sh -c {{tests}}', '/bin/sh -c {{tests}}', 'bash -lc {{tests}}'
    ]
    for (const form of refusedForms) t.ok(`refused: ${JSON.stringify(form)}`, errors(form).some((e) => e.startsWith('tiers.targeted.run')), JSON.stringify(errors(form)))
    // A script inside a Boilerplate collection (`@boilerplate/tooling/…`) is a literally named command too.
    t.ok('a path beginning with @ is a command', !errors('@boilerplate/tooling/run-selftests.sh {{tests}}').some((e) => e.startsWith('tiers.targeted.run')))
    const shells = []
    for (const shell of ['/bin/sh', '/bin/bash']) if (await fs.access(shell).then(() => true, () => false)) shells.push(shell)
    if (shells.includes('/bin/bash')) {
      const { stdout } = await run('/bin/bash', ['-c', 'compgen -b; compgen -k'])
      for (const word of stdout.split('\n').filter(Boolean)) t.ok(`this shell's own word is no command: ${word}`, errors(`${word} {{tests}}`).some((e) => e.startsWith('tiers.targeted.run')))
    }
    const names = ['x; touch ran #', 'a`touch ran`b', '$(touch ran)', "'; touch ran; '", 'trail\\', "$'x\\'; touch ran; #", '& touch ran', '> ran', 'touch', 'ran', '$& ran', '"; touch ran; "', '* ?', '~', '#', '{a,b}']
    for (const test of names) t.ok(`usable, so it reaches the template: ${JSON.stringify(test)}`, usableTestName(test))
    // Every accepted form: what the fake program must receive before and after the names.
    const accepted = [
      ['selftest --only {{tests}}', ['--only'], []],
      ['selftest {{tests}}', [], []],
      ['selftest {{tests}} --verbose out=report.json', [], ['--verbose', 'out=report.json']],
      ['npm run selftest -- --only {{tests}}', ['run', 'selftest', '--', '--only'], []],
      ['node tools/selftest.mjs {{tests}}', ['tools/selftest.mjs'], []],
      ['./run-selftests KEY=1 a@b,c:d%e+f {{tests}}', ['KEY=1', 'a@b,c:d%e+f'], []],
      ['{{PROGRAM}} {{tests}}', [], []]
    ]
    const bin = await fs.mkdtemp(path.join(helpers, 'bin-'))
    const record = `for a in "$@"; do printf '%s\\n' "$a"; done >> out`
    const program = await script(bin, 'selftest', record)
    await script(bin, 'npm', record)
    await script(bin, 'node', record)
    for (const shell of shells) {
      for (const [form, before, after] of accepted) {
        const template = form.replace('{{PROGRAM}}', program)
        t.eq(`accepted: ${JSON.stringify(template)}`, errors(template), [])
        const dir = await fs.mkdtemp(path.join(helpers, 'cwd-'))
        await script(dir, 'run-selftests', record)
        const filled = tierTarget({ tiers: { smoke: ['s'], targeted: { command: 's', run: template, always: [] } }, commands: [{ id: 's', run: 'x' }] }, 'targeted', names).commands[0].run
        await run(shell, ['-c', filled], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
        t.eq(`${shell} ${JSON.stringify(form)}: nothing in a name ran`, (await fs.readdir(dir)).sort(), ['out', 'run-selftests'])
        const received = (await fs.readFile(path.join(dir, 'out'), 'utf8')).split('\n').slice(0, -1)
        t.eq(`${shell} ${JSON.stringify(form)}: each name arrived as one argument`, received, [...before, ...names, ...after])
      }
    }
  }])

  sections.push(['AC-2, AC-3: a failed drive\'s named tests run instead of the smoke, and the audit reads the result', async (t) => {
    const { engine, events, audits } = await scenario({ target: localDrive({ fails: { 'core/a': ONLY_ROUND_0 } }) })
    const [first, second] = revisions(engine)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the failed drive named the test', engine.run.checkHistory.find((h) => h.revision === first && h.tier === 'full')?.namedFailures, [{ command: 'collect', test: 'core/a' }])
    t.eq('the first revision had its smoke', started(events, 'smoke'), [first])
    t.eq('the repair revision ran the targeted tier', started(events, 'targeted'), [second])
    const drive = targetedOf(engine, second)
    t.eq('its commands are what was declared, in order, without the rest of the drive', drive.commands.map((c) => c.id), ['boot', 'selftests', 'collect'])
    t.eq('the template is filled with the name', drive.commands.find((c) => c.id === 'selftests').run, TEMPLATE.replace('{{tests}}', "'core/a'"))
    t.eq('the record names the tests and where they came from', [drive.targeted.tests, drive.targeted.sources.map((s) => s.from)], [['core/a'], ['drive']])
    t.eq('it passed', drive.result, 'passed')
    const audit = audits.find((a) => a.revision === second)
    t.ok('the audit began after the drive ended', audit.targetedOnRecord && !audit.checksRunning, JSON.stringify({ on: audit.targetedOnRecord, running: audit.checksRunning }))
    t.ok('its prompt identifies the tier', /"tier":\s*"targeted"/.test(audit.prompt))
    t.ok('and names the tests', /"tests":\s*\[\s*"core\/a"\s*\]/.test(audit.prompt))
    t.eq('the full drive still ran on the approved revision', started(events, 'full'), [first, second])
    t.eq('closure counted it', engine.run.closure?.conditions?.checksSatisfied, true)
    t.eq('metrics count a pass the full drive confirmed', runMetrics(engine.run).targeted, { drives: 1, passed: 1, failed: 0, unavailable: 0, confirmedByFull: 1, missedByFull: 0 })
    await releaseWorkspace(engine)
  }])

  sections.push(['AC-2: an open finding\'s failingTests name them too', async (t) => {
    const { engine, events } = await scenario({ target: localDrive(), findings: { 0: [naming('auditor-1-x', ['core/z'])] } })
    const [first, second] = revisions(engine)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('smoke, then targeted', [started(events, 'smoke'), started(events, 'targeted')], [[first], [second]])
    const drive = targetedOf(engine, second)
    t.eq('the finding\'s name ran', drive.targeted.tests, ['core/z'])
    t.eq('and the record says which finding', drive.targeted.sources, [{ from: 'finding', id: 'auditor-1-x', tests: ['core/z'] }])
    await releaseWorkspace(engine)
  }])

  sections.push(['AC-2: no usable names, no targeted drive: the smoke runs and says why', async (t) => {
    const cases = [
      ['no-named-tests', {}, [blocking('auditor-1-plain')]],
      ['unusable-name', {}, [naming('auditor-1-suite', ['worker/(suite)', 'core/a'])]],
      ['too-many', { maxTests: 1 }, [naming('auditor-1-many', ['core/a', 'core/b'])]]
    ]
    for (const [reason, targeted, own] of cases) {
      const { engine, events } = await scenario({ target: localDrive({ targeted }), findings: { 0: own } })
      const [first, second] = revisions(engine)
      t.eq(`${reason}: smoke on both revisions`, [started(events, 'smoke'), started(events, 'targeted')], [[first, second], []])
      t.eq(`${reason}: the record says why`, engine.run.checkResults.find((c) => c.revision === second && c.tier === 'smoke')?.targetedDeclined?.reason, reason)
      await releaseWorkspace(engine)
    }
    t.ok('a leading dash is no name', !usableTestName('--all'))
    t.ok('nor a control character', !usableTestName('a\nb'))
    t.ok('nor an overlong one', !usableTestName('a'.repeat(201)))
    t.ok('spaces and quotes are, once quoted', usableTestName('it\'s "a" test'))
  }])

  sections.push(['AC-2: a revision that only asked for a diagnostic drive has no drive, so the one before it still names the tests', async (t) => {
    const target = localDrive()
    const failed = { revision: 'a', tier: 'full', result: 'failed', gating: 'failed', dir: 'checks/1', namedFailures: [{ command: 'collect', test: 'core/a' }] }
    const run = { revisions: [{ fingerprint: 'a' }, { fingerprint: 'b' }, { fingerprint: 'c' }], checkHistory: [failed] }
    t.eq('the failed drive of the revision before it names them', selectTargeted({ target, run, revision: 'c' }).tests, ['core/a'])
    t.eq('and the record names that revision', selectTargeted({ target, run, revision: 'c' }).sources[0].revision, 'a')
    const passed = { revision: 'b', tier: 'smoke', result: 'passed', gating: 'passed' }
    t.eq('a later drive that passed supersedes it', selectTargeted({ target, run: { ...run, checkHistory: [failed, passed] }, revision: 'c' }).declined?.reason, 'no-named-tests')
  }])

  sections.push(['a named test no report shows as run makes the drive unavailable, never a pass; approval still drives the full tier', async (t) => {
    const { engine, events } = await scenario({ target: localDrive({ report: collect(), targeted: { run: IGNORING_TEMPLATE } }), findings: { 0: [naming('auditor-1-ghost', ['core/ghost'])] } })
    const [, second] = revisions(engine)
    const drive = targetedOf(engine, second)
    t.eq('unavailable, naming it', [drive.result, drive.targeted.missing], ['unavailable', ['core/ghost']])
    t.ok('the error says so', drive.error?.includes('core/ghost'), drive.error)
    t.eq('the full drive ran on approval', started(events, 'full'), [second])
    t.eq('the run completes on it', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }])

  sections.push(['AC-4, AC-5: a full failure after a targeted pass does not close, and the record names both', async (t) => {
    const { engine, events } = await scenario({ target: localDrive({ fails: { 'core/a': ONLY_ROUND_0, 'core/b': ONLY_ROUND_1 } }) })
    const [first, second, third] = revisions(engine)
    t.eq('three revisions: the targeted pass on the second did not close it', revisions(engine).length, 3)
    t.eq('targeted on each repair', started(events, 'targeted'), [second, third])
    t.eq('the full drive on all three', started(events, 'full'), [first, second, third])
    const history = (rev, tier) => engine.run.checkHistory.filter((h) => h.revision === rev && h.tier === tier).at(-1)
    t.eq('one miss on the record', engine.run.targetedMisses?.length, 1)
    const [miss] = engine.run.targetedMisses
    t.eq('it names the revision', miss.revision, second)
    t.eq('the targeted result', [miss.targeted.dir, miss.targeted.gating, miss.targeted.tests], [history(second, 'targeted').dir, 'passed', ['core/a']])
    t.eq('and the full drive', [miss.full.dir, miss.full.gating, miss.full.failures], [history(second, 'full').dir, 'failed', [{ command: 'collect', test: 'core/b' }]])
    t.ok('with the reason it failed', miss.full.reason?.includes('core/b'), miss.full.reason)
    t.ok('an event says so too', events.some((e) => e.type === 'targeted-missed' && e.revision === second))
    t.eq('the next repair runs what the full drive named', targetedOf(engine, third).targeted.tests, ['core/b'])
    t.eq('metrics measure it', runMetrics(engine.run).targeted, { drives: 2, passed: 2, failed: 0, unavailable: 0, confirmedByFull: 1, missedByFull: 1 })
    t.eq('the run completes on the third full drive', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }])

  sections.push(['a failed targeted drive returns the author and gets no full drive', async (t) => {
    const stubborn = '[ -f round-0.txt ] && [ ! -f round-2.txt ]'
    const { engine, events } = await scenario({ target: localDrive({ fails: { 'core/a': stubborn } }) })
    const [first, second, third] = revisions(engine)
    t.eq('the second revision\'s targeted drive failed', engine.run.checkHistory.find((h) => h.revision === second && h.tier === 'targeted')?.gating, 'failed')
    t.eq('no full drive for those bytes', started(events, 'full'), [first, third])
    t.eq('no miss: it did not pass', engine.run.targetedMisses ?? [], [])
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }])

  sections.push(['AC-4: a revision with only a targeted pass does not close', async (t) => {
    const prepare = (engine) => {
      const real = engine.maybeRunChecks.bind(engine)
      // The full drive never produces a result; the early tiers run as ever.
      engine.maybeRunChecks = async (options = {}) => options.tier ? real(options) : undefined
    }
    const { engine, events } = await scenario({ target: localDrive(), findings: { 0: [naming('auditor-1-x', ['core/a'])] }, prepare })
    const [, second] = revisions(engine)
    t.eq('the targeted drive passed', targetedOf(engine, second)?.result, 'passed')
    t.eq('no full drive ran', started(events, 'full'), [])
    t.ok('the run did not complete', engine.run.status !== 'completed', `${engine.run.status} ${engine.run.blockedReason}`)
    t.ok('closure did not count it', engine.run.closure?.conditions?.checksSatisfied !== true)
    t.eq('nor can its result be accepted as the full check', acceptableCheck(engine.run).check, null)
    await releaseWorkspace(engine).catch(() => {})
  }])

  sections.push(['AC-4: readers of the full drive do not read a targeted record as one', async (t) => {
    const rev = 'sha256:r'
    const targeted = { revision: rev, tier: 'targeted', result: 'failed', gating: 'failed', baselineComparison: { selftest: { unstable: [{ command: 'c', test: 't' }] } } }
    t.eq('selftest-history: its ignored failures are not closure\'s', ignoredSelftests({ revisions: [{ fingerprint: rev }], checkResults: [targeted] }), [])
    const run = { status: 'blocked', blockedReason: 'rounds-exhausted', revisions: [{ fingerprint: rev }], checkHistory: [targeted], checkResults: [targeted], steps: [], participants: {}, approvals: [] }
    t.ok('run-explanation: the full drive never ran, and why', explainRun(run).detail?.includes('The full drive never ran on the last revision: its targeted tier failed.'), explainRun(run).detail)
    const awaited = { ...run, outstandingFindings: [{ id: 'x', awaitsCheck: true }] }
    t.ok('run-explanation: a failed targeted drive is not the drive a finding awaited', !explainRun(awaited).headline?.includes('only awaited the drive'), explainRun(awaited).headline)
    const summary = checkSummary({ revision: rev, tier: 'targeted', result: 'passed', targeted: { tests: ['core/a'] } })
    t.ok('the summary does not call it the full drive', summary.tierNote.startsWith('Targeted tier') && !summary.tierNote.includes('Full drive'), summary.tierNote)
    t.eq('and names its tests', summary.targeted.tests, ['core/a'])
  }])

  sections.push(['a targeted pass does not make the full drive\'s failure of that test read as unstable on the same bytes', async (t) => {
    const fullOnly = `${ONLY_ROUND_0} || { ${ONLY_ROUND_1} && grep -q core/b named.txt; }`
    const { engine } = await scenario({ target: localDrive({ fails: { 'core/a': fullOnly } }) })
    const [, second] = revisions(engine)
    const full = engine.run.checkHistory.find((h) => h.revision === second && h.tier === 'full')
    t.eq('the targeted drive passed core/a on these bytes', engine.run.checkHistory.find((h) => h.revision === second && h.tier === 'targeted')?.gating, 'passed')
    t.eq('the full drive\'s failure of it still gates', [full.gating, full.namedFailures], ['failed', [{ command: 'collect', test: 'core/a' }]])
    t.eq('no failure was ignored', full.unstableIgnored ?? [], [])
    t.eq('the miss is recorded', engine.run.targetedMisses?.[0]?.full.failures, [{ command: 'collect', test: 'core/a' }])
    await releaseWorkspace(engine)
  }])

  sections.push(['a restart keeps the revision\'s decision', async (t) => {
    const hooks = { beforeInvoke: async (x) => {
      if (x.run.revisions.length < 2 || !Object.values(x.run.participants).some((p) => p.pendingInvocation?.cursor?.stepId?.startsWith('audit-'))) return
      delete x.hooks.beforeInvoke
      throw Object.assign(new Error('owner crashed'), { injected: true })
    } }
    const { engine, f } = await scenario({ target: localDrive(), findings: { 0: [naming('auditor-1-x', ['core/z'])] }, hooks })
    const second = engine.run.revisions[1].fingerprint
    t.eq('the decision is on the record', engine.run.targetedSelections?.[second]?.tests, ['core/z'])
    await simulateProcessDeath(f.issuePath)
    const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
    f.state.engine = resumed
    await resumed.recover()
    // What the decision read has moved on, and the drive is lost: it runs again as decided.
    resumed.run.outstandingFindings = []
    resumed.run.checkResults = resumed.run.checkResults.filter((c) => c.tier !== 'targeted')
    await resumed.drive()
    const { events } = await readEvents(f.issuePath, engine.runId)
    t.eq('the resumed run completes', resumed.run.status, 'completed', `${resumed.run.blockedReason}`)
    t.eq('the same tests, driven again, with no smoke for those bytes', [started(events, 'targeted'), started(events, 'smoke').includes(second), targetedOf(resumed, second)?.targeted.tests], [[second, second], false, ['core/z']])
    await releaseWorkspace(resumed)
  }])

  sections.push(['an author answering with the same bytes gets no new drive', async (t) => {
    const { engine, events } = await scenario({ target: localDrive({ fails: { 'core/a': '[ -f round-0.txt ]' } }), unchanged: new Set([1]) })
    t.eq('the loop stops on the unchanged answer', engine.run.blockedReason, 'checks-failed-unchanged', `${engine.run.status}`)
    t.eq('no targeted drive', started(events, 'targeted'), [])
    t.eq('no decision', engine.run.targetedSelections ?? null, null)
    await releaseWorkspace(engine).catch(() => {})
  }])

  sections.push(['AC-6: not declared, the same checks at the same points, and nothing new on the record', async (t) => {
    const fails = { 'core/a': ONLY_ROUND_0 }
    const { engine, events } = await scenario({ target: localDrive({ declare: false, fails }), findings: { 1: [naming('auditor-1-x', ['core/z'])] } })
    const [first, second, third] = revisions(engine)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the smoke on every revision', started(events, 'smoke'), [first, second, third])
    t.eq('the full drive after each approval', started(events, 'full'), [first, third])
    t.eq('no targeted drive', started(events, 'targeted'), [])
    t.eq('no new fields on the run', [engine.run.targetedSelections, engine.run.targetedMisses], [undefined, undefined])
    t.ok('nor on its history', engine.run.checkHistory.every((h) => !('namedFailures' in h) && !('targeted' in h) && !('targetedDeclined' in h)))
    t.eq('metrics say nothing of it', runMetrics(engine.run).targeted, undefined)
    await releaseWorkspace(engine)
    const declared = localDrive({ fails })
    const plain = localDrive({ fails, declare: false })
    for (const tier of ['smoke', 'full']) t.eq(`the ${tier} tier's target, and so its key, is the same with or without the declaration`, JSON.stringify(tierTarget(declared, tier)), JSON.stringify(tierTarget(plain, tier)))
    t.eq('no decision is made for it', selectTargeted({ target: plain, run: { revisions: [{ fingerprint: 'a' }, { fingerprint: 'b' }], outstandingFindings: [naming('x', ['core/a'])] }, revision: 'b' }), null)
  }])

  /*
   * The SSH path, on the fake remote manager check-tiers.test.mjs uses: a name
   * arrives byte for byte through every quoting layer, and the full drive after
   * a targeted one has no instance to continue.
   */
  const sshDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-targeted-ssh-')))
  const managerEnv = await installRemoteManager(sshDir)
  await fs.mkdir(path.join(sshDir, 'units'))
  await fs.writeFile(path.join(sshDir, 'units', 'no-fence'), '')
  await fs.writeFile(path.join(sshDir, 'ssh'), ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join('\n') + '\n', { mode: 0o755 })
  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.CHECK_TEST_HOST }
  process.env.DEVPANEL_SSH_BIN = path.join(sshDir, 'ssh')
  process.env.CHECK_TEST_HOST = 'shim'
  const hostile = async (dir) => {
    const pwned = path.join(dir, 'pwned')
    // Relative, to stay under the name limit: the drive's next command looks for it in the same directory.
    const test = `it's "a" $(touch ran-a) \`touch ran-b\` $& b`
    const out = path.join(dir, 'names')
    const reportFile = path.join(dir, 'report.json')
    await fs.writeFile(reportFile, JSON.stringify({ tests: [{ test }] }) + '\n')
    const printer = await script(dir, 'print-names', recordArgs(out))
    return { pwned, test, out, report: `if [ -e ran-a ] || [ -e ran-b ]; then touch ${pwned}; fi; echo "== runtime/selftest.report"; cat ${reportFile}`, template: `${printer} {{tests}}` }
  }
  const exists = (file) => fs.access(file).then(() => true, () => false)

  try {
    sections.push(['AC-2: a hostile name reaches a local command byte for byte and runs nothing', async (t) => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-targeted-local-')))
      const { pwned, test, out, report, template } = await hostile(dir)
      const { engine } = await scenario({ target: localDrive({ report, selftests: 'true', targeted: { run: template } }), findings: { 0: [naming('auditor-1-x', [test])] } })
      t.eq('the command got exactly the name', await fs.readFile(out, 'utf8'), `${test}\n`)
      t.eq('nothing in it ran', await exists(pwned), false)
      t.eq('the report proved it ran', targetedOf(engine, engine.run.revisions[1].fingerprint)?.result, 'passed')
      await releaseWorkspace(engine)
      await fs.rm(dir, { recursive: true, force: true })
    }])

    sections.push(['AC-2: and over SSH; the full drive that follows runs from scratch and says why', async (t) => {
      const { pwned, test, out, report, template } = await hostile(sshDir)
      const workdir = await fs.realpath(await fs.mkdtemp(path.join(sshDir, 'remote-')))
      const cmd = (id, run = 'true', extra = {}) => ({ id, kind: 'candidate', run, ...extra })
      const target = {
        kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, retryFailed: 0, confinement: { user: os.userInfo().username, home: os.homedir() },
        tiers: { smoke: ['prepare', 'start'], targeted: { command: 'selftests', run: template, always: ['prepare', 'start', 'collect'] } },
        commands: [cmd('prepare'), cmd('start', 'exec sleep 120', { service: true }), cmd('selftests'), cmd('collect', report, { report: 'selftest' }), cmd('deep')]
      }
      const { engine, events } = await scenario({ target, findings: { 0: [naming('auditor-1-x', [test])] } })
      const second = engine.run.revisions[1]?.fingerprint
      t.eq('the targeted drive ran', started(events, 'targeted'), [second])
      t.eq('its command got exactly the name', await fs.readFile(out, 'utf8'), `${test}\n`)
      t.eq('nothing in it ran', await exists(pwned), false)
      const drive = targetedOf(engine, second)
      t.eq('it passed, keeping no instance', [drive?.result, drive?.kept ?? null], ['passed', null])
      const full = engine.run.checkResults.filter((c) => c.revision === second && c.tier === 'full').at(-1)
      t.eq('the full drive did not continue anything', [full?.continuedFrom ?? null, full?.continuation?.reason], [null, 'smoke-not-kept'])
      t.ok('and says the targeted tier ran instead', full?.continuation?.detail?.includes('targeted tier'), JSON.stringify(full?.continuation))
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      await releaseWorkspace(engine)
    }])

    await overlappingSections(t, sections)
  } finally {
    process.env.DEVPANEL_SSH_BIN = saved.bin; process.env.CHECK_TEST_HOST = saved.host
    if (saved.bin === undefined) delete process.env.DEVPANEL_SSH_BIN
    if (saved.host === undefined) delete process.env.CHECK_TEST_HOST
    for (const name of await fs.readdir(path.join(sshDir, 'units')).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const { pid } = JSON.parse(await fs.readFile(path.join(sshDir, 'units', name), 'utf8').catch(() => '{}'))
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    await fs.rm(sshDir, { recursive: true, force: true })
    await fs.rm(helpers, { recursive: true, force: true })
  }
}
