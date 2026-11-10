# Harness adapters

A harness is a *runtime* — the thing that runs a model and keeps a session. It is
not a model, and not a provider. `deepseek-flash` is not an adapter; it is the
`claude` adapter under its `deepseek` profile, which substitutes the endpoint and
credential referenced by the roster entry. `gemini` IS an adapter: Google publishes no
Anthropic-compatible endpoint, so there is nothing to substitute, and its
permission model is different enough to need its own code. See
[provider configuration](../docs/model-providers.md).

Adapters live here as `<id>.mjs`. No adapter is loaded during milestone 1 — this
file is the contract they will be written against.

`shared.mjs` holds the provider-independent parts: the installation probe and
the paid model-access probe loop, the per-invocation ledger and its
reconciliation, the line-buffered event observer, the read-only scratch check and
the cancelled/runtime error shapes. An adapter still supplies how a turn is
launched (arguments, environment, sandboxing), `describeEvent` and what each
stream event contributes (session id, usage, the final message), and how the
provider's usage is normalised into the `usage` record below.

## Contract

```js
export const id = 'claude'

/** Availability, version and capabilities. Never throws; reports unavailable. */
export async function probe()
// → { id, available, version, capabilities: { sessionAssignment, resume,
//     effort, structuredOutput, cancellation, instructions }, diagnostics }

/** OPTIONAL, outside the contract: what the runtime itself recorded about a
 *  session, read off its own files — never off the model's answer. The live
 *  checks use it to read back the effort a turn was actually sent with
 *  (`codex` reads `turn_context` lines from the session's rollout under
 *  `$CODEX_HOME/sessions`). Read-only; null when nothing names the session. */
export async function inspectSession({ session, profile, endpointRef, credentialRef, account })
// → { file, sessionId, cliVersion, turns: [{ turnId, at, model, effort }] } | null

/** One turn. Establishes the native session on the first call. */
export async function invoke({
  session,        // null on the first turn; the persisted descriptor thereafter
  model,          // wire identifier from the roster entry
  effort,         // null when the model declares efforts: []
  cwd,            // the run's isolated worktree
  instructions,   // role instructions, when capabilities.instructions
  prompt,         // the turn prompt — often authored by the coordinator
  outputSchema,   // the agent-output contract this turn must satisfy
  marker,         // opaque string the adapter must embed in the session
  signal          // AbortSignal
})
// → { session, response, usage, outcome }
```

`outcome` is one of `completed`, `refused`, `truncated`, `cancelled`, `error` —
how the invocation ended, distinct from what the agent said.

`session` is opaque and persisted verbatim; its shape differs per harness and the
engine never interprets it beyond passing it back.

## Why `start()` was rejected

An earlier draft had `start()` create an empty session and `send()` use it. Not
every runtime can do that. `claude` can pre-assign an id (`--session-id <uuid>`);
`codex` only yields one after the first `exec` returns. The contract therefore
lets the native session **arrive with the first turn**, and `sessionAssignment`
tells the engine which world it is in:

| | `preassign` | `discover` |
|---|---|---|
| Session id known before launch | yes | no |
| Crash mid-first-turn | reconcile by id | needs marker evidence |
| Worst case | retry safely | `recovery-required` |

### Gemini: the fence is a policy file, not a mode

Two of this contract's rules land differently on the Gemini CLI, and both are
worth stating here rather than leaving in one adapter's comments.

**A permission MODE is not a fence.** Gemini's plan mode auto-approves its own
`exit_plan_mode` when the run is non-interactive (`policies/plan.toml`, v0.60.0),
and leaving plan mode restores ordinary tool access — so a role fenced by a mode
can unfence itself. The adapter writes an **admin-tier policy file** per
invocation instead: admin rules resolve above the user, workspace and default
tiers, including YOLO's allow-all, and the generated policy denies everything
before naming what the seat may use. Mode transitions, subagents, skills and MCP
are denied for every seat; write and shell tools only reach the source writer;
the supervisor gets no allow rule at all. An allow-list that misses something
therefore fails CLOSED, which is the direction a permission mistake should fail in.

**The runtime fails open around that file, three ways.** It drops
`--admin-policy` with only a warning when the host's system policy directory holds
any `.toml`; a malformed file prints `[ADMIN] Policy file error` and the run
continues in YOLO mode; a missing one is ignored silently. So the adapter checks
the system policy directory before launching, aborts on either warning, and
requires a positive acknowledgement: the policy carries a rule naming a tool that
does not exist, the runtime warns about it naming the file and the ADMIN tier,
and a turn without that line on stderr is an environment failure — its answer is
never accepted. An adapter whose fence can be absent without anyone noticing has
no fence, and reading the file back proves only that the adapter can read.

