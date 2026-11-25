/*
 * Which issue-page sections this browser has hidden, and whether the issue
 * folder was explicitly opened or closed. One choice for every issue, kept in
 * localStorage like the actor name (identity.js): a person who hides the status
 * block to read steps wants it hidden on the next issue too.
 *
 * Anything that is not exactly what this code writes is no preference at all,
 * so the page falls back to its default view rather than to half a choice.
 */

export const SECTION_IDS = ['issue', 'decision', 'assess', 'questions', 'stats', 'run', 'runbar', 'status', 'timeline', 'detail', 'outcome', 'tech']

const HIDDEN = 'devpanel.issue.hidden'
const FOLDER = 'devpanel.issue.folder'

// Touching localStorage can itself throw (storage disabled), so it is resolved inside the try.
const store = (storage) => storage ?? globalThis.localStorage

/** The hidden section ids, in SECTION_IDS order; [] unless every stored entry is a known id. */
export function readHidden (storage) {
  try {
    const value = JSON.parse(store(storage).getItem(HIDDEN))
    if (!Array.isArray(value) || !value.every((id) => SECTION_IDS.includes(id))) return []
    return SECTION_IDS.filter((id) => value.includes(id))
  } catch { return [] }
}

export function writeHidden (ids, storage) {
  try { store(storage).setItem(HIDDEN, JSON.stringify(SECTION_IDS.filter((id) => ids.includes(id)))) } catch { /* per-browser convenience only */ }
}

/*
 * What the page shows: the saved choice (`hidden`) with the sections an alert link opened for this visit
 * (`revealed`, docs/operator-alerts.md) shown on top. A reveal is never part of the saved choice: only a toggle
 * changes `hidden`, and `save` says when it must be written.
 */
export const sectionShown = ({ hidden, revealed }, id) => !hidden.includes(id) || revealed.includes(id)

export function toggleSectionState ({ hidden, revealed }, id) {
  // Shown only for this visit: hiding it again ends the reveal; the saved choice already hides it.
  if (hidden.includes(id) && revealed.includes(id)) return { hidden, revealed: revealed.filter((x) => x !== id), save: false }
  return { hidden: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id], revealed, save: true }
}

export const revealSectionState = ({ hidden, revealed }, ids) => ({ hidden, revealed: [...new Set([...revealed, ...ids.filter((id) => hidden.includes(id))])] })

/** true (opened), false (closed) or null: no choice made, so the page decides. */
export function readFolder (storage) {
  try {
    const value = store(storage).getItem(FOLDER)
    return value === 'open' ? true : value === 'closed' ? false : null
  } catch { return null }
}

export function writeFolder (open, storage) {
  try { store(storage).setItem(FOLDER, open ? 'open' : 'closed') } catch { /* per-browser convenience only */ }
}
