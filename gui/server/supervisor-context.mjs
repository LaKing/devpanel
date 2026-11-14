import crypto from 'node:crypto'

/*
 * The top-level supervisor's unchanging prompt blocks: project infrastructure (per project), the seat
 * catalogue, the playbooks and the earlier sessions' accounting (remaining.history). Every prompt stays in
 * the native session and is re-read on every later call, and these four made a prompt about 145 000
 * characters, nearly all of it repeated. So a block goes in full only when the current session has not been
 * sent those exact bytes (sha256 of its JSON); otherwise it is a marker naming the call that carried it and
 * the action that returns it in full now (get_context), so a marker is never the only copy.
 *
 * What a session was sent (state.contextSent) is bound to its id and recorded only after a call returned on
 * that same session: a failed call, a stopped one, or a resume that came back on another session counts as
 * nothing sent.
 */
export const CONTEXT_BLOCKS = ['infrastructure', 'seatModels', 'playbooks', 'history']

/*
 * Compaction. No adapter reports when the runtime compacts the session (harness/claude.mjs and codex.mjs
 * return no such event; the only mention is the deepseek profile's CLAUDE_CODE_AUTO_COMPACT_WINDOW), and a
 * compacted session may have dropped the full copies its markers point at. So the panel bounds how long that
 * can last instead of detecting it: once the session has been sent this many characters (prompts and
 * replies) since its last call that carried every block in full, the next call carries them all again.
 * A prompt counts when its call is ATTEMPTED (countAttempt, saved before the runtime is invoked), not when
 * it returns: a call that failed may still have grown the session, so failures, retries and a restart in
 * between cannot carry markers past the bound. Only the hashes wait for a call that returned.
 * 400 000 characters is about 100k tokens, under half of a 200k-token window, so after any compaction the
 * full copies come back within that much conversation (get_context covers the gap); at a full prompt of
 * about 145 000 characters it costs one full call in every fifteen or twenty steady ones.
 */
export const RESEND_AFTER_CHARS = 400_000

export const hashBlock = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const getAction = (block, project) => `get_context ${JSON.stringify(project ? { block, project } : { block })}`

/**
 * This call's blocks: in full, or a marker where the session already holds the same bytes.
 *
 * @param current  { infrastructure: {project: value} | null, playbooks, seatModels? (absent: not offered), history }
 * @param record   state.contextSent: { session, entries: {key: {hash, invocationId, at}}, charsSinceFull }
 * @returns { fields, offered: {key: hash}, full: [key], unchanged: [key] }
 */
export function composeContext (current, record, { sessionId = null, resendAfterChars = RESEND_AFTER_CHARS } = {}) {
  const usable = sessionId != null && record?.session === sessionId && (record.charsSinceFull ?? 0) < resendAfterChars
  const entries = usable ? record.entries ?? {} : {}
  const offered = {}, full = [], unchanged = []
  // Nothing to repeat in a null (an unreadable project, no history yet): it goes as it is and is not recorded.
  const pick = (key, value, block, project) => {
    if (value == null) return value
    const hash = hashBlock(value)
    offered[key] = hash
    const seen = entries[key]
    if (seen?.hash === hash) {
      unchanged.push(key)
      return { unchanged: true, since: seen.at, call: seen.invocationId, get: getAction(block, project) }
    }
    full.push(key)
    return value
  }
  const fields = {}
  fields.infrastructure = current.infrastructure
    ? Object.fromEntries(Object.entries(current.infrastructure).map(([project, value]) => [project, pick(`infrastructure:${project}`, value, 'infrastructure', project)]))
    : null
  fields.playbooks = pick('playbooks', current.playbooks, 'playbooks')
  if (Object.hasOwn(current, 'seatModels')) fields.seatModels = pick('seatModels', current.seatModels, 'seatModels')
  fields.history = pick('history', current.history, 'history')
  return { fields, offered, full, unchanged }
}

/**
 * A call is about to be made with `chars` of prompt on `sessionId`: counted toward the resend bound now,
 * whether the call then returns, fails or is never heard from. Nothing about what the session holds changes.
 */
export function countAttempt (record, { sessionId, chars }) {
  if (sessionId == null || record?.session !== sessionId) return record ?? null
  return { ...record, charsSinceFull: (record.charsSinceFull ?? 0) + chars }
}

/**
 * What the session holds after a call that RETURNED on it. `chars` is what the call added beyond its prompt,
 * already counted by countAttempt: the reply. Called only when the returned session is the one
 * the call was invoked with, or the call opened a new one; anything else records nothing.
 */
export function recordSent (record, { priorSessionId, sessionId, offered, full, invocationId, at, chars }) {
  if (sessionId == null) return null
  const same = priorSessionId != null && priorSessionId === sessionId && record?.session === sessionId
  const base = same ? record : { session: sessionId, entries: {}, charsSinceFull: 0 }
  const entries = {}
  // Keyed by what this call offered: a project no longer listed drops out.
  for (const [key, hash] of Object.entries(offered)) {
    if (full.includes(key)) entries[key] = { hash, invocationId, at }
    else if (base.entries?.[key]?.hash === hash) entries[key] = base.entries[key]
  }
  const allFull = Object.keys(offered).every((key) => full.includes(key))
  return { session: sessionId, entries, charsSinceFull: allFull ? 0 : (base.charsSinceFull ?? 0) + chars }
}
