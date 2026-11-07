import dns from 'node:dns/promises'
import os from 'node:os'

/*
 * Who opened an issue, recorded once on issue.json as `openedBy`:
 *
 *   { user, host, from: { project, issueId, runId?, via, cycle? } | null }
 *
 * `user@host` names the opener: a person by their proxy login (proxy-user.mjs) or the name they gave the panel and
 * the machine their browser connected from, or a panel process (`supervisor`,
 * `engine`) and the panel's own host. `from` names the issue it came out of,
 * when there is one: a residual-risk follow-up, an accepted split, an inquiry's
 * proposal, or a run's finding. A red daily full verification names its cycle
 * instead (`via: 'full-verification'`, `cycle`, the stage run): the cycle is
 * not an issue, so such an issue has no parent issue. Issues opened before this existed carry none;
 * what their own record implies is derived on read, never written back.
 */

export const PANEL_HOST = os.hostname()
export const VIA = ['follow-up', 'split', 'inquiry', 'finding', 'full-verification']

const clean = (value, max = 120) => (typeof value === 'string' && value.trim() ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null)

export function openedBy ({ user, host = PANEL_HOST, from = null }) {
  const record = { user: clean(user) ?? 'unknown', host: clean(host, 255) ?? 'unknown', from: null }
  if (from) {
    if (!VIA.includes(from.via)) throw Object.assign(new Error(`openedBy.from.via must be one of ${VIA.join(', ')}`), { status: 400 })
    if (from.via === 'full-verification') {
      if (!clean(from.cycle, 200)) throw Object.assign(new Error('openedBy.from of a full verification needs the cycle it came from'), { status: 400 })
      record.from = { project: clean(from.project, 200), issueId: null, runId: clean(from.runId, 200), via: from.via, cycle: clean(from.cycle, 200) }
      return record
    }
    if (!clean(from.issueId, 200)) throw Object.assign(new Error('openedBy.from needs the issue it came from'), { status: 400 })
    record.from = { project: clean(from.project, 200), issueId: clean(from.issueId, 200), runId: clean(from.runId, 200), via: from.via }
  }
  return record
}

/** What an older issue's own record says about where it came from; null when nothing does. */
export function derivedOpenedBy (meta, project) {
  if (meta.fromInquiry?.inquiryId) return { user: 'supervisor', host: null, from: { project, issueId: meta.fromInquiry.inquiryId, runId: meta.fromInquiry.runId ?? null, via: 'inquiry' }, derived: true }
  if (meta.origin?.issue) return { user: 'engine', host: null, from: { project, issueId: meta.origin.issue, runId: meta.origin.runId ?? null, via: 'finding' }, derived: true }
  if (meta.inquiry?.createdBy) return { user: meta.inquiry.createdBy, host: null, from: null, derived: true }
  return null
}

export const describeOpener = (o) => (o ? (o.host ? `${o.user}@${o.host}` : o.user) : null)

/**
 * The machine a browser or API client connected from: its reverse-DNS name
 * when one answers quickly, else its address. Never blocks issue creation.
 */
export async function clientHost (req, { timeoutMs = 300 } = {}) {
  const address = String(req.socket?.remoteAddress ?? req.ip ?? '').replace(/^::ffff:/, '')
  if (!address) return 'unknown'
  if (address === '127.0.0.1' || address === '::1') return PANEL_HOST
  try {
    const names = await Promise.race([dns.reverse(address), new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))])
    return names?.[0] ?? address
  } catch { return address }
}
