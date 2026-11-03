import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ISSUES_DIR } from './issues.js'

/*
 * Reporters: the deployments allowed to report AS THEMSELVES (report.mjs), and how far the
 * top-level supervisor may act on what they report.
 *
 * A reporter is a name bound to one project and a key. The panel keeps only the key's sha256 in
 * `issues/.reporters.json` (git-ignored host data, 0600); the key itself is printed once by
 * `tools/reporter.mjs add` and lives in the deployment's secrets. Not in `projects/<id>.yaml`:
 * that file is run configuration and contributes to every run's configHash, and a key is neither.
 *
 * Trust is what a report is, decided by the panel and never by the report's text:
 *   anonymous — no key (private network only): a deployment we cannot tell from any other peer.
 *   fault     — a keyed reporter's automatic error/warning/crash report: the framework wrote it.
 *   request   — a keyed reporter relaying a PERSON (an assistant aid: bug report, feature request):
 *               the text is a human's, so it can steer an agent like any prompt can.
 * Each trust maps to the supervisor level for that reporter: `none` (the supervisor starts
 * nothing), `assess` (only ASSESS playbooks: they read and report, deliver nothing) or `any`.
 * An operator in the panel is never gated by this; it is the supervisor's autonomy only.
 */

export const LEVELS = ['none', 'assess', 'any']
export const ASSESS_PLAYBOOKS = ['triage', 'analysis']
export const DEFAULT_POLICY = { fault: 'any', request: 'assess' }
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

const file = () => process.env.DEVPANEL_REPORTERS_FILE ?? path.join(ISSUES_DIR, '.reporters.json')
const digest = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex')

export async function readReporters () {
  try { return JSON.parse(await fs.readFile(file(), 'utf8')).reporters ?? {} } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function writeReporters (reporters) {
  const target = file()
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify({ reporters }, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(temp, target)
}

function checkPolicy (policy) {
  for (const trust of ['fault', 'request']) if (!LEVELS.includes(policy[trust])) throw new Error(`${trust} must be one of ${LEVELS.join(', ')}`)
  return policy
}

/** A new reporter, or a new key for an existing one. Returns the key: the only time it is seen. */
export async function addReporter ({ name, project, policy = {} }) {
  if (!NAME.test(name ?? '')) throw new Error('a reporter name is lowercase letters, digits, . _ -')
  if (!project) throw new Error('a reporter belongs to one project')
  const reporters = await readReporters()
  const key = crypto.randomBytes(32).toString('base64url')
  const previous = reporters[name]?.policy ?? DEFAULT_POLICY
  reporters[name] = { project, keySha256: digest(key), policy: checkPolicy({ ...previous, ...policy }), createdAt: new Date().toISOString() }
  await writeReporters(reporters)
  return key
}

export async function setPolicy (name, policy) {
  const reporters = await readReporters()
  if (!reporters[name]) throw new Error(`no reporter ${name}`)
  reporters[name].policy = checkPolicy({ ...reporters[name].policy, ...policy })
  await writeReporters(reporters)
  return reporters[name]
}

export async function removeReporter (name) {
  const reporters = await readReporters()
  if (!reporters[name]) return false
  delete reporters[name]
  await writeReporters(reporters)
  return true
}

/** The reporter a key belongs to, as {name, project, policy}, or null. Constant-time per entry. */
export async function reporterForKey (key) {
  if (typeof key !== 'string' || !key) return null
  const offered = Buffer.from(digest(key), 'hex')
  for (const [name, r] of Object.entries(await readReporters())) {
    if (crypto.timingSafeEqual(offered, Buffer.from(r.keySha256, 'hex'))) return { name, project: r.project, policy: r.policy }
  }
  return null
}

/**
 * Why the supervisor may not start `playbook` on this issue, or null. Read at start time from the
 * CURRENT reporter record, so tightening a policy or removing a reporter applies to issues already
 * open; a reporter that no longer exists counts as anonymous.
 */
/** How far the supervisor may act on this issue: `any`, `assess` (ASSESS_PLAYBOOKS only) or `none`. */
export async function reportStartLevel (issue, { reporters = null } = {}) {
  const report = issue?.report
  if (!report) return 'any'
  const current = report.reporter ? (reporters ?? await readReporters())[report.reporter] : null
  return report.trust === 'anonymous' || !current ? 'none' : current.policy?.[report.trust] ?? 'none'
}

export async function reportStartRefusal (issue, playbook, { reporters = null } = {}) {
  const report = issue?.report
  if (!report) return null
  const level = await reportStartLevel(issue, { reporters })
  const who = report.reporter ? `reporter ${report.reporter}` : 'an anonymous report'
  if (level === 'any') return null
  if (level === 'assess' && ASSESS_PLAYBOOKS.includes(playbook)) return null
  const allowed = level === 'assess' ? `only ${ASSESS_PLAYBOOKS.join(' or ')}` : 'no playbook'
  return `${issue.id} came from ${who} (${report.trust}); the supervisor may start ${allowed} on it. An operator can start it from the panel.`
}
