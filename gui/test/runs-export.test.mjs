import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'npm run runs — one row per run, read-only: every unreadable input named, runs in run-id order, totals as overview counts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUI = path.resolve(HERE, '..')
const TOOL = path.join(GUI, 'tools', 'runs.mjs')
const HOOK = pathToFileURL(path.join(HERE, 'fakes', 'record-imports.mjs')).href
const exec = promisify(execFile)
const exists = (p) => fs.access(p).then(() => true, () => false)

const NOW = Date.now()
const KEYS = ['issue', 'packed', 'runId', 'playbook', 'configHash', 'status', 'outcome', 'startedAt', 'endedAt', 'agentMs', 'operatorWaitMs',
  'checksMs', 'checks', 'turns', 'cost', 'tokens', 'cause', 'next']

const run = (runId, status, startedAt, extra = {}) => ({
  runId, status, outcome: ['completed', 'blocked', 'failed', 'cancelled'].includes(status) ? (status === 'completed' ? 'resolved' : 'unresolved') : null,
  blockedReason: null,
  playbook: { id: 'implementation', version: 2, intent: null, configHash: 'sha256:aaaabbbbcccc' },
  participants: { implementer: { model: 'fixture-model' } },
  startedAt, endedAt: ['running', 'paused'].includes(status) ? null : new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
  steps: [], budgets: { used: {} }, failure: null, ...extra
})
const at = (iso, plusMs) => new Date(Date.parse(iso) + plusMs).toISOString()
const turn = (role, startedAt, ms) => ({ role, phase: 'implement', startedAt, endedAt: at(startedAt, ms), durationMs: ms })

