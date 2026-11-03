import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyFailure } from '../server/runtime/failure.mjs'

export const name = 'adapters — activity telemetry and the scratch directory'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const NL = String.fromCharCode(10)

const temps = []
async function temp () {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-activity-'))
  temps.push(d)
  return d
}

async function shim ({ shape, record, mode = 'ok' }) {
  const file = path.join(await temp(), 'cli')
  await fs.writeFile(file, [
    '#!/bin/sh',
    `export AGENT_MODE='${mode}'`,
    `export AGENT_SHAPE='${shape}'`,
    `export AGENT_RECORD='${record}'`,
    // Some host Node launchers strip TMPDIR; capture what the CLI received.
    'export AGENT_TMPDIR="$TMPDIR"',
    `exec "${process.execPath}" "${AGENT}" "$@"`
  ].join(NL) + NL)
  await fs.chmod(file, 0o755)
  return file
}

const readRecord = async (file) =>
  (await fs.readFile(file, 'utf8').catch(() => '')).split(NL).filter(Boolean).map((l) => JSON.parse(l))

export default async function (t) {
  t.section('1. claude: the event stream is observed as it arrives')
  {
    const record = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record })
    const claude = await import('../../harness/claude.mjs')
    const scratchDir = await temp()
    const events = []
    const spawns = []
    const cwd = await temp()
    const turn = await claude.invoke({
      model: 'claude-fable-5-1',
      cwd,
      scratchDir,
      prompt: 'Do the `handoff` thing.',
      marker: 'devpanel:test:1',
      ledgerDir: null,
      observe: { onActivity: (e) => events.push(e), onSpawn: (s) => spawns.push(s) }
    })
    t.ok('the turn completed', turn.outcome === 'completed' && turn.response.includes('```json'))
    t.ok('the spawn report carries the command line and directory',
      spawns.length === 1 && spawns[0].command === process.env.DEVPANEL_CLAUDE_BIN && spawns[0].args.includes('-p') && spawns[0].cwd === cwd,
      JSON.stringify({ command: spawns[0]?.command, cwd: spawns[0]?.cwd, n: spawns[0]?.args?.length }))
    t.ok('a spawn was reported first', events[0]?.kind === 'spawned' && Number.isInteger(events[0].pid), JSON.stringify(events[0]))
    t.ok('a tool use was seen', events.some((e) => e.kind === 'tool-use' && e.detail === 'Read'), events.map((e) => e.kind).join(','))
    t.ok('and the result', events.some((e) => e.kind === 'result'))
    t.ok('every event carries a timestamp', events.every((e) => typeof e.at === 'string'))
    t.eq('the diagnostics count them', turn.diagnostics.events, events.length - 1)

    const calls = await readRecord(record)
    t.eq('the runtime was asked for the stream', calls[0].received.argv.includes('stream-json'), true)
    t.eq('and given the scratch directory', calls[0].received.scratchDir, scratchDir)
  }

  t.section('1b. long scratch paths do not become Linux bridge socket paths')
  if (process.platform === 'linux') {
    const root = await temp()
    const scratchDir = path.join(root, 'long-issue-name-'.repeat(10), 'scratch')
    await fs.mkdir(scratchDir, { recursive: true })
    const record = path.join(root, 'calls')
    const claude = await import('../../harness/claude.mjs')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record })
    const options = { cwd: root, scratchDir, prompt: 'x' }
    const first = await claude.invoke(options)
    await claude.invoke({ ...options, session: first.session })
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record, mode: 'runtime-error' })
    let failed = false
    try { await claude.invoke(options) } catch { failed = true }
    t.ok('runtime failure is still reported', failed)
    const calls = (await readRecord(record)).map(c => c.received)
    t.ok('scratch retains its durable long path', calls.every(c => c.scratchDir === scratchDir))
    t.ok('bridge temp paths leave room below the socket limit', calls.every(c => typeof c.tempDir === 'string' && Buffer.byteLength(c.tempDir) < 40), JSON.stringify(calls.map(c => ({tempDir:c.tempDir,tempMode:c.tempMode}))))
    t.ok('temporary directories are private', calls.every(c => c.tempMode === 0o700))
    t.eq('each invocation has an isolated temp directory', new Set(calls.map(c => c.tempDir)).size, 3)
    for (const call of calls) t.eq('temporary directory is cleaned after success or failure', await fs.stat(call.tempDir).then(() => true, () => false), false)
    t.ok('durable scratch survives invocation cleanup', (await fs.stat(scratchDir)).isDirectory())
  }

  t.section('2. codex: the JSONL events are observed too')
  {
    const record = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CODEX_BIN = await shim({ shape: 'codex', record })
    const codex = await import('../../harness/codex.mjs')
    const events = []
    const turn = await codex.invoke({
      model: 'gpt-6-astra',
      cwd: await temp(),
      scratchDir: await temp(),
      prompt: 'Do the `handoff` thing.',
      marker: 'devpanel:test:2',
      ledgerDir: null,
      observe: { onActivity: (e) => events.push(e) }
    })
    t.ok('the turn completed', turn.outcome === 'completed')
    t.ok('spawn reported', events[0]?.kind === 'spawned')
    t.ok('the agent message was seen', events.some((e) => e.kind === 'text'), events.map((e) => e.kind).join(','))
    t.ok('the session event was classified as system', events.some((e) => e.kind === 'system'))
    t.eq('the scratch directory reached the process', (await readRecord(record))[0].received.scratchDir !== null, true)
  }

  t.section('2b. the tooling policy is enforced through the runtimes\' own switches')
  {
    const record = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record })
    const claude = await import('../../harness/claude.mjs')
    const scratch = await temp()
    const liveCheckout = await temp()
    const turn = await claude.invoke({ model: 'm', cwd: await temp(), prompt: 'x', ledgerDir: null, tooling: { allowLiveCheckout: false, liveCheckout, allowedRoots: [scratch] } })
    const argv = (await readRecord(record))[0].received.argv
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
    t.ok('reads and edits of the live checkout are denied', settings.permissions.deny.includes(`Read(/${liveCheckout}/**)`) && settings.permissions.deny.includes(`Edit(/${liveCheckout}/**)`), settings.permissions.deny.join(','))
    t.eq('the scratch root is added', argv[argv.indexOf('--add-dir') + 1], scratch)
    t.eq('additional read-only roots require a sandbox', turn.diagnostics.tooling.bash, 'sandbox-required')
    t.ok('additional roots are denied writes', settings.sandbox.filesystem.denyWrite.includes(scratch))
    t.ok('additional roots have absolute Edit denies', settings.permissions.deny.includes(`Edit(/${scratch}/**)`))

    const record2 = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CODEX_BIN = await shim({ shape: 'codex', record: record2 })
    const codex = await import('../../harness/codex.mjs')
    const turn2 = await codex.invoke({ model: 'm', cwd: await temp(), prompt: 'x', ledgerDir: null, tooling: { allowLiveCheckout: false, liveCheckout: '/projects/live-project', allowedRoots: [] } })
    const argv2 = (await readRecord(record2))[0].received.argv
    t.ok('codex is sandboxed to workspace writes', argv2.some((arg, i) => arg === '-c' && argv2[i + 1] === 'sandbox_mode="workspace-write"'))
    t.eq('and says reads are not fenced', turn2.diagnostics.tooling.reads, 'not-fenceable')
    const resumed = await codex.invoke({ session: turn2.session, model: 'm', cwd: await temp(), prompt: 'continue', tooling: { allowedRoots: [], networkAccess: true } })
    const resumeArgv = (await readRecord(record2))[1].received.argv
    t.eq('codex resumes the original session', resumeArgv.slice(0, 3), ['exec', 'resume', turn2.session.id])
    t.ok('resumed turn keeps the workspace write fence', resumeArgv.some((arg, i) => arg === '-c' && resumeArgv[i + 1] === 'sandbox_mode="workspace-write"'))
    t.ok('resume avoids the unsupported sandbox flag', !resumeArgv.includes('--sandbox'))
    t.ok('configured infrastructure permits SSH network access', resumeArgv.includes('sandbox_workspace_write.network_access=true'))
    t.ok('network permission is not added to unconfigured runs', !argv2.includes('sandbox_workspace_write.network_access=true'))
    t.eq('resumed turn completes', resumed.outcome, 'completed')

    const allowed = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record: allowed })
    const claude2 = await import('../../harness/claude.mjs?allowed=1')
    await claude2.invoke({ model: 'm', cwd: await temp(), prompt: 'x', ledgerDir: null, tooling: { allowLiveCheckout: true, liveCheckout: '/projects/live-project', allowedRoots: [] } })
    // --settings is always passed now (it requests thinking summaries); what
    // matters is that it denies nothing.
    const allowedArgv = (await readRecord(allowed))[0].received.argv
    const allowedSettings = JSON.parse(allowedArgv[allowedArgv.indexOf('--settings') + 1])
    t.ok('an allowed live checkout is not denied', !allowedSettings.permissions?.deny?.length && !allowedSettings.sandbox, JSON.stringify(allowedSettings))
    t.eq('thinking summaries are requested', allowedSettings.showThinkingSummaries, true)
  }

  t.section('reviewer source restrictions survive fresh and resumed invocations')
  for (const shape of ['claude', 'codex']) {
    const record = path.join(await temp(), 'calls')
    process.env[shape === 'claude' ? 'DEVPANEL_CLAUDE_BIN' : 'DEVPANEL_CODEX_BIN'] = await shim({ shape, record })
    const adapter = await import(`../../harness/${shape}.mjs`)
    const cwd = await temp()
    const scratchDir = await temp()
    const tooling = { writesCode: false, worktree: cwd, allowedRoots: [scratchDir], allowLiveCheckout: true }
    let session = null
    for (const resumed of [false, true]) {
      const turn = await adapter.invoke({ session, model: 'm', cwd, scratchDir, tooling, prompt: 'Review source; write notes in scratch.' })
      session = turn.session
      const call = (await readRecord(record)).at(-1).received
      t.eq(`${shape}/${resumed}: source policy reported`, turn.diagnostics.tooling.source, 'read-only')
      if (shape === 'codex') {
        t.eq('process working root is scratch', call.cwd, scratchDir)
        t.ok('sandbox cwd explicitly pinned', call.argv.includes(`cwd=${JSON.stringify(scratchDir)}`))
        t.ok('no additional writable roots', call.argv.includes('sandbox_workspace_write.writable_roots=[]'))
        t.ok('cannot request write escalation', call.argv.includes('approval_policy="never"'))
        t.ok('general temp writes disabled', call.argv.includes('sandbox_workspace_write.exclude_slash_tmp=true'))
      } else {
        const settings = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1])
        t.eq('source writes denied in Bash sandbox', settings.sandbox.filesystem.denyWrite, [cwd])
        t.eq('scratch remains writable', settings.sandbox.filesystem.allowWrite, [scratchDir])
        t.eq('sandbox required', settings.sandbox.failIfUnavailable, true)
        t.eq('no unsandboxed retry', settings.sandbox.allowUnsandboxedCommands, false)
        t.ok('source edits denied through file tools', settings.permissions.deny.includes(`Edit(/${cwd}/**)`))
      }
    }
  }

  t.section('masked caches of a tooling mount stay writable in the CLI sandboxes (tooling.nodeModules)')
  for (const shape of ['claude', 'codex']) {
    const record = path.join(await temp(), 'calls')
    process.env[shape === 'claude' ? 'DEVPANEL_CLAUDE_BIN' : 'DEVPANEL_CODEX_BIN'] = await shim({ shape, record })
    const adapter = await import(`../../harness/${shape}.mjs?masks=1`)
    for (const writesCode of [true, false]) {
      const cwd = await fs.realpath(await temp())
      const scratchDir = await fs.realpath(await temp())
      const evidence = await fs.realpath(await temp())
      const target = path.join(cwd, 'node_modules')
      await fs.mkdir(target)
      // As in a real turn: the cache directory exists only inside the fence, linked from the mount.
      const mask = '/run/devpanel/caches/0/.vite-temp'
      const tooling = { writesCode, worktree: cwd, allowedRoots: [evidence], mountTargets: [target], mountMasks: [mask], maskedMountTargets: [target] }
      await adapter.invoke({ model: 'm', cwd, scratchDir, tooling, prompt: 'Run the declared test command.' })
      const call = (await readRecord(record)).at(-1).received
      const seat = writesCode ? 'writer' : 'reader'
      if (shape === 'claude') {
        const fsys = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]).sandbox.filesystem
        t.ok(`claude ${seat}: the mask is writable in its sandbox`, fsys.allowWrite.includes(mask), JSON.stringify(fsys))
        t.ok(`claude ${seat}: the masked mount is not re-mounted read-only over it`, !fsys.denyWrite.includes(target), JSON.stringify(fsys))
        const deny = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]).permissions.deny
        t.ok(`claude ${seat}: nor named by an edit denial, which the CLI also mounts read-only`, !deny.some((rule) => rule.includes(`${target}/**`)), JSON.stringify(deny))
      } else {
        const roots = call.argv.find((a) => a.startsWith('sandbox_workspace_write.writable_roots='))
        t.ok(`codex ${seat}: the mask is a writable root`, JSON.parse(roots.split('=').slice(1).join('=')).includes(mask), roots)
      }
    }
  }

  t.section('symlink spellings are denied; only canonical paths reach bubblewrap')
  for (const writesCode of [false, true]) {
    const root = await temp()
    const aliases = {}, real = {}
    for (const name of ['source', 'scratch', 'live', 'git', 'extra']) {
      real[name] = path.join(root, name)
      aliases[name] = path.join(root, name + '-alias')
      await fs.mkdir(real[name])
      await fs.symlink(real[name], aliases[name])
    }
    const record = path.join(root, 'calls')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record })
    const claude = await import('../../harness/claude.mjs')
    let session = null
    for (const resumed of [false, true]) {
      const result = await claude.invoke({ session, model: 'm', cwd: aliases.source, scratchDir: aliases.scratch, prompt: 'Inspect the candidate.',
        tooling: { writesCode, allowLiveCheckout: false, liveCheckout: real.live, liveCheckoutAliases: [aliases.live],
          allowedRoots: [real.scratch, aliases.live, real.live, aliases.extra], gitDirectories: [aliases.git] } })
      session = result.session
      const argv = (await readRecord(record)).at(-1).received.argv
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
      const mount = settings.sandbox.filesystem
      t.eq(`writer=${writesCode}/resume=${resumed}: writable mount targets resolved`, mount.allowWrite, writesCode ? [real.source, real.scratch] : [real.scratch])
      t.ok('denied mount targets are resolved and deduplicated', mount.denyWrite.every(p => Object.values(real).includes(p)) && new Set(mount.denyWrite).size === mount.denyWrite.length)
      t.ok('live and additional roots remain read-only', [real.live, real.extra].every(p => mount.denyWrite.includes(p)))
      t.ok('scratch alias is not accidentally denied', !mount.denyWrite.includes(real.scratch))
      for (const tool of ['Edit','Write','MultiEdit','NotebookEdit','Glob','Grep']) {
        t.ok(`${tool} denies both live-checkout spellings`, [aliases.live,real.live].every(p => settings.permissions.deny.includes(`${tool}(/${p}/**)`)))
      }
      // Read(...) denials become read-deny mounts; a symlink spelling there is an
      // unmountable bubblewrap target ("Can't mount on symlink destination").
      t.ok('Read denies the canonical live checkout', settings.permissions.deny.includes(`Read(/${real.live}/**)`))
      t.ok('Read never names a symlink spelling', settings.permissions.deny.every(rule => !rule.startsWith('Read(') || Object.values(real).some(p => rule === `Read(/${p}/**)`)), settings.permissions.deny.filter(r => r.startsWith('Read(')).join(','))
      if (!writesCode) t.ok('source and Git aliases have both edit denials', [aliases.source,real.source,aliases.git,real.git].every(p => settings.permissions.deny.includes(`Edit(/${p}/**)`)))
      t.eq('sandbox stays mandatory', settings.sandbox.failIfUnavailable, true)
      t.eq('unsandboxed fallback stays disabled', settings.sandbox.allowUnsandboxedCommands, false)
    }
    await fs.symlink(path.join(root, 'missing'), path.join(root, 'broken'))
    let error
    try { await claude.invoke({ model:'m', cwd:real.source, scratchDir:real.scratch, prompt:'x', tooling:{allowedRoots:[path.join(root,'broken')]} }) } catch (caught) { error=caught }
    t.eq('unresolvable mounts fail as configuration errors', error?.kind, 'configuration-error')
    t.eq('invalid mounts never launch the runtime', (await readRecord(record)).length, 2)
  }

  t.section('a failed Bash sandbox stops the invocation on its first tool result')
  for (const mode of ['sandbox-error', 'sandbox-error-array', 'sandbox-read', 'sandbox-success']) {
    const record = path.join(await temp(), 'calls'), ledgerDir = await temp()
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape:'claude', record, mode })
    const claude = await import('../../harness/claude.mjs')
    let failure, result
    const deadline=AbortSignal.timeout(5000)
    try { result=await claude.invoke({model:'m',cwd:await temp(),prompt:'x',ledgerDir,signal:deadline,observe:{onOutput:()=>{throw new Error('broken telemetry consumer')}}}) } catch(error) { failure=error }
    if(mode.startsWith('sandbox-error')) {
      t.eq(`${mode} is an environment failure`,classifyFailure(failure).class,'environment')
      t.eq('stops without waiting for the outer deadline',deadline.aborted,false)
      t.ok('process-group termination is confirmed',failure?.termination?.confirmedAt!=null)
      t.ok('the error explains the sandbox failure',failure?.message.includes('bwrap: bind mount failed'))
      const ledger=(await fs.readFile(path.join(ledgerDir,'claude-ledger.jsonl'),'utf8')).trim().split(NL).map(JSON.parse)
      t.eq('ledger records failure rather than user cancellation',ledger.at(-1).phase,'failed')
      t.eq('a failed sandbox produces no accepted result',result,undefined)
    } else t.eq(`${mode} is not mistaken for a sandbox initialization failure`,result?.outcome,'completed')
  }

  t.section('stdout provider failures and Codex temporary-file cleanup')
  for (const mode of ['stdout-rate-limit', 'stdout-quota']) {
    const record = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record, mode })
    const claude = await import('../../harness/claude.mjs')
    let failure
    try { await claude.invoke({ model: 'm', cwd: await temp(), prompt: 'x' }) } catch (error) { failure = error }
    t.eq(`${mode} retains its provider classification`, classifyFailure(failure).class, mode === 'stdout-quota' ? 'quota' : 'rate-limit')
  }
  for (const mode of ['runtime-error', 'slow']) {
    const record = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CODEX_BIN = await shim({ shape: 'codex', record, mode })
    const codex = await import('../../harness/codex.mjs')
    const controller = new AbortController()
    const pending = codex.invoke({ model: 'm', cwd: await temp(), prompt: 'x', signal: controller.signal }).catch(error => error)
    for (let tries=0; tries<200 && !(await readRecord(record)).length; tries++) await new Promise(resolve => setTimeout(resolve, 10))
    if (mode === 'slow') controller.abort()
    await pending
    const argv = (await readRecord(record))[0]?.received.argv ?? []
    const index = argv.findIndex(arg => arg === '-o' || arg === '--output-last-message')
    t.ok(`${mode} wrote an output-file argument`, index >= 0)
    if (index >= 0) t.eq(`${mode} removes the temporary output directory`, await fs.stat(path.dirname(argv[index+1])).then(()=>true,()=>false), false)
  }

  t.section('3. an observer that throws cannot fail the turn')
  {
    const record = path.join(await temp(), 'calls')
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ shape: 'claude', record })
    const claude = await import('../../harness/claude.mjs')
    const turn = await claude.invoke({
      model: 'm', cwd: await temp(), prompt: 'x', ledgerDir: null,
      observe: { onActivity: () => { throw new Error('observer bug') } }
    })
    t.eq('completed anyway', turn.outcome, 'completed')
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}
