# Execution contract

The current tactical playbook model is documented in [Tactical playbooks](tactical-playbooks.md). It supersedes the legacy catalogue and single-auditor workflow described below for new runs.

What a run is, when an issue may close, and what happens when things go wrong.
Milestone 1 defines these; later milestones implement them.

## Layers

| Directory | Holds | Edited by |
|---|---|---|
| `harness/` | runtime adapters | developers |
| `roster/` | concrete models bound to a harness | operators |
| `strategy-templates/` | algorithms: roles, phases, review rules, prompts, and the intents they offer | operators |
| `playbooks/` | named bindings of a strategy to participants, with a default intent | operators |
| `schemas/` | the contracts all of the above must satisfy | developers |

## Strategies, intents and playbooks

Three things decide how a run behaves, and they are deliberately separate:

- A **strategy** is the shape: roles, phases, loops, review policy, completion.
  There are two — `author-auditor-pingpong`, whose deliverable is a
  fingerprinted candidate, and `analysis`, whose deliverable is a document and
  which fingerprints nothing and delivers nothing (`delivery: none`; closure on
  the coordinator's confirmation plus no outstanding blocking findings).
- An **intent** is a prompt overlay for one kind of work, at
  `strategy-templates/<strategy>/intents/<id>.yaml`: guidance keyed by step id,
  appended to that step's prompt under `## Intent: …` whether the prompt is a
  template or coordinator-authored. It changes what participants are told to
  look for and what counts as done. It never changes the phase shape, roles,
  review rules or completion policy. Guidance naming a step the strategy lacks
  is a load error. The change strategy offers `feature`, `bugfix`, `refactor`,
  `hardening`, `performance`, `tests`, `maintenance`, `docs`, `prototype`; the
  analysis strategy offers `research`, `requirements`, `spec`, `breakdown`,
  `review`, `triage`, `changelog`.
- A **playbook** binds a strategy to participants, budgets, check requirement,
  closure authority and a default intent. A run may choose another intent of
  the same strategy through `runOptions.intent`; an unknown one is refused at
  resolution. Three choices are kept distinct on the wire: the option omitted
  (the playbook default applies), `null` (no overlay at all), or an id. The chosen intent is snapshotted with its hash and contributes
  to the config hash, so a preview and a start agree on it.

The playbook catalogue (analysis, triage, implementation, plan-and-implement,
refactoring, staging, deployment, prompt) is described in `docs/tactical-playbooks.md`.
The pingpong playbooks (`standard-change`, `tight-change`, `careful-change`,
`prototype`, `review`) were removed on 2026-09-25; the `author-auditor-pingpong`
and `analysis` strategy templates remain for snapshotted runs.

Hotfixes, deployment, incident response, database migration, merge-conflict
resolution and release preparation are not playbooks: they act on a live system
or a shared branch, which the worktree model does not cover until delivery can
commit and merge and checks can run. Until then they are operator procedures,
possibly informed by an `analysis` run.

Human-authored configuration is YAML; machine-written state is JSON. A playbook is
**resolved and snapshotted** at run start, so editing one never alters a run in
flight.

## Storage

Steps stay flat at the issue root and numbering continues across runs. A step
folder contains **only** `response.md` — the agent's response, nothing else.
Everything the engine needs lives outside it.

```
issues/<project>/<date>-<name>/
├── issue.json                  status: open | resolved | abandoned
├── 000-triage/response.md
├── 001-plan/response.md
├── 002-audit-plan/response.md
├── 003-revise-plan/response.md
└── runs/
    └── <run-id>/
        ├── run.json            status, participants, sessions, step map, approvals
        ├── resolved-playbook.json   the snapshot this run actually executes
        ├── outputs/003.json    structured agent output, kept out of the step
        ├── artifacts/          patches and delivery artifacts
        └── events.jsonl        append-only transitions
```

Issue status and run status are separate. An issue stays **open** while a run is
paused, blocked, failed or cancelled. `run.json` is what maps a step back to its
run, participant, phase, round and attempt — the flat numbering carries no such
information on its own.

State is persisted **before** the corresponding socket event is emitted, so a
reconnecting client reconstructs progress from storage and never from the stream.

### Coordinator decision context

The initial `000-report/response.md` is issue input, not an unclassified agent
response. Evidence capture prioritizes it and recent notes while still excluding
known agent turns. Every tool-free coordinator turn receives frozen excerpts of
the initial report and newest notes, with explicit omissions and truncation;
later edits to the live issue do not enter the run implicitly. Explicit scope and
decision records determine precedence, not folder order alone.

Validated structured worker reports are delivered whole to the coordinator,
including the verdict, revision, findings and prior-finding dispositions. Narrative
budgets may bound reader-capable workers' excerpts but cannot remove structured
decision evidence from a seat that cannot retrieve it. Duplicate response prose
is omitted. Invalid outputs remain invalid, and the normal same-revision approval,
check and closure requirements still apply.

## Revision fingerprint

A candidate's identity. Deliberately **not** a git diff, which omits untracked
files, and **not** a commit hash, which misses uncommitted work.

It is a canonical `sha256` over the complete deliverable content set: every path
with its mode and content hash, sorted by path, with **deletions recorded
explicitly** so removing a file changes the fingerprint. The base commit and the
exclusion globs are recorded alongside, so a fingerprint computed over a different
scope cannot be mistaken for the same candidate.

Everything binds to it: an approval names the fingerprint it examined, a check
result names the fingerprint it ran against, and closure names the fingerprint it
closed on. **Any subsequent modification produces a new fingerprint and invalidates
the previous approval and checks.** They are never carried forward.

Immediately before delivery the fingerprint is re-derived. If integration changed
the candidate — a rebase, a conflict resolution, anything — approval and checks are
stale and must be renewed.

**Rule, not just algorithm.** A fingerprint records the *rule* it was computed
under (`rule: exec-bit` today; revisions without one were computed under the
legacy `posix` rule that recorded every permission bit). A rule change is not a
content change: when closure finds the re-derived fingerprint differs from the
approved revision *and* the approved revision was recorded under an older rule,
it fingerprints the workspace under that older rule too. If that reproduces the
approved revision exactly, the bytes are what was approved and only the name is
stale: the revision is re-expressed under the current rule (`revisions[]` gains
an entry with `migratedFrom`), and approvals, checks and the confirmation are
carried to the new name because they examined these very bytes. Anything that
differs under the old rule is real drift and is treated as such.

## Revisions are engine-owned

The engine fingerprints the workspace after every turn that `recordsRevision`
and records the result on the step. Nothing an author says can set it. What an
author *can* answer is where it started: the turn is told the current revision
("Current revision: …", or "No candidate exists yet" on a first implementation)
and echoes it as `authorArtifact.basedOnRevision` (`null` when none). An echo
that names a different revision is a protocol failure, repaired once — the
author worked from something other than what it was given. The old `revision`
field, which asked the author to echo a fingerprint that did not yet exist, is
gone.

## Usage is per turn, per provider

Every step records `usage` as the adapter reported it, with the provider's
categories kept apart — `inputTokens`, `outputTokens`, `cacheCreationTokens`,
`cacheReadTokens` — and `tokens` derived by that provider's semantics (Anthropic:
all four summed, since cached input is still input the model read; OpenAI:
input already includes the cached share). `costUsd` is kept when reported;
steps without a cost are counted in `budgets.used.costUnknownSteps`. Two
runtimes report **running totals** on a resumed session rather than the
invocation's own usage, and the adapters turn those back into per-invocation
numbers by subtracting the totals recorded on the session descriptor after the
previous turn: Claude's `total_cost_usd` since CLI 2.1.277 (a headless resume no
longer starts the session total at zero; the version is read from the stream's
`init` record, older or unknown versions are taken as reported), and Codex's
`turn.completed.usage` token counters on `exec resume`. The value the runtime
printed stays on the step as `costReportedUsd` / `tokensReported`, and
`costBasis` / `tokensBasis` says how the number was derived: `reported`,
`first`, `delta`, or `reset` when a total went backwards and the reported value
was taken whole. A descriptor written before totals were tracked over-counts
its next turn once and is exact from then on. Usage is
written onto the pending invocation before the step is committed and adopted
from the runtime's ledger on recovery, so a turn that finished while the engine
was down is not counted as free. The token budget is checked against provider
totals.

## Reviews

An auditor returns `approved` or `changes-needed` with findings. Each finding
carries a severity and an explicit `blocking` flag. The strategy defines what
counts as **substantial**; only substantial findings keep a loop going. Outstanding
findings are the substantial ones from the latest review *of the current revision*,
recomputed rather than accumulated, so a withdrawn finding disappears.

An unparseable or self-contradictory result is a **protocol failure, not a review
finding**. It triggers bounded protocol repair — the same participant is asked to
restate in the required shape — and on exhaustion the run enters `blocked` for a
human. It must never fall through to `changes-needed`: that would send the author
into correction rounds against a formatting failure.

### Reviewers of one round run concurrently

The occupied reviewers of a consensus round examine the same revision against the
same context and none reads another's verdict from that round, so the engine runs
them at once (`reviewPolicy.concurrentReviews: false` keeps them serial). The
round's consensus is folded only after every one is recorded; a seat that fails is
awaited with the others before the run records anything. Replay is unchanged:
steps are matched by phase, step and round, not by position. All run-state writes
of one engine (run.json, events, journal reads) go through one queue, so
concurrent turns cannot reorder a snapshot or read a half-appended event.

### Checks run beside the reviews

After a revision is recorded its checks start in the background and the review
turns run meanwhile (`checks.concurrent: false` runs them first). Reviewers are
told the result is pending. Every other turn — a coordinator brief or
confirmation, closure — waits for the result. A **failed** check on the revision
a round reviewed makes that round `changes-needed` even when every reviewer
approved, so the author gets another round as when reviewers saw the failure
first; `unavailable` is not a failure of the candidate and is left to closure's
requirement. A failure whose every failed required command is baseline-known
(below, "Inherited check failures") counts as passed here and at closure:
it costs no round. Every outcome is also appended to `run.checkHistory`, because
`checkResults` keeps only the current revision and replay must still know an
earlier round's revision failed.

A target with `timing: approved` (the default for a project's staging test
drive) does not run beside the reviews: a revision is checked only once every
reviewer approved it. The planner returns `{kind: 'checks'}` for an approved
round whose revision has no result yet; the engine runs the checks and plans
again, so a failure still sends the author another round. Revisions the
reviewers send back are not test-driven, with one exception: a criterion only
the check can prove would otherwise deadlock the loop (the auditor withholds the
approval that would run the check). A reviewer marks such a finding
`awaitsCheck: true`; when every substantial finding of a round is so marked and
the revision has no result yet, the planner returns `{kind: 'checks'}` for it
anyway. It happens once per revision: the recorded result (`checkHistory`)
answers on replay. Once the full drive of that revision has a result that is
not a failure, the planner asks each reviewer whose findings awaited it to
review the same revision again in the same round (a step with `recheck: <revision>`,
its attempts numbered on their own), with the drive's result, gating, baseline
comparison and selftest report summary in the prompt. No author turn runs and
no round is spent; the new verdicts replace the reviewers' earlier ones and
decide the round. It happens once per (round, revision): the recorded re-review
answers on replay, even when it again awaits the check. A failed drive gets no
re-review: it makes the round `changes-needed` as above. A passed drive
approves nothing by itself, so closure still needs an approval and a passing
check on the same revision. Every seat's `checks.latest` carries `timing` saying the checks wait
for approval, and a triage that writes the first brief (`firstHandoff`) is told
the same, so either brief names the criteria only they can prove and the
author does not hand over unchanged revisions to wait for them. Only a revision made inside a loop
with an occupied reviewer seat waits (every reviewer seat empty: nobody would
approve it); one from a phase without such a loop (the Prompt
playbook) is checked at once. A check that cannot run there
(in place, quarantined) is recorded as `not-run` and closure judges it.

A target with **tiers** (`tiers.smoke`, a list of its command ids) is both:
its smoke tier runs on every recorded revision beside the reviews, as above, and
its full drive (the whole target) waits for approval, as `timing: approved`
does. `maybeRunChecks`/`startChecks` run one tier per call, idempotent per
(revision, tier); `checkResults[]`, `checkHistory[]` and the `checks*` events
carry `tier` (a record without one is a full drive). A failed smoke on the
reviewed revision is the failed-check path: `changes-needed`, another author
round, and no full drive for those bytes. The planner returns `{kind: 'checks'}`
only when the round approved, the revision has no full result and its smoke did
not fail. Closure, the closure confirmation's check evidence, refresh-checks
and a reconciled candidate's revalidation use the **full** drive only; with only
a smoke result the check is `unavailable`, which blocks under `required`. A
smoke never stands in for the full drive. `checksOnlyBlock` reads the newest
check of either tier, so a smoke failure on an approved revision is a
checks-only stop, and refresh-checks reruns the full drive.

