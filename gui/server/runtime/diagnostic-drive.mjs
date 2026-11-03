import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * A diagnostic drive: the configured check target run once on the current
 * revision plus a patch the author keeps in its scratch directory, to gather
 * evidence on staging without adding diagnostic code to the candidate.
 *
 * The variant is not a revision. Its record lives in `run.diagnosticDrives` and
 * has no `revision` key, so nothing that binds to a fingerprint (approvals, the
 * check gate, closure, baselines, selftest history, refresh-checks) can read it.
 * The patch is applied only to the temporary rebuild of the drive (checks.mjs),
 * never to the worktree, so it cannot reach a fingerprint or a delivery.
 * execution-contract.md "Diagnostic drives".
 */

const NL = String.fromCharCode(10)

/** Per run, whatever became of them: refused and interrupted requests count too. */
export const MAX_DIAGNOSTIC_DRIVES = 3
export const MAX_PATCH_BYTES = 16 * 1024 * 1024

/**
 * What `plan()` can tell of a request without touching anything, as a repair
 * message; null when it may go ahead. Asked only while the step has no record,
 * so a replay never judges an accepted request again.
 */
export function diagnosticRequestProblem (request, { recordsRevision, inLoop, used }) {
  if (!recordsRevision || !inLoop) return 'diagnosticDrive may only be requested from the author turn of a review loop, the turn that records a revision. Leave it out here'
  if (used >= MAX_DIAGNOSTIC_DRIVES) return `this run has used its ${MAX_DIAGNOSTIC_DRIVES} diagnostic drives, so no further one can run. Restate your result without diagnosticDrive`
  const patch = String(request.patch ?? '')
  if (!patch || path.isAbsolute(patch) || patch.includes('\0') || patch.split(/[\\/]/).includes('..')) return `diagnosticDrive.patch must be a path relative to your scratch directory, with no ".." segment; got ${JSON.stringify(patch.slice(0, 200))}`
  return null
}

/** A refusal found when the drive is about to run: the record says it, and the author's next turn is told. */
export class DiagnosticRefusal extends Error {
  constructor (code, message) { super(message); this.code = code }
}

/**
 * Freeze the author's patch beside the drive's logs. Only a regular file inside
 * the seat's scratch directory is read: this runs outside the seat fence, and a
 * link planted there must not copy something of the panel's into the record.
 */
export async function freezePatch ({ scratchDir, patch, dest }) {
  const refuse = (detail) => new DiagnosticRefusal('patch-unreadable', detail)
  const root = await fs.realpath(scratchDir).catch(() => null)
  if (!root) throw refuse(`the scratch directory ${scratchDir} cannot be read`)
  const real = await fs.realpath(path.join(root, patch)).catch(() => null)
  if (!real) throw refuse(`${patch} does not exist in your scratch directory`)
  if (!real.startsWith(root + path.sep)) throw refuse(`${patch} resolves outside your scratch directory`)
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw refuse(`${patch} is not a regular file`)
  if (stat.size === 0) throw refuse(`${patch} is empty`)
  if (stat.size > MAX_PATCH_BYTES) throw refuse(`${patch} is ${stat.size} bytes, over the ${MAX_PATCH_BYTES} byte limit`)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(real, dest)
  const bytes = await fs.readFile(dest)
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/** Whether this author turn may ask: the run's frozen contract must know the field, or the answer would be rejected. */
export function offersDiagnosticDrive (snapshot, phase, step) {
  return Boolean(phase?.loop) && step?.recordsRevision === true && step.output === 'authorArtifact' &&
    Boolean(snapshot.contracts?.defs?.authorArtifact?.properties?.diagnosticDrive)
}

/** How to ask, on an author turn. */
export function diagnosticOffer ({ target, left }) {
  const tiers = target.tiers ? ` This target has tiers: "tier": "smoke" drives only ${target.tiers.smoke.join(', ')}, and "full" (the default) drives every command.` : ''
  return [
    `Diagnostic drive: when you need evidence from the check target (${target.kind}: ${(target.commands ?? []).map((c) => c.id).join(', ') || 'no commands listed'}) that only extra code can produce, do not add that code, or a changelog entry for it, to the candidate. Set diagnosticDrive in your result instead. ${left} left in this run.${tiers}`,
    'The engine then drives the target once on this turn\'s revision plus your patch, in a temporary copy, and gives you the result in another turn of this same step and round, before any audit. That uses no review round, but it is a step of the run\'s budget and real time on the target. The variant is never reviewed, delivered or counted as a check, and the patch must apply to the revision as it stands at the end of this turn.',
    'Write the patch in your scratch directory, without touching the worktree. To change a file: `cp path "$S/new"`, edit that copy, then `diff -u --label a/path --label b/path path "$S/new" > "$S/diag.patch"`. To add a file: `diff -u --label /dev/null --label b/path /dev/null "$S/new" > "$S/diag.patch"`. Name it relative to the scratch directory in diagnosticDrive.patch.'
  ].join(NL)
}

const commandLine = ({ id, required, passed, exitCode, signal, timedOut, log, results }) => ({ id, required, passed, exitCode, ...(signal ? { signal } : {}), ...(timedOut ? { timedOut } : {}), log, ...(results ? { results } : {}) })

/** One record as a seat reads it; what a seat acts on, not the whole of it. */
export const driveSummary = (d) => ({
  n: d.n, diagnostic: true, status: d.status, result: d.result, ofRevision: d.ofRevision, reason: d.reason,
  ...(d.tier ? { tier: d.tier } : {}), ...(d.target ? { target: d.target } : {}), dir: d.dir,
  ...(d.variant ? { variant: d.variant } : {}), ...(d.refused ? { refused: d.refused } : {}), ...(d.error ? { error: d.error } : {}),
  commands: (d.commands ?? []).map(commandLine), ...(d.skipped?.length ? { skipped: d.skipped } : {})
})

/** The author's next turn after its request. */
export function diagnosticResult (record, runDir) {
  const how = record.status === 'refused' ? `was refused (${record.refused?.code}) and nothing ran: ${record.refused?.detail}`
    : record.status === 'interrupted' ? 'was interrupted by a panel restart, so it proves nothing. It was not run again'
      : `finished: ${record.result}`
  return [
    `This is another turn of this step, after the diagnostic drive you requested. Diagnostic drive ${record.n} ${how}.`,
    `It was a drive of a variant, not a check of your revision: it satisfies and fails nothing.${record.status === 'refused' ? '' : ` Its logs and the frozen patch are in ${path.join(runDir, record.dir)}. Read them when the summary below does not answer your question.`}`,
    'Leave the candidate as it should be delivered, with no diagnostic code in it, and return your result as usual. It goes to audit unless you request another drive.',
    JSON.stringify({ ...driveSummary(record), commands: (record.commands ?? []).map((c) => ({ ...commandLine(c), ...(c.stdout ? { stdout: c.stdout } : {}) })) })
  ].join(NL)
}

/** Every later turn of the run, the auditors' included. */
export function diagnosticDrivesBlock (records, runDir) {
  return [
    `Diagnostic drives of this run. Each is a drive of a variant (a revision plus the author's patch, kept outside the worktree), diagnostic and NOT a check of the revision under audit. None was reviewed or will be delivered, its result satisfies and fails no gate, and its patch is not in the candidate or in revision.diff. Read one as the author's evidence; judge the revision only on its own diff and its own checks. Each variant's patch is variant.patch in its dir, under ${runDir}.`,
    JSON.stringify(records.map(driveSummary))
  ].join(NL)
}
