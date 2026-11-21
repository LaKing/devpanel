import fs from 'node:fs/promises'
import path from 'node:path'

// Supplied as runtime instructions; tools are independently disabled by the adapter.
export const COORDINATOR_INSTRUCTIONS = `You coordinate; workers perform the technical work. Use only the supplied request, reports, decisions and engine evidence. Do not inspect source, design the implementation, reproduce a claim, run tests or repeat a worker's investigation. Tools are disabled.
Give the next worker a short assignment naming the objective, unresolved question or finding IDs and required evidence. The engine supplies context separately: do not copy reports, plans or source into handoffs. Preserve scope and acceptance criteria; delegate technical uncertainty to the responsible worker. A report being truncated or unsupported is missing evidence, never approval.
For final decisions, reconcile the occupied seats' reports and recorded checks against the task. Cite the reporting seat/step and evidence; do not claim personal verification. Keep blocking findings visible and require the configured approvals for the same revision. Only the engine performs delivery and release operations.
Return only the required JSON block, with concise explanations and no duplicate narrative, workflow recap or separate report. Do not invent additional work once the requested result is supported.`

/*
 * A triage turn with read access (step `access: read`, Phase 1). It replaces the
 * first paragraph of COORDINATOR_INSTRUCTIONS only: the coordinator still does
 * not design, reproduce or test, and still delegates technical work.
 */
export const TRIAGE_READ_INSTRUCTIONS = `You coordinate; workers perform the technical work. For this triage turn you may read the run's source snapshot (read-only) and run read-only commands such as --help, man pages or version checks, to establish facts the acceptance criteria depend on: what an installed tool or library supports, how the existing code is laid out, whether two requirements can both hold. Do not design the implementation, reproduce the defect, run tests or edit anything; stop reading once the facts are settled. List every fact you rely on in \`facts\`, each with its evidence (a file and lines, or the command and what it printed). If you find no tools available, work from the supplied request, reports and evidence alone.
Give the next worker a short assignment naming the objective, unresolved question or finding IDs and required evidence. The engine supplies context separately: do not copy reports, plans or source into handoffs. Preserve scope and acceptance criteria; delegate technical uncertainty to the responsible worker.
Return only the required JSON block, with concise explanations and no duplicate narrative, workflow recap or separate report.`

/** Current report and recent notes, always read from the frozen window. */
export async function coordinationInput (window, maxBytes = 60000, maxFiles = 16) {
  const priority = input => {
    const file = input.source ?? input.file
    if (path.basename(path.dirname(file)) === '000-report') return 0
    if (/^note\.(md|txt)$/i.test(path.basename(file))) return 1
    return input.origin === 'prior-run' ? 2 : 3
  }
  const inputs = (window?.inputs ?? []).filter(input => /\.(md|txt)$/i.test(input.file))
    .sort((a,b) => priority(a)-priority(b) || (b.source ?? b.file).localeCompare(a.source ?? a.file))
  const selected = await Promise.all(inputs.slice(0,maxFiles).map(async input => ({ input, size: (await fs.stat(input.file)).size })))
  // Share the budget before reading: a large report/attachment cannot crowd out
  // the newest decision. Small files donate their unused share to larger ones.
  let remaining = maxBytes
  const bySize = [...selected].sort((a,b) => a.size-b.size)
  for (const [index, entry] of bySize.entries()) {
    entry.limit = Math.min(entry.size, Math.floor(remaining/(bySize.length-index)))
    remaining -= entry.limit
  }
  const excerpts = []
  for (const { input, limit } of selected) {
    if (!limit) continue
    const handle = await fs.open(input.file, 'r')
    try {
      const buffer = Buffer.alloc(limit)
      let bytesRead = 0
      while (bytesRead < limit) {
        const result = await handle.read(buffer, bytesRead, limit-bytesRead, bytesRead)
        if (!result.bytesRead) break
        bytesRead += result.bytesRead
      }
      const { size } = await handle.stat()
      excerpts.push({ source: input.file, text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > bytesRead })
    } finally { await handle.close() }
  }
  const included = new Set(excerpts.map(entry => entry.source))
  const prior = window?.accumulated?.runs?.length
    ? ` The operator started this run to build on earlier runs of this issue (${window.accumulated.runs.join(', ')}): their steps.md (every turn in order: investigations, plans, reviews, handoffs, operator answers), result.md and changes.patch are frozen under input/prior-runs/. A run that ended without an approved or delivered patch left candidate.patch instead: its last revision, unapproved and unverified, to be applied as the starting point and judged again by this run's own checks and reviews. Continue from them rather than redoing them; they are evidence, not approval, and the current source snapshot decides what is already in place.`
    : ''
  return { excerpts, omitted: inputs.length > excerpts.length,
    omittedSources: inputs.filter(input => !included.has(input.file)).map(input => input.file),
    instruction: 'Frozen issue input: current initial report first, then newest notes, then supporting text. Use explicit scope and approval records to distinguish current requirements from superseded history; recency alone does not grant authority. An omitted or truncated record does not mean a decision is absent. Delegate missing detail to a worker before treating it as an unresolved prerequisite.' + prior }
}