async function listing (dir, rel = '') {
  const out = []
  for (const entry of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(rel, entry.name)
    const stat = await fs.lstat(path.join(dir, child))
    out.push(`${child} ${entry.isDirectory() ? 'd' : 'f'} ${stat.size} ${stat.mtimeMs}`)
    if (entry.isDirectory()) out.push(...await listing(dir, child))
  }
  return out
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-runs-export-'))
  const projects = path.join(root, 'projects')
  const issuesDir = path.join(root, 'issues')
  const PROJECTS = ['alpha-project', 'broken-project', 'order-project', 'filed-project', 'repeat-project', 'moved-project', 'dup-project', 'race-project', 'tri-project', 'noon-project']
  for (const p of PROJECTS) await fs.mkdir(path.join(projects, p), { recursive: true })
  await fs.mkdir(issuesDir)

  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  process.env.DEVPANEL_PROJECTS_DIR = projects
  try {
    const issues = await import(`../server/issues.js?runs-export=${Date.now()}`)
    const { exportRuns, validTimestamp } = await import('../server/run-export.mjs')
    const { buildOverview } = await import('../server/supervisor-overview.mjs')
    const { packIssue, unpackIssue, packedRuns, bundleFiles } = await import('../server/issue-bundle.mjs')

    const issue = async (project, title) => (await issues.createIssue(project, { name: title })).id
    const put = async (project, id, folder, file, content) => {
      const dir = path.join(issuesDir, project, id, 'runs', folder)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content))
    }
    const putRun = (project, id, record, folder = record.runId) => put(project, id, folder, 'run.json', record)
    const pack = (project, id) => packIssue({ issuesDir, project, id, issue: { id, name: id }, releaseWorktrees: async () => {} })
    const sidecar = (project, id) => bundleFiles(issuesDir, project, id).runs
    const bundle = (project, id) => bundleFiles(issuesDir, project, id).bundle
    const rewrite = async (file, change) => fs.writeFile(file, JSON.stringify(change(JSON.parse(await fs.readFile(file, 'utf8')))))
    const read = (project, extra = {}) => exportRuns({ issuesDir, project, now: NOW, ...extra })
    const parts = (lines) => ({
      rows: lines.filter((l) => 'runId' in l && 'cause' in l),
      unreadable: lines.filter((l) => 'unreadable' in l),
      skipped: lines.filter((l) => 'skipped' in l),
      totals: lines.at(-1).totals
    })
    const linesFor = (list, where) => list.filter((l) => l.unreadable === where)

    // ---- alpha: sound data, open and packed, for parity, row keys and causes
    const T0 = '2026-11-10T10:00:00.000Z'
    const alphaOpen = await issue('alpha-project', 'Open work')
    await putRun('alpha-project', alphaOpen, run('a1', 'completed', T0, {
      steps: [turn('implementer', at(T0, 1000), 60_000), turn('auditor-1', at(T0, 30_000), 60_000), { role: 'operator', startedAt: at(T0, 100_000), endedAt: at(T0, 160_000) }],
      checkResults: [{ at: at(T0, 200_000), durationMs: 45_000, result: 'passed' }],
      budgets: { used: { costUsd: 0.5, tokens: 1000 } }
    }))
    await putRun('alpha-project', alphaOpen, run('a2', 'failed', at(T0, 3_600_000), {
      failure: { class: 'runtime', message: 'boom' }, steps: [turn('implementer', at(T0, 3_601_000), 5000)],
      budgets: { used: { tokens: 20, costUnknownSteps: 1 } }
    }))
    await putRun('alpha-project', alphaOpen, run('a3', 'failed', at(T0, 7_200_000), {
      blockedReason: 'preflight-refused', preflight: { state: 'refused', detail: 'no harness answers' }
    }))
    await putRun('alpha-project', alphaOpen, run('a4', 'cancelled', at(T0, 9_000_000), { preflight: { state: 'pending', detail: null } }))
    await putRun('alpha-project', alphaOpen, run('a5', 'blocked', at(T0, 10_000_000), { blockedReason: 'rounds-exhausted', budgets: { used: { costUsd: 1.25, estimatedCostUsd: 0.5, costEstimatedSteps: 2, costUnknownSteps: 1, tokens: 300 } } }))
    const alphaLive = await issue('alpha-project', 'In flight')
    await putRun('alpha-project', alphaLive, run('a6', 'running', at(T0, 20_000_000)))
    await putRun('alpha-project', alphaLive, run('a7', 'paused', at(T0, 21_000_000)))
    const alphaPacked = await issue('alpha-project', 'Put away')
    await putRun('alpha-project', alphaPacked, run('b1', 'completed', '2026-11-01T08:00:00.000Z', {
      steps: [turn('implementer', '2026-11-01T08:01:00.000Z', 30_000)], budgets: { used: { estimatedCostUsd: 0.25, costEstimatedSteps: 3, tokens: 500 } }
    }))
    await issues.setIssueArchived('alpha-project', alphaPacked, true)

    // ---- broken: one of every unreadable input, beside sound rows
    const bOpen = await issue('broken-project', 'Damaged records')
    const bDir = path.join(issuesDir, 'broken-project', bOpen, 'runs')
    await putRun('broken-project', bOpen, run('ok-1', 'completed', '2026-11-12T00:00:00.000Z'))
    await put('broken-project', bOpen, 'trunc', 'run.json', '{"runId":')
    await put('broken-project', bOpen, 'nul', 'run.json', 'null')
    await put('broken-project', bOpen, 'arr', 'run.json', '[]')
    await putRun('broken-project', bOpen, { runId: 'st5', status: 5 })
    await putRun('broken-project', bOpen, { runId: 'steps5', steps: 5 })
    await putRun('broken-project', bOpen, { runId: 'stepsarr', steps: [5] })
    await putRun('broken-project', bOpen, { runId: 'nost', startedAt: '2026-11-12T01:00:00.000Z' })
    await putRun('broken-project', bOpen, { runId: 'nostart', status: 'completed', outcome: 'resolved' })
    await putRun('broken-project', bOpen, { ...run('snaparr', 'completed', '2026-11-12T02:00:00.000Z'), playbook: { id: 'implementation' } })
    await put('broken-project', bOpen, 'snaparr', 'resolved-playbook.json', '[]')
    await putRun('broken-project', bOpen, { ...run('snap5', 'completed', '2026-11-12T03:00:00.000Z'), playbook: { id: 'implementation' } })
    await put('broken-project', bOpen, 'snap5', 'resolved-playbook.json', { configHash: 5 })
    await putRun('broken-project', bOpen, run('chkstr', 'completed', '2026-11-12T04:00:00.000Z', { checkResults: [{ at: '2026-11-12T04:10:00.000Z', durationMs: '1000' }] }))
    await putRun('broken-project', bOpen, run('reusedstr', 'completed', '2026-11-12T05:00:00.000Z', { baselineChecks: [{ at: '2026-11-12T05:10:00.000Z', durationMs: 1000, reused: 'false' }] }))
    await putRun('broken-project', bOpen, run('reusedobj', 'completed', '2026-11-12T06:00:00.000Z', { baselineChecks: [{ at: '2026-11-12T06:10:00.000Z', durationMs: 1000, reused: { key: 'k' } }, { at: '2026-11-12T06:20:00.000Z', durationMs: 500, reused: false }] }))
    await putRun('broken-project', bOpen, run('feb31', 'completed', '2026-02-31T12:00:00.000Z'))
    const bNoRuns = await issue('broken-project', 'Runs is a file')
    await fs.writeFile(path.join(issuesDir, 'broken-project', bNoRuns, 'runs'), 'not a directory')

    const packedWith = async (title, records, after) => {
      const id = await issue('broken-project', title)
      for (const r of records) typeof r.raw === 'string' ? await put('broken-project', id, r.folder, 'run.json', r.raw) : await putRun('broken-project', id, r)
      await pack('broken-project', id)
      await after?.(id)
      return id
    }
    const p1 = await packedWith('Truncated sidecar', [run('p1-a', 'completed', '2026-11-13T00:00:00.000Z')],
      (id) => fs.writeFile(sidecar('broken-project', id), '[{"runId":'))
    const p2 = await packedWith('Sidecar of the wrong shape', [run('p2-a', 'completed', '2026-11-13T01:00:00.000Z')],
      (id) => fs.writeFile(sidecar('broken-project', id), '{}'))
    const p3 = await packedWith('Null member', [run('p3-a', 'completed', '2026-11-13T02:00:00.000Z')],
      (id) => rewrite(sidecar('broken-project', id), (m) => [...m, null]))
    const p4 = await packedWith('Garbage bundle', [run('p4-a', 'completed', '2026-11-13T03:00:00.000Z')],
      (id) => fs.writeFile(bundle('broken-project', id), 'not a gzip'))
    const p5 = await packedWith('Sidecar missing a member', [run('p5-a', 'completed', '2026-11-13T04:00:00.000Z'), run('p5-b', 'completed', '2026-11-13T05:00:00.000Z')],
      (id) => rewrite(sidecar('broken-project', id), (m) => m.filter((r) => r.runId !== 'p5-b')))
    const p6 = await packedWith('Dotted legacy run that did not read when packed',
      [run('p6-a', 'completed', '2026-11-13T06:00:00.000Z'), { folder: 'old.run-1', raw: '{"runId":"old.run-1",' }])
    const p7 = await packedWith('Malformed sidecar member with a known run id',
      [run('r1', 'completed', '2026-11-13T07:00:00.000Z'), run('r2', 'completed', '2026-11-13T08:00:00.000Z')],
      (id) => rewrite(sidecar('broken-project', id), (m) => m.map((r) => (r.runId === 'r1' ? { ...r, status: 5 } : r))))

    // ---- dup: one sidecar holding the same run twice
    const dp = await issue('dup-project', 'Duplicated member')
    await putRun('dup-project', dp, run('d1', 'completed', '2026-11-17T00:00:00.000Z'))
    await putRun('dup-project', dp, run('d2', 'failed', '2026-11-17T01:00:00.000Z'))
    await pack('dup-project', dp)
    await rewrite(sidecar('dup-project', dp), (m) => [m[0], { ...m[0], outcome: 'copy' }, m[1]])

    // ---- race: a pack caught between the folder read and the sidecar read; the folder's copy of s2 did not read
    const rc = await issue('race-project', 'Mid-pack')
    await putRun('race-project', rc, run('s1', 'completed', '2026-11-18T00:00:00.000Z'))
    await putRun('race-project', rc, run('s2', 'failed', '2026-11-18T01:00:00.000Z'))
    await pack('race-project', rc)
    const rcFiles = bundleFiles(issuesDir, 'race-project', rc)
    const rcSidecar = await fs.readFile(rcFiles.runs)
    const rcBundle = await fs.readFile(rcFiles.bundle)
    await unpackIssue({ issuesDir, project: 'race-project', id: rc })
    await fs.writeFile(rcFiles.runs, rcSidecar)
    await fs.writeFile(rcFiles.bundle, rcBundle)
    await fs.writeFile(path.join(issuesDir, 'race-project', rc, 'runs', 's2', 'run.json'), '{"runId":"s2",')

    // ---- tri: sidecar r1, r2, r3; the folder holds r1 and r3 readable and r2 malformed (a move in progress)
    const tr = await issue('tri-project', 'Three runs mid-move')
    await putRun('tri-project', tr, run('r1', 'completed', '2026-11-19T00:00:00.000Z'))
    await putRun('tri-project', tr, run('r2', 'failed', '2026-11-19T01:00:00.000Z'))
    await putRun('tri-project', tr, run('r3', 'blocked', '2026-11-19T02:00:00.000Z'))
    await pack('tri-project', tr)
    const trFiles = bundleFiles(issuesDir, 'tri-project', tr)
    const trSidecar = await fs.readFile(trFiles.runs)
    const trBundle = await fs.readFile(trFiles.bundle)
    await unpackIssue({ issuesDir, project: 'tri-project', id: tr })
    await fs.writeFile(trFiles.runs, trSidecar)
    await fs.writeFile(trFiles.bundle, trBundle)
    await fs.writeFile(path.join(issuesDir, 'tri-project', tr, 'runs', 'r2', 'run.json'), '{"runId":"r2",')

    // ---- noon: a run a millisecond before 12:00Z and one at 12:00:00.000Z
    const nn = await issue('noon-project', 'Around noon')
    await putRun('noon-project', nn, run('n1', 'completed', '2026-11-20T11:59:59.999Z'))
    await putRun('noon-project', nn, run('n2', 'completed', '2026-11-20T12:00:00.000Z'))

    // ---- order: run ids against start times
    const o1 = await issue('order-project', 'Ordered by id')
    await putRun('order-project', o1, run('r-a', 'completed', '2026-11-20T03:00:00.000Z'))
    await putRun('order-project', o1, run('r-b', 'failed', '2026-11-20T02:00:00.000Z'))
    await putRun('order-project', o1, run('r-c', 'blocked', '2026-11-20T01:00:00.000Z'))
    await put('order-project', o1, 'r-bb', 'run.json', '{')
    const o2 = await issue('order-project', 'Interleaved')
    await putRun('order-project', o2, run('r-ab', 'completed', '2026-11-21T00:00:00.000Z'))
    await putRun('order-project', o2, run('r-ca', 'completed', '2026-11-21T01:00:00.000Z'))

    // ---- filed: the project's issue path is a file, its archive is still read
    const f1 = await issue('filed-project', 'Packed before the folder went bad')
    await putRun('filed-project', f1, run('f-1', 'completed', '2026-11-14T00:00:00.000Z'))
    await pack('filed-project', f1)
    await fs.rm(path.join(issuesDir, 'filed-project'), { recursive: true, force: true })
    await fs.writeFile(path.join(issuesDir, 'filed-project'), 'not a directory')

    // ---- repeat: the archive directory is a file, listed twice
    const rp = await issue('repeat-project', 'Readable folder')
    await putRun('repeat-project', rp, run('rp-1', 'completed', '2026-11-15T00:00:00.000Z'))
    await fs.mkdir(path.join(issuesDir, '.archive'), { recursive: true })
    // Creating an issue may leave the id-lock directory there (issue-locks.mjs); the fixture replaces it.
    await fs.rm(path.join(issuesDir, '.archive', 'repeat-project'), { recursive: true, force: true })
    await fs.writeFile(path.join(issuesDir, '.archive', 'repeat-project'), 'not a directory')

    // ---- moved: a restore caught between publishing the folder and removing the sidecar
    const mv = await issue('moved-project', 'Mid-restore')
    await putRun('moved-project', mv, run('m1', 'completed', '2026-11-16T00:00:00.000Z'))
    await putRun('moved-project', mv, run('m2', 'failed', '2026-11-16T01:00:00.000Z'))
    await pack('moved-project', mv)
    const mvFiles = bundleFiles(issuesDir, 'moved-project', mv)
    const keptSidecar = await fs.readFile(mvFiles.runs)
    const keptBundle = await fs.readFile(mvFiles.bundle)
    await unpackIssue({ issuesDir, project: 'moved-project', id: mv })
    await fs.writeFile(mvFiles.runs, keptSidecar)
    await fs.writeFile(mvFiles.bundle, keptBundle)

    // =====================================================================
    t.section('1. AC5/AC7: every input that does not read is one line, and the reading goes on')
    const broken = parts((await read('broken-project')).lines)
    const expectOne = (label, where, pattern = null) => {
      const found = linesFor(broken.unreadable, where)
      t.eq(`${label}: exactly one unreadable line`, found.length, 1)
      if (pattern && found[0]) t.ok(`${label}: says why`, pattern.test(found[0].error), found[0].error)
    }
    expectOne('truncated run.json', path.join(bDir, 'trunc', 'run.json'))
    expectOne('run.json of null', path.join(bDir, 'nul', 'run.json'), /not a run record/)
    expectOne('run.json of []', path.join(bDir, 'arr', 'run.json'), /not a run record/)
    expectOne('status: 5', path.join(bDir, 'st5', 'run.json'), /status is not a string/)
    expectOne('steps: 5', path.join(bDir, 'steps5', 'run.json'), /steps is not an array/)
    expectOne('steps: [5]', path.join(bDir, 'stepsarr', 'run.json'), /member of steps/)
    expectOne('resolved-playbook.json of []', path.join(bDir, 'snaparr', 'resolved-playbook.json'), /not a snapshot/)
    expectOne('resolved-playbook.json with configHash: 5', path.join(bDir, 'snap5', 'resolved-playbook.json'), /configHash is not a string/)
    t.eq('a bad snapshot keeps its row, configHash null', ['snaparr', 'snap5'].map((id) => broken.rows.find((r) => r.runId === id)?.configHash), [null, null])
    expectOne('runs/ that is a file', path.join(issuesDir, 'broken-project', bNoRuns, 'runs'), /ENOTDIR/)
    expectOne('truncated sidecar', sidecar('broken-project', p1))
    expectOne('sidecar of {}', sidecar('broken-project', p2), /not an array/)
    expectOne('a null sidecar member', `${sidecar('broken-project', p3)}#1`, /not a run record/)
    expectOne('a garbage bundle', bundle('broken-project', p4))
    t.ok('the garbage bundle\'s sidecar runs are still rows', broken.rows.some((r) => r.runId === 'p4-a'))
    expectOne('a run the sidecar lost', `${bundle('broken-project', p5)}#runs/p5-b/run.json`, /^in the bundle but not in its run records$/)
    expectOne('a dotted legacy run that did not read when packed', `${bundle('broken-project', p6)}#runs/old.run-1/run.json`)
    t.ok('its sibling is a row', broken.rows.some((r) => r.runId === 'p6-a'))
    const r1Lines = broken.unreadable.filter((l) => l.unreadable.startsWith(sidecar('broken-project', p7)) || l.unreadable.startsWith(bundle('broken-project', p7)))
    t.eq('a malformed sidecar member with a known run id: only its own line', r1Lines.map((l) => l.unreadable), [`${sidecar('broken-project', p7)}#0`])
    t.ok('and r2 is still a row', broken.rows.some((r) => r.runId === 'r2' && r.issue === p7))
    expectOne('check evidence of the wrong type is not "no check ran"', path.join(bDir, 'chkstr', 'run.json'), /checkResults\[0\]\.durationMs is not a number/)
    t.ok('and it is no row', !broken.rows.some((r) => r.runId === 'chkstr'))
    expectOne('a baseline whose reused is neither false nor a reuse record', path.join(bDir, 'reusedstr', 'run.json'), /baselineChecks\[0\]\.reused/)
    t.eq('a reuse record and reused:false are sound: only the unreused baseline counts', broken.rows.find((r) => r.runId === 'reusedobj')?.checksMs, 500)
    t.eq('every sound run is a row', broken.rows.map((r) => r.runId).sort(),
      ['feb31', 'nost', 'nostart', 'ok-1', 'p3-a', 'p4-a', 'p5-a', 'p6-a', 'r2', 'reusedobj', 'snap5', 'snaparr'])
    t.eq('no input is reported twice', new Set(broken.unreadable.map((l) => l.unreadable)).size, broken.unreadable.length)
    t.eq('the totals count the unreadable lines', broken.totals.unreadable, broken.unreadable.length)
    const windowed = parts((await read('broken-project', { from: Date.parse('2000-01-01T00:00:00Z') })).lines)
    t.eq('with a window, a run without startedAt is one line, not a silent gap',
      linesFor(windowed.unreadable, path.join(bDir, 'nostart', 'run.json')).map((l) => /cannot place it in the window/.test(l.error)), [true])
    t.eq('with a window, an impossible date (2026-02-31) is one line, not moved to March',
      linesFor(windowed.unreadable, path.join(bDir, 'feb31', 'run.json')).map((l) => /cannot place it in the window/.test(l.error)), [true])
    t.ok('and is no row in the window', !windowed.rows.some((r) => r.runId === 'feb31'))

    const dup = parts((await read('dup-project')).lines)
    t.eq('a run held twice in one history is one row', dup.rows.map((r) => r.runId), ['d1', 'd2'])
    t.eq('the later copy is a skipped line', dup.skipped.map((s) => s.skipped), [`${sidecar('dup-project', dp)}#1`])
    t.eq('the first copy is the one kept', dup.rows[0].outcome, 'resolved')
    t.eq('a run never follows itself', dup.rows[0].next, { runId: 'd2', status: 'failed', outcome: 'unresolved' })
    t.eq('the totals count it once', [dup.totals.rows, dup.totals.skipped], [2, 1])

    const race = parts((await read('race-project')).lines)
    t.eq('mid-pack: s1 from the folder, s2 from the sidecar', race.rows.map((r) => [r.runId, r.packed]), [['s1', false], ['s2', true]])
    t.eq('the folder copy of s2 that did not read is one line', race.unreadable.map((l) => l.unreadable), [path.join(issuesDir, 'race-project', rc, 'runs', 's2', 'run.json')])
    t.eq('s1 names s2 with the outcome its readable copy records', race.rows[0].next, { runId: 's2', status: 'failed', outcome: 'unresolved' })

    const tri = parts((await read('tri-project')).lines)
    t.eq('three runs mid-move: each once', tri.rows.map((r) => [r.runId, r.packed]), [['r1', false], ['r2', true], ['r3', false]])
    t.eq('packed r2 is followed by r3, with r3\'s outcome, though the folder copy of r3 is the counted one',
      tri.rows.find((r) => r.runId === 'r2')?.next, { runId: 'r3', status: 'blocked', outcome: 'unresolved' })
    t.eq('folder r1 is followed by r2, with the outcome of its readable copy', tri.rows.find((r) => r.runId === 'r1')?.next, { runId: 'r2', status: 'failed', outcome: 'unresolved' })
    t.eq('the packed copies of r1 and r3 are skipped lines', tri.skipped.map((x) => x.skipped), [`${trFiles.runs}#0`, `${trFiles.runs}#2`])

    t.eq('a UTC time to the minute is a timestamp', validTimestamp('2026-11-20T12:00Z'), true)
    t.eq('finer than a millisecond is not (Date.parse would drop it unseen)', validTimestamp('2026-11-20T12:00:00.0009Z'), false)
    t.eq('a year below 100 is a four-digit year, not 19xx', validTimestamp('0099-01-01T00:00:00Z'), true)
    t.eq('the fraction counts in the round trip', [validTimestamp('2026-11-20T12:00:00.5Z'), validTimestamp('2026-11-20T12:00:60Z')], [true, false])

    const filed = parts((await read('filed-project')).lines)
    t.eq('an issue path that is a file: one line', filed.unreadable.map((l) => l.unreadable), [path.join(issuesDir, 'filed-project')])
    t.eq('and its archive is still read', filed.rows.map((r) => [r.runId, r.packed]), [['f-1', true]])

    const repeat = parts((await read('repeat-project')).lines)
    t.eq('an archive directory that is a file, listed twice: one line', repeat.unreadable.map((l) => l.unreadable), [path.join(issuesDir, '.archive', 'repeat-project')])
    t.ok('naming ENOTDIR', /ENOTDIR/.test(repeat.unreadable[0]?.error ?? ''), repeat.unreadable[0]?.error)
    t.eq('the folder\'s runs are rows', repeat.rows.map((r) => r.runId), ['rp-1'])

    const moved = parts((await read('moved-project')).lines)
    t.eq('mid-restore: each run once, from the folder', moved.rows.map((r) => [r.runId, r.packed]), [['m1', false], ['m2', false]])
    t.eq('each packed copy is a skipped line', moved.skipped.map((s) => s.skipped), [`${mvFiles.runs}#0`, `${mvFiles.runs}#1`])
    t.eq('the totals count each run once', [moved.totals.rows, moved.totals.skipped], [2, 2])

    t.section('2. AC4/AC7: runs follow each other by run id, nothing else')
    const order = parts((await read('order-project')).lines)
    t.eq('rows are ordered by run id across issues, not by start time', order.rows.map((r) => r.runId), ['r-a', 'r-ab', 'r-b', 'r-c', 'r-ca'])
    const next = Object.fromEntries(order.rows.map((r) => [r.runId, r.next]))
    t.eq('r-a is followed by r-b, with its outcome', next['r-a'], { runId: 'r-b', status: 'failed', outcome: 'unresolved' })
    t.eq('r-b is followed by the unreadable r-bb', next['r-b'], { runId: 'r-bb', unreadable: true })
    t.eq('the last run of an issue has no next', [next['r-c'], next['r-ca']], [null, null])
    t.eq('next stays within its issue', next['r-ab'], { runId: 'r-ca', status: 'completed', outcome: 'resolved' })
    const late = parts((await read('order-project', { from: Date.parse('2026-11-20T02:30:00Z') })).lines)
    t.eq('a window selects by startedAt', late.rows.map((r) => r.runId), ['r-a', 'r-ab', 'r-ca'])
    t.eq('next is read before the window', late.rows.find((r) => r.runId === 'r-a')?.next?.runId, 'r-b')

    t.section('3. AC2/AC3: every row carries every field; causes as recorded')
    const alpha = parts((await read('alpha-project')).lines)
    t.eq('alpha has no unreadable input', alpha.unreadable, [])
    const everyRow = [...alpha.rows, ...broken.rows, ...order.rows]
    t.eq('every key on every row, even when the record lacks it', everyRow.filter((r) => KEYS.some((k) => !(k in r))).map((r) => r.runId), [])
    const nost = JSON.parse(JSON.stringify(broken.rows.find((r) => r.runId === 'nost')))
    t.eq('a record without status and outcome reads null for both, after serialization', [nost.status, nost.outcome, 'status' in nost, 'outcome' in nost], [null, null, true, true])
    const a = Object.fromEntries(alpha.rows.map((r) => [r.runId, r]))
    t.eq('cost, unpriced steps and tokens', [a.a1.cost, a.a1.tokens, a.a2.cost, a.a2.tokens], [{ usd: 0.5, estimatedUsd: 0, unpricedSteps: 0, estimatedSteps: 0, pricing: 'priced' }, 1000, { usd: null, estimatedUsd: 0, unpricedSteps: 1, estimatedSteps: 0, pricing: 'unpriced' }, 20])
    t.eq('reported, estimated and unknown apart; reported money beside an unknown step is partial', a.a5.cost, { usd: 1.25, estimatedUsd: 0.5, unpricedSteps: 1, estimatedSteps: 2, pricing: 'partial' })
    t.eq('estimated money alone is priced, with no reported usd', a.b1.cost, { usd: null, estimatedUsd: 0.25, unpricedSteps: 0, estimatedSteps: 3, pricing: 'priced' })
    t.eq('checks coverage', [a.a1.checks, a.a3.checks], [{ coverage: 'recorded', intervals: 1 }, { coverage: 'none', intervals: 0 }])
    t.ok('agent and wait time are measured', a.a1.agentMs > 0 && a.a1.operatorWaitMs === 60_000 && a.a1.checksMs === 45_000, JSON.stringify([a.a1.agentMs, a.a1.operatorWaitMs, a.a1.checksMs]))
    t.eq('cause: failure.class', a.a2.cause, { value: 'runtime', source: 'failure.class', detail: 'boom' })
    t.eq('cause: preflight refused, with its detail', a.a3.cause, { value: 'preflight-refused', source: 'blockedReason', detail: 'no harness answers' })
    t.eq('cause: a pending preflight with no detail is unknown', a.a4.cause, { value: 'unknown', source: 'unknown', detail: null })
    t.eq('the packed run is a row, with its configHash', [a.b1?.packed, a.b1?.configHash], [true, 'sha256:aaaabbbbcccc'])

    t.section('4. AC6: totals over the same selection match the overview, which is unchanged')
    const overview = await buildOverview({ projects: ['alpha-project'], listIssues: (p, o) => issues.listIssues(p, o),
      readPackedRuns: (p, id) => packedRuns(issuesDir, p, id), now: NOW })
    const o = overview.projects[0].runs
    const x = alpha.totals
    t.eq('rows = total', x.rows, o.total)
    t.eq('byStatus', x.byStatus, o.byStatus)
    t.eq('terminal', x.terminal, o.terminal)
    t.eq('agentMs, operatorWaitMs, checksMs', [x.agentMs, x.operatorWaitMs, x.checksMs], [o.metrics.agentMs, o.metrics.operatorWaitMs, o.metrics.checksMs])
    t.eq('cost: reported, estimated, tokens, priced, partial, unpriced and steps, as the overview counts them', x.cost, o.cost)
    t.eq('the totals count partially priced runs apart', [x.cost.priced, x.cost.partial, x.cost.unpriced, x.cost.usd, x.cost.estimatedUsd, x.cost.unpricedSteps, x.cost.estimatedSteps], [2, 1, 3, 1.75, 0.75, 2, 5])
    t.ok('the parity is not vacuous', x.rows === 8 && x.agentMs > 0 && x.cost.usd > 0, JSON.stringify(x))

    t.section('5. AC1: the command writes nothing, starts nothing, and exits 0 unless the project has no directory')
    const bin = path.join(root, 'bin')
    const marker = path.join(root, 'spawned')
    await fs.mkdir(bin)
    for (const cli of ['claude', 'codex', 'gemini']) await fs.writeFile(path.join(bin, cli), `#!/bin/sh\necho ${cli} >> '${marker}'\n`, { mode: 0o755 })
    const importLog = path.join(root, 'imports.log')
    const cli = async (...args) => {
      await fs.rm(importLog, { force: true })
      try {
        const { stdout } = await exec(process.execPath, ['--import', HOOK, TOOL, ...args], {
          cwd: GUI,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, DEVPANEL_PROJECTS_DIR: projects, DEVPANEL_ISSUES_DIR: issuesDir,
            DEVPANEL_IMPORT_LOG: importLog, DEVPANEL_HOST_CONFIG_DIR: process.env.DEVPANEL_HOST_CONFIG_DIR,
            DEVPANEL_CLAUDE_BIN: path.join(bin, 'claude'), DEVPANEL_CODEX_BIN: path.join(bin, 'codex') },
          maxBuffer: 16 << 20
        })
        return { code: 0, lines: stdout.split('\n').filter(Boolean), imports: (await fs.readFile(importLog, 'utf8').catch(() => '')).split('\n').filter(Boolean) }
      } catch (error) { return { code: error.code, lines: [], stderr: error.stderr } }
    }
    const before = await listing(root)
    const all = await cli('--project', 'alpha-project')
    const brokenCli = await cli('--project', 'broken-project')
    const windowCli = await cli('--project', 'order-project', '--from', '2026-11-20T02:30:00Z', '--to', '2026-11-21')
    const after = await listing(root)
    let parsed = null
    try { parsed = all.lines.map((l) => JSON.parse(l)) } catch {}
    t.ok('every line is JSON', parsed !== null && parsed.length > 0, all.lines.slice(0, 2).join(' | '))
    t.eq('the CLI prints the same rows and totals as the module', parsed?.filter((l) => 'cause' in l).map((r) => r.runId), alpha.rows.map((r) => r.runId))
    t.ok('the last line is the totals', Boolean(parsed?.at(-1)?.totals))
    t.eq('the fixture is unchanged (imports.log aside)', after.filter((l) => !l.startsWith('imports.log ')), before.filter((l) => !l.startsWith('imports.log ')))
    t.eq('no CLI was run', await exists(marker), false)
    const forbidden = /\/harness\/|\/server\/(supervisor|top-supervisor|top-supervisor-service|runs-api)\.mjs$|\/server\/runtime\/(launch|engine|process|command|checks|ledger)\.mjs$|\/server\/decisions\//
    t.ok('the import record works (it saw the export module)', all.imports.some((u) => u.endsWith('/server/run-export.mjs')))
    t.eq('no adapter, engine, launch, ledger or supervisor module was loaded', all.imports.filter((u) => forbidden.test(u)), [])
    t.eq('unreadable inputs do not change the exit code', brokenCli.code, 0)
    t.eq('a UTC window from the command line', windowCli.lines.map((l) => JSON.parse(l)).filter((l) => 'cause' in l).map((r) => r.runId), ['r-a', 'r-ab', 'r-ca'])
    const noon = await cli('--project', 'noon-project', '--from', '2026-11-20T12:00Z')
    t.eq('--from to the minute selects the run at 12:00:00.000Z and not the one before', noon.lines.map((l) => JSON.parse(l)).filter((l) => 'cause' in l).map((r) => r.runId), ['n2'])
    const yearTime = await cli('--project', 'noon-project', '--from', '0099-01-01T00:00:00Z')
    const yearDay = await cli('--project', 'noon-project', '--from', '0099-01-01')
    t.eq('--from 0099-01-01T00:00:00Z is accepted', yearTime.code, 0)
    t.eq('and gives the same bound as --from 0099-01-01', yearTime.lines.map((l) => JSON.parse(l)).at(-1)?.totals?.from, yearDay.lines.map((l) => JSON.parse(l)).at(-1)?.totals?.from ?? 'no day bound')
    t.eq('a project with no directory exits 1', (await cli('--project', 'ghost-project')).code, 1)
    for (const bad of [['--project', '../x'], ['--project', 'a/b'], ['--project', '.archive'], [], ['--bogus'], ['--project'], ['--project', 'alpha-project', '--from', '2026-02-31'],
      ['--project', 'alpha-project', '--from', '2026-11-02', '--to', '2026-11-01'], ['--project', 'alpha-project', '--from', '2026-11-01T00:00:00+01:00'],
      ['--project', 'alpha-project', '--from', '2026-02-31T12:00:00Z'], ['--project', 'noon-project', '--from', '2026-11-20T12:00:00.0009Z']]) {
      t.eq(`${bad.join(' ') || '(no arguments)'}: exit 2`, (await cli(...bad)).code, 2)
    }
    for (const bad of ['../x', 'a/b', '.archive']) {
      let code = null
      try { await exportRuns({ issuesDir: path.join(root, 'nowhere'), project: bad }) } catch (error) { code = error.code }
      t.eq(`exportRuns refuses ${bad} before reading anything`, code, 'BAD_PROJECT')
    }
  } finally {
    if (saved.issues === undefined) delete process.env.DEVPANEL_ISSUES_DIR; else process.env.DEVPANEL_ISSUES_DIR = saved.issues
    if (saved.projects === undefined) delete process.env.DEVPANEL_PROJECTS_DIR; else process.env.DEVPANEL_PROJECTS_DIR = saved.projects
    await fs.rm(root, { recursive: true, force: true })
  }
}
