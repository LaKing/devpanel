# Event journal integrity

`readEvents(issuePath, runId)` returns an object containing `events`, `status`,
`complete`, `recoveryRequired`, `stoppedAt`, and `message`. Callers must check
completeness; the event array alone is not execution authority. The run API keeps
its `events` array for the timeline and exposes the accompanying `journal`
diagnostic and overall `recovery.required`. The UI displays a recovery alert.

Only the contiguous prefix of valid, newline-terminated event objects is returned.
Interpretation stops at the first problem; later lines are never skipped into the
history. `stoppedAt.line` is one-based and `byteOffset` is zero-based, measured in
UTF-8 bytes. Neither inspection nor refusal rewrites the original journal.

- `complete`: all records were readable and delimited, with no recovery finding.
  A newly initialized empty journal is valid.
- `incomplete-tail`: the final append lacks its newline, including JSON that ends
  prematurely. This describes the bytes, not proof that a harmless crash occurred.
- `corrupt-record`: a malformed, invalid UTF-8, blank, or non-event delimited record.
  Valid records after that point are excluded.
- `corrupt-tail`: malformed final bytes that cannot be classified as incomplete JSON.
- `missing` / `unreadable`: missing storage or an I/O failure, distinct from an empty
  journal.

Every incomplete or corrupt result requires recovery, including an incomplete final
append. A separate `journal-recovery.json` finding survives restarts and subsequent
journal edits. If the journal later parses successfully, `status` may describe
complete bytes while `complete` remains false and `recoveryRequired` remains true;
`finding` preserves the original diagnostic. Failures reading or persisting this
finding are explicit and do not authorize execution. The finding is written only into
a run directory that still exists: a read that outlives its issue being packed or
deleted reports a persistence failure and never brings the folder back.

The engine checks the journal before driving, recovering a turn, invoking an agent,
accepting a turn, persisting transitions, or evaluating delivery. Appending events,
integration and integration reconciliation also refuse an unresolved finding.
Workspace cleanup retains the candidate, and starting another run on the same
issue cannot bypass the finding.

There is deliberately no automatic truncation, replay, or one-click acknowledgement.
Recovery requires offline investigation with the run stopped: preserve the original
journal and finding, and reconcile missing evidence against invocation ledgers,
outputs, approvals, source state and delivery receipts. A readable prefix alone
cannot establish turn ownership or delivery authority. General forensic repair still requires reconciling the underlying evidence; no generic acknowledgement or journal rewrite is provided. Source-integrity recovery does not clear
an event-journal finding.

## Retiring a legacy failure before execution

A narrow operator command can retire a historical run which failed the `head`
base-policy check before any workspace or agent turn existed:

```sh
node gui/server/runtime/legacy-journal-cli.mjs /absolute/path/to/issue RUN_ID --reason "Evidence reviewed: pre-workspace base-policy failure"
```

The issue lock must be available. The command checks the original failed run,
zero turns and sessions, empty revisions/approvals/checks/artifacts, and absence
of workspace, release, delivery, or integrity activity. Unexpected files or any
journal other than a missing-journal finding are refused. Preflight probe records
and costs remain part of the untouched original run.

It writes a separate `legacy-journal-disposition.json` with hashes of all original
files. It never fabricates events or clears the original recovery finding. The old
run remains non-resumable, but no longer prevents starting a new run on the issue.
Changed evidence invalidates retirement and requires recovery again.
