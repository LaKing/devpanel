import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCommand } from '../gui/server/runtime/command.mjs'
import { runProcess, ProcessError } from '../gui/server/runtime/process.mjs'
import { NL, installationProbe, probeModels, createLedger, lineObserver, cancelledError, runtimeError, childEnvironment, withReap } from './shared.mjs'
import { hostPlatform } from '../gui/server/runtime/platform.mjs'
import { applyFence, assertFenced } from './fence.mjs'
import { configGuard, guardLabel, runGuarded, configViolation, configDiagnostics, recoverPending as recoverGuard, resolveConfig as resolveGuard } from './config-guard.mjs'
import { harnessRefusal } from '../gui/server/runtime/confinement-policy.mjs'

/*
 * Gemini CLI adapter.
 *
 * Sessions are PRE-ASSIGNED, as with claude: `--session-id <uuid>` names the
 * session before the turn starts and `--resume <uuid>` reopens exactly that one.
 * The CLI also accepts `--resume latest` and `--resume <index>`; this adapter
 * never uses either. "The most recent session for this project" is not evidence
 * that a session belongs to THIS invocation — harness/README.md's rule — and an
 * unknown uuid is refused by the runtime rather than silently resolved to
 * something else, which is the behaviour that makes id-binding worth having.
 *
 * A session becomes resumable only once it holds real content: a turn that died
 * before the model answered leaves a file the runtime will not list, and
 * `--resume` on it exits non-zero with "No previous sessions found". That is the
 * right shape — the engine only ever resumes a descriptor returned by a turn that
 * COMPLETED, and a crash mid-invocation is reconciled through the ledger and the
 * marker, never by reaching for whatever session happens to be on disk.
 *
 * Tool permissions are NOT carried by approval modes. Gemini's plan mode allows
 * `exit_plan_mode` to the model itself in headless runs (policies/plan.toml,
 * v0.60.0: decision "allow", priority 70, interactive = false), and leaving plan
 * mode restores ordinary tool access, so plan mode cannot fence an auditor.
 * Enforcement here is an ADMIN-tier policy file written per invocation: admin
 * rules resolve at 5.x, above every other tier including YOLO's allow-all at
 * 1.999, so the fence holds no matter what the model or a user config asks for.
 *
 * The runtime fails OPEN around that file in three ways, and each has its own
 * guard (all three are in `invoke`):
 *
 *   1. `--admin-policy` is silently dropped when the host's system policy
 *      directory holds any `.toml` (policy/config.ts, v0.60.0: "Security
 *      Warning: Ignoring --admin-policy because system policies are already
 *      defined"). The directory is checked BEFORE launch, spending nothing, and
 *      the warning aborts the turn if it appears anyway.
 *   2. A malformed file prints "[ADMIN] Policy file error" and the run carries
 *      on in YOLO mode. That message aborts the turn.
 *   3. A missing or unread file produces no message at all. So the policy
 *      carries an ACKNOWLEDGEMENT rule (see `POLICY_CANARY_TOOL`): a rule naming
 *      a tool that does not exist, which the runtime warns about when — and only
 *      when — it has parsed the file at the admin tier. No acknowledgement on
 *      stderr, no accepted answer: the turn is an environment failure.
 *
 * Authentication is PINNED rather than requested. The runtime resolves its auth
 * method from `security.auth.selectedType` in its settings before it consults
 * any environment variable (validateNonInterActiveAuth.ts, v0.60.0), and system
 * settings outrank workspace and user settings. A connection that names a
 * credential or an account therefore runs under a controlled system settings
 * file — the host's own, with the method selected AND enforced — so neither the
 * operator's `~/.gemini` nor a `.gemini/settings.json` in the candidate can
 * route the turn through some other login.
 */

export const id = 'gemini'

export const capabilities = {
  sessionAssignment: 'preassign',
  resume: true,
  // The CLI exposes no effort or thinking control: no flag, no settings key.
  // Thinking levels exist inside its own per-model configs and are not ours to
  // set. Roster entries therefore declare `efforts: []` — supports none — rather
  // than null, which would claim nobody has looked.
  effort: false,
  structuredOutput: false,   // no schema constraint on the CLI; fenced JSON + repair
  cancellation: true,
  instructions: true
}

const COMMAND = () => resolveCommand('gemini', process.env.DEVPANEL_GEMINI_BIN)

/**
 * What the Gemini CLI needs inside the seat fence: its package (a Node script
 * with its dependencies beside it, read-only), the launcher link, its home
 * (`GEMINI_CLI_HOME` or `~/.gemini`, read-write: login and sessions), git's
 * identity, and this invocation's policy and temp directories.
 */
export async function fenceManifest ({ binary, env, writable = [], readOnly = [] }) {
  const home = os.homedir()
  const real = await fs.realpath(binary)
  const pkg = real.includes(`${path.sep}node_modules${path.sep}`) ? real.slice(0, real.lastIndexOf(`${path.sep}bundle${path.sep}`)) || path.dirname(real) : path.dirname(real)
  return {
    home,
    homeBinds: [{ path: pkg, writable: false }, { path: binary, writable: false },
      { path: env.GEMINI_CLI_HOME ?? path.join(home, '.gemini'), writable: true }, { path: path.join(home, '.gitconfig'), writable: false }],
    writable,
    readOnly
  }
}

/*
 * One turn's fence manifest. The policy directory holds the ADMIN policy and the
 * pinned system-settings copy: the turn's own fence, so it is bound read-only.
 * Nothing shows the CLI must write there (it reads both files); a seat able to
 * rewrite them could lift its own fence for a later read of the same file.
 * Only the runtime's private TMPDIR stays writable.
 */
export function turnFenceManifest ({ binary, env, policyDir, runtimeTemp = null }) {
  return fenceManifest({ binary, env, writable: runtimeTemp ? [runtimeTemp] : [], readOnly: [policyDir] })
}

/*
 * The operator's configuration in that home (config-guard.mjs, harness/README.md
 * "Seat hygiene"). It lives in `.gemini` under `GEMINI_CLI_HOME`, else in
 * `~/.gemini` (paths.ts homedir(), v0.60.0: the note under resolveConnection);
 * that directory itself stays writable (OAuth credentials, session transcripts).
 * Before a fenced seat turn the missing directories and the empty-safe file are
 * created and bound read-only; the JSON and .env files cannot be empty
 * placeholders and are integrity-checked. settings.json is the settings file
 * this adapter already reasons about (pinAuthentication); extensions, policies,
 * agents and skills exist in the runtime (the denied tools, the system policy
 * directory); their user directories, `commands`, GEMINI.md, trustedFolders.json
 * and .env are taken from the CLI's published behaviour, not verified from its
 * source.
 */
export const CONFIGURATION_DIRS = Object.freeze(['extensions', 'commands', 'policies', 'agents', 'skills'])
export const EMPTY_SAFE_FILES = Object.freeze(['GEMINI.md'])
export const CHECKED_FILES = Object.freeze(['settings.json', 'trustedFolders.json', '.env'])
const LEDGER_FILE = 'gemini-ledger.jsonl'

