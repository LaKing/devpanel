# devpanel

devpanel is a self-hosted panel that runs multi-agent *playbooks* against issues filed on the projects of one
host. You file an issue against a project. A playbook then drives agent CLIs (Claude Code, Codex, Gemini CLI)
as a coordinator, an author and one or more auditors. A run ends only when the auditors approved the same
revision, its checks passed and the result was delivered. Otherwise it stops and says why.

The backend is Node 22 with Express 5 and socket.io. The front end is Vue 3 with Vuetify. There is no database:
config written by people is YAML, and state written by the machine is JSON, all in plain files.

Repository: <https://github.com/LaKing/devpanel>

![A project's issues, each with the state of its latest run](docs/images/issues.png)

![Starting a playbook: seats, models and efforts, delivery and limits, previewed before anything is spent](docs/images/start-run.png)

![An issue after a delivered run: the outcome, the steps and the patch](docs/images/issue-run.png)

The screenshots come from an isolated demo instance (example projects, the test suite's fake runtime).

## How it works

- **Issues** are directories: `issues/<project>/<date>-<slug>/`, with numbered step folders and a `runs/`
  folder for each run. A directory's name is its identity, so a folder made by hand still shows up.
- **Playbooks** (`playbooks/*.yaml`) bind a strategy (`strategy-templates/<id>/`: roles, phases, review loops,
  prompts) to participants from the roster, plus budgets, check requirements and closure authority. The normal
  catalogue is Analysis, Triage, Implementation, Plan and implement, Staging and Deployment; see
  [docs/tactical-playbooks.md](docs/tactical-playbooks.md). A playbook is resolved and snapshotted when the run
  starts, so editing YAML never affects a run already in flight.
- **Seats.** The *coordinator* triages the issue, writes acceptance criteria and briefs the other seats. The
  *author* (planner or implementer) writes the plan or the code. *Auditors* review each revision against the
  criteria, usually on a different model from the author. The engine interprets the strategy's phases, and
  model output only ever proposes. A separate top-level supervisor, a single long-lived model session, can
  open issues, preview and start runs, and watch them
  ([docs/top-level-supervisor.md](docs/top-level-supervisor.md)).
- **Isolation.** Each run gets its own git worktree, built from a recorded base commit with private Git
  directories, plus a scratch directory. The project's checkout is not touched while seats work. An optional
  *in-place* mode (`runOptions.isolation: in-place`, a checkbox in the start dialog) runs in the checkout itself.
  In that mode checks are skipped and delivery is recorded as `in-place`.
- **Fingerprints.** A revision is a sha256 over the candidate's full content set, deletions included.
  Approvals, check results and closure all bind to that fingerprint, so any change to the bytes invalidates
  them. Checks rebuild the candidate from base plus patch in a fresh worktree, verify the fingerprint, and then
  run locally or on a configured staging container.
- **Delivery.** An approved, checked revision is delivered by the engine: as a patch kept with the run
  (`worktree-diff`), applied uncommitted to the project's checkout once the destination is verified
  (`apply-to-source`, the default for the coding playbooks), or published as a commit for an operator-approved
  merge (`commit`).
- **Plain files and replay.** The engine never stores a cursor. It derives the next turn by replaying the
  recorded steps, so a crash between persisting a step and advancing is harmless. State is written with
  write-then-rename, and it is persisted before the socket event is emitted.

Details: [docs/execution-contract.md](docs/execution-contract.md) (the normative spec for runs, fingerprints,
reviews, checks and closure), [gui/README.md](gui/README.md) (HTTP and socket API, storage, front end, tests),
[harness/README.md](harness/README.md) (runtime adapters), [docs/project-infrastructure.md](docs/project-infrastructure.md)
(staging and deployment containers), and [CLAUDE.md](CLAUDE.md) (a dense architectural map).

## Requirements

- Linux. The seat fence is bubblewrap (`bwrap`), and the installer also needs `socat`.
- systemd, both for running as a service and for the confined test drives' transient units.
- Node.js >= 22.12 (`gui/package.json` `engines`). To bind port 443 without root, the node binary needs
  `cap_net_bind_service`. Otherwise set `PORT`, for example to 8443.
- git.
- The agent CLIs your roster uses (`claude`, `codex`, `gemini`), installed and logged in as the user that runs
  the panel. The binaries are found through `DEVPANEL_CLAUDE_BIN` / `DEVPANEL_CODEX_BIN`, then `PATH`, then
  `~/.local/bin`.

## Install and quick start

Run everything as the ordinary user who owns the checkout, never as root, except for the steps marked root.

```sh
git clone https://github.com/LaKing/devpanel.git devpanel && cd devpanel
sudo ./install.sh                  # root: install and verify sandbox prerequisites (bubblewrap, socat)
cd gui
./install.sh                       # owner: npm dependencies, self-signed certificate, production build, render the unit
sudo ./install.sh --service        # root: install, enable and start the systemd unit (it runs as the owner)
# or, without a service:
./start.sh                         # production: one process serving dist/ (default port 443)
./start.sh dev                     # development: open the Vite port (5173); it proxies /api and /socket.io
```

On first start the panel writes a random operator token to `.devpanel-token` (mode 0600) at the repository
root. Paste it into the panel when it asks. After changing anything under `gui/server/`, run
`systemctl restart devpanel`.

Before your first paid run:

```sh
cd gui
npm test                                              # every suite; nothing in it reaches a real runtime or spends money
npm run config:check                                  # resolve every playbook offline
npm run config:check -- implementation --preflight    # one playbook in full, probing the installed CLIs
npm run preview -- implementation --issue <project>/<issue-id>   # dry run: reads config only
```

## Configuration

- **Projects.** The panel scans the projects root, `DEVPANEL_PROJECTS_DIR` (default `/srv`, a host-specific default), for
  directories named `<name>-project`. Each one is a project you can file issues against, labelled `<name>`.
  The root and this naming rule are defined once, in `gui/server/project-path.mjs`; the server and the seat
  fence (whose other-project canaries are the root's other entries) both read them from there.
  Alternatively the host settings' `projectDiscovery` (`{ "pattern": "*/*", "markers": ["package.json"] }`) makes every
  matching directory below the root that holds a marker a project, identified by its relative path
  (`2026/shop` → `2026-shop-project`, labelled `2026-shop`); see [docs/host-config.md](docs/host-config.md#host-settings).
  `projects/<id>.yaml`
  is optional: it adds the source repository and integration branch, the workspace policy, the seat tooling,
  staging and deployment infrastructure, and operator actions (`schemas/project.schema.json`).
- **Host configuration.** What belongs to one installation (its project files, roster entries naming a person's
  login, release targets and live-check reports) lives in the git-ignored `host-config/` directory,
  `DEVPANEL_HOST_CONFIG_DIR`. The in-tree files keep working beside it; on the same file name the host-config
  one wins. `examples/host-config/` shows the layout, and `tools/migrate-host-config.mjs` moves an existing
  installation's files there ([docs/host-config.md](docs/host-config.md)).
- **Issues.** They are stored under the issue root, `DEVPANEL_ISSUES_DIR` (default `issues/` at the repository root, which is
  git-ignored host data). It is set on its own and never derived from the projects root.
- **When these are read.** The issue store reads both variables once, when the server loads; the run supervisor
  reads `DEVPANEL_PROJECTS_DIR` at load and takes the issue root from the issue store. Other readers read them on each use. Set them before starting the panel and restart it after changing them.
- **Host overrides.** Without touching the tracked defaults, `host-config/` can replace a playbook
  (`host-config/playbooks/<id>.yaml`), leave out a runtime the host does not have (`harnesses.disabled`),
  bind a toolchain under the home into the seat fence (`fence.readOnly: ["~/.nvm"]`) and exempt directories
  inside the home from the forbidden-root rule (`selection.allowedHomePaths`), keep the panel's data outside the checkout
  (`dataRoot`) and keep its snapshots, refs and candidate branches out of the project repositories (`gitStore`), and give runs the content
  of repositories nested in a monorepo instead of empty gitlinks (`nestedRepositories: "include"`);
  see [docs/host-config.md](docs/host-config.md).
- **Roster.** `roster/*.yaml` lists one concrete model per file, bound to a harness, with its supported
  `efforts` and `verification.status`. Unverified entries resolve for preview but are refused for live runs.
  The paid `npm run live` checks are how an entry gets verified.
- **Playbooks and strategies.** These live in `playbooks/*.yaml` and `strategy-templates/<id>/`. Every layer is
  validated against `schemas/*.schema.json`.
- **Decisions.** `decisions/*.yaml` configures an optional advisory decision provider ([docs/decisions.md](docs/decisions.md)).
- **Environment.** `PORT`, `HOST`, `DEVPANEL_TLS` and the other server variables are listed in
  [gui/README.md](gui/README.md#environment).

## Security model

- **Seat fence.** Each Claude, Codex and Gemini seat turn runs inside a bubblewrap allow-list namespace that
  holds only the run's paths, the CLI's install and its config directory. The fence is proved before launch.
  Seats get an allow-listed environment, and only the author may write. Gemini seats also get an admin-tier
  policy file inside that fence. A turn whose fence cannot be proved is refused. It runs unfenced, recorded as
  `namespace: 0`, only when an operator sets `DEVPANEL_FENCE_UNPROVED=run`. `DEVPANEL_FENCE=off` switches the
  fence off altogether. An *in-place* run is not fenced either: its workspace is the live checkout, and each
  step records the fence as skipped. See [harness/README.md](harness/README.md).
- **Authentication.** The API and socket require the operator token from `.devpanel-token` (or `DEVPANEL_TOKEN`).
  It is compared in constant time and kept in the browser's sessionStorage only. Two alternatives exist:
  a reverse-proxy basic-auth login verified against the proxy's users directory (host settings' `proxyLogin`),
  and, on a single-user install bound to loopback, `DEVPANEL_AUTH=local`. One tokenless route,
  `POST /api/report/:project`, lets a private-network peer open an issue and do nothing more.
- **Credentials are referenced, never stored.** Roster entries name credentials by reference (`env:NAME`,
  `file:/path`, `keyring:NAME`). Values are never written to configuration, logs or run metadata. Per-person
  logins (`account`) get isolated CLI config directories.

## Limitations

- **macOS has no seat fence.** `install-on-osx.sh` installs a per-user launchd agent with `DEVPANEL_AUTH=local`.
  macOS has no bubblewrap, so by default the panel refuses seat turns, tooling commands and local checks there,
  naming macOS. Unfenced operation is an explicit per-install opt-in: `DEVPANEL_UNFENCED=acknowledged bash
  install-on-osx.sh` (kept across reinstalls; `DEVPANEL_UNFENCED=no` withdraws it). Opted in, seats are confined
  only by the CLIs' own sandboxes and permission rules; every run records it (`unfenced`, namespace 0, local checks
  `local-unconfined`, tooling commands unconfined, in `result.md` too) and the panel shows it on every page. Gemini
  seats are refused on macOS, and a project that declares tooling mounts cannot run there (nothing binds them).
  Under `DEVPANEL_AUTH=local` every local process is the operator, unfenced seats and the code they run included:
  they can start runs, answer questions and deliver through the API. It is refused unless `HOST` is loopback. The script needs
  `DEVPANEL_SOURCE`, the rsync source of a panel checkout, and never syncs the Mac's own `projects/`,
  `host-config/`, issues or token. [docs/macos.md](docs/macos.md) is the whole account, with the Mac proof checklist.
- **The default seats are one choice of models.** The roster and playbook participants name the models the
  panel was developed with. Review them, and put your own projects, release targets and settings in
  `host-config/`, before running anything that spends money or touches a container; the generic examples are in
  `examples/host-config/` ([docs/host-config.md](docs/host-config.md)).
- Live model checks (`npm run live`) are paid and refuse without `DEVPANEL_LIVE=1`. The top-level supervisor
  runs on Claude or Codex only, and Gemini reports no cost, so its runs are unpriced.

## Measuring how runs go

To take a dated measurement on your own panel, run from `gui/`:

```sh
npm run --silent overview > overview-$(date -u +%F).json                 # every project, archived history included
npm run --silent overview -- --project devpanel-project > overview.json  # one project; --project repeats
```

`tools/overview.mjs` prints, as JSON, the same overview the top-level supervisor reads (`buildOverview` in
`server/supervisor-overview.mjs`). It only reads: it starts no session or run, spends nothing and writes no file,
and it works without the service running (it reads `DEVPANEL_PROJECTS_DIR` and `DEVPANEL_ISSUES_DIR`, as the server
does). Quote a figure together with two fields of the same output:

- `generatedAt`: when the reading was taken. Runs and dispositions keep changing, so a figure without it is not
  a measurement.
- `scope`: what was read. That is the projects (`projects`, and `selected`: `all` or `named`), the projects root,
  the issue store and `archived: "included"`, because runs under archived issues, packed ones included, are
  counted.

Each rate (`totals.runs.successRate`, `deliveryRate`, `issues.resolutionRate`, and the same per project, per
playbook configuration in `byPlaybook` and per seat in `bySeat`) carries `of`, `total`, `percent` and `means`,
its definition. With no population, `total` is 0 and `percent` is `null` (no data), never 0%. Live and paused
runs are counted but kept out of every denominator.

Definitions, as the engine states them:

- *success*: "runs that completed AND resolved, over runs that reached a terminal state; live and paused runs
  are excluded".
- *delivery*: "terminal runs whose candidate reached its destination, delivered by the engine or landed by hand
  (counted apart in engine and manual), over runs that reached a terminal state".
- *resolution*: "issues explicitly dispositioned 'resolved', over issues given any disposition; issues nobody
  has decided are not counted either way".

**Completed, delivered and resolved are three different things.** A completed run may still end unresolved,
and an issue counts as resolved only once someone records that disposition. Read a run's result, not its
status, and record a disposition on the issue yourself.

**"Blocked" is not a crash.** Blocked means the engine refused to close: a check failed, the auditors did not
approve the same revision, or the rounds ran out. The candidate is retained, and the panel offers *Continue*,
*refresh checks* or *finalize* where they apply.

**Compare like with like.** Panel totals mix every playbook configuration a panel has ever run; compare the
groups of one `configHash` (`byPlaybook`), and treat any group under about 10 runs as an anecdote.

**Check readiness before you spend.** A run that ends within seconds with no agent time failed at launch. Run
`npm run config:check -- <playbook> --preflight` and `npm run preview` first.

## Version

The canonical version is the root `version` file. `gui/package.json` still says `0.1.0`, the value versioning
started from, and is not updated, so the two differ.

## License

Copyright © 2026 LaKing@D250.hu

devpanel is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE).

Much of the code was written with AI coding agents (Claude Code and Codex) under human direction and review;
the providers' terms assign their output to the user, who publishes it under this licence.

devpanel has been developed with devpanel: many of its features and fixes were filed as issues on its own
project and carried out by its own playbooks (coordinator, author and auditors in isolated worktrees), then
reviewed, tested and committed by its maintainer.
