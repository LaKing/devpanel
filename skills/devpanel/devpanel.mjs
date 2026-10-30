#!/usr/bin/env node
// Command-line client for the devpanel API, used by the devpanel skill (SKILL.md beside it).
//
// It opens issues, reads their state, adds material to them and starts runs. A start spends money, so it
// happens only when the user asks for it (SKILL.md), always through `start`, which previews first and
// refuses a configuration the preview marks blocking. `answer` also starts a run: the server restarts the
// same playbook after an owner answer.
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The panel's own checkout, found from this file (node resolves the ~/.claude/skills symlink for the main
// module): the checkout the skill is linked from on a Linux host, ~/devpanel on a Mac (install-on-osx.sh).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// DEVPANEL_URL, else the .devpanel-url install-on-osx.sh writes (its port is not 443), else the hosts' default.
const URL_FILE = path.join(ROOT, '.devpanel-url');
const SERVER = new URL(process.env.DEVPANEL_URL ?? (fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, 'utf8').trim() : 'https://localhost:443'));
const LINKBASE = linkBase();

// Declarations, not constants: LINKBASE above is computed before this point.
function expandHome(p) { return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }
function isDir(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }

// Where the host configuration lives, by the server's rule (server/config/host-config.mjs hostConfigDir):
// DEVPANEL_HOST_CONFIG_DIR, else the checkout's host-config/ if it exists, else <data root>/host-config if that
// exists (only when DEVPANEL_DATA_ROOT is set), else the checkout's. `data` is set when it came from the data root.
function hostConfig () {
    if (process.env.DEVPANEL_HOST_CONFIG_DIR) return { dir: path.resolve(ROOT, process.env.DEVPANEL_HOST_CONFIG_DIR), data: null };
    const inTree = path.join(ROOT, 'host-config');
    if (isDir(inTree)) return { dir: inTree, data: null };
    const data = process.env.DEVPANEL_DATA_ROOT ? path.resolve(process.env.DEVPANEL_DATA_ROOT) : null;
    return data && isDir(path.join(data, 'host-config')) ? { dir: path.join(data, 'host-config'), data } : { dir: inTree, data: null };
}

// The host settings, read without the server's modules: the host-config settings, or their carried copy while
// a move is pending.
function hostSettings () {
    const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const hostDir = hostConfig().dir;
    let settings = read(path.join(hostDir, 'settings.json'));
    if (!settings && !process.env.DEVPANEL_HOST_CONFIG_DIR) {
        const carried = read(path.join(ROOT, 'tools', 'host-move', 'manifest.json'))?.entries?.find((e) => e.to === 'host:settings.json');
        if (typeof carried?.from === 'string' && !carried.from.split('/').includes('..')) settings = read(path.join(ROOT, carried.from));
    }
    return settings;
}

// Where paths in the output link to: DEVPANEL_LINKBASE, else the variable an editor's terminal exports under
// its own name, which the host settings name (skill.linkBaseVariable; docs/host-config.md "Host settings").
function linkBase () {
    if (process.env.DEVPANEL_LINKBASE) return process.env.DEVPANEL_LINKBASE;
    const name = hostSettings()?.skill?.linkBaseVariable;
    return (typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name) && process.env[name]) || '';
}

const USAGE = `usage: devpanel.mjs [-p <project>] <command> ...
  open <file.md|->            open an issue; the first heading is its title
  list                        open issues with their latest run
  status <id>                 issue state, latest run explanation, triage questions
  result <id>                 the latest run's result.md and patch location
  note <id> <file.md|->       add a note step (context for the next run)
  answer <id> <file.json|->   answer triage questions; RESTARTS the run (paid)
  preview <id> <playbook>     what a start would run: checks, rounds, budgets, prerequisites (free)
  start <id> <playbook>       preview, then start that exact configuration (paid; only on the user's word)
  watch [<id>] [--until-settled]
                              one line per run event of the project (or issue) as it happens; with
                              --until-settled, exit when the issue's run finishes, pauses or stops
<id> may be a unique prefix or slug fragment. Project defaults to the one the cwd is in (projectDiscovery, else the nearest *-project directory).`;

function fail(message) {
    console.error(message);
    process.exit(1);
}

// The token is readable by the panel's owner only; a fenced seat cannot see it, which is the point (general §008).
// Without it the request goes out bare: a local install (DEVPANEL_AUTH=local) admits a loopback client, any other
// server answers 401, and that error names the file.
// Where the server keeps it (server/project-path.mjs tokenFile): DEVPANEL_TOKEN_FILE, else the host settings'
// <dataRoot>/.devpanel-token, else the panel's checkout.
function tokenPath() {
    if (process.env.DEVPANEL_TOKEN_FILE) return process.env.DEVPANEL_TOKEN_FILE;
    const dataRoot = hostSettings()?.dataRoot;
    if (typeof dataRoot === 'string' && dataRoot) return path.join(expandHome(dataRoot), '.devpanel-token');
    const implied = hostConfig().data;
    return path.join(implied ?? ROOT, '.devpanel-token');
}