/** The configuration guard for the home a connection resolves to. */
export function configGuardFor (env) {
  const bindRoot = env.GEMINI_CLI_HOME ?? path.join(os.homedir(), '.gemini')
  const base = env.GEMINI_CLI_HOME ? path.join(env.GEMINI_CLI_HOME, '.gemini') : bindRoot
  return configGuard({ bindRoot, base, ensureBase: Boolean(env.GEMINI_CLI_HOME), dirs: CONFIGURATION_DIRS, emptyFiles: EMPTY_SAFE_FILES, checkedFiles: CHECKED_FILES })
}
const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PROFILE_ROOT = () => process.env.DEVPANEL_GEMINI_PROFILE_ROOT ?? path.join(os.homedir(), '.config/devpanel/gemini-profiles')

/**
 * Where the runtime keeps host-wide configuration (Storage.getSystemConfigDir,
 * v0.60.0). Its `policies/` subdirectory is what decides whether `--admin-policy`
 * is honoured at all, and its `settings.json` is the layer that outranks every
 * other settings file. `DEVPANEL_GEMINI_SYSTEM_CONFIG_DIR` exists so the suite
 * can stage a host that has system policies; the runtime itself always reads the
 * platform directory, so a wrong override only disables the pre-launch check —
 * the runtime's own warning and the missing acknowledgement still stop the turn.
 */
export const systemConfigDir = () => process.env.DEVPANEL_GEMINI_SYSTEM_CONFIG_DIR ?? hostPlatform().geminiSystemConfigDir
const systemPoliciesDir = () => path.join(systemConfigDir(), 'policies')
/** The system settings file the runtime would read (GEMINI_CLI_SYSTEM_SETTINGS_PATH wins, as in the runtime). */
const hostSystemSettingsPath = (env) => env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? path.join(systemConfigDir(), 'settings.json')

/**
 * Everything a login could be inherited from. Cleared before an explicit
 * selection is made: a home nobody has logged into must fail as unauthenticated,
 * not quietly succeed as whoever is authenticated ambiently and file the work
 * under someone else's account.
 */
const INHERITABLE = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GEMINI_BASE_URL'
]

/**
 * Turn a connection into the environment a process will actually run with.
 *
 * Shared by probe() and invoke(), for the reason the claude adapter states: a
 * probe that echoes one connection but launches under another proves nothing
 * about the connection it claims.
 *
 * `applied.authType` is the runtime's own name for the method this connection
 * requires (AuthType, v0.60.0), or null for the ambient route. It is what
 * `invoke` pins in the controlled system settings; the environment variables
 * below are set as well, because the pinned method still needs its credential.
 */
export function resolveConnection ({ profile = 'default', endpointRef = null, credentialRef = null, account = null, hygiene = false } = {}) {
  // Under hygiene the child starts from an allow-list (shared.mjs childEnvironment).
  const env = hygiene ? childEnvironment('gemini') : { ...process.env }
  const applied = { profile, endpointRef, credentialRef, account, endpoint: false, credential: false, auth: 'ambient', authType: null }

  /*
   * An account is another PERSON's login on the same provider.
   *
   * Gemini keeps its whole state — settings, OAuth credentials, session
   * transcripts — under a home directory it reads from `GEMINI_CLI_HOME`
   * (paths.ts homedir(), v0.60.0), with `.gemini` beneath it. That is the lever,
   * not the process HOME: overriding HOME would drag git, npm and ssh
   * configuration along with it and change far more than which login is used.
   */
  if (account) {
    if (endpointRef || credentialRef) {
      return { env, applied, error: `connection names both an account ("${account}") and an endpoint/credential: it is either another person's login or another provider, never both` }
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(account)) return { env, applied, error: `account "${account}" must be lowercase letters, digits and hyphens` }
    for (const key of INHERITABLE) delete env[key]
    env.GEMINI_CLI_HOME = accountDir(account)
    // Name the auth method as well as the directory. Without this an account
    // whose directory has no login could fall through to whatever method the
    // host has configured; with it, an un-logged-in home is an authentication
    // failure, which is the only honest outcome.
    env.GOOGLE_GENAI_USE_GCA = 'true'
    applied.auth = 'login'
    applied.authType = 'oauth-personal'
    return { env, applied, error: null }
  }

  if (profile === 'default' && !credentialRef && !endpointRef) return { env, applied, error: null }

  let endpoint, credential
  try {
    endpoint = deref(endpointRef)
    credential = deref(credentialRef)
  } catch {
    return { env, applied, error: `profile "${profile}" has an unreadable or unsupported endpoint/credential reference` }
  }

  // An unresolvable reference must NOT fall through to the ambient login.
  if (!credential) {
    return { env, applied, error: `profile "${profile}" cannot be resolved: ${credentialRef ?? 'credentialRef'} not set` }
  }
  if (endpointRef && !endpoint) {
    return { env, applied, error: `profile "${profile}" cannot be resolved: ${endpointRef} not set` }
  }

  for (const key of INHERITABLE) delete env[key]
  env.GEMINI_API_KEY = credential
  applied.credential = true
  applied.auth = 'api-key'
  applied.authType = 'gemini-api-key'
  if (endpoint) { env.GOOGLE_GEMINI_BASE_URL = endpoint; applied.endpoint = true; applied.authType = 'gateway' }
  /*
   * Every credential route gets a home of its own, the default profile included.
   * The operator's `~/.gemini` holds their own settings and login; a keyed
   * connection that ran under it would mix its sessions with theirs and, before
   * authentication was pinned, could have been routed through their login by a
   * `selectedType` they set for themselves.
   */
  const namespace = crypto.createHash('sha256').update(`${profile}${NL}${endpoint ?? 'default'}`).digest('hex').slice(0, 16)
  env.GEMINI_CLI_HOME = path.join(PROFILE_ROOT(), namespace)
  return { env, applied, error: null }
}

/**
 * Where one account's login lives. Named by the account rather than hashed,
 * because a person has to log into it by hand, once:
 *
 *   GEMINI_CLI_HOME=~/.config/devpanel/gemini-profiles/account-ana gemini
 */
export function accountDir (account) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(account)) throw new Error(`account "${account}" must be lowercase letters, digits and hyphens`)
  return path.join(PROFILE_ROOT(), `account-${account}`)
}

/** Resolve a roster reference. Only references are stored; values live here. */
function deref (ref) {
  if (!ref) return null
  const [kind, ...rest] = ref.split(':')
  const name = rest.join(':')
  if (kind === 'env') return process.env[name] ?? null
  if (kind === 'file') {
    const file = name.startsWith('~/') ? path.join(os.homedir(), name.slice(2)) : path.resolve(CONFIG_ROOT, name)
    return readFileSync(file, 'utf8').trim()
  }
  if (kind === 'agent') return null
  throw new Error('unsupported reference type')
}

// --- the permission fence -------------------------------------------------------

/*
 * Tool names as registered by the runtime (v0.60.0). Enumerated rather than
 * matched by `readOnlyHint`, so a tool that arrives later — or one whose
 * annotation changes — is denied by the catch-all instead of being allowed by a
 * description of itself.
 */
const READ_TOOLS = ['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory']
const BOOKKEEPING_TOOLS = ['write_todos', 'update_topic', 'complete_task']
const NETWORK_TOOLS = ['web_fetch', 'google_web_search']
const WRITE_TOOLS = ['write_file', 'replace']
const SHELL_TOOLS = ['run_shell_command', 'list_background_processes', 'read_background_output']
// Mode transitions and anything that runs work we have not fenced. `exit_plan_mode`
// is allowed to the model in headless runs by the shipped plan policy, so it is
// denied here explicitly rather than left to a mode we do not rely on anyway.
const ESCALATION_TOOLS = ['enter_plan_mode', 'exit_plan_mode', 'invoke_agent', 'activate_skill', 'take_snapshot', 'ask_user']

