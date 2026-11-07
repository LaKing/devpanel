import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

import { loadConfig } from '../server/config/load.mjs'
import { poolIdOf, poolMembers, poolOf, poolRecord } from '../server/runtime/module-pool.mjs'
import { cleanupSandboxes, sandbox } from './helpers.mjs'

export const name = 'module pool — a framework and its instances share one pool; the owner of each module; framework declarations validated'

const modulesOf = (collections) => ({ infrastructure: { testDrive: { modules: { collections } } } })

export default async function (t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'module-pool-')))
  try {
    // The framework owns @c/x and @c/y; instance-a links its @c collection into the framework and has a-modules/m;
    // instance-b has its own b-modules/n; standalone-project is a pool of its own; plain-project declares no modules.
    const dir = (id) => path.join(root, id)
    await fs.mkdir(path.join(dir('framework-project'), '@c', 'x'), { recursive: true })
    await fs.mkdir(path.join(dir('framework-project'), '@c', 'y'), { recursive: true })
    await fs.writeFile(path.join(dir('framework-project'), '@c', 'README.md'), 'not a module\n')
    await fs.mkdir(path.join(dir('instance-a-project'), 'a-modules', 'm'), { recursive: true })
    await fs.symlink(path.join(dir('framework-project'), '@c'), path.join(dir('instance-a-project'), '@c'))
    await fs.mkdir(path.join(dir('instance-b-project'), 'b-modules', 'n'), { recursive: true })
    await fs.mkdir(path.join(dir('standalone-project'), 's-modules', 'q'), { recursive: true })
    const projects = new Map([
      ['framework-project', { id: 'framework-project', ...modulesOf(['@*']), modulePool: { hookReader: { run: 'read-hooks' } } }],
      ['instance-a-project', { id: 'instance-a-project', framework: 'framework-project', ...modulesOf(['@*', '*-modules']) }],
      ['instance-b-project', { id: 'instance-b-project', framework: 'framework-project', ...modulesOf(['b-modules']) }],
      ['standalone-project', { id: 'standalone-project', ...modulesOf(['*-modules']) }],
      ['plain-project', { id: 'plain-project' }]
    ])
    const resolvePath = async (id) => dir(id)

    t.section('pool identity and members')
    t.eq('an instance is in its framework\'s pool', poolIdOf('instance-a-project', projects), 'framework-project')
    t.eq('the framework is its own pool', poolIdOf('framework-project', projects), 'framework-project')
    t.eq('a project with modules and no framework is a pool of its own', poolIdOf('standalone-project', projects), 'standalone-project')
    t.eq('a project without modules has none', poolIdOf('plain-project', projects), null)
    t.eq('members: the framework first, then its instances', poolMembers('framework-project', projects), ['framework-project', 'instance-a-project', 'instance-b-project'])

    t.section('the modules and the project that owns each')
    {
      const fromInstance = await poolOf('instance-a-project', { projects, resolvePath })
      const fromFramework = await poolOf('framework-project', { projects, resolvePath })
      const owners = poolRecord(fromInstance).owners
      t.eq('the framework\'s modules plus every instance\'s own', owners, { '@c/x': 'framework-project', '@c/y': 'framework-project', 'a-modules/m': 'instance-a-project', 'b-modules/n': 'instance-b-project' })
      t.eq('a framework module reached through an instance\'s link belongs to the framework, so one lock key serves every member', fromInstance.modules.get('@c/x').owner, 'framework-project')
      t.eq('read from any member, the pool is the same', poolRecord(fromFramework).owners, owners)
      t.eq('the framework\'s collections and its hook reader are the pool\'s', [fromInstance.frameworkCollections, fromInstance.hookReader], [['@*'], { run: 'read-hooks' }])
      t.eq('nothing ambiguous or unreadable', [fromInstance.ambiguous, fromInstance.unreadable], [[], []])
      const alone = await poolOf('standalone-project', { projects, resolvePath })
      t.eq('a pool of its own has its own modules and no framework', [alone.framework, poolRecord(alone).owners], [null, { 's-modules/q': 'standalone-project' }])
      t.eq('no pool, no reading', await poolOf('plain-project', { projects, resolvePath }), null)
      const unreadable = await poolOf('instance-b-project', { projects, resolvePath: async (id) => id === 'instance-a-project' ? path.join(root, 'missing') : dir(id) })
      t.eq('a member whose checkout cannot be read contributes nothing and is named', unreadable.unreadable, ['instance-a-project'])
    }

    t.section('projects/<id>.yaml: framework validated by the schema and the loader')
    {
      const write = (cfg, files) => Promise.all(Object.entries(files).map(([id, data]) => fs.mkdir(path.join(cfg, 'projects'), { recursive: true }).then(() => fs.writeFile(path.join(cfg, 'projects', `${id}.yaml`), YAML.stringify({ id, ...data })))))
      const projectErrors = async (files) => {
        const cfg = await sandbox((d) => write(d, files))
        const loaded = await loadConfig({ root: cfg })
        return { loaded, errors: loaded.errors.filter((e) => e.file?.includes('/projects/')).map((e) => e.message) }
      }
      // A framework file declares something of its own (here a workspace policy); `framework:` alone is an instance's declaration.
      const FRAMEWORK = { workspace: { base: 'head' } }
      const good = await projectErrors({ 'framework-project': FRAMEWORK, 'instance-a-project': { framework: 'framework-project' } })
      t.eq('an instance naming a configured framework loads', [good.errors, good.loaded.projects.get('instance-a-project')?.framework], [[], 'framework-project'])
      const unknown = await projectErrors({ 'instance-a-project': { framework: 'missing-project' } })
      t.ok('an unknown framework is refused', unknown.errors.some((m) => /not a configured project/.test(m)) && !unknown.loaded.projects.has('instance-a-project'), unknown.errors.join('; '))
      const self = await projectErrors({ 'instance-a-project': { framework: 'instance-a-project' } })
      t.ok('a project cannot be its own framework', self.errors.some((m) => /its own framework/.test(m)), self.errors.join('; '))
      const chained = await projectErrors({ 'framework-project': FRAMEWORK, 'middle-project': { framework: 'framework-project' }, 'instance-a-project': { framework: 'middle-project' } })
      t.ok('a framework that names a framework is refused: one level', chained.errors.some((m) => /names a framework itself/.test(m)), chained.errors.join('; '))
      const badShape = await projectErrors({ 'instance-a-project': { framework: 'Not A Project!' } })
      t.ok('the schema refuses a malformed id', badShape.errors.length > 0 && !badShape.loaded.projects.has('instance-a-project'))
      const reader = await projectErrors({ 'framework-project': { modulePool: { hookReader: { run: 'read-hooks' } } } })
      t.ok('a hook reader needs a modules declaration', reader.errors.some((m) => /hookReader needs/.test(m)), reader.errors.join('; '))
    }
  } finally {
    await cleanupSandboxes()
    await fs.rm(root, { recursive: true, force: true })
  }
}
