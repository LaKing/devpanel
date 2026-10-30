import { issuesRoot, listProjectDirs, projectLabel, projectPath as projectSourceDir, projectsRoot, resolveProjectPath } from './project-path.mjs'
import { withStepReservation } from './step-allocation.mjs'
import { writeAtomic, writeJson } from './runtime/persistence.mjs'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { runResult } from './runtime/run-result.mjs'
import { explainRun } from './runtime/run-explanation.mjs'
import { withLock } from './runtime/lock.mjs'
import { unrecordedCleanup, unrecordedRefusal } from './runtime/cleanup-barrier.mjs'
import { ARCHIVE_FILE, archiveState, requireUnarchived } from './issue-archive.mjs'
import { bundleFiles, deletePacked, packIssue, packedRuns, packedSummaries, packedSummary, unpackIssue } from './issue-bundle.mjs'
import { openedBy as openedByRecord, derivedOpenedBy } from './opened-by.mjs'
import { brief, families } from './issue-family.mjs'

/*
 * File-backed issue storage, keyed by the project an issue was discovered in.
 *
 *   <ISSUES_DIR>/<project>/<YYYY-MM-DD>-<slug>/        the issue
 *   <ISSUES_DIR>/<project>/<YYYY-MM-DD>-<slug>/<NNN>-<slug>/   a step
 *
 * Directory names carry the identity — not issue.json — so everything sorts by
 * name alone and a folder made by hand still shows up.
 */


// Read once, at load: tests import a fresh copy after setting the variable.
const PROJECTS_DIR = projectsRoot()

export const ISSUES_DIR = issuesRoot()

const META_FILE = 'issue.json'
const ISSUE_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/
const STEP_PATTERN = /^(\d{3})-(.+)$/
const STEP_NUMBER_WIDTH = 3

export class IssueError extends Error {
  constructor (message, status = 400) {
    super(message)
    this.status = status
  }
}

// --- naming ----------------------------------------------------------------

/** Lowercase, ASCII, hyphen-separated — and safe as a single path segment. */
export function slugify (input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Local calendar date — an issue opened at 23:00 belongs to that day. */
export function today (date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function requireName (value, what, maxLength = 64) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new IssueError(`${what} needs a name`)
  if (name.length > maxLength) throw new IssueError('name is longer than 64 characters')

  const slug = slugify(name)
  if (!slug) throw new IssueError('name must contain at least one letter or digit')

  return { name, slug }
}

// --- projects --------------------------------------------------------------

async function projectDirNames () {
  return (await listProjectDirs(PROJECTS_DIR)).map(({ id }) => id)
}

async function countIssues (project) {
  try {
    const entries = await fs.readdir(path.join(ISSUES_DIR, project), { withFileTypes: true })
    const active = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && ISSUE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const dir = path.join(ISSUES_DIR, project, entry.name)
        if (await archiveState(dir)) return false
        // Inquiries stay out of the issue lists (docs/top-level-supervisor.md "Inquiries"),
        // so the count beside the project must leave them out too.
        try { return JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8')).kind !== 'inquiry' } catch { return true }
      }))
    return active.filter(Boolean).length
  } catch {
    return 0
  }
}

/**
 * Every project under the projects root, each with how many issues it holds. One list serves both
 * the project overview (those with issues) and the new-issue picker (all of them).
 */
export async function listProjects () {
  const names = await projectDirNames()

  return Promise.all(names.map(async (name) => ({
    id: name,
    label: projectLabel(name),
    path: await resolveProjectPath(name, { projectsDir: PROJECTS_DIR }),
    issueCount: await countIssues(name)
  })))
}

/**
 * Validate a project id from a URL against the directories that actually exist,
 * so a request can neither invent a project nor walk out of ISSUES_DIR.
 */
export async function requireProject (project) {
  if (typeof project !== 'string' || !project || project.includes('/') || project.includes('..')) {
    throw new IssueError('no such project', 404)
  }

  const names = await projectDirNames()
  if (!names.includes(project)) throw new IssueError('no such project', 404)

  return project
}

// --- issues ----------------------------------------------------------------

async function readIssue (project, dirName) {
  const match = ISSUE_PATTERN.exec(dirName)
  if (!match) return null

  const [, openedOn, slug] = match
  const dir = path.join(ISSUES_DIR, project, dirName)
  const archive = await archiveState(dir)

  let meta = {}
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8'))
  } catch {
    meta = {}
  }

  let stepCount = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    stepCount = entries.filter((entry) => entry.isDirectory() && STEP_PATTERN.test(entry.name)).length
  } catch { /* unreadable */ }

  const runs = await runSummaries(dir)

  return {
    id: dirName,
    project,
    slug,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : slug,
    archived: Boolean(archive),
    archivedAt: archive?.archivedAt ?? null,
    kind: ['bug','feature','inquiry'].includes(meta.kind) ? meta.kind : null,
    // A supervisor inquiry (Phase 4): a question answered by an analysis run
    // that publishes nothing. Kept out of UI lists, never out of admission.
    ...(meta.kind === 'inquiry' ? { inquiry: meta.inquiry ?? {} } : {}),
    ...(meta.fromInquiry ? { fromInquiry: meta.fromInquiry } : {}),
    origin: meta.origin ?? null,
    // Who opened it (user@host) and the issue it came from (opened-by.mjs).
    openedBy: meta.openedBy ?? derivedOpenedBy(meta, project),
    report: meta.report ?? null,
    // Distinct from any run's status: an issue stays open while a run is paused,
    // blocked, failed or cancelled.
    status: ['open', 'resolved', 'abandoned'].includes(meta.status) ? meta.status : 'open',
    openedOn,
    openedAt: meta.openedAt ?? null,
    path: dir,
    // Where the issue is on disk now, for people to copy: its folder, or its
    // bundle once packed (`path` of a packed issue names the folder it had).
    location: dir,
    hasMetadata: Object.keys(meta).length > 0,
    // An explicit decision about the ISSUE, distinct from any run's outcome:
    // a run can complete its negotiated work and still leave the reported
    // problem in place. Set with evidence, by an operator or the supervisor.
    disposition: meta.disposition ?? null,
    // Execution ORDER, decided by a person or the supervisor — not severity, not
    // urgency inferred from the text. Absent means nobody has decided yet, and
    // that is reported as unset rather than defaulted, so a backlog that predates
    // the field does not silently acquire management decisions no one made.
    priority: currentPriority(meta.priorityHistory) ?? meta.priority ?? null,
    // Append-only: every decision, in the order they were taken.
    priorityHistory: Array.isArray(meta.priorityHistory) ? meta.priorityHistory : (meta.priority ? [meta.priority] : []),
    // Issues that must be settled first (issue-dependencies.mjs), or null.
    dependsOn: meta.dependsOn ?? null,
    archiveOverride: archive?.override ?? null,
    stepCount,
    runCount: runs.length,
    // The newest run, reduced to what a list can tag an issue with. Read from
    // persisted state, so a run driven by another process is described too.
    latestRun: runs[0] ?? null
  }
}

