import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import YAML from 'yaml'

import { applyFence, assertFenced } from '../../harness/fence.mjs'
import * as gemini from '../../harness/gemini.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { preflight } from '../server/config/preflight.mjs'
import { hostInfo } from '../server/metrics.js'
import { renderResult } from '../server/run-result-step.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { fencePolicy, harnessRefusal } from '../server/runtime/confinement-policy.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { gitWorktreeProvider, startRun } from '../server/runtime/launch.mjs'
import { platformFor } from '../server/runtime/platform.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { renderToolingCommand } from '../server/runtime/tooling-commands.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { fakeProbe } from './helpers.mjs'

export const name = 'macOS confinement — refused by default, unfenced only by the install\'s opt-in, labelled; mounts and Gemini refused (darwin injected)'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PANEL = path.resolve(HERE, '..', '..')
const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
const exists = (p) => fs.lstat(p).then(() => true, () => false)

// darwin, as platform.mjs answers it; nothing here reads a Mac.
const darwin = () => platformFor('darwin', { exec: async () => ({ ok: false, code: 1, stdout: '', error: 'not a mac' }) })
const linux = () => platformFor('linux')
const P = 'devpanel-project'

const writeProject = (configRoot, tooling) => fs.mkdir(path.join(configRoot, 'projects'), { recursive: true })
  .then(() => fs.writeFile(path.join(configRoot, 'projects', `${P}.yaml`), YAML.stringify({ id: P, workspace: { tooling } })))

async function withEnv (vars, body) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await body() } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

const startOn = async (f, platform, runOptions = {}) => startRun({
  playbookId: f.playbookId, issue: { project: P, id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery,
  platform, runOptions,
  ...(Object.keys(runOptions).length ? { expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions, projectId: P })).resolved.configHash } : {})
})

