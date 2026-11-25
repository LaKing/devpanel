import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import YAML from 'yaml'
import { SEATS, loadPanel, panelFiles, resolveSeats } from './consult/panel.mjs'
import { canonical, editedText, refuse, sameSeat } from './seat-edit.mjs'

/*
 * The consult panel on the Playbooks page: "Consultation", seated like a playbook (up to three seats, each optional,
 * at least one occupied, any verified roster model) and edited the same way.
 *
 * Decision: it is shown and edited as a playbook but is not one in the catalogue. A strategy file is the phase
 * interpreter's contract (steps, output contracts, completion); the panel is still asked through consult/consult.mjs,
 * and a strategy the engine cannot run would be a facade. Its seats therefore stay in consult/panel.yaml.
 * Mechanism: an edit is written as the installation's own copy, `<host-config>/consult/panel.yaml`, which replaces
 * the tracked file whole (docs/consult.md); only `seats` is changed, comments kept, and a copy that came to say the
 * same as the tracked file is removed. The panel is read at every consult, so the next consult gets the new seats
 * without a restart; a consult already recorded is replayed from its record.
 */

export const CONSULTATION = 'consultation'
const DESCRIPTION = 'The consult panel: a question that would go to a person is put to these seats first. Each reads the project read-only and answers alone. What the seats asked agree on is the decision; if they still differ after the last round, the majority decides.'
const SEAT_NOTE = { 'consultant-1': 'Answers independently, and writes the question for a person when the decision is reserved to one.', 'consultant-2': 'A second, independent answer.', 'consultant-3': 'The tie-breaker: asked, blind, only when the first two do not agree. With it the majority can decide.' }
const sha256 = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`
const rest = (text) => { const { seats, ...other } = YAML.parse(text) ?? {}; return canonical(other) }

/** The page's entry for the panel, or null when no panel is configured. An invalid panel file is an entry that does not resolve. */
export async function consultationEntry ({ root, hostDir, roster }) {
  const files = panelFiles({ root, hostDir })
  const base = { id: CONSULTATION, title: 'Consultation', description: DESCRIPTION, strategy: null, kind: 'consultation', deprecated: false }
  let panel
  try { panel = await loadPanel({ root, hostDir }) } catch (error) {
    return { ...base, source: 'host', drift: false, configHash: null, resolves: false, errors: [error.message], seats: SEATS.map((role) => ({ role, description: SEAT_NOTE[role], optional: true, writesCode: false, model: null, effort: null, resolvedEffort: null })) }
  }
  if (!panel) return null
  const { seats, problems } = await resolveSeats(panel, { roster })
  const tracked = await fs.readFile(files.tracked, 'utf8').catch(() => null)
  const fromHost = panel.file === files.host
  return {
    ...base,
    source: fromHost ? 'host' : 'tree',
    drift: fromHost && tracked != null ? rest(panel.text) !== rest(tracked) : false,
    configHash: panel.hash,
    resolves: !problems.length,
    errors: [...problems, ...(panel.enabled ? [] : ['the panel is switched off (enabled: false): questions go to a person as before'])],
    seats: SEATS.map((role) => ({
      role, description: SEAT_NOTE[role], optional: true, writesCode: false,
      model: panel.seats?.[role]?.model ?? null, effort: panel.seats?.[role]?.effort ?? null, resolvedEffort: seats.find((s) => s.seat === role)?.effort ?? null
    }))
  }
}

/** Change the panel's seats (`requested` shape: `{ role: null | { model, effort? } }`); refuses what would leave no seat or a seat that cannot be asked. */
export async function saveConsultationSeats (seats, { root, hostDir, roster, actor = 'operator', now = () => new Date() }) {
  const files = panelFiles({ root, hostDir })
  const panel = await loadPanel({ root, hostDir })
  if (!panel) throw refuse('no consult panel is configured (consult/panel.yaml)', 404)
  const changes = []
  for (const [role, seat] of Object.entries(seats)) {
    if (!SEATS.includes(role)) throw refuse(`"${role}" is not a seat of the panel (${SEATS.join(', ')})`, 400)
    const from = panel.seats?.[role] ? { model: panel.seats[role].model, effort: panel.seats[role].effort ?? null } : null
    const to = seat ? { model: seat.model, effort: seat.effort ?? null } : null
    if (!sameSeat(from, to)) changes.push({ role, from, to })
  }
  if (!changes.length) return { changed: false, written: null, removed: false }

  const fromHost = panel.file === files.host
  const doc = editedText(panel.text, changes, 'seats')
  if (!fromHost) doc.commentBefore = [' Host copy of consult/panel.yaml, written by the panel\'s Playbooks page. It replaces the tracked file', ' whole: delete it to return to the tracked default.', ...(doc.commentBefore ? [doc.commentBefore] : [])].join('\n')
  const text = doc.toString({ lineWidth: 0 })
  const data = YAML.parse(text)
  if (!Object.keys(data.seats ?? {}).length) throw refuse('the panel needs at least one occupied seat', 422)
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(await fs.readFile(path.join(root, 'schemas', 'consult-panel.schema.json'), 'utf8')))
  if (!validate(data)) throw refuse('the edited panel does not satisfy the panel schema', 422, (validate.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`))
  // Only what the edit itself breaks is refused: a panel that already had a seat nobody can ask may still be changed.
  const known = new Set((await resolveSeats(panel, { roster })).problems)
  const added = (await resolveSeats({ ...panel, seats: data.seats }, { roster })).problems.filter((p) => !known.has(p))
  if (added.length) throw refuse('with these seats the panel could not be asked', 422, added)

  const tracked = await fs.readFile(files.tracked, 'utf8').catch(() => null)
  const sameAsTracked = tracked != null && canonical(data) === canonical(YAML.parse(tracked))
  let written = null; let removed = false
  if (sameAsTracked) {
    if (fromHost) { await fs.rm(files.host, { force: true }); removed = true }
  } else {
    await fs.mkdir(path.dirname(files.host), { recursive: true })
    const temporary = `${files.host}.${process.pid}.tmp`
    await fs.writeFile(temporary, text)
    await fs.rename(temporary, files.host)
    written = files.host
  }
  await fs.mkdir(path.dirname(files.host), { recursive: true })
  await fs.appendFile(path.join(path.dirname(files.host), '.history.jsonl'), JSON.stringify({ at: now().toISOString(), actor, playbook: CONSULTATION, changes, written, removed, configHash: { before: panel.hash, after: sha256(text) } }) + '\n')
  return { changed: true, written, removed, changes }
}