const LIVE_RUN = ['pending', 'preflighting', 'running', 'stopping', 'paused']

/*
 * Run summaries by run.json path, reused while the file's mtime and size are
 * unchanged. Every list and overview request used to parse every run.json of
 * every issue (up to megabytes each); a summary depends only on run.json and on
 * the last step's output, which is written once before the step is recorded, so
 * an unchanged run.json means an unchanged summary.
 */
const summaryCache = new Map()
const SUMMARY_CACHE_LIMIT = 5000

/**
 * Every run under an issue, newest first, as list-sized summaries.
 * A half-written run directory is not a run and is skipped.
 */
async function runSummaries (dir) {
  let names = []
  try {
    names = (await fs.readdir(path.join(dir, 'runs'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
      .map((e) => e.name)
  } catch { return [] }
  const out = []
  for (const runId of names) {
    const file = path.join(dir, 'runs', runId, 'run.json')
    let stat
    try { stat = await fs.stat(file) } catch { continue }
    const cached = summaryCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { out.push(cached.summary); continue }
    let run
    try { run = JSON.parse(await fs.readFile(file, 'utf8')) } catch { continue }
    // The disposition the run detail shows, derived the same way: a triage that
    // judged the playbook unfit is "rejected", not merely unresolved.
    const last = run.steps?.at?.(-1)
    const outputs = {}
    if (last) {
      try { outputs[last.number] = JSON.parse(await fs.readFile(path.join(dir, 'runs', runId, 'outputs', `${last.number}.json`), 'utf8')) } catch { /* no output */ }
    }
    const disposition = runResult(run, outputs)
    const summary = {
      runId: run.runId ?? runId,
      status: run.status ?? null,
      outcome: run.outcome ?? null,
      result: disposition.result ?? null,
      resultReason: disposition.resultReason ?? null,
      resultLabel: disposition.resultLabel ?? null,
      blockedReason: run.blockedReason ?? null,
      playbook: run.playbook?.id ?? null,
      intent: run.playbook?.intent ?? null,
      live: LIVE_RUN.includes(run.status),
      recoveryRequired: run.blockedReason === 'recovery-required' || run.recovery?.required === true,
      workspaceRetained: run.workspace?.state === 'retained',
      delivered: Boolean(run.delivery?.completedAt),
      startedAt: run.startedAt ?? null,
      endedAt: run.endedAt ?? null,
      // When the run last changed state: how long something has been waiting.
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      pauseQuestion: run.status === 'paused' ? (run.pause?.question ?? null) : null,
      // Triage asked the owner before starting work (runtime/engine.mjs ask-owner).
      ownerInput: run.ownerInput ? { verdict: run.ownerInput.verdict, questions: (run.ownerInput.questions ?? []).map((q) => q.question), parts: run.ownerInput.split?.length ?? 0, answered: Boolean(run.ownerInput.answer) } : null,
      recoveryReason: run.recovery?.required ? (run.recovery.reason ?? null) : null,
      // Only the last output is read here, which is where a closing
      // confirmation sits; the run page reads them all.
      explanation: explainRun(run, { outputs })
    }
    if (summaryCache.size >= SUMMARY_CACHE_LIMIT) summaryCache.delete(summaryCache.keys().next().value)
    summaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary })
    out.push(summary)
  }
  return out.sort((a, b) => ((a.startedAt ?? '') < (b.startedAt ?? '') ? 1 : -1))
}

/** One project's issues, newest first. */
export async function listIssues (project, { archived = false } = {}) {
  await requireProject(project)

  let entries
  try {
    entries = await fs.readdir(path.join(ISSUES_DIR, project), { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const issues = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => readIssue(project, entry.name))
  )

  // Family links are read across both tabs, so an active child still names its archived parent.
  const family = families(issues.filter(Boolean), project)
  // Archiving packs an issue out of the folders: a parent missing here is looked up on its own, so a child can
  // still name it. Only missing parents are read; the whole archive is not.
  for (const parent of new Set([...family.values()].filter((f) => f.parent && !f.parent.known && f.parent.project === project).map((f) => f.parent.id))) {
    const packed = ISSUE_PATTERN.test(parent) ? await packedSummary(ISSUES_DIR, project, parent).catch(() => null) : null
    if (!packed) continue
    for (const f of family.values()) if (f.parent?.id === parent && f.parent.project === project) Object.assign(f.parent, { known: true, name: packed.issue?.name ?? null, packed: true })
  }
  const listed = issues.filter(Boolean).filter((issue) => issue.archived === archived).map((issue) => ({ ...issue, family: family.get(`${project}/${issue.id}`) }))
  if (archived) {
    // Packed issues are no longer folders here; their summaries stand in.
    const present = new Set(listed.map((i) => i.id))
    for (const summary of await packedSummaries(ISSUES_DIR, project)) {
      if (!present.has(summary.issue.id)) listed.push({ ...summary.issue, archived: true, packed: true, location: bundleFiles(ISSUES_DIR, project, summary.issue.id).bundle, bundle: summary.bundle ?? null })
    }
  }
  return listed.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * One issue's family (issue-family.mjs) with every member described, packed issues included, so the issue
 * page can show children and prerequisites a list scan leaves nameless. A cross-project parent or
 * prerequisite is read on its own; one that cannot be read is listed by id with `missing: true`.
 */
export async function issueFamily (project, id) {
  const issue = await getIssue(project, id)
  const all = [...await listIssues(project), ...await listIssues(project, { archived: true })]
  if (!all.some((i) => i.id === id)) all.push(issue)
  const links = families(all, project).get(`${project}/${id}`)
  const named = new Map(all.map((i) => [`${i.project ?? project}/${i.id}`, i]))
  const describe = async (p, i) => {
    const found = named.get(`${p}/${i}`) ?? await getIssue(p, i).catch(() => null)
    return found ? brief({ project: p, ...found }) : { project: p, id: i, missing: true }
  }
  const from = issue.openedBy?.from
  return {
    parent: from?.issueId ? { ...await describe(from.project ?? project, from.issueId), via: from.via, runId: from.runId ?? null } : null,
    children: await Promise.all(links.children.map((c) => describe(project, c))),
    dependsOn: await Promise.all((issue.dependsOn?.issues ?? []).map((d) => describe(d.project, d.id))),
    dependsOnReason: issue.dependsOn?.reason ?? null,
    blocks: await Promise.all(all.filter((i) => (i.dependsOn?.issues ?? []).some((d) => d.project === project && d.id === id)).map((i) => describe(project, i.id)))
  }
}

/**
 * One run's record, wherever the issue is: `runs/<runId>/run.json` while the
 * issue is unpacked, the bundle's run records once it is packed. Null when
 * there is none.
 */
export async function readRunRecord (project, issueId, runId) {
  if (!ISSUE_PATTERN.test(issueId) || !/^[A-Za-z0-9._-]+$/.test(runId ?? '')) return null
  const dir = path.join(ISSUES_DIR, project, issueId)
  const unpacked = await fs.readFile(path.join(dir, 'runs', runId, 'run.json'), 'utf8').then(JSON.parse, () => null)
  if (unpacked) return unpacked
  return (await packedRuns(ISSUES_DIR, project, issueId)).find((r) => r?.runId === runId) ?? null
}

/** Every run record of an issue, wherever it is: its runs/ while unpacked, the bundle's once packed. */
export async function readRunRecords (project, issueId) {
  if (!ISSUE_PATTERN.test(issueId)) return []
  const runsDir = path.join(ISSUES_DIR, project, issueId, 'runs')
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => null)
  if (!entries) return (await packedRuns(ISSUES_DIR, project, issueId)).filter(Boolean)
  const records = await Promise.all(entries.filter((e) => e.isDirectory() && !/^(worktree|workspace)-/.test(e.name))
    .map((e) => fs.readFile(path.join(runsDir, e.name, 'run.json'), 'utf8').then(JSON.parse, () => null)))
  return records.filter(Boolean)
}

/** Open an issue against a project. Both the project and the name are required. */
export async function createIssue (project, { name, input, fromInquiry = null, openedBy = null, reportOrigin = null } = {}) {
  // An issue made from an inquiry's proposal came from that inquiry, whoever asked.
  const opener = openedByRecord({ ...(openedBy ?? { user: 'unknown' }), ...(fromInquiry && !openedBy?.from ? { from: { project, issueId: fromInquiry.inquiryId, runId: fromInquiry.runId, via: 'inquiry' } } : {}) })
  // An issue made from an inquiry's proposal names where it came from; the
  // same proposal cannot become two issues.
  if (fromInquiry !== null) {
    const { inquiryId, runId, key } = fromInquiry ?? {}
    if (![inquiryId, runId, key].every((v) => typeof v === 'string' && v.trim())) throw new IssueError('fromInquiry needs inquiryId, runId and key')
    // An answered inquiry packs itself once its run has settled, so the
    // proposal is usually read from the bundle, not from a run directory.
    const inquiry = await getIssue(project, inquiryId).catch(() => null)
    if (!inquiry || inquiry.kind !== 'inquiry') throw new IssueError(`${inquiryId} is not an inquiry of this project`, 404)
    const run = await readRunRecord(project, inquiryId, runId)
    if (!run) throw new IssueError(`no run ${runId} on inquiry ${inquiryId}`, 404)
    if (!(run.reportDisposition?.proposals ?? []).some((p) => p.key === key)) throw new IssueError(`run ${runId} proposed no finding "${key}"`, 404)
    const same = (f) => f && f.inquiryId === inquiryId && f.runId === runId && f.key === key
    for (const entry of await fs.readdir(path.join(ISSUES_DIR, project), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !ISSUE_PATTERN.test(entry.name)) continue
      const meta = await fs.readFile(path.join(ISSUES_DIR, project, entry.name, META_FILE), 'utf8').then(JSON.parse, () => null)
      if (same(meta?.fromInquiry)) throw new IssueError(`the proposal "${key}" of ${inquiryId} is already issue ${entry.name}`, 409)
    }
    // A derived issue that was archived and packed still counts.
    for (const summary of await packedSummaries(ISSUES_DIR, project)) {
      if (same(summary.issue?.fromInquiry)) throw new IssueError(`the proposal "${key}" of ${inquiryId} is already issue ${summary.issue.id} (archived)`, 409)
    }
  }
  await requireProject(project)
  let report = null
  let sourcePath = null
  if (input !== undefined) {
    if (typeof input !== 'string' || !input.trim()) throw new IssueError('Enter a title, report, or local .md path')
    const value = input.trim()
    if (!value.includes('\n') && (/^(?:\/|\.\.?\/|~\/)/.test(value) || /\.md$/i.test(value))) {
      if (!/\.md$/i.test(value)) throw new IssueError('The local file must have a .md extension')
      sourcePath = path.resolve(projectSourceDir(project, PROJECTS_DIR), value.startsWith('~/') ? path.join(process.env.HOME, value.slice(2)) : value)
      let handle
      try {
        handle = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK)
        const stat = await handle.stat()
        if (!stat.isFile()) throw new IssueError('The path must reference a regular Markdown file')
        if (stat.size > 1024 * 1024) throw new IssueError('Report exceeds 1 MiB')
        report = await handle.readFile('utf8')
      } catch (error) {
        if (error instanceof IssueError) throw error
        throw new IssueError(`Cannot read Markdown file: ${error.code ?? error.message}`)
      } finally { await handle?.close() }
    } else if (/[\r\n]/.test(value)) report = input
    else name = value
    if (report !== null) {
      if (!report.trim()) throw new IssueError('The report is empty')
      const lines = report.split(/\r?\n/)
      name = (lines.find((line) => /^#{1,6}\s+\S/.test(line)) ?? lines.find((line) => line.trim())).replace(/^#{1,6}\s+/, '').trim()
    }
  }
  if (report !== null && Buffer.byteLength(report) > 1024 * 1024) throw new IssueError('Report exceeds 1 MiB')
  const { name: finalName, slug } = requireName(name, 'an issue', Infinity)

  const openedAt = new Date()
  const dirName = `${today(openedAt)}-${slug}`
  const projectDir = path.join(ISSUES_DIR, project)
  const dir = path.join(projectDir, dirName)

  await fs.mkdir(projectDir, { recursive: true })

  try {
    // Fails if it already exists, which is how uniqueness is enforced.
    await fs.mkdir(dir)
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new IssueError(`"${slug}" was already opened against this project today`, 409)
    }
    throw err
  }

  const record = {
    name: finalName,
    ...(sourcePath ? { sourcePath } : {}),
    ...(fromInquiry ? { fromInquiry: { inquiryId: fromInquiry.inquiryId, runId: fromInquiry.runId, key: fromInquiry.key } } : {}),
    slug,
    project,
    status: 'open',
    openedOn: today(openedAt),
    openedAt: openedAt.toISOString(),
    openedBy: opener,
    // From POST /api/report (report.mjs): {kind, category, reporter, trust}; bounds the supervisor (reporters.mjs).
    ...(reportOrigin ? { report: reportOrigin } : {})
  }

  try {
    if (report !== null) {
      await fs.mkdir(path.join(dir, '000-report'))
      await fs.writeFile(path.join(dir, '000-report', 'response.md'), report, 'utf8')
    }
    await fs.writeFile(path.join(dir, META_FILE), JSON.stringify(record, null, 2) + '\n', 'utf8')
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true })
    throw error
  }

  return readIssue(project, dirName)
}

