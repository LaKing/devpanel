# Host configuration

Some configuration belongs to one installation, not to devpanel:

- the projects it serves (`projects/<id>.yaml`): their containers, SSH targets and paths;
- its own versions of catalogue playbooks (`playbooks/<id>.yaml`): other seats, models,
  efforts or budgets, while the tracked `playbooks/` stays the shared default;
- which decision provider is active and how it is reached (`decisions/active.yaml`,
  `decisions/<id>.yaml`), read before the tracked `decisions/` (docs/decisions.md);
- roster entries that name a person's login (`account:`), or carry the installation's own
  dated verification evidence; the tracked `roster/` is the shared model catalogue;
- release targets (`tools/releases/<site>-targets.json`): hosts, instance directories, state roots, service accounts;
- live-check reports (`gui/live/reports/`): the host's accounts, paths and costs;
- its defaults (`settings.json`, "Host settings" below), its publish denylist
  (`publish-denylist.txt`, "Publishing") and its own documentation (`docs/`, "Seat guidance").

They live in one git-ignored **host-config** directory beside the publishable tree,
with the installation's agent notes in the git-ignored `CLAUDE.local.md` beside
`CLAUDE.md`. The generic examples in [`examples/host-config/`](../examples/host-config/)
show the layout with reserved `example.invalid` names; nothing there is loaded.

## The setting

