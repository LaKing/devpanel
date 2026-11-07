import fs from 'node:fs/promises'
import path from 'node:path'

import { collectionMatcher } from './modules-tier.mjs'
import { runProcess } from './process.mjs'

/*
 * Hook expansion (execution-contract.md "The modules tier", "Module locks"): a module
 * subscribes to another module's hook through its hooks/ directory. A revision that
 * changes a hook's exported argument signature — its declaration, or the parameters of a
 * hooks/ handler for it — affects every subscriber of that hook in the pool.
 *
 * Hooks are read by the pool's declared reader (projects/<id>.yaml `modulePool.hookReader`),
 * typically a wrapper around the framework's own declaration tooling, run with its working
 * directory at a candidate tree in the panel's local check fence. Its stdout is one JSON
 * object, checked here:
 *
 *   { "declarations": [{ "module", "hook", "signature" }],
 *     "subscribers":  [{ "module", "hook", "parameters" }] }
 *
 * Anything else is a failed reading, and a failed reading never means "no subscribers".
 */

const isString = (v) => typeof v === 'string' && v.length > 0

/** The reader's output, validated; throws with the reason. */
export function parseReading (text) {
  let data
  try { data = JSON.parse(String(text ?? '').trim()) } catch (error) { throw new Error(`the hook reader printed no JSON object (${error.message})`) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the hook reader printed something other than one JSON object')
  const extra = Object.keys(data).filter((k) => !['declarations', 'subscribers'].includes(k))
  if (extra.length) throw new Error(`the hook reader printed unknown keys: ${extra.join(', ')}`)
  if (!Array.isArray(data.declarations) || !Array.isArray(data.subscribers)) throw new Error('the hook reader must print declarations and subscribers as arrays')
  data.declarations.forEach((d, i) => {
    if (!d || !isString(d.module) || !isString(d.hook) || typeof d.signature !== 'string') throw new Error(`declarations[${i}] needs module, hook and signature strings`)
  })
  data.subscribers.forEach((s, i) => {
    if (!s || !isString(s.module) || !isString(s.hook) || typeof s.parameters !== 'string') throw new Error(`subscribers[${i}] needs module, hook and parameters strings`)
  })
  const strip = (m) => m.replace(/\/+$/, '')
  return {
    declarations: data.declarations.map((d) => ({ module: strip(d.module), hook: d.hook, signature: d.signature })),
    subscribers: data.subscribers.map((s) => ({ module: strip(s.module), hook: s.hook, parameters: s.parameters }))
  }
}

/** Hooks whose signature changed between two readings: a declaration's signature, or any handler's parameters. */
export function changedHooks (base, revision) {
  const signatures = (reading) => {
    const out = new Map()
    for (const d of reading?.declarations ?? []) out.set(d.hook, `${out.get(d.hook) ?? ''}\0${d.module}:${d.signature}`)
    return out
  }
  const handlers = (reading) => {
    const out = new Map()
    for (const s of [...(reading?.subscribers ?? [])].sort((a, b) => a.module < b.module ? -1 : 1)) out.set(s.hook, `${out.get(s.hook) ?? ''}\0${s.module}:${s.parameters}`)
    return out
  }
  const changed = new Set()
  for (const [read, a, b] of [[signatures, base, revision], [handlers, base, revision]]) {
    const before = read(a), after = read(b)
    for (const hook of new Set([...before.keys(), ...after.keys()])) {
      if (read === handlers) {
        // A handler that only appears or disappears is a new or dropped subscription, not a signature
        // change; a handler of one module whose parameters differ is.
        const per = (r) => new Map((r?.subscribers ?? []).filter((s) => s.hook === hook).map((s) => [s.module, s.parameters]))
        const x = per(a), y = per(b)
        if ([...x].some(([m, p]) => y.has(m) && y.get(m) !== p)) changed.add(hook)
      } else if (before.get(hook) !== after.get(hook) && before.has(hook) && after.has(hook)) changed.add(hook)
    }
  }
  return [...changed].sort()
}

/**
 * Every subscriber of a changed hook, with provenance: `[{module, project, hooks, inTree}]`,
 * one entry per module. Nothing is subtracted: a subscriber the triage or the changed paths
 * already made affected is named too. `readings` is `[{project, inTree, reading}]`, the
 * run's own tree first; a module read in the run's own tree is tested there (`inTree`), and
 * another member's reading contributes only the modules that member owns.
 */
export function subscribersOf (changed, readings, owners = {}) {
  const hooks = new Set(changed)
  const out = new Map()
  for (const { project, inTree, reading } of readings) {
    for (const s of reading?.subscribers ?? []) {
      if (!hooks.has(s.hook)) continue
      if (!inTree && (owners[s.module] ?? project) !== project) continue
      const entry = out.get(s.module) ?? { module: s.module, project: owners[s.module] ?? project, hooks: [], inTree: Boolean(inTree) }
      if (!entry.hooks.includes(s.hook)) entry.hooks.push(s.hook)
      entry.inTree ||= Boolean(inTree)
      out.set(s.module, entry)
    }
  }
  return [...out.values()].map((e) => ({ ...e, hooks: e.hooks.sort() })).sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0)
}

