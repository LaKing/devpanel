import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { latestRefusal } from '../server/runtime/refused-seat.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'
import { summarisePreview } from '../server/supervisor-summary.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'refused seat — readiness and preview warn when a start puts a refused model back on its seat'

const MODEL = 'gpt-6.2-sol'
const OTHER = 'gpt-6-sol'
const OLD = '2026-11-01T00-00-00-000Z-aaaaaaaa'
const NEW = '2026-11-02T00-00-00-000Z-bbbbbbbb'

let issues = 0
const issueDir = async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'refused-seat-')), `issue-${++issues}`)
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true })
  return dir
}

/** Only run.json, deliberately without events.jsonl: the state in which store.readRun would write a recovery finding. */
async function writeRun (issuePath, runId, record, { raw = null } = {}) {
  const dir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'run.json'), raw ?? JSON.stringify({ runId, ...record }))
}

const refusal = (extra = {}) => ({
  status: 'failed',
  failure: { class: 'refusal', message: 'the provider refused', role: 'auditor-1', stepId: 'audit', invocationId: 'i1', retries: 0, availability: null },
  failures: [{ invocationId: 'i1', role: 'auditor-1', class: 'refusal', model: MODEL }],
  participants: { coordinator: { role: 'coordinator', model: 'opus-5-5', state: 'ready' }, 'auditor-1': { role: 'auditor-1', model: MODEL, state: 'ready' } },
  ...extra
})

const listing = async (dir) => (await fs.readdir(dir, { recursive: true })).sort()