/**
 * The acknowledgement rule's tool name. It names NO tool: `glob_` is one
 * character from `glob`, which is what makes the runtime say so. Loading a
 * policy, the runtime warns about every rule whose tool name it does not
 * recognise but which is within three edits of one it does (validateToolName,
 * policy/config.ts v0.60.0), and prints that warning as
 *
 *   [WARNING] [ADMIN] Policy file warning in <file>:
 *
 * with the TIER it loaded the file at. That line is the only positive evidence
 * the runtime gives that the file was parsed at all; reading the file back from
 * disk proves only that this adapter can read what it wrote. The rule itself is
 * a deny at the lowest priority, so if a tool of this name ever appears it is
 * denied, not allowed.
 */
export const POLICY_CANARY_TOOL = 'glob_'

/** The line the runtime prints when it has loaded `fileName` at the admin tier. */
export const acknowledgementPattern = (fileName) =>
  new RegExp(`\\[ADMIN\\] Policy file warning in ${escapeRegex(fileName)}:`)

/** What the runtime prints when the fence is NOT in force. Each one aborts the turn. */
const REJECTION_PATTERNS = [
  /\[ADMIN\] Policy file error[^\n]*/,
  /Ignoring --admin-policy[^\n]*/
]

const toml = (value) => Array.isArray(value)
  ? `[${value.map((v) => JSON.stringify(v)).join(', ')}]`
  : JSON.stringify(value)

