import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

import { readPoolLocks } from '../server/runtime/module-locks.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { engineFixture } from './fakes/fixture.mjs'

export const name = 'module locks at start — disjoint issues run in parallel, a shared module is refused naming the holder, the locks go at the run\'s end'

const P = 'devpanel-project'
const POOL = 'framework-project'
const NL = String.fromCharCode(10)
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')

export default async function (t) {
  const f = await engineFixture()
  const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
  try {
    // devpanel-project is an instance of framework-project: one pool of modules.
    await fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true })
    await fs.writeFile(path.join(f.configRoot, 'projects', `${POOL}.yaml`), YAML.stringify({ id: POOL, workspace: { base: 'head' } }))
    await fs.writeFile(path.join(f.configRoot, 'projects', `${P}.yaml`), YAML.stringify({ id: P, framework: POOL }))
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, P)).catch(() => {})
    process.env.DEVPANEL_PROJECTS_DIR = projectsDir
    // Every turn takes a while, so the first runs are still live when the next start comes.
    const control = path.join(f.issuesDir, 'control.json')
    await fs.writeFile(control, JSON.stringify({ ledger: path.join(f.issuesDir, 'ledger.jsonl'), delayMs: 1500 }))
    process.env.DEVPANEL_FAKE_CONTROL = control
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(HARNESS_MODULE)}` + NL)
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })

    const sized = async (name, modules) => {
      const issue = await f.issues.createIssue(P, { name })
      const file = path.join(issue.path, 'issue.json')
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), sizing: { affectedModules: modules } }, null, 2) + NL)
      return issue
    }
    const first = await sized('Changes the framework module', ['@c/x', 'own-modules/a'])
    const second = await sized('Changes another module', ['own-modules/b'])
    const third = await sized('Also changes the framework module', ['@c/x'])

    t.section('disjoint module sets start in parallel, without asking')
    const one = await supervisor.start({ project: P, issueId: first.id, playbookId: f.playbookId, configRoot: f.configRoot })
    const two = await supervisor.start({ project: P, issueId: second.id, playbookId: f.playbookId, configRoot: f.configRoot })
    t.ok('both start', Boolean(one.runId && two.runId))
    t.eq('both are live at once', [supervisor.isActive(P, first.id), supervisor.isActive(P, second.id)], [true, true])
    const locks = await readPoolLocks(POOL)
    t.eq('each run holds its issue\'s modules in the pool', locks.map((l) => [l.module, l.runId === one.runId ? 'first' : l.runId === two.runId ? 'second' : l.runId]), [['@c/x', 'first'], ['own-modules/a', 'first'], ['own-modules/b', 'second']])
    const record = JSON.parse(await fs.readFile(path.join(first.path, 'runs', one.runId, 'run.json'), 'utf8'))
    t.eq('the run records its pool and its locks', [record.modulePool?.id, record.moduleLocks?.held.map((h) => h.module)], [POOL, ['@c/x', 'own-modules/a']])

    t.section('a start sharing a module is refused from the panel, the holder named, and leaves no run behind')
    const refused = await supervisor.start({ project: P, issueId: third.id, playbookId: f.playbookId, configRoot: f.configRoot }).catch((e) => e)
    t.eq('409, retryable, MODULE_LOCKED', [refused.status, refused.retryable, refused.started, refused.code], [409, true, false, 'MODULE_LOCKED'])
    t.ok('naming the module and the holding run', refused.message?.includes('@c/x') && refused.message.includes(one.runId), refused.message)
    t.eq('the holder in the detail', refused.holders?.map((h) => [h.module, h.runId, h.issueId]), [['@c/x', one.runId, first.id]])
    t.eq('no run directory for the refused issue', await fs.readdir(path.join(third.path, 'runs')).catch(() => []), [])
    const reading = await supervisor.moduleLockReading({ project: P, issueId: third.id })
    t.eq('readiness reads the same: moduleLocks names the conflict', reading.conflicts.map((c) => [c.module, c.runId]), [['@c/x', one.runId]])

    t.section('the locks are released at the run\'s end, and the shared issue can start')
    await supervisor.settle()
    const ended = JSON.parse(await fs.readFile(path.join(first.path, 'runs', one.runId, 'run.json'), 'utf8'))
    t.eq('the ended run holds nothing and says what it released', [ended.moduleLocks?.held, ended.moduleLocks?.released?.modules], [[], ['@c/x', 'own-modules/a']], ended.status)
    t.eq('the pool is empty', (await readPoolLocks(POOL)).length, 0)
    const later = await supervisor.start({ project: P, issueId: third.id, playbookId: f.playbookId, configRoot: f.configRoot })
    t.ok('the shared issue starts now', Boolean(later.runId))

    t.section('an integrity continuation of an ended run re-takes its modules first (auditor-1-006)')
    const integrity = () => supervisor.resolveIntegrity({ project: P, issueId: first.id, runId: one.runId, disposition: 'accept-partial', expectedStateHash: 'inspected', reason: 'continue', actor: 'operator' }).catch((e) => e)
    const blocked = await integrity()
    t.eq('while the shared issue\'s run holds @c/x it is refused as occupied, before the integrity check is reached', [blocked.status, blocked.code, blocked.holders?.[0]?.runId], [409, 'MODULE_LOCKED', later.runId], blocked.message)
    const afterRefusal = JSON.parse(await fs.readFile(path.join(first.path, 'runs', one.runId, 'run.json'), 'utf8'))
    t.eq('the refused continuation keeps the set required on the record', [afterRefusal.moduleLocks.held, afterRefusal.moduleLocks.released?.modules], [[], ['@c/x', 'own-modules/a']])
    await supervisor.settle()
    const free = await integrity()
    t.ok('once free, the locks are taken and only the integrity check refuses (this run has no quarantine)', free.status === 409 && free.code !== 'MODULE_LOCKED', `${free.code} ${free.message}`)
    const afterIntegrity = JSON.parse(await fs.readFile(path.join(first.path, 'runs', one.runId, 'run.json'), 'utf8'))
    t.eq('a continuation that did not go on gives them back, still required', [(await readPoolLocks(POOL)).length, afterIntegrity.moduleLocks.held, afterIntegrity.moduleLocks.released?.modules], [0, [], ['@c/x', 'own-modules/a']])
  } finally {
    for (const [key, env] of [['projects', 'DEVPANEL_PROJECTS_DIR'], ['control', 'DEVPANEL_FAKE_CONTROL']]) {
      if (saved[key] === undefined) delete process.env[env]
      else process.env[env] = saved[key]
    }
  }
}
