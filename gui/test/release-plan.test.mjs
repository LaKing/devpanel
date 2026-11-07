import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

import { resolvePlaybook } from '../server/config/load.mjs'
import { NO_GREEN_STAGING, planOf, releasePlan } from '../server/config/release-plan.mjs'
import { runOptionErrors } from '../server/config/run-options.mjs'
import { infrastructureErrors } from '../server/infrastructure.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { usesSourceRepository } from '../server/runtime/source-repository.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'release plan — the three deployment environments, the filled releaseId, the refusal and the override'

const OLD_SENTENCE = 'Deployment requires the releaseId'

const environment = (id) => ({ id, ssh: { hostRef: `ssh-config:${id}.invalid`, workdir: '/tmp' }, projectRoot: '/tmp/fixture', files: {} })
const target = { workdir: '/tmp', ownership: 'fixture', rollback: 'manual', commands: Object.fromEntries(['inspect', 'checkpoint', 'verifyCheckpoint', 'apply', 'verifyRelease', 'restart', 'observe', 'test', 'restore', 'verifyRestore'].map((id) => [id, { run: 'true', timeoutSeconds: 10 }])) }
const infrastructure = (deployments = ['prod']) => ({ kind: 'boilerplate', orientation: 'Fixture', staging: environment('stage'), deployments: deployments.map(environment), testDrive: { commands: [{ id: 'test', run: 'true' }] }, release: { targets: Object.fromEntries(['stage', ...deployments].map((id) => [id, target])) } })
const filled = { releaseId: 'green-run', issueId: '2026-11-01-green', startedAt: '2026-11-01T10:00:00.000Z', packed: false }
const latestGreen = { issueId: '2026-11-01-green', runId: 'green-run', startedAt: '2026-11-01T10:00:00.000Z', packed: false }

