import os from 'node:os'

import express from 'express'

import { clientHost } from './opened-by.mjs'
import { validFingerprint } from './report-identity.mjs'
import { reporterForKey } from './reporters.mjs'

/*
 * POST /api/report/:project {input, kind?, category?, fingerprint?} — open an issue from a project's deployment.
 *
 * It can do nothing else: no run is started, nothing is read back, the answer is only {project, id, trust}.
 * A report already opened today is answered 409 {error, project, id}, naming that issue so the reporter
 * can stop resubmitting; only its id, which the report's own title and the date determine. An id an archived
 * issue holds is never taken, and two reports of one title whose fingerprints differ are two issues
 * (issues.js createIssue). A fingerprint comes from `fingerprint` or from the report's own text; a match with
 * an earlier issue is recorded on the new one, never told to the reporter (report-identity.mjs).
 * Mounted in index.js BEFORE the token gate, with its own small body parser.
 *
 * Who may: a peer whose address is private (RFC 1918, IPv6 ULA) and that did not come through the
 * reverse proxy. The proxy connects from the host's private address too, but sets X-Forwarded-For
 * (`option forwardfor`), and behind it is the internet; such a request is refused here. Not this
 * panel's own addresses or loopback either: seats and code under test run here (general §008).
 *
 * With `X-Devpanel-Reporter-Key` the report is the named reporter's (reporters.mjs): trust `fault`
 * for kind `fault` (the framework's own error/warning/crash report), `request` for kind `request`
 * (a person, relayed by an assistant). Without a key it is `anonymous`, whatever it claims. A key
 * that matches nothing, or another project's reporter, is refused rather than downgraded, so a
 * misconfigured deployment finds out. The trust is recorded on the issue (`issue.report`) and
 * bounds what the top-level supervisor may start on it; it never limits an operator.
 *
 * Pitfall: createIssue reads a single-line `….md` input as a LOCAL FILE PATH. Report input is
 * therefore always made multi-line text first, or anyone could copy any .md file into an issue.
 */

const MAX_BYTES = 256 * 1024
const WINDOW_MS = 10 * 60 * 1000
const PER_WINDOW = 20
const KINDS = ['fault', 'request']
const CATEGORIES = ['bug', 'feature', 'error', 'warning', 'crash']

const bare = (address) => String(address ?? '').replace(/^::ffff:/, '').toLowerCase()

export function privateAddress (address) {
  const a = bare(address)
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])]
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
  }
  return /^f[cd][0-9a-f]{2}:/.test(a)
}

const ownAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().map((i) => bare(i?.address)))

/** Why this peer may not report, or null when it may. */
export function refusal (req, own = ownAddresses()) {
  const peer = bare(req.socket?.remoteAddress)
  if (req.headers?.['x-forwarded-for'] !== undefined) return 'came through the proxy'
  if (!privateAddress(peer)) return 'not from the private network'
  if (own.has(peer)) return 'from the panel itself'
  return null
}

// Report text, never a path: a single line becomes the heading of a one-line report.
export function reportText (input) {
  if (typeof input !== 'string' || !input.trim()) return null
  return /[\r\n]/.test(input) ? input : `# ${input.trim()}\n`
}

// `refuse` and `identify` are injectable only so a test over loopback can reach the accepting path.
export function reportRouter ({ createIssue, emit, now = Date.now, refuse = refusal, identify = reporterForKey }) {
  const router = express.Router()
  const recent = new Map()

  router.post('/api/report/:project', express.json({ limit: MAX_BYTES }), async (req, res, next) => {
    try {
      const why = refuse(req)
      if (why) return res.status(403).json({ error: `reporting is refused: ${why}`, hint: 'call the panel by its private address, not through the proxy' })
      const offered = req.headers['x-devpanel-reporter-key']
      const reporter = offered ? await identify(offered) : null
      if (offered && !reporter) return res.status(403).json({ error: 'the reporter key matches no reporter' })
      if (reporter && reporter.project !== req.params.project) return res.status(403).json({ error: `reporter ${reporter.name} reports for ${reporter.project}, not ${req.params.project}` })
      const kind = req.body?.kind ?? 'fault'
      const category = req.body?.category ?? null
      if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` })
      if (category !== null && !CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of ${CATEGORIES.join(', ')}` })
      const fingerprint = req.body?.fingerprint ?? null
      if (fingerprint !== null && !validFingerprint(fingerprint)) return res.status(400).json({ error: 'fingerprint must be one word of 6 to 128 letters, digits and . _ : + / = -, starting with a letter or digit' })
      const input = reportText(req.body?.input)
      if (!input) return res.status(400).json({ error: 'input (the report as Markdown) is required' })
      const bucket = reporter ? `reporter:${reporter.name}` : `peer:${bare(req.socket.remoteAddress)}`
      const times = (recent.get(bucket) ?? []).filter((t) => now() - t < WINDOW_MS)
      if (times.length >= PER_WINDOW) return res.status(429).json({ error: `at most ${PER_WINDOW} reports per ${WINDOW_MS / 60000} minutes from one reporter or address` })
      recent.set(bucket, [...times, now()])
      const report = { kind, category, reporter: reporter?.name ?? null, trust: reporter ? kind : 'anonymous', ...(fingerprint ? { fingerprint } : {}) }
      const issue = await createIssue(req.params.project, { input, reportOrigin: report, openedBy: { user: reporter?.name ?? 'report', host: await clientHost(req) } })
      emit({ reason: 'issue-created', project: issue.project, id: issue.id })
      // Unknown format, or several values: no repeat can be claimed for it, and that should be findable.
      if (issue.report && !issue.report.fingerprint && /fingerprint/i.test(input)) console.info(`${req.method} ${req.path}: ${issue.id} mentions a fingerprint, but none could be read`)
      res.status(201).json({ project: issue.project, id: issue.id, trust: report.trust })
    } catch (error) {
      // A resubmission is routine, not a failure: info here, because the app's error handler warns.
      if (!error.existingId) return next(error)
      console.info(`${req.method} ${req.path}: ${error.message}`)
      res.status(409).json({ error: error.message, project: req.params.project, id: error.existingId })
    }
  })
  return router
}
