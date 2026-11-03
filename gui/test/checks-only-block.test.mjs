import fs from 'node:fs/promises'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { checksOnlyBlock } from '../server/runtime/run-control.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

/*
 * The reviewers approve, the installed check fails, and the author has nothing
 * to change (a flaky or environmental failure): the loop stops at the first
 * unchanged answer instead of replaying the recorded failure until its cap,
 * and refresh-checks reruns the check on that candidate.
 */
async function scenario () {
  const prompts = []
  let engine = null
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    prompts.push({ stepId, role, round })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      if (round === 0) await fs.writeFile(path.join(engine.run.workspace.path, 'work.txt'), 'work\n')
      return fence({ summary: round ? 'The failing check is not caused by this change' : 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
    // Fails on the candidate only (the base has no work.txt): not baseline-known.
    '\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: 0\n    commands:\n      - id: flaky\n        run: test ! -f work.txt\n')
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  return { engine, prompts }
}

export default async function (t) {
  t.section('an approved revision answered unchanged after a failed check stops the loop; refresh-checks reruns it')
  {
    const { engine, prompts } = await scenario()
    t.eq('stopped as checks-failed-unchanged', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked checks-failed-unchanged')
    t.eq('after one unchanged answer, not at the round cap', prompts.filter((p) => p.stepId === 'implement').length, 2)
    t.ok('recognised as a checks-only block', checksOnlyBlock(engine.run))
    t.eq('refresh-checks, continue and accepting the result are offered', supportedActions(engine.run), ['continue', 'refresh-checks', 'accept-check-result', 'start-new'])
    const explanation = explainRun(engine.run)
    t.ok('the explanation says the reviewers approved and names the failing check', /reviewers approved/.test(explanation.headline) && /flaky/.test(explanation.detail ?? ''), JSON.stringify(explanation))

    await engine.refreshClosureChecks({ kind: 'local', commands: [{ id: 'flaky', run: 'true' }] })
    await engine.drive()
    t.eq('with the check passing, the run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('no further author round was needed', prompts.filter((p) => p.stepId === 'implement').length, 2)
    await releaseWorkspace(engine)
  }
}
