import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * The triage pre-gate's questions, and how well its answers agree with what
 * Triage and the operator then did (rollout steps 2 and 3 of docs/decisions.md).
 *
 * The request is built here; pregate.mjs asks it before a Triage start and
 * links the record into the run (`runs/<run-id>/decisions/`), where
 * `triageAgreement` reads it. Agreement is how the threshold gets tuned.
 */

export const PURPOSE = 'triage-pregate'
/** The note a confirmed "needs input" hold adds. Never sent back as part of the report. */
export const HOLD_STEP = 'pregate-hold'

/** Bounds on what is sent, well under the provider's 32k-token limit. */
const MAX_FILE_CHARS = 8000
const MAX_REPORT_CHARS = 24000
const MAX_CANDIDATES = 254   // a choice takes 255 options, one of them is "none"
const MAX_TITLE_CHARS = 160

const GATE = {
  type: 'choice',
  instructions: 'An issue has been filed against a software project. Before anyone spends time investigating it, what should happen to it next?',
  criteria: {
    continue: 'The report describes an actionable defect or request with enough detail to investigate; it is worth a triage or implementation run.',
    'close-issue': 'The report duplicates an existing issue, is invalid or out of scope, or describes something that needs no change.',
    'needs-input': 'A specific missing fact (what happened, where, how to reproduce, what is wanted) prevents anyone from classifying the report; the reporter must be asked first.'
  }
}

/** The normal catalogue (docs/tactical-playbooks.md). Legacy ids are not offered. */
const PLAYBOOK = {
  type: 'choice',
  instructions: 'Which kind of run should do the work this issue asks for?',
  criteria: {
    analysis: 'Investigation only: the question is what is wrong or what should be done, answered with findings and follow-up issues; nothing is changed.',
    triage: 'A short check of whether a specific reported claim holds, before any work is planned.',
    implementation: 'A clear, bounded code or configuration change whose shape is already evident from the report.',
    'plan-and-implement': 'A change large or uncertain enough that a plan should be agreed and reviewed before it is implemented.',
    deployment: 'Release an already-made change: to the staging environment and test it there (the default), or promote a change already tested on staging to production.'
  }
}

/** Issue priority is execution order (issues.js PRIORITIES), not severity alone. */
const PRIORITY = {
  type: 'choice',
  instructions: 'In what order should this issue be worked on, relative to the rest of the project\'s backlog?',
  criteria: {
    urgent: 'Production is down, data is being lost or corrupted, or users are blocked now; before anything else.',
    high: 'A user-facing defect without a workaround, or something that blocks other work.',
    normal: 'A real defect or improvement that has a workaround or limited reach.',
    low: 'Cosmetic, speculative or nice to have.'
  }
}

/*
 * How much work the issue is: an ordered rubric, so the answer is a
 * distribution over the bands and a weighted level, not only a label. The bands
 * are the ones the operator asked for; the descriptions close the gaps between
 * them (3-4 h, 5-6 h) so every estimate falls in exactly one band. This is
 * advisory: it changes no proposal and gates nothing.
 */
