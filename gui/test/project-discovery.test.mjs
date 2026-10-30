import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { discoveredProjects, listProjectDirs, projectPath, resolveProjectPath } from '../server/project-path.mjs'
import { knownProjectRoots } from '../server/runtime/selection.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'
import { defaultCanaries } from '../../harness/fence.mjs'

export const name = 'projects discovered below the projects root by pattern and marker (host settings projectDiscovery)'

const run = promisify(execFile)
const KEYS = ['DEVPANEL_PROJECTS_DIR', 'DEVPANEL_ISSUES_DIR', 'DEVPANEL_HOST_CONFIG_DIR']

export default async (t) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const restore = () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-discovery-'))
  try {
    // A work tree by year: two projects of the same name in different years, one
    // directory without a marker, a dot directory, a file, and a marker only one level deeper.
    const root = path.join(fixture, 'work')
    const project = async (rel, marker = 'package.json') => {
      await fs.mkdir(path.join(root, rel), { recursive: true })
      if (marker) await fs.writeFile(path.join(root, rel, marker), '{}')
    }
    await project('2025/shop')
    await project('2026/shop')
    await project('2026/blog')
    await project('2026/api', 'Cargo.toml')
    await project('2026/notes', null)
    await project('2026/.cache')
    await project('2026/deep/inner')
    await fs.writeFile(path.join(root, '2026', 'readme.md'), '')
    await run('git', ['init', '-q', path.join(root, '2026', 'shop')])

    t.section('1. the setting')
    const hostDir = path.join(fixture, 'host-config')
    await fs.mkdir(hostDir)
    t.eq('absent, there is no discovery', hostSettings({ hostDir }).projectDiscovery, null)
    await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ projectsRoot: root, projectDiscovery: { pattern: '*/*' } }))
    t.eq('the markers default to package.json', hostSettings({ hostDir }).projectDiscovery, { pattern: '*/*', markers: ['package.json'] })
    const invalid = path.join(fixture, 'invalid')
    await fs.mkdir(invalid)
    for (const pattern of ['/abs/*', '../*', '*/..']) {
      await fs.writeFile(path.join(invalid, 'settings.json'), JSON.stringify({ projectDiscovery: { pattern } }))
      let error = null
      try { hostSettings({ hostDir: invalid }) } catch (e) { error = e }
      t.ok(`a pattern leaving the root is refused: ${pattern}`, error)
    }

    t.section('2. discovery')
    const found = discoveredProjects(root, { pattern: '*/*', markers: ['package.json'] })
    t.eq('matching directories with a marker, by identity', [...found.keys()], ['2025-shop-project', '2026-blog-project', '2026-shop-project'])
    t.eq('each mapped to its directory', found.get('2025-shop-project'), path.join(root, '2025', 'shop'))
    t.eq('any one marker admits', [...discoveredProjects(root, { pattern: '2026/*', markers: ['package.json', 'Cargo.toml'] }).keys()], ['2026-api-project', '2026-blog-project', '2026-shop-project'])
    t.eq('a literal segment narrows it', [...discoveredProjects(root, { pattern: '2026/sh*', markers: ['package.json'] }).keys()], ['2026-shop-project'])
    t.eq('three levels down', [...discoveredProjects(root, { pattern: '*/*/*', markers: ['package.json'] }).keys()], ['2026-deep-inner-project'])
    t.eq('without the setting it is null', discoveredProjects(root, null), null)

    t.section('3. the panel reads it: listings, paths, repositories, canaries')
    process.env.DEVPANEL_HOST_CONFIG_DIR = hostDir
    delete process.env.DEVPANEL_PROJECTS_DIR
    t.eq('the listing is the discovered projects', (await listProjectDirs()).map((p) => p.id), ['2025-shop-project', '2026-blog-project', '2026-shop-project'])
    t.eq('a project path is its directory', projectPath('2026-shop-project'), path.join(root, '2026', 'shop'))
    t.eq('and resolves there', await resolveProjectPath('2026-shop-project'), await fs.realpath(path.join(root, '2026', 'shop')))
    t.eq('the known repositories come from it', [...await knownProjectRoots()], [await fs.realpath(path.join(root, '2026', 'shop'))])

    const issuesDir = path.join(fixture, 'issues')
    await fs.mkdir(issuesDir)
    process.env.DEVPANEL_ISSUES_DIR = issuesDir
    const issues = await import(`../server/issues.js?discovery=${Date.now()}`)
    const listed = await issues.listProjects()
    t.eq('the issue store lists them', listed.map((p) => p.id), ['2025-shop-project', '2026-blog-project', '2026-shop-project'])
    t.eq('with the year in the label', listed.map((p) => p.label), ['2025-shop', '2026-blog', '2026-shop'])

    const home = path.join(fixture, 'home')
    await fs.mkdir(home)
    const own = path.join(root, '2026', 'shop')
    const canaries = await defaultCanaries({ home, granted: [own] })
    t.ok('a sibling project in the same year is a canary', canaries.includes(path.join(root, '2026', 'blog')), canaries.join(','))
    t.ok('another year is a canary', canaries.includes(path.join(root, '2025')))
    t.ok('the granted project and its year are not', !canaries.includes(own) && !canaries.includes(path.join(root, '2026')))
  } finally {
    restore()
    await fs.rm(fixture, { recursive: true, force: true })
  }
}
