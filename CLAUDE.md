# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It describes devpanel itself and names no installation. An installation's own notes (its applications,
containers, procedures, people and history) live beside it in the git-ignored `CLAUDE.local.md` and
`host-config/docs/`; read them when they exist. Run seats get them through the host settings'
`seatGuidance` (docs/host-config.md "Seat guidance"): frozen into the run's evidence and named in the prompt.

## What this is

devpanel: a self-hosted panel (Node 22 + Express 5 + socket.io backend, Vue 3 + Vuetify 4 front end) that runs
multi-agent "playbooks" against issues filed on the `<projects-root>/*-project` directories of its host (or the directories
the host settings' `projectDiscovery` finds, `2026/shop` → `2026-shop-project`; `project-path.mjs`). A run drives
Claude Code / Codex CLIs as coordinator, author and auditor through a declarative phase interpreter, in an
isolated git worktree per run. A separate *top-level supervisor* (a single long-lived model session) can open
issues, preview and start runs, and watch them.

Everything is plain files: human-authored config is YAML, machine-written state is JSON. There is no database.

## Tactical playbooks

Read `docs/tactical-playbooks.md` before changing playbooks, coordinator effects, evidence windows or release operations. The normal catalogue now has Analysis, Triage, Implementation, Plan and implement, Staging and Deployment. Refactoring and Prompt remain; the legacy pingpong and one-time migration playbooks were removed (2026-09-25). Default seats: Opus 5.5 at medium coordinates and writes; coding playbooks occupy `auditor-1` with GPT-6.1 Sol at medium. Optional seats are omitted unless occupied; consensus requires every occupied auditor on the same artifact. Only the engine executes configured release mutations.

## Project infrastructure

Boilerplate application infrastructure is configured in `projects/<id>.yaml`.
Read `docs/project-infrastructure.md` before changing container access, staging
test drives, deployment inspection or participant infrastructure guidance.
Every configured application has one staging container and at least one
deployment container. A configured application's project file documents its source/framework
ownership, SSH access, logs and isolated staging procedure. Do not assume projects
cannot run because they cannot run on the authoring host; use configured staging.
Deployment containers are for inspection during authoring. Candidate tests must
use the exact revision and must never call live-checkout deployment scripts.

## Commands

All npm scripts run from `gui/`:

```sh
./install.sh                 # once: deps, self-signed cert, production build, render systemd unit
./start.sh dev               # Vite (5173, hot reload) + API; open the Vite port, it proxies /api and /socket.io
./start.sh                   # production, one process serving dist/ on :443
systemctl restart devpanel   # how server/ changes take effect when running as a service (Node loads server/ once)

npm test                     # every suite; nothing in it can reach a real runtime or spend money
npm test -- engine           # suites whose filename contains "engine" (e.g. control, config, top-supervisor)
npm run visual               # Chromium layout suite; needs ./tools/install-browser.sh first, else it skips
DEVPANEL_REQUIRE_BROWSER=1 npm test   # fail instead of skip when Chromium is missing

npm run config:check                              # resolve every playbook offline (load only, no probes)
npm run config:check -- implementation --preflight   # one playbook in full, with harness probes
npm run preview -- <playbook> [--issue <project>/<id>] [--prompts]   # dry-run a run, reads config only
npm run publish:check        # does the tracked tree name this installation? greps it for host-config/publish-denylist.txt
                             # (tools/publish-check.mjs; no denylist, nothing to find)
npm run --silent selftest-history -- --project <id> [--test <name>]   # recorded selftest outcomes and which tests read
                             # as unstable, with the drives that made them so, as JSON; read-only (tools/selftest-history.mjs)
npm run --silent overview [-- --project <id>]   # run outcome metrics as JSON (generatedAt, scope, rates with
                             # of/total/means), archived history included; read-only, no session (tools/overview.mjs)
npm run --silent supervisor-calls -- --from <YYYY-MM-DD> --to <YYYY-MM-DD>   # the top-level supervisor's calls per started run
                             # for a stated period (inclusive UTC days) as JSON, from the ledger and run records, with what the
                             # ledger covers; read-only, no session (tools/supervisor-calls.mjs)
npm run contract             # launches the INSTALLED claude/codex CLIs to prove they still honour
                             # CLAUDE_CONFIG_DIR / CODEX_HOME. Local, read-only, spends nothing — but it
                             # is outside `npm test` because that suite may not reach a real runtime.
npm run policy:gemini        # free: hands the adapter's generated policies (auditor, and the writer with
                             # read-only roots) to the INSTALLED Gemini CLI's policy engine and records its
                             # decisions under live/reports/; the fence check binds the auditor hash to a live turn
npm run live                 # PAID live checks; refuses without DEVPANEL_LIVE=1 and an invocation ceiling
npm run live -- --harness gemini --model <wire> --fence   # PAID, one turn: asks a read-only role to
                             # write, run a command and change its own mode; the verdict is read off
                             # the filesystem, not from what the model says it did
npm run live -- --harness codex --model <wire> --efforts low,medium,high,xhigh,max --max-invocations 10
                             # PAID, 2 turns per level (fresh + resumed), at most 2 × levels ADAPTER invocations
                             # (no retry loop here; the CLI's own internals are not bounded). A level counts only
                             # when the whole session check passed AND the runtime's OWN session record names that
                             # level and model for both turns (codex rollout `turn_context`); the model's answer is
                             # never the evidence, and how the backend interpreted the level is not observed.
                             # --effort <one> for a single level; --resume-effort <other> requests a different level
                             # on the resumed turn (equal levels cannot tell honoured from inherited) — that run
                             # verifies the SWITCH and no level, and the report says so under `efforts.switch`;
                             # `attempted` means the ledger holds an invocation at that level. The cap must cover
                             # 2 × levels or it refuses before spending
npm run live -- --harness claude --model claude-haiku-4-5 --repo-broker --max-invocations 2
                             # PAID, one writer turn: in a private-repository worktree inside the fence, edit + git commit
                             # (worker Git dir) and one db_query through the broker's MCP shim (fake database); verdicts
                             # from the Git directories and the broker's evidence
npm run live -- --harness claude --model <wire> --tooling --project devpanel-project --max-invocations 1
                             # PAID, one read-only turn: the project's workspace.tooling mounts and declared commands
                             # inside the fence, offline; per path confirmed / refuted / not-run (isolation unavailable)
npm run live -- --jev        # PAID (~$0.00002), one request to the Jev decision provider; needs DEVPANEL_LIVE=1
npm run live -- --jev-integration   # PAID (~$0.0001), three requests: each rollout phase's real questions to Jev; DEVPANEL_LIVE=1
npm run live -- --openai-decisions  # PAID, one request to decisions/openai.yaml; DEVPANEL_LIVE=1. Needs a key at ~/.config/openai/key
```

Never run `install.sh` or `start.sh` as root; the service and everything else run as the project owner
(the user that owns the checkout). Port 443 works via `cap_net_bind_service` on the node binary.

Tests use a homegrown runner (`gui/test/run.mjs`): each `*.test.mjs` default-exports `async (t) => {}` and
uses `t.section / t.ok / t.eq / t.skip`. Skips are counted separately from passes on purpose. Config tests
copy the real `roster/ strategy-templates/ playbooks/ schemas/ harness/` into a temp sandbox via
`test/helpers.mjs`; they must never touch `issues/`. Preflight tests inject `fakeProbe`, so nothing is spawned.
The runner points `DEVPANEL_HOST_CONFIG_DIR` at an empty directory and `DEVPANEL_PROJECTS_DIR` at one holding
only an empty `devpanel-project/`, so no suite reads the host's own configuration, settings or projects; a suite that
tests them names its fixture directory explicitly.

Diagnostics go to `logs/devpanel.jsonl` (tail it), with the journal as a secondary log.

## Layout and who edits what

| Path | Holds | Edited by |
|---|---|---|
| `harness/*.mjs` | runtime adapters (`claude`, `codex`, `gemini`); the contract is `harness/README.md` | developers |
| `roster/*.yaml` | concrete models bound to a harness, with `efforts` and `verification.status` | operators |
| `strategy-templates/<id>/` | `strategy.yaml` (roles, phases, loops, review policy, completion) + `prompts/*.md` + `intents/*.yaml` (prompt overlays per kind of work, keyed by step id) | operators |
| `playbooks/*.yaml` | a strategy bound to participants, budgets, `checks.requirement`, `autoClose`, default `intent`. The normal catalogue contains `analysis`, `triage`, `implementation`, `plan-and-implement`, `staging`, and `deployment`; older IDs remain available for compatibility | operators |
| `decisions/<id>.yaml` | advisory decision provider (`jev`: TypeSafe Jev, the default; `openai`: the OpenAI Decisions API, beta; `model`: a verified roster model through its CLI, `decisions/model-oracle.mjs`), its client `kind`, endpoint, `credentialRef`, `threshold`, pricing (`decision-provider.schema.json`); `decisions/active.yaml` (`provider: <id>`) selects the one active provider, Jev when absent; see `docs/decisions.md` | operators |
| `projects/<id>.yaml` | optional per-project source repository and integration branch, workspace policy (`base`, `symlinks`, `excludes`, seat `tooling` mounts and commands), infrastructure, local `checks` (a project without SSH staging; docs/project-infrastructure.md "Local checks") and `actions` (`project.schema.json`) | operators |
| `host-config/` | an installation's own `projects/`, `roster/` entries naming a login or carrying its dated verification evidence, `roster-pricing/`, `playbooks/` and `decisions/` overrides, release `releases/<site>-targets.json`, `live-reports/`, `settings.json` (its defaults: projects root, proxy users directory, script header markers, test-drive unit user, forbidden prefixes, seat guidance; opt-in, all off by default: `projectDiscovery`, `dataRoot` (issues, logs, cert, token and host-config outside the checkout), `gitStore` (`runtime/git-store.mjs`), `nestedRepositories: include`, `harnesses.disabled`, `fence.readOnly`, `selection.allowedHomePaths` — the last two are refused when they reach a login entry of the home or the panel's data, `runtime/private-paths.mjs`; `config/host-settings.mjs`, `host-settings.schema.json`), `publish-denylist.txt` (what `npm run publish:check` must not find in the tracked tree) and `docs/`; git-ignored, `DEVPANEL_HOST_CONFIG_DIR` (relative to the config root; default `<config root>/host-config`, `config/host-config.mjs`). Each category is the union with the in-tree directory by file name, the host-config file winning (reported as shadowed). `examples/host-config/` shows it; `tools/migrate-host-config.mjs` (run by a person, never by a run) moves tracked files there and carries out a move manifest (`tools/host-move/manifest.json` when one is shipped). See `docs/host-config.md` | operators |
| `schemas/*.schema.json` | JSON Schemas every layer above must satisfy (validated with ajv) | developers |
| `issues/<project>/<date>-<slug>/` (under `<dataRoot>/issues` when the host settings name a data root) | issue.json, flat `NNN-<slug>/` steps, `runs/<run-id>/` state, `.archive.json` (all of `issues/` is git-ignored host data, never committed with code). An agent step folder holds only `response.md`; which run a step belongs to is read from the runs' records (`step.run` on the issue API), never written into the folder. When a run ends the supervisor writes its `NNN-result/` (`result.md` account + `changes.patch`), keyed `run-result:<runId>` so a later end rewrites it in place and agent input excludes it by provenance (`server/run-result-step.mjs`), unless the run starts with `runOptions.accumulate` (*Accumulate results from previous runs*): then earlier runs' products are frozen into its window (`runtime/prior-runs.mjs`, execution-contract.md "Earlier runs") | the engine / the API |
| `issues/.supervisor/` | top-level supervisor `state.json`, adapter ledgers, owner lock (git-ignored) | the supervisor |
| `docs/` | `execution-contract.md` and `top-level-supervisor.md` are the design authority | developers |
| `skills/devpanel/` | Claude Code skill + `devpanel.mjs` API client for conversations in any project (open, status, result, note, answer; never starts a run); linked as `~/.claude/skills/devpanel` | developers |