const escapeRegex = (text) => text.replace(/[-[\]{}()*+?.,\\^$|#\s"]/g, '\\$&')

/**
 * Argument patterns that match a `file_path` under `root`, the way the policy
 * engine sees it. The engine matches `argsPattern` against a stable
 * serialisation of the tool's RAW arguments (policy/stable-stringify.ts,
 * v0.60.0): keys sorted, every top-level `"key":value` pair wrapped in NUL
 * characters, values JSON-encoded. So a write to /a/b/c is checked against
 *
 *   {\0"content":"…"\0,\0"file_path":"/a/b/c"\0}
 *
 * and a root is denied by its JSON-encoded spelling followed by `/` or the
 * closing quote, which is what keeps `/a/b` from also matching `/a/bc`.
 */
function rootPattern (root) {
  const encoded = escapeRegex(JSON.stringify(root).slice(1, -1))
  return `\\x00"file_path":"${encoded}(/|")`
}

/**
 * Spellings of a file path that are not its canonical one. The policy is
 * checked before the runtime resolves the path, so a rule that names a root by
 * its spelling is only as good as the spelling the model chose:
 * `/worktree/../evidence/x`, `/a/./evidence/x` and `/a//evidence/x` all land
 * inside a read-only root after resolution and none of them contains the root's
 * spelling. Rather than enumerate equivalents, every non-canonical spelling is
 * refused: a `..` segment, a `.` segment and an empty segment (`//`), anywhere.
 * What remains is one spelling per file, and that spelling is what the root
 * rules match. Several plain patterns rather than one alternation: the runtime
 * rejects a pattern with a quantifier inside a group that is itself quantified,
 * and plain patterns cannot trip that check.
 */
const SPELLING_PATTERNS = [
  ['a `..` segment', '\\x00"file_path":"\\.\\.(/|")'],
  ['a `..` segment', '\\x00"file_path":"[^\\x00]*/\\.\\.(/|")'],
  ['a `.` segment', '\\x00"file_path":"\\.(/|")'],
  ['a `.` segment', '\\x00"file_path":"[^\\x00]*/\\.(/|")'],
  ['an empty segment (`//`)', '\\x00"file_path":"[^\\x00]*//'],
  // The runtime strips NUL characters before it resolves the path, so
  // `ven\0dor` names `vendor`; the serialiser encodes the NUL as `\u0000`.
  ['a NUL character', '\\x00"file_path":"[^\\x00]*\\\\u0000']
]

/** Is `child` equal to `parent` or beneath it, both already resolved. */
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/**
 * The admin-tier policy for one turn.
 *
 * Deny-by-default, then name what this seat may do. Priorities are within the
 * admin tier, which resolves above user, workspace and default rules — including
 * `--approval-mode yolo`, whose allow-all lives in the default tier. An
 * allow-list that misses something therefore fails CLOSED (the tool is denied),
 * which is the direction a permission mistake should fail in.
 *
 * `readOnlyRoots` are directories a WRITING seat may read but not change: the
 * engine's evidence directory, a project's configured roots. Gemini has no
 * read-only workspace root (`--include-directories` grants reads and writes
 * together), so the file tools are denied into those roots by argument pattern,
 * and the shell — which no path rule can reach — is denied outright for the
 * turn. The alternative was to refuse the seat; a writer with file tools and no
 * shell is still a writer, and the engine runs the checks itself.
 *
 * `carveOuts` are the writable areas (the worktree, scratch) that lie BENEATH a
 * read-only root, in which case the root is denied as a whole and each of them
 * is allowed back by spelling. Exempting the root instead would have exempted
 * every sibling in it. A read-only root that itself lies inside a carve-out
 * outranks the carve-out, so the order of nesting never decides who wins.
 *
 * Exported so the test suite can assert the artifact the runtime is handed,
 * rather than assert that the adapter meant well.
 */
export function buildPolicy ({ supervisorOnly = false, writesCode = false, networkAccess = false, readOnlyRoots = [], carveOuts = [] } = {}) {
  const shellFenced = writesCode && readOnlyRoots.length > 0
  const allowed = supervisorOnly
    ? []
    : [
        ...READ_TOOLS, ...BOOKKEEPING_TOOLS,
        ...(networkAccess ? NETWORK_TOOLS : []),
        ...(writesCode ? [...WRITE_TOOLS, ...(shellFenced ? [] : SHELL_TOOLS)] : [])
      ]

  const lines = [
    '# devpanel — generated per invocation, admin tier.',
    '# Admin rules resolve at 5.x, above YOLO\'s allow-all at 1.999: nothing the',
    '# model, the user config or an approval mode asks for can widen this.',
    '',
    '# 0. Acknowledgement. This names no tool. The runtime warns about a rule it',
    '#    does not recognise, naming this file and the tier it loaded it at, and',
    '#    that warning is the only evidence that this file was read at all. The',
    '#    adapter refuses the turn\'s answer unless it appeared.',
    '[[rule]]',
    `toolName = ${toml(POLICY_CANARY_TOOL)}`,
    'decision = "deny"',
    'priority = 1',
    '',
    '# 1. Nothing, unless named below.',
    '[[rule]]',
    'toolName = "*"',
    'decision = "deny"',
    'priority = 100',
    'denyMessage = "devpanel: this tool is not available to this role."',
    ''
  ]

  if (allowed.length) {
    lines.push(
      '# 2. What this role may use.',
      '[[rule]]',
      `toolName = ${toml(allowed)}`,
      'decision = "allow"',
      'priority = 110',
      ''
    )
  }

  lines.push(
    '# 3. Never, for any role: MCP servers this panel did not configure.',
    '[[rule]]',
    'toolName = "*"',
    'mcpName = "*"',
    'decision = "deny"',
    'priority = 130',
    'denyMessage = "devpanel: MCP tools are not available."',
    '',
    '# 4. Never, for any role: mode transitions, subagents, skills, prompts.',
    '#    Plan mode auto-approves its own exit in headless runs, so a role that',
    '#    could enter it could also leave it and take its write tools back.',
    '[[rule]]',
    `toolName = ${toml(ESCALATION_TOOLS)}`,
    'decision = "deny"',
    'priority = 140',
    'denyMessage = "devpanel: mode changes, subagents and skills are not available."',
    ''
  )

  if (!writesCode && !supervisorOnly) {
    // Redundant against the catch-all, and kept on purpose: a future edit that
    // widens the allow-list still cannot hand a non-writing role the ability to
    // change the candidate, because this rule outranks the allow.
    lines.push(
      '# 5. A role that is not the writer cannot write or run commands, and this',
      '#    outranks the allow-list above so widening that list cannot undo it.',
      '[[rule]]',
      `toolName = ${toml([...WRITE_TOOLS, ...SHELL_TOOLS])}`,
      'decision = "deny"',
      'priority = 150',
      'denyMessage = "devpanel: this role is read-only; source and Git state are not yours to change."',
      ''
    )
  }

  if (shellFenced) {
    lines.push(
      '# 6. Roots this role may read but must not change. They are mounted',
      '#    read-only for this turn; that mount is the boundary. These rules name',
      '#    them so a refused write is explained. The runtime matches a rule',
      '#    against the tool\'s RAW arguments, before it resolves the path, so',
      '#    each root is denied by its spellings and every other spelling of a',
      '#    path (a `..`, `.`, empty segment or NUL) is refused outright below, at',
      '#    a higher priority than anything that allows a write. The shell is',
      '#    denied for the turn.',
      '[[rule]]',
      `toolName = ${toml(SHELL_TOOLS)}`,
      'decision = "deny"',
      'priority = 155',
      `denyMessage = ${toml(`devpanel: the shell is not available in this turn; ${readOnlyRoots.join(', ')} must stay read-only and no shell rule can guarantee that.`)}`,
      ''
    )
    for (const root of readOnlyRoots) {
      // A root nested inside a writable carve-out outranks the carve-out.
      const nested = carveOuts.some((area) => within(root, area))
      lines.push(
        '[[rule]]',
        `toolName = ${toml(WRITE_TOOLS)}`,
        `argsPattern = ${toml(rootPattern(root))}`,
        'decision = "deny"',
        `priority = ${nested ? 164 : 160}`,
        `denyMessage = ${toml(`devpanel: ${root} is read-only for this role.`)}`,
        ''
      )
    }
    for (const area of carveOuts) {
      lines.push(
        '# 6a. A writable area beneath a read-only root: the root stays denied,',
        '#     this area alone is allowed back, by its spelling only.',
        '[[rule]]',
        `toolName = ${toml(WRITE_TOOLS)}`,
        `argsPattern = ${toml(rootPattern(area))}`,
        'decision = "allow"',
        'priority = 162',
        ''
      )
    }
    lines.push(
      '# 7. Only the canonical spelling of a path is accepted, so the rules above',
      '#    see the same path the runtime will resolve. Above every allow.'
    )
    for (const [what, pattern] of SPELLING_PATTERNS) {
      lines.push(
        '[[rule]]',
        `toolName = ${toml(WRITE_TOOLS)}`,
        `argsPattern = ${toml(pattern)}`,
        'decision = "deny"',
        'priority = 165',
        `denyMessage = ${toml(`devpanel: a file path with ${what} is refused; name the file by its resolved path inside the worktree or scratch.`)}`,
        ''
      )
    }
  }

  return lines.join(NL)
}

/**
 * Which of a turn's roots a writing seat may not change: every root that is not
 * exactly a writable area (scratch, the worktree), compared by resolved path.
 * A root that CONTAINS a writable area is still read-only — exempting it would
 * exempt its every sibling — and the area beneath it is returned as a carve-out.
 * Each is returned in its configured spelling and, when it differs, its
 * resolved one, and — for a root inside the working directory — its relative
 * one, because the policy matches the spelling the model uses. These spellings
 * are what the policy DENIES BY NAME so the model is told why; what keeps the
 * roots unchanged is the read-only mount (`mountReadOnly`), which does not care
 * how a path was spelled or what it was resolved through.
 */
async function readOnlyRootsFor (roots, writable, cwd) {
  const real = async (p) => fs.realpath(p).catch(() => path.resolve(p))
  const areas = []
  for (const area of writable.filter(Boolean)) areas.push({ spellings: [path.resolve(area), await real(area)], resolved: await real(area) })
  const here = cwd ? await real(cwd) : null
  const spellings = (configured, resolved) => {
    const out = [path.resolve(configured), resolved]
    if (here && within(resolved, here) && resolved !== here) out.push(path.relative(here, resolved))
    return [...new Set(out)]
  }
  const readOnly = []
  const carve = []
  const resolvedRoots = []
  for (const root of roots) {
    const resolved = await real(root)
    if (areas.some((a) => a.resolved === resolved)) continue
    resolvedRoots.push(resolved)
    for (const s of spellings(root, resolved)) if (!readOnly.includes(s)) readOnly.push(s)
    for (const a of areas) {
      if (!within(a.resolved, resolved)) continue
      for (const s of new Set(a.spellings)) if (!carve.includes(s)) carve.push(s)
    }
  }
  return { readOnlyRoots: readOnly, carveOuts: carve, resolvedRoots: [...new Set(resolvedRoots)] }
}

const BWRAP = () => resolveCommand('bwrap', process.env.DEVPANEL_BWRAP_BIN)

/**
 * The boundary that does not depend on spelling: each read-only root is bind-
 * mounted read-only over itself (bubblewrap, the same tool the claude sandbox
 * uses), in a mount namespace the turn's process tree cannot leave. The kernel
 * applies the mount to whatever a path RESOLVES to — a relative spelling, a
 * stripped NUL, a chain of links through a directory outside the worktree, a
 * shell — so no transformation the runtime applies before writing can reach
 * around it, and a hard link out of the mount is refused as cross-device.
 *
 * The mount is PROVED before the model is launched: a shell in the same
 * sandbox tries to create a file in every root and every attempt must fail.
 * A root that is not an existing directory cannot be mounted and refuses the
 * turn — as does a missing bubblewrap, or a namespace the host will not grant —
 * since a fence that could not be put up is not a fence.
 *
 * Returns the bubblewrap arguments the turn is to be launched with.
 */
async function mountReadOnly (resolvedRoots, { invocationId, signal }) {
  const refuse = (message) => new ProcessError(message, { kind: 'environment-error', started: false, invocationId })
  for (const root of resolvedRoots) {
    const stat = await fs.stat(root).catch(() => null)
    if (!stat?.isDirectory()) throw refuse(`read-only root ${root} is not an existing directory, so it cannot be mounted read-only for this turn`)
  }
  const argv = ['--die-with-parent', '--dev-bind', '/', '/', ...resolvedRoots.flatMap((root) => ['--ro-bind', root, root])]
  const script = 'status=0; for d in "$@"; do f="$d/.devpanel-ro-probe-$$"; if ( : > "$f" ) 2>/dev/null; then rm -f "$f"; echo "WRITABLE $d"; status=1; else echo "READ-ONLY $d"; fi; done; exit $status'
  let probe
  try {
    probe = await runProcess({ command: BWRAP(), args: [...argv, '--', '/bin/sh', '-c', script, 'devpanel-ro-probe', ...resolvedRoots], signal, stdin: '', maxBuffer: 65536 })
  } catch (error) {
    throw refuse(`bubblewrap is unavailable (${error.message}); a gemini writer with read-only roots needs it to mount ${resolvedRoots.join(', ')} read-only`)
  }
  const lines = probe.stdout.split(NL)
  const unproved = resolvedRoots.filter((root) => !lines.includes(`READ-ONLY ${root}`))
  if (probe.cancelled) throw cancelledError(probe.termination)
  if (probe.code !== 0 || unproved.length) {
    const detail = (probe.stderr.trim() || lines.filter((l) => l.startsWith('WRITABLE')).join('; ') || `exit ${probe.code}`).slice(0, 400)
    throw refuse(`the read-only mount for ${unproved.length ? unproved.join(', ') : resolvedRoots.join(', ')} could not be proved before launch: ${detail}`)
  }
  return argv
}

/**
 * The names of the system policy files that would make the runtime drop
 * `--admin-policy`. Mirrors the runtime's own test (policy/config.ts, v0.60.0:
 * any `.toml` entry in the system policies directory); an unreadable directory
 * other than a missing one is reported as such rather than assumed empty.
 */
export async function systemPolicyFiles () {
  try {
    return (await fs.readdir(systemPoliciesDir())).filter((f) => f.endsWith('.toml')).sort()
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
}

/**
 * Pin the authentication method in a controlled SYSTEM settings file.
 *
 * The runtime picks `security.auth.selectedType` from its merged settings before
 * it looks at any environment variable, and system settings outrank workspace
 * and user settings (settings.ts mergeSettings, v0.60.0). Setting the variables
 * alone therefore does not select the method: an operator's `~/.gemini` that
 * selects their Google login, or a `.gemini/settings.json` inside the candidate,
 * would win. The file written here is the host's own system settings with the
 * connection's method both selected and ENFORCED, so a mismatch anywhere is a
 * refused start rather than a different login. The host's system defaults keep
 * their own path, which the runtime would otherwise derive from ours.
 */
async function pinAuthentication (env, applied, dir, invocationId) {
  if (!applied.authType) return null
  const hostPath = hostSystemSettingsPath(env)
  const refuse = (message) => new ProcessError(message, { kind: 'configuration-error', started: false, invocationId })
  let host = {}
  let raw = null
  try {
    raw = await fs.readFile(hostPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw refuse(`gemini system settings ${hostPath} cannot be read (${error.code}); refusing to launch without knowing what the host enforces`)
  }
  if (raw !== null) {
    try { host = JSON.parse(raw) } catch { throw refuse(`gemini system settings ${hostPath} are not plain JSON; refusing to guess what the host enforces`) }
    if (!host || typeof host !== 'object' || Array.isArray(host)) throw refuse(`gemini system settings ${hostPath} are not a JSON object; refusing to guess what the host enforces`)
  }
  const enforced = host.security?.auth?.enforcedType
  if (enforced && enforced !== applied.authType) {
    throw refuse(`gemini system settings ${hostPath} enforce authentication "${enforced}"; this connection needs "${applied.authType}"`)
  }
  const pinned = {
    ...host,
    security: { ...(host.security ?? {}), auth: { ...(host.security?.auth ?? {}), selectedType: applied.authType, enforcedType: applied.authType } }
  }
  const file = path.join(dir, 'system-settings.json')
  await fs.writeFile(file, JSON.stringify(pinned, null, 2), 'utf8')
  env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? path.join(path.dirname(hostPath), 'system-defaults.json')
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = file
  return { selectedType: applied.authType, enforcedType: applied.authType, hostSettings: hostPath, merged: raw !== null }
}

export async function probe ({ depth = 'installation', models = [], profile = 'default', endpointRef = null, credentialRef = null, account = null, signal = null, timeoutMs = 120000, hygiene = false } = {}) {
  const result = await installationProbe(COMMAND(), { id, depth, models, profile, endpointRef, credentialRef, account, capabilities })
  if (result.installation.status !== 'installed' || depth === 'installation') return result

  // Resolve the connection FIRST: an unresolvable one is a single authentication
  // error, not N model failures that each spent a call.
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) {
    result.usage = { tokens: 0, costUsd: 0, costUnknownCalls: 0 }
    result.invocations = 0
    result.authentication = { status: 'error', detail: connection.error }
    for (const model of models) result.modelAccess[model] = { status: 'unknown', detail: connection.error }
    return result
  }
  result.connection = { ...result.connection, applied: connection.applied }

  // The CLI reports tokens, never money: every paid call counts as unknown.
  const probeInvoke = hygiene ? (options) => invoke({ ...options, hygiene }) : invoke
  return probeModels(result, { invoke: probeInvoke, models, profile, endpointRef, credentialRef, account, signal, timeoutMs, costKnown: false })
}

const { record, reconcile: reconcileLedger } = createLedger(LEDGER_FILE, { guarded: true })

/** The ledger's answer, plus what the configuration guard left pending (codex.mjs reconcile). */
export async function reconcile (invocationId, options = {}) {
  const evidence = await reconcileLedger(invocationId, options)
  if (!options.ledgerDir) return evidence
  const pending = await recoverGuard({ ledgerFile: path.join(options.ledgerDir, LEDGER_FILE), invocationId })
  return pending?.integrity?.violations?.length ? { ...evidence, integrity: pending.integrity } : evidence
}
export const recoverPending = ({ ledgerDir, invocationId = null }) => recoverGuard({ ledgerFile: path.join(ledgerDir, LEDGER_FILE), invocationId })
export const resolveConfig = (invocationId, { ledgerDir }) => resolveGuard({ ledgerFile: path.join(ledgerDir, LEDGER_FILE), invocationId })

/**
 * One turn. An error raised after the runtime ran carries its descendant scan
 * (shared.mjs withReap), so the engine never retries on unproved cleanup.
 */
export async function invoke (options) {
  const ran = {}
  try { return await invokeOnce(options, ran) } catch (error) { throw withReap(error, ran.run) }
}

async function invokeOnce ({
  session,
  model,
  effort,
  cwd,
  instructions,
  prompt,
  marker,
  signal,
  meta = {},
  ledgerDir = null,
  profile = 'default',
  endpointRef = null,
  credentialRef = null,
  account = null,
  graceMs = 5000,
  supervisorOnly = false,
  scratchDir = null,
  observe = null,
  maxBuffer = undefined,
  tooling = null,
  hygiene = false,
  // The run's paths for the seat fence (fence.namespace: 1, harness/fence.mjs).
  fence: fenceSpec = null,
  // A coordinator turn that may read (Phase 1): Gemini's non-writer policy
  // (read tools, no shell) when a fence is requested, tool-free otherwise.
  readOnlyTools = false,
  // The host's OS (platform.mjs); injectable so a test can be darwin.
  platform = hostPlatform(),
  // Called once the seat fence is proved, before the launch (codex.mjs).
  afterFence = null
} = {}, ran = {}) {
  const invocationId = meta.invocationId ?? crypto.randomUUID()
  // Before anything is written, probed or launched: every Gemini seat is
  // refused on a host without bubblewrap (owner decision 3), whoever calls.
  const refusal = harnessRefusal(id, { platform })
  if (refusal) throw new ProcessError(refusal, { kind: 'environment-error', started: false, invocationId })
  if (readOnlyTools && fenceSpec) supervisorOnly = false

  // Declared unsupported, so being asked for one is a configuration fault, not
  // something to drop on the floor and run anyway at an unknown effort.
  if (effort) {
    throw new ProcessError(`gemini exposes no effort control; "${effort}" cannot be honoured`, {
      kind: 'configuration-error', started: false, invocationId
    })
  }

  const writesCode = Boolean(tooling?.writesCode) && !supervisorOnly
  const policyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-gemini-'))
  // Named by invocation, so the runtime's acknowledgement names THIS turn's file.
  const policyName = `devpanel-${String(invocationId).replace(/[^A-Za-z0-9._-]/g, '-')}.toml`
  const policyFile = path.join(policyDir, policyName)
  let runtimeTemp = null
  let fenced = null
  let config = null

  try {
    /*
     * Guard 1: the runtime drops `--admin-policy` when the host's system policy
     * directory holds any `.toml`, and says so only in a warning. Checked here,
     * before anything is spent: a host configured that way cannot run a fenced
     * turn at all, and the remedy belongs to the operator.
     */
    const systemPolicies = await systemPolicyFiles()
    if (systemPolicies.length) {
      throw new ProcessError(`gemini would ignore devpanel's permission policy: system policies exist in ${systemPoliciesDir()} (${systemPolicies.join(', ')}) and the runtime drops --admin-policy when they do; remove them or run this seat on another harness`, {
        kind: 'environment-error', started: false, invocationId
      })
    }

    // The workspace is what file tools may touch at all: the runtime refuses any
    // path outside it (WorkspaceContext.isPathWithinWorkspace). The project's live
    // checkout is therefore fenced by being absent, not by a rule.
    const workspaceDirs = []
    let readOnlyRoots = []
    let carveOuts = []
    let sandboxArgv = null
    const enforcement = {
      reads: 'workspace-scoped',
      writes: supervisorOnly ? 'denied' : writesCode ? 'workspace-scoped' : 'denied',
      shell: writesCode ? 'not-fenceable' : 'denied',
      mcp: 'denied',
      modeTransitions: 'denied',
      subagents: 'denied',
      workspace: workspaceDirs,
      readOnlyRoots,
      liveCheckout: 'outside the workspace',
      policy: { file: policyName, acknowledged: false }
    }

    if (tooling && !supervisorOnly) {
      for (const root of tooling.allowedRoots ?? []) {
        // `--include-directories` takes directories only: given a file the CLI exits ("Path is not a directory").
        // A single-file root (a consult's project configuration) is reached through its parent directory, and only
        // for a read seat that asked for a fence: inside it the parent holds nothing the fence did not bind, and
        // that turn never runs unfenced (refused below). Anywhere else the file stays outside the workspace, named.
        const isFile = await fs.stat(root).then((s) => !s.isDirectory(), () => false)
        if (!isFile) { workspaceDirs.push(root); continue }
        const parent = path.dirname(root)
        if (readOnlyTools && fenceSpec) { if (!workspaceDirs.includes(parent)) workspaceDirs.push(parent) } else (enforcement.unreachableRoots ??= []).push(root)
      }
      if (tooling.allowLiveCheckout && tooling.liveCheckout) {
        /*
         * Gemini has no read-only workspace root: `--include-directories` grants
         * a directory to the file tools for reading AND writing. For a role that
         * may write, "you may read the live checkout" cannot be expressed without
         * also granting writes to it — so it is refused rather than approximated.
         * Nothing in the normal catalogue asks for this (allowLiveCheckout
         * defaults to false); a playbook that does needs claude or codex.
         */
        if (writesCode) {
          throw new ProcessError('gemini cannot grant read-only access to the live checkout for a role that writes source: its workspace roots are readable and writable together', {
            kind: 'configuration-error', started: false, invocationId
          })
        }
        workspaceDirs.push(tooling.liveCheckout)
        enforcement.liveCheckout = 'in the workspace, read-only by policy'
      }
      if (writesCode) {
        /*
         * Every root but scratch is read-only for the writer too — the engine's
         * evidence directory, a project's configured roots — and the same grant
         * that lets the file tools read them lets them write. The policy denies
         * the writes by argument pattern and takes the shell away for the turn,
         * because no rule can keep a shell out of a directory.
         */
        const fence = await readOnlyRootsFor(tooling.allowedRoots ?? [], [cwd, scratchDir], cwd)
        readOnlyRoots = fence.readOnlyRoots
        carveOuts = fence.carveOuts
        enforcement.readOnlyRoots = readOnlyRoots
        if (readOnlyRoots.length) {
          /*
           * The policy names the roots so the model is told why a write was
           * refused; the MOUNT is what keeps them unchanged, whatever the path
           * was spelled as or resolved through. Proved before anything is spent.
           */
          sandboxArgv = await mountReadOnly(fence.resolvedRoots, { invocationId, signal })
          enforcement.sandbox = { tool: 'bwrap', argv: sandboxArgv, readOnlyMounts: fence.resolvedRoots, proved: true }
          enforcement.writes = 'workspace-scoped; read-only roots mounted read-only (proved), and denied by argument pattern'
          enforcement.shell = 'denied for this turn'
          if (carveOuts.length) enforcement.carveOuts = carveOuts
        }
      }
    }

    /*
     * Guard 2 and 3 are set up here. The file is verified after writing (a fence
     * the runtime cannot read is not a fence), and the runtime's own complaint
     * about it, or its silence, aborts the turn below.
     */
    const policy = buildPolicy({ supervisorOnly, writesCode, networkAccess: Boolean(tooling?.networkAccess), readOnlyRoots, carveOuts })
    enforcement.policy.sha256 = crypto.createHash('sha256').update(policy).digest('hex')
    await fs.writeFile(policyFile, policy, 'utf8')
    if (await fs.readFile(policyFile, 'utf8').catch(() => null) !== policy) {
      throw new ProcessError('gemini permission policy could not be written; refusing to launch a turn without its fence', {
        kind: 'configuration-error', started: false, invocationId
      })
    }

    // Pre-assign on the first turn; resume exactly that id afterwards.
    const sessionId = session?.id ?? crypto.randomUUID()

    /*
     * `-p ''` with the body on stdin: the CLI appends the -p value to stdin, so
     * an empty one delivers the prompt verbatim, the way the other adapters do,
     * without a megabyte of prompt passing through argv.
     */
    const args = [
      '-p', '',
      '--output-format', 'stream-json',
      // Every worktree is a directory the runtime has never seen. Headless runs
      // refuse to start in an untrusted one, so trust is stated explicitly.
      '--skip-trust',
      // Approval modes are UI, not permission: the admin policy above is what
      // decides. yolo keeps allowed tools from stalling on a confirmation that
      // nothing can answer in a headless run.
      '--approval-mode', 'yolo',
      '--admin-policy', policyFile
    ]
    if (session?.id) args.push('--resume', session.id)
    else args.push('--session-id', sessionId)
    if (model) args.push('--model', model)
    for (const dir of workspaceDirs) args.push('--include-directories', dir)

    const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
    if (connection.error) {
      throw new ProcessError(connection.error, { kind: 'configuration-error', profile, account, invocationId })
    }
    const env = connection.env
    // Extensions and their policies are configuration this panel did not write.
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true'
    if (supervisorOnly) { delete env.DEVPANEL_TOKEN; delete env.DEVPANEL_TOKEN_FILE }
    enforcement.authentication = await pinAuthentication(env, connection.applied, policyDir, invocationId) ?? { selectedType: null, enforcedType: null, hostSettings: null, merged: false }
    /*
     * Durable artifacts belong in scratch, but the runtime's own temporary files
     * belong nowhere near the candidate: TMPDIR is what `os.tmpdir()` resolves to
     * inside the CLI, and a stray temp file written under the worktree would
     * become part of the revision the fingerprint measures. A throwaway directory
     * keeps that impossible even if scratch were ever handed to us inside the
     * workspace. It is reported on the turn so the suite can hold the adapter to
     * it without depending on what the child process happens to see.
     */
    if (scratchDir) env.DEVPANEL_SCRATCH_DIR = scratchDir
    let runtimeTempReport = null
    if (scratchDir) {
      env.TMPDIR = runtimeTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-gemini-tmp-'))
      runtimeTempReport = { path: runtimeTemp, mode: (await fs.stat(runtimeTemp)).mode & 0o777 }
    }

    const body = [
      instructions ? `${instructions}${NL}${NL}` : '',
      prompt,
      marker ? `${NL}${NL}[${marker}]` : ''
    ].join('')

    await record(ledgerDir, { invocationId, marker, phase: 'started', sessionId, at: new Date().toISOString() })

    /*
     * The runtime reporting that it could not load our policy — or dropped it —
     * is the one thing that must stop a turn mid-flight: everything it does after
     * that point is unfenced, so its answer is not something to accept. So is a
     * tool running before the policy was acknowledged.
     */
    const environmentAbort = new AbortController()
    let policyFailure = null
    const events = streamObserver(observe, {
      acknowledgement: acknowledgementPattern(policyName),
      policyName,
      onPolicyFailure (failure) {
        if (policyFailure || signal?.aborted) return
        policyFailure = failure
        environmentAbort.abort()
      }
    })
    const invocationSignal = signal ? AbortSignal.any([signal, environmentAbort.signal]) : environmentAbort.signal
    // The outer seat fence wraps everything, the adapter's own read-only
    // sandbox included (it then binds within the fenced view).
    // afterFence (chat's replay) runs inside applyFence, after the first proof and before preparation.
    fenced = fenceSpec ? await applyFence({ spec: { ...fenceSpec, cwd }, command: COMMAND(), signal, guard: configGuardFor(env), replay: afterFence,
      manifest: await turnFenceManifest({ binary: COMMAND(), env, policyDir, runtimeTemp }) }) : null
    assertFenced(fenced, { turn: 'a fenced Gemini turn', mounts: fenceSpec?.mounts ?? [] })
    // A read seat's policy was written before the fence was tried, so here it already holds read tools. Where
    // DEVPANEL_FENCE_UNPROVED=run lets other turns go on unfenced, this one would read its roots with nothing masked
    // (a consult's roots hold the panel's token); the other adapters fall back to a tool-free turn, this one refuses.
    if (readOnlyTools && fenceSpec && !fenced?.applied) {
      throw new ProcessError(`a Gemini read seat gets its read tools only inside a proved seat fence, and the fence could not be proved: ${fenced?.reason ?? 'no fence'}`, {
        kind: 'environment-error', started: false, invocationId
      })
    }
    const inner = { command: sandboxArgv ? BWRAP() : COMMAND(), args: sandboxArgv ? [...sandboxArgv, '--', COMMAND(), ...args] : args }
    const launch = fenced?.applied ? fenced.wrap(inner.command, inner.args) : inner
    // The operator's configuration (config-guard.mjs): checked after the turn
    // whatever its ending; a violation fails it before anything else.
    config = fenced?.applied ? fenced.config ?? null : null
    let guarded
    try {
      guarded = await runGuarded({ config, label: guardLabel(meta, invocationId), ledgerFile: ledgerDir ? path.join(ledgerDir, LEDGER_FILE) : null, invocationId, context: meta.questionId ? { questionId: meta.questionId } : null },
        () => runProcess({
          command: launch.command,
          args: launch.args,
          cwd, env, stdin: body, signal: invocationSignal, graceMs, maxBuffer, observe: events.hooks, reap: true, reapTag: meta.reapTag ?? null
        }))
    } catch (error) {
      // Only a guard refusal before the launch is "not started"; the check
      // after the launch is returned with the run, never thrown.
      if (error.started === false) await record(ledgerDir, { invocationId, marker, phase: 'not-started', error: error.message, at: new Date().toISOString() })
      throw error
    }
    const run = guarded.run
    if (run) ran.run = run
    if (guarded.integrity?.violations.length) {
      await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, error: 'cli-config-integrity', at: new Date().toISOString() })
      throw configViolation(guarded.integrity, { cli: 'gemini', run, thrown: guarded.thrown ?? (policyFailure ? new Error(`the permission policy was not loaded: ${policyFailure}`) : null), invocationId })
    }
    if (guarded.thrown) {
      const error = guarded.thrown
      if (error.kind === 'spawn-error' && error.started === false) {
        await record(ledgerDir, { invocationId, marker, phase: 'not-started', error: error.message, code: error.code, at: new Date().toISOString() })
      }
      throw error
    }

    // Checked BEFORE cancellation: the abort above is how the turn was stopped,
    // and reporting it as a cancellation would hide why.
    if (policyFailure) {
      await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, classification: 'environment', error: policyFailure, at: new Date().toISOString() })
      throw new ProcessError(`gemini could not load its permission policy: ${policyFailure}`, {
        kind: 'environment-error', invocationId, termination: run.termination
      })
    }

    if (run.cancelled) {
      await record(ledgerDir, { invocationId, marker, phase: 'cancelled', sessionId, at: new Date().toISOString() })
      throw cancelledError(run.termination)
    }

    const seen = events.seen
    const payload = seen.result ?? finalResult(run.stdout)

    if (run.code !== 0) {
      await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, at: new Date().toISOString() })
      throw runtimeError(`gemini exited ${run.code}`, {
        code: run.code,
        // The runtime's own message is what classification reads; the exit code
        // alone says nothing about whether this was a quota, an auth fault or a bug.
        stderr: [payload?.error?.message, run.stderr.trim()].filter(Boolean).join(NL).slice(0, 2000),
        stdout: run.stdout.slice(-2000),
        payload,
        invocationId
      })
    }

    /*
     * Guard 3: silence is not consent. A runtime that never parsed the file says
     * nothing about it, and would have run every tool the model asked for. The
     * answer is refused as an environment failure, whatever it says.
     */
    if (!events.acknowledged) {
      const failure = `no "[ADMIN] Policy file warning in ${policyName}" appeared on stderr, so there is no evidence the runtime loaded the fence at the admin tier`
      await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, classification: 'environment', error: failure, at: new Date().toISOString() })
      throw new ProcessError(`gemini never acknowledged its permission policy: ${failure}; the answer is not accepted`, {
        kind: 'environment-error', invocationId, stderr: run.stderr.trim().slice(-2000)
      })
    }
    enforcement.policy.acknowledged = true

    if (!payload) {
      throw runtimeError('gemini produced no result record', { stdout: run.stdout.slice(0, 500), invocationId })
    }
    if (payload.status === 'error') {
      throw runtimeError(`gemini reported an error: ${payload.error?.type ?? 'unknown'}`, {
        stderr: payload.error?.message ?? null, payload, invocationId
      })
    }

    /*
     * Continuity is the point of a session. The runtime echoes the id it opened
     * in its `init` event; anything else means this turn ran somewhere other than
     * where the last one left off, which must fail rather than quietly become a
     * fresh conversation carrying none of the run's history.
     */
    const reported = seen.sessionId ?? sessionId
    if (reported !== sessionId) {
      await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, reported, at: new Date().toISOString() })
      throw runtimeError(`gemini reported session ${reported} for a turn launched as ${sessionId}`, { invocationId })
    }

    const response = seen.text ?? ''

    // Google semantics: the prompt total already includes the cached share, which
    // is reported separately and must not be added again. `total_tokens` is the
    // runtime's own total across every model it used for this turn.
    const stats = payload.stats ?? {}
    const usage = {
      provider: 'google',
      inputTokens: stats.input_tokens ?? null,
      outputTokens: stats.output_tokens ?? null,
      cacheCreationTokens: null,
      cacheReadTokens: stats.cached ?? null,
      tokens: stats.total_tokens ?? ((stats.input_tokens ?? 0) + (stats.output_tokens ?? 0)),
      // The CLI reports no money at all, for any auth method.
      costUsd: null
    }

    await record(ledgerDir, {
      invocationId, marker, phase: 'completed',
      sessionId: reported, response, usage, at: new Date().toISOString()
    })

    return {
      session: { id: reported },
      response,
      usage,
      outcome: 'completed',
      diagnostics: {
        durationMs: run.durationMs,
        reap: run.leftovers?.scan ?? null,
        events: events.count,
        hygiene: Boolean(hygiene),
        fence: fenceSpec ? { namespace: fenced?.applied ? 1 : 0, reason: fenced?.reason ?? null, proof: fenced?.proof ?? null, mounts: fenced?.mounts ?? null, config: configDiagnostics(config) } : null,
        tooling: supervisorOnly || tooling ? enforcement : null,
        // What the consult panel and a coordinator's `access: read` turn branch on, as claude and codex report it:
        // 'read' only when the read tools ran inside a proved fence.
        ...(readOnlyTools ? { access: fenced?.applied === true ? 'read' : 'none (fence not proved)' } : {}),
        // Every tool the runtime reported running, with what the policy said.
        // This is what a fence check reads: an attempt that was DENIED is
        // evidence the fence held; a turn with no attempts proves nothing.
        toolCalls: events.toolCalls,
        runtimeTemp: runtimeTempReport
      }
    }
  } finally {
    await fs.rm(policyDir, { recursive: true, force: true }).catch(() => {})
    if (runtimeTemp) await fs.rm(runtimeTemp, { recursive: true, force: true }).catch(() => {})
  }
}