A **failed** check runs again on the same revision before it counts
(`target.retryFailed`, default 1, 0 to 3). Each earlier attempt is kept on the
result as `attempts`, a `checks-retry` event is written, and a pass after a
failure is marked `flaky: true`; reviewers see both in `checks.latest`. Only a
valid pass replaces a failure: a retry that could not run (`unavailable`) is
recorded and the failure stands. Each attempt keeps its command records, so
`get_check_log` reads an attempt's logs by its directory. A seat
cannot rerun a check, and no operator answer can let it: the rerun is the
engine's.

A drive that **passed** but whose selftest report names failures the base does
not have (`baselineComparison.selftest.verdict: new-failures`) fails the gate
too, and runs once more on the same revision under the same allowance
(`runtime/selftest-retry.mjs`; the event carries `reason: new-selftest-failures`).
Only a test that fails in both drives counts as new. When none does, the second
drive replaces the first, marked `flaky`, with the first kept in `attempts`
beside the `newFailures` it named, and its comparison cleared of the one-drive
failures, which stay listed as `selftest.flakyFailures` (a different unstable
test in the second drive does not fail it). When some do, the first stands with
`selftestReproduced: true` and `newFailures` narrowed to those, the rest listed
as `flakyFailures`; only then does the author get a round.

Neither retry runs when an earlier revision of the run already answered it
(`runtime/selftest-retry.mjs`). The result then carries `retrySkipped`, shown in
`checks.latest`, with a `checks-retry-skipped` event beside it. What the decision
reads survives a new revision as `checkHistory[].retryEvidence`. An earlier
revision counts only for a drive of the same target (`targetKey`: a smoke and a
full drive are different targets) and on a revision other than this one (a refresh
reads the other revisions like any drive, never its own); a reconciled candidate
has another base and reads no history. An older record without the evidence is a first occurrence.

- **`selftest-reproduced-earlier`**: every new failure was named by both drives of
  an earlier revision. `selftestReproduced` from a retry comparison that was
  `not-made` named no test twice and does not count; any other new failure means
  the retry runs.
- **`failed-same-way`**: every failed required command already stood failed on an
  earlier revision the same way, and the base known at the decision passed it. The
  same way is the same command with either `timeout-no-output` (timed out having
  printed nothing but the systemd-run and ssh status lines and the launcher's fence
  notices) or the same crash
  signature (`failureIdentities`, baseline-failures.mjs: a core-dump signal and the
  command's distinct crash lines, numbers and hex ids replaced). A failure a retry
  cleared on the earlier revision is not one: that is instability. A base not driven
  yet is not driven to decide this; like a base that failed the command too, it
  leaves the retry to run.

When every reviewer approved a revision, its check failed, and the author's
next answer is the **same revision**, the loop stops as
`checks-failed-unchanged` instead of replaying the recorded failure until its
round cap: no further round could change it. A run stopped that way, or by
`rounds-exhausted` with every occupied auditor approving its latest revision and
that revision's latest check not passing (`checksOnlyBlock`, run-control.mjs;
a check of baseline-known failures only counts as passing, so such a revision
closes instead of stopping here),
offers refresh-checks (below) to rerun the checks on that candidate once a flaky
or environmental failure is fixed, and Continue (`checks-failed-unchanged`) or
Resume (`rounds-exhausted`) for another author round.

A check that fails the gate **only** because its comparison base did not finish
its selftest run (the selftest comparison is `not-made` with `baseUnfinished`,
and without it the check would pass: `inconclusiveBase`, baseline-failures.mjs)
says nothing about the candidate. On a revision every reviewer approved, the
loop stops as `checks-inconclusive` at once: no author round, since no source
change answers it. When the reviewers have findings of their own, their round
goes ahead, but the check is not counted against the author. Such a run is a
checks-only block: refresh-checks drives a fresh base (an unfinished one is
never held or cached) and reruns the candidate's checks; Continue gives the
author a round anyway; Resume is not offered, as replay reaches the same stop.
The check history marks such a check `inconclusive: true`.

### Plan findings are owed by the implementation

The substantial findings raised while the plan was under review are recorded as
`findings.plan` — the commitments the approved plan carries. The implementation
audit receives them and its `reviewResult` must give each one a disposition in
`priorFindings`: `addressed`, `deferred` (with a reason) or `withdrawn` (with a
reason). A review that omits a disposition is a protocol failure and is repaired.

Exactly one disposition per finding id: a `priorFindings` list that names an id
twice is a protocol failure, because "deferred and addressed" is not a
disposition and whichever entry won would decide closure. A review under repair
for any reason counts for nothing — it contributes no approval and no
outstanding findings until the participant restates it acceptably.

A `deferred` finding keeps its severity, so it is substantial exactly as a fresh
finding would be: it appears in `findings.outstanding` marked `source:
plan-review`, sends the author back, and makes `approved` a contradiction until it
is addressed or withdrawn. An approved plan therefore cannot launder an
implementation that quietly dropped one of the plan's fixes — the first live
maildir run did exactly that when a handoff froze the file the plan's fix lived in.

### A finding against an acceptance criterion is blocking

A finding that shows the artifact contradicts one of the brief's acceptance
criteria names it in `contradicts` (the criterion's id, as triage recorded it in
`acceptanceCriteria`). Such a finding is blocking whatever its severity. The
criteria themselves therefore name outcomes, not chores: the triage and orient
prompts refuse "documentation updated"-style criteria, so a wording slip is an
ordinary finding with its own severity, not a criterion violation. The
auditor's own observations outside the criteria keep their severity and may stay
non-blocking. `criterion` alone cannot carry this: it may cite an acceptance
criterion, a plan commitment or an invariant, and a minor note may cite a
criterion it does not claim is broken.

The engine checks it as it checks a deferred plan finding. A `contradicts` that
names no criterion of the brief (the auditor does not invent criteria), one on a
finding that is not `blocking: true`, or one beside verdict `approved` is a
contract contradiction: bounded protocol repair asks the same auditor to restate.
A restated `changes-needed` with the finding blocking sends the author a round;
an unrepaired contradiction contributes no approval and blocks the run once
repair is exhausted. The rule applies to every `reviewResult`, so a plan audit
that finds the plan contradicting a criterion is held to it too; a run without
triage criteria has none to name.

### Residual risk is recorded, not summarised away

The coordinator's `closureConfirmation` carries `residualRisks`: every plan finding
deferred or partly addressed, every criterion met by a narrower reading than
triage recorded, and anything from the original report the candidate leaves in
place. They are copied onto the run's `closure` record and shown with it.

## Verification

Verification is often impossible on the panel's own host. Many projects cannot be
run there, and where they can it is on a remote container over SSH.

### The check runner

Project infrastructure in `projects/<id>.yaml` can supply the staging target for
code-producing playbooks. It is included in the configuration hash and run snapshot
and delivered to every participant. Its requirement can only strengthen the
playbook requirement; its staging target takes precedence. Document-only runs do
not launch test instances. See [Project infrastructure](project-infrastructure.md)
for container roles, diagnostics and test-drive configuration.

Check targets may declare `finallyCommands` for logs and process cleanup. These
are attempted after command failure or cancellation with independent timeouts.
Failed required SSH finalizers retain the remote candidate for investigation and make the
result unavailable, unless a required command had already failed: then the result stays
`failed` (a collector that finds nothing after a failed boot is a consequence, and only
`failed` returns the candidate to the author). Remote services must also have a lifetime limit for cases
where the transport disappears entirely.

When a playbook configures `checks.target`, the engine runs it once per
revision, right after the step that recorded the revision, so the next review
sees `checks.latest` for the content it is reviewing. A check is evidence about
one revision and nothing else:

1. The candidate is **rebuilt** from its base commit and patch into a temporary
   worktree and fingerprinted; the fingerprint must equal the revision, or the
   result is `unavailable` and no command runs.
2. The target's commands run in that rebuilt candidate — `local` in the
   worktree itself, `ssh` on the host after an archive of the verified
   reconstruction is uploaded and its SHA-256 recomputed on arrival (a mismatch
   is `unavailable`: the result would not be bound to the revision).
3. After the commands, the candidate is compared with what was materialised —
   locally by re-fingerprinting, over SSH by a remote listing of content
   hashes, symlink targets and modes — entry identity being content **and**
   mode. A modified path, a deleted path, a mode change, or the reappearance of
   a path the candidate itself deleted makes the result `unavailable`: the
   evidence is not bound to the revision. Files a command adds (build output)
   are tolerated and counted. A remote that cannot be listed afterwards is
   `unavailable` too. Over SSH the candidate lands in a directory that is
   created fresh (unique suffix, `mkdir` without `-p`, so an existing one is
   an error) and is listed **before** any command runs: it must contain
   exactly the candidate, nothing missing and nothing extra, or the check is
   `unavailable` — a stale fixture cannot make a test pass.
4. Each command's exit status, signal, duration and log are kept under
   `runs/<run-id>/checks/<n>/`; the result records them. A required command
   that fails fails the set; an optional one is recorded. After a required
   failure, a later command runs only if it declares `needs` (earlier command
   ids; an empty list means independent; a `join` implies its service) and
   every need passed. Any other command is skipped and listed in
   `result.skipped` with the reason. A timeout terminates the command and fails
   it. Cancellation is `unavailable`.

Absence of a target is still `unavailable` at closure, never a pass, and a
result never rewrites the requirement. Scratch selftests an author or auditor
runs by hand are their evidence, not the run's: only the runner's results feed
`checksSatisfied` and the verification level.

### Inherited check failures (baseline-known)

A failure the project already had before the change must not cost the change
its closure. A failure the change introduced must still block, even inside a
check that also carries inherited ones. `runtime/baseline-failures.mjs`
decides which is which.

**Baseline capture.** The baseline is the same check target run on the run's
base commit, which is the **source revision** (`run.workspace.baseCommit`).
It runs once per run and target, under `checks/base-<key>/`, with no patch.
With `compareBaseline: true` it runs eagerly beside the first candidate check.
Otherwise it is captured when a candidate check fails (after its retries),
because only then can a failure be inherited. A passing candidate never pays
for it. The kept entry in `run.baselineChecks[]` records `sourceRevision`,
`capturedAt` and `failures`, the fingerprints of every failed required
command:
- `{command, test, message, fingerprint}` per failure block;
- one `{command, test: '(command)', message: 'exit <code>', fingerprint}` per command.

A base that could not be checked is not kept, and the next failed check tries
again. Later revisions and refreshes with the same target reuse the baseline;
with `baselineCache` configured, only while the identity read for that check
equals the one the baseline was taken under (`baselineChecks[].identityKey`):
a staging file or the environment that changed between two revisions of one
run means a fresh base drive (in its own `checks/base-<key>-<identity>/`) or a
cache hit on the new key, and an identity that cannot be read reuses nothing.
A baseline gets an `identityKey` only when that identity is established: a
cache hit, or a base drive whose identity read the same before and after it.
An `unstable` drive, or one whose second read failed, has none and is never
reused; the next check drives the base again. Every base drive and every
adopted cache copy gets a directory no earlier baseline record names and
nothing on disk occupies (`checks/base-<key>-<identity>`, then `-2`, `-3`…), so
the evidence an earlier record or comparison read is never overwritten.
A changed target or another source revision has none, so a stale baseline is
never used: it is captured afresh. A tiered target has one baseline per tier
(each tier is its own target definition).

**Across runs (`baselineCache`).** Before running a base drive the engine looks
in `issues/<project>/.baselines/` (`runtime/baseline-cache.mjs`) for an entry
whose key is exactly: the base commit, the sha256 of the tier target's
definition (the `targetKey` above), the content hash of every
`baselineCache.files` path on the target, and the hash of the
`baselineCache.environment` command's output there (run as the SSH account,
never inside a candidate). No component is approximated; one that cannot be
computed means no lookup and no store, recorded on `baselineChecks[].cache`. A
hit is copied byte for byte into the run's `checks/base-<key>/`, checked against
the entry's manifest (otherwise it is a miss), and recorded as
`baselineChecks[].reused` `{key, entry, fromRun, capturedAt, storedAt}` and
`baselineComparison.reused`. Because the base commit is equal, its
`sourceRevision` is this run's own and the inherited-failure rules below apply
unchanged. After a missed base drive the identity is read again and the entry is
stored only if both reads agree (`cache.state: stored`, else `unstable`,
`unavailable` or `not-stored`); the first entry under a key wins, and each store
prunes entries older than `maxAgeDays` and beyond `maxEntries`. Working-tree
snapshot commits are content-addressed for this (see "Workspace"): the same
checkout on the same HEAD gives the same base commit.

**What is compared.** For each failed required command, the comparison reads
its complete log. A command's output splits into three parts:
- **Failure blocks.** A failure line (`FAIL`, `FAILED`, `not ok`, `✗`, `✘`,
  `×`) with its test identity (the text up to the first ` — `, ` - ` or `: `)
  and every diagnostic line that belongs to it. Outside TAP, that is each
  following stdout line up to the next result line, `--- stderr ---` or the
  end. In TAP, it is the test point's YAML block, and the identity is the
  **path** of enclosing test names (`suiteA > same`): node:test opens each
  test with `# Subtest: X` at its depth and closes it with its point at that
  depth. Blocks pair only when their full paths are equal. A point whose
  enclosing tests are not all open, or that closes a different name than the
  one opened at its depth, leaves the hierarchy unestablished, and that
  command's comparison is not made.
