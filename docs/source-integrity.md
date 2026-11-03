# Per-turn source integrity

The engine captures a source/Git baseline when the workspace is provisioned,
before any agent invocation. This is separate from a candidate revision: a
reviewer cannot make unreviewed edits part of the first candidate's baseline.
Before every turn the engine compares against its last accepted state and saves
a pre-turn manifest. After success, failure, or cancellation, it saves the
post-turn manifest and an attributed integrity report before accepting a response.
Recovery compares pending invocations against the persisted pre-turn state too.

The source manifest covers file contents, modes, symlinks, additions and deletions,
including ignored and untracked source. It uses the candidate's normal exclusions
(`.git`, `node_modules`, `.devpanel-lock`), but tracked files remain covered even
under exclusions. Git HEAD (commit and symbolic reference), repository location,
and logical index entries/flags are checked separately. A read-only `git status`
that only refreshes index stat caches is not a source change. An unreadable or
unsupported source entry blocks acceptance rather than being silently omitted.

A seat turn's fence leaves mount targets behind: the Claude CLI's Bash sandbox binds
`/dev/null` over a list of config paths (`.mcp.json`, `.bashrc`, `.claude/agents`, …),
bubblewrap creates each missing one, and the CLI removes them only when the command
ends, so a killed turn leaves them. A worktree records the list (`workspace.fenceStubs`,
`FENCE_STUBS` in `fingerprint.mjs`, read off a live seat's mount table because the CLI
publishes none). At a turn's end, and at recovery after a lost owner, the engine removes
those that were not there before the turn (the record on the pending invocation; the
last of overlapping seats does it, and a path the first of them did not find is not
kept for a later one having seen it). `workspaceProjection` leaves out what is left, as
it does tooling mount targets, so no manifest, fingerprint, auditor diff, patch or
destination reading counts them. A stub is told from a real file, path by path, by what
was measured on live targets: an empty regular file with no write bit, at a listed path
the base does not hold. A file there with bytes or a write bit, even empty, is reviewed
and delivered. A CLI that binds another path reads as a change: a quarantine naming empty
files, until the list has it.

Accepted limit: nothing on disk says who made such a file, so a file an author made empty
and read-only on purpose at a listed path reads as a stub. It is left out of the patch and
removed at the turn's end. It holds no content, and counting stubs is what can put empty
files over real ones at delivery. Under the CLI's sandbox a command cannot make one there.

`writesCode` from the resolved participant owns permission. Authors may edit and
stage source. Other roles may not change source or the index. Git HEAD/history is
engine-owned for every role. Reviewer Codex sessions run with scratch as their
sandbox write root, including resumed sessions, with approval escalation disabled.
Reviewer Claude sessions deny source/Git edits and require a Bash filesystem
sandbox, with scratch writable and unsandboxed retries disabled. The adapter
requests a hard failure when that sandbox is unavailable. See the runtime's
[sandbox settings](https://code.claude.com/docs/en/sandboxing) and
[absolute file permission syntax](https://code.claude.com/docs/en/permissions).
These restrictions supplement the engine's checks; a run worktree alone is not
participant-level write isolation. Before/after checks observe net state changes,
not an audit of transient writes that were completely reverted during a turn.

An unauthorized change, failed/cancelled invocation with source or Git edits,
missing baseline during recovery, or inability to verify the source quarantines
the run. The workspace is retained in place, approvals/check evidence is cleared,
and normal turns, checks, closure and integration are blocked. Nothing silently
rolls back or deletes potentially useful partial work. The run detail exposes the
role, invocation, changed paths and Git changes. Manifests and reports live under
`runs/<run-id>/integrity/`; `run.json` records the quarantine and recovery decisions.
Do not edit these engine records to bypass recovery.

## Explicit recovery

First stop the old process and inspect the retained workspace and report. The
inspection command is read-only and returns a `stateHash` for the current source
and Git state:

```sh
node gui/server/runtime/integrity-cli.mjs <issue-path> <run-id>
```

Then record one of these dispositions, naming that exact state:

```sh
node gui/server/runtime/integrity-cli.mjs <issue-path> <run-id> \
  --disposition accept-partial --state sha256:... \
  --actor operator-name --reason 'Inspected and retained partial implementation for retry'
```

- `accept-partial` permits retaining a failed author's source/index edits for a
  fresh author attempt. It cannot accept a non-writer's edits or a changed HEAD.
- `restored` requires source and Git state to match the pre-turn manifest exactly.
  Restore the files/index/HEAD yourself, inspect again, then supply the new hash.
- `abandon` terminates the run while retaining its workspace and integrity history.

A stale hash or absent actor/reason is rejected. Recovery acquires the issue lock.
It never runs an agent, deletes work, or integrates anything. Normal recovery via
`resumeRun` / `Engine.drive` is permitted only after a disposition; old participant
sessions are cleared so a retry does not reuse the quarantined turn's session.
A retained partial implementation still needs a normal author response, candidate
revision, review and delivery before integration. Recovery is not approval of the
candidate and does not restore old check results or approvals.

## Claude sandbox host requirements

Linux authoring hosts need `bubblewrap` and `socat` (Fedora: `sudo dnf install
bubblewrap socat`). Package installation is not sufficient inside a nested
container: its namespace/mount policy must allow Bubblewrap to mount `/proc`.
An administrator can check that prerequisite without a model call:

```sh
bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc -- true
```

Inside a `systemd-nspawn` container that check can fail with
`Can't mount proc on /proc: Operation not permitted`; an extra proc mount at
`/run/devpanel/proc`, which the persistent configuration below provides, is the
remedy. Afterwards, rerun the check above and confirm that a sandboxed Claude Bash
turn can write to its scratch directory. Install the persistent configuration as root:

```sh
cd <panel checkout>
./install.sh
```

The installer adds `run-devpanel-proc.mount` and a `Requires`/`After` dependency
for `devpanel.service`, installs missing packages, and tests as the service user.
It does not restart devpanel or make model calls. The extra proc filesystem is
not masked by nspawn, relaxing that protection; existing `/proc` mounts and
Claude's mandatory sandbox remain in place. Other container restrictions can
still prevent initialization, in which case installation fails visibly.

The Claude adapter uses a private, short `/tmp/dpc-*` directory per invocation for
Linux runtime temporary files and bridge sockets, removed when the process ends.
`DEVPANEL_SCRATCH_DIR` continues to name the persistent run scratch directory for
artifacts. Long issue/run paths cannot be used as bridge-socket paths because of
the Unix socket pathname limit. See the upstream
[socket-path issue](https://github.com/anthropic-experimental/sandbox-runtime/issues/213).
