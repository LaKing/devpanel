# Tactical playbooks

The start dialog offers eight playbooks. Triage uses a coordinator for a short handoff
and an investigator for the technical work and final disposition. Other coordinated
playbooks may occupy additional worker seats. Every occupied seat has its own
session and scratch directory.
The engine currently schedules seats **sequentially**; the coordinator cannot
advance past a round until every occupied seat has returned a valid result.

| Playbook | Required worker | Optional workers | Result |
| --- | --- | --- | --- |
| Analysis | `analyser` | `analyser-2` … `analyser-5` | Combined investigation and actionable issues |
| Triage | `investigator` | none | Coordinator handoff, precise investigation, direct disposition |
| Implementation | `implementer` | `auditor-1` … `auditor-4` | Approved changes applied to development source and verified; patch-only delivery selectable |
| Refactoring | `planner` (also implements) | `auditor-1` … `auditor-4` (first occupied by default) | Simpler structure with preserved functionality |
| Plan and implement | `planner` (also implements) | `auditor-1` … `auditor-4` | Plan consensus followed by implementation consensus |
| Staging | `release-operator` | `verifier-1` … `verifier-4` | Checkpointed stage release and recorded tests |
| Deployment | `release-operator` | `verifier-1` … `verifier-4` | Promotion of the exact successfully staged archive |
| Prompt | `worker` | none | One seat does the whole task; delivered, unreviewed |

All optional seats default to unoccupied. Configure them in `participants` in the
playbook YAML, or in the start dialog. API overrides use
`runOptions.participants: {"auditor-1":{"model":"gpt-6-astra"}}`; `null` clears an
optional seat. A required seat cannot be cleared. No auditors means **no independent
audit**, explicitly recorded in closure and displayed in the issue page.

A playbook may restrict automatic quota substitutions with `fallbackModels`, an
allowlist of roster IDs captured in the run snapshot. An empty list disables
substitution; omission preserves the normal verified-model fallback behavior.
Availability, preflight and author/auditor independence still apply. This does not
change the initially assigned seats or the top-level supervisor's model.

Implementation, Plan and implement, and Refactoring default to `apply-to-source`.
Starting one authorizes engine-owned application at the destination shown in
readiness/preview. Choose `worktree-diff` to review a patch before applying it.
Source drift or a changed path under a materialized symlink leaves the patch and
worktree available: apply manually or rerun. Only verified destination content
satisfies source delivery. The engine leaves HEAD and the source index unchanged.

The old `standard-change`, `careful-change`, `tight-change`, `prototype`, `review`
and the one-time `migration-*-gpt` playbooks were removed on 2026-09-25; their IDs no
longer resolve for new runs. Already snapshotted runs retain their own algorithm.
Review of existing material belongs in Analysis.

Default seats (since 2026-09-26): every coordinator is Claude Opus 5.5 (`opus-5-5`)
at medium effort. The source writer of Implementation, Plan and implement and
Refactoring (`implementer` / `planner`) is Opus 5.5 at medium, and their `auditor-1`
is occupied by default with GPT-6.1 Sol (`gpt-6.1-sol`, since 2026-10-01) at medium, so those playbooks are
independently audited unless a run empties the seat. Other worker seats (analyser,
investigator, release operator, prompt worker) keep their own efforts. Any seat's
model and effort can be overridden per run.

## Coordinator and consensus

An author may ask for a diagnostic drive: the check target on its revision plus a
patch kept outside the worktree, to gather evidence without adding diagnostic code to
the candidate. It is never reviewed, delivered or counted as a check
(execution-contract.md "Diagnostic drives").

Every newly resolved playbook assigns its coordinator `coordinationOnly: true`.
The engine runs that seat from its scratch directory in the adapters' tool-free
mode: no source tools, shell, MCP, skills or inherited tool configuration. Workers
retain their normal access. Old snapshots keep their recorded policy.

One exception (phase 1 of the seat-access fence, harness/README.md "Seat hygiene"): a step
marked `access: read` — the triage step of Implementation and Plan and
implement — runs its coordinator inside the seat fence with the run's source
snapshot mounted read-only, read tools and an offline sandboxed shell, in its
own session and CLI home (`p.readSession`, `cli-homes/coordinator-read`), so
later coordinator turns stay tool-free and never carry the source text. It
lists what it established in `triageResult.facts` with evidence and asks the
owner (`autonomy.verdict: needs-owner-input`, a `requirement-conflict` question)
when those facts show that two requirements cannot both hold.
When the fence cannot be proved (or `DEVPANEL_FENCE=off`) the step is tool-free
as before.