/**
 * An inquiry (Phase 4): a technical question the supervisor asks without
 * opening a full issue ticket. Stored as an issue with `kind: "inquiry"` whose
 * report is the question, answered by an analysis run that publishes nothing.
 */
export async function createInquiry (project, { question, relatedIssue = null, createdBy = 'supervisor', openedBy = null } = {}) {
  if (typeof question !== 'string' || !question.trim()) throw new IssueError('an inquiry needs a question')
  if (!['supervisor', 'operator'].includes(createdBy)) throw new IssueError('createdBy must be supervisor or operator')
  if (relatedIssue !== null) {
    if (typeof relatedIssue !== 'string' || !ISSUE_PATTERN.test(relatedIssue)) throw new IssueError('relatedIssue must be an issue id of this project')
    const related = await fs.stat(path.join(ISSUES_DIR, project, relatedIssue)).then((st) => st.isDirectory(), () => false)
    if (!related && !await packedSummary(ISSUES_DIR, project, relatedIssue)) throw new IssueError(`related issue ${relatedIssue} does not exist in ${project}`, 404)
  }
  const title = question.trim().split(/\r?\n/)[0].replace(/^#{1,6}\s+/, '').slice(0, 80)
  const report = `# Inquiry: ${title}\n\n${question.trim()}\n${relatedIssue ? `\nRelated issue: ${relatedIssue} (read it; do not change it).\n` : ''}\nThis is an inquiry: answer the question with evidence. Findings are proposals for the supervisor; nothing is published as an issue.\n`
  const created = await createIssue(project, { input: report, openedBy: openedBy ?? { user: createdBy } })
  const file = path.join(created.path, META_FILE)
  const meta = JSON.parse(await fs.readFile(file, 'utf8'))
  meta.kind = 'inquiry'
  meta.inquiry = { question: question.trim(), relatedIssue, createdBy, createdAt: new Date().toISOString(), closure: null, history: [] }
  await writeJson(file, meta)
  return readIssue(project, created.id)
}

/** Record or remove an inquiry's closure. Callers hold the project's admission lock. */
export async function setInquiryClosure (project, id, closure, { reopenedBy = null, reason = null } = {}) {
  const dir = await issueDir(project, id)
  const file = path.join(dir, META_FILE)
  const meta = JSON.parse(await fs.readFile(file, 'utf8'))
  if (meta.kind !== 'inquiry') throw new IssueError(`${id} is not an inquiry`, 409)
  meta.inquiry ??= {}
  // A reopen keeps the closure it removes, with who reopened it and why.
  if (meta.inquiry.closure && closure === null) meta.inquiry.history = [...(meta.inquiry.history ?? []), { ...meta.inquiry.closure, reopened: { by: reopenedBy, reason, at: new Date().toISOString() } }]
  meta.inquiry.closure = closure
  await writeJson(file, meta)
  return readIssue(project, id)
}

// --- steps -----------------------------------------------------------------

async function issueDir (project, id) {
  await requireProject(project)

  if (typeof id !== 'string' || !ISSUE_PATTERN.test(id)) {
    throw new IssueError('no such issue', 404)
  }

  const dir = path.join(ISSUES_DIR, project, id)
  // Belt and braces: the resolved path must still sit under the project folder.
  if (path.dirname(path.resolve(dir)) !== path.resolve(path.join(ISSUES_DIR, project))) {
    throw new IssueError('no such issue', 404)
  }

  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) throw new IssueError('no such issue', 404)
  } catch (err) {
    if (err instanceof IssueError) throw err
    // Packed out of the folder by archiving: it exists, and refuses changes
    // exactly as an archived folder does.
    if (await packedSummary(ISSUES_DIR, project, id)) {
      throw Object.assign(new IssueError('This issue is archived. Restore it before making changes.', 409), { packed: true })
    }
    throw new IssueError('no such issue', 404)
  }

  return dir
}

