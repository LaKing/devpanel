import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { JSDOM } from 'jsdom'
import { CONFIG_ROOT, sandbox } from './helpers.mjs'
import { markdownNodes } from '../src/markdown.js'
import { buildOverview } from '../server/supervisor-overview.mjs'
import { deployStaging, deploymentReport } from '../server/staging-deployment.mjs'
import { executeRelease } from '../server/runtime/release.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { renderResult } from '../server/run-result-step.mjs'
import {
  COVERAGE_BASELINE, DEPLOYMENT_UNPROVEN, cycleSnapshotCoverage, deliveriesOf, deploymentCoverage, holds, parsePatchContent, resumeArchivedCoverageNotes, resumeCoverageNotes, stagingPendingReport,
  stagingRunCoverage, writeDeploymentNotes, writeRunCoverageNotes
} from '../server/staging-coverage.mjs'

export const name = 'staging coverage — what a release carried, from content; only a staging release clears a run'

const exec = promisify(execFile)
const temps = []
const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'staging-coverage-')); temps.push(d); return d }
const sha1 = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
const ZERO = '0'.repeat(40)

/** A file of the delivery's patch, in the form the delivery's own diff writes it. */
const section = (rel, pre, post) => [
  `diff --git a/${rel} b/${rel}`,
  pre === null ? 'new file mode 100644' : null,
  post === null ? 'deleted file mode 100644' : null,
  `index ${pre === null ? ZERO : sha1(pre)}..${post === null ? ZERO : sha1(post)}${pre !== null && post !== null ? ' 100644' : ''}`,
  `--- a/${rel}`, `+++ b/${rel}`, '@@ -1 +1 @@'
].filter(Boolean).join('\n') + '\n'

// After the coverage baseline and before any clock this suite runs under: deploy_staging reads the real time.
const T = (n) => new Date(Date.parse(COVERAGE_BASELINE) + n * 60_000).toISOString()
const OLD = '2026-09-18T00:00:00.000Z'
const STAGING_TARGET = { staging: { id: 'stage' }, release: { targets: { stage: {} } } }

/** Issues and run records on disk, in a checkout of their own. */
async function world () {
  const root = await tmp()
  const checkout = path.join(root, 'checkout')
  await fs.mkdir(checkout)
  const issues = []
  const runs = new Map()
  const w = {
    root, checkout, issues, runs,
    issue (id, extra = {}) {
      const issue = { id, project: 'p', path: path.join(root, 'issues', id), archived: false, ...extra }
      issues.push(issue)
      runs.set(id, [])
      return issue
    },
    /** A run delivered into the checkout by the engine: `changes` is [path, before, after]. */
    async deliver (issueId, runId, at, changes, extra = {}) {
      const dir = path.join(root, 'issues', issueId, 'runs', runId, 'artifacts')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'x.patch'), changes.map(([p, a, b]) => section(p, a, b)).join(''))
      const run = { runId, status: 'completed', outcome: 'resolved', startedAt: at, endedAt: at, revisions: [{ fingerprint: 'rev' }],
        delivery: { action: 'apply-to-source', revision: 'rev', completedAt: at, artifactRef: 'artifacts/x.patch', application: { verified: true } }, ...extra }
      runs.get(issueId).push(run)
      return run
    },
    staging (issueId, runId, at, release, extra = {}) {
      const run = { runId, status: 'completed', outcome: 'resolved', startedAt: at, endedAt: at, release: { tactic: 'staging', status: 'completed', ...release }, ...extra }
      runs.get(issueId).push(run)
      return run
    },
    write: (rel, text) => fs.mkdir(path.dirname(path.join(checkout, rel)), { recursive: true }).then(() => fs.writeFile(path.join(checkout, rel), text)),
    async snapshot (files) {
      const dir = await tmp()
      for (const [rel, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
        await fs.writeFile(path.join(dir, rel), text)
      }
      return dir
    },
    get ctx () {
      return {
        project: 'p', projectPath: checkout,
        listIssues: async (_project, { archived = false } = {}) => issues.filter((i) => Boolean(i.archived) === archived),
        readRuns: async (issuePath) => runs.get(path.basename(issuePath)) ?? [],
        readPackedRuns: async (_project, id) => runs.get(id) ?? []
      }
    },
    report: (infrastructure = null) => stagingPendingReport({ ...w.ctx, infrastructure }),
    cover: (snapshotPath, snapshotAt) => stagingRunCoverage({ ...w.ctx, snapshotPath, snapshotAt })
  }
  return w
}

const ids = (list) => list.map((e) => e.runId)
const htmlOf = async (text) => new JSDOM(await renderToString(h('div', markdownNodes(text))))

/** What the panel does when a note is written: here, only what was asked. */
const recordingIssues = () => {
  const written = []
  return { written, createEngineNote: async (project, issueId, note) => { written.push({ project, issueId, ...note }); return { where: 'step' } } }
}

