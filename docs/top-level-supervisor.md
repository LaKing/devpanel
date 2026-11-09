# Top-level supervisor

The supervisor is devpanel's **management plane**. Coordinators and their agents are
the execution plane. Its charter is fixed in the prompt and no operator message
replaces it:

> Maintain a company-wide overview of projects, issues, priorities, playbooks,
> models and delegated work. Take management actions only; delegate technical
> execution to scoped coordinators through issues and playbooks.

Messages set objectives and campaigns *within* that charter. They do not redefine
the role, and they confer no capability the action vocabulary lacks.

| Capability | Supervisor |
|---|---|
| See projects, issues, run history, costs, outcomes | Every project |
| Create issues and set their priority | Every project |
| Choose playbooks, seats, models, budgets | Yes |
| Start, monitor, answer, stop and assess runs | Yes |
| Edit source or operate Git | **No** — no such action exists |
| Implement or test anything | **No** |
| Archive or disposition an issue | Yes, with recorded evidence |
| Deploy or change shared infrastructure | Only through a release playbook and its checkpoints |

## Visibility is not a permission

Project scope used to do two unrelated jobs: deciding what the supervisor could
**see**, and deciding where it could **spend**. Coupling them is what made it
report partial truths as facts — asked about a project outside its selection it
said the work did not exist, because from where it stood it did not.

