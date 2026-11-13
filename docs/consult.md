# The consult panel

A question that would go to a person goes to two senior models first. They are not seats of any run: they read the
project read-only, each answers on its own, and only when they do not agree, or the decision is a person's by its
nature, is a person asked, in plain words the panel wrote. A weaker model never has to put a demanding technical
question to a person, and a person is not asked what the code already answers.

It is advice with one piece of authority: when both consultants choose the same answer, that answer is recorded as
the decision the question asked for. It grants no capability. It cannot approve a revision, accept a check result,
deliver, deploy or archive; whoever acts on its answer does so within their own limits.

## Who asks

| Asker | What goes to the panel | Where |
|---|---|---|
| A run's seat | an owner hold (`ownerHolds`: `access`, `security`, `documented-promise`) | `engine.consultFirst`, before the pause |
| A run's coordinator | an `operatorRequest` of category `owner-gate` or `requirement-conflict`; `technical` (below) | `engine.applyOperatorRequests` |
| Triage | each question of a `needs-owner-input` ending | `consult/owner-questions.mjs`, after the run's end |
| The top-level supervisor | its own question (`consult`), and the wording of what it asks the operator | `top-supervisor.mjs` |
| A person | any question, from the command line | `npm run consult` |

Never consulted: a `live-checkout` request (a work order, not a question), a closed question with fixed options
(continue/stop), a proposed split (`too-large`), a release authorization (the server writes that question itself).

A category listed in the panel's `alwaysHuman` (default `authorization`: spending, production, destroying data,
publishing), and a supervisor question of kind `reserved`, is a person's whatever anyone thinks. The panel is asked
in mode `brief` only: one seat reads and writes the question for the person, and nothing is decided.

## Configuration

`consult/panel.yaml`, replaced whole by `host-config/consult/panel.yaml` (docs/host-config.md), checked against
`schemas/consult-panel.schema.json`:

```yaml
enabled: true
seats:
  consultant-1: { model: fable-5-2, effort: medium }
  consultant-2: { model: gpt-6-astra, effort: medium }
maxRounds: 2            # a second round shows each seat the other's opinion, once
turnTimeoutMinutes: 20
maxTurnCostUsd: 5       # reserved on the spending ledger per seat turn
maxPerRun: 6            # consults one run may ask
maxTechnicalPerRun: 3
alwaysHuman: [authorization]
readOnly: []            # further absolute paths every consult may read
deny: []                # absolute paths shown empty even inside a readable directory
```

A seat names a verified roster entry on the `claude` or `codex` harness (Gemini has no read-only workspace root and is
refused). The file is read at every consult, so a change needs no restart. It is not part of any run's snapshot or
`configHash`: a run reads a consult's record, never this file. `npm run config:check` warns when a seat cannot be
used. The host settings' `operatorLanguage` (an ISO 639-1 code, default `en`) is the language the question for a
person is written in; everything else stays English.

## Access

Each seat turn runs inside a proved bubblewrap fence (`harness/fence.mjs`), as the adapters' read seat (the mode a
coordinator's `access: read` turn uses): read tools and a read-only shell. `consult/roots.mjs` grants, read-only:

- the project's live checkout as it stands, uncommitted work, ignored files and logs included;
- the checkouts of the projects its project file ties it to (`framework`, `workspace.related`), and what a checkout's
  top-level links lead to;
- the issue's whole folder: report, notes, every run's steps, prompts, responses, checks and evidence;
- the asking run's worktree;
- the panel's configuration file of the project and of the projects tied to it (`projects/<id>.yaml`, the
  installation's copy when it has one): how the project is checked, staged and delivered;
- the panel's `readOnly` paths.

Every root is checked before it is granted, because the fence's own canaries treat whatever lies inside a granted
path as covered: a root is refused when it is or contains the home or the projects root, reaches a login or key
directory of the home or a container filesystem, or is or lies in a protected path; a link out of a checkout is
followed only to a directory under the projects root. What was refused, and why, is in the consult's `roots.json`.

