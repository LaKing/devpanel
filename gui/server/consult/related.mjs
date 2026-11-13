/*
 * The projects a consult on `project` may read beside it: its framework and
 * what its project file declares related (projects/<id>.yaml `framework`,
 * `workspace.related`). One function for the engine, the supervisor and the CLI.
 */
export function relatedProjects (projects, project) {
  const config = projects?.get(project)
  if (!config) return []
  return [...new Set([config.framework, ...(config.workspace?.related ?? []).map((r) => r.project)].filter((id) => id && id !== project))]
}

/** The configuration files of `project` and of the projects tied to it (projects/<id>.yaml, the installation's copy when it has one). */
export function projectFiles (projects, project) {
  return [project, ...relatedProjects(projects, project)].map((id) => projects?.get(id)).filter((config) => config?.file)
    .map((config) => ({ path: config.file, what: `the panel's configuration of ${config.id}: its check tiers, staging and delivery` }))
}
