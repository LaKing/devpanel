import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import YAML from 'yaml'

import { CONFIG_ROOT, resolvePlaybook } from '../server/config/load.mjs'
import { modulesTarget } from '../server/infrastructure.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { gitWorktreeProvider, releaseWorkspace, startRun } from '../server/runtime/launch.mjs'
import { platformFor } from '../server/runtime/platform.mjs'
import { cleanupFixtures, engineFixture, scriptFor } from './fakes/fixture.mjs'

export const name = 'project-local checks — projects/<id>.yaml `checks` resolve to a local target, gate revisions, carry the fence labels'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const P = 'devpanel-project'
const temps = []
const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
const exists = (p) => fs.lstat(p).then(() => true, () => false)
// Paths go into shell text quoted: TMPDIR may hold spaces (docs/macos.md, paths with spaces).
const q = (p) => `'${String(p).replaceAll("'", "'\\''")}'`
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const darwin = () => platformFor('darwin', { exec: async () => ({ ok: false, code: 1, stdout: '', error: 'not a mac' }) })
const linux = () => platformFor('linux')

const writeProject = async (configRoot, data) => {
  await fs.mkdir(path.join(configRoot, 'projects'), { recursive: true })
  await fs.writeFile(path.join(configRoot, 'projects', `${P}.yaml`), YAML.stringify({ id: P, ...data }))
}

async function withEnv (vars, body) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await body() } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