`DEVPANEL_HOST_CONFIG_DIR` names the directory. Unset or empty, it is
`<config root>/host-config` if that exists, else `<data root>/host-config` if that
exists and `DEVPANEL_DATA_ROOT` names a data root (nothing outside the checkout is
looked for without it; a host-config found there also makes it the settings'
`dataRoot` unless they name another), else
`<config root>/host-config`; a relative value is relative to the config root (the
loader's root: `DEVPANEL_CONFIG_ROOT`, else this checkout); an absolute one is used as
is. The same rule holds everywhere: the loader and `config:check`
(`gui/server/config/host-config.mjs`), the host settings, the live checks, the
migration script, the publish check and the release procedures
(`tools/releases/host_targets.py`). Releases started by the engine get the resolved
absolute directory in their environment. Release targets are read when the release
runs: they were never part of a run's snapshot.

```
host-config/
  projects/<id>.yaml
  roster/<id>.yaml
  playbooks/<id>.yaml
  decisions/active.yaml
  decisions/<id>.yaml
  releases/<site>-targets.json
  releases/README.md
  live-reports/<report>
  settings.json
  publish-denylist.txt
  docs/
```

## Precedence

Each category (projects, roster, playbooks, releases, live reports) is the union of the in-tree
directory and the host-config one, by file name. When both hold a file of the same
name, **the host-config file is used** and the in-tree one is shadowed: `config:check`
lists it as a warning, not an error. Two different file names declaring the same id
stay an error. With the setting unset and no host-config directory, or an empty one,
only the in-tree files are read. Moving a file unchanged does not change any
`configHash`.

A roster entry is hashed by its bytes, so an installation that keeps its own copy of a
catalogue entry (its dated verification evidence, say) keeps that entry's hash, and
every configuration group built on it, whatever the tracked catalogue says. To adopt
a newer tracked entry, delete the host copy; that starts a new configuration group.

Live checks write their reports to `host-config/live-reports/` once the host-config
directory exists, and to `gui/live/reports/` before that.

`config:check` prints where each category was found:

```
host-config <config root>/host-config (present)   roster 21 (tree 21, host 0)   projects 6 (tree 0, host 6)   …
```

## Host settings

`settings.json` holds the installation's own defaults
([`host-settings.schema.json`](../schemas/host-settings.schema.json),
`gui/server/config/host-settings.mjs`). Every key is optional; an absent key keeps the
neutral default, which names no installation:

| Key | Default | Meaning |
|---|---|---|
| `projectsRoot` | the directory holding the panel's checkout | where the `<name>-project` directories are (`DEVPANEL_PROJECTS_DIR` wins) |
| `dataRoot` | none: the panel's checkout | where the panel keeps what it writes: the issue root becomes `<dataRoot>/issues` (issues, runs, their worktrees, private Git directories, scratch, supervisor state) the server log `<dataRoot>/logs`, the operator token `<dataRoot>/.devpanel-token` and the TLS certificate `<dataRoot>/cert`; `DEVPANEL_ISSUES_DIR`, `DEVPANEL_LOG_DIR`, `DEVPANEL_TOKEN_FILE` and `DEVPANEL_CERT_DIR` still win. The data root is a forbidden root and a fence canary like the panel's checkout |
| `gitStore` | `false`: the project repository | with `dataRoot`: snapshot objects, `refs/devpanel/*` and the candidate branches `devpanel/<issue>/<run>` go to `<dataRoot>/repos/<project>.git`, a bare store reading the project's objects through alternates (`runtime/git-store.mjs`); the project repository is only read, and an operator-approved merge fetches the candidate's objects into it (no ref). Rewriting and pruning the project's history can leave an old run's snapshot without its parent |
| `nestedRepositories` | `gitlink`: what `git add -A` records, an empty directory in the run's worktree | `include`: a repository nested in the checkout (a monorepo's part) is snapshotted as that repository would carry it — tracked and unignored files as they are on disk, never its `.git` — so the run sees the whole tree; `apply-to-source` writes there in place (the part sees uncommitted changes), a `commit` delivery touching it is refused, and the source base keeps the gitlink (`runtime/working-tree.mjs` `includeNested`) |
| `projectDiscovery.pattern` | none: the `<name>-project` entries of the root | find projects below the root instead: `*` per path segment (`"*/*"` is two levels down); identity is the relative path joined with `-` plus `-project` (`2026/shop` → `2026-shop-project`) |
| `projectDiscovery.markers` | `["package.json"]` | file names any one of which makes a matching directory a project |
| `proxyLogin.usersDir` | none: a login name is attribution only | the reverse proxy's users directory; `{hostname}` is replaced by the host's name (`DEVPANEL_USERS_DIR` wins) |
| `proxyLogin.digestFiles` | `[".hash"]` | files in a user's directory holding a SHA-512 hex digest that admits |
| `projectActions.headerMarkers` | none | marker words read in script headers (`# <MARKER> key: value`) besides `DEVPANEL` |
| `testDrive.confinement` | none: a `kind: candidate` command needs the project's own | `{user, home}` of candidate commands when the project's `testDrive.confinement` omits them |
| `selection.allowedHomePaths` | none: the whole home is forbidden | directories inside the home (`~/work`) where an allowed root, tooling mount or materialized target is not refused for being in the home; every other forbidden root still applies |
| `harnesses.disabled` | none | runtimes this host does not have (`codex`, `gemini`): their roster entries are left out, and a playbook naming one fails resolution saying so (override it in `playbooks/`) |
| `fence.readOnly` | none | directories bound read-only into every seat fence, for a toolchain under the home (`~/.nvm`); the home, anything containing it and the CLI login directories are refused |
| `selection.forbiddenPrefixes` | `["production", "staging"]` | projects-root entries named `<prefix>.*` are container filesystems no run may read |
| `skill.linkBaseVariable` | none | the variable the devpanel skill client reads as its link base after `DEVPANEL_LINKBASE` |
| `reporter.panelUrl` | none | the panel's private address for `gui/tools/provision-reporter.mjs` |
| `seatGuidance.projects` | none | projects whose run seats get the installation's notes ("Seat guidance") |

An invalid file is an error, not a fallback: `config:check` reports it and the server
refuses to start, so a typo never weakens a protection. The file is read at call time
and an edit takes effect without a restart (except for values a module reads once at
load: the projects root).

## Seat guidance

