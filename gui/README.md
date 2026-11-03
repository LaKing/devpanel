# devpanel — GUI

The panel itself: a Node backend (Express 5 + socket.io) that stores issues, runs
playbooks through the phase interpreter and streams run events and host metrics,
and a Vue 3 + Vuetify front end that renders them.

## Running it

```sh
./install.sh     # once — dependencies, certificate, production build
./start.sh       # production: one process serving the built app  → https://<host>
./start.sh dev   # development: Vite + API with live reload       → https://<host>:5173
```

**Run both as the project owner (the user that owns the checkout), never as root.**
Port 443 works unprivileged because the node binary carries `cap_net_bind_service`
(`getcap` it to confirm) — the process itself stays an ordinary process of that
user with no elevated rights.

The GUI build mode refuses root to avoid root-owned `node_modules/`. The
`--service` and `--sandbox` modes require root. The repository-level `install.sh`
defaults to sandbox setup and is also intended to run as root.

In dev mode open the **Vite** port (5173), not the API port — Vite proxies `/api`
and `/socket.io` through to the backend, and it is the one that hot-reloads.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `443` | API / production app port |
| `HOST` | `0.0.0.0` | bind address — set `127.0.0.1` to restrict to this machine |
| `DEVPANEL_DEV_PORT` | `5173` | Vite dev server port (dev only) |
| `DEVPANEL_TICK_MS` | `2000` | how often metrics are broadcast |
| `DEVPANEL_TLS` | on | set `0` to serve plain HTTP |
| `DEVPANEL_CERT_DIR` | `../cert` | where `localhost.crt` / `localhost.key` live |
| `DEVPANEL_DEV_ORIGINS` | localhost:5173, 127.0.0.1:5173 | origins socket.io accepts in dev |
| `DEVPANEL_ISSUES_DIR` | `../issues` | the issue root: where issue folders are created; independent of the projects root |
| `DEVPANEL_PROJECTS_DIR` | the host settings' `projectsRoot`, else the directory holding the panel's checkout | the projects root (`<projects-root>`): scanned for `<name>-project` directories (labelled `<name>`) |
| `DEVPANEL_USERS_DIR` | the host settings' `proxyLogin.usersDir`, else none | the reverse proxy's users directory, where basic-auth logins are verified |
| `DEVPANEL_HOST_CONFIG_DIR` | `<config root>/host-config` | the installation's own configuration ([docs/host-config.md](../docs/host-config.md)) |

The projects root and the `-project` naming rule are defined once, in `server/project-path.mjs`, which the
server and `harness/fence.mjs` (other-project canaries) import. The issue store (`issues.js`) reads
`DEVPANEL_PROJECTS_DIR` / `DEVPANEL_ISSUES_DIR` once, at load; the run supervisor reads `DEVPANEL_PROJECTS_DIR`
at load and takes the issue root from the issue store; other readers read them on each use. Set
both before the server starts, and restart after changing them.

## Running it as a service

`install.sh` renders a unit from `systemd/devpanel.service.in` and installs it.
Writing into `/etc/systemd/system` is the one step that needs root; everything
else — dependencies, certificate, build — runs as the project's owner, and the
service it installs runs the panel as that owner too, never as root.

```
./install.sh                     # as the owner: deps, cert, build, render the unit
sudo ./install.sh --service      # as root: install, enable and start it
```

Root service installation also installs and verifies Claude sandbox prerequisites.
For sandbox setup alone, run `<panel checkout>/install.sh` as root (or
`./install.sh --sandbox` from this directory). It installs missing `bubblewrap`
and `socat` packages, and on systemd-nspawn installs/enables
`run-devpanel-proc.mount` plus a devpanel service dependency. Existing manual proc
mounts are supported. Re-running is safe. The check runs Bubblewrap as the service
user without making model calls; `DEVPANEL_USER` can explicitly select that account.
Sandbox-only setup does not build the GUI or restart the running panel.

Run as a non-root user, `--service` renders the unit and prints the three
commands to run as root rather than failing. The user and group come from who
owns the project directory, not from who ran the installer — under `sudo` the
latter is root, which is exactly wrong.

Afterwards:

```
systemctl restart devpanel      # pick up server-side changes
systemctl status devpanel
journalctl -u devpanel -f       # the log
```

**`systemctl restart devpanel` is how server changes take effect.** The browser
re-reads `dist/` on every visit, but Node loads `server/` once at startup, so a
rebuilt front end can be served by a back end from hours earlier — a page calling
routes the running process has never heard of. The panel detects that and says so
(see *Staleness*, below), but restarting is the fix.

Two details in the unit are load-bearing:

- **`TimeoutStopSec=45` against `DEVPANEL_SHUTDOWN_GRACE_MS=20000`.** SIGTERM runs
  the supervisor's shutdown — stop every run it is driving, wait for the runtimes
  to confirm termination, then exit. If systemd's timeout were the shorter of the
  two it would SIGKILL part-way through, and those runs would come back needing
  recovery: the exact state the shutdown path exists to prevent.
- **No `NoNewPrivileges=yes`.** Port 443 is reached through `cap_net_bind_service`
  on the node binary, and `NoNewPrivileges` blocks that class of capability. The
  alternative, `AmbientCapabilities`, would hand the capability to every agent
  process the panel spawns, which is worse for a smaller gain.

`start.sh` refuses to run when the service is active, or when another panel is
already running — starting a second copy is how you end up with several processes
and one port, with the browser talking to whichever won the bind.

## Staleness

The server compares the mtimes of its own sources against its start time and
reports the result in the metrics it already broadcasts. When the code on disk is
newer than the process serving it, the panel shows a standing banner, and any
unmatched `/api` path answers in JSON saying so rather than with Express's HTML
"Cannot DELETE /api/…", which names no cause at all.

## HTTPS