export default async function (t) {
  try {
    t.section('a delivery\'s own patch names what it left, path by path')
    {
      const repo = await tmp()
      const git = (...args) => exec('git', ['-C', repo, ...args], { encoding: 'utf8' })
      await git('init', '-q')
      await git('config', 'user.email', 'a@example.invalid')
      await git('config', 'user.name', 'a')
      for (const [f, text] of [['a', 'one\n'], ['m', 'x\n'], ['d', 'del\n'], ['with space', 'one\n']]) await fs.writeFile(path.join(repo, f), text)
      await fs.writeFile(path.join(repo, 'b'), Buffer.from([0, 1, 2]))
      await fs.symlink('a', path.join(repo, 'l'))
      await git('add', '-A')
      await git('commit', '-qm', 'base')
      await fs.writeFile(path.join(repo, 'a'), 'two\n')
      await fs.chmod(path.join(repo, 'm'), 0o755)
      await fs.rm(path.join(repo, 'd'))
      await fs.writeFile(path.join(repo, 'ß.n'), 'new\n')
      await fs.writeFile(path.join(repo, 'with space'), 'two\n')
      await fs.writeFile(path.join(repo, 'b'), Buffer.from([0, 1, 3]))
      await fs.rm(path.join(repo, 'l'))
      await fs.symlink('m', path.join(repo, 'l'))
      await git('add', '-A')
      const patch = (await git('diff', '--cached', '--binary', '--full-index', '--no-renames', 'HEAD')).stdout
      const entries = new Map(parsePatchContent(patch).map((e) => [e.path, e]))
      t.eq('every changed path is read, quoted and spaced ones too', [...entries.keys()].sort(), ['a', 'b', 'd', 'l', 'm', 'with space', 'ß.n'].sort())
      t.eq('a modification names both blobs', entries.get('a'), { path: 'a', pre: { blob: sha1('one\n'), mode: '100644' }, post: { blob: sha1('two\n'), mode: '100644' } })
      t.eq('an added file had nothing before', entries.get('ß.n'), { path: 'ß.n', pre: null, post: { blob: sha1('new\n'), mode: '100644' } })
      t.eq('a deleted file leaves nothing', entries.get('d').post, null)
      t.eq('a mode-only change has modes and no blob', entries.get('m'), { path: 'm', pre: { mode: '100644' }, post: { mode: '100755' } })
      t.eq('a link is a link', entries.get('l').post.mode, '120000')
      t.ok('a binary file is read', Boolean(entries.get('b').post.blob))
      t.eq('an unreadable header is no answer', parsePatchContent('diff --git nonsense\nindex 1..2\n'), null)
    }

    t.section('the pending list: delivered and landed runs, for every project')
    {
      const w = await world()
      w.issue('i1'); w.issue('i2'); w.issue('i3'); w.issue('i4')
      await w.write('f', 'new\n'); await w.write('g', 'landed\n')
      await w.deliver('i1', 'delivered', T(1), [['f', 'old\n', 'new\n']])
      await w.deliver('i2', 'patch-only', T(1), [['z', 'old\n', 'new\n']], { delivery: { action: 'worktree-diff', completedAt: T(1), artifactRef: 'artifacts/x.patch', revision: 'rev' } })
      await w.deliver('i3', 'landed', T(1), [['g', 'old\n', 'landed\n']], { delivery: { action: 'worktree-diff', completedAt: T(1), artifactRef: 'artifacts/x.patch', revision: 'rev' },
        landed: { by: 'op', handChanges: 'none', recordedAt: T(2), revision: 'rev' } })
      await w.deliver('i4', 'landed-by-hand', T(1), [['h', 'old\n', 'landed\n']], { delivery: null, landed: { by: 'op', handChanges: 'also edited h', recordedAt: T(2), revision: 'rev' } })
      const report = await w.report()
      t.eq('delivered and landed runs are pending', ids(report.pending).sort(), ['delivered', 'landed'])
      t.eq('a retained patch never reached the checkout', [...ids(report.pending), ...ids(report.indeterminate)].includes('patch-only'), false)
      t.eq('a landing says so', report.pending.find((e) => e.runId === 'landed').kind, 'manual')
      t.eq('hand changes make a landing\'s bytes unknowable', report.indeterminate.map((e) => [e.runId, e.reason]), [['landed-by-hand', 'landed-with-hand-changes']])
      t.eq('a project with no way to release still lists them', report.configured, { stagingRelease: false, sharedDeployment: false })
      t.eq('and cannot cut a batch, with the reason', report.batch, { ready: false, reason: 'no-staging-release-target' })
      t.eq('with a Staging release target the batch is ready', (await w.report(STAGING_TARGET)).batch.ready, true)
      w.runs.get('i1').push({ runId: 'busy', status: 'running' })
      const busy = await w.report(STAGING_TARGET)
      t.eq('no batch while a delivery is in progress', [busy.batch.ready, busy.batch.reason, ids(busy.liveRuns)], [false, 'delivery-in-progress', ['busy']])
    }

    t.section('covered: the snapshot holds the delivered bytes, or a later delivery\'s')
    {
      const w = await world()
      w.issue('i1'); w.issue('rel')
      await w.write('f', 'new\n')
      await w.deliver('i1', 'r1', T(1), [['f', 'old\n', 'new\n'], ['gone', 'x\n', null]])
      const coverage = await w.cover(await w.snapshot({ f: 'new\n' }), T(2))
      t.eq('bytes equal and a deletion absent: covered', [ids(coverage.covered), ids(coverage.indeterminate)], [['r1'], []])
      w.staging('rel', 'release', T(2), { coverage })
      t.eq('a successful Staging run clears it', ids((await w.report()).pending), [])
      const stale = await w.cover(await w.snapshot({ f: 'new\n', gone: 'x\n' }), T(3))
      t.eq('a covered run is not named again', [...ids(stale.covered), ...ids(stale.indeterminate)], [])
    }
    {
      const w = await world()
      w.issue('i1'); w.issue('i2')
      await w.write('f', 'c\n')
      await w.deliver('i1', 'first', T(1), [['f', 'a\n', 'b\n']])
      await w.deliver('i2', 'second', T(2), [['f', 'b\n', 'c\n']])
      const coverage = await w.cover(await w.snapshot({ f: 'c\n' }), T(3))
      t.eq('both covered', ids(coverage.covered), ['first', 'second'])
      t.eq('the earlier one superseded on the same path', coverage.covered[0].superseded, ['f'])
      t.eq('the checkout holding the later bytes keeps the earlier one pending, not hand-changed', ids((await w.report()).pending), ['first', 'second'])
    }
    {
      const w = await world()
      w.issue('i1'); w.issue('i2'); w.issue('i3')
      await w.write('f', 'b\n')
      await w.deliver('i1', 'd1', T(1), [['f', 'a\n', 'b\n']])
      await w.deliver('i2', 'd2', T(2), [['f', 'b\n', 'a\n']])
      await w.deliver('i3', 'd3', T(3), [['f', 'a\n', 'b\n']])
      const reverted = await w.cover(await w.snapshot({ f: 'a\n' }), T(4))
      t.eq('A→B→A→B: the last one is not covered by the bytes before it', ids(reverted.indeterminate), ['d3'])
      t.eq('and the revert and what it reverted are', ids(reverted.covered), ['d1', 'd2'])
    }
    {
      const w = await world()
      w.issue('i1')
      await w.write('f', 'b\n')
      await w.deliver('i1', 'late', T(5), [['f', 'a\n', 'b\n']])
      const coverage = await w.cover(await w.snapshot({ f: 'b\n' }), T(4))
      t.eq('delivered after the snapshot: this release does not speak for it, whatever the bytes', [ids(coverage.notShipped), ids(coverage.covered), ids(coverage.indeterminate)], [['late'], [], []])
      t.eq('and it stays pending', ids((await w.report()).pending), ['late'])
    }

    t.section('a full verification cycle\'s snapshot: what it covered, from content, for the runs it was given; no staging list changes')
    {
      const w = await world()
      w.issue('i1'); w.issue('i2'); w.issue('i3'); w.issue('i4'); w.issue('rel')
      await w.write('f', 'b\n')
      await w.deliver('i1', 'held', T(1), [['f', 'a\n', 'b\n']])
      await w.deliver('i2', 'edited', T(2), [['g', 'a\n', 'b\n']])
      await w.deliver('i3', 'after', T(5), [['h', null, 'x\n']])
      await w.deliver('i4', 'already', T(1), [['k', null, 'y\n']])
      // A green staging release covered `already` before: the cycle reads content regardless of staging.
      w.staging('rel', 'release', T(2), { coverage: { covered: [{ runId: 'already' }], indeterminate: [] } })
      const snapshot = await w.snapshot({ f: 'b\n', g: 'by hand\n', k: 'y\n' })
      const cycle = await cycleSnapshotCoverage({ ...w.ctx, listHomes: async () => [], snapshotPath: snapshot, snapshotAt: T(4) })
      t.eq('covered by its bytes, indeterminate where the snapshot differs, not shipped after it', [ids(cycle.covered), ids(cycle.indeterminate), ids(cycle.notShipped)], [['already', 'held'], ['edited'], ['after']])
      t.eq('what differs is named', [cycle.basis, cycle.indeterminate[0].reason, cycle.indeterminate[0].paths], ['cycle-snapshot', 'snapshot-differs', ['g']])
      const given = await cycleSnapshotCoverage({ ...w.ctx, listHomes: async () => [], snapshotPath: snapshot, snapshotAt: T(4), candidates: ['held'] })
      t.eq('only the runs it was given (those still counting)', [ids(given.covered), ids(given.indeterminate), ids(given.notShipped)], [['held'], [], []])
      t.eq('the staging pending list is the staging releases\' alone: the run the cycle covered stays pending there', ids((await w.report()).pending), ['held'])
      t.eq('the trigger counts every delivery from the baseline on, in order', (await deliveriesOf({ ...w.ctx, listHomes: async () => [] })).map((d) => d.runId), ['already', 'held', 'edited', 'after'])
    }

    t.section('hand-changed: indeterminate, never silently covered')
    {
      const w = await world()
      w.issue('i1'); w.issue('rel')
      await w.write('f', 'by hand\n')
      await w.deliver('i1', 'r1', T(1), [['f', 'old\n', 'new\n']])
      const live = await w.report(STAGING_TARGET)
      t.eq('the checkout no longer holds it', live.indeterminate.map((e) => [e.runId, e.reason, e.paths]), [['r1', 'checkout-differs', ['f']]])
      t.eq('which prompts no batch', [live.pending.length, live.batch.ready, live.batch.reason], [0, false, 'nothing-pending'])

      const named = await w.cover(await w.snapshot({ f: 'by hand\n' }), T(2))
      t.eq('a release shipping other bytes names it', named.indeterminate.map((e) => [e.runId, e.reason, e.paths, e.firstNamed]), [['r1', 'snapshot-differs', ['f'], true]])
      w.staging('rel', 'green', T(2), { coverage: named })
      await w.write('f', 'new\n')
      const after = await w.report(STAGING_TARGET)
      t.eq('a green release naming it does not clear it, even once the checkout holds the bytes again', after.indeterminate.map((e) => [e.runId, e.reason]), [['r1', 'snapshot-differs']])
      t.eq('and it prompts no batch', after.batch.ready, false)
      const again = await w.cover(await w.snapshot({ f: 'by hand\n' }), T(3))
      t.eq('named again, not for the first time', again.indeterminate[0].firstNamed, false)
      const proved = await w.cover(await w.snapshot({ f: 'new\n' }), T(4))
      t.eq('a later release holding the bytes covers it', ids(proved.covered), ['r1'])
      w.staging('rel', 'green-2', T(4), { coverage: proved })
      t.eq('which clears it', ids((await w.report()).indeterminate), [])
    }
    {
      const w = await world()
      w.issue('i1'); w.issue('i2')
      await w.write('f', 'old\n')
      await w.deliver('i1', 'reverted', T(1), [['f', 'old\n', 'new\n']])
      await w.deliver('i2', 'older-in-place', T(1), [['h', 'old\n', 'new\n']], { delivery: { action: 'in-place', completedAt: T(1), changedPaths: ['h'] } })
      const report = await w.report()
      t.eq('a hand revert reads as a hand change', report.indeterminate.find((e) => e.runId === 'reverted')?.reason, 'checkout-differs')
      t.eq('an older in-place run has no bytes on record', report.indeterminate.find((e) => e.runId === 'older-in-place')?.reason, 'no-content-on-record')
      const coverage = await w.cover(await w.snapshot({ f: 'old\n' }), T(2))
      t.eq('at a release too', ids(coverage.indeterminate).sort(), ['older-in-place', 'reverted'])
    }
    {
      const w = await world()
      w.issue('i1')
      await w.write('f', 'new\n')
      await w.deliver('i1', 'in-place', T(1), [], { delivery: { action: 'in-place', completedAt: T(1), content: [{ path: 'f', post: { blob: sha1('new\n'), mode: '100644' } }] } })
      t.eq('a new in-place run carries its bytes', ids((await w.cover(await w.snapshot({ f: 'new\n' }), T(2))).covered), ['in-place'])
    }

    t.section('unknown content is no match: a chmod with hand-edited bytes is not covered')
    {
      t.eq('a state with no blob holds nothing', holds({ mode: '100755' }, { mode: '100755', sha1: sha1('anything'), sha256: 'x' }), false)
      const w = await world()
      w.issue('i1'); w.issue('i2')
      await fs.mkdir(path.join(w.root, 'issues/i1/runs/chmod/artifacts'), { recursive: true })
      const chmod = 'diff --git a/tool.sh b/tool.sh\nold mode 100644\nnew mode 100755\n'
      await fs.writeFile(path.join(w.root, 'issues/i1/runs/chmod/artifacts/x.patch'), chmod)
      w.runs.get('i1').push({ runId: 'chmod', status: 'completed', outcome: 'resolved', startedAt: T(1), revisions: [{ fingerprint: 'rev' }],
        delivery: { action: 'apply-to-source', revision: 'rev', completedAt: T(1), artifactRef: 'artifacts/x.patch', application: { verified: true } } })
      await w.write('tool.sh', 'edited by hand\n')
      await fs.chmod(path.join(w.checkout, 'tool.sh'), 0o755)
      const snapshot = await w.snapshot({ 'tool.sh': 'edited by hand\n' })
      await fs.chmod(path.join(snapshot, 'tool.sh'), 0o755)
      const coverage = await w.cover(snapshot, T(2))
      t.eq('a release does not cover it', [ids(coverage.covered), coverage.indeterminate.map((e) => [e.runId, e.reason])], [[], [['chmod', 'mode-only-bytes-unknown']]])
      const report = await w.report(STAGING_TARGET)
      t.eq('it is not pending', [ids(report.pending), report.indeterminate.map((e) => [e.runId, e.reason])], [[], [['chmod', 'mode-only-bytes-unknown']]])
      await w.deliver('i2', 'before-chmod', T(1),[['tool.sh', 'old\n', 'new\n']])
      const linked = await w.cover(snapshot, T(2))
      t.eq('and connects no earlier delivery to bytes nobody delivered', ids(linked.indeterminate).sort(), ['before-chmod', 'chmod'])
      t.eq('which is not covered either', ids(linked.covered), [])
    }

    t.section('a red release clears nothing, and says who it carried')
    {
      const w = await world()
      w.issue('i1'); w.issue('rel')
      await w.write('f', 'new\n')
      await w.deliver('i1', 'r1', T(1), [['f', 'old\n', 'new\n']])
      const coverage = await w.cover(await w.snapshot({ f: 'new\n' }), T(2))
      w.staging('rel', 'red', T(2), { status: 'rolled-back', coverage }, { status: 'blocked', outcome: 'unresolved' })
      const report = await w.report(STAGING_TARGET)
      t.eq('it stays pending', ids(report.pending), ['r1'])
      t.eq('naming the attempt', report.pending[0].lastAttempt, { issueId: 'rel', runId: 'red', status: 'rolled-back' })
      t.eq('and a batch can still be cut', report.batch.ready, true)
    }

    t.section('a green release from before this feature counts through its retained archive')
    {
      const w = await world()
      w.issue('i1'); w.issue('rel')
      await w.write('f', 'new\n')
      await w.deliver('i1', 'r1', T(2), [['f', 'old\n', 'new\n']])
      const archive = async (runId) => {
        const dir = path.join(w.root, 'issues', 'rel', 'runs', runId, 'artifacts')
        await fs.mkdir(dir, { recursive: true })
        await exec('tar', ['--exclude=.git', '-cf', path.join(dir, 'release.tar'), '-C', await w.snapshot({ f: 'new\n', other: 'x\n' }), '.'])
        return crypto.createHash('sha256').update(await fs.readFile(path.join(dir, 'release.tar'))).digest('hex')
      }
      const earlier = await archive('earlier')
      w.staging('rel', 'earlier', T(1), { sha256: earlier })
      t.eq('an older release with the same bytes does not cover a later delivery', ids((await w.report()).pending), ['r1'])
      w.staging('rel', 'no-archive', T(3), { sha256: 'a'.repeat(64) })
      t.eq('a missing archive establishes nothing', ids((await w.report()).pending), ['r1'])
      await archive('changed')
      w.staging('rel', 'changed', T(3), { sha256: 'b'.repeat(64) })
      t.eq('a changed archive establishes nothing', ids((await w.report()).pending), ['r1'])
      const sha256 = await archive('retained')
      const record = w.staging('rel', 'retained', T(3), { sha256 })
      const before = await fs.readFile(path.join(w.root, 'issues', 'rel', 'runs', 'retained', 'artifacts', 'release.tar'))
      t.eq('its verified snapshot covers the run', [ids((await w.report()).pending), ids((await w.report()).indeterminate)], [[], []])
      t.eq('writing no record', record.release.coverage, undefined)
      t.eq('and leaving the archive as it was', Buffer.compare(before, await fs.readFile(path.join(w.root, 'issues', 'rel', 'runs', 'retained', 'artifacts', 'release.tar'))), 0)
    }

    t.section('a packed issue\'s delivery stays listed, read from its bundle')
    {
      const w = await world()
      const id = '2026-01-01-packed'
      await w.write('f', 'new\n')
      const stage = await tmp()
      const member = path.join(stage, id, 'runs', 'r1', 'artifacts')
      await fs.mkdir(member, { recursive: true })
      await fs.writeFile(path.join(member, 'x.patch'), section('f', 'old\n', 'new\n'))
      const bundle = path.join(stage, `${id}.tar.gz`)
      await exec('tar', ['-czf', bundle, '-C', stage, id])
      w.issue(id, { archived: true, packed: true, location: bundle, path: null })
      w.runs.get(id).push({ runId: 'r1', status: 'completed', outcome: 'resolved', startedAt: T(1), revisions: [{ fingerprint: 'rev' }],
        delivery: { action: 'apply-to-source', revision: 'rev', completedAt: T(1), artifactRef: 'artifacts/x.patch', application: { verified: true } } })
      const ctx = { ...w.ctx, readOperations: async () => [] }
      const report = await stagingPendingReport({ ...ctx, infrastructure: null })
      t.eq('it is pending, and says it is archived', report.pending.map((e) => [e.runId, e.archived, e.paths]), [['r1', true, ['f']]])
      t.eq('and a release can cover it', ids((await stagingRunCoverage({ ...ctx, snapshotPath: await w.snapshot({ f: 'new\n' }), snapshotAt: T(2) })).covered), ['r1'])
      await fs.rm(bundle)
      t.eq('a bundle that is gone reads as unknown, not covered', (await stagingPendingReport({ ...ctx, infrastructure: null })).indeterminate.map((e) => e.reason), ['patch-unreadable'])
    }

    t.section('the coverage baseline: older deliveries are history, counted once and named nowhere')
    {
      t.ok('this suite\'s fixtures stand on the two sides of it', Date.parse(OLD) < Date.parse(COVERAGE_BASELINE) && Date.parse(T(1)) > Date.parse(COVERAGE_BASELINE))
      const w = await world()
      w.issue('old'); w.issue('old-landed'); w.issue('old-bytes-unknown'); w.issue('new'); w.issue('new-landed'); w.issue('rel'); w.issue('dep')
      await w.write('f', 'by hand\n'); await w.write('g', 'by hand\n')
      await w.deliver('old', 'history', OLD, [['f', 'a\n', 'b\n']])
      await w.deliver('old-landed', 'history-landed', OLD, [['f', 'b\n', 'c\n']], { delivery: null, landed: { by: 'op', handChanges: 'also edited f', recordedAt: OLD, revision: 'rev' } })
      await w.deliver('old-bytes-unknown', 'history-unknown', OLD, [], { delivery: { action: 'in-place', completedAt: OLD, changedPaths: ['h'] } })
      await w.deliver('new', 'tracked', T(1), [['g', 'a\n', 'b\n']])
      await w.deliver('new-landed', 'tracked-unknown', T(1), [['z', 'a\n', 'b\n']], { delivery: null, landed: { by: 'op', handChanges: 'also edited z', recordedAt: T(1), revision: 'rev' } })

      const report = await w.report(STAGING_TARGET)
      t.eq('history is one number, with what it is measured against', report.history, { count: 3, before: COVERAGE_BASELINE })
      t.eq('absent from pending', ids(report.pending), [])
      t.eq('a delivery after the baseline still reads indeterminate, on checkout-differs and on unknown bytes', report.indeterminate.map((e) => [e.runId, e.reason]).sort(), [['tracked', 'checkout-differs'], ['tracked-unknown', 'landed-with-hand-changes']])
      t.eq('the same with no staging target at all', (await w.report(null)).history, report.history)

      const coverage = await w.cover(await w.snapshot({ f: 'b\n', g: 'b\n' }), T(2))
      t.eq('a release names no history', [ids(coverage.covered), ids(coverage.indeterminate)], [['tracked'], ['tracked-unknown']])
      const relIssue = w.issues.find((i) => i.id === 'rel')
      await fs.mkdir(path.join(relIssue.path, 'runs/green'), { recursive: true })
      const notes = recordingIssues()
      await writeRunCoverageNotes({ project: 'p', issue: relIssue, run: { runId: 'green', status: 'completed', outcome: 'resolved', release: { tactic: 'staging', status: 'completed', coverage } }, issues: notes })
      t.eq('and its notes go only to what it named', notes.written.map((n) => n.issueId).sort(), ['new', 'new-landed'])

      const named = await deploymentCoverage(w.ctx).before(T(2))
      t.eq('a first deployment names no history', ids(named.indeterminate).sort(), ['tracked', 'tracked-unknown'])
      const depIssue = w.issues.find((i) => i.id === 'dep')
      await fs.mkdir(path.join(depIssue.path, 'operations'), { recursive: true })
      for (const [id, status, label] of [['first', 'completed', 'so it writes no note for history'], ['red', 'failed', 'nor does a red one']]) {
        const written = recordingIssues()
        await writeDeploymentNotes({ project: 'p', issue: depIssue, operation: { id, status, coverage: named }, issues: written })
        t.eq(label, written.written.map((n) => n.issueId).sort(), ['new', 'new-landed'])
      }
    }
    {
      const w = await world()
      w.issue('i1')
      await w.write('f', 'new\n')
      const landing = (recordedAt) => ({ delivery: null, landed: { by: 'op', handChanges: 'also edited f', revision: 'rev', ...(recordedAt ? { recordedAt } : {}) } })
      await w.deliver('i1', 'landed-since', OLD, [['f', 'old\n', 'new\n']], landing(T(1)))
      await w.deliver('i1', 'no-recorded-time', OLD, [['f', 'old\n', 'new\n']], landing(null))
      await w.deliver('i1', 'no-time-at-all', null, [['f', 'old\n', 'new\n']], landing(null))
      const report = await w.report()
      t.eq('a landing is read by when it was recorded, an older record by its run, and no time at all stays listed',
        [report.history.count, ids(report.indeterminate).sort()], [1, ['landed-since', 'no-time-at-all']])
    }

    t.section('the work is bounded: a bundle is opened only for a listed run')
    {
      const N = 12
      /** A world whose issues are packed, each delivery's record naming its paths unless `extra` says otherwise. */
      const packedWorld = async () => {
        const w = await world()
        const stage = await tmp()
        w.packed = async (id, runId, at, changes, extra = {}) => {
          const member = path.join(stage, id, 'runs', runId, 'artifacts')
          await fs.mkdir(member, { recursive: true })
          await fs.writeFile(path.join(member, 'x.patch'), changes.map(([p, a, b]) => section(p, a, b)).join(''))
          const location = path.join(stage, `${id}.tar.gz`)
          await exec('tar', ['-czf', location, '-C', stage, id])
          w.issue(id, { archived: true, packed: true, location, path: null })
          w.runs.get(id).push({ runId, status: 'completed', outcome: 'resolved', startedAt: at, endedAt: at, revisions: [{ fingerprint: 'rev' }],
            delivery: { action: 'apply-to-source', revision: 'rev', completedAt: at, artifactRef: 'artifacts/x.patch', application: { verified: true }, changedPaths: changes.map(([p]) => p) }, ...extra })
          return location
        }
        return w
      }
      /** Runs `work` with a tar first on PATH that records its arguments, so what is counted is what ran. */
      const tarCalls = async (work) => {
        const bin = await tmp()
        const log = path.join(bin, 'tar.log')
        const realTar = (await exec('sh', ['-c', 'command -v tar'], { encoding: 'utf8' })).stdout.trim()
        await fs.writeFile(path.join(bin, 'tar'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realTar}' "$@"\n`, { mode: 0o755 })
        const savedPath = process.env.PATH
        process.env.PATH = `${bin}:${savedPath}`
        try { await work() } finally { process.env.PATH = savedPath }
        return (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      }
      const read = (w) => stagingPendingReport({ ...w.ctx, readOperations: async () => [], infrastructure: null })
      const reasons = (report) => report.indeterminate.map((e) => [e.runId, e.reason])

      {
        const w = await packedWorld()
        const old = []
        for (let i = 0; i < N; i++) old.push(await w.packed(`2026-09-${String(i + 1).padStart(2, '0')}-old`, `old-${i}`, OLD, [[`old-${i}`, 'a\n', 'b\n']]))
        await w.write('listed', 'b\n')
        const listedBundle = await w.packed('2026-12-01-listed', 'listed', T(5), [['listed', 'a\n', 'b\n']])
        const coveredBundle = await w.packed('2026-12-02-covered', 'covered', T(1), [['covered', 'a\n', 'b\n']])
        w.issue('rel')
        w.staging('rel', 'green', T(2), { coverage: { covered: [{ issueId: '2026-12-02-covered', runId: 'covered' }], indeterminate: [] } })
        // A green release from before the baseline, with nothing recorded: no delivery it could speak for is listed.
        const oldRelease = await w.packed('2026-09-20-old-release', 'old-release', OLD, [['r', 'a\n', 'b\n']], { delivery: null, release: { tactic: 'staging', status: 'completed', sha256: 'a'.repeat(64) } })
        let report
        const calls = await tarCalls(async () => { report = await read(w) })
        t.eq('the listed run is listed, the rest counted', [ids(report.pending), report.history.count], [['listed'], N])
        t.eq('one bundle read, the listed run\'s', calls.map((c) => c.includes(listedBundle)), [true])
        t.eq(`none of the ${N} older bundles`, calls.filter((c) => old.some((b) => c.includes(b))), [])
        t.eq('nor a covered run\'s, whose content nothing asked about', calls.filter((c) => c.includes(coveredBundle)), [])
        t.eq('nor the older release\'s archive', calls.filter((c) => c.includes(oldRelease)), [])
      }
      {
        const w = await packedWorld()
        await w.write('listed', 'by hand\n')
        const listedBundle = await w.packed('2026-12-01-listed', 'listed', T(1), [['listed', 'a\n', 'b\n']])
        const covered = []
        for (let i = 0; i < N; i++) {
          const id = `2026-12-${String(i + 2).padStart(2, '0')}-covered`
          await w.packed(id, `covered-${i}`, T(i + 2), [[`covered-${i}`, 'a\n', 'b\n']])
          covered.push({ issueId: id, runId: `covered-${i}` })
        }
        w.issue('rel')
        w.staging('rel', 'green', T(N + 3), { coverage: { covered, indeterminate: [] } })
        let report
        const calls = await tarCalls(async () => { report = await read(w) })
        t.eq('hand-changed: the listed run still reads indeterminate', [ids(report.pending), reasons(report)], [[], [['listed', 'checkout-differs']]])
        t.eq(`and its search opens only its own bundle, none of the ${N} covered ones on other paths`, calls.map((c) => c.includes(listedBundle)), [true])
      }
      {
        const w = await packedWorld()
        await w.write('shared', 'c\n')
        const first = await w.packed('2026-12-01-first', 'first', T(1), [['shared', 'a\n', 'b\n']])
        const later = await w.packed('2026-12-02-later', 'later', T(2), [['shared', 'b\n', 'c\n']])
        await w.packed('2026-12-03-other', 'other', T(3), [['other', 'a\n', 'b\n']])
        w.issue('rel')
        w.staging('rel', 'green', T(4), { coverage: { covered: [{ issueId: '2026-12-02-later', runId: 'later' }, { issueId: '2026-12-03-other', runId: 'other' }], indeterminate: [] } })
        let report
        const calls = await tarCalls(async () => { report = await read(w) })
        t.eq('superseded on the same path: still resolved, through a covered delivery', [ids(report.pending), reasons(report)], [['first'], []])
        t.eq('opening its bundle and not the unrelated one', calls.map((c) => (c.includes(first) ? 'first' : c.includes(later) ? 'later' : 'other')), ['first', 'later'])
        const coverage = await stagingRunCoverage({ ...w.ctx, readOperations: async () => [], snapshotPath: await w.snapshot({ shared: 'c\n' }), snapshotAt: T(5) })
        t.eq('and a release reads it the same', coverage.covered.map((e) => [e.runId, e.superseded]), [['first', ['shared']]])
      }
      {
        const w = await packedWorld()
        await w.write('listed', 'by hand\n')
        const listedBundle = await w.packed('2026-12-01-listed', 'listed', T(1), [['listed', 'a\n', 'b\n']])
        // Delivered after the baseline by the code before `changedPaths`: the one case only its patch can answer.
        const unnamed = await w.packed('2026-12-02-unnamed', 'unnamed', T(2), [['elsewhere', 'a\n', 'b\n']],
          { delivery: { action: 'apply-to-source', revision: 'rev', completedAt: T(2), artifactRef: 'artifacts/x.patch', application: { verified: true } } })
        w.issue('rel')
        w.staging('rel', 'green', T(3), { coverage: { covered: [{ issueId: '2026-12-02-unnamed', runId: 'unnamed' }], indeterminate: [] } })
        let report
        const calls = await tarCalls(async () => { report = await read(w) })
        t.eq('a record naming no paths: the result is the same', reasons(report), [['listed', 'checkout-differs']])
        t.eq('at the cost of its bundle', calls.map((c) => (c.includes(listedBundle) ? 'listed' : c.includes(unnamed) ? 'unnamed' : 'other')), ['listed', 'unnamed'])
      }
    }

    t.section('deploy_staging records what it names, and clears nothing')
    {
      const root = await sandbox()
      const cfg = YAML.parse(await fs.readFile(path.join(CONFIG_ROOT, 'examples/host-config/projects/example-project.yaml'), 'utf8'))
      cfg.id = 'fixture'
      const w = await world()
      const counter = path.join(w.root, 'count')
      const configure = async (run) => {
        cfg.infrastructure.stagingDeployment = { enabled: true, notes: 'Fixture', workdir: w.root, commands: [{ id: 'deploy', run, timeoutSeconds: 5 }] }
        await fs.mkdir(path.join(root, 'projects'), { recursive: true })
        await fs.writeFile(path.join(root, 'projects/fixture.yaml'), YAML.stringify(cfg))
      }
      w.issue('i1'); w.issue('i2'); w.issue('rel')
      const deploy = (issue, extra = {}) => deployStaging({ project: 'fixture', issuePath: w.issues.find((i) => i.id === issue).path, root, coverage: deploymentCoverage(w.ctx), ...extra })
      for (const id of ['dep-a', 'dep-b', 'dep-red', 'dep-stale']) w.issue(id)
      await w.write('f', 'new\n')
      await w.deliver('i1', 'r1', T(1), [['f', 'old\n', 'new\n']])
      await configure(`printf x >> ${counter}`)

      const matching = await deploy('dep-a')
      t.eq('green, the checkout holding the bytes: indeterminate, covering nothing', [matching.status, matching.coverage.covered, matching.coverage.basis], ['completed', [], DEPLOYMENT_UNPROVEN])
      t.eq('naming the candidate with the one reason', matching.coverage.indeterminate.map((e) => [e.runId, e.issueId, e.reason, e.firstNamed]), [['r1', 'i1', DEPLOYMENT_UNPROVEN, true]])
      t.eq('the reading says what the checkout held, around the commands', matching.coverage.indeterminate[0].checkout, { before: 'held', after: 'held' })
      t.ok('the record is on the operation', JSON.parse(await fs.readFile(path.join(w.root, 'issues/dep-a/operations/staging-deployment.json'), 'utf8')).coverage.indeterminate.length === 1)
      t.ok('the report says it is unproven', deploymentReport(matching).includes('unproven') && deploymentReport(matching).includes('r1'))

      const listed = await w.report(STAGING_TARGET)
      t.eq('the run stays pending', ids(listed.pending), ['r1'])
      t.eq('with the deployment named', listed.pending[0].lastDeployment, { issueId: 'dep-a', operationId: matching.id, status: 'completed' })
      t.eq('and can still prompt the Staging release that clears it', listed.batch.ready, true)
      t.eq('a project with only a deployment cannot', (await w.report({ staging: { id: 'stage' }, stagingDeployment: { enabled: true } })).batch, { ready: false, reason: 'no-staging-release-target' })

      await w.write('f', 'by hand\n')
      const differing = await deploy('dep-b')
      t.eq('green, the checkout differing: the same coverage', [differing.coverage.covered, differing.coverage.indeterminate.map((e) => [e.runId, e.reason])], [[], [['r1', DEPLOYMENT_UNPROVEN]]])
      t.eq('the reading is what differs', differing.coverage.indeterminate[0].checkout, { before: 'differs', after: 'differs' })
      t.eq('named before, so not first named', differing.coverage.indeterminate[0].firstNamed, false)
      const handChanged = await w.report(STAGING_TARGET)
      t.eq('a hand-changed run stays indeterminate after a deployment', handChanged.indeterminate.map((e) => [e.runId, e.reason]), [['r1', 'checkout-differs']])
      await w.write('f', 'new\n')

      const notes = recordingIssues()
      const fromIssue = (id) => w.issues.find((i) => i.id === id)
      await writeDeploymentNotes({ project: 'fixture', issue: fromIssue('dep-a'), operation: matching, issues: notes })
      t.eq('a green deployment notes a first-named run\'s issue', notes.written.map((n) => [n.issueId, n.invocationId]), [['i1', `staging-coverage:${matching.id}`]])
      t.ok('saying only a staging release clears it', notes.written[0].text.includes('Only a staging release (a Deployment run in the staging environment) can clear'))
      t.ok('with a link to the deploying issue', notes.written[0].text.includes(`(/projects/fixture/dep-a)`))
      const secondNotes = recordingIssues()
      await writeDeploymentNotes({ project: 'fixture', issue: fromIssue('dep-b'), operation: differing, issues: secondNotes })
      t.eq('a second green deployment re-notes nobody', secondNotes.written, [])

      const replay = await deploy('dep-a')
      t.eq('replay returns the stored record', [replay.replayed, replay.id, replay.coverage], [true, matching.id, matching.coverage])
      t.eq('the commands did not run again', (await fs.readFile(counter, 'utf8')).length, 2)
      await writeDeploymentNotes({ project: 'fixture', issue: fromIssue('dep-a'), operation: replay, issues: notes })
      t.eq('a replay writes under the same key, so one step', new Set(notes.written.map((n) => n.invocationId)).size, 1)

      await w.deliver('i2', 'r2', T(2), [['g', 'old\n', 'new\n']])
      await w.write('g', 'new\n')
      await configure('printf failed >&2; exit 3')
      const red = await deploy('dep-red')
      t.eq('red: indeterminate too, every candidate', [red.status, red.coverage.covered, ids(red.coverage.indeterminate).sort()], ['failed', [], ['r1', 'r2']])
      const redNotes = recordingIssues()
      await writeDeploymentNotes({ project: 'fixture', issue: fromIssue('dep-red'), operation: red, issues: redNotes })
      t.eq('a red deployment notes every candidate\'s issue', redNotes.written.map((n) => n.issueId).sort(), ['i1', 'i2'])
      t.ok('choosing no follow-up', redNotes.written.every((n) => n.text.includes('No issue is chosen for the follow-up')))

      await configure('printf repaired')
      const retry = await deploy('dep-red', { retryFailed: red.id })
      t.eq('a retry has its own id and record', [retry.status, retry.retryOf, retry.id !== red.id, ids(retry.coverage.indeterminate).sort()], ['completed', red.id, true, ['r1', 'r2']])
      t.eq('the failed attempt keeps its own', JSON.parse(await fs.readFile(path.join(w.root, `issues/dep-red/operations/staging-deployment-${red.id}.json`), 'utf8')).coverage.indeterminate.length, 2)

      const stale = path.join(w.root, 'issues/dep-stale/operations')
      await fs.mkdir(stale, { recursive: true })
      const crashed = { id: 'crashed', status: 'running', project: 'fixture', startedAt: T(9), commands: [], coverage: { basis: DEPLOYMENT_UNPROVEN, covered: [], indeterminate: [{ issueId: 'i1', runId: 'r1', reason: DEPLOYMENT_UNPROVEN, firstNamed: true, checkout: { before: 'held', after: 'not-read' } }] } }
      await fs.writeFile(path.join(stale, 'staging-deployment.json'), JSON.stringify(crashed))
      const lost = recordingIssues()
      await resumeCoverageNotes({ project: 'fixture', issue: fromIssue('dep-stale'), issues: lost })
      t.eq('at startup, an operation still running is left to its replay', lost.written, [])
      const recovered = await deploy('dep-stale')
      t.eq('a crash replays as recovery required, never a success', [recovered.status, recovered.coverage.indeterminate[0].checkout.after], ['recovery-required', 'not-read'])
      await writeDeploymentNotes({ project: 'fixture', issue: fromIssue('dep-stale'), operation: recovered, issues: lost })
      t.ok('and the note a crash lost is written', lost.written[0]?.text.includes('recovery-required'))

      const later = await w.cover(await w.snapshot({ f: 'new\n', g: 'new\n' }), T(10))
      t.eq('a later Staging run covers them', ids(later.covered).sort(), ['r1', 'r2'])
      w.staging('rel', 'green', T(10), { coverage: later })
      const clear = await w.report(STAGING_TARGET)
      t.eq('and clears them', [ids(clear.pending), ids(clear.indeterminate)], [[], []])
    }

    t.section('the Staging run: the record, the explanation, the restore')
    {
      const w = await world()
      w.issue('i1'); w.issue('i2')
      await w.deliver('i1', 'r1', T(1), [['app.txt', 'old', 'release one']])
      await w.deliver('i2', 'hand', T(1), [['other.txt', 'old', 'new']])
      const issuePath = path.join(w.root, 'issues', 'rel')
      const workspace = { path: await w.snapshot({ 'app.txt': 'release one' }) }
      await fs.mkdir(issuePath, { recursive: true })
      const commandIds = ['inspect', 'checkpoint', 'verifyCheckpoint', 'apply', 'verifyRelease', 'restart', 'observe', 'test', 'restore', 'verifyRestore']
      const config = { workdir: w.root, ownership: 'Own app.txt.', rollback: 'automatic', commands: Object.fromEntries(commandIds.map((id) => [id, { run: id, timeoutSeconds: 10 }])) }
      const snapshot = { tactic: 'staging', runOptions: {}, infrastructure: { staging: { id: 'stage' }, deployments: [{ id: 'prod' }], release: { targets: { stage: config, prod: config } } } }
      const execute = async (args) => (args.command === 'tar' ? runProcess(args) : { code: args.args.at(-1) === 'test' ? 1 : 0, stdout: 'observed', stderr: '' })
      const coverage = ({ snapshotPath }) => w.cover(snapshotPath, T(2))
      const release = await executeRelease({ issuePath, runId: 'red', workspace, snapshot, execute, coverage })
      t.eq('a failed test keeps its automatic restore', [release.status, release.commands.at(-1).id], ['rolled-back', 'verifyRestore'])
      t.eq('and the record of what it carried', [ids(release.coverage.covered), ids(release.coverage.indeterminate)], [['r1'], ['hand']])
      t.eq('the record is durable', JSON.parse(await fs.readFile(path.join(issuePath, 'runs/red/release.json'), 'utf8')).coverage.covered[0].runId, 'r1')

      const failing = await executeRelease({ issuePath, runId: 'reading-failed', workspace, snapshot, execute: async (args) => (args.command === 'tar' ? runProcess(args) : { code: 0, stdout: '', stderr: '' }), coverage: async () => { throw new Error('unreadable') } })
      t.eq('a coverage reading that fails never stops a release', [failing.status, failing.coverage], ['completed', { error: 'unreadable' }])

      const run = { runId: 'red', status: 'blocked', outcome: 'unresolved', blockedReason: 'release-rolled-back', playbook: { strategy: 'staging' }, release }
      const explained = explainRun(run)
      t.eq('the explanation names who it carried', explained.releaseCoverage.covered, [{ issueId: 'i1', runId: 'r1' }])
      t.eq('and who is indeterminate', explained.releaseCoverage.indeterminate.map((e) => e.runId), ['hand'])
      t.ok('in words', explained.detail.includes('r1 (i1)') && explained.detail.includes('hand (i2)'))
      const account = renderResult(run)
      t.ok('the account lists them', account.includes('## Release coverage') && account.includes('covered: `r1`') && account.includes('indeterminate: `hand`'))

      const notes = recordingIssues()
      const receipt = await writeRunCoverageNotes({ project: 'p', issue: { id: 'rel', path: issuePath }, run, issues: notes })
      t.eq('a note on every issue it carried or could not place', notes.written.map((n) => n.issueId).sort(), ['i1', 'i2'])
      const onCovered = notes.written.find((n) => n.issueId === 'i1')
      t.ok('naming the run and its outcome', onCovered.text.includes('Release run red') && onCovered.text.includes('did not pass (release rolled-back, run blocked)'))
      t.ok('that the restore ran', onCovered.text.includes('automatic restore ran'))
      t.ok('the follow-up is not chosen', onCovered.text.includes('No issue is chosen for the follow-up'))
      t.ok('the link selects the run', onCovered.text.includes('(/projects/p/rel?run=red)'))
      t.eq('the receipt says they are written', receipt.i1.state, 'written')

      const greenNotes = recordingIssues()
      const green = { ...run, status: 'completed', outcome: 'resolved', blockedReason: null, release: { ...release, status: 'completed' } }
      await writeRunCoverageNotes({ project: 'p', issue: { id: 'rel', path: issuePath }, run: green, issues: greenNotes })
      const greenNote = greenNotes.written.find((n) => n.issueId === 'i1')
      t.ok('on success too', greenNote.text.includes('passed') && !greenNote.text.includes('follow-up'))
      t.eq('a later end rewrites under the same key', greenNote.invocationId, onCovered.invocationId)
      t.eq('a run with no coverage writes nothing', await writeRunCoverageNotes({ project: 'p', issue: { id: 'rel', path: issuePath }, run: { runId: 'x', status: 'completed' }, issues: greenNotes }), null)

      const owed = recordingIssues()
      await resumeCoverageNotes({ project: 'p', issue: { id: 'rel', path: issuePath }, run, issues: owed })
      t.eq('at startup, a written receipt owes nothing', owed.written, [])
      await fs.rm(path.join(issuePath, 'runs/red/staging-coverage-notes.json'))
      await resumeCoverageNotes({ project: 'p', issue: { id: 'rel', path: issuePath }, run, issues: owed })
      t.eq('a crash before the receipt writes them', owed.written.map((n) => n.issueId).sort(), ['i1', 'i2'])
    }

    t.section('recovery reaches a retry\'s archived attempt, and leaves written notes alone')
    {
      const w = await world()
      const issue = w.issue('dep')
      const dir = path.join(issue.path, 'operations')
      await fs.mkdir(dir, { recursive: true })
      const named = (issueId, runId) => ({ issueId, runId, reason: DEPLOYMENT_UNPROVEN, firstNamed: false, checkout: { before: 'held', after: 'held' } })
      const red = { id: 'red-attempt', status: 'failed', coverage: { basis: DEPLOYMENT_UNPROVEN, covered: [], indeterminate: [named('i1', 'r1'), named('i2', 'r2')] } }
      const green = { id: 'green-retry', status: 'completed', retryOf: 'red-attempt', coverage: { basis: DEPLOYMENT_UNPROVEN, covered: [], indeterminate: [named('i1', 'r1')] } }
      await fs.writeFile(path.join(dir, 'staging-deployment-red-attempt.json'), JSON.stringify(red))
      await fs.writeFile(path.join(dir, 'staging-deployment.json'), JSON.stringify(green))
      await fs.writeFile(path.join(dir, 'staging-coverage-notes-red-attempt.json'), JSON.stringify({ i1: { state: 'failed', reason: 'locked' }, i2: { state: 'written', where: 'step' } }))
      await fs.writeFile(path.join(dir, 'staging-coverage-notes-green-retry.json'), JSON.stringify({}))
      const notes = recordingIssues()
      await resumeCoverageNotes({ project: 'p', issue, issues: notes })
      t.eq('the failed attempt\'s failed note is written, and only that', notes.written.map((n) => [n.issueId, n.invocationId]), [['i1', 'staging-coverage:red-attempt']])
      t.ok('saying it failed', notes.written[0].text.includes('did not complete (failed)'))
      t.eq('the receipt keeps both', JSON.parse(await fs.readFile(path.join(dir, 'staging-coverage-notes-red-attempt.json'), 'utf8')), { i1: { state: 'written', where: 'step' }, i2: { state: 'written', where: 'step' } })
      await resumeCoverageNotes({ project: 'p', issue, issues: notes })
      t.eq('the next start owes nothing', notes.written.length, 1)
      await fs.rm(path.join(dir, 'staging-coverage-notes-red-attempt.json'))
      await resumeCoverageNotes({ project: 'p', issue, issues: notes })
      t.eq('a lost receipt rewrites under the same key, so no second step', [notes.written.length, new Set(notes.written.map((n) => n.invocationId)).size], [3, 1])
    }

    t.section('notes on real issues: a step, or kept beside an archived one')
    {
      const previous = process.env.DEVPANEL_ISSUES_DIR
      process.env.DEVPANEL_ISSUES_DIR = await tmp()
      const issues = await import(`../server/issues.js?coverage=${Date.now()}`)
      if (previous === undefined) delete process.env.DEVPANEL_ISSUES_DIR
      else process.env.DEVPANEL_ISSUES_DIR = previous
      const P = 'devpanel-project'
      const open = await issues.createIssue(P, { name: 'Open issue' })
      const toPack = await issues.createIssue(P, { name: 'Packed issue' })
      const folder = await issues.createIssue(P, { name: 'Archived folder' })
      const rel = await issues.createIssue(P, { name: 'Release issue' })
      await fs.mkdir(path.join(rel.path, 'runs', 'rel'), { recursive: true })
      await issues.setIssueArchived(P, toPack.id, true, { overrideReason: 'test' })
      await fs.writeFile(path.join(folder.path, '.archive.json'), '{}')
      const bundle = path.join(issues.ISSUES_DIR, '.archive', P, `${toPack.id}.tar.gz`)
      const bundleBytes = await fs.readFile(bundle)
      const noted = (status) => ({ runId: 'rel', status, outcome: status === 'completed' ? 'resolved' : 'unresolved',
        release: { tactic: 'staging', status: status === 'completed' ? 'completed' : 'rolled-back',
          coverage: { covered: [open, toPack, folder].map((i, n) => ({ issueId: i.id, runId: `r${n}` })), indeterminate: [] } } })
      const stepOf = async (id) => (await issues.getIssue(P, id)).steps.filter((s) => s.slug === 'staging-coverage')
      const noteText = async (id) => { const [s] = await stepOf(id); return fs.readFile(path.join((await issues.getIssue(P, id)).path, `${s.number}-${s.slug}`, 'note.md'), 'utf8') }

      for (const [status, word] of [['completed', 'passed'], ['blocked', 'failed']]) {
        const receipt = await writeRunCoverageNotes({ project: P, issue: rel, run: noted(status), issues })
        t.eq(`${word}: an open issue gets a step, one however often it is written`, (await stepOf(open.id)).length, 1)
        t.ok(`${word}: the step says so`, (await noteText(open.id)).includes(word))
        t.eq(`${word}: the archived ones are kept beside them`, [receipt[toPack.id].where, receipt[folder.id].where], ['archive', 'archive'])
        for (const id of [toPack.id, folder.id]) {
          const { archivedNotes, archived } = await issues.getIssue(P, id)
          t.eq(`${word}: one readable note, the issue still archived`, [archivedNotes.length, archived], [1, true])
          t.ok(`${word}: naming the outcome`, archivedNotes[0].text.includes(word))
          const dom = await htmlOf(archivedNotes[0].text)
          const link = dom.window.document.querySelector('a')
          t.eq(`${word}: its link is followable, to the release run`, link?.getAttribute('href'), `/projects/${P}/${rel.id}?run=rel`)
          t.eq(`${word}: in this tab, which keeps the token`, link?.getAttribute('target'), null)
          dom.window.close()
        }
        t.eq(`${word}: the bundle is as it was verified`, Buffer.compare(bundleBytes, await fs.readFile(bundle)), 0)
      }
      t.eq('a packed issue stays out of the active lists', (await issues.listIssues(P)).some((i) => i.id === toPack.id), false)
      t.eq('and its kept notes are no second packed issue', (await issues.listIssues(P, { archived: true })).filter((i) => i.packed).length, 1)

      const kept = (await issues.getIssue(P, toPack.id)).archivedNotes[0].text
      await issues.setIssueArchived(P, toPack.id, false)
      t.eq('restored, the note is a real step', (await stepOf(toPack.id)).length, 1)
      t.eq('with the same text', (await noteText(toPack.id)).trimEnd(), kept)
      t.eq('and nothing kept', (await issues.getIssue(P, toPack.id)).archivedNotes, undefined)
      await writeRunCoverageNotes({ project: P, issue: rel, run: noted('completed'), issues })
      t.eq('written again after the restore, the same step', (await stepOf(toPack.id)).length, 1)
      const dom = await htmlOf(await noteText(toPack.id))
      t.eq('its link still follows, after the restore', dom.window.document.querySelector('a')?.getAttribute('href'), `/projects/${P}/${rel.id}?run=rel`)
      dom.window.close()

      const sidecar = path.join(issues.ISSUES_DIR, '.archive', P, `${toPack.id}.notes.json`)
      await issues.setIssueArchived(P, toPack.id, true, { overrideReason: 'test' })
      await writeRunCoverageNotes({ project: P, issue: rel, run: noted('completed'), issues })
      t.ok('archived again, a note is kept', await fs.stat(sidecar).then(() => true, () => false))
      await issues.deleteIssue(P, toPack.id)
      t.eq('deleting the issue removes it', await fs.stat(sidecar).then(() => true, () => false), false)

      const deployed = { id: 'op1', status: 'failed', coverage: { covered: [], indeterminate: [{ issueId: folder.id, runId: 'r2', reason: DEPLOYMENT_UNPROVEN, firstNamed: false, checkout: { before: 'held', after: 'held' } }] } }
      await writeDeploymentNotes({ project: P, issue: rel, operation: deployed, issues })
      const onFolder = (await issues.getIssue(P, folder.id)).archivedNotes.find((n) => n.invocationId === 'staging-coverage:op1')
      const opDom = await htmlOf(onFolder.text)
      t.eq('a deployment\'s kept note links to the issue holding its report', opDom.window.document.querySelector('a')?.getAttribute('href'), `/projects/${P}/${rel.id}`)
      opDom.window.close()
      for (const packed of [false, true]) {
        const label = packed ? 'packed' : 'archived in place'
        const target = await issues.createIssue(P, { name: `Carried by a ${label} release` })
        const other = await issues.createIssue(P, { name: `Already told by a ${label} release` })
        const release = await issues.createIssue(P, { name: `Release issue ${label}` })
        const covered = [{ issueId: target.id, runId: 'c1' }, { issueId: other.id, runId: 'c2' }]
        await fs.mkdir(path.join(release.path, 'runs/rel'), { recursive: true })
        await fs.writeFile(path.join(release.path, 'runs/rel/run.json'), JSON.stringify({ runId: 'rel', status: 'blocked', outcome: 'unresolved', startedAt: T(2), endedAt: T(2), blockedReason: 'release-rolled-back',
          playbook: { id: 'staging', strategy: 'staging' }, release: { tactic: 'staging', status: 'rolled-back', coverage: { covered, indeterminate: [] } } }))
        await fs.writeFile(path.join(release.path, 'runs/rel/staging-coverage-notes.json'), JSON.stringify({ [target.id]: { state: 'failed', reason: 'locked' }, [other.id]: { state: 'written', where: 'step' } }))
        await fs.mkdir(path.join(release.path, 'operations'), { recursive: true })
        await fs.writeFile(path.join(release.path, 'operations/staging-deployment.json'), JSON.stringify({ id: `op-${packed}`, status: 'failed', startedAt: T(2), commands: [],
          coverage: { basis: DEPLOYMENT_UNPROVEN, covered: [], indeterminate: [{ issueId: target.id, runId: 'c1', reason: DEPLOYMENT_UNPROVEN, firstNamed: false, checkout: { before: 'held', after: 'held' } }] } }))
        if (packed) await issues.setIssueArchived(P, release.id, true, { overrideReason: 'test' })
        else await fs.writeFile(path.join(release.path, '.archive.json'), '{}')
        const listed = (await issues.listIssues(P, { archived: true })).find((i) => i.id === release.id)
        t.eq(`${label}: the release issue reads as archived`, [listed.archived, Boolean(listed.packed)], [true, packed])
        const bundleFile = path.join(issues.ISSUES_DIR, '.archive', P, `${release.id}.tar.gz`)
        const before = packed ? await fs.readFile(bundleFile) : null
        const calls = []
        const counted = new Proxy(issues, { get: (m, k) => k === 'createEngineNote' ? (project, id, note) => { calls.push([id, note.invocationId]); return m.createEngineNote(project, id, note) } : m[k] })
        await resumeArchivedCoverageNotes({ project: P, issue: listed, issues: counted })
        t.eq(`${label}: the owed notes are written, and not the one already written`, calls.sort(), [[target.id, 'staging-coverage:rel'], [target.id, `staging-coverage:op-${packed}`]].sort())
        const steps = (await issues.getIssue(P, target.id)).steps.filter((s) => s.slug === 'staging-coverage')
        t.eq(`${label}: each is a real note on the issue`, steps.length, 2)
        t.eq(`${label}: the issue told before gets nothing more`, (await issues.getIssue(P, other.id)).steps.filter((s) => s.slug === 'staging-coverage').length, 0)
        if (packed) t.eq('packed: the bundle is as it was verified', Buffer.compare(before, await fs.readFile(bundleFile)), 0)
        await resumeArchivedCoverageNotes({ project: P, issue: listed, issues: counted })
        t.eq(`${label}: the receipts held, so the next start owes nothing`, calls.length, 2)
        if (packed) {
          const side = path.join(issues.ISSUES_DIR, '.archive', P, `${release.id}.coverage-receipts.json`)
          t.eq('packed: the receipts are beside the bundle', Object.keys(JSON.parse(await fs.readFile(side, 'utf8'))).sort(), ['op-true', 'rel'])
          t.eq('packed: and are no second packed issue', (await issues.listIssues(P, { archived: true })).filter((i) => i.id.endsWith('.coverage-receipts')).length, 0)
          await issues.setIssueArchived(P, release.id, false)
          t.eq('packed: a restore takes them away', await fs.stat(side).then(() => true, () => false), false)
        }
      }

      t.eq('a note for an issue that is gone is no failure to retry', (await writeDeploymentNotes({ project: P, issue: rel, operation: { ...deployed, id: 'op2', coverage: { ...deployed.coverage, indeterminate: [{ ...deployed.coverage.indeterminate[0], issueId: '2026-01-01-gone' }] } }, issues }))['2026-01-01-gone'].state, 'gone')
    }

    t.section('the overview carries the same list')
    {
      const w = await world()
      w.issue('i1')
      await w.write('f', 'new\n')
      await w.deliver('i1', 'r1', T(1), [['f', 'old\n', 'new\n']])
      const overview = await buildOverview({ projects: ['p'], listIssues: w.ctx.listIssues, readRuns: w.ctx.readRuns, readPackedRuns: w.ctx.readPackedRuns,
        stagingPending: (project) => stagingPendingReport({ ...w.ctx, project, infrastructure: null }) })
      const line = overview.projects[0].stagingPending
      t.eq('per project, on a project with no staging configured too', [ids(line.pending), line.configured.stagingRelease, line.batch.reason], [['r1'], false, 'no-staging-release-target'])
      t.ok('and says what it means', overview.means.stagingPending.includes('no successful staging release (a Deployment run in the staging environment)'))
      const small = await buildOverview({ projects: ['p'], listIssues: w.ctx.listIssues, readRuns: w.ctx.readRuns, readPackedRuns: w.ctx.readPackedRuns, openIssueLimit: 0,
        stagingPending: (project) => stagingPendingReport({ ...w.ctx, project, infrastructure: null }) })
      t.eq('a long list says how much was left out', [small.projects[0].stagingPending.pending, small.projects[0].stagingPending.truncated.pending], [[], 1])
      const broken = await buildOverview({ projects: ['p'], listIssues: w.ctx.listIssues, readRuns: w.ctx.readRuns, readPackedRuns: w.ctx.readPackedRuns, stagingPending: async () => { throw new Error('unreadable') } })
      t.eq('a list that cannot be read says so', broken.projects[0].stagingPending, { error: 'unreadable' })
    }

    t.section('the wiring: the route, the prompt and the docs')
    {
      const read = (rel) => fs.readFile(path.join(CONFIG_ROOT, rel), 'utf8')
      t.ok('startup recovery reaches archived release issues', (await read('gui/server/supervisor.mjs')).includes('resumeArchivedCoverageNotes({ project: projectId, issue, issues })'))
      t.ok('the route exists', (await read('gui/server/index.js')).includes("app.get('/api/projects/:project/staging-pending'"))
      const prompt = await read('gui/server/top-supervisor.mjs')
      t.eq('the prompt no longer asks for a hand-written list', prompt.includes('names the delivered runs'), false)
      t.ok('it says only a staging release clears', prompt.includes('only a staging release (a Deployment run in the staging environment) does'))
      t.ok('and cuts a batch with a Deployment run to staging (operator-request:016)', prompt.includes('cutting a batch is your decision: preview and start_run the deployment playbook with runOptions.environment staging'))
      t.eq('it names no Staging playbook', /staging playbook|staging or deployment playbook/i.test(prompt), false)
      t.ok('deploy_staging stays the saved-command operation', prompt.includes('deploy_staging {project,issueId};') && prompt.includes('It executes the saved operator commands outside agent sandboxes'))
      t.ok('and leaves the batch to the supervisor', prompt.includes('cutting a batch is your decision'))
      const supervisorDoc = await read('docs/top-level-supervisor.md')
      const deploymentDoc = await read('docs/staging-deployment.md')
      t.eq('nor does its doc', supervisorDoc.includes('note names the delivered runs'), false)
      for (const [doc, text] of [['top-level-supervisor', supervisorDoc], ['staging-deployment', deploymentDoc]]) {
        t.ok(`${doc}: when to cut a batch`, /`pending`\s+list is non-empty/.test(text) && /no\s+delivery is in progress/.test(text))
        t.ok(`${doc}: who decides`, /never an agent inside a\s+run|no agent inside a run/.test(text))
      }
      t.ok('the doc states the deployment limit', /Only a staging release clears a run/.test(deploymentDoc))
      for (const [doc, text] of [['top-level-supervisor', supervisorDoc], ['staging-deployment', deploymentDoc]]) t.ok(`${doc}: how history is treated`, /coverage\s+baseline/.test(text) && /history/.test(text))
    }
  } finally {
    await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  }
}
