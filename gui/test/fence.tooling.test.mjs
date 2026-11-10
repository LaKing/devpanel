import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { applyFence, fenceArgs, fencedCommand, TOOLING_BIN } from '../../harness/fence.mjs'
import { main as prettierCheck } from '../../harness/tooling/prettier-check.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { fingerprint, workspaceProjection } from '../server/runtime/fingerprint.mjs'
import { ensureMountPoint, resolveMounts, targetErrors } from '../server/runtime/tooling-mounts.mjs'
import { CHILD_OUTPUT_MEANING, CHILD_OUTPUT_UNCHECKED, CHILD_OUTPUT_UNOBSERVABLE, ISOLATION_INHERITED, ISOLATION_UNAVAILABLE, OFFLINE, renderToolingCommand, toolingBrief } from '../server/runtime/tooling-commands.mjs'
import { executed, runToolingCheck, toolingPassed } from '../live/tooling-check.mjs'

export const name = 'seat tooling — read-only mounts proved in the fence, contained mount points, offline commands'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PANEL = path.resolve(HERE, '..', '..')
const TOOLING = path.join(PANEL, 'harness', 'tooling')
const WRAPPER = path.join(TOOLING, 'offline')
const run = promisify(execFile)
const exists = (p) => fs.lstat(p).then(() => true, () => false)

