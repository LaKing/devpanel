# DeepSeek and Gemini

The roster includes DeepSeek V4.1 Flash (`deepseek-flash`) and DeepSeek V4 Pro
(`deepseek-v4-pro`). Both run through Claude Code, using the provider's
Anthropic-compatible API. They can be selected
for playbook participants (including coordinators) and the dashboard supervisor.
Existing playbook selections are unchanged.

## Configuration

| Provider | Endpoint file | Credential file |
|---|---|---|
| DeepSeek | `providers/deepseek.endpoint` | `~/.config/deepseek/key` |

Endpoint files contain a URL. Credential files contain only the API key and should
be readable only by the service account. Other tools of the same account may share
these credential locations; no keys are copied into this repository. `~` is the
home directory of the account running devpanel.

Each roster YAML configures `model`, `profile`, `endpointRef`, and `credentialRef`.
References support `env:VARIABLE`, `file:/absolute/path`, `file:~/path`, and
`file:relative/path` (relative to the configuration root containing the harness).
For example, an installation can use `credentialRef: env:DEEPSEEK_API_KEY` instead
of a key file. Missing, empty, or unreadable references stop invocation before
launch; a provider profile never falls back to the default Claude account.

Provider sessions live under `~/.config/devpanel/claude-profiles/`, separated by
profile and endpoint. Override the parent with `DEVPANEL_CLAUDE_PROFILE_ROOT`.
Keep that location persistent so native sessions can resume. These sessions are
separate from workflows and the default Claude account. Changing a supervisor's
model or connection reference starts a fresh session.

Claude's primary and internal model selectors are pinned to the roster's exact
wire identifier. In particular, DeepSeek documents that unknown model names can
silently select Flash. Check that the account's `/models` response lists the
identifiers the roster names (`deepseek-flash`, `deepseek-v4-pro`).

DeepSeek's [September 10 release notes](https://api-docs.deepseek.com/updates/)
confirm that `deepseek-flash` serves V4.1 Flash. The retired V4 Flash identifiers
temporarily route to V4.1 Flash too. `deepseek-v4-pro` continues to serve V4 Pro.
The Flash identifier tracks provider updates; it is not a fixed model version.

The adapter preserves worktree/scratch handling, cancellation, runtime output,
and tooling restrictions. Provider author turns use Claude's `acceptEdits`
permission mode; supervisor turns disable tools. Effort overrides remain disabled
in these roster entries until their runtime mapping is separately verified.
Token usage is recorded under the profile name (`deepseek`); monetary cost is unknown because
Claude's Anthropic price estimate is not the provider's bill.

## Verification

Each exact model identifier is verified with two real adapter invocations: a
fresh session writes a random marker to an isolated temporary file, then the
resumed session recalls it with tools disabled, and the native session ID must be
retained. Verification applies to the installation and account that ran it, whose
evidence stays in its own host configuration; every installation checks its own
credentials and access. Tests use fake credentials and subprocesses.

Run `cd gui && npm run config:check` to validate configuration. Restart the
running devpanel service after updating adapter code so cached supervisor modules
use the new implementation.