Writable: a temporary scratch directory, removed after the turn. A run's seat sees a snapshot of tracked files; a
consult seat is asked precisely because it can see the rest, so only credentials are masked: the panel's token, its
certificate directory, the reporter keys, and the panel's `deny` paths are shown empty (`spec.masks`, proved like
every other part of the fence). The home, other projects, and container filesystems under the projects root
(`selection.forbiddenPrefixes`) are not visible at all. A seat does not reach remote hosts for logs.

Without a proved fence there is no consult: a host that runs none, or a turn whose adapter reports no read access,
is `unavailable`. An opinion that could not read is not a second opinion.

## The opinion

One JSON object per seat (`schemas/consult-opinion.schema.json`):

- `verdict`: `answer`, or `owner` with an `ownerReason` (`production-deployment`, `irreversible-data-loss`,
  `spending`, `agreed-rule-change`, `product-intent`);
- `choice`: the key of one of the options offered, or `other`; `answer`: the decision to follow;
- `conditions`: what the work must honour for the answer to hold; `reasoning`; `evidence[]` with `location` and
  `observation` (at least one for an `answer`); `confidence`: `high`, `medium` or `low`;
- `ownerBrief`: how this would be put to a person, always required: `question` (at most two sentences), `why`,
  `options[]` each with its `consequence`, `recommendation`.

The options of the first round are the asker's recommendation (`recommended`) and its own closed options. A reply
that breaks the contract gets one repair turn in the same session.

## The rule

Agreement is never a model's reading of two texts (`consult/rule.mjs`, pure):

- **resolved**: both seats say `answer`, name the same option other than `other`, and neither confidence is `low`.
  The answer is that option's text with the conditions of both seats.
- **escalated**: a seat says `owner`, or the seats still differ after the last round. The result carries the `brief`:
  the first seat's `ownerBrief` with each seat's position.
- **unavailable**: a seat gave no usable opinion (failed, timed out, could not read, broke the contract twice), a
  seat's model is unverified or held, the spending policy refused the call, or the host runs no fence.

When the seats differ and a round is left, each seat's own session is resumed and shown the other's opinion. An
answer given as `other` becomes a named option (`alt-1`, `alt-2`) that either seat can then choose. The same rule
decides.

## Records

`<caller directory>/consults/<id>/`, written as it happens: `request.json`, and per round and seat the prompt, the
response, `<seat>.turn.json` (the validated opinion, the session, the cost) and the live output; `result.json` is
written before the result is returned. The caller directory is `runs/<run id>/` for a run and `issues/.supervisor/`
for the supervisor and the command line. The id is the hash of the caller's key, the question and the mode, so the
same question is one consult: asked again, the record answers and no seat turn runs; two callers asking it at once
share the one in flight. A consult that was cancelled
or lost its process runs again from the turns already recorded. A panel that is not configured or is switched off
records nothing, so enabling it later asks.

Each seat turn is on the spending ledger (`subject: 'decision'`, `meta.purpose: 'consult'`, the panel's
`maxTurnCostUsd` reserved, the known or estimated cost settled) under the same windows as every other call.
Admission and reservation are one step, so the two seats of a round cannot both pass on the last dollars. A failed
turn that states its cost is settled at it, one that never started is released, and any other failure stays
reserved, the ledger's rule for a charge nobody can state. A quota
failure records the model in the availability store.

## In a run

`engine.consultFirst` is called where a run would pause for a person. `run.consulting` is set while the panel works
(the run reads "two senior models are answering a question"), `run.consults` keeps every consult's outcome.