The coordinator sees the task, bounded captured-input excerpts, worker reports,
criteria, unresolved findings, operator decisions and engine revision/check/release
metadata. It does not inspect source or independently redo a worker's checks. It
routes technical uncertainty to the responsible worker and reconciles reported
evidence against the objective. Every coordinator turn receives the frozen initial
report followed by newest notes and supporting text (up to 16 files and 60,000
bytes, shared so large files cannot crowd out short decisions). Explicit scope and
approval records govern; recency alone does not confer authority. Omitted sources
and truncation are explicit, and missing excerpts do not establish missing approval.
Supplied reports omit duplicate narrative and the coordinator's own earlier messages.
Validated structured worker outputs remain complete, including verdicts, revision
identity, residual findings and prior-finding dispositions; narrative budget limits
must not truncate the evidence a tool-free coordinator needs to decide closure.
Invalid outputs never supply approval. Coordinator output is JSON
only, with concise handoffs and reasoning. All default coordinator efforts are medium;
workers retain the reasoning settings appropriate to their technical tasks.

Analysis now briefs the workers, collects every occupied analyser's report and
records one reconciliation/disposition. It has no preliminary source-verification
turn or second closing-report turn. Triage returns the investigator's disposition
directly. Coding/release workflows retain the audit, exact-revision and release
authorization gates; coordinator confirmations reference worker/engine evidence,
not personal inspection.


Each coding round starts with a coordinator brief, followed by the sole writer
and every occupied auditor. An approval by a later auditor cannot erase another
seat's findings. All auditors must approve the same candidate after its latest
writing turn. Plan approval likewise requires all occupied auditors to review the
same draft. A source revision or evidence-window refresh invalidates approvals.
Missing, malformed, failed, and stale audit responses never count as approval.
Protocol repair remains bounded; round or overall budget exhaustion is unresolved.

Auditors must cite a concrete criterion and location for actionable concerns.
They prefix finding IDs with their seat, and may withdraw an unsupported concern
with an explanation. The coordinator reads the complete round and directs the
next correction. In Plan and implement, `handoff.restartPlan: true` reopens the
whole plan cycle when an implementation requires a material plan change. It is
honoured only from an implement-review brief: anywhere else (a plan-review brief
in particular) it is recorded as ignored (`coordinatorEffects[step].ignored`) and
the plan simply takes its next loop round, so `maxRounds` stays in force. Plan
and implementation review exhaust by rule (`extend-if-converging`, 2026-10-01):
after five rounds a loop whose last round left fewer substantial findings than
the one before, none of them reopened after an earlier round closed it, gets one
more round without asking; otherwise the run ends unresolved, keeping the work so
far, and its explanation names any reopened finding and says whether the full drive
reached the last revision. An audit on the last allowed round holding an
`awaitsCheck` finding gets that drive before the loop ends.

### What a brief asks for

Every `brief.md` that receives `findings.outstanding` (Implementation, Plan and
implement, Staging, Deployment, Analysis) asks the coordinator to reference open
findings by ID and quote only what the worker lacks, within the handoff prompt's
2400-character limit. The Triage brief receives only the issue and the window.

The briefs that follow candidate revisions (Implementation and Plan and implement)
also say that the same timeout or crash signature on two consecutive revisions
gets a diagnostic step before another change, stated as such in the handoff. A
brief turn has no check history in its context: `checks.latest` is the latest drive,
`retrySkipped` (`failed-same-way`) and `previousDrive` appear only in some drives,
and a fresh session lacks the earlier turns. So the wording never claims a repeat
it cannot see. It sends the worker, who can read every drive under the run's
`checks/`, to compare first and treat a match as the repeat. Whether a coordinator
follows this can only be seen on a run; the templates do not enforce it.

A recorded example of such a handoff, written by hand under this wording after a
real run in which 900-second timeouts recurred over several revisions before a
person's note turned the work to diagnosis (the names and IDs are made up; it is not
a live model's output). The findings are in the worker's context, so they are only
cited; the operator's chat instruction reaches the coordinator's turn alone, so
it is the one thing quoted:

