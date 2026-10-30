#!/usr/bin/env node
/*
 * Test runner. No dependency, no framework.
 *
 *   npm test                 run every suite
 *   npm test -- regressions  run suites whose filename matches
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupSandboxes } from './helpers.mjs'
import { cleanupFixtures } from './fakes/fixture.mjs'
import { cleanupStages } from './browser/stage.mjs'
import { cleanupBuild } from './browser/build.mjs'
import { closeChromium } from './browser/chromium.mjs'

// The seat fence (fence.namespace: 1) mounts only a run's own paths; the
// suite's fake CLIs live in gui/test/fakes and write to temp files it does not
// mount. Suites that test the fence itself turn it back on, or call the
// adapters with a fence spec directly.
process.env.DEVPANEL_FENCE ??= 'off'
// No suite reads this host's own configuration (docs/host-config.md): not an
// inherited host-config directory, not the checkout's host-config/, and not the
// carried settings of a host move still pending in the checkout. The setting
// points at an empty directory of the run's own; a suite that tests host
// configuration names its fixture directory explicitly.
const os = await import('node:os')
const EMPTY_HOST_CONFIG = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-no-host-config-'))
process.env.DEVPANEL_HOST_CONFIG_DIR = EMPTY_HOST_CONFIG
// Nor the data root a host-config may be found in (~/devpanel by default): a
// suite that unsets the setting above must not find this host's there either.
process.env.DEVPANEL_DATA_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-no-data-root-'))
// Nor the host's projects: the suites' projects root holds only the panel's own
// project, empty (the engine fixtures file their issues under it). A suite that
// needs other projects points DEVPANEL_PROJECTS_DIR at a fixture of its own.
const PROJECTS = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-projects-'))
await fs.mkdir(path.join(PROJECTS, 'devpanel-project'))
process.env.DEVPANEL_PROJECTS_DIR = PROJECTS

const HERE = path.dirname(fileURLToPath(import.meta.url))
// runner.test.mjs points this at its fixture suites.
const SUITES = path.resolve(process.env.DEVPANEL_TEST_SUITES ?? HERE)
const filter = process.argv[2] ?? ''
const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' }

const files = (await fs.readdir(SUITES))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort()

/*
 * Temp directories the suites create are removed at the end of a run — which a
 * killed, timed-out or interrupted run never reaches; thousands accumulated in
 * /tmp. So: clean up on SIGINT/SIGTERM too, and sweep this user's own leftovers
 * with the suites' prefixes once they are a day old (no run is that long).
 */
const TEMP_PREFIXES = ['devpanel-', 'check-ws-', 'check-run-', 'check-proj-', 'ssh-cancel-', 'ssh-shim', 'sup-defaults', 'eng-adapter', 'precond-proj-']
async function sweepStaleTemps () {
  const tmp = os.tmpdir()
  const uid = process.getuid?.()
  const cutoff = Date.now() - 24 * 3600_000
  for (const name of await fs.readdir(tmp).catch(() => [])) {
    if (!TEMP_PREFIXES.some((p) => name.startsWith(p))) continue
    const full = path.join(tmp, name)
    const stat = await fs.lstat(full).catch(() => null)
    if (!stat?.isDirectory() || (uid !== undefined && stat.uid !== uid) || stat.mtimeMs > cutoff) continue
    await fs.rm(full, { recursive: true, force: true }).catch(() => {})
  }
}
await sweepStaleTemps()
const cleanupAll = async () => {
  await closeChromium().catch(() => {})
  await cleanupStages().catch(() => {})
  await cleanupBuild().catch(() => {})
  await cleanupSandboxes().catch(() => {})
  await cleanupFixtures().catch(() => {})
  await fs.rm(EMPTY_HOST_CONFIG, { recursive: true, force: true }).catch(() => {})
  await fs.rm(PROJECTS, { recursive: true, force: true }).catch(() => {})
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanupAll().finally(() => process.exit(130)) })

let passed = 0
const failures = []
const skipped = []

function context (file) {
  let section = ''
  return {
    section (name) { section = name; console.log(`  ${c.dim}${name}${c.off}`) },
    ok (label, condition, detail = '') {
      const line = `${label}${detail ? ` ${c.dim}— ${detail}${c.off}` : ''}`
      if (condition) { passed++; console.log(`    ${c.green}✓${c.off} ${line}`) }
      else { failures.push(`${file} › ${section} › ${label}${detail ? ` — ${detail}` : ''}`); console.log(`    ${c.red}✗${c.off} ${line}`) }
    },
    eq (label, actual, expected) {
      const equal = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
      this.ok(label, equal, equal ? '' : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    },
    /**
     * Not checked, and not counted as checked.
     *
     * A skip that reports itself as a pass is worse than no test: it says the
     * thing was verified when nothing looked at it.
     */
    skip (label, reason = '') {
      skipped.push(`${file} › ${section} › ${label}${reason ? ` — ${reason}` : ''}`)
      console.log(`    ${c.yellow}○${c.off} ${label}${reason ? ` ${c.dim}— ${reason}${c.off}` : ''}`)
    }
  }
}

/*
 * An error nobody handles (a server's 'error' event, a stray rejection) would
 * otherwise end the process before cleanupAll() and the tally. It is the
 * running suite's failure: that suite is abandoned and the next one starts.
 * Outside a suite it is the run's own.
 */
let current = null
let abandon = null
const uncaught = (error) => {
  const message = `uncaught: ${error?.message ?? error}`
  if (!current) {
    // It may have ended the run's own top level, before the tally: never exit 0.
    process.exitCode = 1
    failures.push(`run › ${message}`)
    console.log(`    ${c.red}✗ ${message} outside a suite${c.off}`)
    return
  }
  failures.push(`${current} › threw › ${message}`)
  console.log(`    ${c.red}✗ suite threw${c.off} ${message}`)
  abandon?.()
}
process.on('uncaughtException', uncaught)
process.on('unhandledRejection', uncaught)

for (const file of files) {
  current = file
  try {
    const mod = await import(path.join(SUITES, file))
    console.log(`\n${c.cyan}${mod.name ?? file}${c.off}`)
    await new Promise((resolve, reject) => {
      abandon = resolve
      Promise.resolve().then(() => mod.default(context(file))).then(resolve, reject)
    })
    // A rejection the suite left unawaited is reported only after its
    // microtasks drain; it is still this suite's.
    await new Promise((resolve) => setImmediate(resolve))
  } catch (error) {
    failures.push(`${file} › threw › ${error.message}`)
    console.log(`    ${c.red}✗ suite threw${c.off} ${error.message}`)
  } finally {
    current = abandon = null
  }
}

await cleanupAll()

const tally = [`${passed} passed`, `${failures.length} failed`]
if (skipped.length) tally.push(`${skipped.length} skipped`)
console.log(`\n${tally.join(', ')}`)
for (const f of failures) console.log(`  ${c.red}✗${c.off} ${f}`)
for (const s of skipped) console.log(`  ${c.yellow}○${c.off} ${s}`)
process.exit(failures.length ? 1 : 0)
