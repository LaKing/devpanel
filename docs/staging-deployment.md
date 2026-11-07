# Shared staging deployment

The current tactical playbook model is documented in [Tactical playbooks](tactical-playbooks.md). It supersedes the legacy catalogue and single-auditor workflow described below for new runs.

Deploying/starting the shared staging instance is an operation the operator or the
top-level supervisor triggers, never an agent inside a run.
The analysis playbook only produces a document. The revision-bound test drive
boots an isolated candidate and preserves the shared instance. Neither performs
a shared deployment.

Projects may explicitly enable `infrastructure.stagingDeployment`, supplying a
host `workdir`, ordered `commands`, optional `diagnostics`, per-command deadlines, and operational notes.
Commands are installed operator configuration; models cannot supply shell text
or choose arbitrary hosts. All deployment commands must target the configured
staging instance. Production deployment remains unavailable through this action.

The top-level supervisor uses `deploy_staging {project,issueId}` on its own
judgement whenever deploying moves work forward: a delivered fix that test drives
or live verification need, a stale or broken staging instance, or a user request
(see [Top-level supervisor](top-level-supervisor.md)). The operation runs on the host with its existing
SSH access, outside the restricted author/reviewer process. Authoring agents are
briefed to leave this operation to the supervisor. After execution, the supervisor
assesses the recorded evidence and saves its assessment using `add_note`.

Operators can invoke the same operation directly as the service account:

```sh
node gui/server/staging-deployment-cli.mjs <project-id> <issue-id>
```

A typical configuration runs the application's own reviewed staging deployment
script, which copies current application/framework source, preserves instance secrets/data,
installs dependencies, starts the shared service and checks readiness. Installation
can update staging OS packages/service configuration; normal boot can migrate its
own database. It then collects the journal for the first 180 seconds following
service start, verifies the invocation has not changed, and checks the service is
still active. This is operational evidence, not a full functional test suite.

Results live in `<issue>/operations/staging-deployment.json` and an issue note.
The first operation is persisted before command execution. A project lock excludes
concurrent operations. Repeated requests for the same issue return the existing
result; they never re-run commands, including after failure. A previous running
record is reported as recovery-required after interruption. Inspect partial
remote effects before retrying. An operator may use the CLI option
`--retry-failed <operation-id>` after fixing a diagnosed failure. It requires the
exact failed attempt, archives that record, and links the new attempt via
`retryOf`. This option is not exposed to model actions; interrupted/running
operations cannot be retried this way.
There is no automatic rollback or production promotion. Cancellation terminates
the local process group, but remote effects may remain and require inspection.

The operation refuses disabled project configuration, archived issues, and an
active run on the same issue. Bounded stdout/stderr and command exit status are
retained; truncation is explicitly recorded. A failed action skips remaining actions but still runs configured diagnostics. A diagnostic failure also prevents success. Cancellation stops further commands. The observation command refuses to label a service start older than the operation as new deployment evidence.
Shared deployment does not mark source revisions approved or automatically close
an issue. The historical analysis triage result stays unchanged.

## What a release covers

`GET /api/projects/:project/staging-pending`, and `stagingPending` per project in the
supervisor's `overview`, list the runs delivered into a project's development checkout
(by the engine, or landed by hand) that no successful Staging run has covered.
`server/staging-coverage.mjs` derives them, for every project, whether or not it can
release (`configured` says what it has).

**History.** A delivery from before the coverage baseline (`COVERAGE_BASELINE`, the date
coverage began, the same for every project and independent of any staging target) is
history: counted in `history.count`, and absent from `pending`, `indeterminate`, every
release's and deployment's record, and every note. Its content is never read, so a first
deployment after upgrade notes nothing for it. A delivery is placed by when it was made
(a landing by when it was recorded); one with no time on record stays listed. Everything
below is about deliveries from the baseline on.