- **Pass points.** `PASS`, `ok`, `✓` or `✔` lines, by their exact text; in
  TAP, by their path. Nothing attaches to a pass line outside TAP.
- **Unattributed output.** Every other line, in order, including all of stderr.

A block's fingerprint is `sha256(command, test, failure line + diagnostic
lines)`, where `test` is the full path in TAP. The stored entry shows it as
`{command, test: 'suiteA > same', message, fingerprint}`. The test identity
and its complete diagnostics therefore decide together.

**Normalisation.** Lines are compared byte for byte; whitespace, blank lines
and indentation are kept. The only rules are these, each at exactly the
position stated:

| # | Rule | Exact position | Defined by |
|---|---|---|---|
| N0 | `\r\n` becomes `\n` | everywhere | line endings |
| F1-a | cut the `$ <command.run>` header and its blank line, and the final `--- exit … ---` line; a header mismatch means the comparison is not made | first two lines and last line of the `.log` | devpanel runner |
| F1-b | `devpanel-check-(<12hex>-<12hex>\|<24hex>\|<6 alnum>)` becomes `devpanel-check-*` | anywhere | engine-generated directory and unit names |
| F1-c | keep the `--- stderr ---` line; it ends any block, F2 never applies after it, and stderr is unattributed | the runner's separator | devpanel runner |
| F2-a | TAP rules apply only when line 1 of the output is exactly `TAP version 13` or `TAP version 14` | first line | TAP |
| F2-b | the ordinal is removed: `<I>(not ok\|ok) <N>[ - name]` becomes `<I>(not ok\|ok)[ - name]` | only on a test-point line `^((?: {4})*)(not ok\|ok) \d+( - .*)?$` outside any YAML block | TAP test point |
| F2-c | a test point's diagnostic is its YAML block: the opener `<I>  ---` on the line directly after the point, through the first line exactly `<I>  ...`; content is kept byte for byte, and deeper block-scalar lines (`      ...`, `1..3`, `# pass 4`) are data | as stated | TAP YAML block |
| F2-d | remove `<I>  duration_ms: <number>` | only as the first line after the opener, at the block's key depth; nested assertion data such as `actual.duration_ms` is kept | node:test reporter timing |
| F2-e(i) | remove `<I># Subtest: X` | only directly before its own test point `X` at the same indent, or opening its nested stream that closes with that point; program output that looks the same is kept | node:test subtest header |
| F2-e(ii) | remove a nested plan `<I>    1..N` | only directly before its parent's test point at `<I>` | node:test nested plan |
| F2-e(iii) | remove the top-level `1..N` and the trailer `# tests`, `# suites`, `# pass`, `# fail`, `# cancelled`, `# skipped`, `# todo`, `# duration_ms` | only as the last nine lines of stdout, in that order | node:test trailer |

Nothing else is removed or rewritten. Numbers, durations, hex values, paths,
`line:col` and timestamps inside a message or diagnostic are values. A new
format is added to this table and to the module together, and its rules must
name the exact structural position they apply at.

**Same-revision comparison.** A failed required command of the candidate is
**baseline-known** only if all of these hold:
- the base of the same source revision also failed it, and not by timeout or
  signal; the candidate did not time out or get a signal either;
- the exit code is the same on both sides;
- every candidate failure block equals a distinct base block;
- every base pass point is still reported by the candidate;
- the unattributed output is identical, in order.

The candidate may add passes. The check's `baselineComparison.failures` holds
the result:
- **`baseline-known`**: every failed required command qualified. The check
  counts as passed for the review loop, `checks-failed-unchanged`,
  `checksOnlyBlock`, refresh-checks and closure, including the verification
  level. `check.result` stays `failed`, because that is what ran.
- **`new-failures`**: at least one block or command fails only on the
  candidate. `newFailures` names them, beside the `baselineKnown` ones of the
  same check, and the check blocks as before.
- **`not-made`**, with the `reason`: there is no baseline, the base was
  `unavailable`, the baseline is of another source revision, a log does not
  read as the runner wrote it, a TAP test hierarchy could not be established,
  the candidate lost base passes, the unattributed output differs, or a
  required command did not run (`notRun`).

  Its outcome is unknown, and a failure is never silently taken as inherited:
  `not-made` blocks exactly as a failure does.

**Recording.** The kept baseline entry holds the base fingerprints, its source
revision and capture time. Each failed check holds its comparison. Closure
copies the outcome to `run.closure.checks`: `result`, `gating`, `comparison`,
`reason`, `baselineKnown`, `newFailures` and `notRun`. The run explanation
names new failures and states a comparison that could not be made. `result.md`
lists baseline-known failures and proposes them as separate issues; none is
opened automatically.

### Selftest reports: new failures by test identity

A selftest runner can report its failures and still exit 0, so the byte rules
above, which read failed required commands, never see them. A command declares
what its output carries with `report: selftest` (typically on a required
`collect-selftest-report` command; how it runs, `required` and its exit are
unchanged; an older spelling with a site prefix, `<site>-selftest`, is read the
same). Its stdout holds exactly one `== <path>/selftest.report` line,
then a few summary lines grepped from the report, then the report's JSON.

**Reading.** From the command's full `.stdout`, the report is the segment from
that line to the next line starting with `== ` (or the end), and within it the
suffix from the earliest line starting with `{` or `[` that parses as one JSON
value. A test is any object with a string `test`; it failed when it has `error`
or `stack` and is not `skipped`, and a name that failed once is failed. The
**identity is the whole `test` string**: messages, timings, the report's path
and line positions are never compared.

**Comparing.** `baselineComparison.selftest` (`compareSelftestReports`):
- `none`: the report lists no failure; no base is needed.
- `baseline-known`: every failed test also fails in the base's report of the
  same source revision.
- `new-failures`: `newFailures` names the tests that fail only on the
  candidate, beside the `baselineKnown` ones.
- `not-made`, with the `reason`: the candidate lists failures but its report,
  or the base's, cannot be read, or there is no base of this source revision,
  or the base's report holds a suite-level failure (a name ending in a
  parenthesised segment: `worker/(suite)`, `(suite-busy)`,
  `admin/(thread-ready)`) while a candidate failure is absent from it, or the
  base's report command failed or never ran (the base stopped before its
  selftests, e.g. at readiness). Such a base never finished its suites, so it
  cannot call a failure new: it is not evidence of a regression, and both mark
  the comparison `baseUnfinished`. A report that was produced but cannot be
  read does not: a fresh drive would read it the same way.
- `not-applicable`: the command itself failed, so the byte rules judge it.

**An unfinished base is driven again.** When an unfinished base is what makes
the candidate's selftest comparison inconclusive (`baseUnfinished`),
`checkCandidate` drives the base once more, past the baseline cache; a candidate
with nothing to judge against it does not pay for that drive. A cached base
found unfinished (stored before such bases were refused) is discarded from the
cache first, or every later run would hit it again and could not store the
complete one under the same key. The unfinished drive stays in
`run.baselineChecks` as evidence with `unfinished: true`, which no later check
reuses (`unfinishedSuites` decides it); a second unfinished drive is compared
(as `not-made`, `baseUnfinished`) but neither reused nor cached, and the review
loop stops as `checks-inconclusive` (above). One redrive, not more: a base that
stops early twice is a staging-drive problem a person should look at, and
Refresh checks drives again when it is fixed. The redrive is independent of
`retryFailed`, which reruns only the candidate's drive; with tiers, each tier's
target has its own base and its own redrive. The DKIM run of 2026-10-17 was
refused twice because a base whose worker suite had timed out made two
inherited failures look new.

A candidate whose report lists failures captures the base even when the check
passed. `gatingResult` is `failed` on `new-failures` and `not-made`, whatever
ran; it never turns any other failure into a pass, and `check.result` stays
what ran, so no retry is started. The failed gate takes the existing path: the
round does not pass and the author gets another one, before any confirmation,
including under `timing: approved`. Closure copies the comparison to
`run.closure.checks.selftest`, and the run explanation names new selftest
failures.

### Tooling policy

`workspace.tooling` says what a participant's runtime may reach beyond the
worktree and the run's scratch directory: `allowLiveCheckout` (default false)
and `allowedRoots`. It is stated in every prompt, recorded on the run, and
enforced below the prompt where the runtime allows: Claude Code receives
`--add-dir` for allowed roots and permission rules denying Read, Edit, Write,
Glob and Grep under the live checkout; Codex runs in its `workspace-write`
sandbox. Neither runtime can fence Bash by path; the adapters report that gap
in their diagnostics rather than claim more than they enforce, and the
recorded policy is what an auditor checks a transcript against. Check
commands themselves run only in the rebuilt candidate.

Beside the configured roots, every working seat may read the run's `evidence/`
and `checks/` directories (read-only). Once a check exists, its prompt names
`checks/`: each check's directory holds every command's full `.log` and
`.stdout`, the base drive under `base-*`. A seat that needs a test name, a
timing or a log line the summary does not carry reads and quotes it there,
rather than asking the operator whether a criterion may be accepted without it.

**Policy and outcome are separate fields.** Mixing them lets an unreachable host
quietly rewrite a requirement, which is precisely what must not happen.

*Requirement* is policy, declared by the strategy:

| `checks.requirement` | Meaning |
|---|---|
| `required` | auto-close needs a `passed` result bound to the approved fingerprint |
| `optional` | a result, if there is one, must not be `failed`; absence does not block |
| `none` | checks play no part in this strategy |

*Result* is a runtime outcome, recorded per fingerprint in `run.json`:
`passed` · `failed` · `not-run` · `unavailable`.

A playbook may **strengthen** the requirement (`none` → `optional` → `required`),
never weaken it. A project that cannot be verified is not a reason to weaken a
strategy that depends on verification — pick a different strategy.

An `unavailable` result under a `required` requirement **blocks the run**. It never
downgrades the requirement. Preflight catches the degenerate case up front: a
`required` requirement with no target configured can never be satisfied, and fails
before anything runs.

Whatever is sent to a remote target must reproduce the exact fingerprint on
arrival, or the result is rejected as not bound to the revision.

## Evidence versus authority

Closure records a **verification level** — `verified` when a check passed on that
exact fingerprint, `review-only` when none did. That describes the *evidence*.

It does not by itself *authorise* an automatic close. Authority is the resolved
playbook's top-level `autoClose.minimumVerification`, and it defaults to
**`verified`**. It is stated once: the strategy's own default is folded into that
value (recorded as `autoClose.strategyDefault`) and does not travel separately
under `completion`, so nothing can read the strategy default and misreport a
playbook that explicitly chose `review-only`.
Closing on agreement alone requires a playbook to opt in explicitly with
`review-only` plus a written justification — it is never a fallback the engine
chooses when checks turn out to be unavailable.

So a run may satisfy every closure condition and still stop: evidence is
review-only, authority demands verified, the run ends `unresolved` with
`closure-not-authorised`, and a human decides. This applies to playbooks that
explicitly require verified evidence or inherit that default.

A playbook that explicitly allows review-only closure (formerly `standard-change`
and `tight-change`) closes this way. After author/auditor agreement on the current candidate, the coordinator
writes a closing report as the final `confirm` step's response: final changes,
acceptance-criterion evidence, review outcome, checks performed or not run, and
remaining limitations. The coordinator must confirm the criteria are satisfied;
the engine then saves the candidate patch and completes the run as resolved.
Passing checks are not required by these playbooks, and missing checks remain
visible as review-only evidence. Failed checks, rejected criteria, stale approval,
and delivery failures still prevent successful completion.

## Disposition: the issue's state, decided separately

A run completing is the run's outcome. `run.outcome` stays the engine's closure
record (`resolved` = the completion checklist passed, `unresolved` = it did not),
but it is never shown as the run's result. What a closed run achieved is derived
from the record by `runtime/run-result.mjs`, in its playbook's words: `reported`
(an analysis report accepted, with its findings), the triage decision itself,
`delivered` (an approved revision reached the source), `artifact-ready` (a patch
retained, the source not updated), `staged`, `deployed`, or `completed` when
nothing more specific applies. A run that did not reach closure is `incomplete`
and `blockedReason` says why. A run carrying `run.landed` — a person's record,
through `POST …/runs/:runId/landed` or the supervisor's `mark_landed`, that they
landed its work by hand (what was applied, commit hash or checkout path, who,
when, what was changed beyond the patch) — reads `delivered` with `resultReason:
manual-landing` whatever its status, and its explanation says who landed it. The
record is an explicit claim: nothing is inferred from the source repository, and
it never alters `run.outcome`, closure or approvals. Once the run has settled,
the run's engine is loaded holding the run lock, re-reads the run under that
lock (a record loaded before the lock is never written back), and writes the
record through its queue (`engine.recordLanding`), like any other engine write. Records written before this vocabulary read the same
way, because nothing stored changes.

