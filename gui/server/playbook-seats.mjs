import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { CONFIG_ROOT, getValidator, loadConfig, resolvePlaybook, schemaId } from './config/load.mjs'
import { discover } from './config/host-config.mjs'

/*
 * The Playbooks page: every playbook's seats as they stand (the model and effort bound to each role of its
 * strategy), and an operator's edit of those defaults.
 *
 * Decision: an edit is written as the installation's own copy of the playbook, `<host-config>/playbooks/<file>`,
 * never into the tracked `playbooks/` catalogue. A host copy is the documented override (docs/host-config.md) and
 * the tracked tree stays publishable. The copy is the effective file's own text with only `participants` changed,
 * comments kept. A copy that came to say the same as the tracked file is removed, so nothing is left shadowing a
 * catalogue entry it no longer differs from.
 * Mechanism: the candidate is validated in memory before anything is written, by the schema and by the same
 * resolvePlaybook a run start uses (roles bound, model in the roster, effort supported by model and harness), so a
 * file the loader would refuse never reaches the disk. A playbook is resolved and snapshotted at run start: an edit
 * changes what later starts get, never a run in flight, and gives the playbook a new configHash. A preview made
 * before the edit no longer matches and is refused at start, as after any configuration change.
 * Pitfall: a host copy shadows the WHOLE tracked file. `drift` on a row says the copy differs from the tracked
 * file outside `participants`: the tracked file changed after the copy was written, or the copy was edited by hand.
 */

const refuse = (message, status, detail) => Object.assign(new Error(message), { status, ...(detail ? { detail } : {}) })
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
const sameSeat = (a, b) => (a?.model ?? null) === (b?.model ?? null) && (a?.effort ?? null) === (b?.effort ?? null) && Boolean(a) === Boolean(b)
const messages = (errors) => errors.map((e) => `${e.field && e.field !== '/' ? `${e.field}: ` : ''}${e.message}`)
// A blocker is { role, model, reason } (config/load.mjs): what keeps a start from being launched with these seats.
const blocked = (blockers) => (blockers ?? []).map((b) => `${b.role ? `${b.role}: ` : ''}${b.model ? `${b.model} ` : ''}${b.reason ?? b.message ?? 'cannot launch'}`)

/** Does the host copy say something else than the tracked file, outside `participants`? */
async function drifted (file, treeFile) {
  const rest = async (f) => { const { participants, ...other } = YAML.parse(await fs.readFile(f, 'utf8')) ?? {}; return canonical(other) }
  try { return await rest(file) !== await rest(treeFile) } catch { return true }
}

/**
 * Every playbook with its seats, and the roster models a seat can take. `held(modelId)` may name the instant a
 * model is on hold until (the availability store); a held model can still be seated, the page says so.
 */
export async function playbookSeats ({ root = CONFIG_ROOT, hostDir, held = async () => null } = {}) {
  const config = await loadConfig(hostDir ? { root, hostDir } : { root })
  const files = new Map((await discover('playbooks', { root: config.root, hostDir: config.hostDir })).map((f) => [f.file, f]))
  const playbooks = []
  for (const [id, playbook] of config.playbooks) {
    const strategy = config.strategies.get(playbook.strategy)
    const resolution = await resolvePlaybook(id, { config, root: config.root })
    const entry = files.get(playbook.file)
    playbooks.push({
      id,
      title: playbook.title ?? id,
      description: playbook.description ?? '',
      strategy: playbook.strategy,
      deprecated: playbook.deprecated === true,
      source: entry?.source ?? 'tree',
      drift: entry?.shadows ? await drifted(playbook.file, entry.shadows) : false,
      configHash: resolution.ok ? resolution.resolved.configHash : null,
      // What keeps it from resolving, or from starting as it stands. Some of the latter no seat causes: a release
      // playbook needs a project's release target, which this page has none of.
      resolves: resolution.ok,
      errors: resolution.ok ? blocked(resolution.resolved.liveExecution.blockers) : messages(resolution.errors),
      seats: Object.entries(strategy?.roles ?? {}).map(([role, spec]) => ({
        role,
        description: spec.description ?? '',
        optional: spec.optional === true,
        writesCode: spec.writesCode === true,
        model: playbook.participants?.[role]?.model ?? null,
        effort: playbook.participants?.[role]?.effort ?? null,
        resolvedEffort: resolution.ok ? resolution.resolved.participants[role]?.effort ?? null : null
      }))
    })
  }
  const models = []
  for (const m of config.roster.values()) {
    models.push({ id: m.id, title: m.title ?? m.id, harness: m.harness, efforts: Array.isArray(m.efforts) ? m.efforts : [], defaultEffort: m.defaultEffort ?? null,
      verified: m.verification?.status === 'verified', heldUntil: await held(m.id).catch(() => null) })
  }
  return { playbooks: playbooks.sort((a, b) => a.title.localeCompare(b.title)), models: models.sort((a, b) => a.title.localeCompare(b.title)), errors: messages(config.errors) }
}

/** The request's seats, checked for shape only: `{ role: null | { model, effort? } }`. */
function requested (seats) {
  if (!seats || typeof seats !== 'object' || Array.isArray(seats) || !Object.keys(seats).length) throw refuse('seats must name at least one role', 400)
  for (const [role, seat] of Object.entries(seats)) {
    if (seat === null) continue
    if (typeof seat !== 'object' || Array.isArray(seat) || typeof seat.model !== 'string' || !seat.model) throw refuse(`seat "${role}" needs a model, or null to leave it empty`, 400)
    if (seat.effort != null && typeof seat.effort !== 'string') throw refuse(`seat "${role}": effort is a level name, or absent for the model's default`, 400)
    if (Object.keys(seat).some((key) => !['model', 'effort'].includes(key))) throw refuse(`seat "${role}": only model and effort can be set here`, 400)
  }
  return seats
}

