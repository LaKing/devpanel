import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as guard from '../../harness/config-guard.mjs'
import * as codex from '../../harness/codex.mjs'
import * as gemini from '../../harness/gemini.mjs'
import { applyFence, assertFenced, fenceArgs, runlessFence } from '../../harness/fence.mjs'
import * as claude from '../../harness/claude.mjs'
import { runProcess } from '../server/runtime/process.mjs'

export const name = 'operator configuration in shared CLI homes — pre-created, bound read-only, integrity-checked (config-guard.mjs)'

const LINUX = { id: 'linux', bubblewrap: true }
const provedStub = (calls = []) => async (args) => { calls.push(args); return { proved: true, reason: null, checked: {} } }
const exists = (p) => fs.lstat(p).then(() => true, () => false)
const listing = async (dir) => (await fs.readdir(dir, { recursive: true })).sort().join(',')
const ledgerLines = async (file) => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const resetHooks = () => { for (const k of Object.keys(guard.hooks)) guard.hooks[k] = null }

/** fs.promises.open, wrapped to log every sync (path) and optionally fail one. */
function watchSyncs ({ fail = null } = {}) {
  const original = fs.open
  const log = []
  fs.open = async (p, ...rest) => {
    const handle = await original(p, ...rest)
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      log.push(String(p))
      if (fail?.(String(p))) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' })
      return sync()
    }
    return handle
  }
  return { log, restore: () => { fs.open = original } }
}