**When to cut a batch.** When `batch.ready` is true: the `pending` list is non-empty, no
delivery is in progress (`liveRuns` is empty), and a Staging release target is
configured. The top-level supervisor or an operator decides, never an agent inside a
run. The engine only supplies the list and records coverage: it starts no release and
bisects no red batch, and serial runs need nothing more.

**Covered.** A Staging run compares its snapshot with what each waiting run delivered,
when the release happens, and records the result on `run.release.coverage`. A run is
covered when, for every path it changed, the snapshot's bytes are the delivered bytes,
or those of a later delivery built on them (the delivery's before-image is the earlier
one's after-image). The bytes come from each delivery's patch, whose index lines name the
blobs. A delivery's record names the paths it changed (`delivery.changedPaths`), so looking
for a later delivery on one path opens no other's patch or bundle; a record older than that
field, or a landing of another revision, is read from its patch. Recorded order only says which delivery is later, and a release counts only for
runs delivered before it started: order can exclude a release and never establishes
coverage. A successful Staging run that recorded nothing counts through its
retained `artifacts/release.tar`, verified against its recorded hash; a missing or
changed archive establishes nothing, and that reading writes no record or note.

**Indeterminate.** A run whose bytes cannot be known (a landing with hand changes, an
older in-place run, an unreadable patch, a chmod, whose patch names no blob) or whose paths hold something else, in the
snapshot or in the checkout, is `indeterminate`, never covered. It stays listed until a
successful Staging run's bytes establish it. A person reads this list, and there is no
dismissal. It does not count towards `batch.ready`, so a hand-edited path cannot prompt
batches for ever.

**A Deployment run to staging counts.** A Deployment run with environment `staging`
(its default), and the staging half of `staging-then-production`, release this
run's snapshot exactly as a Staging run does: they record coverage and count as
Staging runs for everything in this section. Their receipt also records the
snapshot's content identity (`run.release.content`).

**Production and coverage.** A production Deployment run with no named releaseId
is filled with the newest green staging release whose content is the checkout's
([Tactical playbooks](tactical-playbooks.md#deployment-environments) "When
releaseId is filled"). Coverage explains why there may be none (a run still
pending is content no green release carried) but decides nothing: the match is
read from the release's own bytes, because coverage records which deliveries a
release carried, not what one archive holds. With no match the start is refused
with *No green staging release matches the content of this project's checkout:
run Staging (or 'Staging first, Deployment on success'), or name a releaseId.*,
and the start dialog offers the latest green staging release or says there is
none. An operator may still name a releaseId explicitly.

**Only a Staging run clears a run.** `deploy_staging` runs opaque saved commands and
leaves no shipped bytes to compare, so reading the instance or the checkout around them
would not prove what shipped. Its record (`coverage` on the operation) names every
waiting run `indeterminate`, reason `deployed-content-unproven`; it covers none and
changes neither list. A run with no hand change stays in `pending`, with `lastDeployment`,
and can still prompt the Staging release that clears it. The record's `checkout` field
says whether the development checkout held each run's bytes before and after the
commands; that is information only and decides nothing. A project with shared deployment
and no Staging release target can never clear a run: its runs stay listed and
`batch.ready` stays false, with the reason.

**Notes.** Each issue a Staging run carried gets one note per release, on success and on
failure, naming the release run, its outcome and a link to it; a later end of the run
rewrites the note. An indeterminate run's issue gets one when it is first named and on
every red release. A red release keeps its configured automatic restore, and its failure
is attributed to every issue it carried; which issue gets the follow-up is the
supervisor's or the operator's choice. A deployment notes the issues of first-named runs
when green and of every run it names when red, linking to the issue holding its report.
An archived issue refuses new steps, so its note is kept beside it
(`issues/.archive/<project>/<id>.notes.json`), shown on its page, and becomes a step when
it is restored; the bundle is not touched. At startup the panel writes any note a crash
or a failed write left owing, for every deployment attempt and every release issue,
archived ones included, leaving written notes alone. A packed release issue's receipts
are kept beside its bundle.
