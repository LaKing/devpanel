import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { CONFIG_ROOT, sandbox, errorMatching } from './helpers.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'intents and the analysis strategy — overlays, selection, and a document that closes'

const NL = String.fromCharCode(10)

const start = (f, extra = {}) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock,
  deliveryProvider: f.delivery, ...extra
})

/*
 * No live implementation playbook names an intent, and the implementation
 * strategy ships none; the overlay mechanism is proved on it by installing two
 * in the sandbox and making one the playbook's default, as an operator would.
 */
const INTENTS = {
  bugfix: ['id: bugfix', 'title: Bug fix', 'description: Correcting behaviour that does not work as intended.', 'guidance:',
    '  triage: |', '    Reproduce or locate the defect before anything else.',
    '  implement: |', '    Fix the cause, not the symptom.',
    '  audit-implement-1: |', '    Confirm the cause is removed.'],
  refactor: ['id: refactor', 'title: Refactor', 'description: Restructure without changing behaviour.', 'guidance:',
    '  triage: |', '    Name the behaviour that must be preserved.',
    '  implement: |', '    Keep observable behaviour identical.']
}
async function installIntents (dir, playbookDefault = 'bugfix') {
  const intents = path.join(dir, 'strategy-templates/implementation/intents')
  await fs.mkdir(intents, { recursive: true })
  for (const [id, lines] of Object.entries(INTENTS)) await fs.writeFile(path.join(intents, `${id}.yaml`), lines.join(NL) + NL)
  const playbook = path.join(dir, 'playbooks/implementation.yaml')
  await fs.writeFile(playbook, (await fs.readFile(playbook, 'utf8')).replace(/^strategyVersion: 1$/m, `strategyVersion: 1${NL}intent: ${playbookDefault}`))
}

const recording = (script) => {
  const seen = []
  return { seen, script: (turn) => { seen.push({ ...turn }); return script(turn) } }
}

