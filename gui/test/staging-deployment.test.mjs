import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { CONFIG_ROOT, sandbox } from './helpers.mjs'
import { deployStaging } from '../server/staging-deployment.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'staging-operation-'))
  const root = await sandbox()
  const cfg = YAML.parse(await fs.readFile(path.join(CONFIG_ROOT, 'examples/host-config/projects/example-project.yaml'), 'utf8'))
  cfg.id = 'fixture'
  cfg.infrastructure.stagingDeployment = { enabled: true, notes: 'Fixture operation', workdir: dir, commands: [
    { id: 'deploy', run: 'printf deployed >> count; printf started', timeoutSeconds: 2 },
    { id: 'observe', run: 'printf observed', timeoutSeconds: 2 }
  ] }
  await fs.mkdir(path.join(root, 'projects'), { recursive: true })
  const save = () => fs.writeFile(path.join(root, 'projects/fixture.yaml'), YAML.stringify(cfg))
  // An issue's folder exists before anything deploys for it: the deployment takes its run lock and never creates it.
  const call = async (issue, extra = {}) => {
    await fs.mkdir(path.join(dir, issue), { recursive: true })
    return deployStaging({ project: 'fixture', issuePath: path.join(dir, issue), root, ...extra })
  }
  try {
    await save()
    const originalOpen = fs.open
    fs.open = async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode)
      if (String(file).includes('staging-deployment.json.') && flags === 'wx') handle.sync = async () => { throw new Error('deployment-sync-failed') }
      return handle
    }
    let syncFailure
    try { await call('unsynced') } catch (error) { syncFailure = error } finally { fs.open = originalOpen }
    t.eq('deployment refuses a non-durable intent record', syncFailure?.message, 'deployment-sync-failed')
    t.eq('no deployment starts before durable intent', await fs.access(path.join(dir, 'count')).then(() => true, () => false), false)
    const result = await call('success')
    t.eq('deploy and observation complete in order', result.commands.map(c => c.id + ':' + c.status), ['deploy:completed', 'observe:completed'])
    t.eq('log evidence is retained', result.commands[1].stdout, 'observed')
    t.eq('result persists on disk', JSON.parse(await fs.readFile(path.join(dir, 'success/operations/staging-deployment.json'))).status, 'completed')
    t.eq('repeated requests return stored evidence', (await call('success')).replayed, true)
    t.eq('deployment did not execute twice', await fs.readFile(path.join(dir, 'count'), 'utf8'), 'deployed')
    cfg.infrastructure.stagingDeployment.commands[0].run = 'printf failed >&2; exit 3'
    cfg.infrastructure.stagingDeployment.diagnostics = [{ id: 'diagnostic', run: 'printf "$DEVPANEL_OPERATION_STARTED_AT"', timeoutSeconds: 2 }]
    await save()
    const failure = await call('failure')
    t.eq('failed deployment skips remaining actions but collects diagnostics', [failure.status, failure.commands.map(c => c.id)], ['failed', ['deploy', 'diagnostic']])
    t.eq('diagnostics are bound to the operation start', failure.commands[1].stdout, failure.startedAt)
    t.eq('failures cannot silently replay', (await call('failure')).replayed, true)
    let wrongRetry = false
    try { await call('failure', { retryFailed: 'wrong-id' }) } catch { wrongRetry = true }
    t.ok('operator retry is bound to the inspected failed attempt', wrongRetry)
    cfg.infrastructure.stagingDeployment.commands[0].run = 'printf repaired'
    await save()
    const retry = await call('failure', { retryFailed: failure.id })
    t.eq('explicit operator retry succeeds', retry.status, 'completed')
    t.eq('retry records the previous failed attempt', retry.retryOf, failure.id)
    t.eq('previous failure is archived intact', JSON.parse(await fs.readFile(path.join(dir, `failure/operations/staging-deployment-${failure.id}.json`))).status, 'failed')
    const stale = path.join(dir, 'stale/operations')
    await fs.mkdir(stale, { recursive: true }); await fs.writeFile(path.join(stale, 'staging-deployment.json'), JSON.stringify({ status: 'running', commands: [] }))
    t.eq('interrupted state requires recovery instead of replay', (await call('stale')).status, 'recovery-required')
    cfg.infrastructure.stagingDeployment.commands[0].run = 'sleep 5'
    cfg.infrastructure.stagingDeployment.commands[0].timeoutSeconds = 1
    await save()
    t.eq('deadline stops the operation and requires inspection', (await call('timeout')).status, 'recovery-required')
    cfg.infrastructure.stagingDeployment.enabled = false
    await save()
    let denied = false
    try { await call('disabled') } catch { denied = true }
    t.ok('unconfigured deployment authority fails closed', denied)
    t.eq('supervisor accepts only a project and issue for deployment', parseSupervisorResponse('{"message":"Deploy requested stage","action":{"type":"deploy_staging","project":"fixture","issueId":"success"}}').action.type, 'deploy_staging')
    let arbitrary = false
    try { parseSupervisorResponse('{"message":"x","action":{"type":"deploy_staging","project":"fixture","issueId":"success","command":"arbitrary"}}') } catch { arbitrary = true }
    t.ok('model cannot supply commands or destinations', arbitrary)
    let deployments = 0, turns = 0
    const supervisor = await createTopSupervisor({ dir: path.join(dir, 'supervisor'),
      models: async () => [{ id: 'fixture', verification: { status: 'verified' } }],
      adapter: { invoke: async args => ({ session: { id: 'session' }, response: JSON.stringify({ message: 'Staging operation', action: turns++ === 0 ? { type: 'deploy_staging', project: 'fixture', issueId: 'issue' } : null }), usage: { costUsd: 0 } }) },
      tools: { projects: async () => [{ id: 'fixture' }], playbooks: async () => [], listIssues: async () => [],
        deployStaging: async (a, options) => { deployments++; t.eq('operation retains project scope', a.project, 'fixture'); t.ok('stop signal reaches deployment', options.signal instanceof AbortSignal); return { status: 'completed' } }
      }
    })
    try {
      await supervisor.start({ model: 'fixture', projects: ['fixture'], message: 'Deploy shared staging and assess its logs' })
      const deadline = Date.now() + 4000
      while (turns < 2 || supervisor.get().status !== 'active') { if (Date.now() > deadline) throw Error('Supervisor operation timed out'); await new Promise(r => setTimeout(r, 10)) }
      t.eq('supervisor executes the explicit staging operation', deployments, 1)
      t.ok('operation evidence is in supervisor history', supervisor.get().messages.some(m => m.role === 'tool' && m.text.includes('completed')))
    } finally { await supervisor.stop(); await supervisor.shutdown() }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