async function readStep (dir, entryName) {
  const [, number, slug] = STEP_PATTERN.exec(entryName)
  const stepDir = path.join(dir, entryName)

  let files = []
  try {
    const entries = await fs.readdir(stepDir, { withFileTypes: true })
    files = await Promise.all(entries.map(async (entry) => {
      let size = null
      let modified = null
      try {
        const stat = await fs.stat(path.join(stepDir, entry.name))
        size = stat.isFile() ? stat.size : null
        modified = stat.mtimeMs
      } catch { /* vanished mid-read */ }
      return { name: entry.name, directory: entry.isDirectory(), size, modified }
    }))
    files.sort((a, b) => a.name.localeCompare(b.name))
  } catch { /* unreadable step folder */ }

  return {
    id: entryName,
    number,
    slug,
    name: slug.replace(/-/g, ' '),
    path: stepDir,
    files
  }
}

/** Steps in order — the number is the order they were taken in. */
export async function listSteps (project, id) {
  const dir = await issueDir(project, id)

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const [steps, owners] = await Promise.all([
    Promise.all(entries
      .filter((entry) => entry.isDirectory() && STEP_PATTERN.test(entry.name))
      .map((entry) => readStep(dir, entry.name))),
    stepOwners(dir)
  ])

  // Which run a step belongs to — its turns, and its result entry — so the
  // folder can be read run by run. A step no run claims (the report, notes,
  // answers) has none.
  return steps.map((step) => ({ ...step, run: owners.get(step.number) ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/*
 * Step number → the run it belongs to. Read from the runs' own records (the
 * step folders hold only what was said, by design), plus each run's result
 * entry, recognised by its reservation key. Cached per run.json version.
 */
const ownerCache = new Map()
async function stepOwners (dir) {
  const owners = new Map()
  let names = []
  try {
    names = (await fs.readdir(path.join(dir, 'runs'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-')).map((e) => e.name)
  } catch { /* no runs */ }
  for (const runId of names) {
    const file = path.join(dir, 'runs', runId, 'run.json')
    let stat
    try { stat = await fs.stat(file) } catch { continue }
    let cached = ownerCache.get(file)
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      let run
      try { run = JSON.parse(await fs.readFile(file, 'utf8')) } catch { continue }
      const playbook = run.playbook?.title ?? run.playbook?.id ?? null
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, runId, playbook, startedAt: run.startedAt ?? null,
        steps: (run.steps ?? []).map((st) => [String(st.number).padStart(3, '0'), st.role ?? null]) }
      if (ownerCache.size >= SUMMARY_CACHE_LIMIT) ownerCache.delete(ownerCache.keys().next().value)
      ownerCache.set(file, cached)
    }
    for (const [number, role] of cached.steps) owners.set(number, { runId, playbook: cached.playbook, startedAt: cached.startedAt, role, kind: role === 'operator' ? 'answer' : 'turn' })
  }
  let reservations = []
  try { reservations = JSON.parse(await fs.readFile(path.join(dir, '.step-reservations.json'), 'utf8')) } catch { /* none */ }
  for (const r of Array.isArray(reservations) ? reservations : []) {
    const m = /^run-result:(.+)$/.exec(r?.invocationId ?? '')
    if (!m) continue
    const turn = [...owners.values()].find((o) => o.runId === m[1])
    owners.set(String(r.number).padStart(3, '0'), { runId: m[1], playbook: turn?.playbook ?? null, startedAt: turn?.startedAt ?? null, role: null, kind: 'result' })
  }
  return owners
}

/** One issue with its steps, or a 404. */
export async function getIssue (project, id) {
  try { await issueDir(project, id) } catch (error) {
    // Archived issues are packed out of the project folder; they are read from
    // their summary (issue-bundle.mjs) until restored.
    if (!error.packed) throw error
    return describePacked(await packedSummary(ISSUES_DIR, project, id))
  }
  const issue = await readIssue(project, id)
  if (!issue) throw new IssueError('no such issue', 404)
  return { ...issue, steps: await listSteps(project, id) }
}

/** A packed issue, described the way the lists and pages describe any issue. */
function describePacked (summary) {
  return {
    ...summary.issue,
    archived: true,
    packed: true,
    location: bundleFiles(ISSUES_DIR, summary.issue.project, summary.issue.id).bundle,
    steps: [],
    archive: { packedAt: summary.packedAt ?? null, bundle: summary.bundle ?? null, runs: summary.runs ?? [], results: summary.results ?? [] }
  }
}

/** Archive/restore without moving or deleting any of the issue's files. */
export const DISPOSITIONS = ['resolved', 'partially-resolved', 'split', 'duplicate', 'declined', 'not-reproducible', 'superseded', 'not-resolved']
// Dispositions that are a statement about OTHER issues name them: a split
// without its parts, or a duplicate without its original, cannot be followed.
const RELATED_REQUIRED = { split: 'the issues it was split into', duplicate: 'the issue it duplicates' }

/*
 * Priority is execution order, and only that.
 *
 * It is deliberately not severity, not customer impact, not a deadline and not
 * blocked-ness: those are separate facts that a single scalar flattens into
 * something nobody can act on. What it answers is one question — what should be
 * worked on before what — and it carries who decided, when, and why, because an
 * ordering without a reason is an assertion nobody can review.
 */
export const PRIORITIES = ['urgent', 'high', 'normal', 'low']
export const DEFAULT_PRIORITY = 'normal'

/**
 * Record what the issue's state IS, with evidence, separately from what any
 * run did. `runId` ties the decision to the run whose closure it rests on;
 * that run's unaccepted residual risks are copied as `openRisks`, so a
 * "resolved" that leaves risks open is visibly contradictory.
 */
export async function setIssueDisposition (project, id, { value, evidence, runId = null, by = 'operator', override = null, related = null } = {}) {
  if ((await readIssue(project, id).catch(() => null))?.kind === 'inquiry') throw new IssueError('an inquiry has no disposition; close or acknowledge it', 409)
  if (!DISPOSITIONS.includes(value)) throw new IssueError(`disposition must be one of ${DISPOSITIONS.join(', ')}`)
  if (typeof evidence !== 'string' || !evidence.trim()) throw new IssueError('a disposition needs evidence: say what was checked')
  if (!['operator', 'supervisor'].includes(by)) throw new IssueError('by must be operator or supervisor')
  const dir = await issueDir(project, id)
  const links = await relatedIssues(project, id, value, related)

  // The run the decision rests on: the one named, else the newest with a
  // closure record. Omitting the run is not a way around its residuals.
  const summaries = await runSummaries(dir)
  let runRecord = null
  if (runId) {
    try { runRecord = JSON.parse(await fs.readFile(path.join(dir, 'runs', runId, 'run.json'), 'utf8')) } catch { throw new IssueError(`no run ${runId} on this issue`, 404) }
  } else {
    for (const s of summaries) {
      try { const r = JSON.parse(await fs.readFile(path.join(dir, 'runs', s.runId, 'run.json'), 'utf8')); if (r.closure) { runRecord = r; runId = s.runId; break } } catch { /* skip */ }
    }
  }
  const openRisks = (runRecord?.closure?.residualRisks ?? []).filter((r) => r.accepted === false).map((r) => ({ description: r.description, relatesTo: r.relatesTo ?? null }))
  let overrideRecord = null
  if (value === 'resolved' && openRisks.length) {
    // Only an operator may override, and only by saying why, on the record.
    if (by !== 'operator' || typeof override !== 'string' || !override.trim()) {
      throw new IssueError(`run ${runId} left ${openRisks.length} residual risk(s) unaccepted; "resolved" contradicts them — choose partially-resolved, accept them on the record first, or (operator only) override with a stated reason`, 409)
    }
    overrideRecord = { reason: override.trim(), openRisksAtOverride: openRisks.length }
  }
  const file = path.join(dir, META_FILE)
  let meta = {}
  try { meta = JSON.parse(await fs.readFile(file, 'utf8')) } catch { meta = {} }
  meta.disposition = { value, evidence: evidence.trim(), runId: runId ?? null, by, at: new Date().toISOString(), openRisks, override: overrideRecord, related: links }
  await writeJson(file, meta)
  return getIssue(project, id)
}

/**
 * The issues a disposition names, each proven to exist: `<id>` in the same
 * project, or `<project>/<id>` in another. Never the issue itself. A duplicate
 * names exactly one original.
 */
async function relatedIssues (project, id, value, related) {
  if (related === null || related === undefined) related = []
  if (!Array.isArray(related) || related.some((r) => typeof r !== 'string' || !r.trim())) throw new IssueError('related must be a list of issue ids')
  if (RELATED_REQUIRED[value] && !related.length) throw new IssueError(`a ${value} disposition names ${RELATED_REQUIRED[value]} in related`)
  if (value === 'duplicate' && related.length !== 1) throw new IssueError('a duplicate names exactly one original issue')
  const out = []
  for (const ref of new Set(related.map((r) => r.trim()))) {
    const [p, i] = ref.includes('/') ? ref.split('/', 2) : [project, ref]
    if (p === project && i === id) throw new IssueError('a disposition cannot name its own issue as related')
    await issueDir(p, i).catch(() => { throw new IssueError(`related issue ${ref} does not exist`, 404) })
    out.push({ project: p, id: i })
  }
  return out
}

/**
 * Set an issue's place in the execution order.
 *
 * Operators and the supervisor may both decide it; a coordinator may recommend
 * one in its result and never write one, because the order of the company's work
 * is not a thing a run gets to change from inside itself.
 */
export async function setIssuePriority (project, id, { value, reason, by = 'operator' } = {}) {
  if ((await readIssue(project, id).catch(() => null))?.kind === 'inquiry') throw new IssueError('an inquiry has no priority', 409)
  if (!PRIORITIES.includes(value)) throw new IssueError(`priority must be one of ${PRIORITIES.join(', ')}`)
  if (typeof reason !== 'string' || !reason.trim()) throw new IssueError('a priority needs a reason: say why this order')
  if (!['operator', 'supervisor'].includes(by)) throw new IssueError('by must be operator or supervisor')
  const dir = await issueDir(project, id)
  const file = path.join(dir, META_FILE)
  let meta = {}
  try { meta = JSON.parse(await fs.readFile(file, 'utf8')) } catch { meta = {} }

  // The TRAIL is the record, and it only ever grows. Keeping one "previous"
  // value would mean every reordering quietly erased the one before it, and the
  // question a manager actually asks — how often has this moved, and who kept
  // moving it — would have no answer on disk.
  const history = Array.isArray(meta.priorityHistory) ? [...meta.priorityHistory] : []
  // A decision written before the trail existed is not lost to it.
  if (!history.length && meta.priority) history.push({ value: meta.priority.value, reason: meta.priority.reason ?? null, by: meta.priority.by ?? null, at: meta.priority.at ?? null })
  history.push({ value, reason: reason.trim(), by, at: new Date().toISOString() })
  meta.priorityHistory = history
  meta.priority = currentPriority(history)
  await writeJson(file, meta)
  return getIssue(project, id)
}

/** The decision in force, and the one it replaced, derived from the trail. */
function currentPriority (history) {
  if (!Array.isArray(history) || !history.length) return null
  const current = history[history.length - 1]
  const previous = history[history.length - 2] ?? null
  return {
    ...current,
    previous: previous ? { value: previous.value, at: previous.at, by: previous.by } : null,
    changes: history.length
  }
}

/**
 * One follow-up issue per residual risk the closing coordinator did not
 * accept, linked back to the run, deduplicated by the risk's position in the
 * closure record. The original issue keeps its own disposition: a follow-up
 * tracks work that remains, it never absorbs the defect that was reported.
 */
export async function createFollowUps (project, id, runId, { by = null } = {}) {
  const dir = await issueDir(project, id)
  const runFile = path.join(dir, 'runs', runId, 'run.json')
  let run
  try { run = JSON.parse(await fs.readFile(runFile, 'utf8')) } catch { throw new IssueError(`no run ${runId} on this issue`, 404) }
  const risks = run.closure?.residualRisks ?? []
  if (!run.closure) throw new IssueError('the run has no closure record yet', 409)
  const existing = run.closure.followUps ?? []
  const created = []
  for (let index = 0; index < risks.length; index++) {
    const risk = risks[index]
    if (risk.accepted !== false) continue
    const already = existing.find((f) => f.riskIndex === index)
    if (already) { created.push({ ...already, existing: true }); continue }
    const title = `Follow-up: ${risk.description.replace(/\s+/g, ' ').trim().slice(0, 70)}`
    const report = [
      `# ${title}`, '',
      `Residual risk left unaccepted at the closure of run \`${runId}\` on issue \`${id}\`${risk.relatesTo ? ` (relates to ${risk.relatesTo})` : ''}.`, '',
      '## Risk as recorded', '', risk.description, '',
      '## Provenance', '',
      `- Source issue: ${id}`, `- Run: ${runId}`, `- Closing revision: ${run.closure.revision ?? 'none'}`, `- Recorded at: ${run.closure.at ?? 'unknown'}`, '',
      'This follow-up tracks remaining work. The source issue keeps its own disposition; nothing here changes what was or was not fixed there.', ''
    ].join('\n')
    let issue
    try {
      issue = await createIssue(project, { input: report, openedBy: { ...(by ?? { user: 'unknown' }), from: { project, issueId: id, runId, via: 'follow-up' } } })
    } catch (error) {
      if (error.status === 409) { created.push({ riskIndex: index, issueId: null, skipped: 'an issue with this name was already opened today' }); continue }
      throw error
    }
    const record = { riskIndex: index, issueId: issue.id, createdAt: new Date().toISOString() }
    existing.push(record)
    created.push(record)
  }
  run.closure.followUps = existing
  await writeJson(runFile, run)
  return { runId, followUps: created }
}

/**
 * Archive hides an issue; it is not a statement about it. Archiving without a
 * disposition is always possible from the panel; it is recorded as an override
 * on the archive record, with the reason when one was given. The supervisor's
 * own rule (a disposition first) lives in the supervisor, not here.
 */
export async function setIssueArchived (project, id, archived, { overrideReason = null } = {}) {
  await requireProject(project)
  if (!archived && ISSUE_PATTERN.test(String(id)) && await packedSummary(ISSUES_DIR, project, id)) {
    // Restore a packed issue: unpack it, then it is an ordinary archived
    // folder, and the marker comes off as for any restore.
    await unpackIssue({ issuesDir: ISSUES_DIR, project, id })
  }
  // Archiving what is already packed is a repeat, and harmless.
  if (archived && ISSUE_PATTERN.test(String(id)) && !await fs.stat(path.join(ISSUES_DIR, project, id)).then(() => true, () => false) &&
      await packedSummary(ISSUES_DIR, project, id)) return getIssue(project, id)
  const result = await markArchived(project, id, archived, { overrideReason })
  if (!archived) return result
  await packArchived(project, id)
  return getIssue(project, id)
}

/**
 * Pack an archived issue out of the project folder (issue-bundle.mjs). Done
 * after the archive marker is written and the issue's locks are released: the
 * marker already refuses new runs and steps, and the locks live in the folder
 * that is about to go.
 */
export async function packArchived (project, id) {
  const dir = await issueDir(project, id)
  if (!await archiveState(dir)) throw new IssueError('Only an archived issue is packed.', 409)
  await requireCleanupRecorded(dir, 'packing this issue')
  const issue = await readIssue(project, id)
  let released = null
  const summary = await packIssue({
    issuesDir: ISSUES_DIR, project, id,
    issue: { ...issue, runs: await runSummaries(dir) },
    releaseWorktrees: async (paths) => { released = await releaseWorktrees(dir, project, { only: paths }) }
  })
  if (released?.pruned) await git('git', ['-C', released.projectPath, 'worktree', 'prune']).catch(() => {})
  return summary
}

/*
 * An in-place run's unproved cleanup outlives its run record only in the
 * project barrier file (reconcile reads active issues alone). An open entry the
 * file does not hold — its write failed — would be dropped by archiving,
 * packing or deleting the issue, so each is refused instead.
 */
async function requireCleanupRecorded (dir, verb) {
  for (const name of await fs.readdir(path.join(dir, 'runs')).catch(() => [])) {
    if (name.startsWith('worktree-') || name.startsWith('workspace-')) continue
    const run = await fs.readFile(path.join(dir, 'runs', name, 'run.json'), 'utf8').then(JSON.parse, () => null)
    if ((await unrecordedCleanup(path.dirname(dir), run)).length) throw new IssueError(unrecordedRefusal(run, verb), 409)
  }
}

async function markArchived (project, id, archived, { overrideReason = null } = {}) {
  const dir = await issueDir(project, id)
  return withLock(path.join(dir, '.run.lock'), { purpose: 'issue-archive', takeOverDead: false }, async () => {
    return withLock(path.join(dir, '.step-alloc.lock'), { purpose: 'issue-archive', waitMs: 10000 }, async () => {
      if (archived) {
        if (await archiveState(dir)) return getIssue(project, id)   // already archived: repeat is harmless
        let meta = {}
        try { meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8')) } catch { meta = {} }
        // Archive preserves every existing file in place; the override lives in
        // the archive record itself, the one file archiving creates.
        let archiveOverride = null
        if (!meta.disposition) {
          const reason = typeof overrideReason === 'string' && overrideReason.trim() ? overrideReason.trim() : null
          archiveOverride = { reason }
        }
        let runs = []
        try { runs = await fs.readdir(path.join(dir, 'runs'), { withFileTypes: true }) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        for (const entry of runs.filter((e) => e.isDirectory())) {
          let run
          try { run = JSON.parse(await fs.readFile(path.join(dir, 'runs', entry.name, 'run.json'), 'utf8')) } catch (error) {
            if (error.code === 'ENOENT') continue
            throw new IssueError('Run state could not be checked. Resolve it before archiving.', 409)
          }
          if (['pending', 'preflighting', 'running', 'stopping', 'paused'].includes(run.status) ||
              run.recovery?.required || run.blockedReason === 'recovery-required' ||
              Object.values(run.participants ?? {}).some((p) => p.pendingInvocation || p.state === 'recovery-required')) {
            throw new IssueError('Stop the active run and resolve any pending recovery before archiving this issue.', 409)
          }
        }
        await requireCleanupRecorded(dir, 'archiving this issue')
        {
          const file = path.join(dir, ARCHIVE_FILE)
          await writeJson(file, { archivedAt: new Date().toISOString(), ...(archiveOverride ? { override: archiveOverride } : {}) })
        }
      } else {
        await fs.rm(path.join(dir, ARCHIVE_FILE), { force: true })
      }
      return getIssue(project, id)
    })
  })
}

const git = promisify(execFile)

/**
 * Hand every git worktree living under `dir` back to the project that owns it.
 *
 * A run's workspace is a worktree of the HOST project, registered in that
 * repository's .git/worktrees. Deleting the issue folder on its own leaves the
 * registration behind — `git worktree list` in the project keeps reporting a
 * path that is not there any more. Since a blocked or cancelled run deliberately
 * keeps its worktree, an issue being deleted is quite likely to hold one.
 *
 * Removal first, prune afterwards: prune clears any registration whose directory
 * has gone, which covers whatever removal could not handle.
 */
async function releaseWorktrees (dir, project, { only = null } = {}) {
  const projectPath = await resolveProjectPath(project, { projectsDir: PROJECTS_DIR })
  const inside = only
    ? (p) => only.includes(p)
    : (p) => p === dir || p.startsWith(dir + path.sep)

  let listed = ''
  try {
    ({ stdout: listed } = await git('git', ['-C', projectPath, 'worktree', 'list', '--porcelain']))
  } catch {
    // Not a git repository, or unreadable: there is no registration to strip.
    return { pruned: false }
  }

  for (const line of listed.split(String.fromCharCode(10))) {
    if (!line.startsWith('worktree ')) continue
    const at = line.slice('worktree '.length).trim()
    if (!inside(at)) continue
    await git('git', ['-C', projectPath, 'worktree', 'remove', '--force', at]).catch(() => {})
  }
  return { projectPath, pruned: true }
}

/**
 * Delete an issue and everything under it, permanently.
 *
 * Gated behind archiving on purpose. Archive is the reversible step and already
 * refuses an issue with a live or recovery-required run, so delete never has to
 * reason about one — and nothing can be destroyed that was not first taken out
 * of the active lists deliberately.
 */
export async function deleteIssue (project, id) {
  await requireProject(project)
  if (ISSUE_PATTERN.test(String(id)) && await packedSummary(ISSUES_DIR, project, id) &&
      !await fs.stat(path.join(ISSUES_DIR, project, id)).then(() => true, () => false)) {
    const summary = await packedSummary(ISSUES_DIR, project, id)
    await deletePacked(ISSUES_DIR, project, id)
    await writeJson(path.join(ISSUES_DIR, project, '.deleted-issues', id + '.json'), { project, id, runIds: (summary.results ?? []).map((r) => r.runId), deletedAt: new Date().toISOString(), packed: true })
    return { project, id, deleted: true }
  }
  const dir = await issueDir(project, id)

  if (!await archiveState(dir)) {
    throw new IssueError('Archive this issue before deleting it. Archiving is reversible; deleting is not.', 409)
  }

  return withLock(path.join(dir, '.run.lock'), { purpose: 'issue-delete', takeOverDead: false }, async () => {
    await requireCleanupRecorded(dir, 'deleting this issue')
    const runIds = (await fs.readdir(path.join(dir,'runs')).catch(error=>{if(error.code==='ENOENT')return [];throw error})).filter(id=>!id.startsWith('worktree-')&&!id.startsWith('workspace-'))
    const released = await releaseWorktrees(dir, project)
    await fs.rm(dir, { recursive: true, force: true })
    await writeJson(path.join(path.dirname(dir),'.deleted-issues',id+'.json'), {project,id,runIds,deletedAt:new Date().toISOString()})
    // After the directory is gone, so every registration that pointed into it
    // is now prunable.
    if (released.pruned) {
      await git('git', ['-C', released.projectPath, 'worktree', 'prune']).catch(() => {})
    }
    return { project, id, deleted: true }
  })
}

const endWithNewline = (text) => (text.endsWith('\n') ? text : text + '\n')

/*
 * What a note may be written as.
 *
 * Every one of these is stored as bytes and served as a download, and shown in
 * the panel as text — including .html, which is never handed to the browser as
 * markup. The extension records what the author meant it to be; it does not
 * change how anything treats it.
 */
export const NOTE_FORMATS = { md: 'note.md', txt: 'note.txt', html: 'note.html' }

export function noteFilename (format) {
  const key = String(format ?? 'md').trim().toLowerCase().replace(/^\./, '')
  const file = NOTE_FORMATS[key]
  if (!file) {
    throw new IssueError(`unknown text format "${format}" — use ${Object.keys(NOTE_FORMATS).join(', ')}`, 400)
  }
  return file
}

/**
 * A reference someone added: a URL, or a path on a machine.
 *
 * Both are useful for different reasons. A link points at a ticket or a build; a
 * path points at the log or the directory the work is actually about, and since
 * the coordinator is told to read the issue folder, a path is often the more
 * directly usable of the two.
 *
 * What is refused is a scheme the browser would execute. `javascript:` and
 * `data:` in a list the panel renders is script injection with extra steps, so
 * the check happens here, where the value becomes durable, rather than relying on
 * every later reader to be careful.
 */
export function classifyReference (value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)
  if (scheme) {
    const name = scheme[1].toLowerCase()
    if (name === 'http' || name === 'https') {
      let parsed
      try { parsed = new URL(raw) } catch { throw new IssueError(`not a URL: ${raw}`, 400) }
      return { kind: 'url', href: parsed.href, label: parsed.hostname + parsed.pathname }
    }
    if (name === 'file') {
      // Recorded as the path it names: a file:// link is not followable from a
      // browser, but the path is exactly what an agent needs.
      let parsed
      try { parsed = new URL(raw) } catch { throw new IssueError(`not a URL: ${raw}`, 400) }
      return { kind: 'path', path: decodeURIComponent(parsed.pathname) }
    }
    throw new IssueError(
      `"${name}:" links cannot be added — use http, https, or a filesystem path`, 400)
  }

  // A path on some machine. Not checked for existence: the machine that matters
  // is often not this one, and a path that does not resolve here is still the
  // right thing to write down.
  if (raw.startsWith('/') || raw.startsWith('~/') || raw.startsWith('./') || raw.startsWith('../')) {
    return { kind: 'path', path: raw }
  }

  throw new IssueError(
    `cannot tell what "${raw}" refers to — give a full http(s) URL or an absolute path`, 400)
}

/** Links and paths, as markdown: links followable, paths as literal text. */
export function renderLinks (entries) {
  const lines = []
  for (const entry of entries) {
    const value = typeof entry === 'string' ? entry : entry?.url ?? entry?.path ?? ''
    const ref = classifyReference(value)
    if (!ref) continue
    if (ref.kind === 'url') {
      const label = String(entry?.label ?? '').trim() || ref.label
      lines.push(`- [${label.replace(/[[\]]/g, '')}](${ref.href})`)
    } else {
      // A path is written as code, not as a link: a browser cannot follow it, and
      // dressing it as something clickable would promise that it could.
      lines.push(`- \`${ref.path}\``)
    }
  }
  if (!lines.length) return ''
  const NL = String.fromCharCode(10)
  return `# Links and paths${NL}${NL}${lines.join(NL)}${NL}`
}

/** Bytes a single attachment may occupy. */
export const MAX_FILE_BYTES = Number(process.env.DEVPANEL_MAX_FILE_BYTES ?? 25 * 1024 * 1024)

/**
 * A filename that can only ever name a file inside the step folder.
 *
 * Rejected rather than rewritten: silently turning `../../etc/passwd` into
 * `etc_passwd` stores the file under a name the uploader never chose, and hides
 * that something tried.
 */
export function safeFilename (name) {
  const value = String(name ?? '').trim()
  if (!value) throw new IssueError('a filename is required', 400)
  if (value.length > 200) throw new IssueError('that filename is too long', 400)
  if (value === '.' || value === '..') throw new IssueError('invalid filename', 400)
  if (value.includes('/') || value.includes('\\')) throw new IssueError('a filename cannot contain a path', 400)
  // eslint-disable-next-line no-control-regex -- control characters in a filename are never legitimate
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new IssueError('invalid filename', 400)
  if (value.startsWith('.')) throw new IssueError('a filename cannot start with a dot', 400)
  return value
}

async function stepFolder (project, id, number) {
  const dir = await issueDir(project, id)
  const steps = await listSteps(project, id)
  const step = steps.find((s) => s.number === String(number))
  if (!step) throw new IssueError('no such step', 404)
  return { dir, folder: path.join(dir, step.id), step }
}

/** Attach a file to a step. */
export async function addStepFile (project, id, number, filename, bytes) {
  const safe = safeFilename(filename)
  const { dir, folder } = await stepFolder(project, id, number)
  await requireUnarchived(dir)

  if (!Buffer.isBuffer(bytes)) throw new IssueError('no file content was sent', 400)
  if (bytes.length === 0) throw new IssueError('that file is empty', 400)
  if (bytes.length > MAX_FILE_BYTES) {
    throw new IssueError(`that file is larger than the ${Math.round(MAX_FILE_BYTES / 1048576)}MB limit`, 413)
  }

  const target = path.join(folder, safe)
  // Belt and braces: the name was validated, and the resolved path is checked
  // against the folder it must not leave.
  if (path.dirname(path.resolve(target)) !== path.resolve(folder)) {
    throw new IssueError('invalid filename', 400)
  }

  await fs.writeFile(target, bytes)
  return readStep(dir, path.basename(folder))
}

/** Read one file out of a step, for download. */
export async function readStepFile (project, id, number, filename) {
  const safe = safeFilename(filename)
  const { folder } = await stepFolder(project, id, number)
  const target = path.join(folder, safe)
  if (path.dirname(path.resolve(target)) !== path.resolve(folder)) {
    throw new IssueError('invalid filename', 400)
  }
  try {
    const [bytes, stat] = await Promise.all([fs.readFile(target), fs.stat(target)])
    return { name: safe, bytes, size: stat.size }
  } catch {
    throw new IssueError('no such file', 404)
  }
}

/**
 * Add the next step. Numbering continues from the highest existing step, so
 * steps stay ordered even if an earlier one was renamed or removed by hand.
 */
/**
 * Allocate a step.
 *
 * Numbers are claimed by a durable RESERVATION, not merely by a folder existing.
 * Scanning folders alone means a reservation whose folder has not been created
 * yet is invisible, and the next writer takes the same number — producing
 * 000-audit-plan alongside 000-fix.
 *
 * `invocationId` makes the whole operation idempotent: a retry after a crash
 * resumes the same reservation instead of allocating again. Every path runs
 * under the shared allocation lock, including the resume.
 */
export async function createStep (project, id, {
  name, response = null, text = null, format = 'md', links = null, invocationId = null, onReserve = null
} = {}) {
  const dir = await issueDir(project, id)
  // Naming a note is work the author should not have to do to write one down.
  // Agent turns always carry a name; a person adding material need not.
  const { slug } = requireName(name?.trim() ? name : 'note', 'a step')
  const noteFile = text ? noteFilename(format) : null

  return withStepReservation(dir, {slug, invocationId, onReserve}, async entry => {
    const folder = path.join(dir, entry.folder)
    await fs.mkdir(folder, { recursive: true })

    // An agent's step holds its response and nothing else — execution metadata
    // lives under runs/<run-id>/, never in here. A step a person writes holds
    // what they put in it: a note, links, and attached files. The coordinator is
    // told to read the issue folder, so all of it reaches the work.
    if (response !== null) {
      await writeAtomic(path.join(folder, 'response.md'), response)
    }
    if (text) await fs.writeFile(path.join(folder, noteFile), endWithNewline(text), 'utf8')
    if (links?.length) await fs.writeFile(path.join(folder, 'links.md'), renderLinks(links), 'utf8')

    return readStep(dir, entry.folder)
  })
}
