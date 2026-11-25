import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { CHANGES_MS, changeList, changesSection, createFullVerification, cycleChanges, redIssueReport } from '../server/full-verification.mjs'
import { manualClock } from '../server/runtime/clock.mjs'
import { startCycleByHand } from './helpers.mjs'

export const name = 'full verification — what changed since the last verification: range, attribution by content, the list, the red issue, information only'

const exec = promisify(execFile)
const temps = []
const tmp = async (p = 'fv-changes-') => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
const sha1 = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
const ZERO = '0'.repeat(40)
const T1 = '2026-11-20T00:00:00.000Z'
const at = (min) => new Date(Date.parse(T1) + min * 60_000).toISOString()

/** A file of a delivery's patch, as its own diff writes it. */
const section = (rel, pre, post) => [
  `diff --git a/${rel} b/${rel}`,
  pre === null ? 'new file mode 100644' : null,
  post === null ? 'deleted file mode 100644' : null,
  `index ${pre === null ? ZERO : sha1(pre)}..${post === null ? ZERO : sha1(post)}${pre !== null && post !== null ? ' 100644' : ''}`,
  `--- a/${rel}`, `+++ b/${rel}`, '@@ -1 +1 @@'
].filter(Boolean).join('\n') + '\n'

async function repoAt (dir) {
  await fs.mkdir(dir, { recursive: true })
  const git = async (...args) => (await exec('git', ['-C', dir, '-c', 'user.email=a@example.invalid', '-c', `user.name=${git.author}`, ...args], { encoding: 'utf8' })).stdout.trim()
  git.author = 'Someone'
  await git('init', '-q')
  const write = async (rel, text) => { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), text) }
  const commit = async (files, subject, author = 'Someone') => {
    for (const [rel, text] of Object.entries(files)) await write(rel, text)
    git.author = author
    await git('add', '-A')
    await git('commit', '-qm', subject)
    return git('rev-parse', 'HEAD')
  }
  return { dir, git, write, commit }
}

/** Issues of projects, each run delivered into a checkout: `changes` is [path, before, after]. */
function issueStore (root) {
  const byProject = new Map()
  return {
    async deliver (project, runId, when, changes, extra = {}) {
      const issue = { id: `issue-${runId}`, project, name: `Issue of ${runId}`, path: path.join(root, project, `issue-${runId}`), archived: false }
      const runDir = path.join(issue.path, 'runs', runId)
      await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
      await fs.writeFile(path.join(runDir, 'artifacts', 'x.patch'), changes.map(([p, a, b]) => section(p, a, b)).join(''))
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId, status: 'completed', outcome: 'resolved', startedAt: when, endedAt: when, revisions: [{ fingerprint: 'rev' }],
        delivery: { action: 'apply-to-source', revision: 'rev', completedAt: when, artifactRef: 'artifacts/x.patch', application: { verified: true } }, ...extra }))
      byProject.set(project, [...(byProject.get(project) ?? []), issue])
    },
    listIssues: async (project, { archived = false } = {}) => (archived ? [] : byProject.get(project) ?? []),
    listHomes: async () => []
  }
}

const sections = (repo) => Object.fromEntries(repo.sections.map((s) => [s.kind, s]))

