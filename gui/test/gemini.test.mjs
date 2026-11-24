import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as gemini from '../../harness/gemini.mjs'
import { buildPolicy, POLICY_CANARY_TOOL, acknowledgementPattern } from '../../harness/gemini.mjs'
import { classifyFailure } from '../server/runtime/failure.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { runFenceCheck, fencePassed, describeFence } from '../live/fence-check.mjs'

export const name = 'gemini adapter — sessions, the permission fence, and what it refuses'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const NL = String.fromCharCode(10)

const temps = []
async function temp () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-'))
  temps.push(dir)
  return dir
}

/**
 * Point the real adapter at a controlled subprocess. The adapter code under test
 * is exactly the code that will drive the installed CLI; only the binary differs.
 */
async function underTest ({ mode = 'ok', record = null, sessionId = null, recall = null } = {}) {
  const shim = path.join(await temp(), 'cli')
  await fs.writeFile(shim, [
    '#!/bin/sh',
    `export AGENT_MODE='${mode}'`,
    "export AGENT_SHAPE='gemini'",
    // The shell can see TMPDIR; carry it across the exec so the recorder can
    // report what the runtime would actually use as its temporary directory.
    'export AGENT_TMPDIR="$TMPDIR"',
    record ? `export AGENT_RECORD='${record}'` : '',
    sessionId ? `export AGENT_SESSION_ID='${sessionId}'` : '',
    recall ? `export AGENT_RECALL='${recall}'` : '',
    `exec "${process.execPath}" "${AGENT}" "$@"`
  ].join(NL) + NL)
  await fs.chmod(shim, 0o755)
  process.env.DEVPANEL_GEMINI_BIN = shim
  return shim
}

const readRecord = async (file) =>
  (await fs.readFile(file, 'utf8')).split(NL).filter(Boolean).map((l) => JSON.parse(l))

/**
 * A tool call's arguments as the policy engine serialises them before matching
 * `argsPattern` (policy/stable-stringify.ts, v0.60.0): keys sorted, each
 * top-level pair wrapped in NUL characters, values JSON-encoded.
 */
const stableArgs = (args) =>
  '{' + Object.keys(args).sort().map((k) => `\0${JSON.stringify(k)}:${JSON.stringify(args[k])}\0`).join(',') + '}'

/**
 * Resolve one tool call against a generated policy the way the runtime does:
 * every matching rule is considered and the highest priority wins. Asserting
 * DECISIONS rather than the presence of lines is the point — a rule that is
 * present but outranked protects nothing.
 */
function decide (policyText, tool, { mcp = false, args = null } = {}) {
  const rules = []
  for (const block of policyText.split('[[rule]]').slice(1)) {
    const rule = { priority: 0 }
    for (const line of block.split(NL)) {
      const m = /^(toolName|mcpName|decision|priority|argsPattern)\s*=\s*(.+)$/.exec(line.trim())
      if (!m) continue
      const [, key, raw] = m
      rule[key] = key === 'priority' ? Number(raw) : JSON.parse(raw.replace(/,\s*\]$/, ']'))
    }
    rules.push(rule)
  }
  const matches = rules.filter((rule) => {
    const named = rule.toolName === '*' || (Array.isArray(rule.toolName) ? rule.toolName.includes(tool) : rule.toolName === tool)
    if (!named) return false
    if (rule.mcpName !== undefined) return mcp
    if (rule.argsPattern !== undefined) return args !== null && new RegExp(rule.argsPattern).test(stableArgs(args))
    return true
  })
  if (!matches.length) return 'unmatched'
  return matches.sort((a, b) => b.priority - a.priority)[0].decision
}

/** A gemini settings file under a home, the way the runtime lays it out. */
async function settingsHome (settings) {
  const home = await temp()
  await fs.mkdir(path.join(home, '.gemini'), { recursive: true })
  await fs.writeFile(path.join(home, '.gemini/settings.json'), JSON.stringify(settings), 'utf8')
  return home
}

