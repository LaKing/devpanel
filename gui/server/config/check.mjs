#!/usr/bin/env node
import fs from 'node:fs/promises'
import { discoveryCollisions, listProjectDirs, projectsRoot, resolveProjectPath } from '../project-path.mjs'
import { probeProjectSandbox } from '../runtime/sandbox-probe.mjs'
/*
 * Resolve configuration offline; explicit --preflight runs local diagnostics.
 *
 *   node server/config/check.mjs                 list playbooks and resolve each
 *   node server/config/check.mjs <playbook>      resolve one, in full
 *   node server/config/check.mjs <playbook> --preflight
 *
 * Preflight defaults to the FREE installation depth. Deeper probes cost a call
 * per model and require DEVPANEL_LIVE=1 plus --max-probe-invocations N.
 *
 * Resolution is offline. --preflight probes project sandbox mounts and installed harnesses.
 */
import { loadConfig, resolvePlaybook, CONFIG_ROOT } from './load.mjs'
import { discover } from './host-config.mjs'
import { hostSettings } from './host-settings.mjs'
import { preflight } from './preflight.mjs'
import { createProbeExecutor, ProbeNotAuthorised } from '../runtime/probe-budget.mjs'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const value = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const target = args.find((a, i) => !a.startsWith('--') && !['--depth', '--project', '--max-probe-invocations'].includes(args[i - 1]))
const projectId = value('--project', null)

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' }
const mark = (s) => s === 'pass' ? `${c.green}pass${c.off}` : s === 'fail' ? `${c.red}fail${c.off}`
  : s === 'warn' ? `${c.yellow}warn${c.off}` : `${c.dim}${s}${c.off}`

function reportErrors (errors) {
  for (const e of errors) {
    const where = [e.file?.replace(CONFIG_ROOT + '/', ''), e.field].filter(Boolean).join(' ')
    console.log(`  ${c.red}✗${c.off} ${e.message}`)
    if (where) console.log(`    ${c.dim}${where}${c.off}`)
  }
}

const config = await loadConfig()
if (config.errors.length) {
  console.log(`${c.red}configuration errors${c.off}`)
  reportErrors(config.errors)
  process.exit(1)
}

console.log(`${c.dim}root${c.off} ${config.root}`)
// Where this host's own configuration is read from (docs/host-config.md): the
// in-tree files and the host directory, the host file winning on the same name.
const hostPresent = await fs.stat(config.hostDir).then((s) => s.isDirectory(), () => false)
const counts = { ...config.sources }
for (const id of ['releases', 'live-reports']) {
  const files = await discover(id, { root: config.root, hostDir: config.hostDir })
  counts[id] = { tree: files.filter((f) => f.source === 'tree').length, host: files.filter((f) => f.source === 'host').length }
}
console.log(`${c.dim}host-config${c.off} ${config.hostDir} (${hostPresent ? 'present' : 'absent'})   ${Object.entries(counts).map(([id, n]) => `${c.dim}${id}${c.off} ${n.tree + n.host} (tree ${n.tree}, host ${n.host})`).join('   ')}`)
for (const s of config.shadowed) console.log(`  ${mark('warn')} ${s.category}/${s.name}: host-config shadows the in-tree ${s.tree}`)
// The host settings (docs/host-config.md "Host settings"): an invalid file is an error here as at server start.
try {
  const settings = hostSettings({ root: config.root, hostDir: config.hostDir })
  if (settings.pending) console.log(`  ${mark('warn')} host move pending: host settings are read from ${settings.file} until tools/migrate-host-config.mjs runs`)
  // Two directories whose relative paths join to one identity: only the first is a project.
  for (const x of discoveryCollisions(projectsRoot(), settings.projectDiscovery)) console.log(`  ${mark('warn')} projectDiscovery: ${x.dropped} is left out, its identity ${x.id} is ${x.kept}'s`)
} catch (error) {
  console.log(`${c.red}configuration errors${c.off}`)
  console.log(`  ${c.red}✗${c.off} ${error.message}`)
  process.exit(1)
}
console.log(`${c.dim}adapters${c.off} ${config.harnesses.join(', ') || '(none)'}   ${c.dim}models${c.off} ${config.roster.size}${config.disabledModels.size ? ` (${config.disabledModels.size} left out: disabled ${[...new Set(config.disabledModels.values())].join(', ')})` : ''}   ${c.dim}strategies${c.off} ${config.strategies.size}   ${c.dim}playbooks${c.off} ${config.playbooks.size}\n`)

const ids = target ? [target] : [...config.playbooks.keys()]
let failed = 0

if (flag('--preflight')) {
  const projectsDir = projectsRoot()
  const projects = projectId ? [projectId] : [...new Set([...config.projects.keys(), ...(await listProjectDirs(projectsDir)).map(({ id }) => id)])].sort()
  console.log('Project sandbox preflight (local commands only; no model calls)')
  for (const project of projects) {
    let result
    try {
      result = await probeProjectSandbox({ projectPath: await resolveProjectPath(project, { projectsDir }), allowedRoots: config.projects.get(project)?.workspace?.tooling?.allowedRoots ?? [] })
    } catch (error) { result = { status: 'fail', message: error.message } }
    console.log(`  ${mark(result.status)} ${project}: ${result.message}`)
    if (result.status === 'fail' || result.status === 'unknown') failed++
  }
  if (!projects.length) console.log('  No configured or discovered project paths to probe.')
  console.log()
}