export default async function (t) {
  const f = await engineFixture({ auditor: MODEL })
  const resolve = (id, opts) => resolvePlaybook(id, { ...opts, root: f.configRoot })
  const preview = (issuePath, runOptions = {}) => previewRun({ playbookId: 'implementation', configRoot: f.configRoot, issue: { name: 'x', path: issuePath, project: 'p' }, runOptions })
  const readiness = (issuePath, runOptions = {}) => launchReadiness({ project: 'p', issueId: 'i', projectPath: f.projectPath, playbook: 'implementation', runOptions,
    resolve, inspectLaunch: async () => ({}), inspect: async () => null, refusedSeat: () => latestRefusal(issuePath) })
  const inPreview = (p) => p.prerequisites.filter((x) => x.kind === 'refused-seat')
  const inReadiness = (r) => r.configuration.prerequisites.filter((x) => x.kind === 'refused-seat')

  t.section('the fixture seats the refused model by default (AC5)')
  const empty = await issueDir()
  const baseline = await preview(empty)
  t.eq('auditor-1 resolves to the refused model', baseline.participants.find((p) => p.role === 'auditor-1')?.model, MODEL)
  const changed = await preview(empty, { participants: { 'auditor-1': { model: OTHER } } })
  t.eq('runOptions.participants changes it', changed.participants.find((p) => p.role === 'auditor-1')?.model, OTHER)

  t.section('a refused run and the same model: readiness and preview warn (AC1, AC2, AC5)')
  {
    const issue = await issueDir()
    await writeRun(issue, OLD, refusal())
    const before = await listing(issue)
    const r = await readiness(issue)
    const entries = inReadiness(r)
    t.eq('readiness: one refused-seat prerequisite', entries.length, 1)
    t.ok('naming the run, the seat and the model', entries[0]?.detail.includes(OLD) && entries[0].detail.includes('auditor-1') && entries[0].detail.includes(MODEL), entries[0]?.detail)
    t.eq('as information, with its fields', [entries[0]?.category, entries[0]?.condition, entries[0]?.runId, entries[0]?.seat, entries[0]?.model], ['information', 'refused-seat', OLD, 'auditor-1', MODEL])
    t.ok('in words that do not claim the run stopped', /recorded a provider refusal/.test(entries[0]?.detail) && !/stopped/.test(entries[0]?.detail), entries[0]?.detail)
    t.eq('readiness stays ready (AC4)', r.configuration.ready, true)
    t.eq('and the baseline is untouched', r.baselineReady, true)

    const p = await preview(issue)
    const pe = inPreview(p)
    t.eq('preview, with no reader injected (the CLI path): one entry', pe.length, 1)
    t.eq('the same entry', [pe[0]?.category, pe[0]?.runId, pe[0]?.seat, pe[0]?.model, pe[0]?.detail], ['information', OLD, 'auditor-1', MODEL, entries[0]?.detail])
    t.eq('the configuration stays ready (AC4)', p.configurationReady, baseline.configurationReady)
    t.ok('and the supervisor is shown it', summarisePreview(p).prerequisites.some((x) => x.kind === 'refused-seat'))
    t.eq('the lookup wrote nothing', await listing(issue), before)

    t.section('a changed model: no warning (AC3, AC5)')
    const other = { participants: { 'auditor-1': { model: OTHER } } }
    t.eq('readiness', inReadiness(await readiness(issue, other)).length, 0)
    t.eq('preview', inPreview(await preview(issue, other)).length, 0)
  }

  t.section('every stopped kind warns')
  {
    const kinds = {
      'quarantined blocked, a sibling still invoking': refusal({ status: 'blocked', blockedReason: 'recovery-required', integrity: { status: 'quarantined' },
        participants: { 'auditor-1': { role: 'auditor-1', model: MODEL, state: 'recovery-required' },
          implementer: { role: 'implementer', model: 'opus-5-5', state: 'invoking', pendingInvocation: { invocationId: 'i2', quarantinedReport: 'integrity/i2-quarantine.json' } } } }),
      'cleanup-blocked': refusal({ status: 'blocked', blockedReason: 'cleanup-unproved' }),
      'abandoned after failing': refusal({ status: 'cancelled', abandonment: { previousStatus: 'failed' }, participants: { 'auditor-1': { role: 'auditor-1', model: MODEL, state: 'abandoned' } } }),
      'abandoned after blocking': refusal({ status: 'cancelled', abandonment: { previousStatus: 'blocked' } })
    }
    for (const [label, record] of Object.entries(kinds)) {
      const issue = await issueDir()
      await writeRun(issue, OLD, record)
      t.eq(`${label}: readiness`, inReadiness(await readiness(issue)).length, 1)
      t.eq(`${label}: preview`, inPreview(await preview(issue)).length, 1)
    }
    const fallback = await issueDir()
    await writeRun(fallback, OLD, refusal({ failures: [] }))
    t.eq('the seat\'s recorded model stands in when no attempt names one', (await latestRefusal(fallback))?.model, MODEL)
  }

  t.section('no warning otherwise (AC3)')
  {
    const cases = {
      'another failure class': async (i) => writeRun(i, OLD, refusal({ failure: { class: 'runtime', role: 'auditor-1', invocationId: 'i1' } })),
      'a refusal on a run still running': async (i) => writeRun(i, OLD, refusal({ status: 'running' })),
      'a cancelled run nobody abandoned': async (i) => writeRun(i, OLD, refusal({ status: 'cancelled' })),
      'a newer completed run': async (i) => { await writeRun(i, OLD, refusal()); await writeRun(i, NEW, { status: 'completed', failure: null, participants: {} }) },
      'a newer run whose record cannot be read': async (i) => { await writeRun(i, OLD, refusal()); await writeRun(i, NEW, null, { raw: '{ not json' }) },
      'no runs at all': async () => {}
    }
    for (const [label, arrange] of Object.entries(cases)) {
      const issue = await issueDir()
      await arrange(issue)
      t.eq(`${label}: readiness`, inReadiness(await readiness(issue)).length, 0)
      t.eq(`${label}: preview`, inPreview(await preview(issue)).length, 0)
    }
    t.eq('no runs directory: nothing', await latestRefusal(path.join(os.tmpdir(), 'refused-seat-absent-issue')), null)
  }

  t.section('a retained worktree with its own run.json does not hide the latest refusal')
  {
    const issue = await issueDir()
    await writeRun(issue, OLD, refusal())
    await writeRun(issue, `worktree-${OLD}`, { status: 'completed', failure: null })
    await writeRun(issue, `workspace-${OLD}`, { status: 'completed', failure: null })
    t.eq('the refused run is still the latest', (await latestRefusal(issue))?.runId, OLD)
    t.eq('and readiness warns', inReadiness(await readiness(issue)).length, 1)
  }

  await cleanupFixtures()
}