**Authentication is pinned in system settings.** The runtime chooses its auth
method from its merged settings before the environment, and system settings win.
A connection that names a credential or an account therefore runs under a
per-invocation copy of the host's system settings with the method selected and
enforced (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`), so neither the operator's own
`~/.gemini` nor a settings file inside the candidate can reroute the turn.

**Read-only cannot be expressed per path, so it is expressed per argument.**
There is no read-only workspace root: `--include-directories` grants reading and
writing together. A non-writing Gemini seat has no write and no shell tools at
all — it cannot run tests or write scratch notes. A writing seat given read-only
roots (the engine's evidence directory, a project's configured roots) is launched
through bubblewrap with every root bind-mounted read-only over itself, proved from
inside the sandbox before the model runs; the mount holds whatever a path is
spelled as or resolved through (relative, NUL-stripped, via links, from a shell).
The policy additionally denies writes into the roots by argument pattern so the
model is told why, refuses every non-canonical spelling (`..`, `.`, empty
segments, NUL) above any allow, denies a root that contains the worktree or scratch
whole with only those areas allowed back, and denies the shell for the turn. A
root that cannot be mounted, or a host without bubblewrap, refuses the turn. A
writing seat asked to also read the live checkout is refused rather than quietly
granted writes to it. `npm run policy:gemini` proves the generated policies
against the installed engine.

## Recovery

The engine writes `pendingInvocation` — including a unique `invocationId` and the
`marker` — **before** launching. After a crash, an invocation in that state is
uncertain: it may already have modified the worktree, so it is reconciled before
anything is retried.

For `discover` adapters, "resume the most recent session" is **not** acceptable
evidence. A concurrent run on the same harness can easily own a more recent
session. Reconciliation requires evidence tying a discovered session to *this*
`invocationId` — which is why `marker` is part of the contract and must be
embedded where the adapter can later read it back. Without such evidence the
participant enters `recovery-required` and a human decides.

Silently starting a fresh session would break the continuity the whole design
rests on, and is never an acceptable fallback.

## Cancellation must terminate the process

**Racing a promise against an abort signal does not stop anything.** It stops
*waiting*. The child process keeps running, keeps writing to the workspace, and
keeps spending money — while the engine believes the turn is over and may release
the workspace to something else.

An adapter's cancellation path must therefore:

1. Signal the child process, and **its children** — agent runtimes spawn tool
   processes, and killing only the parent orphans them.
2. Escalate if it does not exit (`SIGTERM`, then `SIGKILL` after a grace period).
3. **Await confirmed termination** — the process is reaped and no descendant of it
   survives.
4. Only then report the invocation as cancelled.

The engine relies on that ordering: `invocationStoppedAt` is what gates releasing
workspace ownership, and it is set when `invoke()` reports the abort. If the
adapter reports early, the engine hands the worktree away while a live process is
still writing to it.

The fake harness in `gui/test/fakes/harness.mjs` races the signal, which is enough
to establish the *engine's* behaviour — that it stops the loop, leaves nothing
pending, and orders the release correctly. It establishes nothing about process
termination. **Real adapter tests must prove the process and its descendants are
actually gone**, by pid, after cancellation and after a deadline abort.

The same applies to the wall-clock deadline: it aborts through the same signal, so
it inherits exactly this obligation.

## Seat hygiene (`fence.hygiene: 1`)

New runs resolve with `fence: { hygiene: 1 }` (`FENCE_POLICY` in
`gui/server/config/load.mjs`), frozen in the snapshot; the engine passes it to
`invoke()` as `hygiene`, and preflight passes it to `probe()`. Runs resolved
before it keep today's behaviour. Runless tool-free turns (top-level
supervisor, model oracle, performance probe) always pass `hygiene: true`.

- **Environment.** The child environment is built by `childEnvironment()` in
  `shared.mjs`: ordinary process settings (PATH, HOME, locale, `XDG_*`,
  certificates, proxies, nvm) plus the variables of the one provider the runtime
  talks to (`ANTHROPIC_`/`CLAUDE_`, `OPENAI_`/`CODEX_`, `GEMINI_`/`GOOGLE_`).
  Nothing named `DEVPANEL_*` is inherited; the panel token, database references,
  other providers' keys and `SSH_AUTH_SOCK` never reach a seat.
  `DEVPANEL_CHILD_ENV_PASS` (names, or `PREFIX*`) lets the test suite hand its
  fake CLIs their control variables.
- **Claude workers:** `--setting-sources project` (the repository's `CLAUDE.md`
  and project settings load; the operator's user settings — permission mode,
  allow rules such as `git push`, plugins — do not), `--strict-mcp-config` with
  no servers (no claude.ai connectors), `--tools` naming `WORKER_TOOLS`,
  `--permission-mode acceptEdits`, and `WORKER_ALLOW` (`Read`, `WebFetch`,
  `WebSearch`, `Task`, …) plus `sandbox.autoAllowBashIfSandboxed` in
  `--settings`, which keeps today's reach without the per-call `auto`
  classifier. Deny rules and the Bash sandbox are unchanged.
- **Codex workers:** `--ignore-user-config --ignore-rules` and the stated
  `WORKER_SETTINGS` (approval never, no MCP servers, apps, plugins, memories,
  browser or computer use); sandbox mode and network per turn as before.
- **Gemini:** the allow-listed environment; its admin policy already states
  everything else.
- **Project tooling** (`workspace.tooling.mounts` / `commands` in
  `projects/<id>.yaml`, docs/project-infrastructure.md "Seat tooling"). The
  engine's fence spec carries `mounts: [{ source, target }]`: each source is
  bound READ-ONLY at its worktree-relative target, proved before launch (a
  directory, a write refused, a sentinel entry of the source visible), and a
  source that does not exist refuses the turn naming it, and so does a turn
  no proved fence would bind them in (see "Seat fence"). The same spec reaches
  every adapter through `applyFence`, so **claude, codex and gemini get the same
  mounts**; `tooling.mountTargets` adds Claude Edit/Write deny rules and
  sandbox `denyWrite` entries so a refused write is explained. Declared commands
  run only through `harness/tooling/offline`, bound read-only at
  `/run/devpanel/tooling/offline`: `offline <program> [args…]` (no `--`
  separator; a leading `--` is refused, exit 64) runs the program in a fresh
  network namespace with loopback only (`bwrap --dev-bind / / --unshare-net`).
  It probes that namespace first. When it cannot start (Codex's
  `workspace-write` sandbox refuses it: `loopback: Failed to create NETLINK_ROUTE
  socket`, because its seccomp filter denies every socket family but `AF_UNIX`),
  the wrapper accepts the runtime's own denial only when it proves it for its
  own process before running anything: `/proc/self/status` shows a seccomp
  filter (inherited by the command across exec, never removable) and creating
  a TCP or UDP socket, IPv4 or IPv6, is refused with `EPERM`. A filter that
  lets IP sockets be created (refusing only `bind` or `listen`, say) is not
  accepted. It then runs the command and says `devpanel-offline: isolation
  inherited` on stderr. That denial refuses loopback too, so a command that
  listens on `127.0.0.1` fails there. The proof rests on what the process can
  do, never on the harness or the sandbox setting. Where neither holds, the
  wrapper imposes the denial itself. That is a Claude seat whose Bash sandbox is
  on: the CLI's seccomp filter keeps a command from making namespaces (`bwrap:
  No permissions to create a new namespace`) while IP sockets can still be
  created there and reach the sandbox's proxy on loopback; a Codex seat with
  `networkAccess` is the same case. Fixed-path `/usr/bin/python3 -I -S` installs
  a seccomp filter on the wrapper's own process (`PR_SET_NO_NEW_PRIVS`, then
  `PR_SET_SECCOMP`; no privilege needed, inherited across exec, never removable):
  `socket()` is refused with `EPERM` for every family, `io_uring_setup` with
  `ENOSYS`, and every syscall of a foreign ABI (i386, x32) with `EPERM`;
  `socketpair`, and so pipes to children, still works. It then runs the wrapper
  once more, and that second pass decides by the same proof as above, saying
  `isolation inherited: … this wrapper installed a seccomp filter of its own`.
  The second pass is marked by `DEVPANEL_OFFLINE_IMPOSED`; a seat that sets it
  only skips the attempt. Syscall numbers are listed for x86_64 and aarch64. Nothing the seat's
  environment controls takes part in the decision: the dynamic loader's
  variables (`LD_*`) are dropped before anything is executed, so no preload
  reaches bwrap, the verifier or the command; `bwrap` and the verifier are fixed
  paths (`/usr/bin/bwrap`, `/usr/bin/python3`); the verifier runs with every
  variable unset, in Python's isolated mode (`-I -S`); everything else is a
  shell builtin, with no `PATH` lookup. Only a verifier that exits 0 with a
  final line carrying the nonce made for that call counts, so one that stops
  early or fails proves nothing. The wrapper's own interpreter (`/bin/sh`) is
  where trust starts: a preload that subverts the shell itself is beyond what a
  script can check. Neither isolation proved and none imposed (another machine
  type, a runtime that refuses `prctl`, no Python), it exits **125**, says the command was
  NOT run with each reason, and never falls back to running it with network. The prompt tells the seat to record exactly that, quoted. Once
  isolation is decided, the wrapper also measures whether a Node child's output
  can be read here: fixed-path `/usr/bin/node`, every variable unset, a per-call
  nonce read back through `execFile`. It says `child output unobservable [<nonce>]`
  on stderr when a cleanly exiting child's output came back empty, `child output
  unchecked [<nonce>]` when the measurement failed, and nothing when it was read.
  The command runs the same either way, with its own exit code, and the exit 125
  path never measures (docs/execution-contract.md "Tooling policy"). **Network
  policy:** nothing here grants network; a turn's own `networkAccess`
  (infrastructure inspection) and the CLI's API traffic are unchanged, and the
  declared commands have none. Seats never install anything: the mounts are
  read-only. **Gemini is left out of command execution:** a non-writing seat has
  no shell, and a writer is denied it whenever a read-only root exists (always,
  the run's evidence), so a gemini seat is told it cannot run the commands and
  records them as not run. `npm run live -- --tooling --project <id>` is the
  paid check (one read-only turn per project and adapter).

Evidence: `test/seat-hygiene.test.mjs` (offline, recording fake CLI, seeded
canaries) and `npm run live -- --harness <h> --model <wire> --hygiene` (two
paid turns: a writer and a reviewer; instructions file canary, `pwd` from the
runtime's own record, the writer's edit on disk, the reviewer's worktree
unchanged); reports go under `gui/live/reports/` (or the host configuration's
`live-reports/`). Claude Code
creates an empty `.claude/.cc-writes/` directory in its working directory with
or without hygiene; it holds no files and is not part of any fingerprint.

## Seat fence (`fence.namespace: 1`)

`fence.mjs` wraps a turn's CLI in a bubblewrap allow-list namespace, proved
before launch; the engine supplies the run's paths (`fenceSpec`), each adapter
its CLI's needs (`fenceManifest`). An adapter never fails a turn because the
fence could not be built: it runs unfenced and reports
`diagnostics.fence.namespace: 0` with the reason, which the engine records on
the step. `npm run live -- --read-fence` is the paid check (one writer turn).
See the plan's implementation log for what is and is not fenced yet.

Hosts without bubblewrap (macOS) have no fence at all
(`gui/server/runtime/confinement-policy.mjs`). There every seat turn, tooling
command and local check is refused before it starts, naming macOS, unless the
install opted in with `DEVPANEL_UNFENCED=acknowledged` (`install-on-osx.sh`
keeps it per install). With the opt-in, turns run as `namespace: 0`, local
checks `local-unconfined` and declared commands are given unwrapped and
labelled unconfined; the run records `unfenced` and the panel flags it on every
page. `DEVPANEL_FENCE=off` and `DEVPANEL_FENCE_UNPROVED=run` grant nothing
there, and Gemini seats are refused in preview, preflight and `invoke` itself.
Declared tooling mounts are bound only by a proved fence: any turn with tools
that would not get one (fence off, macOS, an in-place run, a run from before
the fence) is refused naming the mount's source and target, before a mount
point is created.

Private repositories (`fence.repository: 1`): the worktree's `.git` names the
run's worker Git directory, which the fence mounts writable for the writer and
read-only for everyone else, with the engine's object store read-only beneath
it. `tooling.gitWorker` names that directory; an adapter adds it to a WRITING
seat's own sandbox (Claude `sandbox.filesystem.allowWrite`, Codex
`sandbox_workspace_write.writable_roots`) so `git add`/`commit` work, and to no
other seat.

## Credentials

Adapters read credentials through the *references* in the roster entry
(`env:NAME`, `file:/path`, `keyring:NAME`, `agent:`). No credential value is ever
stored in configuration, logged, or written into run metadata.

### Accounts: another person's login, not another provider

Several people collaborating through one panel each have their own subscription.
That is not an endpoint-and-token connection — there is nothing to substitute,
because the auth lives in a logged-in config directory. A roster entry therefore
takes an `account` instead:

```yaml
id: opus-5-ana
title: Claude Opus 5 (Ana's login)
harness: claude
model: claude-opus-5
account: ana        # NOT endpointRef/credentialRef — those describe a provider
```

The adapter gives that account a directory of its own —
`~/.config/devpanel/claude-profiles/account-<name>`, `CODEX_HOME` at
`~/.config/devpanel/codex-profiles/account-<name>`, or `GEMINI_CLI_HOME` at
`~/.config/devpanel/gemini-profiles/account-<name>` — and changes nothing else:
same provider, same models, a different person's session. The directory is named
after the account rather than hashed, because a person has to log into it by
hand, once:

```sh
CLAUDE_CONFIG_DIR=~/.config/devpanel/claude-profiles/account-ana claude login
CODEX_HOME=~/.config/devpanel/codex-profiles/account-bea codex login
GEMINI_CLI_HOME=~/.config/devpanel/gemini-profiles/account-cyd gemini
```

`GEMINI_CLI_HOME` is the whole of gemini's state — settings, credentials and
session transcripts sit under it — which is why the account fence is that variable
and not the process `HOME`: overriding `HOME` would move git, npm and ssh
configuration as well. Because the CLI can authenticate three ways, the adapter
also names the METHOD (the login) rather than only clearing the others, or a home
with no login could still be answered by a method the host has configured.

`account` and `endpointRef`/`credentialRef` are mutually exclusive and the
adapter refuses both together: a connection is either another person's login or
another provider, never both. Everything inheritable is cleared first — ambient
API keys, OAuth tokens, base URLs — so a directory nobody has logged into fails
as *unauthenticated* rather than quietly succeeding as whoever is logged in
ambiently and filing the work under someone else's name.

The account is part of the connection's identity: preflight keys probes by it and
verifies the probe echoed the account it ran under, so one person's login can
never vouch for another's. Changing an entry's account also counts as changing
the supervisor's model, so the previous native session is archived rather than
resumed — one person's conversation must not continue as another's.

Two levels of evidence, because they prove different things. `npm test` spawns a
fake CLI that records the environment it was given, with ambient credentials
seeded first so "the key was cleared" cannot pass merely because it was never
set; that proves the adapter *forwards* the account. `npm run contract` launches
the installed binaries to prove they still *honour* the variables — an isolated,
empty config directory that reports a LOGIN fails rather than skips, since that
is precisely the regression. It sits outside `npm test` because that suite may
not reach a real runtime.

The conflict is enforced in the **schema**, not only in the adapter: a roster
entry with `account` may carry neither `endpointRef` nor `credentialRef`, and
must keep `profile: default`, because a non-default profile is provider routing
and would label the connection as something it is not. An adapter that never
received every field could not catch it, and the broken probe path did not.

`overview.bySeat` groups by role and **roster entry**, not by account. Distinct
ids incidentally separate `opus-5-ana` from another entry, but one person using
several models is still split across rows; per-account totals need an explicit
`byAccount` grouping that does not exist yet.

Claude sandbox mount paths are canonicalized with `fs.realpath` before settings
are passed to the runtime. File-tool denials retain both the configured spelling
and the resolved target, including live-checkout, source, Git and additional
read-only roots, with one exception: `Read(...)` denials name only the resolved
target. The runtime folds `Read(...)` denials into read-deny mounts and mounts a
directory spelling verbatim, so a symlinked spelling (`<projects-root>/x-project -> x`)
fails the whole sandbox with `bwrap: Can't mount on symlink destination`; the
runtime resolves tool paths before matching, so the canonical denial still
covers the alias. Scratch identity is compared canonically so a scratch alias is
not accidentally mounted read-only. An unresolvable configured path fails before
runtime launch; mandatory sandboxing and disabled unsandboxed fallback are retained.

Claude tool-result monitoring correlates results with the streamed Bash tool-use
ID. On the first failed Bash result beginning with `bwrap:` (also after an
`Exit code N` prefix), the adapter aborts the CLI, waits for process-group
termination, and records an environment failure. It never accepts the final
response from that invocation or retries the run as a transient provider fault.
Read-tool output and explicitly successful Bash results do not trigger this check.

Project discovery, supervised starts/resumes, and direct run provisioning resolve
source directories canonically. Logical project IDs remain unchanged. The original
project alias is retained separately for file-tool denials, so canonicalizing the
source does not remove protection for paths written using the alias.

`config:check --preflight` runs one free Linux sandbox smoke check per configured
or discovered project; `--project <id>` restricts it to that project. It checks
socat installation and runs `/usr/bin/true` inside bubblewrap with canonical
read-only project/additional roots and a temporary writable scratch mount.
Scratch is removed afterward. This proves local mount and namespace setup, not
Claude's network bridge, provider authentication, or model access. Live Claude
run preflight performs the same check before paid model probes; failures prevent
launch. Ordinary configuration resolution remains offline.

For one project's analysis configuration, from the repository root:

```sh
npm --prefix gui run config:check -- analysis --project <project-id> --preflight
```

At the default installation depth, authentication and model access remain
unproven. Deeper model probes retain their existing explicit spending controls.