function token() {
    try {
        return process.env.DEVPANEL_TOKEN?.trim() || fs.readFileSync(tokenPath(), 'utf8').trim();
    } catch {
        return null;
    }
}

// node:https rather than fetch: the panel's certificate is self-signed, and fetch has no per-request opt-out.
function api(method, url, body) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const bearer = token();
    const headers = { ...(bearer && { Authorization: `Bearer ${bearer}` }), ...(payload && { 'Content-Type': 'application/json' }) };
    return new Promise((resolve, reject) => {
        const req = https.request({ host: SERVER.hostname.replace(/^\[|\]$/g, ''), port: SERVER.port || 443, path: url, method, headers, rejectUnauthorized: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => (text += d));
            res.on('end', () => {
                const type = res.headers['content-type'] ?? '';
                const data = type.includes('json') ? JSON.parse(text || 'null') : text;
                const hint = res.statusCode === 401 && !bearer ? ` (no token: cannot read ${tokenPath()})` : '';
                if (res.statusCode >= 400) reject(new Error(`${method} ${url}: ${res.statusCode} ${data?.error ?? data?.message ?? text}${hint}`));
                else resolve(data);
            });
        });
        req.on('error', (e) => reject(new Error(`devpanel unreachable at ${SERVER.origin}: ${e.message}`)));
        req.end(payload);
    });
}

function readInput(file) {
    if (!file) fail(USAGE);
    return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
}

const link = (p, text = path.basename(p)) => (LINKBASE ? `[${text}](${LINKBASE}${p})` : p);
const base = (project) => `/api/projects/${encodeURIComponent(project)}`;

// The project the working directory is in, by the server's rule (server/project-path.mjs): with the host
// settings' projectDiscovery, the directory below the projects root that matches its pattern and holds one of its
// markers, identified by its relative path (`2026/shop` -> `2026-shop-project`); otherwise the nearest ancestor
// named *-project, wherever the projects live (/srv on the hosts, DEVPANEL_PROJECTS_DIR on a Mac).
function discoveredProject(cwd) {
    const settings = hostSettings();
    const discovery = settings?.projectDiscovery;
    if (typeof discovery?.pattern !== 'string') return null;
    const root = process.env.DEVPANEL_PROJECTS_DIR ?? (typeof settings.projectsRoot === 'string' ? settings.projectsRoot : path.dirname(ROOT));
    let real;
    try { real = fs.realpathSync(root); } catch { return null; }
    const rel = path.relative(real, cwd);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const globs = discovery.pattern.split('/').filter(Boolean);
    const parts = rel.split(path.sep).slice(0, globs.length);
    if (parts.length < globs.length) return null;
    const matches = (glob, name) => (!name.startsWith('.') || glob.startsWith('.'))
        && new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(name);
    if (!globs.every((glob, i) => matches(glob, parts[i]))) return null;
    const markers = Array.isArray(discovery.markers) && discovery.markers.length ? discovery.markers : ['package.json'];
    if (!markers.some((m) => fs.existsSync(path.join(real, ...parts, m)))) return null;
    return `${parts.join('-')}-project`;
}

function projectOf(given) {
    let cwd = process.cwd();
    try { cwd = fs.realpathSync(cwd); } catch { /* as given */ }
    const name = given ?? discoveredProject(cwd) ?? cwd.split(path.sep).reverse().find((part) => part.endsWith('-project'));
    if (!name) fail('no project: pass -p <project> or run inside a project directory');
    return name.endsWith('-project') ? name : `${name}-project`;
}

async function resolveId(project, wanted) {
    if (!wanted) fail(USAGE);
    const issues = await api('GET', `${base(project)}/issues`);
    const exact = issues.find((i) => i.id === wanted);
    if (exact) return exact.id;
    const hits = issues.filter((i) => i.id.startsWith(wanted) || i.slug.includes(wanted));
    if (hits.length === 1) return hits[0].id;
    fail(hits.length ? `ambiguous id "${wanted}":\n${hits.map((i) => `  ${i.id}`).join('\n')}` : `no open issue matches "${wanted}" in ${project}`);
}