Whether the **issue** is resolved is a separate decision, recorded on
`issue.json` as `disposition` — `resolved`, `partially-resolved`, `split`,
`duplicate`, `declined`, `not-reproducible`, `superseded` or `not-resolved` —
with evidence, who decided (operator or supervisor), when, and the run it rests
on. `related` names other issues (`<id>` in the same project or `<project>/<id>`),
each proven to exist: `split` requires the issues it was split into, `duplicate`
exactly one original, and no disposition may name its own issue. When a run is
named, its unaccepted residual risks are copied as `openRisks`, and
`resolved` is refused while any remain: a run that completed its negotiated
work while leaving the reported exposure in place is `partially-resolved`,
not `resolved`. Omitting the run is not a way around this — the newest run
with a closure is used — and only an operator may override, by stating a
reason that is kept on the disposition. Archiving without a disposition is
always possible from the panel and is recorded as an override
(`archiveOverride`, with the reason when one was given); the supervisor must
set a disposition first and has no override. Archive hides; disposition states. Neither is inferred from
`run.outcome`.

Unaccepted residual risks can become **follow-up issues** — one per risk,
named after it, with a report carrying the source issue, run and closing
revision, deduplicated by the risk's index in the closure record
(`closure.followUps`). A follow-up tracks remaining work; the source issue
keeps its own disposition, and the defect it reported is never moved into a
follow-up to justify closing it.

The panel's **What remains** section shows, once a run has ended: each
residual risk as open or accepted with its follow-up link, the verification
level and whether any check ran, whether the delivery is a saved patch (not
integrated) or a document, the base the candidate was cut from, and the
disposition with a control to record one.

## Closure

An issue closes automatically only when **all** of these hold:

1. **Same-revision approval** — the author's completed revision and the auditor's
   approved revision are the same fingerprint.
2. **Checks satisfied** — per the requirement table above, *and* the resulting
   verification level authorised by `autoClose.minimumVerification`.
3. **No outstanding blocking findings.**
4. **Coordinator confirmation** — the acceptance criteria recorded at triage are
   satisfied. Agreement between author and auditor is not sufficient; they can
   agree on something that misses the point of the issue.
5. **Delivery completed** — the agreed delivery action actually happened.

A strategy chooses which of these it requires (`completion.requires`). Two more
exist for strategies without the seats above: **report disposition recorded**
(triage and analysis) and **worker completion** — the latest valid
`singleSeatResult` of the writing seat says `completed: true`. A single seat
that reports the task unfinished, with its blockers, blocks the run as
`task-incomplete` and delivers nothing; nobody else on such a run can say the
work is done.

Delivery is explicit, because these are different completion points:

| Action | Completion point |
|---|---|
| `none` | candidate exists under `artifacts/`; nothing leaves the run |
| `worktree-diff` | a patch is produced against the base commit |
| `apply-to-source` | the verified patch is applied to the bound development checkout and its destination fingerprint reproduces the approved revision; the source index and HEAD are unchanged. The same verified commit as `commit` is written first, on `devpanel/<issue>/<run>` in the repository that owns the worktree, so what was applied is always also a commit that can be diffed, reverted or merged, even when the checkout was cut from a dirty working tree (the base snapshot commit is its parent) |
| `commit` | a verified commit on `devpanel/<issue>/<run>` in the repository that owns the worktree, parented on the base commit, built from a throwaway index; the patch is written too. A playbook may strengthen `worktree-diff` to `commit`, never weaken |
| `merge` | reserved; integration is the operator-approved step below |

Implementation, Plan and implement, and Refactoring default to `apply-to-source`.
An operator may select `worktree-diff` in the start dialog, via
`runOptions.delivery`, or in playbook YAML. Patch-only completion is displayed as
“Patch ready — source not updated”; it remains a legitimate delivery contract.
Starting with `apply-to-source` deliberately authorizes the engine to write the
development checkout shown in preview/readiness. This includes supervisor starts:
`start_run` has this bounded indirect write capability, while the supervisor and
agents gain no direct checkout command capability. Commit and deployment remain
separate operations.

Source delivery saves and reconstructs the patch before writing. It takes a
destination-repository lock using `runtime/lock.mjs`, checks the bound path and
repository, records current Git state, and compares source with the captured
base. Pre-existing dirty work represented by that base is allowed. Subsequent
drift on a path the patch changes blocks delivery and names the path. Drift on
other paths (someone else's edit, a regenerated file) does not: the patch is
applied beside it, the patch's paths must then hold exactly the reviewed bytes
and every drifted path must be as it was found, and the application records
`composed: {paths}` because that combination was never tested. The same holds
when the patch changes files under materialized links and is dispatched to
their Git owners (`runtime/owner-delivery.mjs`).

A run blocked with an approved, undelivered candidate is carried forward:
`runtime/carry-forward.mjs` applies its retained patch to the next run's fresh
worktree of the same issue after the baseline is recorded (cleanly, else a
three-way merge through the source repository's objects with a throwaway index,
leaving conflict markers), records `workspace.seed`, and every turn of that run
is told what it continues and that defects the earlier reviewers saw fixed must
stay fixed. The carried patch goes through review, checks and delivery again.
Destination selection uses Git's ignore rules and the same HEAD-seeded private
index and exclusion pathspecs as the working-tree snapshot. Ignored checkout
content is neither read nor hashed. Recorded baseline paths and paths explicitly
included in the verified patch remain in the comparison, even if ignored.
`git apply --check` precedes `git apply`; no source index or history is changed.
The destination fingerprint, not command success, gates `deliveryCompleted`.
Changed paths under materialized symlink roots are dispatched to their bound Git
owner checkouts. Launch captures each link target, resolved path and repository;
legacy runs capture these bindings on first delivery. The engine locks all affected
repositories in sorted order, reconstructs the approved artifact, and creates
remapped patches under `artifacts/owners/`. Every pending owner patch passes
`git apply --check` before any checkout is written. Symlinks, owner indexes and
history are preserved. Unowned targets, ambiguous aliases and changed bindings
refuse delivery. Unchanged materialized roots still participate in composition
verification.

`source-application.json` records application intent before the write and verified
completion afterwards. Finalize reads the destination: the approved fingerprint
means done; the unchanged base means not applied and permits application; anything
else requires recovery. Repository identity changes refuse delivery; Git state
must remain unchanged during the application itself. There
is no blind rollback. Owner delivery records destination mappings, patch hashes
and per-repository progress. After interruption, each owner must match either its
captured base or its approved result; finalize applies only pending owners and
verifies the complete application composition. A failed or interrupted
application retains the patch and worktree. For drift the operator path is
**reconcile** (below), else **apply manually or rerun** against current source;
Finalize never rebases the candidate or carries approval onto a different
composition.
For an operator-chosen rollback, first run `git apply -R --check <patch>` in
the destination and reverse only when that check succeeds and the affected
paths still match. Otherwise inspect the conflicting edits; never force a
reverse patch over newer work.

Old snapshots retain their delivery policy. An explicit operator request to
`POST …/runs/:runId/apply-artifact` with `expectedRevision` can apply a completed,
approved retained patch, reconstructing a removed worktree from its base. It uses
the same source primitive and records `artifactApplication` separately; it does
not rewrite historical delivery or the snapshot. Missing base or proof refuses
application. `GET …/runs/:runId/patch` downloads the retained patch.

**Finalize.** A run that stopped at the hand-off — `delivery-unverifiable`,
`delivery-failed`, `delivery-unavailable`, `candidate-changed-during-delivery`,
`source-delivery-blocked`, or `source-delivery-interrupted` —
still holds the approved candidate in its retained worktree, and nothing about
the reviews has changed. Once the cause is fixed an operator may *finalize* it
(`POST …/runs/:runId/finalize`, the **Finalize run** button, offered as the
`finalize` action). Closure is evaluated again from the disk exactly as the first
time: the fingerprint is re-derived, approvals must still name it, delivery must
still rebuild it. Finalizing can therefore only complete what was already earned,
never bypass a condition; a run that still fails stays blocked with the new
reason, and every attempt is recorded under `run.finalizations`. It takes the
same exclusivity as a start (one live run per project, ownership through the
lock) and the worktree is settled afterwards by the same disposal rules.

### Reconciling a delivery with drifted source

When source delivery refuses because the destination changed the approved
patch's own paths (`application.state: source-drift`, the paths in
`application.drifted`; older records name them in the message), the run —
blocked `source-delivery-blocked` or `delivery-unverifiable`, worktree retained,
every closure condition met but delivery — offers `reconcile-delivery`
(`POST …/runs/:runId/reconcile-delivery`, the **Reconcile with source** button,
the top-level supervisor's `reconcile_delivery_run`). The name is deliberately
not `reconcile`, which already means integration recovery and runtime session
reconciliation. It takes Finalize's exclusivity and disposal rules, and
`runtime/source-reconcile.mjs` does the work. When every drifted own path is one
the project declares `append`/`prepend`, the panel runs it by itself as soon as
the run ends (`runtime/auto-reconcile.mjs`, actor `engine`), once per run: a run
that already has a reconciliation, a drift on any undeclared path, or a project
that is busy at that moment leaves the run blocked with the button offered.

1. The retained patch must still rebuild the approved revision on its base B.
   Paths under materialized links are merged like any other (B holds their
   materialized copies, the destination is read through the links); owner
   delivery records its own-path drift in `application.drifted` too, and the
   merged candidate is dispatched to the owners as any candidate is.
2. The destination is read exactly as delivery reads it (destination
   fingerprint against the run's baseline). B′ is a commit over B with that
   drift written in, built in a throwaway index in the run's recorded Git
   directory (the source repository's objects, or the private fetch of the
   snapshot) and pinned as `refs/devpanel/reconciled/<runId>-<n>`; its
   baseline is the run's with the same entries. Bytes that no longer hash as
   read refuse (`source-moving`).
3. The approved patch is applied `--3way` to a temporary worktree of B′. A
   conflict on a path the project declares `append` or `prepend` in
   `workspace.reconcile` (projects/<id>.yaml only; read when the action runs and
   recorded on the attempt) is resolved by keeping the source's content (stage 2)
   and adding the lines the candidate added there after it (`append`) or before
   it (`prepend`, a newest-first changelog) — only when its change to that path
   is pure addition. Every other conflict refuses (`conflicts`).
4. Outside the append/prepend paths the merged change must be the reviewed one: a path
   the source did not touch must have the approved bytes and mode, and a
   drifted path must carry the same removed and added lines in the same order
   and the same mode change, positions aside. Anything else refuses
   (`delta-changed`). The merged paths and the appended ones are recorded.
5. The merged candidate is an ordinary revision over B′: fingerprinted against
   B′'s baseline, kept as `reconcile/<n>/` (patch, verified to rebuild it, and
   baseline), and revalidated by the run's configured checks through the same
   check runner and base comparison — a local target always, a staging drive
   only when the requirement is `required` — and judged by closure's rule.
   A failure refuses (`revalidation-failed`).
6. Accepted: the revision is recorded with `reconciledFrom: <approved>` and
   `baseCommit: B′`, every approval of the approved revision is carried with
   `reconciledFrom`, and closure runs on the rebuilt candidate (a confirmation
   naming the approved revision names it). Delivery is the ordinary
   `apply-to-source` with base B′; `delivery.reconciliation` names the attempt,
   the approved revision, the merge base B, the source base B′, the merged
   paths and the appended ones. In a private repository B′ is also fetched
   into the source repository, and publication translates the merged delta
   (B′ → candidate) onto A′ = the source base A with the same drift outside
   materialized links (`refs/devpanel/reconciled/<runId>-<n>-source`), so
   the snapshot's exclusions and materialized copies never reach a published
   commit; where A was the snapshot itself, B′ is A′. A later Finalize
   rebuilds the same candidate.

Every attempt is journaled in `run.reconciliations` (`reconcile-started`, then
`reconciled` or `reconcile-refused`) and always merges the originally approved
patch. A refusal delivers nothing and leaves the run blocked exactly as it was,
with the conflicting or changed paths listed, or for failed revalidation the
check's whole record on the entry (`checks`, never in `checkResults`, so it
counts for nothing at closure) with `checks.reason` naming the gating condition
that failed; `get_run` and `get_check_log` read it. The next run of the issue
still starts from the approved patch (carry-forward). There is no new verification
level, and integration merges (`integrate.mjs`) are not involved.

## Workspace disposal

A worktree is deleted only when its content is provably captured elsewhere or
provably absent: the comparison against the persisted baseline proves nothing
changed, or a `worktree-diff` delivery completed with reconstruction verified
(or with a provider that offered no reconstruction to check). A `none` delivery
captures nothing, so a completed analysis run whose author touched the worktree
keeps it, with the reason recorded; an unverified patch or an unreadable
comparison keeps it too. "Delivery completed" is never by itself a licence to
delete.

## Integration: approved, bound, into the right repository

