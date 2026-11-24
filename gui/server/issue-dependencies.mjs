import { getIssue, IssueError } from './issues.js'
import { updateIssueMeta } from './issue-meta.mjs'
import { settled } from './issue-family.mjs'

/*
 * Prerequisites between issues. A run on an issue whose prerequisite is still
 * open spends a start to learn that it must wait: an issue started before the
 * one whose rule it depends on can only have its triage ask the owner.
 * Recorded by an operator or the supervisor,
 * shown as `waitingOn` in the supervisor's overview, and the supervisor's
 * start_run refuses an issue while one is open. An operator may still start
 * it from the panel: the order is management, not a lock.
 *
 * A prerequisite is settled once it has a disposition or is archived (issue-family.mjs `settled`).
 */


const parse = (project, ref) => ref.includes('/') ? ref.split('/', 2) : [project, ref]

export async function setIssueDependencies (project, id, { dependsOn, reason, by = 'operator' } = {}, { getIssue: read = getIssue } = {}) {
  if (!Array.isArray(dependsOn) || dependsOn.some((r) => typeof r !== 'string' || !r.trim())) throw new IssueError('dependsOn must be a list of issue ids (same project, or project/id)')
  if (dependsOn.length && (typeof reason !== 'string' || !reason.trim())) throw new IssueError('dependencies need a reason: say what the issue waits for')
  if (!['operator', 'supervisor'].includes(by)) throw new IssueError('by must be operator or supervisor')
  const issue = await read(project, id)
  if (issue.packed) throw new IssueError('an archived issue cannot be changed', 409)
  if (issue.kind === 'inquiry') throw new IssueError('an inquiry has no dependencies', 409)
  const issues = []
  for (const ref of new Set(dependsOn.map((r) => r.trim()))) {
    const [p, i] = parse(project, ref)
    if (p === project && i === id) throw new IssueError('an issue cannot depend on itself')
    const dep = await read(p, i).catch(() => { throw new IssueError(`issue ${ref} does not exist`, 404) })
    // A cycle of any length would hold every issue on it forever. Split chains are written automatically
    // (owner-input.mjs), so a longer cycle is no longer only something a person would notice.
    const through = await pathBack(dep, { project, id }, read)
    if (through) throw new IssueError(`${ref} already depends on this issue${through.length ? ` (through ${through.join(' → ')})` : ''}`)
    issues.push({ project: p, id: i })
  }
  await updateIssueMeta(issue.path, (meta) => {
    meta.dependsOn = issues.length ? { issues, reason: reason.trim(), by, at: new Date().toISOString() } : null
  })
  return read(project, id)
}

/**
 * The prerequisites `from` waits for, followed until `target` is reached: the intermediate issues in between
 * (empty for a direct edge), or null when `target` is not among them. A missing issue ends its branch.
 */
async function pathBack (from, target, read, limit = 1000) {
  const seen = new Set()
  const walk = async (issue, trail) => {
    for (const d of issue.dependsOn?.issues ?? []) {
      if (d.project === target.project && d.id === target.id) return trail
      const key = `${d.project}/${d.id}`
      if (seen.has(key) || seen.size >= limit) continue
      seen.add(key)
      const next = await read(d.project, d.id).catch(() => null)
      const found = next && await walk(next, [...trail, d.project === target.project ? d.id : key])
      if (found) return found
    }
    return null
  }
  return walk(from, [])
}

/** The prerequisites of `issue` that are not settled yet, with their names. `getIssue` is injectable for tests. */
export async function openDependencies (issue, { getIssue: read = getIssue } = {}) {
  const open = []
  for (const dep of issue.dependsOn?.issues ?? []) {
    const found = await read(dep.project, dep.id).catch(() => null)
    // A prerequisite that was deleted can no longer hold anything up.
    if (found && !settled(found)) open.push({ project: dep.project, id: dep.id, name: found.name })
  }
  return open
}
