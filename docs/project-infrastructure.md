# Project infrastructure and staging test drives

The current tactical playbook model is documented in [Tactical playbooks](tactical-playbooks.md). It supersedes the legacy catalogue and single-auditor workflow described below for new runs.

Configure infrastructure in `projects/<project-id>.yaml` in the devpanel configuration
root, or in the installation's own `host-config/projects/` ([Host configuration](host-config.md));
the host-config file wins when both exist. `DEVPANEL_CONFIG_ROOT` selects an alternate root. The project page displays
the configuration and offers bounded status/log/file inspection. Configuration is
edited as YAML, reviewed, then used by subsequent runs; it is not inferred from a
hostname, deployment script or generated documentation.

For a configured Boilerplate application, the schema requires one staging
environment, at least one deployment environment, orientation instructions and
a test-drive command list. Add any number of deployment environments to the
array. Environment ids must be unique. Staging must use a different host reference
from every deployment environment. Operators must ensure different SSH aliases
also represent different containers; devpanel cannot prove that offline.

[`examples/host-config/projects/example-project.yaml`](../examples/host-config/projects/example-project.yaml)
is an example. A project file declares infrastructure only: it does not authorize merging into a source repository. Existing optional
`sourceRepository` and `integrationBranch` settings must still be supplied together.

## Configuration fields

| Field | Meaning |
| --- | --- |
| `infrastructure.kind` | `boilerplate` |
| `workspace.reconcile` | `{<path or glob>: append \| prepend \| {rule, inert}}`: how a delivery refused for drift merges onto the source. See "Reconcile policy: inert paths" below. |
| `orientation` | Source ownership, application/framework composition, documentation entry points, access instructions and operating conventions. No credentials. |
| `staging` | Environment used by automatic candidate checks. |
| `deployments` | One or more environments available for inspection, never selected by the automatic test-drive runner. |
| Environment `id`, `description`, `notes`, `url` | Identity and operator guidance. Only `id` is mandatory among these. |
| Environment `ssh.hostRef` | `ssh-config:<destination>` (including `user@host`), `env:<variable>`, or `file:<reference-file>`. |
| Environment `ssh.userRef` | Optional `env:` or `file:` reference containing the SSH username. |
| Environment `ssh.identityRef` | `agent:` for normal SSH agent/config authentication, `file:<private-key-path>`, or `env:<variable-containing-key-path>`. Key contents are never inserted into model prompts. |
| Environment `ssh.workdir` | Existing writable remote parent for temporary candidate directories. Use a short absolute path; Unix socket path limits apply to Boilerplate instances. |
| Environment `projectRoot` | Existing instance root, for orientation and diagnostics. The test drive does not replace it. |
| Environment `files` | Named, explicitly permitted diagnostic files with absolute paths, e.g. `application-log: /opt/app.example/runtime/log/current/project.log`. Do not register secret files. |
| Environment `statusCommand` | Optional trusted operator-authored diagnostic shell command. Callers cannot supply replacement shell text. |
| `testDrive.requirement` | `required` by default, or `optional`. This can strengthen but never weaken the playbook's requirement. |
| `testDrive.commands` | Ordered `{id, run, timeoutSeconds, required}` commands run in the verified candidate on staging. At least one must be required. |
| `testDrive.finallyCommands` | Optional ordered log collection and process cleanup. Attempted even on command failure or cancellation, each with its own timeout. Command ids must be unique across both lists. |
| `testDrive.timing` | `approved` (default): a revision is test-driven only after every reviewer approved it, so the ~20 minute drive is not spent on revisions sent back anyway. `every-revision`: each revision, beside its reviews. |
| `testDrive.tiers` | `{smoke: [ids]}`: the smoke tier runs on every revision beside the reviews, the full drive once on the approved revision; only the full drive counts for closure. See "Tiers" below. |
| `testDrive.baselineCache` | `{stagingFiles, environment, maxEntries, maxAgeDays}`: reuse each tier's base drive across runs on an exact key. See "Baseline cache" below. |
| `testDrive.retryFailed` | How often a failed drive runs again on the same revision before the failure counts (default 1, 0 to 3). A pass after a failure is recorded as `flaky`. A passing drive gated only by new selftest failures runs once more too (when this is at least 1). Neither runs when an earlier revision of the run already reproduced the failure (execution-contract.md). |
| `testDrive.notes` | Prerequisites, intended coverage, fixture choices, and limitations. |
| `testDrive.commands[].kind` | `candidate` or `privileged` (0e; every command or none). See "Confined test drives" below. |
| `testDrive.confinement` | `{user, home, readOnly, writable}` for `kind: candidate` commands: the unit user (else the host settings' `testDrive.confinement.user`; there is no built-in account, and a candidate command without one is refused), its home (else the host settings' `testDrive.confinement.home`; an empty tmpfs inside the fence), and the toolchain paths bound back (`~/.nvm` and the npm seed read-only; no shared writable cache, audit I7). Never secrets. |
| `testDrive.compareBaseline` | `true` runs the same commands once per run on the run's base commit (`checks/base-<key>/`), beside the first candidate check and reused by later revisions and refreshes with the same target. Each candidate check then carries `baselineComparison`: per command, the stdout lines only the candidate printed (`added`) and only the base printed (`removed`), with check-directory names normalised, plus a changed pass/fail. Reviewers see it in `checks.latest`, so a failure is "pre-existing" only if the base printed it too. Commands that print one line per finding (failing test, file with warnings) make this exact. Off by default: it doubles the first check's load on the target. Without it the base is still captured once a candidate check fails, and closure treats failures identical on the base as baseline-known (execution-contract.md "Inherited check failures"). Every command's full stdout is kept as `<id>.stdout` beside its log; the record keeps the first 2000 characters of stdout and the last 1000 of stderr, plus `results`: every PASS/FAIL/SKIP/ok/not ok/check-mark and "N passed" line of the whole output (at most 200), so a non-gating selftest collector's verdicts reach the auditor and the confirm step without reading the log (checks.mjs `resultLines`). |
| `testDrive.commands[].needs` | Earlier command ids this command depends on; a `join` implies its service. After a required command fails, a command still runs if it declares `needs` (`[]`: independent) and every need passed; otherwise it is skipped (`result.skipped`). A skipped required command leaves the outcome unknown, so no failure counts as inherited. Declare it on checks that only need the application ready, so one inherited failure does not hide the rest. Not allowed on `finallyCommands`. |

