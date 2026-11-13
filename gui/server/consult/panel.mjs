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
export const SEATS = ['consultant-1', 'consultant-2']

async function readPanelFile (root) {
  for (const file of [path.join(hostConfigDir({ root }), 'consult', 'panel.yaml'), path.join(root, 'consult', 'panel.yaml')]) {
    try { return { file, text: await fs.readFile(file, 'utf8') } } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  return null
}

/** The panel, defaults filled in; null when no file configures one. Throws on an invalid file, naming it. */
export async function loadPanel ({ root = DEFAULT_CONFIG_ROOT } = {}) {
  const found = await readPanelFile(root)
  if (!found) return null
  const data = YAML.parse(found.text)
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(JSON.parse(await fs.readFile(path.join(root, 'schemas', 'consult-panel.schema.json'), 'utf8')))
  if (!validate(data)) throw new Error(`${found.file} is invalid: ${validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`)
  return { ...DEFAULTS, ...data, file: found.file, hash: `sha256:${crypto.createHash('sha256').update(found.text).digest('hex')}` }
}

/**
 * The panel's seats as roster entries. A seat that cannot be used is a problem
 * with a reason, never an exception: the caller reports the consult unavailable.
 *
 * @param roster        Map of roster entries (config/load.mjs)
 * @param availability  optional availability store ({ check(modelId) })
 */
export async function resolveSeats (panel, { roster, availability = null }) {
  const seats = []
  const problems = []
  for (const seat of SEATS) {
    const { model: id, effort = null } = panel.seats[seat]
    const model = roster.get(id)
    if (!model) { problems.push(`${seat}: roster model "${id}" does not exist`); continue }
    if (model.verification?.status !== 'verified') { problems.push(`${seat}: ${id} is not verified`); continue }
    // Gemini has no read-only workspace root: a non-writing seat there has no tools at all.
    if (model.harness === 'gemini') { problems.push(`${seat}: ${id} runs on gemini, which cannot give a seat read-only access`); continue }
    if (effort && Array.isArray(model.efforts) && !model.efforts.includes(effort)) { problems.push(`${seat}: ${id} has no effort "${effort}"`); continue }
    const hold = await availability?.check(id)
    if (hold) { problems.push(`${seat}: ${id} is unavailable${hold.exhaustedUntil ? ` until ${hold.exhaustedUntil}` : ''}${hold.reason ? ` (${hold.reason})` : ''}`); continue }
    seats.push({ seat, model, effort: effort ?? model.defaultEffort ?? null })
  }
  return { seats, problems }
}
