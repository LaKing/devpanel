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
| `testDrive.tiers` | `{smoke: [ids], continueSmoke, keepSeconds, targeted}`: the smoke tier runs on every revision beside the reviews, the full drive once on the approved revision, continuing the smoke's running instance (`continueSmoke: false` opts out; `keepSeconds` is how long it waits); `targeted` runs named selftests instead of the smoke on a repair revision; only the full drive counts for closure. See "Tiers" and "The targeted tier" below. |
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
  returns (the application), `lifetimeSeconds` bounds it, `startedMarker` says
  when it counts as started (below); `join: <service id>`
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
Every command gets `DEVPANEL_CANDIDATE_DIR`, `DEVPANEL_RUN_ID` (the run; see
"One application snapshot per run") and `DEVPANEL_UNIT_<ID>` for each
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

### When a service counts as started

`service: true` returns once systemd has the unit up, which says nothing about
what the service has written yet. A readiness command that reads a file the
service writes can run first and fail for that reason alone. The rule for that:
**a service command that declares `startedMarker` counts as started only when its
unit is active and the marker file exists.** The start command itself waits, so
readiness and every later command run after that point.

```yaml
- id: start
  kind: candidate
  service: true
  startedMarker: .devpanel-service-pid   # relative to the candidate directory
  startedTimeoutSeconds: 120             # the bound, from when the unit is up; 120 is the default
  run: echo $$ > .devpanel-service-pid; exec node app.mjs
```

What a project must declare or do to be covered:

- Declare `startedMarker` on the `service: true` command and have the service
  write that file, as a regular file (a link does not count), inside the candidate
  directory. The engine reads it from outside the fence, as the SSH account, at the
  same path.
- Keep the marker out of the candidate's own files: one that exists before the
  start fails it, because it could not show the service wrote it.
- A service without `startedMarker` is not covered and behaves as before: it counts
  as started once its unit is up, so its readiness must tolerate the wait itself.

When the bound passes without the marker, or the unit ends first, the **start
command fails**: its exit is 1, and the last line of its record's `stderr` and of
its log's stderr is `devpanel-started: service <id> did not start: …`, naming the
marker, the bound and the unit's state. Readiness is not run against it: it is
recorded in `result.skipped`, under the ordinary rule for commands after a failed
required one (`needs start, which failed` when it declares `needs`). The failure
counts like any failed check, so `retryFailed` applies.

The bound is its own: `timeoutSeconds` covers the launch, and the engine lets the
start command run for `timeoutSeconds`, the bound and 60 s more, so a short
`timeoutSeconds` cannot end the wait before the command says why. A launch that
stalls past all of that is an ordinary timeout (`timedOut`), with no marker named.

A `required: false` service that fails this rule fails nothing by itself, but what
declares it, through `needs` or `join`, is skipped rather than run against a service
that never started. If such a skipped command is required, the drive fails. A
command that declares neither still runs, so declare the dependency.

A full drive that continues a smoke's instance does not wait again. The smoke's
start passed under this rule, its record is carried, and the claim proves the
service is that same start (`InvocationID`). A start the smoke did not run is run by
the full drive, under the same rule.

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

The full drive does not repeat the smoke. When the smoke passed and its service
is proved still running and unchanged, the full drive **continues that instance**:
it executes only the target's commands the smoke did not run, in declared order,
then every finalizer, and records `continuedFrom`. The smoke's instance waits up to
`tiers.keepSeconds` (default 1800, 60 to 7200; its services get that much longer a
life), removed by a timer on the staging host if the panel never comes back. Any
failed proof runs from scratch and records why in `continuation`. It is still the
full drive: closure and the baseline comparison treat it like any other, and a
failed one retries from scratch. execution-contract.md has the proofs and reasons.

