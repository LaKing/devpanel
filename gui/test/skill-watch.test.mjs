import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import { listen } from './helpers.mjs'

export const name = 'the skill\'s watch --until-settled — the real CLI waits while a run cannot be called settled'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/devpanel/devpanel.mjs')
const PROJECT = 'devpanel-project'
const OLDER = '2026-11-01T10-00-00-000Z-aaaa0000'
const NEWER = '2026-11-02T10-00-00-000Z-bbbb1111'
const RECHECK_MS = 40
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const startedAt = (runId) => `${runId.slice(0, 10)}T10:00:00.000Z`
const base = (runId) => ({ runId, startedAt: startedAt(runId), playbook: { id: 'implementation' }, steps: [], participants: {}, workspace: { path: '/nowhere', state: 'retained' } })
const completed = (runId) => ({ ...base(runId), status: 'completed', outcome: 'resolved', blockedReason: null, endedAt: startedAt(runId) })
const blocked = (runId, extra = {}) => ({ ...base(runId), status: 'blocked', outcome: 'unresolved', blockedReason: 'source-delivery-blocked',
  delivery: { action: 'apply-to-source', application: { state: 'source-drift', drifted: ['changelog.txt'] } }, ...extra })
const pending = (runId) => blocked(runId, { autoReconcile: { state: 'pending', at: startedAt(runId), owner: 'the server' } })
const notRun = (runId) => blocked(runId, { autoReconcile: { state: 'not-run', reason: 'the project was busy', at: startedAt(runId) } })