- **resolved**: a decision step is recorded through the same recorder as a person's answer (`engine.recordDecision`):
  role `operator`, `decision.actor` `consult panel (<model>@<effort> + <model>@<effort>)`, `decision.consult` with the
  consult id, the choice, the conditions and each seat's opinion. Replay, `decisions` in later prompts and the
  closing of an owner hold read it exactly as they read an owner's answer. The run does not pause. `result.md` lists
  these under "Decided by the consult panel", beside "Assumptions made", for the owner to overrule afterwards.
- **escalated** or **unavailable**: the run pauses as before, and `run.pause` carries `consult` (outcome, reason,
  positions) and, when escalated, `brief`. The issue page shows the brief first; the technical wording stays below.
- The outcome is the panel's rule. Nothing a coordinator writes turns an escalation into an answer.

The time a consult takes is excused from the wall clock like a wait for a person, credited per stretch it ran.
Stopping the run cancels the panel's turns and leaves `run.consulting` naming the consult, so a resume goes on with
it from its record. A recorded result is used before the panel's configuration is read: a replay after a crash
finds the answer whether or not the panel was switched off since, and the decision step has a stable identity
(`decision-consult-<id>`), so it is never recorded twice. A fault in the panel never fails a run:
the question goes to a person.

**`technical`.** A coordinator's `operatorRequest` of category `technical` is a question about a technical route it
cannot judge from its evidence. It never waits for a person: an agreed answer is the decision; when the seats differ,
or the panel cannot be asked, or the run has used its consults, the decision step says what each seat said (or that
nobody was asked) and the coordinator decides, recording the choice as an assumption, or raises an `owner-gate`
request if it cannot.

**Triage.** A run that ended `needs-owner-input` holds nothing, so its questions are consulted after its end
(`ownerInput.consult.status`: `running`, then `resolved`, `escalated` or `failed`). When every question is resolved,
the answers take the owner's own path (`owner-input.mjs`): recorded on the run with the panel as the actor, written
as a note on the issue, and the same configuration is started again. Otherwise each open question carries `consult`
and `brief` for the owner. Once per issue: a second `needs-owner-input` after a panel-answered one goes to the owner.
A consult the service's shutdown cut short (`running`, or `resolved` with no answer yet) is found at the next start
among the runs of the last three days and finished from its records.

## For the top-level supervisor

`consult {question, recommendation, project, issueId?, runId?, reason?}` starts a consult in the background and
returns its id; the result wakes the supervisor as a `consult-result` event with the outcome, the answer and
conditions, each seat's position and the brief. `ask_operator` takes a `kind` when a panel is wired in:

- `reserved`, with `reservedBy` (`production`, `irreversible`, `rules-or-limits`, `owner-question`,
  `operator-capability`): recorded at once; a `brief`-mode consult attaches the plain wording when it arrives.
- `undecided`, with the `consultId` of a consult that ended `escalated` or `unavailable`: the question carries that
  consult's brief and positions. A consult that was resolved is refused here.

An `undecided` question takes its project and issue from its consult and is refused for another. `ask_operator` is
refused for an issue whose run is already paused on a question, named or not: that question went through the panel
in the run and is in front of the operator with its brief. A consult result that arrives while the supervisor is
stopped is kept for its next start. A session may ask 40 consults; a New session renews that.

## From the command line

```sh
npm run --silent consult -- --project <id> --question <file> [--issue <id>] [--run <id>] \
    [--recommendation <text>] [--reason <text>] [--mode brief] [--plan]
```

`--plan` prints the seats, what they could read, what is masked and the prompt, and invokes nothing. Without it the
command launches real model turns and refuses unless `DEVPANEL_LIVE=1`. It has no spending ledger; the cost is on the
printed result. The record is kept under `issues/.supervisor/consults/`.

## What it never does

- It does not ask a person anything itself: it returns, and the caller asks.
- It does not change a file outside its scratch directory, start a service or reach a remote host.
- It does not widen what a coordinator, a seat or the supervisor may do.
- It does not hide a disagreement: two answers that differ go to a person with both positions.
