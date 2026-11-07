import fs from 'node:fs/promises'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { resolvePlaybook, loadConfig, projectConfig } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { startRun, reserveRun } from '../server/runtime/launch.mjs'
import { inspectEnvironment, projectInfrastructure } from '../server/infrastructure.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-infrastructure-'))
  const previous = process.env.DEVPANEL_SSH_BIN
  const prompts = []
  const script = scriptFor()
  const f = await engineFixture({ script: args => { prompts.push(args); return script(args) } })
  const infra = {
    kind: 'boilerplate', orientation: 'Application collection is App-modules; framework ownership is separate.',
    staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage', workdir: dir }, projectRoot: '/opt/stage', files: { log: path.join(dir, 'stage.log') }, statusCommand: 'printf staging-ready' },
    deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:production', workdir: '/srv' }, projectRoot: '/opt/production', files: {} }],
    testDrive: { commands: [{ id: 'candidate', run: 'test -f source.txt && printf candidate-tested' }], finallyCommands: [{ id: 'cleanup', run: 'printf cleanup-confirmed' }],
      // The coding playbooks' per-revision check (the modules tier); the commands above stay for the full verification.
      modules: { collections: ['@*'], lint: { id: 'lint', run: 'ls {{files}}' }, load: { id: 'load', run: 'test -f source.txt && printf candidate-loaded' }, restart: { id: 'restart', run: 'true' }, ready: { id: 'ready', run: 'true' },
        test: { id: 'module-selftest', run: 'ls -d {{filter}}' }, finallyCommands: [{ id: 'cleanup', run: "printf 'cleanup-confirmed\\n== runtime/selftest.report\\n{\"tests\":[]}\\n'", report: 'selftest' }] } }
  }
  const file = path.join(f.configRoot, 'projects/devpanel-project.yaml')
  const write = async value => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, YAML.stringify({ id: 'devpanel-project', infrastructure: value })) }
  const resolve = () => resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project' })
  try {
    const shim = path.join(dir, 'ssh')
    const managerEnv = await installRemoteManager(dir)
    await fs.writeFile(shim, '#!/bin/sh\n'+managerEnv+'\nfor last; do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 })
    process.env.DEVPANEL_SSH_BIN = shim
    await write(infra)
    const first = await resolve()
    t.ok('infrastructure-only project configuration validates', first.ok)
    t.eq('infrastructure does not authorize source integration', (await projectConfig('devpanel-project', { root: f.configRoot, projectPath: f.projectPath })).declared, false)
    t.eq('project staging replaces absent playbook check target', first.resolved.checks.target.ssh.hostRef, 'ssh-config:stage')
    t.eq('staging test drive is required by default', first.resolved.checks.requirement, 'required')
    const preview = await previewRun({ playbookId: f.playbookId, configRoot: f.configRoot, project: { id: 'devpanel-project', path: f.projectPath } })
    t.eq('preview carries the same project configuration hash', preview.configHash, first.resolved.configHash)
    t.eq('preview exposes container orientation', preview.infrastructure.orientation, infra.orientation)
    await write({ ...infra, orientation: 'Changed orientation' })
    t.ok('infrastructure changes invalidate previews', (await resolve()).resolved.configHash !== first.resolved.configHash)
    let refused = false
    try { await reserveRun({ playbookId: f.playbookId, configRoot: f.configRoot, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, expectConfigHash: first.resolved.configHash }) } catch (e) { refused = e.status === 409 }
    t.ok('start refuses a stale infrastructure preview', refused)
    for (const [label, mutate] of [
      ['missing staging', v => { delete v.staging }],
      ['no deployment containers', v => { v.deployments = [] }],
      ['duplicate environment ids', v => { v.deployments[0].id = 'stage' }],
      ['deployment used as staging', v => { v.deployments[0].ssh.hostRef = 'ssh-config:stage' }],
      ['only optional tests', v => { v.testDrive.commands[0].required = false }],
      ['unsafe remote workdir', v => { v.staging.ssh.workdir = "/opt/'; touch /tmp/no" }]
    ]) {
      const invalid = structuredClone(infra); mutate(invalid); await write(invalid)
      t.ok(label + ' is rejected', (await loadConfig({ root: f.configRoot })).errors.length > 0)
    }
    await write(infra)
    await fs.writeFile(path.join(dir, 'stage.log'), 'x'.repeat(40000) + '\nlatest diagnostic\n')
    const log = await inspectEnvironment({ project: 'devpanel-project', environment: 'stage', resource: 'log' }, { root: f.configRoot })
    t.ok('remote diagnostics are bounded and include latest output', log.available && log.stdout.length <= 32768 && log.stdout.includes('latest diagnostic'))
    let unknown = false
    try { await inspectEnvironment({ project: 'devpanel-project', environment: 'production', resource: '/etc/passwd' }, { root: f.configRoot }) } catch { unknown = true }
    t.ok('unconfigured diagnostic paths cannot be requested', unknown)
    const refusedStatus = (args) => inspectEnvironment(args, { root: f.configRoot }).then(() => null, (error) => error.status)
    t.eq('an unknown resource is a refusal, not a fault', await refusedStatus({ project: 'devpanel-project', environment: 'production', resource: '/etc/passwd' }), 400)
    t.eq('an unknown environment too', await refusedStatus({ project: 'devpanel-project', environment: 'nowhere' }), 400)
    for (const resource of ['constructor', '__proto__', 'toString']) {
      let denied = false
      try { await inspectEnvironment({ project: 'devpanel-project', environment: 'production', resource }, { root: f.configRoot }) } catch (error) { denied = error.message === 'Unknown configured diagnostic resource' }
      t.ok(`${resource} is not a configured resource`, denied)
    }
    t.eq('supervisor has an explicit diagnostics action', parseSupervisorResponse(JSON.stringify({ message: 'Read staging log', action: { type: 'inspect_environment', project: 'devpanel-project', environment: 'stage', resource: 'log' } })).action.type, 'inspect_environment')
    const supervisorPrompts = []
    let diagnosticCalls = 0
    const supervisor = await createTopSupervisor({
      dir: path.join(dir, 'supervisor'), models: async () => [{ id: 'test', model: 'fake', verification: { status: 'verified' } }],
      adapter: { invoke: async args => {
        supervisorPrompts.push(JSON.parse(args.prompt))
        const number = supervisorPrompts.length
        return { session: { id: 'test-session' }, usage: { costUsd: 0 }, response: JSON.stringify({ message: 'Inspecting staging', action: number <= 2 ? {
          type: 'inspect_environment', project: number === 1 ? 'devpanel-project' : 'outside-project', environment: 'stage', resource: 'log'
        } : null }) }
      } },
      tools: { projects: async () => [{ id: 'devpanel-project' }], playbooks: async () => [], listIssues: async () => [],
        infrastructure: project => projectInfrastructure(project, { root: f.configRoot }),
        inspectEnvironment: args => { diagnosticCalls++; return inspectEnvironment(args, { root: f.configRoot }) }
      }
    })
    try {
      await supervisor.start({ model: 'test', projects: ['devpanel-project'], message: 'Read staging diagnostics', limits: { maxCalls: 4 } })
      const deadline = Date.now() + 8000
      while (supervisorPrompts.length < 3 || supervisor.get().status !== 'active') {
        if (Date.now() > deadline) throw new Error('supervisor diagnostics timeout')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      t.ok('supervisor receives container configuration every turn', supervisorPrompts.every(p => p.infrastructure['devpanel-project'].staging.id === 'stage'))
      t.ok('supervisor receives actual remote diagnostic output', supervisorPrompts[1].event.result.stdout.includes('latest diagnostic'))
      t.eq('out-of-scope inspection never reaches SSH', diagnosticCalls, 1)
    } finally { await supervisor.shutdown() }
    const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath,
      configRoot: f.configRoot, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
    await engine.drive()
    // The seats that can act on containers get the brief. Coordinator turns are
    // tool-free (no SSH, no shell): the engine leaves it out of theirs.
    t.ok('implementer and auditor receive infrastructure', ['implementer', 'auditor-1'].every(role => prompts.some(p => p.role === role && p.prompt.includes(infra.orientation) && p.prompt.includes('inspection-only'))))
    t.ok('authored handoffs to working seats cannot omit the infrastructure brief', prompts.filter(p => p.role !== 'coordinator').every(p => p.prompt.includes(infra.orientation)))
    t.ok('tool-free coordinator turns are not given access they cannot use', prompts.filter(p => p.role === 'coordinator').every(p => !p.prompt.includes('inspection-only')))
    t.ok('engine records successful revision-bound modules-tier checks over SSH', engine.run.checkResults.length > 0 && engine.run.checkResults.every(c => c.result === 'passed' && c.tier === 'modules' && c.revision && c.commands.some(cmd => cmd.id === 'load') && c.commands.some(cmd => cmd.id === 'cleanup')), JSON.stringify(engine.run.checkResults.map(c => [c.result, c.tier, c.error])))
    t.ok('the drive held its staging host exclusively', engine.run.checkResults.every(c => c.driveSlot?.exclusive === true))
    await write({ ...infra, orientation: 'Future runs only' })
    t.eq('active run keeps its original infrastructure snapshot', engine.snapshot.infrastructure.orientation, infra.orientation)
  } finally {
    if (previous === undefined) delete process.env.DEVPANEL_SSH_BIN
    else process.env.DEVPANEL_SSH_BIN = previous
    await fs.rm(dir, { recursive: true, force: true })
  }
}