export default async function (t) {
  try {
    t.section('1. two cycles on one checkout: range, each commit attributed, the deliveries since, the uncommitted paths')
    {
      const root = await tmp()
      const app = await repoAt(path.join(root, 'app'))
      const checkout = await fs.realpath(app.dir)
      const store = issueStore(path.join(root, 'issues'))
      const A = await app.commit({ a: '0', b: '0' }, 'base')
      // d1 was delivered (uncommitted) before cycle 1's snapshot, which tested and covered it; cycle 1's checkpoint commits it.
      await store.deliver('app-project', 'd1', at(-10), [['a', '0', '1']])
      const C = await app.commit({ a: '1', version: '1' }, 'checkpoint 1', 'cycle')
      // After cycle 1: d2 committed by a person together with a hand edit; d3 chained on d1's bytes; d4 split over two commits.
      await store.deliver('app-project', 'd2', at(10), [['b', '0', '2']])
      const H1 = await app.commit({ b: '2', h: 'hand' }, 'with a hand edit', 'Hand Person')
      await store.deliver('app-project', 'd3', at(20), [['a', '1', '3']])
      const D3 = await app.commit({ a: '3' }, 'd3 only')
      await store.deliver('app-project', 'd4', at(30), [['c', null, '4'], ['e', null, '4']])
      const S1 = await app.commit({ c: '4' }, 'first half')
      const S2 = await app.commit({ e: '4' }, 'second half')
      const H2 = await app.commit({ z: 'hand' }, 'pure hand', 'Hand Person')
      // d5's bytes are not on record (landed with hand changes): never attributed, its commit reads by hand.
      await store.deliver('app-project', 'd5', at(40), [['y', null, '5']], { landed: { applied: 'checkout', recordedAt: at(40), handChanges: 'edited after', revision: 'rev' } })
      const Y = await app.commit({ y: '5' }, 'd5 landed by hand')
      const HEAD = await app.git('rev-parse', 'HEAD')
      const cycle1 = {
        id: '2026-11-20.1', projects: [{ project: 'app-project', snapshot: { base: { headCommit: A } }, snapshotAt: T1, coverage: { covered: [{ issueId: 'issue-d1', runId: 'd1' }] } }],
        outcome: { bump: { chain: [{ project: 'app-project', headBefore: A, afterCommit: { state: 'compared', commit: C } }] } },
        changes: { repositories: [{ checkout, range: { to: { commit: A, at: T1, basis: 'snapshot-base' } } }] }
      }
      const record = { id: '2026-11-21.1', date: '2026-11-21', projects: [{ project: 'app-project', snapshot: { base: { headCommit: HEAD } }, snapshotAt: at(60),
        atSnapshot: { readAt: at(60), checkouts: [{ checkout: app.dir, head: HEAD, uncommitted: { paths: ['u'], total: 1 } }] } }] }
      const changes = await cycleChanges({ record, records: [cycle1], projectPathOf: async (p) => (p === 'app-project' ? app.dir : null), listIssues: store.listIssues, listHomes: store.listHomes, clock: manualClock(Date.parse(at(61))) })
      const repo = changes.repositories[0]
      t.eq('one repository, the snapshotted checkout, owned and read by the project', [changes.repositories.length, repo.checkout, repo.project, repo.readBy, repo.error], [1, checkout, 'app-project', ['app-project'], undefined])
      t.eq('the range: from cycle 1\'s snapshot HEAD to this snapshot\'s', [repo.range.from, repo.range.to.commit, repo.range.basis, repo.range.since, repo.range.fromIsAncestor], [{ commit: A, at: T1, cycleId: '2026-11-20.1' }, HEAD, 'previous-cycle', T1, true])
      const by = Object.fromEntries(repo.commits.list.map((c) => [c.sha, c]))
      t.eq('every commit of the range, oldest first, with its total', [repo.commits.list.map((c) => c.sha), repo.commits.total], [[C, H1, D3, S1, S2, H2, Y], 7])
      t.eq('the cycle checkpoint is the checkpoint; the delivery it carried is named, verified by cycle 1', [by[C].attribution, by[C].checkpoint, by[C].runs], ['cycle-checkpoint', { cycleId: '2026-11-20.1', project: 'app-project' }, [{ project: 'app-project', issueId: 'issue-d1', runId: 'd1', verifiedBy: '2026-11-20.1' }]])
      t.eq('a person\'s commit carrying a delivery and a hand edit: delivered, the hand path named, with author and subject', [by[H1].attribution, by[H1].runs.map((r) => r.runId), by[H1].handPaths, by[H1].author, by[H1].subject], ['delivered', ['d2'], { paths: ['h'], total: 1 }, 'Hand Person', 'with a hand edit'])
      t.eq('a chained delivery: only d3, never d1 again (its bytes stood at the parent)', [by[D3].attribution, by[D3].runs.map((r) => r.runId)], ['delivered', ['d3']])
      t.eq('a split delivery is carried by both commits', [by[S1].runs.map((r) => r.runId), by[S2].runs.map((r) => r.runId)], [['d4'], ['d4']])
      t.eq('a commit no delivery explains is by hand', [by[H2].attribution, by[H2].author, by[H2].subject, by[H2].handPaths], ['by-hand', 'Hand Person', 'pure hand', { paths: ['z'], total: 1 }])
      t.eq('a delivery with unknown bytes is never attributed', [by[Y].attribution, by[Y].runs], ['by-hand', []])
      t.eq('the deliveries since the last verification: d1, which cycle 1 tested and checkpointed, is not listed again', repo.deliveries.map((d) => [d.runId, d.commits]), [['d2', [H1]], ['d3', [D3]], ['d4', [S1, S2]], ['d5', []]])
      t.eq('a delivered issue carries its name and project', [repo.deliveries[0].issueId, repo.deliveries[0].issueName, repo.deliveries[0].project], ['issue-d2', 'Issue of d2', 'app-project'])
      t.eq('the uncommitted paths of the reading after the snapshot', repo.uncommitted, { paths: ['u'], total: 1 })
      t.ok('the record states its limits', changes.limits.length === 3 && changes.limits.some((l) => /already uncommitted/.test(l)) && changes.limits.some((l) => /indeterminate/.test(l)))

      t.section('2. the list as the API gives it: issues delivered, commits by hand, uncommitted, in that order')
      const list = changeList({ changes })
      const r = list.repositories[0]
      t.eq('computed, sections in order', [list.state, r.sections.map((s) => s.kind)], ['computed', ['delivered', 'by-hand', 'uncommitted']])
      t.eq('commits by hand: the pure one, the unknown one, and the delivered commit with a hand edit (mixed); never the checkpoint', sections(r)['by-hand'].items.map((c) => [c.sha, c.mixed ?? false]), [[H1, true], [H2, false], [Y, false]])
      t.eq('the counts', r.commits, { shown: 7, total: 7 })
      t.eq('not computed: a record without changes (a running cycle, an older record)', [changeList({}), changeList(null)], [{ state: 'not-computed' }, { state: 'not-computed' }])
      t.eq('failed: its error', changeList({ changes: { error: 'boom' } }), { state: 'failed', error: 'boom' })
      t.eq('a repository that could not be read keeps its error', changeList({ changes: { repositories: [{ checkout: '/x', project: 'p', readBy: ['p'], error: 'no HEAD' }] } }).repositories, [{ checkout: '/x', project: 'p', readBy: ['p'], error: 'no HEAD' }])

      t.section('3. no earlier change list: an older record\'s snapshot HEAD; none at all: since the coverage baseline')
      const older = { id: '2026-11-19.1', projects: [{ project: 'app-project', snapshot: { base: { headCommit: S2 } }, snapshotAt: at(35) }] }
      const fallback = (await cycleChanges({ record, records: [older], projectPathOf: async () => app.dir, listIssues: store.listIssues, listHomes: store.listHomes })).repositories[0]
      t.eq('from the older record\'s entry', [fallback.range.basis, fallback.range.from.commit, fallback.commits.list.map((c) => c.sha)], ['previous-cycle-snapshot', S2, [H2, Y]])
      const first = (await cycleChanges({ record, records: [], projectPathOf: async () => app.dir, listIssues: store.listIssues, listHomes: store.listHomes })).repositories[0]
      t.eq('no earlier verification: every commit since the baseline, every delivery since it', [first.range.basis, first.range.from, first.commits.total, first.deliveries.map((d) => d.runId)], ['since-coverage-baseline', null, 8, ['d1', 'd2', 'd3', 'd4', 'd5']])
      const noHead = (await cycleChanges({ record: { projects: [{ project: 'app-project', atSnapshot: { checkouts: [{ checkout: app.dir, error: 'git status failed' }] } }] }, records: [], projectPathOf: async () => app.dir, listIssues: store.listIssues })).repositories[0]
      t.ok('a checkout not read after the snapshot is an error of its own, nothing thrown', /could not be read after the snapshot: git status failed/.test(noHead.error))
    }

    t.section('4. an instance\'s delivery through its link is attributed in the framework\'s checkout')
    {
      const root = await tmp()
      const fw = await repoAt(path.join(root, 'fw'))
      const inst = await repoAt(path.join(root, 'inst'))
      const store = issueStore(path.join(root, 'issues'))
      const F0 = await fw.commit({ 'lib/keep': 'k' }, 'base')
      const I0 = await inst.commit({ own: 'o' }, 'base')
      await store.deliver('inst-project', 'i1', at(5), [['fw/m.js', null, 'm']])
      const F1 = await fw.commit({ 'lib/m.js': 'm' }, 'framework commit of the instance\'s delivery')
      const fwReal = await fs.realpath(fw.dir)
      const record = { projects: [
        { project: 'inst-project', snapshot: { base: { headCommit: I0 }, links: [{ path: 'fw', owner: fw.dir, prefix: 'lib' }] }, snapshotAt: at(10),
          atSnapshot: { readAt: at(10), checkouts: [{ checkout: inst.dir, head: I0, uncommitted: { paths: [], total: 0 } }, { checkout: fw.dir, head: F1, uncommitted: { paths: [], total: 0 } }] } },
        { project: 'framework-project', mode: 'derived' }
      ] }
      const prior = { id: 'p', changes: { repositories: [{ checkout: fwReal, range: { to: { commit: F0, at: T1 } } }] }, projects: [] }
      const changes = await cycleChanges({ record, records: [prior], projectPathOf: async (p) => ({ 'inst-project': inst.dir, 'framework-project': fw.dir })[p], listIssues: store.listIssues, listHomes: store.listHomes })
      const framework = changes.repositories.find((x) => x.checkout === fwReal)
      t.eq('the framework\'s checkout is its own, read by the instance', [framework.project, framework.readBy, framework.range.to.basis], ['framework-project', ['inst-project'], 'read-after-snapshot'])
      t.eq('its commit carries the instance\'s delivery, translated through the link', [framework.commits.list[0].attribution, framework.commits.list[0].runs], ['delivered', [{ project: 'inst-project', issueId: 'issue-i1', runId: 'i1' }]])
      t.eq('and lists it as delivered there', framework.deliveries.map((d) => [d.project, d.runId, d.commits]), [['inst-project', 'i1', [F1]]])
    }

    t.section('5. a red issue quotes the change list right after its failing tests, bounded')
    {
      const commits = Array.from({ length: 40 }, (_, i) => ({ sha: `${String(i).padStart(2, '0')}${'a'.repeat(38)}`, author: 'P', authoredAt: T1, subject: `hand ${i}`, attribution: 'by-hand', runs: [], handPaths: { paths: ['x'], total: 1 } }))
      const record = { id: '2026-11-21.1', date: '2026-11-21', changes: { computedAt: T1, limits: [], repositories: [
        { checkout: '/work/app', project: 'app-project', readBy: ['app-project'], range: { from: { commit: 'f'.repeat(40), at: T1, cycleId: '2026-11-20.1' }, to: { commit: 'e'.repeat(40) }, basis: 'previous-cycle' },
          commits: { list: commits, total: 40 }, deliveries: [{ project: 'app-project', issueId: 'issue-d2', issueName: 'Issue two', runId: 'd2', at: T1, commits: [] }], uncommitted: { paths: ['u1', 'u2'], total: 25 } },
        { checkout: '/work/other', project: 'other-project', readBy: ['other-project'], error: 'not this project\'s' }
      ] } }
      const entry = { project: 'app-project', stage: 'stage', verdict: 'red', check: { result: 'failed', gating: 'failed', baseline: null } }
      const failures = [{ command: 'selftest', test: 'cart/total', basis: 'new', excerpt: { text: 'expected 3', source: 'log' } }]
      const changes = changesSection(changeList(record), { record, projects: ['app-project'] })
      const text = redIssueReport({ record, entry, name: 'Full verification 2026-11-21: app-project red on stage', stage: 'stage', failures, unread: [{ command: 'selftest', reason: 'unreadable' }], flaky: [{ command: 'selftest', test: 'flaky one', dir: 'd' }], changes })
      const iFail = text.indexOf('## Failing tests')
      const iChanges = text.indexOf('## Changes since the last verification')
      t.ok('after the failing tests, before the unread reports and the flaky tests', iFail >= 0 && iChanges > iFail && iChanges < text.indexOf('## Reports that could not be read') && iChanges < text.indexOf('## Flaky'))
      const quoted = text.slice(iChanges)
      t.ok('in order: issues delivered, commits by hand, uncommitted changes', quoted.indexOf('#### Issues delivered (1)') < quoted.indexOf('#### Commits by hand (40)') && quoted.indexOf('#### Commits by hand (40)') < quoted.indexOf('#### Uncommitted changes (25)'))
      t.ok('the delivered issue with its run, uncommitted', quoted.includes('`app-project/issue-d2` Issue two: run `d2`') && quoted.includes('uncommitted'))
      t.eq('30 commits quoted, the rest named in the record', [(quoted.match(/: hand \d+/g) ?? []).length, quoted.includes('… 10 more in `issues/.verification/2026-11-21/cycle.json` (`changes`)')], [30, true])
      t.ok('the uncommitted paths with the rest named', quoted.includes('- `u1`') && quoted.includes('… 23 more in'))
      t.ok('only the repositories this project\'s snapshot read', !quoted.includes('/work/other'))
      t.ok('a list not computed is said in one line', changesSection({ state: 'failed', error: 'timed out' }, { record, projects: ['app-project'] }).includes('could not be computed: timed out'))
    }

    t.section('6. information only: a change list that throws or never answers changes nothing of the cycle')
    {
      const run = async ({ red, changesOf, clock = manualClock(Date.parse('2026-11-21T09:00:00.000Z')) }) => {
        const issuesDir = await tmp('fv-changes-cycle-')
        const verificationDir = path.join(issuesDir, '.verification')
        const infra = {
          'framework-project': { staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage-c', workdir: '/opt' }, projectRoot: '/opt/app', files: {}, fullVerification: 'instances' } },
          'app-project': { staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage-a', workdir: '/opt' }, projectRoot: '/opt/app', files: {} }, release: { targets: { stage: {} } } }
        }
        const calls = { actions: [], issues: [], interrupted: [] }
        const check = red
          ? { result: { result: 'failed', dir: 'checks/full-verification', commands: [] }, gating: 'failed', selftest: { newFailures: [{ command: 'selftest', test: 'cart/total' }] }, baseline: null }
          : { result: { result: 'passed', dir: 'checks/full-verification' }, gating: 'passed', baseline: null }
        const supervisor = {
          frozenState: null,
          async freeze (cycleId) { this.frozenState = { cycleId }; return [] },
          thaw () { this.frozenState = null; return true },
          frozen () { return this.frozenState },
          busy: () => [],
          isActive: () => false,
          async start () { return { runId: 'run-app', status: 'preflighting' } },
          async resume () { return {} },
          async stop () { calls.interrupted.push('stop') }
        }
        const issues = {
          ISSUES_DIR: issuesDir,
          listProjects: async () => Object.keys(infra).map((id) => ({ id })),
          listIssues: async () => [],
          async createIssue (project, args) { calls.issues.push({ project, ...args }); return { id: `issue-${calls.issues.length}` } },
          async addStepFile () {},
          async ensureRunHome (project, date) { const dir = path.join(issuesDir, project, `.verification-${date}`); await fs.mkdir(dir, { recursive: true }); return { id: `verification-${date}`, path: dir } }
        }
        const fv = createFullVerification({
          supervisor, issues, clock, settings: () => null, verificationDir, log: { warn () {} },
          resolveHost: async (ssh) => ({ host: String(ssh?.hostRef ?? '').replace(/^ssh-config:/, ''), pinned: null }),
          resolve: async (_id, { projectId, runOptions }) => ({ ok: true, resolved: { configHash: `hash-${projectId}`, runOptions, infrastructure: infra[projectId], liveExecution: { blockers: [] } } }),
          infrastructureOf: async (p) => infra[p],
          projectsConfig: async () => new Map([['framework-project', { id: 'framework-project' }], ['app-project', { id: 'app-project', framework: 'framework-project' }]]),
          readRun: async () => ({ runId: 'run-app', status: 'completed', outcome: 'resolved', endedAt: '2026-11-21T09:30:00.000Z', release: { tactic: 'staging', status: 'completed', environment: 'stage' }, fullVerification: { check } }),
          runAction: async ({ project, args }) => { calls.actions.push([project, args]); return { id: `op-${calls.actions.length}`, status: 'completed', exitCode: 0 } },
          versionOf: async () => '1.0.0',
          projectPathOf: async () => { throw new Error('no checkout in this fixture') },
          changesOf
        })
        const started = await startCycleByHand(fv, { by: 'tester' })
        await fv.settle()
        const record = JSON.parse(await fs.readFile(path.join(verificationDir, started.date, 'cycle.json'), 'utf8'))
        return { record, calls, clock, latest: await fv.latest() }
      }
      const shape = ({ record, calls }) => ({
        verdict: record.verdict, state: record.state, interruption: record.interruption ?? null,
        entries: record.projects.map((e) => [e.project, e.verdict ?? null, e.coverageEstablished ?? null, e.coverage ?? null]),
        chain: (record.outcome?.bump?.chain ?? []).map((s) => [s.project, s.args, s.status]), committed: record.outcome?.committed ?? null,
        issues: calls.issues.map((i) => i.project), actions: calls.actions
      })
      for (const red of [false, true]) {
        const label = red ? 'red' : 'green'
        const plain = await run({ red, changesOf: async () => ({ computedAt: 'x', limits: [], repositories: [] }) })
        const thrown = await run({ red, changesOf: async () => { throw new Error('git exploded') } })
        // The cycle waits on a change list that never answers: its own bound, on the cycle's clock, lets it go on.
        const clock = manualClock(Date.parse('2026-11-21T09:00:00.000Z'))
        let stalledCall = null
        const called = new Promise((resolve) => { stalledCall = resolve })
        const stalledRun = run({ red, clock, changesOf: () => { stalledCall(); return new Promise(() => {}) } })
        await called
        await new Promise((resolve) => setTimeout(resolve, 20))
        const before = await Promise.race([stalledRun.then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 50))])
        clock.advance(CHANGES_MS)
        const stalled = await stalledRun
        t.eq(`${label}: the plain cycle's outcome`, red ? [shape(plain).issues, shape(plain).actions] : [shape(plain).chain.map((s) => s[2]), shape(plain).committed], red ? [['app-project'], []] : [['completed', 'completed'], true])
        t.eq(`${label}: a throwing change list leaves the cycle as it was, and says why`, [shape(thrown), thrown.record.changes], [shape(plain), { error: 'git exploded' }])
        t.eq(`${label}: a stalled one holds the cycle only until its own bound`, before, 'waiting')
        t.eq(`${label}: then the cycle goes on as it was, not interrupted`, [shape(stalled), /not computed within 120 s/.test(stalled.record.changes?.error ?? '')], [shape(plain), true])
        t.eq(`${label}: the API says the list failed`, thrown.latest.changes, { state: 'failed', error: 'git exploded' })
        if (red) t.ok('red: the issue says the list could not be computed, after the failing tests', thrown.calls.issues[0].input.indexOf('could not be computed: git exploded') > thrown.calls.issues[0].input.indexOf('## Failing tests'))
      }
    }

    t.section('7. the page, from source: its template compiles and shows the sections in the order the API gives them')
    {
      const { parse, compileTemplate } = await import('vue/compiler-sfc')
      const file = new URL('../src/views/VerificationView.vue', import.meta.url).pathname
      const source = await fs.readFile(file, 'utf8')
      const { descriptor, errors } = parse(source, { filename: file })
      const compiled = compileTemplate({ source: descriptor.template.content, filename: file, id: 'verification-view' })
      t.eq('it parses and its template compiles', [errors.length, compiled.errors.length], [0, 0])
      const card = descriptor.template.content.slice(descriptor.template.content.indexOf('data-test="cycle-changes"'))
      t.ok('the card iterates each repository\'s sections as given (delivered, by hand, uncommitted)', /v-for="section in repo\.sections"/.test(card))
      t.ok('with the three headings', /delivered: 'Issues delivered', 'by-hand': 'Commits by hand', uncommitted: 'Uncommitted changes'/.test(descriptor.scriptSetup.content))
      t.ok('a list not computed yet says so', card.includes('Not computed yet'))
    }
  } finally {
    for (const d of temps) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}
