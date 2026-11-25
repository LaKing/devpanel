import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { conflicts, exclusivityOf, writesCheckout } from '../server/run-exclusivity.mjs'
import { createSupervisor } from '../server/supervisor.mjs'

export const name = 'run exclusivity — what writes the checkout, who shares a project, and which writing runs a full verification\'s freeze holds'

const isolated = (tactic, action = 'none') => ({ tactic, workspace: { isolation: 'git-worktree' }, completion: { delivery: { action } } })
const inPlace = (tactic = 'implementation') => ({ tactic, workspace: { isolation: 'in-place' }, completion: { delivery: { action: 'in-place' } } })

export default async function (t) {
  const temps = []
  try {
    t.section('1. what writes the checkout: delivery, release or in place; Analysis, Triage and inquiries only read')
    {
      t.eq('an analysis (no delivery, own worktree) reads', writesCheckout(isolated('analysis')), false)
      t.eq('a triage reads', writesCheckout(isolated('triage')), false)
      t.eq('an analysis in place writes', writesCheckout({ ...isolated('analysis'), workspace: { isolation: 'in-place' } }), true)
      t.eq('a deployment writes', writesCheckout(isolated('deployment')), true)
      t.eq('a staging release writes', writesCheckout(isolated('staging')), true)
      t.eq('an implementation that applies to the source writes', writesCheckout(isolated('implementation', 'apply-to-source')), true)
      t.eq('a run that cannot be read is taken to write', writesCheckout(null), true)
      t.eq('exclusivity: in place, release, unknown', [exclusivityOf(inPlace()), exclusivityOf(isolated('deployment')), exclusivityOf(null)], [{ inPlace: true, release: false }, { inPlace: false, release: true }, { unknown: true }])
    }

    t.section('2. a freeze scoped to the cycle\'s projects holds in-place, release and delivering runs of those projects as before, and none of any other project')
    {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-exclusivity-'))
      temps.push(dir)
      const issues = { getRunHolder: async () => { throw Object.assign(new Error('no such issue'), { status: 404 }) }, getIssue: async () => { throw Object.assign(new Error('no such issue'), { status: 404 }) }, listIssues: async () => [], listProjects: async () => [] }
      const supervisor = createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir })
      const asked = []
      const kinds = { 'in-place': inPlace(), release: isolated('staging'), delivering: isolated('implementation', 'apply-to-source'), reading: isolated('analysis') }
      for (const project of ['app-project', 'devpanel-project']) {
        for (const [kind, resolved] of Object.entries(kinds)) {
          const runId = `${project}:${kind}`
          supervisor.active.set(`${project}/${kind}`, { runId, project, issueId: kind, phase: 'run', writes: writesCheckout(resolved), engine: { run: { status: 'running' }, requestFreeze () { asked.push(runId); return null } } })
        }
      }
      const frozen = await supervisor.freeze('2026-11-25.1', { projects: ['app-project'] })
      const expected = ['app-project:in-place', 'app-project:release', 'app-project:delivering']
      t.eq('the scope\'s in-place, release and delivering runs are asked to pause, as today; its reading run is not', [frozen.map((r) => r.runId), asked], [expected, expected])
      t.eq('the cycle waits for exactly those', supervisor.busy().map((r) => r.runId), expected)
      t.ok('no run of the project outside the scope is asked or waited for, whatever it is', !asked.some((id) => id.startsWith('devpanel-project')) && !supervisor.busy().some((r) => r.project === 'devpanel-project'), JSON.stringify(asked))
      supervisor.active.clear()
      const codeOf = (promise) => promise.then(() => 'ran', (error) => error.code ?? error.message)
      t.eq('a finalize in the scope is refused FULL_VERIFICATION_FREEZE', await codeOf(supervisor.finalize({ project: 'app-project', issueId: 'x', runId: 'r1' })), 'FULL_VERIFICATION_FREEZE')
      const outside = await codeOf(supervisor.finalize({ project: 'devpanel-project', issueId: 'x', runId: 'r1' }))
      t.ok('one outside it is not refused for the cycle (on this fixture it fails for its own reason)', outside !== 'FULL_VERIFICATION_FREEZE', outside)
      supervisor.thaw('2026-11-25.1')
      t.eq('a freeze without a scope holds every project, as before', (await supervisor.freeze('2026-11-25.2')).length, 0)
      t.eq('and names none', supervisor.frozen().projects, null)
      supervisor.thaw('2026-11-25.2')
    }

    t.section('3. who shares a project is a separate rule, unchanged by any freeze')
    {
      t.eq('two isolated runs share', conflicts(exclusivityOf(isolated('implementation', 'apply-to-source')), exclusivityOf(isolated('analysis'))), false)
      t.eq('an in-place run shares with nobody', conflicts(exclusivityOf(inPlace()), exclusivityOf(isolated('analysis'))), true)
      t.eq('two release runs stay apart', conflicts(exclusivityOf(isolated('staging')), exclusivityOf(isolated('deployment'))), true)
      t.eq('an unreadable run conflicts', conflicts(exclusivityOf(null), exclusivityOf(isolated('analysis'))), true)
    }
  } finally {
    for (const d of temps) await fs.rm(d, { recursive: true, force: true })
  }
}
