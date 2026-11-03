import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRun, worktreeDiffDelivery, releaseOwnership } from '../server/runtime/launch.mjs'
import { carryForward, carryForwardBrief } from '../server/runtime/carry-forward.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
export const name = 'carry-forward — an approved, undelivered patch seeds the next run of the issue'

/*
 * Run 1 writes the patch, is approved, and is refused delivery because the
 * live checkout changed the same file meanwhile. Run 2 starts on the same
 * issue: its worktree must start from run 1's patch, and its turns must say so.
 */
async function setup () {
  let engine
  let first = true
  const prompts = []
  const script = scriptFor()
  const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async turn => {
    prompts.push({ run: engine?.runId, stepId: turn.stepId, prompt: turn.prompt })
    if (turn.stepId === 'implement' && first) {
      await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), 'console.log("Hello Beautiful world")')
      await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello Other world")')
    }
    return script(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
  } })
  await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello World")')
  await git(f.projectPath, 'add', 'server.mjs')
  await git(f.projectPath, 'commit', '-qm', 'server')
  const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'opus-5' } } }
  const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
  const start = async () => {
    engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider: worktreeDiffDelivery,
      expectConfigHash: resolved.resolved.configHash, runOptions: options })
    return engine
  }
  const one = await start()
  await one.drive()
  await releaseOwnership(one, { reason: 'test: keep the candidate' })
  first = false
  return { f, one, start, prompts }
}

export default async function (t) {
  t.section('the source is back where the patch fits: run 2 starts with the patch applied and delivers it')
  {
    const { f, one, start, prompts } = await setup()
    t.eq('run 1 was refused for drift on its own path', one.run.delivery?.application?.state, 'source-drift', one.run.blockedReason)
    await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello World")')
    const two = await start()
    t.eq('the seed names run 1', two.run.workspace.seed?.fromRun, one.runId)
    t.eq('the patch applied cleanly', two.run.workspace.seed?.state, 'applied', two.run.workspace.seed?.error)
    t.eq('the worktree holds the approved bytes', await fs.readFile(path.join(two.run.workspace.path, 'server.mjs'), 'utf8'), 'console.log("Hello Beautiful world")')
    await two.drive()
    const told = prompts.filter((p) => p.run === two.runId && p.prompt.includes(`This run continues run ${one.runId}`))
    t.ok('every turn of run 2 was told', told.length > 0 && told.length === prompts.filter((p) => p.run === two.runId).length, `${told.length}`)
    t.eq('run 2 delivered the carried patch', two.run.delivery?.application?.state, 'complete', two.run.delivery?.error)
    t.ok('its record names the paths it changed', two.run.delivery?.changedPaths?.includes('server.mjs'), JSON.stringify(two.run.delivery?.changedPaths))
    t.eq('the source runs the approved code', (await exec('node', [path.join(f.projectPath, 'server.mjs')])).stdout, 'Hello Beautiful world\n')
    await releaseOwnership(two, { reason: 'test' }).catch(() => {})
  }

  t.section('the source still conflicts: run 2 starts with conflict markers and is told where')
  {
    const { one, start } = await setup()
    const two = await start()
    t.eq('the seed names run 1', two.run.workspace.seed?.fromRun, one.runId)
    t.eq('the three-way merge conflicted', two.run.workspace.seed?.state, 'conflicts', JSON.stringify(two.run.workspace.seed))
    t.eq('the conflicted path is listed', two.run.workspace.seed?.conflicts, ['server.mjs'])
    t.ok('the file holds both sides', (await fs.readFile(path.join(two.run.workspace.path, 'server.mjs'), 'utf8')).includes('<<<<<<<'))
    await releaseOwnership(two, { reason: 'test' }).catch(() => {})
  }

  t.section('git stopped at the output limit: the seed says so, with the limit, and the run still has the patch')
  {
    const { f, one, start } = await setup()
    const two = await start()
    // The worktree as provisioning hands it to carryForward: the snapshot, before any merge.
    const file = path.join(two.run.workspace.path, 'server.mjs')
    const snapshot = 'console.log("Hello Other world")'
    await fs.writeFile(file, snapshot)
    const carry = (extra) => carryForward({ issuePath: f.issuePath, runId: two.runId, workspace: two.run.workspace, sourceRepository: two.run.workspace.repository?.source, ...extra })

    const seed = await carry({ outputLimit: 16 })
    t.eq('the seed stays context-only and is not fatal', [seed?.fromRun, seed?.state], [one.runId, 'context-only'])
    t.ok('the error names the git call and the limit', /git apply printed more than the 16 bytes/.test(seed?.error ?? ''), seed?.error)
    t.eq('nothing is read from the cut-short output', seed?.conflicts, [])
    t.eq('the worktree is as it was', await fs.readFile(file, 'utf8'), snapshot)
    t.ok('the patch is still handed over', (await fs.stat(seed?.patch)).size > 0, seed?.patch)
    t.ok('and every turn is told the limit', carryForwardBrief(seed).includes('16 bytes'), carryForwardBrief(seed))

    const unlimited = await carry({})
    t.eq('under the stated limit the same tree merges as before', [unlimited?.state, unlimited?.error], ['conflicts', null])
    await releaseOwnership(two, { reason: 'test' }).catch(() => {})
  }
}