Visibility is now panel-wide and unconditional. `projects` in every prompt is
every project on the panel; a named project is checked for *existence* only, and
an unknown one is a 404, not a refusal. Safety is carried by the capabilities
themselves: budgets, concurrency, per-issue retry caps, archive policy, and an
action vocabulary with no direct checkout command. There is a deliberate indirect
write capability: starting Implementation, Plan and implement, Refactoring or Prompt
with `apply-to-source` authorizes the engine to apply the approved patch to the
destination shown in readiness/preview and verify it before resolution. Select
`worktree-diff` for patch-only delivery. Changed files under materialized symlinks are dispatched to their bound Git-owner
checkouts, preserving links, indexes and history. Source drift or an unbound owner
blocks application; finalize can retry retained approved work after correction.
When the drift reached the approved patch's own paths, `reconcile_delivery_run
{project, issueId, runId}` (a run it owns whose `actions` include
`reconcile-delivery`) has the engine merge that patch three-way onto the current
source, revalidate the merged candidate with the run's configured checks, carry
the approvals (`reconciledFrom`) and deliver it — the same bounded authority,
not a new one. The only automatic conflict resolution is the project's declared
`workspace.reconcile` `append` paths (source kept, candidate's added lines
appended); any other conflict, a changed reviewed delta or failed checks leave
the run blocked with the paths in `run.reconciliations`, and a new run of the
issue still starts from the approved patch (execution-contract.md "Reconciling
a delivery with drifted source"). A run reading `reconcilePending: true` has an
automatic reconcile undecided: monitoring holds its wake until the decision
arrives as an ordinary `run-changed`, and a run record that cannot be read is
a monitoring fault that is retried (`getRun` answers 503, not 404).
This authority does not include committing, running arbitrary scripts, or deploying.

Shared staging is a separate action. Where a project's infrastructure enables
`stagingDeployment`, `deploy_staging {project, issueId}` runs the saved operator
commands outside agent sandboxes, and the supervisor uses it on its own judgement
whenever deploying moves work forward: a delivered fix that test drives or live
verification need, a stale or broken staging instance, or a user request. It deploys
the project's live checkout as it stands, uncommitted deliveries included. The engine
records the delivered runs it may have carried as unproven and notes their issues; the
supervisor's own note is its assessment of the recorded logs. A deployment never
clears the staging pending list: only a staging release (a Deployment run in the
staging environment) does. Production is never deployed without an explicit operator instruction;
production environments stay inspection-only.

`overview` gives each project `stagingPending`, the list of `GET
/api/projects/:project/staging-pending`: runs delivered into the development checkout
that no successful staging release has covered. When to cut a batch: `batch.ready` is true,
meaning the `pending` list is non-empty, no delivery is in progress (`liveRuns` is
empty) and a staging release target is configured. The supervisor or the operator
decides, and the supervisor cuts it by previewing and starting (`start_run`) the deployment
playbook with `runOptions.environment: staging` (its default); the engine never starts a release, and no agent inside a run decides it.
`indeterminate` runs are read by a person and prompt no batch. Deliveries from before the
coverage baseline are history: one number (`history.count`), in neither list and in no
note, so they never prompt a batch. A red release is noted on
every issue it carried, and which one gets the follow-up is the supervisor's or the
operator's choice. See [Shared staging deployment](staging-deployment.md#what-a-release-covers).

`focus` is what the operator asked to be attended to first. It orders the
overview and nothing else; an empty focus means the whole panel. If per-tenant or
per-repository access control is ever needed, that belongs in an organisation-level
authorisation policy, not in an activation setting.

`campaign` (`{projects, leaveReporters}`) decides wakes and what the ready queue lists,
and only those: an issue-list change it places outside waits for the next wake, without
a provider (docs/decisions.md "Wake filter"), and its issues are counted rather than
listed in the queue ("The ready queue"). It takes nothing out of sight: the supervisor
still sees every project and can act on any issue. An operator sets it on the Supervisor page
at any time, since Stop would also stop owned runs; it is sent in every prompt and
survives Start and New session, and the model has no action to change it. A campaign
given only as chat text is not declared: those changes wake unless the provider
confidently judges them outside.

Open **Supervisor** in the application navigation. Select a verified Claude- or Codex-backed
model, optionally a focus, set limits, and give it an objective.
The model picker includes unverified roster entries with an explicit label and
an explanation. They can be selected for inspection, but Start remains disabled;
the server independently refuses them before a model call is made.
Starting invokes the model; previewing the page never does. Model calls have a
120-second deadline. Every limit has one scope:

| Limit | Default | Scope | Reset behavior |
| --- | --- | --- | --- |
| `maxCalls` | 2000 | Model-call attempts in this session, including action-result and repair turns | Start and a server restart resume the count; New session resets it |
| `maxStartsPerIssue` | 20 | Launch attempts for each project/issue pair in this session; failed launches count, a start refused for momentary occupancy does not | Start, server restart and model/scope changes resume the count; New session resets it |
| `maxRuns` | 200 | Launch attempts across every issue in this session, with the same exception | Start and a server restart resume the count; New session resets it |
| `maxConcurrent` | 3 | Live owned runs **plus unresolved launch reservations** | Capacity is released only by a known terminal run or an attributed non-start |

These are **session limits**, and the session boundary is explicit: only an
operator's New session begins a fresh allowance. Start and a process restart
resume the existing one, so nothing automatic can replenish it; the model has no
reset action of its own. What earlier sessions used is kept in `history`
(sessions, starts, starts by issue, calls) as accounting that decides nothing.
Spending over calendar time is a different question and is bounded by the
spending policy's daily and monthly windows, which continue across sessions.
Omitting limits on Start retains saved caps. An operator may explicitly increase
a numeric cap to grant more allowance; changing the cap does not reset usage.
Lowering a cap below usage prevents further starts without cancelling existing
work.

**There is no activation time limit.** A `minutes` limit sent by an older client
is ignored; other unknown limits are rejected. Owned issue runs keep their own
playbook budgets. Reported supervisor cost belongs to the current conversation;
New session archives it, and missing costs remain unknown. Issue-run spending is
recorded on those runs.

Concurrency defaults to three, and may mean several issues of one project: the
invariant is one live run per issue, including preflight and stopping. The resources
those runs share have their own guards: deliveries and base snapshots take turns on
each repository's delivery lock, and remote test drives wait for a slot per staging
host (`testDrive.maxConcurrentDrives`). The panel server refuses a run beside a live
in-place run, or a staging or deployment run beside another of its project
(execution-contract.md "Locking"). This covers both browser and supervisor launches
within that server; standalone engine callers are not coordinated by it.
Model calls count supervisor turns, including processing action results.
Run starts count launch attempts, including retries, rather than distinct issues.

The supervisor has one persistent native session and chat history across issues.

### Instruct, ask, and its questions to the operator

The supervisor page sends two kinds of message:

- **Instruct** (`POST /api/supervisor/messages`) goes into the session the supervisor works
  from. During a call it is queued, and the supervisor reads it right after that call's own
  action result: a call's tool result goes to the front of the queue, so a message or a wake
  that arrived meanwhile never takes its place and later results are never read a call late.
- **Ask** (`POST /api/supervisor/ask`, 202) is answered in a *fork* of that native session
  (adapters' `fork: true`). It is one tool-free call, and no action is executed from the
  reply, so the working session never sees the question. It may be asked while the
  supervisor works, or while it is stopped if a session exists, one question at a time. The
  question and answer are kept in the chat, marked `side`, and left out of the history a
  new session is seeded with. The call goes on the spending ledger (`subject: model-call`,
  `meta.side`). It is not one of the supervisor's own calls, so `maxCalls` does not count it.

Every call's streamed output is written to `issues/.supervisor/live/<invocationId>.jsonl`
before it is announced on `supervisor:live`, and `GET /api/supervisor/live/:invocationId`
serves it. The page shows the working call's reasoning there, and each reply has a
*Reasoning* toggle. Claude sessions request thinking summaries.

The supervisor decides for itself first. A choice between technical routes (which
layer or project to fix, which playbook, model or effort, what order, whether to
deploy shared staging) is its own: it takes the route the evidence supports, records
the decision and its reason with `add_note` on the issue, and carries on; when two
routes are both sound and cheap it takes both. A question stops every piece of work
that depends on it until a person reads it, which can be hours, so only these are
reserved to the operator: a production deployment, deleting data or anything else
irreversible, changing the agreed rules or the supervisor's limits, and the owner's
questions (a triage `ownerInput`, an `owner-gate` or `requirement-conflict` pause).
While a reserved question is open, the supervisor keeps doing everything that does
not depend on it: other issues, other projects, and the parts of the same work the
answer cannot change.

A reserved decision is recorded with
`ask_operator {question, project?, issueId?, options?}`, with the supervisor's
recommendation in it, instead of leaving it as prose.
Open questions (`GET /api/supervisor/questions`) appear first in Needs attention, on the
named issue's page and above the supervisor's composer. Each can be answered in any of
those places through `POST /api/supervisor/questions/:id/answer {answer, actor}`. A closed
question accepts exactly one of its options. The answer is queued as an
`operator-answer {questionId, question, answer, actor}` event, so it reaches the
supervisor even if it was stopped when the answer was given; it reads the answer when it
next runs. Open questions belong to the session: New session archives them with it.
It accepts chat while a turn is working, wakes when owned runs or the scoped issue queue change, and
continues without an open browser. A response with no action waits for events
rather than polling the model. The server polls run state without spending.
Each owned run is observed on its own: a run that cannot be read is reported
once and tried again, and never stops the others or the issue scan. A packed
issue's runs are read from its bundle, so packing between two polls is an
ordinary ending (status and cost). A run whose record is gone (deleted) leaves
monitoring; if it was last seen live, a `run-unreadable` event wakes the
supervisor to read the issue instead.
The poll compares a delivery reading as well as the status (`deliveryReading`:
the latest reconcile that ended, the landing, the delivery's application or
merge) and a progress reading (`progressReading`: phase and round, the latest
drive's checks verdict, the blocked reason), and `run-changed` says in `changed`
which of `status`, `reconcile`, `landing`, `delivery`, `phase`, `checks` and
`blockedReason` moved. So a refused reconcile or a landing wakes the supervisor
although the run's status stays the same, and the wake filter never holds it. A
reconcile still `merging` is not a change: one decision, one wake. A run with no
stored reading takes its present one as the baseline without waking, and a packed
run's reading carries the delivery fields; it has no phase or verdict to compare.

The event carries the run as a compact delta (`runDelta`), not the whole run:
status, outcome, result, phase, checks (`{revision, result, gating, tier, at}`),
blockedReason, actions, `from` (what the moved fields were), and, when the run has
them, what the model acts on or relays without another read: pause (with the id
`answer_run` copies), failure, ownerInput, acceptCheck and its request or refusal,
reconciliation, landed, delivery, integration, recovery, the latest substitution.
Steps, metrics, budgets and diagnostics are `get_run`'s, which is needed only for
detail. `model-substituted` carries the same delta.

A live run's progress wakes nobody: a phase, a checks verdict or a status moving
between live statuses decides nothing the engine is not already handling (a failed
check goes back to the author). It is not put to the provider and starts no timer;
it is merged per run in `state.deferred` (`progress: true`, the earliest `from` of
each field and the newest reading) and rides with the next wake. An event that does
wake for that run outdates the entry, which is dropped.
Stopping aborts the supervisor and its owned issue runs, waits for termination,
and retains conversation history. A normal Start with the same model continues the same session. Changing models
while stopped creates a new native session seeded with the recent conversation;
the full chat and previous native session identities remain stored.
A server restart retains history but requires an explicit Start; an interrupted
operation is marked recovery-required and is not replayed. Recovery of ambiguous
operations currently requires operator investigation; there is no generic Resume
that could duplicate an issue-run launch.

`answer_run {project, issueId, runId, answer, pauseId}` answers the question a paused
owned run asked, with `pauseId` copied from that inspected run’s `pause.id`.
Missing or stale IDs are refused. A closed question accepts only one of its options, and the
supervisor is told to decide from evidence it has read, to read more (`get_step`,
`get_check_log`, an inquiry) when that is not enough, and to ask the user only for a
reserved decision. The answer is recorded on the run as an operator step attributed to the
supervisor. A request whose `pause.request.category` is `owner-gate` or
`requirement-conflict` is the user's decision: the supervisor relays the question and
recommendation and answers only with what the user said; that includes an owner hold
(`pause.kind: 'owner-hold'`, execution-contract.md "Owner holds"). An `authorization` request
is the supervisor's when it asks for something within its own authority (shared
staging, a technical route), and the user's when it asks for a reserved decision.

A run that ended with `ownerInput` (triage judged one run could not finish the
issue without its owner; execution-contract.md "Asking the owner before any work starts") has no
supervisor action at all. The supervisor sees the questions or the proposed split
in the run summary, tells the user, and does not restart that issue: the owner's
answer on the issue page starts the next run itself.

Two further actions: `set_disposition {project, issueId, value, evidence,
runId?, related?, acceptRisks?}` records the issue's state with evidence
(`resolved` is refused while the named run left residual risks unaccepted;
`get_issue` lists them under `issue.unacceptedRisks` beforehand, and the
supervisor either accepts each in the same call with `acceptRisks: [{id | text,
reason}]`, recorded with `by: supervisor`, or records `partially-resolved` and
lists them in the evidence; it has no override); `finish {}` ends the
activation gracefully. `create_followups` is refused to the supervisor: opening
follow-ups on every closure grew issues faster than the work they tracked (51
of 85 issues by 2026-10-24), so follow-up issues are the operator's, from the
issue page. A residual risk that is a correctness or security defect goes to
`ask_operator` with a recommendation. Archiving is refused until a
disposition exists.

`mark_landed {project, issueId, runId, applied, handChanges, commit?, checkout?,
landedAt?}` records that a person landed a settled run's work by hand (the same
record as `POST …/runs/:runId/landed`, with `by: supervisor`): what was applied,
the commit hash or checkout path it went to (one is required), when, and what was
changed beyond the patch (`"none"` when nothing). It is a claim the supervisor
makes only on the operator's word or evidence it can quote, never inferred from
the source repository. The run then reads `delivered` / `manual-landing` and the
overview counts it under `delivered.manual`; outcome, closure and approvals are
unchanged. It is refused for live or paused runs, runs without a candidate, runs
the engine already delivered to the source, and a second claim.

**Finishing** is the opposite of Stop: no further starts, owned runs are left
to complete on their own budgets, and the activation moves to `stopped` with
reason `finished` once none is live and nothing is queued. The model's "I am
done" and the activation's state then agree; a Stop still cancels everything.
`POST /api/supervisor/finish` and the panel's Finish button do the same.

**New session** (`POST /api/supervisor/reset`, the panel's New session button)
starts a fresh conversation, a fresh native session and **fresh session limits**:
model calls, run starts, starts by issue and the failed-launch guards begin again
from zero. It archives the old conversation and clears the cost display and any
pending conversation operation. What the old session used is added to `history`.

A fresh session is what the button promises, and it is an operator's decision:
the model cannot press it. A failed launch guarded within the old session may
therefore be attempted once more after a deliberate New session; if it fails again
it is guarded again for the rest of the new one. Money is not session state: the
daily and monthly spending windows live in the ledger and are untouched.

What it keeps is **ownership of anything still open** — a live run, a paused one
waiting on an answer, an unreconciled reservation — so New session is never a way
to orphan a run.

What it does **not** keep is settled work. Runs that reached a terminal state, and
launch attempts already retired, move into the archive rather than into the new
session. A run that finished days ago is history, not a responsibility, and
carrying it forward leaves the supervisor reading its own list as current
business — eight completed runs from last week are not eight things to attend to.
The history stays in `state.<timestamp>.json` and in the accounting, which is
where history belongs. The notice says how many were retired.

It is refused while the supervisor is live; Stop first. State is archived next to
`state.json`, and the last settings remain available for the next Start.

Launch admission is serialized. It checks the session caps, the spending windows
where a policy is active, and the source condition, then atomically saves a
reservation and increments session/per-issue usage before calling the run service. The reservation already occupies a concurrent slot while
that call is pending. A returned run takes over the slot. A definite non-start
releases concurrency but remains charged as an attempt. An uncertain result or a
crash between reservation and receipt keeps the slot reserved; it is not replayed.
The service's existing exclusive owner lock prevents another process from admitting
launches against the same state directory.

The source checkout is inspected again before launch. A `head` base with tracked
modifications is refused before launch/preflight, even with a new preview ID or
changed model/budget. Clean the checkout or explicitly choose another base policy.
Known failed/blocked launches are also remembered by project/issue and launch input
state (resolved configuration and relevant source state). Unchanged inputs cannot
be retried across activations of the same session; New session permits one more
attempt. A new preview ID alone changes nothing. Admission refusals do not spend
another attempt; reaching the external launch service does.

Two authenticated, operator-only recovery endpoints are deliberately absent from
the model's action interface. Stop the supervisor before using them:

- `POST /api/supervisor/launches/reconcile` accepts `launchId`, `reason` containing
  investigation evidence, and either `runId` or `notStarted: true`. It attributes
  a resulting run or confirms non-start. New runs persist `supervisorLaunchId`;
  attributing a receipt requires that identifier to match the reservation.
  It never refunds session/per-issue usage.
- `POST /api/supervisor/launches/retry` accepts `launchId` and `reason` documenting
  an external repair not reflected in configuration/source hashes (for example,
  a repaired service). It clears that failed-input guard, but still refuses a
  currently dirty/unreadable checkout and does not widen any cap. The next attempt
  remains charged. Uncertain launches must be reconciled first.

If the interrupted conversation is marked `recovery-required`, use New session
after reconciliation to retire its pending operation before starting again. The
spending ledger and its windows remain in force; the session limits begin afresh.

Old state is migrated once, combining retained ownership with archived sessions
and the counters still present. This recovers the reported four owned runs even
when the last activation counter says two. Historical failed attempts erased from
both counters and ownership cannot be reconstructed; the migration records that
limitation instead of claiming exact historical usage.

Model replies propose one action at a time. Server-side actions enforce project
scope, explicit preview/config-hash binding, budgets, and the archive permission.
The Claude invocation disables built-in tools, inherited MCP servers, settings,
and skills. The Codex invocation ignores user configuration, uses a read-only
sandbox with approval escalation denied, and disables shell execution, apps,
plugins, subagents, browser/computer tools and code execution features on both
initial and resumed turns. Its discovered session ID is saved for later turns. It does not receive the devpanel API token. Permanent deletion,
arbitrary shell execution, and editing playbook policy are not actions.
Issue text and lower-level agent responses are treated as evidence, not instructions
that can widen the supervisor's authority.

State is stored in `issues/.supervisor/state.json` with adapter ledgers alongside.
An exclusive process-identity lock protects it. State writes are atomic and ordered.
Messages retain exact model responses, prompts, action requests, results, and usage.
Replies may contain a single JSON response object surrounded by prose or a code
fence. Its envelope and action arguments are validated before execution; multiple
JSON values are rejected as ambiguous. An invalid reply gets one formatting-repair
turn in the same session, charged against the existing per-activation call limit. No
action from an invalid reply executes. A second invalid reply stops the supervisor,
with both raw responses and the validation errors retained in history.
The API and socket use the existing authenticated channel:

- `GET /api/supervisor` and `/api/supervisor/models`
- `POST /api/supervisor/start` — model, message, limits (`maxCalls`, `maxStartsPerIssue`, `maxRuns`, `maxConcurrent`), `allowArchive`, and an optional `focus` (project ids to attend to first; `projects` is still accepted as its old name)
- `POST /api/supervisor/messages` — text
- `POST /api/supervisor/campaign` — `campaign` (`{projects, leaveReporters}`, or null to clear), `actor`; any status
- `POST /api/supervisor/stop`
- `POST /api/supervisor/finish` and `POST /api/supervisor/reset`
- `supervisor:changed` socket event triggers rereading durable state.

What the supervisor is shown is a **summary**, never the panel's full view: a
run lists its steps with roles, verdicts, validity and usage, plus closure,
delivery verdict and diagnostics; `get_step {project, issueId, runId, step}`
returns one turn's full prompt, response and structured output; `get_file
{project, issueId, step, name}` returns an issue file in full; `get_issue`
clips reports to 6000 characters and says so; `preview` omits rendered prompt
bodies. A run-changed notification carries a smaller delta (`runDelta`). The first live
sessions handed the model 283 KB run views and prompts up to 490 KB; nothing is
hidden now, only deferred.

Every prompt carries `remaining`: authoritative counts and explicit scopes —
session calls, session starts, session starts per issue, and occupied concurrent
slots including reservations, with earlier sessions' usage under `history` as
accounting —
so the model never infers a budget from run history, and `replyFormat`
restating the envelope. A change the supervisor itself makes (a note, an
issue, an archive) is absorbed into the poller's last-observed state, so it
does not come back as an `issues-changed` wake-up; a change made by anyone
else still does. Its own reconcile or landing is absorbed the same way, its
action result having said so, and no `run-changed` follows for that alone.

Each playbook the supervisor is shown lists its `intents` and its default
`intent`. It chooses the playbook by shape and cost, and passes
`runOptions: { intent }` to `preview` for the kind of work at hand; the preview
hash binds the intent to the start.

A `get_run` result carries `diagnostics.protocol`: for every attempt whose
structured output was rejected, the classification (`no-structured-output`,
`contract-violation`, `ambiguous-output`), the validator's error and the number of
JSON candidates seen. The supervisor is instructed to read it before deciding, and
that a contract violation is the agent's, an unreadable-but-valid output would be
the engine's, and neither is fixed by a cheaper model or a smaller round cap. In
the first live session it spent its last run start retrying a run that had been
blocked by a parser defect.

`get_run` does not always return the record. Runs the supervisor owns are watched by
the panel and their changes arrive as events, and the charter tells it to end its turn
rather than re-read one. Should it read the same run again within one wake with nothing
changed, the answer is `{ unchanged: true, status, since, detail }`, whose `detail` says
`unchanged since <time>; you will be woken on change` (a run it does not own gets no
such promise, because nothing monitors it). Unchanged compares the whole run summary
except `active[].activity` (liveness) and `metrics.time` (derived from the clock), so a
new step, verdict, revision, check, delivery or reconcile always returns the full
record; so do the first read of a run in a wake, a read of another run (the next read
of the first is full again), a later wake, and a new native session within the wake.
An action between two reads does not reset it. Only this action is guarded: monitoring
and the start gate read full records through `tools.getRun`.

Automated tests use injected adapters or a scratch-server shim. They never start a
paid supervisor session.

Codex configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference

CLI lookup honors explicit `DEVPANEL_CLAUDE_BIN` / `DEVPANEL_CODEX_BIN` overrides,
then the service PATH, then the service user's `~/.local/bin`. A spawn failure
before the child starts is recorded as a launch attempt with zero model cost,
not an ambiguous paid call. The pending turn is moved to failure history and the
supervisor becomes stopped and retryable; no automatic retry is performed.

## What the supervisor is told it may choose

Two failures come from the same shape of omission: the supervisor is shown a
*default* and reads it as the *only* option.

**Seats.** Every prompt carries `seatModels`, the catalogue of models a run's
seats may be filled with — distinct from the models the supervisor itself runs
on, which is a different question with a different answer. A playbook's listed
participants are its *defaults*; `runOptions.participants` assigns any seat any
roster id, including a provider no playbook names, and the engine resolves it
like any other. Without the catalogue the supervisor sees only playbook defaults,
and one asked for a model it cannot see will refuse work it was able to do —
telling the user a model "is not available here" when the seat would have taken
it.

The catalogue is evidence, not labels:

| Field | Says |
|---|---|
| `verified` / `verification` | whether runtime access was ever proven, **when**, and by what method — so its freshness can be judged |
| `available` / `unavailable` | whether it is usable *now*, from the host-wide record of exhausted models, with when it is expected back |
| `contextWindow`, `efforts`, `defaultEffort` | capacity and the effort levels actually proven; `efforts: null` means none are, so no effort should be sent |
| `harness`, `profile` | the runtime it is reached through |
| `performance` | latest operator-triggered hello-world sample: startup, response and total milliseconds, status, timestamp, usage and configuration staleness |
| `notes` | the roster's own account of what it is and what about it is unmeasured |

Verified and available are deliberately separate: verified-and-unavailable is a
real state, and reading either as the other wastes a start. Where the roster
records nothing — such as price — nothing is claimed. Hello-world timings are
single fresh-session observations, not estimates for complex tasks. Use only
successful, non-stale samples, and consider their age. What a model has actually
*done* is measured rather than described: `overview.bySeat` groups every past run
by role and model with its outcomes, mean duration and known cost.

A user naming a model says it the short way a person does. The instruction is to
match what they said against ids *and* titles before concluding anything, and
never to substitute a different model silently — preview the assignment and say
which ids were used.

**Projects.** A name the supervisor cannot find among its issues is usually a
*project*, not a missing issue — so it checks `projects` first, and never reports
work as non-existent because it was looking in one place. See "Visibility is not a
permission" above.

## Reported issues: trust bounds what it may start

An issue opened through `POST /api/report/:project` carries `report: {kind, category, reporter, trust}`
(`gui/server/report.mjs`); its text was written outside the panel, by a deployment or by a person through an
assistant, and becomes an agent prompt once a run starts. `start_run` therefore asks
`reportStartRefusal` (`gui/server/reporters.mjs`) after the dependency check: `anonymous` (no reporter key)
allows nothing; a keyed reporter's `request` (a person relayed) allows its `request` level, by default
`assess` = `triage` or `analysis` only, so a feature request is never implemented automatically; its `fault`
(the framework's own error report) allows its `fault` level, by default `any`. The level is read from the
current reporter record at start time, so tightening a policy or removing a reporter applies to issues already
open, and a removed reporter counts as anonymous. The supervisor sees `report` on issue summaries and the rule
in its prompt; an operator starting from the panel is never bound by it. Pinned by `gui/test/reporters.test.mjs`.

## Project actions belong to operators

`checkpoint.sh` and the actions declared in `projects/<id>.yaml` act on the **live
checkout**. They are run from the project page by a person, and recorded under
`issues/<project>/.actions/`. The supervisor has no action for them: management
plane, not execution plane. An action may declare `effect: commit-checkout` to
state what it does rather than leave it inferred from its filename — see
`docs/project-infrastructure.md`, "What an action does is declared, never
inferred".

### Repository faults are delegated, not acted on

A start refused before a run exists carries `code` and `resolvableBy` — what
*could* clear it, never who may. `commit-action` means committing the checkout
would (`EMPTY_REPOSITORY`, `DIRTY_BASE`); `operator` means no configured action
can (`UNSAFE_REPOSITORY`, `NOT_A_REPOSITORY`, `UNREADABLE_REPOSITORY`).

Either way it is not the supervisor's to do. It opens an issue against that
project stating the fault, the evidence and the remedy, says what is blocked, and
does not start a run on that issue while the fault stands — the run would be
refused for the same reason and spend a start proving it. The same applies to a
run paused with `pause.request`: it answers with what is actually true, which is
that the work has not been done and what has been opened for it. An answer is
recorded as a step and later turns read it as fact.

Run participants cannot do this work either, and that is not arbitrary: their
workspace is an isolated worktree whose content *is* the revision's identity. A
participant that committed, or reached the live checkout, would change what the
fingerprint measures and what the patch rebuilds. Git work inside their own
worktree is theirs; git work on a live checkout belongs to a person, through the
panel's project actions.

> **Known gap.** No playbook can commit a live checkout, so "delegate it to a
> run" does not yet close every repository fault — an empty repository in
> particular cannot be fixed by any run, because no run can be cut from it. Until
> a release-style playbook covers checkout operations, these issues are opened
> for a person.

## Inquiries: a question without an issue ticket

The supervisor has no code access of its own. A technical question it needs
answered — one that takes reading source, logs or data — becomes an
**inquiry** (phase 4 of the seat-access fence):

- `inquire {project, question, relatedIssue?, runOptions?}` stores the question
  as an issue with `kind: "inquiry"` (the question is its report) and returns a
  bound preview of the **analysis** playbook with `runOptions.inquiry: true`
  frozen into the snapshot (part of `configHash`). `runOptions` may change seat
  models and efforts only (`participants`). `start_run {project, issueId:
  <inquiryId>, previewId}` starts it. `preview` refuses the flag; `start`
  refuses an inquiry on another playbook and the flag on an ordinary issue.
- **No side effects.** An inquiry run records its validated disposition, keeps
  the findings as `run.reportDisposition.proposals` and never calls
  `publishFindings`: no issue is created and nothing is appended to the
  related issue. `create_issue {project, input, fromInquiry: {inquiryId, runId,
  key}}` turns one proposal into an issue, at most once.
- **State** (`server/inquiry.mjs`, from the latest run, first row wins): running,
  waiting for an answer, needs recovery, answered (row 4), answered with
  needs-information (5, takes `acknowledge_inquiry`), unanswered (6), blocked (7),
  stopped (8), failed (9) — rows 6–9 take `close_inquiry` with a reason — and
  unclassified (0). `get_inquiry` returns the row, the answer (disposition,
  response, reasoning, proposal keys) and any closure.
- **Closure is terminal.** A close or acknowledgement is bound to the latest run
  and recorded on the inquiry; start, resume, recover, retry and refresh are
  refused until `reopen_inquiry {project, inquiryId, reason}` (the old closure
  stays in `inquiry.history` with who reopened it and why).
- **Packing.** One predicate (`inquiryPackable`) packs an inquiry into the archive
  when its latest run is settled (no live or unknown lock owner, workspace
  released, nothing pending) and its row is 4, or 5–9 with the fitting closure
  for that run. An answered inquiry packs itself when its run ends; the answer
  and the closure travel into the bundle. Drafts (no run) are never packed.
- **Admission.** Start, resume/recover/retry/refresh, finalize, close,
  acknowledge, reopen and packing take the project's durable admission lock
  (`issues/<project>/.admission.lock`), so their checks cannot interleave, across
  processes too. Inquiries are serialized with every other run on the project.
- **Visibility.** Inquiries stay out of the panel's issue lists (`GET …/issues`
  unless `?inquiries=true`), Needs attention, priorities, dispositions and the
  overview's open issues (listed there under `inquiries`), but their runs count
  in run, cost, concurrency and spending accounting. Operators read and act on
  them through `GET /api/projects/:project/inquiries/:id` and `POST …/close`,
  `…/acknowledge`, `…/reopen`.

## The overview

`overview {}` returns the whole panel in one bounded reading: every project, its
open issues with age and priority, and what past runs actually did. It exists
because a supervisor that has to ask project by project ends up reasoning about
whichever project it happened to look at first. The per-configuration and
per-seat statistics (`byPlaybook`, `bySeat`, 98% of a full reading) are left out
unless asked for with `overview {stats: ["byPlaybook"] | ["bySeat"] | true}`;
`statsOmitted` counts the groups left out and says how to ask.

Four things it is careful about, because each is a way to be confidently wrong:

- **A run's outcome is not the issue's state.** Run success and issue resolution
  are reported as separate rates, each named for exactly what it counts.
- **Work in flight has no outcome yet.** Live and paused runs are counted but
  excluded from every denominator, so a rate does not sag while work is healthy.
- **History includes archived issues.** A record of past runs that skips what was
  put away omits precisely the finished work.
- **Every rate carries its fraction.** `{of, total, percent}`, always. A bare
  100% over one run is not a measurement, and a reader given only the percentage
  cannot tell. Unpriced runs are counted as unpriced rather than summed as zero.

Results are grouped by what actually varies between runs — and by the **exact
configuration** each run was cut from, not merely its name. `playbook.id` and its
`version` are a label and a number someone has to remember to raise; the resolved
`configHash` changes whenever the YAML does. Grouping by the label alone would let
an edit retroactively rewrite what older runs were runs *of*. Runs now carry the
hash on the record, older ones have it read back from their snapshot, and a run
whose configuration cannot be established is grouped as `config unrecorded`
rather than merged into a group it may not belong to. Seats are grouped by role
and **roster entry**, so "this playbook works" and "this model works in this seat" are
answerable rather than inferred. Note that this is per entry, not per account: one
person using several models is split across rows, and per-account totals would
need an explicit `byAccount` grouping that does not exist yet.

## The ready queue

What the supervisor could start next is read for it by the engine
(`gui/server/ready-queue.mjs`) and sent in the prompt as `readyQueue`, so it neither
assembles the answer from separate reads nor finds out from a refused start. It is
an **observation**: it reads what admission reads, and `start_run` still re-checks
everything, so a start that loses a race is refused as before. It chooses no playbook,
and a preview is still needed. There is no action for it. Every prompt stays in the
native session, so a session is sent the queue whole only when it says something new,
and otherwise `{unchanged: true, since}`. A new session or activation gets it whole,
and a call that failed has not been told. A queue that cannot be read reaches the
model as `{unavailable: reason}` and does not stop the call.

**Members** are the open, undecided, non-inquiry issues of the declared campaign. With
no campaign, that is the whole panel, ordered by focus. An issue with an open owned run
is always in. No code parses the mission. The campaign narrows this reading only:
`outside` counts what it leaves out, and overview, `list_issues` and `start_run` still
reach every issue.

**Order** is focus, priority and age as in the overview, then each prerequisite in the
queue before what waits for it. At most 30 rows are shown, running and ready ones first,
and `omitted` counts the rest by state. `next` and the capacity wake work on every member,
so the limit never hides an issue from them.

**A row's state** is `ready` (no run on record, nothing in the way), `blocked`, `running`
(its latest run is live or paused) or `decide` (an earlier run ended, so another is a
judgement: it is never offered as next, unless a start of it was refused as occupied).

**What blocks it** is `blockedBy[]`, each `{kind, ..., until: {event, at}}`. `at` is a
time only when one is known, and null otherwise; nothing is estimated.

| Kind | Names | Until | `at` |
| --- | --- | --- | --- |
| `dependency` | the open prerequisites | each gets a disposition or is archived | null |
| `checkout-held` | the issue and run of the live in-place run holding the checkout | that run settles (a wall-clock budget is a limit, and pauses suspend it) | null |
| `module-lock` | `modules` the issue's triage named that another live run of the same module pool holds, and `holders` (module, run, project, issue) | `module-lock`: the holding run ends and its locks are released | null |
| `own-run` | the run, its status | it settles, or its question is answered | null |
| `owner-input` | the run | the owner answers on the issue page | null |
| `report-trust` | | an operator starts it from the panel (a report the supervisor may only assess stays `ready`, with `allowedPlaybooks`) | null |
| `launch-unresolved` | | an operator reconciles the launch | null |
| `failed-launch` | the reason; `advisory`, as the guard is keyed on inputs the queue does not read | the inputs change, or an operator authorizes a retry | null |
| `start-limit` | used, limit | an operator raises `maxStartsPerIssue` or begins a New session | null |
| `unreadable-run` | the run records | a person establishes what they hold | null |

**Module locks.** A framework project and its instances (`framework:` in
`projects/<id>.yaml`) share one pool of modules, the framework's modules plus each
instance's own, and a coding run locks the modules it affects in it
(docs/execution-contract.md "Module locks"). The queue reads the pool's locks against
each issue's triage modules (`sizing.affectedModules`): a module another live run holds
is a `module-lock` block, `until: {event: "module-lock", at: null}`, and `start_run` of
that issue is refused as occupied (retryable, `MODULE_LOCKED`, the holder named) — it
waits and never fails the issue. Issues whose modules are disjoint stay `ready` and start
side by side without anyone being asked. A `running` row whose run waits for a module its
revision now needs carries `module-lock` with `waiting: true`; that run takes the module
itself when it frees.

What stops every start is said once, as `canStartNow` and `because[]`: `finishing`,
`session-starts`, `concurrency` (a live run settles) and, only where allowances are
enforced, `spending-window`, the one block with a known time: the next UTC day or month.
A model's availability has its own time, but belongs to a model and no playbook is
chosen yet, so `seatModels` says it. Repository faults, base-policy refusals and stale
previews are not in the queue: they need a playbook and git, so `readiness` and
`start_run` still say those.

### When capacity frees

The poll reads which live in-place run holds each project's checkout, by the test a start
is refused on (`supervisor.checkoutHolder`: a live run with a live lock owner, however it
was started, and this process's own), so it sees runs the supervisor does not own. Another
issue's ordinary run holds nothing. It reads the module pools' locks the same way
(`supervisor.moduleLockReading`). If an issue that waited at the last reading for a
checkout, a module lock, a concurrency slot, a spending window or a prerequisite could start now, a
`capacity-freed` event wakes the supervisor, with `freed` (`checkout-released`, `module-lock-released`, `concurrency-freed`, `spending-window-rolled`,
`dependency-settled`) and `next`. A run's module locks are released when it ends (a paused
run keeps them), so the release of a module is told like the release of a checkout. It never goes through the wake filter, which can hold a
resolved ending for 15 minutes; what the filter holds rides along. An event already queued
in that poll carries it as `capacityFreed` instead of costing a second call. It is an offer:
the mission decides, and `action: null` is a fine answer.

There is no wake when nothing could start (nothing ready, finishing, no starts left), or
for what a prompt already showed the model, such as its own `set_disposition`: a reading
in a prompt that returned is the new baseline. The poll runs between turns, so a release
is learned at worst one turn and one poll later, and the next prompt's queue is current
anyway. A first reading is a baseline, not news. A run that settles while a poll is under way
can show its capacity free before its ending has been observed; the news then waits one poll,
so both arrive in one call. A run's status is written before its lock is released, so its
ending can also wake first and the release be told by the next poll: one more call, when no
prompt in between showed it.

### Calls per started run

`npm run --silent supervisor-calls -- --from YYYY-MM-DD --to YYYY-MM-DD` (from `gui/`;
`gui/tools/supervisor-calls.mjs`) reads the figure for a stated period of inclusive UTC
days, read-only and without a model session.

- `callsPerStartedRun.of` is the supervisor's own calls: `model-call` reservations in the
  period, repair and action-result turns included. Side questions and calls that never
  reached a runtime (`notStarted`: the reservation was released) are counted apart, under
  `calls`.
- A limit in older lines: a call Stop kept from reaching the adapter used to be settled at a
  known cost of 0, rather than released, and such a line reads the same as a real call whose
  runtime reported a cost of exactly 0. The tool cannot tell them apart, so it leaves both out
  of `of`, in every period, and counts them as `calls.settledAtZero`: the figure is low by at
  most that many.
- `callsPerStartedRun.total` is the runs it started: `run-start` reservations in the period
  that were settled, or that a run record carries as its `supervisorLaunchId`, archived
  runs included. A released reservation is `starts.neverStarted`. An outstanding one with no
  such run is `starts.uncertain`. A refusal before the reservation writes no line. Runs an
  operator started are not counted. Session counters cannot give this: they count attempts,
  per session.
- `ledger.coverage` says what the figure can stand on: `complete`, `partial` or `none`.
  `perRun` is null when nothing started.

To compare a before and an after, run it for both periods with the same tool, use a period
only when `ledger.coverage` is `complete` and `starts.started` is above zero, and state both
periods beside the figures. The ledger is append-only and a New session leaves it alone, so
an earlier period reads the same later on. A period the ledger does not cover has no figure.

## Readiness: conditions read now, taking nothing

`readiness {project, issueId?}` answers "could a run start here right now" without
reserving anything or spending any allowance. It exists because admission stops at
the **first** refusal: the budget is checked before the launch condition — which is
right, since doing filesystem work for a start that is refused anyway is waste —
but it means a budget-blocked supervisor never re-reads the source. The only fault
it can then describe is the last one it happened to see, which may have been fixed
days ago.

That is not hypothetical. A supervisor reported `detected dubious ownership` as a
current blocker and prescribed `git config --global --add safe.directory …` for a
checkout whose ownership had been correct for a day; the real fault by then was
that the repository had no commits, and the prescribed remedy would have changed
nothing.

There are two readings, and they are kept apart on purpose.

**Without a playbook** it reports only what holds for *any* configuration, and its
verdict is called `baselineReady` rather than runnable — because whether a given
playbook could run also depends on that playbook's own base policy, which has not
been looked at:

```
repository:    { ok: false, code: "EMPTY_REPOSITORY", message: "…no valid HEAD…" }
ownership:     { status: "valid", detail: "git read this checkout, so ownership is not what blocks it" }
budget:        { starts: { used: 8, limit: 2, remaining: 0, exhausted: true } }
baselineReady: false
prerequisites: [ { condition: "budget", needs: … }, { condition: "repository", needs: … } ]
```

**With a playbook** (`readiness {project, issueId, playbook, runOptions?}`) that
configuration is resolved and its source policy evaluated too — `DIRTY_BASE` and
the rest — reported separately, under the identity it belongs to:

```
configuration: {
  playbook: "implementation", intent: null, base: "working-tree",
  configHash: "sha256:6f0a786a…",
  observed:   { head: "8c0eca2f…", sourceFingerprint: "93746842…", at: "…" },
  ready: true, prerequisites: []
}
```

A base policy over a checkout git cannot read has no answer, so it is reported as
**not evaluated** rather than given a verdict, and a configuration that fails to
resolve is reported as that rather than assumed away.

Anything absent from `prerequisites` was checked and found in order. Neither
reading is a launch guarantee: both observe a checkout that can change a moment
later, which is why `start_run` re-checks every condition for itself. A reading is
also explicitly **not a preview** — a preview binds a configuration, and one taken
before these conditions changed is not evidence that a run is launchable now.

A reading of a project in a module pool, and a preview, also carry `moduleLocks`
(docs/execution-contract.md "Module locks"): `pool` (the framework's id), `members`,
`modules` (how many the pool has), `held` (every lock: `module`, its `owner` project,
the holding `runId`, `project` and `issueId`, `since`, `state` held | dead | stale |
unknown, `waiting` when that run waits for another module) and, for an issue,
`expected` (its triage modules, `source: sizing | none`) and `conflicts`: the expected
modules another live run holds. Two issues with disjoint modules read with empty
`conflicts`; two sharing a module read with the holder named. With a coding playbook
named, a conflict is a `module-lock` prerequisite of `configuration` (`ready: false`):
`start_run` would be refused as occupied, and the ready queue shows it as
`blockedBy: [{kind: "module-lock", until: {event: "module-lock"}}]`. A baseline reading
does not count it, since occupancy is no repository fault; in a preview it is an
information prerequisite, so the configuration stays ready to start once the holder ends.

A reading naming an issue, and a preview, also carry `pathOverlap`
(`runtime/path-overlap.mjs`): whether this candidate's expected files are being
touched by another live run, of another issue of its project or of another project.
Both sides are compared at the real file a delivery would write, through symlinks, so
a run of the owning project and a third project writing into the same owner both count
(`relation`: `same-project`, `owner-live`, `co-writer`, `candidate-owns`); `workspace.related` plays no part, since it only
grants read-only snapshots. Expected paths come from the issue's newest earlier
run: its retained worktree, its patch, else the paths its plan names (`via: plan`,
which a plan that only mentions a file can match; an absolute path counts through
links when it lies in a listed project, and is otherwise only compared as a string).
A live run's paths are its
worktree's changes as of now plus its plan's. `state` is `overlap`, `none`,
`not-applicable` (the configuration delivers nothing), `unavailable`, or `unknown`:
no earlier plan or revision, a source that could not be read (`expected.incomplete`),
or a live run that could not be compared. Every path is compared; only the file
lists shown stop at 30 (`more`). `unknown` is not an all-clear, and `possible` names the live runs whose files the candidate's
links can reach.

It is not a prerequisite and refuses nothing: `baselineReady` and
`configurationReady` do not hear of it, and it is no admission rule. Every start reads it again, and a start with `overlap` or `unknown`
goes ahead with the reading on `run.startOverlap` (with `by`: `operator` or
`supervisor`) and in its response. The supervisor is told to prefer other ready
work, or wait for the named run, unless the issue is urgent; an operator sees a
warning in the start dialog.

Until a reading is taken, a fault the supervisor remembers is labelled as
historical evidence — "a run on *date* failed with X; unverified since" — and its
old remedy is never prescribed as the current fix.

## Priority: execution order, decided and audited

`priority` is **execution order** and only that. It is deliberately not severity,
customer impact, a deadline or blocked-ness: those are separate facts that one
scalar flattens into something nobody can act on.

`urgent | high | normal | low`, stored with the reason, the author and the time,
and with whatever it replaced, so a reordering reads as a decision rather than as
the way things always were:

The trail is the record and it only ever grows: `priorityHistory` is append-only,
and the decision in force is derived from its last entry. Keeping a single
`previous` would mean each reordering quietly erased the one before it, and "how
often has this moved, and who keeps moving it" would have no answer on disk.

```json
"priorityHistory": [
  { "value": "normal", "reason": "Filed from triage",  "by": "operator",   "at": "…" },
  { "value": "high",   "reason": "Customer-facing regression", "by": "supervisor", "at": "…" }
]
"priority": { "value": "high", "reason": "Customer-facing regression", "by": "supervisor",
              "at": "…", "previous": { "value": "normal", … }, "changes": 2 }