export default async function (t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'config-guard-')))
  const mk = async (name) => { const d = path.join(root, name); await fs.mkdir(d, { recursive: true }); return d }
  const work = await mk('work')
  const spec = { cwd: work, writable: [work], readOnly: [], entries: [] }
  try {
    t.section('1. Codex: missing directories and empty-safe files are created; checked files are only watched (AC1, AC6)')
    {
      const home = await mk('codex-home')
      await fs.writeFile(path.join(home, 'config.toml'), 'model = "m"\n')
      const p = await codex.configGuardFor({ CODEX_HOME: home }).prepare()
      for (const d of ['rules', 'skills', 'hooks', 'plugins', 'prompts']) {
        const st = await fs.lstat(path.join(home, d))
        t.ok(`${d}/ was created as an empty directory`, st.isDirectory() && (await fs.readdir(path.join(home, d))).length === 0)
      }
      for (const f of ['requirements.toml', 'AGENTS.md']) t.eq(`${f} was created empty`, (await fs.stat(path.join(home, f))).size, 0)
      t.eq('an existing config.toml is left as it was', await fs.readFile(path.join(home, 'config.toml'), 'utf8'), 'model = "m"\n')
      t.eq('hooks.json is not created (an empty one is invalid JSON)', await exists(path.join(home, 'hooks.json')), false)
      t.eq('the five directories are to be bound read-only', p.readOnly.map((d) => path.basename(d)), ['rules', 'skills', 'hooks', 'plugins', 'prompts'])
      t.eq('the three empty-safe files are to be bound read-only', p.entries.map((f) => path.basename(f)), ['config.toml', 'requirements.toml', 'AGENTS.md'])
      t.eq('hooks.json, AGENTS.override.md and .env are watched', p.watch.map((f) => path.basename(f)), ['hooks.json', 'AGENTS.override.md', '.env'])

      const linked = await mk('codex-linked')
      await fs.symlink(path.join(root, 'elsewhere'), path.join(linked, 'hooks'))
      const refusal = await codex.configGuardFor({ CODEX_HOME: linked }).prepare().then(() => null, (e) => e)
      t.ok('a symlink at a listed directory refuses the turn', /hooks is a symlink/.test(refusal?.message ?? ''), refusal?.message)
      t.eq('and nothing was created before the refusal', await listing(linked), 'hooks')
      const checked = await mk('codex-checked-link')
      await fs.writeFile(path.join(root, 'target.json'), '{}')
      await fs.symlink(path.join(root, 'target.json'), path.join(checked, 'hooks.json'))
      const refusal2 = await codex.configGuardFor({ CODEX_HOME: checked }).prepare().then(() => null, (e) => e)
      t.ok('a symlinked checked file (hooks.json) refuses the turn too', /hooks\.json is a symlink/.test(refusal2?.message ?? ''), refusal2?.message)
      t.eq('…again before anything is created', await listing(checked), 'hooks.json')
      const absent = await codex.configGuardFor({ CODEX_HOME: path.join(root, 'no-such-home') }).prepare()
      t.eq('an absent home is skipped, not created', [absent.skipped, await exists(path.join(root, 'no-such-home'))], ['home-absent', false])
    }

    t.section('2. Gemini: the same mechanism in .gemini, which itself stays writable (AC2, AC4)')
    {
      const ghome = await mk('gemini-home')
      const p = await gemini.configGuardFor({ GEMINI_CLI_HOME: ghome }).prepare()
      const base = path.join(ghome, '.gemini')
      t.ok('.gemini was created under GEMINI_CLI_HOME', (await fs.lstat(base)).isDirectory())
      t.ok('.gemini itself is not bound read-only (credentials, sessions)', !p.readOnly.includes(base))
      t.eq('its configuration directories are', p.readOnly.map((d) => path.relative(ghome, d)), ['.gemini/extensions', '.gemini/commands', '.gemini/policies', '.gemini/agents', '.gemini/skills'])
      t.eq('GEMINI.md is created empty and bound', [(await fs.stat(path.join(base, 'GEMINI.md'))).size, p.entries.map((f) => path.basename(f))], [0, ['GEMINI.md']])
      t.eq('settings.json, trustedFolders.json and .env are watched, not created', [p.watch.map((f) => path.basename(f)), await exists(path.join(base, 'settings.json'))], [['settings.json', 'trustedFolders.json', '.env'], false])
      const dflt = gemini.configGuardFor({})
      t.eq('without GEMINI_CLI_HOME the home is ~/.gemini itself', [dflt.plan.bindRoot, dflt.plan.base], [path.join(os.homedir(), '.gemini'), path.join(os.homedir(), '.gemini')])
    }

    t.section('3. the final fence binds every prepared entry read-only after the writable home (AC1, AC6; required-bind-fallback)')
    {
      const home = await mk('codex-bind')
      const manifest = await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: home } })
      const fenced = await applyFence({ spec, manifest, guard: codex.configGuardFor({ CODEX_HOME: home }), platform: LINUX, prove: provedStub() })
      t.eq('the guarded fence is applied', fenced.applied, true, fenced.reason)
      const args = fenced.wrap('/bin/true', []).args
      const at = (flag, p) => args.findIndex((a, i) => a === flag && args[i + 1] === p && args[i + 2] === p)
      const homeAt = at('--bind', home)
      t.ok('the home is bound writable', homeAt > 0)
      for (const d of ['rules', 'skills', 'hooks', 'plugins', 'prompts', 'config.toml', 'requirements.toml', 'AGENTS.md']) {
        t.ok(`${d} is bound read-only over itself, after the home`, at('--ro-bind', path.join(home, d)) > homeAt)
      }
      t.eq('the step records what the guard did', guard.configDiagnostics(fenced.config).created.length, 8)
      const p = await codex.configGuardFor({ CODEX_HOME: home }).prepare()
      t.eq('missingBind finds nothing missing in those arguments', await guard.missingBind(await fenceArgs({ cwd: work, writable: [work], homeBinds: [{ path: home, writable: true }], readOnly: p.readOnly, entries: p.entries }), p), null)
      const vanished = { prepare: async () => ({ ...p, readOnly: [...p.readOnly, path.join(home, 'gone')] }) }
      const refused = await applyFence({ spec, manifest, guard: vanished, platform: LINUX, prove: provedStub() })
      t.ok('an entry the final fence would skip refuses the turn', refused.refused === true && /gone is not bound read-only/.test(refused.reason), refused.reason)
      const absent = await applyFence({ spec, manifest: await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: path.join(root, 'absent') } }), guard: codex.configGuardFor({ CODEX_HOME: path.join(root, 'absent') }), platform: LINUX, prove: provedStub() })
      t.eq('an absent home launches without configuration binds', [absent.applied, absent.config?.skipped], [true, 'home-absent'])
    }

    t.section('4. nothing touches the home unless the turn will run inside a proved fence (AC5; unfenced-fallback)')
    {
      const home = await mk('codex-unproved')
      const before = await listing(home)
      let prepared = 0
      const spy = { prepare: async () => { prepared++; return codex.configGuardFor({ CODEX_HOME: home }).prepare() } }
      const manifest = await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: home } })
      const unproved = await applyFence({ spec, manifest, guard: spy, platform: LINUX, prove: async () => ({ proved: false, reason: 'no namespaces' }) })
      t.eq('an unproved fence never prepares', [unproved.applied, unproved.refused ?? false, prepared], [false, false, 0])
      t.eq('the home is byte-for-byte as it was', await listing(home), before)
      const saved = process.env.DEVPANEL_FENCE_UNPROVED
      process.env.DEVPANEL_FENCE_UNPROVED = 'run'
      try {
        t.eq('the operator switch still runs it unfenced (namespace 0), as today', (() => { try { assertFenced(unproved, { platform: LINUX }); return 'runs' } catch (e) { return e.message } })(), 'runs')
        let n = 0
        const second = await applyFence({ spec, manifest, guard: spy, platform: LINUX, prove: async () => (n++ ? { proved: false, reason: 'second' } : { proved: true, checked: {} }) })
        t.eq('a failed guarded proof refuses', second.refused, true)
        t.ok('…and the placeholders stay (harmless, never deleted)', await exists(path.join(home, 'hooks')))
        t.ok('…and no unfenced fallback runs it, whatever the switch says', (() => { try { assertFenced(second, { platform: LINUX }); return false } catch (e) { return e.kind === 'environment-error' && e.started === false } })())
      } finally { if (saved === undefined) delete process.env.DEVPANEL_FENCE_UNPROVED; else process.env.DEVPANEL_FENCE_UNPROVED = saved }
      const runless = { ...spec, seat: false }
      prepared = 0
      const sup = await applyFence({ spec: runless, manifest, guard: spy, platform: LINUX, prove: provedStub() })
      t.eq('a runless (seat: false) spec never prepares', [sup.applied, prepared, sup.config], [true, 0, null])
      const savedFence = process.env.DEVPANEL_FENCE
      delete process.env.DEVPANEL_FENCE
      try {
        const spec2 = runlessFence({ cwd: work })
        if (spec2) t.eq('runlessFence marks its spec seat: false', spec2.seat, false)
        else t.skip('runlessFence returns no spec under this host\'s fence policy')
      } finally { if (savedFence !== undefined) process.env.DEVPANEL_FENCE = savedFence }
    }

    t.section('5. the supervisor\'s manifest and fence arguments are byte-identical to today\'s (AC5; supervisor-manifest)')
    {
      const home = await mk('codex-supervisor')
      for (const f of ['config.toml', 'AGENTS.md', 'hooks.json', 'requirements.toml', 'AGENTS.override.md', '.env']) await fs.writeFile(path.join(home, f), 'x')
      for (const d of ['rules', 'skills']) await fs.mkdir(path.join(home, d))
      const manifest = await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: home } })
      t.eq('the manifest keys are today\'s', Object.keys(manifest), ['home', 'homeBinds', 'entries', 'readOnly', 'writable'])
      t.eq('entries are only today\'s four names', manifest.entries.map((f) => path.basename(f)), ['config.toml', 'AGENTS.md', 'hooks.json', 'requirements.toml'])
      t.eq('read-only directories are only the existing ones', manifest.readOnly.map((d) => path.basename(d)), ['rules', 'skills'])
      const runless = { ...spec, seat: false }
      const plain = await applyFence({ spec: runless, manifest, platform: LINUX, prove: provedStub() })
      const withGuard = await applyFence({ spec: runless, manifest, guard: codex.configGuardFor({ CODEX_HOME: home }), platform: LINUX, prove: provedStub() })
      t.eq('a seat: false turn gets exactly the arguments it got without a guard', JSON.stringify(withGuard.wrap('/bin/true', []).args), JSON.stringify(plain.wrap('/bin/true', []).args))
      t.eq('and the home gained nothing', (await fs.readdir(home)).sort(), ['.env', 'AGENTS.md', 'AGENTS.override.md', 'config.toml', 'hooks.json', 'requirements.toml', 'rules', 'skills'])
    }

    t.section('6. an abort during the added preparation or proof is a cancellation, not a refusal (AC5; abort-during-final-proof)')
    {
      const home = await mk('codex-abort')
      const manifest = await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: home } })
      const ac = new AbortController()
      let n = 0
      const prove = async () => { if (n++ === 0) return { proved: true, checked: {} }; ac.abort(); return { proved: false, reason: 'the fence probe was cancelled' } }
      const during = await applyFence({ spec, manifest, guard: codex.configGuardFor({ CODEX_HOME: home }), platform: LINUX, prove, signal: ac.signal }).then(() => null, (e) => e)
      t.eq('an abort during the final proof surfaces as AbortError', during?.name, 'AbortError')
      const ac2 = new AbortController()
      const g = codex.configGuardFor({ CODEX_HOME: home })
      const inPrepare = await applyFence({ spec, manifest, guard: { prepare: async () => { ac2.abort(); return g.prepare() } }, platform: LINUX, prove: provedStub(), signal: ac2.signal }).then(() => null, (e) => e)
      t.eq('…and so does one during the preparation', inPrepare?.name, 'AbortError')
    }

    // ---------------------------------------------------------------------------
    const codexHome = await mk('codex-turns')
    const config = await codex.configGuardFor({ CODEX_HOME: codexHome }).prepare()
    const hooksJson = path.join(codexHome, 'hooks.json')
    const ledger = path.join(root, 'ledger', 'codex-ledger.jsonl')
    const node = (script, extra = {}) => runProcess({ command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH }, stdin: '', ...extra })

    t.section('7. a seat-created hooks.json is detected, moved aside and fails the turn; an unchanged home passes (AC3, AC6)')
    {
      const planted = await guard.runGuarded({ config, label: 'run-1', ledgerFile: ledger, invocationId: 'inv-plant' }, () => node(`require('fs').writeFileSync(${JSON.stringify(hooksJson)}, '{"hooks":"curl evil"}')`))
      const v = planted.integrity.violations[0]
      t.eq('one violation: hooks.json created', [planted.integrity.violations.length, path.basename(v.path), v.change, v.status], [1, 'hooks.json', 'created', 'quarantined'])
      t.ok('moved into <name>.devpanel-quarantine-<runId>-<ts>', /\/hooks\.json\.devpanel-quarantine-run-1-[^/]+\/hooks\.json\.[0-9a-f]{32}$/.test(v.quarantinedTo), v.quarantinedTo)
      t.eq('its bytes are intact there, nothing deleted', await fs.readFile(v.quarantinedTo, 'utf8'), '{"hooks":"curl evil"}')
      t.eq('the operator\'s CLI no longer finds it', await exists(hooksJson), false)
      const error = guard.configViolation(planted.integrity, { cli: 'codex', run: planted.run, invocationId: 'inv-plant' })
      t.ok('the turn fails as an integrity violation, with the explanation', error.kind === 'environment-error' && error.integrity === planted.integrity && /^integrity violation: .*created hooks\.json, moved to/.test(error.message), error.message)
      t.eq('the verdict is in the ledger, not yet acknowledged', (await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-plant' }))?.replayed, true)
      t.eq('the caller acknowledges it once its record is persisted', await guard.resolveConfig({ ledgerFile: ledger, invocationId: 'inv-plant' }), true)
      t.eq('…after which nothing replays', await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-plant' }), null)

      const clean = await guard.runGuarded({ config, label: 'run-1', ledgerFile: ledger, invocationId: 'inv-clean' }, () => node(''))
      t.eq('an unchanged home passes', [clean.run.code, clean.integrity.violations.length], [0, 0])
      t.eq('and leaves nothing pending', await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-clean' }), null)
    }

    t.section('8. a cancelled turn is still checked, and fails as an integrity violation (AC3, AC6; option B)')
    {
      const ac = new AbortController()
      const turn = guard.runGuarded({ config, label: 'run-1', ledgerFile: ledger, invocationId: 'inv-cancel' },
        () => node(`require('fs').writeFileSync(${JSON.stringify(hooksJson)}, '{}'); setInterval(() => {}, 1000)`, { signal: ac.signal, graceMs: 500 }))
      for (let i = 0; i < 200 && !await exists(hooksJson); i++) await new Promise((r) => setTimeout(r, 25))
      ac.abort()
      const r = await turn
      t.eq('the process was cancelled', r.run?.cancelled, true)
      t.eq('the check still ran and moved the file', [r.integrity.violations[0]?.status, await exists(hooksJson)], ['quarantined', false])
      const error = guard.configViolation(r.integrity, { cli: 'codex', run: r.run, invocationId: 'inv-cancel' })
      t.ok('the turn fails as an integrity violation, not a cancellation', error.name !== 'AbortError' && error.kind === 'environment-error' && /also cancelled/.test(error.message), error.message)
    }

    t.section('9. the pre-turn snapshot is durable before launch, or the turn does not start (AC3; interrupted-integrity)')
    {
      const locked = await mk('locked-ledger')
      await fs.chmod(locked, 0o500)
      let launched = false
      const refused = await guard.runGuarded({ config, label: 'run-1', ledgerFile: path.join(locked, 'sub', 'codex-ledger.jsonl'), invocationId: 'inv-locked' }, async () => { launched = true; return { code: 0 } }).then(() => null, (e) => e)
      await fs.chmod(locked, 0o700)
      t.ok('an unwritable ledger refuses the turn before launch', refused?.kind === 'environment-error' && refused.started === false && !launched, refused?.message)
    }

    t.section('10. quarantine claims a fresh name and never replaces anything (AC3; quarantine-no-clobber)')
    {
      guard.hooks.stamp = () => 'STAMP'
      try {
        const taken = path.join(codexHome, 'hooks.json.devpanel-quarantine-run-2-STAMP')
        await fs.mkdir(taken)
        await fs.writeFile(path.join(taken, 'keep'), 'earlier')
        const r = await guard.runGuarded({ config, label: 'run-2', ledgerFile: ledger, invocationId: 'inv-taken' }, async () => { await fs.writeFile(hooksJson, 'new'); return { code: 0 } })
        const v = r.integrity.violations[0]
        t.ok('a taken name moves the claim to -2', v.quarantinedTo.startsWith(`${taken}-2/`), v.quarantinedTo)
        t.eq('the earlier quarantine is untouched', [await fs.readFile(path.join(taken, 'keep'), 'utf8'), (await fs.readdir(taken)).length], ['earlier', 1])
        const r2 = await guard.runGuarded({ config, label: 'run-2', ledgerFile: ledger, invocationId: 'inv-taken-2' }, async () => { await fs.writeFile(hooksJson, 'again'); return { code: 0 } })
        t.ok('inner names are random and distinct', path.basename(r2.integrity.violations[0].quarantinedTo) !== path.basename(v.quarantinedTo))
      } finally { resetHooks() }
      guard.hooks.beforeMove = async ({ src }) => { await fs.rm(src); await fs.writeFile(src, 'swapped in') }
      try {
        const r = await guard.runGuarded({ config, label: 'run-3', ledgerFile: ledger, invocationId: 'inv-swap' }, async () => { await fs.writeFile(hooksJson, 'first'); return { code: 0 } })
        t.eq('a source swapped mid-quarantine is what is moved (its contents captured)', await fs.readFile(r.integrity.violations[0].quarantinedTo, 'utf8'), 'swapped in')
      } finally { resetHooks() }
      guard.hooks.beforeMove = async ({ src }) => { await fs.rm(src) }
      try {
        const r = await guard.runGuarded({ config, label: 'run-4', ledgerFile: ledger, invocationId: 'inv-gone' }, async () => { await fs.writeFile(hooksJson, 'x'); return { code: 0 } })
        const v = r.integrity.violations[0]
        t.ok('a move that fails leaves the claim empty and still fails the turn', v.status === 'quarantine-failed' && (await fs.readdir(v.claim)).length === 0, JSON.stringify(v))
      } finally { resetHooks() }
      const dir = await guard.runGuarded({ config, label: 'run-5', ledgerFile: ledger, invocationId: 'inv-dir' }, async () => { await fs.mkdir(hooksJson); return { code: 0 } })
      t.ok('a directory planted at a checked name is moved aside too', (await fs.lstat(dir.integrity.violations[0].quarantinedTo)).isDirectory())
    }

    t.section('11. an interrupted check is finished by recovery, from the durable intent (AC3; interrupted-integrity)')
    {
      class Crash extends Error {}
      guard.hooks.stamp = () => 'CRASH'
      const taken = path.join(codexHome, 'hooks.json.devpanel-quarantine-run-6-CRASH')
      await fs.mkdir(taken)
      await fs.writeFile(path.join(taken, 'unrelated'), 'older quarantine')
      guard.hooks.beforeMove = async () => { throw new Crash('panel died before the move') }
      const crashed = await guard.runGuarded({ config, label: 'run-6', ledgerFile: ledger, invocationId: 'inv-crash-1' }, async () => { await fs.writeFile(hooksJson, 'evil'); return { code: 0 } })
      resetHooks()
      t.ok('the crash fired after the intent, before the move', crashed.guardError instanceof Crash && await exists(hooksJson))
      t.ok('a guard error after the launch keeps the run and still fails it with structured integrity', crashed.run?.code === 0 && crashed.integrity?.incomplete === true && crashed.integrity.violations[0]?.status === 'check-failed', JSON.stringify(crashed.integrity))
      const intent = (await ledgerLines(ledger)).find((e) => e.invocationId === 'inv-crash-1' && e.phase === 'quarantine-intent')
      t.eq('the intent names the claim actually made (-2), not the taken first name', intent?.claim, `${taken}-2`)
      const r = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-crash-1' })
      t.ok('recovery moves it and reports the violation', r.integrity.violations[0].status === 'quarantined' && !await exists(hooksJson), JSON.stringify(r.integrity.violations[0]))
      t.eq('the older quarantine is untouched', await fs.readFile(path.join(taken, 'unrelated'), 'utf8'), 'older quarantine')

      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId === 'inv-crash-2') throw new Crash('panel died before the verdict') }
      await guard.runGuarded({ config, label: 'run-7', ledgerFile: ledger, invocationId: 'inv-crash-2' }, async () => { await fs.writeFile(hooksJson, 'evil2'); return { code: 0 } }).catch(() => {})
      resetHooks()
      const syncs = watchSyncs()
      let r2
      try { r2 = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-crash-2' }) } finally { syncs.restore() }
      const v2 = r2.integrity.violations[0]
      t.ok('after a crash past the move, the matching destination is reported', v2.status === 'quarantined' && v2.change === 'created', JSON.stringify(v2))
      const claim = path.dirname(v2.quarantinedTo)
      const iClaim = syncs.log.indexOf(claim)
      const iDir = syncs.log.indexOf(codexHome, iClaim + 1)
      const iLedger = syncs.log.indexOf(ledger, iDir + 1)
      t.ok('recovery syncs the claim, then the source directory, then records the verdict', iClaim >= 0 && iDir > iClaim && iLedger > iDir, JSON.stringify(syncs.log))

      // A mismatching object where the move should be: unverified, never "quarantined".
      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId.startsWith('inv-mismatch')) throw new Crash('crash') }
      await guard.runGuarded({ config, label: 'run-8', ledgerFile: ledger, invocationId: 'inv-mismatch-1' }, async () => { await fs.writeFile(hooksJson, 'evil3'); return { code: 0 } }).catch(() => {})
      await guard.runGuarded({ config, label: 'run-9', ledgerFile: ledger, invocationId: 'inv-mismatch-2' }, async () => { await fs.writeFile(hooksJson, 'evil4'); return { code: 0 } }).catch(() => {})
      resetHooks()
      const lines = await ledgerLines(ledger)
      const swap = async (id) => { const i = lines.find((e) => e.invocationId === id && e.phase === 'quarantine-intent'); const p = path.join(i.claim, i.inner); await fs.rm(p); await fs.writeFile(p, 'not the moved file') }
      await swap('inv-mismatch-1')
      const u = (await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-mismatch-1' })).integrity.violations[0]
      t.ok('an identity mismatch with the original path absent is quarantine-unverified, still a violation', u.status === 'quarantine-unverified' && !u.quarantinedTo, JSON.stringify(u))
      await swap('inv-mismatch-2')
      await fs.writeFile(hooksJson, 'still here')
      const q = (await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-mismatch-2' })).integrity.violations[0]
      t.ok('…and with the configuration still at the original path, it is quarantined anew', q.status === 'quarantined' && q.earlierClaim?.status === 'quarantine-unverified' && !await exists(hooksJson), JSON.stringify(q))
    }

    t.section('12. a move whose directory syncs fail is not done: no verdict, no acknowledgement, retried by recovery (AC3; quarantine-move-durability)')
    {
      const live = watchSyncs()
      let r
      try { r = await guard.runGuarded({ config, label: 'run-10', ledgerFile: ledger, invocationId: 'inv-order' }, async () => { await fs.writeFile(hooksJson, 'x'); return { code: 0 } }) } finally { live.restore() }
      const claim = path.dirname(r.integrity.violations[0].quarantinedTo)
      const a = live.log.indexOf(claim)
      const b = live.log.indexOf(codexHome, a + 1)
      const c = live.log.indexOf(ledger, b + 1)
      t.ok('live: claim synced, then the source directory, then the verdict', a >= 0 && b > a && c > b, JSON.stringify(live.log))

      const failing = watchSyncs({ fail: (p) => p.includes('.devpanel-quarantine-run-11-') })
      let u
      try { u = await guard.runGuarded({ config, label: 'run-11', ledgerFile: ledger, invocationId: 'inv-unsynced' }, async () => { await fs.writeFile(hooksJson, 'x'); return { code: 0 } }) } finally { failing.restore() }
      t.eq('a failed sync is quarantine-unsynced, still a violation', u.integrity.violations[0].status, 'quarantine-unsynced')
      t.eq('no verdict line was written', (await ledgerLines(ledger)).some((e) => e.invocationId === 'inv-unsynced' && e.phase === 'config-checked'), false)
      t.eq('and it cannot be acknowledged', await guard.resolveConfig({ ledgerFile: ledger, invocationId: 'inv-unsynced' }), false)
      const retry = watchSyncs()
      let rr
      try { rr = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-unsynced' }) } finally { retry.restore() }
      const rc = path.dirname(rr.integrity.violations[0].quarantinedTo)
      const ra = retry.log.indexOf(rc)
      t.ok('recovery retries both syncs in order, then records it quarantined', rr.integrity.violations[0].status === 'quarantined' && ra >= 0 && retry.log.indexOf(codexHome, ra + 1) > ra, JSON.stringify(retry.log))
      t.eq('…after which it can be acknowledged', await guard.resolveConfig({ ledgerFile: ledger, invocationId: 'inv-unsynced' }), true)
    }

    t.section('13. overlapping turns on one home: the turn that created the change fails too (AC3; concurrent-turn-attribution)')
    {
      const la = path.join(root, 'ledger-a', 'codex-ledger.jsonl')
      const lb = path.join(root, 'ledger-b', 'codex-ledger.jsonl')
      let release
      const gate = new Promise((r) => { release = r })
      let planted
      const plantedP = new Promise((r) => { planted = r })
      // Both turns take their snapshot first; then A creates the file and B finishes before A.
      let startB
      const bStarted = new Promise((r) => { startB = r })
      let finishB
      const bGate = new Promise((r) => { finishB = r })
      const bTurn = guard.runGuarded({ config, label: 'b', ledgerFile: lb, invocationId: 'B1' }, async () => { startB(); await bGate; return { code: 0 } })
      await bStarted
      const a = guard.runGuarded({ config, label: 'a', ledgerFile: la, invocationId: 'A1' }, async () => { await fs.writeFile(hooksJson, 'by A'); planted(); await gate; return { code: 0 } })
      await plantedP
      finishB()
      const b = await bTurn
      t.eq('the other turn finds it first and moves it', b.integrity.violations[0]?.status, 'quarantined')
      release()
      const ra = await a
      t.ok('the creating turn, now seeing nothing, still fails on the inherited violation', ra.integrity.violations.length === 1 && ra.integrity.violations[0].inherited === true && ra.integrity.violations[0].foundBy === 'B1', JSON.stringify(ra.integrity.violations))
      t.eq('…and its durable verdict says so', (await guard.recoverPending({ ledgerFile: la, invocationId: 'A1' }))?.integrity.violations[0].inherited, true)

      // Publication arrives while the creator is finalizing.
      let releaseB
      const gateB = new Promise((r) => { releaseB = r })
      const b2 = guard.runGuarded({ config, label: 'b', ledgerFile: lb, invocationId: 'B2' }, async () => { await gateB; return { code: 0 } })
      let b2done
      guard.hooks.beforeFinalize = async ({ invocationId }) => { if (invocationId === 'A2') { await fs.writeFile(hooksJson, 'late'); releaseB(); b2done = await b2 } }
      const a2 = await guard.runGuarded({ config, label: 'a', ledgerFile: la, invocationId: 'A2' }, async () => ({ code: 0 }))
      resetHooks()
      t.eq('the overlapping turn found and moved it', b2done.integrity.violations[0]?.status, 'quarantined')
      t.ok('a publication during finalization is in the live verdict', a2.integrity.violations.some((v) => v.inherited && v.foundBy === 'B2'))
      t.ok('…and in the durable verdict', (await guard.recoverPending({ ledgerFile: la, invocationId: 'A2' }))?.integrity.violations.some((v) => v.inherited))

      // The same, with the panel dying before the creator's verdict is written.
      let releaseB3
      const gateB3 = new Promise((r) => { releaseB3 = r })
      const b3 = guard.runGuarded({ config, label: 'b', ledgerFile: lb, invocationId: 'B3' }, async () => { await gateB3; return { code: 0 } })
      guard.hooks.beforeFinalize = async ({ invocationId }) => { if (invocationId === 'A3') { await fs.writeFile(hooksJson, 'late again'); releaseB3(); await b3 } }
      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId === 'A3') throw new Error('panel died') }
      await guard.runGuarded({ config, label: 'a', ledgerFile: la, invocationId: 'A3' }, async () => ({ code: 0 })).catch(() => {})
      resetHooks()
      const replayed = await guard.recoverPending({ ledgerFile: la, invocationId: 'A3' })
      t.ok('recovery of the creator replays the inherited violation from its ledger', replayed?.integrity.violations.some((v) => v.inherited && v.foundBy === 'B3'), JSON.stringify(replayed))
    }

    t.section('14. recovery is per invocation and never touches a live turn (consult-recovery)')
    {
      let release, launched
      const gate = new Promise((r) => { release = r })
      const launchedP = new Promise((r) => { launched = r })
      const liveTurn = guard.runGuarded({ config, label: 'live', ledgerFile: ledger, invocationId: 'LIVE' }, async () => { launched(); await gate; return { code: 0 } })
      await launchedP
      t.eq('a live invocation is reported active, not checked', (await guard.recoverPending({ ledgerFile: ledger, invocationId: 'LIVE' }))?.active, true)
      t.ok('a ledger-wide recovery leaves it out', !(await guard.recoverPending({ ledgerFile: ledger })).some((r) => r.invocationId === 'LIVE'))
      release()
      await liveTurn
    }

    t.section('15. fail-closed edges (audit 073)')
    {
      // required-bind-fallback: a symlinked home the fence would bind writable is refused, not skipped.
      const real = await mk('codex-real-home')
      const linkedHome = path.join(root, 'codex-linked-home')
      await fs.symlink(real, linkedHome)
      const refusal = await codex.configGuardFor({ CODEX_HOME: linkedHome }).prepare().then(() => null, (e) => e)
      t.ok('a symlinked CLI home refuses the guarded turn', /codex-linked-home is a symlink/.test(refusal?.message ?? ''), refusal?.message)
      const fenced = await applyFence({ spec, manifest: await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: linkedHome } }), guard: codex.configGuardFor({ CODEX_HOME: linkedHome }), platform: LINUX, prove: provedStub() })
      t.eq('…before launch, through applyFence', [fenced.applied, fenced.refused], [false, true])
      t.eq('and nothing was created in its target', await listing(real), '')

      // unreadable-configuration: an unreadable baseline refuses; an unreadable change is still moved.
      const uhome = await mk('codex-unreadable')
      const ucfg = await codex.configGuardFor({ CODEX_HOME: uhome }).prepare()
      const uhooks = path.join(uhome, 'hooks.json')
      await fs.writeFile(uhooks, '{}')
      await fs.chmod(uhooks, 0o000)
      let launched = false
      const unreadable = await guard.runGuarded({ config: ucfg, label: 'u', ledgerFile: ledger, invocationId: 'inv-unreadable-base' }, async () => { launched = true; return { code: 0 } }).then(() => null, (e) => e)
      t.ok('an unreadable checked file at baseline refuses the turn before launch', unreadable?.started === false && !launched && /cannot be verified/.test(unreadable.message), unreadable?.message)
      await fs.chmod(uhooks, 0o600)
      await fs.rm(uhooks)
      const appeared = await guard.runGuarded({ config: ucfg, label: 'u', ledgerFile: ledger, invocationId: 'inv-unreadable-new' }, async () => { await fs.writeFile(uhooks, 'secret'); await fs.chmod(uhooks, 0o000); return { code: 0 } })
      const uv = appeared.integrity.violations[0]
      t.ok('a checked file that appears unreadable is still moved aside by rename and fails the turn', uv?.change === 'unverifiable' && uv.status === 'quarantined' && !await exists(uhooks), JSON.stringify(uv))
      await fs.chmod(uv.quarantinedTo, 0o600).catch(() => {})

      // postcheck-reported-not-started: the adapters record not-started only for a refusal before launch.
      for (const name of ['codex', 'gemini']) {
        const src = await fs.readFile(path.resolve(import.meta.dirname, `../../harness/${name}.mjs`), 'utf8')
        t.ok(`${name}: a guard error is recorded as not-started only when nothing started`, /if \(error\.started === false\) await record\(ledgerDir, \{ invocationId, marker, phase: 'not-started', error: error\.message/.test(src))
      }

      // interrupted-integrity: the latest intent per path wins.
      guard.hooks.stamp = () => 'LIVE'
      guard.hooks.beforeMove = async () => { throw new Error('panel died before the move') }
      await guard.runGuarded({ config, label: 'run-12', ledgerFile: ledger, invocationId: 'inv-latest' }, async () => { await fs.writeFile(hooksJson, 'evil'); return { code: 0 } })
      guard.hooks.beforeMove = null
      guard.hooks.stamp = () => 'RECOVERY'
      const torn = watchSyncs({ fail: (p) => p.includes('-RECOVERY') })
      let first
      try { first = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-latest' }) } finally { torn.restore() }
      resetHooks()
      t.eq('a recovery whose fresh move cannot be synced stays unsynced', first.integrity.violations[0].status, 'quarantine-unsynced')
      const second = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-latest' })
      t.ok('the next recovery follows the latest intent and reports the move, not a failure', second.integrity.violations[0].status === 'quarantined' && second.integrity.violations[0].quarantinedTo.includes('-RECOVERY'), JSON.stringify(second.integrity.violations))

      // interrupted-integrity: after an earlier matching move, a newer change at the original path is caught too.
      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId === 'inv-newer') throw new Error('panel died before the verdict') }
      await guard.runGuarded({ config, label: 'run-13', ledgerFile: ledger, invocationId: 'inv-newer' }, async () => { await fs.writeFile(hooksJson, 'first'); return { code: 0 } })
      resetHooks()
      await fs.writeFile(hooksJson, 'newer')
      const newer = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-newer' })
      t.ok('both the earlier move and the newer file are reported, and the newer one is moved', newer.integrity.violations.filter((v) => v.status === 'quarantined').length === 2 && !await exists(hooksJson), JSON.stringify(newer.integrity.violations.map((v) => [v.change, v.status])))

      // planned-integration-coverage: T27(c), a failed sync during recovery itself.
      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId === 'inv-rsync') throw new Error('crash past the move') }
      await guard.runGuarded({ config, label: 'run-14', ledgerFile: ledger, invocationId: 'inv-rsync' }, async () => { await fs.writeFile(hooksJson, 'x'); return { code: 0 } })
      resetHooks()
      const failing = watchSyncs({ fail: (p) => p.includes('.devpanel-quarantine-run-14-') })
      let r1
      try { r1 = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-rsync' }) } finally { failing.restore() }
      t.eq('a recovery whose retried sync fails records quarantine-unsynced, no verdict', [r1.integrity.violations[0].status, (await ledgerLines(ledger)).some((e) => e.invocationId === 'inv-rsync' && e.phase === 'config-checked')], ['quarantine-unsynced', false])
      t.eq('and cannot be acknowledged', await guard.resolveConfig({ ledgerFile: ledger, invocationId: 'inv-rsync' }), false)
      const retry = watchSyncs()
      let r2
      try { r2 = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-rsync' }) } finally { retry.restore() }
      const rc = path.dirname(r2.integrity.violations[0].quarantinedTo)
      t.ok('the next recovery syncs the claim, then the source directory, then records it', r2.integrity.violations[0].status === 'quarantined' && retry.log.indexOf(rc) >= 0 && retry.log.indexOf(codexHome, retry.log.indexOf(rc) + 1) > retry.log.indexOf(rc))

      // concurrent-turn-attribution: a recovery's move is published to a live turn on the same home first.
      const lx = path.join(root, 'ledger-x', 'codex-ledger.jsonl')
      await fs.mkdir(path.dirname(lx), { recursive: true })
      await fs.writeFile(lx, JSON.stringify({ invocationId: 'X', phase: 'guarded', home: codexHome, label: 'x', watch: config.watch, before: await guard.snapshotConfig(config.watch) }) + '\n')
      let releaseLive
      const liveGate = new Promise((r) => { releaseLive = r })
      let plantedLive
      const plantedP = new Promise((r) => { plantedLive = r })
      const la = path.join(root, 'ledger-live', 'codex-ledger.jsonl')
      const liveTurn = guard.runGuarded({ config, label: 'live', ledgerFile: la, invocationId: 'LIVE-CREATOR' }, async () => { await fs.writeFile(hooksJson, 'by the live seat'); plantedLive(); await liveGate; return { code: 0 } })
      await plantedP
      const rx = await guard.recoverPending({ ledgerFile: lx, invocationId: 'X' })
      t.eq('the interrupted invocation\'s recovery moves the file', rx.integrity.violations[0]?.status, 'quarantined')
      releaseLive()
      const rl = await liveTurn
      t.ok('the creating live turn still fails, on the violation published by recovery', rl.integrity.violations.some((v) => v.inherited && v.foundBy === 'X'), JSON.stringify(rl.integrity.violations))

      // torn-guard-ledger: a torn tail never swallows the next baseline.
      const lt = path.join(root, 'ledger-torn', 'codex-ledger.jsonl')
      await fs.mkdir(path.dirname(lt), { recursive: true })
      await fs.writeFile(lt, '{"invocationId":"old","phase":"start')
      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId === 'inv-torn') throw new Error('crash') }
      await guard.runGuarded({ config, label: 'torn', ledgerFile: lt, invocationId: 'inv-torn' }, async () => { await fs.writeFile(hooksJson, 'x'); return { code: 0 } })
      resetHooks()
      const rt = await guard.recoverPending({ ledgerFile: lt, invocationId: 'inv-torn' })
      t.ok('the baseline written after a torn tail is found by recovery', rt?.integrity?.violations?.[0]?.change === 'created', JSON.stringify(rt))
      t.ok('the torn fragment stays on its own line', (await fs.readFile(lt, 'utf8')).startsWith('{"invocationId":"old","phase":"start\n'))
    }

    t.section('16. audit 076')
    {
      // torn-guard-ledger: the adapters' own reconciliation survives a closed torn line; a torn final line stays uncertain.
      for (const [name, adapter] of [['codex', codex], ['gemini', gemini]]) {
        const dir = path.join(root, `reconcile-${name}`)
        await fs.mkdir(dir, { recursive: true })
        const file = path.join(dir, `${name}-ledger.jsonl`)
        await fs.writeFile(file, ['{"invocationId":"old","phase":"star', JSON.stringify({ invocationId: 'R1', phase: 'started' }), JSON.stringify({ invocationId: 'R1', phase: 'completed', sessionId: 's1', response: 'ok' })].join('\n') + '\n')
        t.eq(`${name}: a torn line followed by valid records does not hide a completed invocation`, (await adapter.reconcile('R1', { ledgerDir: dir })).phase, 'completed')
        await fs.appendFile(file, '{"invocationId":"R2","pha')
        t.eq(`${name}: a torn final line keeps today's uncertain outcome`, (await adapter.reconcile('R1', { ledgerDir: dir })).phase, 'uncertain')
      }
      // claude-ledger-behavior: Claude has no guard and reads its ledger strictly, exactly as before.
      {
        const dir = path.join(root, 'reconcile-claude')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'claude-ledger.jsonl'), ['{"invocationId":"old","phase":"star', JSON.stringify({ invocationId: 'R1', phase: 'started' }), JSON.stringify({ invocationId: 'R1', phase: 'completed', sessionId: 's1', response: 'ok' })].join('\n') + '\n')
        t.eq('claude: any malformed line leaves the ledger unreadable, as before (no tolerant reading)', await claude.reconcile('R1', { ledgerDir: dir }), { phase: 'uncertain', reason: 'no adapter ledger available' })
        await fs.writeFile(path.join(dir, 'claude-ledger.jsonl'), [JSON.stringify({ invocationId: 'R1', phase: 'started' }), JSON.stringify({ invocationId: 'R1', phase: 'guarded' })].join('\n') + '\n')
        t.eq('claude: guard phase names are not filtered either (its last line decides, as before)', (await claude.reconcile('R1', { ledgerDir: dir })).reason, 'invocation recorded as guarded')
      }

      // concurrent-turn-attribution: what recovery moves is decided by the read it publishes; a file a live
      // turn creates after that read is not moved by recovery, so its creator still fails on its own check.
      const lx = path.join(root, 'ledger-x2', 'codex-ledger.jsonl')
      guard.hooks.beforeCheckedWrite = async ({ invocationId }) => { if (invocationId === 'X2') throw new Error('crash past the move') }
      await guard.runGuarded({ config, label: 'x2', ledgerFile: lx, invocationId: 'X2' }, async () => { await fs.writeFile(hooksJson, 'by X2'); return { code: 0 } })
      resetHooks()
      const la = path.join(root, 'ledger-live2', 'codex-ledger.jsonl')
      let releaseLive
      const gate = new Promise((r) => { releaseLive = r })
      let started
      const startedP = new Promise((r) => { started = r })
      const live = guard.runGuarded({ config, label: 'live2', ledgerFile: la, invocationId: 'LIVE2' }, async () => { started(); await gate; return { code: 0 } })
      await startedP
      guard.hooks.afterPublish = async ({ invocationId }) => { if (invocationId === 'X2') await fs.writeFile(hooksJson, 'by the live seat, after recovery read') }
      const rx = await guard.recoverPending({ ledgerFile: lx, invocationId: 'X2' })
      resetHooks()
      t.ok('recovery replays its own move only', rx.integrity.violations.length === 1 && rx.integrity.violations[0].status === 'quarantined', JSON.stringify(rx.integrity.violations.map((v) => [v.change, v.status])))
      t.eq('the live seat\'s file, created after recovery\'s read, was not moved by recovery', await fs.readFile(hooksJson, 'utf8'), 'by the live seat, after recovery read')
      releaseLive()
      const rl = await live
      t.ok('so the creating turn fails on its own check', rl.integrity.violations.some((v) => !v.inherited && v.change === 'created' && v.status === 'quarantined'), JSON.stringify(rl.integrity.violations))

      // interrupted-integrity: an older unsynced move stays replayable when a newer intent exists for the path.
      guard.hooks.stamp = () => 'OLDER'
      const live1 = watchSyncs({ fail: (p) => p.includes('-OLDER') })
      let first
      try { first = await guard.runGuarded({ config, label: 'run-15', ledgerFile: ledger, invocationId: 'inv-older' }, async () => { await fs.writeFile(hooksJson, 'first'); return { code: 0 } }) } finally { live1.restore() }
      t.eq('the live move is unsynced', first.integrity.violations[0].status, 'quarantine-unsynced')
      const olderClaim = path.dirname(first.integrity.violations[0].quarantinedTo)
      await fs.writeFile(hooksJson, 'newer')
      guard.hooks.stamp = () => 'NEWER'
      const rec1 = watchSyncs({ fail: (p) => p.includes('-OLDER') })
      let r1
      try { r1 = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-older' }) } finally { rec1.restore() }
      resetHooks()
      t.ok('recovery moves the newer file but keeps the older move unsynced, with no verdict', r1.integrity.violations.some((v) => v.status === 'quarantine-unsynced') && r1.integrity.violations.some((v) => v.status === 'quarantined' && v.quarantinedTo.includes('-NEWER')) && !(await ledgerLines(ledger)).some((e) => e.invocationId === 'inv-older' && e.phase === 'config-checked'), JSON.stringify(r1.integrity.violations.map((v) => [v.status, v.quarantinedTo])))
      const rec2 = watchSyncs()
      let r2
      try { r2 = await guard.recoverPending({ ledgerFile: ledger, invocationId: 'inv-older' }) } finally { rec2.restore() }
      t.ok('the next recovery retries the older claim\'s sync too before recording both', rec2.log.includes(olderClaim) && r2.integrity.violations.filter((v) => v.status === 'quarantined').length === 2, JSON.stringify({ log: rec2.log, v: r2.integrity.violations.map((v) => v.status) }))

      // unfenced-chat-replay: a real Codex turn whose requested fence is not proved and runs on the
      // DEVPANEL_FENCE_UNPROVED=run fallback never calls afterFence (where chat replays the guard).
      const shim = path.join(root, 'codex-cli')
      await fs.writeFile(shim, ['#!/bin/sh', "export AGENT_MODE='ok'", "export AGENT_SHAPE='codex'", `exec "${process.execPath}" "${path.resolve(import.meta.dirname, 'fakes/cli/agent.mjs')}" "$@"`].join('\n') + '\n')
      await fs.chmod(shim, 0o755)
      const saved = { bin: process.env.DEVPANEL_CODEX_BIN, unproved: process.env.DEVPANEL_FENCE_UNPROVED, home: process.env.CODEX_HOME }
      process.env.DEVPANEL_CODEX_BIN = shim
      process.env.DEVPANEL_FENCE_UNPROVED = 'run'
      process.env.CODEX_HOME = await mk('codex-fallback-home')
      // The proof fails deterministically: the sandbox binary it launches exits 1.
      saved.bwrap = process.env.DEVPANEL_BWRAP_BIN
      process.env.DEVPANEL_BWRAP_BIN = '/bin/false'
      let afterFenceCalls = 0
      let outcome
      try {
        outcome = await codex.invoke({ model: 'm', cwd: work, prompt: 'hi', ledgerDir: path.join(root, 'ledger-fallback'), fence: { ...spec, panelRoot: null }, afterFence: async () => { afterFenceCalls++ } }).then((r) => r, (e) => e)
      } finally {
        for (const [k, env] of [['bin', 'DEVPANEL_CODEX_BIN'], ['unproved', 'DEVPANEL_FENCE_UNPROVED'], ['home', 'CODEX_HOME'], ['bwrap', 'DEVPANEL_BWRAP_BIN']]) { if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k] }
      }
      // The fallback launches the runtime (the adapter's existing fallback then fails at the runtime,
      // codex exited 1, because it removed its last-message directory on the failed proof).
      t.ok('an unproved fence on the DEVPANEL_FENCE_UNPROVED=run fallback launches without ever calling afterFence', afterFenceCalls === 0 && (outcome?.diagnostics?.fence?.namespace === 0 || /codex exited/.test(outcome?.message ?? '')), outcome?.message ?? JSON.stringify(outcome?.diagnostics?.fence))
    }

    t.section('17. audits 079/082: chat\'s replay runs after the first proof and before preparation; the launch binds are built and proved after it')
    {
      const bound = (fenced, p) => { const args = fenced.wrap('/bin/true', []).args; return args.some((a, i) => a === '--ro-bind' && args[i + 1] === p && args[i + 2] === p) }
      const home = await mk('codex-replay')
      const manifest = await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: home } })
      await codex.configGuardFor({ CODEX_HOME: home }).prepare()
      const fenceWith = (replay, prove) => applyFence({ spec, manifest, guard: codex.configGuardFor({ CODEX_HOME: home }), replay, platform: LINUX, prove })
      let moves = 0
      const moveAgents = async () => fs.rename(path.join(home, 'AGENTS.md'), path.join(home, `AGENTS.md.devpanel-quarantine-x${++moves}`))

      // A replay that moves a prepared entry: the final build sees the home after it.
      const order = []
      const proofs = []
      const fenced = await fenceWith(async () => { order.push(`replay after ${proofs.length} proof(s)`); await moveAgents() }, async (a) => { proofs.push(a); return { proved: true, reason: null, checked: {} } })
      t.eq('the replay runs after the first proof and before the final one', [fenced.applied, order, proofs.length], [true, ['replay after 1 proof(s)'], 2])
      t.ok('the entry it moved is prepared again, empty, and bound read-only in the launch arguments', (await fs.stat(path.join(home, 'AGENTS.md'))).size === 0 && bound(fenced, path.join(home, 'AGENTS.md')))

      // chat-replay-invalidates-fence: a replay that throws after a move is treated as possibly moved.
      const afterThrow = await fenceWith(async () => { await moveAgents(); throw new Error('config-checked could not be persisted') }, provedStub())
      t.ok('a replay that throws after moving still gets the rebuilt, re-proved fence (nothing stale)', afterThrow.applied && (await fs.stat(path.join(home, 'AGENTS.md'))).size === 0 && bound(afterThrow, path.join(home, 'AGENTS.md')), afterThrow.reason)
      let n = 0
      const failsAfter = await fenceWith(async () => { await moveAgents(); throw new Error('boom') }, async () => (++n === 1 ? { proved: true, reason: null, checked: {} } : { proved: false, reason: 'canary readable', checked: {} }))
      const savedUnproved = process.env.DEVPANEL_FENCE_UNPROVED
      process.env.DEVPANEL_FENCE_UNPROVED = 'run'
      try {
        const msg = (() => { try { assertFenced(failsAfter, { turn: 't', platform: LINUX }) } catch (e) { return e.message } return '' })()
        t.ok('…and when that proof fails the turn is refused, even where the unproved fallback is allowed', failsAfter.refused === true && msg.length > 0, msg)
      } finally { if (savedUnproved === undefined) delete process.env.DEVPANEL_FENCE_UNPROVED; else process.env.DEVPANEL_FENCE_UNPROVED = savedUnproved }
      const absentHome = path.join(root, 'codex-replay-absent')
      const absent = await applyFence({ spec, manifest: await codex.fenceManifest({ binary: process.execPath, env: { CODEX_HOME: absentHome } }), guard: codex.configGuardFor({ CODEX_HOME: absentHome }), replay: async () => { throw new Error('boom') }, platform: LINUX, prove: provedStub() })
      t.eq('a replay that throws where no rebuild follows (absent home) refuses the turn', [absent.applied, absent.refused], [false, true])
      let calledUnproved = 0
      const unproved = await fenceWith(async () => { calledUnproved++ }, async () => ({ proved: false, reason: 'no namespace', checked: {} }))
      t.eq('the replay never runs when the first proof fails', [unproved.applied, calledUnproved], [false, 0])

      // chat-replay-blocked-by-prepare: an interrupted fork left a directory at a checked path.
      for (const [name, adapter, envOf, checked] of [['codex', codex, (h) => ({ CODEX_HOME: h }), (h) => path.join(h, 'hooks.json')], ['gemini', gemini, (h) => ({ GEMINI_CLI_HOME: h }), (h) => path.join(h, '.gemini', 'settings.json')]]) {
        const h = await mk(`${name}-wrong-type`)
        const g = adapter.configGuardFor(envOf(h))
        const cfg = await g.prepare()
        const lf = path.join(root, `ledger-wrong-${name}`, `${name}-ledger.jsonl`)
        await fs.mkdir(path.dirname(lf), { recursive: true })
        await fs.writeFile(lf, JSON.stringify({ invocationId: `ASK-${name}`, phase: 'guarded', home: cfg.home, label: 'ask', watch: cfg.watch, before: await guard.snapshotConfig(cfg.watch) }) + '\n')
        await fs.mkdir(checked(h))
        await fs.writeFile(path.join(checked(h), 'planted'), 'x')
        const m = await adapter.fenceManifest({ binary: process.execPath, env: envOf(h) })
        const blocked = await applyFence({ spec, manifest: m, guard: adapter.configGuardFor(envOf(h)), platform: LINUX, prove: provedStub() })
        t.eq(`${name}: without the replay, preparation refuses the wrong-type entry`, [blocked.applied, blocked.refused], [false, true])
        const replay = async () => { await guard.recoverPending({ ledgerFile: lf, invocationId: `ASK-${name}` }) }
        const healed = await applyFence({ spec, manifest: m, guard: adapter.configGuardFor(envOf(h)), replay, platform: LINUX, prove: provedStub() })
        const moved = (await fs.readdir(path.dirname(checked(h)))).find((f) => f.startsWith(`${path.basename(checked(h))}.devpanel-quarantine-`))
        t.ok(`${name}: the replay before preparation quarantines it (nothing deleted) and the ask is fenced`, healed.applied && !await exists(checked(h)) && Boolean(moved), healed.reason)
        const claimed = moved ? await fs.readdir(path.join(path.dirname(checked(h)), moved)) : []
        t.ok(`${name}: the quarantined directory keeps its content`, claimed.length === 1 && await exists(path.join(path.dirname(checked(h)), moved, claimed[0], 'planted')))
        const next = await applyFence({ spec, manifest: m, guard: adapter.configGuardFor(envOf(h)), replay, platform: LINUX, prove: provedStub() })
        t.eq(`${name}: the next ask succeeds too`, next.applied, true, next.reason)
      }

      for (const name of ['codex', 'gemini']) {
        const src = await fs.readFile(path.resolve(import.meta.dirname, `../../harness/${name}.mjs`), 'utf8')
        t.ok(`${name}: afterFence is handed to applyFence as its replay and called nowhere else`, /replay: afterFence/.test(src) && !/afterFence\(\)/.test(src))
      }
    }
  } finally {
    resetHooks()
    await fs.chmod(path.join(root, 'locked-ledger'), 0o700).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
}
