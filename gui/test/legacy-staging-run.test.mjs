import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_ROOT } from './helpers.mjs'
import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { planOf } from '../server/config/release-plan.mjs'
import { runResult, stagedReleasePassed } from '../server/runtime/run-result.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { stagedRelease } from '../server/runtime/release.mjs'
import { stagingPendingReport } from '../server/staging-coverage.mjs'
import { buildOverview, runsOf } from '../server/supervisor-overview.mjs'

export const name = 'legacy Staging runs — a run of the removed Staging playbook still reads, promotes and counts'

/*
 * The Staging playbook and its strategy were removed from the catalogue
 * (2026-11-07); staging releases are now the deployment playbook's staging
 * environment. A run recorded before that keeps its own snapshot
 * (resolved-playbook.json, tactic staging) and release receipt, and nothing that
 * reads it may need the playbook again. The fixture is such a run, as written to
 * disk: run.json, release.json, resolved-playbook.json and the release archive.
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legacy-staging-run')
const ISSUE = '2026-11-05-cut-a-staging-batch'
const RUN = '2026-11-05T10-00-00-000Z-legacy01'
const DELIVERED = { issueId: '2026-11-04-a-delivered-fix', runId: '2026-11-04T09-00-00-000Z-delivered' }

export default async function (t) {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-staging-'))
  try {
    await fs.cp(FIXTURE, projectDir, { recursive: true })
    const issuePath = path.join(projectDir, ISSUE)

    t.section('the catalogue no longer has it, and has no alias for it')
    {
      const cfg = await loadConfig({ root: CONFIG_ROOT })
      t.eq('no staging playbook or strategy', [cfg.playbooks.has('staging'), cfg.strategies.has('staging')], [false, false])
      t.eq('the id resolves to nothing', (await resolvePlaybook('staging', { root: CONFIG_ROOT, config: cfg })).ok, false)
    }

    t.section('the run and its snapshot read from disk unchanged')
    const runs = await runsOf(issuePath)
    const run = runs[0]
    {
      t.eq('the run record is read', [runs.length, run?.runId, run?.playbook?.strategy], [1, RUN, 'staging'])
      const snapshot = JSON.parse(await fs.readFile(path.join(issuePath, 'runs', RUN, 'resolved-playbook.json'), 'utf8'))
      t.eq('its snapshot still plans a staging release', [planOf(snapshot).mode, planOf(snapshot).staging, planOf(snapshot).legacy], ['staging', 'stage', true])
      t.eq('it reads as staged', runResult(run).result, 'staged')
      const explained = explainRun(run)
      t.eq('its explanation is unchanged', explained.headline, 'Done: installed and tested on staging')
      t.eq('and names what it carried', explained.releaseCoverage.covered, [DELIVERED])
      t.ok('its release passed', stagedReleasePassed(run.release, run))
    }

    t.section('a production release can still promote its archive')
    {
      const staged = await stagedRelease(projectDir, RUN, { findPacked: null })
      t.eq('the receipt and the verified archive are returned', [staged.runId, staged.tactic, staged.archive], [RUN, 'staging', path.join(issuePath, 'runs', RUN, 'artifacts', 'release.tar')])
    }

    t.section('its coverage still counts in stagingPending, open and archived, and in the overview')
    {
      // A delivery the Staging run carried. Its patch is not kept here, so on its own it reads indeterminate.
      const deliveredIssue = { id: DELIVERED.issueId, project: 'example-project', path: path.join(projectDir, 'elsewhere', DELIVERED.issueId) }
      const deliveredRun = { runId: DELIVERED.runId, status: 'completed', outcome: 'resolved', startedAt: '2026-11-04T09:00:00.000Z', revisions: [{ fingerprint: 'rev' }],
        delivery: { action: 'apply-to-source', revision: 'rev', completedAt: '2026-11-04T09:30:00.000Z', artifactRef: 'artifacts/x.patch', application: { verified: true } } }
      const legacyOpen = { id: ISSUE, project: 'example-project', path: issuePath, archived: false }
      const legacyPacked = { id: ISSUE, project: 'example-project', archived: true, packed: true }
      const ctx = (issues) => ({
        project: 'example-project',
        listIssues: async (_project, { archived = false } = {}) => issues.filter((i) => Boolean(i.archived) === archived),
        readRuns: async (dir) => (dir === issuePath ? runsOf(dir) : [deliveredRun]),
        // A packed issue's runs are read from its bundle's record; here, the same run.json.
        readPackedRuns: async (_project, id) => (id === ISSUE ? runs : []),
        readOperations: async () => []
      })
      const listed = (report) => [...report.pending, ...report.indeterminate].map((e) => e.runId)
      t.eq('without the Staging run the delivery is waiting', listed(await stagingPendingReport({ ...ctx([deliveredIssue]), infrastructure: null })), [DELIVERED.runId])
      t.eq('with it, in an open issue, nothing waits', listed(await stagingPendingReport({ ...ctx([deliveredIssue, legacyOpen]), infrastructure: null })), [])
      t.eq('with it, in an archived (packed) issue, nothing waits', listed(await stagingPendingReport({ ...ctx([deliveredIssue, legacyPacked]), infrastructure: null })), [])
      const c = ctx([deliveredIssue, legacyOpen])
      const overview = await buildOverview({ projects: ['example-project'], listIssues: c.listIssues, readRuns: c.readRuns, readPackedRuns: c.readPackedRuns,
        stagingPending: (project) => stagingPendingReport({ ...c, project, infrastructure: null }) })
      const line = overview.projects[0].stagingPending
      t.eq('the overview\'s stagingPending counts it too', [line.pending, line.indeterminate], [[], []])
    }
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true })
  }
}