`./make-cert.sh` writes a self-signed certificate to `<project>/cert/`
(`localhost.crt` and `localhost.key`). It covers `localhost`, the
host's FQDN and short name, and every IP the host answers on, so the same
certificate works however you reach the panel. `install.sh` and `start.sh` both
call it automatically when no certificate is present; pass `--force` to replace
one that is still valid.

Browsers will warn once — the certificate is self-signed, so nothing vouches for
it. That is expected for a development panel. To use a real certificate instead,
point `DEVPANEL_TLS_CERT` and `DEVPANEL_TLS_KEY` at it.

The key is `chmod 600` and `cert/` is git-ignored — it must never be committed.

> **Authentication is a shared operator token.** Every `/api` route and the socket
> handshake require it (`server/auth.mjs`); the browser keeps it in sessionStorage
> only. It is sent as `X-Devpanel-Token` (the browser) or `Authorization: Bearer`
> (direct clients): `Authorization` is left free so a basic-auth reverse proxy in front
> keeps working. With the default `HOST=0.0.0.0` the login page is reachable from the
> network; set `HOST=127.0.0.1` to keep the panel on the loopback interface.
>
> **A verified proxy login stands in for the token.** Behind that proxy the browser's
> Basic header reaches the panel unchanged. The panel does not trust it for where it came
> from: it checks the password against the users directory the proxy publishes read-only,
> `<usersDir>/<u>/`, where each digest file holds the SHA-512 hex of a password that admits
> the user (`.hash` by default; the host settings' `proxyLogin.digestFiles` names others) and
> a plaintext `.password` counts too — any one admits (`server/proxy-user.mjs`; the directory is
> `DEVPANEL_USERS_DIR`, else the host settings' `proxyLogin.usersDir`). A refused login is
> logged with a reason code only; `node tools/check-proxy-login.mjs <user>` runs the same
> check from a terminal. A verified login
> admits the API and the socket like the token, so a person behind the proxy never sees
> the token page. Its username is the actor of every request: it replaces any `actor` a
> body sends and the hardcoded `operator` of project actions, pre-gate confirmations and
> integrity decisions. `GET /api/whoami` returns `{user, verified}`; the panel hides its
> "Your name" fields and shows `devpanel - <user>` in the drawer. Without the users
> directory the name is read unverified, for attribution only, and the token is required.
> Direct clients (the devpanel skill, tests) keep using the token.
>
> **A local single-user install may drop the token** (`DEVPANEL_AUTH=local`, set by
> `install-on-osx.sh`; `server/local-login.mjs`). The server refuses to start with it unless
> `HOST` is loopback. A request whose `Host` is the loopback address and port, whose `Origin`
> (if sent) is the same, and whose `Sec-Fetch-Site` (if sent) is `same-origin` or `none` is
> admitted as a verified login of the account running the panel, API and socket alike; the
> token still works for everything else. This blocks web pages (DNS rebinding, cross-site
> requests), not local processes: every local process, agents included, is an operator. It is
> meant for an install without the seat fence, where the agents could read the token anyway.
> **The risk:** on a macOS install that opted in to unfenced seats (`DEVPANEL_UNFENCED=acknowledged`),
> a seat or the candidate code it runs can call this API as the operator: start runs, answer
> questions, deliver. Without the opt-in seats are refused there. `GET /api/info` and the socket
> `hello` carry `host.fence` (`{mode: fence|off|unfenced|refused, reason}`); the panel shows
> `unfenced` and `refused` as a banner on every page, and a run that ran unfenced carries
> `unfenced` (an "unfenced" chip on the issue page, a section in `result.md`).
> `GET /api/health` (public) also returns `tokenFile`, the token's path with the home shown as `~`.
> `GET /api/info` and `hello` also carry `host.directories` (`{projects, issues}`, the home shown as `~`):
> the projects root and the issues directory (`DEVPANEL_ISSUES_DIR`, its own setting, never derived from
> the projects root), which the drawer's re-scan button, the issue-list footer and the path placeholders show.
>
> **Reporting from a project's deployment.** `POST /api/report/:project {input, kind?, category?}`
> needs no token (`server/report.mjs`, mounted before the gate). It opens an issue and
> does nothing else: no run starts, nothing is read back, the answer is `{project, id, trust}`.
> Allowed peers have a private address (10/8, 172.16/12, 192.168/16, fc00::/7) and no
> `X-Forwarded-For` header, i.e. a sibling container reaching `https://<panel ip>/` directly;
> a reverse proxy sets that header (`option forwardfor`) and behind it is the internet.
> The panel's own addresses and loopback are refused, so seats and code under test still
> need the token. Input is always report text: a single line becomes a heading, never a
> local `.md` path as on the token route. 256 KB each; at most 20 per reporter (or, without
> a key, per address) per 10 minutes.
>
> **Trust.** With `X-Devpanel-Reporter-Key` the report is a named reporter's
> (`server/reporters.mjs`); `kind: fault` (default) is the deployment's own error, warning or
> crash report, `kind: request` a person relayed by an assistant; `category` is one of `bug`,
> `feature`, `error`, `warning`, `crash`. Without a key it is `anonymous`, whatever it claims;
> a key that matches nothing, or another project's reporter, is refused (403), not downgraded.
> The issue records `report: {kind, category, reporter, trust}` and `openedBy` is
> `<reporter>@<host>` (or `report@<host>`). The trust bounds the **top-level supervisor**
> only, read at start time from the current reporter record: `anonymous` → it starts
> nothing; `request` → by default only `triage` or `analysis` (a person's feature request is
> never implemented automatically); `fault` → by default any playbook. Levels per reporter:
> `none`, `assess` (triage/analysis), `any`. An operator in the panel is never bound by it.
> Reporters are kept as key hashes in `issues/.reporters.json` (0600, git-ignored), managed
> with `node tools/reporter.mjs list | add <name> <project> [--fault L] [--request L] |
> policy <name> … | remove <name>`; `add` prints the key once, for the deployment's secrets.
> A Boilerplate deployment is connected in one step with `node tools/provision-reporter.mjs
> <name> <project> <ssh-target> <root> [--fault L] [--request L]`: it creates the reporter,
> writes `<root>/secrets/devpanel-reporter.json {key}` and `<root>/config/devpanel-reporter.json
> {url, project}` over SSH (stdin, never the command line), and proves the key from the
> deployment with an empty report (400 = accepted, no issue opened). Its `--url` is the panel's
> private address, else the host settings' `reporter.panelUrl`. Give a production deployment
> fault `any` and a staging one fault `assess` (staging runs candidate code, whose provoked
> errors must not start implementation).
> From a container: `curl -sk -X POST https://<panel ip>/api/report/<project>-project -H 'Content-Type: application/json' -H 'X-Devpanel-Reporter-Key: <key>' -d '{"input":"# Title\n\nWhat happened","kind":"fault","category":"error"}'`

## Layout

```
gui/
├── install.sh            dependencies, certificate, build, systemd service
├── start.sh              run in production or dev mode (by hand)
├── systemd/
│   └── devpanel.service.in   unit template, rendered by install.sh
├── make-cert.sh          generate the self-signed certificate
├── vite.config.js        build config; dev proxy and dev TLS follow PORT/HOST
├── server/
│   ├── index.js          Express 5 + socket.io over TLS; serves dist/ in production
│   ├── auth.mjs          the bearer token: loading, checking, socket handshake
│   ├── staleness.mjs     is this process running the code on disk?
│   ├── metrics.js        host sampling (CPU deltas, memory, uptime)
│   ├── issues.js         directory-backed, project-scoped issue storage
│   ├── runs-api.mjs      read-only run views, assembled from persisted state
│   ├── supervisor.mjs    run lifecycle: start, stop, one run per issue
│   ├── config/           playbook resolution, preflight, the config:check CLI
│   └── runtime/          engine, store, launch, locks, fingerprints, preview
├── live/                 the paid live checks — opt-in, never run by npm test
├── tools/
│   └── install-browser.sh  fetches a headless Chromium into .browser/
├── test/
│   ├── run.mjs           the runner: `npm test [filter]`
│   ├── fakes/            scripted harness, fixtures, fake CLIs
│   └── browser/          the staged server, the jsdom page, the Chromium page
└── src/
    ├── main.js           app entry
    ├── App.vue           shell: app bar (+ #appbar-actions slot), nav drawer, outlet
    ├── router.js         routes; meta.title drives the app-bar heading
    ├── auth.js           the operator's token, in sessionStorage — never in a URL
    ├── socket.js         the one socket + shared reactive `connection` state
    ├── format.js         bytes / duration / relative-time helpers
    ├── plugins/
    │   ├── vuetify.js    light + dark themes, component defaults
    │   └── icons.js      the bundled icon set — add new icons here
    ├── api.js            fetch helper for the REST endpoints
    ├── projects.js       the shared project list feeding the drawer
    ├── components/       StatTile, ConnectionBadge, ActiveAgents, RunTimeline,
    │                     TurnDetail, StartRunDialog
    └── views/            DashboardView, ProjectIssuesView, IssueView,
                          SignInView, NotFoundView
```

## Issues

Use **Archive issue** in the issue page's app bar to remove an issue from active
lists. The confirmation keeps all responses, run metadata, artifacts, and retained
workspaces. **Archived issues** on the project page lists them; open one to inspect
its history or **Restore issue**. Active runs must be stopped and uncertain runs
reconciled before archiving.

Archiving writes `.archive.json` in the issue directory and preserves every
existing file at its original path. This keeps Git worktree and native-session
references intact. Archived issues reject new runs and steps. The authenticated
API exposes `POST /api/projects/:project/issues/:id/archive`, the matching
`/restore` endpoint, and `GET /api/projects/:project/issues?archived=true`.

Every issue is opened against the **host project** it was discovered in, and
storage mirrors that — plain directories, no database:

```
<panel checkout>/issues/
└── devpanel-project/                    the host project
    └── 2026-09-10-tls-cert-renewal/     the issue
        ├── issue.json                   { name, slug, project, openedOn, openedAt }
        ├── 000-report/                  a step
        │   ├── notes.md
        │   └── capture.bin
        ├── 001-investigate/
        │   └── openssl.log
        └── 002-apply-the-fix/
```

Three nested directories, three levels of navigation:

| Route | Shows |
|---|---|
| `/projects/:project` | that project's issues |
| `/projects/:project/:id` | one issue and its steps |

Projects themselves are the drawer, not a route.

**The navigation drawer lists every `<projects-root>/*-project`**, one entry each — the
projects themselves, not a link to a list of them. The project set comes from the
filesystem, so it is known up front; a project carrying issues shows its count,
one with none is dimmed and countless.

The `Projects` heading carries a re-scan button that re-reads the projects root, picking up
a project added on disk and dropping one removed. `GET /api/projects` scans on
every call, so the reload buttons on the issue pages re-scan too. Counts also
refresh on their own when `issues:changed` arrives, including from another
browser.

Because every project is one click away in the drawer, an issue can be filed
against any of them directly and there is no separate overview page —
`/projects` redirects to the dashboard.

Directory names, not `issue.json`, hold the identity: `<YYYY-MM-DD>-<slug>` for
an issue, `<NNN>-<slug>` for a step. So both sort correctly by name alone, a
folder created by hand still appears (marked *folder only*), and a corrupt
`issue.json` degrades the same way rather than hiding the issue.

Everything a step produced goes in its folder — notes, logs, patches. The panel
lists those files with their sizes; it does not manage them.

**Host project and name are both required**, for issues and for steps. Names are
slugified to `[a-z0-9-]`, so none can escape its directory. The project from a
URL is validated against the actual `<projects-root>/*-project` directories, so a request
can neither invent one nor walk out of the issues tree.

**Uniqueness is scoped to the project** — the same issue name may exist under two
projects, but not twice under one on the same day. `mkdir` itself enforces it: a
collision returns 409, with no lock and no race.

**Step numbering** continues from the highest existing step rather than counting
them, so deleting `001` by hand does not make the next step collide with `002`.

| Endpoint | Purpose |
|---|---|
| `GET /api/projects` | re-scans `/srv` — every `*-project`, each with its issue count |
| `GET /api/projects/:project/issues` | that project's issues, newest first; each with `family` (`server/issue-family.mjs`): `parent` (`openedBy.from`, `known: false` when it is in no folder and no bundle), `children`, `openChildren`, `waitingOn` (unsettled prerequisites; one in another project is `unknown`) and `blocks`. The list page nests children under their parent (`src/issue-tree.js`) while no column sort is set |
| `POST /api/projects/:project/issues` | open one — `{ name }` |
| `POST /api/report/:project` | **no token**, private network only: open one from a project's container — `{ input }` (Markdown, always text), answers `{ project, id }` only; see the notes under "HTTPS" |
| `GET /api/projects/:project/issues/:id` | one issue with its steps and files |
| `GET /api/projects/:project/issues/:id/family` | `{parent, children, dependsOn, dependsOnReason, blocks}`, each member `{project, id, name, disposition, archived, packed, settled, run}` (packed issues included; an unreadable one `missing: true`). Provenance and order stay separate: a parent is not a prerequisite |
| `POST /api/projects/:project/issues/:id/steps` | add the next step — `{ name }` |
| `GET /api/projects/:project/issues/:id/runs/:runId` | one run in full; `actions` lists what the run's state admits now, from the functions that admit them (`supportedActions` is the same list under its older name; a listed action can still be refused for what only the call shows: the workspace changed, a budget, a busy project); `metrics` (`runtime/run-metrics.mjs`) holds `time` (`agentMs`, `operatorWaitMs`, `suspendedMs`, `checksMs` = the union of every recorded check run's own interval with overlap counted once, `waitingForChecksMs` = check time while no seat turn ran, a turn still in flight included, `otherMs` without it), `rounds`, `findings`, `closureReturns` and `regressionsAfterApproval` (checks that failed, inherited failures included, or whose baseline comparison named new failures, on a revision already approved when they began; `regressionsBasis` says whether an older record made it partly inferred); `landed` is the manual landing record, or null |
| `GET /api/projects/:project/issues/:id/runs/:runId/live/:invocationId` | the runtime's raw output for one turn, `?after=<seq>` to continue |
| `GET /api/projects/:project/actions` | the project's operator actions (`checkpoint` when `checkpoint.sh` exists, plus `projects/<id>.yaml` `actions`), each with its declared `effect` (only `commit-checkout`, or null) and last operation |
| `POST /api/projects/:project/actions/:action` | start one on the live checkout — `202 { operation }`; output streams as `project:action` socket events |
| `GET /api/projects/:project/actions/operations/:operationId` | the operation record and its output, `?after=<seq>` to continue |
| `POST /api/projects/:project/actions/operations/:operationId/stop` | terminate a running operation's process group and confirm it |
| `GET /api/playbooks` | every playbook with its strategy, default `intent` and available `intents` |
| `POST /api/projects/:project/issues/:id/disposition` | record the issue's state with evidence — `{ value, evidence, runId?, related?, override?, acceptRisks? }`. `acceptRisks: [{id \| text, reason}]` accepts residual risks listed under `unacceptedRisks` (on the issue and in a run's `explanation`) in the same atomic write; any refusal records nothing |
| `POST /api/projects/:project/issues/:id/priority` | record where the issue sits in the execution order — `{ value, reason }`, value `urgent\|high\|normal\|low` |
| `POST /api/projects/:project/issues/:id/dependencies` | record prerequisites — `{ dependsOn: [ids], reason }` (same project, or `project/id`; `[]` clears). The supervisor does not start the issue while one has no disposition and is not archived. A cycle of any length is refused. An accepted split chains its parts: each waits for the one before |
| `POST /api/projects/:project/issues/:id/runs/:runId/finalize` | evaluate closure again for a run that stopped at delivery, from its retained worktree |
| `POST /api/projects/:project/issues/:id/runs/:runId/reconcile-delivery` | merge the approved patch onto source that drifted on its own paths, revalidate with the configured checks (or, for drift only on inert paths, carry the approved result with no drive), carry the approvals and deliver; a refusal lists the paths in `run.reconciliations` |
| `GET /api/projects/:project/issues/:id/runs/:runId/patch` | download the retained patch. A settled run with an approved revision and no delivery attempt gets that revision's check artifact, once base + patch rebuilds its fingerprint (409 otherwise), named `<hash>.approved-check-artifact.patch` and labelled by the headers `X-Devpanel-Patch-Kind: approved-revision-check-artifact` and `X-Devpanel-Patch-Revision`; `patch-check` and `apply-artifact` do not take it |
| `GET /api/projects/:project/issues/:id/runs/:runId/patch-check` | read-only: would the patch apply to the checkout NOW — `{state: applies \| applied \| conflicts \| unavailable, owners: [{path, files, state, conflicts?}], checkedAt}`; each file is checked in the git checkout that owns it, through symlinked collections (`server/runtime/patch-check.mjs`). The issue page asks it every time it shows the run. Textual only: not a test of the code, and not the stricter as-reviewed rule of source delivery |
| `POST /api/projects/:project/issues/:id/runs/:runId/apply-artifact` | explicit operator application of a completed retained patch; body names `expectedRevision`; source drift refuses it |
| `POST /api/projects/:project/issues/:id/runs/:runId/cleanup-proof` | scan again for the processes a turn of the run left behind (`run.cleanup`, `runtime/cleanup-barrier.mjs`): survivors of its own reaping are stopped, a lost owner's are only named; proved entries close and leave the project barrier. 409 `CLEANUP_UNPROVED` naming what is left, 409 `SCAN_UNAVAILABLE` for a `structural` entry or where the scan mechanism is unproved (darwin), 409 while the run is live; works from the barrier alone for a run whose record, or whose issue (deleted or packed), is gone |
| `POST /api/projects/:project/issues/:id/runs/:runId/cleanup-acknowledgement` | a person's word that those processes are gone — `{ reason }` (required, ≤ 2000 characters; who is the login or `actor`): the run's open cleanup entries get `acknowledgement { by, at, reason }`, its entries leave `issues/<project>/.cleanup-barrier.json` with a `history` record, and Resume may proceed. Refused (409) while the run is live or has nothing to acknowledge; works from the barrier entry for a deleted or packed issue (404 when none remains); the only way for a `structural` entry (darwin) |
| `POST /api/projects/:project/issues/:id/runs/:runId/landed` | record that a settled run's work was landed by hand — `{ applied, handChanges, commit? \| checkout?, landedAt? }` (what was applied, what was changed beyond the patch or `"none"`, the commit hash or absolute checkout path, when; who is the login or `actor`). Stored once as `run.landed` with `recordedAt`, the run's latest `revision` and its `deliveryAction`; nothing is read from the repository. The run then reads `result: delivered`, `resultReason: manual-landing`, its explanation says who landed it, and `outcome`, closure and approvals are unchanged. Refused (409) for a live or paused run, a run with no candidate, one the engine already delivered to the source (apply-to-source, in-place, an applied artifact or a merged integration), a second claim, or a packed issue |
| `DELETE /api/projects/:project/issues/:id/runs/:runId` | delete a settled run (the trash icon on the issue page, acting on the click): its workspace (never an in-place checkout), `runs/<runId>/` and its step folders in the issue (turns, operator answers, the result entry). Step reservations, the spending ledger and `refs/devpanel/*` stay. Refused (409) for a live or paused run, while a run is active on the issue, or for an archived issue; 404 for an unknown run. Irreversible. Returns `{ runId, deleted, steps }` |
| `POST /api/projects/:project/issues/:id/runs/:runId/followups` | open follow-up issues for the run's unaccepted residual risks |
| `POST /api/supervisor/finish` | no further starts; stop once owned runs complete |
| `GET /api/availability` | roster, cooldowns, saved performance samples, timing definitions and refresh progress; never invokes models |
| `POST /api/availability/refresh` | start/join a bounded hello-world measurement batch; returns 202; one call per verified model not on hold |
| `POST /api/availability/:model` | operator hold: `{until, reason, actor}`; starts naming the model are refused until then |
| `DELETE /api/availability/:model` | clear a recorded cooldown |
| `POST /api/decisions/probe` | one short real request to the active decision provider (`decision:<id>` on the availability page): TypeSafe Jev by default, or the one `decisions/active.yaml` selects (`provider: openai` for the OpenAI Decisions API); see `docs/decisions.md` |
| `POST /api/supervisor/reset` | fresh session: archive chat, native session and pending operation, and begin fresh session limits (calls, starts, per-issue starts, failed-launch guards); spending windows continue; refused while live |
| `GET /api/projects/:project/issues/:id/runs/:runId/integration-target` | the declared repository, branch and its head, to approve exactly |
| `POST /api/projects/:project/issues/:id/runs/:runId/integrate` | operator approval to merge a committed candidate — `{ expectedRevision, targetBranch, expectedTargetHead }` |
| `POST /api/projects/:project/issues/:id/runs/:runId/integration/reconcile` | settle a publication a crash interrupted |