for (const id of ids) {
  const r = await resolvePlaybook(id, { config, projectId })
  if (!r.ok) { console.log(`${c.red}✗${c.off} ${id}`); reportErrors(r.errors); failed++; continue }

  const p = r.resolved
  const live = p.liveExecution.eligible ? `${c.green}live-eligible${c.off}` : `${c.yellow}preview only${c.off}`
  console.log(`${c.green}✓${c.off} ${c.cyan}${id}${c.off} v${p.playbook.version}  ${c.dim}→ ${p.strategy.id} v${p.strategy.version}${c.off}  ${live}`)
  // Not a failure: the configuration is valid without the tool, but every seat
  // turn of the project is refused until the source exists.
  for (const m of p.workspace.tooling.mounts ?? []) {
    if (m.missing) console.log(`  ${mark('warn')} tooling mount ${m.target}: ${m.source} does not exist${m.provisional ? ' (provisional)' : ''}; this project's seat turns are refused until it does`)
  }
  // What the checkout provides under host settings tooling.nodeModules: no file states it, so it is listed.
  if (p.workspace.tooling.auto) {
    for (const m of p.workspace.tooling.mounts ?? []) console.log(`    ${c.dim}tooling${c.off}    mount ${m.target} ← ${m.sourceReal ?? m.source} (read-only${m.masks?.length ? `; masked: ${m.masks.join(', ')}` : ''})`)
    for (const x of p.workspace.tooling.commands ?? []) console.log(`    ${c.dim}tooling${c.off}    command ${x.id}: ${x.cwd ? `${x.cwd}: ` : ''}${x.run}`)
    for (const s of p.workspace.tooling.autoSkipped ?? []) console.log(`  ${mark('warn')} tooling ${s.target} left out: ${s.reason}`)
  }

  if (target) {
    for (const [role, q] of Object.entries(p.participants)) {
      const eff = q.effort ?? `${c.dim}no effort${c.off}`
      const ver = q.model.verification?.status === 'verified' ? '' : ` ${c.yellow}(unverified)${c.off}`
      console.log(`    ${role.padEnd(12)} ${q.model.id} ${c.dim}${q.model.wire} via ${q.model.harness}${c.off} ${eff}${ver}${q.writesCode ? ` ${c.dim}[writer]${c.off}` : ''}`)
    }
    console.log(`    ${c.dim}checks${c.off}     requirement=${p.checks.requirement} target=${p.checks.target?.kind ?? 'none'}${p.checks.target ? ` commands=${(p.checks.target.commands ?? []).map((x) => x.id).join(',')} timing=${p.checks.target.timing ?? 'every-revision'}` : ''}`)
    console.log(`    ${c.dim}autoClose${c.off}  ${p.autoClose.minimumVerification} ${c.dim}(from ${p.autoClose.source})${c.off}`)
    console.log(`    ${c.dim}budgets${c.off}    ${Object.entries(p.budgets).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    console.log(`    ${c.dim}config${c.off}     ${p.configHash}`)
  }
  for (const b of p.liveExecution.blockers) console.log(`    ${c.yellow}!${c.off} ${b.role}: ${b.model ? b.model + ' ' : ''}${b.reason}`)

  if (flag('--preflight')) {
    // Diagnostics default to the FREE depth. Reaching further spends money, and a
    // command people run to inspect configuration must not do that by accident.
    const depth = value('--depth', 'installation')
    const authorised = process.env.DEVPANEL_LIVE === '1'
    const probeBudget = Number(value('--max-probe-invocations', '0'))

    if (depth !== 'installation' && !authorised) {
      console.log(`\n    ${c.yellow}refusing to probe at depth "${depth}"${c.off}`)
      console.log(`    ${c.dim}It costs a call per model. Set DEVPANEL_LIVE=1 and pass --max-probe-invocations N.${c.off}`)
      failed++
      continue
    }

    const modules = new Map()
    const probe = createProbeExecutor({
      load: async (harness) => {
        if (!modules.has(harness)) modules.set(harness, import(`${config.root}/harness/${harness}.mjs`))
        return modules.get(harness)
      },
      allowPaid: authorised,
      maxInvocations: probeBudget
    })

    let pf
    try {
      pf = await preflight(p, { probe, depth })
    } catch (error) {
      if (error instanceof ProbeNotAuthorised) {
        console.log(`\n    ${c.yellow}${error.message}${c.off}`)
        failed++
        continue
      }
      throw error
    }
    const probedNote = pf.probed ? '' : ` ${c.dim}(not probed — configuration is ineligible)${c.off}`
    console.log(`\n    ${c.dim}preflight (depth ${pf.depth})${c.off}${probedNote}`)
    for (const f of pf.findings) console.log(`      ${mark(f.status)}  ${c.dim}${f.level}${c.off}  ${f.message}`)
    if (probe.spent.invocations) console.log(`      ${c.dim}probe spend${c.off}  ${probe.summary()}`)
    else console.log(`      ${c.dim}·${c.off}  ${c.dim}installation depth only — nothing was spent${c.off}`)

    // Launch requires positive evidence: no failures AND nothing unknown.
    const verdict = pf.launchReady
      ? `${c.green}launch-ready${c.off}`
      : `${c.yellow}not launch-ready${c.off} ${c.dim}(${pf.failures.length} failing, ${pf.unknowns.length} unproven)${c.off}`
    console.log(`      ${c.dim}→${c.off} ${verdict}`)

    // A diagnostic run fails on definite problems; unknowns are reported, not fatal.
    if (pf.failures.length) failed++
  }
  console.log()
}

process.exit(failed ? 1 : 0)