```

An operator sets it on the issue page; the supervisor sets it with
`set_priority {project, issueId, priority, reason}`. A coordinator may *recommend*
one in its result and can never write one — the order of the company's work is not
something a run rewrites from inside itself.

Prerequisites are separate from priority: `set_dependencies {project, issueId,
dependsOn, reason}` (an operator uses `POST …/issues/:id/dependencies`) records
issues that must be settled first — given a disposition or archived. `start_run`
refuses the issue while one is open, and `overview` lists it with `waitingOn`
after every ready issue. An accepted split already chains its parts in the order
triage gave (each waits for the one before); `set_dependencies` may loosen or
replace that. A cycle of any length is refused. An operator may still start it from the panel. The
overview's `flow7d` per project counts, in issues, those opened, those settled by
disposition value, and those with a candidate delivered (`deliveredIssues`: a
completed delivery other than `none`, of a run that recorded a revision, or a
landing by hand recorded on the run; analyses and inquiries never count) in the
last seven days, split as `delivered: { engine, manual }` (an issue with both
kinds counts in each), so a growing backlog and a partial resolution are not read
as progress. Every run group also carries `delivered: { engine, manual }` and a
`deliveryRate` over terminal runs, counting a run once — as the landing when a
person recorded one — and each open issue lists its `delivered` runs (kind, when,
the engine's action or who landed it and where), so an umbrella issue worked in
batches shows each batch. Archived issues keep their counts through their packed
run records.

Issues that predate the field read as **unset**, not as `normal`. A migration that
defaulted them would be inventing management decisions nobody made; unset is
counted in the overview as its own thing, and a backlog-triage pass is a real
piece of work the supervisor can be asked to do.

## The spending ledger

A standing supervisor cannot be bounded by a lifetime fuse: one that burns out
disables the whole plane, including for projects it never touched. Money is
bounded by windows instead — so many starts and so much money per UTC day and
per UTC month — beside the session limits above. `runtime/ledger.mjs` holds the
accounting that makes that possible.

**Append-only.** Every fact is one line in `issues/.supervisor/ledger.jsonl`:
`reserve`, `settle`, `release`, `wake`. Nothing is rewritten, so a crash can lose
the last line but never corrupt an earlier one, and the file is its own audit
trail. State is derived by replay; there is no second copy to disagree with it.
A torn final line is dropped, the file truncated to the last complete entry, and
the truncation recorded — losing a reservation silently is exactly what this
exists to prevent, so it is reported instead.

**Outstanding means spent.** A reservation with neither settlement nor release
counts in full against its window. A crash between reserving and spending
therefore fails *closed*: the money is treated as gone until something says
otherwise. A release gives it back in full and requires a stated reason; a
settled reservation can never be released.

**Unknown is never averaged.** A reservation takes an explicitly configured
ceiling — a playbook budget, an operator's cap — or it is `unpriced` and draws on
an allowance of unpriced runs, which is a different resource with its own limit.
A historical mean is a statement about runs that already happened; admission is a
statement about one that has not. Runs without a configured ceiling are common
(every seat on an unpriced provider makes one), so the allowance is not a corner case.

**Overage is recorded, not absorbed.** When the settled cost exceeds what was
reserved, the difference is written on the settlement and the window then holds
what was *actually* spent — which may exceed its own limit. The honest
consequence is that the window admits nothing further until it rolls.

**Windows are UTC**, because no organisation timezone exists in configuration.
The zone is recorded rather than assumed, and a ledger asked for a zone nobody
implemented throws rather than quietly treating it as UTC.

**A wake is one durable event-processing chain.** Its identity and its call count
live in the ledger, so a restart mid-chain resumes the same wake instead of
handing the supervisor a fresh allowance by losing count.

**New session cannot touch any of it.** The ledger is a separate file from
`state.json`; reset rewrites only the latter. Entries, active reservations and
window usage all survive, and a test asserts the file is byte-for-byte unchanged
across a reset.

### Every limit, and exactly what it is scoped to

Every limit has exactly one scope, separated by what it protects:

| Limit | Scope |
|---|---|
| `maxCalls`, `maxRuns`, `maxStartsPerIssue`, failed-launch guards | per **session**: Start and restart resume, New session renews |
| `perWakeCalls` | per **durable event chain** |
| `daily`/`monthly` starts, money, unpriced allowances | persistent **UTC windows**, across sessions |
| `concurrent` | **instantaneous** occupancy |
| `history` | accounting of earlier sessions; decides **nothing** |

A lifetime ceiling on *starts* was wrong for a standing supervisor — it burns out
and disables the plane — which is why spending moved to wall-clock windows. Windows
are bounded by time, not by conversation, and that is load-bearing: money that
reset with the conversation would be bypassed by pressing New session, and the
ledger's whole job is surviving exactly that. Session limits are the opposite
kind of thing: they protect against a runaway conversation, so the conversation is
their natural boundary, and renewing them is an operator's explicit decision that
the model cannot take for itself. Retries per issue belong with them, not in the
policy: an older `perIssueStarts` key is accepted and ignored, and the loader says
so.

The one guarantee that matters therefore holds: **a conversation reset restores
no spending.** It restores exactly the session limits, because that is what a
fresh session means.

### Spending telemetry and optional allowance enforcement

`issues/.supervisor/spending-policy.json`, beside the ledger and outside
`state.json`, so a New session cannot touch it either:

```json
{ "version": 1, "enforceAllowances": false,
  "daily":   { "starts": 3,  "usd": 10,  "unpricedRuns": 2,  "unpricedCalls": 50 },
  "monthly": { "starts": 20, "usd": 100, "unpricedRuns": 10, "unpricedCalls": 500 },
  "perWakeCalls": 4, "concurrent": 1 }