Creating anything broadcasts `issues:changed` with the project, so a second open
panel updates without a reload.

### A note on the page chrome

Page-level actions (reload, *New issue*, *Add step*) live in the application bar,
not in the page body. Each view teleports its own buttons into `#appbar-actions`,
so App.vue does not need to know what any given page offers.

Because `<Transition mode="out-in">` wraps the router outlet, **a view must have a
single root element** — the teleport goes inside it. A view with two root nodes
silently fails to mount on navigation, with no error.

Lists fill the viewport and scroll, with a sticky header and no pagination. Rows
are made clickable through Vuetify 4's `:row-props`; the `@click:row` event of
Vuetify 3 no longer exists.

`/projects/:project` and `/projects/:project/:id` are **sibling** routes, not
nested, so RouterLink's own active matching does not mark the project active
while one of its issues is open. The drawer therefore sets `:active` from
`route.params.project` rather than relying on the link.

## How the data flows

The server samples the host and broadcasts a `metrics` event on an interval. That
ticker only runs while at least one client is connected, and retires itself once
the last one leaves.

`src/socket.js` owns the single socket connection and writes every event into one
reactive object. Components import `connection` and read from it; nothing else
touches the socket. To add a live widget, emit a new event from the server, store
it in that object, and read it from a component.

Events: `hello` (host facts + first sample, on connect), `metrics` (each tick),
`ping:check` (round-trip latency probe), `issues:changed` (an issue was opened),
`run:event` (run transitions; `type: 'live'` carries one persisted chunk of a
runtime's output, `type: 'activity'` a liveness tick).

## Testing

`npm test` runs everything; `npm test <filter>` runs the suites whose filename
matches. Nothing in it can reach a real runtime or spend money — the staged
server's harness directory contains only a scripted fake, and the real adapters
are absent from it rather than merely unused.

Three of the suites are end to end:

- **`control.test.mjs`** drives the HTTP API of a real server running in its own
  process: starting, refusing duplicates, stopping — including stopping during
  the paid preflight — a server killed mid-invocation, a graceful shutdown, and a
  blocked run whose candidate must survive.
- **`acceptance.browser.test.mjs`** drives the built application in jsdom against
  that same server — selecting a playbook, reading the preview, starting,
  watching, stopping, and reconnecting. It is the real bundle, the real socket
  and the real routes; only the window is synthetic.
- **`visual.chromium.test.mjs`** drives the same application in Chromium, for the
  things jsdom cannot answer: clipped text, sideways overflow, a dialog whose
  buttons fall below the fold, keyboard focus, and whether both themes paint.

The Chromium pass needs a browser this project does not ship. Install one:

```
./tools/install-browser.sh        # ~270 MB into gui/.browser, gitignored
npm run visual
```

The script fetches the browser build *and* the system libraries it needs, both
into `gui/.browser`, and nothing outside this project is touched or depended on.
It needs no root: the libraries are unpacked from distribution packages into a
directory of our own, and the loader is pointed at it for the browser process
only. `glibc`, `libgcc` and `libstdc++` are deliberately excluded — shadowing the
running C library breaks more than it fixes. Re-running is safe.

Afterwards `npm run visual` finds everything with no environment set.
`DEVPANEL_BROWSER_LIBS` and `PLAYWRIGHT_BROWSERS_PATH` override the locations.

Without a usable browser the suite reports **skipped** — counted separately from
passes, because a skip that reports itself as a pass claims something was checked
when nothing looked at it. For CI, where a missing browser means the environment
is wrong rather than that layout is exempt:

```
DEVPANEL_REQUIRE_BROWSER=1 npm test    # fails instead of skipping
```

`test/browser/build.mjs` builds the client as one classic script, because jsdom
will not execute an ES module. `test/browser/stage.mjs` starts the server as a
subprocess against throwaway directories, so "the run continues after the browser
closes" is a claim the test can actually check.

The live checks in `live/` are separate on purpose. They spend money, so they
refuse to run without `DEVPANEL_LIVE=1` and an explicit invocation ceiling. Two
of them exist: the default two-turn session check (access, and continuity across
processes), and `--fence`, one turn that asks a read-only role to edit a file,
create a file, run a shell command and change its own permission mode. The
verdict there is read from the filesystem afterwards and from the runtime's own
record of the tool calls it refused, never from the model's account of what it
managed to do — the offline suite can only prove that the adapter handed the
runtime the rules it meant to. A turn that attempted none of the fenced
operations is reported as inconclusive, not as a fence that held.

`npm run contract` sits between the two tiers: it launches the installed CLIs
with local, read-only commands to prove they still honour `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` and `GEMINI_CLI_HOME`. It spends nothing and is outside `npm test`,
which may not reach a real runtime at all.

### Where an issue is on disk

Every issue carries `location`, the path to copy: its folder under `issues/<project>/`, or
its bundle (`issues/.archive/<project>/<id>.tar.gz`) once packed. The `path` of a packed
issue still names the folder it had. The issue page shows `location` under the title, with
a copy button. One click selects the whole path, so Ctrl+C works where the clipboard is refused.

### Time spent on an issue

`GET …/issues/:id/stats` (`server/issue-stats.mjs`) reads every run record of the issue:
`runs/` while unpacked, the bundle's `<id>.runs.json` once packed. It returns each seat on
its model, with its turns, agent time (asked → answered), tokens and cost. A
quota-substituted model gets its own row, and untimed or unpriced turns are counted rather
than given zero. It also returns the coordinator's share, and how long the issue stood:
inside runs (waiting on a person, stopped, engine work) and between opening and archiving
with no run going. Archived issues show it as a **Time spent** card. Nothing is stored.

### Who opened an issue

Each new issue records `openedBy: {user, host, from}` in `issue.json`; the issue page
shows it beside the date and the issue list in its **Opened by** column (the tooltip adds
where it came from). An issue from `POST /api/report/:project` is
`<reporter>@<deployment host>` (`report@…` without a key) and carries, in the list and on
the issue page, a **report** chip (coloured by trust, which the tooltip names) and, for the
categories a framework raises itself, an **error**, **crash** (red) or **warning** (amber)
chip before it (`src/report-tags.mjs`). `POST …/issues` takes an optional `actor` (the proxy login when
there is one, else the name the new-issue dialog asks for), and the host is the client's reverse-DNS name or its address. A follow-up,
an accepted split, an inquiry's proposal and a run's finding also name the issue and run
they came from (`from.via`: `follow-up`, `split`, `inquiry`, `finding`). Issues opened
earlier show what their own record implies, marked `derived`, or nothing.

## Adding material to an issue

An open issue takes a note, references and files from the panel — *Add to this
issue* on the issue page. It all lands in one numbered step, the same shape
everything else in the issue uses:

```
2026-09-11-something-is-broken/
└── 000-report/
    ├── note.md        the text, verbatim (.md, .txt or .html)
    ├── links.md       URLs and paths, as markdown
    └── server.log     an attachment
```

Naming the step is optional — having to title a note before writing one is work
for nobody's benefit, and an untitled one is simply called `note`. The text can be
markdown, plain text or HTML; the extension records what the author meant it to
be and changes nothing about how it is handled.

A reference can be a URL **or a path**: `https://example.com/ticket/9` and
`<projects-root>/some-project/logs/today.log` are both useful, and the path is often the more
directly usable of the two, since the coordinator is told to read this folder.
Paths are written as literal code rather than as links — a browser cannot follow
one, and dressing it as clickable would promise that it could. A `file://` URL is
recorded as the path it names.

That placement is the point. The coordinator's prompt tells it to read the issue
folder, so an attached log or a linked ticket is material the run works from
rather than a note beside it.

Three rules the server enforces rather than trusting the caller:

- **Filenames are rejected, not repaired.** A name containing a path separator,
  `..`, a control character or a leading dot is refused. Rewriting it would store
  the file under a name nobody chose and hide that something tried.
- **Only `http`, `https`, `file:` and filesystem paths are accepted.** Any other
  scheme is refused by name — a `javascript:` or `data:` URL in a list the panel
  renders is script injection with extra steps, so the check happens where the
  value becomes durable rather than at every later reader.
- **Attachments are served as `application/octet-stream`, always as a download,
  with `nosniff`.** The operator's token lives in this origin's sessionStorage, so
  an uploaded `.html` or `.svg` served with its own type would run as same-origin
  script with access to it. Text files are shown inline in the panel, interpolated
  as text; nothing is ever rendered as markup — not the markdown, and emphatically
  not a note written as `.html`.

Files are capped at 25 MB each (`DEVPANEL_MAX_FILE_BYTES`), and an archived issue
accepts nothing further — not a note, not a file into a step it already has.

## Archiving and deleting

Two steps, and only one of them is reversible.

**Archive** takes an issue out of the active lists and changes nothing on disk —
every step, response and retained candidate stays exactly where it is, at the
same path, because git worktrees and runtime sessions hold absolute paths into
it. Close accepts an empty reason. For active execution, Close offers to stop
and wait before archiving. Interrupted runs show “Interrupted — needs recovery”
and offer **Abandon run**, or confirmation to abandon while closing the issue.
Abandonment records cancellation and an end time, preserves the original recovery
and pending invocation details in `run.abandonment`, and retains existing work
and logs. It does not certify or replay any deployment. Ownership must be free;
a live or unverifiable lock refuses abandonment. The authenticated endpoint is
`POST /api/projects/:project/issues/:id/runs/:runId/abandon`.
Archived issues are browsable under *Archived issues*, and restoring one puts it
back untouched.

A run that stopped at delivery (`delivery-unverifiable`, `delivery-failed`,
`delivery-unavailable`, `candidate-changed-during-delivery`) offers **Finalize
run** while its worktree is retained: closure is evaluated again from the disk,
with the same conditions as the first time, so it completes only what was
already approved. Fix the cause first; a run that still fails stays blocked with
the new reason. `POST /api/projects/:project/issues/:id/runs/:runId/finalize`.

When source delivery was refused because the live checkout changed the approved
patch's own paths, the run also offers **Reconcile with source**
(`reconcile-delivery`, `POST …/runs/:runId/reconcile-delivery`): the approved
patch is merged three-way onto the checkout as it is now, in a temporary
worktree; a conflict is resolved only on a path the project declares
`workspace.reconcile: { <path or glob>: append | prepend }` (the checkout's
content kept, the candidate's added lines after it, or before it for a
newest-first changelog); the merged candidate must carry the
reviewed change unaltered elsewhere and pass the run's configured checks
(local always, the staging drive only under a `required` requirement), unless all
the drift is on paths declared `{ rule, inert: true }` and everything else is
byte-identical to the approved revision: then its passing result carries and no
check runs (`noDrive` on the attempt). Then the
approvals carry with `reconciledFrom` and it is delivered, the delivery naming
the merge base and the merged and appended paths. Otherwise nothing is
delivered, the run stays blocked and the attempt lists the paths
(`run.reconciliations`). See execution-contract.md "Reconciling a delivery with
drifted source".

**Delete** is permanent, and only offered for an issue that is already archived —
from the archived list, nowhere else. It acts on the click: archiving is the
deliberate step that makes it reachable, so there is no second confirmation.

Deleting is not `rm -rf`. A run's workspace is a git worktree of the *host
project*, registered in that repository's `.git/worktrees`, and a blocked or
cancelled run deliberately keeps its worktree. Removing the issue folder alone
would leave the project repository reporting a path that no longer exists, so
`deleteIssue` hands each worktree back first and prunes afterwards.

## Running agents

The dashboard's Overview lists every agent currently invoked, across every
project, with the role, the roster model, the model actually sent to the runtime,
the step it is working on and how long the turn has been out. Each entry links to
`/projects/<project>/<issue>?run=<runId>`, which opens that run rather than the
newest one.

Two things it deliberately does:

- **It keeps a live run visible between turns.** A playbook that has just
  finished one turn and not yet asked the next is still working. Listing only
  in-flight invocations would empty the panel every few seconds and read as
  "nothing is happening".
- **It reports ownership rather than assuming it.** The list is built from
  persisted state, so a run driven by another process appears too — but a run
  whose owner is gone is marked as such instead of being given a spinner. A run
  nobody is driving will never move again, and animating it would say otherwise.

## Timing

Every turn is measured automatically, from the moment it is asked to the moment
the answer arrives. Each step records `startedAt`, `endedAt` and `durationMs`;
the run carries `timing: { agentMs, abandonedMs, unknownSteps }`.

The boundary is deliberate. Filing a turn — creating the step folder, extracting
structured output, fingerprinting the workspace — is devpanel's time, not the
model's, and it grows with the size of the project rather than with the work the
agent did. So the stopwatch stops when the adapter returns, before any of that.
The run's wall clock minus `agentMs` is therefore a real number: what the harness
spent on its own bookkeeping.

Two cases do not produce a plain duration, and neither is reported as zero:

- **An abandoned turn** — cancelled, or aborted on the wall-clock budget — files
  no step, because there is no answer to file. The time it consumed is added to
  `abandonedMs`, which is usually the number worth looking at when a run hit its
  budget.
- **Work adopted after a restart** has a start but no recorded answer time: the
  runtime finished at a moment nothing wrote down. `durationMs` is `null`, the
  step says why, and `unknownSteps` counts it. A fabricated figure would be worse
  than an em dash.

## The run lifecycle

```
reserved ─▶ preflighting ─▶ pending ─▶ running ─▶ completed
              │                          │  │  │
              │                          │  │  └─▶ paused ─(answer)─▶ pending
              │                          │  └─▶ stopping ─▶ cancelled
              │                          └────▶ blocked
              └─▶ failed (preflight-refused, or a classified runtime failure)
```

Some starts never reach `reserved`. `POST …/issues/:id/runs` proves the source
checkout readable first — after the project and playbook resolve, before the run
is reserved and before preflight spends anything — and refuses `422` with a stable
code when git cannot read it: `UNSAFE_REPOSITORY` (dubious ownership),
`EMPTY_REPOSITORY` (no valid HEAD; make the initial commit), `NOT_A_REPOSITORY`,
or `UNREADABLE_REPOSITORY`. There is no run to carry the classification, so the
response does: `{ error, code, class: "environment", started: false, retryable:
false, remedy, detail }`, where `error` already reads as the message plus its
remedy. Whether the checkout is *clean* is not judged there — that stays the base
policy's decision at provisioning time (`DIRTY_BASE`).

A run that triage judged unable to finish without its owner is not paused: it
ends `completed`/`unresolved` with `ownerInput` (questions or a proposed split),
and `POST …/runs/:runId/owner-input {actor, answers:{Q1:…}|split:'accept'|'decline', note?}`
answers it once — the answers become a note on the issue and the same
configuration starts again (`started`, or `startError` when refused), or an
accepted split becomes new issues. A run is `paused` when a step handed a
question to the operator (a coordinator `operatorRequest`, or a configuration
that still uses `await-input`). Nothing is in flight; the worktree is kept; the only way on is
`POST …/runs/:runId/answer {answer, actor, pauseId}`, which the engine records as an
operator step before the supervisor drives the run again. A closed question
accepts exactly one of its `pause.options`.

At any point the operator can talk to a run's coordinator (the issue page's
**Coordinator chat** entry, `server/runtime/coordinator-chat.mjs`).
`GET …/runs/:runId/chat` returns the conversation, and `POST …/runs/:runId/chat {kind, text, actor}`
adds to it. `kind: 'question'` (202) is answered in a fork of the coordinator's native
session: one tool-free turn on a copy, with live output under `live/ask-<uuid>.jsonl`, and
the run itself is untouched. `kind: 'instruction'` (201) is delivered verbatim in the
coordinator's next turn. That step records it (`step.instructions`), and a completed
run refuses one with 409. Both arrive as `run:event {type:'chat'}`. The chat shows the
coordinator's turns with their streamed reasoning: Claude seats request thinking
summaries and Codex seats request reasoning summaries.