`docs/execution-contract.md` is the normative spec for runs, fingerprints, reviews, verification, closure,
locking and preview. Read it before touching `gui/server/runtime/` or `gui/server/config/`. `gui/README.md`
documents the HTTP/socket API, issue storage rules, the front-end conventions, and the test tiers.

## Server architecture (`gui/server/`)

- `index.js` — Express + socket.io over TLS, bearer-token or verified reverse-proxy basic-auth login (`auth.mjs`, `proxy-user.mjs`), or on a local single-user install
  (`DEVPANEL_AUTH=local`, loopback only) same-origin loopback requests (`local-login.mjs`), staleness banner
  (`staleness.mjs`), mounts issues, runs, supervisor and top-supervisor routes.
- `issues.js` — directory-backed issue/step storage. Identity is the directory name, not `issue.json`.
  `openedBy` (`opened-by.mjs`) records who opened an issue as `{user, host, from}`. `user@host` is the proxy login or the name given
  in the panel at the machine it connected from, or `supervisor`/`engine` at the panel host. `from` names the source
  issue and run for a follow-up, split, inquiry proposal or finding. Older issues derive it from their own record
  (`derived: true`) and are never rewritten.
  Step numbers continue from the highest existing step. Attachments are always served as octet-stream downloads.
- `config/load.mjs` — filesystem + schema only, never spawns. Produces one immutable resolved playbook
  (participants, effective settings after narrowing, prompt paths + hashes, budgets, contributing file hashes).
  `config/preflight.mjs` probes installed harnesses with an injectable `probe`; probe results are untrusted
  input validated against `harness-capabilities.schema.json`. Use `assertLaunchable(await preflight(...))`,
  never hand-test the `launchReady` field. `config/run-options.mjs` allow-lists per-launch overrides.
