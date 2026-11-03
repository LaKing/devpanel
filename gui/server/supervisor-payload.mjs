import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/*
 * What a tool result costs the top-level supervisor: every result enters its
 * native session and stays there, re-read on every later call. One overview
 * was 372k characters (most of it per-configuration statistics), a disposition
 * echoed the whole issue with its steps, and a project's issue list ran to
 * 190k. Here each action's result is shaped for the session, in
 * top-supervisor.mjs drive(), after the action ran and before it is shown.
 *
 * Nothing is dropped silently: a mutation's acknowledgement names what changed
 * and passes warnings on; a page says how many rows there are and how to read
 * the next; statistics left out say how to ask for them; and anything still
 * over the bound is kept whole in a file and shown with `get_result` to read
 * on. Diagnostics (check results, test names) live in get_run and
 * get_check_log, which are only bounded, never summarised here.
 */

export const RESULT_LIMIT = 40_000
export const PAGE_CHARS = 30_000
const PAGE_ROWS = 50
const MUTATIONS = new Set(['set_disposition', 'archive_issue', 'set_priority', 'set_dependencies', 'create_issue', 'mark_landed'])

/** The fields of an issue that say where it stands, without its steps or material. */
export function issueRow (i) {
    return {
        id: i.id, name: i.name, status: i.status ?? null,
        ...(i.kind ? { kind: i.kind } : {}), ...(i.archived ? { archived: true } : {}),
        priority: i.priority?.value ?? i.priority ?? null, disposition: i.disposition?.value ?? i.disposition ?? null,
        ...(i.report ? { report: { kind: i.report.kind ?? null, trust: i.report.trust ?? null, reporter: i.report.reporter ?? null } } : {}),
        ...(i.dependsOn?.length ? { dependsOn: i.dependsOn.map((d) => d.id ?? d) } : {}),
        openedOn: i.openedOn ?? null,
        latestRun: i.latestRun ? { runId: i.latestRun.runId, status: i.latestRun.status, outcome: i.latestRun.outcome ?? null, blockedReason: i.latestRun.blockedReason ?? null } : null
    }
}

/** A mutation's acknowledgement: the issue as it now stands, what was done, and any warning the result carried. */
export function acknowledge (action, result) {
    const issue = result?.issue ?? result
    if (!issue || typeof issue !== 'object' || !issue.id || !Array.isArray(issue.steps ?? [])) return result
    const warnings = [...new Set([...(result.warnings ?? []), ...(issue.warnings ?? [])])]
    return { ok: true, change: action.type, issue: { project: issue.project ?? action.project, ...issueRow(issue), ...(issue.disposition?.runId ? { dispositionRun: issue.disposition.runId } : {}) },
        ...(result.landed ? { landed: result.landed } : {}), ...(warnings.length ? { warnings } : {}) }
}

/** One page of a project's issues, open first as listed; the rest is counted, not dropped. */
export function issuesPage (issues, { project, offset = 0, limit = PAGE_ROWS } = {}) {
    const start = Math.max(0, Number.isSafeInteger(offset) ? offset : 0)
    const size = Math.min(200, Math.max(1, Number.isSafeInteger(limit) ? limit : PAGE_ROWS))
    const rows = issues.slice(start, start + size).map(issueRow)
    const next = start + rows.length < issues.length ? start + rows.length : null
    return { project, total: issues.length, offset: start, issues: rows,
        ...(next !== null ? { omitted: issues.length - next, next: `list_issues {project:"${project}",offset:${next}}` } : {}),
        detail: 'Rows only; get_issue returns an issue with its notes and runs.' }
}

