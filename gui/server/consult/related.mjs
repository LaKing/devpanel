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
