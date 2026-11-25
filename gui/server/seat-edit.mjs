import YAML from 'yaml'

/*
 * Editing seats in a configuration file, shared by the Playbooks page's two kinds of entry: a catalogue playbook
 * (playbook-seats.mjs, its `participants`) and the consult panel (consultation-seats.mjs, its `seats`).
 */

export const refuse = (message, status, detail) => Object.assign(new Error(message), { status, ...(detail ? { detail } : {}) })
export const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
export const sameSeat = (a, b) => (a?.model ?? null) === (b?.model ?? null) && (a?.effort ?? null) === (b?.effort ?? null) && Boolean(a) === Boolean(b)

/** The request's seats, checked for shape only: `{ role: null | { model, effort? } }`. */
export function requested (seats) {
  if (!seats || typeof seats !== 'object' || Array.isArray(seats) || !Object.keys(seats).length) throw refuse('seats must name at least one role', 400)
  for (const [role, seat] of Object.entries(seats)) {
    if (seat === null) continue
    if (typeof seat !== 'object' || Array.isArray(seat) || typeof seat.model !== 'string' || !seat.model) throw refuse(`seat "${role}" needs a model, or null to leave it empty`, 400)
    if (seat.effort != null && typeof seat.effort !== 'string') throw refuse(`seat "${role}": effort is a level name, or absent for the model's default`, 400)
    if (Object.keys(seat).some((key) => !['model', 'effort'].includes(key))) throw refuse(`seat "${role}": only model and effort can be set here`, 400)
  }
  return seats
}

/** The file's text with the seats changed and nothing else: comments stay, except on a value that changed. `key` is the map the seats live in. */
export function editedText (text, changes, key = 'participants') {
  const doc = YAML.parseDocument(text)
  for (const { role, to } of changes) {
    const at = [key, role]
    if (!to) { doc.deleteIn(at); continue }
    if (!doc.hasIn(at)) { doc.setIn(at, doc.createNode(to.effort ? { model: to.model, effort: to.effort } : { model: to.model })); continue }
    for (const key of ['model', 'effort']) {
      const node = doc.getIn([...at, key], true)
      if (to[key] == null) { if (node) doc.deleteIn([...at, key]); continue }
      // A trailing comment explained the old value ("the default since ..."); beside a new one it would mislead.
      if (node && node.value !== to[key]) { node.value = to[key]; node.comment = null } else if (!node) doc.setIn([...at, key], to[key])
    }
  }
  return doc
}