/** The overview without its per-configuration and per-seat statistics unless asked: they were 98% of it. */
export function overviewFor (overview, { stats = false } = {}) {
    if (stats === true || !overview || typeof overview !== 'object') return overview
    const want = new Set([].concat(stats || []))
    const out = { ...overview }
    const omitted = {}
    for (const key of ['byPlaybook', 'bySeat']) {
        if (want.has(key) || !(key in out)) continue
        omitted[key] = Object.keys(out[key] ?? {}).length
        delete out[key]
    }
    if (Object.keys(omitted).length) out.statsOmitted = { groups: omitted, how: 'overview {stats:["byPlaybook"]} or {stats:["bySeat"]}, or {stats:true} for both' }
    return out
}

/**
 * An issue-list change as the difference from what was last observed (the
 * poll's fingerprint: id, status, name), not the whole list again: `issues`
 * holds the added and changed rows, `removed` the ids that left the list.
 */
export function issuesChanged (project, previousFingerprint, issues) {
    let before = []
    try { before = JSON.parse(previousFingerprint ?? '[]') } catch { /* unreadable: every row reads as added */ }
    const was = new Map(before.map((i) => [i.id, i]))
    const now = new Set(issues.map((i) => i.id))
    const touched = issues.filter((i) => !was.has(i.id) || was.get(i.id).status !== i.status || was.get(i.id).name !== i.name)
        .map((i) => ({ ...issueRow(i), change: !was.has(i.id) ? 'added' : was.get(i.id).status !== i.status ? `status ${was.get(i.id).status} -> ${i.status}` : 'renamed' }))
    const removed = before.filter((i) => !now.has(i.id)).map((i) => i.id)
    return { type: 'issues-changed', project, total: issues.length, issues: touched, ...(removed.length ? { removed } : {}), detail: `Only what changed; list_issues {project:"${project}"} lists them all.` }
}

/** A result shaped for the session, then bounded: over RESULT_LIMIT it is kept whole on disk and shown as its first page. */
export async function shapeResult (action, result, { dir }) {
    let shown = result
    if (MUTATIONS.has(action.type) && !result?.error) shown = acknowledge(action, result)
    const text = JSON.stringify(shown) ?? 'null'
    if (text.length <= RESULT_LIMIT) return shown
    const id = crypto.randomUUID()
    await fs.mkdir(path.join(dir, 'results'), { recursive: true })
    await fs.writeFile(path.join(dir, 'results', `${id}.json`), text)
    await prune(path.join(dir, 'results')).catch(() => { /* an old result left behind is only disk */ })
    return { truncated: true, action: action.type, chars: text.length, resultId: id, page: text.slice(0, PAGE_CHARS),
        next: `get_result {resultId:"${id}",offset:${PAGE_CHARS}}`, detail: 'The whole result is kept; `page` is its JSON text from the start. Read on with get_result, or ask a narrower question.' }
}

/** The newest KEPT results stay readable; a session reads on in a result within a few calls of seeing it. */
const KEPT = 200
async function prune (resultsDir) {
    const names = (await fs.readdir(resultsDir)).filter((n) => n.endsWith('.json'))
    if (names.length <= KEPT) return
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(resultsDir, n))).mtimeMs })))
    for (const { n } of dated.sort((a, b) => a.t - b.t).slice(0, names.length - KEPT)) await fs.rm(path.join(resultsDir, n), { force: true })
}

/** A slice of a kept result's JSON text. */
export async function readResult ({ dir, resultId, offset = 0 }) {
    if (typeof resultId !== 'string' || !/^[0-9a-f-]{36}$/.test(resultId)) throw Object.assign(new Error('Unknown resultId'), { status: 400 })
    const text = await fs.readFile(path.join(dir, 'results', `${resultId}.json`), 'utf8').catch(() => { throw Object.assign(new Error('Unknown resultId'), { status: 404 }) })
    const start = Math.max(0, Number.isSafeInteger(offset) ? offset : 0)
    const page = text.slice(start, start + PAGE_CHARS)
    const end = start + page.length
    return { resultId, chars: text.length, offset: start, page, ...(end < text.length ? { next: `get_result {resultId:"${resultId}",offset:${end}}` } : { last: true }) }
}