### Confined test drives

A test drive whose commands all declare a `kind` is confined by the engine,
not by the command text (step 0e of the seat-access fence):

- `kind: candidate` — the whole `run` text executes in its own transient
  systemd unit as `confinement.user`, with `NoNewPrivileges`, inside a
  bubblewrap allow-list: read-only `/usr`, `/etc` and `/sys`, a private `/tmp`, the
  empty home with only the declared paths, and the candidate directory.
  The staging instance, `/root`, other `/srv` entries and the SSH account's
  keys are absent. Options: `network: true` keeps the host network (dependency
  installation; otherwise `PrivateNetwork`); `service: true` starts it and
  returns (the application), `lifetimeSeconds` bounds it; `join: <service id>`
  enters that running service's own user and mount namespaces (with
  `nsenter`, targeting the pid the launcher reads from systemd, never one the
  candidate wrote) and its private network (`JoinsNamespaceOf`), so readiness
  probes and CLI selftests see exactly the application's fenced view and can
  inspect its processes and sockets; `unprivilegedPorts: true`
  lets it bind ports below 1024 inside its own namespace.
- Pid namespace: a candidate command gets a private pid namespace, so it cannot
  see or signal processes outside its own test drive (the staging instance, the
  operator's shells, a concurrent check). The launcher picks the way per launch,
  as the SSH account: bubblewrap's `--unshare-pid` where the unit user can mount
  `/proc` in a new pid namespace; else, when the SSH account is root,
  `PrivatePIDs=` on the unit (systemd 257+). The second is what systemd-nspawn
  containers need: the container's `/proc` is overmounted (kmsg, boot_id, a
  read-only `sys`), so the kernel refuses an unprivileged fresh proc mount in a
  new pid namespace ("mount too revealing"), while the service manager, as
  container root, can create the namespace and its `/proc` and bubblewrap runs
  inside it. Either way pid 1 inside is bubblewrap, which the probe requires.
  A `join:` command enters that pid namespace as well: as the unit user through
  the service's user namespace, or, since a `PrivatePIDs=` namespace is owned by
  the initial user namespace, as root followed by a setuid to the unit user
  inside. Where neither way works the fence runs without a pid namespace, says
  so on stderr, and the probe labels the check `remote-unconfined`
  (`HOST-PIDS-VISIBLE`). `gui/tools/pidns-probe.sh` and `pidns-join-probe.sh`
  prove which way a host supports (run as root on the staging host).