async function candidate () {
  const projectPath = await temp('macos-check-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'value.txt'), '1' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'm1', root: await temp('macos-check-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  return { projectPath, ws, baseline, fp, runDir: await temp('macos-check-run-') }
}

export default async function (t) {
  try {
    t.section('1. the policy: Linux unchanged; macOS refused unless this install opted in')
    {
      t.eq('Linux, fence on', fencePolicy({ platform: linux(), env: {} }).mode, 'fence')
      t.eq('Linux, DEVPANEL_FENCE=off, the same reason as before', fencePolicy({ platform: linux(), env: { DEVPANEL_FENCE: 'off' } }), { mode: 'off', reason: 'switched off (DEVPANEL_FENCE=off)' })
      const refused = fencePolicy({ platform: darwin(), env: {} })
      t.ok('macOS without the opt-in: refused, naming macOS and the opt-in', refused.mode === 'refused' && refused.reason.includes('macOS (darwin)') && refused.reason.includes('DEVPANEL_UNFENCED=acknowledged'), refused.reason)
      t.eq('DEVPANEL_FENCE=off and DEVPANEL_FENCE_UNPROVED=run grant nothing there', fencePolicy({ platform: darwin(), env: { DEVPANEL_FENCE: 'off', DEVPANEL_FENCE_UNPROVED: 'run' } }).mode, 'refused')
      t.eq('only the exact opt-in does', fencePolicy({ platform: darwin(), env: { DEVPANEL_UNFENCED: 'yes' } }).mode, 'refused')
      t.eq('with it, unfenced', fencePolicy({ platform: darwin(), env: { DEVPANEL_UNFENCED: 'acknowledged' } }).mode, 'unfenced')
    }

    t.section('2. P1-2: without the opt-in seats and local checks refuse before anything runs, naming macOS')
    {
      await withEnv({ DEVPANEL_UNFENCED: undefined }, async () => {
        const turns = []
        const script = scriptFor()
        const f = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
        // Preflight refuses first, before any probe is paid for.
        let probed = 0
        const probe = async (...a) => { probed++; return fakeProbe()(...a) }
        const { resolved } = await resolvePlaybook(f.playbookId, { root: f.configRoot })
        const pre = await preflight(resolved, { probe, platform: darwin(), env: {} })
        t.eq('preflight is not launch-ready', pre.launchReady, false)
        t.ok('its fence finding names macOS', pre.failures.some((x) => x.level === 'fence' && x.message.includes('macOS')), JSON.stringify(pre.failures))
        t.eq('and nothing was probed', probed, 0)
        const refusedStart = await startOn(f, darwin()).then(() => null, (e) => e)
        t.ok('a start on darwin is refused at preflight', /macOS/.test(refusedStart?.message ?? ''), refusedStart?.message)
        t.eq('no seat ran', turns.length, 0)

        // A run already under way (resumed after the opt-in was withdrawn): the engine refuses its turns itself.
        const g = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
        const engine = await startOn(g, linux())
        engine.platform = darwin()
        await engine.drive().catch(() => {})
        t.eq('the run fails as an environment fault', engine.run.failure?.class, 'environment', JSON.stringify(engine.run.failure))
        t.ok('naming macOS', /macOS \(darwin\) has no seat fence/.test(engine.run.failure?.message ?? ''), engine.run.failure?.message)
        t.eq('and no seat was invoked', turns.length, 0)

        const c = await candidate()
        const marker = path.join(c.runDir, 'ran')
        const check = await runChecks({ target: { kind: 'local', commands: [{ id: 'mark', run: `: > ${marker}` }] }, revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir, platform: darwin() })
        t.eq('a local check is refused, unavailable', [check.result, check.confinement?.level], ['unavailable', 'local-refused'])
        t.ok('with the reason naming macOS', check.error?.includes('macOS (darwin)'), check.error)
        t.eq('and its command never ran', await exists(marker), false)
        await gitWorktreeProvider.release({ projectPath: c.projectPath, path: c.ws.path })
      })
    }

    t.section('3. P1-3, P3-3: opted in, both coding playbooks run (reading triage included), every step recorded unfenced')
    for (const playbook of ['implementation', 'plan-and-implement']) {
      await withEnv({ DEVPANEL_UNFENCED: 'acknowledged' }, async () => {
        const turns = []
        const script = scriptFor()
        const f = await engineFixture({ playbook, script: (turn) => { turns.push(turn); return script(turn) } })
        const commands = [{ id: 'unit', cwd: 'gui', run: 'node test/run.mjs <suite>' }]
        await writeProject(f.configRoot, { commands })
        const engine = await startOn(f, darwin())
        await engine.drive()
        const triage = turns.find((tn) => tn.stepId === 'triage')
        const author = turns.find((tn) => tn.stepId === 'implement')
        t.ok(`${playbook}: the run got past triage (access: read) to the author`, Boolean(triage) && Boolean(author), turns.map((tn) => tn.stepId).join(','))
        t.ok(`${playbook}: triage was not given read access without the fence`, Boolean(triage) && !triage.prompt.includes('Source snapshot for this triage (read-only)'))
        const agentSteps = engine.run.steps.filter((s) => s.role !== 'operator')
        t.ok(`${playbook}: every agent step records namespace 0 with the macOS reason`, agentSteps.length > 0 && agentSteps.every((s) => s.fence?.namespace === 0 && s.fence.reason.includes('macOS (darwin)')), JSON.stringify(agentSteps.map((s) => s.fence)))
        t.ok(`${playbook}: the run records that it ran unfenced`, engine.run.unfenced?.seats === 'namespace 0' && engine.run.unfenced.checks === 'local-unconfined' && engine.run.unfenced.tooling === 'unconfined', JSON.stringify(engine.run.unfenced))
        t.ok(`${playbook}: preflight showed it (a fence warning on the run's record)`, engine.run.preflight?.fence?.mode === 'unfenced', JSON.stringify(engine.run.preflight))
        const line = renderToolingCommand(commands[0], engine.run.workspace.path, { offline: false })
        t.ok(`${playbook}: the author's command is unwrapped and labelled unconfined`, author.prompt.includes(line) && author.prompt.includes('[unconfined]') && !author.prompt.includes('/run/devpanel/tooling/offline'))
        t.eq(`${playbook}: and its step says so`, engine.run.steps.find((s) => s.stepId === 'implement')?.tooling?.commands, 'unconfined')
        const md = renderResult(engine.run)
        t.ok(`${playbook}: result.md shows the unfenced run`, md.includes('## Unfenced run') && md.includes('namespace 0') && md.includes('local-unconfined'))
      })
    }
    await withEnv({ DEVPANEL_UNFENCED: 'acknowledged' }, async () => {
      const c = await candidate()
      const check = await runChecks({ target: { kind: 'local', commands: [{ id: 'value', run: 'test "$(cat value.txt)" = 2' }] }, revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir, platform: darwin() })
      t.eq('opted in, a local check runs, labelled local-unconfined', [check.result, check.confinement?.level], ['passed', 'local-unconfined'])
      t.ok('with the macOS reason', check.confinement?.reason?.includes('macOS (darwin)'))
      await gitWorktreeProvider.release({ projectPath: c.projectPath, path: c.ws.path })
    })

    t.section('4. P1-4: the API carries the host\'s fence state; the panel renders it on every page and per run')
    {
      t.eq('/api/info and hello: unfenced, with the reason', hostInfo({ platform: darwin(), env: { DEVPANEL_UNFENCED: 'acknowledged' } }).fence.mode, 'unfenced')
      t.eq('refused without the opt-in', hostInfo({ platform: darwin(), env: {} }).fence.mode, 'refused')
      t.eq('Linux: fence', hostInfo({ platform: linux(), env: {} }).fence.mode, 'fence')
      const app = await fs.readFile(path.join(PANEL, 'gui', 'src', 'App.vue'), 'utf8')
      t.ok('App.vue shows a banner, outside any route, while unfenced or refused', app.includes("['unfenced', 'refused'].includes(connection.host?.fence?.mode)") && /<v-alert\s+v-if="unfenced"/.test(app) && app.indexOf('v-if="unfenced"') < app.indexOf('<router-view'))
      const view = await fs.readFile(path.join(PANEL, 'gui', 'src', 'views', 'IssueView.vue'), 'utf8')
      t.ok('IssueView.vue flags a run that ran unfenced', view.includes('v-if="run.unfenced"'))
      const api = await fs.readFile(path.join(PANEL, 'gui', 'server', 'runs-api.mjs'), 'utf8')
      t.ok('and the run API carries it', api.includes('unfenced: run.unfenced ?? null'))
    }

    t.section('5. P1-1: the installer enables nothing silently; the opt-in is explicit, per install, guarded')
    {
      const script = await fs.readFile(path.join(PANEL, 'install-on-osx.sh'), 'utf8')
      t.ok('it no longer writes DEVPANEL_FENCE', !/<key>DEVPANEL_FENCE<\/key>/.test(script))
      t.ok('DEVPANEL_UNFENCED is written only under the opt-in', /\$\{UNFENCED:\+ {4}<key>DEVPANEL_UNFENCED<\/key><string>acknowledged<\/string>/.test(script) && (script.match(/<key>DEVPANEL_UNFENCED<\/key>/g) ?? []).length === 1)
      t.ok('the read-back of an installed agent is guarded under set -euo pipefail (auditor-2-002)', /if \[\[ -z "\$UNFENCED" && -f "\$PLIST" \]\]; then\n\s+UNFENCED="\$\(\/usr\/libexec\/PlistBuddy -c 'Print :EnvironmentVariables:DEVPANEL_UNFENCED' "\$PLIST" 2>\/dev\/null \|\| true\)"/.test(script))
      t.ok('DEVPANEL_AUTH=local stays', script.includes('<key>DEVPANEL_AUTH</key><string>local</string>'))
      // The plist section exactly as bash expands it, with and without the opt-in.
      const plist = script.slice(script.indexOf('cat > "$PLIST" <<EOF'), script.indexOf('\nEOF\n') + 5)
      const out = await temp('macos-plist-')
      const render = async (unfenced) => {
        const file = path.join(out, `${unfenced || 'none'}.plist`)
        await run('bash', ['-c', `set -u; LABEL=l NODE_BIN=/n DEST=/d SVC_PATH=/p PORT=1 HOST=127.0.0.1 PROJECTS=/x LOG=/log PLIST='${file}' UNFENCED='${unfenced}'${NL}${plist}`])
        return fs.readFile(file, 'utf8')
      }
      const off = await render('')
      const on = await render('acknowledged')
      t.ok('a first install writes no opt-in', !off.includes('DEVPANEL_UNFENCED') && off.includes('<key>DEVPANEL_SHUTDOWN_GRACE_MS</key>'), off)
      t.ok('an opted-in install writes exactly that key, on its own line', on.includes(`${NL}    <key>DEVPANEL_UNFENCED</key><string>acknowledged</string>${NL}    <key>DEVPANEL_SHUTDOWN_GRACE_MS</key>`), on)
    }

    t.section('6. P3-1, P3-2: declared mounts no fence binds refuse the first turn with tools, in place too, and nothing is made')
    {
      const source = await temp('macos-mount-src-')
      await fs.writeFile(path.join(source, 'tool.js'), 'module.exports = 1\n')
      // In place on a fenced Linux host: the live checkout has nothing bound at the target.
      await withEnv({ DEVPANEL_FENCE: undefined }, async () => {
        const turns = []
        const script = scriptFor()
        const f = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
        await writeProject(f.configRoot, { mounts: [{ target: 'tools/fake', source }] })
        const engine = await startOn(f, linux(), { isolation: 'in-place' })
        await engine.drive().catch(() => {})
        t.eq('in place: the run fails as an environment fault', engine.run.failure?.class, 'environment', JSON.stringify(engine.run.failure))
        t.ok('naming source, target and why', ['tools/fake', source, 'in-place run'].every((s) => engine.run.failure?.message.includes(s)), engine.run.failure?.message)
        t.ok('no seat with tools was invoked', !turns.some((tn) => tn.stepId === 'implement' || tn.stepId.startsWith('audit')))
        t.eq('and nothing was made in the checkout', await exists(path.join(f.projectPath, 'tools', 'fake')), false)
      })
      // macOS, opted in: tool-free coordination proceeds, the first turn with tools is refused (auditor-1-triage-test-expectation).
      await withEnv({ DEVPANEL_UNFENCED: 'acknowledged' }, async () => {
        const turns = []
        const script = scriptFor()
        const f = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
        await writeProject(f.configRoot, { mounts: [{ target: 'tools/fake', source }] })
        const engine = await startOn(f, darwin())
        await engine.drive().catch(() => {})
        t.ok('macOS: the tool-free triage ran', turns.some((tn) => tn.stepId === 'triage'))
        const said = turns.map((tn) => tn.prompt).join(NL)
        t.ok('and was told the mount is NOT bound, never that it is read-only', said.includes('NOT bound') && !said.includes('Mounted read-only'))
        t.eq('the first seat with tools was refused: an environment fault', engine.run.failure?.class, 'environment', JSON.stringify(engine.run.failure))
        t.ok('naming source, target and macOS', ['tools/fake', source, 'macOS (darwin)'].every((s) => engine.run.failure?.message.includes(s)), engine.run.failure?.message)
        t.ok('no seat with tools ran', !turns.some((tn) => tn.stepId === 'implement' || tn.stepId.startsWith('audit')))
        t.eq('and no mount point was made in the worktree', await exists(path.join(engine.run.workspace.path, 'tools', 'fake')), false)
      })
      // A fence asked for and not proved: the mount refuses even the operator's switch.
      await withEnv({ DEVPANEL_FENCE_UNPROVED: 'run' }, async () => {
        const thrown = (() => { try { assertFenced({ applied: false, reason: 'probe failed' }, { turn: 'a fenced turn', mounts: [{ source: '/src/tool', target: '/w/tools/fake' }] }) } catch (e) { return e } })()
        t.ok('assertFenced refuses unbound mounts even under DEVPANEL_FENCE_UNPROVED=run', thrown?.started === false && thrown.message.includes('/src/tool') && thrown.message.includes('/w/tools/fake'), thrown?.message)
        t.eq('without mounts the switch still applies on Linux', (() => { try { assertFenced({ applied: false, reason: 'probe failed' }); return 'ran' } catch { return 'refused' } })(), 'ran')
      })
    }

    t.section('7. P4: every Gemini seat refused on macOS, in preview, preflight and the adapter itself, before any probe or launch')
    {
      const f = await engineFixture()
      const roster = path.join(f.configRoot, 'roster', 'gemini-4-argon.yaml')
      await fs.writeFile(roster, (await fs.readFile(roster, 'utf8')).replace(/^harness: .*$/m, 'harness: gemini'))
      const runOptions = { participants: { 'auditor-1': { model: 'gemini-4-argon' } } }
      const onMac = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, platform: darwin() })
      const blocker = onMac.resolved.liveExecution.blockers.find((b) => b.kind === 'platform-unsupported')
      t.ok('resolution: a blocker for the Gemini seat, naming macOS and the confinement', blocker?.role === 'auditor-1' && blocker.reason.includes('macOS (darwin)') && blocker.reason.includes('bubblewrap'), JSON.stringify(onMac.resolved.liveExecution.blockers))
      const preview = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, runOptions, platform: darwin() })
      t.ok('preview: blocking, and not ready', preview.configurationReady === false && preview.prerequisites.some((p) => p.category === 'blocking' && p.kind === 'platform-unsupported' && p.detail.includes('macOS')))
      const onLinux = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, platform: linux() })
      t.ok('Linux: no such blocker (P4-3)', !onLinux.resolved.liveExecution.blockers.some((b) => b.kind === 'platform-unsupported'))
      let probed = 0
      const probe = async (...a) => { probed++; return fakeProbe()(...a) }
      // As a quota fallback calls it: eligibility asserted, the participants still checked.
      const pre = await preflight({ ...onMac.resolved, liveExecution: { eligible: true, blockers: [] } }, { probe, platform: darwin(), env: { DEVPANEL_UNFENCED: 'acknowledged' } })
      t.ok('preflight: refused for the Gemini seat, naming macOS', pre.launchReady === false && pre.failures.some((x) => x.level === 'fence' && x.message.startsWith('auditor-1:') && x.message.includes('macOS')), JSON.stringify(pre.failures))
      t.eq('before any probe', probed, 0)
      const linuxPre = await preflight({ ...onLinux.resolved, liveExecution: { eligible: true, blockers: [] } }, { probe: fakeProbe(), platform: linux(), env: {} })
      t.ok('Linux preflight has no fence finding (P4-3, P1-6)', !linuxPre.findings.some((x) => x.level === 'fence'))
      t.eq('harnessRefusal: claude and codex are not refused', [harnessRefusal('claude', { platform: darwin() }), harnessRefusal('codex', { platform: darwin() })], [null, null])

      // Direct invocation: refused before the CLI is ever started.
      const dir = await temp('macos-gemini-')
      const marker = path.join(dir, 'launched')
      const shim = path.join(dir, 'gemini')
      await fs.writeFile(shim, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 })
      await withEnv({ DEVPANEL_GEMINI_BIN: shim }, async () => {
        const error = await gemini.invoke({ prompt: 'hello', model: 'gemini-4-argon', cwd: dir, platform: darwin(), meta: { invocationId: 'macos-1' } }).then(() => null, (e) => e)
        t.ok('gemini.invoke on darwin throws an environment fault, not started, naming macOS', error?.kind === 'environment-error' && error.started === false && error.message.includes('macOS'), error?.message)
        t.eq('and the CLI never ran', await exists(marker), false)
      })
    }

    t.section('8. P1-3: a run resolved before the seat fence, resumed on an opted-in Mac, records itself unfenced too (auditor-1-legacy-unfenced-evidence)')
    await withEnv({ DEVPANEL_UNFENCED: 'acknowledged' }, async () => {
      const f = await engineFixture()
      const engine = await startOn(f, linux())
      t.eq('started on Linux: no unfenced record yet', engine.run.unfenced ?? null, null)
      // As a snapshot from before fence.namespace: 1 reads.
      delete engine.snapshot.fence
      engine.platform = darwin()
      await engine.drive()
      const agentSteps = engine.run.steps.filter((s) => s.role !== 'operator')
      t.ok('the run recorded that it ran unfenced', engine.run.unfenced?.seats === 'namespace 0' && engine.run.unfenced.reason.includes('macOS (darwin)'), JSON.stringify(engine.run.unfenced))
      t.ok('every agent step records namespace 0 with the macOS reason', agentSteps.length > 0 && agentSteps.every((s) => s.fence?.namespace === 0 && s.fence.reason.includes('macOS (darwin)')), JSON.stringify(agentSteps.map((s) => s.fence)))
      t.ok('and result.md shows the unfenced run', renderResult(engine.run).includes('## Unfenced run'))
    })

    t.section('9. P2-3, P2-4: an opted-in in-place run gives its declared commands unconfined to coordinator and worker alike (auditor-1-inplace-command-labels)')
    await withEnv({ DEVPANEL_UNFENCED: 'acknowledged' }, async () => {
      const turns = []
      const script = scriptFor()
      const f = await engineFixture({ script: (turn) => { turns.push(turn); return script(turn) } })
      const commands = [{ id: 'unit', cwd: 'gui', run: 'node test/run.mjs <suite>' }]
      await writeProject(f.configRoot, { commands })
      const engine = await startOn(f, darwin(), { isolation: 'in-place' })
      await engine.drive()
      const line = renderToolingCommand(commands[0], engine.run.workspace.path, { offline: false })
      const author = turns.find((tn) => tn.stepId === 'implement')
      const brief = turns.find((tn) => tn.stepId.startsWith('brief'))
      for (const [label, turn] of [['the author', author], ['the coordinator\'s brief', brief]]) {
        t.ok(`in place, ${label} is given the command unwrapped and labelled unconfined`, Boolean(turn) && turn.prompt.includes(line) && turn.prompt.includes('[unconfined]') && !turn.prompt.includes('/run/devpanel/tooling/offline'), turn?.prompt.slice(-1200))
      }
      t.eq('and the author\'s step records it', engine.run.steps.find((s) => s.stepId === 'implement')?.tooling?.commands, 'unconfined')
    })

    t.section('10. the run-less fence on darwin (auditor-2-005): applyFence binds nothing, and only the opt-in, never DEVPANEL_FENCE_UNPROVED=run, runs a turn unfenced')
    {
      const applied = await applyFence({ spec: { cwd: '/nowhere', writable: [], readOnly: [], entries: [] }, platform: darwin() })
      t.ok('applyFence: not applied, naming macOS', applied.applied === false && applied.reason.includes('macOS (darwin)'), applied.reason)
      await withEnv({ DEVPANEL_FENCE_UNPROVED: 'run' }, async () => {
        const thrown = (() => { try { assertFenced(applied, { turn: 'a supervisor turn', platform: darwin() }) } catch (e) { return e } })()
        t.ok('assertFenced refuses it on darwin even under DEVPANEL_FENCE_UNPROVED=run, naming the opt-in', thrown?.started === false && thrown.message.includes('DEVPANEL_UNFENCED=acknowledged'), thrown?.message)
      })
    }
  } finally {
    await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
