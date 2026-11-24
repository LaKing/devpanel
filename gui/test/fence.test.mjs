import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyFence, fenceArgs, fencedCommand } from '../../harness/fence.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import * as claude from '../../harness/claude.mjs'
import * as codex from '../../harness/codex.mjs'
import { Engine } from '../server/runtime/engine.mjs'
import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { engineFixture } from './fakes/fixture.mjs'
import { DEFAULT_FORBIDDEN_PREFIXES } from '../server/config/host-settings.mjs'

export const name = 'seat fence (fence.namespace: 1) — an allow-list namespace, proved before launch'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RECORDER = path.join(HERE, 'fakes', 'cli', 'env-recorder.mjs')
const PANEL = path.resolve(HERE, '..', '..')

/**
 * Whether this host can run the fence at all. Reported precisely, so a green
 * run without bubblewrap is never mistaken for enforcement evidence
 * (DEVPANEL_REQUIRE_SANDBOX=1 turns a skip into a failure).
 */
async function available () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fence-avail-'))
  try {
    const wrapped = fencedCommand({ command: '/bin/true', args: [], fence: await fenceArgs({ cwd: dir, writable: [dir] }) })
    const r = await runProcess({ command: wrapped.command, args: wrapped.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
    if (r.code === 0) return null
    if (/Unexpected capabilities/.test(r.stderr)) return 'refused: caller capabilities'
    if (/user namespace|Operation not permitted/i.test(r.stderr)) return 'user namespaces unavailable'
    return `bubblewrap failed: ${r.stderr.trim().slice(0, 120)}`
  } catch (error) {
    return error.code === 'ENOENT' ? 'bubblewrap or setpriv absent' : error.message
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

/** Run a shell inside a proved fence and return its stdout. */
async function inside (spec, script, manifest = {}) {
  const f = await applyFence({ spec, manifest })
  if (!f.applied) throw new Error(f.reason)
  const w = f.wrap('/bin/sh', ['-c', script])
  const r = await runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, stdin: '' })
  return { out: r.stdout, code: r.code, fence: f }
}

export default async function (t) {
  const missing = await available()
  if (missing) {
    if (process.env.DEVPANEL_REQUIRE_SANDBOX === '1') t.ok(`the fence can run on this host (${missing})`, false)
    else t.skip(`seat fence: ${missing}`)
    return
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fence-test-')))
  const worktree = path.join(root, 'worktree'), scratch = path.join(root, 'scratch'), evidence = path.join(root, 'evidence')
  const secret = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.fence-canary-')))
  try {
    for (const d of [worktree, scratch, evidence]) await fs.mkdir(d)
    await fs.writeFile(path.join(worktree, 'source.txt'), 'candidate\n')
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n')
    await fs.writeFile(path.join(evidence, 'report.json'), '{}')
    await fs.writeFile(path.join(secret, 'key'), 'HOME-CANARY')
    const spec = { cwd: worktree, writable: [worktree, scratch], readOnly: [evidence], entries: [path.join(worktree, '.git')], panelRoot: PANEL }

    t.section('1. the seat sees its own paths and nothing else')
    {
      const { out } = await inside(spec, [
        `cat source.txt; cat ${evidence}/report.json`,
        `test -e ${secret}/key && echo HOME-CANARY-VISIBLE || echo home-canary-hidden`,
        `test -e ${path.join(os.homedir(), '.ssh')} && echo SSH-VISIBLE || echo ssh-hidden`,
        `test -e ${path.join(PANEL, '.devpanel-token')} && echo TOKEN-VISIBLE || echo token-hidden`,
        `test -e ${path.join(PANEL, 'gui')} && echo PANEL-SOURCE-VISIBLE || echo panel-source-hidden`,
        'ls /srv | tr "\\n" " "'
      ].join('; '))
      t.ok('its worktree and evidence are readable', out.includes('candidate') && out.includes('{}'))
      t.ok('a file elsewhere in the home is absent', out.includes('home-canary-hidden'), out)
      t.ok('~/.ssh is absent', out.includes('ssh-hidden'))
      t.ok('the panel token is absent', out.includes('token-hidden'))
      t.ok('the panel\'s own source is absent', out.includes('panel-source-hidden'))
      const containers = new RegExp(`(^|\\s)(?:${DEFAULT_FORBIDDEN_PREFIXES.join('|')})\\.`)
      t.ok('no container filesystem under /srv is visible', !containers.test(out.split('\n').pop() ?? ''), out.split('\n').pop())
    }

    t.section('2. writes land only where granted')
    {
      const { out } = await inside(spec, [
        'echo edit > source.txt && echo worktree-writable',
        `echo x > ${scratch}/note && echo scratch-writable`,
        `(echo x > ${evidence}/forged) 2>/dev/null && echo EVIDENCE-WRITABLE || echo evidence-read-only`,
        '(echo "gitdir: /evil" > .git) 2>/dev/null && echo ENTRY-REPLACED || echo entry-read-only',
        '(rm -f .git) 2>/dev/null; test -f .git && echo entry-kept || echo ENTRY-REMOVED',
        '(echo x > /etc/forged) 2>/dev/null && echo ETC-WRITABLE || echo etc-read-only'
      ].join('; '))
      for (const word of ['worktree-writable', 'scratch-writable', 'evidence-read-only', 'entry-read-only', 'entry-kept', 'etc-read-only']) t.ok(word, out.includes(word), out)
      t.eq('the worktree edit reached the host', await fs.readFile(path.join(worktree, 'source.txt'), 'utf8'), 'edit\n')
      t.eq('the .git entry on the host is unchanged', await fs.readFile(path.join(worktree, '.git'), 'utf8'), 'gitdir: /somewhere/.git/worktrees/x\n')
    }

    t.section('3. a fence that cannot be proved is not used')
    {
      const exposed = await applyFence({ spec: { ...spec, readOnly: [evidence, secret] }, manifest: {} })
      t.eq('granting a path that a canary names still proves (it is granted, so not a canary)', exposed.applied, true)
      const noCli = await applyFence({ spec, manifest: {}, command: path.join(root, 'no-such-cli') })
      t.eq('a CLI not visible inside refuses the fence', noCli.applied, false)
      t.ok('with the reason', /CLI-NOT-VISIBLE/.test(noCli.reason ?? ''), noCli.reason)
      const writableRo = await applyFence({ spec: { cwd: worktree, writable: [worktree], readOnly: [path.join(root, 'missing')] }, manifest: {} })
      t.eq('a missing read-only root is skipped, not an error', writableRo.applied, true)
    }

    t.section('3b. a protected directory that contains the grant hides everything else in it')
    {
      // The top-level supervisor runs in issues/.supervisor/workspace: the
      // protected issues/.supervisor is a mount point's parent, so it cannot be
      // absent, but its state, ledger and lock must be.
      const panel = path.join(root, 'panel')
      const state = path.join(panel, 'issues', '.supervisor')
      const workspace = path.join(state, 'workspace')
      await fs.mkdir(workspace, { recursive: true })
      await fs.writeFile(path.join(state, 'state.json'), '{}')
      await fs.writeFile(path.join(panel, '.devpanel-token'), 'secret')
      const f = await applyFence({ spec: { cwd: workspace, writable: [workspace], readOnly: [], entries: [], panelRoot: panel }, manifest: {} })
      t.eq('the supervisor workspace fence proves', f.applied, true, f.reason)
      if (f.applied) {
        const w = f.wrap('/bin/sh', ['-c', `for p in ${state}/state.json ${panel}/.devpanel-token; do test -e $p && echo VISIBLE $p; done; : > ${workspace}/probe && echo wrote`])
        const r = await runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
        t.eq('state and token stay invisible; the workspace is writable', r.stdout.trim(), 'wrote')
      }
    }

    t.section('4. cancellation stops the whole tree inside the fence')
    {
      const f = await applyFence({ spec, manifest: {} })
      const w = f.wrap('/bin/sh', ['-c', `sleep 60 & echo $! > ${scratch}/child; sleep 60`])
      const controller = new AbortController()
      const running = runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin' }, stdin: '', signal: controller.signal, graceMs: 500, reap: true })
      for (let i = 0; i < 50 && !(await fs.stat(path.join(scratch, 'child')).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100))
      controller.abort()
      const r = await running
      t.eq('the invocation reports cancelled', r.cancelled, true)
      const leftover = (await runProcess({ command: 'pgrep', args: ['-f', 'sleep 60'], env: { PATH: '/usr/bin:/bin' } })).stdout.trim()
      const ours = []
      for (const pid of leftover.split('\n').filter(Boolean)) {
        const env = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
        if (env.includes('sleep')) ours.push(pid)
      }
      const mine = []
      for (const pid of ours) { const ppid = (await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')).split(' ')[3]; if (ppid) mine.push(pid) }
      t.ok('no sleeper from inside the fence survives', !(await Promise.all(ours.map(async (pid) => (await fs.readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')).includes(scratch)))).some(Boolean))
    }

    t.section('5. the Claude adapter runs its CLI inside the fence and says so')
    {
      const log = path.join(scratch, 'env.jsonl')
      const saved = { bin: process.env.DEVPANEL_CLAUDE_BIN, rec: process.env.DEVPANEL_ENV_RECORDER, pass: process.env.DEVPANEL_CHILD_ENV_PASS }
      process.env.DEVPANEL_CLAUDE_BIN = RECORDER
      process.env.DEVPANEL_ENV_RECORDER = log
      process.env.DEVPANEL_CHILD_ENV_PASS = 'DEVPANEL_ENV_RECORDER'
      try {
        const ledger = path.join(root, 'ledger'); await fs.mkdir(ledger)
        const r = await claude.invoke({ model: 'm', cwd: worktree, scratchDir: scratch, ledgerDir: ledger, prompt: 'hi', hygiene: true,
          tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: path.join(root, 'live'), allowedRoots: [evidence, scratch] },
          // The fake CLI and node live in the panel checkout: granted read-only for this test only.
          fence: { ...spec, readOnly: [evidence, path.dirname(RECORDER), path.join(PANEL, 'gui', 'node_modules')] } })
        t.eq('the turn ran fenced', r.diagnostics?.fence?.namespace, 1, JSON.stringify(r.diagnostics?.fence))
        const record = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))[0]
        t.ok('the CLI was spawned', Boolean(record))
        const settings = JSON.parse(record.argv[record.argv.indexOf('--settings') + 1])
        t.ok('the live checkout is not denied by path inside the fence (it is not mounted)', !(settings.permissions?.deny ?? []).some((d) => d.includes(path.join(root, 'live'))))
        t.eq('the autoupdater is off inside', record.envKeys.includes('DISABLE_AUTOUPDATER'), true)
      } finally {
        for (const [k, env] of [['bin', 'DEVPANEL_CLAUDE_BIN'], ['rec', 'DEVPANEL_ENV_RECORDER'], ['pass', 'DEVPANEL_CHILD_ENV_PASS']]) {
          if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k]
        }
      }
    }

    t.section('5b. a per-run Claude home: sessions in the run, only the credential bound in')
    {
      const log = path.join(scratch, 'env-home.jsonl')
      const cliHome = path.join(root, 'cli-homes', 'implementer')
      const saved = { bin: process.env.DEVPANEL_CLAUDE_BIN, rec: process.env.DEVPANEL_ENV_RECORDER, pass: process.env.DEVPANEL_CHILD_ENV_PASS }
      process.env.DEVPANEL_CLAUDE_BIN = RECORDER
      process.env.DEVPANEL_ENV_RECORDER = log
      process.env.DEVPANEL_CHILD_ENV_PASS = 'DEVPANEL_ENV_RECORDER'
      try {
        const ledger = path.join(root, 'ledger-home'); await fs.mkdir(ledger)
        const fenceSpec = { ...spec, readOnly: [evidence, path.dirname(RECORDER), path.join(PANEL, 'gui', 'node_modules')] }
        const r = await claude.invoke({ model: 'm', cwd: worktree, scratchDir: scratch, ledgerDir: ledger, prompt: 'hi', hygiene: true, cliHome,
          tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [evidence, scratch] }, fence: fenceSpec })
        const record = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).pop()
        t.eq('the CLI\'s config directory is the per-run home', record.CLAUDE_CONFIG_DIR, cliHome)
        t.eq('the turn reports a per-run home', r.diagnostics?.fence?.home, 'per-run')
        t.eq('the session records it, so a resume uses the same home', r.session?.home, cliHome)
        t.ok('the credential mount point exists in the run home', await fs.stat(path.join(cliHome, '.credentials.json')).then(() => true, () => false))
        // A resumed session whose fence cannot be proved (here: a mounted path is
        // named as a canary) must not fall back to the shared home, where its
        // transcript is not.
        const broken = await claude.invoke({ model: 'm', cwd: worktree, scratchDir: scratch, ledgerDir: ledger, prompt: 'hi', hygiene: true, cliHome, session: r.session,
          tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [evidence, scratch] }, fence: { ...fenceSpec, canaries: [evidence] } }).then(() => null, (e) => e)
        t.eq('a per-run session outside a proved fence is an environment error', broken?.kind, 'environment-error')
        t.ok('saying why', /per-run home/.test(broken?.message ?? ''), broken?.message)
        const first = await claude.invoke({ model: 'm', cwd: worktree, scratchDir: scratch, ledgerDir: ledger, prompt: 'hi', hygiene: true, cliHome: path.join(root, 'cli-homes', 'other'),
          tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [evidence, scratch] }, fence: { ...fenceSpec, canaries: [evidence] } }).then(() => null, (e) => e)
        // Audit I5: an unproved fence refuses the turn; running unfenced is an
        // operator switch, recorded as namespace 0, never the adapter's own fallback.
        t.eq('a NEW session whose fence cannot be proved is refused', first?.kind, 'environment-error', first?.message)
        t.ok('saying why and naming the switch', /could not be proved/.test(first?.message ?? '') && /DEVPANEL_FENCE_UNPROVED/.test(first?.message ?? ''), first?.message)
        process.env.DEVPANEL_FENCE_UNPROVED = 'run'
        let switched
        try {
          switched = await claude.invoke({ model: 'm', cwd: worktree, scratchDir: scratch, ledgerDir: ledger, prompt: 'hi', hygiene: true, cliHome: path.join(root, 'cli-homes', 'other'),
            tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [evidence, scratch] }, fence: { ...fenceSpec, canaries: [evidence] } })
        } finally { delete process.env.DEVPANEL_FENCE_UNPROVED }
        t.eq('with the operator switch it runs, recorded as namespace 0', switched.diagnostics?.fence?.namespace, 0, JSON.stringify(switched.diagnostics?.fence))
        t.ok('with the reason', /VISIBLE/.test(switched.diagnostics?.fence?.reason ?? ''), switched.diagnostics?.fence?.reason)
        t.eq('in the shared home, not the per-run one', switched.diagnostics?.fence?.home, 'shared')
      } finally {
        for (const [k, env] of [['bin', 'DEVPANEL_CLAUDE_BIN'], ['rec', 'DEVPANEL_ENV_RECORDER'], ['pass', 'DEVPANEL_CHILD_ENV_PASS']]) {
          if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k]
        }
      }
    }

    t.section('6. the engine\'s own spec on a real linked worktree: worker Git reads, cannot stage')
    {
      const f = await engineFixture()
      const ws = await gitWorktreeProvider.create({ projectPath: f.projectPath, runId: 'fence-engine', root: f.issuePath, policy: { base: 'head' } })
      await fs.writeFile(path.join(ws.path, 'source.txt'), 'edited\n')
      const runScratch = path.join(f.issuePath, 'scratch'); await fs.mkdir(runScratch, { recursive: true })
      const self = { toolingMounts: Engine.prototype.toolingMounts, hostFence: Engine.prototype.hostFence, snapshot: { fence: { namespace: 1 } }, run: { workspace: { ...ws, scratchPath: runScratch, source: { repository: await fs.realpath(path.join(f.projectPath, '.git')) } } } }
      const saved = process.env.DEVPANEL_FENCE
      delete process.env.DEVPANEL_FENCE
      let engineSpec
      try { engineSpec = await Engine.prototype.fenceSpec.call(self, { coordinationOnly: false, tooling: { writesCode: true, allowedRoots: [runScratch] }, scratchDir: runScratch }) }
      finally { if (saved !== undefined) process.env.DEVPANEL_FENCE = saved }
      t.ok('the spec binds the worktree entry read-only', engineSpec.entries.includes(path.join(ws.path, '.git')))
      const { out } = await inside(engineSpec, [
        'git status --porcelain 2>&1 | head -3',
        'git diff --stat 2>&1 | tail -1',
        '(git add source.txt 2>&1 | head -1) ; echo "add-exit:$?"',
        `test -e ${path.join(f.projectPath, 'source.txt')} && echo LIVE-CHECKOUT-VISIBLE || echo live-checkout-hidden`
      ].join('; '), { homeBinds: [{ path: path.join(os.homedir(), '.gitconfig') }] })
      t.ok('git status works inside', out.includes('M source.txt'), out)
      t.ok('git diff works inside', /1 file changed/.test(out), out)
      t.ok('staging is refused (read-only object store)', /Read-only file system|unable|fatal/i.test(out), out)
      t.ok('the live checkout itself is not visible', out.includes('live-checkout-hidden'), out)
      await gitWorktreeProvider.release({ projectPath: f.projectPath, path: ws.path })
    }

    t.section('7. the Codex manifest: the login and sessions are writable, the operator\'s configuration is not')
    {
      // A seat that could rewrite config.toml (notify program, MCP commands),
      // AGENTS.md, hooks, rules or skills would have them executed by the
      // operator's next interactive codex, outside every fence (audit I3).
      const codexHome = path.join(root, 'codex-home')
      await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true })
      await fs.mkdir(path.join(codexHome, 'skills', 'x'), { recursive: true })
      await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "m"\n')
      await fs.writeFile(path.join(codexHome, 'AGENTS.md'), 'operator instructions\n')
      await fs.writeFile(path.join(codexHome, 'auth.json'), '{"tokens":{}}\n')
      await fs.writeFile(path.join(codexHome, 'skills', 'x', 'SKILL.md'), 'skill\n')
      const manifest = await codex.fenceManifest({ binary: RECORDER, env: { CODEX_HOME: codexHome } })
      t.ok('config.toml and AGENTS.md are bound read-only over themselves', ['config.toml', 'AGENTS.md'].every((n) => manifest.entries.includes(path.join(codexHome, n))), JSON.stringify(manifest.entries))
      t.ok('the skills directory is read-only', manifest.readOnly.includes(path.join(codexHome, 'skills')))
      const probe = (file) => `(echo planted >> ${codexHome}/${file}) 2>/dev/null && echo "${file}:WRITTEN" || echo "${file}:refused"`
      const { out } = await inside(spec, [probe('config.toml'), probe('AGENTS.md'), probe('skills/x/SKILL.md'), probe('skills/new.md'),
        `(rm ${codexHome}/config.toml) 2>/dev/null && echo "config.toml:REMOVED" || echo "config.toml:kept"`,
        probe('auth.json'), probe('sessions/rollout.jsonl')].join('; '), manifest)
      for (const file of ['config.toml', 'AGENTS.md', 'skills/x/SKILL.md', 'skills/new.md']) t.ok(`${file} cannot be written from inside`, out.includes(`${file}:refused`), out)
      t.ok('config.toml cannot be removed either', out.includes('config.toml:kept'), out)
      t.ok('auth.json stays writable (the CLI refreshes its login)', out.includes('auth.json:WRITTEN'), out)
      t.ok('sessions stay writable', out.includes('sessions/rollout.jsonl:WRITTEN'), out)
      t.eq('the real file is untouched', await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), 'model = "m"\n')
    }

    t.section('8. the guarded Codex fence: missing configuration is created and cannot be written from inside (config-guard.mjs, AC1)')
    {
      const home = path.join(root, 'codex-home-guarded')
      await fs.mkdir(path.join(home, 'sessions'), { recursive: true })
      const manifest = await codex.fenceManifest({ binary: RECORDER, env: { CODEX_HOME: home } })
      const f = await applyFence({ spec, manifest, guard: codex.configGuardFor({ CODEX_HOME: home }) })
      t.ok('the guarded fence is proved and applied', f.applied === true && f.config?.created?.length === 8, f.reason)
      const w = f.wrap('/bin/sh', ['-c', [
        ...['hooks/x', 'rules/x', 'skills/x', 'config.toml', 'AGENTS.md', 'requirements.toml'].map((p) => `(echo planted >> ${home}/${p}) 2>/dev/null && echo "${p}:WRITTEN" || echo "${p}:refused"`),
        `(echo '{}' > ${home}/hooks.json) 2>/dev/null && echo "hooks.json:WRITTEN" || echo "hooks.json:refused"`,
        `(echo s > ${home}/sessions/rollout.jsonl) 2>/dev/null && echo "sessions:WRITTEN" || echo "sessions:refused"`
      ].join('; ')])
      const r = await runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, stdin: '' })
      for (const p of ['hooks/x', 'rules/x', 'skills/x', 'config.toml', 'AGENTS.md', 'requirements.toml']) t.ok(`${p} cannot be written from inside`, r.stdout.includes(`${p}:refused`), r.stdout)
      t.ok('hooks.json can be created (it is integrity-checked after the turn, not bound)', r.stdout.includes('hooks.json:WRITTEN'), r.stdout)
      t.ok('sessions stay writable', r.stdout.includes('sessions:WRITTEN'), r.stdout)
      const sup = await applyFence({ spec: { ...spec, seat: false }, manifest: await codex.fenceManifest({ binary: RECORDER, env: { CODEX_HOME: path.join(root, 'codex-home-runless') } }), guard: codex.configGuardFor({ CODEX_HOME: path.join(root, 'codex-home-runless') }) })
      t.eq('a runless fence (supervisor) prepares nothing', sup.config, null)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(secret, { recursive: true, force: true })
  }
}
