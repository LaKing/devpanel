import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import YAML from 'yaml'

import { DEFAULT_CONFIG_ROOT, hostConfigDir } from '../config/host-config.mjs'

/*
 * The consult panel's configuration: consult/panel.yaml, replaced whole by a
 * host-config/consult/panel.yaml (docs/host-config.md). Read at every consult,
 * so changing a seat needs no restart. It is deliberately not part of any run's
 * snapshot: a run reads a consult's RECORD, never this file, so replay cannot
 * depend on what it says today.
 */

const DEFAULTS = { enabled: true, maxRounds: 2, turnTimeoutMinutes: 20, maxTurnCostUsd: 5, maxPerRun: 6, maxTechnicalPerRun: 3, alwaysHuman: ['authorization'], readOnly: [], deny: [] }
/** The panel's seats, in order. Each is optional, at least one is occupied (the schema); the first occupied one writes a `brief`. */
export const SEATS = ['consultant-1', 'consultant-2', 'consultant-3']

/** Where the panel's file may be: the installation's own copy, then the tracked one. */
export const panelFiles = ({ root = DEFAULT_CONFIG_ROOT, hostDir = hostConfigDir({ root }) } = {}) => ({ host: path.join(hostDir, 'consult', 'panel.yaml'), tracked: path.join(root, 'consult', 'panel.yaml') })

async function readPanelFile (root, hostDir) {
  const files = panelFiles(hostDir ? { root, hostDir } : { root })
  for (const file of [files.host, files.tracked]) {
    try { return { file, text: await fs.readFile(file, 'utf8') } } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  return null
}

/** The panel, defaults filled in; null when no file configures one. Throws on an invalid file, naming it. */
export async function loadPanel ({ root = DEFAULT_CONFIG_ROOT, hostDir = null } = {}) {
  const found = await readPanelFile(root, hostDir)
  if (!found) return null
  const data = YAML.parse(found.text)
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(JSON.parse(await fs.readFile(path.join(root, 'schemas', 'consult-panel.schema.json'), 'utf8')))
  if (!validate(data)) throw new Error(`${found.file} is invalid: ${validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`)
  return { ...DEFAULTS, ...data, file: found.file, text: found.text, hash: `sha256:${crypto.createHash('sha256').update(found.text).digest('hex')}` }
}

/**
 * The seats one consult is asked of: the panel's, with the asker's own choice laid over them. `overrides` names only
 * the seats to change: `{ model, effort? }` occupies one, `null` leaves it empty for this consult.
 */
export function seatsFor (panel, overrides = null) {
  const seats = { ...(panel.seats ?? {}) }
  const problems = []
  if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) return { seats, problems: ['seats must be an object keyed by seat name'] }
  for (const [seat, to] of Object.entries(overrides ?? {})) {
    if (!SEATS.includes(seat)) { problems.push(`"${seat}" is not a seat of the panel (${SEATS.join(', ')})`); continue }
    if (to === null) { delete seats[seat]; continue }
    if (!to || typeof to !== 'object' || typeof to.model !== 'string' || !to.model || (to.effort != null && typeof to.effort !== 'string')) { problems.push(`${seat}: a seat is { model, effort? }, or null to leave it empty`); continue }
    seats[seat] = { model: to.model, ...(to.effort ? { effort: to.effort } : {}) }
  }
  return { seats, problems }
}

/**
 * The occupied seats as roster entries, in seat order. A seat that cannot be used is a problem
 * with a reason, never an exception: the caller reports the consult unavailable.
 *
 * @param roster        Map of roster entries (config/load.mjs)
 * @param availability  optional availability store ({ check(modelId) })
 * @param overrides     optional seats of this one consult (seatsFor)
 */
export async function resolveSeats (panel, { roster, availability = null, overrides = null }) {
  const seats = []
  const { seats: occupied, problems } = seatsFor(panel, overrides)
  for (const seat of SEATS) {
    if (!occupied[seat]) continue
    const { model: id, effort = null } = occupied[seat]
    const model = roster.get(id)
    if (!model) { problems.push(`${seat}: roster model "${id}" does not exist`); continue }
    if (model.verification?.status !== 'verified') { problems.push(`${seat}: ${id} is not verified`); continue }
    // No harness is refused here. A Gemini seat reads with its file tools inside the same proved fence but has no
    // shell (harness/gemini.mjs, the non-writer policy): it cannot run git, so it sees the checkout as it stands and
    // no history. Whether a seat really read is decided per turn, from the adapter's `diagnostics.access` (consult.mjs).
    if (effort && Array.isArray(model.efforts) && !model.efforts.includes(effort)) { problems.push(`${seat}: ${id} has no effort "${effort}"`); continue }
    const hold = await availability?.check(id)
    if (hold) { problems.push(`${seat}: ${id} is unavailable${hold.exhaustedUntil ? ` until ${hold.exhaustedUntil}` : ''}${hold.reason ? ` (${hold.reason})` : ''}`); continue }
    seats.push({ seat, model, effort: effort ?? model.defaultEffort ?? null })
  }
  if (!Object.keys(occupied).length) problems.push('no seat of the panel is occupied')
  return { seats, problems }
}