`CLAUDE.local.md` and `host-config/docs/` are git-ignored, so a run's worktree never
holds them. When `seatGuidance.projects` names a run's project, the engine freezes
both into `runs/<id>/evidence/host-guidance/` at the run's start
(`gui/server/runtime/host-guidance.mjs`, recorded as `run.hostGuidance` with a
`host-guidance.json` manifest of every file's sha256). Every seat may read the run's
evidence, and every seat prompt names the directory, with `CLAUDE.local.md` inline up
to 32 KB (a pointer above that). Symbolic links and special files are skipped and
listed. Nothing of it enters the candidate, its fingerprint or the configHash. Without
the setting nothing is copied and nothing is said.

## Moving this installation's files: `tools/migrate-host-config.mjs`

The files that are tracked stay in the tree, and keep working, until a person moves
them. In this order:

1. `node tools/migrate-host-config.mjs --dry-run` prints what would move. It changes nothing.
2. `node tools/migrate-host-config.mjs` moves them, as the panel's owner.
3. `node gui/server/config/check.mjs` shows them under `host`.
4. The next checkpoint commits their removal from the index.

The script moves `projects/*.yaml`, roster entries with `account:`,
`tools/releases/*-targets.json` and `gui/live/reports/*`, and carries out a **move
manifest** when one is present (`tools/host-move/manifest.json`, or `--manifest <file>`):

```json
{ "entries": [ { "from": "<checkout path>", "to": "host:<path> | root:<path> | in-place" } ] }
```

`host:` is relative to the host-config directory, `root:` to the checkout (Git must
ignore the target). `in-place` keeps the file where it is, byte for byte: its path is
added to the repository's own exclude file (`info/exclude`, never tracked) and, when
it is tracked, untracked. An in-place file that is not tracked (one a delivered patch
added, still unstaged) is only excluded: never untracked, never removed. The manifest
lists itself last, so after a run nothing of it is left in the checkout.

It checks every target first and refuses the whole run (exit 2) on a target with
different bytes (it never overwrites), a symlink or special file, a symlink anywhere
from `--root` or `--to` down to a target, a target that is its own original (the same
directory by real path, or the same file), a manifest path that is absolute or has an
empty, `.` or `..` segment, a missing source whose target is missing too, or a target
inside the checkout that Git does not ignore. It copies each file under a temporary
name, syncs and checks it, then links it into place. Only when every copy reads back
with its source's sha256 does it exclude the in-place files, untrack the tracked
originals (`git rm --cached`) and remove the moved ones; any mismatch stops before
that (exit 3). A target that already holds the same bytes counts as present, and a
manifest entry whose source is gone but whose target exists counts as moved, so a run
that stopped half-way is finished by running it again, and a second run moves nothing.
It prints a JSON manifest of every file with its sha256, mode and what was done.
`--root <checkout>` and `--to <dir>` override the defaults.

While a shipped manifest has not been carried out yet, the settings it carries
(`host:settings.json`) and the `CLAUDE.local.md` it carries are read from the
checkout's copy, and the server logs that the move is pending: a restart between a
delivery and the move changes nothing. This holds only for the default host-config
directory; an explicit `DEVPANEL_HOST_CONFIG_DIR` never reads carried files.

To undo a move, copy the files back to their in-tree paths; the loader reads both.

An application's project file may still say in its release `ownership` text that
targets are installed in `tools/releases/<site>-targets.json`; they are read from
`host-config/releases/` first. Its `workspace.tooling.allowedRoots` may grant seats
`tools/releases`, where the procedures are; `host-config/releases` cannot be granted
instead, because an allowed root inside the panel checkout must be under `tools/`
(`allowedRootErrors` in `gui/server/config/load.mjs`).

The ignore rules (`/projects/*.yaml`, `/tools/releases/*-targets.json`,
`/gui/live/reports/`, `/host-config/`, `/CLAUDE.local.md`) mean a checkpoint never
commits a new live report, project file or local note.

## Release procedures

`tools/releases/<site>.py` reads `<site>-targets.json` from host-config first, then
beside itself ([tools/releases/README.md](../tools/releases/README.md)). A site's
procedures are the installation's own files, kept in `tools/releases/` untracked.

## macOS

`install-on-osx.sh` requires `DEVPANEL_SOURCE` and never syncs `projects/`,
`host-config/`, `issues/` or token data, so a Mac keeps its own project files and
host-config across every run. Create the Mac's projects in its own
`host-config/projects/` (or `projects/`). [macOS](macos.md) covers the rest: seats,
fence labels, local checks, the service and the Mac proof checklist.

## Publishing

The tracked tree names no installation. `npm run publish:check`
(`tools/publish-check.mjs`) greps what a commit would contain — tracked files and
untracked ones Git does not ignore, contents and paths — for the installation's own
denylist, `host-config/publish-denylist.txt`: one JavaScript regular expression per
line, matched case-insensitively, `#` for comments. The denylist is the
installation's, never tracked; without one there is nothing to look for and the check
passes. A match exits 1 and lists `path:line: text`.
