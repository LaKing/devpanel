import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'npm run overview — the run outcome metrics, read-only, archived history included'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUI = path.resolve(HERE, '..')
const TOOL = path.join(GUI, 'tools', 'overview.mjs')
const HOOK = pathToFileURL(path.join(HERE, 'fakes', 'record-imports.mjs')).href
const exec = promisify(execFile)
const exists = (p) => fs.access(p).then(() => true, () => false)

const NOW = Date.now()
const at = (days) => new Date(NOW - days * 86_400_000).toISOString()
const run = (runId, o) => ({
  runId, status: o.status, outcome: o.outcome ?? null,
  playbook: { id: 'implementation', version: 2, intent: null, configHash: 'sha256:aaaaaaaaaaaabbbb' },
  participants: { implementer: { model: 'fixture-model' } },
  startedAt: at(2), endedAt: ['running', 'paused'].includes(o.status) ? null : at(2),
  steps: [], budgets: { used: {} }, ...o.extra
})

/** Every entry under `dir`: path, kind, size and mtime, so a created, removed or touched file shows. */
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-overview-cli-'))
  const projects = path.join(root, 'projects')
  const issuesDir = path.join(root, 'issues')
  const project = 'alpha-project'
  const repo = path.join(projects, project)
  await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(path.join(projects, 'empty-project'))
  await fs.mkdir(issuesDir)
  await exec('git', ['init', '-q', repo])

  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  process.env.DEVPANEL_PROJECTS_DIR = projects
  try {
    // The fixture is built with the issue store itself, so the archived issue is
    // packed the way archiving packs one.
    const issues = await import(`../server/issues.js?overview-cli=${Date.now()}`)
    const fixture = async (title, disposition, runs) => {
      const opened = await issues.createIssue(project, { name: title })
      const dir = path.join(issuesDir, project, opened.id)
      if (disposition) {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'issue.json'), 'utf8'))
        await fs.writeFile(path.join(dir, 'issue.json'), JSON.stringify({ ...meta, disposition: { value: disposition, evidence: 'fixture', at: at(1) } }))
      }
      for (const r of runs) {
        await fs.mkdir(path.join(dir, 'runs', r.runId), { recursive: true })
        await fs.writeFile(path.join(dir, 'runs', r.runId, 'run.json'), JSON.stringify(r))
      }
      return opened.id
    }
    await fixture('Delivered by the engine', 'resolved', [run('r1', { status: 'completed', outcome: 'resolved',
      extra: { revisions: [{ fingerprint: 'sha256:1' }], delivery: { action: 'worktree-diff', completedAt: at(2) } } })])
    await fixture('Completed but unresolved', 'not-resolved', [
      run('r2', { status: 'completed', outcome: 'unresolved' }),
      run('r3', { status: 'failed', outcome: 'unresolved' })])
    await fixture('Still in flight', null, [run('r4', { status: 'running' }), run('r5', { status: 'paused' })])
    const packedId = await fixture('Put away', 'resolved', [run('r6', { status: 'completed', outcome: 'resolved',
      extra: { landed: { by: 'operator', landedAt: at(2), recordedAt: at(2), commit: 'abc1234', revision: null } } })])
    await issues.setIssueArchived(project, packedId, true)

    const bin = path.join(root, 'bin')
    const marker = path.join(root, 'spawned')
    await fs.mkdir(bin)
    for (const cli of ['claude', 'codex', 'gemini']) {
      await fs.writeFile(path.join(bin, cli), `#!/bin/sh\necho ${cli} >> '${marker}'\n`, { mode: 0o755 })
    }
    const importLog = path.join(root, 'imports.log')
    const cli = async (...args) => {
      await fs.rm(importLog, { force: true })
      const { stdout } = await exec(process.execPath, ['--import', HOOK, TOOL, ...args], {
        cwd: GUI,
        env: {
          PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME,
          DEVPANEL_PROJECTS_DIR: projects, DEVPANEL_ISSUES_DIR: issuesDir, DEVPANEL_IMPORT_LOG: importLog,
          DEVPANEL_HOST_CONFIG_DIR: process.env.DEVPANEL_HOST_CONFIG_DIR,
          DEVPANEL_CLAUDE_BIN: path.join(bin, 'claude'), DEVPANEL_CODEX_BIN: path.join(bin, 'codex')
        },
        maxBuffer: 16 << 20
      })
      return { out: JSON.parse(stdout), imports: (await fs.readFile(importLog, 'utf8')).split('\n').filter(Boolean) }
    }

    const before = await listing(root)
    const all = await cli()
    const empty = await cli('--project', 'empty-project')
    const after = await listing(root)

    t.section('1. it writes nothing: projects root, issues and the archive are as they were')
    t.ok('the fixture holds a packed bundle under the archive', await exists(path.join(issuesDir, '.archive', project, `${packedId}.tar.gz`)))
    t.ok('and the folder it was packed from is gone', !await exists(path.join(issuesDir, project, packedId)))
    t.eq('every path, size and mtime under the fixture is unchanged (imports.log aside)',
      after.filter((l) => !l.startsWith('imports.log ')), before.filter((l) => !l.startsWith('imports.log ')))

    t.section('2. it starts no agent, model or runtime session')
    t.eq('no CLI on PATH or named by DEVPANEL_*_BIN was run', await exists(marker), false)
    t.ok('the import record works (it saw the overview module)', all.imports.some((u) => u.endsWith('/server/supervisor-overview.mjs')))
    const forbidden = /\/harness\/|\/server\/(supervisor|top-supervisor|top-supervisor-service|runs-api)\.mjs$|\/server\/runtime\/(launch|engine|process|command|checks|ledger)\.mjs$|\/server\/decisions\//
    t.eq('no adapter, engine, launch, ledger or supervisor module was loaded', all.imports.filter((u) => forbidden.test(u)), [])

    t.section('3. it reads archived histories from the packed bundle')
    t.eq('the archived issue is counted', all.out.totals.archivedIssues, 1)
    const line = all.out.projects.find((p) => p.project === project)
    t.eq('its manual landing is in the delivery counts', line.runs.delivered, { engine: 1, manual: 1 })

    t.section('4. completed-resolved, completed-unresolved, live and paused, deliveries, dispositions')
    const runs = all.out.totals.runs
    t.eq('every run is counted', runs.total, 6)
    t.eq('live and paused are kept out of the terminal runs', [runs.live, runs.paused, runs.terminal], [1, 1, 4])
    t.eq('completed AND resolved is a success; completed and unresolved is not', [runs.succeeded, runs.completedUnresolved, runs.failed], [2, 1, 1])
    t.eq('success over terminal runs', [runs.successRate.of, runs.successRate.total, runs.successRate.percent], [2, 4, 50])
    t.eq('delivery over terminal runs, engine and manual apart', [runs.deliveryRate.of, runs.deliveryRate.total, runs.deliveryRate.engine, runs.deliveryRate.manual], [2, 4, 1, 1])
    t.eq('dispositions, undecided named as such', Object.entries(all.out.issues.dispositions).sort(), [['not-resolved', 1], ['resolved', 2], ['undecided', 1]])
    t.eq('resolution over decided issues', [all.out.issues.resolutionRate.of, all.out.issues.resolutionRate.total], [2, 3])

    t.section('5. generatedAt, the scope, and every rate with of, total and its definition')
    t.ok('generatedAt is a timestamp', Number.isFinite(Date.parse(all.out.generatedAt)), all.out.generatedAt)
    t.eq('the scope names every project read, and where from', [all.out.scope.projects, all.out.scope.selected, all.out.scope.projectsRoot, all.out.scope.issuesDir, all.out.scope.archived],
      [['alpha-project', 'empty-project'], 'all', projects, issuesDir, 'included'])
    t.eq('a named project narrows it', [empty.out.scope.projects, empty.out.scope.selected], [['empty-project'], 'named'])
    for (const [label, r] of [['success', runs.successRate], ['delivery', runs.deliveryRate], ['resolution', all.out.issues.resolutionRate]]) {
      t.ok(`${label} carries of, total and means`, Number.isInteger(r.of) && Number.isInteger(r.total) && typeof r.means === 'string' && r.means.length > 0, `${r.of}/${r.total}: ${r.means}`)
    }

    t.section('6. an empty population is no data, never 0%')
    t.eq('no terminal runs: success percent is null', [empty.out.totals.runs.successRate.total, empty.out.totals.runs.successRate.percent], [0, null])
    t.eq('delivery likewise', empty.out.totals.runs.deliveryRate.percent, null)
    t.eq('no decided issues: resolution percent is null', empty.out.issues.resolutionRate.percent, null)

    t.section('7. an unknown project is refused, not read as empty')
    let refused = null
    try { await cli('--project', 'nowhere-project') } catch (error) { refused = error.code }
    t.eq('exit 2', refused, 2)

    t.section('8. a project named twice is read once; an unknown or incomplete argument is refused')
    const named = all.out.scope.projects.find((p) => p !== 'empty-project')
    const once = await cli('--project', named)
    const twice = await cli('--project', named, '--project', named)
    t.eq('scope lists it once', twice.out.scope.projects, [named])
    t.eq('totals are not doubled', twice.out.totals.runs.total, once.out.totals.runs.total)
    for (const bad of [['--bogus'], ['--project'], ['--project', '--help'], ['stray']]) {
      let code = null
      try { await cli(...bad) } catch (error) { code = error.code }
      t.eq(`${bad.join(' ')}: exit 2`, code, 2)
    }
  } finally {
    if (saved.issues === undefined) delete process.env.DEVPANEL_ISSUES_DIR; else process.env.DEVPANEL_ISSUES_DIR = saved.issues
    if (saved.projects === undefined) delete process.env.DEVPANEL_PROJECTS_DIR; else process.env.DEVPANEL_PROJECTS_DIR = saved.projects
    await fs.rm(root, { recursive: true, force: true })
  }
}