```json
{
  "targetRole": "implementer",
  "prompt": "Objective: the migration suite finishes on the candidate.\n\nDiagnostic step before another change. `migration-suite` timed out at 900 s with no output on this revision, as on the previous one (checks.latest.retrySkipped, failed-same-way). Identify the process that blocks it and measure where the 900 s go. Report what you ran and measured, then change only what the measurement supports, in this turn. Do not raise the timeout or add retries as a guess.\n\nOpen findings: auditor-1-rpc-call-unbounded and auditor-1-lock-order. Address both by ID.\n\nNot in your context, from the operator: \"the staging database is shared, do not drop it between drives\".\n\nEvidence needed next: the measurement, and the check you ran for migrations-complete.",
  "rationale": "Second identical timeout on consecutive revisions: another guess would repeat the last round.",
  "windowDecision": "keep"
}
```

## Autonomous runs

A run finishes without a person, or does not start
(execution-contract.md "Asking the owner before any work starts"). Every triage records
`autonomy.verdict`: `autonomous`, `needs-owner-input` (at most five questions in
the owner's terms, each with a recommendation) or `too-large` (a proposed split).
Anything but `autonomous` ends the run after triage (`to: ask-owner`), so nothing
stays live for it; the owner answers on the issue page, and the answers start a fresh run
or the split becomes new issues. During a run the coordinator decides technical
choices itself and records them as `assumptions`; `operatorRequest` remains for
live-checkout work, a stop the issue itself asked for or a question a plan or an
audit addresses to the owner on access, security or a documented promise
(`owner-gate`), authorization and verified requirement conflicts, one question
with a recommendation. A seat states such a question in `ownerHolds`, and the
engine asks it before implementation, whatever the coordinator wrote
(execution-contract.md "Owner holds").

## Proportional scope

Implementation and Plan and implement size the work to the request (a one-line
title fix once grew a new module, plugin, fake router and selftest, then ended
unresolved on a test run it could never perform).
Orientation writes a few criteria stating the requested behavior; it adds no
test or coverage criterion unless the human asked for one or a named risk
(data loss, security, a reported regression) needs it, and every criterion must
be establishable inside the run. A small change is called small in the first
handoff, which asks for the smallest change in the existing code's own idiom and
prescribes no report format. The implementer does not restructure code for
testability or build scratch stand-ins for a running application, and reports
in a few sentences.

At confirmation, a criterion supported by the change and by the checks that can
run here is met. Verification that needs a running application, browser, suite or
deployment the run cannot reach is recorded once as a residual risk *pending live
verification* (`accepted: false`): it does not block the run's closure and
delivery, and it does keep `resolved` from being set until an operator has looked.
Only contradicting evidence or missing work makes a criterion unmet.

## Source and evidence window

New tactics default to `workspace.base: working-tree`. Project, playbook and run
base overrides still apply. Source is isolated using the existing snapshot and
symlink policy. Release packaging additionally rejects external source symlinks;
materialize them before staging. Dependencies, secrets, business data and entire log histories are
not blindly copied. Deployment workers receive the staged source archive instead
of a new development checkout.

Human input files and attachments are copied at startup, prioritizing
`000-report/response.md`, then newest notes before their attachments. Known agent-turn
folders and other unclassified `response.md` files are excluded. Published findings and recorded
external reports retain their provenance and remain inputs to the issue they create. Default aggregate limits are
100 files and 25 MiB, with a 25 MiB per-file limit; the manifest records copied bytes,
files, exclusions and omissions. Configure `windowLimits.maxInputFiles`,
`maxInputBytes`, and `maxInputFileBytes` in project YAML.

Prompts include the window summary and manifest path, plus the latest report from
each seat/phase/step. Worker views retain up to 24 reports;
`windowLimits.maxPromptChars` controls their report-body budget (default 60,000
characters). Coordinator views retain every latest structured worker output without
clipping. Metadata and the current brief are additional. Truncated worker reports
name their durable full JSON evidence file. The full
issue catalogue and copied input catalogue remain in the manifest instead of being
repeated in every prompt. Configure bounded log
captures in a project's YAML:

```yaml
evidence:
  - name: stage-application
    path: /opt/staging.app.example/runtime/log/current/project.log
    maxBytes: 262144
    required: false
workspace:
  retention:
    completed: delete       # or retain
    unsuccessful: retain
```

With no explicit `evidence` list, configured infrastructure diagnostic file paths
are attempted through local mounts. Remote-only paths are recorded as unavailable;
configure a local log export or mount when those logs must be in the starting
window. An explicit empty list disables capture. Required capture failures prevent
startup. Captures include time, original path, size, truncation and content hash.
They live under `runs/<id>/evidence/<window-id>/`, outside deliverable source.

The coordinator owns the window. A handoff, disposition or closing confirmation may choose `windowDecision: keep`,
`refresh-evidence`, or `restart-required`. Refresh captures logs again, preserves
source/unfinished code, invalidates previous conclusions and repeats all occupied
seats. Another evidence refresh is ignored until a worker has returned a valid
report; this guard survives resume and prevents coordinator-only reset loops.
Previous worker reports remain explicitly historical context until replaced by
new reports from those seats, and cannot count as current approvals. Failed
candidate checks need a correction or check refresh, not a log-window reset.
Source refresh stops with `coordinator-requested-source-refresh`; start a
new run to choose a new source snapshot. Nothing silently overwrites unfinished
work. Reports explicitly state their recorded coverage rather than claiming to
describe subsequent live changes. Older windows remain evidence.

On successful completion the supervisor removes the temporary source and scratch
space once the source is unchanged or delivery reconstruction proves the changed
candidate is preserved. Reports, inputs, log captures, issues, release archives
and operation receipts remain durable. Failed, cancelled, paused, undelivered and
quarantined work is retained for recovery. `completed: retain` opts out of successful
workspace deletion. No automatic age-based deletion of unfinished work is enabled.

## Analysis and Triage issues

Triage has one workflow: coordinator brief → two investigator seats at once, each
returning a disposition and a size. The
coordinator receives supplied issue/window context and returns a handoff of at most
800 characters. Its CLI runs from its scratch directory with built-in tools,
shell, MCP and inherited tool configuration disabled using the adapters' existing
tool-free mode. It does not inspect source, reproduce claims or create implementation
criteria. Each investigator receives the original report/window plus the brief,
performs the evidence gathering necessary for the claim, and returns the final result.
There is no coordinator re-investigation, synthesis or confirmation turn.

Investigation must be proportional to the claim. Trace relevant code and use targeted
checks when needed to establish or disprove it; stop once there is enough evidence
for a disposition. Fix design, unrelated defects and general test suites are outside
triage. A specific missing fact produces needs-information, naming the question and
next check. It never automatically launches another investigation.

Every seat has at most one formatting repair. The coordinator and the investigators
run at low reasoning effort. The five-minute run deadline and six-turn allowance
(brief, two investigators, repairs) are runaway guards, not work targets. Token and
known-cost allowances stop additional calls after 120,000 provider-accounted tokens
or $1; the final invocation can exceed those allowances. The output contract bounds
response length and finding count, and the investigator result is shown directly.
Accepted reports link the current issue; duplicates link the existing issue.
Implementation criteria belong to the follow-up fix, not to triage completion.

Triage and Analysis complete on a validated, published disposition in the current evidence
window (`reportDispositionRecorded`). This condition is restricted to read-only
assessment with no candidate delivery. Completing the run does not resolve or archive
the issue. Older snapshots retain their original closure rules and status; the UI
explains the historical implementation-criteria mismatch without changing records.
The result shows the verdict, brief explanation, elapsed time and reported cost,
with technical details and logs collapsed.

Investigators return evidence and proposed issues. The coordinator returns a
`reportDisposition`; the engine creates or links issues in the source project.
Each issue carries bug/feature classification, acceptance criteria, source issue,
run and stable finding identity. Publication is replay-safe and adds evidence
through the shared step reservation format. The coordinator receives the issue
catalogue to identify existing reports and avoid semantic duplicates.

### Two-seat sizing

The investigate phase has two seats: `investigator` (Opus 5.5, low) and the optional
`investigator-2` (GPT-6.1 Sol, low). Their steps are marked `concurrent: true`, so
they run at the same time, like the reviewers of a consensus round; the brief goes
to both and neither reads the other. Besides its disposition, each seat records an
order-of-magnitude sizing, not a design: `size` (`minor`, one write and one
hand-over, or `major`, it needs a plan), one sentence of reason (`sizeReason`), and,
for a Boilerplate project, `affectedModules` as `<collection>/<module>` paths
(framework and application modules alike). Each also gives an `autonomy` verdict
(the shape of `triageResult.autonomy`): `autonomous` only for an accepted report;
every other disposition is `needs-owner-input` with the one question the owner
must answer, and the engine treats `autonomous` on any other disposition as a
contract violation (protocol repair).

The run records one decision, `reportDisposition.sizing`, once every occupied
seat has a valid disposition (`runtime/triage-sizing.mjs`):

- **Disagreement reads as Major**: the size is `minor` only when both seats say
  minor; any disagreement records `major`.
- **Modules are the union** of both seats' lists, in order of first appearance,
  primary seat first.
- The **autonomy verdict is the most restrictive** of the seats' (too-large, then
  needs-owner-input, then autonomous).