- `kind: privileged` — runs as the SSH account with the candidate and control
  directories masked by empty read-only mounts: it can read the journal and
  manage units by name, but cannot read or execute candidate files.

systemd expands `$` in a unit's command line; the engine escapes the run text,
so it reaches `/bin/sh` exactly as written (`$$` is the shell's pid).
Every command gets `DEVPANEL_CANDIDATE_DIR` and `DEVPANEL_UNIT_<ID>` for each
candidate command's unit (e.g. `journalctl -u "$DEVPANEL_UNIT_START"`). When the
SSH account is root, the verified candidate is handed to the unit user after
its arrival listing. The engine's launch bookkeeping lives in
`<candidate>.control`, beside the candidate and owned by the SSH account. The
engine stops every unit after the commands; service units only after the
finalizers, which may still need the application. No stop command is needed.

Before the target's commands, the engine runs two probes: a candidate command
that must find `/root`, other `/srv` entries, the home's `.ssh`, the
environment's `projectRoot` and the control directory absent and `/usr`
read-only, and a privileged one that must find the candidate directory empty.
A drive of privileged commands only runs as the SSH account: it needs no unit
user, the candidate is not handed over, and only the privileged probe runs. A
drive with a candidate command and no unit user (neither the project's
`testDrive.confinement` nor the host settings') is refused before anything is sent.
A `confinement.readOnly`/`writable` path declared INSIDE one of those (for
example an application cache under `projectRoot`, such as
`runtime/cache/devpanel-application`) is expected: that canary may then hold
only the bind and the empty directories leading to it, and anything else
visible in it still fails the probe. A declared path that is a canary or
contains one, or that is not spelled canonically (`.`, `..`, empty segments),
fails it. The check result records `confinement.level`: `remote-enforced` when both
pass, otherwise `remote-unconfined` with the reason — the checks still run
(label, don't refuse). A target without kinds is `remote-unconfined`. Local
check targets run inside the seat fence (`local-enforced`, or
`local-unconfined` when it cannot be proved or `DEVPANEL_FENCE=off`), with
`confinement.readOnly`/`writable` bound for their toolchain. On a host without
the fence (macOS) they are `local-refused` and do not run, unless the install
opted in to unfenced operation (`DEVPANEL_UNFENCED=acknowledged`,
`install-on-osx.sh`): then `local-unconfined`, with that reason
(`runtime/confinement-policy.mjs`).

### Tiers: a smoke beside the reviews, the full drive after approval

`testDrive.tiers.smoke` names the commands (and finalizers) that tell whether a
revision stages, installs, lints, boots and answers: for example
refresh-npm-seed, prepare, lint, start, readiness and the log collectors.
The smoke tier runs on **every** recorded revision beside
its reviews; a failure (after `retryFailed`) sends the author another round
through the ordinary failed-check path, and a revision whose smoke failed gets no
full drive, unless it is the last allowed round's and its audit holds an
`awaitsCheck` finding (execution-contract.md). The **full** tier is the whole target: it runs once, on the
revision every reviewer approved, as `timing: approved` does, and it is the only
result closure, the closure confirmation and refresh-checks count — a passing
smoke never stands in for it. Every command a smoke command `needs` or `join`s
must be in the smoke tier; `tiers` with `timing: every-revision` is refused.
Each tier has its own base drive (`compareBaseline`), so the first smoke never
waits for a full base drive. Check records and events carry `tier`.

### Baseline cache: one base drive per exact key, across runs

`testDrive.baselineCache` keeps each tier's base drive under
`issues/<project>/.baselines/<key>/` (files under `issues/`, no service) and
reuses it in a later run **only on an exact match** of every component:

| Component | How it is computed | Why |
|---|---|---|
| base commit | `run.workspace.baseCommit` | the bytes the base drive ran. Working-tree snapshot commits are a function of content and HEAD (no run id, HEAD's date), so an unchanged checkout repeats its commit |
| target definition | sha256 of the tier's target as resolved (commands, confinement, SSH destination, retry) | any change to the drive is a miss |
| staging files | sha256 of each `baselineCache.stagingFiles` name from `infrastructure.staging.files`, read over SSH (for example `deployment-scope`, `framework-version`) | the application snapshot on staging |
| environment | sha256 of `baselineCache.environment`'s output, run as the SSH account, never in a candidate: hostname, machine id, every installed Node; where a scope file names application paths, also their content hash | the host and runtimes; a scope lists paths, not their bytes |

The identity is read for every check, and a baseline the run already holds is
reused for a later revision only under the same identity, so staging or the
environment changing mid-run means a fresh base drive. A base drive whose
identity changed during it, or could not be read after it, is never reused. The environment command
must fail when any read fails (list and hash the application in separate
steps, so an unreadable file or directory exits non-zero instead of hiding
inside a pipeline). A component that cannot be read means no lookup and no store (recorded on
`baselineChecks[].cache`). The identity is read again after a base drive and the
entry is stored only if both reads agree. A hit is copied into the run as
`checks/base-<key>/`, verified file by file against the entry's manifest (a
damaged or partial copy is a miss), and recorded as `baselineChecks[].reused`
`{key, entry, fromRun, capturedAt}` and on the check's
`baselineComparison.reused`; comparisons, logs, archives and the confirmation's
read-only checks root read it where they always have. Entries older than
`maxAgeDays` (14) and the oldest beyond `maxEntries` (12) are pruned at each
store. A hit saves the base drive, which runs beside the candidate's: it
lightens staging, and shortens wall time only where the candidate was waiting
for the base.

### The npm seed: a per-host cache, read-only to candidates

`refresh-npm-seed` (`kind: privileged`, so the candidate is masked, not
required) fills `/var/cache/devpanel/npm-seed` on the staging host from the **deployed
instance's own lockfiles**, never a candidate's: `npm ci --ignore-scripts` per
lockfile into a build directory beside the seed, under a `flock`. A version is
built aside as `v-<lockfiles hash>`, marked complete (`.complete`) last, and
published by an atomic symlink swap of `current`. A superseded version is
removed only a day after it was superseded, so a copier never meets a missing
or partial seed. Candidates get the seed through `confinement.readOnly`, never
`writable` (audit I7: a writable shared cache is a channel between
candidates). `prepare` reads `current` once, copies that version into its
private tmpfs home and uses it (`npm_config_prefer_offline`) only if the copy
carries the version's `.complete`; otherwise it downloads as before. What it
saves is measured on the staging host, not assumed.

SSH uses batch mode and the service account's SSH configuration/agent. Install
host keys and access credentials outside project YAML. Configuration is trusted
operator code: commands execute with the configured remote account's permissions.
Use an unprivileged account for application processes, and restrict privileged commands to
provisioning/service control where needed. Container provisioning and credential
installation are operator tasks; declaring a container does not create it.

Validate a project's effective policy without making model calls or connecting:

```sh
cd gui
npm run config:check -- implementation --project <project-id>
```

## Reconcile policy: inert paths

`workspace.reconcile` in `projects/<id>.yaml` (project-only) says how a delivery
refused for drift on its own paths is merged onto the source
(execution-contract.md "Reconciling a delivery with drifted source"). A path's
value is its rule, or the rule with `inert`:

```yaml
workspace:
  reconcile:
    'docs/notes.txt': append                     # merged by the rule, then the checks run
    '**/changelog.txt': { rule: prepend, inert: true }
```

The merge is the same either way: `inert` does not change how a path composes,
and a conflict the rule cannot resolve still refuses. What it changes is the
revalidation. When every path the source drifted on is inert, inside or outside
the approved patch, and every other path of the merged candidate is byte-identical
to the approved revision, no check runs, on the candidate or on a base. The approved
revision's passing full check result carries to the merged revision
(`carriedFrom`), and the attempt records why (`noDrive`). Any other drift gets the
configured checks as without the declaration, as does a revision with no passing
result to carry (`inert.notCarried`).

**Declaring a path inert makes it the project's responsibility that no check
depends on that file, because no drive will re-check it.** A selftest that reads
it, a build that embeds it, or a startup that parses it can break on the composed
bytes and nothing will notice before delivery. Declare only files nothing executes
or tests, such as a changelog, and never a broad glob: `'**'` would skip the drive
for real code. A path is inert only when its own entry says `inert: true`, and the
first entry naming a path decides both its rule and its inertness.

## Local checks: a project without staging

A project that has no SSH staging environment (a library, a CLI, a Rust crate on a
Mac) declares its checks itself, at the top of `projects/<id>.yaml`:

```yaml
id: example-crate-project
checks:
  requirement: required        # default; optional is the other choice
  commands:
    - { id: fmt, run: cargo fmt --check }
    - { id: clippy, run: cargo clippy -- -D warnings }
    - { id: test, run: cargo test }
  confinement:
    readOnly: [/home/me/.cargo, /home/me/.rustup]   # toolchain paths the fence binds; never secrets
```

Every playbook whose steps record a revision (implementation, plan-and-implement,
refactoring) resolves them as a `kind: local` target: the candidate is rebuilt
from base plus patch on this host, fingerprinted, and the commands run in it, with
every command's log under `runs/<id>/checks/<n>/`. Timing defaults to every
revision, beside the reviews, and a failed required check sends the author another
round; `timing`, `retryFailed`, `compareBaseline`, `tiers` and `finallyCommands`
mean what they mean for a test drive. `requirement` strengthens the playbook's,
never weakens it. Commands take no `kind` and none of the SSH confinement options:
they run through the local check fence, labelled `local-enforced` (Linux, fence
proved), `local-unconfined` (`DEVPANEL_FENCE=off`, or macOS under the install's
opt-in) or `local-refused` (no fence and no opt-in: nothing runs, the result is
`unavailable`, and a required check blocks closure). A project declares either
`infrastructure.testDrive` or `checks`, never both. `npm run config:check --
implementation --project <id>` prints `target=local commands=…`. A project's
own file stays with the installation that runs it (`host-config/projects/`).


### Unstable selftests

A selftest that recorded drives classify as unstable stops gating and is reported
instead (execution-contract.md "Unstable selftests"). That is on by default; a
project opts out with `classifyUnstable: false` on `infrastructure.testDrive` or
`checks`, which makes such a failure gate like any other. A tester may state a
test's module with a string `module` beside `test` in its report, a directory
relative to the project: the classification then needs no module of its own making.

## What participants receive

The infrastructure configuration contributes to the preview/configuration hash
and is embedded in `resolved-playbook.json`. Every coordinator, author and auditor
turn receives an infrastructure brief, including turns with coordinator-authored
handoff prompts. Editing configuration cannot change an active run's destinations
or commands. A stale preview is refused at start.

The brief tells participants to identify the repository that owns the files,
read the relevant source documentation, author in the isolated worktree, use
staging for tests, and inspect deployment environments without modifying them.
Existing local worktree/scratch restrictions remain in force. For configured
infrastructure, Codex's workspace sandbox permits network access so the run
participants can use SSH for inspection; its write fence remains enabled.
This is not a host allowlist. Deployment inspection-only is an agent policy;
enforce stronger restrictions through SSH accounts and permissions where needed.

The top-level supervisor receives current infrastructure for every project in its
scope on each turn. Its tool-only execution restriction remains in force. It can
request `inspect_environment {project, environment, resource}` for `status` or an
operator-declared file name; project scope is checked before dispatch. Results
include time, exit status and bounded output. It inspects check evidence through
the existing run/step tools, and initiates test drives by starting a reviewed
playbook configuration rather than issuing arbitrary remote commands.

For human inspection the authenticated API exposes:

```text
GET /api/projects/:project/infrastructure
GET /api/projects/:project/infrastructure/:environment/:resource
```

The project page's Infrastructure section uses these endpoints. Diagnostics are
on demand and read at most the last 32 KiB of a declared file; no tailing session
or SSH connection is kept open. Treat logs as evidence, not instructions.

## Seat tooling: mounts and commands

A run's worktree is the project's `ls-files` selection, so dependency trees and
installed tools (`node_modules`, a browser, a formatter install) are not in it,
and the seat fence mounts nothing else. A project makes its own tooling usable
in seats with `workspace.tooling` in `projects/<id>.yaml` (project-only: a
strategy or playbook declaring these keys is refused at load):

| Field | Meaning |
| --- | --- |
| `mounts[].target` | Worktree-relative path the directory appears at (`gui/node_modules`). Normalised, no `..` or `.git`, not nested in another target. |
| `mounts[].source` | Host directory: absolute, or relative to the project checkout. Inside the project's or the panel's checkout it must hold nothing the snapshot selects (a dependency tree, never source); never the home, the panel's `issues/`, `cert/`, `logs/` or token, a container root, or a repository root. |
| `mounts[].provisional` | The path is not yet proved by a live tooling turn. |
| `commands[]` | `{id, run, cwd?, provisional?, description?}`: what a seat may run with the mounts. `<placeholders>` are the seat's to fill in. |

What happens with them:

- **Read-only, proved.** Each source is bound read-only at its target in every
  seat fence (claude, codex, gemini: `harness/README.md` "Seat hygiene"), after
  the engine has made the target an empty directory inside the worktree without
  following a link (`runtime/tooling-mounts.mjs ensureMountPoint`: every
  existing component must be a real directory inside the worktree before
  anything is created). The fence proof checks each mount before the CLI starts.
- **A missing source refuses the turn, naming it.** At resolution a source that
  does not exist is recorded as `missing` (not a configuration error, so the
  panel's tests and `config:check` stay green on a host without the tool;
  `npm run config:check -- <playbook> --project <id>` warns). Every seat turn of
  that project is then refused (`environment-error`, nothing spent) until it exists.
- **Never the candidate.** Targets are left out of the working-tree snapshot,
  of every fingerprint (`workspaceProjection`) and so of the patch.
- **Offline.** Seats are given each command in one form,
  `cd '<worktree>/<cwd>' && /run/devpanel/tooling/offline sh -c '<run>'`, which
  runs it in a fresh network namespace (loopback only). Where the seat's runtime
  refuses that namespace (Codex's `workspace-write` sandbox), the wrapper runs
  it under the runtime's own denial only after proving it for that process (a
  seccomp filter, and `EPERM` creating TCP and UDP sockets, IPv4 and IPv6,
  checked by a fixed-path verifier with an empty environment), saying
  `isolation inherited`; loopback is refused there too, so a command that
  listens on it fails in a Codex seat. Exit 125 from the wrapper means neither
  isolation could be had in that seat: the command was not run, and the seat
  records it as not run with the line and output quoted. No
  new network is granted; infrastructure inspection access is unchanged.
- **"Could not run" is not a report for a listed command.** Author, plan and
  audit prompts, the coordinator's briefs and its closure confirmation list the
  commands and require the quoted attempt. A gemini seat has no shell and is
  told so.

For devpanel's own project, mount `gui/node_modules` and `gui/.browser` and
declare the unit suites, `config:check` and the Chromium suite (built into the
seat's scratch directory, served through `DEVPANEL_DIST_DIR`, so `gui/dist`
never enters a candidate). An application with its own formatter module can
mount it and declare `prettier --check` through
`/run/devpanel/tooling/prettier-check.mjs --settings <module> --check <files>`,
which calls the application's formatter handler (`{ filepath, content }` →
`{ content }`) and compares its output with the file (no second Prettier
config). A tool that exists only on the staging host stays in the test drive.
Prove a project's entries with
`DEVPANEL_LIVE=1 npm run live -- --harness <h> --model <wire> --tooling --project <id>`
(one read-only turn in an export of the checkout whose escaping links are
materialized as a run's are under `symlinks: materialize`, so a mount target or
command behind a link is tested as a run meets it; the report under `gui/live/reports/tooling-*` gives each
mount and command `confirmed`, `refuted` or `not-run`, whether network
isolation was available in that runtime and of which kind (`isolationMode`:
`namespace` or `inherited`), and `seatNetwork`, the same 127.0.0.1 probe run in
the seat's own shell without the wrapper).

## Project actions: checkpoint.sh

Git state matters to every run: the base policy reads the checkout, delivery
diffs against it and integration merges into it. Committing that checkout is
therefore a first-class operation, not something an agent improvises with git.

A project is committed through `checkpoint.sh` in the project root, an
installation's own script that typically increments the version, adds the files,
commits them and publishes when a remote exists, in one script, and never
restarts; devpanel treats every project that has one as offering a `checkpoint`
action (`bash ./checkpoint.sh`, run in the project root). Its `# DEVPANEL cmd:`,
`# DEVPANEL hint:` and `# DEVPANEL icon:` header lines supply the label,
description and icon; scripts that already carry another marker word (an
editor's own convention) are read when the host settings name it in
`projectActions.headerMarkers` ([Host configuration](host-config.md)). A project
may declare further actions, or replace the built-in one, in `projects/<id>.yaml`:

```yaml
actions:
  - id: checkpoint
    label: Commit application changes
    run: bash ./checkpoint.sh
    timeoutSeconds: 600
    effect: commit-checkout
```

### What an action does is declared, never inferred

`effect` is the one thing about an action that an agent is allowed to act on by
itself, and it is therefore the one thing that must be stated rather than
guessed. `commit-checkout` means: this action commits the checkout, and does
nothing else that someone asking for an uncommitted checkout to be committed
would not expect. A script can say the same with a `# DEVPANEL effect:
commit-checkout` header.

Having a `checkpoint.sh` declares nothing. The registry only ever proved the file
exists, and a script may raise a version, publish to a remote,
restart a service or deploy — which is why an action with no declared effect is
one an operator runs deliberately, and never one the top-level supervisor may
decide to run on its own reasoning. The declaration is only half of it: the
top-level supervisor may run an action at all only under its activation's
`projectActions` grant, which the dispatcher checks before anything is spawned —
see `docs/top-level-supervisor.md`, "The grant is an execution gate, not a
paragraph in the prompt".

What runs is installed configuration — the script on disk or the saved command —
never text supplied by a model or a browser; callers name an action id. One
action runs per project at a time; a second request while one is running is
refused with the running operation's id. Each operation is recorded under
`issues/<project>/.actions/<operation-id>/` as `operation.json` (status
`running | completed | failed | interrupted`, exit code, the tail of each
stream) and `output.jsonl` (every stdout/stderr chunk with a sequence number,
appended before its socket event is emitted). The default deadline is 600
seconds; reaching it interrupts the process group and says so. Output is capped
at 8 MiB per operation with an explicit marker.

The project page shows one button per action. Starting one opens a popup that
streams the output as it is written, catches up from the record on reconnect,
and offers Stop while it runs; the exit code and status are shown when it ends.
The authenticated API:

```text
GET  /api/projects/:project/actions
POST /api/projects/:project/actions/:action                       → 202 { operation }
GET  /api/projects/:project/actions/operations/:operationId?after=<seq>
POST /api/projects/:project/actions/operations/:operationId/stop
```

Socket event `project:action` carries `{ type: started | output | ended,
project, operationId, action, entry?, operation? }`.

These are an **operator** capability. The top-level supervisor has no action for
them at all — management plane, not execution plane — and run participants cannot
reach the live checkout either: it is not their worktree, and their brief says so.
Work that needs a checkout operated on becomes an issue and a run, or a person at
the panel. Operators run them from the project page, or from a terminal as the
service account:

```sh
node gui/server/project-action-cli.mjs <project-id> checkpoint
node gui/server/project-action-cli.mjs <project-id> --list
```

A `checkpoint.sh` that commits a dereferenced copy of the checkout (for example
`rsync -aL` into a temporary work tree) leaves a checkout whose collections are
symlinks "dirty" against HEAD by design; the `workspace.base` policy, not a
checkpoint, is what makes such a project runnable.

## Running a test drive

Preview and start a code-producing playbook for the configured project. The project
staging target takes precedence over a playbook check target. The engine runs it
after each new recorded candidate revision, before the subsequent review. A
document-only strategy has no candidate and does not deploy or start an instance.

The existing check runner reconstructs the candidate from its base and patch,
verifies its fingerprint, uploads an archive into a new directory under the
staging workdir, verifies arrival, then executes commands with that directory as
the working directory. It checks candidate source again after commands. Adding
build/dependency output is permitted; modifying, removing or changing modes of
candidate files invalidates verification. All commands must test this uploaded
candidate, not a live checkout. Do not call the existing shared-instance deployment
script as a shortcut.

Each command's output and exit status is stored at
`issues/<project>/<issue>/runs/<run>/checks/<number>/<command-id>.log` and its result
is recorded in `run.json.checkResults`. The auditor sees the result for the
revision under review. Required checks that fail or are unavailable prevent
successful closure; unavailable infrastructure is never recorded as a pass.

Finalizers run after a failure and on cancellation without inheriting an already
aborted signal. Each has a timeout. Required finalizer failures fail verification (the result is `unavailable`, or `failed`
when a required command had already failed);
SSH cleanup failures retain the candidate directory and report its path rather
than deleting files underneath a potentially running instance. Transport loss
can still prevent cleanup: provision a remote lifetime limit as the example
below does. Remote commands are also wrapped with `timeout`.

## An example test drive

The staging host runs a shared instance of the application; production is a
separate container. Local mounts are for orientation/inspection, not an
alternative candidate source.

A clean-instance test drive:

1. Prepares dependencies in a separate, lifetime-bounded transient service from the candidate's lockfiles as the unit user, using its
   pinned Node major from the system installation or the remote account's nvm installation.
2. Starts a unique transient systemd service as the unit user, with its working
   directory set to the candidate. A private network namespace prevents conflicts
   with the shared instance and prevents outbound application requests.
3. Runs the candidate's readiness tool in that network namespace.
4. Captures service/application logs and stops both preparation and application units, including their descendants.
   A ten-minute service lifetime is a fallback if the controlling connection dies.

This is a **clean-instance readiness smoke test**. It does not claim full functional
coverage, production data compatibility or external integration coverage. No
production data, instance secrets, configuration or runtime state is copied.
Add test-specific fixture setup, functional commands and appropriate isolated
network/service arrangements to the YAML as coverage grows. Increase the service
lifetime alongside timeouts for longer tests.

The candidate must include the dependency lifecycle tool, its manifests/lockfiles,
the application entry point and the correct framework composition. The staging
container needs the pinned Node version, systemd, `nsenter`, GNU coreutils/tar and
the application's system dependencies. Missing prerequisites fail visibly; older
source revisions cannot silently borrow newer shared-instance code.

Successful testing does not deploy to production. Commit delivery, source
integration and deployment remain distinct operations.

### Candidate base for live checkouts

Project files may set `workspace.base` and `workspace.symlinks`. Resolution uses
strategy defaults, then project defaults, then explicit playbook choices, then
per-run overrides. The selected base and its source are stored in the run.
Project configuration changes invalidate previously generated previews.

An application whose live checkout contains uncommitted application/framework
composition and external collection links defaults to `base: working-tree` and
`symlinks: materialize`. Runs snapshot that composition through a temporary Git
index and copy external link targets into the isolated candidate. The live branch,
index, and files are not cleaned or committed. Other projects retain their existing
base policy. Selecting `head` explicitly still requires a clean checkout.

A run that already failed during workspace creation remains a failed historical
record. Restart the server to load the updated resolution code, then start a new run
after refreshing its preview. API clients may explicitly pass run options
`{"base":"working-tree","symlinks":"materialize"}` with the existing server code.

Shared-instance deployment is a separate [staging deployment operation](staging-deployment.md), available to the supervisor when explicitly configured and requested.


Remote test-drive commands require Bash, flock, and systemd on the target. Root
connections use the system manager; other accounts need a working user manager.
Each command runs in its own cgroup with a runtime deadline and whole-cgroup kill
policy. Cancellation uses a separate SSH connection to stop those units and confirm
termination before candidate cleanup. An uncertain launch or failed stop retains
the candidate for inspection. Configured finalizers still handle services started
outside the command cgroup (for example, a separately named application service).

Infrastructure awareness is not a remote authorization boundary. Installed SSH
credentials determine the actual remote permissions, even for read-only source
roles. Use read-only inspection credentials for workers and keep mutation credentials
with the engine's installed release commands when remote privilege separation is
required. Local sandbox read/write rules cannot make a root SSH account read-only.