Delivery ends at a commit nobody has merged. **Integration** is an operator's
approval (`POST …/runs/<run-id>/integrate` with `expectedRevision`), turned into
a `--no-ff` merge of the candidate's branch into the project's integration
branch, and recorded on the run (`integration`: who approved, the revision, the
repository, the target branch and its head at approval, the merge commit, the
method). An approval names the revision, the target branch and the target head it was
given (`GET …/integration-target` returns the declared repository, branch and
head to approve exactly). It refuses when:

- the project has no complete `projects/<project>.yaml` naming both
  `sourceRepository` and `integrationBranch` (a partial file is invalid, not a
  declaration): without one the only target is a guess, and a guess is how a
  fix lands in the wrong repository;
- the approval names a revision other than the delivered one, a branch other
  than the declared one, or a target head other than the branch's head now —
  the branch moved since the operator looked, and approval was for a merge
  onto what they saw;
- the run's delivery is not a verified commit, or it was already integrated;
- the candidate's repository is not the project's declared **source
  repository** (`projects/<project>.yaml`: `sourceRepository`,
  `integrationBranch`; defaults are the checkout and its current branch). An
  application repository holding a flattened image of modules whose source
  lives elsewhere is exactly this case: committing there is not delivery, and
  the mapping between the two is a project decision the engine does not guess;
- the target branch is checked out in the source repository with tracked
  modifications: merging under a dirty working tree would leave it
  inconsistent. A clean checkout is merged in place so its tree follows; a
  branch not checked out is merged in a temporary worktree.

The merge is **built** in a temporary worktree detached at the approved head,
so its first parent is what was approved whatever the branch does meanwhile,
and then **published** atomically by a compare-and-swap on the **named**
branch ref (`update-ref` with the approved head as the old value) — never
through whatever HEAD points at, so a checkout that switched branches
meanwhile cannot redirect the publication. Every registered worktree that has
the branch checked out is inspected first (a dirty one refuses the operation)
and, after publication, has its index and working tree moved from the approved
head to the merge; a worktree that acquired local changes in between is
reported as stale rather than overwritten, and the publication stands. A
branch that moved in between fails the swap and nothing is recorded as
integrated. Integrations are serialised per repository.

Publication is **phased and persisted**: the record is written with the built
merge and phase `publishing` *before* the ref moves, `published` after it, and
`complete` once every checkout has followed. A process that dies in between
leaves a record that reconciliation settles from the repository alone — at
startup, or on request (`POST …/integration/reconcile`): `publishing` is
resolved by looking at the branch (swapped, or not, in which case it is
`aborted` and integration is offered again); `published` still owes the
checkouts their update. An unfinished publication refuses a second approval.
A stale checkout is not a footnote: the run's `integration.warning` names it
with the reason and a remedy, the panel shows "Published, checkout needs
attention", and the supervisor's run summary carries the same. A
conflict aborts the merge and is recorded as the refusal; nothing is left
half-merged. The supervisor has no integrate action.

## Failure

Round exhaustion, unresolved disagreement, budget exhaustion and protocol blocking
all leave the issue **unresolved**. None of them is a reason to close. A run that
cannot finish is a run that stops and says so.

## Workspace

One git worktree per run, from an explicit base commit chosen by **policy**, never
by whatever HEAD happened to be. `workspace.base` is set by the strategy, may be
overridden by the playbook (`workspace.base`) and by a run (`runOptions.base`),
and the choice, the resulting commit and the checkout's state are recorded on the
run (`workspace.base`):

| `base` | Cut from | Rule |
|---|---|---|
| `head` (default) | the checked-out commit | with `requireCleanBase`, a checkout with tracked modifications is **refused** with the count and the alternatives — a patch against a commit the live tree has left is not a patch against what is deployed |
| `working-tree` | a snapshot commit of the checkout as it is: tracked modifications, untracked files, symlinks; ignored files excluded | built through a throwaway index, parented on HEAD, kept reachable under `refs/devpanel/base/<run-id>`; for projects whose live state is not committed. The commit (and its filtered or materialized successors) carries no run id and HEAD's committer date, so it is a function of content and HEAD: two runs on an unchanged checkout share a base commit, as two `head` runs always did, and run identity stays in the refs named for the run |
| `{ commit: <ref> }` | that ref | explicit |

### What `working-tree` can actually snapshot

A `working-tree` base is built by `git add -A` into a throwaway index, so anything
that reads the tree to decide whether a run may start is answering one question:
what would that command produce, and can it produce anything at all. Two
implementations of that answer drift in one direction — a reader more permissive
than the snapshot approves a tree the launch cannot materialise, and the run dies
after admission and preflight have already spent. So the classification lives once
in `runtime/working-tree.mjs`, and both the launch condition and the snapshot use
it.

| Untracked entry | Fingerprinted as | Because |
|---|---|---|
| nested repository or worktree | `gitlink:<HEAD commit>` | that is what `git add -A` records; hashing the directory's name would miss every change inside it |
| nested repository with no commit | **blocks** | there is no gitlink target to record |
| plain directory git excludes the contents of | its presence and mode | verified with a scoped `ls-files` rather than assumed; if git also lists paths inside it, the entry is not the whole story and it **blocks** |
| symlink | the target text | as the snapshot stores it |
| regular file | content hash | — |
| unreadable regular file (EACCES, EIO) | **blocks** | `git add -A` fails on it |
| fifo, socket, device | **blocks** | git cannot record one, and `readFile` on a fifo does not fail — it blocks forever |
| vanished mid-scan | re-read once, then reported as a moving tree | a tree that moved describes no single state |

Blocking is a refusal, not a note: `inspectLaunchState` returns
`UNREADABLE_WORKTREE` (or `MOVING_WORKTREE`) and admission refuses, so the fault
is found before anything is paid for rather than while the base is being built.

`workspace.excludes` (project or playbook) names pathspec globs a `working-tree`
snapshot leaves out — runtime state, secret directories, symlinked dependency
trees that `.gitignore`'s directory-only rules miss. They are absent from the
base and the worktree, and recorded on `run.workspace.base.excludes`.

The candidate, the fingerprint baseline and the delivered patch are all relative
to the recorded base commit, so under `working-tree` a patch contains the
author's changes and none of the pre-existing divergence.

**Modes.** A file's mode in the fingerprint is the executable bit only, the
one thing Git carries: delivery rebuilds the candidate from the base commit and
a Git patch, so any other permission bit (a 0600 materialized copy, say) could
never be reconstructed and would block delivery as unverifiable.

**In place.** A run may forgo isolation altogether (`runOptions.isolation:
"in-place"`, the *Work directly in the project checkout* box in the start
dialog, or `workspace.isolation` in a playbook): the workspace *is* the project
checkout, there is no base commit and no snapshot, and there is nothing to hand
off — delivery is recorded as `in-place` with the changed paths, and closure
completes on it. Everything else holds unchanged: the fingerprint is taken over
the checkout against a baseline captured at start, approvals bind to it, turn
integrity quarantines a non-writer's edit or a failed writer's partial work
exactly as in a worktree, and the live checkout is offered to the workers
because it is the work. The panel never removes the checkout, whatever the
retention policy says, and checks — which rebuild base plus patch — are not run.
The trade is explicit and the preview says so: edits land live as they are
made, and a failed or cancelled turn can leave partial edits in the tree.

**Earlier runs.** By default a run's frozen input is human input only: the
report, notes and published findings. Earlier agent turns and result steps are
left out by provenance. `runOptions.accumulate: true` (the *Accumulate results
from previous runs* box in the start dialog, disabled while the issue has no
ended run) is the operator's explicit choice to build on substantial earlier
work — e.g. to implement an analysis's findings. For every ended earlier run of
the issue, oldest first, the window then also freezes
`input/prior-runs/<runId>/`: `steps.md` (every turn in order — investigations,
plans, reviews, handoffs, operator answers — headed with seat, phase, round,
revision and contract, invalid outputs included), and the result step's
`result.md` and `changes.patch` (`runtime/prior-runs.mjs`). These come after the
human input under the same input budget, are recorded on `window.accumulated`,
and the coordinator is told they are evidence to continue from, not approval.
The tool-free coordinator sees them as bounded excerpts beside the report and
notes; the seats read the full files. The option is snapshotted with the other
run options; a fresh evidence window keeps the inputs of the first.

**Symlinks.** A fingerprint records a symlink by its identity (its target
string, mode `link`), never by what it reaches: following it would fingerprint
content outside the candidate, and a write *through* it would change a live
file while the candidate's fingerprint stayed the same. So a symlink whose
target resolves outside the worktree is decided by `workspace.symlinks`:
`reject` (default) refuses to provision and lists them; `materialize` replaces
each with a copy of its target inside the worktree and re-snapshots that as the
base, so the candidate is self-contained and edits to the copy are candidate
content; `allow` keeps them, records them on the run, and accepts that writes
through them are not captured. Playbook and run may override. The scan for
escaping links traverses everything but `.git`: a link under `node_modules` or
any other path the fingerprint ignores still reaches outside the worktree.

Within a run the author is the sole writer. One run per issue does not prevent two issues touching the same
project, which is what the per-run worktree is for. Non-Git projects cannot be
isolated; the default is to block rather than let an author loose on a live tree.

## Locking

Two locks, both carrying owner identity — pid, boot id, process start time, host.

- **Run lock** — one active run per issue. Above it, the run supervisor allows
  one live run per **project**: a second issue on the same project is refused
  with 409 while another is starting or running, in this process or, judged by
  a live lock owner, in another. Two candidates cut from one base commit would
  be two patches that conflict at integration.
- **Step-allocation lock** — taken by *every* step-creating path, including manual
  creation through the API. Retry-on-`EEXIST` is not sufficient here: two
  concurrent creates with different slugs both succeed and both take the same
  number. This was a live defect once (two steps received `001`); allocation now
  runs under the shared lock with a durable reservation, and a retry after a crash
  resumes the reservation instead of allocating again.

Recovery must establish **positively that the previous owner is no longer active**
— the pid exists *and* its start time and boot id match. Lock age alone is not
evidence: a long invocation is indistinguishable from a dead one by age.

Liveness has three answers (`runtime/lock.mjs`, probes in `runtime/platform.mjs`):
`alive`, `dead` (proven absence, another start time for the pid, another boot) and
`unknown` (no pid, another host, or a probe that failed or answered something
unreadable — a start time with any component out of range is unreadable, never
rolled over into another instant). Only `dead` is taken over — by `acquire` (run,
step-allocation and top-level supervisor locks) and by the supervisor at startup,
which leaves a run whose owner is `unknown` alone, refuses to stop it and labels
it `owner-unknown`. A lock naming the server's own pid is its own only when that
owner is proved `alive`; an `unknown` one is held like any other.
If that process is gone, a person deletes the issue's `.run.lock` and recovers
the run; devpanel never removes a lock it cannot prove dead.

The `unknown` answer for a failed or malformed probe applies to the darwin
probes and to the decision itself. The Linux probes are the code that read
`/proc` before, moved verbatim with their outcomes: a `/proc/<pid>/stat` that
cannot be read, or lacks field 22, still reads as an absent process. On darwin
the boot identity is `sysctl kern.bootsessionuuid` and the start time `ps -o
lstart` in the C locale and UTC, which has **whole-second** precision (Linux:
clock ticks). That is accepted on one argument — XNU allocates pids
sequentially and wraps at 99999, so a pid comes back within the same second
only after the whole range was used in that second — and recorded on every run
as `host.startTimePrecision`. It is unproved until a Mac runs
`cd ~/devpanel/gui && node test/run.mjs lock`.

## Escaped descendants

Every agent turn runs with `reap`: when it ends, its process group is stopped
and the host is scanned for processes still carrying its `DEVPANEL_REAP_TAG`
(a descendant that left the group with setsid). The tag is created by the
engine and stored on the pending invocation before launch, so a lost owner's
turns can be scanned too. The scan says `complete` (only this proves the
descendants gone), `incomplete`, `unavailable`, or `not-requested` (check
commands, which are not reaped). On a host whose scan mechanism is not proved
(darwin, until a Mac proves `ps -E`; `host.unavailable` names
`descendantScanProof`) the parser's verdict is the status and the record says
`mechanism: 'unproved'`: a listing that parses complete — every row of this user
inspected, this process present, no malformed row — counts as `complete`, its
tagged pids are terminated and the turn proceeds; it is never recorded as plain
proved. A listing that does not parse complete, or a `ps` that fails, is
`incomplete`/`unavailable` with reason `structural`, because no rescan on that
host can prove it.

A turn whose scan is not `complete` records an open cleanup entry on the run
(`run.cleanup.entries`), in the same write as the turn's answer and before the
commit clears the pending invocation that carries the tag, and the run blocks
`cleanup-unproved`: the answer is kept, but no next turn, retry, replacement
model, check or delivery starts, and this wins over a pause or anything else of
the same commit. Concurrent reviews settle first: the run stays live until the
last sibling has, so a lost owner leaves every sibling's tag to owner-loss
recovery. Its workspace is retained. An entry closes in one of two ways:

- **a proof** — the tag is scanned again; survivors of the turn's own reaping
  are terminated and scanned once more, while an owner-lost tag is only
  scanned (survivors are named, never killed). Resume and Recover prove first;
  `POST …/runs/:runId/cleanup-proof` proves on demand. Not offered for a
  `structural` entry or on a host whose scan mechanism is unproved (409
  `SCAN_UNAVAILABLE`).