- **`recommendedPlaybook`** is `prompt` for Minor and `plan-and-implement` for Major.

The disposition, its published issues and `byStep` stay the primary
investigator's; the second seat's output is recorded beside it and publishes
nothing. With `investigator-2` left empty, the one seat sizes alone.

The decision is persisted on the issue as `issue.json` `sizing` (size, modules,
recommended playbook, verdict and each seat's role, model, size and sentence),
keyed by the run and step that produced it; a later triage replaces it. Every
later run of the issue reads it: the run's window freezes it at capture
(`window.json` `sizing`) and the window summary every step sees carries `sizing`
and `affectedModules`; a step may also name the `sizing` context ref. The issue
page shows it under Size with a Start button for the recommendation, and the
supervisor's issue summary carries it.

### Routing: autoStart

`runOptions.autoStart` (triage only; left out of the configHash because it does
not change the run) is on by default when an operator chooses Triage in the
issue page's run dialog ("Start the recommended playbook when triage finishes")
and when the top-level supervisor previews a triage, unless either turns it off.
When such a triage closes (`completed`) with the verdict `autonomous`, the panel
starts the recommended playbook on the same issue (`server/auto-start.mjs`): Prompt
for a Minor issue, Plan and implement for a Major one. Those are the only
conditions; a duplicate or rejected report is held back by its seats' own verdict.
The start passes, in order, the shared start admission (`server/start-admission.mjs`:
open dependencies, and report trust, so an assess-only report is never escalated
to a writing playbook), then, for a triage the supervisor started, its start gate
(session limits, spending windows, concurrency, ledger reservation, ownership),
and finally the run supervisor's own admission. What happened (the started run,
or the refusal and who refused) is written once to `runs/<triage run>/auto-start.json`
and shown on the run; it is never retried. With autoStart off, a non-autonomous
verdict, or a refusal, nothing starts and the recommendation stays on offer.