Provider reference: [DeepSeek's Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/).
The GLM entries that used the same route (Z.ai's endpoint) were retired on 2026-11-07;
the `profile` mechanism is unchanged, so another Anthropic-compatible provider can be
added the same way.


# Gemini

Gemini models run through Google's own **Gemini CLI** (`harness/gemini.mjs`), not
through a compatibility endpoint. Google publishes no Anthropic-compatible API, so
the DeepSeek route — the claude adapter with an endpoint substituted — does not
apply, and putting a translating proxy in the path would add a permanent moving
part to every run. The roster carries `gemini-4-argon` (the Gemini 3.x entries were retired on
2026-11-07); an installation verifies it with its configured API key through
session-resume checks and live fence checks, supplemented by installed-runtime
policy evidence (`npm run policy:gemini`), and keeps the reports with its own roster
copy.

## Installing and authenticating

```sh
npm install -g @google/gemini-cli        # or any location on the service PATH
```

`DEVPANEL_GEMINI_BIN` overrides the binary, as with the other runtimes. The CLI
offers three authentication methods, and the adapter never leaves the choice to
whatever the host happens to have configured:

| Roster field | Method | Where the credential lives |
|---|---|---|
| `credentialRef` | AI Studio API key | `~/.config/gemini/key`, or `env:GEMINI_API_KEY` |
| `account` | a person's Google login | `~/.config/devpanel/gemini-profiles/account-<name>` |
| *(unset)* | whatever the host is configured for | the operator's own `~/.gemini` |

An `account` is another PERSON's login, exactly as for claude and codex. Gemini
keeps settings, credentials and session transcripts under one home directory,
which it reads from `GEMINI_CLI_HOME`; the adapter points that at a directory of
the account's own, clears every inheritable credential (`GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_CLOUD_PROJECT`, …) and selects the login method explicitly, so a directory
nobody has logged into fails as *unauthenticated* rather than answering as whoever
the host is logged in as. The process `HOME` is left alone — overriding it would
move git, npm and ssh configuration too. A `credentialRef` connection gets a home
of its own as well (`~/.config/devpanel/gemini-profiles/<hash>`), the default
profile included, so its sessions never mix with the operator's. Each person logs
in once, by hand:

```sh
GEMINI_CLI_HOME=~/.config/devpanel/gemini-profiles/account-ana gemini
```

`npm run contract` checks that the installed CLI still honours that variable, and
fails rather than skips if an isolated home ever reports a login.

**The method is pinned, not merely requested.** The runtime resolves its auth
method from `security.auth.selectedType` in its merged settings *before* it looks
at any environment variable (`validateNonInterActiveAuth.ts`, v0.60.0), and
system settings outrank the workspace's and the user's. Setting `GEMINI_API_KEY`
therefore selects nothing by itself: an operator's `~/.gemini` that selects their
Google login, or a `.gemini/settings.json` inside the candidate, would decide
instead. So every connection that names a credential or an account runs under a
**controlled system settings file**: the host's own `/etc/gemini-cli/settings.json`
(or whatever `GEMINI_CLI_SYSTEM_SETTINGS_PATH` names), copied per invocation with
the connection's method both *selected* and *enforced*, handed to the runtime
through `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, with the host's system defaults kept
at their own path. A host whose system settings enforce a different method is a
configuration conflict, refused before launch. The ambient route — no credential,
no account — pins nothing and runs exactly as the host is configured. The host's
system settings must be plain JSON; a file the adapter cannot parse is refused
rather than guessed at.

## Sessions

Sessions are **pre-assigned**: `--session-id <uuid>` names the session before the
turn, and `--resume <uuid>` reopens exactly that one. The CLI also accepts
`--resume latest` and `--resume <index>`; the adapter never sends either, because
"the most recent session for this project" is not evidence that a session belongs
to the invocation being recovered. The runtime echoes the session it opened in its
`init` event, and a turn that reports a different one fails rather than continuing
as a fresh conversation.

A session becomes resumable only once it holds real content. A turn that died
before the model answered leaves a file the runtime will not list, and resuming it
exits non-zero with *No previous sessions found for this project*. The engine only
resumes descriptors returned by turns that completed, so this surfaces as an honest
failure rather than a silent new conversation; a crash mid-invocation is reconciled
through the adapter ledger and the marker instead.

## Permissions are a policy file, not a mode

Gemini's plan mode cannot fence a role in a headless run. The shipped policy
(`packages/core/src/policy/policies/plan.toml`, v0.60.0) allows `exit_plan_mode`
to the model itself when `interactive = false`, and leaving plan mode restores
ordinary tool access. Approval modes are therefore treated as UI, and the fence is
an **admin-tier policy file written per invocation**: admin rules resolve at 5.x,
above the user, workspace and default tiers — including YOLO's allow-all at 1.999
— so nothing the model, a user config or an approval mode asks for can widen them.

The policy denies everything by default and then names what the seat may do:

| Seat | May use | May not |
|---|---|---|
| author (`writesCode`) | read tools, `write_file`, `replace`, `run_shell_command` | MCP, subagents, skills, mode transitions |
| any other role | read tools only | writing, shell, MCP, subagents, skills, mode transitions |
| supervisor | nothing | everything, including reads |

Two consequences are worth knowing before choosing this harness for a seat:

- **A Gemini seat that is not the source writer has no shell and no scratch
  writes.** The runtime has no per-path write rule, so "read-only" is expressed by
  denying the write and shell tools outright. A Gemini coordinator or auditor can
  read, search and reason; it cannot run the test suite or leave notes in scratch.
  Claude and codex auditors can, inside a sandbox.
- **`allowLiveCheckout` cannot be honoured for a writing seat.** Gemini's
  `--include-directories` grants a directory to the file tools for reading and
  writing together, with no read-only workspace root, so the adapter refuses the
  launch instead of quietly granting writes to the live checkout. The normal
  catalogue never asks for this (`allowLiveCheckout` defaults to false).

**The runtime fails open around this file, so the adapter does not.** Three
ways, each with its own guard:

1. **System policies displace it.** When `/etc/gemini-cli/policies/` holds any
   `.toml`, the runtime drops `--admin-policy` altogether and says so only in a
   warning (`Security Warning: Ignoring --admin-policy …`, `policy/config.ts`
   v0.60.0). The adapter checks that directory *before launching* — a fence that
   would be ignored is not launched, and nothing is spent — and aborts the turn if
   the warning appears anyway.
2. **A malformed file** prints `[ADMIN] Policy file error` and the run carries on
   in YOLO mode. That line aborts the turn: the process group is terminated and an
   environment failure is recorded.
3. **A missing or unread file** produces no message at all. So the adapter does
   not take silence for consent: the policy carries an **acknowledgement rule**,
   naming a tool that does not exist (`glob_`, one character from `glob`). The
   runtime warns about a rule whose tool it does not recognise but nearly does,
   and prints that warning with the tier it loaded the file at —
   `[WARNING] [ADMIN] Policy file warning in devpanel-<invocation>.toml:` — before
   it runs anything. That line is the only positive evidence the runtime gives
   that the file was parsed, at the admin tier, for *this* turn. Without it the
   turn is an environment failure: at the first tool call if one arrives first,
   otherwise when the answer does. Reading the file back from disk, which the
   adapter also does, proves only that it can read what it wrote.

A runtime that stops printing that warning would fail every Gemini turn until
the adapter is updated. That is the intended direction: a fence whose presence
cannot be confirmed is treated as absent.

Everything outside the workspace is unreachable to the file tools regardless of
policy, so the live checkout is fenced by absence rather than by a rule.

**Read-only roots for a writing seat.** The engine grants every seat its evidence
directory and a project's configured `allowedRoots`, and all of them but scratch
are read-only. Gemini's workspace grant is read-write, and any rule that names a
path is only as good as the spelling the model chose: the runtime resolves
relative paths, strips NUL characters and follows symbolic links *after* the
policy has matched the raw arguments, so `/a/./evidence/x`, `vendor/x` from the
worktree, `ven\0dor/x` and `alias/nested/x` through a chain of links all reach a
root that no spelling rule named (each reproduced against the installed 0.60.0
engine and its write tool). The boundary is therefore not a spelling. For a
writer turn with read-only roots the adapter launches the runtime through
bubblewrap with every root bind-mounted **read-only over itself**, in a mount
namespace the turn's process tree cannot leave. The kernel applies the mount to
whatever a path resolves to — relative, NUL-stripped, through links, from a
shell — and a hard link out of the mount is refused as cross-device. The mount is
**proved before the model is launched**: a shell in the same sandbox tries to
create a file in every root and every attempt must fail. A root that is not an
existing directory, a missing bubblewrap, or a namespace the host will not grant
refuses the turn before anything is spent; a fence that could not be put up is
not a fence. The turn records `tooling.sandbox` with the exact bubblewrap
arguments and the mounted roots.

The policy still names the roots, so a refused write is *explained* to the model
rather than merely failing with `EROFS`: `write_file` and `replace` into each
root are denied by argument pattern under the root's configured, resolved and —
inside the worktree — relative spelling, every non-canonical spelling (a `..`,
`.` or empty segment, a NUL) is refused above any allow, a root that *contains*
the worktree or scratch is denied whole with only those areas allowed back, and a
root inside one of them outranks the carve-out. The shell tools are denied for
the turn as before; the mount would fence them from the roots too, so restoring
the shell to a fenced writer is now a policy choice rather than an impossibility.
A writer with file tools and no shell is still a writer; the engine runs the
checks itself. When scratch is the only extra root nothing is mounted and the
writer keeps its shell, recorded as unfenceable exactly as Bash is under claude.

`npm run policy:gemini` hands the generated policies — the auditor's, and the
writer's under an evidence root, under a root above the worktree and scratch,
and under a root inside the worktree (with its relative and NUL spellings) — to
the installed CLI's own policy engine and records every decision under
`gui/live/reports/`. The auditor's hash is what the paid fence check binds to a
live turn; the writer's decisions are the engine's own, on the exact bytes the
adapter generates. The mount itself is exercised by the offline suite
(`gemini.test.mjs`, section 2g) with a shell inside the sandbox trying every
route above.

## What this harness does not report

No effort control exists — no flag, no setting — so roster entries declare
`efforts: []` (supports none), and an effort override is refused rather than
dropped. No cost is reported for any authentication method, so runs draw on the
unpriced allowance; token counts are recorded, with the cached share kept separate
and not added twice.

The panel supervisor is still restricted to claude and codex
(`top-supervisor-service.mjs`). The adapter implements the supervisor restriction —
a policy that denies every tool — but whether a Gemini model holds to the
one-JSON-object-per-reply discipline the supervisor requires is unverified, and
that is a claim about model behaviour, not about connectivity.

## Verifying

Two bounded checks establish model access, session continuity and the permission fence.
Run from `gui/`; `--credential-ref` selects the same key as the roster:

```sh
DEVPANEL_LIVE=1 npm run live -- --harness gemini --model gemini-4-argon --credential-ref 'file:~/.config/gemini/key'
DEVPANEL_LIVE=1 npm run live -- --harness gemini --model gemini-4-argon --credential-ref 'file:~/.config/gemini/key' --fence
```

The first is the two-turn session check: access, and continuity across processes.
The second asks a read-only role to edit a file, create a file, run a shell command
and change its own mode. Its verdict has two halves: the filesystem afterwards,
and the runtime's own record of every tool call (`diagnostics.toolCalls`, with
the policy's verdict on each). A pass needs *both*: nothing changed on disk, and
each restricted capability was either attempted and refused, or independently
verified as excluded by the installed runtime as described below. Without either
kind of evidence, an untouched disk leaves the check **inconclusive**. Confirm
the wire identifier against the account's own model list at the same time — an
unrecognised name is a silent-substitution risk here as it is with DeepSeek — and
only then set `verification.status: verified`, quoting the report path.

### Gemini fence verification and excluded tools

Gemini CLI 0.60.0 removes statically denied tools from its tool registry. A model
may therefore make no restricted calls, or receive `Tool "write_file" not found`,
instead of a policy-denial event. The live fence checker supplements those cases
with the installed CLI's own TOML parser and policy engine. It verifies that both
write tools, the shell, and both mode-transition tools are excluded and that
forced calls are denied by admin rules even above a permissive lower tier.
A control without the admin policy must allow those calls, and reads must remain
available. No tool is executed by this local policy-engine check.

The proof is accepted only when its policy SHA-256 matches the policy acknowledged
by the live turn. Actual successful restricted calls or filesystem changes still
fail verification. Missing evidence remains inconclusive. The installed-runtime
check is pinned to the inspected 0.60.0 bundle layout and fails closed on an
unsupported version; it is outside the offline test suite.
