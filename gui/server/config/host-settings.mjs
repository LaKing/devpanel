import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'

import { bootDataRoot, DEFAULT_CONFIG_ROOT, HOST_CONFIG_ENV, hostConfigDir } from './host-config.mjs'

/*
 * One installation's own defaults (docs/host-config.md "Host settings"):
 * <host-config>/settings.json, validated against schemas/host-settings.schema.json.
 * Every key is optional and an absent one keeps the neutral default, which names
 * no installation. An invalid file is an error wherever it is read: a typo must
 * never quietly fall back to a weaker default (fewer forbidden roots, no login).
 *
 * While a host move is pending (tools/host-move/manifest.json still in the
 * checkout, its settings not yet copied), the carried settings are read instead,
 * so a restart between delivery and the move changes nothing. Only for the
 * default host directory: an explicit DEVPANEL_HOST_CONFIG_DIR (the test runner
 * sets one) never reads the checkout's carried files.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = path.resolve(HERE, '..', '..', '..', 'schemas', 'host-settings.schema.json')
export const SETTINGS_FILE = 'settings.json'
export const MOVE_MANIFEST = path.join('tools', 'host-move', 'manifest.json')

export const DEFAULT_DIGEST_FILES = ['.hash']
export const DEFAULT_FORBIDDEN_PREFIXES = ['production', 'staging']
export const DEFAULT_PROJECT_MARKERS = ['package.json']

let validate = null
const compiled = () => (validate ??= new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(SCHEMA, 'utf8'))))

const statOf = (file) => { try { return fs.statSync(file) } catch { return null } }

/**
 * The entries of a host move that has not run yet, {from, to} with `from` resolved
 * and present: none under an explicit DEVPANEL_HOST_CONFIG_DIR or without a manifest.
 */
export function pendingMoves ({ root = DEFAULT_CONFIG_ROOT, env = process.env } = {}) {
  if (env[HOST_CONFIG_ENV]) return []
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, MOVE_MANIFEST), 'utf8')) } catch { return [] }
  return (manifest.entries ?? []).filter((e) => typeof e.from === 'string' && typeof e.to === 'string' && !e.from.split('/').includes('..'))
    .map((e) => ({ from: path.join(root, e.from), to: e.to })).filter((e) => statOf(e.from)?.isFile())
}

/** The carried file a pending host move would install at `to` (host:<rel> or root:<rel>), or null. */
export const pendingCarry = (to, options) => pendingMoves(options).find((e) => e.to === to)?.from ?? null

function parse (file) {
  let data
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { throw new Error(`host settings ${file}: ${error.message}`) }
  if (!compiled()(data)) throw new Error(`host settings ${file}: ${validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`)
  return data
}

const cache = new Map()

const expandHome = (p) => p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p

/**
 * The effective settings for a config root: {file, pending, projectsRoot, dataRoot, gitStore, nestedRepositories, projectDiscovery, proxyLogin, projectActions,
 * testDrive, selection, harnesses, fence, tooling, skill, reporter, seatGuidance}, defaults filled in. Read at call time and
 * cached by file identity, so an edit is seen without a restart.
 */
export function hostSettings ({ root = DEFAULT_CONFIG_ROOT, env = process.env, hostDir = hostConfigDir({ root, env }) } = {}) {
  let file = path.join(hostDir, SETTINGS_FILE)
  let pending = false
  if (!statOf(file)) {
    const carried = hostDir === path.resolve(root, 'host-config') ? pendingCarry(`host:${SETTINGS_FILE}`, { root, env }) : null
    file = carried
    pending = Boolean(carried)
  }
  const stat = file ? statOf(file) : null
  const key = file ? `${file}\0${stat?.mtimeMs}\0${stat?.size}` : `none\0${root}`
  // A host-config directory found in the data root makes that the data root
  // unless the settings name another.
  const data = bootDataRoot(env)
  const impliedDataRoot = !env[HOST_CONFIG_ENV] && data && hostDir === path.join(data, 'host-config') ? data : null
  const cacheKey = `${key}\0${impliedDataRoot}`
  if (!cache.has(cacheKey)) cache.set(cacheKey, resolve(file ? parse(file) : {}, { root, file, pending, impliedDataRoot }))
  return cache.get(cacheKey)
}

function resolve (data, { root, file, pending, impliedDataRoot = null }) {
  return {
    file,
    pending,
    projectsRoot: data.projectsRoot ?? path.dirname(path.resolve(root)),
    dataRoot: data.dataRoot ? expandHome(data.dataRoot) : impliedDataRoot,
    gitStore: data.gitStore === true,
    nestedRepositories: data.nestedRepositories ?? 'gitlink',
    projectDiscovery: data.projectDiscovery ? { pattern: data.projectDiscovery.pattern, markers: data.projectDiscovery.markers ?? DEFAULT_PROJECT_MARKERS } : null,
    proxyLogin: {
      usersDir: data.proxyLogin?.usersDir ? data.proxyLogin.usersDir.replaceAll('{hostname}', os.hostname()) : null,
      digestFiles: data.proxyLogin?.digestFiles ?? DEFAULT_DIGEST_FILES
    },
    projectActions: { headerMarkers: ['DEVPANEL', ...(data.projectActions?.headerMarkers ?? []).filter((m) => m !== 'DEVPANEL')] },
    testDrive: { confinement: { user: data.testDrive?.confinement?.user ?? null, home: data.testDrive?.confinement?.home ?? null } },
    selection: { forbiddenPrefixes: data.selection?.forbiddenPrefixes ?? DEFAULT_FORBIDDEN_PREFIXES, allowedHomePaths: (data.selection?.allowedHomePaths ?? []).map(expandHome) },
    harnesses: { disabled: data.harnesses?.disabled ?? [] },
    fence: { readOnly: (data.fence?.readOnly ?? []).map(expandHome) },
    tooling: { nodeModules: data.tooling?.nodeModules === true },
    skill: { linkBaseVariable: data.skill?.linkBaseVariable ?? null },
    reporter: { panelUrl: data.reporter?.panelUrl ?? null },
    seatGuidance: { projects: data.seatGuidance?.projects ?? [] }
  }
}
