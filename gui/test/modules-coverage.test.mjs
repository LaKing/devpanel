import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { coverageInput, modulesCoverage } from '../server/runtime/modules-coverage.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'
import { summarisePreview } from '../server/supervisor-summary.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'modules coverage — what the modules tier would test, read before a start (preview and readiness)'

const COLLECTIONS = ['@*']
const TARGET = { kind: 'ssh', tier: 'modules', modules: { collections: COLLECTIONS, rootFilter: 'core', test: { id: 'module-selftest', run: 'x {{filter}}' } } }
const AC1 = 'modules tier will test nothing for these paths'
const FP = (c) => `sha256:${c.repeat(64)}`
const recorded = (fromPaths, core = null, collections = COLLECTIONS) => ({ fingerprint: FP(fromPaths.length ? 'b' : 'a'),
  affectedModules: { triage: [], fromPaths, modules: fromPaths, unlisted: [], notInTree: [], core },
  modules: { changed: fromPaths, checksums: {}, collections } })

let issues = 0
const issueDir = async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'modules-coverage-')), `issue-${++issues}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** An ended run on disk, as the store reads it (path-overlap.test's layout); `plan` is the text of its plan step. */
async function writeRun (issuePath, runId, startedAt, record, { plan = null } = {}) {
  const dir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(path.join(dir, 'outputs'), { recursive: true })
  const number = runId.slice(-3)
  const steps = plan ? [{ number, slug: 'plan', stepId: 'plan', role: 'planner', phase: 'plan-review', round: 0 }] : []
  if (plan) {
    await fs.mkdir(path.join(issuePath, `${number}-plan`), { recursive: true })
    await fs.writeFile(path.join(issuePath, `${number}-plan`, 'response.md'), plan)
    await fs.writeFile(path.join(dir, 'outputs', `${number}.json`), JSON.stringify({ valid: true, contract: 'authorArtifact', output: { summary: 'the plan' } }))
  }
  await fs.writeFile(path.join(dir, 'resolved-playbook.json'), JSON.stringify({ reviewPolicy: {}, completion: { delivery: { action: 'apply-to-source' } }, workspace: {} }))
  await fs.writeFile(path.join(dir, 'events.jsonl'), '')
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId, issue: {}, playbook: { id: 'plan-and-implement', strategy: 'plan-and-implement' }, participants: {}, budgets: { limits: {}, used: {} },
    status: 'blocked', startedAt, steps, revisions: [], approvals: [], checkResults: [], workspace: { state: 'removed' }, ...record }))
}

const read = async (issuePath, triage = []) => modulesCoverage({ target: TARGET, triage, input: await coverageInput({ issuePath, target: TARGET }) })

export default async function (t) {
  t.section('the reading itself')
  {
    t.eq('a target that is not a modules tier reads nothing', modulesCoverage({ target: { kind: 'local', commands: [] }, input: { known: false } }), null)
    t.eq('nor an undeclared one', modulesCoverage({ target: { tier: 'modules' }, input: { known: false } }), null)
    const tests = modulesCoverage({ target: TARGET, input: { known: true, source: 'plan', fromRun: 'r', paths: ['@c/m/file.mjs', 'README.md'] } })
    t.eq('known paths that match a module give tests, root with rootFilter', [tests.state, tests.filters], ['tests', ['@c/m', 'core']])
    t.ok('with no warning in its words', !tests.detail.includes('test nothing'), tests.detail)
    const nothing = modulesCoverage({ target: TARGET, input: { known: true, source: 'recorded-revision', fromRun: 'r', revision: FP('a'), affected: recorded([]).affectedModules } })
    t.eq('a known empty change set gives nothing', [nothing.state, nothing.filters], ['nothing', []])
    t.ok('in the words AC1 asks for, naming the run and revision', nothing.detail.startsWith(AC1) && nothing.detail.includes('gate will be inconclusive') && nothing.detail.includes(`run r revision ${FP('a')}`), nothing.detail)
    t.ok('and that it describes that change set, not the next author', nothing.detail.includes('not what the next author will change'))
    const triaged = modulesCoverage({ target: TARGET, triage: ['@c/t/'], input: { known: true, source: 'recorded-revision', fromRun: 'r', affected: recorded([]).affectedModules } })
    t.eq('a triage module is always tested, so an empty change set with one tests it', [triaged.state, triaged.filters], ['tests', ['@c/t']])
    const unknown = modulesCoverage({ target: TARGET, triage: ['@c/t'], input: { known: false, incomplete: [] } })
    t.eq('no evidence: unknown, even when the triage names modules, which are listed beside it (AC4)', [unknown.state, unknown.triageFilters, 'filters' in unknown], ['unknown', ['@c/t'], false])
    t.ok('and it never claims the tier will test nothing', !unknown.detail.includes('test nothing') && /unknown/.test(unknown.detail), unknown.detail)
    const bare = modulesCoverage({ target: TARGET, input: { known: false } })
    t.ok('nor without a triage list', bare.state === 'unknown' && !bare.detail.includes('test nothing') && bare.triageFilters.length === 0)
  }

  t.section('the reader: the issue\'s runs newest first, revision before plan in each (AC1, AC2, AC4)')
  {
    const none = await issueDir()
    t.eq('no runs: unknown', (await read(none)).state, 'unknown')

    const reported = await issueDir()
    await writeRun(reported, 'run-a-001', '2026-11-11T20:33:08.000Z', { revisions: [recorded([])], checkHistory: [{ tier: 'modules', revision: FP('a'), modules: { tests: 0 } }] })
    const said = await read(reported)
    t.eq('the reported case: the newest run\'s revision recorded nothing changed, no triage → nothing', [said.state, said.source, said.fromRun], ['nothing', 'recorded-revision', 'run-a-001'])
    t.ok('its words are AC1\'s', said.detail.startsWith(AC1), said.detail)
    t.eq('the earlier drive that tested nothing is a note beside it', said.earlierDrive?.run, 'run-a-001')

    const mixed = await issueDir()
    await writeRun(mixed, 'run-a-001', '2026-11-01T00:00:00.000Z', { revisions: [recorded([])] })
    await writeRun(mixed, 'run-b-002', '2026-11-02T00:00:00.000Z', {}, { plan: 'Change @c/m/file.mjs so it reads the config.' })
    const newerPlan = await read(mixed)
    t.eq('an older empty revision, a newer plan naming a module path → tests from the plan (AC2)', [newerPlan.state, newerPlan.source, newerPlan.fromRun, newerPlan.filters], ['tests', 'plan', 'run-b-002', ['@c/m']])
    t.ok('with no warning', !newerPlan.detail.includes('test nothing'))

    const reverse = await issueDir()
    await writeRun(reverse, 'run-b-001', '2026-11-01T00:00:00.000Z', {}, { plan: 'Change @c/m/file.mjs so it reads the config.' })
    await writeRun(reverse, 'run-a-002', '2026-11-02T00:00:00.000Z', { revisions: [recorded([])] })
    const newerEmpty = await read(reverse)
    t.eq('the reverse order: the newer run\'s empty revision → nothing, naming that run', [newerEmpty.state, newerEmpty.fromRun], ['nothing', 'run-a-002'])
    t.ok('in AC1\'s words', newerEmpty.detail.startsWith(AC1))

    const both = async (older, newer) => {
      const dir = await issueDir()
      await writeRun(dir, 'run-old-001', '2026-11-01T00:00:00.000Z', { revisions: [older] })
      await writeRun(dir, 'run-new-002', '2026-11-02T00:00:00.000Z', { revisions: [newer] })
      return read(dir)
    }
    const a = await both(recorded([]), recorded(['@c/m']))
    t.eq('two recorded revisions: the newer wins (it tests a module)', [a.state, a.fromRun, a.filters], ['tests', 'run-new-002', ['@c/m']])
    const b = await both(recorded(['@c/m']), recorded([]))
    t.eq('and the other way round (the newer changed nothing)', [b.state, b.fromRun], ['nothing', 'run-new-002'])

    const inRun = await issueDir()
    await writeRun(inRun, 'run-a-001', '2026-11-01T00:00:00.000Z', { revisions: [recorded([], { paths: 1, dirs: ['lib'] })] }, { plan: 'Change @c/m/file.mjs.' })
    const own = await read(inRun)
    t.eq('within one run the recorded revision wins over its plan; a core directory is a filter', [own.state, own.source, own.filters], ['tests', 'recorded-revision', ['lib']])

    const other = await issueDir()
    await writeRun(other, 'run-a-001', '2026-11-01T00:00:00.000Z', { revisions: [recorded([], null, ['*-modules'])] }, { plan: 'Change @c/m/file.mjs.' })
    const skipped = await read(other)
    t.eq('a revision recorded under other collections is skipped for that run\'s plan', [skipped.state, skipped.source], ['tests', 'plan'])

    const triageOnly = await issueDir()
    const unknown = await read(triageOnly, ['@c/t'])
    t.eq('no evidence with a triage list: unknown, the triage filters beside it', [unknown.state, unknown.triageFilters], ['unknown', ['@c/t']])
  }

  t.section('preview and readiness carry the reading; only nothing and unknown add a prerequisite')
  {
    const f = await engineFixture()
    const preview = (reading) => previewRun({ playbookId: 'implementation', configRoot: f.configRoot, modulesCoverage: async () => reading })
    const nothingReading = modulesCoverage({ target: TARGET, input: { known: true, source: 'recorded-revision', fromRun: 'r', affected: recorded([]).affectedModules } })
    const testsReading = modulesCoverage({ target: TARGET, input: { known: true, source: 'plan', fromRun: 'r', paths: ['@c/m/x.mjs'] } })
    const unknownReading = modulesCoverage({ target: TARGET, triage: ['@c/t'], input: { known: false } })
    const prereq = (p) => p.prerequisites.find((x) => x.kind === 'modules-coverage') ?? null
    const n = await preview(nothingReading)
    t.ok('nothing: a warning up front, in AC1\'s words', prereq(n)?.status === 'warning' && prereq(n).category === 'information' && prereq(n).detail.startsWith(AC1), JSON.stringify(prereq(n)))
    t.eq('the reading rides on the preview', n.modulesCoverage.state, 'nothing')
    t.ok('and on what the supervisor is shown', summarisePreview(n).modulesCoverage?.state === 'nothing' && summarisePreview(n).prerequisites.some((x) => x.kind === 'modules-coverage'))
    t.ok('it does not make the configuration unready', n.configurationReady === (await previewRun({ playbookId: 'implementation', configRoot: f.configRoot })).configurationReady)
    const ts = await preview(testsReading)
    t.eq('tests: no prerequisite (AC2)', prereq(ts), null)
    t.eq('the reading is still there', ts.modulesCoverage.state, 'tests')
    const u = await preview(unknownReading)
    t.ok('unknown: a prerequisite that says unknown, never nothing (AC4)', prereq(u)?.status === 'unknown' && !prereq(u).detail.includes('test nothing'), JSON.stringify(prereq(u)))
    t.eq('no injection, no reading', 'modulesCoverage' in (await previewRun({ playbookId: 'implementation', configRoot: f.configRoot })), false)

    const resolve = async () => ({ ok: true, resolved: { configHash: 'h', workspace: {}, completion: { delivery: { action: 'worktree-diff' } }, checks: { target: TARGET } } })
    const readiness = async (reading) => launchReadiness({ project: 'p', projectPath: f.projectPath, playbook: 'implementation', resolve, inspectLaunch: async () => ({}), inspect: async () => null,
      modulesCoverage: async (target) => target === TARGET ? reading : null })
    const rn = await readiness(nothingReading)
    t.ok('readiness names it under the configuration, called with the resolved target', rn.configuration.modulesCoverage?.state === 'nothing' && rn.configuration.modulesCoverage.detail.startsWith(AC1))
    t.eq('and stays ready', rn.configuration.ready, true)
    t.eq('tests on readiness: no warning', (await readiness(testsReading)).configuration.modulesCoverage.state, 'tests')
    t.eq('unknown on readiness', (await readiness(unknownReading)).configuration.modulesCoverage.state, 'unknown')
    const faulted = await launchReadiness({ project: 'p', projectPath: f.projectPath, playbook: 'implementation', resolve, inspectLaunch: async () => ({}),
      inspect: async () => ({ code: 'EMPTY_REPOSITORY', message: 'no commits', remedy: 'commit' }), modulesCoverage: async () => nothingReading })
    t.eq('a repository fault does not hide it', faulted.configuration.modulesCoverage?.state, 'nothing')
    await cleanupFixtures()
  }
}
