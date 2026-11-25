/*
 * The engine programs an engine-only playbook may run (docs/tactical-playbooks.md "Engine-only playbooks").
 * A program is a fixed sequence of engine operations: a playbook runs it only when its phases name exactly
 * that sequence, because the engine executes the program whole (the full verification cycle,
 * server/full-verification.mjs, wrapped as a run by server/full-verification-run.mjs). Any other
 * sequence resolves and previews but cannot be started. No runtime import: config/load.mjs reads this.
 */
export const ENGINE_PROGRAMS = Object.freeze({
  'full-verification': Object.freeze(['full-verification-freeze', 'full-verification-wait', 'full-verification-stages', 'full-verification-outcome', 'full-verification-thaw'])
})

/** The program whose operation sequence the phases name exactly, else null. */
export function engineProgramOf (phases) {
  const ops = (phases ?? []).map((p) => p.engine)
  for (const [id, sequence] of Object.entries(ENGINE_PROGRAMS)) {
    if (ops.length === sequence.length && ops.every((op, i) => op === sequence[i])) return id
  }
  return null
}