- **an acknowledgement** — a person's recorded word (`POST
  …/runs/:runId/cleanup-acknowledgement` with a reason; the issue page's
  *Acknowledge cleanup*), kept with who, when, which run and why; refused while
  the run is live. It is an explicit override of the gate, and the only way
  for a `structural` entry (darwin).

An in-place run's workspace is the project checkout, which every issue shares,
so its open entries are also kept in `issues/<project>/.cleanup-barrier.json`:
while one is there no new or resumed in-place run of the project starts (409
`CLEANUP_BARRIER`, which says when only an acknowledgement can lift it).
Abandoning, deleting or archiving the run does not lift it; a proof or an
acknowledgement does, and every lift is appended to the file's history. Once the
issue is deleted or packed by archiving, both work from the barrier entry's own
metadata (issue, run, tag). Worktree runs are not barred, and one live run per
project is unchanged. After a lost owner, a tag that scans complete and clean is
proved at once and bars nothing (on darwin as `mechanism: 'unproved'`); a
surviving tagged process, a scan short of complete, or a scan that throws bars
the checkout. The run records are the authority and the file follows them: each
startup reconcile, each proof, acknowledgement and run end puts a run's open
entries on it and lifts the ones it has proved or acknowledged, so a tag written
there ahead of a record a crash then lost does not bar other issues once proved.
A barrier write that fails is recorded on the run (`recovery.cleanupNoteFailed`
at startup) and does not stop the reconcile of the others; the supervisor then
holds those entries itself and admission stays closed (the 409 says the file
could not be written), trying the write again at every in-place admission
until it succeeds. The run record is what survives a restart: the next startup
reconcile reads it and holds the entries again. So nothing removes that record
while an in-place run has an open entry the barrier file does not record (or the
file cannot be read): deleting the run, and archiving, packing or deleting its
issue, are refused (409; `CLEANUP_UNRECORDED` for the run), because a deleted or
packed record is out of reconcile's reach. Once the file holds the entry they go
ahead and the file carries it.
This is one process's guard: an installation runs one panel process, and the
service's exclusive owner lock (top-level-supervisor.md) keeps a second one from
admitting runs.

## Capability: unknown is not unsupported

A roster entry distinguishes the two, because the fix differs:

| | Meaning | Naming an effort |
|---|---|---|
| `efforts: []` | the model supports **no** effort setting — an established fact | hard error, remove it |
| `efforts: null` | **unknown**; nobody has established what it takes | error, verify the entry first |

`verification.status` gates execution rather than loading. An unverified entry
**resolves for preview** — you can inspect a playbook, read its prompts and see its
budgets offline — but a live run refuses it. `haiku-4-5` is verified with
`efforts: []`; `glm-via-claude` has unknown effort levels (`efforts: null`)
despite verified model access.
GPT roster entries list the effort levels verified through fresh and resumed
Codex invocations, with evidence reports referenced in each entry. The Codex
adapter advertises effort support; `defaultEffort: null` retains the runtime
default when no effort is selected. Verification records the CLI setting and
successful completion, not the backend's internal interpretation of that setting.

## Loading versus probing

Separate on purpose:

- **`load.mjs`** — filesystem and schema only, no process ever spawned. Previews
  work offline. Output is one immutable, fully resolved playbook: validated
  participants, effective settings after narrowing, prompt references with hashes,
  budgets, completion policy, and the exact versions and hashes of every
  contributing file. Every failure names its source file and field.
- **`preflight.mjs`** — probes installed harnesses before a live run, with the
  probe injected so it is testable offline.

A probe reports three separate things, because **an installed binary proves only
the first**: `installation`, `authentication`, `modelAccess`. A shallower probe
leaves the deeper ones `unknown` — never assumed `ok`.

Inspect any of this without running anything:

```sh
node server/config/check.mjs                              # resolve every playbook
node server/config/check.mjs implementation --preflight # one, in full, with probes
```

## Start preconditions

Preflight probes at model depth — one paid call per participant — and the
workspace is not cut until after it passes. A source checkout git cannot read
would therefore spend a launch and then fail at provisioning, leaving a run whose
only account of itself was a raw `Command failed: git -C … rev-parse HEAD`.

So the checkout is proven **before anything is reserved or spent**. The shared
`supervisor.start()` path validates it after the project and the playbook resolve
and before `reserveRun()`, so the panel's own start and the top-level supervisor's
`start_run` meet the same gate. Four stable codes, each with the remedy:

| Code | Condition | Remedy |
|---|---|---|
| `UNSAFE_REPOSITORY` | git refuses the checkout as owned by another user (`detected dubious ownership`) | give it to the panel's own user, or record `safe.directory` deliberately |
| `EMPTY_REPOSITORY` | no valid HEAD: the branch is unborn, so there is no base commit to cut from | make the initial commit |
| `NOT_A_REPOSITORY` | the project directory is not a git repository | initialise and commit, or point the project elsewhere |
| `UNREADABLE_REPOSITORY` | anything else git refuses, HEAD included | git's own words are kept as `detail` |

Because the check runs before reservation there is deliberately **no run**, and
therefore no `run.failure` to classify. The classification travels on the rejected
start instead — `class: 'environment'`, `started: false`, `retryable: false`,
`status: 422` — and the API returns those fields beside `error`.

Each fault also says **what could clear it**, in `resolvableBy`. This is capability,
never permission. `commit-action` means an action that commits the checkout would
clear it — `EMPTY_REPOSITORY`, and the launch-state gate's `DIRTY_BASE`.
`operator` means no configured action can: ownership, a missing repository, a
broken HEAD.

Capability is not authority, and the gap between them is where the damage would
be. Whether the top-level supervisor may run an action to clear a fault is decided
by two things the server checks before dispatch, never by the model's reading of
its mission: the activation's `projectActions` grant, and what the action
**declares** it does (`effect: commit-checkout`). See
`docs/top-level-supervisor.md`, "Repository faults are work the supervisor can
do". `DIRTY_BASE` is the case to be careful about granting: committing a dirty
checkout commits whatever is in it, which may be the user's own unrelated work,
and a refused start is not authorization to do that.

Run participants do none of it: their worktree's content is the revision's
identity, so committing in it or reaching the live checkout would change what the
fingerprint measures. The top-level
supervisor's start gate reads `started === false` and releases the concurrency
slot rather than holding it as uncertain, and records the unchanged input as a
failed launch, so the same start is not retried blindly. A preflight refused with
no failure, only unproven findings (a probe that timed out or was cancelled), is
not recorded: it says nothing about the inputs, so the same start may pass, and
`maxStartsPerIssue` still bounds the retries. `run.preflight.counts`
(`failures`, `unproven`) carries the distinction; a record without it is guarded.

A start refused for what is occupied right now carries `started: false` and
`retryable: true`: a run active or starting on the issue or project, a held run or
admission lock, the concurrency limit, a stopping server or supervisor, a model on
an availability hold. The identical start can pass once that clears, so the gate
records no guard, releases the reservation and gives the attempt's charge back to
`maxRuns` and `maxStartsPerIssue` (`chargeReturned` on the launch). An archived
issue, a closed inquiry and the repository, base-policy and configuration refusals
are not momentary and stay guarded.

What this gate does **not** judge is cleanliness. A dirty checkout is a legitimate
start under `working-tree`, and refusing it under `head` is the base policy's
decision (`DIRTY_BASE`), taken against the tree as it is when the workspace is
cut, not against a reading taken earlier. A `deployment` run is exempt from the
gate entirely: its workspace is the archive of an already-staged release, so the
state of the source checkout says nothing about whether it can run.

## The launch gate

Preflight returns `launchReady`, true only when nothing failed **and** nothing is
unknown. Positive evidence is required: an unprobed or unproven connection is not
a green light.

Callers must not hand-test the field. Removing the old `ok` field did not make
callers fail closed on its own — `!undefined` is truthy, so anything branching on
a negation would sail straight through. Use the gate:

```js
import { preflight, assertLaunchable } from './config/preflight.mjs'
assertLaunchable(await preflight(resolved, { probe }))   // throws unless === true
```

A probe result is **untrusted input**. Before it is interpreted it must validate
against `harness-capabilities.schema.json` — otherwise a truthy non-boolean such as
`resume: "unknown"` reads as a capability — and its `id` and `connection` must
match the connection that was asked about, so one provider's authentication cannot
vouch for another's.

## Dry-run preview

`previewRun()` renders what a run would do, reading configuration only. It performs
no invocation, no authentication probe, no workspace, no run directory, no lock and
no step allocation — asserted by comparing the issue and project trees byte for
byte before and after.

Values that only exist at runtime render as visible symbolic slots, never as empty
strings: an empty substitution reads as "the template has nothing there", which is
a different and misleading claim. Each slot says where the value will come from —
`«steps.plan.response · produced at runtime by the author in step "plan"»`.

Two things are unpreviewable by nature and are shown as slots rather than guessed:
the prompts the coordinator authors during the run, and every future agent output.

```sh
node server/runtime/preview-cli.mjs <playbook> [--issue <project>/<id>] [--prompts]
```

## Structured output

The machine-readable part of a response is found by a scanner that understands
JSON strings, not by a regular expression. A non-greedy fence match ended inside
a handoff prompt that contained three backticks and rejected a valid answer as
"no parseable json block"; the scanner finds the object's real end.

Selection is conservative. Objects inside ```` ```json ```` fences are preferred;
bare objects are the fallback. Among the candidates only those that satisfy the
contract are kept. Exactly one survivor is the answer. Several *different*
survivors are **ambiguous** and go to repair — the engine never picks one. Every
rejected output is classified, and the classification travels with the run:

| `classification` | Meaning | Whose problem |
|---|---|---|
| `no-structured-output` | no JSON object anywhere in the response | the agent's |
| `contract-violation` | an object was found; it fails the contract, and the error says how | the agent's |
| `ambiguous-output` | more than one different compliant object | the agent's |

A valid object the engine could not find would be an engine defect; that class no
longer exists by construction, and a run blocked with `protocol-repair-exhausted`
exposes `diagnostics.protocol` — attempt, classification, error, candidate count —
so a reader decides from evidence rather than paying for a retry that changes
nothing.

### A repair says what was wrong

A repair turn restates the contract **definition** — required fields, enums and
descriptions rendered from the snapshotted schema — and quotes the validator's
error for the previous attempt. "Could not be read" told the first live authors
nothing they could write to.

## Every named context item is delivered

A step's `context` list is a promise that the participant has those things in
front of it. The engine keeps that promise itself: for a coordinator-authored
prompt it appends **every** listed item, verbatim, under `## Context supplied by
the engine`; for a strategy template it appends whatever the template did not
already render. A brief that summarises the plan, or names a path the recipient
cannot reach, no longer decides what the recipient sees. The contract definition
for the step's output is appended the same way.

The snapshot embeds the output contracts (`contracts.defs`, with the schema hash)
alongside the prompt bytes, so the definition a turn is shown and the definition
it is judged against are the same frozen text. Validation is **compiled from the
snapshot**, keyed by that hash; the schema files on disk are not consulted once a
run has started, so editing one cannot flip a recorded answer from accepted to
rejected mid-run.

### The plan is a derived reference, not the first draft

`steps.plan.response` is the first draft and never changes; after `revise-plan`
it is the superseded document. Steps therefore name the plan through two derived
references:

| Reference | Meaning |
|---|---|
| `plan.current` | the latest author artifact produced before any candidate existed, revisions included |
| `plan.approved` | the artifact the approving plan review examined: the last one recorded before a plan-stage review that returned `approved` with nothing substantial; `null` until then |

Both carry their step numbers (`plan.currentStep`, `plan.approvedStep`,
`plan.approvedByStep`), so the tie between the plan and the audit that approved it
is inspectable. Plan review and revision read `plan.current`; implementation,
implementation review and closure read `plan.approved`.

## Live output

Everything the runtime writes while a turn is in flight — raw stdout and stderr,
with spawn and exit markers — is appended in order to
`runs/<run-id>/live/<invocationId>.jsonl` and emitted over the socket as a `live`
event **only after** it is on disk. `GET …/runs/<run-id>/live/<invocationId>`
serves the backlog, and `?after=<seq>` continues from a sequence number, so a
browser that opens mid-turn, or reconnects, reads exactly what a live one saw. The
step's result remains the stored response; the live log is the transcript of how
it was produced, kept in run metadata, never in the step folder, and capped per
invocation (`DEVPANEL_LIVE_MAX_BYTES`, 64 MiB). Past the cap, output is dropped
but the markers are not: the cap marker replaces the chunk that crossed it and
is forwarded like any entry, and the exit marker is always persisted and
forwarded, so a capped turn never looks like one still running. The client
merges backlog pages and socket events by sequence number, so a chunk delivered
both ways lands once, and a gap triggers a single catch-up request.

