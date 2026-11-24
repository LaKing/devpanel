#!/usr/bin/env node
/*
 * List the refs/devpanel/* refs the retention rule would retire, per repository
 * (execution-contract.md "Retiring refs/devpanel/*"). Read-only unless --apply.
 *
 *   npm run --silent retire-refs                      every project with issues, as JSON
 *   npm run --silent retire-refs -- --project <id>    one project (repeatable)
 *   npm run --silent retire-refs -- --apply           retire them: one transaction per repository,
 *                                                     under its delivery lock, proofs made again there
 *
 * The listing takes no lock and writes nothing. Any enumeration error or Git
 * warning aborts: the JSON then says `aborted: true` with what failed, and the
 * exit status is 1 — never a count of zero standing for "could not tell".
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { supportedActions } from '../server/supervisor.mjs'
import { issuesRoot, resolveProjectPath } from '../server/project-path.mjs'
import { gitStoreDir } from '../server/runtime/git-store.mjs'
import { applyRetirement, RefRetirementAborted, scanRetirement, strictGit } from '../server/runtime/ref-retention.mjs'

/**
 * The arguments, strictly: --apply, and --project <id> with a project name. Anything
 * else (an unknown flag, a --project with no name or a flag as its name) refuses
 * before anything is read, so a malformed scope can never widen an --apply.
 */
function parseArguments (argv) {
  let apply = false
  const only = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--project') {
      const name = argv[i + 1]
      if (!name || name.startsWith('-') || path.basename(name) !== name || ['.', '..'].includes(name)) return { error: `--project needs a project name${name ? `, not ${name}` : ''}` }
      only.push(name)
      i++
      continue
    }
    return { error: `unknown argument ${arg}; usage: retire-refs [--project <id>]... [--apply]` }
  }
  return { apply, only }
}

const args = parseArguments(process.argv.slice(2))
const apply = args.apply === true
const only = args.only ?? []

/** Each project's repositories: its checkout's Git common directory, and the panel's Git store for it when there is one. */
async function repositoriesOf (projects) {
  const byRepository = new Map()
  const add = (repository, project) => byRepository.set(repository, [...new Set([...(byRepository.get(repository) ?? []), project])])
  for (const project of projects) {
    const at = { project, step: 'project repository' }
    const checkout = await resolveProjectPath(project).catch((error) => { throw new RefRetirementAborted(`project ${project} has no readable checkout: ${error.message}`, { kind: 'enumeration', at }) })
    const common = (await strictGit(['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir']).catch((error) => { error.at ??= at; throw error })).trim()
    add(await fs.realpath(common), project)
    const store = gitStoreDir(project)
    if (store && await fs.stat(store).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw new RefRetirementAborted(`cannot read ${store}: ${error.code}`, { kind: 'enumeration', at }) })) add(await fs.realpath(store), project)
  }
  return [...byRepository].map(([repository, projects]) => ({ repository, projects }))
}

async function main () {
  if (args.error) throw new RefRetirementAborted(args.error, { kind: 'arguments', at: { step: 'arguments' } })
  const root = issuesRoot()
  let projects
  try {
    projects = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch (error) {
    throw new RefRetirementAborted(`cannot list ${root}: ${error.code ?? error.message}`, { kind: 'enumeration', at: { step: 'issues' } })
  }
  if (only.length) {
    const missing = only.filter((p) => !projects.includes(p))
    if (missing.length) throw new RefRetirementAborted(`no issues directory for ${missing.join(', ')} under ${root}`, { kind: 'enumeration', at: { step: 'projects' } })
    projects = only
  }
  const repositories = await repositoriesOf(projects)
  const actionsOf = (run) => supportedActions(run)
  const generatedAt = new Date().toISOString()
  if (!apply) {
    const { reports } = await scanRetirement({ issuesRoot: root, repositories, actionsOf })
    return { generatedAt, mode: 'list', issuesRoot: root, repositories: reports }
  }
  const outcomes = await applyRetirement({ issuesRoot: root, repositories, actionsOf })
  return { generatedAt, mode: 'apply', issuesRoot: root, repositories: outcomes }
}

try {
  process.stdout.write(JSON.stringify(await main(), null, 2) + '\n')
} catch (error) {
  const report = error instanceof RefRetirementAborted ? error.toJSON() : { aborted: true, kind: 'error', message: error.message, at: null }
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'list', ...report }, null, 2) + '\n')
  process.exitCode = 1
}
