import { installRemoteManager, SSH_ANSWERS_G } from './fakes/remote-manager.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { checkSummary } from '../server/runtime/check-summary.mjs'
import { runChecks, compareWithBaseline } from '../server/runtime/checks.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { patch } from './helpers.mjs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const name = 'checks — an isolated, fingerprint-matched candidate, with command, exit and log evidence'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

async function candidate () {
  const projectPath = await temp('check-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'value.txt'), '1' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'c1', root: await temp('check-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  const runDir = await temp('check-run-')
  return { projectPath, ws, baseline, fp, runDir }
}

const start = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

export default async function (t) {
  t.section('1. commands run in a rebuilt candidate that equals the revision, and pass')
  {
    const c = await candidate()
    const result = await runChecks({
      target: { kind: 'local', commands: [{ id: 'value', run: 'test "$(cat value.txt)" = 2' }, { id: 'no-git-worktree-of-author', run: 'test ! -e scratch' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('passed', result.result, 'passed', result.error)
    t.eq('materialisation verified against the revision', result.materialization.verified, true)
    t.eq('both commands recorded', result.commands.length, 2)
    t.ok('with exit codes', result.commands.every((x) => x.exitCode === 0))
    const digest = await runChecks({
      target: { kind: 'local', commands: [{ id: 'digest', run: 'echo "PASS calculation-view 2"; head -c 5000 /dev/zero | tr "\\0" x' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    const excerpt = digest.commands[0].stdout
    t.ok('a command\'s stdout head is on its record, bounded', excerpt.startsWith('PASS calculation-view 2') && excerpt.length === 2000, String(excerpt?.length))
    t.ok('and reaches the reviewers\' summary', checkSummary(digest).commands[0].stdout.startsWith('PASS calculation-view 2'))
    const report = await runChecks({
      target: { kind: 'local', commands: [{ id: 'selftest-report', required: false, run: 'head -c 3000 /dev/zero | tr "\\0" x; echo; echo "  PASS vuetiform/setup-context-size"; echo "FAIL document-seeder/retry: timeout"; echo noise; echo "2 tests, 1 failures"; echo "  ✓ renders" >&2' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    const results = checkSummary(report).commands[0].results
    t.eq('the result lines past the stdout head are on the record, stderr included', results?.lines, ['  PASS vuetiform/setup-context-size', 'FAIL document-seeder/retry: timeout', '2 tests, 1 failures', '  ✓ renders'])
    t.eq('with their count', [results?.total, results?.truncated], [4, 0])
    t.eq('a command without result lines records none', 'results' in result.commands[0], false)
    const log = await fs.readFile(path.join(c.runDir, result.dir, result.commands[0].log), 'utf8')
    t.ok('and a log naming the command and its exit', log.includes('$ test') && log.includes('--- exit 0'))
    const { stdout } = await run('git', ['-C', c.projectPath, 'worktree', 'list'])
    t.eq('the reconstruction worktree is gone', stdout.trim().split(NL).length, 2)
  }

  t.section('1b. compareBaseline: the base commit checked alone, and a per-command line diff')
  {
    const c = await candidate()
    const commands = [
      { id: 'digest', run: 'echo "VALUE $(cat value.txt)"; echo "SAME line"; echo "dir /opt/devpanel-check-$RANDOM$RANDOM"' },
      { id: 'quiet', run: 'echo steady' },
      { id: 'gate', required: false, run: 'test "$(cat value.txt)" = 1' }
    ]
    const common = { target: { kind: 'local', commands }, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir }
    const [cand, base] = await Promise.all([
      runChecks({ ...common, revision: c.fp.fingerprint, fingerprint: c.fp }),
      runChecks({ ...common, revision: null, base: true, dirName: 'base-test' })
    ])
    t.eq('the base runs from the commit alone', (await fs.readFile(path.join(c.runDir, base.dir, 'digest.stdout'), 'utf8')).split(NL)[0], 'VALUE 1')
    t.ok('in its named directory, beside a numbered candidate check', base.dir === path.join('checks', 'base-test') && cand.dir === path.join('checks', '001'), base.dir + ' ' + cand.dir)
    t.ok('recording what it ran', base.baseCommit === c.ws.baseCommit && typeof base.baseFingerprint === 'string' && base.materialization.verified === true)
    const cmp = await compareWithBaseline({ runDir: c.runDir, baseline: base, candidate: cand })
    const digest = cmp.commands.find((x) => x.id === 'digest')
    t.eq('the candidate-only line is added, the base-only line removed', [digest?.added, digest?.removed], [['VALUE 2'], ['VALUE 1']])
    t.ok('check directory names do not count as differences', !digest.added.some((l) => l.includes('devpanel-check')))
    t.ok('a command whose verdict changed is listed even with equal output', cmp.commands.some((x) => x.id === 'gate' && x.baselinePassed === true && x.candidatePassed === false))
    t.eq('an identical command is only named as unchanged', cmp.unchanged, ['quiet'])
  }

  t.section('2. a failing required command fails the set; a failing optional one does not')
  {
    const c = await candidate()
    const failed = await runChecks({
      target: { kind: 'local', commands: [{ id: 'ok', run: 'true' }, { id: 'bad', run: 'echo broken >&2; exit 3' }, { id: 'never', run: 'true' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('failed', failed.result, 'failed')
    t.eq('stopped at the failure', failed.commands.length, 2)
    t.eq('with the exit code', failed.commands[1].exitCode, 3)
    t.eq('and its stderr excerpt on the record, for reviewers', failed.commands[1].stderr.trim(), 'broken')
    const log = await fs.readFile(path.join(c.runDir, failed.dir, 'bad.log'), 'utf8')
    t.ok('stderr kept', log.includes('broken'))

    const tolerant = await runChecks({
      target: { kind: 'local', commands: [{ id: 'lint', run: 'exit 1', required: false }, { id: 'test', run: 'true' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('an optional failure still passes the set', tolerant.result, 'passed')
    t.eq('but is recorded as not passed', tolerant.commands[0].passed, false)
    t.eq('checks are numbered per run', tolerant.dir, 'checks/002')
  }

  t.section('3. a timeout terminates the command and fails it')
  {
    const c = await candidate()
    const result = await runChecks({
      target: { kind: 'local', commands: [{ id: 'hang', run: 'sleep 30', timeoutSeconds: 1 }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('failed', result.result, 'failed')
    t.eq('marked as timed out', result.commands[0].timedOut, true)
    t.ok('quickly', result.durationMs < 10000, `${result.durationMs} ms`)
  }

  t.section('3b. finalizers run after a failed command and after cancellation')
  {
    const c = await candidate()
    const args = { revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir }
    for (const cancelled of [false, true]) {
      const result = await runChecks({ ...args,
        signal: cancelled ? AbortSignal.abort() : undefined,
        target: { kind: 'local', commands: [{ id: 'fail', run: 'exit 7' }], finallyCommands: [{ id: 'logs', run: 'echo captured' }, { id: 'stop', run: 'echo stopped' }] }
      })
      t.eq(cancelled ? 'cancelled check stays unavailable' : 'failed check stays failed', result.result, cancelled ? 'unavailable' : 'failed')
      t.ok('both finalizers completed', ['logs', 'stop'].every(id => result.commands.some(command => command.id === id && command.passed)))
    }
  }

  t.section('4. a revision the candidate cannot be rebuilt to is unavailable, never passed')
  {
    const c = await candidate()
    const result = await runChecks({
      target: { kind: 'local', commands: [{ id: 'x', run: 'true' }] },
      revision: 'sha256:' + '0'.repeat(64), fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('unavailable', result.result, 'unavailable')
    t.eq('nothing ran', result.commands.length, 0)
    t.ok('and the reason says so', /not the revision under check|does not reconstruct/.test(result.error + ' ' + (result.materialization?.detail ?? '')), result.error)
  }

  t.section('4b. a command that changes the candidate invalidates the evidence')
  {
    const c = await candidate()
    const result = await runChecks({
      target: { kind: 'local', commands: [{ id: 'tamper', run: 'echo 3 > value.txt' }, { id: 'test', run: 'test "$(cat value.txt)" = 3' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('not passed: unavailable', result.result, 'unavailable')
    t.ok('naming the changed path', /changed the candidate \(value.txt/.test(result.error ?? ''), result.error)
    t.eq('the tally is recorded', result.materialization.afterCommands.modified, 1)

    const build = await runChecks({
      target: { kind: 'local', commands: [{ id: 'build', run: 'mkdir -p dist && echo out > dist/bundle.js' }, { id: 'test', run: 'test -f dist/bundle.js' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('build output is tolerated', build.result, 'passed', build.error)
    t.eq('and counted', build.materialization.afterCommands.added, 1)
  }

  t.section('4c. ssh transfer carries binary content intact (local shim)')
  {
    const c = await candidate()
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 0, 128, 127, 0])
    await fs.writeFile(path.join(c.ws.path, 'blob.bin'), bytes)
    const fp = await fingerprint(c.ws.path, { baseCommit: c.ws.baseCommit, baseline: c.baseline })
    // A shim that runs the remote command locally, stdin passed through as-is.
    const shimDir = await temp('ssh-shim-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh')
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, '# last argument is the remote command', 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_SSH_BIN = shim
    process.env.CHECK_TEST_HOST = 'shim'
    const workdir = await temp('ssh-remote-')
    const result = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'blob', run: 'cmp blob.bin - <<EOF' + NL + 'EOF' + NL + 'test "$(sha256sum blob.bin | cut -d\' \' -f1)" = ' + (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }] },
      revision: fp.fingerprint, fingerprint: fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    delete process.env.DEVPANEL_SSH_BIN; delete process.env.CHECK_TEST_HOST
    t.eq('the archive arrived intact', result.materialization.remoteSha256, result.materialization.archiveSha256)
    t.eq('and the binary file matched byte for byte on the far side', result.result, 'passed', result.error ?? JSON.stringify(result.commands))
    t.eq('the remote directory was cleaned up', (await fs.readdir(workdir)).length, 0)
    t.eq('and the local archive was not kept; its hash is the record', await fs.stat(path.join(c.runDir, result.dir, 'candidate.tar')).then(() => true, () => false), false)
    t.ok('with its size', result.materialization.archiveBytes > 0)
  }

  t.section('4d. over ssh, a command that rewrites a source file is caught the same way')
  {
    const c = await candidate()
    const shimDir = await temp('ssh-shim2-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh')
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_SSH_BIN = shim
    process.env.CHECK_TEST_HOST = 'shim'
    const workdir = await temp('ssh-remote2-')
    const result = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'tamper', run: 'echo 3 > value.txt' }, { id: 'test', run: 'test "$(cat value.txt)" = 3' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('unavailable, not passed', result.result, 'unavailable')
    t.ok('naming the path', /changed the candidate \(value.txt/.test(result.error ?? ''), result.error)
    t.eq('the remote listing was compared', result.materialization.afterCommands.modified, 1)

    const clean = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'read', run: 'test "$(cat value.txt)" = 2' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('an honest remote check passes', clean.result, 'passed', clean.error)
    const failedCleanup = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'test', run: 'true' }], finallyCommands: [{ id: 'stop', run: 'exit 1' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('failed required remote cleanup is unavailable', failedCleanup.result, 'unavailable')
    t.ok('failed cleanup retains and names the candidate', failedCleanup.error.includes('candidate retained at') && (await fs.readdir(workdir)).some(name => !name.endsWith('.tar')))
    const optionalCleanup = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'test', run: 'true' }], finallyCommands: [{ id: 'logs', run: 'exit 1', required: false }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('optional diagnostics failure does not fail verification', optionalCleanup.result, 'passed')
    // A candidate that never booted: readiness fails, so the report collector finds nothing.
    const neverBooted = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'readiness', run: 'exit 2' }], finallyCommands: [{ id: 'collect-report', run: 'exit 1' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('a failed required command stays failed when a collector then fails', neverBooted.result, 'failed', neverBooted.error)
    t.ok('naming both, and the retained candidate', /required command readiness failed; required finalizer collect-report failed; candidate retained at/.test(neverBooted.error ?? ''), neverBooted.error)
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'case "$last" in "rm -rf "*) echo cleanup-denied >&2; exit 23;; esac', 'exec /bin/sh -c "$last"'].join(NL) + NL)
    const removal = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'test', run: 'true' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('final removal failure prevents success', removal.result, 'unavailable')
    t.eq('removal exit status is retained', removal.materialization.cleanup.exitCode, 23)
    t.ok('removal failure names both residual paths', removal.error.includes(removal.materialization.cleanup.archive))
    t.ok('removal stderr is retained', removal.materialization.cleanup.stderr.includes('cleanup-denied'))
    delete process.env.DEVPANEL_SSH_BIN; delete process.env.CHECK_TEST_HOST
  }

  t.section('4d2. a remote directory that is not exactly the candidate is refused before any command')
  {
    const c = await candidate()
    const shimDir = await temp('ssh-shim3-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh')
    // A shim that plants a stray fixture right after extraction, as a stale or
    // shared directory would carry.
    await fs.writeFile(shim, [
      '#!/bin/sh', SSH_ANSWERS_G, 'for last; do :; done',
      'out=$(/bin/sh -c "$last"); rc=$?', 'printf "%s\\n" "$out"',
      'case "$last" in *"tar -C "*) d=$(printf "%s" "$last" | sed -n "s/.*tar -C \x27\\([^\x27]*\\)\x27.*/\\1/p"); [ -n "$d" ] && printf "stale" > "$d/fixture.txt";; esac',
      'exit $rc'
    ].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_SSH_BIN = shim
    process.env.CHECK_TEST_HOST = 'shim'
    const workdir = await temp('ssh-remote3-')
    const result = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'uses-fixture', run: 'test -f fixture.txt' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    delete process.env.DEVPANEL_SSH_BIN; delete process.env.CHECK_TEST_HOST
    t.eq('unavailable', result.result, 'unavailable')
    t.ok('naming the stray file', /differs from the revision before any command ran \(fixture.txt/.test(result.error ?? ''), result.error)
    t.eq('no command ran', result.commands.length, 0)
    t.eq('the remote directory was removed', (await fs.readdir(workdir)).length, 0)
  }

  t.section('4d3. each attempt gets its own remote directory')
  {
    const c = await candidate()
    const shimDir = await temp('ssh-shim4-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh')
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_SSH_BIN = shim
    process.env.CHECK_TEST_HOST = 'shim'
    const workdir = await temp('ssh-remote4-')
    const seen = new Set()
    for (let i = 0; i < 2; i++) {
      const r = await runChecks({
        target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'pwd', run: 'pwd' }] },
        revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
      })
      t.eq(`attempt ${i + 1} passed`, r.result, 'passed', r.error)
      seen.add((await fs.readFile(path.join(c.runDir, r.dir, 'pwd.log'), 'utf8')).split(NL)[2])
    }
    delete process.env.DEVPANEL_SSH_BIN; delete process.env.CHECK_TEST_HOST
    t.eq('two attempts, two directories', seen.size, 2)
  }

  t.section('4d4. a base check runs over ssh too, beside the candidate check')
  {
    const c = await candidate()
    const shimDir = await temp('ssh-shim5-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh')
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_SSH_BIN = shim
    process.env.CHECK_TEST_HOST = 'shim'
    const workdir = await temp('ssh-remote5-')
    const common = { target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'value', run: 'cat value.txt' }] }, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir }
    const [cand, base] = await Promise.all([
      runChecks({ ...common, revision: c.fp.fingerprint, fingerprint: c.fp }),
      runChecks({ ...common, revision: null, base: true, dirName: 'base-ssh' })
    ])
    delete process.env.DEVPANEL_SSH_BIN; delete process.env.CHECK_TEST_HOST
    t.eq('the base check passed', base.result, 'passed', base.error)
    t.eq('the candidate check passed', cand.result, 'passed', cand.error)
    t.eq('the base printed the base content', (await fs.readFile(path.join(c.runDir, base.dir, 'value.stdout'), 'utf8')).trim(), '1')
    t.eq('the candidate printed its own', (await fs.readFile(path.join(c.runDir, cand.dir, 'value.stdout'), 'utf8')).trim(), '2')
  }

  t.section('4d5. without a unit user (neutral host settings): privileged-only drives run, candidate commands are refused')
  {
    const c = await candidate()
    const shimDir = await temp('ssh-shim6-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh')
    const sent = path.join(shimDir, 'sent.log')
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', `printf '%s\\n--\\n' "$last" >> '${sent}'`, 'exec /bin/sh -c "$last"'].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_SSH_BIN = shim
    process.env.CHECK_TEST_HOST = 'shim'
    const ssh = { hostRef: 'env:CHECK_TEST_HOST', workdir: await temp('ssh-remote6-') }
    const common = { revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir }
    const privileged = await runChecks({ ...common, target: { kind: 'ssh', ssh, commands: [{ id: 'logs', kind: 'privileged', run: 'true' }], finallyCommands: [{ id: 'collect', kind: 'privileged', required: false, run: 'true' }] } })
    const log = await fs.readFile(sent, 'utf8').catch(() => '')
    const units = (await fs.readFile(path.join(shimDir, 'units', 'invocations.jsonl'), 'utf8').catch(() => '')).split(NL).filter(Boolean)
    t.ok('nothing asks for a unit user', !/confinement\.user|no unit user/.test(privileged.error ?? ''), privileged.error)
    t.ok('the candidate is not handed to anyone (no chown)', !log.includes('chown'), log.split('--').filter((l) => l.includes('chown')).join(''))
    t.ok('no candidate probe is sent', !log.includes('CANDIDATE-NOT-WRITABLE'))
    t.ok('the privileged mask probe is', log.includes('MASK-WRITABLE'))
    t.eq('and recorded alone', (privileged.confinement?.probe ?? []).map((p) => p.id), ['devpanel-probe-privileged'])
    t.eq('three units: the mask probe and the drive\'s two commands', units.length, 3)
    await fs.rm(sent, { force: true })
    const candidateOnly = await runChecks({ ...common, target: { kind: 'ssh', ssh, commands: [{ id: 'start', kind: 'candidate', run: 'true' }, { id: 'logs', kind: 'privileged', run: 'true' }] } })
    delete process.env.DEVPANEL_SSH_BIN; delete process.env.CHECK_TEST_HOST
    t.eq('a drive with a candidate command is unavailable', candidateOnly.result, 'unavailable')
    t.ok('with the clear refusal naming testDrive.confinement.user and .home', /kind: candidate commands but no unit user and home: set testDrive\.confinement\.user and \.home/.test(candidateOnly.error ?? ''), candidateOnly.error)
    t.eq('refused before anything was sent', await fs.readFile(sent, 'utf8').catch(() => ''), '')
  }

  t.section('remote cancellation confirms stop before cleanup; failed stop retains the candidate')
  for (const stopFails of [false, true]) {
    const c = await candidate(), shimDir = await temp('ssh-cancel-shim-'), workdir = await temp('ssh-cancel-remote-')
    const managerEnv = await installRemoteManager(shimDir)
    const shim = path.join(shimDir, 'ssh'), pidFile = path.join(shimDir, 'command.pid')
    await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', ...(stopFails ? ['case "$last" in *"Remote command cgroups stopped"*) exit 77;; esac'] : []), 'exec /bin/sh -c "$last"'].join(NL)+NL, {mode:0o755})
    process.env.DEVPANEL_SSH_BIN=shim; process.env.CHECK_TEST_HOST='shim'
    const controller=new AbortController()
    const pending=runChecks({target:{kind:'ssh',ssh:{hostRef:'env:CHECK_TEST_HOST',workdir},commands:[{id:'test',run:stopFails?'true':`echo $$ > '${pidFile}'; sleep 60`,timeoutSeconds:65}]},revision:c.fp.fingerprint,fingerprint:c.fp,baseCommit:c.ws.baseCommit,baseline:c.baseline,workspacePath:c.ws.path,runDir:c.runDir,signal:controller.signal})
    if(!stopFails){
      for(let n=0;n<500&&!await fs.stat(pidFile).then(()=>true,()=>false);n++)await new Promise(r=>setTimeout(r,10))
      // The launch bookkeeping lives beside the candidate, in its control directory.
      const remote=(await fs.readdir(workdir)).find(name=>name.endsWith('.control'))
      for(let n=0;n<300 && await fs.stat(path.join(workdir,remote,'.registration-uncertain')).then(()=>true,()=>false);n++)await new Promise(r=>setTimeout(r,10))
      controller.abort()
    }
    const result=await pending
    delete process.env.DEVPANEL_SSH_BIN;delete process.env.CHECK_TEST_HOST
    t.eq(`stop failure=${stopFails}: result unavailable`,result.result,'unavailable')
    t.eq(`stop failure=${stopFails}: termination evidence`,result.materialization.remoteTermination.confirmed,!stopFails)
    t.eq(`stop failure=${stopFails}: candidate retained`,(await fs.readdir(workdir)).some(name=>!name.endsWith('.tar')),stopFails)
    if(!stopFails){
      const pid=Number(await fs.readFile(pidFile,'utf8'))
      const alive=await fs.readFile(`/proc/${pid}/stat`,'utf8').then(s=>!s.slice(s.lastIndexOf(')')+2).startsWith('Z'),()=>false)
      t.eq('command is stopped when cancellation returns',alive,false)
    }
  }

  t.section('4e. a candidate that deletes a file is not blamed for its absence; a mode change is caught')
  {
    const c = await candidate()
    await fs.rm(path.join(c.ws.path, 'value.txt'))
    const fp = await fingerprint(c.ws.path, { baseCommit: c.ws.baseCommit, baseline: c.baseline })
    t.ok('the candidate records the deletion', fp.entries.some((e) => e.path === 'value.txt' && e.status === 'deleted'))
    const absent = await runChecks({
      target: { kind: 'local', commands: [{ id: 'gone', run: 'test ! -e value.txt' }] },
      revision: fp.fingerprint, fingerprint: fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('confirming the absence passes', absent.result, 'passed', absent.error)
    const resurrect = await runChecks({
      target: { kind: 'local', commands: [{ id: 'back', run: 'echo 1 > value.txt' }] },
      revision: fp.fingerprint, fingerprint: fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('bringing a deleted path back invalidates', resurrect.result, 'unavailable')
    t.eq('as reappeared', resurrect.materialization.afterCommands.reappeared, 1)

    const d = await candidate()
    const mode = await runChecks({
      target: { kind: 'local', commands: [{ id: 'chmod', run: 'chmod +x value.txt' }, { id: 'test', run: 'test -x value.txt' }] },
      revision: d.fp.fingerprint, fingerprint: d.fp, baseCommit: d.ws.baseCommit, baseline: d.baseline, workspacePath: d.ws.path, runDir: d.runDir
    })
    t.eq('a mode change is a change', mode.result, 'unavailable')
    t.eq('counted as modified', mode.materialization.afterCommands.modified, 1)
  }

  t.section('5. an unreachable ssh target is unavailable with the reason')
  {
    const c = await candidate()
    process.env.CHECK_TEST_HOST = 'nonexistent.invalid'
    const result = await runChecks({
      target: { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir: '/tmp' }, commands: [{ id: 'x', run: 'true' }] },
      revision: c.fp.fingerprint, fingerprint: c.fp, baseCommit: c.ws.baseCommit, baseline: c.baseline, workspacePath: c.ws.path, runDir: c.runDir
    })
    t.eq('unavailable', result.result, 'unavailable')
    t.ok('naming the transport failure', /upload failed|could not|resolve/i.test(result.error ?? ''), result.error)
    delete process.env.CHECK_TEST_HOST
  }

  t.section('6. in a run: checks bind to the revision, run beside the audit, and make closure verified')
  {
    const f = await engineFixture()
    // A local target on the sandboxed playbook: one command that inspects the candidate.
    const playbookFile = path.join(f.configRoot, 'playbooks/implementation.yaml')
    await fs.appendFile(playbookFile, 'checks:\n  requirement: required\n  target:\n    kind: local\n    commands:\n      - id: present\n        run: test -f source.txt\n')
    await patch(playbookFile, 'minimumVerification: review-only', 'minimumVerification: verified')
    const seen = []
    const base = scriptFor()
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke: async (a) => { seen.push(a); return f.fake.invoke(a) } } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    const run = await engine.drive()
    t.eq('one check result, for the implementation revision', run.checkResults.length, 1)
    t.eq('bound to that revision', run.checkResults[0].revision, run.steps.find((s) => s.stepId === 'implement').revision)
    t.eq('passed', run.checkResults[0].result, 'passed')
    const audit = seen.find((a) => a.meta.stepId === 'audit-implement-1')
    // A consensus review runs beside the revision's checks: the auditor is told
    // they are running, never handed a result that does not exist yet.
    t.ok('the auditor is told the checks are running', audit.prompt.includes('"result": "running"'))
    t.ok('and is not shown them as passed', !audit.prompt.includes('"result": "passed"'))
    t.eq('closure is verified', run.closure.verificationLevel, 'verified')
    t.eq('and authorised under a verified policy', run.closure.authorised, true)
    t.eq('the run resolved', run.outcome, 'resolved')
    t.ok('the log is on disk under the run', await fs.stat(path.join(f.issuePath, 'runs', engine.runId, run.checkResults[0].dir, 'present.log')).then(() => true, () => false))
    void base
    await releaseWorkspace(engine)
  }

  t.section('6b. compareBaseline in a run: the base is checked once, beside the first check, and reviewers get the diff')
  {
    const f = await engineFixture()
    const playbookFile = path.join(f.configRoot, 'playbooks/implementation.yaml')
    await fs.appendFile(playbookFile, 'checks:\n  requirement: required\n  target:\n    kind: local\n    compareBaseline: true\n    commands:\n      - id: digest\n        run: find . -type f -not -path "./.git*" | LC_ALL=C sort | xargs cksum; echo same\n')
    const seen = []
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke: async (a) => { seen.push(a); return f.fake.invoke(a) } } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    const run = await engine.drive()
    t.eq('one base check for the run', run.baselineChecks?.length, 1)
    t.eq('of the base commit', run.baselineChecks[0].baseCommit, run.workspace.baseCommit)
    const cmp = run.checkResults[0].baselineComparison
    const digest = cmp?.commands.find((x) => x.id === 'digest')
    // This fixture's author changes nothing the command lists (the diff itself is 1b's).
    t.ok('the candidate check carries the comparison: no differing line, the command unchanged', digest === undefined && cmp?.unchanged?.includes('digest'), JSON.stringify(cmp?.commands))
    const confirm = seen.filter((a) => a.meta.stepId === 'confirm').at(-1)
    t.ok('the confirming coordinator is shown it', confirm?.prompt.includes('"baselineComparison"') && confirm.prompt.includes(cmp.baselineDir))
    // A base recorded as unavailable (an older engine kept those) is checked again, never reused.
    engine.run.baselineChecks[0].result = 'unavailable'
    await engine.maybeRunChecks({ force: true })
    t.eq('an unavailable base is run again on the next check', engine.run.baselineChecks.map((b) => b.result), ['unavailable', 'passed'])
    t.eq('and the new comparison uses it', engine.run.checkResults.at(-1).baselineComparison?.baselineResult, 'passed')
    await releaseWorkspace(engine)
  }

  t.section('7. the tooling policy reaches the runtime')
  {
    const f = await engineFixture()
    const seen = []
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke: async (a) => { seen.push(a); return f.fake.invoke(a) } } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    // The first turns are the coordinator's: tool-free, in scratch, with no
    // workspace tooling to state. The policy is the working seats'.
    await engine.drive({ maxTurns: 4 })
    const working = seen.find((a) => a.tooling)
    t.ok('coordination-only turns carry no tooling', seen.filter((a) => a.supervisorOnly).every((a) => a.tooling === null))
    const tooling = working?.tooling
    t.eq('live checkout is denied by default', tooling?.allowLiveCheckout, false)
    t.eq('and named', tooling?.liveCheckout, f.projectPath)
    // A tactical seat's scratch is its own subdirectory of the run's scratch.
    t.ok('the seat\'s scratch directory is an allowed root', tooling?.allowedRoots.includes(path.join(engine.run.workspace.scratchPath, working.meta.role)))
    t.ok('and the prompt states the scope', working?.prompt.includes('Source workspace:') && working.prompt.includes(f.projectPath))
    t.ok('the run\'s check logs are a read-only root of every working seat', tooling?.allowedRoots.includes(path.join(f.issuePath, 'runs', engine.runId, 'checks')))
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}