The process runner retains the **tail** of each stream, not the head, and
reports `truncated` whenever anything was dropped; the adapters take the final
`result` record (Claude) and the session id, usage and last message (Codex)
from their own line observers, which see every byte, so a verbose turn cannot
lose its result to the retained-buffer limit.

## Run-owned scratch space

Each run has `runs/<run-id>/scratch/`, created at provisioning and named in every
prompt. It is outside the worktree, so nothing written there can enter the
candidate, and inside the run directory, so it stays with the run. Adapters set
`DEVPANEL_SCRATCH_DIR` and `TMPDIR` to it for the runtime process. Worktree
isolation alone does not constrain writes — a live author built a test harness
under the host project's tree — which is why an explicit place is offered.

## Delivery must rebuild the candidate

`worktree-diff` delivery stages exactly the paths the fingerprint records as
changed (ignored or not — the fingerprint is the identity) into a **throwaway
index seeded from the base commit**, never the worktree's own index — anything an
author or tool had pre-staged there, including paths the fingerprint excludes and
a reconstruction therefore cannot see, would otherwise ride into the patch
unreviewed. It diffs that index against the **persisted base commit** with
`--binary --full-index --no-renames` (a rename is a deletion plus an addition,
which is also how the fingerprint sees it), checks by name that the patch
touches exactly the fingerprint's changed set (`delivery.reconstruction.paths`; any extra or missing
path fails verification before a byte is compared), and then proves the artifact: the patch is applied to a temporary checkout of the base
commit, that checkout is fingerprinted with the same baseline, and only an
identical fingerprint is a verified capture. The result is recorded as
`delivery.reconstruction`. A mismatch blocks the run with
`delivery-unverifiable`; the worktree is retained, because the artifact is not a
faithful copy of it. Two earlier defects motivated this: a diff against HEAD lost
everything the author had committed inside the worktree, and a patch without
binary payloads could not rebuild a binary file — while `delivery.completedAt`
would still have licensed deleting the worktree.

## Activity is liveness, not progress

While a turn is in flight the adapter streams the runtime's own events (Claude's
`stream-json`, Codex's JSONL) and the engine records the process id, the last
event's kind and detail, an event count and a timestamp on
`pendingInvocation.activity`, persisted at most every few seconds and emitted
only after it is on disk. The panel shows it as "last seen using Read 4s ago ·
liveness, not progress". A tool call a moment ago proves the process is alive; it
proves nothing about how near the answer is, and nothing presents it as if it did.

## Snapshots must contain bytes, not references

The resolved playbook records prompt **paths and hashes**. That is enough to detect
that a template changed; it is not enough to render from. A hash cannot be
un-hashed, and a path can be edited or deleted mid-run.

So before a run executes, `resolved-playbook.json` must embed the **actual prompt
bytes**, and every turn must render from that embedded copy — never by re-reading
`strategy-templates/` at render time. Editing a template while a run is in flight
must have no effect on it, which is the same guarantee the configuration snapshot
already gives for participants and budgets.

The recorded hashes then serve their real purpose: proving the snapshot matches
what was on disk when the run started.

## Authentication

Every `/api` route and the socket handshake require the shared operator token
(`auth.mjs`); the token lives in `.devpanel-token` on the server and in
sessionStorage in the browser, never in a URL. There is no per-user identity.


## Per-run settings

The start dialog accepts overrides for one launch: maximum turns, wall-clock
minutes, token budget, per-phase review rounds, protocol-repair attempts, and
participant roster models and effort levels. Reopening the dialog or choosing
Reset to defaults restores the saved playbook. These controls never write its YAML.

Preview and start accept the same `runOptions` object. Its allow-listed fields
are `budgets` (`maxSteps`, `wallClockMinutes`, `maxTokens`, `maxCostUsd`), `rounds`
(loop phase IDs), `repairAttempts`, `participants` (role to `model`/`effort`),
`base` (`head`, `working-tree`, or a commit) and `symlinks` (`reject`,
`materialize`, `allow`). A null effort
uses the model default. Replacing a model clears its predecessor's effort unless
the caller supplies one. Unknown models, roles, phases and unsupported efforts
are rejected. Budgets cannot exceed strategy ceilings; repair attempts may only
reduce the strategy's cap. Review rounds use the existing loop override rules.

The preview hash includes canonicalized arguments. A start with overrides must
supply that hash; changed arguments or changed contributing configuration cause
a refusal before any run or paid probe is created. The engine executes the frozen
resolved snapshot, which includes the arguments, effective settings and prompt
bytes. Run reads expose `runOptions` for later inspection. An edit while a preview
is outstanding cannot enable Start with the earlier settings.


## Markdown display

Responses, prompts, coordinator handoffs and Markdown attachments default to a
formatted view. Raw text displays the exact stored source. Structured output,
patches, logs and non-Markdown source files stay plain text.

The client parses Markdown with HTML disabled and builds a fixed set of Vue
nodes. It never inserts rendered HTML strings. HTTP(S), mailto and fragment links
are allowed; other link targets remain unlinked. External links protect the
opener and referrer. Images display their alt text without fetching their URLs.
Code and embedded HTML remain literal text. Opening a response cannot introduce
scripts, frames or remote image requests into the authenticated panel.


## Asking the owner before any work starts

A run should finish without a person.
When it cannot, the question comes first, from triage, and the run **ends** rather
than pausing on the project's single run slot.

`triageResult.autonomy` is required: `verdict` is `autonomous`,
`needs-owner-input` (with 1–5 `questions`, each with a `category` — `owner-gate`,
`requirement-conflict`, `authorization`, `missing-information` — and the agents'
`recommendation`) or `too-large` (with a 2–6 part `split`). The engine refuses a
verdict that contradicts itself as a contract violation, repaired like any other
(`triageProblem`): questions only with `needs-owner-input`, a split only with
`too-large`, no `firstHandoff` and `suggestion.action: needs-input` whenever the
verdict is not `autonomous`. A triage recorded under an older contract has no
verdict and is not checked.

The transition `to: ask-owner` (only on a `triageResult` step) ends the run as
`completed` / `unresolved` with `run.ownerInput` — verdict, reason, questions or
split, `askedBy`, `at`, `answer: null`. Its result is `needs-input`
(`owner-questions` / `owner-split`), it is a question on Needs attention, and the
worktree is released like any ended run. `POST …/runs/:runId/owner-input`
(`server/owner-input.mjs`) answers it once, under the run lock: the answer is
recorded on `run.ownerInput.answer` first; then the answers become a human note on
the issue (which the next run's evidence window captures) and the same playbook
starts again with the snapshot's run options, pinned to the asking run's
`configHash` — a changed playbook is not started, and the refusal is recorded as
`answer.startError`. An accepted split instead creates the parts as issues and
records the `split` disposition naming them; a declined split writes a note and
starts again. The top-level supervisor has no action for this: owner questions
are the owner's.

## Operator decisions

A run may stop for a human without ending. Three things ask:

- a phase transition `to: await-input` with a `question` (rendered from the
  step's structured output). The shipped strategies no longer use it for triage;
  they use `ask-owner` (above);
- a loop whose `onExhausted` is `await-input`: when its rounds are used without
  the exit condition holding, it asks `continue` or `stop` instead of blocking.
  The shipped Implementation and Plan and implement loops use
  `extend-if-converging` instead, which asks nobody: when the last regular round
  left fewer substantial findings (a failed check counts as one) than the round
  before it, and none of them is reopened, the loop gets exactly one more round,
  derived from the record so a replay grants the same (an extra round already on
  the record stands); otherwise it ends as `rounds-exhausted`. A finding is
  reopened when its exact id was closed in an earlier round of the loop: every
  seat that named it reviewed that round and none listed it as substantial. One
  that stays open from round to round is not reopened. `run.extensionDenied`
  (`phase`, `round`, `reopened`) records the ids and the run's explanation names
  them;
- the coordinator itself, through `operatorRequest` on its `handoff`, as a last
  resort (below).

The run's status becomes `paused`; `run.pause` holds the question, the closed
`options` (or null for free text), which step asked and when. Nothing is in
flight and the worktree is retained. The answer is recorded by `engine.answer()`
as a step of its own — role `operator`, a folder on disk, the decision on the
step record — and the run goes back to `pending`. Replay then sees the operator
step after the asking step and continues past the question; a `continue` answer
grants exactly one more round, a `stop` answer ends the loop as round exhaustion.
A closed question accepts only one of its options; anything else is refused with
422, never interpreted. Operator steps are not counted against `maxSteps`.

Every later step may name `decisions` in its context and receives every answer
so far, verbatim. The panel answers through `POST …/runs/:runId/answer`; the
top-level supervisor through `answer_run`, on runs it owns.

### The operator can ask the coordinator, and instruct it

The issue page offers a chat with a run's coordinator seat
(`runtime/coordinator-chat.mjs`). It has two kinds of message, and they differ in authority:

- **Question.** The answer comes from a *fork* of the coordinator's native
  session (`claude --resume <id> --fork-session --session-id <new>`, `codex exec
  fork <id>`). It runs in the adapters' tool-free mode, in the same working
  directory, home and seat fence as the coordinator's turns. The run's session
  never gains a turn, `run.json` is not written, and nothing in the answer
  reaches the run. A question may be asked mid-turn. The copy then knows the run
  up to its last completed turn, and the prompt states where the run stands now.
  The cost is reported on the answer. It is operator spend, not counted against
  the run's budgets. A run without a coordinator session yet refuses with 409.
- **Instruction.** It is delivered by the engine, verbatim, at the end of the next
  coordinator-only turn's prompt (`operator-instructions`), and that step records
  the ids it carried (`step.instructions`, `step.instructionScope`). Delivery
  follows session scope. A turn on an existing session is given only what no
  earlier step of the same scope carried. A fresh session (none yet, or one the
  engine reset) is given every instruction so far, with the earlier ones marked,
  because it never saw them. An instruction influences how the coordinator writes
  its briefs; it is not an approval, does not waive a closure condition, and does
  not pause or wake the run. A completed or abandoned run refuses one.

Both kinds are appended to `runs/<id>/chat.jsonl` before the
`run:event {type:'chat'}` announces them. The file is not run state. The engine
reads it only while building a coordinator prompt, so replaying recorded steps
is unaffected. A question with no recorded answer after a restart reads as
interrupted and is never re-asked.

Reasoning is shown, not inferred. Claude seats pass `showThinkingSummaries`
(without it the stream carries only signatures), and Codex seats pass
`model_reasoning_summary="detailed"`. The summaries appear in the live output
as `thinks` rows.

### The coordinator can ask for work it may not do

A participant's workspace is an isolated worktree whose content *is* the
revision's identity. Nothing in a run may reach the live checkout: a commit
there would change what the fingerprint measures and what the patch rebuilds,
and approvals, checks and closure all bind to that fingerprint. This is why the
tooling brief tells a role that writes code "do not change Git HEAD or create
commits".

A prohibition with no way round it leaves the coordinator unable to say that the
work genuinely needs the live checkout. So the `handoff` contract carries an
optional `operatorRequest` — `question`, `reason`, a required `category` and
`recommendation`, and optionally the `projectAction` that would do it. The
category is one of `live-checkout`, `owner-gate` (a stop the issue itself asks
for at this point, such as confirming the plan: one approve-or-revise question),
`authorization` (spending, production, destroying data, publishing) or
`requirement-conflict` (criteria that cannot all hold, with evidence). There is
no category for a technical choice: the coordinator decides it and records it in
the handoff's `assumptions`, which the run's `result.md` lists under
"Assumptions made" for the owner to overrule afterwards. A tool missing on the
authoring host is not a question either: the check runs on the configured
staging infrastructure or is reported `unavailable`. The engine records it in
`run.operatorRequests` (keyed by the step that raised it, so a crash between
marking and pausing cannot ask twice), pauses with `pause.kind:
'operator-request'` and `pause.request`, and delivers the handoff that turn
authored only after the answer. It is independent of `tactic`: any strategy
whose coordinator authors a handoff can ask.

The request is applied **before** any other coordinator effect on the same turn.
The contract permits a handoff to carry both, and the window effects are the
dangerous pair: `restart-required` would block the run before the ask was ever
made, and `refresh-evidence` or `restartPlan` move `windowResetAfter` past the very
step that asked, so the request would never be seen again. Asking first loses
nothing — the effect still applies on the next pass, in its own terms.

Who answers is the same question as everywhere else. `pause.request` reaches the
top-level supervisor in the run summary, but `projectAction` there is a model's
suggestion with no authority of its own: the activation grant and the declared
effect gate it exactly as they gate a refused start, in the same dispatcher. When the work is not something the supervisor may do, it opens an
issue with `create_issue` rather than answering as though it were done, and says
so in the answer. An answer is recorded as a step, and later turns read it as
fact.

## Runtime failures, retry and availability

A runtime that exits non-zero, reports an error record, or cannot be spawned is
classified by `runtime/failure.mjs` from its own words, and the classification
is recorded with the evidence it was read from (`run.failures[]`):

| Class | Retried | Effect |
| --- | --- | --- |
| `rate-limit`, `transient` | yes, up to `retryPolicy.maxAttempts` (default 3), after `baseDelaySeconds`·2ⁿ capped at `maxDelaySeconds`, or the provider's own retry-after | the turn is re-invoked with a fresh invocation id |
| `quota` | with a compatible replacement | the model is recorded in the host-wide availability store with the provider's reset instant, or a default hold marked `assumed`; later starts naming it are refused (409) until then |
| `auth`, `environment`, `runtime` | no | the run fails with `run.failure` naming the class |

A Claude turn records its login's shared credential file (inode, size, mtime;
a content hash compares but is never kept) as it starts and again when it
fails, as `credentials` on the failure. An `auth` failure (an expired OAuth
session included) while that file was replaced or rewritten is another
process's refresh rotating the token the turn held: it is `transient`, retried
once at once, and the retry's fence binds the file as it is now (a removed
file is a change as well; its retry fails as `auth` against a file unchanged
since that retry began). A seat's single-file bind keeps the inode it was
launched with, so a refresh by another process is invisible to a running turn.
Unchanged, it stays `auth`, and no auth failure touches model availability.