/** The deduplicated sets the record's provenance feeds: what is locked, and what each drive tests. */
export function combinedSets (affected) {
  const via = affected?.viaHooks ?? []
  const lock = [...new Set([...(affected?.modules ?? []), ...via.map((v) => v.module)])].sort()
  const mainFilters = [...new Set([...(affected?.modules ?? []), ...via.filter((v) => v.inTree).map((v) => v.module)])].sort()
  const byProject = {}
  for (const v of via.filter((v) => !v.inTree)) (byProject[v.project] ??= new Set()).add(v.module)
  return { lock, mainFilters, subscriberDrives: Object.fromEntries(Object.entries(byProject).map(([p, s]) => [p, [...s].sort()])) }
}

/**
 * Another pool member at its committed HEAD with the framework's collections replaced by the
 * candidate's (`from`, the run's worktree at the revision): the tree a subscriber drive tests
 * and a subscriber reading reads. Returns `{ tree, identity }`.
 */
export async function composeTree ({ project, memberPath, frameworkCollections, from, into, revision, signal = null }) {
  await fs.rm(into, { recursive: true, force: true })
  await fs.mkdir(into, { recursive: true })
  const tar = `${into}.tar`
  const git = async (...args) => {
    const out = await runProcess({ command: 'git', args: ['-C', memberPath, ...args], signal, maxBuffer: 1024 * 1024 })
    if (out.code !== 0) throw new Error(`git ${args[0]} in ${project}: ${out.stderr.trim().slice(0, 300) || `exit ${out.code}`}`)
    return out.stdout.trim()
  }
  const sourceHead = await git('rev-parse', 'HEAD')
  await git('archive', '--format=tar', '-o', tar, 'HEAD')
  try {
    const untar = await runProcess({ command: 'tar', args: ['-xf', tar, '-C', into], signal })
    if (untar.code !== 0) throw new Error(`unpacking ${project} failed: ${untar.stderr.trim().slice(0, 300)}`)
  } finally { await fs.rm(tar, { force: true }) }
  const isFramework = collectionMatcher(frameworkCollections)
  // Every framework collection the member's HEAD carries goes first, links to the live framework
  // included: a collection the candidate deleted must not survive in the composed tree.
  const removed = []
  for (const entry of await fs.readdir(into, { withFileTypes: true })) {
    if (!isFramework(entry.name)) continue
    await fs.rm(path.join(into, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  const replaced = []
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (!isFramework(entry.name)) continue
    await fs.rm(path.join(into, entry.name), { recursive: true, force: true })
    await fs.cp(path.join(from, entry.name), path.join(into, entry.name), { recursive: true, dereference: true })
    replaced.push(entry.name)
  }
  return { tree: into, identity: { project, sourceHead, revision, frameworkFrom: 'candidate', replaced: replaced.sort(), dropped: removed.filter((n) => !replaced.includes(n)).sort() } }
}