/** The playbook's text with the seats changed and nothing else: comments stay, except on a value that changed. */
function editedText (text, changes) {
  const doc = YAML.parseDocument(text)
  for (const { role, to } of changes) {
    const at = ['participants', role]
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

let saving = Promise.resolve()

/**
 * Change seats of one playbook. `seats` names only the roles to change: `null` empties an optional seat,
 * `{ model, effort? }` binds it (no effort: the model's default). Returns what was written and the page's view.
 */
export function savePlaybookSeats (id, seats, options = {}) {
  const run = saving.then(() => save(id, requested(seats), options))
  saving = run.catch(() => {})
  return run
}

async function save (id, seats, { root = CONFIG_ROOT, hostDir, actor = 'operator', held, now = () => new Date() } = {}) {
  const config = await loadConfig(hostDir ? { root, hostDir } : { root })
  const playbook = config.playbooks.get(id)
  if (!playbook) throw refuse(`no playbook "${id}"`, 404)
  const roles = config.strategies.get(playbook.strategy)?.roles ?? {}
  const changes = []
  for (const [role, seat] of Object.entries(seats)) {
    if (!roles[role]) throw refuse(`"${role}" is not a seat of ${id} (its strategy ${playbook.strategy} has: ${Object.keys(roles).join(', ')})`, 400)
    if (seat === null && !roles[role].optional) throw refuse(`seat "${role}" cannot be left empty: the strategy requires it`, 400)
    const from = playbook.participants?.[role] ? { model: playbook.participants[role].model, effort: playbook.participants[role].effort ?? null } : null
    const to = seat ? { model: seat.model, effort: seat.effort ?? null } : null
    if (!sameSeat(from, to)) changes.push({ role, from, to })
  }
  const view = () => playbookSeats({ root, hostDir, held })
  if (!changes.length) return { changed: false, written: null, removed: false, ...await view() }

  const before = await resolvePlaybook(id, { config, root: config.root })
  const entry = (await discover('playbooks', { root: config.root, hostDir: config.hostDir })).find((f) => f.file === playbook.file)
  const target = path.join(config.hostDir, 'playbooks', path.basename(playbook.file))
  const doc = editedText(await fs.readFile(playbook.file, 'utf8'), changes)
  if (entry?.source !== 'host') {
    doc.commentBefore = [` Host copy of playbooks/${path.basename(playbook.file)}, written by the panel's Playbooks page. It shadows the tracked file`,
      ' whole: delete it to return to the tracked default.', ...(doc.commentBefore ? [doc.commentBefore] : [])].join('\n')
  }
  // lineWidth 0: the printer otherwise folds long strings at 80 columns and rewrites lines the edit never touched.
  const text = doc.toString({ lineWidth: 0 })
  const data = YAML.parse(text)

  const validate = (await getValidator(config.root)).getSchema(schemaId('playbook'))
  if (!validate(data)) throw refuse('the edited playbook does not satisfy the playbook schema', 422, (validate.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`))
  const candidate = { ...config, playbooks: new Map(config.playbooks).set(id, { ...data, file: target, hash: sha256(text) }) }
  const after = await resolvePlaybook(id, { config: candidate, root: config.root })
  // Compared with the playbook as it stood: an installation whose configuration already has a problem elsewhere
  // can still change a seat, and an edit may be the repair. What the edit itself breaks is refused.
  const known = new Set(before.ok ? [] : messages(before.errors))
  const added = after.ok ? [] : messages(after.errors).filter((m) => !known.has(m))
  if (added.length) throw refuse('the edited seats do not resolve', 422, added)
  // A playbook can be unlaunchable for a reason no seat causes (a release target that only a project supplies):
  // only a blocker the edit adds is the edit's fault.
  const had = new Set(before.ok ? blocked(before.resolved.liveExecution.blockers) : [])
  const blocking = after.ok ? blocked(after.resolved.liveExecution.blockers).filter((b) => !had.has(b)) : []
  if (blocking.length) throw refuse('with these seats the playbook could not start a run', 422, blocking)

  // Back to what the tracked file says: no copy is kept to shadow it.
  const tracked = entry?.source === 'host' ? entry.shadows : playbook.file
  const sameAsTracked = tracked ? canonical(data) === canonical(YAML.parse(await fs.readFile(tracked, 'utf8'))) : false
  let written = null; let removed = false
  if (sameAsTracked) {
    if (entry?.source === 'host') { await fs.rm(playbook.file, { force: true }); removed = true }
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await fs.writeFile(temporary, text)
    await fs.rename(temporary, target)
    written = target
  }
  // Beside the copies, not a playbook: the loader reads `*.yaml` only.
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.appendFile(path.join(path.dirname(target), '.history.jsonl'), JSON.stringify({ at: now().toISOString(), actor, playbook: id, changes, written, removed,
    configHash: { before: before.ok ? before.resolved.configHash : null, after: after.ok ? after.resolved.configHash : null } }) + '\n')
  return { changed: true, written, removed, changes, ...await view() }
}
