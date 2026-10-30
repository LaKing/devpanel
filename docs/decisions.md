# Advisory decisions (TypeSafe Jev, or the OpenAI Decisions API)

A decision provider is a cheap, fast classifier. Its input is a `state` (text or JSON) and a set of typed
questions, and it returns probabilities. It is **not** a harness, a roster entry or a seat: it cannot read the
repository, run a command or write anything. Callers use it to *route* work and fall back to exactly what they
did before whenever it is not confident enough or not available. It is never consulted for approvals, closure,
dispositions or anything bound to a fingerprint.

## Configuration

`decisions/<id>.yaml`, validated by `schemas/decision-provider.schema.json`. Two providers are shipped: `jev`
(TypeSafe Jev, the default) and `openai` (the OpenAI Decisions API, see below). Jev's file:

| Field | Meaning |
|---|---|
| `endpoint`, `model` | `https://api.typesafe.ai/v1/systemone`, `jev-latest` (the response names the real version, e.g. `jev-1.13.0`) |
| `credentialRef` | `file:~/.config/typesafe/key` (mode 600, owned by the service user) or `env:NAME`. It is read at every call, so adding or rotating the key needs no restart. The value is never stored, logged or recorded |
| `threshold` | Act only at or above this confidence (0.9). It is applied once, when the answer is recorded |
| `timeoutMs`, `retries`, `maxWaitMs` | Bounded retries on 429/529/5xx/network errors. A `retry-after` longer than `maxWaitMs` is not waited for; the caller falls back |
| `pricing`, `maxCallCostUsd` | $0.042 per million input tokens, output free (docs.typesafe.ai/models.md, 2026-09-19). The ledger reserves the ceiling and settles usage × price |
| `maxStateChars` | Checked before sending. The provider's limit is 32k tokens for the state plus the longest question |

A missing file means "not configured", which callers treat as unavailable. An invalid file throws.

### Which provider is active

Exactly one provider is active at a time. `decisions/active.yaml` selects it:

```yaml
provider: openai
```

Without that file (or with one that selects nothing) the active provider is `jev`. The file holds only
`provider: <id>`; anything else throws. A selected provider whose `decisions/<id>.yaml` is missing or invalid
throws too: it is shown on the Model availability page as `decision:<id>`, unconfigured, with the error, and
nothing is asked. It never falls back to Jev. The selection is re-read at every ask, like the provider file, so
switching needs no restart. Records carry the provider id in their key, so switching never answers a question
from the other provider's record.

A provider file's `kind` names the client that speaks to its endpoint: `jev` (the default when absent, so
`jev.yaml` needs none), `openai` or `model`. `advisor.mjs` builds the oracle from that `kind` (`oracleFor`).

Both files are read from the host config first (`host-config/decisions/`, docs/host-config.md), then from the
tracked `decisions/`, so an installation chooses and tunes its provider without editing tracked files.

### A roster model as the provider (`kind: model`)

A host whose only access is a logged-in CLI (a Claude subscription, say) can make a verified roster model the
provider. It is asked exactly as the Assess bar asks one (`model-oracle.mjs`: one tool-free turn, answers
checked by `checkAnswers`), so there is no endpoint, key or price list; the schema refuses them. Each ask
reserves `maxCallCostUsd` and settles what the CLI reported. An unknown or unverified roster id is a
`configuration` failure, never charged.

```yaml
# host-config/decisions/claude.yaml (with host-config/decisions/active.yaml: "provider: claude")
id: claude
kind: model
model: haiku-4-5      # a roster id
threshold: 0.9
maxCallCostUsd: 0.05
timeoutMs: 120000
```

It draws on the same subscription limits as the runs, and each ask is a CLI turn of some seconds, not a
sub-second API call.

### The OpenAI Decisions API (`decisions/openai.yaml`, `gui/server/decisions/openai.mjs`)