Rejected and insufficient-information reports create no issues. The stored
response is shown in the issue page. Insufficient information should produce a
specific clarification question; lack of reproduction alone is not rejection.
No external response is sent and no automatic report-ingestion integration is
installed. Human, model and automated reports can already be supplied as ordinary
issue input.

## Prompt

`prompt` is the single-seat playbook for tasks that do not need coordination:
no coordinator, no plan, no audit. The one `worker` seat receives the issue, the
captured-input excerpts and the window manifest, so every attached file is in
reach, and does the work directly in the isolated candidate in one turn (one
formatting repair at most). The candidate is fingerprinted and delivered exactly
as in the coordinated playbooks, so the result is a verified patch, or the live
checkout when the run is started in place. Nobody reviews it, so the seat's own
outcome is the gate: it returns `singleSeatResult` with `completed` and, when
false, the blockers that stopped it, and closure requires that completion, no
failed check, no outstanding blocking findings and delivery. An unfinished task
blocks as `task-incomplete` and delivers nothing; closure records review-only
with that justification. The worker's summary is the entire report. Its step names the `sizing` context
ref, so the worker is told the issue's triage size and affected modules and that
a Minor issue is one write and one hand-over; checks and delivery are unchanged.
Use it for
small, well-specified changes; anything that needs a plan or a second opinion
belongs in Implementation.

## Refactoring

`refactoring` reuses the Plan and implement strategy with a refactoring intent,
not a duplicated phase interpreter. A planner owns the redesign and implementation;
one independent auditor is occupied by default and more may be assigned. The
coordinator defines scope and routes reports, not the architecture.

The objective is less unnecessary code, clearer responsibilities and interfaces,
readable control flow and robust structure while preserving all requested behavior.
The planner inventories observable APIs, defaults, errors, side effects, ordering,
data formats and relevant security/performance properties. It proposes the smallest
coherent redesign and focused before/after checks. Characterization tests are added
only for material untested behavior; existing tests must not be weakened.

Deletion needs evidence that the path is unused, including dynamic/configured entry
points. Smaller line counts alone do not establish improvement: code-golf, speculative
abstractions, new frameworks and unrelated fixes are not the goal. Compatibility
or functional changes require a separate decision. Plan and candidate audits check
both simplification and preserved behavior against the exact artifact; missing
verification is reported honestly, never treated as a passed check.

## Configuring releases