**Limitation.** A command declared before a smoke service (say `lint` between
`prepare` and `start`, with `lint` outside the smoke) runs after the service started,
so the service never sees its effect. That is harmless for a command that only reads
the candidate. If the service depends on it at boot (fixtures it loads at start), or
it needs the service down (a migration holding the data directory), the later
commands test a service the declared order would not have produced, and a false pass
counts as a full result. Validation cannot tell, so `npm run preview` warns and the
record names it (`declaredBeforeServices`). For such a target, declare the command
later or set `tiers.continueSmoke: false`, which is also the choice when a smoke
finalizer changes application data: a smoke's finalizers run before the commands that
continue.

### The targeted tier: named selftests on a repair revision

```yaml
tiers:
  smoke: [prepare, start, readiness]
  targeted:
    command: run-selftests     # keeps its kind, needs, position and timeout; only its `run` is replaced
    run: "npm run selftest -- --only {{tests}}"
    always: [prepare, start, readiness, collect-selftest-report]
    maxTests: 20               # default; more names than this run the smoke instead
```

When the previous revision's failed drive or an open blocking finding names failing
tests, the next revision runs `always` and the template, in declared order, instead
of its smoke, and its audit waits for the result. **Closure still takes only the full
drive**, so an approved revision still gets one, from scratch: the tier saves a full
drive on a repair that does not work, and costs a little on one that does. The run
record and metrics measure that (execution-contract.md "Reviews").

Validation refuses a `command` that is missing, a finalizer, a service or not
required; an unknown id in `always`; a selected command whose `needs` or `join` is
outside the tier; a tier with no `report: selftest` command, since the report is what
proves the named tests ran; and a `run` that is not the template form below.

Test names come from agents and test output, and each is shell-quoted once when the
template is filled. So validation accepts only a form it can prove keeps them as plain
arguments, rather than trying to read shell syntax:

```
command word... {{tests}} word...
```

- Single spaces separate the words, and `{{tests}}` appears once, as a word of its own.
- `command` is a literal name or path (letters, digits, `_ . / -`), never a shell
  builtin or reserved word, and never a program whose purpose is to run its arguments
  (`env`, `xargs`, `sudo`, `sh`, `bash` and the like, by any path).
- Every other word uses only letters, digits and `_ @ % + = : , . / -`.

Quotes, expansions (`$HOME` too), redirections, pipes, `;`, comments, assignments before
the command, `--only={{tests}}` and several lines are all refused. **Anything more
complex belongs in a script the template calls.**

**The remaining limit:** validation cannot see what a called program does. A script
that calls `eval`, runs `sh -c "$*"` or builds a command line from its arguments
defeats the quoting. A program given an option that runs code (`node -e {{tests}}`,
`find . -exec {{tests}}`) does the same. Pass the names on as `"$@"`.

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

### How many drives a host runs

