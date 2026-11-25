import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { CONFIG_ROOT, getValidator, loadConfig, resolvePlaybook, schemaId, engineOnlyRefusal } from '../server/config/load.mjs'
import { preflight } from '../server/config/preflight.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { listPlaybooks } from '../server/runs-api.mjs'
import { playbookSeats, savePlaybookSeats } from '../server/playbook-seats.mjs'
import { summarisePreview } from '../server/supervisor-summary.mjs'
import { sandbox, cleanupSandboxes } from './helpers.mjs'

export const name = 'engine-only playbooks — no seats: resolved, checked, previewed and listed, never started, nothing spent'

const sh = promisify(execFile)
const ENGINE_ONLY = [
  'id: engine-check',
  'version: 1',
  'kind: engine-only',
  'title: Engine check',
  'description: A playbook with no seats.',
  'phases:',
  '  - id: freeze',
  '    title: Close admission',
  '    engine: freeze-admission',
  '  - id: drive',
  '    engine: drive-suite',
  ''
].join('\n')

const refused = async (work) => { try { await work(); return null } catch (error) { return error } }

export default async function (t) {
  const root = await sandbox(async (dir) => fs.writeFile(path.join(dir, 'playbooks', 'engine-check.yaml'), ENGINE_ONLY))
  const hostDir = path.join(root, 'host-config')
  try {
    t.section('AC1: the schema takes an engine-only playbook with no seats; every catalogue playbook still validates')
    {
      const validate = (await getValidator(root)).getSchema(schemaId('playbook'))
      const engine = { id: 'e', version: 1, kind: 'engine-only', phases: [{ id: 'a', engine: 'op' }] }
      t.ok('an engine-only playbook with engine phases validates', validate(engine), JSON.stringify(validate.errors))
      t.ok('it may not declare participants', !validate({ ...engine, participants: { coordinator: { model: 'x' } } }))
      t.ok('nor bind a strategy', !validate({ ...engine, strategy: 'analysis' }))
      t.ok('nor leave out its phases', !validate({ id: 'e', version: 1, kind: 'engine-only' }))
      t.ok('a phase names its engine operation', !validate({ ...engine, phases: [{ id: 'a' }] }))
      t.ok('a seat playbook still needs participants', !validate({ id: 's', version: 1, strategy: 'analysis' }))
      t.ok('and may not declare engine phases', !validate({ id: 's', version: 1, strategy: 'analysis', participants: { coordinator: { model: 'x' } }, phases: [{ id: 'a', engine: 'op' }] }))
      const YAML = (await import('yaml')).default
      for (const file of (await fs.readdir(path.join(CONFIG_ROOT, 'playbooks'))).filter((f) => f.endsWith('.yaml'))) {
        const data = YAML.parse(await fs.readFile(path.join(CONFIG_ROOT, 'playbooks', file), 'utf8'))
        t.ok(`catalogue ${file} validates unchanged`, validate(data), JSON.stringify(validate.errors))
      }
    }

    t.section('AC2: resolution gives no participants and no seat prompts, and refuses nothing for missing roles or models')
    const cfg = await loadConfig({ root })
    t.eq('the sandbox configuration loads without errors', cfg.errors, [])
    const r = await resolvePlaybook('engine-check', { config: cfg, root })
    t.ok('it resolves', r.ok, JSON.stringify(r.errors))
    const resolved = r.resolved
    t.eq('no participants, roles or prompts', [resolved.kind, resolved.participants, resolved.roles, resolved.prompts, resolved.strategy], ['engine-only', {}, {}, {}, null])
    t.eq('its phases are the engine steps', resolved.phases.map((p) => [p.id, p.engine]), [['freeze', 'freeze-admission'], ['drive', 'drive-suite']])
    t.ok('a configHash', /^sha256:/.test(resolved.configHash))
    t.eq('one blocker: not executable yet', resolved.liveExecution.blockers.map((b) => b.kind), ['engine-only-unsupported'])
    const withOptions = await resolvePlaybook('engine-check', { config: cfg, root, runOptions: { participants: { coordinator: { model: 'opus-5-5' } } } })
    t.ok('run options are refused: it has no seats to set', !withOptions.ok && withOptions.errors.some((e) => /takes no run options/.test(e.message)), JSON.stringify(withOptions.errors))
    {
      const bad = await sandbox(async (dir) => fs.writeFile(path.join(dir, 'playbooks', 'engine-bad.yaml'), ENGINE_ONLY.replace('id: engine-check', 'id: engine-bad') + 'participants:\n  coordinator:\n    model: opus-5-5\n'))
      const loaded = await loadConfig({ root: bad })
      t.ok('a seat key on an engine-only playbook is a readable load error', loaded.errors.some((e) => /an engine-only playbook declares no participants/.test(e.message)) && !loaded.playbooks.has('engine-bad'), JSON.stringify(loaded.errors))
    }

    t.section('AC3, AC7: preflight probes no harness for it')
    {
      let probes = 0
      const pf = await preflight(resolved, { probe: async () => { probes++; throw new Error('must not probe') }, root })
      t.eq('no probe, not launch-ready, the blocker said', [probes, pf.probed, pf.launchReady], [0, false, false])
      t.ok('the blocker is the finding', pf.failures.some((f) => /does not execute engine steps/.test(f.message)), JSON.stringify(pf.failures))
      const refusal = engineOnlyRefusal(resolved)
      t.eq('a start is refused as a start that never happened', [refusal?.status, refusal?.code, refusal?.started, refusal?.retryable], [422, 'ENGINE_ONLY_NOT_RUNNABLE', false, false])
    }

    t.section('AC3: npm run config:check resolves it; --preflight probes nothing for it')
    {
      const check = (args) => sh(process.execPath, [path.join(CONFIG_ROOT, 'gui/server/config/check.mjs'), ...args], { env: { ...process.env, DEVPANEL_CONFIG_ROOT: root } }).then((x) => ({ code: 0, out: x.stdout }), (e) => ({ code: e.code, out: `${e.stdout}${e.stderr}` }))
      const all = await check([])
      t.eq('every playbook resolves, this one included', all.code, 0, all.out)
      t.ok('it is listed as engine-only with its phases, no seats', /engine-check.*engine-only, 2 engine phases, no seats/.test(all.out), all.out)
      const one = await check(['engine-check'])
      t.ok('alone: its phases and operations, no participant line', one.code === 0 && one.out.includes('freeze-admission') && one.out.includes('drive-suite') && !/coordinator/.test(one.out), one.out)
      const pf = await check(['engine-check', '--preflight'])
      const section = pf.out.slice(pf.out.indexOf('engine-check'))
      t.ok('--preflight: not probed, nothing spent', section.includes('not probed') && !section.includes('probe spend') && !/TypeError/.test(pf.out), pf.out)
    }

    t.section('AC4: the preview shows its engine phases and no seats, models or model cost')
    {
      const p = await previewRun({ playbookId: 'engine-check', configRoot: root })
      t.ok('it previews', p.ok, JSON.stringify(p.errors))
      t.eq('engine phases, no participants or prompts', [p.kind, p.participants, p.prompts, p.phases.map((x) => [x.kind, x.engine])], ['engine-only', [], {}, [['engine', 'freeze-admission'], ['engine', 'drive-suite']]])
      t.eq('no budget or cost limit', p.limits, { budgets: {}, rounds: [] })
      t.eq('only the blocker: no paid preflight note', p.prerequisites.map((x) => [x.category, x.kind]), [['blocking', 'engine-only-unsupported']])
      t.eq('so it is not ready to start', p.configurationReady, false)
      const cli = await sh(process.execPath, [path.join(CONFIG_ROOT, 'gui/server/runtime/preview-cli.mjs'), 'engine-check'], { env: { ...process.env, DEVPANEL_CONFIG_ROOT: root } }).then((x) => x.stdout, (e) => `${e.stdout}${e.stderr}`)
      t.ok('npm run preview prints its engine phases', cli.includes('Engine phases') && cli.includes('freeze-admission') && cli.includes('drive-suite'), cli)
      t.ok('and no seats, models or cost', !cli.includes('Participants') && !/opus|gpt|maxCostUsd/.test(cli), cli)

      t.section('the top-level supervisor\'s summary keeps the kind and the engine phases (auditor-1.summarise-kind-dependency)')
      const s = summarisePreview(p)
      t.eq('kind and engine phases survive the summary', [s.kind, s.phases], ['engine-only', [{ id: 'freeze', kind: 'engine', engine: 'freeze-admission' }, { id: 'drive', kind: 'engine', engine: 'drive-suite' }]])
      t.eq('no seats or participants in it', [s.seats, s.participants, s.configurationReady], [[], [], false])
    }

    t.section('AC5: the start dialog\'s list offers it without seats or models')
    {
      const listed = (await listPlaybooks({ root })).find((p) => p.id === 'engine-check')
      t.eq('listed, engine-only, no participants', [listed?.ok, listed?.kind, listed?.strategy, listed?.participants], [true, 'engine-only', null, {}])
      const dialog = await fs.readFile(path.join(CONFIG_ROOT, 'gui/src/components/StartRunDialog.vue'), 'utf8')
      t.ok('the dialog replaces the seat and limit settings for it', dialog.includes('<div v-if="engineOnly" class="run-settings stage__settings" data-test="engine-only-settings">') &&
        dialog.includes('<div v-else-if="parameterData?.parameterDefinitions" class="run-settings stage__settings">') && dialog.includes('<div v-if="parameterData?.parameterDefinitions && !engineOnly" class="run-settings stage__limits">'))
      t.ok('and shows its engine phases instead of participants', dialog.includes('data-test="engine-phase"') && dialog.indexOf('<template v-if="engineOnly">') < dialog.indexOf('<h3 class="section">Participants</h3>'))
    }

    t.section('AC6: /playbooks lists it with no seats, and the seat-edit API refuses an edit')
    {
      const row = (await playbookSeats({ root, hostDir })).playbooks.find((p) => p.id === 'engine-check')
      t.eq('listed with no seats and its phases', [row?.kind, row?.seats, row?.phases?.map((p) => p.engine), row?.resolves], ['engine-only', [], ['freeze-admission', 'drive-suite'], true])
      const error = await refused(() => savePlaybookSeats('engine-check', { coordinator: { model: 'opus-5-5' } }, { root, hostDir, actor: 'tester' }))
      t.eq('an edit is refused', [error?.status, /no seats to edit/.test(error?.message ?? '')], [400, true])
      t.eq('and nothing is written', await fs.stat(path.join(hostDir, 'playbooks')).then(() => true, () => false), false)
      const view = await fs.readFile(path.join(CONFIG_ROOT, 'gui/src/views/PlaybooksView.vue'), 'utf8')
      t.ok('the page shows phases instead of a seat table and Save', view.includes('data-test="engine-only-phases"') && view.includes('<v-table v-else') && view.includes(`<template v-if="p.kind !== 'engine-only'">`))
    }
  } finally {
    await cleanupSandboxes()
  }
}