Source integrity is verified for the failed turn before any retry, exactly as for
a completed one. The wait respects cancellation. `retryPolicy` is set per strategy.

The integrity record covers every file in the worktree plus every path Git
tracks, even under the fingerprint's exclusions. A tracked submodule pointer
(a gitlink, index mode `160000`) has no content in the repository and is
materialised by a checkout as an empty directory; it is recorded as an entry of
mode `gitlink` hashed over the commit it names, never required to exist as a
file. Files an agent writes under that directory are ordinary worktree entries.

The availability store lives beside the issues (`.availability.json`), is read
before every start, fails closed when unreadable, and is cleared per model by an
operator (`DELETE /api/availability/:model`).

## Cost reporting and quota substitution

`budgets.maxCostUsd` is advisory metadata. Reported costs and estimates never stop
an individual run. Unknown prices remain explicit in `budgets.used.costUnknownSteps`.

A confirmed provider quota failure invokes the service's replacement selector after
failed-turn integrity verification. It considers verified models with at least the
original context capacity, prefers another connection/account, excludes unavailable
models and models used by other seats, and preflights each candidate. Coordinators
retain their tool-free restrictions. Auth, runtime and integrity errors never trigger
quota substitution.

The original resolved snapshot remains immutable. `modelOverrides` stores the exact
replacement connection and effort; `modelSubstitutions` records the handoff and
`modelFallbackChecks` retains preflight evidence and usage. The replacement starts
with a fresh native session and the existing run context/worktree. Completed steps
are not repeated. Exhaustion with no compatible available replacement ends the run
with its evidence retained. The supervisor observes substitutions during monitoring
and uses the same quota-triggered failover for its own model.

## The auditor's voice

Audit steps render strategy-owned templates. The coordinator's handoff is one
context item among the others, never the whole prompt, so the method — read the
patch, run what can be run, cite what a finding violates and where, record what
was not verified — does not depend on what the coordinator chose to write. The
implementation auditor receives `revision.diff`: the candidate as a unified diff
against the base commit, untracked files included, computed from the worktree at
invocation time and capped at 256 KB.

A substantial finding (`blocking: true`, or severity `major`/`critical`) must
carry `criterion` and `location`; the engine treats a review missing either as
a contract violation and asks the reviewer to cite or downgrade. `verification`
(`gate`, `performed`, `notRun`) records what the reviewer actually did.

### Persistence and decision identity

Run state, snapshots, integrity records, availability records and staging operation
records use the shared persistence helper: exclusive unique temporary file,
write, file sync, close, rename, then directory sync. Ancestor directories are
synced as well; journal appends are synced before events are emitted. A sync
failure is an operation failure, not an acknowledged save.

Availability updates hold a process-safe lock for the full read/modify/write,
including operator clears. A missing store starts empty; an invalid store refuses
operations. New pauses carry a unique `pause.id`; answers must supply that value
as `pauseId`. Missing or stale IDs return 409 without recording a decision.
Historical pauses receive a stable derived ID when read, so operators can reload
and answer them. The phase key is not an occurrence ID.

Failure of the final SSH candidate/archive removal makes checks unavailable.
The cleanup result retains exit status or transport error and both remote paths;
a failed removal may have partially deleted them and requires inspection.

### Input-size rejection recovery

Model prompts receive bounded check summaries; complete manifests and command
evidence remain under the run's `evidence/checks/latest.json`. A confirmed
`input_too_large` failure can use `POST .../runs/:runId/retry-input` or the
supervisor's `retry_input_run` action. The engine requires an unchanged retained
workspace, clear integrity and no pending invocation or release recovery. It
resets only the rejected seat's native session, preserves completed steps and
failure evidence, and excludes time spent stopped from the execution deadline.
The monitoring loop records its last-notified status separately from accounting
refreshes, so a settlement cannot consume the completion/failure notification.

### Continuing a run stopped at closure

`POST .../runs/:runId/continue` (`engine.continueRun`) and the supervisor's
`continue_run` reopen the review loop that produced the candidate of a code run
blocked at closure (`closure-conditions-unmet`, `refreshed-checks-failed`), with
clear integrity, the workspace retained and no release. The operator's instruction,
the closure record (unmet conditions, residual risks not accepted) and the issue
notes numbered after the run's first step that no earlier Continue carried are
recorded as one operator decision step with key `<phase>:continue`. Replay counts
the loop's last round before that step as not passed (`operatorContinued`) and
allows the round after it whatever the loop's cap, so the coordinator briefs the
author for that round in the same worktree and sessions; reviews, checks and a
fresh closure confirmation follow, and the earlier confirmations are superseded.
Budget limits may be raised as for resume, and the time the run stood still is not
counted. `run.continueHistory` records each Continue. Resume is not offered here:
replaying an unchanged record reaches the same closure.

### The engine returns an unmet confirmation to review

The closure confirmation classifies every unmet criterion
(`criteria[].unmet`): `missing-work` or `missing-evidence` (the author can still
fix it), or `live-checkout`, `owner-gate`, `authorization`,
`requirement-conflict` (only the operator can). `met: false` without `unmet`,
or `met: true` with one, is a contract violation repaired like any other. Both
apply only to runs whose snapshot's `closureConfirmation` contract defines
`unmet`; an older run replays as it was recorded.

When closure of an `implementation` or `plan-and-implement` run (Refactoring
included) is blocked as `closure-conditions-unmet` and every other condition
holds — same-revision approval, checks satisfied, no outstanding blocking
finding, authority — and the confirmation names the current revision and
classifies each unmet criterion `missing-work` or `missing-evidence`, the
engine does not stop the run (`engine.returnToReview`). Like Continue, it
records one decision step, with key `<phase>:return`, actor `engine`,
`automatic: true`, and the unmet criteria as blocking findings `closure-<id>`
(severity major, the criterion, its location and the coordinator's evidence).
Replay counts the loop's last round as not passed, so the coordinator briefs
the author for one more round in the same worktree and sessions; the earlier
confirmations are superseded, and closure is evaluated again after a fresh
confirmation.

The closure findings are outstanding until a review examines them, and each
later implementation review must give each one a `priorFindings` disposition
(they are supplied in `findings.plan`); a `deferred` one stays blocking. A
review recorded before the return is not asked about them.

At most two returns per run (`run.closureReturns` records each). A third
unmet confirmation, an unclassified criterion or one the operator must decide,
an in-place run, or a run of any other tactic blocks exactly as before, with the
reason in `run.closure.notReturned`; Continue stays available. The run
explanation says a run was returned, and why one was not; run metrics count
returns (`closureReturns`, and `turns.automatic` beside `turns.operator`).

The confirmation step has `access: checks`: inside a proved seat fence the
coordinator's own turn may read the run's `checks/` and `evidence/` (not the
source) with read-only tools. It keeps the coordinator's session and working
directory (read-only for this turn) and writes only to its own scratch beside
it, `scratch/<role>-checks`, because the adapters refuse a reading turn whose
scratch is its working directory. With the fence off, unproved
(`DEVPANEL_FENCE_UNPROVED=run`) or in place it stays tool-free, as before.
Either way the prompt quotes the latest check's `gating` and
`baselineComparison`, selftest failures included.

### Refreshing closure evidence

`POST .../runs/:runId/refresh-checks` and the supervisor's `refresh_checks_run`
resume a retained tactical code run blocked at closure, or stopped only by failed
checks on an approved revision (`checksOnlyBlock`). The server loads only the
operator-installed testDrive configuration; models cannot supply shell commands.
The workspace must match its integrity checkpoint. The approved source and audits
are preserved, old confirmations are retained but superseded, and the exact
candidate is reconstructed for fresh checks. A failed new result blocks delivery;
the latest result for the revision is authoritative. After passing checks, a fresh
coordinator session reassesses every acceptance criterion against the new evidence.
No criterion is waived. The original snapshot stays immutable; the check target
and refresh history are separate durable run records.


### The first brief can be written at triage

When a strategy's first coordinator step after triage is a `handoff`, the triage
turn is asked for an optional `firstHandoff` naming the seat it briefs. A valid
one is recorded as that round-0 brief through the normal commit path — validated
against the handoff contract, its effects applied — with no second invocation;
the step carries `derivedFrom`. Without one, or on a repair or later round, the
brief turn runs as before. A derived brief left pending by a crash is simply
derived again.

### Recovery after the owner disappeared

A run marked `recovery-required` by startup reconciliation (`recovery.ownerLost`)
offers `recover` (`POST …/runs/:runId/recover`). It refuses while any process
group from the lost owner is alive or integrity is not clear, reconciles every
pending invocation from the adapter ledgers (adopt completed, retry not-started),
retries an *uncertain* one with a fresh session only when the integrity
comparison proves the workspace untouched, and otherwise stays blocked naming what
is uncertain. On success it resumes as `resume` does, the time nobody owned the
run counted as suspended (`ownerRecoveries`). A quarantined run instead offers
`resolve-integrity` (`GET/POST …/runs/:runId/integrity`): inspect the changes,
then `accept-partial`, `restored` or `abandon`, pinned to the inspected state hash.

One failure does not quarantine: a writing turn (no HEAD change, nothing
unauthorized) that failed because another process replaced the shared credential
file under it (`failure.credentials.changed`, retried once by `failure.mjs`). Its
partial edits are its own interrupted work, so the engine keeps them as the
retry's baseline, as an operator's `accept-partial` would, and records
`partialAccepted: { reason: 'credential-rotated', paths, index }` on the turn's
integrity report and on the failure. Once per step and round; a second failure
there quarantines as any other.

### Integrity capture cost

Tool-free coordination-only turns take no whole-tree capture; the next working
turn compares against the last checkpoint, and a change found then is attributed
to the uncaptured turns (`attribution: inferred-from-uncaptured-turns`). Captures
reuse a file's hash from the same process's previous capture only when inode,
size, mtime, ctime and permission bits are identical and the file was last
changed more than 2 s before that capture began; anything else is re-read.

### Operator pause and resume

`POST …/runs/:runId/pause` requests a pause at the next turn boundary. The
current invocation finishes and is recorded; no new turn starts afterwards.
The request is durable and visible while the invocation finishes. The resulting
pause has `kind: manual`. Stop remains a separate action that cancels an invocation.

`POST …/runs/:runId/resume` continues that same run, including cleanly stopped,
failed, budget-blocked, round-exhausted and protocol-repair-exhausted runs with
retained, unchanged workspaces. It takes the usual issue lock and project slot,
checks the journal and integrity checkpoint, and preserves native sessions,
completed steps, findings, checks and usage. It never reruns preflight. A pending
operator question still requires the existing answer endpoint. Missing workspaces,
uncertain invocations, quarantines and release mutations require their existing
recovery paths; resume does not waive those conditions or closure requirements.

The optional `budgets` object supplies positive integer total `maxSteps`,
`maxTokens` and `wallClockMinutes` allowances. Limits cannot shrink, and exhausted
allowances must be explicitly increased. The UI defaults elapsed time to seven
days (10,080 minutes). Time spent stopped or waiting for an operator answer is
excluded from the deadline; spent steps and tokens are never reset. Resume grants
one additional review round or protocol repair when that is the exhausted limit.
Changes are recorded in `resumeHistory` and `controlOverrides`; the original
resolved playbook snapshot stays immutable. Explicit continuation does not imply
approval of any outstanding finding or automatic resolution of the issue.

For explicitly authorized operator corrections, `retained-amendment.mjs` provides
`amendRetained(engine, { edits, target, actor, reason })` under the exclusive run
lock. Each edit supplies a workspace-relative path and exact before/after text.
The helper checks the existing integrity checkpoint, refuses symlinks and Git
metadata, records a pending amendment before writing, and fingerprints the new
candidate. Interrupted amendments block resume. Completed amendments preserve
sessions and the launch snapshot but clear approvals; prior check receipts remain
in history. An optional replacement check target must retain the same destination
and is recorded separately so subsequent checks use the corrected commands.
This is an operator maintenance helper, not a model-exposed action. Resume still
requires fresh review and the usual closure conditions.