export default async function (t) {
  t.section('the mapping: staging is the default, production and staging-then-production only when named (AC1, AC6, AC7)')
  {
    const infra = infrastructure()
    const none = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: {} })
    t.eq('no environment releases to staging', [none.plan.mode, none.plan.staging, none.plan.production], ['staging', 'stage', null])
    t.eq('and needs no releaseId: no blocker at all', none.blockers, [])
    const staging = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'staging' } })
    t.eq('staging by name', [staging.plan.mode, staging.plan.staging, staging.blockers.length], ['staging', 'stage', 0])
    t.eq('the staging environment id means staging too', releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'stage' } }).plan.mode, 'staging')
    const both = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'staging-then-production' } })
    t.eq('staging-then-production releases to both targets', [both.plan.mode, both.plan.staging, both.plan.production, both.blockers.length], ['staging-then-production', 'stage', 'prod', 0])
    const production = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'production' }, stagedRelease: filled })
    t.eq('production by name, on the only production target', [production.plan.mode, production.plan.production], ['production', 'prod'])
    t.eq('a deployment environment id still selects it', releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'prod', releaseId: 'x' } }).plan.production, 'prod')
    t.ok('an unknown environment is a blocker', releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'elsewhere' } }).blockers.some((b) => b.reason.includes('Unknown release environment')))
    const several = infrastructure(['prod-a', 'prod-b'])
    t.ok('several production targets: production must name one', releasePlan({ tactic: 'deployment', infrastructure: several, runOptions: { environment: 'production', releaseId: 'x' } }).blockers.some((b) => b.reason.includes('explicitly')))
    t.ok('and staging-then-production is refused', releasePlan({ tactic: 'deployment', infrastructure: several, runOptions: { environment: 'staging-then-production' } }).blockers.some((b) => b.reason.includes('single production target')))
    t.eq('a named one resolves', releasePlan({ tactic: 'deployment', infrastructure: several, runOptions: { environment: 'prod-b', releaseId: 'x' } }).blockers, [])
    t.ok('a releaseId with staging is an error', releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { releaseId: 'x' } }).errors.length === 1)
    t.ok('and with staging-then-production', releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'staging-then-production', releaseId: 'x' } }).errors.length === 1)
    t.ok('a missing release target is a blocker', releasePlan({ tactic: 'deployment', infrastructure: { ...infra, release: { targets: { prod: target } } }, runOptions: {} }).blockers.some((b) => b.reason.includes('Release target requires')))
    for (const env of ['staging', 'production', 'staging-then-production']) t.eq(`run options accept ${env}`, runOptionErrors({ environment: env }), [])
    // A deployment environment that claims a release environment's name never takes over its meaning.
    const claiming = { ...infrastructure(['staging']), staging: environment('stage') }
    const byDefault = releasePlan({ tactic: 'deployment', infrastructure: claiming, runOptions: {} })
    t.eq('a deployment called staging: the default still releases to staging', [byDefault.plan.mode, byDefault.plan.staging, byDefault.plan.production], ['staging', 'stage', null])
    const twoStage = releasePlan({ tactic: 'deployment', infrastructure: { ...infrastructure(['staging-then-production']), staging: environment('stage') }, runOptions: { environment: 'staging-then-production' } })
    t.eq('a deployment called staging-then-production: staging still runs first', [twoStage.plan.mode, twoStage.plan.staging], ['staging-then-production', 'stage'])
    t.eq('and such ids are refused by the infrastructure check', [infrastructureErrors(claiming).some((e) => e.includes('cannot be called staging')), infrastructureErrors({ ...infrastructure(), staging: environment('production') }).some((e) => e.includes('cannot be called production'))], [true, true])
    t.eq('the natural ids stay valid (staging called staging, production called production)', infrastructureErrors({ ...infrastructure(['production']), staging: environment('staging'), release: { targets: { staging: target, production: target } } }).filter((e) => e.includes('cannot be called')), [])
  }

  t.section('production: filled, refused, or named (AC2, AC3, AC4)')
  {
    const infra = infrastructure()
    const p = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'production' }, stagedRelease: filled })
    t.eq('the selection fills the releaseId', [p.plan.releaseId, p.plan.releaseIdSource, p.plan.filledFrom.issueId], ['green-run', 'filled', '2026-11-01-green'])
    t.eq('and nothing blocks', p.blockers, [])
    const refused = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'production' }, stagedRelease: { releaseId: null, reason: 'content-not-staged', latestGreen } })
    const blocker = refused.blockers.find((b) => b.kind === 'no-green-staging')
    t.eq('no matching green staging release: refused with the sentence', blocker?.reason, NO_GREEN_STAGING)
    t.eq('naming the latest green release', blocker?.latestGreen, latestGreen)
    t.ok('the old sentence is gone', !JSON.stringify(refused).includes(OLD_SENTENCE))
    const none = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'production' }, stagedRelease: { releaseId: null, reason: 'no-green-staging', latestGreen: null } })
    t.eq('with none at all, latestGreen is null', none.blockers.find((b) => b.kind === 'no-green-staging')?.latestGreen, null)
    const named = releasePlan({ tactic: 'deployment', infrastructure: infra, runOptions: { environment: 'production', releaseId: 'named-run' }, stagedRelease: filled })
    t.eq('a named releaseId is used instead of the filled one', [named.plan.releaseId, named.plan.releaseIdSource], ['named-run', 'operator'])
  }

  t.section('a snapshot resolved before plans existed derives the old plan')
  {
    const legacy = planOf({ tactic: 'deployment', runOptions: { releaseId: 'good' }, infrastructure: { staging: { id: 'stage' }, deployments: [{ id: 'prod' }] } })
    t.eq('production with its named releaseId', [legacy.mode, legacy.production, legacy.releaseId], ['production', 'prod', 'good'])
    t.eq('a legacy staging snapshot stages', planOf({ tactic: 'staging', runOptions: {}, infrastructure: { staging: { id: 'stage' }, deployments: [] } }).mode, 'staging')
  }

  t.section('resolution and preview through the deployment playbook')
  {
    const root = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'))
      await fs.writeFile(path.join(dir, 'projects/test-project.yaml'), YAML.stringify({ id: 'test-project', infrastructure: infrastructure() }))
    })
    const nonModel = (r) => r.resolved.liveExecution.blockers.filter((b) => !b.model)
    const staging = await resolvePlaybook('deployment', { root, projectId: 'test-project' })
    t.ok('a deployment with no environment resolves', staging.ok, JSON.stringify(staging.errors))
    t.eq('to staging, with no releaseId blocker (AC1)', [staging.resolved.release.mode, nonModel(staging)], ['staging', []])
    t.eq('the start dialog offers the three environments by name, staging first (AC7)', staging.resolved.parameterDefinitions.release.environments.map((e) => e.title), ['Staging', 'Production', 'Staging first, Deployment on success'])
    t.eq('and defaults to staging (AC6)', staging.resolved.parameterDefinitions.release.default, 'staging')
    t.ok('a staging deployment is cut from the source checkout', usesSourceRepository(staging.resolved))
    const both = await resolvePlaybook('deployment', { root, projectId: 'test-project', runOptions: { environment: 'staging-then-production' } })
    t.eq('staging-then-production resolves with no blocker', [both.resolved.release.mode, nonModel(both)], ['staging-then-production', []])
    t.ok('its production phases run', both.resolved.phases.some((p) => p.id === 'investigate-production-operator' && p.when))
    const refused = await resolvePlaybook('deployment', { root, projectId: 'test-project', runOptions: { environment: 'production' } })
    t.eq('production with no selection is refused with the sentence (AC3)', nonModel(refused).map((b) => b.reason), [NO_GREEN_STAGING])
    t.ok('a production deployment is not cut from the source checkout', !usesSourceRepository(refused.resolved))
    const filledResolution = await resolvePlaybook('deployment', { root, projectId: 'test-project', runOptions: { environment: 'production' }, stagedRelease: filled })
    t.eq('a selection fills it (AC2)', [filledResolution.resolved.release.releaseId, filledResolution.resolved.release.releaseIdSource, nonModel(filledResolution)], ['green-run', 'filled', []])
    const other = await resolvePlaybook('deployment', { root, projectId: 'test-project', runOptions: { environment: 'production' }, stagedRelease: { ...filled, releaseId: 'other-green' } })
    t.ok('the filled releaseId is part of the configHash', other.resolved.configHash !== filledResolution.resolved.configHash)
    const named = await resolvePlaybook('deployment', { root, projectId: 'test-project', runOptions: { environment: 'production', releaseId: 'named-run' }, stagedRelease: filled })
    t.eq('a named releaseId overrides the fill (AC4)', [named.resolved.release.releaseId, named.resolved.release.releaseIdSource], ['named-run', 'operator'])
    const wrong = await resolvePlaybook('deployment', { root, projectId: 'test-project', runOptions: { releaseId: 'named-run' } })
    t.ok('a releaseId for a staging deployment is refused', !wrong.ok)

    const asked = []
    const select = async () => { asked.push(1); return { releaseId: null, reason: 'no-green-staging', latestGreen: null } }
    const shown = await previewRun({ playbookId: 'deployment', configRoot: root, project: { id: 'test-project', path: '/tmp/none' }, runOptions: { environment: 'production' }, selectRelease: select })
    const refusal = shown.prerequisites.find((p) => p.kind === 'no-green-staging')
    t.eq('the preview carries the refusal and says there is none', [refusal?.detail, refusal?.latestGreen, shown.configurationReady], [NO_GREEN_STAGING, null, false])
    t.eq('the selection is asked once', asked.length, 1)
    const staged = await previewRun({ playbookId: 'deployment', configRoot: root, project: { id: 'test-project', path: '/tmp/none' }, runOptions: {}, selectRelease: select })
    t.eq('a staging preview never asks for a selection', [asked.length, staged.release.mode], [1, 'staging'])
    t.ok('and no phase of production runs for it', staged.phases.filter((p) => p.when).every((p) => p.runs === false))
    const offered = await previewRun({ playbookId: 'deployment', configRoot: root, project: { id: 'test-project', path: '/tmp/none' }, runOptions: { environment: 'production' }, selectRelease: async () => ({ releaseId: null, reason: 'content-not-staged', latestGreen }) })
    t.eq('the preview offers the latest green staging release', offered.prerequisites.find((p) => p.kind === 'no-green-staging')?.latestGreen, latestGreen)
    const filledPreview = await previewRun({ playbookId: 'deployment', configRoot: root, project: { id: 'test-project', path: '/tmp/none' }, runOptions: { environment: 'production' }, selectRelease: async () => filled })
    t.eq('a filled preview names the release', [filledPreview.release.releaseId, filledPreview.release.releaseIdSource], ['green-run', 'filled'])
  }
}