Public beta (developers.openai.com/api/docs/guides/decisions, read 2026-10-07): `POST
https://api.openai.com/v1/decisions` with a Bearer key, model `gpt-6-luna` (the only one). It needs a real
OpenAI API key; a ChatGPT login (the Codex CLI's) does not grant API access. `credentialRef` is
`file:~/.config/openai/key`; no key is shipped. Maximum questions per request, context limit, rate limits and
timeouts are not documented, so `timeoutMs`, `retries`, `maxWaitMs` and `maxStateChars` are Jev's values, and
`threshold` (0.9) and `maxCallCostUsd` (0.01) are marked untuned in the file.

Pricing: Jev costs $0.042 per million input tokens; OpenAI costs $0.10 per million input tokens, with no output,
cache-read or cache-write charges (regional premiums and long-context multipliers may apply). Both are set in
the YAML only. The guide shows no `usage` object in the response. When there is none the ask still succeeds,
`costUsd` is null and the ledger settles the reserved `maxCallCostUsd` with `costKnown: false`, exactly as for
any provider that reports none. `npm run live -- --openai-decisions` records whether a usage object came back.

devpanel's question and answer shape (`questions.mjs`) stays the contract. The translation is entirely inside
`openai.mjs` and is purely syntactic:

| devpanel (Jev) | OpenAI |
|---|---|
| `questions` object keyed by id | `questions` array, id → `name` |
| `noul` (`criteria.true`/`false`, when given, appended to the instructions as "True means: …") | `predicate`; answer `probability` → `noul` |
| `choice.criteria` map `{ option: description }` | `choices: [{ value: option, description }]`; answer `probabilities` array → map keyed by `value` |
| `score.criteria` array of descriptions / `{ what }` | `levels: [{ label: "<index>", description }]`; answer `probabilities` array → map keyed by `String(value)` |
| `state` (string or JSON) | `input` string (JSON-stringified when not a string) |

The translated answers pass `checkAnswers` like Jev's, so the same tolerance applies (a distribution off by more
than 0.01 from 1 is a contract violation) and an option or level never offered is a contract violation. Nothing
is rescaled. Images are not sent: `state` is text.

Transport, retries, timeout, `maxStateChars`, `retry-after`, credential reading, failure classes and key
scrubbing are shared with Jev in `gui/server/decisions/http.mjs`. `jev.mjs` and `openai.mjs` supply only the
request body and how a response becomes answers.

## Questions and answers (`gui/server/decisions/questions.mjs`)

- `noul`: yes/no. The value is `P(true) >= 0.5`. The provider gives no confidence for a noul, so it is derived as `max(p, 1-p)`, marked `confidenceSource: 'derived'`.
- `choice`: 2–255 named options. The value is the option.
- `score`: an ordered rubric of at least 2 levels. The value is the most probable *level*; the weighted `score` is kept beside it.

Questions are validated before sending. Answers are untrusted: they must match the provider's documented shape
(for Jev the JSON Schema `schemas/jev-response.schema.json`; for OpenAI the checks in `openai.mjs`), answer every question asked with the type asked, choose an offered option,
and carry a distribution over exactly the offered options that sums to 1. Anything else is a
`contract-violation`.

## Recording (`gui/server/decisions/index.mjs`)

`createDecisions({ oracle, config, ledger?, admit? }).ask({ dir, purpose, subject, state, questions })`:

- The key is sha256 over the canonical `{provider, model, purpose, state, questions}`. The record is
  `<dir>/<purpose>-<key16>.json`, published with a hard link so the first writer wins and a second adopts it.
- The record is written **before** `ask()` returns, and a later ask for the same key reads it without calling.
  That covers an unavailable outcome too, so a replay after a crash takes the same fallback it took the first time.
- `confidentAnswer(record, id)` returns the interpretation only when the record is answered and that question is
  confident. Callers branch on this alone.
- Money: `ledger.reserve({ subject: 'decision', maxCostUsd })` before the call. A decision is always priced,
  and the ledger refuses an unpriced one. After the call:
  - answered: settle at usage × price, or at the ceiling if no usage was reported
  - refused by an HTTP status (not charged): release
  - timeout, 5xx or network error (charge unknown): stays outstanding (fail closed)
  - contract violation (charged): settle
  
  A refusal by `admit` is recorded as `spending-refused` and the provider is not called.

## Failure classes (`gui/server/decisions/http.mjs`, shared by both providers)

`configuration`, `invalid-question`, `auth` (401/403), `invalid-request` (400/404/422), `rate-limit` (429/529),
`transient` (5xx, network), `timeout`, `contract-violation`, `cancelled`, plus `spending-refused` from the
recorder. Every error message is scrubbed of the key's value.

## Checks

- `npm test -- decisions`: every phase wired as the server wires it (`decisions.phases.test.mjs`), with a scripted
  oracle and a real ledger. Nothing reaches the network, because `npm test` may not spend money.