function describeRun(run) {
    if (!run) return ['no run yet'];
    const e = run.explanation ?? {};
    const lines = [`latest run ${run.runId} (${run.playbook}): ${run.status} / ${run.result}${run.live ? ' — LIVE' : ''}`];
    if (e.headline) lines.push(`  ${e.headline}`);
    if (e.detail) lines.push(`  ${e.detail}`);
    for (const u of e.unmet ?? []) lines.push(`  unmet ${u.id}: ${u.text}`);
    if (run.pauseQuestion) lines.push(`  paused, asks: ${run.pauseQuestion}`);
    if (e.next) lines.push(`  next: ${e.next}`);
    return lines;
}

const commands = {
    async open(project, file) {
        const input = readInput(file);
        // The server reads one-line input as a bare title, or as a path to read if it ends in .md (issues.js createIssue).
        if (!/^#\s+\S/m.test(input) || !input.trim().includes('\n')) fail('the input must be a markdown report: a "# Title" heading and a body');
        const issue = await api('POST', `${base(project)}/issues`, { input, actor: 'claude' });
        console.log(`opened ${project}/${issue.id}\n${link(issue.path, issue.id)}`);
    },

    async list(project) {
        for (const i of await api('GET', `${base(project)}/issues`)) {
            const run = i.latestRun;
            const state = run ? `${run.status}/${run.result}${run.live ? ' LIVE' : ''}` : 'no run';
            console.log(`${i.id}  [${state}]${i.priority ? ` ${i.priority.value}` : ''}${i.disposition ? ` (${i.disposition.value})` : ''}`);
        }
    },

    async status(project, wanted) {
        const id = await resolveId(project, wanted);
        const issue = await api('GET', `${base(project)}/issues/${id}`);
        console.log(`${issue.name}\n${project}/${id} — ${issue.status}, ${issue.runCount} run(s), ${link(issue.path, 'folder')}`);
        if (issue.disposition) console.log(`disposition: ${issue.disposition.value} — ${issue.disposition.evidence ?? ''}`);
        console.log(describeRun(issue.latestRun).join('\n'));
        const asked = issue.latestRun?.ownerInput;
        if (!asked || asked.answered) return;
        // The list summary drops question ids; answering needs them, so read the run itself.
        const run = await api('GET', `${base(project)}/issues/${id}/runs/${issue.latestRun.runId}`);
        const o = run.ownerInput ?? {};
        console.log(`\ntriage verdict: ${o.verdict}${o.reason ? ` — ${o.reason}` : ''}`);
        for (const q of o.questions ?? []) console.log(`  ${q.id}: ${q.question}${q.recommendation ? `\n      recommended: ${q.recommendation}` : ''}`);
        for (const part of o.split ?? []) console.log(`  split part: ${part.title} — ${part.scope}`);
    },

    async result(project, wanted) {
        const id = await resolveId(project, wanted);
        const issue = await api('GET', `${base(project)}/issues/${id}`);
        const step = [...(issue.steps ?? [])].reverse().find((s) => s.run?.kind === 'result');
        if (!step) return console.log('no result yet');
        const text = await api('GET', `${base(project)}/issues/${id}/steps/${step.number}/files/result.md`);
        console.log(text);
        const patch = step.files.find((f) => f.name === 'changes.patch');
        console.log(`---\n${link(path.join(step.path, 'result.md'))}${patch ? `  ${link(path.join(step.path, 'changes.patch'))} (${patch.size} bytes)` : '  (no patch)'}`);
    },

    async note(project, wanted, file) {
        const id = await resolveId(project, wanted);
        const step = await api('POST', `${base(project)}/issues/${id}/steps`, { name: 'note', text: readInput(file) });
        console.log(`added ${step.id} to ${project}/${id}`);
    },

    async preview(project, wanted, playbook) {
        const { id, p } = await previewOf(project, wanted, playbook);
        console.log(describePreview(project, id, p).join('\n'));
    },

    // The start carries the previewed configHash, so the server refuses it if the configuration changed in between.
    async start(project, wanted, playbook) {
        const { id, p } = await previewOf(project, wanted, playbook);
        console.log(describePreview(project, id, p).join('\n'));
        if (!p.configurationReady) fail('not started: the preview lists a blocking prerequisite');
        const run = await api('POST', `${base(project)}/issues/${id}/runs`, { playbook, configHash: p.configHash });
        console.log(`started ${project}/${id} run ${run.runId ?? run.id ?? JSON.stringify(run)}`);
    },

    // Body: { "actor": "<who decided>", "answers": { "Q1": "..." } } or { "actor": ..., "split": "accept" | "decline" }, optional "note".
    async answer(project, wanted, file) {
        const id = await resolveId(project, wanted);
        const body = JSON.parse(readInput(file));
        if (!body.actor) fail('the answer needs "actor": the person who decided, not the model');
        const issue = await api('GET', `${base(project)}/issues/${id}`);
        const run = issue.latestRun;
        if (!run?.ownerInput || run.ownerInput.answered) fail('the latest run has no unanswered triage questions');
        const r = await api('POST', `${base(project)}/issues/${id}/runs/${run.runId}/owner-input`, body);
        console.log(JSON.stringify(r, null, 2));
    },

    // The panel's own socket, so a caller (a person's terminal, an orchestrating session) learns of a run's progress
    // when it happens instead of polling. Output chunks and activity ticks are left out: they are on disk.
    async watch(project, ...flags) {
        const untilSettled = flags.includes('--until-settled');
        const wanted = flags.find((f) => !f.startsWith('--'));
        const id = wanted ? await resolveId(project, wanted) : null;
        if (untilSettled && !id) fail('--until-settled needs the issue whose run to wait for');
        const settledRun = async () => {
            const run = (await api('GET', `${base(project)}/issues/${id}`)).latestRun;
            return run && (!run.live || run.status === 'paused') ? run : null;
        };
        if (untilSettled) {
            const run = await settledRun();
            if (run) { console.log(`settled ${run.runId} ${run.status}${run.result ? ` / ${run.result}` : ''}`); return; }
        }
        const { io } = createRequire(path.join(ROOT, 'gui', 'package.json'))('socket.io-client');
        const socket = io(SERVER.origin, { auth: { token: token() }, rejectUnauthorized: false, transports: ['websocket'] });
        const time = () => new Date().toTimeString().slice(0, 8);
        socket.on('connect', () => console.log(`${time()} watching ${project}${id ? `/${id}` : ''}`));
        socket.on('connect_error', (e) => console.log(`${time()} cannot connect: ${e.data?.reason ?? e.message}`));
        socket.on('disconnect', (reason) => console.log(`${time()} disconnected: ${reason}`));
        socket.on('run:event', async (e) => {
            if (e.type === 'live' || e.type === 'activity' || e.project !== project || (id && e.issueId !== id)) return;
            const detail = [e.role, e.stepId, e.status ?? e.outcome ?? e.reason].filter(Boolean).join(' ');
            console.log(`${time()} ${id ? '' : `${e.issueId} `}${e.runId ?? ''} ${e.type}${detail ? ` ${detail}` : ''}`);
            // The run record, not the event, says whether it settled: a pause or an end is persisted before it is emitted.
            if (untilSettled && SETTLING.has(e.type)) {
                const run = await settledRun().catch(() => null);
                if (run) { console.log(`settled ${run.runId} ${run.status}${run.result ? ` / ${run.result}` : ''}`); socket.close(); }
            }
        });
    },
};

const SETTLING = new Set(['finished', 'paused', 'cancelled', 'run-recovery-required', 'run-finished', 'run-abandoned']);

async function previewOf(project, wanted, playbook) {
    if (!playbook) fail('name the playbook, e.g. implementation, plan-and-implement, analysis, staging');
    const id = await resolveId(project, wanted);
    const p = await api('GET', `/api/playbooks/${encodeURIComponent(playbook)}/preview?project=${encodeURIComponent(project)}&issue=${encodeURIComponent(id)}`);
    return { id, p };
}

function describePreview(project, id, p) {
    const target = p.checks?.target;
    const lines = [`${project}/${id} — ${p.playbook?.title ?? p.playbook?.id ?? '?'} (config ${String(p.configHash).slice(0, 12)})`,
        `checks: ${p.checks?.requirement ?? 'none'}${target ? `, ${target.kind}${target.compareBaseline ? ', with baseline' : ''}` : ''}`,
        `rounds: ${(p.limits?.rounds ?? []).map((r) => `${r.phase}=${r.maxRounds}`).join(' ') || '—'}`,
        `budgets: ${JSON.stringify(p.limits?.budgets ?? {})}`,
        `delivery: ${p.delivery?.action ?? '?'}${p.delivery?.destination ? ` → ${p.delivery.destination}` : ''}`];
    for (const x of p.prerequisites ?? []) lines.push(`${x.category}: ${x.kind} — ${x.detail ?? ''}`);
    return lines;
}

const args = process.argv.slice(2);
let given = null;
// -p is accepted anywhere: after the command it would otherwise be read as an issue id.
const at = args.indexOf('-p');
if (at >= 0) [, given] = args.splice(at, 2);
const [command, ...rest] = args;
if (!commands[command]) fail(USAGE);
commands[command](projectOf(given), ...rest).catch((e) => fail(e.message));