export const WORK_TIME_BANDS = ['5–10 min', '10–20 min', '½–1 h', '1–2 h', '2–3 h', '4–5 h', '6 h+']
const WORK_TIME = {
  type: 'score',
  instructions: 'How much hands-on working time would an experienced developer who knows this codebase need to do what the issue asks, including verifying the result? Count working time only, not waiting or calendar time. If the report is too vague to do anything yet, estimate the work once it is clear.',
  criteria: [
    'At most about 10 minutes: a one-line or obvious change, or a quick answer.',
    'About 10 to 20 minutes: a small, local change with a quick check.',
    'About half an hour to an hour: a focused change in one area, with some reading and testing.',
    'About 1 to 2 hours: a change touching a few files or needing real investigation.',
    'About 2 to 3½ hours: a multi-part change, or a defect that must be reproduced and traced.',
    'About 3½ to 5½ hours: a substantial feature or a cross-cutting fix with careful verification.',
    'About 6 hours or more: a day of work or longer, a redesign, or several separable pieces of work.'
  ]
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters not sent]` : text)

/**
 * What is sent: the issue's title and every text report filed on it so far, and
 * the questions. The issue's current priority is deliberately NOT in the state:
 * it is one of the things being compared against.
 */
export async function triageRequest ({ issues, project, issueId }) {
  const issue = await issues.getIssue(project, issueId)
  const reports = []
  let budget = MAX_REPORT_CHARS
  for (const step of issue.steps ?? []) {
    if (step.slug === HOLD_STEP) continue
    for (const f of step.files ?? []) {
      if (budget <= 0 || f.directory || !/\.(md|txt)$/i.test(f.name)) continue
      let text
      try { text = (await issues.readStepFile(project, issueId, step.number, f.name)).bytes?.toString('utf8') } catch { continue }
      if (!text?.trim()) continue
      text = clip(text.trim(), Math.min(MAX_FILE_CHARS, budget))
      budget -= text.length
      reports.push({ step: step.number, file: f.name, text })
    }
  }

  // Duplicate candidates: this project's other issues, open ones first, then
  // archived ones (a report of something already fixed is a duplicate too).
  const list = async (archived) => { try { return await issues.listIssues(project, { archived }) } catch { return [] } }
  const others = [...await list(false), ...await list(true)]
    .filter((i) => i.id !== issueId)
    .slice(0, MAX_CANDIDATES)

  const questions = { gate: GATE, playbook: PLAYBOOK, priority: PRIORITY, workTime: WORK_TIME }
  if (others.length) {
    const criteria = { none: 'None of the listed issues reports the same problem or request.' }
    for (const other of others) {
      const notes = [`opened ${other.openedOn}`, other.archived ? 'archived' : null, other.status !== 'open' ? other.status : null].filter(Boolean).join(', ')
      criteria[other.id] = `${clip(other.name, MAX_TITLE_CHARS)} (${notes})`
    }
    questions.duplicateOf = {
      type: 'choice',
      instructions: 'Does this issue report the same problem or request as one of the project\'s existing issues? Choose that issue, or none.',
      criteria
    }
  }

  const state = {
    project,
    issue: { title: issue.name, kind: issue.kind ?? null, openedOn: issue.openedOn },
    reports
  }
  return { state, questions }
}

// ------------------------------------------------------------------ agreement

/** What Triage's own disposition says the pre-gate should have answered. */
export const GATE_OF_DISPOSITION = {
  accepted: 'continue',
  duplicate: 'close-issue',
  rejected: 'close-issue',
  'no-findings': 'close-issue',
  'needs-information': 'needs-input'
}

const readJson = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null } }

/** The one shadow record of a run, or null. */
async function shadowRecord (runPath) {
  let names = []
  try { names = await fs.readdir(path.join(runPath, 'decisions')) } catch { return null }
  const name = names.filter((n) => n.startsWith(`${PURPOSE}-`) && n.endsWith('.json')).sort()[0]
  return name ? readJson(path.join(runPath, 'decisions', name)) : null
}

/** One question's comparison: `agree` is null when there is nothing to compare against. */
function compare (record, id, expected, source) {
  const d = record.status === 'answered' ? record.decisions?.[id] : null
  if (!d) return null
  return {
    predicted: d.value,
    confidence: d.confidence ?? null,
    confident: d.confident === true,
    expected: expected ?? null,
    source: expected == null ? null : source,
    agree: expected == null ? null : d.value === expected
  }
}

/**
 * Every shadow record on the panel, set beside what actually happened:
 *
 *   gate         Triage's disposition, mapped (GATE_OF_DISPOSITION)
 *   duplicateOf  the issue Triage linked a duplicate to, or "none" for any
 *                other disposition
 *   priority     the issue's priority in force now, and who set it
 *   playbook     the first non-triage run started on the issue afterwards
 *
 * Only a completed Triage run with a recorded disposition is a comparison;
 * anything else is counted, not scored. Rates carry `{ of, total }`.
 */
export async function triageAgreement ({ issues, threshold = null }) {
  const rows = []
  for (const { id: project } of await issues.listProjects()) {
    const all = [...await issues.listIssues(project, { archived: false }), ...await issues.listIssues(project, { archived: true })]
    for (const issue of all) {
      const runsPath = path.join(issue.path, 'runs')
      let runIds = []
      try { runIds = (await fs.readdir(runsPath, { withFileTypes: true })).filter((e) => e.isDirectory() && !/^(worktree|workspace)-/.test(e.name)).map((e) => e.name) } catch { continue }
      const runs = (await Promise.all(runIds.map(async (runId) => ({ runId, run: await readJson(path.join(runsPath, runId, 'run.json')) }))))
        .filter((r) => r.run)
        .sort((a, b) => ((a.run.startedAt ?? '') < (b.run.startedAt ?? '') ? -1 : 1))
      for (const { runId, run } of runs) {
        const record = await shadowRecord(path.join(runsPath, runId))
        if (!record) continue
        const override = await readJson(path.join(runsPath, runId, 'decisions', 'pregate-override.json'))
        const disposition = run.status === 'completed' ? run.reportDisposition ?? null : null
        const duplicate = disposition?.disposition === 'duplicate'
          ? (disposition.issues ?? []).find((i) => i.linked && i.issueId !== issue.id)?.issueId ?? null
          : disposition ? 'none' : null
        const later = runs.find((r) => (r.run.startedAt ?? '') > (run.startedAt ?? '') && r.run.playbook?.id !== 'triage')
        rows.push({
          project,
          issueId: issue.id,
          runId,
          askedAt: record.askedAt,
          status: record.status,
          failure: record.failure?.class ?? null,
          model: record.model ?? null,
          costUsd: record.costUsd ?? null,
          latencyMs: record.latencyMs ?? null,
          triage: { status: run.status ?? null, disposition: disposition?.disposition ?? null },
          // A start an operator pushed past a hold: exactly the cases the gate got wrong, or right.
          override: override ? { by: override.by ?? null, reason: override.reason ?? null } : null,
          questions: {
            gate: compare(record, 'gate', disposition ? GATE_OF_DISPOSITION[disposition.disposition] : null, 'triage-disposition'),
            duplicateOf: compare(record, 'duplicateOf', duplicate, 'triage-disposition'),
            priority: compare(record, 'priority', issue.priority?.value ?? null, issue.priority ? `priority set by ${issue.priority.by ?? 'unknown'}` : null),
            playbook: compare(record, 'playbook', later?.run.playbook?.id ?? null, later ? `run ${later.runId}` : null)
          }
        })
      }
    }
  }

  const summary = {}
  for (const id of ['gate', 'duplicateOf', 'priority', 'playbook']) {
    const scored = rows.map((r) => r.questions[id]).filter((q) => q?.agree != null)
    const confident = scored.filter((q) => q.confident)
    const rate = (list) => ({ of: list.filter((q) => q.agree).length, total: list.length })
    summary[id] = { all: rate(scored), confident: rate(confident) }
  }
  return {
    purpose: PURPOSE,
    threshold,
    records: rows.length,
    answered: rows.filter((r) => r.status === 'answered').length,
    unavailable: rows.filter((r) => r.status !== 'answered').length,
    costUsd: rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    summary,
    rows: rows.sort((a, b) => ((a.askedAt ?? '') < (b.askedAt ?? '') ? 1 : -1))
  }
}