- `runtime/engine.mjs` — the phase interpreter. The next turn is *derived by replaying recorded steps*, never
  read from a stored cursor, so a crash between persisting a step and advancing is harmless. Expressions in
  strategy YAML (`when:` / `until:`) are evaluated by a deliberately tiny evaluator (`&&`, `!`, `==`), never code.
  Every item in a step's `context` list is appended verbatim to the prompt (all of them for coordinator-authored
  prompts, the un-rendered ones for templates), together with the output contract's definition and the run's
  scratch directory. A repair turn quotes the validator's error. Occupied reviewers of one consensus round run
  concurrently, and a revision's checks run beside its reviews (a failed check vetoes the round via
  `run.checkHistory`), or only after approval for `timing: approved` targets (staging test drives by default);
  a target with `tiers.smoke` does both: the smoke tier on every revision beside the reviews (a failure returns the
  author; no full drive for those bytes, unless the last allowed round's audit holds an `awaitsCheck` finding, which gets the drive before the loop exhausts), the full drive once on the approved revision, and closure, the confirmation
  and refresh-checks count only the full drive (records and events carry `tier`; none means full); an SSH full drive continues its smoke's proved running instance, executing only the commands the smoke did not run (`continuedFrom`), else runs from scratch and says why (`continuation`; `continuationPlan`, execution-contract.md "Reviews");
  a failed check is retried on the same revision (`retryFailed`, default 1; a later pass is `flaky`), unless an earlier revision already reproduced the failure (`retrySkipped`, `runtime/selftest-retry.mjs`); a triage `firstHandoff` is recorded as the round-0 brief without a second turn; all
  engine writes go through one queue. See "Reviews" and "Operator pause and resume" in execution-contract.md.
- `runtime/structured-output.mjs` — finds the JSON object in a response with a string-aware scanner (never a
  regex), prefers fenced objects, falls back to bare ones, rejects several *different* compliant objects as
  ambiguous, and classifies every rejection (`no-structured-output`, `contract-violation`, `ambiguous-output`).
  Validation is compiled from the snapshot's `contracts` (keyed by hash), never from the live schema files.
- Live output: adapters forward every raw stdout/stderr chunk via `observe.onOutput`; the engine appends them to
  `runs/<run-id>/live/<invocationId>.jsonl` and emits `run:event {type:'live'}` only after the write. Served by
  `GET …/runs/:runId/live/:invocationId?after=<seq>`; rendered by `src/components/LiveOutput.vue`.
- Revisions: the engine records `step.revision` after a `recordsRevision` turn; the author only echoes
  `basedOnRevision` (the revision it was told, or null). A wrong echo is a protocol failure. Per-turn `usage` is
  on the step with provider categories; `tokens` is the provider total, cache included for Anthropic.
- Plan references: `plan.current` (latest plan-stage author artifact) and `plan.approved` (the one the approving
  audit examined, with `approvedByStep`). `steps.plan.response` is only the first draft; do not use it in contexts.
- `runtime/store.mjs` — durable run state under `<issue>/runs/<run-id>/` (`run.json`, `resolved-playbook.json`
  with embedded prompt *bytes*, `outputs/NNN.json`, `artifacts/`, `events.jsonl`). Writes are write-then-rename,
  and state is persisted *before* the socket event is emitted.
- `runtime/launch.mjs` — run reservation, git-worktree provisioning by base policy (`workspace.base`: `head`
  refuses a dirty checkout, `working-tree` snapshots the checkout into a commit under `refs/devpanel/base/`
  — content-addressed: no run id in the message and HEAD's date, so an unchanged checkout repeats its base commit —,
  `{commit}` is explicit; recorded on `run.workspace.base`), a run-owned `scratch/` dir, preflight
  recording, ownership release, worktree-diff delivery.
  `runOptions.isolation: in-place` (the start dialog's checkbox) skips isolation: the workspace is the project
  checkout, delivery is recorded as `in-place`, checks are skipped and the checkout is never removed. Delivery stages exactly the fingerprint's changed paths,
  into a throwaway index seeded from the base commit (never the worktree's own index), diffs against the
  persisted base commit with `--binary`, rejects a patch whose touched paths differ from the fingerprint's change
  set, then rebuilds the candidate in a temp worktree and compares fingerprints; a mismatch blocks with
  `delivery-unverifiable` and keeps the worktree.
  `runtime/lock.mjs` — run lock and step-allocation lock carrying pid/boot-id/start-time;
  recovery must prove the previous owner is dead, not merely old. A failed or unreadable probe is `unknown`,
  never taken over (the supervisor labels such a run `owner-unknown`; execution-contract.md "Locking").
- `runtime/platform.mjs` — every host OS probe, in one module: boot and process identity, tagged-process
  inspection, mount discovery, and what the host cannot do (`run.host = describe()`). Linux is the former
  `/proc` code verbatim; darwin uses sysctl and ps (start times to the second; its `ps -E` reap scan is
  not proved: a listing that parses complete counts as complete with `mechanism: 'unproved'`,
  anything short of that is `structural` and only an acknowledgement settles it). Injectable (`platformFor(id, { exec, readFile, … })`);
  imports only node builtins, so runProcess can use it.
- `runtime/integrate.mjs` — operator-approved merge of a `commit` delivery into the project's integration branch:
  bound to the delivered revision, refused when the candidate's repository is not the declared source repository
  or the target is checked out dirty; conflicts abort and are recorded. `commit` delivery lives in `launch.mjs`.
- `runtime/source-delivery.mjs` — default delivery for Implementation, Plan and implement and Refactoring:
  apply the verified patch to the bound development checkout, under a repository lock, without committing
  or staging. Destination fingerprint verification gates resolution. `worktree-diff` remains selectable.
  Changed materialized-symlink paths are refused; drift on the patch's own paths leaves the patch for manual
  application or a rerun, drift elsewhere is applied beside (`application.composed`), and the next run of the
  issue starts from the undelivered approved patch (`runtime/carry-forward.mjs`, `workspace.seed`). Finalize uses destination/base fingerprints for recovery, retaining the worktree until verified.
  `runtime/apply-artifact.mjs` offers explicit application of completed retained patches, including old runs.
  `runtime/patch-check.mjs` answers, read-only and per owning checkout (following symlinked collections, C-quoted
  `ß.*` paths included), whether a run's patch would `git apply` now; the issue page (`PatchCheck.vue`) asks on every view.
- `runtime/checks.mjs` — the check runner: rebuilds the candidate from base + patch into a temp worktree,
  requires its fingerprint to equal the revision, runs the target's commands (`local`, or `ssh` with an archive
  whose hash is verified on arrival) with per-command logs under `runs/<id>/checks/<n>/`. The engine calls it once
  per revision after a `recordsRevision` step. Every command of every drive of a run gets `DEVPANEL_RUN_ID`, and a required command declaring
  `reportsUnavailable` ends the drive `unavailable` with the reason of its `devpanel-unavailable: <reason>` line (docs/project-infrastructure.md "One application snapshot per run"). A command marked `report: selftest` (an older spelling with a site
  prefix, `<site>-selftest`, is read the same) has its selftest report read by `baseline-failures.mjs`: a failed test whose name the
  base's report lacks, or a report that cannot be compared while failures are listed, makes `gatingResult` `failed`
  (`baselineComparison.selftest`); inherited failures never block, and the byte rules for failed commands are unchanged.
  `runtime/selftest-history.mjs`: each drive leaves a line in `issues/<project>/.selftest-history/`, and a test that passed
  and failed on one tree (`treeIdentity`, `targetKey`), or failed as new on revisions proved not to touch its module in 2 other
  issues, within 14 days, is `unstable`: its failure is in `selftest.unstable`, not `newFailures`, and does not gate, reported as
  ignored; each auditor who has not read such a drive re-reviews once per drive (`recheckDrive`; a reconcile's from inside the reconcile, `engine.noticeAuditors`),
  with no author turn; 5 consecutive passes expire it; `classifyUnstable: false` opts a project out (execution-contract.md "Unstable selftests").
  `runtime/baseline-cache.mjs`: a target's `baselineCache` reuses each tier's base drive across runs from
  `issues/<project>/.baselines/<key>/` only on an exact key (base commit, tier target hash, `files` content hashes on the
  target, the `environment` command's output hash); a component that cannot be read means no lookup and no store, and a baseline the run already holds is reused for a
  later revision only under the same identity (`identityKey`, set only on a hit or a drive whose identity read the same
  before and after); a hit
  is copied into the run's `checks/base-*` and verified against the entry's manifest (`baselineChecks[].reused`,
  `baselineComparison.reused`; otherwise `baselineChecks[].cache`); stored only when the identity read before and
  after the drive agree; pruned by `maxAgeDays`/`maxEntries`. A project may also keep a read-only npm seed on its
  staging host (a privileged command fills it from the deployed instance's lockfiles; prepare copies it into the private
  home): docs/project-infrastructure.md "Tiers", "Baseline cache", "The npm seed". `workspace.tooling` (allowLiveCheckout, allowedRoots) is stated in
  prompts and enforced by the adapters where possible (Claude permission deny rules and `--add-dir`; Codex
  `--sandbox workspace-write`); Bash is not path-fenceable and the adapters say so.
  A project's own tooling (`workspace.tooling.mounts` / `commands`, projects/<id>.yaml only, refused in a strategy or
  playbook; `runtime/tooling-mounts.mjs`, `runtime/tooling-commands.mjs`): each source is bound READ-ONLY at a
  worktree-relative target in every seat fence (claude, codex, gemini), proved before launch; the engine makes the
  target an empty directory without following a link out of the worktree. A missing source is recorded `missing` at
  resolution (never a config error; `config:check --project` warns) and refuses that project's seat turns naming it.
  Targets are left out of the snapshot, every fingerprint (`workspaceProjection`) and the patch. Declared commands are
  given to authors, auditors and the coordinator only as `cd <cwd> && /run/devpanel/tooling/offline sh -c '<run>'`
  (`harness/tooling/offline`: a fresh network namespace, no `--`; where that cannot start (Codex's sandbox) the
  runtime's own denial is accepted only when proved before the command — a seccomp filter and EPERM creating TCP/UDP
  sockets, IPv4 and IPv6, checked by `/usr/bin/python3 -I -S` with every variable unset and `LD_*` dropped before anything runs, proof
  only on exit 0 plus a per-call nonce —, which refuses
  loopback too; otherwise exit 125 = isolation unavailable, NOT run, no
  fallback), and "could not run" for a listed command must quote the attempt. Gemini seats have no shell and are
  told so. The panel's own project mounts `gui/node_modules` and `gui/.browser` (the browser suite builds into scratch,
  served through `DEVPANEL_DIST_DIR`); an application can mount its own formatter module for
  `harness/tooling/prettier-check.mjs`, which calls that formatter handler and compares. `npm run live -- --tooling --project <id>` is the paid proof.
  Candidate code execution is confined (0e, `runtime/remote-check-process.mjs`): local commands run inside the
  seat fence with an allow-listed environment (`local-enforced`); an SSH test drive whose commands all declare
  `kind: candidate | privileged` runs each candidate command as the unit user in its own transient unit inside a
  bubblewrap allow-list (candidate dir, read-only /usr /etc /sys, empty home plus `testDrive.confinement` paths;
  `network`, `service` (with `startedMarker`, started only when the unit is active and that file exists, within `startedTimeoutSeconds`), `join` = nsenter into the running service's fence, `unprivilegedPorts`) and each
  privileged one with the candidate masked; the launch bookkeeping lives in `<candidate>.control`; two engine
  probes decide `result.confinement.level` (`remote-enforced`, else `remote-unconfined` — labelled, never refused).
  The unit user and home are the project's `testDrive.confinement`, else the host settings'; there is no built-in
  account. See docs/project-infrastructure.md "Confined test drives".
- `runtime/diagnostic-drive.mjs` — an author's `authorArtifact.diagnosticDrive` (`{reason, patch, tier?}`): the check target once on the revision
  plus a patch in its scratch directory, applied only to the drive's temporary rebuild (`runChecks`' `variant`). Recorded in `run.diagnosticDrives` with no
  `revision` key, so no approval, gate, closure, baseline or selftest history reads it; the author gets the result in a further turn of the step and round
  (`step.diagnosticOf`), and every later seat's prompt says it was diagnostic. At most 3 per run, each at most once (`interrupted` after a crash). execution-contract.md "Diagnostic drives".
- `runtime/working-tree.mjs` — what `git add -A` would make of the untracked tree, used by BOTH the launch
  condition and the `working-tree` snapshot so a reading cannot be more permissive than the build: a nested
  repository is `gitlink:<HEAD>`, an unreadable file or special file BLOCKS (`UNREADABLE_WORKTREE`), a
  vanished path is re-read once then reported as `MOVING_WORKTREE`. It also holds how the launch path reads git: an
  output only counted or hashed is streamed (`streamGit`, `statusCounts`), a listing that must be held is bounded
  (`gitRead`, `GIT_OUTPUT_LIMIT`, 256 MiB, gate and provisioning alike) and over the limit refuses `GIT_OUTPUT_LIMIT`.
- `runtime/fingerprint.mjs` — revision identity: sha256 over the full content set including explicit deletions;
  file mode is the executable bit only (what a Git patch can rebuild), and the `rule` is recorded on the revision.
  Approvals, checks and closure all bind to a fingerprint; any change invalidates them. A rule change is not a
  change: closure re-fingerprints under the recorded rule and, if that reproduces the approved revision, re-expresses
  it under the current rule with approvals carried (`migratedFrom`).
- A run blocked at delivery (`delivery-unverifiable`, `delivery-failed`, `delivery-unavailable`,
  `candidate-changed-during-delivery`) offers `finalize`: `engine.finalize()` re-evaluates closure from the retained
  worktree under the same conditions; it completes only what was already approved.
- A code run blocked at closure (`closure-conditions-unmet`, `refreshed-checks-failed`) offers `continue`
  (**Continue playbook**, `engine.continueRun`, supervisor `continue_run`): an operator decision step
  `<phase>:continue` carrying the instruction, the closure record and the issue notes added since the run began;
  replay counts the loop's last round as not passed and runs one more, then confirms again. Resume would only
  replay to the same closure.
- Accept check result (`engine.acceptCheckResult`, supervisor `accept_check_result_run`): named failures of the latest full check on an
  approved revision stop blocking it, recorded on `run.closure.acceptedCheckRisk` only once every other condition but delivery is met (a
  missing confirmation is asked for first; `run.checkAcceptanceRequest` accepts nothing). `verificationLevel` stays `review-only`; delivery
  and reconcile are the normal ones, and a failure nobody named is refused. execution-contract.md "Accepting a check result and delivering".
- The engine returns an unmet confirmation itself (`engine.returnToReview`): the confirmation classifies each unmet
  criterion (`criteria[].unmet`; unclassified is a contract violation). When only the confirmation failed and every
  unmet criterion is `missing-work`/`missing-evidence`, an `implementation`/`plan-and-implement` run records an
  `automatic` decision step `<phase>:return` (actor `engine`) carrying blocking `closure-<id>` findings, replayed like
  Continue; later audits give each a `priorFindings` disposition. At most 2 per run (`run.closureReturns`); otherwise,
  or for an operator matter, it blocks as before with `closure.notReturned`. The confirm step has `access: checks`
  (read-only `checks/` + `evidence/` inside a proved fence) and always gets the check's gating and baseline comparison.
- Checks-only stops: an approved revision whose check failed and that the author answers unchanged ends the loop as
  `checks-failed-unchanged`; that, or `rounds-exhausted` with every auditor approving the latest revision and its check
  not passing (`checksOnlyBlock`, run-control.mjs), offers `refresh-checks` to rerun the checks on the candidate.
- `runtime/process.mjs` — spawning with cancellation that terminates the whole process group and awaits
  confirmed termination before reporting. A reaped command's escaped descendants are found by their
  `DEVPANEL_REAP_TAG` (`leftovers.scan`: complete | incomplete | unavailable | not-requested); a turn whose
  scan is not complete blocks `cleanup-unproved` until a proof or a recorded operator acknowledgement, and an
  in-place run's open entries bar the project checkout (`runtime/cleanup-barrier.mjs`, execution-contract.md
  "Escaped descendants"). `runtime/command.mjs` resolves CLI binaries
  (`DEVPANEL_CLAUDE_BIN` / `DEVPANEL_CODEX_BIN`, PATH, then `~/.local/bin`).
- `project-actions.mjs` — operator scripts on the live checkout: every project with a `checkpoint.sh` gets a `checkpoint`
  action (an installation's own script, typically version, commit, publish), `projects/<id>.yaml` `actions` add or replace. One
  operation per project at a time, recorded under `issues/<project>/.actions/<id>/` with output appended before
  its `project:action` socket event. Operators run these from the project page or with
  `project-action-cli.mjs`; the top-level supervisor has no action for them. See `docs/project-infrastructure.md`.
- `decisions/` — advisory decision provider (TypeSafe Jev by default, or the OpenAI Decisions API when `decisions/active.yaml`
  selects it; `advisor.mjs` builds the client from the provider's `kind`, transport shared in `http.mjs`), never a harness or seat and never an authority for
  approval or closure. Typed questions (`noul`/`choice`/`score`) are validated before sending, and answers are
  checked against what was asked. Each ask is recorded (answered or unavailable) under the caller's directory
  BEFORE it returns, so a replay never asks again. It is priced on the ledger (`subject: 'decision'`), and
  `confidentAnswer()` is the only thing a caller may branch on. All callers go through `advisor.mjs` (the real
  client, the top-level supervisor's ledger, nothing asked without either). `pregate.mjs` asks before a Triage start
  and a confident close/needs-input HOLDS it (`PREGATE_HOLD`); only an operator confirms a proposal or overrides with a
  reason. `wake-filter.mjs` holds routine supervisor events (failures, pauses, unresolved endings never), and issue-list changes
  outside the operator's declared `state.campaign` or confidently judged outside the mission with no timer, merged per project, until the next wake; one that cannot be placed wakes.
  `failure-advisor.mjs` may turn a `runtime` failure into `transient`/`rate-limit`, never `quota`/`auth`.
  `GET /api/decisions/triage-shadow` reports agreement. The issue page's Assess bar (`AssessBar.vue`) asks the pre-gate questions of the provider (default) or of any verified roster model at any of its efforts (`decisions/model-oracle.mjs`: one tool-free CLI turn, answers checked by `checkAnswers`, recorded as provider `model:<id>` with the provider's threshold, under the same ledger, admission and availability holds). The provider is on the Model availability page as
  `decision:<id>` in the same store: hold/clear/test there, a rejected key or rate limit holds it. See `docs/decisions.md`.
- `runtime/coordinator-chat.mjs` — the operator's chat with a run's coordinator (`CoordinatorChat.vue`, `GET/POST
  …/runs/:runId/chat`). A question is answered in a tool-free FORK of the coordinator's native session (adapters'
  `fork: true`) and changes nothing. An instruction is delivered verbatim in the next coordinator turn and recorded on
  that step (`step.instructions`); a fresh session gets all of them. Both are in `runs/<id>/chat.jsonl` (not run state).
  Adapters request thinking or reasoning summaries so the panel can show a turn's reasoning. See execution-contract.md
  "The operator can ask the coordinator, and instruct it".
  The top-level supervisor has the same split (docs/top-level-supervisor.md "Instruct, ask, and its questions to the
  operator"). Its chat is Instruct, and `ask` forks its session. Its calls stream to `issues/.supervisor/live/`
  (`supervisor:live`). `ask_operator` records questions that appear in Needs attention and on the issue page, and
  their answers arrive as `operator-answer` events.
- `inquiry.mjs` + `issues.createInquiry` — supervisor inquiries (Phase 4): a technical question stored as an issue
  with `kind: "inquiry"`, answered by an analysis run with `runOptions.inquiry: true` frozen in the snapshot, which
  publishes nothing (findings stay `reportDisposition.proposals`; `create_issue … fromInquiry` turns one into an issue,
  once). State rows from the latest run; answered inquiries pack themselves once settled, others need close (with a
  reason) or acknowledge, bound to the latest run; a closure is terminal until reopened. Start, answer/resume/recover,
  finalize, close/acknowledge/reopen and packing take the durable `issues/<project>/.admission.lock`. Inquiries stay out
  of UI issue lists, Needs attention, priorities and dispositions, never out of admission or accounting.
  See docs/top-level-supervisor.md "Inquiries".
- `broker/` + `harness/mcp-devpanel.mjs` — the broker (Phase 3): when the run's infrastructure declares an environment
  `database`, each seat with tools gets a per-turn MCP server (`inspect_environment`, `db_query`) over a per-turn Unix
  socket; token bound to run/invocation/seat, grants checked per call (staging by declaration, production by an
  operator grant in `<issue>/grants.json`), allow-list query grammar, caps, evidence in `runs/<id>/evidence/broker/`
  before the result returns. Inert today: no project declares a database and the `mongodb` driver is not installed.
- `supervisor.mjs` — issue-run lifecycle: one run per issue, durable and stoppable before it spends,
  ownership reconstructed at startup (a live run with a dead owner is `recovery-required`, not stopped).
  `runtime/source-repository.mjs` proves the source checkout readable in `start()` — after the project and
  playbook resolve, before `reserveRun()` and paid preflight — so both panel and supervisor starts share it.
  `UNSAFE_REPOSITORY`, `EMPTY_REPOSITORY`, `NOT_A_REPOSITORY` and `UNREADABLE_REPOSITORY` are refused with the
  remedy; there is no run yet, so the classification (`class: 'environment'`, `started: false`,
  `retryable: false`) is on the rejected start, not on `run.failure`. Cleanliness stays the base policy's call:
  `launch-preconditions.mjs` reads that policy (clean base under `head`, escaping tracked symlinks under
  `reject`) before reservation too, so a doomed start is refused before paid preflight; provisioning re-checks.
  `shutdown()` records a pending pause as a pause and any other stopped run as `cancelled` with `stoppedBy: 'service-shutdown'`;
  `resumeInterrupted()` resumes those at the next start (host settings `resumeAfterShutdown`, default on; execution-contract.md "Operator pause and resume").
  `resolvableBy` is capability, never permission. The supervisor has no direct checkout command, and source
  delivery requires a usable base; a repository fault therefore becomes an issue rather than an improvised command. Project actions are an
  operator capability on the project page. An action may declare `effect: commit-checkout` (`projects/<id>.yaml`
  or a `# DEVPANEL effect:` header; the host settings may name another marker word) to state what it does rather than leave it inferred from a filename — a script
  may also version, publish, restart or deploy.
- `runtime/path-overlap.mjs` — would this candidate write files another project's live run is touching? Compared at the real destination, through links (`related` plays no part): expected paths from the issue's earlier runs (retained worktree, patch, plan text; none reads `unknown`, never `none`), a live run's from its worktree now and its plan. On readiness and preview as `pathOverlap`, an information prerequisite; every start reads it again and records `run.startOverlap`. It refuses nothing, for operator and supervisor alike. docs/top-level-supervisor.md "Readiness".
- `runtime/call-cost.mjs` — a supervisor call's estimated cost from its own tokens and `roster-pricing/<id>.yaml` (unhashed, beside the entry), when the runtime reports none; a Codex delta counts only after a turn that proved a clean baseline (`state.ownUsageSession`). Marked `estimated` on the ledger, `cost` on the view; else unknown and counted.
- `runtime/ledger.mjs` — append-only spending ledger (`issues/.supervisor/ledger.jsonl`): `reserve`/`settle`/
  `release`/`wake` lines, replayed on load, a torn final line truncated and reported. An outstanding
  reservation counts in full (fail closed); an unknown cost never gets an average, it consumes the
  unpriced-run allowance; an overage is recorded on the settlement and the window holds what was really
  spent. UTC windows (no org timezone in config; another zone throws). Wakes are durable so a restart
  mid-chain resumes the same call count. New session cannot alter it — separate file from `state.json`.
- `runtime/spending-policy.mjs` + `issues/.supervisor/spending-policy.json` — calendar windows beside the
  session limits: `daily`/`monthly` `{starts, usd, unpricedRuns}`, `perWakeCalls`, `concurrent` (an older
  `perIssueStarts` key is accepted and ignored: retries per issue are the session limit `maxStartsPerIssue`); unpriced runs and unpriced CALLS have separate allowances (one shared pool let calls exhaust
  the run budget while staying unbounded). A window checks exhaustion FIRST — committed >= the USD ceiling
  refuses every subject, priced or not — because an unpriced allowance permits risk while money remains, never
  a bypass once the overspend is known. Money is integer micro-USD throughout; dollars only at the edges.
  A reservation that cannot be written stops the call. Validated at startup; absent/unparseable/invalid means **not active**, and only the
  session limits gate (`spending.decides` on the view says which). Active, the session limits still gate first
  and the windows gate as well. Scopes are exact: `maxCalls`, `maxRuns`, `maxStartsPerIssue` and the
  failed-launch guards per SESSION (Start and a server restart resume them; only an operator's New session
  renews them — the model has no reset action); `perWakeCalls` per durable event chain; daily/monthly starts,
  money and unpriced allowances in persistent UTC windows across sessions; `concurrent` instantaneous
  occupancy. `state.history` accumulates earlier sessions' usage as accounting that decides nothing. New
  session restores no spending — the ledger is a separate file — and exactly the session limits.
  A start reserves the configured
  `maxCostUsd` carried from its preview, before the external call; without one it is unpriced and draws on
  that allowance. Settlement happens where the run's outcome is first observed; a definite non-start releases
  with a reason, an uncertain one stays committed. A per-wake refusal ends the chain, never the activation.
- `supervisor-summary.mjs` — what the top-level supervisor is shown: run, step, preview and issue summaries, plus
  the authoritative `remaining` budget block. Detail is on demand via `get_step` and `get_file`. A run change reaches
  it as `runDelta` (status, phase, checks verdict, blocked reason, what it acts on), `get_run` only for detail; a live
  run's progress wakes nobody and rides with the next wake (`holdProgress`).
- `ready-queue.mjs` — what the supervisor could start next, read by the engine and sent in the prompt as `readyQueue`
  when it says something new: the declared campaign's issues (no campaign: the whole panel) in dependency order, each
  with `blockedBy[].until {event, at}`; an observation, `start_run` still decides. When an issue that waited could start
  now (`supervisor.projectHolder` reads a project's lock, owned run or not) a `capacity-freed` event wakes it with `next`,
  past the wake filter. docs/top-level-supervisor.md "The ready queue".
- `runtime/run-metrics.mjs` — convergence measurements read off the run record, never stored by the engine:
  round EXECUTIONS per phase ((cycle, round) pairs a seat ran in, with `cycles` and `maxDepth`) beside cycle
  restarts and ignored `restartPlan` requests; the elapsed time split into agent time / operator wait /
  suspended / other, built from disjoint intervals because a decision step and `controlSuspendedMs` record the
  same answered wait twice (`waitsInControlTotalMs` names it, `overlappingSuspensionMs` is recorded suspension
  inside a wait, `inconsistentMs` when the parts exceed the whole; an open question is never taken out of an
  older record's total); and reviewer finding
  SLUGS (id after the seat prefix) as distinct / matched by another seat in the same review / restated by the
  same seat / repeated later — slug equality is evidence of agreement, not proof of one defect, and the reading
  says so — with `findings.blockingByRound` giving each review's blocking findings (`blocking`, `blockingSlugs`). The engine marks each coordinator effect's `reset` (`plan`/`evidence`); a fresh first step that no
  recorded reset explains is an inferred restart (`restartsInferred`, basis `inferred`/`mixed`), reconciled
  boundary by boundary so a record resumed across the upgrade keeps its history. Check time is `checksMs` (union of every
  recorded check interval: `checkResults` and their attempts, `priorCheckResults`, `baselineChecks`, and `checkHistory`
  entries' `runs`, each check run's own interval; never the span around them) and `waitingForChecksMs` (the part no seat
  turn, finished or still in flight, overlapped, taken out of `otherMs`); `regressionsAfterApproval` counts checks that
  failed (inherited failures included) or whose baseline comparison named new failures, on a revision approved when they began
  (the engine records `afterApproval` on each `checkHistory` entry; older records are inferred, `regressionsBasis`).
  On `GET …/runs/:runId` as `metrics`, in the run summary,
  and totalled per group in `overview`; in `bySeat` the whole-run figures are a participation cohort and only
  `seat` is that seat's own turns and time. Compare groups of the same `configHash` before changing seats or models.
- The top-level supervisor is the **management plane**; coordinators and their agents are the execution plane.
  Its charter is fixed in the prompt and no message replaces it. Visibility is panel-wide and unconditional —
  `projects` is every project, a named one is checked for existence only, and `focus` merely orders attention.
  It has no direct checkout command. Deliberately, `start_run` with `apply-to-source` authorizes engine-owned
  application of an approved patch to the destination named in readiness/preview. Patch-only delivery remains
  selectable; this bounded indirect write authority does not authorize commits or arbitrary scripts. Safety is carried by the
  capabilities themselves (budgets, concurrency, per-issue retries, archive policy, action vocabulary).
- Its prompt carries `seatModels` (every roster entry with `verified`/`verification` evidence, `available` from
  the host availability store, `contextWindow`, `efforts`, `notes`) beside `playbooks`, because a playbook's
  participants are defaults and `runOptions.participants` may name any roster id for any seat. `overview {}`
  (`supervisor-overview.mjs`) returns the whole panel: open issues with age and priority, and run history with
  rates that always carry `{of,total}`, live/paused excluded from denominators, archived issues included,
  `readiness {project,issueId?,playbook?,runOptions?}` (`supervisor-readiness.mjs`) reads repository, ownership
  and budget fresh as `baselineReady` (never "runnable"); naming a playbook resolves it and evaluates its base
  policy too, reported under `configuration` with `configHash`, observed head/source fingerprint and
  `observedAt`. It reserves nothing and spends no allowance, and is an observation, not a guarantee —
  `start_run` re-checks everything — admission stops at the first refusal, so without it a
  budget-blocked supervisor reports whichever fault it last saw. Groupings are by seat·model and by the run's exact resolved `configHash` (on `run.playbook.configHash`, else read
  back from the snapshot), so editing a playbook starts a new group instead of rewriting old statistics.
- `issue.dependsOn` (`issue-dependencies.mjs`) names prerequisites; the supervisor's `start_run` refuses while one is
  unsettled (no disposition, not archived) and `overview` shows `waitingOn` and a 7-day `flow7d` per project. A cycle
  of any length is refused. An accepted split chains its parts in triage's order (`owner-input.mjs`). Provenance
  (`openedBy.from`, a tree) and order (`dependsOn`, a graph) are separate: a follow-up or finding is born after its
  parent's run ended, so it gets no automatic prerequisite. `issue-family.mjs` derives both on read (`family` on list
  items, `GET …/issues/:id/family`); the list nests children under parents, the issue page shows `IssueFamily.vue`.
- Run deletion: `DELETE …/runs/:runId` (`supervisor.deleteRun`, operator only; the trash icon on the issue page deletes
  on the click) removes a settled run's workspace (`launch.removeRunWorkspace`, never an in-place checkout), its
  `runs/<id>/` and its step folders, under the issue's run lock; live and paused runs are refused. Step reservations
  stay so numbers and provenance never repeat; the ledger stays as accounting.
- Manual landings: `POST …/runs/:runId/landed` (operator) and `mark_landed` (supervisor) record `run.landed`
  (`applied`, `commit` or `checkout`, `by`, `landedAt`/`recordedAt`, `handChanges`, the run's latest `revision`) on a settled
  run, once: `supervisor.markLanded` loads the run's engine holding the run lock and `engine.recordLanding` re-reads
  the run under that lock, judges every refusal on that reading, and writes it through the engine's queue. An explicit claim — nothing is read from git — that makes
  `run-result.mjs` read `delivered`/`manual-landing` and the explanation name who landed it; outcome, closure and approvals
  are untouched. Refused when the engine already delivered to the source. The overview counts `delivered: { engine, manual }`
  per run group (with `deliveryRate`) and in `flow7d`, and lists each open issue's delivered runs.
- `issue.priority` is execution order (`urgent|high|normal|low`) with `reason`, `by`, `at` and `previous`. Set by
  an operator (issue page, `POST …/issues/:id/priority`) or the supervisor (`set_priority`); a coordinator may
  recommend but never write one. Pre-existing issues read as **unset**, never defaulted. `priorityHistory` is
  append-only and the decision in force is derived from its last entry.
- `top-supervisor.mjs` / `top-supervisor-service.mjs` / `supervisor-response.mjs` — the top-level supervisor:
  one persistent native session, one proposed action per reply as a single JSON object, one formatting-repair
  turn, existence-checked projects (visibility is panel-wide; `focus` only orders attention), preview-hash
  binding, budgets and archive permission. Limits
  are `maxCalls` (runaway guard, default 200), `maxStartsPerIssue` (retry guard, default 2), `maxRuns` (ceiling,
  default 20), `maxConcurrent` (default 1). There is deliberately no activation time limit. The run supervisor
  enforces one live run per project, in-process and against persisted runs with a live lock owner.

## Harness adapters (`harness/`)

A harness is a runtime, not a model or provider. A roster entry's `account` is another PERSON's login on the
same provider (several people share one panel): it gives that entry an isolated `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` named `account-<name>`, clears every inheritable credential so an un-logged-in directory fails as
unauthenticated, and is mutually exclusive with `endpointRef`/`credentialRef` (login vs provider). Each person
logs in once by hand against that directory. `npm test` proves the account reaches the spawned process (a fake
CLI records its environment, with ambient credentials seeded so the clearing cannot pass vacuously);
`npm run contract` proves the installed CLIs still honour the variables at all (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `GEMINI_CLI_HOME`) — an isolated home reporting a
LOGIN fails rather than skips, since that is exactly the regression. The account is part of the connection identity, so one login's
probe never vouches for another's, and changing it archives the supervisor's native session instead of resuming
it. The account/provider conflict is enforced in `roster-model.schema.json` (account implies `profile: default`
and forbids endpoint/credential refs), not only in the adapter. `overview.bySeat` groups by roster entry, not
by account — per-account totals would need an explicit `byAccount` grouping, which does not exist. `glm-via-claude` is the `claude` adapter under its `glm`
profile with endpoint/credential substituted from roster *references* (`env:NAME` etc.); credential values
are never stored, logged or written to run metadata. Adapters export `id`, `capabilities`, `probe()`,
`invoke()` and `reconcile()`. `claude` and `gemini` pre-assign session ids (`--session-id`, resumed by that
exact uuid — never `latest` or an index); `codex` discovers them after
the first exec, so reconciliation after a crash needs the `marker` embedded in the session.
`gemini` is a real adapter rather than a profile (Google publishes no Anthropic-compatible endpoint) and its
permissions are an ADMIN-tier policy file written per invocation, because its plan mode auto-approves its own
exit in headless runs and so cannot fence anything. Mode transitions, subagents, skills and MCP are denied for
every seat; write and shell tools reach only the source writer; the supervisor gets no allow rule at all.
The runtime fails OPEN around that file — it drops `--admin-policy` with a warning when `/etc/gemini-cli/policies`
holds any TOML, a malformed one only warns, a missing one is ignored — so the adapter checks that directory before
launching, aborts on `[ADMIN] Policy file error` or `Ignoring --admin-policy`, and requires a positive
acknowledgement: the policy names a tool that does not exist (`glob_`), the runtime warns about it naming the
file and the ADMIN tier, and a turn without that stderr line is an environment failure, never an accepted
answer. Authentication is pinned through a per-invocation copy of the host's system settings
(`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, method selected and enforced), because the runtime reads `selectedType`
before any environment variable and system settings outrank the operator's `~/.gemini` and the candidate's.
Gemini has no read-only workspace root, so a non-writing seat has no write or shell tools at all (no scratch
writes, no test runs); a writing seat's read-only roots (evidence, configured roots) are bind-mounted
read-only over themselves through bubblewrap for the turn, proved from inside the sandbox before launch (a
missing root or bubblewrap refuses the turn), because the runtime resolves relative paths, strips NULs and
follows links AFTER the policy matched the raw arguments, so no spelling rule can be the boundary; the policy
still names the roots (configured, resolved and relative spellings) and refuses every non-canonical spelling
(`..`, `.`, empty segments, NUL) so a refusal is explained, denies a root that CONTAINS the worktree or scratch
whole with only those areas allowed back, and denies the shell for that turn; `allowLiveCheckout` is refused for a
writing seat rather than approximated. The live `--fence` check passes only when each fenced capability was
attempted and refused per `diagnostics.toolCalls`; a turn that attempted nothing is inconclusive. It
exposes no effort control (`efforts: []`, an override is refused) and reports no cost, so its runs draw on the
unpriced allowance. `docs/model-providers.md` is the reference; the panel supervisor is still claude/codex only. Both stream the
runtime's events (`--output-format stream-json --verbose` / `exec --json`) and report them through
`observe.onActivity`; the engine records them on `pendingInvocation.activity` as liveness evidence only.
Seat hygiene: new runs resolve with `fence: { hygiene: 1 }`; under it the child environment is an allow-list
(`childEnvironment()` in `harness/shared.mjs`: process basics plus the one provider's own variables, never
`DEVPANEL_*`), Claude workers run with `--setting-sources project`, strict empty MCP, a named tool list and
`acceptEdits` with explicit allow rules instead of the operator's `auto` mode, and Codex workers with
`--ignore-user-config --ignore-rules`; see `harness/README.md` "Seat hygiene".
New runs also resolve with `selection: 1` (materialized links carry their owner's `ls-files` selection,
`runtime/selection.mjs`; delivery projects the destination the same way and refuses `selection-rules-changed`)
and `namespace: 1`: Claude and Codex seats and coordinators run inside a bubblewrap allow-list namespace
(`harness/fence.mjs`: only the run's paths, the CLI's install and its config directory; proved before launch;
an unproved fence runs the turn as `namespace: 0`, recorded on the step). `DEVPANEL_FENCE=off` switches it off
(the test runner's default, since fake CLIs live outside any run). A host without bubblewrap (macOS) refuses seat
turns, tooling commands and local checks unless the install opted in with `DEVPANEL_UNFENCED=acknowledged`
(`install-on-osx.sh`; `runtime/confinement-policy.mjs`): then they run unfenced, recorded (`run.unfenced`, namespace 0,
`local-unconfined`, commands rendered unwrapped and labelled unconfined) and flagged in the panel; Gemini seats are
refused there (`docs/macos.md`: the macOS account and its proof checklist). Declared tooling mounts are bound only by a proved fence: any other turn with tools, in place included,
is refused naming the mount. Host Git calls on a run's worktree name the git
directory recorded at provisioning (`runtime/engine-git.mjs`), never the worktree's seat-writable `.git` entry.
Inside a proved fence a Claude seat's config directory is a per-run home (`runs/<id>/cli-homes/<seat>`, only the
credential file bound in; recorded as `session.home`). The triage step of Implementation and Plan and implement
is `access: read`: that coordinator turn reads the run's snapshot inside the fence (own session `p.readSession`),
records `triageResult.facts`, and stays tool-free when the fence cannot be proved.
New runs also resolve with `repository: 1` (0d): the worktree gets private Git directories under
`runs/<id>/git/` — `engine` (a depth-1 fetch of the pinned snapshot ref `refs/devpanel/base/<run>`, the recorded
`workspace.gitDir`, never mounted) and `worker` (named by the worktree's `.git`; objects borrowed read-only from the
engine; writable by the writer, read-only to other seats; no history). The source repository keeps no worktree
registration and is never mounted. A `commit`/`apply-to-source` candidate is verified in the engine directory and
published into the source by `runtime/publication.mjs`: transfer to a temporary ref, translation of the reviewed
delta onto the source base A (`workspace.sourceBase`; `identity` when the snapshot is A), one `update-ref --stdin`
transaction for `refs/devpanel/reviewed/<run>`, `refs/devpanel/candidates/<run>` and the branch, journaled in
`runs/<id>/publication.json`. Integration merges the translation and refuses a merge whose paths differ from it;
an untranslatable delta (materialized, excluded or symlinked-in-A paths) refuses `commit` delivery
(`integration-translation-failed`). Release removes the tree and `git/`; the refs stay.
`scratchDir` is exported to the process as `DEVPANEL_SCRATCH_DIR` and `TMPDIR`. Adapter ledgers
live in run metadata, never inside the worktree (they would change the fingerprint and ship with the patch).

Cancellation must actually kill the child and its descendants and await termination before reporting; the
engine releases the worktree on that report. The fake harness in `gui/test/fakes/` only races the signal.

## Invariants worth knowing before changing behaviour

- A playbook is resolved and snapshotted at run start; editing YAML or prompt templates never affects a run
  in flight. Turns render from the embedded prompt bytes in `resolved-playbook.json`.
- Requirement (policy: `required | optional | none`) and result (`passed | failed | not-run | unavailable`)
  are separate fields. A playbook may only strengthen a strategy's check requirement. `unavailable` under
  `required` blocks; it never downgrades. A smoke-tier result never satisfies closure: only the full drive does.
- Verification level (evidence) and `autoClose.minimumVerification` (authority) are separate. Default authority
  is `verified`; a playbook may opt into `review-only` with a written justification.
- An unparseable auditor result is a protocol failure with bounded repair, never a `changes-needed` finding.
- Substantial findings from plan review become `findings.plan`. The implementation audit must give each a
  disposition in `reviewResult.priorFindings`, exactly one per id; a `deferred` one stays outstanding (source
  `plan-review`) and makes `approved` a contradiction. A review under protocol repair contributes no approval.
  `closureConfirmation.residualRisks` is kept on `run.closure`.
- The effective closure authority is the resolved playbook's top-level `autoClose` only; `completion` no longer
  carries the strategy's own `autoClose`.
- Intents change prompts only, never shape. `runOptions.intent` may pick another intent of the same strategy; it
  is validated at resolution and snapshotted. The `analysis` strategy uses the `documentArtifact` contract, records
  no revision, delivers nothing (`delivery: none`) and closes review-only; the coordinator's confirmation need not
  name a revision when none exists.
- Roster `efforts: []` means "supports none" (fact); `efforts: null` means unknown. Unverified roster entries
  resolve for preview but are refused for live runs.
- A roster model is verified with real adapter calls for access and session resume: the bounded live
  session check (two short calls per model). Mark verified only after success; record failures honestly.
  Connectivity verification does not establish supervisor quality or untested effort levels. The report and
  its dated evidence belong to the installation that ran it: they go in its `host-config/roster/` copy of
  the entry (and `host-config/live-reports/`), never in the tracked catalogue. Whether such calls need the
  owner's approval each time is the installation's rule (`CLAUDE.local.md`).
- Round/budget exhaustion, disagreement and protocol blocking leave the issue *unresolved*; only the full
  closure checklist (same-revision approval, checks satisfied, no blocking findings, coordinator confirmation,
  delivery completed) closes it. Budgets are `maxSteps`, `wallClockMinutes`, `maxTokens` and `maxCostUsd`
  (known cost only; unpriced steps are counted in `used.costUnknownSteps`).
- Runs are autonomous (execution-contract.md "Asking the owner before any work starts"): triage records a required
  `autonomy.verdict` (`autonomous` | `needs-owner-input` with questions | `too-large` with a split); anything
  but autonomous ends the run after triage via `to: ask-owner` (`run.ownerInput`, result `needs-input`, no
  slot held), and `POST …/runs/:runId/owner-input` (`server/owner-input.mjs`) records the answer, writes it as
  an issue note and restarts the same configHash, or turns an accepted split into issues. Shipped review loops
  use `onExhausted: extend-if-converging` (one extra round only when findings shrank and none reopened; nobody is asked).
  `operatorRequest` needs a `category` (`live-checkout` | `owner-gate` | `authorization` |
  `requirement-conflict`) and a `recommendation`; technical choices go to handoff `assumptions`, listed in
  `result.md`.
- Operator decisions are steps. A phase transition `to: await-input` (with a `question`), a loop
  `onExhausted: await-input`, or the coordinator's own `operatorRequest` on its `handoff` pauses the run
  (`status: paused`, `run.pause`); `engine.answer()` records the
  answer as a step with role `operator` and the run replays past it. An `operatorRequest` is how a run asks
  for work only the live checkout can take (`pause.request`, recorded once in `run.operatorRequests`): the
  supervisor cannot run it either — `pause.request.projectAction` names what a person could do — so it answers
  with what is actually true and opens an issue for the work. Requests are applied before any other coordinator effect on
  the same handoff, or a window decision would block the run or reset past the step that asked. A closed question (`pause.options`) accepts
  exactly one option, never prose. Every later step may name `decisions` in its context. Operator steps spend
  no step budget.
- Runtime failures are classified (`runtime/failure.mjs`): `rate-limit`, `transient` and `output-limit` are retried after a
  bounded wait (`retryPolicy`, default 3 attempts, 30 s doubling, 10 min cap, provider retry-after honoured);
  `quota` records the model in the host-wide availability store (`issues/.availability.json`) and later starts
  naming it are refused until the recorded reset (the Model availability page at `/models`, `GET/POST/DELETE
  /api/availability[/:model]`, shows every roster model's record and lets an operator clear or hold one); `auth`, `environment` and `runtime` fail the run with
  `run.failure` on record. Nothing is retried silently: every attempt is in `run.failures`.
- Audit steps use strategy-owned templates (`audit-plan.md`, `audit-implementation.md`, `audit-draft.md`); the
  coordinator's handoff is context, never the whole prompt. The implementation auditor receives `revision.diff`,
  the candidate as a patch computed from the worktree. A substantial finding (blocking, or major/critical)
  without `criterion` and `location` is a contract violation and goes to protocol repair.
- A run's outcome never sets the issue's state. `run.outcome` is only the closure record; what a run achieved is
  derived by `runtime/run-result.mjs` (`reported`, a triage decision, `delivered`, `artifact-ready`, `staged`, `deployed`,
  `completed`, else `incomplete`) and is never "resolved". How a run stands is said to people by
  `runtime/run-explanation.mjs` (`explanation` on run list/detail and issue summaries: `headline`, `detail`, verbatim
  `cause`, `kept`, `next`, `unmet` with the coordinator's evidence, `tone`); it translates the record and decides nothing,
  and the issue page, Needs attention and summaries use it rather than showing reason codes. `issue.disposition` (resolved, partially-resolved, split,
  duplicate, declined, not-reproducible, superseded, not-resolved; `split`/`duplicate` name existing issues in
  `related`) is an explicit decision with evidence; `resolved` is refused while the named run left residual risks
  unaccepted (stated up front as `unacceptedRisks` on the issue and the run explanation; `acceptRisks` on the disposition accepts them in the same write of `issue.json`, `runtime/residual-risks.mjs`). Follow-up issues come from unaccepted risks and never absorb the original defect. The supervisor
  needs a disposition before it may archive, and has `finish` to end an activation without cancelling runs.
  `reset` (New session) archives the chat, native session and any pending operation to `state.<ts>.json` and starts
  clean; it is refused while live and is the way out of `recovery-required`. It begins fresh session limits
  (calls, starts, per-issue counters, failed-launch guards), adds the old usage to `history`, retains ownership
  of anything still open (live, paused, unreconciled), and retires settled runs and finished launches into the
  archive rather than the new session. State version 2 (`startBudgetVersion`) migrates version-1 lifetime
  counters into `history` and reads the session's own usage back from its launch records.
- Archiving packs the issue out of its project folder (`server/issue-bundle.mjs`): into
  `issues/.archive/<project>/<id>.tar.gz`, beside `<id>.json` (the issue as lists describe it, run summaries, every
  run's result text) and `<id>.runs.json` (run records for the overview's history). A run worktree is saved as
  `runs/<id>/artifacts/worktree-at-archive.patch` against its base, handed back to git and left out; any worktree
  that cannot be saved stays in the bundle, and a save failure leaves the issue unpacked. The bundle is verified
  (every packed file listed) before the folder is removed. A packed issue reads through `getIssue`/`listIssues`
  (`packed: true`, `archive.results`), refuses changes with 409, and its runs cannot be resumed. Restore unpacks it
  (runs marked `workspace.state: removed`); delete removes the bundle. Deleting is only offered for archived issues.
  `tools/pack-archived.mjs` packs issues archived before this existed.

## Front-end conventions (`gui/src/`)

- `socket.js` owns the single socket and one reactive `connection` object; components only read from it.
  To add a live widget, emit a server event, store it there, read it from a component.
- Views must have a single root element (`<Transition mode="out-in">` wraps the outlet; two roots fail
  silently). Page actions teleport into `#appbar-actions` in App.vue.
- `/projects/:project` and `/projects/:project/:id` are sibling routes; the drawer sets `:active` from
  `route.params.project`. Vuetify 4: clickable rows use `:row-props`, not `@click:row`.
- Markdown is rendered to a fixed set of Vue nodes with HTML disabled; nothing ever inserts rendered HTML
  strings. Icons are registered in `plugins/icons.js`.
- The operator token lives in sessionStorage only, never in a URL.
- The person is the reverse proxy's basic-auth login when there is one (`src/identity.js`, `GET /api/whoami`,
  `server/proxy-user.mjs` overrides every body `actor`); only without it do "Your name" fields appear. A login
  verified against the proxy's users directory (`DEVPANEL_USERS_DIR` or the host settings' `proxyLogin`) admits
  API and socket without the token (`auth.mjs`).
- `POST /api/report/:project` (`server/report.mjs`) is the one tokenless route: a private-network peer that did not
  come through the proxy and is not the panel itself may open an issue, nothing more. A reporter key
  (`server/reporters.mjs`, `tools/reporter.mjs`) makes it trust `fault` or `request`, else `anonymous`; `issue.report.trust`
  bounds what the top-level supervisor may start (none / triage+analysis / any), never an operator.

## Security-sensitive rules the server enforces

Filenames with separators, `..`, control chars or a leading dot are rejected, not repaired. Only `http`,
`https`, `file:` and filesystem paths are accepted as references. Uploads are capped
(`DEVPANEL_MAX_FILE_BYTES`, 25 MB). `cert/`, `*.key`, `.devpanel-token`, `logs/`, `issues/` (including `issues/.supervisor/`),
`host-config/` and `CLAUDE.local.md` are git-ignored and must stay that way. No tracked file names an installation:
`npm run publish:check` greps the tree for the installation's own denylist (`host-config/publish-denylist.txt`).