A staging host's CPU and memory are shared: each drive boots a full instance, and
projects may share a host. `testDrive.maxConcurrentDrives` in the host settings
(default 2) is how many drives one host runs at a time, counted across projects and
processes. A drive over it waits, is never failed for waiting, and can be stopped. Every
drive counts: candidate and base, smoke and full, a retry, a diagnostic drive. A base reused
from the cache is not a drive, a kept smoke instance holds no slot while it waits for its
full drive, and local checks are not capped. The wait is on the check result
(`driveSlot`), counted as check waiting in run metrics (`driveSlotWaitMs`) and, with no
seat turn running, not charged to the wall-clock budget (execution-contract.md "What the
wall clock counts").

A host is what SSH itself would dial: the `hostname` of `ssh -G` for the target's
reference, read once per drive, so two aliases of one `HostName` share a count. DNS is not
consulted: a name and its IP, or a `CNAME`, are two hosts unless the config gives them one
`HostName`. Every connection of the drive is then pinned with `-o HostName=`, so a reference
or alias changed mid-drive cannot send it to a host it is not counted on; the alias's user,
port, identity and proxy still apply. Two things end a drive `unavailable` before it connects:

- `ssh -G` still failing after 5 minutes of retries (a wrapper named by
  `DEVPANEL_SSH_BIN` must answer it).
- Pinning would change the connection. `Match host <alias>` stops matching once the
  hostname is fixed, so the settings it holds would be lost; the error names them. Use
  `Match originalhost <alias>`, or move the rule below the `Host` block that sets `HostName`.

### Measuring a host during concurrent drives

This answers one question: with the current two drives, does resource-driven slowdown or
instability remain, and does one-drive operation improve it? Bytes held in swap do not
answer it: pages can sit in swap with nothing short of memory. A shortage shows as swap
traffic and pressure while drives run.

A person does this. Seats have no SSH to the host and a run's checks drive one revision at
a time, so no run can produce the measurement. You need SSH to the staging host and a shell
on the panel host.

**1. Sample the host.** `tools/staging-host-sampler.sh` needs only bash and awk there. Log
in as the account the target's SSH reference logs in as: its `drive_units` column counts
that account's user units, or the system's for root, which is where the drives' units are.

```sh
scp tools/staging-host-sampler.sh <host>:
ssh <host> 'nohup bash staging-host-sampler.sh --label two-drives --duration 3h </dev/null >sampler.log 2>&1 &'
ssh <host> 'date -u'; date -u   # note any difference: samples carry the host's clock, drive records the panel's
```

`--interval` is 5 seconds by default. The output is
`host-samples-<label>-<UTC start>.tsv` in the directory it started in, the login's home here
(`--output` names another), and it stays on the host until you copy it back. It takes one
line per sample, comment lines naming the host, kernel, CPU count and which pressure files
exist, and it refuses an existing file. Interrupting it (`kill <pid>`) keeps what it has.
Start it a few minutes before the first drive, so the record shows the host at rest.

| Columns | What they say |
|---|---|
| `ts_utc`, `elapsed_s`, `drive_units` | the sample's time; `devpanel-check-*` units running. A drive can hold several units, and a kept smoke instance has units and no slot, so this says "something is running", not how many slots are held |
| `swap_used_mib`, `swap_cached_mib`, `swap_total_mib` | bytes held in swap |
| `swap_in_pages_s`, `swap_out_pages_s`, `major_faults_s` | swap traffic and disk-backed page faults over the interval |
| `mem_available_mib`, `mem_total_mib` | memory left |
| `mem_some_pct`, `mem_full_pct` | share of the interval tasks stalled on memory (`/proc/pressure/memory`); `full` means every non-idle task did |
| `cpu_some_pct`, `load1/5/15`, `procs_running`, `cpu_busy_pct`, `cpu_steal_pct` | waiting for CPU, and how busy it was |
| `io_some_pct`, `io_full_pct`, `cpu_iowait_pct`, `procs_blocked` | waiting for disk, where swapping also shows |
| `cg_*` | the same for the sampler's root cgroup (`/sys/fs/cgroup`), where it offers them |

`NA` means the host does not offer the figure, or a first sample has no interval behind it. It
is never 0. A kernel without pressure data reads `NA` in the pressure columns and the file's
header says so: that is no evidence of low pressure. Then judge from swap traffic, major faults,
`procs_blocked` and `cpu_iowait_pct`, and write in the issue that pressure was not measured. In a
container (`# virtualization:`), `/proc` may describe the whole machine or the container depending
on how it was built, so name in the issue which you read; the `cg_*` columns are the container's own.

**2. Measure both settings.** Sample one period at each setting, each with its own label:

- *Two drives*: the current setting, `testDrive.maxConcurrentDrives` absent or 2 in the host
  settings.
- *One drive*: set `"testDrive": { "maxConcurrentDrives": 1 }` in `host-config/settings.json`,
  keeping any other `testDrive` key. Put the earlier value back afterwards.

The setting is read when a drive starts, with no restart, and it applies to every staging host of
this panel. A drive already running or waiting keeps the cap it read, so change it with no drive
in progress. `totals.byCap` below shows what the drives read. Runs on the host for other reasons
count against both periods alike: leave them out or name them.

Compare like with like: the same projects, playbooks and kinds of work, and enough drives in each
period to say something. The drives must actually overlap in the two-drive period. Base drives count as
load, and one reused from the baseline cache is no drive, so a period of repeats is lighter: compare
`totals.byKind`. A person starts the runs in the usual way, so this spends what those runs spend.

**3. Get drive time, queueing and failures** for each period, on the panel host, from `gui/`, after
that period's runs have finished. Name every project that drives this host:

```sh
npm run --silent drive-records -- --project <id> --project <id> --from <utc> --to <utc> > drives-two.json
```

| Figure | Field of `drive-records` | Record it comes from (`runs/<run-id>/run.json`, or the bundle's `<id>.runs.json` once packed) |
|---|---|---|
| Drive time | `driveMs` (`durationMs` less the wait), `totals.byTier.*.passedDriveMs` | `at` and `durationMs` of `checkResults[]` and their `attempts[]`, `priorCheckResults[]`, `reconciliations[].checks`, `baselineChecks[]`, `diagnosticDrives[]`; `checkHistory[].runs[]` for an earlier revision |
| Queueing | `waitMs`, `cap`, `host`, `totals.byTier.*.waitMs` | `driveSlot` on those records (`waitMs`, `cap`, `host`); `driveSlotWaits[]` by `dir`. `metrics.time.driveSlotWaitMs` on `GET …/runs/:runId` is the same per run, as a union |
| Failure rate | `result`, `failed`, `timedOut`, `totals.byTier.*.notPassed` | `result` and `commands[]` on those records; `checkHistory[].result` and `gating` |
| Which tests failed | run `npm run --silent selftest-history -- --project <id> --test <name>`, or read the file | `issues/<project>/.selftest-history/<runId>.jsonl`, `commands[].failed` and `asNew`, by `at` and `dir`; the command logs in `runs/<run-id>/checks/<n>/` |

A null is not recorded, never 0: `checkHistory` keeps no result for a retried attempt of an earlier
revision, no slot for it and no cap or host for any of its drives. Those read null and stay out of the
means, whose `of` says how many they cover. `npm run overview` averages over all history, so it
does not answer for a period.

Only remote drives count; local checks are left out. `checkHistory` does not say which a drive was,
so a drive with no record of its own, slot or wait to say so takes its run's target, only when the
run's other records, `checkRefresh`, `checkRefreshHistory` and `resolved-playbook.json` all agree on
one. Where they do not (a target that changed between remote and local, a packed run with no other
record, a packed run that was refreshed, whose first target its record no longer shows) it is listed
under `targetUnknown`, in no total: if the list holds any, say so in the issue.

A drive holds the host from `at + waitMs` to `at + durationMs`. Those intervals, corrected by the
clock difference from step 1, are what to lay over `ts_utc`: which samples had two drives on the host,
and what the host was doing when a drive failed. Summarize what the drives were running through:

```sh
bash staging-host-sampler.sh --summary host-samples-two-drives-….tsv --busy   # samples with drive_units above 0
bash staging-host-sampler.sh --summary host-samples-two-drives-….tsv --from <utc> --to <utc>   # or a stretch by host clock
```

Each column gets its `samples`, `absent`, `nonzero`, `mean` and `max`. When `drive_units` itself is
`NA`, `--busy` finds nothing: use `--from` and `--to`.

**4. Read it.**

- *Active memory shortage*: sustained `swap_in_pages_s`, `swap_out_pages_s` or `major_faults_s`
  while drives run, together with `mem_some_pct` or `mem_full_pct` above what the host shows at rest.
  Swap traffic in the failures' stretches matters more than the mean. A high, flat
  `swap_used_mib` with no such traffic is parked pages, not a shortage.
- *CPU shortage*: `cpu_some_pct` well above rest and `procs_running` or `load1` beyond the
  CPU count of the header. `cpu_steal_pct` above rest points outside this host.
- *Slowdown*: `passedDriveMs` of the same tier, two drives against one. Set the wait beside it: one
  drive trades drive time for `waitMs`, so a run may take longer even as each drive speeds up.
- *Instability*: `notPassed` of the same tier, and whether those drives' `failed` and `timedOut`
  commands and failing tests fall in stretches of pressure or also occur without it. A timing
  failure in a quiet stretch is not evidence of a resource cause.

Then record the result in the issue, as a note on its page (*Add to this issue*, with the sample files and
`drive-records` outputs attached). Write:

- the periods (UTC), labels, settings, projects, and the clock difference;
- per period: drives by kind and tier, `passedDriveMs`, `waitMs`, `notPassed`, and the failing commands or
  tests with the sample values around them;
- per period: the `--busy` summary's swap traffic, memory and CPU pressure, and `swap_used_mib`;
- which figures were `NA`, and which scope `/proc` or `cg_*` described;
- the answer: does resource-driven slowdown or instability remain with two drives, and did one drive improve it?
- the decision about a further limit beside drive slots, from the first line that fits:

| What the record shows | Decision |
|---|---|
| Too few overlapping drives, or the figures that decide it are absent | Inconclusive: measure again, nothing is built |
| With two drives, no resource-driven slowdown or instability | Close it, with the measurement as the reason: the existing limit is enough |
| Two drives show it and one drive removes it, at a wait that is acceptable | Close it, with the measurement as the reason: the existing limit is enough at 1. Keep the setting at 1, and say so |
| It remains with one drive, or the wait at one drive is not acceptable, or what strains the host is outside what a slot counts (a kept smoke instance, load within one drive) | It goes ahead, for exactly that: name in what way the existing limit is insufficient and the figures that show it |

### One application snapshot per run

`DEVPANEL_RUN_ID` is the run's id. Every check command receives it: local and
SSH, `kind: candidate`, `kind: privileged` or none, services and joining commands,
finalizers, in every drive of the run (candidate and base, smoke and full, a
retry, refresh-checks, a reconciled candidate's revalidation, a diagnostic drive
(execution-contract.md "Diagnostic drives")). It is the same for
all of them and differs in another run. The `baselineCache.environment` command
receives it too. It is not part of the target definition, so it changes neither
the `targetKey` nor the baseline key.

It lets a command that stages shared application content pin that content by run:
the first drive to arrive pins what staging holds, later drives and their bases
reuse the pin, and a stage deploy during the run does not change what is under
test. The candidate and base of one revision can be the first drives together,
so creating the pin must be atomic. The pin must outlive anything that can drive
the run again, and the staging host cannot see which runs are live or retained:
pruning belongs to something that can (a project action on the panel's host), or
it must fail closed as below.

A drive that cannot obtain the run's pin must not stage something newer. A required
command declaring `reportsUnavailable: true` says so by exiting non-zero with a line
`devpanel-unavailable: <reason>` on stderr or stdout:

```yaml
- id: stage-content
  kind: privileged
  reportsUnavailable: true
  run: /usr/local/sbin/stage-pinned "$DEVPANEL_RUN_ID" || exit 1
```

The check result is then `unavailable`, not `failed`, and `result.error` names the
command and the reason (`commands[].unavailable` holds the reason). Commands after it are
skipped as after any required failure and finalizers still run; a required finalizer
that then fails does not change the result, and retains the remote candidate as
it always does. If another required command had already failed, the result stays
`failed`. An `unavailable` result is not retried and returns no author round; under
`required` it blocks closure, and refresh-checks can run it again. A base drive that
reports is not kept or cached, and its comparison says why there is none. A smoke
that reports keeps no instance. Without the line, or without the declaration, or
when the engine ended the command, a non-zero exit is an ordinary failure. Declare
it only on a command that runs no candidate code: candidate code could otherwise
block the check instead of failing it. An optional command or a finalizer declaring it is refused.

A pin needs one more step with a baseline cache: its key reads staging as it is now,
so after a stage deploy a run's pinned base drive would be stored under the newer
content's key, and a hit could stand for other content than the pin. The
`baselineCache.environment` command must print what `DEVPANEL_RUN_ID` pinned
(creating the pin the same way when it is first to arrive) and exit non-zero when
it cannot: two runs with the same pinned content then share an entry and no others do.

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
mean what they mean for a test drive, as do `DEVPANEL_RUN_ID` and `reportsUnavailable`
("One application snapshot per run"). `requirement` strengthens the playbook's,
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