// --- the event stream ---------------------------------------------------------

/** Every JSON line in stdout, in order; non-JSON lines are progress noise. */
function jsonLines (text) {
  const out = []
  for (const line of text.split(NL)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* not an event */ }
  }
  return out
}

/** The last `result` record, the fallback for what the observer may have missed. */
function finalResult (stdout) {
  return [...jsonLines(stdout)].reverse().find((e) => e.type === 'result') ?? null
}

/**
 * What one stream event says the runtime is doing. Liveness only: a tool call
 * proves the process is working, not that the answer is close.
 */
export function describeEvent (e) {
  if (!e || typeof e !== 'object') return null
  if (e.type === 'init') return { kind: 'system', detail: e.model ?? null }
  if (e.type === 'message') return e.role === 'assistant' ? { kind: 'text', detail: null } : { kind: 'system', detail: e.role ?? null }
  if (e.type === 'tool_use') return { kind: 'tool-use', detail: e.tool_name ?? e.name ?? null }
  if (e.type === 'tool_result') return { kind: 'tool-result', detail: e.status ?? null }
  if (e.type === 'error') return { kind: 'error', detail: e.error?.type ?? null }
  if (e.type === 'result') return { kind: 'result', detail: e.status ?? null }
  return { kind: e.type ?? 'event', detail: null }
}

