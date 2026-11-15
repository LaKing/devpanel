import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { windowSummary } from '../server/runtime/engine.mjs'

export const name = 'cycle evidence — a red full-verification issue\'s window holds that cycle\'s evidence, read-only'

const DATE = '2026-11-01'
const CYCLE = `${DATE}.2`
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

async function tree (root) {
  const out = {}
  const visit = async (rel) => {
    for (const d of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const r = path.join(rel, d.name)
      if (d.isDirectory()) await visit(r)
      else if (d.isFile()) out[r] = sha(await fs.readFile(path.join(root, r)))
      else out[r] = 'link'
    }
  }
  await visit('')
  return out
}

// issues/ with app-project (red), lib-project (framework), other-project (unrelated), and two cycles of one date.
async function fixture ({ withRecord = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-evidence-'))
  const issues = path.join(root, 'issues')
  const write = async (rel, text) => { const f = path.join(issues, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, text); return f }
  const issue = async (project, id, meta) => { await write(`${project}/${id}/issue.json`, JSON.stringify({ name: id, status: 'open', ...meta })); await write(`${project}/${id}/000-report/response.md`, `# ${id}\n`); return path.join(issues, project, id) }
  const red = await issue('app-project', '2026-11-01-full-verification-red', { openedBy: { user: 'engine', host: 'h', from: { project: 'app-project', runId: null, via: 'full-verification', cycle: CYCLE } } })
  const unrelated = await issue('app-project', '2026-11-02-unrelated', { openedBy: { user: 'someone', host: 'h', from: null } })
  const inquiry = await issue('app-project', '2026-11-03-inquiry-red', { kind: 'inquiry', inquiry: { question: 'why red?', relatedIssue: '2026-11-01-full-verification-red' } })
  const inquiryOther = await issue('app-project', '2026-11-04-inquiry-other', { kind: 'inquiry', inquiry: { question: 'why?', relatedIssue: '2026-11-02-unrelated' } })
  if (withRecord) {
    const record = {
      id: CYCLE, date: DATE, trigger: 'request', by: 'operator', state: 'ended', verdict: 'red', secretField: 'not copied',
      projects: [
        { project: 'app-project', stage: 'stage-a', verdict: 'red', runDir: '/elsewhere/never-followed' },
        { project: 'other-project', stage: 'stage-b', verdict: 'red', runDir: path.join(issues, '.verification', DATE, CYCLE, 'other-project') }
      ],
      outcome: {
        verdict: 'red', committed: false,
        issues: [{ project: 'app-project', issueId: '2026-11-01-full-verification-red' }, { project: 'other-project', issueId: 'x' }],
        bump: { chain: [], failed: null, notRun: [], versions: { 'other-project': '9.9.9' }, untestedCommitted: [],
          withheld: [{ framework: 'zz-framework', members: ['zz-framework', 'zz-instance'], moved: [{ project: 'app-project' }] }] }
      }
    }
    await write(`.verification/${DATE}/cycle.json`, JSON.stringify(record))
    await write(`.verification/${DATE}/cycle.1.json`, JSON.stringify({ id: `${DATE}.1`, date: DATE, projects: [{ project: 'app-project' }] }))
    const checks = `.verification/${DATE}/${CYCLE}/app-project/checks`
    await write(`${checks}/001/selftest.stdout`, '{"failed":["a"]}\n')
    await write(`${checks}/001/project.log`, 'log line\n')
    await write(`${checks}/001/browser-check.json`, '{"ok":false}\n')
    await write(`${checks}/full-verification-rerun-1/test.log`, 'rerun\n')
    await write(`.verification/${DATE}/${CYCLE}/app-project/drive.json`, '{}')
    await write(`.verification/${DATE}/${CYCLE}/other-project/checks/001/secret.log`, 'other project\n')
    await write(`.verification/${DATE}/${DATE}.1/app-project/checks/001/old.log`, 'older cycle\n')
    await fs.symlink(path.join(issues, '.verification', DATE, CYCLE, 'other-project', 'checks', '001', 'secret.log'), path.join(issues, checks, '001', 'link.log'))
  }
  return { root, issues, red, unrelated, inquiry, inquiryOther, write }
}

const capture = (issuePath, runId, extra = {}) => captureWindow({ issuePath, runId, workspace: { path: issuePath, baseCommit: null, base: null }, ...extra })
const relFiles = (w) => (w.cycleEvidence?.files ?? []).map((f) => path.relative(path.join(path.dirname(w.manifest), 'cycle-evidence'), f.file)).sort()

export default async function (t) {
  const f = await fixture()

  t.section('a red issue\'s run: the cycle record and its project\'s checks are in the window')
  const before = await tree(path.join(f.issues, '.verification'))
  const w = await capture(f.red, 'r1')
  const c = w.cycleEvidence
  t.eq('captured', c?.state, 'captured')
  t.eq('the cycle', [c.cycle, c.via], [CYCLE, 'openedBy'])
  t.eq('cycle.json and every checks file, the link skipped', relFiles(w),
    ['app-project/checks/001/browser-check.json', 'app-project/checks/001/project.log', 'app-project/checks/001/selftest.stdout', 'app-project/checks/full-verification-rerun-1/test.log', 'cycle.json'].sort())
  t.eq('the link is counted as skipped', c.skipped, 1)
  for (const file of c.files.filter((x) => x.project)) t.eq(`sha256 of ${path.basename(file.file)} matches its source`, file.sha256, sha(await fs.readFile(file.source)))
  t.ok('the manifest on disk lists them', JSON.parse(await fs.readFile(w.manifest, 'utf8')).cycleEvidence.files.length === 5)
  t.ok('copies live under the window\'s evidence directory (read-only to seats)', c.files.every((x) => x.file.startsWith(path.join(f.red, 'runs', 'r1', 'evidence', w.id, 'cycle-evidence') + path.sep)))
  t.eq('nothing written into the verification records', await tree(path.join(f.issues, '.verification')), before)

  t.section('cycle.json is filtered to the exposed projects, nested mentions included')
  const copied = JSON.parse(await fs.readFile(path.join(path.dirname(w.manifest), 'cycle-evidence', 'cycle.json'), 'utf8'))
  const text = JSON.stringify(copied)
  t.eq('only app-project\'s entry', copied.projects.map((e) => e.project), ['app-project'])
  t.ok('no other project anywhere, nor a pool that does not include app-project', !text.includes('other-project') && !text.includes('zz-instance') && !text.includes('zz-framework'), text)
  t.ok('fields outside the allow-list are left out', !text.includes('secretField'))
  t.eq('the filter says what it left out', [copied.windowFilter.projects, copied.windowFilter.omittedEntries], [['app-project'], 1])
  t.ok('names the original and its hash', copied.windowFilter.note.includes(c.recordSha256) && c.recordFile.endsWith(path.join(DATE, 'cycle.json')))

  t.section('the summary seats are given names it')
  const s = windowSummary(w)
  t.eq('summary', [s.cycleEvidence.state, s.cycleEvidence.files, s.cycleEvidence.cycle], ['captured', 5, CYCLE])

  t.section('an unrelated run gets none')
  const u = await capture(f.unrelated, 'r2')
  t.eq('no cycle evidence', u.cycleEvidence, null)
  t.ok('no directory', !(await fs.stat(path.join(path.dirname(u.manifest), 'cycle-evidence')).catch(() => null)))
  t.ok('no summary block', !('cycleEvidence' in windowSummary(u)))

  t.section('an inquiry naming the red issue as relatedIssue gets it; one naming another issue does not')
  const iq = await capture(f.inquiry, 'r3')
  t.eq('via relatedIssue', [iq.cycleEvidence?.state, iq.cycleEvidence?.via, iq.cycleEvidence?.relatedIssue], ['captured', 'relatedIssue', '2026-11-01-full-verification-red'])
  t.eq('same files', relFiles(iq).length, 5)
  t.eq('other inquiry', (await capture(f.inquiryOther, 'r4')).cycleEvidence, null)

  t.section('a fresh window keeps the first capture')
  const refreshed = await capture(f.red, 'r1', { previous: w, reason: 'refresh' })
  t.eq('kept', refreshed.cycleEvidence, w.cycleEvidence)
  const refreshedDir = windowSummary(refreshed).cycleEvidence.dir
  t.eq('the summary names where the retained copy lives', refreshedDir, path.join(path.dirname(w.manifest), 'cycle-evidence'))
  t.ok('and it exists', Boolean(await fs.stat(path.join(refreshedDir, 'cycle.json')).catch(() => null)))

  t.section('a pool the record names with the project exposes its member')
  const pool = await fixture()
  const rec = JSON.parse(await fs.readFile(path.join(pool.issues, '.verification', DATE, 'cycle.json'), 'utf8'))
  rec.outcome.bump.withheld = [{ framework: 'lib-project', members: ['lib-project', 'app-project'], moved: [{ project: 'other-project' }, { project: 'lib-project' }] }]
  rec.projects.push({ project: 'lib-project', verdict: 'green', runId: 'run-9' })
  await pool.write(`.verification/${DATE}/cycle.json`, JSON.stringify(rec))
  await pool.write(`lib-project/.verification-${DATE}/runs/run-9/checks/001/lib.log`, 'lib\n')
  const pw = await capture(pool.red, 'p1')
  t.eq('projects', pw.cycleEvidence.projects, ['app-project', 'lib-project'])
  t.ok('lib-project checks from its run home', relFiles(pw).includes('lib-project/checks/001/lib.log'), relFiles(pw).join(', '))
  t.ok('other-project still absent, also from withheld[].moved', !relFiles(pw).some((x) => x.startsWith('other-project')) && !(await fs.readFile(path.join(path.dirname(pw.manifest), 'cycle-evidence', 'cycle.json'), 'utf8')).includes('other-project'))

  t.section('caps: a file over the per-file cap keeps its tail and says so; one beyond the total is omitted and listed')
  const big = await fixture()
  await big.write(`.verification/${DATE}/${CYCLE}/app-project/checks/001/project.log`, 'HEAD' + 'x'.repeat(5000) + 'TAIL\n')
  const bw = await capture(big.red, 'b1', { limits: { maxCycleEvidenceFileBytes: 4096 } })
  const cut = bw.cycleEvidence.files.find((x) => x.file.endsWith('project.log'))
  t.eq('truncated', [cut.truncated, cut.bytes, cut.totalBytes], [true, 4096, 5009])
  t.ok('the tail kept', (await fs.readFile(cut.file, 'utf8')).endsWith('TAIL\n'))
  t.ok('a note on the file and on the capture', /cut to the last 4096 of 5009 bytes/.test(cut.note) && /cut to the last 4096 bytes/.test(bw.cycleEvidence.note), bw.cycleEvidence.note)
  const tight = await capture(big.red, 'b2', { limits: { maxCycleEvidenceBytes: 2000, maxCycleEvidenceFileBytes: 4096 } })
  t.ok('omitted ones are listed with the cap that left them out', tight.cycleEvidence.omitted.length > 0 && tight.cycleEvidence.omitted.every((o) => o.reason === 'maxCycleEvidenceBytes' && o.source), JSON.stringify(tight.cycleEvidence.omitted))
  t.ok('and the note says so', /omitted, by the caps or unreadable/.test(tight.cycleEvidence.note), tight.cycleEvidence.note)
  const few = await capture(big.red, 'b3', { limits: { maxCycleEvidenceFiles: 2 } })
  t.eq('file cap', [few.cycleEvidence.files.length, few.cycleEvidence.omitted.length], [2, 3])

  t.section('an evidence directory reached through a link is refused, whatever it points to')
  const linked = await fixture()
  const home = path.join(linked.issues, '.verification', DATE, CYCLE, 'app-project')
  await fs.rm(home, { recursive: true })
  await linked.write(`.verification/${DATE}/${DATE}.1/other-project/checks/001/private.log`, 'OTHER PROJECT, OTHER CYCLE\n')
  await fs.symlink(path.join(linked.issues, '.verification', DATE, `${DATE}.1`, 'other-project'), home)
  const lw = await capture(linked.red, 'l1')
  const entry = lw.cycleEvidence.entries.find((e) => e.project === 'app-project')
  t.eq('refused, with a note', [entry.state, /through a link/.test(entry.note)], ['refused', true])
  t.eq('only the filtered record was copied', relFiles(lw), ['cycle.json'])
  const copiedTree = await tree(path.join(path.dirname(lw.manifest), 'cycle-evidence'))
  t.eq('nothing else on disk either', Object.keys(copiedTree), ['cycle.json'])
  t.ok('the capture says so', /refused \(reached through a link\)/.test(lw.cycleEvidence.note), lw.cycleEvidence.note)

  t.section('an unreadable file after a readable one: listed as omitted, and manifest and disk agree')
  const denied = await fixture()
  const deniedFile = await denied.write(`.verification/${DATE}/${CYCLE}/app-project/checks/zzz/zzz-denied.log`, 'secret\n')
  await fs.chmod(deniedFile, 0o000)
  if (await fs.readFile(deniedFile).then(() => true, () => false)) t.skip('unreadable file', 'this process can read a mode-000 file (root?)')
  else {
    const dw = await capture(denied.red, 'd1')
    t.eq('still captured', dw.cycleEvidence.state, 'captured')
    t.ok('the unreadable file is listed with its reason', dw.cycleEvidence.omitted.some((o) => o.source === deniedFile && /^unreadable: EACCES/.test(o.reason)), JSON.stringify(dw.cycleEvidence.omitted))
    const onDisk = Object.keys(await tree(path.join(path.dirname(dw.manifest), 'cycle-evidence'))).sort()
    t.eq('every file on disk is in the manifest, and only those', onDisk, relFiles(dw))
    t.ok('the readable ones are there', relFiles(dw).includes('app-project/checks/001/project.log'))
  }
  await fs.chmod(deniedFile, 0o600)

  t.section('a pruned record is stated, not silently missing')
  const gone = await fixture({ withRecord: false })
  const gw = await capture(gone.red, 'g1')
  t.eq('pruned', gw.cycleEvidence.state, 'pruned')
  t.ok('the note names the cycle', gw.cycleEvidence.note.includes(CYCLE) && /no longer in issues\/\.verification\/2026-11-01\//.test(gw.cycleEvidence.note), gw.cycleEvidence.note)
  t.ok('nothing copied', !(await fs.stat(path.join(path.dirname(gw.manifest), 'cycle-evidence')).catch(() => null)))
  t.ok('the summary says so', windowSummary(gw).cycleEvidence.instruction.includes('no evidence of full verification'))
  const ig = await capture(gone.inquiry, 'g2')
  t.eq('an inquiry about it too', [ig.cycleEvidence.state, ig.cycleEvidence.relatedIssue], ['pruned', '2026-11-01-full-verification-red'])

  for (const d of [f, pool, big, gone, linked, denied]) await fs.rm(d.root, { recursive: true, force: true })
}