Before mutation, the release operator examines the configured procedure and target read-only. The coordinator must return an explicit release decision, and blocking preparation findings or open questions prevent execution. Operators and verifiers return `releaseAssessment` with a verdict, severity and blocking status per finding, plus observations. Minor nonblocking findings do not cause recovery. Superseded malformed attempts and operator answer steps are not release assessments.

A release target is opt-in. Existing `stagingDeployment` scripts do not constitute
a reversible release configuration. Under `infrastructure.release.targets`, key
entries by the existing staging/deployment environment IDs:

```yaml
release:
  targets:
    staging:
      workdir: /opt/operator-release-tools
      ownership: >-
        Sync release-owned application files and remove obsolete application
        files. Preserve instance secrets, configuration, uploads and database data.
      rollback: automatic  # or manual (stop and require recovery)
      commands:
        inspect:          { run: './release.sh inspect', timeoutSeconds: 60 }
        checkpoint:       { run: './release.sh checkpoint', timeoutSeconds: 300 }
        verifyCheckpoint: { run: './release.sh verify-checkpoint', timeoutSeconds: 300 }
        apply:            { run: './release.sh apply', timeoutSeconds: 900 }
        verifyRelease:    { run: './release.sh verify-release', timeoutSeconds: 120 }
        restart:          { run: './release.sh restart', timeoutSeconds: 120 }
        observe:          { run: './release.sh observe', timeoutSeconds: 240 }
        test:             { run: './release.sh test', timeoutSeconds: 600 }
        restore:          { run: './release.sh restore', timeoutSeconds: 600 }
        verifyRestore:    { run: './release.sh verify-restore', timeoutSeconds: 300 }
```

These are **illustrative operator commands**, not bundled scripts. If the release operator must read installed procedure files outside the source snapshot, declare their directory in `workspace.tooling.allowedRoots` in the project YAML; these are read-only roots, not additional authoring directories. Every phase is
required. Commands run on the authoring host in the configured workdir and may SSH
into the declared container using installed credentials. Models cannot substitute
shell text, command paths or destinations. Commands receive:

- `DEVPANEL_RELEASE_ID`, `DEVPANEL_RELEASE_ENVIRONMENT`
- `DEVPANEL_RELEASE_ARCHIVE`, `DEVPANEL_RELEASE_SHA256`
- `DEVPANEL_RELEASE_STATE_DIR`, `DEVPANEL_RELEASE_STARTED_AT`

`checkpoint` must capture all state needed for reversal, including relevant package
and configuration state and a consistent database checkpoint. `verifyCheckpoint`
must verify that checkpoint can be restored. `apply` consumes the exact archive,
syncs/removes only owned paths, installs required dependencies and performs declared
migrations. `verifyRelease` must verify the target's installed source against the
archive identity. `observe` captures the relevant startup log window. `test` runs
the appropriate environment-specific checks; production tests must be safe for
production data. An exit status of zero is the command's explicit success contract;
the engine cannot prove a backup or remote release correct independently of the
installed verification procedure.

A Git commit alone is not a data rollback. A restore that discards writes made
after deployment may be unacceptable; configure maintenance/draining or a suitable
forward-recovery procedure as part of the project's commands and policy.

Command logs are retained under `runs/<id>/evidence/release/`; agents receive bounded excerpts and paths to read the full captured logs.

The engine records intent before each operation, bounds output and time, and
refuses to replay failed or interrupted mutations. It shares the legacy staging
operation lock and excludes concurrent project actions. Once application mutation begins, failures invoke `restore` and
`verifyRestore` under automatic policy; manual policy or failed recovery leaves
`recovery-required`. Concerns from release verifiers or coordinator rejection also
invoke that recovery policy. Successful rollback still leaves the release run
unresolved. Inspect the durable receipt before any manual retry.

Deployment requires `runOptions.releaseId` (the successful staging run ID) and
must choose `runOptions.environment` when several deployment targets exist. A sole configured target may be selected automatically. It finds
the receipt only inside the same project, requires the staging run and every
verification seat to have completed successfully, verifies the retained archive's
hash and promotes those exact bytes. Newer development files never enter that
promotion. Run deployment separately for each production container as needed.

An installation wires its targets to its own installed
[release procedures](../tools/releases/README.md). A thorough procedure
cold-checkpoints instance files and database state, rehearses restoration,
installs only the selected source and locked npm dependencies, and verifies
startup/tests; staging recovery can be automatic while production recovery stays
manual to protect subsequent customer writes. The target settings are in
`host-config/releases/<site>-targets.json`. Configuration and read-only
inspections do not deploy either instance.