- `DEVPANEL_LIVE=1 npm run live -- --jev`: ONE request with retries off and three questions whose answers are not
  in doubt. It passes on an accepted key plus a satisfied contract. The obvious answers are reported beside
  that, not folded into it. The report goes to `gui/live/reports/jev-*.json`.
- `DEVPANEL_LIVE=1 npm run live -- --jev-integration`: THREE requests to the real provider, one per phase, with the
  question sets imported from the production modules, on written sample inputs whose answers are not in doubt.
  The report goes to `gui/live/reports/jev-integration-*.json`.
- `DEVPANEL_LIVE=1 npm run live -- --openai-decisions`: the same ONE request as `--jev` to `decisions/openai.yaml`
  through the OpenAI client, whether or not it is active. The report goes to `gui/live/reports/openai-*.json`.
  It needs an API key: once one is placed at `~/.config/openai/key` of the service user, run from `gui/`:
  `DEVPANEL_LIVE=1 npm run live -- --openai-decisions`.
- `npm test -- decisions` includes `decisions.openai.test.mjs`: request and answer translation with a fake
  `fetch`, the selection, and the advisor and availability page with OpenAI active.

## Wiring (`gui/server/decisions/advisor.mjs`, `gui/server/index.js`)

Every caller goes through one advisor. It reads the active provider (`decisions/active.yaml`, else `jev`) under the
configuration root at every ask, so enabling, switching or retuning it needs no restart, and uses the client the
provider's `kind` names (`jev.mjs` or `openai.mjs`). It borrows the top-level
supervisor's spending ledger per ask. That ledger is the file's only writer in the process. Without a provider
file or without the ledger, nothing is asked (`{ skipped }`), and each caller does what it did before. The
test and browser sandboxes copy no `decisions/` directory, so a server they start asks nothing.

## Availability (`/models`, `gui/server/decisions/advisor.mjs`)

The Model availability page has a Decision provider section with one row, the active provider. It shows:

- the endpoint and model, the model version the last answer named, and the threshold
- whether the key is usable (read to check it, never shown)
- the hold state, the last call (outcome, latency, cost) and the calls today and this month from the ledger

The provider shares the host's availability store under the id `decision:<id>`:

- **Hold…** stops every ask until the chosen instant. **Clear** lifts it.
- A rejected key (`auth`) holds the provider with an assumed hold.
- A rate limit with a retry-after holds it for that long.
- While it is held, every caller skips (`{ skipped: 'held' }`) and does what it did without it.
- **Test** (`POST /api/decisions/probe`) makes one short real request on the ledger. It is recorded under
  `issues/.supervisor/decisions/`.

The last call is kept in memory, so it reads "none since the service started" after a restart.

## Triage pre-gate (`gui/server/decisions/pregate.mjs`, questions in `triage-shadow.mjs`)

Before a run whose playbook resolves to the `triage` tactic is reserved, the provider is asked about the issue.
The ask waits at most 15 seconds; after that, or on any failure, the start proceeds.

- **Sent:** the project id, the issue's title, kind and opening date, and every `.md`/`.txt` report filed on it
  (8,000 characters per file, 24,000 in total). The issue's current priority and any `pregate-hold` note are left
  out: the priority is compared against, and the note is the gate's own words.
- **Asked:** `gate` (`continue` / `close-issue` / `needs-input`), `playbook` (the normal catalogue), `priority`
  (`urgent` / `high` / `normal` / `low`), and `duplicateOf` (the project's other issues, open ones first then
  archived ones, at most 254, plus `none`). `duplicateOf` is left out when the project has no other issue.
- **Recorded:** `<issue>/decisions/triage-pregate-<key16>.json`, hard-linked into `runs/<run-id>/decisions/` of
  the run it preceded. The same report is answered from its record. New material is a new question.
- **Hold:** a confident `close-issue` or `needs-input` refuses the start (`409 PREGATE_HOLD`, `started: false`,
  `resolvableBy: operator`, with `pregate.proposals`), before anything is reserved. Only an operator resolves it.
  They can confirm a proposal, or start anyway from the start dialog with a reason (`pregate: { override: true,
  reason }` on `POST …/runs`). The override is kept as `runs/<run-id>/decisions/pregate-override.json`. The
  top-level supervisor has no override. It is told about the hold and reports it.
