---
name: devpanel
description: Hand a task to devpanel and follow it up — write an issue an autonomous multi-agent run can finish, open it, read its status, triage questions and result (result.md, changes.patch), add notes. Use when a task is devpanel-sized (general §007), when the user says to open or check a devpanel issue, or asks what a run did. Not for starting runs.
---

# devpanel

devpanel runs playbooks (Analysis, Triage, Implementation, Plan and implement, Staging, Deployment) on issues of the `*-project` projects (in the panel's projects root, `~/projects` on a Mac install). The rules are general §007, §008 and §010; this skill is the procedure and the client.

The client is `devpanel.mjs` beside this file (`~/.claude/skills/devpanel/devpanel.mjs`; run it directly). It finds the panel from its own location: on a Linux host the checkout this skill is linked from, `https://localhost:443`, and the token, which only the panel's owner can read (in the host's `dataRoot` when it has one); on a Mac `~/devpanel`, the address in `~/devpanel/.devpanel-url`, and no token needed (`DEVPANEL_AUTH=local`). `DEVPANEL_URL` and `DEVPANEL_TOKEN` override. The project defaults to the one the working directory is in: with the host settings' `projectDiscovery`, the matching directory below the projects root (`2026/shop` is `2026-shop-project`), otherwise the nearest `*-project` directory above it; `-p <name>` picks another, with or without `-project`. An issue id may be a unique prefix or slug fragment.

```sh
devpanel.mjs open issue.md            # or: ... open - <<'EOF'
devpanel.mjs list
devpanel.mjs status <id>              # latest run explained, unmet goals, triage questions with ids
devpanel.mjs result <id>              # result.md of the latest run, link to changes.patch
devpanel.mjs note <id> note.md        # context the next run will read
devpanel.mjs answer <id> answer.json  # RESTARTS the run — see below
devpanel.mjs preview <id> <playbook>  # what a start would run (free)
devpanel.mjs start <id> <playbook>    # paid; only when the user asks — see below
devpanel.mjs watch [<id>] [--until-settled]  # run events as they happen; exits when the run settles
```

## Writing the issue

A run asks questions only at triage, before any work; every later decision is an agent's assumption. What the issue does not say, the agents guess. So the issue carries everything the conversation established. Write it in English (it is a project file), as markdown with one `# Title` heading:

```markdown
# <imperative title: what changes>

## Goal
What should be true afterwards, and why it matters.

## Context
What the conversation found: the cause if known, files and lines (absolute paths), commands and their output, what was already tried and ruled out.

## Acceptance criteria
- Checkable statements. Each one a reviewer can verify from the diff, a test or a command.

## Out of scope
What not to touch, and tempting neighbouring changes to leave alone.

## Decisions already made
Choices the user made, so the run does not re-open them. Constraints (compatibility, no new dependency, ...).

## Verification
How to prove it: the test suite, a selftest, a staging check, a command and its expected output.
```

- One issue is one deliverable. Several unrelated changes are several issues; a run told to do three things tends to finish two.
- Facts and assumptions stay separate: say which statements were verified and which are suspicions.
- Leave out conversation history and politeness; the agents read every word.
- Write the markdown to the scratchpad, open it, then delete the file.

After opening, tell the user the issue id and the link the client prints.

## Starting a run

A run spends money, so it starts only when the user asks for it in this conversation; otherwise the operator starts it in the panel (or the top-level supervisor does). On the user's word:

```sh
devpanel.mjs preview <id> <playbook>   # free: checks, rounds, budgets, delivery, prerequisites
devpanel.mjs start <id> <playbook>     # previews again, refuses a blocking prerequisite, starts that exact configuration
```

Playbooks: `analysis`, `triage`, `implementation`, `plan-and-implement`, `staging`, `deployment`. Pick the one that fits and say which. Relay the preview's checks and budget lines with the run id. A production `deployment` still needs the operator's explicit instruction (general §010).

## Following up

`watch <id> --until-settled` prints one line per run event over the panel's socket and exits when the issue's run finishes, pauses or stops (immediately if it already has), so a long run can be waited for without polling; without an id it follows every run of the project.

`status` shows the latest run's own explanation (`headline`, `detail`, `unmet` goals, `next`). Relay it, don't re-judge it: an unmet goal is the coordinator's evidence, quoted. `result` prints `result.md`; a delivered patch has already been applied to the development checkout, uncommitted (general §007), so `git diff` in that project shows it. Committing is the operator's checkpoint (general §009).

A note (`note`) is how to add what the user learned since: the next run reads every note on the issue. Use it for corrections and answers given outside triage.

## Triage questions

When triage judged the issue not autonomous, the run ended with questions (`needs-owner-input`) or a proposed split (`too-large`); `status` lists them with their ids and recommendations.

Answering is the owner's decision, and the server then **starts the same playbook again** (a paid run), unless a split was accepted, which opens the parts as new issues. So `answer` runs only when the user gave the answers and said to send them. Put the user's words in, not the model's:

```json
{ "actor": "<the user's name>", "answers": { "Q1": "...", "Q2": "..." }, "note": "optional" }
{ "actor": "<the user's name>", "split": "accept" }
```

If the user would rather not restart now, add the answers as a `note` instead; the next run started from the panel reads them.

## When the client fails

- `devpanel unreachable`: the service is down. On the hosts restarting it needs root (`systemctl restart devpanel`), the operator runs it; on a Mac, `bash ~/devpanel/install-on-osx.sh` restarts it.
- `401`: the token changed or is unreadable; never print or copy the token anywhere.
- `409` on an archived issue: it is packed; restoring is an operator action in the panel.
- The full API is in `gui/README.md` of the panel's checkout.