/** Whether bubblewrap can run here; reported, so a skip is never mistaken for enforcement. */
async function sandboxMissing () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tooling-avail-'))
  try {
    const wrapped = fencedCommand({ command: '/bin/true', args: [], fence: await fenceArgs({ cwd: dir, writable: [dir] }) })
    const r = await runProcess({ command: wrapped.command, args: wrapped.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
    return r.code === 0 ? null : `bubblewrap failed: ${r.stderr.trim().slice(0, 120)}`
  } catch (error) {
    return error.code === 'ENOENT' ? 'bubblewrap or setpriv absent' : error.message
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

const sh = (script, env = { PATH: '/usr/bin:/bin' }) => runProcess({ command: '/bin/sh', args: ['-c', script], env, stdin: '' })

export default async function (t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tooling-')))
  try {
    t.section('1. targets: worktree-relative, normalised, never .git, never nested')
    {
      t.eq('a plain target is accepted', targetErrors([{ target: 'gui/node_modules', source: '/x' }]), [])
      for (const bad of ['/abs', 'a/../b', 'a//b', './a', 'a/.git/x', '.git']) t.ok(`"${bad}" is refused`, targetErrors([{ target: bad, source: '/x' }]).length === 1, JSON.stringify(targetErrors([{ target: bad, source: '/x' }])))
      t.ok('nested targets are refused', targetErrors([{ target: 'gui', source: '/x' }, { target: 'gui/node_modules', source: '/y' }]).length === 1)
    }

    t.section('2. a mount point is created inside the worktree, never through a link (auditor-1-003)')
    {
      const worktree = path.join(root, 'wt-2'), outside = path.join(root, 'outside-2')
      await fs.mkdir(worktree); await fs.mkdir(outside)
      const target = await ensureMountPoint(worktree, 'gui/node_modules')
      t.eq('missing components are created and the target returned', target, path.join(worktree, 'gui', 'node_modules'))
      t.ok('as an empty real directory', (await fs.lstat(target)).isDirectory() && !(await fs.readdir(target)).length)
      t.eq('a second call accepts the empty directory', await ensureMountPoint(worktree, 'gui/node_modules'), target)

      await fs.symlink(outside, path.join(worktree, 'tools'))
      const linked = await ensureMountPoint(worktree, 'tools/prettier').then(() => null, (e) => e)
      t.ok('a symlinked parent is refused, naming it', /tools is a symlink/.test(linked?.message ?? ''), linked?.message)
      t.eq('and nothing was written outside the worktree', await fs.readdir(outside), [])

      await fs.symlink(outside, path.join(worktree, 'gui', 'linked'))
      t.ok('a target that is itself a symlink is refused', /symlink/.test((await ensureMountPoint(worktree, 'gui/linked').catch((e) => e)).message ?? ''))
      await fs.writeFile(path.join(worktree, 'file'), 'x')
      t.ok('a file in the chain is refused', /not a directory/.test((await ensureMountPoint(worktree, 'file/sub').catch((e) => e)).message ?? ''))
      await fs.writeFile(path.join(target, 'planted'), 'x')
      t.ok('an occupied target is refused', /occupied/.test((await ensureMountPoint(worktree, 'gui/node_modules').catch((e) => e)).message ?? ''))
      t.eq('still nothing outside', await fs.readdir(outside), [])
    }

    t.section('3. sources: a missing one is recorded, not an error; source code is never a mount')
    {
      const project = path.join(root, 'project-3')
      await fs.mkdir(path.join(project, 'src'), { recursive: true })
      await fs.mkdir(path.join(project, 'deps', 'pkg'), { recursive: true })
      await fs.writeFile(path.join(project, 'src', 'a.js'), 'source\n')
      await fs.writeFile(path.join(project, 'deps', 'pkg', 'index.js'), 'dep\n')
      await fs.writeFile(path.join(project, '.gitignore'), 'deps/\n')
      await run('git', ['-C', project, 'init', '-q'])
      await run('git', ['-C', project, 'add', '-A'])
      const missing = await resolveMounts([{ target: 'x', source: path.join(root, 'no-such-tool'), provisional: true }], { projectPath: project })
      t.eq('a missing source is no error', missing.errors, [])
      t.eq('it is recorded missing, with its path', [missing.mounts[0].missing, missing.mounts[0].source, missing.mounts[0].provisional], [true, path.join(root, 'no-such-tool'), true])
      const ok = await resolveMounts([{ target: 'deps', source: 'deps' }], { projectPath: project })
      t.eq('an ignored dependency tree of the project is accepted (relative to the checkout)', [ok.errors, ok.mounts[0].sourceReal], [[], path.join(project, 'deps')])
      const source = await resolveMounts([{ target: 'src', source: 'src' }], { projectPath: project })
      t.ok('a directory the snapshot selects is refused', /holds source the snapshot selects \(src\/a\.js\)/.test(source.errors[0]?.message ?? ''), source.errors[0]?.message)
      const repo = await resolveMounts([{ target: 'p', source: project }], { projectPath: null })
      t.ok('a repository root is refused', /Git repository/.test(repo.errors[0]?.message ?? ''), repo.errors[0]?.message)
      const file = await resolveMounts([{ target: 'f', source: path.join(project, '.gitignore') }], { projectPath: null })
      t.ok('a file is refused', /not a directory/.test(file.errors[0]?.message ?? ''))
      const home = await resolveMounts([{ target: 'h', source: os.homedir() }], { projectPath: null })
      t.ok('the home directory is refused', /which no seat may read/.test(home.errors[0]?.message ?? ''), home.errors[0]?.message)
    }

    t.section('4. a mount target never counts in the fingerprint (AC1c)')
    {
      const worktree = path.join(root, 'wt-4')
      await fs.mkdir(path.join(worktree, 'tools', 'prettier'), { recursive: true })
      await fs.writeFile(path.join(worktree, 'source.txt'), 'candidate\n')
      const workspace = { path: worktree, isolation: 'git-worktree', toolingMounts: ['tools/prettier'] }
      const before = await fingerprint(worktree, { projection: workspaceProjection(workspace) })
      await fs.writeFile(path.join(worktree, 'tools', 'prettier', 'index.js'), 'tooling written through an unfenced turn\n')
      const after = await fingerprint(worktree, { projection: workspaceProjection(workspace) })
      t.eq('a file under the target leaves the revision unchanged', after.fingerprint, before.fingerprint)
      t.ok('and is not among its entries', !after.entries.some((e) => e.path.startsWith('tools/prettier')))
      const unprojected = await fingerprint(worktree, {})
      t.ok('without the projection it would have counted', unprojected.entries.some((e) => e.path === 'tools/prettier/index.js'))
      t.ok('a sibling with a common prefix still counts', (await fs.writeFile(path.join(worktree, 'tools', 'prettier-notes.md'), 'x'), (await fingerprint(worktree, { projection: workspaceProjection(workspace) })).entries.some((e) => e.path === 'tools/prettier-notes.md')))
    }

    t.section('5. one rendered form, used by prompts and by these tests (auditor-1-004)')
    {
      const line = renderToolingCommand({ id: 'unit', cwd: 'gui', run: "node -e 'x'" }, '/w t')
      t.eq('cd to the command directory, then the wrapper with the program directly', line, `cd '/w t/gui' && ${OFFLINE} sh -c 'node -e '\\''x'\\'''`)
      t.ok('never a "--" after the wrapper', !line.includes(`${OFFLINE} --`))
      t.eq('the root when no cwd is declared', renderToolingCommand({ id: 'a', run: 'true' }, '/w'), `cd '/w' && ${OFFLINE} sh -c 'true'`)
      const tooling = { mounts: [{ target: 'gui/node_modules', source: '/projects/p/gui/node_modules' }], commands: [{ id: 'unit', cwd: 'gui', run: 'node test/run.mjs <suite>', description: 'unit suites' }, { id: 'fmt', run: 'prettier --check <files>', provisional: true }] }
      const brief = toolingBrief({ tooling, worktree: '/w' })
      t.ok('the brief lists every command in the rendered form', tooling.commands.every((c) => brief.includes(renderToolingCommand(c, '/w'))))
      t.ok('names the mounts and marks provisional entries', brief.includes('gui/node_modules (from /projects/p/gui/node_modules)') && brief.includes('fmt (provisional)'))
      t.ok('and says "could not run" needs the quoted attempt, and what exit 125 means', brief.includes('is not "could not run" unless you quote') && brief.includes(ISOLATION_UNAVAILABLE))
      t.ok('a seat without a shell is told so instead', toolingBrief({ tooling, worktree: '/w', shell: false }).includes('no shell in this turn'))
      t.eq('nothing declared, no brief', toolingBrief({ tooling: {}, worktree: '/w' }), null)
      // The fenced brief, byte for byte: base 098f95c's (P2-1) plus what a child-output line means for a verdict.
      const GOLDEN = "Project tooling (projects/<id>.yaml workspace.tooling).\nMounted read-only in the worktree: gui/node_modules (from /projects/p/gui/node_modules). Never install anything: these are read-only, and the commands below have no network.\nDeclared commands, each to be run exactly in the form shown (fill in <placeholders>):\n- unit: unit suites\n  cd '/w/gui' && /run/devpanel/tooling/offline sh -c 'node test/run.mjs <suite>'\n- fmt (provisional)\n  cd '/w' && /run/devpanel/tooling/offline sh -c 'prettier --check <files>'\nA listed command is not \"could not run\" unless you quote the command line you ran and its output. Exit 125 with \"devpanel-offline: network isolation could not start in this seat\" means isolation is unavailable here and the command was NOT run: record it as not run, quoting the command line and that output, and do not run it any other way (not without the wrapper, not with network). \"devpanel-offline: isolation inherited\" means the command ran under a proved socket denial instead of a network namespace (your runtime's own, or a filter the wrapper installed), which refuses loopback too: a failure to listen on or reach 127.0.0.1 is that, not a defect of the candidate. With \"devpanel-offline: child output unobservable\" on a command's stderr, a result that depends on a Node child's output, such as exit 0 with nothing printed or a test failing on empty child output like \"Unexpected end of JSON input\", is not evidence: not \"the command printed nothing\", not a pass, and not by itself a defect of the candidate. Record it as not observed under verification.notRun, quoting the line, and judge from other evidence such as a check drive. \"devpanel-offline: child output unchecked\" means it is not known whether such output can be read here. Through the wrapper with neither line, empty output with exit 0 means the command printed nothing."
      const GOLDEN_NO_SHELL = "Project tooling (projects/<id>.yaml workspace.tooling).\nMounted read-only in the worktree: gui/node_modules (from /projects/p/gui/node_modules). Never install anything: these are read-only, and the commands below have no network.\nDeclared commands, each to be run exactly in the form shown (fill in <placeholders>):\n- unit: unit suites\n  cd '/w/gui' && /run/devpanel/tooling/offline sh -c 'node test/run.mjs <suite>'\n- fmt (provisional)\n  cd '/w' && /run/devpanel/tooling/offline sh -c 'prettier --check <files>'\nYour runtime has no shell in this turn, so you cannot run these: record each one you would need under not run, saying so."
      t.eq('inside the fence the brief is byte for byte the expected text', toolingBrief({ tooling, worktree: '/w' }), GOLDEN)
      t.eq('and for a seat without a shell', toolingBrief({ tooling, worktree: '/w', shell: false }), GOLDEN_NO_SHELL)
      t.ok('it names the Linux labels: enforced by the wrapper, or isolation inherited (P2-5)', GOLDEN.includes(`${OFFLINE} sh -c`) && GOLDEN.includes(ISOLATION_INHERITED) && GOLDEN.includes(ISOLATION_UNAVAILABLE))

      const plainWords = (text) => text.replace(/[`"]/g, '').replace(/\s+/g, ' ')
      const contract = await fs.readFile(path.join(PANEL, 'docs', 'execution-contract.md'), 'utf8')
      t.ok('the execution contract states the same verdict meaning as the prompt', plainWords(contract).includes(plainWords(CHILD_OUTPUT_MEANING)))
      t.ok('and no brief without the wrapper claims it', !toolingBrief({ tooling, worktree: '/w', shell: false }).includes(CHILD_OUTPUT_UNOBSERVABLE) && !toolingBrief({ tooling, worktree: '/w', confinement: { mode: 'unconfined', reason: 'r' } }).includes(CHILD_OUTPUT_UNOBSERVABLE))

      // Without the fence (P2-2, P2-3, P3-2): no wrapper, no network claim, no read-only mounts.
      const unconfined = toolingBrief({ tooling, worktree: '/w', confinement: { mode: 'unconfined', reason: 'macOS (darwin) has no seat fence; opted in' } })
      t.ok('unconfined: every command unwrapped and labelled', tooling.commands.every((c) => unconfined.includes(`${renderToolingCommand(c, '/w', { offline: false })}`)) && unconfined.includes('UNCONFINED') && unconfined.includes('[unconfined]'), unconfined)
      t.ok('never the wrapper, never "no network", never "read-only"', !unconfined.includes(OFFLINE) && !unconfined.includes('no network') && !unconfined.includes('read-only') && !unconfined.includes(ISOLATION_INHERITED))
      t.ok('the mounts are said NOT to be bound', unconfined.includes('NOT bound') && unconfined.includes('gui/node_modules (from /projects/p/gui/node_modules)'))
      t.ok('a seat without a shell keeps its sentence (auditor-2-003)', toolingBrief({ tooling, worktree: '/w', shell: false, confinement: { mode: 'unconfined', reason: 'r' } }).endsWith('Your runtime has no shell in this turn, so you cannot run these: record each one you would need under not run, saying so.'))
      const refused = toolingBrief({ tooling, worktree: '/w', confinement: { mode: 'refused', reason: 'macOS (darwin) has no seat fence and this install has not opted in' } })
      t.ok('refused: the commands are named, refused, with the reason, and not given to run', refused.includes('REFUSED') && refused.includes('unit, fmt') && refused.includes('has not opted in') && !refused.includes('sh -c') && !refused.includes(OFFLINE), refused)
    }

    t.section('6. the offline wrapper: no separator, fails closed unless the runtime\'s denial is proved (cases 3 and 4)')
    {
      const marker = path.join(root, 'marker-6')
      const separator = await runProcess({ command: '/bin/sh', args: [WRAPPER, '--', 'sh', '-c', `: > ${marker}`], env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      t.eq('a leading "--" is refused (exit 64)', separator.code, 64, separator.stderr)
      t.ok('saying why', /no "--" separator/.test(separator.stderr))
      t.eq('and the command did not run', await exists(marker), false)
      const empty = await runProcess({ command: '/bin/sh', args: [WRAPPER], env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      t.eq('no program is a usage error (exit 64)', empty.code, 64)

      // Nothing on PATH or in the environment takes part: stubs and preloads that would "prove" are never run (auditor-1-001).
      const stubDir = path.join(root, 'stubs-6'), touched = path.join(root, 'touched-6')
      await fs.mkdir(stubDir)
      for (const name of ['bwrap', 'python3', 'node', 'env', 'cat', 'tail']) await fs.writeFile(path.join(stubDir, name), `#!/bin/sh\necho ${name} >> ${touched}\necho "proved $5"\nexit 0\n`, { mode: 0o755 })
      await fs.writeFile(path.join(stubDir, 'preload.cjs'), `require('fs').appendFileSync(${JSON.stringify(touched)}, 'NODE_OPTIONS\\n'); process.exit(0)\n`)
      await fs.writeFile(path.join(stubDir, 'sitecustomize.py'), `open(${JSON.stringify(touched)}, 'a').write('PYTHONPATH\\n'); raise SystemExit(0)\n`)
      await fs.writeFile(path.join(stubDir, 'startup.py'), `open(${JSON.stringify(touched)}, 'a').write('PYTHONSTARTUP\\n'); raise SystemExit(0)\n`)
      const hostile = { PATH: `${stubDir}:/usr/bin:/bin`, NODE_OPTIONS: `--require ${path.join(stubDir, 'preload.cjs')}`, PYTHONPATH: stubDir, PYTHONSTARTUP: path.join(stubDir, 'startup.py') }
      const rendered = renderToolingCommand({ id: 'probe', run: `: > ${marker}` }, root).replace(OFFLINE, `/bin/sh ${WRAPPER}`)
      const plain = await sh(rendered, hostile)
      t.eq('stub bwrap/python3/node/env/cat/tail on PATH, NODE_OPTIONS, PYTHONPATH and PYTHONSTARTUP are never run by the wrapper', await fs.readFile(touched, 'utf8').catch(() => ''), '', plain.stderr)
      await fs.rm(marker, { force: true })

      // Real seccomp filters, installed by bubblewrap around the wrapper: the
      // runtime's denial as Codex installs it, and filters that must not pass.
      const SYS = { x64: { arch: 0xc000003e, socket: 41, bind: 49, getsockopt: 55, getsockname: 51, prctl: 157 }, arm64: { arch: 0xc00000b7, socket: 198, bind: 200, getsockopt: 209, getsockname: 204, prctl: 167 } }[process.arch]
      const ins = (code, jt, jf, k) => { const b = Buffer.alloc(8); b.writeUInt16LE(code, 0); b[2] = jt; b[3] = jf; b.writeUInt32LE(k >>> 0, 4); return b }
      /** A classic-BPF seccomp program: each rule refuses one syscall with EPERM, optionally only for (or except for) one first argument. */
      const filter = async (name, rules) => {
        const LD = 0x20, JEQ = 0x15, RET = 0x06, ALLOW = 0x7fff0000, EPERM = 0x00050001
        const out = [ins(LD, 0, 0, 4), ins(JEQ, 1, 0, SYS.arch), ins(RET, 0, 0, ALLOW)]
        for (const r of rules) {
          out.push(ins(LD, 0, 0, 0))
          if (r.arg0 === undefined) out.push(ins(JEQ, 0, 1, r.nr), ins(RET, 0, 0, EPERM))
          else out.push(ins(JEQ, 0, 3, r.nr), ins(LD, 0, 0, 16), r.not ? ins(JEQ, 1, 0, r.arg0) : ins(JEQ, 0, 1, r.arg0), ins(RET, 0, 0, EPERM))
        }
        out.push(ins(RET, 0, 0, ALLOW))
        const file = path.join(root, `${name}.bpf`); await fs.writeFile(file, Buffer.concat(out)); return file
      }
      const quoteSh = (s) => `'${s.replaceAll("'", `'"'"'`)}'`
      const underFilter = (bpf, line, env = { PATH: '/usr/bin:/bin' }) => sh(`/usr/bin/bwrap --dev-bind / / --seccomp 3 -- /bin/sh -c ${quoteSh(line)} 3< ${quoteSh(bpf)}`, env)
      const canFilter = SYS ? await underFilter(await filter('none', []), 'true') : null
      if (!SYS || canFilter.code !== 0) t.skip(`seccomp-filtered wrapper cases: ${SYS ? `bwrap --seccomp failed here: ${canFilter.stderr.trim().slice(0, 160)}` : `no syscall table for ${process.arch}`}`)
      else {
        const AF_UNIX = 1, AF_NETLINK = 16
        const codexLike = await filter('codex-like', [{ nr: SYS.socket, arg0: AF_UNIX, not: true }])
        const netlinkOnly = await filter('netlink-only', [{ nr: SYS.socket, arg0: AF_NETLINK }])
        const bindOnly = await filter('bind-only', [{ nr: SYS.socket, arg0: AF_NETLINK }, { nr: SYS.bind }])

        // Where no namespace can start and the runtime refuses nothing (a Claude seat's Bash sandbox), the
        // wrapper installs its own socket filter and the same proof decides: the command runs without network.
        const IMPOSED = /this wrapper installed a seccomp filter of its own that refuses every socket/
        const creates = (family) => `cd ${quoteSh(root)} && /bin/sh ${WRAPPER} /usr/bin/python3 -c 'import socket; socket.socket(socket.${family}); print("SOCKET-CREATED")'`
        const imposedRun = await underFilter(netlinkOnly, rendered)
        t.eq('a namespace that cannot start and IP sockets that open: the wrapper imposes the denial and the command runs', [imposedRun.code, await exists(marker)], [0, true], imposedRun.stderr)
        t.ok('saying so, loopback included, and never "unavailable"', imposedRun.stderr.includes(ISOLATION_INHERITED) && IMPOSED.test(imposedRun.stderr) && /loopback is refused too/.test(imposedRun.stderr) && !imposedRun.stderr.includes(ISOLATION_UNAVAILABLE), imposedRun.stderr)
        await fs.rm(marker, { force: true })
        for (const family of ['AF_INET', 'AF_INET6', 'AF_UNIX', 'AF_NETLINK']) {
          const made = await underFilter(netlinkOnly, creates(family))
          t.ok(`the command it runs cannot create an ${family} socket`, made.code !== 0 && !made.stdout.includes('SOCKET-CREATED') && /Operation not permitted/.test(made.stderr), `${made.code} ${made.stdout} ${made.stderr}`)
        }
        const piped = await underFilter(netlinkOnly, `cd ${quoteSh(root)} && /bin/sh ${WRAPPER} /bin/sh -c 'echo through-a-pipe | /bin/cat; exit 7'`)
        t.eq('pipes to children still work there, and the exit code is the command\'s own', [piped.code, piped.stdout], [7, 'through-a-pipe\n'], piped.stderr)

        const bindDenied = await underFilter(bindOnly, rendered)
        t.eq('a filter that refuses bind but lets IP sockets be created is not accepted as it stands (auditor-1-002): the wrapper\'s own filter is what the command runs under', [bindDenied.code, await exists(marker), IMPOSED.test(bindDenied.stderr)], [0, true, true], bindDenied.stderr)
        await fs.rm(marker, { force: true })

        const bypass = await underFilter(netlinkOnly, rendered, hostile)
        t.eq('the auditor\'s bypass (preload exiting 0, stub interpreters on PATH) under a network-permitting filter: the command runs only under the imposed filter (auditor-1-001)', [bypass.code, await exists(marker), IMPOSED.test(bypass.stderr)], [0, true, true], bypass.stderr)
        t.eq('and none of the stubs ran', await fs.readFile(touched, 'utf8').catch(() => ''), '')
        await fs.rm(marker, { force: true })
        const hostileSocket = await underFilter(netlinkOnly, creates('AF_INET'), hostile)
        t.ok('in that environment too the command cannot create an IP socket', hostileSocket.code !== 0 && !hostileSocket.stdout.includes('SOCKET-CREATED'), `${hostileSocket.code} ${hostileSocket.stdout} ${hostileSocket.stderr}`)
        const seatSet = await underFilter(netlinkOnly, rendered, { PATH: '/usr/bin:/bin', DEVPANEL_OFFLINE_IMPOSED: '1' })
        t.eq('a seat that sets the second-pass marker itself gains nothing: exit 125, not run', [seatSet.code, await exists(marker)], [125, false], seatSet.stderr)

        // Where the filter cannot be installed either, it stays what it was: exit 125, nothing run.
        const noPrctl = await filter('no-prctl', [{ nr: SYS.socket, arg0: AF_NETLINK }, { nr: SYS.prctl }])
        const unavailable = await underFilter(noPrctl, rendered)
        t.eq('a namespace that cannot start, IP sockets that open and a filter that cannot be installed: exit 125', unavailable.code, 125, unavailable.stderr)
        t.ok('with the isolation-unavailable message', unavailable.stderr.includes(ISOLATION_UNAVAILABLE) && /NOT run/.test(unavailable.stderr), unavailable.stderr)
        t.ok('why the runtime\'s denial was not accepted', unavailable.stderr.includes('not proved: IP sockets are not refused (TCP/IPv4 created'), unavailable.stderr)
        t.ok('and why none could be imposed', /could not impose one: prctl refused the filter/.test(unavailable.stderr), unavailable.stderr)
        t.eq('and the command never ran (no network fallback)', await exists(marker), false)

        // The auditor's loader bypasses: a preload whose constructor, in anything
        // but the shell, forges `proved <last argument>` and exits 0, or exits 1
        // with PATH-stubbed cat/tail beside it. Built here; skipped without a compiler.
        const forgerSource = path.join(root, 'forger.c')
        await fs.writeFile(forgerSource, [
          '#include <stdio.h>', '#include <string.h>', '#include <unistd.h>', '#include <fcntl.h>',
          '__attribute__((constructor)) static void forge (void) {',
          '  char exe[4096]; ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1); if (n < 0) return; exe[n] = 0;',
          '  if (strstr(exe, "bash") || strstr(exe, "/dash") || !strcmp(exe, "/usr/bin/sh")) return;',
          '  int m = open(MARK, O_WRONLY | O_APPEND | O_CREAT, 0644); if (m >= 0) { dprintf(m, "preload in %s\\n", exe); close(m); }',
          '  char args[65536]; int f = open("/proc/self/cmdline", O_RDONLY); ssize_t k = f < 0 ? 0 : read(f, args, sizeof args - 1); if (k < 1) k = 1; args[k] = 0;',
          '  char *last = args; for (char *p = args; p < args + k - 1; p++) if (!*p) last = p + 1;',
          '  if (MODE == 0) { printf("proved %s\\n", last); fflush(stdout); }',
          '  _exit(MODE);',
          '}', ''].join('\n'))
        const forger = async (mode) => {
          const lib = path.join(root, `forger-${mode}.so`)
          try { await run('cc', ['-shared', '-fPIC', `-DMODE=${mode}`, `-DMARK="${touched}"`, '-o', lib, forgerSource]); return lib } catch (error) { return { error: error.code === 'ENOENT' ? 'no C compiler (cc)' : String(error.stderr ?? error.message).slice(0, 160) } }
        }
        const forging = await forger(0), failing = await forger(1)
        if (typeof forging !== 'string' || typeof failing !== 'string') t.skip(`LD_PRELOAD bypass cases: ${(forging.error ?? failing.error)}`)
        else {
          const preloaded = (lib) => rendered.replace(`/bin/sh ${WRAPPER}`, `LD_PRELOAD=${quoteSh(lib)} /bin/sh ${WRAPPER}`)
          const control = await underFilter(netlinkOnly, `LD_PRELOAD=${quoteSh(forging)} /bin/true`)
          t.ok('control: the preload library does run in a program it reaches', control.code === 0 && (await fs.readFile(touched, 'utf8').catch(() => '')).includes('preload in /usr/bin/true'), control.stderr)
          await fs.rm(touched, { force: true })
          const forged = await underFilter(netlinkOnly, preloaded(forging))
          t.eq('an LD_PRELOAD constructor that forges "proved <nonce>" in env/python3 forges nothing: the command runs only under the imposed filter (auditor-1-001)', [forged.code, await exists(marker), IMPOSED.test(forged.stderr)], [0, true, true], forged.stderr)
          await fs.rm(marker, { force: true })
          t.eq('because no program the wrapper executes gets the preload', await fs.readFile(touched, 'utf8').catch(() => ''), '')
          const exitOne = await underFilter(netlinkOnly, preloaded(failing), hostile)
          t.eq('a preload exiting 1 with PATH-stubbed cat and tail changes nothing either (auditor-1-001)', [exitOne.code, await exists(marker), IMPOSED.test(exitOne.stderr)], [0, true, true], exitOne.stderr)
          await fs.rm(marker, { force: true })
          t.eq('and neither the preload nor the stubs ran', await fs.readFile(touched, 'utf8').catch(() => ''), '')
          const genuine = await underFilter(codexLike, preloaded(forging), hostile)
          t.eq('under Codex\'s denial the same preload changes nothing: the genuine verifier proves it, the command runs', [genuine.code, await exists(marker), await fs.readFile(touched, 'utf8').catch(() => '')], [0, true, ''], genuine.stderr)
          await fs.rm(marker, { force: true })
        }

        const accepted = await underFilter(codexLike, rendered)
        t.eq('Codex\'s denial (every socket family but AF_UNIX refused): the command runs under it (AC2)', [accepted.code, await exists(marker)], [0, true], accepted.stderr)
        t.ok('and says so, loopback included', accepted.stderr.includes(ISOLATION_INHERITED) && /loopback is refused too/.test(accepted.stderr) && !accepted.stderr.includes(ISOLATION_UNAVAILABLE), accepted.stderr)
        await fs.rm(marker, { force: true })
        const acceptedHostile = await underFilter(codexLike, rendered, hostile)
        t.eq('the same in the hostile environment: the genuine verifier decides, the stubs never run', [acceptedHostile.code, await fs.readFile(touched, 'utf8').catch(() => '')], [0, ''], acceptedHostile.stderr)
        const confined = await underFilter(codexLike, `cd ${quoteSh(root)} && /bin/sh ${WRAPPER} /usr/bin/python3 -c 'import socket; socket.socket(socket.AF_INET); print("IP-SOCKET-CREATED")'`)
        t.ok('and the command it runs really cannot create an IP socket', confined.code !== 0 && !confined.stdout.includes('IP-SOCKET-CREATED') && /Operation not permitted/.test(confined.stderr), `${confined.code} ${confined.stdout} ${confined.stderr}`)
        await fs.rm(marker, { force: true })
      }

      t.section('6b. the wrapper says when a Node child\'s output cannot be read, and changes nothing else')
      const NONCED = /\[[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]/
      // Installed by prctl, not bubblewrap: it needs no namespace, so these run where section 6's filtered cases skip.
      const UNDER_PRCTL = [
        'import ctypes, os, sys',
        'prog = open(sys.argv[1], "rb").read()',
        'buf = ctypes.create_string_buffer(prog)',
        'class P(ctypes.Structure): _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]',
        'f = P(len(prog) // 8, ctypes.addressof(buf))',
        'libc = ctypes.CDLL(None, use_errno=True)',
        'if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(f), 0, 0): sys.exit(99)',
        'os.execv(sys.argv[2], sys.argv[2:])'
      ].join('\n')
      const READS = (child) => `require("node:child_process").execFile(process.execPath,["-e","${child}"],(e,o)=>console.log(JSON.stringify(o)))`
      // Through a pipe, as a seat's shell has it: only a socket stdout is what is being measured here.
      const reading = (child) => ['/bin/sh', '-c', `/usr/bin/node -e '${READS(child)}' | /bin/cat`]
      const underPrctl = (bpf, argv) => runProcess({ command: '/usr/bin/python3', args: ['-I', '-c', UNDER_PRCTL, bpf, '/bin/sh', WRAPPER, ...argv], env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      const canPrctl = SYS ? await underPrctl(await filter('prctl-none', []), ['/bin/true']) : null
      if (!SYS || canPrctl.code === 99 || await fs.access('/usr/bin/node').then(() => false, () => true)) t.skip(`child-output cases under a real filter: ${SYS ? 'prctl refused, or no /usr/bin/node' : `no syscall table for ${process.arch}`}`)
      else {
        const AF_UNIX = 1
        const refuseIp = { nr: SYS.socket, arg0: AF_UNIX, not: true }
        const ipOnly = await filter('ip-only', [refuseIp])
        const childUnread = await filter('child-unread', [refuseIp, { nr: SYS.getsockopt }, { nr: SYS.getsockname }])

        const lost = await underPrctl(childUnread, reading('console.log(1234)'))
        t.eq('where a Node child\'s output is discarded, the command still runs: exit 0 and empty output', [lost.code, lost.stdout], [0, '""\n'], lost.stderr)
        t.ok('and stderr says so, with this call\'s nonce (AC3)', lost.stderr.includes(ISOLATION_INHERITED) && lost.stderr.includes(CHILD_OUTPUT_UNOBSERVABLE) && NONCED.test(lost.stderr), lost.stderr)
        const direct = await underPrctl(childUnread, ['/bin/sh', '-c', 'echo direct'])
        t.eq('what a command writes directly is still seen there', [direct.code, direct.stdout], [0, 'direct\n'], direct.stderr)
        const quiet = await underPrctl(childUnread, ['/bin/true'])
        t.eq('a command that prints nothing there: exit 0, empty, the same line beside it', [quiet.code, quiet.stdout, quiet.stderr.includes(CHILD_OUTPUT_UNOBSERVABLE)], [0, '', true], quiet.stderr)
        t.eq('the exit code stays the command\'s own', (await underPrctl(childUnread, ['/bin/sh', '-c', 'exit 7'])).code, 7)

        const intact = await underPrctl(ipOnly, reading('console.log(1234)'))
        t.eq('the runtime\'s network denial alone loses nothing', [intact.code, intact.stdout], [0, `${JSON.stringify('1234\n')}\n`], intact.stderr)
        t.ok('and says nothing about child output', !intact.stderr.includes('child output'), intact.stderr)
        const reallyEmpty = await underPrctl(ipOnly, reading('0'))
        t.eq('a Node child that really printed nothing reads as that (AC4)', [reallyEmpty.code, reallyEmpty.stdout, reallyEmpty.stderr.includes('child output')], [0, '""\n', false], reallyEmpty.stderr)
        const silent = await underPrctl(ipOnly, ['/bin/true'])
        t.eq('a command that really printed nothing reads as that (AC4)', [silent.code, silent.stdout, silent.stderr.includes('child output')], [0, '', false], silent.stderr)
      }

      // The same decisions with fake bwrap, verifier and Node, so every path runs on any host.
      const fakes = path.join(root, 'fakes-6b')
      await fs.mkdir(fakes)
      const fake = async (name, body) => { const file = path.join(fakes, name); await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return file }
      const wrapperText = await fs.readFile(WRAPPER, 'utf8')
      const bwrapStarts = await fake('bwrap-starts', 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"')
      const bwrapRefuses = await fake('bwrap-refuses', 'echo refused >&2; exit 1')
      const proves = await fake('verifier-proves', 'echo "proved $5"')
      const disproves = await fake('verifier-disproves', 'echo "IP sockets are not refused"; exit 1')
      const nodeRan = path.join(fakes, 'node-ran')
      const nodeSays = (name, line) => fake(name, `: > ${nodeRan}\n${line}`)
      const wrapped = async (name, { bwrap = bwrapStarts, verifier = disproves, node, imposer = path.join(fakes, 'no-imposer') }, argv) => {
        const copy = path.join(fakes, `offline-${name}`)
        await fs.writeFile(copy, wrapperText.replace('BWRAP=/usr/bin/bwrap', `BWRAP=${bwrap}`).replace('VERIFIER=/usr/bin/python3', `VERIFIER=${verifier}`).replace('IMPOSER=/usr/bin/python3', `IMPOSER=${imposer}`).replace('NODE=/usr/bin/node', `NODE=${node}`))
        await fs.rm(nodeRan, { force: true })
        return runProcess({ command: '/bin/sh', args: [copy, ...argv], env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      }
      t.ok('the wrapper\'s fixed paths are what these replace', ['BWRAP=/usr/bin/bwrap', 'VERIFIER=/usr/bin/python3', 'IMPOSER=/usr/bin/python3', 'NODE=/usr/bin/node'].every((line) => wrapperText.split('\n').includes(line)))

      const observed = await nodeSays('node-observed', 'echo "observed $3"')
      const discarded = await nodeSays('node-discarded', 'echo "discarded $3"')
      const namespace = await wrapped('a', { node: observed }, ['/bin/true'])
      t.eq('read in a namespace: exit 0, and stdout and stderr both empty (AC4)', [namespace.code, namespace.stdout, namespace.stderr], [0, '', ''])
      const said = await wrapped('b', { node: discarded }, ['/bin/sh', '-c', 'echo ran; exit 3'])
      t.eq('discarded in a namespace: it runs with its own exit code, and says so', [said.code, said.stdout, said.stderr.includes(CHILD_OUTPUT_UNOBSERVABLE)], [3, 'ran\n', true], said.stderr)
      const inherited = await wrapped('c', { bwrap: bwrapRefuses, verifier: proves, node: discarded }, ['/bin/true'])
      t.ok('discarded under the proved denial: both lines', inherited.code === 0 && inherited.stderr.includes(ISOLATION_INHERITED) && inherited.stderr.includes(CHILD_OUTPUT_UNOBSERVABLE), inherited.stderr)

      for (const [label, node, word] of [
        ['a child that failed', await nodeSays('node-failed', 'echo "failed $3 EPERM"'), 'EPERM'],
        ['a child whose output was altered', await nodeSays('node-altered', 'echo "failed $3 altered"'), 'altered'],
        ['a measurement that answered nothing', await nodeSays('node-silent', 'exit 0'), 'no answer'],
        ['an answer without this call\'s nonce', await nodeSays('node-foreign', 'echo "discarded 00000000-0000-0000-0000-000000000000"'), 'no answer'],
        ['no Node at the fixed path', path.join(fakes, 'absent'), 'no answer']
      ]) {
        const r = await wrapped('d', { node }, ['/bin/sh', '-c', 'echo ran'])
        t.eq(`${label} is unchecked, never unobservable (AC7), and the command runs`, [r.code, r.stdout, r.stderr.includes(CHILD_OUTPUT_UNCHECKED), r.stderr.includes(CHILD_OUTPUT_UNOBSERVABLE), r.stderr.includes(word)], [0, 'ran\n', true, false, true], r.stderr)
      }

      const notRun = path.join(fakes, 'not-run')
      const refused = await wrapped('e', { bwrap: bwrapRefuses, node: discarded }, ['/bin/sh', '-c', `: > ${notRun}`])
      t.eq('neither isolation and nothing to impose one with: exit 125, not run, as before (AC6)', [refused.code, await exists(notRun), refused.stderr.includes(ISOLATION_UNAVAILABLE), /NOT run/.test(refused.stderr), /could not impose one: no /.test(refused.stderr)], [125, false, true, true, true], refused.stderr)
      t.eq('and nothing is measured or said about child output', [await exists(nodeRan), refused.stderr.includes('child output')], [false, false], refused.stderr)
    }

    t.section('7. the Prettier launcher calls the application\'s own formatter handler, adds nothing, never writes')
    {
      const formatter = path.join(root, 'app', '@app-modules', 'formatter')
      await fs.mkdir(path.join(formatter, 'run@servers'), { recursive: true })
      // A fake of the application's formatter handler: "formatted" means ending in a newline;
      // .txt is a type it does not format; "syntax error" does not parse. It
      // records what it was handed so the test can see nothing else was added.
      const handler = path.join(formatter, 'run@servers', 'prettier.mjs')
      await fs.writeFile(handler, [
        'export const seen = []',
        'export default async function ({ filepath, content }) {',
        '  seen.push(Object.keys(arguments[0]).sort())',
        '  if (filepath.endsWith(".txt")) return null',
        '  if (content.includes("syntax error")) return { mistakes: new Error("Unexpected token") }',
        '  return { content: content.endsWith("\\n") ? content : content + "\\n" }',
        '}', ''].join('\n'))
      const good = path.join(root, 'good.mjs'), bad = path.join(root, 'bad.mjs'), broken = path.join(root, 'broken.mjs'), text = path.join(root, 'notes.txt')
      await fs.writeFile(good, 'export const a = 1\n'); await fs.writeFile(bad, 'export const a = 1')
      await fs.writeFile(broken, 'syntax error\n'); await fs.writeFile(text, 'free text')
      const lines = []
      const sink = { out: (l) => lines.push(l), err: (l) => lines.push(l) }
      t.eq('formatted files: exit 0', await prettierCheck(['--settings', handler, '--check', good], sink), 0)
      t.eq('an unformatted file: exit 1, listed', [await prettierCheck(['--settings', handler, '--check', good, bad], sink), lines.some((l) => l.includes('[warn] ' + bad))], [1, true])
      lines.length = 0
      t.eq('a file that does not parse: exit 1, with the parser\'s words', [await prettierCheck(['--settings', handler, '--check', broken], sink), lines.some((l) => l.includes(broken) && l.includes('Unexpected token'))], [1, true])
      lines.length = 0
      t.eq('a type the formatter does not format is skipped, not failed', [await prettierCheck(['--settings', handler, '--check', good, text], sink), lines.some((l) => l.startsWith('[skip] ' + text))], [0, true])
      const { seen } = await import(handler)
      t.eq('the handler got the file path and content, nothing else', seen[0], ['content', 'filepath'])
      t.eq('the files were not written', await fs.readFile(bad, 'utf8'), 'export const a = 1')
      const runner = path.join(formatter, 'run@servers', 'runner.mjs')
      await fs.writeFile(runner, 'export function format () {}\nexport const options = { printWidth: 180 }\n')
      lines.length = 0
      t.eq('a module with no default handler: exit 2', await prettierCheck(['--settings', runner, '--check', good], sink), 2)
      t.ok('naming its exports', lines.some((l) => l.includes('no default-exported handler') && l.includes('format')), lines.join(' | '))
    }

    t.section('7b. a selection that cannot be read refuses the mount (auditor-1-008)')
    {
      const project = path.join(root, 'project-7b')
      await fs.mkdir(path.join(project, 'src'), { recursive: true })
      await fs.writeFile(path.join(project, 'src', 'tracked.js'), 'source\n')
      await run('git', ['-C', project, 'init', '-q'])
      await run('git', ['-C', project, 'add', '-A'])
      const emptyPath = path.join(root, 'no-git'); await fs.mkdir(emptyPath)
      const saved = process.env.PATH
      process.env.PATH = emptyPath
      let r
      try { r = await resolveMounts([{ target: 'src', source: 'src' }], { projectPath: project }) } finally { process.env.PATH = saved }
      t.ok('with no git on PATH the source is refused, not admitted as an empty selection', /could not be checked against the snapshot selection/.test(r.errors[0]?.message ?? ''), JSON.stringify(r.errors))
    }

    t.section('7c. the live tooling verdict reads exit codes and decoded commands, and binds no rejected source (auditor-1-005, -006, -007)')
    {
      // A checkout to export, a tool to mount, and a fake runtime that answers
      // every numbered command of the prompt with a recorded exit status.
      const checkout = path.join(root, 'checkout-7c')
      await fs.mkdir(path.join(checkout, 'gui'), { recursive: true })
      await fs.writeFile(path.join(checkout, 'gui', 'source.txt'), 'x\n')
      await run('git', ['-C', checkout, 'init', '-q'])
      await run('git', ['-C', checkout, 'add', '-A'])
      const tool = path.join(root, 'tool-7c'); await fs.mkdir(tool); await fs.writeFile(path.join(tool, 'index.js'), '1\n')
      const commands = [{ id: 'unit', cwd: 'gui', run: 'node test/run.mjs <suite>' }, { id: 'visual', cwd: 'gui', run: 'DEVPANEL_DIST_DIR="$DEVPANEL_SCRATCH_DIR/dist" node -e "console.log(\'quoted\')"' },
        { id: 'fmt', run: 'node /run/devpanel/tooling/prettier-check.mjs --settings s.mjs --check gui/source.txt' }]
      const config = (source) => ({ projects: new Map([['p', { workspace: { tooling: { mounts: [{ target: 'gui/node_modules', source }], commands } } }]]) })
      const quoteSh = (s) => `'${s.replaceAll("'", `'"'"'`)}'`
      const fakeRuntime = (harnessId, answer) => {
        const invoked = []
        return { invoked, adapter: {
          probe: async () => ({ installation: { status: 'installed', version: 'fake' } }),
          invoke: async ({ prompt, observe, fence }) => {
            invoked.push(prompt)
            const lines = prompt.split('\n').map((l) => /^\d+\. (.*)$/.exec(l)?.[1]).filter(Boolean)
            const events = []
            lines.forEach((line, i) => {
              const a = answer(line)
              if (!a) return
              if (harnessId === 'codex') events.push({ type: 'item.completed', item: { type: 'command_execution', command: a.command ?? `/bin/bash -lc ${quoteSh(line)}`, exit_code: a.code, status: 'completed', aggregated_output: a.output } })
              else {
                events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: a.command ?? line } }] } })
                events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: a.code !== 0, content: a.code !== 0 ? `Exit code ${a.code}\n${a.output}` : a.output }] } })
              }
            })
            observe.onOutput('stdout', events.map((e) => JSON.stringify(e)).join('\n') + '\n')
            return { response: 'done', diagnostics: { fence: { namespace: 1, mounts: { tooling: fence.mounts.map((m) => ({ target: m.target, source: m.source })) } } } }
          }
        } }
      }
      const answer = (overrides = {}) => (line) => {
        if (line.endsWith('/bin/true')) return { code: 0, output: '' }
        if (line.includes('NETWORK-REACHED')) return { code: 0, output: 'NETWORK-REFUSED ECONNREFUSED\n' }
        for (const [needle, a] of Object.entries(overrides)) if (line.includes(needle)) return a
        return { code: 0, output: 'all passed\n' }
      }
      const check = async (harnessId, answerFor, source = tool) => {
        const rt = fakeRuntime(harnessId, answerFor)
        const work = await fs.mkdtemp(path.join(root, 'live-'))
        const result = await runToolingCheck({ adapter: rt.adapter, harnessId, model: 'm', root: work, projectId: 'p', ledgerDir: work, config: config(source), projectPath: checkout })
        return { result, invoked: rt.invoked, verdicts: Object.fromEntries(result.paths.filter((p) => p.kind === 'command').map((p) => [p.id, p.verdict])) }
      }

      const failed = await check('codex', answer({ 'test/run.mjs': { code: 1, output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml'\n" } }))
      t.eq('a Codex command that exited 1 is refuted, not confirmed', failed.verdicts.unit, 'refuted', JSON.stringify(failed.result.paths))
      t.eq('and the report does not pass', toolingPassed(failed.result), false)
      const missingRecord = await check('codex', (line) => line.includes('test/run.mjs') ? null : answer()(line))
      t.eq('a command with no record is not-run', missingRecord.verdicts.unit, 'not-run')
      t.eq('and the report does not pass either', toolingPassed(missingRecord.result), false)
      const codexOk = await check('codex', answer())
      t.eq('Codex commands that exited 0 are confirmed, matched through the re-quoted bash -lc form', [codexOk.verdicts.unit, codexOk.verdicts.visual], ['confirmed', 'confirmed'], JSON.stringify(codexOk.result.paths))

      const claude = await check('claude', answer())
      t.eq('a Claude Bash command containing double quotes is matched on its decoded command', claude.verdicts.visual, 'confirmed', JSON.stringify(claude.result.paths))
      t.ok('so is the quoted network probe', ['no-network', 'no-listener'].includes(claude.result.offline), claude.result.offline)
      t.eq('the isolation probe is read from its exit status', claude.result.isolation, 'available')
      const claudeFailed = await check('claude', answer({ 'console.log': { code: 2, output: 'boom\n' } }))
      t.eq('a Claude command that failed is refuted', claudeFailed.verdicts.visual, 'refuted')

      t.section('7d. only executed commands count, and only the formatter may exit 1 (auditor-1-005, -009)')
      const formatterMessage = { code: 1, output: "[warn] gui/source.txt\n1 of 1 file(s) are not formatted with the application's formatter\n" }
      const notFormatter = await check('codex', answer({ 'test/run.mjs': formatterMessage }))
      t.eq('a unit command exiting 1 with the formatter\'s message is refuted', notFormatter.verdicts.unit, 'refuted', JSON.stringify(notFormatter.result.paths))
      const formatter = await check('codex', answer({ 'prettier-check': formatterMessage }))
      t.eq('the declared formatter exiting 1 with its listing has run', formatter.verdicts.fmt, 'confirmed')
      const formatterBroken = await check('codex', answer({ 'prettier-check': { code: 2, output: 'cannot load prettier\n' } }))
      t.eq('the formatter exiting 2 is refuted', formatterBroken.verdicts.fmt, 'refuted')
      // The auditor's case: every line printed with printf, exit 0, nothing executed.
      const printed = (line) => ({ code: 0, output: line + '\n', command: `/bin/bash -lc ${quoteSh(`printf '%s\\n' ${quoteSh(line)}`)}` })
      const codexPrinted = await check('codex', printed)
      t.eq('a printed command is not executed: nothing is confirmed', Object.values(codexPrinted.verdicts).filter((v) => v === 'confirmed'), [], JSON.stringify(codexPrinted.verdicts))
      t.ok('and isolation is not reported available', codexPrinted.result.isolation !== 'available', codexPrinted.result.isolation)
      t.eq('the report does not pass', toolingPassed(codexPrinted.result), false)
      const claudePrinted = await check('claude', (line) => ({ code: 0, output: line + '\n', command: `printf '%s\\n' ${quoteSh(line)}` }))
      t.eq('the same for Claude', [Object.values(claudePrinted.verdicts).includes('confirmed'), claudePrinted.result.isolation === 'available'], [false, false])
      const echoed = await check('claude', (line) => ({ code: 0, output: '', command: `${line}; echo done` }))
      t.eq('a command with something appended is not the declared one', Object.values(echoed.verdicts).includes('confirmed'), false)
      t.eq('a recorded bash -lc wrapper is decoded to exactly its argument', executed(`/bin/bash -lc ${quoteSh("cd '/w' && x")}`), [`/bin/bash -lc ${quoteSh("cd '/w' && x")}`, "cd '/w' && x"])
      t.eq('a wrapper with more than one argument is not decoded', executed("bash -lc 'a' 'b'").length, 1)

      t.section('7e. the live check tells the wrapper\'s namespace from the runtime\'s proved denial, and measures the seat\'s own shell (AC1, AC3)')
      t.eq('a namespace: isolationMode namespace', codexOk.result.isolationMode, 'namespace')
      t.eq('the bare probe is asked for, without the wrapper', codexOk.invoked[0].split('\n').filter((l) => /^\d+\. node -e /.test(l)).length, 1)
      t.eq('and its result recorded as a measurement', codexOk.result.seatNetwork, 'refused ECONNREFUSED')
      const note = `${ISOLATION_INHERITED}: no network namespace here, but this runtime refuses IP sockets\n`
      const codexInherited = await check('codex', (line) => {
        if (line.endsWith('/bin/true')) return { code: 0, output: note }
        if (line.includes('NETWORK-REACHED')) return { code: 0, output: (line.includes(OFFLINE) ? note : '') + 'NETWORK-REFUSED EPERM\n' }
        if (line.includes('console.log')) return { code: 1, output: note + 'Error: listen EPERM: operation not permitted 127.0.0.1\n' }
        return { code: 0, output: note + 'all passed\n' }
      })
      t.eq('a proved runtime denial: isolation available, mode inherited', [codexInherited.result.isolation, codexInherited.result.isolationMode], ['available', 'inherited'])
      t.eq('the seat\'s own shell is refused by its sandbox', codexInherited.result.seatNetwork, 'refused EPERM')
      t.eq('commands that ran are confirmed', codexInherited.verdicts.unit, 'confirmed')
      t.ok('a command that failed is refuted, naming the runtime\'s denial', codexInherited.verdicts.visual === 'refuted' && /runtime's own network denial/.test(codexInherited.result.paths.find((p) => p.id === 'visual').detail), JSON.stringify(codexInherited.result.paths))
      t.eq('the probe through the wrapper has no network', codexInherited.result.offline, 'no-network')
      const codexReached = await check('codex', (line) => line.includes('NETWORK-REACHED') && !line.includes(OFFLINE) ? { code: 0, output: 'NETWORK-REACHED\n' } : answer()(line))
      t.eq('a seat shell that reaches the listener is recorded, not failed', [codexReached.result.seatNetwork, toolingPassed(codexReached.result)], ['network-reached', true])

      const rejected = await check('claude', answer(), os.homedir())
      t.eq('a rejected source is refused before anything is bound or invoked', rejected.invoked.length, 0)
      t.ok('naming why', rejected.result.paths.some((p) => p.kind === 'mount' && p.verdict === 'refuted' && /which no seat may read/.test(p.detail)), JSON.stringify(rejected.result.paths))
      t.eq('and the report does not pass', toolingPassed(rejected.result), false)
    }

    const missing = await sandboxMissing()
    if (missing) {
      if (process.env.DEVPANEL_REQUIRE_SANDBOX === '1') t.ok(`the fence can run on this host (${missing})`, false)
      else t.skip(`seat tooling in the fence: ${missing}`)
      return
    }

    // A fake tooling source and a worktree to mount it into.
    const source = path.join(root, 'host-node_modules')
    await fs.mkdir(path.join(source, 'fake'), { recursive: true })
    await fs.writeFile(path.join(source, 'fake', 'index.js'), 'module.exports = "fake-tool"\n')
    const worktree = path.join(root, 'worktree'), scratch = path.join(root, 'scratch')
    await fs.mkdir(path.join(worktree, 'gui'), { recursive: true }); await fs.mkdir(scratch)
    await fs.writeFile(path.join(worktree, 'gui', 'source.txt'), 'candidate\n')
    const target = await ensureMountPoint(worktree, 'gui/node_modules')
    const spec = { cwd: worktree, writable: [scratch], readOnly: [worktree], entries: [], panelRoot: PANEL, mounts: [{ source, target }], toolingBin: TOOLING }

    t.section('8. the fence proof with a fake mount (AC5b)')
    {
      const args = await fenceArgs(spec)
      const at = args.findIndex((a, i) => a === '--ro-bind' && args[i + 2] === target)
      t.ok('the mount is a read-only bind at its target', at > 0 && args[at + 1] === source)
      t.ok('after the worktree it sits in', at > args.findIndex((a, i) => a === '--ro-bind' && args[i + 2] === worktree))
      t.ok('and the panel\'s tooling is bound at TOOLING_BIN', args.some((a, i) => a === '--ro-bind' && args[i + 2] === TOOLING_BIN))
      const f = await applyFence({ spec, manifest: {} })
      t.eq('the fence proves', f.applied, true, f.reason)
      t.eq('with the mount counted', f.proof?.mounts, 1)
      t.eq('and recorded', f.mounts?.tooling, [{ target, source }])
      const w = f.wrap('/bin/sh', ['-c', [
        'cat gui/node_modules/fake/index.js',
        '(: > gui/node_modules/forged) 2>/dev/null && echo MOUNT-WRITABLE || echo mount-read-only',
        `test -e ${source} && echo SOURCE-VISIBLE || echo source-hidden`,
        `test -x ${TOOLING_BIN}/offline && echo wrapper-visible`
      ].join('; ')])
      const r = await runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      t.ok('the source\'s content is readable at the target', r.stdout.includes('fake-tool'), r.stdout + r.stderr)
      t.ok('a write into it is refused', r.stdout.includes('mount-read-only'), r.stdout)
      t.ok('the source path itself is not visible', r.stdout.includes('source-hidden'), r.stdout)
      t.ok('the offline wrapper is', r.stdout.includes('wrapper-visible'), r.stdout)
      t.eq('the host mount point stayed empty', await fs.readdir(target), [])

      const gone = await fenceArgs({ ...spec, mounts: [{ source: path.join(root, 'no-such-source'), target }] }).then(() => null, (e) => e)
      t.ok('a missing source is never skipped: building the fence fails, naming it', /tooling mount source .*no-such-source does not exist/.test(gone?.message ?? ''), gone?.message)
      const refused = await applyFence({ spec: { ...spec, mounts: [{ source: path.join(root, 'no-such-source'), target }] }, manifest: {} })
      t.ok('so the fence is not applied, with the path in the reason', !refused.applied && refused.reason.includes('no-such-source'), refused.reason)
      const hollow = await applyFence({ spec: { ...spec, mounts: [{ source: path.join(root, 'outside-2'), target }] }, manifest: {} })
      t.eq('an empty source still proves (no sentinel to look for)', hollow.applied, true, hollow.reason)
    }

    t.section('9. a declared command, exactly as rendered, runs through the wrapper inside the fence (cases 1 and 2)')
    {
      const f = await applyFence({ spec, manifest: {} })
      const inFence = async (line) => {
        const w = f.wrap('/bin/sh', ['-c', line])
        return runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      }
      const probe = await inFence(`${OFFLINE} /bin/true`)
      const isolated = probe.code === 0
      if (!isolated) t.skip(`network isolation is unavailable inside the fence here: ${probe.stderr.trim().slice(0, 200)}`)
      const tool = renderToolingCommand({ id: 'probe', cwd: 'gui', run: "node -e \"console.log(require('./node_modules/fake'), 'tool-ok')\"" }, worktree)
      const r = await inFence(tool)
      if (isolated) {
        t.eq('the rendered command exits 0', r.code, 0, r.stderr)
        t.ok('using the mounted tooling', r.stdout.includes('fake-tool tool-ok'), r.stdout + r.stderr)
      } else t.eq('without isolation it is refused, not run unisolated', r.code, 125, r.stderr)

      const server = net.createServer((s) => s.end())
      const listening = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(0, '127.0.0.1', () => resolve(true)) })
      if (!listening) t.skip('this host refuses a loopback listener, so the network probe has no target')
      else try {
        const port = server.address().port
        const connect = `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('NETWORK-REACHED');process.exit(0)}).on('error',(e)=>{console.log('NETWORK-REFUSED',e.code);process.exit(0)})"`
        const control = await inFence(`cd ${worktree} && ${connect}`)
        t.ok('control: without the wrapper the fence reaches the host listener', control.stdout.includes('NETWORK-REACHED'), control.stdout + control.stderr)
        const offline = await inFence(renderToolingCommand({ id: 'net', run: connect }, worktree))
        t.ok('through the rendered form it never does', !offline.stdout.includes('NETWORK-REACHED') && (offline.stdout.includes('NETWORK-REFUSED') || offline.code === 125), offline.stdout + offline.stderr)
      } finally { server.close() }
      const write = await inFence(renderToolingCommand({ id: 'w', cwd: 'gui', run: ': > node_modules/forged && echo WRITTEN || echo refused' }, worktree))
      t.ok('the mount stays read-only inside the wrapper too', !write.stdout.includes('WRITTEN'), write.stdout + write.stderr)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