export default async function (t) {
  // ------------------------------------------------------------ configuration
  t.section('1. every strategy offers its intents, and every playbook resolves with one')
  {
    const cfg = await loadConfig({ root: CONFIG_ROOT })
    t.eq('no configuration errors', cfg.errors.length, 0, cfg.errors.map((e) => e.message).join('; '))
    t.ok('the plan-and-implement strategy has its refactoring overlay', cfg.strategies.get('plan-and-implement').intents.has('refactoring'),
      [...cfg.strategies.get('plan-and-implement').intents.keys()].join(','))
    // The normal catalogue is these five; further offered playbooks (prompt,
    // refactoring) may be added. Asserting properties rather than the exact
    // list keeps a new playbook from breaking this test.
    const offered = [...cfg.playbooks.values()].filter(p=>!p.deprecated).map(p=>p.id)
    t.ok('the five normal playbooks are offered', ['analysis','deployment','implementation','plan-and-implement','triage'].every((id) => offered.includes(id)), offered.join(','))
    // Removed 2026-11-07 with no alias: staging releases are the deployment playbook's staging environment.
    t.eq('no Staging playbook or strategy is left in the catalogue', [cfg.playbooks.has('staging'), cfg.strategies.has('staging')], [false, false])
    t.eq('one-off campaign playbooks are not offered', offered.filter((id) => /^migration-/.test(id)), [])

    const defaults = {}
    for (const id of cfg.playbooks.keys()) {
      const r = await resolvePlaybook(id, { root: CONFIG_ROOT, config: cfg })
      t.ok(`${id} resolves`, r.ok, r.errors?.map((e) => e.message).join('; '))
      defaults[id] = r.resolved?.intent?.id ?? null
    }
    const expected = { analysis: null, deployment: null, implementation: null, 'plan-and-implement': null, prompt: null, refactoring: 'refactoring', triage: null }
    t.eq('each known playbook carries its default intent', JSON.stringify(Object.fromEntries(Object.keys(expected).map((id) => [id, defaults[id] ?? null]))), JSON.stringify(expected))

    const refactoring = (await resolvePlaybook('refactoring', { root: CONFIG_ROOT, config: cfg })).resolved
    t.eq('the intent is snapshotted with its guidance', typeof refactoring.intent.guidance.triage, 'string')
    t.eq('and its source', refactoring.intent.source, 'playbook')
    t.ok('and contributes to the config hash', /^sha256:/.test(refactoring.intent.hash))
    t.ok('the parameter definitions list every intent for the dialog', refactoring.parameterDefinitions.intents.some((i) => i.id === 'refactoring' && i.title))
  }

  const root = await sandbox((dir) => installIntents(dir))

  t.section('2. a run may choose another intent; an unknown one is refused')
  {
    const plain = await resolvePlaybook('implementation', { root })
    t.ok('the sandbox default resolves', plain.ok, plain.errors?.map((e) => e.message).join('; '))
    t.eq('with the playbook default', `${plain.resolved.intent.id}/${plain.resolved.intent.source}`, 'bugfix/playbook')
    const chosen = await resolvePlaybook('implementation', { root, runOptions: { intent: 'refactor' } })
    t.eq('the run option wins', chosen.resolved.intent.id, 'refactor')
    t.eq('and says so', chosen.resolved.intent.source, 'run')
    t.ok('a different intent changes the config hash', chosen.resolved.configHash !== plain.resolved.configHash)

    const none = await resolvePlaybook('implementation', { root, runOptions: { intent: null } })
    t.eq('null clears the playbook default', none.resolved.intent, null)

    const bad = await resolvePlaybook('implementation', { root, runOptions: { intent: 'deployment' } })
    t.eq('an unknown intent does not resolve', bad.ok, false)
    t.ok('and the error names the available ones', Boolean(errorMatching(bad, /not defined by strategy.*available: .*bugfix/)), bad.errors?.[0]?.message)

    const cross = await resolvePlaybook('analysis', { root, runOptions: { intent: 'bugfix' } })
    t.eq('an intent from another strategy is refused too', cross.ok, false)
  }

  t.section('3. an intent that names a step the strategy lacks is a load error')
  {
    const broken = await sandbox(async (dir) => {
      await fs.writeFile(path.join(dir, 'strategy-templates/plan-and-implement/intents/broken.yaml'),
        ['id: broken', 'title: Broken', 'description: names a step that does not exist', 'guidance:', '  deploy: |', '    ship it'].join(NL) + NL)
    })
    const cfg = await loadConfig({ root: broken })
    t.ok('reported with the file and field', cfg.errors.some((e) => /names steps the strategy does not have: deploy/.test(e.message) && e.file.endsWith('broken.yaml')),
      cfg.errors.map((e) => e.message).join('; '))
    t.ok('the strategy still loads without it', cfg.strategies.get('plan-and-implement')?.intents.has('refactoring') === true)
  }

  t.section('4. the preview shows the intent')
  {
    const p = await previewRun({ playbookId: 'implementation', configRoot: root, runOptions: { intent: 'refactor' } })
    t.eq('by id', p.intent.id, 'refactor')
    t.ok('with the steps it speaks to', p.intent.steps.includes('implement'))
    t.eq('and its origin', p.intent.source, 'run')
  }

  // ------------------------------------------------------------ engine
  t.section('5. the overlay reaches coordinator, writer and auditor prompts alike')
  {
    const { seen, script } = recording(scriptFor())
    const f = await engineFixture({ script })
    await installIntents(f.configRoot)
    const engine = await start(f)
    await engine.drive()
    t.eq('the run completed', engine.run.status, 'completed', engine.run.blockedReason)
    const triage = seen.find((s) => s.stepId === 'triage')
    t.ok('the triage template got the bugfix intent', triage.prompt.includes('## Intent: Bug fix') && triage.prompt.includes('Reproduce or locate the defect'))
    const implement = seen.find((s) => s.stepId === 'implement')
    t.ok('the implementer got its own guidance', implement.prompt.includes('## Intent: Bug fix') && implement.prompt.includes('Fix the cause'))
    const audit = seen.find((s) => s.stepId === 'audit-implement-1')
    t.ok('and the auditor its own', audit.prompt.includes('Confirm the cause is removed'))
    const brief = seen.find((s) => s.stepId === 'brief-implement')
    t.ok('a step the intent does not name gets no overlay', !brief.prompt.includes('## Intent:'))
    const snapshot = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'resolved-playbook.json'), 'utf8'))
    t.eq('the snapshot froze the intent', snapshot.intent.id, 'bugfix')
    const prompts = await (await import('../server/runtime/store.mjs')).readPrompts(f.issuePath, engine.runId)
    t.ok('the prompt record says the engine appended it', Object.values(prompts).some((p) => p.appended.some((a) => a.reason === 'intent')))
    await releaseWorkspace(engine)
  }

  t.section('6. an intent chosen at start is the one the run keeps')
  {
    const { seen, script } = recording(scriptFor())
    const f = await engineFixture({ script })
    await installIntents(f.configRoot)
    const { resolved } = await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: { intent: 'refactor' } })
    const engine = await start(f, { runOptions: { intent: 'refactor' }, expectConfigHash: resolved.configHash })
    await engine.drive({ maxTurns: 1 })
    t.ok('the refactor guidance was used', seen[0].prompt.includes('## Intent: Refactor'))
    t.ok('not the playbook default', !seen[0].prompt.includes('## Intent: Bug fix'))
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ analysis
  t.section('7. the analysis playbook closes on its findings with nothing delivered')
  {
    const { seen, script } = recording(scriptFor())
    const f = await engineFixture({ script, playbook: 'analysis' })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('the run completed', run.status, 'completed', run.blockedReason)
    t.eq('and resolved', run.outcome, 'resolved')
    // playbooks/analysis.yaml occupies analyser-2 by default (the owner's defaults since 2026-11-07).
    t.eq('steps in order', run.steps.map((s) => s.stepId).join(','), 'brief,investigate-analyser,investigate-analyser-2,disposition')
    t.eq('no revision was ever recorded', run.revisions.length, 0)
    t.eq('delivery is none and complete', `${run.delivery.action}:${run.delivery.completedAt !== null}`, 'none:true')
    t.eq('closure is review-only and authorised', `${run.closure.verificationLevel}:${run.closure.authorised}`, 'review-only:true')
    t.eq('the workspace was never changed', f.delivery.calls.length, 0)
    t.ok('the analyser was told the investigationResult contract', seen.find((s) => s.stepId === 'investigate-analyser').prompt.includes('`investigationResult` contract'))
    await releaseWorkspace(engine)
  }

  t.section('8. a completed analysis run never licenses deleting a changed worktree')
  {
    const { workspaceDisposition } = await import('../server/supervisor.mjs')
    const changed = { unchanged: false, proven: true, reason: 'accidental.txt differs from the baseline' }
    const clean = { unchanged: true, proven: true, reason: 'every file matches the baseline' }
    const none = { status: 'completed', delivery: { action: 'none', completedAt: 't' } }
    t.eq('a none delivery with changes retains', workspaceDisposition(none, changed).discard, false)
    t.ok('and says why', /captures nothing/.test(workspaceDisposition(none, changed).reason))
    t.eq('a none delivery with a proven-clean worktree discards', workspaceDisposition(none, clean).discard, true)
    const verified = { status: 'completed', delivery: { action: 'worktree-diff', completedAt: 't', reconstruction: { verified: true } } }
    t.eq('a verified patch discards', workspaceDisposition(verified, changed).discard, true)
    const unverified = { status: 'blocked', delivery: { action: 'worktree-diff', completedAt: null, reconstruction: { verified: false } } }
    t.eq('an unverified patch retains', workspaceDisposition(unverified, changed).discard, false)
    const vouched = { status: 'completed', delivery: { action: 'worktree-diff', completedAt: 't', reconstruction: null } }
    t.eq('a delivery without reconstruction evidence retains', workspaceDisposition(vouched, changed).discard, false)
    const truthy = { status: 'completed', delivery: { action: 'worktree-diff', completedAt: 't', reconstruction: { verified: 'yes' } } }
    t.eq('a non-boolean "verified" is not evidence', workspaceDisposition(truthy, changed).discard, false)
    const unprovable = { unchanged: false, proven: false, reason: 'the workspace could not be read' }
    t.eq('an unprovable comparison retains', workspaceDisposition({ status: 'completed', delivery: null }, unprovable).discard, false)
  }

  // The fake runtime module resolves its control file PATH once, at import, and
  // re-reads the CONTENT per call; sections 10 and 11 therefore share one path.
  const sharedControl = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fake-control-')), 'control.json')
  process.env.DEVPANEL_FAKE_CONTROL = sharedControl

  t.section('9. the analysis playbook, end to end: an analyser that touches the worktree is quarantined, not deleted')
  {
    const f = await engineFixture({ playbook: 'analysis' })
    // The supervisor finds a project at <projectsDir>/<project id>; the fixture's
    // repository lives elsewhere, so a projects directory links to it by name.
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project'))
    await fs.writeFile(sharedControl, JSON.stringify({ ledger: path.join(f.issuesDir, 'ledger.jsonl'), delayMs: 0, writes: { 'investigate-analyser': { file: 'accidental.txt', text: 'oops' } } }))
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs'))}${NL}`)
    const { createSupervisor } = await import('../server/supervisor.mjs')
    // The real supervisor drives the run, so the settle path is the one under test.
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
    const started = await supervisor.start({ project: 'devpanel-project', issueId: f.issue.id, playbookId: 'analysis', configRoot: f.configRoot })
    await supervisor.settle()
    const { readRun } = await import('../server/runtime/store.mjs')
    const run = await readRun(f.issuePath, started.runId)
    // The analyser is declared writesCode: false. A file it leaves in the
    // source tree is an unauthorized source change: the run stops for an explicit
    // recovery disposition instead of closing over it or quietly deleting it.
    t.eq('the run is blocked for recovery', `${run.status}/${run.blockedReason}`, 'blocked/recovery-required')
    t.eq('by a source-integrity quarantine', run.integrity?.status, 'quarantined')
    t.eq('attributed to the analyser turn', run.integrity?.latest?.role, 'analyser')
    t.ok('naming the stray file', (run.integrity?.latest?.changes?.paths ?? []).some((c) => c.path === 'accidental.txt'), JSON.stringify(run.integrity?.latest?.changes))
    t.eq('nothing was delivered', run.delivery ?? null, null)
    t.eq('the worktree was retained, not removed', run.workspace.state, 'retained')
    t.ok('with the reason', /retained for recovery/.test(run.workspace.retainedReason ?? ''), run.workspace.retainedReason)
    t.ok('and the file is still there', await fs.stat(path.join(run.workspace.path, 'accidental.txt')).then(() => true, () => false))
  }

  t.section('10. the analysis playbook, end to end, closes review-only with a none delivery when the analyser only reads')
  {
    const f = await engineFixture({ playbook: 'analysis' })
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project'))
    await fs.writeFile(sharedControl, JSON.stringify({ ledger: path.join(f.issuesDir, 'ledger.jsonl'), delayMs: 0 }))
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs'))}${NL}`)
    const { createSupervisor } = await import('../server/supervisor.mjs')
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
    const started = await supervisor.start({ project: 'devpanel-project', issueId: f.issue.id, playbookId: 'analysis', configRoot: f.configRoot })
    await supervisor.settle()
    const { readRun } = await import('../server/runtime/store.mjs')
    const run = await readRun(f.issuePath, started.runId)
    t.eq('the run completed', `${run.status}/${run.outcome}`, 'completed/resolved', run.blockedReason)
    t.eq('with a none delivery', run.delivery?.action, 'none')
    t.eq('review-only, since nothing was checked', run.closure?.verificationLevel, 'review-only')
    t.eq('and every turn passed integrity', run.integrity?.status, 'clear')
    delete process.env.DEVPANEL_FAKE_CONTROL
    await fs.rm(path.dirname(sharedControl), { recursive: true, force: true })
  }

  await cleanupFixtures()
}