- **Proposals** (confident answers only, recomputed from the record at confirmation, never taken from the
  request):

  | Proposal | Condition | Applied on confirmation |
  |---|---|---|
  | `close-duplicate` | `duplicateOf` confident and not `none` | disposition `duplicate` with the original in `related`, evidence naming it and the decision |
  | `close` | `gate` confident `close-issue`, no confident duplicate | disposition `not-resolved`, evidence "closed without a run" |
  | `needs-input` | `gate` confident `needs-input` | a `pregate-hold` note asking for the missing facts |
  | `priority` | `priority` confident, and nobody has set one | priority set by the operator, reason citing the decision |
  | `playbook` | `playbook` confident | nothing; advisory, confirmed by starting that playbook |

  A confirmation is written once (`triage-pregate-<key16>.confirm-<proposal>.json`), so confirming again applies
  nothing.
- **API:** `GET …/issues/:id/pregate` (newest assessment, proposals, confirmations; asks nothing),
  `POST …/issues/:id/pregate` (ask now), `POST …/issues/:id/pregate/confirm {key, proposal}`. The issue page's
  Pre-gate panel uses all three.

Agreement: `GET /api/decisions/triage-shadow` sets every record linked into a run beside what actually happened:

| Question | Compared with |
|---|---|
| `gate` | the Triage run's disposition: `accepted` → `continue`, `needs-information` → `needs-input`, `duplicate`/`rejected`/`no-findings` → `close-issue` |
| `duplicateOf` | the issue a `duplicate` disposition linked, otherwise `none` |
| `priority` | the issue's priority in force now, and who set it |
| `playbook` | the first non-triage run started on the issue afterwards |

Only a completed Triage run with a recorded disposition is scored for `gate` and `duplicateOf`. Each rate is
`{ of, total }` over every scored answer and, separately, over the confident ones. Overridden starts carry the
operator's reason. Held starts produce no run, so they appear only as issue-level records and confirmations.

## Wake filter (`gui/server/decisions/wake-filter.mjs`, `top-supervisor.mjs`)

Monitoring events (`run-changed`, `issues-changed`) each cost a supervisor model call. Before one is queued, the
provider is asked `wake` / `defer`, given the operator's latest mission message and a small summary of the event.
A confident `defer` holds the event in `state.deferred`. Held events are attached as `event.deferred` to the next
event that wakes the supervisor, or delivered as a `deferred-events` event once the oldest has waited 15 minutes.
Nothing is dropped. Records go to `issues/.supervisor/decisions/wake-filter-<key16>.json`.

Never asked, always woken: user messages, action results, format repairs, model substitutions, runs that failed,
blocked, paused or were cancelled, runs with a failure, pause or pause request, runs completed with any outcome
other than `resolved`, and any event type the filter does not know.

## Failure second opinion (`gui/server/decisions/failure-advisor.mjs`, `runtime/engine.mjs`)

A failed turn that `runtime/failure.mjs` classifies as `runtime` (no rule matched) is shown to the provider with
its message and output. The only options are `runtime`, `transient` and `rate-limit`: `quota` and `auth` change
host-wide state or need a person, so they stay with the rules. A confident `transient` or `rate-limit` makes the
attempt retryable under the run's own `retryPolicy`, which still bounds how often. The failure record carries
`reclassification { from, to, decision, answer, confidence, threshold }` either way. The record is
`runs/<run-id>/decisions/failure-reclass-<key16>.json`, keyed by the failed invocation, so a replay takes the same
branch. The ask waits at most 15 seconds and is cancelled with the run.

## Rollout

1. This module (done).
2. Triage pre-gate in shadow mode: record Jev's view beside the Triage run's, and measure agreement (done, 2026-09-19).
3. Act on high confidence with an operator confirming (done, 2026-09-19: the pre-gate hold and proposals).
4. Filter supervisor wakes. Failures, operator requests and budget events always wake (done, 2026-09-19).
5. Reclassify `runtime` failures only toward `transient`/`rate-limit`, never toward `quota` or `auth` (done, 2026-09-19).

All five start at the 0.9 threshold. Tune it from the agreement report and the recorded decisions.

## Work-time estimate

The pre-gate request also asks `workTime`, an ordered `score` over seven bands: 5–10 min,
10–20 min, ½–1 h, 1–2 h, 2–3 h, 4–5 h, 6 h+. The question is the hands-on working time an
experienced developer who knows the codebase would need, including verification. The band
descriptions close the gaps between the labels (2–3½ h, 3½–5½ h). The Assess bar shows the
most probable band, and its tooltip shows the spread. The answer is advisory only: it makes
no proposal and gates nothing.
