import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'npm run supervisor-calls — calls per started run for a stated period, read-only'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUI = path.resolve(HERE, '..')
const TOOL = path.join(GUI, 'tools', 'supervisor-calls.mjs')
const HOOK = pathToFileURL(path.join(HERE, 'fakes', 'record-imports.mjs')).href
const exec = promisify(execFile)

const reserve = (id, subject, at, meta = {}) => ({ kind: 'reserve', id, subject, at, reservedUsdMicros: 0, unpriced: true, meta })
const settle = (id, at, meta = {}) => ({ kind: 'settle', id, at, costUsdMicros: null, costKnown: false, overageUsdMicros: 0, meta })
const release = (id, at) => ({ kind: 'release', id, at, reason: 'it did not happen' })
const lines = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-calls-'))
  const outputs = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-calls-out-'))
  const projects = path.join(root, 'projects'), issuesDir = path.join(root, 'issues'), supervisorDir = path.join(root, 'supervisor')
  const project = 'alpha-project'
  await fs.mkdir(path.join(projects, project), { recursive: true })
  await fs.mkdir(issuesDir)
  await fs.mkdir(supervisorDir)
  await exec('git', ['init', '-q', path.join(projects, project)])
  const ledger = path.join(supervisorDir, 'ledger.jsonl')

  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  process.env.DEVPANEL_PROJECTS_DIR = projects
  try {
    const issues = await import(`../server/issues.js?supervisor-calls=${Date.now()}`)
    const fixture = async (title, { launchId, status, disposition = null }) => {
      const opened = await issues.createIssue(project, { name: title })
      const dir = path.join(issuesDir, project, opened.id)
      if (disposition) {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'issue.json'), 'utf8'))
        await fs.writeFile(path.join(dir, 'issue.json'), JSON.stringify({ ...meta, disposition: { value: disposition, evidence: 'fixture', at: '2026-10-27T00:00:00.000Z' } }))
      }
      const runId = `run-${launchId}`
      await fs.mkdir(path.join(dir, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(dir, 'runs', runId, 'run.json'), JSON.stringify({ runId, supervisorLaunchId: launchId, status, outcome: null, playbook: { id: 'x', version: 1 }, participants: {}, startedAt: '2026-10-27T00:00:00.000Z', steps: [], budgets: { used: {} } }))
      return opened.id
    }
    const liveIssue = await fixture('Still live', { launchId: 'start-live', status: 'running' })
    const packedIssue = await fixture('Packed', { launchId: 'start-packed', status: 'completed', disposition: 'resolved' })
    await issues.setIssueArchived(project, packedIssue, true)
    const uncertainIssue = (await issues.createIssue(project, { name: 'No run came of it' })).id

    const metaOf = (issueId) => ({ project, issueId, playbook: 'x' })
    const inside = '2026-10-28T12:00:00.000Z'
    await fs.writeFile(ledger, lines([
      { kind: 'wake', id: 'w0', at: '2026-10-20T00:00:00.000Z', reason: 'user' },
      reserve('before', 'model-call', '2026-10-20T00:00:00.000Z', { wake: 'w0' }), settle('before', '2026-10-20T00:00:01.000Z'),
      { kind: 'wake', id: 'w1', at: inside, reason: 'user' },
      reserve('c-first-instant', 'model-call', '2026-10-26T00:00:00.000Z', { wake: 'w1' }), settle('c-first-instant', inside),
      reserve('c-last-instant', 'model-call', '2026-11-01T23:59:59.999Z', { wake: 'w1' }),
      reserve('c-settled', 'model-call', inside, { wake: 'w1' }), settle('c-settled', inside),
      reserve('c-outstanding', 'model-call', inside, { wake: 'w1' }),
      reserve('c-never', 'model-call', inside, { wake: 'w1' }), release('c-never', inside),
      reserve('c-side', 'model-call', inside, { side: true }), settle('c-side', inside),
      // What Stop before the adapter leaves: released now, settled at a known 0 by older code.
      reserve('c-stopped', 'model-call', inside, { wake: 'w1' }), release('c-stopped', inside),
      reserve('c-zero', 'model-call', inside, { wake: 'w1' }), { ...settle('c-zero', inside), costUsdMicros: 0, costKnown: true },
      reserve('d-1', 'decision', inside), settle('d-1', inside),
      reserve('c-after', 'model-call', '2026-11-02T00:00:00.000Z', { wake: 'w2' }),
      reserve('start-ended', 'run-start', inside, metaOf('gone-issue')), settle('start-ended', inside, { runId: 'r', status: 'completed' }),
      reserve('start-live', 'run-start', inside, metaOf(liveIssue)),
      reserve('start-packed', 'run-start', inside, metaOf(packedIssue)),
      reserve('start-refused', 'run-start', inside, metaOf(liveIssue)), release('start-refused', inside),
      reserve('start-uncertain', 'run-start', inside, metaOf(uncertainIssue)),
      reserve('start-after', 'run-start', '2026-11-02T00:00:00.000Z', metaOf(liveIssue)), settle('start-after', '2026-11-02T00:00:00.000Z', { runId: 's' })
    ]))

    const bin = path.join(root, 'bin'), marker = path.join(root, 'spawned'), importLog = path.join(root, 'imports.log')
    await fs.mkdir(bin)
    for (const cli of ['claude', 'codex', 'gemini']) await fs.writeFile(path.join(bin, cli), `#!/bin/sh\necho ${cli} >> '${marker}'\n`, { mode: 0o755 })
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, DEVPANEL_PROJECTS_DIR: projects, DEVPANEL_ISSUES_DIR: issuesDir, DEVPANEL_SUPERVISOR_DIR: supervisorDir, DEVPANEL_IMPORT_LOG: importLog, DEVPANEL_HOST_CONFIG_DIR: process.env.DEVPANEL_HOST_CONFIG_DIR }
    // The child's output goes to real files, outside the fixture. Node discards stdio it cannot classify, and a
    // sandbox that denies socket calls makes the socketpair execFile would give it one of those: empty output, exit 0.
    const run = async (...args) => {
      const [outFile, errFile] = [path.join(outputs, 'out'), path.join(outputs, 'err')]
      const [out, err] = await Promise.all([fs.open(outFile, 'w'), fs.open(errFile, 'w')])
      const code = await new Promise((resolve, reject) => {
        spawn(process.execPath, ['--import', HOOK, TOOL, ...args], { cwd: GUI, env, stdio: ['ignore', out.fd, err.fd] }).on('error', reject).on('close', resolve)
      }).finally(() => Promise.all([out.close(), err.close()]))
      return { code, stdout: await fs.readFile(outFile, 'utf8'), stderr: await fs.readFile(errFile, 'utf8') }
    }
    const read = async (...args) => JSON.parse((await run(...args)).stdout)
    const failing = (...args) => run(...args)
    const week = ['--from', '2026-10-26', '--to', '2026-11-01']

    const before = await listing(root)
    const out = await read(...week)
    const after = await listing(root)

    t.section('the figure, computed from what the panel records')
    t.eq('the period is stated', [out.period.from, out.period.to, out.period.timezone], ['2026-10-26', '2026-11-01', 'UTC'])
    t.eq('the supervisor\'s calls: both edge instants in, the days around out; released, side and at-zero calls apart', out.calls, { supervisor: 4, sideQuestions: 1, notStarted: 2, settledAtZero: 1, decisions: 1 })
    t.ok('and it says what at-zero cannot tell apart', /settledAtZero[^.]*cannot say which/.test(out.callsPerStartedRun.means), out.callsPerStartedRun.means)
    t.eq('wakes in the period', out.wakes, 1)
    t.eq('a non-start and an uncertain attempt are not started runs; ended, live and packed ones are', out.starts, { reserved: 5, started: 3, neverStarted: 1, uncertain: 1 })
    t.eq('calls per started run', [out.callsPerStartedRun.of, out.callsPerStartedRun.total, out.callsPerStartedRun.perRun], [4, 3, 1.33])
    t.eq('the ledger spans it', [out.ledger.coverage, out.ledger.firstAt, out.ledger.tornTail], ['complete', '2026-10-20T00:00:00.000Z', undefined])

    t.section('it writes nothing and reaches no runtime')
    t.eq('every path, size and mtime is unchanged (imports.log aside)', after.filter((l) => !l.startsWith('imports.log ')), before.filter((l) => !l.startsWith('imports.log ')))
    t.eq('no CLI was run', await fs.access(marker).then(() => true, () => false), false)
    const imports = (await fs.readFile(importLog, 'utf8')).split('\n').filter(Boolean)
    t.ok('the import record works', imports.some((u) => u.endsWith('/server/runtime/ledger.mjs')))
    const forbidden = /\/harness\/|\/server\/(supervisor|top-supervisor|top-supervisor-service|runs-api)\.mjs$|\/server\/runtime\/(launch|engine|process|command|checks)\.mjs$|\/server\/decisions\//
    t.eq('no adapter, engine, launch or supervisor module was loaded', imports.filter((u) => forbidden.test(u)), [])

    t.section('what it cannot vouch for, it says')
    t.eq('a period before the ledger begins is partial', (await read('--from', '2026-01-01', '--to', '2026-01-02')).ledger.coverage, 'partial')
    t.eq('with nothing started, the figure is unknown, not zero', (await read('--from', '2026-10-21', '--to', '2026-10-21')).callsPerStartedRun.perRun, null)
    t.eq('a period not over yet is partial', (await read('--from', '2026-10-26', '--to', '2999-01-01')).ledger.coverage, 'partial')

    t.section('a torn tail is read past, and left alone; a damaged line is refused')
    const whole = await fs.readFile(ledger, 'utf8')
    await fs.writeFile(ledger, `${whole}{"kind":"reserve","id":"tor`)
    const torn = await read(...week)
    t.eq('the tail is said, the figure the same', [torn.ledger.tornTail, torn.callsPerStartedRun.perRun], [true, 1.33])
    t.eq('and the file keeps it', await fs.readFile(ledger, 'utf8'), `${whole}{"kind":"reserve","id":"tor`)
    await fs.writeFile(ledger, `${whole}not json\n${lines([reserve('later', 'model-call', inside)])}`)
    const damaged = await failing(...week)
    t.eq('damage exits non-zero', damaged?.code, 1)
    t.ok('naming the line', /line \d+ is not a ledger entry/.test(damaged?.stderr ?? ''), damaged?.stderr)
    await fs.rm(ledger)
    const missing = await read(...week)
    t.eq('no ledger is an answer', [missing.ledger.coverage, missing.callsPerStartedRun.perRun, missing.ledger.entries], ['none', null, 0])

    t.section('arguments are parsed strictly')
    for (const args of [[], ['--from', '2026-10-26'], ['--to', '2026-10-26'], ['--from', 'soon', '--to', '2026-10-26'], ['--from', '2026-02-31', '--to', '2026-03-01'], ['--from', '2026-10-27', '--to', '2026-10-26'], [...week, '--project', 'x']]) {
      t.eq(`refused: ${args.join(' ') || '(nothing)'}`, (await failing(...args))?.code, 2)
    }
  } finally {
    if (saved.issues === undefined) delete process.env.DEVPANEL_ISSUES_DIR; else process.env.DEVPANEL_ISSUES_DIR = saved.issues
    if (saved.projects === undefined) delete process.env.DEVPANEL_PROJECTS_DIR; else process.env.DEVPANEL_PROJECTS_DIR = saved.projects
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outputs, { recursive: true, force: true })
  }
}
