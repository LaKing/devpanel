import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { readCheckLog } from '../server/runtime/check-log.mjs'
import { plan } from '../server/runtime/engine.mjs'
import { FENCE_NOTICES } from '../server/runtime/remote-check-process.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { checksOnlyBlock } from '../server/runtime/run-control.mjs'

export const name = 'check timing — a failed check is retried on the same revision; approved-only targets skip rejected revisions'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

/*
 * `reject` rounds get a blocking finding from every reviewer; `check` is the
 * local command. Returns what the reviewers saw and what the engine recorded.
 */
async function scenario ({ check, command = '', target = '', reject = new Set(), requirement = 'required', auditor = 'gpt-6-astra', awaits = null, steady = false, more = new Set(), cap = null, isolation = null }) {
  const log = []
  const implementPrompts = []
  const coordinatorPrompts = []
  const confirmPrompts = []
  let engine = null
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    // A coordinator told which criteria only the approval-timed checks can
    // prove names them in its handoff, on either brief path.
    const named = (p) => p.includes('name the acceptance criteria only those checks can prove') ? ' Only the checks can prove: AC1.' : ''
    if (stepId === 'triage' && awaits) {
      coordinatorPrompts.push(prompt)
      const triage = JSON.parse(scriptFor()(turn).match(/```json\n([\s\S]*?)\n```/)[1])
      return fence({ ...triage, firstHandoff: { targetRole: 'implementer', prompt: `Do the work.${named(prompt)}`, windowDecision: 'keep' } })
    }
    if (stepId.startsWith('brief')) {
      coordinatorPrompts.push(prompt)
      return fence({ targetRole: 'worker', prompt: `Do the work.${named(prompt)}`, windowDecision: 'keep' })
    }
    if (stepId === 'implement') {
      implementPrompts.push(prompt)
      // `steady`: the work is done in the first round and later rounds hand it over unchanged.
      await fs.writeFile(path.join(engine.run.workspace.path, steady ? 'work.txt' : `round-${round}.txt`), 'work\n')
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      log.push({ role, round, checksRunning: Boolean(engine.checksInFlight), recheck: prompt.includes('Re-review of revision'), gating: /"gating":"(\w+)"/.exec(prompt)?.[1] ?? null, previousDrive: prompt.includes('"previousDrive"') })
      // `awaits(prompt)`: the auditor still needs evidence only the check produces.
      if (awaits?.(prompt, round)) return fence({ verdict: 'changes-needed', artifactRevision: revision(prompt), findings: [{ ...blocking(`${role}-drive-${round}`), awaitsCheck: true }, ...(reject.has(round) ? [blocking(`${role}-${round}`)] : []), ...(more.has(round) ? [blocking(`${role}-more-${round}`)] : [])], priorFindings: [] })
      if (reject.has(round)) return fence({ verdict: 'changes-needed', artifactRevision: revision(prompt), findings: [blocking(`${role}-${round}`)], priorFindings: [] })
      return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    }
    if (stepId === 'confirm') {
      confirmPrompts.push(prompt)
      return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    }
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  const playbookFile = path.join(f.configRoot, 'playbooks/implementation.yaml')
  // No `check`: the playbook configures no drive at all.
  if (check != null) await fs.appendFile(playbookFile,
    `\nchecks:\n  requirement: ${requirement}\n  target:\n    kind: local\n${target}    commands:\n      - id: probe\n        run: ${JSON.stringify(check)}\n${command}`)
  if (cap != null) await fs.writeFile(playbookFile, (await fs.readFile(playbookFile, 'utf8')).replace('budgets:\n', `overrides:\n  implement-review.maxRounds: ${cap}\nbudgets:\n`))
  const runOptions = { participants: { 'auditor-1': auditor ? { model: auditor } : null }, ...(isolation ? { isolation } : {}) }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, log, events, implementPrompts, coordinatorPrompts, confirmPrompts }
}

/*
 * Replay: plan() over the steps recorded up to `upTo` (exclusive) with the
 * check evidence on record, as a restarted engine would derive it.
 */
const replay = (engine, upTo = Infinity) =>
  plan(engine.snapshot, engine.activeSteps().filter((s) => Number(s.number) < upTo), engine.outputs, { checkResults: engine.checkEvidence() })