A runtime that exits badly is classified (`GET …/runs/:runId` → `failures[]`,
`failure`): rate limits and transient faults are retried after a bounded wait,
a quota exhaustion is remembered host-wide and refuses later starts naming that
model (the **Model availability** page at `/models` lists every roster model with
its record, lets an operator clear one or record a hold until a chosen instant),
and everything else fails the run with the class on record.

Three properties this shape exists to hold:

- **A run is durable and stoppable before it spends anything.** Preflight probes
  at model depth, which costs a call per model. Reserving the run first means
  that spending happens inside something that can be inspected, attributed and
  interrupted — and that a refusal leaves a record of what was paid, rather than
  vanishing.
- **Ownership is a fact about a process, not about a file.** A run persisted as
  live whose owner is gone is `recovery-required`: what its last invocation did
  is unknown, and "cancelled" would claim knowledge nobody has. The server
  reconciles this at start-up, before it serves anything, and stops what it
  supervises on the way down.
- **Releasing the issue and deleting the candidate are separate.** The git
  worktree provider's release is a force-remove, so the decision to call it is
  made on evidence about the *files*, never about the run's records. A revision is
  fingerprinted from a response, so an author that wrote code and was then
  cancelled, killed or failed before answering has recorded nothing and written
  plenty — reading "no revisions" as "no work" is exactly how that work is lost.
  The workspace is deleted only when its content is captured in the run's
  artifacts, or when comparing it against the persisted baseline *proves* nothing
  changed. A comparison that cannot be made is not a licence to delete: being
  wrong that way costs disk, being wrong the other way destroys the only copy.
  The lock always goes back either way.

