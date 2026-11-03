import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { resumeUnavailable } from '../server/runtime/run-control.mjs'

/*
 * A shutdown during preflight, in-process and with no listening socket, so it can
 * run under an isolation that refuses loopback. The run has no workspace yet:
 * a pending pause still becomes a pause, an unpaused run is still marked, and
 * resuming either one does the setup it never finished.
 * (shutdown-resume.control.test.mjs is the same contract through a real server.)
 */

export const name = 'a shutdown during preflight: paused or marked, and resumable without a workspace'

const P = 'devpanel-project'
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')

export default async function (t) {
  const before = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-shutdown-setup-'))
  try {
    const f = await engineFixture()
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, P))
    process.env.DEVPANEL_PROJECTS_DIR = projectsDir
    process.env.DEVPANEL_FAKE_CONTROL = path.join(state, 'control.json')
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(HARNESS_MODULE)}\n`)
    const setControl = (control) => fs.writeFile(process.env.DEVPANEL_FAKE_CONTROL, JSON.stringify({ ledger: path.join(state, 'ledger.jsonl'), delayMs: 0, ...control }))
    const supervisor = () => createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
    const read = async (issue, runId) => JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
    const inPreflight = async (name) => {
      await setControl({ probeDelayMs: 30000 })
      const issue = await f.issues.createIssue(P, { name })
      const s = supervisor()
      const { runId, status } = await s.start({ project: P, issueId: issue.id, playbookId: 'implementation', configRoot: f.configRoot })
      t.eq(`${name}: it is preflighting`, status, 'preflighting')
      return { issue, runId, s, named: { project: P, issueId: issue.id, runId } }
    }

    t.section('a pause accepted during preflight is honoured by a shutdown')
    {
      const { issue, runId, s, named } = await inPreflight('Pause during preflight')
      const limits = (await read(issue, runId)).budgets.limits
      t.eq('the pause is accepted', (await s.pause(named)).pauseRequested, true)
      t.eq('the shutdown settles', (await s.shutdown({ graceMs: 15000 })).settled, true)
      const paused = await read(issue, runId)
      t.eq('recorded as a manual pause, not cancelled', [paused.status, paused.pause?.kind, paused.pauseRequested], ['paused', 'manual', null])
      t.eq('with no shutdown mark', paused.stoppedBy, undefined)
      t.eq('and no workspace', paused.workspace.path, null)
      t.eq('the ordinary resume would accept it', resumeUnavailable(paused), null)

      const next = supervisor()
      await next.reconcile()
      t.eq('the next start resumes nothing', await next.resumeInterrupted(), { resumed: [], refused: [] })
      t.eq('and it stays paused', (await read(issue, runId)).status, 'paused')

      await setControl({})
      t.eq('the ordinary resume runs its setup', (await next.resume({ ...named, actor: 'alice', origin: 'panel' })).status, 'preflighting')
      await next.settle()
      const after = await read(issue, runId)
      t.ok('it was provisioned', Boolean(after.workspace.path), after.status)
      t.ok('and its turns ran', after.steps.length > 0, after.blockedReason)
      t.eq('the preflight is the second one, and it passed', after.preflight.state, 'passed')
      const entry = after.resumeHistory.at(-1)
      t.eq('the resume names who did it', [entry.actor, entry.origin, entry.previousStatus], ['alice', 'panel', 'paused'])
      t.eq('its limits are unchanged', [entry.limits, after.budgets.limits], [limits, limits])
    }

    t.section('an unpaused run stopped during preflight is marked, and the next start resumes it')
    {
      const { issue, runId, s, named } = await inPreflight('Stopped during preflight')
      const limits = (await read(issue, runId)).budgets.limits
      await s.shutdown({ graceMs: 15000 })
      const stopped = await read(issue, runId)
      t.eq('cancelled and marked', [stopped.status, stopped.stoppedBy], ['cancelled', 'service-shutdown'])
      t.eq('a person could resume it too', resumeUnavailable(stopped), null)

      await setControl({})
      const next = supervisor()
      await next.reconcile()
      t.eq('the next start resumes it', await next.resumeInterrupted(), { resumed: [named], refused: [] })
      await next.settle()
      const after = await read(issue, runId)
      t.ok('it was provisioned', Boolean(after.workspace.path), after.status)
      const entry = after.resumeHistory.at(-1)
      t.eq('the record names the service', [entry.actor, entry.origin], ['service', 'service-restart'])
      t.eq('its limits are unchanged', [entry.limits, after.budgets.limits], [limits, limits])
      t.eq('the mark is answered', after.stoppedBy, undefined)
    }

    t.section('an operator\'s stop during preflight is not that: not marked, not resumable')
    {
      const { issue, runId, s, named } = await inPreflight('Operator stop during preflight')
      await s.pause(named)
      await s.stop(named)
      await s.settle()
      const stopped = await read(issue, runId)
      t.eq('cancelled, unmarked, and no pause', [stopped.status, stopped.stoppedBy, stopped.pause ?? null], ['cancelled', undefined, null])
      t.ok('resume refuses it, as before', Boolean(resumeUnavailable(stopped)))
      const next = supervisor()
      await next.reconcile()
      t.eq('the next start leaves it alone', await next.resumeInterrupted(), { resumed: [], refused: [] })
    }
  } finally {
    await cleanupFixtures()
    if (before.projects === undefined) delete process.env.DEVPANEL_PROJECTS_DIR
    else process.env.DEVPANEL_PROJECTS_DIR = before.projects
    if (before.control === undefined) delete process.env.DEVPANEL_FAKE_CONTROL
    else process.env.DEVPANEL_FAKE_CONTROL = before.control
    await fs.rm(state, { recursive: true, force: true })
  }
}