const counter = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-flaky-')), 'n')
// Fails on its first execution only: a flaky test on identical bytes.
const flaky = (file) => `n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; test "$n" -ge 1`

// A playbook with no review loop (Prompt): `timing: approved` has nothing to wait for.
async function promptRun ({ requirement }) {
  let engine = null
  const f = await engineFixture({ playbook: 'prompt' })
  const original = f.fake.invoke
  f.fake.invoke = async (args) => {
    if (args.meta.stepId === 'execute') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'changed\n')
    return original(args)
  }
  await fs.appendFile(path.join(f.configRoot, 'playbooks/prompt.yaml'),
    // Fails on the candidate only (the base's source.txt is unchanged): not baseline-known.
    `\nchecks:\n  requirement: ${requirement}\n  target:\n    kind: local\n    timing: approved\n    retryFailed: 0\n    commands:\n      - id: probe\n        run: "! grep -qx changed source.txt"\n`)
  const resolved = await resolvePlaybook('prompt', { root: f.configRoot, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'prompt', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
  })
  await engine.drive()
  return engine
}

export default async function (t) {
  t.section('timing: approved on a playbook without a review loop still checks the revision')
  for (const requirement of ['required', 'optional']) {
    const engine = await promptRun({ requirement })
    t.eq(`${requirement}: the revision was checked`, engine.run.checkResults.at(-1)?.result, 'failed')
    t.eq(`${requirement}: the failure is not delivered`, engine.run.status === 'completed', false, `${engine.run.status} ${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }

  t.section('a check that fails once and then passes on the same revision costs no extra round')
  {
    const { engine, events } = await scenario({ check: flaky(await counter()) })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('one implementation round', engine.run.revisions.length, 1)
    const last = engine.run.checkResults.at(-1)
    t.eq('the check passed', last?.result, 'passed')
    t.eq('marked flaky', last?.flaky, true)
    t.eq('the failed attempt is on the record', last?.attempts?.map((a) => a.result), ['failed'])
    t.eq('the retry is an event', events.filter((e) => e.type === 'checks-retry').length, 1)
    const first = last.attempts[0].dir.split('/')[1]
    const log = await readCheckLog({ issuePath: engine.issuePath, runId: engine.runId, check: first, command: 'probe' }).catch((e) => ({ error: e.message }))
    t.eq('the failed attempt\'s log stays readable', log.result ?? log.error, 'failed')
    await releaseWorkspace(engine)
  }

  t.section('a retry that cannot run leaves the failure standing')
  {
    const file = await counter()
    // Attempt 1 fails; attempt 2 edits the candidate, so it is unavailable; the next revision passes.
    const check = `n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; if [ "$n" = 1 ]; then echo x >> source.txt; fi; test "$n" -ge 1`
    const { engine } = await scenario({ check, target: '', requirement: 'optional' })
    t.eq('the first revision counts as failed', engine.run.checkHistory?.[0]?.result, 'failed')
    const events = (await readEvents(engine.issuePath, engine.runId)).events
    t.eq('one retry was attempted', events.filter((e) => e.type === 'checks-retry').length, 1)
    t.eq('another revision followed', engine.run.revisions.length, 2)
    t.eq('so the author got another round', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }

  // Candidate drives counted outside the candidate: round-N.txt marks the revision, and the base has none.
  // The first two revisions fail as `fail` says, the third passes.
  // `onBase` is what the base does instead of passing.
  const repeated = async (fail, { onBase = null } = {}) => {
    const file = await counter()
    const count = `echo x >> ${file}`
    return { file, check: `if test -f round-2.txt; then ${count}; exit 0; fi; if test -f round-0.txt; then ${count}; ${fail}; fi${onBase ? `; ${onBase}` : ''}` }
  }
  const drives = async (file) => (await fs.readFile(file, 'utf8')).split('\n').length - 1
  const SHORT = '        timeoutSeconds: 1\n'
  const byType = (events, type) => events.filter((e) => e.type === type)
  const retries = (events) => [byType(events, 'checks-retry').length, byType(events, 'checks-retry-skipped').length]

  t.section('AC2, timeout: a silent timeout an earlier revision already had, the base passing, is not driven again')
  {
    const { file, check } = await repeated('sleep 30')
    const { engine, events } = await scenario({ check, command: SHORT })
    t.eq('three revisions, and the run completes', [engine.run.revisions.length, engine.run.status], [3, 'completed'], `${engine.run.blockedReason}`)
    t.eq('first occurrence retried, repeat not, the pass once: four candidate drives', await drives(file), 4)
    t.eq('only the first revision has a checks-retry', byType(events, 'checks-retry').map((e) => e.revision), [engine.run.revisions[0].fingerprint])
    t.eq('the skip is on the journal for the second revision, naming the first', byType(events, 'checks-retry-skipped').map((e) => [e.revision, e.reason, e.commands[0].way, e.commands[0].revision]),
      [[engine.run.revisions[1].fingerprint, 'failed-same-way', 'timeout-no-output', engine.run.revisions[0].fingerprint]])
    const onDisk = JSON.parse(await fs.readFile(path.join(engine.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
    t.eq('the evidence is durable, so replay and resume read the same', onDisk.checkHistory.map((h) => h.retryEvidence.failures.map((f) => f.way)), [['timeout-no-output'], ['timeout-no-output'], []])
    await releaseWorkspace(engine)
  }

  t.section('AC2, crash signature: the same crash an earlier revision had, the base passing, is not driven again')
  {
    // The pid differs in every drive; six restarts print one distinct line.
    const { file, check } = await repeated('for i in 1 2 3 4 5 6; do echo "thread admin crashed (pid $$, restart $i): namespace cycle"; done; exit 1')
    const { engine, events } = await scenario({ check })
    t.eq('three revisions, and the run completes', [engine.run.revisions.length, engine.run.status], [3, 'completed'], `${engine.run.blockedReason}`)
    t.eq('four candidate drives', await drives(file), 4)
    t.eq('one retry, one skip', retries(events), [1, 1])
    t.eq('the skip names the crash line', byType(events, 'checks-retry-skipped')[0].commands[0].marker.startsWith('thread admin crashed'), true)
    await releaseWorkspace(engine)
  }

  t.section('AC3: a repeated timeout whose base hung too is retried on every revision')
  {
    const { file, check } = await repeated('sleep 30', { onBase: 'sleep 30' })
    const { engine, events } = await scenario({ check, command: SHORT })
    t.eq('the base timed out as well', engine.run.baselineChecks?.[0]?.commands?.[0]?.timedOut, true)
    t.eq('both failing revisions got their retry, no skip', retries(events), [2, 0])
    t.eq('five candidate drives', await drives(file), 5)
    await releaseWorkspace(engine)
  }

  t.section('AC3: a repeated crash whose base crashed too is retried on every revision')
  {
    // Not the base's own failure byte for byte: that would be inherited and pass the gate.
    const { file, check } = await repeated('echo "thread admin crashed"; exit 1', { onBase: 'echo "base broke"; exit 1' })
    const { engine, events } = await scenario({ check })
    t.eq('both failing revisions got their retry, no skip', retries(events), [2, 0])
    t.eq('five candidate drives', await drives(file), 5)
    await releaseWorkspace(engine)
  }

  t.section('AC2 and AC3: the launcher\'s fence notice is not output, and real output beside it is')
  for (const [variant, notice] of Object.entries(FENCE_NOTICES)) {
    const silent = await repeated(`echo "${notice}" >&2; sleep 30`)
    const quiet = await scenario({ check: silent.check, command: SHORT })
    const failedDir = byType(quiet.events, 'checks-retry')[0]?.failedDir
    const log = await fs.readFile(path.join(quiet.engine.issuePath, 'runs', quiet.engine.runId, failedDir, 'probe.log'), 'utf8')
    t.ok(`${variant}: the drive's log holds the notice`, log.includes(notice))
    t.eq(`${variant} alone: the identity is kept`, quiet.engine.run.checkHistory[0].retryEvidence.failures.map((f) => f.way), ['timeout-no-output'])
    t.eq(`${variant} alone: first occurrence retried, the later revision not`, [retries(quiet.events), await drives(silent.file)], [[1, 1], 4])
    await releaseWorkspace(quiet.engine)
    const printed = await repeated(`echo "${notice}" >&2; echo progress; sleep 30`)
    const noisy = await scenario({ check: printed.check, command: SHORT })
    t.eq(`${variant} with real output: both revisions get their retry`, [retries(noisy.events), await drives(printed.file)], [[2, 0], 5])
    await releaseWorkspace(noisy.engine)
  }

  t.section('AC3: another crash, an ordinary failure and a timeout that printed something are retried')
  {
    const cases = {
      'another crash signature': [await repeated('if test -f round-1.txt; then echo "thread worker crashed"; else echo "thread admin crashed"; fi; exit 1'), ''],
      'an ordinary failure repeated': [await repeated('echo "expected 1 got 2"; exit 1'), ''],
      'a timeout that printed something': [await repeated('echo progress; sleep 30'), SHORT]
    }
    for (const [label, [{ check }, command]] of Object.entries(cases)) {
      const { engine, events } = await scenario({ check, command })
      t.eq(label, retries(events), [2, 0])
      await releaseWorkspace(engine)
    }
  }

  t.section('AC3: a timeout a retry cleared on the earlier revision is instability, and is retried')
  {
    const file = await counter()
    // Candidate drive 1 hangs, 2 passes (flaky); the next revision's drive 3 hangs and 4 passes. The base is known throughout.
    const check = `if ! test -f round-0.txt; then exit 0; fi; n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; if [ "$n" = 0 ] || [ "$n" = 2 ]; then sleep 30; fi`
    const { engine, events } = await scenario({ check, command: SHORT, target: '    compareBaseline: true\n', reject: new Set([0]) })
    t.eq('two revisions, the run completes', [engine.run.revisions.length, engine.run.status], [2, 'completed'], `${engine.run.blockedReason}`)
    t.eq('both timeouts got their retry', retries(events), [2, 0])
    t.eq('the second passes as flaky', engine.run.checkResults.at(-1)?.flaky, true)
    await releaseWorkspace(engine)
  }

  t.section('retryFailed: 0 keeps the old behaviour — the failure counts at once')
  {
    const { engine } = await scenario({ check: flaky(await counter()), target: '    retryFailed: 0\n' })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the failure sent the author another round', engine.run.revisions.length, 2)
    await releaseWorkspace(engine)
  }

  t.section('timing: approved checks only the revision the reviewers approved')
  {
    const { engine, log, events } = await scenario({ check: 'true', target: '    timing: approved\n', reject: new Set([0]) })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('two revisions', engine.run.revisions.length, 2)
    const checked = events.filter((e) => e.type === 'checks-started').map((e) => e.revision)
    t.eq('only the approved revision was checked', checked, [engine.run.revisions[1].fingerprint])
    t.ok('no review ran beside a check', log.every((a) => !a.checksRunning), JSON.stringify(log))
    t.eq('closure saw the passing check', engine.run.closure?.conditions?.checksSatisfied, true)
    await releaseWorkspace(engine)
  }

  t.section('timing: approved with every reviewer seat empty still checks each revision')
  for (const requirement of ['required', 'optional']) {
    // Fails on the candidate only (the base has no round-0.txt): not baseline-known.
    const { engine } = await scenario({ check: 'test ! -f round-0.txt', target: '    timing: approved\n    retryFailed: 0\n', requirement, auditor: null })
    t.eq(`${requirement}: the revision was checked`, engine.run.checkHistory?.[0]?.result, 'failed')
    t.eq(`${requirement}: the failure is not delivered as resolved`, engine.run.outcome === 'resolved' && engine.run.checkResults.at(-1)?.result !== 'passed', false, `${engine.run.status} ${engine.run.blockedReason}`)
    await releaseWorkspace(engine).catch(() => {})
  }

  t.section('timing: approved — a failing check on the approved revision still sends the author back')
  {
    const file = await counter()
    // Fails for the first revision (both attempts), passes afterwards.
    const check = `n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; test "$n" -ge 2`
    const { engine, events } = await scenario({ check, target: '    timing: approved\n' })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the failure cost one more round', engine.run.revisions.length, 2)
    t.eq('first revision: failed, retried, failed', engine.run.checkHistory?.[0]?.result, 'failed')
    t.eq('three check executions in all', events.filter((e) => e.type === 'checks-started').length + events.filter((e) => e.type === 'checks-retry').length, 3)
    await releaseWorkspace(engine)
  }

  // The deadlock: a criterion only the test drive can prove. The auditor will
  // not approve without the drive's result, and the drive waited for approval.
  const checkedPassed = (p) => new RegExp(`"revision":\\s*"${revision(p)}"[^{}]*"result":\\s*"passed"`).test(p)
  t.section('timing: approved — an auditor blocking only on the check\'s evidence gets the check')
  {
    const { engine, log, events, implementPrompts, coordinatorPrompts } = await scenario({ check: 'true', target: '    timing: approved\n', steady: true, awaits: (p) => !checkedPassed(p) })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    const checked = events.filter((e) => e.type === 'checks-started').map((e) => e.revision)
    t.eq('the unapproved revision was checked, once', checked, [engine.run.revisions[0].fingerprint])
    t.eq('before any approval', engine.run.checkHistory?.[0]?.afterApproval, false)
    t.eq('the auditor reviewed again in the same round, once the drive passed', log.map((a) => [a.round, a.recheck]), [[0, false], [0, true]])
    t.eq('the re-review carried the drive\'s gating', log[1]?.gating, 'passed')
    t.eq('no author turn after the first', engine.run.steps.filter((s) => s.stepId === 'implement').length, 1)
    t.eq('no brief after triage\'s', engine.run.steps.filter((s) => s.stepId === 'brief-implement').map((s) => s.round), [0])
    const audits = engine.run.steps.filter((s) => s.stepId === 'audit-implement-1')
    t.eq('the re-review is recorded on round 0 against the revision', audits.map((s) => [s.round, s.attempt, s.recheck ?? null]), [[0, 1, null], [0, 1, engine.run.revisions[0].fingerprint]])
    t.eq('the approval is the re-review\'s', engine.run.approvals.map((a) => a.step), [audits[1].number])
    const before = replay(engine, Number(audits[1].number))
    t.eq('replay before the re-review asks for it', [before.kind, before.step?.id, before.round, before.recheck], ['turn', 'audit-implement-1', 0, engine.run.revisions[0].fingerprint])
    const after = replay(engine, Number(audits[1].number) + 1)
    t.eq('replay after it does not ask again: the round passed', [after.kind, after.step?.id], ['turn', 'confirm'])
    t.eq('replay of the whole run ends it', [replay(engine).kind, replay(engine).reason], ['terminal', 'complete'])
    t.ok('the author was told the check waits for approval', implementPrompts.every((p) => p.includes('do not hand over an unchanged revision to wait for the checks')))
    t.ok('triage was told to name the check-only criteria in its first handoff', coordinatorPrompts[0]?.includes('In the firstHandoff prompt, name the acceptance criteria only those checks can prove'))
    // Round 0's brief is triage's firstHandoff, adopted without a brief turn.
    t.eq('the first brief came from triage', coordinatorPrompts.length, 1 + engine.run.steps.filter((s) => s.stepId === 'brief-implement' && s.round > 0).length)
    t.ok('every brief the author received names the check-only criterion', implementPrompts.length > 0 && implementPrompts.every((p) => p.includes('Only the checks can prove: AC1.')), implementPrompts.map((p) => p.includes('Only the checks can prove: AC1.')).join(','))
    t.eq('closure saw the passing check on the approved revision', engine.run.closure?.conditions?.checksSatisfied, true)
    await releaseWorkspace(engine)
  }

  t.section('timing: approved — a check run for an awaiting auditor that fails sends the author back; the next revision is checked again')
  {
    // Fails on the first revision only (round-0.txt alone), passes once round-1.txt exists.
    // The base has neither, so it passes there: the failure is the candidate's, not inherited.
    const { engine, events } = await scenario({ check: 'test -f round-1.txt || test ! -f round-0.txt', target: '    timing: approved\n    retryFailed: 0\n', awaits: (p, round) => round < 2 && !checkedPassed(p) })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    const checked = events.filter((e) => e.type === 'checks-started').map((e) => e.revision)
    t.eq('each revision checked once', checked, engine.run.revisions.map((r) => r.fingerprint))
    t.eq('the first failed, the second passed before approval', engine.run.checkHistory?.slice(0, 2).map((h) => [h.result, h.afterApproval]), [['failed', false], ['passed', false]])
    const audits = engine.run.steps.filter((s) => s.stepId === 'audit-implement-1')
    t.eq('the failed drive got no re-review; the passed one did, in its round', audits.map((s) => [s.round, Boolean(s.recheck)]), [[0, false], [1, false], [1, true]])
    t.eq('the failed round sent the author back', engine.run.steps.filter((s) => s.stepId === 'implement').map((s) => s.round), [0, 1])
    const next = replay(engine, Number(audits[0].number) + 1)
    t.eq('replay after the failed drive: the round is changes-needed and the author is briefed', [next.kind, next.step?.id, next.round, next.recheck ?? null], ['turn', 'brief-implement', 1, null])
    t.eq('replay of the whole run ends it', replay(engine).reason, 'complete')
    await releaseWorkspace(engine)
  }

  t.section('timing: approved — an ordinary blocking finding beside an awaiting one does not run the check')
  {
    const { engine, events } = await scenario({ check: 'true', target: '    timing: approved\n', reject: new Set([0]), awaits: (p, round) => round === 0 })
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('only the approved revision was checked', events.filter((e) => e.type === 'checks-started').map((e) => e.revision), [engine.run.revisions.at(-1).fingerprint])
    await releaseWorkspace(engine)
  }

  // The reported shape: a smoke beside every review, the full drive waiting.
  const TIERS = '    tiers:\n      smoke: [probe]\n'
  const TIERS_ONCE = `    retryFailed: 0\n${TIERS}`
  const DEEP = '      - id: deep\n        run: "true"\n'
  // Awaits until the drive's result is quoted in a re-review.
  const untilRereview = (p) => !p.includes('Re-review of revision')
  const fullDrives = async (engine) => (await readEvents(engine.issuePath, engine.runId)).events.filter((e) => e.type === 'checks-started' && e.tier === 'full').map((e) => e.revision)
  const revisionsOf = (engine) => engine.run.revisions.map((r) => r.fingerprint)
  const stopped = (engine) => `${engine.run.status}/${engine.run.blockedReason}`
  const fullOf = (engine, rev) => engine.run.checkHistory.find((h) => h.revision === rev && h.tier === 'full')?.result
  const FULL_LATEST = /"tier":\s*"full"/

  t.section('one-round resumes: each round holds a new finding beside an awaited one, and the awaited finding still reaches the full drive')
  {
    const { engine, log, coordinatorPrompts, implementPrompts } = await scenario({ check: 'true', command: DEEP, target: TIERS, cap: 2, reject: new Set([0, 1, 2, 3]), awaits: untilRereview })
    t.eq('the cap stops it', stopped(engine), 'blocked/rounds-exhausted')
    const [, second] = revisionsOf(engine)
    t.eq('only the last allowed round was driven, before the loop ended', await fullDrives(engine), [second])
    t.eq('and its result is on the record for the next resume', fullOf(engine, second), 'passed')
    t.ok('the explanation says the drive ran', explainRun(engine.run).detail.includes('The full drive ran on the last revision and passed'), explainRun(engine.run).detail)

    const steps = engine.activeSteps()
    t.eq('replay without the drive on record asks for it', [plan(engine.snapshot, steps, engine.outputs, { checkResults: [] }).kind, plan(engine.snapshot, steps, engine.outputs, { checkResults: [] }).revision], ['checks', second])
    t.eq('replay with it ends the loop', [replay(engine).kind, replay(engine).reason], ['terminal', 'rounds-exhausted'])
    const resumedOnce = structuredClone(engine.snapshot)
    resumedOnce.phases.find((p) => p.id === 'implement-review').loop.maxRounds = 3
    const onward = plan(resumedOnce, steps, engine.outputs, { checkResults: [] })
    t.eq('a recorded round exhausted without a drive gets none on Resume: the next brief comes', [onward.kind, onward.step?.id, onward.round], ['turn', 'brief-implement', 2])

    for (const round of [2, 3]) {
      await engine.resumeExecution()
      await engine.drive()
      t.eq(`resume ${round - 1}: exactly one more round, stopped again`, [stopped(engine), engine.run.revisions.length], ['blocked/rounds-exhausted', round + 1])
      t.eq(`resume ${round - 1}: one more drive, on that round's revision`, await fullDrives(engine), revisionsOf(engine).slice(1))
      t.ok(`resume ${round - 1}: its brief carried the previous revision's drive`, FULL_LATEST.test(coordinatorPrompts.at(-1)))
      t.ok(`resume ${round - 1}: and so did its author`, FULL_LATEST.test(implementPrompts.at(-1)))
    }
    await engine.resumeExecution()
    await engine.drive()
    t.eq('the last round holds only the awaited finding: it gets its drive and its re-review, and the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the awaited finding reached a full-drive result on every revision from the first stop on', await fullDrives(engine), revisionsOf(engine).slice(1))
    t.eq('every audit after a drive was told what that drive said', log.filter((a) => !a.recheck).map((a) => [a.round, a.previousDrive]), [[0, false], [1, false], [2, true], [3, true], [4, true]])
    t.eq('a mixed round gets no re-review; the all-awaiting one does', log.filter((a) => a.recheck).map((a) => a.round), [4])
    await releaseWorkspace(engine)
  }

  t.section('the last allowed round: a failed smoke does not exempt an awaited finding from the drive')
  {
    const marker = await counter()
    // The second revision's first drive fails: that is its smoke; the full drive of the same bytes passes.
    const check = `test ! -f round-1.txt || test -f ${marker} || { touch ${marker}; false; }`
    const { engine, coordinatorPrompts, implementPrompts } = await scenario({ check, command: DEEP, target: TIERS_ONCE, cap: 2, reject: new Set([0, 1]), awaits: (p, round) => round < 2 })
    const [, second] = revisionsOf(engine)
    t.eq('the cap stops it', stopped(engine), 'blocked/rounds-exhausted')
    t.eq('the smoke failed on that revision', engine.run.checkHistory.find((h) => h.revision === second && h.tier === 'smoke')?.result, 'failed')
    t.eq('the full drive ran on it, once, and passed', [await fullDrives(engine), fullOf(engine, second)], [[second], 'passed'])
    t.ok('the explanation names both', explainRun(engine.run).detail.includes('ran on the last revision after its smoke failed and passed'), explainRun(engine.run).detail)
    await engine.resumeExecution()
    await engine.drive()
    t.eq('the next round approved and the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.ok('the next brief carried the drive and the failed smoke', FULL_LATEST.test(coordinatorPrompts.at(-1)) && coordinatorPrompts.at(-1).includes('"failedSmoke"'))
    t.ok('and so did the author', FULL_LATEST.test(implementPrompts.at(-1)) && implementPrompts.at(-1).includes('"failedSmoke"'))
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await scenario({ check: 'test ! -f round-1.txt', command: DEEP, target: TIERS_ONCE, cap: 2, reject: new Set([0, 1]), awaits: () => true })
    const [, second] = revisionsOf(engine)
    t.eq('a drive that fails too ends the loop, one drive, no second try', [stopped(engine), await fullDrives(engine), fullOf(engine, second)], ['blocked/rounds-exhausted', [second], 'failed'])
    t.ok('and the explanation says so', explainRun(engine.run).detail.includes('after its smoke failed and failed'), explainRun(engine.run).detail)
    t.eq('this audit also held an ordinary blocker: that is disagreement, whatever the drive did', explainRun(engine.run).headline, "Stopped: the author and reviewers didn't agree in time")
    await releaseWorkspace(engine)
  }
  {
    const marker = await counter()
    const check = `test ! -f round-0.txt || test -f ${marker} || { touch ${marker}; false; }`
    const { engine, log, confirmPrompts } = await scenario({ check, command: DEEP, target: TIERS_ONCE, cap: 1, awaits: untilRereview })
    t.eq('all awaiting, the drive passes: its re-review decides, in the same round', [engine.run.status, log.map((a) => [a.round, a.recheck])], ['completed', [[0, false], [0, true]]], `${engine.run.blockedReason}`)
    t.eq('closure saw the full drive', engine.run.closure?.conditions?.checksSatisfied, true)
    t.ok('and the confirmation was shown the failed smoke', confirmPrompts.at(-1)?.includes('"failedSmoke"'))
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await scenario({ check: 'test ! -f round-0.txt || test -f round-1.txt', command: DEEP, target: TIERS_ONCE, cap: 2, reject: new Set([0]), awaits: (p, round) => round === 0 })
    t.eq('any other round: a failed smoke with an awaited finding gets no drive', [engine.run.status, await fullDrives(engine)], ['completed', [revisionsOf(engine)[1]]], `${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }

  t.section('the last allowed round: what ends it, and what does not get a drive')
  {
    const { engine } = await scenario({ check: 'true', command: '      - id: deep\n        run: "test ! -f round-1.txt"\n', target: TIERS_ONCE, cap: 2, reject: new Set([0, 1]), awaits: () => true })
    const [, second] = revisionsOf(engine)
    t.eq('a failed drive with a passed smoke ends the loop', [stopped(engine), await fullDrives(engine), fullOf(engine, second)], ['blocked/rounds-exhausted', [second], 'failed'])
    t.eq('it is no checks-only stop: the reviewers did not approve', checksOnlyBlock(engine.run), false)
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await scenario({ check: 'true', command: DEEP, target: TIERS, cap: 2, reject: new Set([0, 1]) })
    t.eq('only ordinary findings on the last round: no drive', [stopped(engine), await fullDrives(engine)], ['blocked/rounds-exhausted', []])
    t.ok('and the explanation says it never ran', explainRun(engine.run).detail.includes('never ran on the last revision: its audit held blocking findings that do not wait for it'), explainRun(engine.run).detail)
    await releaseWorkspace(engine)
  }
  {
    const { engine, log } = await scenario({ check: 'true', command: DEEP, target: TIERS, cap: 2, reject: new Set([0, 1, 2]), more: new Set([0]), awaits: () => true })
    t.eq('a converging mixed round is not the last: the drive waits for the extra round', [stopped(engine), log.length, await fullDrives(engine)], ['blocked/rounds-exhausted', 3, [revisionsOf(engine)[2]]])
    await releaseWorkspace(engine)
  }
  {
    // The note's rule (not adopted): a round whose only findings await the drive still counts.
    const { engine } = await scenario({ check: 'test ! -f round-0.txt', target: '    timing: approved\n    retryFailed: 0\n', cap: 2, awaits: () => true })
    t.eq('rounds whose findings all await a failing drive count, and stop at the cap', [stopped(engine), engine.run.revisions.length, engine.run.checkHistory.map((h) => h.result)], ['blocked/rounds-exhausted', 2, ['failed', 'failed']])
    t.eq('and the explanation says the audit awaited the failed drive', explainRun(engine.run).headline, 'Stopped: the last audit only awaited the drive, and the drive failed')
    await releaseWorkspace(engine)
  }

  t.section('a run that cannot have a drive says so (decision operator-request:009)')
  {
    const { engine } = await scenario({ check: 'true', target: '    timing: approved\n', requirement: 'optional', cap: 2, reject: new Set([0, 1]), awaits: () => true, isolation: 'in-place' })
    t.eq('in place, optional checks: it ends at the cap', stopped(engine), 'blocked/rounds-exhausted')
    t.eq('with not-run recorded once, on the last revision', engine.run.checkHistory.map((h) => [h.revision, h.result]), [[revisionsOf(engine)[1], 'not-run']])
    t.ok('and the explanation says no drive could run', explainRun(engine.run).detail.includes('No drive could run on the last revision: in-place work'), explainRun(engine.run).detail)
    await releaseWorkspace(engine)
  }
  {
    const { engine, log } = await scenario({ check: null, cap: 2, awaits: (p, round) => round < 2 })
    t.eq('no drive configured: it ends at the cap', stopped(engine), 'blocked/rounds-exhausted')
    t.eq('the record says not-run', engine.run.driveNotRun, { phase: 'implement-review', round: 1, revision: revisionsOf(engine)[1], result: 'not-run', reason: 'no-drive-configured' })
    t.eq('outside the check evidence', engine.run.checkHistory ?? [], [])
    t.eq('so no re-review was spent on it', log.filter((a) => a.recheck), [])
    t.ok('and the explanation says no drive could run', explainRun(engine.run).detail.includes('No drive could run on the last revision: this run has none configured'), explainRun(engine.run).detail)
    await engine.resumeExecution()
    await engine.drive()
    t.eq('a later ending clears it', engine.run.driveNotRun, undefined)
    await releaseWorkspace(engine).catch(() => {})
  }
}