/** The arguments worth keeping from a tool call: where it aimed, never file content. */
const ARGUMENT_KEYS = ['file_path', 'dir_path', 'path', 'command', 'pattern', 'url', 'query']
function summariseArguments (parameters) {
  if (!parameters || typeof parameters !== 'object') return {}
  const out = {}
  for (const key of ARGUMENT_KEYS) if (typeof parameters[key] === 'string') out[key] = parameters[key].slice(0, 500)
  return out
}
const MAX_TOOL_CALLS = 200

/**
 * Assistant text arrives as deltas — one event per chunk — so the response is
 * accumulated here, and consecutive text deltas are collapsed into one activity
 * record. Liveness is "it is still writing", not one entry per token; the raw
 * chunks still reach the live view through `observe.onOutput`.
 *
 * Tool calls are kept by id (`tool_use` then `tool_result`, v0.60.0 stream-json)
 * with the policy's verdict on each, and the policy's own fate is read off
 * stderr: the acknowledgement that names this turn's file, or a complaint.
 */
function streamObserver (observe, { acknowledgement = null, policyName = null, onPolicyFailure = () => {} } = {}) {
  const seen = { sessionId: null, text: null, result: null }
  const calls = new Map()
  let acknowledged = false
  let lastWasText = false
  let stderrTail = ''
  const observer = lineObserver({
    observe,
    describeEvent: (e) => {
      const described = describeEvent(e)
      const isText = described?.kind === 'text'
      if (isText && lastWasText) return null
      lastWasText = isText
      return described
    },
    onEvent: (e) => {
      if (e?.type === 'init' && e.session_id) seen.sessionId = e.session_id
      if (e?.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') seen.text = (seen.text ?? '') + e.content
      if (e?.type === 'result') seen.result = e
      if (e?.type === 'tool_use') {
        // A tool is running. Without the acknowledgement it is running unfenced.
        if (acknowledgement && !acknowledged) onPolicyFailure(`the runtime began running tools (${e.tool_name ?? e.name ?? 'unnamed'}) before acknowledging the permission policy ${policyName}`)
        if (calls.size < MAX_TOOL_CALLS) {
          const id = e.tool_id ?? `#${calls.size}`
          calls.set(id, { id, name: e.tool_name ?? e.name ?? null, arguments: summariseArguments(e.parameters ?? e.input), status: 'pending', error: null })
        }
      }
      if (e?.type === 'tool_result') {
        const call = calls.get(e.tool_id)
        if (call) {
          call.status = e.status ?? 'unknown'
          call.error = e.error ? { type: e.error.type ?? null, message: String(e.error.message ?? '').slice(0, 500) } : null
        }
      }
    }
  })
  return {
    get count () { return observer.count },
    get acknowledged () { return acknowledged },
    get toolCalls () { return [...calls.values()] },
    seen,
    hooks: {
      ...observer.hooks,
      onOutput (stream, chunk) {
        observer.hooks.onOutput(stream, chunk)
        if (stream !== 'stderr') return
        // Buffered, because the complaint and its detail arrive in pieces and a
        // message split across two chunks would otherwise go unnoticed.
        stderrTail = (stderrTail + chunk).slice(-4000)
        if (acknowledgement && !acknowledged && acknowledgement.test(stderrTail)) acknowledged = true
        for (const pattern of REJECTION_PATTERNS) {
          const failure = pattern.exec(stderrTail)
          if (failure) { onPolicyFailure(failure[0].trim().slice(0, 500)); break }
        }
      }
    }
  }
}