## Notes

- **Icons are tree-shaken SVGs, not the webfont.** Only the icons listed in
  `src/plugins/icons.js` are bundled — using the full webfont instead costs about
  3.6 MB of font files. To add one: import it there, name it, use it as `$name`.
- **Both themes are hand-picked**, not one flipped from the other, so contrast
  holds on each surface. The toggle follows the OS until you pick a side.
- The dashboard's stat tiles always show the number, so a colored meter is
  reinforcement rather than the only thing carrying the reading.


Run controls: **Pause run** finishes and saves the current turn, then waits.
**Resume run** continues with the same sessions, steps and workspace. Its dialog
shows total budget allowances (seven days by default); previously spent usage is
retained. Decision pauses continue through **Record answer and continue**.
The endpoints are `POST /api/projects/:project/issues/:id/runs/:runId/pause`
and `POST …/resume` (optional body: `{ "budgets": { "wallClockMinutes": 10080 } }`).
**Continue playbook** (`src/components/ContinueRun.vue`) is offered on a code run
stopped at closure (`closure-conditions-unmet`, `refreshed-checks-failed`) with its
candidate retained: `POST …/continue` `{ "instruction": "…", "actor": "…",
"budgets": {…} }` gives the author another round of the loop that produced the
candidate, in the same worktree and sessions, then reviews, checks and closure run
again. The server adds the closure record and the issue notes written since the run
began to the recorded decision. Resume does not fit there: replaying an unchanged
record reaches the same closure. **Accept check result** (`POST …/accept-check-result`, `{failures, reason, revision}`) delivers an approved revision whose named check failures an operator judges unrelated; nothing is accepted until the coordinator has confirmed the revision (execution-contract.md "Accepting a check result and delivering"). **Refresh checks** (`POST …/refresh-checks`)
reruns the installed checks on the retained candidate of a run stopped at closure,
or only by failed checks on a revision every auditor approved.
Recovery and finalization controls remain necessary for uncertain mutations or
runs already at delivery. A server restart preserves a settled pause.
