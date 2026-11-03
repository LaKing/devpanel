import { writeJson, appendDurable } from './runtime/persistence.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { acquire } from './runtime/lock.mjs'
import { runProcess } from './runtime/process.mjs'
import { projectInfrastructure } from './infrastructure.mjs'
import { DEPLOYMENT_UNPROVEN } from './staging-coverage.mjs'

// Only saved operator commands are executable. A model supplies an issue, not
// shell text or a destination. One durable deployment per issue prevents replay
// after timeouts, crashes, lost responses, or another supervisor activation.
export async function deployStaging ({ project, issuePath, root, signal, retryFailed = null, coverage = null }) {
  const infrastructure = await projectInfrastructure(project, { root })
  const config = infrastructure?.stagingDeployment
  if (!config?.enabled) throw new Error('Shared staging deployment is not enabled for this project')
  const dir = path.join(issuePath, 'operations')
  await fs.mkdir(dir, { recursive: true })
  const lock = await acquire(path.join(path.dirname(issuePath), '.staging-deployment.lock'), { purpose: 'shared-staging-deployment' })
  const file = path.join(dir, 'staging-deployment.json')
  try {
    let previous
    try { previous = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (retryFailed) {
      if (!previous || previous.id !== retryFailed || previous.status !== 'failed') throw new Error('Retry requires the exact ID of a failed operation after inspecting its effects')
      if (signal?.aborted) throw new Error('Staging deployment cancelled before retry')
      const archive = path.join(dir, `staging-deployment-${previous.id}.json`)
      try { await appendDurable(archive, await fs.readFile(file), { flag: 'wx' }) } catch (error) {
        if (error.code !== 'EEXIST' || (await fs.readFile(archive, 'utf8')) !== (await fs.readFile(file, 'utf8'))) throw error
        await appendDurable(archive, '') // A prior attempt may have failed its sync.
      }
      previous = null
    }
    if (previous) return { ...previous, status: previous.status === 'running' ? 'recovery-required' : previous.status, replayed: true, replayNotice: 'Stored operation returned; deployment was not repeated. An interrupted or failed deployment must be inspected before a separately requested retry.' }
    if (signal?.aborted) throw new Error('Staging deployment cancelled before start')
    const state = { id: crypto.randomUUID(), project, environment: infrastructure.staging.id, retryOf: retryFailed, status: 'running', startedAt: new Date().toISOString(), configHash: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'), commands: [] }
    const save = () => writeJson(file, state)
    // The record of what this deployment names (staging-coverage.mjs), in the first
    // save so every way out has it. It never decides whether commands run.
    if (coverage) state.coverage = await coverage.before(state.startedAt).catch((error) => ({ basis: DEPLOYMENT_UNPROVEN, covered: [], indeterminate: [], error: error.message }))
    const readAfter = async () => { if (coverage && !state.coverage.error) await coverage.after(state.coverage).catch(() => {}) }
    await save()
    const plan = [...config.commands.map(c => ({ ...c, diagnostic: false })), ...(config.diagnostics ?? []).map(c => ({ ...c, diagnostic: true }))]
    for (const command of plan) {
      if (state.status === 'failed' && !command.diagnostic) continue
      if (signal?.aborted) {
        state.status = 'recovery-required'; state.endedAt = new Date().toISOString()
        await readAfter(); await save(); return state
      }
      const result = { id: command.id, diagnostic: command.diagnostic, status: 'running', startedAt: new Date().toISOString() }
      state.commands.push(result)
      await save()
      try {
        const timeout = AbortSignal.timeout((command.timeoutSeconds ?? 900) * 1000)
        const run = await runProcess({ command: '/bin/bash', args: ['-e', '-o', 'pipefail', '-c', command.run], cwd: config.workdir,
          env: { ...process.env, DEVPANEL_OPERATION_STARTED_AT: state.startedAt },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout, maxBuffer: 512 * 1024 })
        Object.assign(result, { status: run.cancelled ? 'interrupted' : run.code === 0 ? 'completed' : 'failed', exitCode: run.code,
          stdout: run.stdout, stderr: run.stderr, truncated: run.truncated ?? false })
      } catch (error) { Object.assign(result, { status: 'failed', error: error.message }) }
      result.endedAt = new Date().toISOString()
      if (result.status !== 'completed') {
        state.status = result.status === 'interrupted' ? 'recovery-required' : 'failed'
        state.endedAt = result.endedAt
        if (state.status === 'recovery-required') await readAfter()
        await save()
        if (state.status === 'recovery-required') return state
      }
      await save()
    }
    if (state.status === 'running') state.status = 'completed'
    state.endedAt = new Date().toISOString()
    await readAfter()
    await save()
    return state
  } finally { await lock.release() }
}

export function deploymentReport (result) {
  const named = result.coverage?.indeterminate ?? []
  const coverage = !result.coverage ? ''
    : result.coverage.error ? `## Coverage\n\nCould not be recorded: ${result.coverage.error}\n\n`
    : `## Coverage\n\nWhat this deployment shipped is unproven, so it covers no run and clears none; only a Staging run can.${named.length ? ` Named, with what the development checkout held of each before and after the commands (information only): ${named.map(e => `\`${e.runId}\` (${e.issueId}): ${e.checkout?.before ?? 'not-read'} / ${e.checkout?.after ?? 'not-read'}`).join('; ')}.` : ' No delivered run was waiting.'}\n\n`
  return `# Shared staging deployment: ${result.status}\n\nEnvironment: ${result.environment}\nStarted: ${result.startedAt}\nEnded: ${result.endedAt ?? 'not confirmed'}\n\n` + coverage + result.commands.map(c => `## ${c.id}: ${c.status}\n\n${c.startedAt} — ${c.endedAt ?? 'not confirmed'}\n${c.truncated ? '\nOutput was truncated to the configured buffer limit.\n' : ''}\n\`\`\`text\n${c.stdout ?? ''}\n${c.stderr ?? c.error ?? ''}\n\`\`\`\n`).join('\n')
}