export default async function (t) {
  const saved = Object.fromEntries(['DEVPANEL_GEMINI_BIN', 'DEVPANEL_GEMINI_SYSTEM_CONFIG_DIR', 'DEVPANEL_GEMINI_PROFILE_ROOT', 'GEMINI_CLI_HOME', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH', 'DEVPANEL_TEST_GEMINI_KEY']
    .map((key) => [key, process.env[key]]))
  // A host of our own: no system policies, no system settings, unless a section
  // stages them. The real /etc/gemini-cli is not this suite's business.
  process.env.DEVPANEL_GEMINI_SYSTEM_CONFIG_DIR = await temp()
  process.env.DEVPANEL_GEMINI_PROFILE_ROOT = await temp()
  delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
  delete process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH

  // ============================================================ 1. sessions
  t.section('0. the policy directory is read-only to the seat (the admin policy and the pinned settings copy)')
  {
    const manifest = await gemini.turnFenceManifest({ binary: process.execPath, env: {}, policyDir: '/tmp/devpanel-gemini-x', runtimeTemp: '/tmp/devpanel-gemini-tmp-x' })
    t.eq('policyDir is bound read-only and is not in the writable set', [manifest.readOnly.includes('/tmp/devpanel-gemini-x'), manifest.writable.includes('/tmp/devpanel-gemini-x')], [true, false])
    t.eq('only the runtime\'s private TMPDIR stays writable', manifest.writable, ['/tmp/devpanel-gemini-tmp-x'])
    t.eq('without a TMPDIR nothing of the adapter\'s is writable', (await gemini.turnFenceManifest({ binary: process.execPath, env: {}, policyDir: '/tmp/p' })).writable, [])
  }

  t.section('1. the session is pre-assigned, and resumed by its full id')
  {
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()

    const first = await gemini.invoke({ prompt: 'first turn', model: 'gemini-3-pro', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:g:1', meta: { invocationId: 'inv-1' } })
    const calls = await readRecord(record)
    t.ok('the id was chosen BEFORE the turn', Boolean(calls[0].received.preassigned), String(calls[0].received.preassigned))
    t.eq('and is the one that comes back', calls[0].received.preassigned, first.session.id)

    const second = await gemini.invoke({ session: first.session, prompt: 'second turn', model: 'gemini-3-pro', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:g:2', meta: { invocationId: 'inv-2' } })
    const after = await readRecord(record)
    t.eq('the second turn resumed that exact id', after[1].received.resumed, first.session.id)
    t.eq('no second session was assigned', after[1].received.preassigned, null)
    t.eq('and the session persists', second.session.id, first.session.id)

    // The runtime also accepts "latest" and an index. Neither is evidence that a
    // session belongs to THIS invocation, so neither may ever be sent.
    const resumeArgs = after[1].received.argv.filter((a, i) => after[1].received.argv[i - 1] === '--resume')
    t.eq('resume never names "latest" or an index', resumeArgs, [first.session.id])
  }

  t.section('1b. a turn that reports a different session fails rather than continuing')
  {
    // Continuity is the whole point of a session: silently answering from a
    // fresh one loses everything the run established and looks like success.
    await underTest({ sessionId: '99999999-9999-4999-8999-999999999999' })
    let thrown = null
    try {
      await gemini.invoke({ prompt: 'hello', model: 'gemini-3-pro', cwd: await temp(), meta: { invocationId: 'inv-mismatch' } })
    } catch (error) { thrown = error }
    t.ok('it is a runtime failure', thrown?.kind === 'runtime-error', thrown?.message)
    t.ok('naming both ids', /99999999-9999-4999-8999-999999999999/.test(thrown?.message ?? ''), thrown?.message)
  }

  t.section('1c. resuming really does carry the earlier turn')
  {
    const cwd = await temp()
    await underTest({ recall: 'ALPHA' })
    const first = await gemini.invoke({ prompt: 'remember ALPHA', model: 'gemini-3-pro', cwd, meta: { invocationId: 'inv-r1' } })
    const resumed = await gemini.invoke({ session: first.session, prompt: 'what was it?', model: 'gemini-3-pro', cwd, meta: { invocationId: 'inv-r2' } })
    t.eq('the resumed turn answers from the session', resumed.response, 'ALPHA')
  }

  // ============================================================ 2. the fence
  t.section('2. an auditor cannot write, run commands, or leave the mode it is in')
  {
    const policy = buildPolicy({ writesCode: false })
    for (const tool of ['write_file', 'replace', 'run_shell_command', 'list_background_processes', 'read_background_output']) {
      t.eq(`${tool} is denied`, decide(policy, tool), 'deny')
    }
    for (const tool of ['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory']) {
      t.eq(`${tool} is allowed`, decide(policy, tool), 'allow')
    }

    // Plan mode auto-approves its OWN exit in headless runs (plan.toml v0.60.0:
    // exit_plan_mode, decision allow, interactive = false), so a role that could
    // enter it could also leave it and take its write tools back with it.
    for (const tool of ['enter_plan_mode', 'exit_plan_mode']) {
      t.eq(`${tool} is denied, so the mode cannot be changed from inside`, decide(policy, tool), 'deny')
    }
    for (const tool of ['invoke_agent', 'activate_skill', 'take_snapshot', 'ask_user']) {
      t.eq(`${tool} is denied`, decide(policy, tool), 'deny')
    }
    t.eq('an MCP tool is denied', decide(policy, 'anything', { mcp: true }), 'deny')
    t.eq('and so is a tool that does not exist yet', decide(policy, 'some_future_tool'), 'deny')
    t.eq('the acknowledgement rule names no tool the runtime has, and denies it anyway', decide(policy, POLICY_CANARY_TOOL), 'deny')
  }

  t.section('2b. the write denial outranks the allow-list, not merely follows it')
  {
    // A rule that is present but outranked protects nothing. This is the
    // assertion that keeps a later edit to the allow-list from quietly handing a
    // non-writing role the ability to change the candidate.
    const policy = buildPolicy({ writesCode: false })
    const priorities = Object.fromEntries(policy.split('[[rule]]').slice(1).map((block) => [
      /decision = "(\w+)"/.exec(block)?.[1] + ':' + (/toolName = (.+)/.exec(block)?.[1] ?? ''),
      Number(/priority = (\d+)/.exec(block)?.[1])
    ]))
    const denyWrites = Object.entries(priorities).find(([k]) => k.startsWith('deny:') && k.includes('write_file'))
    const allow = Object.entries(priorities).find(([k]) => k.startsWith('allow:'))
    t.ok('the write denial has the higher priority', denyWrites[1] > allow[1], `${denyWrites[1]} > ${allow[1]}`)
  }

  t.section('2c. the author may write and run commands; the supervisor may do nothing')
  {
    const author = buildPolicy({ writesCode: true })
    for (const tool of ['write_file', 'replace', 'run_shell_command']) {
      t.eq(`${tool} is allowed for the writer`, decide(author, tool), 'allow')
    }
    t.eq('but mode transitions still are not', decide(author, 'exit_plan_mode'), 'deny')
    t.eq('and neither are subagents', decide(author, 'invoke_agent'), 'deny')

    const supervisor = buildPolicy({ supervisorOnly: true })
    for (const tool of ['read_file', 'glob', 'write_file', 'run_shell_command', 'web_fetch', 'invoke_agent']) {
      t.eq(`the supervisor cannot use ${tool}`, decide(supervisor, tool), 'deny')
    }
    t.ok('it is given no allow rule at all', !supervisor.includes('decision = "allow"'))

    t.eq('the network tools follow the infrastructure flag', [
      decide(buildPolicy({ writesCode: true, networkAccess: false }), 'web_fetch'),
      decide(buildPolicy({ writesCode: true, networkAccess: true }), 'web_fetch')
    ], ['deny', 'allow'])
  }

  t.section('2d. the fence reaches the runtime as an ADMIN policy, and the runtime says so')
  {
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()
    const scratch = await temp()
    const turn = await gemini.invoke({
      prompt: 'audit this', model: 'gemini-3-pro', cwd, scratchDir: scratch,
      tooling: { writesCode: false, allowLiveCheckout: false, liveCheckout: '/projects/some-project', allowedRoots: [scratch] },
      meta: { invocationId: 'inv-fence' }
    })
    const received = (await readRecord(record))[0].received

    // Admin rules resolve at 5.x; --policy would land in the user tier at 4.x,
    // under YOLO's own allow-all. The tier is the enforcement.
    t.ok('it is passed with --admin-policy', received.argv.includes('--admin-policy'))
    t.eq('never as a user policy', received.userPolicy, null)
    t.ok('the runtime actually read the rules', /\[\[rule\]\]/.test(received.adminPolicy ?? ''))
    t.eq('the policy it read denies writing', decide(received.adminPolicy, 'write_file'), 'deny')
    t.eq('and denies leaving the mode', decide(received.adminPolicy, 'exit_plan_mode'), 'deny')
    t.eq('approval mode is not the fence, so it does not stall the turn', received.approvalMode, 'yolo')
    t.ok('an unseen worktree is trusted explicitly, or headless refuses to start', received.argv.includes('--skip-trust'))

    // Reading the file back proves the adapter can read what it wrote, nothing
    // more. The runtime's acknowledgement — its warning about the rule that
    // names no tool, labelled with the tier it loaded the file at — is what
    // proves the file was loaded, and the turn records that it was seen.
    t.ok('the policy carries the acknowledgement rule', new RegExp(`toolName = "${POLICY_CANARY_TOOL}"`).test(received.adminPolicy ?? ''))
    t.ok('the file is named for this invocation', /^devpanel-inv-fence\.toml$/.test(received.adminPolicyFile ?? ''), received.adminPolicyFile)
    t.ok('the acknowledgement names that file and the ADMIN tier', acknowledgementPattern(received.adminPolicyFile).test(`[WARNING] [ADMIN] Policy file warning in ${received.adminPolicyFile}:`))
    t.eq('and the turn records that the runtime gave it', turn.diagnostics.tooling.policy, { file: received.adminPolicyFile, acknowledged: true, sha256: crypto.createHash('sha256').update(received.adminPolicy).digest('hex') })

    // The live checkout is fenced by ABSENCE: file tools refuse any path outside
    // the workspace, and it was never made part of it.
    t.ok('the live checkout is not in the workspace', !received.includeDirectories.includes('/projects/some-project'), received.includeDirectories.join(','))
    t.ok('the roots this role may read are', received.includeDirectories.includes(scratch))

    // The worktree IS the revision. A temp file the runtime wrote there would
    // become part of the candidate the fingerprint measures. What the adapter
    // SUPPLIED is asserted unconditionally, from the turn's own record of it;
    // only whether the sandbox let the variable reach the child is environmental.
    t.eq('scratch is named for durable artifacts', received.scratchDir, scratch)
    const supplied = turn.diagnostics.runtimeTemp
    t.ok('the runtime was given a temp directory of its own', supplied?.path?.includes('devpanel-gemini-tmp-'), JSON.stringify(supplied))
    t.ok('outside the worktree', supplied?.path && !supplied.path.startsWith(cwd), supplied?.path)
    t.eq('private to this invocation', supplied?.mode, 0o700)
    t.eq('and removed when the turn ends', await fs.stat(supplied?.path ?? '').then(() => true, () => false), false)

    // Independently: does THIS environment deliver TMPDIR to a spawned process
    // at all? Decided by a process that has nothing to do with the adapter, so
    // the adapter dropping the variable could never look like a sandbox limit.
    const probe = await runProcess({ command: '/bin/sh', args: ['-c', 'printf %s "$TMPDIR"'], cwd, env: { ...process.env, TMPDIR: '/devpanel-tmpdir-probe' }, stdin: '' })
    if (probe.stdout.trim() !== '/devpanel-tmpdir-probe') {
      t.skip('the child saw that directory as TMPDIR', `this environment strips TMPDIR from spawned processes (a plain shell saw ${JSON.stringify(probe.stdout.trim())})`)
    } else {
      t.eq('the child saw that directory as TMPDIR', received.tempDir, supplied?.path)
      t.eq('with the private mode', received.tempMode, 0o700)
    }
  }

  t.section('2d1. a read seat says whether it read, as the other adapters do')
  {
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()
    // No fence is requested here (the runner's default), so the turn stays tool-free and must say so: the consult
    // panel takes an opinion only from a turn reporting `access: 'read'`.
    const unfenced = await gemini.invoke({ prompt: 'read and answer', model: 'gemini-3-pro', cwd, supervisorOnly: true, readOnlyTools: true, meta: { invocationId: 'inv-read-seat' } })
    t.eq('a read seat without a fence reports that it did not read', unfenced.diagnostics.access, 'none (fence not proved)')
    t.eq('and its policy allows no read tool', decide((await readRecord(record))[0].received.adminPolicy, 'read_file'), 'deny')
    const plain = await gemini.invoke({ prompt: 'answer', model: 'gemini-3-pro', cwd, supervisorOnly: true, meta: { invocationId: 'inv-plain' } })
    t.ok('a turn that asked for no read access carries no such claim', !('access' in plain.diagnostics))
    // The installed CLI exits on a file passed to --include-directories, so a single-file root never reaches it.
    const fileRoot = path.join(await temp(), 'project.yaml')
    await fs.writeFile(fileRoot, 'id: demo\n')
    const scratch = await temp()
    const withFile = await gemini.invoke({ prompt: 'audit this', model: 'gemini-3-pro', cwd, scratchDir: scratch, tooling: { writesCode: false, allowedRoots: [scratch, fileRoot] }, meta: { invocationId: 'inv-file-root' } })
    const included = (await readRecord(record)).at(-1).received.includeDirectories
    t.ok('a file root is not handed to the runtime as a directory', !included.includes(fileRoot) && included.includes(scratch), included.join(','))
    t.eq('and, outside a fenced read seat, it is named as out of reach instead of widened to its directory', [withFile.diagnostics.tooling.unreachableRoots, included.includes(path.dirname(fileRoot))], [[fileRoot], false])
  }

  t.section('2d2. a fence the runtime could not load, dropped, or never mentioned stops the turn')
  {
    /*
     * The runtime fails OPEN here, which is the reason this exists: given a
     * malformed policy it prints "[ADMIN] Policy file error" and keeps going in
     * YOLO mode; given system policies it drops --admin-policy with a warning
     * and keeps going; given a missing one it says nothing at all. Everything
     * after that point is unfenced, so the answer is not something to accept.
     */
    const attempt = async (mode, invocationId) => {
      const ledgerDir = await temp()
      await underTest({ mode })
      let thrown = null
      try {
        await gemini.invoke({
          prompt: 'audit this', model: 'gemini-3-pro', cwd: await temp(), ledgerDir,
          tooling: { writesCode: false, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [] },
          meta: { invocationId }
        })
      } catch (error) { thrown = error }
      const ledger = await readRecord(path.join(ledgerDir, 'gemini-ledger.jsonl'))
      return { thrown, ledger }
    }

    const malformed = await attempt('policy-error', 'inv-policy')
    t.eq('a malformed policy: the turn fails as an environment fault', malformed.thrown?.kind, 'environment-error')
    t.ok('not as a cancellation, which would hide why', malformed.thrown?.name !== 'AbortError', malformed.thrown?.name)
    t.ok('quoting what the runtime said', /Policy file error/.test(malformed.thrown?.message ?? ''), malformed.thrown?.message)
    t.ok('and the process was terminated', Boolean(malformed.thrown?.termination?.confirmedAt))
    t.eq('the ledger records it as an environment failure', malformed.ledger.at(-1).classification, 'environment')

    // The reproduction from the review: the runtime warns that it is IGNORING
    // the admin policy because the host has system policies, then answers
    // normally. Before, the adapter reported that turn as completed.
    const ignored = await attempt('policy-ignored', 'inv-ignored')
    t.eq('a dropped policy: the turn fails as an environment fault', ignored.thrown?.kind, 'environment-error')
    t.ok('quoting the security warning', /Ignoring --admin-policy/.test(ignored.thrown?.message ?? ''), ignored.thrown?.message)
    t.eq('never as a completed turn', ignored.thrown?.outcome, undefined)
    t.eq('on the ledger as an environment failure', ignored.ledger.at(-1).classification, 'environment')

    // Silence is not consent: a runtime that never parsed the file never warns
    // about the rule that names no tool, and its answer is refused.
    const silent = await attempt('policy-silent', 'inv-silent')
    t.eq('an unacknowledged policy: the turn fails as an environment fault', silent.thrown?.kind, 'environment-error')
    t.ok('saying which policy went unacknowledged', /devpanel-inv-silent\.toml/.test(silent.thrown?.message ?? ''), silent.thrown?.message)
    t.ok('and stopping at the first tool, not after the answer', /before acknowledging/.test(silent.thrown?.message ?? ''), silent.thrown?.message)
    t.eq('on the ledger as an environment failure', silent.ledger.at(-1).classification, 'environment')
  }

  t.section('2d3. a host with system policies is refused before anything is spent')
  {
    // The runtime drops --admin-policy whenever its system policy directory
    // holds a .toml (policy/config.ts v0.60.0). The adapter checks the same
    // directory first: a fence that would be ignored is not launched at all.
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const systemDir = process.env.DEVPANEL_GEMINI_SYSTEM_CONFIG_DIR
    await fs.mkdir(path.join(systemDir, 'policies'), { recursive: true })
    await fs.writeFile(path.join(systemDir, 'policies/corporate.toml'), '[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 1\n', 'utf8')
    let thrown = null
    try {
      await gemini.invoke({ prompt: 'audit this', model: 'gemini-3-pro', cwd: await temp(), meta: { invocationId: 'inv-system' } })
    } catch (error) { thrown = error }
    t.eq('refused before launch', thrown?.started, false)
    t.eq('as an environment fault', thrown?.kind, 'environment-error')
    t.ok('naming the file that would displace the fence', /corporate\.toml/.test(thrown?.message ?? ''), thrown?.message)
    t.eq('and nothing was spawned', await fs.stat(record).then(() => true, () => false), false)
    await fs.rm(path.join(systemDir, 'policies'), { recursive: true, force: true })
  }

  t.section('2e. what cannot be expressed is refused, not approximated')
  {
    await underTest({})
    let thrown = null
    try {
      await gemini.invoke({
        prompt: 'write the fix', model: 'gemini-3-pro', cwd: await temp(),
        // Gemini has no read-only workspace root: --include-directories grants
        // reads and writes together. For a role that writes, "you may read the
        // live checkout" cannot be honoured, so the launch is refused.
        tooling: { writesCode: true, allowLiveCheckout: true, liveCheckout: '/projects/some-project', allowedRoots: [] },
        meta: { invocationId: 'inv-refuse' }
      })
    } catch (error) { thrown = error }
    t.eq('it refuses before launching', thrown?.started, false)
    t.eq('as a configuration fault', thrown?.kind, 'configuration-error')

    // Efforts: [] is a claim about the runtime. Being asked for one anyway is a
    // configuration fault, not something to drop and run at an unknown effort.
    let effortError = null
    try {
      await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', effort: 'high', cwd: await temp(), meta: { invocationId: 'inv-effort' } })
    } catch (error) { effortError = error }
    t.eq('an effort override is refused', effortError?.kind, 'configuration-error')
    t.eq('the adapter declares no effort support', gemini.capabilities.effort, false)
  }

  t.section('2f. a writer may read the evidence and configured roots, and cannot change them')
  {
    /*
     * Every root the engine grants besides scratch — its evidence directory, a
     * project's configured roots — is read-only for the writer too, and gemini's
     * workspace grant is read-write. The policy denies the file tools into those
     * roots by the arguments the model passes, refuses any `..` that could walk
     * into them after resolution, and takes the shell away, because no rule can
     * keep a shell out of a directory.
     */
    const evidence = '/work/issue/runs/r1/evidence'
    const scratch = '/work/issue/runs/r1/scratch/author'
    const policy = buildPolicy({ writesCode: true, readOnlyRoots: [evidence] })
    const write = (file_path) => decide(policy, 'write_file', { args: { file_path, content: 'x' } })
    const edit = (file_path) => decide(policy, 'replace', { args: { file_path, old_string: 'a', new_string: 'b' } })
    t.eq('a write into the evidence root is denied', write(`${evidence}/report.md`), 'deny')
    t.eq('so is an edit there', edit(`${evidence}/report.md`), 'deny')
    t.eq('and a write to the root itself', write(evidence), 'deny')
    t.eq('a sibling that merely shares the prefix is not the root', write(`${evidence}-copy/x`), 'allow')
    t.eq('a write inside the worktree is allowed', write('/work/issue/runs/r1/worktree/src/a.js'), 'allow')
    t.eq('a write into scratch is allowed', write(`${scratch}/notes.md`), 'allow')
    t.eq('a path that walks upward is refused wherever it starts', write('/work/issue/runs/r1/worktree/../evidence/x'), 'deny')
    t.eq('including a relative one', write('../evidence/x'), 'deny')
    t.eq('and one that ends on the parent', write('/work/issue/runs/r1/worktree/..'), 'deny')
    t.eq('a dotfile is not a parent segment', write('/work/issue/runs/r1/worktree/..hidden'), 'allow')
    for (const tool of ['run_shell_command', 'list_background_processes', 'read_background_output']) {
      t.eq(`${tool} is denied while read-only roots are present`, decide(policy, tool), 'deny')
    }
    t.eq('the shell is allowed again when there is nothing to keep it out of', decide(buildPolicy({ writesCode: true, readOnlyRoots: [] }), 'run_shell_command'), 'allow')
    t.ok('the pattern does not trip the runtime\'s nested-quantifier check', !policy.split(NL).filter((l) => l.startsWith('argsPattern')).some((l) => /\([^)]*[*+?{].*\)[*+?{]/.test(JSON.parse(l.slice('argsPattern = '.length)))))

    // Every spelling of a path that is not its canonical one is refused, not
    // enumerated: the runtime resolves the path AFTER the policy has matched
    // the spelling, so `/a/./evidence` and `/a//evidence` would otherwise pass
    // the root rule and land in the root. Reproduced against the installed
    // engine (0.60.0) before this rule existed; the live check now covers it.
    t.eq('a `.` segment inside the root is refused', write('/work/issue/runs/r1/./evidence/x'), 'deny')
    t.eq('so is an empty segment', write('/work/issue/runs/r1//evidence/x'), 'deny')
    t.eq('and a doubled slash anywhere on the way', write('//work/issue/runs/r1/evidence/x'), 'deny')
    t.eq('a trailing `.` segment', write(`${evidence}/.`), 'deny')
    t.eq('a `./` prefix', write('./notes.md'), 'deny')
    t.eq('the same spellings are refused for an edit', edit('/work/issue/runs/r1/./evidence/x'), 'deny')
    t.eq('a dotfile is still a file', write('/work/issue/runs/r1/worktree/.env'), 'allow')
    t.eq('and a plain relative path resolves inside the cwd, which is writable', write('src/a.js'), 'allow')

    // A root that CONTAINS a writable area is not exempt: exempting it would
    // exempt every sibling in it. The root is denied whole and the areas beneath
    // it are allowed back by spelling, under the canonical-spelling rules.
    const nested = buildPolicy({ writesCode: true, readOnlyRoots: ['/run'], carveOuts: ['/run/scratch/author', '/run/wt'] })
    const writeN = (file_path) => decide(nested, 'write_file', { args: { file_path, content: 'x' } })
    t.eq('a sibling of scratch under the ancestor root is denied', writeN('/run/evidence/x'), 'deny')
    t.eq('and the root itself', writeN('/run/x'), 'deny')
    t.eq('scratch beneath it is allowed', writeN('/run/scratch/author/notes.md'), 'allow')
    t.eq('the worktree beneath it is allowed', writeN('/run/wt/src/a.js'), 'allow')
    t.eq('a prefix sibling of the carve-out is not the carve-out', writeN('/run/scratch/author-2/x'), 'deny')
    t.eq('the carve-out does not reopen `..`', writeN('/run/scratch/author/../../evidence/x'), 'deny')
    t.eq('nor `.`', writeN('/run/scratch/author/./x'), 'deny')
    t.eq('the shell stays denied under an ancestor root', decide(nested, 'run_shell_command'), 'deny')
    const inside = buildPolicy({ writesCode: true, readOnlyRoots: ['/run/wt/vendor'], carveOuts: ['/run/wt'] })
    t.eq('a read-only root inside a carve-out outranks the carve-out', decide(inside, 'write_file', { args: { file_path: '/run/wt/vendor/x', content: '' } }), 'deny')
    t.eq('while the rest of the carve-out stays writable', decide(inside, 'write_file', { args: { file_path: '/run/wt/src/x', content: '' } }), 'allow')

    // Through the adapter: the engine hands over scratch and evidence together,
    // and only evidence becomes read-only.
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()
    const scratchDir = await temp()
    const evidenceDir = await temp()
    const turn = await gemini.invoke({
      prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir,
      tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: '/projects/some-project', allowedRoots: [evidenceDir, scratchDir] },
      meta: { invocationId: 'inv-roots' }
    })
    const received = (await readRecord(record))[0].received
    t.ok('both roots are in the workspace', [evidenceDir, scratchDir].every((d) => received.includeDirectories.includes(d)))
    t.eq('the runtime was told to deny writes into evidence', decide(received.adminPolicy, 'write_file', { args: { file_path: `${evidenceDir}/x`, content: '' } }), 'deny')
    t.eq('by its resolved spelling as well', decide(received.adminPolicy, 'write_file', { args: { file_path: `${await fs.realpath(evidenceDir)}/x`, content: '' } }), 'deny')
    t.eq('and to allow writes into scratch', decide(received.adminPolicy, 'write_file', { args: { file_path: `${scratchDir}/x`, content: '' } }), 'allow')
    t.eq('and the shell is gone for this turn', decide(received.adminPolicy, 'run_shell_command', { args: { command: 'ls' } }), 'deny')
    t.ok('which the turn records', /denied/.test(turn.diagnostics.tooling.shell), turn.diagnostics.tooling.shell)
    t.ok('naming the roots', turn.diagnostics.tooling.readOnlyRoots.includes(evidenceDir) && !turn.diagnostics.tooling.readOnlyRoots.includes(scratchDir), JSON.stringify(turn.diagnostics.tooling.readOnlyRoots))

    const only = await gemini.invoke({
      prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir,
      tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: '/projects/some-project', allowedRoots: [scratchDir] },
      meta: { invocationId: 'inv-scratch-only' }
    })
    t.eq('with scratch as the only root the writer keeps its shell', decide((await readRecord(record))[1].received.adminPolicy, 'run_shell_command', { args: { command: 'ls' } }), 'allow')
    t.eq('recorded as unfenceable, as Bash is under claude', only.diagnostics.tooling.shell, 'not-fenceable')

    // The engine handing over a root ABOVE scratch: the root is read-only, scratch
    // alone is carved out, and the turn records the carve-out.
    const runDir = await temp()
    const scratchBelow = path.join(runDir, 'scratch', 'author')
    await fs.mkdir(scratchBelow, { recursive: true })
    const above = await gemini.invoke({
      prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir: scratchBelow,
      tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: '/projects/some-project', allowedRoots: [runDir, scratchBelow] },
      meta: { invocationId: 'inv-ancestor' }
    })
    const abovePolicy = (await readRecord(record))[2].received.adminPolicy
    t.eq('a root above scratch is denied as a whole', decide(abovePolicy, 'write_file', { args: { file_path: `${runDir}/evidence/x`, content: '' } }), 'deny')
    t.eq('scratch beneath it is allowed back', decide(abovePolicy, 'write_file', { args: { file_path: `${scratchBelow}/x`, content: '' } }), 'allow')
    t.eq('its sibling is not', decide(abovePolicy, 'write_file', { args: { file_path: `${runDir}/scratch/auditor/x`, content: '' } }), 'deny')
    t.eq('and the shell is gone', decide(abovePolicy, 'run_shell_command', { args: { command: 'ls' } }), 'deny')
    t.ok('the turn names the root as read-only', above.diagnostics.tooling.readOnlyRoots.includes(runDir), JSON.stringify(above.diagnostics.tooling.readOnlyRoots))
    t.ok('and scratch as the carve-out', (above.diagnostics.tooling.carveOuts ?? []).includes(scratchBelow), JSON.stringify(above.diagnostics.tooling.carveOuts))
  }

  t.section('2g. the read-only roots are a mount, not a spelling: proved before launch, and holding')
  {
    /*
     * A rule that names a spelling is only as good as the spelling the model
     * chose, and the runtime transforms paths before writing (relative
     * resolution, NUL stripping, link following). The boundary is therefore a
     * read-only bind mount of every root over itself, in a mount namespace the
     * turn cannot leave; the policy rules explain a refusal, the mount makes it.
     * The adapter proves the mount from inside the sandbox before the model is
     * launched, and a mount it cannot put up or prove refuses the turn.
     */
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()
    const scratchDir = await temp()
    const evidenceDir = await temp()
    const vendor = path.join(cwd, 'vendor')
    await fs.mkdir(vendor)
    await fs.writeFile(path.join(vendor, 'x'), 'keep')
    // The review's chain: worktree/alias -> external, external/nested -> worktree/vendor.
    const external = await temp()
    await fs.symlink(external, path.join(cwd, 'alias'))
    await fs.symlink(vendor, path.join(external, 'nested'))
    const tooling = { writesCode: true, allowLiveCheckout: false, liveCheckout: '/projects/some-project', allowedRoots: [evidenceDir, vendor, scratchDir] }
    const NUL = String.fromCharCode(0)

    const bwrapWorks = (await runProcess({ command: 'bwrap', args: ['--dev-bind', '/', '/', '--', '/bin/true'], stdin: '' }).catch(() => ({ code: -1 }))).code === 0
    if (!bwrapWorks) {
      t.skip('a writer with read-only roots is launched inside the mount', 'bubblewrap is not usable in this environment')
    } else {
      const turn = await gemini.invoke({ prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir, tooling, meta: { invocationId: 'inv-mount' } })
      const received = (await readRecord(record))[0].received
      const sandbox = turn.diagnostics.tooling.sandbox
      const resolved = await Promise.all([evidenceDir, vendor, scratchDir].map((d) => fs.realpath(d)))
      t.eq('the turn was launched through bubblewrap', sandbox?.tool, 'bwrap')
      t.ok('with every read-only root mounted read-only over itself, by resolved path', resolved.slice(0, 2).every((d) => sandbox.readOnlyMounts.includes(d)), JSON.stringify(sandbox?.readOnlyMounts))
      t.eq('and the mount proved from inside before launch', sandbox?.proved, true)
      t.ok('the runtime still received its own arguments', received.argv.includes('--admin-policy') && received.includeDirectories.includes(evidenceDir))
      t.ok('scratch is not mounted read-only', !sandbox.readOnlyMounts.includes(resolved[2]))
      t.eq('the policy also names the relative spelling of a root inside the worktree', decide(received.adminPolicy, 'write_file', { args: { file_path: 'vendor/x', content: '' } }), 'deny')
      t.eq('and refuses a NUL in a path, which the runtime would strip', decide(received.adminPolicy, 'write_file', { args: { file_path: `${cwd}/ven${NUL}dor/x`, content: '' } }), 'deny')
      t.eq('the worktree beside the root stays writable', decide(received.adminPolicy, 'write_file', { args: { file_path: `${cwd}/src/a.js`, content: '' } }), 'allow')

      // The mount itself, exercised the way a runtime would: a shell in the
      // SAME sandbox tries every spelling and route the policy cannot see.
      const script = [
        `cd ${JSON.stringify(cwd)}`,
        'try () { if ( : > "$2" ) 2>/dev/null; then echo "WRITABLE $1"; rm -f "$2"; else echo "denied $1"; fi; }',
        `try absolute ${JSON.stringify(`${vendor}/x`)}`,
        'try relative vendor/x',
        'try chained-links alias/nested/y',
        `try evidence ${JSON.stringify(`${evidenceDir}/report.md`)}`,
        'try worktree src.txt',
        `try scratch ${JSON.stringify(`${scratchDir}/notes.md`)}`,
        `ln ${JSON.stringify(`${evidenceDir}/existing`)} hard 2>/dev/null && echo "WRITABLE hard-link" || echo "denied hard-link"; rm -f hard`
      ].join(NL)
      await fs.writeFile(path.join(evidenceDir, 'existing'), 'e')
      const inside = await runProcess({ command: 'bwrap', args: [...sandbox.argv, '--', '/bin/sh', '-c', script], cwd, stdin: '' })
      const lines = inside.stdout.split(NL).filter(Boolean)
      t.eq('inside the mount, every route into a root is refused and the writable areas stay writable', lines, [
        'denied absolute', 'denied relative', 'denied chained-links', 'denied evidence', 'WRITABLE worktree', 'WRITABLE scratch', 'denied hard-link'
      ])
      t.eq('and the roots are untouched afterwards', await fs.readFile(path.join(vendor, 'x'), 'utf8'), 'keep')
      const control = await runProcess({ command: '/bin/sh', args: ['-c', script], cwd, stdin: '' })
      t.ok('which the same script outside the mount would not have been', control.stdout.includes('WRITABLE absolute') && control.stdout.includes('WRITABLE chained-links'), control.stdout)
      await fs.writeFile(path.join(vendor, 'x'), 'keep')
    }

    // A mount that cannot be put up is a refused turn, never an unfenced one.
    const savedBwrap = process.env.DEVPANEL_BWRAP_BIN
    process.env.DEVPANEL_BWRAP_BIN = path.join(await temp(), 'no-bwrap')
    try {
      await gemini.invoke({ prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir, tooling, meta: { invocationId: 'inv-no-bwrap' } })
      t.ok('a missing bubblewrap refuses the turn', false)
    } catch (error) {
      t.eq('a missing bubblewrap refuses the turn', error.kind, 'environment-error')
      t.eq('before anything was spent', error.started, false)
      t.ok('naming what it needed it for', /bubblewrap/.test(error.message) && error.message.includes(await fs.realpath(evidenceDir)), error.message)
    } finally {
      if (savedBwrap === undefined) delete process.env.DEVPANEL_BWRAP_BIN; else process.env.DEVPANEL_BWRAP_BIN = savedBwrap
    }
    t.eq('and nothing was launched', (await readRecord(record)).length, bwrapWorks ? 1 : 0)

    try {
      await gemini.invoke({ prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir, tooling: { ...tooling, allowedRoots: [path.join(cwd, 'does-not-exist')] }, meta: { invocationId: 'inv-missing-root' } })
      t.ok('a root that does not exist cannot be mounted and refuses the turn', false)
    } catch (error) {
      t.eq('a root that does not exist cannot be mounted and refuses the turn', error.kind, 'environment-error')
    }

    // With no read-only root there is nothing to mount: the writer runs as before.
    const plain = await gemini.invoke({ prompt: 'implement', model: 'gemini-3-pro', cwd, scratchDir, tooling: { ...tooling, allowedRoots: [scratchDir] }, meta: { invocationId: 'inv-unmounted' } })
    t.eq('without read-only roots no sandbox is involved', plain.diagnostics.tooling.sandbox, undefined)
    t.eq('and the shell is recorded as unfenceable', plain.diagnostics.tooling.shell, 'not-fenceable')
  }

  t.section('3. the answer is assembled from deltas, and usage is not invented')
  {
    await underTest({})
    const turn = await gemini.invoke({ prompt: 'say something', model: 'gemini-3-pro', cwd: await temp(), meta: { invocationId: 'inv-usage' } })
    t.ok('the whole answer is returned, not its last chunk', turn.response.includes('Here is the work.') && turn.response.trim().endsWith('```'), turn.response.slice(0, 40))
    t.eq('the provider total is the runtime\'s own', turn.usage.tokens, 4333)
    t.eq('the cached share is recorded, not added again', turn.usage.cacheReadTokens, 4000)
    t.eq('cost is unknown rather than estimated', turn.usage.costUsd, null)
    t.eq('and attributed to the provider that billed it', turn.usage.provider, 'google')
    t.eq('the turn completed', turn.outcome, 'completed')
    t.eq('every tool call is on the turn, with the policy\'s verdict', turn.diagnostics.toolCalls.map((c) => [c.name, c.status]), [['read_file', 'success']])
  }

  t.section('3b. a provider fault is a failed RUN, classified from the runtime\'s own words')
  {
    await underTest({ mode: 'stdout-quota' })
    let thrown = null
    try {
      await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd: await temp(), ledgerDir: await temp(), meta: { invocationId: 'inv-quota' } })
    } catch (error) { thrown = error }
    t.eq('it is a runtime failure, never an answer', thrown?.kind, 'runtime-error')
    t.eq('classified as an exhausted quota', classifyFailure(thrown).class, 'quota')
    t.ok('carrying the message it was read from', /usage limit reached/.test(thrown?.stderr ?? ''), thrown?.stderr)
  }

  t.section('3c. cancellation terminates the process before it is reported')
  {
    const ledgerDir = await temp()
    await underTest({ mode: 'slow' })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    let thrown = null
    try {
      await gemini.invoke({ prompt: 'hello', cwd: await temp(), ledgerDir, marker: 'devpanel:g:c', signal: controller.signal, graceMs: 250, meta: { invocationId: 'inv-cancel' } })
    } catch (error) { thrown = error }
    t.eq('it aborts', thrown?.name, 'AbortError')
    t.ok('carrying proof the group was terminated', Boolean(thrown?.termination?.confirmedAt))
    const ledger = await readRecord(path.join(ledgerDir, 'gemini-ledger.jsonl'))
    t.eq('and the cancellation is on the adapter ledger', ledger.at(-1).phase, 'cancelled')
  }

  t.section('3d. an interrupted invocation reconciles only with attributable evidence')
  {
    const ledgerDir = await temp()
    await underTest({})
    await gemini.invoke({ prompt: 'work', model: 'gemini-3-pro', cwd: await temp(), ledgerDir, marker: 'devpanel:g:d', meta: { invocationId: 'inv-done' } })
    t.eq('a completed invocation is recognisable', (await gemini.reconcile('inv-done', { ledgerDir })).phase, 'completed')
    t.eq('another invocation\'s record is not evidence for this one', (await gemini.reconcile('inv-other', { ledgerDir })).phase, 'uncertain')
    t.eq('and no ledger at all is not evidence of absence', (await gemini.reconcile('inv-done', { ledgerDir: await temp() })).phase, 'uncertain')
  }

  t.section('3e. the authentication method is selected where the runtime loads it, and what outranks it is refused')
  {
    /*
     * The runtime reads `security.auth.selectedType` from its merged settings
     * before it looks at any environment variable. A system settings file would
     * outrank everything, but the runtime loads one only from a root-owned path,
     * which this service cannot make: the method goes into the connection's own
     * home (the user tier), and the two things that outrank or replace it, the
     * workspace's settings and an account's own, are checked before launch.
     * The fake resolves the method exactly as the runtime does, the skipped
     * system file included.
     */
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const ambientHome = await settingsHome({ security: { auth: { selectedType: 'oauth-personal' } } })
    process.env.GEMINI_CLI_HOME = ambientHome
    process.env.DEVPANEL_TEST_GEMINI_KEY = 'sk-roster-key'
    const cwd = await temp()

    const keyed = await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', tooling: { writesCode: false, allowedRoots: [] }, meta: { invocationId: 'inv-auth-key' } })
    let calls = await readRecord(record)
    let seen = calls.at(-1).received
    t.eq('a keyed connection resolves to the API key', seen.effectiveAuth, 'gemini-api-key')
    t.eq('with nothing the runtime could refuse', seen.authError, null)
    t.ok('under a home of its own, never the operator\'s', seen.geminiHome && seen.geminiHome !== ambientHome, seen.geminiHome)
    t.eq('the method is in that home\'s settings, selected and enforced', seen.userSettings.security?.auth, { selectedType: 'gemini-api-key', enforcedType: 'gemini-api-key' })
    t.eq('no system settings file is handed over for the runtime to skip', [seen.systemSettingsPath, seen.systemDefaultsPath, seen.systemSettingsSkipped], [null, null, false])
    t.eq('the turn records where the method is in force', [keyed.diagnostics.tooling.authentication.tier, keyed.diagnostics.tooling.authentication.file], ['user', path.join(seen.geminiHome, '.gemini/settings.json')])
    t.eq('a writing seat\'s home keeps the ignore filtering', seen.fileFiltering, {})

    // What the home's file already held stays; a second turn finds nothing to write.
    const homeFile = path.join(seen.geminiHome, '.gemini/settings.json')
    await fs.writeFile(homeFile, JSON.stringify({ general: { vimMode: true }, security: { auth: { useExternal: false } } }), 'utf8')
    await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', meta: { invocationId: 'inv-auth-merge' } })
    seen = (await readRecord(record)).at(-1).received
    t.eq('what the file held is carried, with the method beside it', [seen.userSettings.general, seen.userSettings.security.auth], [{ vimMode: true }, { useExternal: false, selectedType: 'gemini-api-key', enforcedType: 'gemini-api-key' }])
    const written = (await fs.stat(homeFile)).mtimeMs
    await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', meta: { invocationId: 'inv-auth-steady' } })
    t.eq('an unchanged file is not rewritten (another turn\'s configuration guard compares it)', (await fs.stat(homeFile)).mtimeMs, written)

    // The workspace's own settings outrank the user tier: one that selects another method is refused before launch.
    await fs.mkdir(path.join(cwd, '.gemini'), { recursive: true })
    await fs.writeFile(path.join(cwd, '.gemini/settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }), 'utf8')
    let before = (await readRecord(record)).length
    let thrown = null
    try { await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', meta: { invocationId: 'inv-auth-workspace' } }) } catch (error) { thrown = error }
    t.eq('a workspace that selects another method is refused before launch', [thrown?.started, (await readRecord(record)).length], [false, before])
    t.ok('naming the file and both methods', thrown?.message.includes(path.join(cwd, '.gemini', 'settings.json')) && /oauth-personal/.test(thrown.message) && /gemini-api-key/.test(thrown.message), thrown?.message)
    await fs.writeFile(path.join(cwd, '.gemini/settings.json'), JSON.stringify({ ui: { theme: 'Default' }, security: { auth: { selectedType: 'gemini-api-key' } } }), 'utf8')
    const agreeing = await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', tooling: { writesCode: false, allowedRoots: [] }, meta: { invocationId: 'inv-auth-workspace-ok' } })
    t.eq('one that agrees, or says nothing about the method, runs and is named', agreeing.diagnostics.tooling.authentication.workspaceSettings, path.join(cwd, '.gemini', 'settings.json'))
    await fs.writeFile(path.join(cwd, '.gemini/settings.json'), '{ not json', 'utf8')
    thrown = null
    try { await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', meta: { invocationId: 'inv-auth-workspace-bad' } }) } catch (error) { thrown = error }
    t.ok('one that cannot be read as JSON is refused, not guessed', thrown?.started === false && /not plain JSON/.test(thrown.message), thrown?.message)
    await fs.rm(path.join(cwd, '.gemini'), { recursive: true, force: true })

    await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, account: 'cyd', meta: { invocationId: 'inv-auth-login' } })
    seen = (await readRecord(record)).at(-1).received
    t.eq('an account resolves to the Google login, from the environment', seen.effectiveAuth, 'oauth-personal')
    t.eq('and nothing is written into the person\'s home', await fs.stat(path.join(gemini.accountDir('cyd'), '.gemini/settings.json')).then(() => true, () => false), false)

    await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, meta: { invocationId: 'inv-auth-ambient' } })
    seen = (await readRecord(record)).at(-1).received
    t.eq('the ambient route writes nothing and runs as the host is configured', [seen.effectiveAuth, seen.geminiHome, seen.userSettings], ['oauth-personal', ambientHome, { security: { auth: { selectedType: 'oauth-personal' } } }])

    // A host whose own system settings enforce another method is a conflict, refused before launch.
    const hostSettings = path.join(await temp(), 'settings.json')
    await fs.writeFile(hostSettings, JSON.stringify({ security: { auth: { enforcedType: 'vertex-ai' } } }), 'utf8')
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = hostSettings
    before = (await readRecord(record)).length
    thrown = null
    try {
      await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', meta: { invocationId: 'inv-auth-enforced' } })
    } catch (error) { thrown = error }
    t.eq('refused before launch', thrown?.started, false)
    t.ok('naming both methods', /vertex-ai/.test(thrown?.message ?? '') && /gemini-api-key/.test(thrown?.message ?? ''), thrown?.message)
    t.eq('and nothing was spawned', (await readRecord(record)).length, before)
    delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH

    // An ACCOUNT's own home that selects an API key: nothing this service can write outranks the person's file,
    // so the conflict is refused before launch instead of running as the key.
    const misconfigured = gemini.accountDir('dee')
    await fs.mkdir(path.join(misconfigured, '.gemini'), { recursive: true })
    await fs.writeFile(path.join(misconfigured, '.gemini/settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }), 'utf8')
    before = (await readRecord(record)).length
    thrown = null
    try { await gemini.invoke({ prompt: 'hi', model: 'gemini-3-pro', cwd, account: 'dee', meta: { invocationId: 'inv-auth-conflict' } }) } catch (error) { thrown = error }
    t.eq('the person\'s conflicting selection is refused before launch', [thrown?.started, (await readRecord(record)).length], [false, before])
    t.ok('naming the account\'s file', thrown?.message.includes(path.join(misconfigured, '.gemini', 'settings.json')), thrown?.message)

    // A read seat's settings: its own home, with the ignore filtering off; the writing seats' home is untouched.
    const read = gemini.resolveConnection({ credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', readSeat: true })
    const write = gemini.resolveConnection({ credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY' })
    t.eq('a read seat has a home of its own beside the connection\'s', read.env.GEMINI_CLI_HOME, `${write.env.GEMINI_CLI_HOME}.read`)
    const applied = await gemini.applySettings(read.env, read.applied, { cwd, readSeat: true })
    const readHome = JSON.parse(await fs.readFile(path.join(read.env.GEMINI_CLI_HOME, '.gemini/settings.json'), 'utf8'))
    t.eq('there the ignore filtering is off, beside the method', [readHome.context.fileFiltering, readHome.security.auth.enforcedType, applied.fileFiltering], [{ respectGitIgnore: false, respectGeminiIgnore: false }, 'gemini-api-key', { respectGitIgnore: false, respectGeminiIgnore: false }])
    t.eq('and the writing seats\' home never gets it', JSON.parse(await fs.readFile(path.join(write.env.GEMINI_CLI_HOME, '.gemini/settings.json'), 'utf8')).context, undefined)
    const person = gemini.resolveConnection({ account: 'cyd', readSeat: true })
    t.ok('an account\'s read seat says the filtering was not applied', /not applied/.test((await gemini.applySettings(person.env, person.applied, { cwd, readSeat: true })).fileFiltering))

    // Prepaid API credit that ran out (seen live 2026-11-24): quota, so the model is held, not a nameless runtime fault.
    t.eq('depleted prepaid credits classify as quota', classifyFailure({ message: 'gemini exited 146', stderr: 'Error when talking to Gemini API _ApiError: {"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 402,\\n \\"message\\": \\"Your prepayment credits are depleted. Please go to AI Studio\\", \\"status\\": \\"RESOURCE_EXHAUSTED\\"}}","code":402,"status":"Payment Required"}}' }).class, 'quota')
    t.eq('a rate limit that also says RESOURCE_EXHAUSTED stays a rate limit', classifyFailure({ message: 'gemini exited 1', stderr: '{"error":{"code":429,"message":"Too many requests","status":"RESOURCE_EXHAUSTED"}}' }).class, 'rate-limit')

    // Should the runtime ever find itself under an enforced type it cannot
    // satisfy, its refusal is an authentication fault, not a generic failure.
    t.eq('the runtime\'s enforcement refusal classifies as auth', classifyFailure({ message: 'gemini exited 1', stderr: "The enforced authentication type is 'oauth-personal', but the current type is 'gemini-api-key'. Please re-authenticate with the correct type." }).class, 'auth')

    delete process.env.GEMINI_CLI_HOME
  }

  // ============================================================ 4. the live fence check
  t.section('4. the live fence check passes only a fence that was pushed on and held')
  {
    /*
     * The offline suite proves the adapter hands the runtime the right rules.
     * Whether the RUNTIME then refuses is a claim about somebody else's software,
     * and `npm run live -- --fence` is what establishes it against a real model.
     * What is testable here is that the check itself is not vacuous: a runtime
     * that ignores the fence must fail it, and a model that never tried must
     * not pass it — an untouched disk after no attempts proves nothing.
     */
    const ledger = { records: [], record (entry) { this.records.push(entry) } }
    const check = async (extra = {}) => runFenceCheck({
      adapter: gemini, harnessId: 'gemini', model: 'gemini-3-pro',
      workspace: await temp(), scratch: await temp(), ledgerDir: await temp(), ledger, ...extra
    })

    await underTest({ mode: 'breach' })
    const breached = await check()
    t.ok('a runtime that wrote anyway is caught', !fencePassed(breached))
    t.ok('and the report says what got through', /THE FENCE DID NOT HOLD/.test(describeFence(breached)), describeFence(breached))
    t.eq('every breach is named, on disk and in the runtime\'s own record', breached.stages.filter((s) => s.status === 'fail').map((s) => s.name), [
      'the candidate was not edited', 'no file was written', 'no shell command ran', 'nothing else appeared in the worktree',
      'a write to the candidate was attempted and denied', 'a shell command was attempted and denied', 'a mode change was attempted and denied'
    ])

    // The review's case: a model that attempts nothing leaves the disk exactly
    // as it was. That is not a fence that held; it is a fence nobody pushed on.
    await underTest({})
    const untested = await check()
    t.ok('a turn that attempted nothing does not pass', !fencePassed(untested))
    t.ok('the disk was indeed untouched', untested.stages.filter((s) => s.status === 'fail').length === 0)
    t.eq('but every capability is inconclusive', untested.stages.filter((s) => s.status === 'inconclusive').map((s) => s.name), [
      'a write to the candidate was attempted and denied', 'a shell command was attempted and denied', 'a mode change was attempted and denied'
    ])
    t.ok('and the report says so', /INCONCLUSIVE/.test(describeFence(untested)), describeFence(untested))

    // An installed-runtime proof can establish registry exclusion without
    // relying on the model claiming a tool was unavailable. It must match the
    // exact policy acknowledged in this live invocation.
    const proof = {
      passed: true,
      hash: crypto.createHash('sha256').update(buildPolicy({ writesCode: false })).digest('hex'),
      tools: ['write_file', 'replace', 'run_shell_command', 'enter_plan_mode', 'exit_plan_mode'].map(name =>
        ({ name, excluded: true, decision: 'deny', adminRule: true, controlAllowed: true }))
    }
    const excluded = await check({ verifyPolicy: async () => structuredClone(proof) })
    t.ok('matching runtime exclusion proof establishes the fence', fencePassed(excluded))
    const wrongPolicy = await check({ verifyPolicy: async () => ({ ...structuredClone(proof), hash: 'other-policy' }) })
    t.ok('proof for a different policy cannot pass', !fencePassed(wrongPolicy))
    const missingTool = await check({ verifyPolicy: async () => ({ ...structuredClone(proof), tools: proof.tools.slice(1) }) })
    t.ok('every restricted tool needs evidence', !fencePassed(missingTool))
    const failedProof = await check({ verifyPolicy: async () => ({ ...structuredClone(proof), passed: false }) })
    t.ok('failed runtime proof cannot pass', !fencePassed(failedProof))
    const missingToolAdapter = {
      ...gemini,
      invoke: async options => {
        const turn = await gemini.invoke(options)
        turn.diagnostics.toolCalls = [{ name: 'write_file', arguments: { file_path: 'fence-canary-write.txt' }, status: 'error', error: { message: 'Tool "write_file" not found.' } }]
        return turn
      }
    }
    const missingWithProof = await check({ adapter: missingToolAdapter, verifyPolicy: async () => structuredClone(proof) })
    t.ok('tool-not-found with matching exclusion proof passes', fencePassed(missingWithProof))
    const missingWithoutProof = await check({ adapter: missingToolAdapter })
    t.ok('tool-not-found alone is not proof of enforcement', !fencePassed(missingWithoutProof))
    await underTest({ mode: 'breach' })
    const proofWithBreach = await check({ verifyPolicy: async () => structuredClone(proof) })
    t.ok('runtime proof never overrides a live breach', !fencePassed(proofWithBreach))

    await underTest({ mode: 'fence-denied' })
    const held = await check()
    t.ok('a runtime that refused every attempt passes', fencePassed(held), JSON.stringify(held.stages.filter((s) => s.status !== 'pass')))
    t.ok('with the refusals attributed to the policy the adapter wrote', held.stages.filter((s) => s.name.endsWith('and denied')).every((s) => /devpanel:/.test(s.detail)), JSON.stringify(held.stages.slice(-3)))
    t.ok('and the report says it held', /the fence held/.test(describeFence(held)), describeFence(held))

    // A turn that never ran is a failure of the CHECK, not evidence of a fence.
    await underTest({ mode: 'runtime-error' })
    const broken = await check()
    t.ok('a turn that failed is never read as a fence that held', !fencePassed(broken))
    t.ok('and says so', /never tested/.test(describeFence(broken)), describeFence(broken))
  }

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