```

Read and validated at startup. Absent, unparseable or invalid — a zero ceiling, a
fractional count, a daily ceiling above its monthly one, an unimplemented
timezone, a missing unpriced allowance — all give the same answer: **not active,
and why**. The refusal to activate is the point: a typo must be a message, not a
silently unbounded supervisor.

While the policy is inactive only the session limits gate, and the view says so
(`spending.decides: "session limits only"`); a refusal reads:

> Session run-start limit reached: 8 of 2 starts used this session. Raise
> maxRuns on Start or begin a New session.

By default, `enforceAllowances` is false, including when omitted from an older
policy. Daily/monthly dollars, starts and unpriced counters are reporting only.
Crossing them does not refuse calls or runs. The supervisor receives raw totals
marked nonbinding, and must not postpone work because of these numbers. Per-wake,
session runaway and concurrency guards remain operational controls.

Only an explicit `enforceAllowances: true` opts into the legacy calendar admission
rules below. The live installation uses false. A real provider quota error instead
records availability and tries verified compatible alternatives for the supervisor,
coordinators and workers; participant substitutions require successful preflight,
preserve completed work and start a fresh native session. Integrity quarantine
still requires recovery.

With explicit allowance enforcement enabled, admission checks the ledger:

Each window is checked in a fixed order, and the first check is the one that
binds everything:

| Order | Limit | Refused when | Applies to |
|---|---|---|---|
| 1 | `daily`/`monthly.usd` **exhausted** | committed ≥ the ceiling | **every subject**, priced or not |
| 2 | `daily`/`monthly.starts` | the window's starts are used | runs |
| 3 | `daily`/`monthly.usd` | committed + this reservation would exceed it | operations with a configured ceiling |
| 4 | `daily`/`monthly.unpricedRuns` | a start with no configured `maxCostUsd` | unpriced runs |
| 4 | `daily`/`monthly.unpricedCalls` | a model call the provider did not price | unpriced calls |

Plus `perWakeCalls` (the chain has used its calls — until the next event) and
`concurrent`.

In the optional enforced mode, exhaustion is checked before unpriced allowances.
In reporting mode, none of these calendar checks decides admission.

A run reserves the `maxCostUsd` its configuration declares, carried from the
preview; without one it is unpriced and draws on that allowance. The reservation
is written **before** the external call, so a crash between the two leaves the
money held rather than spendable twice, and settles when the run's outcome is
first observed — with what it actually cost, or as unknown. A definite non-start
releases it with the reason on record; an *uncertain* one does not, because
nobody knows whether it is running.

The supervisor's own calls are **accounted** the same way but **bounded
differently**, and the difference matters. They reserve nothing — their price
exists only after they return — and settle what they cost, so their money lands
in the same windows as everything else. What they cannot draw on is the run
allowance: unpriced runs and unpriced calls have separate daily and monthly
ceilings, because one shared allowance means the noisier subject exhausts the
other's budget while staying unbounded itself, and there are many calls per run.
Calls are bounded by `perWakeCalls` and by `unpricedCalls`; runs by `starts`,
`usd` and `unpricedRuns`.

Spending against no reservation is not an overage either: a subject that
deliberately reserves nothing would otherwise close a window it never exceeded.

A call whose runtime reports no cost, on a model with a price in `roster-pricing/`
(docs/host-config.md), settles at an **estimate**: that call's own tokens times the
price. Its ledger line keeps `costKnown: false, costUsdMicros: null` and adds
`estimated: true, estimatedUsdMicros, estimate` (tokens, rates, source, date), so
nothing summing reported cost can mistake it. Estimates count in the USD windows, said
apart as `estimatedUsd` and `estimatedCalls`, because leaving known token spending out
would keep the windows blind to it; under `enforceAllowances: true` one can close a
window. The unpriced-call allowance is unchanged: it counts every model call. `costUsd`
stays what was reported, and `cost` on the view and on `/api/supervisor/status` gives
`{reportedUsd, estimatedUsd, estimatedCalls, unknownCalls}`.

Codex reports the thread's running total and the adapter subtracts the totals on the
session, so a delta is one call's usage only when the previous turn left those totals
current. `state.ownUsageSession` records that a turn proved it: all three counters
reported, no counter reset, the same session, no fork running. Otherwise the next call
stays unknown, as does any call after a failure or a cancel, and a Codex fork always.
A call that cannot be estimated (no price, no usage, zero tokens) is counted in
`unknownCostCalls` and `unknownCalls`. Unknown is not zero. Old ledger lines are not
rewritten: one without `estimated` reads as reported or unknown from its `costKnown`.

**Money is integer micro-USD** wherever it is stored, compared or summed. Dollars
exist only at the edges — an operator writes them in the policy, a reader sees
them in a summary — because a ceiling decided in floating point refuses runs it
has the money for: `0.1 + 0.2 > 0.3` is true in binary, and a hundred settlements
of seven cents must be exactly seven dollars.

**A reservation that cannot be written stops the spending.** If the ledger append
fails, the model is not called and the activation stops with the reason: money
spent outside the ledger is money no window can ever refuse, and an unwritable
ledger is precisely when that matters. A *settlement* that fails is different —
the call already happened, so the reservation stays outstanding, keeps consuming
its allowance, and the failure is said out loud rather than swallowed.

A per-wake refusal ends the chain rather than aborting the activation — the
supervisor waits for the next event, and the next wake gets its own allowance.

## Service diagnostics

Application diagnostics are written to `logs/devpanel.jsonl`, readable by the
service owner without journal privileges. Each line contains a UTC timestamp,
severity, process ID, and message. Startup, shutdown, request errors, uncaught
exceptions, issue-run events, and supervisor state transitions are recorded.
Prompts and agent response bodies stay in their dedicated state/ledger files.
Known credential values and bearer tokens are redacted from application logs.
The log file is created with mode 0600 and the directory with mode 0700.

Rotation keeps the current file plus five backups (`.1` newest through `.5`),
with a default maximum of 10 MiB per file. `DEVPANEL_LOG_DIR`,
`DEVPANEL_LOG_MAX_BYTES`, and `DEVPANEL_LOG_BACKUPS` override these settings.
The system journal remains a secondary service-administration log, including
failures that happen before the application logger can initialize.

Read recent entries or follow them with:

```sh
tail -n 50 <panel checkout>/logs/devpanel.jsonl
tail -F <panel checkout>/logs/devpanel.jsonl
```


A deleted issue leaves a deletion receipt identifying its runs. The supervisor
uses that receipt to finish associated start reservations without erasing their
budget usage. A missing run without proof becomes `uncertain` and can be reconciled
through the existing operator reconciliation endpoint using
`{ "launchId": "…", "retired": true, "reason": "confirmed stopped and deliberately deleted" }`.
Retirement requires an absent run and preserves the start and its budget history;
it cannot declare an existing run finished. Uncertain starts still occupy capacity
until their outcome is established.

## Model performance measurements

The model availability page's Refresh button posts to `/api/availability/refresh`.
It starts one fresh-session, no-tools hello-world call per verified model that is
not on hold. Calls run sequentially with a 120-second deadline each. Concurrent
refresh requests join the running batch. GET requests and page polling never
invoke models. The POST returns 202 with progress; results update after each
model and persist in `issues/.model-performance.json` across server restarts.
Shutdown aborts the current call and waits for termination. Interrupted batches
are not automatically repeated.

Startup is invocation start to the first CLI readiness event; response is
readiness to the first visible answer event; total is invocation start to
completion, including generation and cleanup. These are measured with a monotonic
clock. They are CLI observations, not guaranteed first-token latencies. Missing
events produce null timings. Failures, timeouts and unexpected answers are recorded
as unsuccessful samples, never as healthy latency measurements. Changed model,
connection or default effort marks previous samples stale.

The same samples reach every supervisor turn through `seatModels[].performance`.
Refresh uses the model's configured profile, account, credential and default effort.
These operator-initiated probes use normal provider quota or API billing, separate
from supervisor session call counts; each persisted sample records known cost and
tokens. Unknown cost stays null. Probe-reported quota exhaustion updates the
existing availability hold.

### Operational allowance sizing

A wake includes every model turn needed to inspect an issue, correct a preview,
start work and interpret action results. An eight-call wake can end before the
first run starts, so size `perWakeCalls` for whole chains (tens of calls, not a
handful), and the daily and monthly starts, unpriced runs and unpriced model calls
for the work the installation expects. Session defaults are 2000 calls,
200 run starts, 20 starts per issue, and three concurrent runs. Saved session
limits remain operator-controlled and are not silently replaced by defaults.

An installation's monetary ceilings are in
`issues/.supervisor/spending-policy.json`. Counters and the spending ledger are
retained when allowances change. Same-project exclusion, failed-launch guards,
preview validation and release checkpoints still apply.

Supervisor model calls have no fixed two-minute deadline. Provider latency alone
must not cancel a healthy management turn; operator Stop still propagates abort.
`accept_check_result_run {project, issueId, runId, revision, failures, reason}` accepts
named failures of the check on an approved revision of a run it owns and delivers it
(execution-contract.md "Accepting a check result and delivering"). The engine enforces
its authority (`supervisorAcceptRefusal`): named test failures, each new against a
compared base, at most 3, nothing left not run, on a playbook whose
`minimumVerification` is `review-only`. A whole command, a timeout, a crash, a suite
entry, a failure no comparison judged, or a playbook that closes only on passed checks
changes the agreed rules, so it is the operator's: `ask_operator`. An `accepted: false`
result accepts nothing yet: the coordinator confirms first, and `checkAcceptanceRefusal`
says why it did not.
After an operator installs missing candidate tests, `refresh_checks_run` lets the
supervisor reassess a retained closure-blocked candidate without another full
implementation run. Accepted residual risk does not turn an unmet acceptance
criterion into a met one.
A run with less wall clock left than its mean round is refused with both numbers
(execution-contract.md "What the wall clock counts"): only an operator can raise the
limit or override it, so that goes to `ask_operator`.
`continue_run {project, issueId, runId, instruction}` continues a run it owns that
stopped at closure (execution-contract.md "Continuing a run stopped at closure"):
the author gets another round with the instruction, the closure record and the new
issue notes. It is for a record that shows what to fix, never to waive a criterion. The
supervisor continues a run at most once (`MAX_CONTINUES` in
`gui/server/top-supervisor.mjs`); a second request is refused and the decision
(accept, amend the criterion, or stop) goes to the operator through
`ask_operator`.

### What a result costs the session

Every tool result enters the supervisor's native session and is re-read on every
later call, so each is shaped for it (`gui/server/supervisor-payload.mjs`), and
nothing is dropped without saying so:

- An issue mutation (`set_disposition`, `archive_issue`, `set_priority`,
  `set_dependencies`, `create_issue`, `mark_landed`) returns an acknowledgement:
  `change`, the issue's row as it now stands, and any `warnings`, not the issue
  with its steps.
- `list_issues {project, offset?, limit?}` returns a page of rows (50 by default,
  at most 200) with `total`, `omitted` and the call for the `next` page.
- A preview names each check command by id, kind and report, without its shell
  text (the project's configuration and the run's check record hold that).
- An `issues-changed` event carries the rows that were added or changed (with
  `change`) and the ids `removed`, beside the `total`; not the whole list again.
- Any result still over 40,000 characters is kept whole under
  `issues/.supervisor/results/` and shown as its first page with `truncated`,
  `resultId` and `next`: `get_result {resultId, offset}` reads on by its JSON text.

`get_check_log {project, issueId, runId, check, command}` reads the bounded tail
of an engine-recorded command log. `check` is the zero-padded check directory
number and `command` is its recorded command id. Check logs are not issue-step
files and must not be requested through `get_file`. The response includes the
checked revision, exit code, truncation flag and retained log path.