async function candidate () {
  const projectPath = await temp('check-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'value.txt'), '1' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'l1', root: await temp('check-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  const check = (target, extra = {}) => runChecks({ target, revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir, ...extra })
  const runDir = await temp('check-run-')
  return { projectPath, ws, runDir, check }
}

const worktrees = async (projectPath) => (await run('git', ['-C', projectPath, 'worktree', 'list'])).stdout.trim().split(NL).length

/** An author whose round 0 makes work.txt and later rounds fixed.txt; reviewers approve. */
function authorScript (holder, { fixes = true } = {}) {
  return async (turn) => {
    const { stepId, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await fs.writeFile(path.join(holder.engine.run.workspace.path, round > 0 && fixes ? 'fixed.txt' : 'work.txt'), 'work\n')
      return fence({ summary: round ? 'Fixed the failing check' : 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
}

async function gatedRun ({ fixes }) {
  const holder = {}
  const f = await engineFixture({ playbook: 'implementation', script: authorScript(holder, { fixes }) })
  // The base (no work.txt) passes, so a failure is the candidate's own, never inherited.
  await writeProject(f.configRoot, { checks: { commands: [{ id: 'fixed', run: 'test -f fixed.txt || test ! -f work.txt' }] } })
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: P })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  holder.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: P },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await holder.engine.drive()
  return { engine: holder.engine, f }
}

export default async function (t) {
  const commands = [{ id: 'fmt', run: 'true' }, { id: 'clippy', run: 'true' }, { id: 'test', run: 'true' }]
  try {
    t.section('1. P1-resolve: a project with only local checks resolves through both coding playbooks')
    {
      const f = await engineFixture()
      await writeProject(f.configRoot, { checks: { commands } })
      for (const id of ['implementation', 'plan-and-implement']) {
        const r = await resolvePlaybook(id, { root: f.configRoot, projectId: P })
        t.ok(`${id}: resolves`, r.ok, JSON.stringify(r.errors))
        t.eq(`${id}: a local target with the declared commands`, [r.resolved?.checks.target?.kind, r.resolved?.checks.target?.commands.map((c) => c.id)], ['local', ['fmt', 'clippy', 'test']])
        t.eq(`${id}: required by default, on every revision`, [r.resolved?.checks.requirement, r.resolved?.checks.target?.timing], ['required', undefined])
      }
      await writeProject(f.configRoot, { checks: { requirement: 'optional', commands } })
      t.eq('optional is honoured', (await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })).resolved?.checks.requirement, 'optional')
      await writeProject(f.configRoot, { checks: { commands } })
      t.eq('a playbook without revisions takes no checks', (await resolvePlaybook('analysis', { root: f.configRoot, projectId: P })).resolved?.checks.target ?? null, null)

      const out = await run(process.execPath, [path.join(CONFIG_ROOT, 'gui/server/config/check.mjs'), 'implementation', '--project', P], { env: { ...process.env, DEVPANEL_CONFIG_ROOT: f.configRoot } })
      t.ok('config:check shows the local target and its commands', out.stdout.includes('target=local commands=fmt,clippy,test timing=every-revision'), out.stdout.split(NL).find((l) => l.includes('requirement=')) ?? out.stdout)

      const refused = async (data, pattern) => {
        await writeProject(f.configRoot, data)
        const r = await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })
        return !r.ok && r.errors.some((e) => pattern.test(e.message) && e.file?.endsWith(`/projects/${P}.yaml`))
      }
      const infra = {
        kind: 'boilerplate', orientation: 'o',
        staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage', workdir: '/tmp' }, projectRoot: '/opt/stage', files: {} },
        deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:production', workdir: '/opt' }, projectRoot: '/opt/production', files: {} }],
        testDrive: { commands: [{ id: 'candidate', run: 'true' }] }
      }
      t.ok('checks with infrastructure is refused', await refused({ infrastructure: infra, checks: { commands } }, /either as infrastructure\.testDrive .* or as checks/))
      t.ok('an SSH confinement option is refused', await refused({ checks: { commands: [{ id: 'x', run: 'true', kind: 'candidate' }] } }, /belong to an SSH test drive/))
      t.ok('a set without a required command is refused', await refused({ checks: { commands: [{ id: 'x', run: 'true', required: false }] } }, /at least one required command/))
      t.ok('duplicate ids are refused', await refused({ checks: { commands: [{ id: 'x', run: 'true' }], finallyCommands: [{ id: 'x', run: 'true' }] } }, /ids must be unique/))

      t.section('2. an infrastructure (Boilerplate) project resolves to the modules tier')
      await writeProject(f.configRoot, { infrastructure: infra })
      const ssh = await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })
      t.ok('it resolves', ssh.ok, JSON.stringify(ssh.errors))
      t.eq('its checks are the modules tier, exactly', ssh.resolved?.checks, { requirement: 'required', target: modulesTarget(infra), boundToRevision: true })
    }

    t.section('3. P1-gate: required project checks run per revision and a failure gates approval')
    {
      const { engine } = await gatedRun({ fixes: true })
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
      t.eq('the target is the project\'s local checks', engine.snapshot.checks.target.kind, 'local')
      t.eq('both reviewers approved round 0, but its failed check made a second round', engine.run.steps.filter((s) => s.stepId === 'implement').length, 2)
      // checkResults holds only the current revision's evidence; the history holds every revision's.
      t.eq('each revision was checked: failed, then passed', engine.run.checkHistory.map((c) => c.result), ['failed', 'passed'])
      t.eq('the closure counts the passing check', engine.run.closure?.verificationLevel, 'verified')
      await releaseWorkspace(engine)

      const never = await gatedRun({ fixes: false })
      t.ok('a check that never passes leaves the run unresolved', never.engine.run.outcome !== 'resolved' && never.engine.run.checkResults.at(-1)?.result === 'failed', `${never.engine.run.outcome} ${never.engine.run.blockedReason}`)
      await releaseWorkspace(never.engine)
    }

    t.section('4. P1-labels: local-refused runs nothing; local-unconfined; local-enforced where the fence proves')
    {
      const f = await engineFixture()
      const c = await candidate()
      const marker = path.join(c.runDir, 'ran')
      await writeProject(f.configRoot, { checks: { commands: [{ id: 'mark', run: `: > ${q(marker)}` }], finallyCommands: [{ id: 'final', run: `: > ${q(`${marker}.final`)}` }] } })
      const target = (await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })).resolved.checks.target
      await withEnv({ DEVPANEL_UNFENCED: undefined }, async () => {
        const refused = await c.check(target, { platform: darwin() })
        t.eq('darwin without the opt-in: refused, unavailable', [refused.result, refused.confinement?.level], ['unavailable', 'local-refused'])
        t.ok('and neither a command nor a finalizer ran', refused.commands.length === 0 && !await exists(marker) && !await exists(`${marker}.final`))
      })
      await withEnv({ DEVPANEL_UNFENCED: 'acknowledged' }, async () => {
        const opted = await c.check(target, { platform: darwin() })
        t.eq('darwin opted in: runs, labelled local-unconfined', [opted.result, opted.confinement?.level], ['passed', 'local-unconfined'])
      })
      await fs.rm(marker, { force: true })
      await withEnv({ DEVPANEL_FENCE: 'off' }, async () => {
        const off = await c.check(target, { platform: linux() })
        t.eq('Linux with the fence switched off: local-unconfined', [off.result, off.confinement?.level], ['passed', 'local-unconfined'])
      })
      await withEnv({ DEVPANEL_FENCE: undefined, DEVPANEL_FENCE_UNPROVED: undefined }, async () => {
        const fenced = await c.check({ ...target, commands: [{ id: 'plain', run: 'true' }], finallyCommands: undefined }, { platform: linux() })
        if (fenced.confinement?.level === 'local-enforced') t.eq('Linux with the fence: local-enforced, passed', fenced.result, 'passed', fenced.error)
        else t.skip('Linux with the fence: local-enforced', `the fence cannot be proved in this environment (${fenced.confinement?.reason ?? fenced.error}); it was refused, not run`)
      })
      await gitWorktreeProvider.release({ projectPath: c.projectPath, path: c.ws.path })
    }

    t.section('5. P1-fixtures: a failing command gates the set; cancellation stops the command and cleans up')
    {
      const c = await candidate()
      const failed = await c.check({ kind: 'local', commands: [{ id: 'lint', run: 'echo broken >&2; exit 3' }, { id: 'test', run: 'true' }] })
      t.eq('a failing required command fails the set', failed.result, 'failed')
      t.eq('the later command is skipped, with its reason', failed.skipped?.map((s) => s.id), ['test'])
      t.ok('the failure\'s log is kept', (await fs.readFile(path.join(c.runDir, failed.dir, 'lint.log'), 'utf8')).includes('broken'))

      const pidFile = path.join(c.runDir, 'pid')
      const before = await worktrees(c.projectPath)
      const controller = new AbortController()
      const pending = c.check({ kind: 'local', commands: [{ id: 'hang', run: `echo $$ > ${q(pidFile)}; exec sleep 30` }], finallyCommands: [{ id: 'stop', run: 'echo stopped' }] }, { signal: controller.signal })
      for (let i = 0; i < 100 && !await exists(pidFile); i++) await new Promise((r) => setTimeout(r, 50))
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
      controller.abort()
      const cancelled = await pending
      t.eq('a cancelled check is unavailable, cancelled', [cancelled.result, cancelled.error], ['unavailable', 'cancelled'])
      t.ok('its finalizer still ran', cancelled.commands.some((x) => x.id === 'stop' && x.passed))
      const alive = (() => { try { process.kill(pid, 0); return true } catch { return false } })()
      t.eq('the command was terminated', alive, false)
      t.eq('the reconstruction worktree is gone', await worktrees(c.projectPath), before)
      await gitWorktreeProvider.release({ projectPath: c.projectPath, path: c.ws.path })
    }
  } finally {
    await cleanupFixtures()
    await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  }
}
