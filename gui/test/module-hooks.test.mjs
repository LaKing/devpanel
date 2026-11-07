import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { changedHooks, combinedSets, composeTree, parseReading, subscribersOf } from '../server/runtime/module-hooks.mjs'
import { affectedModulesNotice, modulesDrive } from '../server/runtime/modules-tier.mjs'
import { readPoolLocks, releaseModules, takeModules } from '../server/runtime/module-locks.mjs'

export const name = 'hook expansion — a hook signature change widens the affected set to every subscriber, locked and tested once, with provenance; a failed reading blocks'

const sh = promisify(execFile)
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const reading = (declarations, subscribers) => ({ declarations, subscribers })
const P = 'devpanel-project'

/* An Implementation run on a modules tier of kind local, in a module pool whose framework declares a hook reader. */
async function scenario ({ reader, sizing = null, onAudit = null, beforeDrive = null, dir }) {
  const state = { engine: null, prompts: [] }
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      const ws = state.engine.run.workspace.path
      // The hook's declaration changes signature; its subscriber @c/s is untouched.
      await fs.writeFile(path.join(ws, '@c/a/hook.sig'), `(a, b) round ${round}\n`)
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
  // The base holds the declaring module and a subscriber.
  await fs.mkdir(path.join(f.projectPath, '@c/a'), { recursive: true })
  await fs.mkdir(path.join(f.projectPath, '@c/s/hooks'), { recursive: true })
  await fs.writeFile(path.join(f.projectPath, '@c/a/hook.sig'), '(a)\n')
  await fs.writeFile(path.join(f.projectPath, '@c/s/hooks/h.params'), '(a)\n')
  await sh('git', ['-C', f.projectPath, 'add', '-A'])
  await sh('git', ['-C', f.projectPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'modules'])
  // Check commands get an allow-listed environment, so the log path is written into the printer itself.
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const log = path.join(dir, `log-${stamp}`)
  const printer = path.join(dir, `print-${stamp}`)
  await fs.writeFile(printer, `#!/bin/sh\n{ printf '%s' "$1"; shift; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >> '${log}'\n`, { mode: 0o755 })
  const target = { kind: 'local', retryFailed: 0, modules: {
    collections: ['@*'],
    lint: { id: 'lint', run: `${printer} lint {{files}}` }, load: { id: 'load', run: `${printer} load` }, restart: { id: 'restart', run: `${printer} restart` },
    ready: { id: 'ready', run: `${printer} ready` }, test: { id: 'module-selftest', run: `${printer} test {{filter}}` },
    finallyCommands: [{ id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[]}\'', report: 'selftest' }]
  } }
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement: 'required', target })}\n`)
  if (sizing) {
    const file = path.join(f.issuePath, 'issue.json')
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), sizing }, null, 2) + '\n')
  }
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: P })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: P },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  // What supervisor.start records for a pooled project (a pool of its own here, so nothing to compose).
  engine.run.modulePool = { id: 'pool-' + engine.runId, framework: null, members: [{ project: P, path: f.projectPath, collections: ['@*'] }], frameworkCollections: ['@*'], hookReader: { run: reader }, owners: {}, targets: {} }
  engine.run.moduleLocks = { pool: engine.run.modulePool.id, project: P, issueId: f.issue.id, held: [], waiting: null }
  engine.moduleLockPollMs = 50
  await beforeDrive?.(engine)
  await engine.drive()
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, events, f, prompts: state.prompts, log }
}

export default async function (t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'module-hooks-')))
  try {
    t.section('the reader\'s output is checked; anything else is a failed reading')
    t.eq('a well-formed reading', parseReading('{"declarations":[{"module":"@c/a/","hook":"h","signature":"(a)"}],"subscribers":[]}').declarations, [{ module: '@c/a', hook: 'h', signature: '(a)' }])
    for (const [label, text] of [['not JSON', 'oops'], ['an array', '[]'], ['unknown keys', '{"declarations":[],"subscribers":[],"x":1}'], ['missing fields', '{"declarations":[{"module":"m"}],"subscribers":[]}']]) {
      t.ok(`refused: ${label}`, (() => { try { parseReading(text); return false } catch { return true } })())
    }

    t.section('which hooks changed signature: a declaration, or a handler\'s parameters')
    {
      const base = reading([{ module: '@c/a', hook: 'h', signature: '(a)' }, { module: '@c/a', hook: 'k', signature: '(x)' }], [{ module: '@c/s', hook: 'h', parameters: '(a)' }, { module: '@c/t', hook: 'k', parameters: '(x)' }])
      t.eq('nothing changed', changedHooks(base, base), [])
      t.eq('a declaration\'s signature', changedHooks(base, reading([{ module: '@c/a', hook: 'h', signature: '(a, b)' }, base.declarations[1]], base.subscribers)), ['h'])
      t.eq('a hooks/ handler\'s parameters', changedHooks(base, reading(base.declarations, [base.subscribers[0], { module: '@c/t', hook: 'k', parameters: '(x, y)' }])), ['k'])
      t.eq('a new subscription is not a signature change', changedHooks(base, reading(base.declarations, [...base.subscribers, { module: '@c/u', hook: 'h', parameters: '(a)' }])), [])
    }

    t.section('every subscriber, with provenance; a subscriber already affected is still named (auditor-1-004); locked and tested once')
    {
      const own = reading([], [{ module: '@c/s', hook: 'h', parameters: '(a)' }, { module: '@c/s', hook: 'k', parameters: '(x)' }, { module: 'own-modules/m', hook: 'h', parameters: '(a)' }, { module: '@c/z', hook: 'other', parameters: '' }])
      const other = reading([], [{ module: '@c/s', hook: 'h', parameters: '(a)' }, { module: 'b-modules/n', hook: 'h', parameters: '(a)' }])
      const owners = { '@c/s': 'framework-project', 'own-modules/m': 'instance-a-project', 'b-modules/n': 'instance-b-project' }
      const via = subscribersOf(['h', 'k'], [{ project: 'instance-a-project', inTree: true, reading: own }, { project: 'instance-b-project', inTree: false, reading: other }], owners)
      t.eq('each module once, its project and hooks; the other member contributes only its own modules', via, [
        { module: '@c/s', project: 'framework-project', hooks: ['h', 'k'], inTree: true },
        { module: 'b-modules/n', project: 'instance-b-project', hooks: ['h'], inTree: false },
        { module: 'own-modules/m', project: 'instance-a-project', hooks: ['h'], inTree: true }])
      // The triage already lists @c/s and the paths changed @c/a: @c/s stays in viaHooks.
      const affected = { modules: ['@c/a', '@c/s'], core: null, viaHooks: via }
      const sets = combinedSets(affected)
      t.eq('the lock set holds each module once', sets.lock, ['@c/a', '@c/s', 'b-modules/n', 'own-modules/m'])
      t.eq('the main drive tests each in-tree module once', sets.mainFilters, ['@c/a', '@c/s', 'own-modules/m'])
      t.eq('another project\'s subscriber goes to its own subscriber drive, once', sets.subscriberDrives, { 'instance-b-project': ['b-modules/n'] })
      const declared = { collections: ['@*'], lint: { id: 'lint', run: 'l {{files}}' }, load: { id: 'load', run: 'x' }, restart: { id: 'restart', run: 'x' }, ready: { id: 'ready', run: 'x' }, test: { id: 'module-selftest', run: 't {{filter}}', report: 'selftest' } }
      const { plan } = modulesDrive({ kind: 'local', modules: declared }, { affected, files: [] })
      t.eq('the drive\'s generated tests run @c/s once', plan.tests.map((x) => x.module), ['@c/a', '@c/s', 'own-modules/m'])
      t.ok('the auditor is told the subscribers with their provenance', /"@c\/s" \(framework-project; h, k; tested in this drive\).*"b-modules\/n" \(instance-b-project; h; tested in a subscriber drive/.test(affectedModulesNotice({ fingerprint: 'sha256:x', modules: { changed: ['@c/a'] }, affectedModules: affected, hooks: { state: 'read', changed: ['h', 'k'] } })))
    }

    t.section('a subscriber drive\'s tree: the member at its HEAD with the candidate\'s framework collections')
    {
      const member = path.join(dir, 'member')
      await fs.mkdir(path.join(member, 'b-modules/n'), { recursive: true })
      await fs.mkdir(path.join(dir, 'framework/@c/a'), { recursive: true })
      await fs.writeFile(path.join(dir, 'framework/@c/a/hook.sig'), 'old\n')
      await fs.writeFile(path.join(member, 'b-modules/n/x.mjs'), 'export {}\n')
      await fs.symlink(path.join(dir, 'framework/@c'), path.join(member, '@c'))
      // A framework collection the candidate deleted: the member's HEAD still links it.
      await fs.mkdir(path.join(dir, 'framework/@old/m'), { recursive: true })
      await fs.writeFile(path.join(dir, 'framework/@old/m/stale.mjs'), 'export const stale = 1\n')
      await fs.symlink(path.join(dir, 'framework/@old'), path.join(member, '@old'))
      await sh('git', ['-C', member, 'init', '-q'])
      await sh('git', ['-C', member, 'add', '-A'])
      await sh('git', ['-C', member, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'm'])
      const candidate = path.join(dir, 'candidate')
      await fs.mkdir(path.join(candidate, '@c/a'), { recursive: true })
      await fs.writeFile(path.join(candidate, '@c/a/hook.sig'), 'new\n')
      const composed = await composeTree({ project: 'instance-b-project', memberPath: member, frameworkCollections: ['@*'], from: candidate, into: path.join(dir, 'composed'), revision: 'sha256:r' })
      t.eq('the framework collection is the candidate\'s, as a directory', [await fs.readFile(path.join(composed.tree, '@c/a/hook.sig'), 'utf8'), (await fs.lstat(path.join(composed.tree, '@c'))).isSymbolicLink()], ['new\n', false])
      t.eq('the member\'s own modules are its HEAD', await fs.readFile(path.join(composed.tree, 'b-modules/n/x.mjs'), 'utf8'), 'export {}\n')
      t.eq('the identity names the member\'s head and what was replaced', [composed.identity.project, composed.identity.replaced, /^[0-9a-f]{40}$/.test(composed.identity.sourceHead)], ['instance-b-project', ['@c'], true])
      t.eq('a framework collection the candidate deleted is gone from the composed tree, not left linking the live framework', [await fs.lstat(path.join(composed.tree, '@old')).then(() => true, () => false), composed.identity.dropped], [false, ['@old']])
    }

    const readerScript = path.join(dir, 'read-hooks')
    await fs.writeFile(readerScript, `#!/bin/sh\nsig=$(tr -d '\\n' < @c/a/hook.sig)\nparams=$(tr -d '\\n' < @c/s/hooks/h.params)\nprintf '{"declarations":[{"module":"@c/a","hook":"h","signature":"%s"}],"subscribers":[{"module":"@c/s","hook":"h","parameters":"%s"}]}' "$sig" "$params"\n`, { mode: 0o755 })

    t.section('an engine run: the subscriber joins the affected set, the revision waits for its lock before any review, then tests it once')
    {
      const otherIssue = path.join(dir, 'other-issue')
      await fs.mkdir(path.join(otherIssue, 'runs', 'run-other'), { recursive: true })
      await fs.writeFile(path.join(otherIssue, 'runs', 'run-other', 'run.json'), JSON.stringify({ runId: 'run-other', status: 'running' }))
      let other = null
      let releasedAt = null
      let auditedWhileHeld = false
      const { engine, events, log } = await scenario({
        dir, reader: readerScript, sizing: { affectedModules: ['@c/s'] },
        // Another live run of the pool holds the subscriber; it lets go a moment after the revision starts waiting.
        beforeDrive: async (e) => {
          other = await takeModules({ pool: e.run.moduleLocks.pool, modules: ['@c/s'], runId: 'run-other', project: 'other-project', issueId: 'other', issuePath: otherIssue })
          const poll = setInterval(async () => {
            if (!e.run.moduleLocks.waiting) return
            clearInterval(poll)
            await new Promise((r) => setTimeout(r, 200))
            await releaseModules({ pool: e.run.moduleLocks.pool, held: other.held })
            releasedAt = Date.now()
          }, 20)
        },
        onAudit: async () => { if (!releasedAt) auditedWhileHeld = true }
      })
      const first = engine.run.revisions[0]
      t.eq('the hook change was read', [first.hooks?.state, first.hooks?.changed], ['read', ['h']])
      t.eq('viaHooks names the subscriber the triage already listed, with project and hook', first.affectedModules?.viaHooks, [{ module: '@c/s', project: P, hooks: ['h'], inTree: true }])
      t.eq('the run waited for it: a wait was recorded and excused from the wall clock', [events.some((e) => e.type === 'module-lock-wait'), (engine.run.moduleLockWaits ?? []).length > 0], [true, true])
      t.eq('no review ran while the other run held it', auditedWhileHeld, false)
      const waitAt = events.findIndex((e) => e.type === 'module-lock-wait')
      const takenAt = events.findIndex((e) => e.type === 'module-locks-taken')
      const checksAt = events.findIndex((e) => e.type === 'checks-started')
      t.ok('the wait came before the locks were taken, and both before the check', waitAt >= 0 && waitAt < takenAt && takenAt < checksAt, JSON.stringify([waitAt, takenAt, checksAt]))
      t.eq('the lock grew to the revision\'s modules, each once', first.moduleLocks?.added, ['@c/a', '@c/s'])
      const lines = (await fs.readFile(log, 'utf8')).trim().split('\n')
      const drives = lines.filter((l) => l === 'load').length
      t.ok('every drive tested the subscriber exactly once', drives > 0 && lines.filter((l) => l === 'test [@c/s]').length === drives, lines.join(' | '))
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      await releaseWorkspace(engine).catch(() => {})
      const left = await readPoolLocks(engine.run.moduleLocks.pool)
      t.eq('locks still recorded on the engine record until the supervisor settles it', left.map((l) => l.module), ['@c/a', '@c/s'])
      await releaseModules({ pool: engine.run.moduleLocks.pool, held: engine.run.moduleLocks.held })
    }

    t.section('a declared reader that fails blocks the revision\'s modules check; it is never an empty viaHooks')
    {
      const failing = path.join(dir, 'fail-hooks')
      await fs.writeFile(failing, '#!/bin/sh\necho "cannot read hooks" >&2\nexit 3\n', { mode: 0o755 })
      const { engine } = await scenario({ dir, reader: failing })
      const first = engine.run.revisions[0]
      t.eq('the reading is unavailable, viaHooks unknown', [first.hooks?.state, first.affectedModules?.viaHooks], ['unavailable', null])
      const check = engine.run.checkHistory.find((h) => h.revision === first.fingerprint)
      t.eq('the modules check is unavailable for it', [check?.tier, check?.result], ['modules', 'unavailable'])
      t.ok('closure is not met', engine.run.status !== 'completed', engine.run.status)
      await releaseModules({ pool: engine.run.moduleLocks.pool, held: engine.run.moduleLocks.held })
      await releaseWorkspace(engine).catch(() => {})
    }

    t.section('a changed hook with a pool member whose checkout cannot be read: incomplete, so unavailable, never read (auditor-1-007)')
    {
      const { engine } = await scenario({
        dir, reader: readerScript,
        beforeDrive: (e) => {
          e.run.modulePool.members.push({ project: 'instance-b-project', path: null, collections: ['b-modules'] })
          e.run.modulePool.unreadable = ['instance-b-project']
        }
      })
      const first = engine.run.revisions[0]
      t.eq('the analysis is unavailable, viaHooks unknown', [first.hooks?.state, first.affectedModules?.viaHooks], ['unavailable', null])
      t.ok('naming the unreadable member', /instance-b-project/.test(first.hooks?.error ?? ''), first.hooks?.error)
      const check = engine.run.checkHistory.find((h) => h.revision === first.fingerprint)
      t.eq('the revision\'s modules check is unavailable', [check?.tier, check?.result], ['modules', 'unavailable'])
      t.ok('closure is not met', engine.run.status !== 'completed', engine.run.status)
      await releaseModules({ pool: engine.run.moduleLocks.pool, held: engine.run.moduleLocks.held })
      await releaseWorkspace(engine).catch(() => {})
    }

    t.section('no reader declared in the pool: undeclared, nothing widened, nothing blocked')
    {
      const { engine } = await scenario({ dir, reader: readerScript, beforeDrive: (e) => { e.run.modulePool.hookReader = null } })
      const first = engine.run.revisions[0]
      t.eq('undeclared, an empty viaHooks', [first.hooks?.state, first.affectedModules?.viaHooks], ['undeclared', []])
      t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
      await releaseModules({ pool: engine.run.moduleLocks.pool, held: engine.run.moduleLocks.held })
      await releaseWorkspace(engine).catch(() => {})
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
