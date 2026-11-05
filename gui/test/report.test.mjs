import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import express from 'express'

import { bundleFiles, unpackIssue } from '../server/issue-bundle.mjs'
import { lookupRetry, reportFingerprint, validFingerprint } from '../server/report-identity.mjs'
import { privateAddress, refusal, reportRouter, reportText } from '../server/report.mjs'
import { withLock } from '../server/runtime/lock.mjs'
import { listen } from './helpers.mjs'

export const name = 'anonymous reporting — a private-network peer may open an issue and nothing else'

async function serve (options, onError = null) {
  const app = express()
  app.use(reportRouter(options))
  if (onError) app.use(onError)
  const server = http.createServer(app)
  await listen(server, 0, '127.0.0.1')
  const post = async (project, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/report/${project}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { post, close: () => new Promise((resolve) => server.close(resolve)) }
}

const exec = promisify(execFile)
const sha = (file) => fs.readFile(file).then((bytes) => crypto.createHash('sha256').update(bytes).digest('hex'))
const exists = (p) => fs.access(p).then(() => true, () => false)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * No listening socket in these, so they run wherever the suite does; the route's own cases are section 5.
 * Fixtures only: nothing here reads a real project's issues.
 */
async function identity (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-identity-'))
  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
  const issuesDir = path.join(root, 'issues')
  const P = 'app-project'
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  process.env.DEVPANEL_PROJECTS_DIR = path.join(root, 'projects')
  await fs.mkdir(path.join(root, 'projects', P), { recursive: true })
  await fs.mkdir(issuesDir)
  const issues = await import(`../server/issues.js?identity=${Date.now()}`)
  const clockWas = lookupRetry.now
  let clock = 1
  lookupRetry.now = () => clock
  const nextMinute = () => { clock += 2 * 60 * 1000 }
  const origin = { kind: 'fault', category: 'error', reporter: 'r', trust: 'fault' }
  const report = (title, fingerprint, seams) => issues.createIssue(P, { input: `# ${title}\n\nFingerprint: ${fingerprint}\n`, reportOrigin: { ...origin }, openedBy: { user: 'r' } }, seams)
  const archive = (id) => issues.setIssueArchived(P, id, true, { overrideReason: 'fixture' })
  const folder = (id) => path.join(issuesDir, P, id)
  const record = async (id) => JSON.parse(await fs.readFile(path.join(folder(id), 'issue.json'), 'utf8'))
  // A bundle from before reports recorded a fingerprint: only its text has it.
  const oldBundle = async (id, text, { openedAt = '2026-01-01T10:00:00.000Z' } = {}) => {
    const work = await fs.mkdtemp(path.join(root, 'old-'))
    await fs.mkdir(path.join(work, id, '000-report'), { recursive: true })
    await fs.writeFile(path.join(work, id, '000-report', 'response.md'), text)
    await fs.writeFile(path.join(work, id, 'issue.json'), JSON.stringify({ name: id, project: P, report: origin, openedAt }))
    const files = bundleFiles(issuesDir, P, id)
    await fs.mkdir(files.dir, { recursive: true })
    await exec('tar', ['-C', work, '-czf', files.bundle, id])
    await fs.writeFile(files.summary, JSON.stringify({ version: 1, issue: { id, name: id, project: P, report: origin, openedAt, packed: true }, runs: [], results: [], operations: [], packedAt: openedAt }))
    await fs.writeFile(files.runs, '[]')
    return files
  }
  try {
    t.section('A. a fingerprint is read from a label, and only from a label')
    for (const [what, text, expected] of [
      ['a bullet', '# T\n\n- fingerprint: abc123def\n', 'abc123def'],
      ['bold', '# T\n\n**Fingerprint:** `abc123def`\n', 'abc123def'],
      ['a backticked value', '# T\n\nFingerprint `abc123def`\n', 'abc123def'],
      ['a table row', '# T\n\n| Fingerprint | abc123def |\n', 'abc123def'],
      ['JSON', '# T\n\n```json\n{"kind":"x","fingerprint":"abc123def"}\n```\n', 'abc123def'],
      ['prose', '# T\n\nThe fingerprint matches another one seen earlier.\n', null],
      ['two different values', '# T\n\nfingerprint: abc123def\nfingerprint: fed321cba\n', null],
      ['the same value twice', '# T\n\nfingerprint: abc123def\nerror fingerprint: abc123def\n', 'abc123def'],
      ['no value', '# T\n\nfingerprint: unknown\n', null],
      ['longer than a fingerprint can be', `# T\n\nfingerprint: ${'a'.repeat(128)}X\n`, null],
      ['exactly as long as one can be', `# T\n\nfingerprint: ${'a'.repeat(128)}\n`, 'a'.repeat(128)],
      ['words after the value', '# T\n\nfingerprint: abc123def seen again\n', null],
      ['a character no fingerprint has, inside the value', '# T\n\nfingerprint: abc123#def\n', null],
      ['a quoted value with a space', '# T\n\nfingerprint: "abc123 def"\n', null],
      ['a closed value with words after it', '# T\n\n**Fingerprint:** `abc123def` (sha1)\n', 'abc123def'],
      ['too long by an underscore', `# T\n\nfingerprint: ${'a'.repeat(128)}_\n`, null],
      ['too long by two', `# T\n\nfingerprint: ${'a'.repeat(128)}__\n`, null],
      ['too long inside emphasis', `# T\n\nfingerprint: **${'a'.repeat(129)}**\n`, null],
      ['too long inside backticks', `# T\n\nfingerprint: \`${'a'.repeat(129)}\`\n`, null],
      ['too long in JSON', `# T\n\n{"fingerprint":"${'a'.repeat(129)}"}\n`, null],
      ['underscores belong to the value', '# T\n\nfingerprint: abc_123_def\n', 'abc_123_def'],
      ['a trailing underscore is part of it', '# T\n\nfingerprint: abc123_\n', 'abc123_'],
      ['and two are another value', '# T\n\nfingerprint: abc123__\n', 'abc123__'],
      ['balanced bold', '# T\n\nfingerprint: **abc123def**\n', 'abc123def'],
      ['balanced underscores', '# T\n\nfingerprint: __abc123def__\n', 'abc123def'],
      ['emphasis that does not open', '# T\n\nfingerprint: abc123def**\n', null],
      ['emphasis that does not close', '# T\n\nfingerprint: **abc123def\n', null],
      ['an unbalanced underscore in front', '# T\n\nfingerprint: _abc123def\n', null],
      ['a trailing comma on a bare value', '# T\n\nfingerprint: abc123def,\n', null],
      ['a trailing brace on a bare value', '# T\n\nfingerprint: abc123def}\n', null],
      ['a trailing pipe with no table', '# T\n\nfingerprint: abc123def |\n', null],
      ['a table with more columns', '# T\n\n| Fingerprint | abc123def | seen |\n', null],
      ['a closing quote with more stuck to it', '# T\n\nfingerprint: "abc123def"more\n', null],
      ['a pretty-printed JSON member', '# T\n\n  "fingerprint": "abc123def",\n', 'abc123def'],
      ['two JSON members on one line', '# T\n\n{"fingerprint":"abc123def","fingerprint":"fed321cba"}\n', null]
    ]) t.eq(what, reportFingerprint(text), expected)
    t.eq('the route\'s field takes what the parser takes', ['abc123def', 'abc_123_def', `${'a'.repeat(128)}X`, `${'a'.repeat(128)}_`, 'unknown', 'n/a', 'short', 'two words here'].map(validFingerprint), [true, true, false, false, false, false, false, false])
    {
      const a = await report('Long value one', `${'a'.repeat(128)}X`)
      const b = await report('Long value two', `${'a'.repeat(128)}Y`)
      t.eq('two values that share only a long prefix are not read as one', [a.report?.fingerprint, b.report?.fingerprint, b.repeats], [undefined, undefined, null])
      const under = await report('Long underscores one', `${'a'.repeat(128)}_`)
      const under2 = await report('Long underscores two', `${'a'.repeat(128)}__`)
      t.eq('nor when what differs is underscores', [under.report?.fingerprint, under2.report?.fingerprint, under2.repeats], [undefined, undefined, null])
      await report('Short underscores one', 'short0_')
      const short2 = await report('Short underscores two', 'short0__')
      t.eq('a short value and the same with one more underscore are two values', [short2.report?.fingerprint, short2.repeats], ['short0__', null])
    }

    t.section('B. an archived id is never taken; a fingerprint match is what says "repeats"')
    {
      const first = await report('Same fault', 'aaaa1111')
      await issues.createStep(P, first.id, { name: 'first-note', text: 'only in the first' })
      await archive(first.id)
      const before = await sha(bundleFiles(issuesDir, P, first.id).bundle)
      const second = await report('Same fault', 'aaaa1111')
      t.eq('the new report has its own id', second.id, `${first.id}-2`)
      t.eq('its record says what it repeats', (await record(second.id)).repeats, { project: P, id: first.id, evidence: 'fingerprint', fingerprint: 'aaaa1111' })
      t.eq('and the API', (await issues.getIssue(P, second.id)).repeats?.id, first.id)
      const family = await issues.issueFamily(P, second.id)
      t.eq('the family names the history, archived', [family.repeats?.id, family.repeats?.name, family.repeats?.packed], [first.id, 'Same fault', true])
      const third = await report('Same fault', 'bbbb2222')
      t.eq('a different fingerprint is another issue', third.id, `${first.id}-3`)
      t.eq('which repeats nothing, only shares a title', [(await record(third.id)).repeats, (await record(third.id)).sameTitleAs], [undefined, { project: P, id: first.id }])
      for (const [what, attempt, id] of [
        ['a resubmission of the second names it', () => report('Same fault', 'aaaa1111'), second.id],
        ['a resubmission of the third names it', () => report('Same fault', 'bbbb2222'), third.id],
        ['an unreadable fingerprint answers as today, naming the first live one', () => issues.createIssue(P, { input: '# Same fault\n\nno label here\n', reportOrigin: { ...origin } }), second.id]
      ]) t.eq(what, await attempt().then(() => null, (e) => [e.status, e.existingId]), [409, id])
      await archive(second.id)
      t.eq('archiving the new issue leaves the older bundle as it was', await sha(bundleFiles(issuesDir, P, first.id).bundle), before)
      const held = (await exec('tar', ['-tzf', bundleFiles(issuesDir, P, first.id).bundle])).stdout
      t.ok('with the first issue in it', held.includes('first-note'))
      const fourth = await report('Same fault', 'aaaa1111')
      t.eq('both archived ids are walked past, and the newest match is named', [fourth.id, (await record(fourth.id)).repeats.id], [`${first.id}-4`, second.id])

      const titled = await issues.createIssue(P, { input: '# Title only\n\nno label\n', reportOrigin: { ...origin } })
      await archive(titled.id)
      const again = await issues.createIssue(P, { input: '# Title only\n\nno label\n', reportOrigin: { ...origin } })
      t.eq('a shared title alone is no repeat', [again.id, again.repeats, again.sameTitleAs], [`${titled.id}-2`, null, { project: P, id: titled.id }])
      t.eq('and the family says so', (await issues.issueFamily(P, again.id)).sameTitleAs?.id, titled.id)

      await fs.mkdir(path.join(folder('2026-01-02-live-old-fault'), '000-report'), { recursive: true })
      await fs.writeFile(path.join(folder('2026-01-02-live-old-fault'), 'issue.json'), JSON.stringify({ name: 'Live old fault', project: P, report: origin, openedAt: '2026-01-02T10:00:00.000Z' }))
      await fs.writeFile(path.join(folder('2026-01-02-live-old-fault'), '000-report', 'response.md'), '# Live old fault\n\nFingerprint: cccc0000\n')
      t.eq('a live issue of another day, under another title, by its text', (await report('Other words', 'cccc0000')).repeats?.id, '2026-01-02-live-old-fault')
      await oldBundle('2026-01-03-old-bundle', '# Old bundle\n\nFingerprint: cccc1111\n')
      t.eq('an old bundle, from the text inside it', (await report('Other words again', 'cccc1111')).repeats?.id, '2026-01-03-old-bundle')
      for (let i = 0; i < 12; i++) await oldBundle(`2026-02-${String(i + 1).padStart(2, '0')}-noise-${i}`, `# Noise\n\nFingerprint: noise${i}000\n`)
      await oldBundle('2025-01-01-the-oldest', '# Oldest\n\nFingerprint: cccc2222\n', { openedAt: '2025-01-01T10:00:00.000Z' })
      t.eq('the match in the oldest of many is still found: there is no limit to hit', (await report('Words of the oldest', 'cccc2222')).repeats?.id, '2025-01-01-the-oldest')
    }

    t.section('C. forced orderings: an issue moving during the lookup is seen once')
    {
      const a = await report('Ordering restored', 'dddd0001')
      await archive(a.id)
      let restoring = null
      let folderDuringSeam = null
      const reported = await report('Ordering restored later', 'dddd0001', { lookup: { betweenListings: async () => {
        let ready
        const atPublish = new Promise((resolve) => { ready = resolve })
        restoring = unpackIssue({ issuesDir, project: P, id: a.id, beforePublish: () => ready() })
        await atPublish
        await delay(50)
        folderDuringSeam = await exists(folder(a.id))
      } } })
      t.eq('a restore started between the two listings waits for them', folderDuringSeam, false)
      t.eq('and the lookup finds it', reported.repeats?.id, a.id)
      await restoring
      t.eq('then the restore finishes', await exists(folder(a.id)), true)

      const b = await report('Ordering packed', 'dddd0002')
      let packing = null
      let stillFolder = null
      const reportedB = await report('Ordering packed later', 'dddd0002', { lookup: { betweenListings: async () => {
        packing = archive(b.id)
        await delay(300)
        stillFolder = await exists(folder(b.id))
      } } })
      t.eq('a pack started between the two listings waits for them', stillFolder, true)
      t.eq('and the lookup finds it', reportedB.repeats?.id, b.id)
      await packing

      const c = await report('Moved after listing', 'dddd0003')
      await archive(c.id)
      const reportedC = await report('Moved after listing, later', 'dddd0003', { lookup: { afterSnapshot: () => issues.setIssueArchived(P, c.id, false) } })
      t.eq('restored after the listing: found in its folder', reportedC.repeats?.id, c.id)

      const d = await report('Packed after listing', 'dddd0004')
      const reportedD = await report('Packed after listing, later', 'dddd0004', { lookup: { afterSnapshot: () => archive(d.id) } })
      t.eq('packed after the listing: found in its bundle', reportedD.repeats?.id, d.id)

      const e = await report('Round trip', 'dddd0005')
      await archive(e.id)
      const reportedE = await report('Round trip, later', 'dddd0005', { lookup: { afterSnapshot: async () => { await issues.setIssueArchived(P, e.id, false); await archive(e.id) } } })
      t.eq('restored and packed again after the listing: still found', reportedE.repeats?.id, e.id)
    }

    t.section('D. pending lookup, then archive')
    {
      const movesLock = path.join(issuesDir, '.archive', P, '.moves.lock')
      const pendingReport = (title, fingerprint) => withLock(movesLock, { purpose: 'test' }, () => report(title, fingerprint, { movesWaitMs: 20 }))
      const earlier = await report('Pending earlier', 'eeee0001')
      await archive(earlier.id)
      const earlierBundle = await sha(bundleFiles(issuesDir, P, earlier.id).bundle)
      const pending = await pendingReport('Pending report', 'eeee0001')
      const held = await record(pending.id)
      t.eq('the listing could not be taken: accepted, pending, and no claim', [Boolean(held.repeatLookup?.listing), held.repeats], [true, undefined])
      // Archiving reads the issue twice (before packing, and to answer). A read while the lock is held spends
      // this minute's rerun, so the lookup is still pending when packing happens and completes only after it.
      const stillHeld = await withLock(movesLock, { purpose: 'test' }, () => issues.getIssue(P, pending.id))
      t.ok('a read while the lock is held changes nothing', Boolean(stillHeld.repeatLookup?.listing) && !stillHeld.repeats)
      const archived = await archive(pending.id)
      const files = bundleFiles(issuesDir, P, pending.id)
      t.eq('archiving is not held up by the pending lookup, and it is pending when packed', [archived.packed, Boolean(archived.repeatLookup?.listing), archived.repeats], [true, true, null])
      t.ok('the verified summary says so too', Boolean(JSON.parse(await fs.readFile(files.summary, 'utf8')).issue.repeatLookup?.listing))
      const hashes = [await sha(files.bundle), await sha(files.summary)]
      nextMinute()
      const packed = await issues.getIssue(P, pending.id)
      t.eq('a read after packing completes it', [packed.packed, packed.repeats?.id, packed.repeatLookup], [true, earlier.id, null])
      t.eq('the archived list says the same', (await issues.listIssues(P, { archived: true })).find((i) => i.id === pending.id)?.repeats?.id, earlier.id)
      t.eq('the family, for the page', (await issues.issueFamily(P, pending.id)).repeats?.id, earlier.id)
      t.eq('the new bundle and summary are as verified', [await sha(files.bundle), await sha(files.summary)], hashes)
      t.eq('the earlier bundle too', await sha(bundleFiles(issuesDir, P, earlier.id).bundle), earlierBundle)
      await issues.setIssueArchived(P, pending.id, false)
      const restored = await issues.getIssue(P, pending.id)
      t.eq('a restored report keeps the outcome', [restored.packed ?? false, restored.repeats?.id, restored.repeatLookup], [false, earlier.id, null])
      t.ok('and its own record still says it was pending', Boolean((await record(pending.id)).repeatLookup))
      t.eq('archiving it again is not refused', (await archive(pending.id)).repeats?.id, earlier.id)
      await issues.deleteIssue(P, pending.id)
      t.eq('delete takes the outcome with it', await exists(files.repeatLookup), false)

      // The path tools/pack-archived.mjs takes: a marked folder, packed on its own.
      const viaTool = await pendingReport('Pending, packed by the tool', 'eeee0001')
      await fs.writeFile(path.join(folder(viaTool.id), '.archive.json'), JSON.stringify({ archivedAt: new Date().toISOString() }))
      await issues.packArchived(P, viaTool.id)
      t.eq('packed by the tool: completed the same way', (await issues.getIssue(P, viaTool.id)).repeats?.id, earlier.id)

      const brokenId = '2026-01-04-broken-bundle'
      const broken = await oldBundle(brokenId, '# Broken\n\nFingerprint: eeee0002\n')
      const good = await fs.readFile(broken.bundle)
      await fs.writeFile(broken.bundle, 'not a tarball')
      const waiting = await report('Waits for a broken bundle', 'eeee0002')
      t.eq('a bundle that cannot be read: accepted, and named', (await record(waiting.id)).repeatLookup?.unread, [brokenId])
      await archive(waiting.id)
      nextMinute()
      t.eq('still failing at archive: the warning stays on the record', (await issues.getIssue(P, waiting.id)).repeatLookup?.unread, [brokenId])
      t.eq('and for the page', (await issues.issueFamily(P, waiting.id)).repeatLookup?.unread, [brokenId])
      await fs.writeFile(broken.bundle, good)
      nextMinute()
      const healed = await issues.getIssue(P, waiting.id)
      t.eq('replacing the bundle completes it', [healed.repeats?.id, healed.repeatLookup], [brokenId, null])

      const goneId = '2026-01-05-broken-then-deleted'
      const gone = await oldBundle(goneId, '# Gone\n\nFingerprint: eeee0003\n')
      await fs.writeFile(gone.bundle, 'not a tarball')
      const waitingGone = await report('Waits for a deleted bundle', 'eeee0003')
      t.eq('pending on it', (await record(waitingGone.id)).repeatLookup?.unread, [goneId])
      await archive(waitingGone.id)
      await issues.deleteIssue(P, goneId)
      nextMinute()
      const cleared = await issues.getIssue(P, waitingGone.id)
      t.eq('an operator deleting the bundle clears it, with no claim', [cleared.repeats, cleared.repeatLookup], [null, null])

      const moving = await report('Keeps moving', 'eeee0004')
      const exhausted = await report('Waits for a moving issue', 'eeee0004', { lookup: { failRead: (entry) => entry.id === moving.id } })
      t.eq('relocations exhausted: named as unread', (await record(exhausted.id)).repeatLookup?.unread, [moving.id])
      t.eq('the next read completes it', (await issues.getIssue(P, exhausted.id)).repeats?.id, moving.id)
    }

    t.section('E. a rerun writes nothing but its own outcome')
    {
      const movesLock = path.join(issuesDir, '.archive', P, '.moves.lock')
      const earlier = await report('Rerun earlier', 'ffff0001')
      const pending = await withLock(movesLock, { purpose: 'test' }, () => report('Rerun report', 'ffff0001', { movesWaitMs: 20 }))
      const before = await fs.readFile(path.join(folder(pending.id), 'issue.json'), 'utf8')
      let runs = 0
      lookupRetry.seams = { afterSnapshot: () => { runs++ } }
      const [one, two] = await Promise.all([issues.getIssue(P, pending.id), issues.getIssue(P, pending.id)])
      lookupRetry.seams = {}
      t.eq('two reads at once run one lookup', runs, 1)
      t.eq('both read its outcome', [one.repeats?.id, two.repeats?.id], [earlier.id, earlier.id])
      t.eq('issue.json is byte for byte what it was', await fs.readFile(path.join(folder(pending.id), 'issue.json'), 'utf8'), before)

      const other = await withLock(movesLock, { purpose: 'test' }, () => report('Rerun beside a decision', 'ffff0001', { movesWaitMs: 20 }))
      // Not awaited inside the rerun: the disposition's own read of the issue waits for that very rerun.
      let decided = null
      lookupRetry.seams = { afterSnapshot: () => { decided = issues.setIssueDisposition(P, other.id, { value: 'declined', evidence: 'written while the rerun ran' }); return delay(50) } }
      const read = await issues.getIssue(P, other.id)
      await decided
      lookupRetry.seams = {}
      t.eq('a disposition written while it runs survives', [(await record(other.id)).disposition?.value, read.repeats?.id], ['declined', pending.id])
    }

    t.section('G. a corrupt outcome file is no outcome')
    {
      const movesLock = path.join(issuesDir, '.archive', P, '.moves.lock')
      const earlier = await report('Corrupt outcome earlier', 'cdcd0001')
      const pending = await withLock(movesLock, { purpose: 'test' }, () => report('Corrupt outcome report', 'cdcd0001', { movesWaitMs: 20 }))
      const before = await fs.readFile(path.join(folder(pending.id), 'issue.json'), 'utf8')
      const outcome = bundleFiles(issuesDir, P, pending.id).repeatLookup
      for (const [what, bytes] of [['truncated JSON', '{'], ['JSON of another shape', '"x"']]) {
        await fs.writeFile(outcome, bytes)
        const listed = await issues.listIssues(P).then((rows) => rows.find((i) => i.id === pending.id), (e) => e.message)
        t.ok(`${what}: the project list still reads, the issue still pending`, Boolean(listed?.repeatLookup?.listing), JSON.stringify(listed))
      }
      await fs.writeFile(outcome, '{')
      const read = await issues.getIssue(P, pending.id).catch((e) => e.message)
      t.eq('the issue reads, and the rerun completes it', [read.repeats?.id, read.repeatLookup], [earlier.id, null])
      t.eq('the file is whole again', JSON.parse(await fs.readFile(outcome, 'utf8')).repeats?.id, earlier.id)
      t.eq('issue.json untouched', await fs.readFile(path.join(folder(pending.id), 'issue.json'), 'utf8'), before)
      await fs.writeFile(outcome, '{')
      const throttled = await issues.getIssue(P, pending.id).catch((e) => e.message)
      t.ok('corrupted again within the minute: still reads, as pending', Boolean(throttled.repeatLookup?.listing), JSON.stringify(throttled))
      nextMinute()
      t.eq('and the next rerun repairs it', (await issues.getIssue(P, pending.id)).repeats?.id, earlier.id)
    }

    t.section('H. packed between the two reads of a folder: followed to the bundle, not read as no fingerprint')
    {
      // A report from before fingerprints were recorded: its record has none, so its text is read.
      const textOnly = async (id, name, fingerprint) => {
        await fs.mkdir(path.join(folder(id), '000-report'), { recursive: true })
        await fs.writeFile(path.join(folder(id), 'issue.json'), JSON.stringify({ name, project: P, report: origin, openedAt: '2026-01-06T10:00:00.000Z' }))
        await fs.writeFile(path.join(folder(id), '000-report', 'response.md'), `# ${name}\n\nFingerprint: ${fingerprint}\n`)
      }
      await textOnly('2026-01-06-text-only', 'Text only', 'hhhh0001')
      let moved = false
      const found = await report('Follows the text-only report', 'hhhh0001', { lookup: { betweenFolderReads: async (dir) => {
        if (moved || !dir.endsWith('2026-01-06-text-only')) return
        moved = true
        await archive('2026-01-06-text-only')
      } } })
      t.eq('it moved in between', [moved, await exists(folder('2026-01-06-text-only'))], [true, false])
      t.eq('and the match is still found', [found.repeats?.id, found.repeatLookup], ['2026-01-06-text-only', null])

      // The same two reads in the walk for an id: an id packed in between is archived now, not a live one to name.
      const today = issues.today()
      const walked = `${today}-walked-while-packing`
      await textOnly(walked, 'Walked while packing', 'hhhh0002')
      let packedInWalk = false
      const beside = await report('Walked while packing', 'hhhh0002', { lookup: { betweenFolderReads: async (dir) => {
        if (packedInWalk || !dir.endsWith(walked)) return
        packedInWalk = true
        await archive(walked)
      } } })
      t.eq('a new id, not a 409 naming an archived issue', [packedInWalk, beside.id, beside.sameTitleAs?.id, beside.repeats?.id], [true, `${walked}-2`, walked, walked])

      // Packed AND restored between the failed read and any look at the folder: it stands again, and proves nothing.
      await textOnly('2026-01-06-round-trip', 'Round trip', 'hhhh0004')
      let packedOnce = false
      let restoredOnce = false
      const roundTrip = await report('Follows the round trip', 'hhhh0004', { lookup: {
        betweenFolderReads: async (dir) => { if (!packedOnce && dir.endsWith('2026-01-06-round-trip')) { packedOnce = true; await archive('2026-01-06-round-trip') } },
        afterMissingRead: async (dir) => { if (!restoredOnce && dir.endsWith('2026-01-06-round-trip')) { restoredOnce = true; await issues.setIssueArchived(P, '2026-01-06-round-trip', false) } }
      } })
      t.eq('a round trip between the reads: it moved and came back', [packedOnce, restoredOnce, await exists(folder('2026-01-06-round-trip'))], [true, true, true])
      t.eq('and the match is still found', [roundTrip.repeats?.id, roundTrip.repeatLookup], ['2026-01-06-round-trip', null])

      // The same before the record is read: a folder gone when its issue.json is read, and back before anything looks.
      await textOnly('2026-01-06-record-trip', 'Record trip', 'hhhh0005')
      let recordRestored = false
      const recordTrip = await report('Follows the record trip', 'hhhh0005', { lookup: {
        afterSnapshot: () => archive('2026-01-06-record-trip'),
        afterMissingRead: async (dir) => { if (!recordRestored && dir.endsWith('2026-01-06-record-trip')) { recordRestored = true; await issues.setIssueArchived(P, '2026-01-06-record-trip', false) } }
      } })
      t.eq('a round trip before the record is read: found, not skipped', [recordRestored, recordTrip.repeats?.id, recordTrip.repeatLookup], [true, '2026-01-06-record-trip', null])

      // And in a bundle: its read fails because it has gone, and it is back before the listing.
      const trip = await oldBundle('2026-01-06-bundle-trip', '# Bundle trip\n\nFingerprint: hhhh0006\n')
      const held = { bundle: await fs.readFile(trip.bundle), summary: await fs.readFile(trip.summary), runs: await fs.readFile(trip.runs) }
      let hidden = false
      let back = false
      const bundleTrip = await report('Follows the bundle trip', 'hhhh0006', { lookup: {
        beforeBundleRead: async (file) => { if (!hidden && file === trip.bundle) { hidden = true; await fs.rm(trip.bundle) } },
        afterBundleMiss: async (file) => { if (!back && file === trip.bundle) { back = true; await fs.writeFile(trip.bundle, held.bundle) } }
      } })
      t.eq('a bundle that went and came back between its read and its listing: found', [hidden, back, bundleTrip.repeats?.id, bundleTrip.repeatLookup], [true, true, '2026-01-06-bundle-trip', null])

      // The lock held while a folder's absence would be concluded: that is pending, never "no fingerprint".
      await textOnly('2026-01-06-held-trip', 'Held trip', 'hhhh0007')
      const movesLock = path.join(issuesDir, '.archive', P, '.moves.lock')
      await fs.rm(path.join(folder('2026-01-06-held-trip'), '000-report', 'response.md'))
      let release
      const released = new Promise((resolve) => { release = resolve })
      let holding = null
      const heldLookup = await report('Waits on a held lock', 'hhhh0007', { movesWaitMs: 20, lookup: { afterMissingRead: async (dir) => {
        if (holding || !dir.endsWith('2026-01-06-held-trip')) return
        let ready
        const taken = new Promise((resolve) => { ready = resolve })
        holding = withLock(movesLock, { purpose: 'test' }, async () => { ready(); await released })
        await taken
      } } })
      release()
      await holding
      t.eq('absence that cannot be concluded is pending, and names the issue', [heldLookup.repeats, heldLookup.repeatLookup?.unread], [null, ['2026-01-06-held-trip']])

      // A bundle whose own listing shows no report is an answer, and not a pending one.
      const noReport = await fs.mkdtemp(path.join(root, 'no-report-'))
      await fs.mkdir(path.join(noReport, '2026-01-06-no-report-member'))
      await fs.writeFile(path.join(noReport, '2026-01-06-no-report-member', 'issue.json'), '{}')
      const noReportFiles = await oldBundle('2026-01-06-no-report-member', 'replaced below')
      await exec('tar', ['-C', noReport, '-czf', noReportFiles.bundle, '2026-01-06-no-report-member'])
      const noMember = await report('Finds no report member', 'hhhh0008')
      t.eq('a bundle with no report in its listing: nothing pending on it', [noMember.repeats, noMember.repeatLookup], [null, null])

      // A report file missing from a folder that stands is an answer, and not a pending one.
      await fs.mkdir(folder('2026-01-07-no-report-file'))
      await fs.writeFile(path.join(folder('2026-01-07-no-report-file'), 'issue.json'), JSON.stringify({ name: 'No report file', project: P, report: origin, openedAt: '2026-01-07T10:00:00.000Z' }))
      const none = await report('Finds no report file', 'hhhh0003')
      t.eq('no fingerprint there, and nothing pending on it', [none.repeats, none.repeatLookup], [null, null])
    }

    t.section('F. a resubmission does not wait behind another report\'s lookup')
    {
      const live = await report('Live and waiting', 'abab0001')
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const slow = report('A slow lookup', 'abab0002', { lookup: { afterSnapshot: () => gate } })
      const answer = await Promise.race([
        report('Live and waiting', 'abab0001').then(() => 'created', (e) => [e.status, e.existingId]),
        delay(5000).then(() => 'still waiting')
      ])
      t.eq('answered 409 at once, naming the issue', answer, [409, live.id])
      release()
      t.ok('and the slow one still opens', (await slow).id.endsWith('a-slow-lookup'))
    }
  } finally {
    lookupRetry.now = clockWas
    lookupRetry.seams = {}
    for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fs.rm(root, { recursive: true, force: true })
  }
}

export default async function (t) {
  await identity(t)

  t.section('1. who counts as the private network')
  t.eq('10/8, 172.16/12, 192.168/16', ['10.1.0.5', '172.16.1.1', '172.31.9.9', '192.168.1.2'].map(privateAddress), [true, true, true, true])
  t.eq('mapped IPv4 and IPv6 ULA', [privateAddress('::ffff:10.0.0.1'), privateAddress('fd12:3456::1')], [true, true])
  t.eq('public, loopback, 172.32', ['8.8.8.8', '127.0.0.1', '::1', '172.32.0.1'].map(privateAddress), [false, false, false, false])
  const own = new Set(['10.1.0.119'])
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers })
  t.eq('a sibling container may', refusal(req('::ffff:10.1.0.7'), own), null)
  t.eq('haproxy (X-Forwarded-For) may not', refusal(req('10.1.0.1', { 'x-forwarded-for': '1.2.3.4' }), own), 'came through the proxy')
  t.eq('the panel itself may not', refusal(req('10.1.0.119'), own), 'from the panel itself')
  t.eq('loopback may not', refusal(req('127.0.0.1'), own), 'not from the private network')

  t.section('2. input is report text, never a path')
  t.eq('a single .md line becomes a heading', reportText('/home/alice/notes.md'), '# /home/alice/notes.md\n')
  t.eq('multi-line text stays', reportText('# Title\nbody'), '# Title\nbody')
  t.eq('empty is nothing', reportText('  '), null)

  t.section('3. the endpoint')
  {
    const s = await serve({ createIssue: async () => { throw new Error('must not be called') }, emit: () => {} })
    try {
      const r = await s.post('app-project', { input: '# x\ny' })
      t.eq('the real check refuses loopback', r.status, 403)
    } finally { await s.close() }
  }
  {
    const created = []
    const events = []
    let clock = 0
    const s = await serve({
      createIssue: async (project, args) => { created.push({ project, ...args }); return { project, id: `issue-${created.length}`, report: 'secret body' } },
      emit: (e) => events.push(e),
      now: () => clock,
      refuse: () => null,
      identify: async (key) => (key === 'good' ? { name: 'app-prod', project: 'app-project' } : key === 'other' ? { name: 'flex-prod', project: 'other-project' } : null)
    })
    try {
      const r = await s.post('app-project', { input: 'Checkout page 500s', actor: 'root', name: 'override' })
      t.eq('201 with only project, id and trust', [r.status, r.body], [201, { project: 'app-project', id: 'issue-1', trust: 'anonymous' }])
      t.eq('created as report text, named by nobody but "report"', [created[0].input, created[0].openedBy.user, created[0].name], ['# Checkout page 500s\n', 'report', undefined])
      t.eq('without a key it is anonymous whatever it claims', created[0].reportOrigin, { kind: 'fault', category: null, reporter: null, trust: 'anonymous' })
      t.eq('other panels are told', events[0], { reason: 'issue-created', project: 'app-project', id: 'issue-1' })
      t.eq('missing input is 400', (await s.post('app-project', {})).status, 400)
      const keyed = await s.post('app-project', { input: '# Crash\nstack', kind: 'fault', category: 'crash' }, { 'X-Devpanel-Reporter-Key': 'good' })
      t.eq('a keyed fault report is trusted as fault', [keyed.body.trust, created.at(-1).reportOrigin, created.at(-1).openedBy.user], ['fault', { kind: 'fault', category: 'crash', reporter: 'app-prod', trust: 'fault' }, 'app-prod'])
      const asked = await s.post('app-project', { input: '# Add export\nplease', kind: 'request', category: 'feature' }, { 'X-Devpanel-Reporter-Key': 'good' })
      t.eq('a keyed person relay is trusted as request', asked.body.trust, 'request')
      t.eq('an unknown key is refused, not downgraded', (await s.post('app-project', { input: 'x' }, { 'X-Devpanel-Reporter-Key': 'bad' })).status, 403)
      t.eq("another project's reporter is refused", (await s.post('app-project', { input: 'x' }, { 'X-Devpanel-Reporter-Key': 'other' })).status, 403)
      t.eq('an unknown kind is 400', (await s.post('app-project', { input: 'x', kind: 'order' })).status, 400)
      for (let i = 1; i < 20; i++) await s.post('app-project', { input: `r${i}` })
      // the keyed reports above count against the reporter, not this address
      t.eq('the 21st report within 10 minutes is 429', (await s.post('app-project', { input: 'one more' })).status, 429)
      clock += 10 * 60 * 1000
      t.eq('after the window it is accepted again', (await s.post('app-project', { input: 'later' })).status, 201)
    } finally { await s.close() }
  }

  t.section('4. a duplicate report is answered with the existing id and logged at info')
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-duplicate-'))
    const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR, info: console.info, warn: console.warn }
    process.env.DEVPANEL_ISSUES_DIR = path.join(root, 'issues')
    process.env.DEVPANEL_PROJECTS_DIR = path.join(root, 'projects')
    await fs.mkdir(path.join(root, 'projects', 'app-project'), { recursive: true })
    await fs.mkdir(path.join(root, 'issues'))
    const { createIssue, IssueError } = await import(`../server/issues.js?report=${Date.now()}`)
    const logged = []
    console.info = (message) => logged.push(['info', message])
    console.warn = (message) => logged.push(['warn', message])
    const events = []
    // The app's error handler (index.js) warns about whatever reaches it.
    const toHandler = (err, req, res, _next) => { console.warn(`${req.method} ${req.path}: ${err.message}`); res.status(err.status ?? 500).json({ error: err.message }) }
    try {
      const s = await serve({ createIssue, emit: (e) => events.push(e), refuse: () => null }, toHandler)
      try {
        const first = await s.post('app-project', { input: '# Same fault\nfirst body' })
        t.eq('the first is created', [first.status, events.length, logged], [201, 1, []])
        const dir = path.join(root, 'issues', 'app-project', first.body.id)
        const before = await fs.readFile(path.join(dir, '000-report', 'response.md'), 'utf8')
        const again = await s.post('app-project', { input: '# Same fault\nsecond body' })
        t.eq('409 with the same error, the existing id beside it', [again.status, again.body], [409, { error: '"same-fault" was already opened against this project today', project: 'app-project', id: first.body.id }])
        t.eq('no new issue and the existing one unchanged', [await fs.readdir(path.join(root, 'issues', 'app-project')), await fs.readFile(path.join(dir, '000-report', 'response.md'), 'utf8')], [[first.body.id], before])
        t.eq('no second issue-created event', events.length, 1)
        t.eq('logged once, at info, not at warn', logged, [['info', 'POST /api/report/app-project: "same-fault" was already opened against this project today']])
      } finally { await s.close() }
      logged.length = 0
      const failing = (error) => serve({ createIssue: async () => { throw error }, emit: (e) => events.push(e), refuse: () => null }, toHandler)
      for (const [what, error, status] of [
        ['another 409 of createIssue', new IssueError('the proposal is already issue x', 409), 409],
        ['a 404', new IssueError('no such project', 404), 404],
        ['an unexpected error', new Error('disk full'), 500]
      ]) {
        const f = await failing(error)
        try {
          const r = await f.post('app-project', { input: '# Other\nbody' })
          t.eq(`${what} reaches the error handler, warned, without an id`, [r.status, r.body, logged.pop()], [status, { error: error.message }, ['warn', `POST /api/report/app-project: ${error.message}`]])
        } finally { await f.close() }
      }
      t.eq('none of them was logged at info', logged, [])
    } finally {
      console.info = saved.info
      console.warn = saved.warn
      for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      await fs.rm(root, { recursive: true, force: true })
    }
  }

  t.section('5. over the route: an archived id and a fingerprint')
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-route-'))
    const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR, info: console.info }
    process.env.DEVPANEL_ISSUES_DIR = path.join(root, 'issues')
    process.env.DEVPANEL_PROJECTS_DIR = path.join(root, 'projects')
    await fs.mkdir(path.join(root, 'projects', 'app-project'), { recursive: true })
    await fs.mkdir(path.join(root, 'issues'))
    const { createIssue, getIssue, setIssueArchived } = await import(`../server/issues.js?route=${Date.now()}`)
    const logged = []
    console.info = (message) => logged.push(message)
    try {
      const s = await serve({ createIssue, emit: () => {}, refuse: () => null })
      try {
        const first = await s.post('app-project', { input: '# Route fault\n\nFingerprint: 11112222\n' })
        await setIssueArchived('app-project', first.body.id, true, { overrideReason: 'fixture' })
        const second = await s.post('app-project', { input: '# Route fault\n\nFingerprint: 11112222\n' })
        t.eq('201 and a new id, and the answer is still only that', [second.status, second.body], [201, { project: 'app-project', id: `${first.body.id}-2`, trust: 'anonymous' }])
        t.eq('the repeat is on the record', (await getIssue('app-project', second.body.id)).repeats?.id, first.body.id)
        const again = await s.post('app-project', { input: '# Route fault\n\nFingerprint: 11112222\n' })
        t.eq('a resubmission names the live issue', [again.status, again.body.id], [409, second.body.id])
        const given = await s.post('app-project', { input: '# Given\n\nbody\n', fingerprint: 'given-0001' })
        t.eq('the field is a fingerprint too', (await getIssue('app-project', given.body.id)).report?.fingerprint, 'given-0001')
        t.eq('a bad field is 400', (await s.post('app-project', { input: '# Bad\n\nbody\n', fingerprint: 'no spaces allowed' })).status, 400)
        t.eq('so is a field that says it has none', (await s.post('app-project', { input: '# Bad\n\nbody\n', fingerprint: 'unknown' })).status, 400)
        logged.length = 0
        await s.post('app-project', { input: '# Odd\n\nThe fingerprint is written some other way\n' })
        t.ok('a fingerprint mentioned but not read is logged', logged.some((m) => m.includes('none could be read')), logged.join(' | '))
      } finally { await s.close() }
    } finally {
      console.info = saved.info
      for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}