export default async function (t) {
  const issuesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-watch-'))
  const previous = process.env.DEVPANEL_ISSUES_DIR
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  const issues = await import(`../server/issues.js?skill-watch=${Date.now()}`)

  // The two routes the watch reads, from the real issue code over real run records; the events are the test's.
  // `failReads` answers that many readings of an issue with a 503; `failing` answers all of them so.
  const api = { failReads: 0, failed: 0, failing: false }
  const server = http.createServer(async (req, res) => {
    try {
      const m = /^\/api\/projects\/([^/]+)\/issues(?:\/([^/?]+))?/.exec(req.url)
      if (!m) throw Object.assign(new Error('no such route'), { status: 404 })
      if (m[2] && (api.failing || api.failReads > 0)) {
        if (api.failReads > 0) api.failReads--
        api.failed++
        throw Object.assign(new Error('the panel is unwell'), { status: 503 })
      }
      const project = decodeURIComponent(m[1])
      const body = m[2] ? await issues.getIssue(project, decodeURIComponent(m[2])) : await issues.listIssues(project)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    } catch (error) {
      res.writeHead(error.status ?? 500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
  })
  const io = new Server(server)
  await listen(server, 0, '127.0.0.1')
  const url = `http://127.0.0.1:${server.address().port}`
  const watches = []

  const until = async (test, label) => {
    const end = Date.now() + 30000
    while (!(await test())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
      await sleep(20)
    }
  }
  const newIssue = async (issueName, runs) => {
    const { id } = await issues.createIssue(PROJECT, { name: issueName })
    const dir = path.join(issuesDir, PROJECT, id)
    const write = async (runId, value) => {
      await fs.mkdir(path.join(dir, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(dir, 'runs', runId, 'run.json'), typeof value === 'string' ? value : JSON.stringify(value))
    }
    for (const [runId, value] of Object.entries(runs)) await write(runId, value)
    return { id, dir, write }
  }
  const watch = (id) => {
    const child = spawn(process.execPath, [CLI, 'watch', id, '--until-settled', '-p', PROJECT], {
      env: { ...process.env, DEVPANEL_URL: url, DEVPANEL_TOKEN: 'test', DEVPANEL_WATCH_RECHECK_MS: String(RECHECK_MS) }, stdio: ['ignore', 'pipe', 'pipe'] })
    const w = { child, id, out: '', code: undefined }
    child.stdout.on('data', (d) => { w.out += d })
    child.stderr.on('data', (d) => { w.out += d })
    child.on('exit', (code) => { w.code = code })
    w.settled = () => /^settled /m.test(w.out)
    w.connected = () => until(() => /watching /.test(w.out), `the watch to connect: ${w.out}`)
    w.done = () => until(() => w.code !== undefined, `the watch to exit: ${w.out}`)
    watches.push(w)
    return w
  }
  const emit = (issue, runId, ...types) => { for (const type of types) io.emit('run:event', { type, project: PROJECT, issueId: issue.id, runId }) }
  const waiting = (w) => !w.settled() && w.code === undefined

  try {
    t.section('a run that is settled: reported at once, as before')
    {
      const issue = await newIssue('Settled', { [NEWER]: completed(NEWER) })
      const w = watch(issue.id)
      await w.done()
      t.ok('prints its end state', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('and exits 0', w.code, 0)
    }
    {
      const issue = await newIssue('Blocked, nothing coming', { [NEWER]: blocked(NEWER) })
      const w = watch(issue.id)
      await w.done()
      t.ok('a block with no reconcile coming is settled', w.out.includes(`settled ${NEWER} blocked`), w.out)
      t.eq('and exits 0', w.code, 0)
    }

    t.section('started while the reconcile is undecided: waits, also through the end events, then reports the decision')
    {
      const issue = await newIssue('Refused or never ran', { [NEWER]: pending(NEWER) })
      const w = watch(issue.id)
      await w.connected()
      await sleep(RECHECK_MS * 3)
      t.ok('started in that state it does not settle or exit', waiting(w), w.out)
      emit(issue, NEWER, 'finished', 'run-finished')
      await sleep(200)
      t.ok('seeing the end events does not settle it', waiting(w), w.out)
      await issue.write(NEWER, notRun(NEWER))
      emit(issue, NEWER, 'run-finished')
      await w.done()
      t.ok('once decided it reports the actual end state', w.out.includes(`settled ${NEWER} blocked`), w.out)
      t.eq('and exits 0', w.code, 0)
    }
    {
      const issue = await newIssue('Accepted', { [NEWER]: pending(NEWER) })
      const w = watch(issue.id)
      await w.connected()
      // The live order of the reported run: the engine's end, a gap, then the attempt.
      emit(issue, NEWER, 'finished')
      await sleep(200)
      emit(issue, NEWER, 'run-reconciling', 'reconcile-started')
      await sleep(100)
      t.ok('through the gap before reconcile-started and past it, it waits', waiting(w), w.out)
      await issue.write(NEWER, completed(NEWER))
      emit(issue, NEWER, 'reconciled', 'finished', 'run-finished')
      await w.done()
      t.ok('an accepted reconcile reports completed', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('once', w.out.match(/^settled /gm).length, 1)
      t.eq('and exits 0', w.code, 0)
    }

    t.section('a decision while disconnected is caught on reconnect')
    {
      const issue = await newIssue('Reconnect', { [NEWER]: pending(NEWER) })
      const w = watch(issue.id)
      await w.connected()
      await issue.write(NEWER, completed(NEWER))
      // No event: the transport drops, as a restarting panel's would, and the client reconnects by itself.
      for (const socket of io.sockets.sockets.values()) socket.conn.close()
      await w.done()
      t.ok('reports the decision', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('and exits 0', w.code, 0)
    }

    t.section('a reading that fails is not an answer, and is asked again')
    {
      const issue = await newIssue('One failed read on the final event', { [NEWER]: pending(NEWER) })
      const w = watch(issue.id)
      await w.connected()
      await issue.write(NEWER, completed(NEWER))
      api.failReads = 1
      api.failed = 0
      // The only event there will be, and its reading fails.
      emit(issue, NEWER, 'run-finished')
      await w.done()
      t.eq('the final event\'s reading failed', api.failed, 1)
      t.ok('the actual end state is still reported', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('and it exits 0', w.code, 0)
    }
    {
      const issue = await newIssue('Failing at the start', { [NEWER]: completed(NEWER) })
      api.failing = true
      api.failed = 0
      const w = watch(issue.id)
      await w.connected()
      await until(() => api.failed >= 3, 'readings to fail on the start, connect and timer paths')
      t.ok('failing at the start: no settled line and no exit, though the record is settled', waiting(w), w.out)
      api.failing = false
      await w.done()
      t.ok('recovered: it reports the end state', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('and exits 0', w.code, 0)
    }
    {
      const issue = await newIssue('Failing on reconnect', { [NEWER]: pending(NEWER) })
      const w = watch(issue.id)
      await w.connected()
      await issue.write(NEWER, completed(NEWER))
      api.failing = true
      api.failed = 0
      for (const socket of io.sockets.sockets.values()) socket.conn.close()
      await until(() => (w.out.match(/watching /g) ?? []).length === 2, `the watch to reconnect: ${w.out}`)
      await until(() => api.failed >= 1, 'the reconnect reading to fail')
      t.ok('failing on reconnect: no settled line and no exit', waiting(w), w.out)
      api.failing = false
      await w.done()
      t.ok('recovered: it reports the end state', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('and exits 0', w.code, 0)
    }

    t.section('the newest run cannot be read: an older run says nothing about it')
    {
      const issue = await newIssue('Unreadable pending', { [OLDER]: completed(OLDER), [NEWER]: '{ not json' })
      const read = await issues.getIssue(PROJECT, issue.id)
      t.eq('the issue names the unreadable newer run', read.unreadableNewerRuns, [NEWER])
      t.eq('latestRun stays the latest readable one', read.latestRun?.runId, OLDER)
      const w = watch(issue.id)
      await until(() => w.out.includes(`cannot read run ${NEWER}`), `the unreadable run to be named: ${w.out}`)
      await w.connected()
      await sleep(RECHECK_MS * 4)
      t.ok('started in that state it does not settle or exit', waiting(w), w.out)
      emit(issue, NEWER, 'finished', 'run-finished')
      await sleep(200)
      t.ok('nor on the end events', waiting(w), w.out)
      t.eq('and names it once', w.out.match(/cannot read run/g).length, 1)
      await issue.write(NEWER, pending(NEWER))
      await sleep(RECHECK_MS * 4)
      t.ok('it reads again, still undecided: it waits', waiting(w), w.out)
      await issue.write(NEWER, completed(NEWER))
      emit(issue, NEWER, 'run-finished')
      await w.done()
      t.ok('decided: it reports the newer run', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.ok('never the older one', !w.out.includes(`settled ${OLDER}`), w.out)
      t.eq('and exits 0', w.code, 0)
    }
    {
      const issue = await newIssue('Heals with no event', { [OLDER]: completed(OLDER), [NEWER]: '{ not json' })
      const w = watch(issue.id)
      await until(() => w.out.includes(`cannot read run ${NEWER}`), `the unreadable run to be named: ${w.out}`)
      await w.connected()
      await issue.write(NEWER, completed(NEWER))
      await w.done()
      t.ok('a record that reads again with no event is still reported', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('and exits 0', w.code, 0)
    }

    t.section('what must not hold a watcher')
    {
      const issue = await newIssue('Old damage', { [OLDER]: '{ not json', [NEWER]: completed(NEWER) })
      t.eq('an unreadable older run is not listed', (await issues.getIssue(PROJECT, issue.id)).unreadableNewerRuns, [])
      const w = watch(issue.id)
      await w.done()
      t.ok('and does not hold the watch', w.out.includes(`settled ${NEWER} completed`), w.out)
      t.eq('which exits 0', w.code, 0)
    }
    {
      const issue = await newIssue('Not a run', { [OLDER]: completed(OLDER) })
      await fs.mkdir(path.join(issue.dir, 'runs', NEWER), { recursive: true })
      t.eq('a directory with no record is not listed', (await issues.getIssue(PROJECT, issue.id)).unreadableNewerRuns, [])
      const w = watch(issue.id)
      await w.done()
      t.ok('and the latest record is reported as before', w.out.includes(`settled ${OLDER} completed`), w.out)
      t.eq('which exits 0', w.code, 0)
    }
  } finally {
    for (const w of watches) if (w.code === undefined) w.child.kill('SIGKILL')
    await new Promise((resolve) => io.close(() => resolve()))
    if (previous === undefined) delete process.env.DEVPANEL_ISSUES_DIR
    else process.env.DEVPANEL_ISSUES_DIR = previous
    await fs.rm(issuesDir, { recursive: true, force: true })
  }
}
