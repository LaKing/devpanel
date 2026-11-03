import { managedRemoteCommand, stopRemoteCommands, controlDir, unitName, probeCommands, confinementLevel, withConfinementDefaults } from './remote-check-process.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { systemClock } from './clock.mjs'
import { sshConnection, shellQuote } from './ssh.mjs'
import { fingerprint, treeIdentity } from './fingerprint.mjs'
import { runProcess } from './process.mjs'
import { hostPlatform } from './platform.mjs'
import { fencePolicy } from './confinement-policy.mjs'
import { discardReconstruction, reconstructInto, worktreeDiffDelivery } from './launch.mjs'
import { applyFence, PANEL_ROOT } from '../../../harness/fence.mjs'
import { childEnvironment } from '../../../harness/shared.mjs'

/*
 * The check runner.
 *
 * A check is evidence about ONE revision: the candidate is rebuilt from its
 * base commit and patch into an isolated directory, that directory is
 * fingerprinted and must equal the revision, and only then do the target's
 * commands run in it. Every command's exit status, duration and log are kept
 * under runs/<run-id>/checks/<n>/ so a result can be re-read, not re-trusted.
 *
 * Results follow the contract's vocabulary and never rewrite the requirement:
 *   passed       every required command exited 0
 *   failed       a required command did not
 *   unavailable  the candidate could not be materialised or reached, or the
 *                run was cancelled — nothing was proven either way
 *   not-run      there is no target (recorded by the engine, not here)
 *
 * Transport for `ssh` is an archive of the verified reconstruction whose
 * SHA-256 is recomputed on arrival; a mismatch means the result is not bound
 * to the revision and is `unavailable`.
 */

const NL = String.fromCharCode(10)

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export async function runChecks ({
  target,
  revision,
  fingerprint: fp = null,
  baseCommit,
  baseline = new Map(),
  workspacePath,
  runDir,
  clock = systemClock,
  signal = null,
  // The worktree's git directory recorded at provisioning (engine-git.mjs).
  gitDir = null,
  // `base: true` runs the same target on the base commit alone (no patch), so
  // reviewers can tell what the change altered (compareBaseline). Its
  // directory is named, not numbered: it may run beside a numbered check.
  base = false,
  dirName = null,
  // The host's OS (platform.mjs): decides whether local commands may run at all.
  platform = hostPlatform()
}) {
  const startedAt = clock.now()
  const dir = path.join(runDir, 'checks', dirName ?? String(await nextIndex(path.join(runDir, 'checks'))).padStart(3, '0'))
  await fs.mkdir(dir, { recursive: true })
  const result = {
    revision,
    result: 'unavailable',
    target: target?.kind ?? null,
    at: clock.iso(),
    durationMs: null,
    materialization: null,
    commands: [],
    error: null,
    dir: path.relative(runDir, dir)
  }
  const finish = () => { result.durationMs = clock.now() - startedAt; return result }

  if (!target || !['local', 'ssh'].includes(target.kind)) {
    result.error = 'no usable check target'
    return finish()
  }

  // 1. A candidate rebuilt from base + patch, proven equal to the revision.
  const rebuilt = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-check-'))
  const materialized = { method: target.kind === 'ssh' ? (target.materialize ?? 'archive') : 'reconstruction', verified: false, detail: null }
  result.materialization = materialized
  try {
    let patch
    if (base) { patch = path.join(dir, 'base.patch'); await fs.writeFile(patch, '') }
    else patch = await buildPatch({ workspacePath, baseCommit, baseline, fingerprint: fp, revision, runDir, dir, gitDir })
    await reconstructInto({ dir: rebuilt, workspacePath, baseCommit, patchFile: patch, gitDir })
    const check = await fingerprint(rebuilt, { baseCommit, baseline, clock })
    // The base is the commit itself, checked out unchanged; its fingerprint is
    // recorded rather than compared with a revision it does not have.
    if (base) Object.assign(result, { baseCommit, baseFingerprint: check.fingerprint })
    materialized.verified = base || check.fingerprint === revision
    if (!materialized.verified) {
      materialized.detail = `rebuilt candidate fingerprints to ${check.fingerprint.slice(0, 23)}…, not the revision under check`
      result.error = 'candidate could not be materialised to the revision'
      return finish()
    }
    // The bytes this drive tests, the same for a candidate and a base of one tree (selftest-history.mjs).
    result.treeIdentity = treeIdentity(check.entries)

    // 2. Commands, in the isolated candidate, or on the target host.
    if (target.kind === 'local') {
      await runCommandsLocally({ target, cwd: rebuilt, dir, result, clock, signal, platform })
    } else {
      await runCommandsOverSsh({ target, rebuilt, dir, result, materialized, clock, signal, candidateEntries: check.entries })
    }

    // 3. The candidate must still BE the revision. A command that edits a
    // source file and a later one that tests the edited file would otherwise
    // certify content nobody reviewed. Files a command adds (build output) are
    // recorded and tolerated; a modified, re-moded or deleted candidate path —
    // or a path the candidate deleted that reappeared — invalidates the
    // evidence. Verified locally by re-fingerprinting, remotely by listing.
    const afterEntries = target.kind === 'local'
      ? (await fingerprint(rebuilt, { baseCommit, baseline, clock })).entries
      : materialized.remoteEntries
    if (afterEntries) {
      const drift = compareCandidate(check.entries, afterEntries)
      materialized.afterCommands = { modified: drift.modified.length, deleted: drift.deleted.length, reappeared: drift.reappeared.length, added: drift.added.length }
      const bad = [...drift.modified, ...drift.deleted, ...drift.reappeared]
      if (bad.length) {
        result.result = 'unavailable'
        result.error = `commands changed the candidate (${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}); the evidence is not bound to the revision`
      }
    } else if (target.kind === 'ssh' && result.result === 'passed') {
      result.result = 'unavailable'
      result.error = 'the remote candidate could not be verified after the commands; the evidence is not bound to the revision'
    }
    // The listing is evidence, kept beside the logs rather than in the result:
    // thousands of entries per check made run.json megabytes, and run.json is
    // rewritten every few seconds during a turn and served whole to the page.
    if (materialized.remoteEntries) await externalise(materialized, dir)
  } catch (error) {
    result.error = error.name === 'AbortError' ? 'cancelled' : error.message
    result.result = 'unavailable'
  } finally {
    await discardReconstruction({ dir: rebuilt, workspacePath, gitDir })
  }
  return finish()
}

/**
 * What changed between the candidate as materialised and as it is after the
 * commands. Entries are compared by their whole identity — content hash AND
 * mode — and a path the candidate itself deleted (a `deleted` entry) is
 * expected to be absent; only its reappearance is a change.
 */
export function compareCandidate (beforeEntries, afterEntries) {
  const identity = (e) => `${e.contentHash}|${e.mode ?? ''}`
  const before = new Map(beforeEntries.filter((e) => e.status !== 'deleted').map((e) => [e.path, identity(e)]))
  const expectedAbsent = new Set(beforeEntries.filter((e) => e.status === 'deleted').map((e) => e.path))
  const after = new Map(afterEntries.filter((e) => e.status !== 'deleted').map((e) => [e.path, identity(e)]))
  const modified = [...before].filter(([p, id]) => after.has(p) && after.get(p) !== id).map(([p]) => p)
  const deleted = [...before.keys()].filter((p) => !after.has(p))
  const reappeared = [...expectedAbsent].filter((p) => after.has(p))
  const added = [...after.keys()].filter((p) => !before.has(p) && !expectedAbsent.has(p))
  return { modified, deleted, reappeared, added }
}

/** The patch for this revision, written into the check directory for the record. */
async function buildPatch ({ workspacePath, baseCommit, baseline, fingerprint: fp, revision, runDir, dir, gitDir = null }) {
  const receipt = await worktreeDiffDelivery.deliver({
    action: 'worktree-diff', revision, fingerprint: fp, baseCommit, baseline, workspacePath, runDir: dir, gitDir
  }).catch(async (error) => {
    // deliver() expects an artifacts/ directory; create it and retry once.
    await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true })
    return worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision, fingerprint: fp, baseCommit, baseline, workspacePath, runDir: dir, gitDir })
  })
  if (receipt.reconstruction && receipt.reconstruction.verified !== true) {
    throw new Error(`the candidate's patch does not reconstruct: ${receipt.reconstruction.detail ?? 'unverified'}`)
  }
  return path.join(dir, receipt.artifactRef)
}

async function nextIndex (checksDir) {
  let names = []
  try { names = await fs.readdir(checksDir) } catch { return 1 }
  const numbers = names.map((n) => Number(n)).filter(Number.isInteger)
  return numbers.length ? Math.max(...numbers) + 1 : 1
}

/*
 * After a required command failed, a later command runs only when it declares
 * `needs` (an empty list: independent) and every need — plus the service it
 * joins — ran and passed. Without `needs` it is skipped, as before; every skip
 * is recorded in `result.skipped` with its reason.
 */
function skipReason (command, ran, failed) {
  if (!failed) return null
  if (!Array.isArray(command.needs)) return 'an earlier required command failed'
  const needs = [...new Set([...command.needs, ...(command.join ? [command.join] : [])])]
  const unmet = needs.find((id) => ran.find((c) => c.id === id)?.passed !== true)
  return unmet ? `needs ${unmet}, which ${ran.some((c) => c.id === unmet) ? 'failed' : 'did not run'}` : null
}

async function runCommandSet ({ commands, result, signal, run }) {
  let failed = false
  for (const command of commands ?? []) {
    if (signal?.aborted) break
    const reason = skipReason(command, result.commands, failed)
    if (reason) { (result.skipped ??= []).push({ id: command.id, required: command.required !== false, reason }); continue }
    result.commands.push(await run(command))
    if (!result.commands.at(-1).passed && command.required !== false) failed = true
  }
}

function judge (result) {
  const required = result.commands.filter((c) => c.required !== false)
  result.result = required.every((c) => c.passed) ? 'passed' : 'failed'
}

/**
 * The local check fence (0e): the candidate's commands run inside the seat
 * fence (harness/fence.mjs) — the rebuilt candidate writable, the declared
 * toolchain paths bound, everything else of this host (other projects, the
 * home, the panel's token and runs) absent — with an allow-listed
 * environment. A fence that cannot be proved does not run candidate code on
 * this host: the check is `unavailable` with the reason (audit I5), unless the
 * operator's DEVPANEL_FENCE_UNPROVED=run says to run it unconfined, labelled;
 * DEVPANEL_FENCE=off turns the fence off altogether. A host without the fence
 * (macOS) runs them unconfined only under the install's opt-in, and refuses
 * them otherwise (confinement-policy.mjs).
 */
async function localFence ({ target, cwd, signal, platform }) {
  const policy = fencePolicy({ platform })
  if (policy.mode === 'off') return { level: 'local-unconfined', reason: 'the fence is switched off (DEVPANEL_FENCE=off)', wrap: null }
  if (policy.mode === 'unfenced') return { level: 'local-unconfined', reason: policy.reason, wrap: null }
  if (policy.mode === 'refused') return { level: 'local-refused', reason: policy.reason, wrap: null, refused: true }
  const confinement = target.confinement ?? {}
  const home = os.homedir()
  const inHome = (p) => p === home || p.startsWith(home + '/')
  const manifest = {
    homeBinds: [...(confinement.readOnly ?? []).filter(inHome).map((p) => ({ path: p, writable: false })), ...(confinement.writable ?? []).filter(inHome).map((p) => ({ path: p, writable: true }))],
    readOnly: (confinement.readOnly ?? []).filter((p) => !inHome(p)),
    writable: (confinement.writable ?? []).filter((p) => !inHome(p))
  }
  const fence = await applyFence({ spec: { cwd, writable: [cwd], readOnly: [], entries: [], panelRoot: PANEL_ROOT }, manifest, command: '/bin/sh', signal })
  if (fence.applied) return { level: 'local-enforced', proof: fence.proof, wrap: fence.wrap }
  if (process.env.DEVPANEL_FENCE_UNPROVED === 'run') return { level: 'local-unconfined', reason: fence.reason, wrap: null }
  return { level: 'local-refused', reason: fence.reason, wrap: null, refused: true }
}

async function runCommandsLocally ({ target, cwd, dir, result, clock, signal, platform }) {
  const { wrap, refused = false, ...confinement } = await localFence({ target, cwd, signal, platform })
  result.confinement = confinement
  if (refused) {
    result.error = `the check fence ${platform.bubblewrap ? 'could not be proved' : 'does not exist on this host'}, so no candidate command ran on this host: ${confinement.reason}`
    result.result = 'unavailable'
    return
  }
  // Inside the fence /tmp is private; a TMPDIR naming a host path would not exist.
  const env = { ...childEnvironment('none'), HOME: os.homedir(), ...(wrap ? { TMPDIR: '/tmp' } : {}) }
  const spawn = c => ({ ...(wrap ? wrap('/bin/sh', ['-c', c.run]) : { command: '/bin/sh', args: ['-c', c.run] }), env })
  try {
    await runCommandSet({ commands: target.commands, result, signal, run: (command) => runOne({ command, cwd, dir, clock, signal, spawn }) })
  } finally {
    for (const command of target.finallyCommands ?? []) result.commands.push(await runOne({ command, cwd, dir, clock, spawn }))
  }
  judge(result)
  if (signal?.aborted) { result.error = 'cancelled'; result.result = 'unavailable' }
}

async function externalise (materialized, dir) {
  const text = JSON.stringify(materialized.remoteEntries)
  await fs.writeFile(path.join(dir, 'remote-entries.json'), text)
  materialized.remoteEntryCount = materialized.remoteEntries.length
  materialized.remoteEntriesFile = 'remote-entries.json'
  materialized.remoteEntriesSha256 = sha256(text)
  delete materialized.remoteEntries
}

async function sha256File (file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function runCommandsOverSsh ({ target, rebuilt, dir, result, materialized, clock, signal, candidateEntries }) {
  const { command: SSH, args: sshArgs } = await sshConnection(target.ssh)
  // A directory that is ours alone: named for the revision AND a fresh random
  // suffix, created without -p so an existing one is an error, never reused.
  const remoteDir = `${target.ssh.workdir.replace(/\/+$/, '')}/devpanel-check-${sha256(result.revision ?? `base:${result.baseCommit}`).slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}`
  // The engine's launch bookkeeping lives beside the candidate, owned by the
  // SSH account alone: candidate code can neither forge nor erase it (R8-4).
  const control = controlDir(remoteDir)
  const structured = confinementLevel(target) === 'structured'
  // The unit user and home: the project's, else the host settings'. A candidate
  // command without them is refused here, before anything is sent.
  const confinement = withConfinementDefaults(target.confinement ?? {})
  // A drive of privileged commands only runs as the SSH account: no handover,
  // no unit user, no candidate probe.
  const hasCandidates = [...(target.commands ?? []), ...(target.finallyCommands ?? [])].some((c) => c.kind === 'candidate')
  if (hasCandidates && (!confinement.user || !confinement.home)) {
    throw new Error('the test drive has kind: candidate commands but no unit user and home: set testDrive.confinement.user and .home in the project, or testDrive.confinement in the host settings')
  }

  // Archive the verified reconstruction; prove the bytes arrived intact.
  const archive = path.join(dir, 'candidate.tar')
  const tar = await runProcess({ command: 'tar', args: ['-C', rebuilt, '--exclude=.git', '-cf', archive, '.'], signal })
  if (tar.code !== 0) throw new Error(`tar failed: ${tar.stderr.slice(0, 200)}`)
  // Hashed and sent as streams: the archive of a large candidate is hundreds of
  // megabytes, and reading it whole into memory for each check spiked the
  // server's RSS (and cannot work past 2 GiB). The bytes go to stdin as bytes;
  // no string round-trip re-encodes them.
  const localHash = await sha256File(archive)
  materialized.archiveSha256 = localHash
  materialized.archiveBytes = (await fs.stat(archive)).size
  let upload
  try {
    upload = await runProcess({
      command: SSH, args: [...sshArgs, `mkdir ${shellQuote(remoteDir)} && mkdir -m 0700 ${shellQuote(control)} && cat > ${shellQuote(remoteDir + '.tar')} && sha256sum ${shellQuote(remoteDir + '.tar')} | cut -d' ' -f1 && tar -C ${shellQuote(remoteDir)} -xf ${shellQuote(remoteDir + '.tar')} && rm -f ${shellQuote(remoteDir + '.tar')}`],
      stdin: createReadStream(archive), signal
    })
  } finally {
    // Only its hash is evidence; a local copy kept per check grows without
    // bound. The candidate is rebuildable from base + patch.
    await fs.rm(archive, { force: true })
  }
  if (upload.code !== 0) throw new Error(`upload failed: ${upload.stderr.slice(0, 300)}`)
  const remoteHash = upload.stdout.trim().split(NL)[0]
  materialized.remoteSha256 = remoteHash
  if (remoteHash !== localHash) {
    materialized.verified = false
    throw new Error('archive hash on arrival differs from the archive sent; the result would not be bound to the revision')
  }

  // What is on the far side, as entries comparable to the fingerprint: sha256
  // of every regular file, target of every symlink, mode of each.
  const listRemote = async (listingSignal = signal) => {
    const listing = await runProcess({ command: SSH, args: [...sshArgs, `cd ${shellQuote(remoteDir)} && find . -type d \\( -name .git -o -name node_modules -o -name .devpanel-lock \\) -prune -o -type f -printf '%m\\t%p\\n' -exec sha256sum {} + ; echo '--links--'; find . -type d \\( -name .git -o -name node_modules -o -name .devpanel-lock \\) -prune -o -type l -printf '%p\\t%l\\n'`], signal: listingSignal })
    if (listing.code !== 0) { materialized.detail = `remote listing failed: ${listing.stderr.slice(0, 200)}`; return null }
    return parseRemoteListing(listing.stdout)
  }
  const cleanup = async () => {
    try {
      const removed = await runProcess({ command: SSH, args: [...sshArgs, `rm -rf ${shellQuote(remoteDir)} ${shellQuote(control)} ${shellQuote(remoteDir + '.tar')}`], signal: AbortSignal.timeout(30000) })
      materialized.cleanup = { passed: removed.code === 0 && !removed.cancelled, exitCode: removed.code, stderr: removed.stderr?.slice(0, 2000), remoteDir, archive: remoteDir + '.tar' }
    } catch (error) {
      materialized.cleanup = { passed: false, error: error.message, remoteDir, archive: remoteDir + '.tar' }
    }
    if (!materialized.cleanup.passed) throw new Error(`staging cleanup failed; candidate or archive may remain at ${remoteDir} and ${remoteDir}.tar`)
  }

  // Before any command: the remote directory must contain exactly the
  // candidate — nothing missing, nothing extra. A stale or pre-populated
  // directory would let a fixture that is not in the candidate make a test pass.
  const arrived = await listRemote()
  const before = arrived ? compareCandidate(candidateEntries, arrived) : null
  materialized.beforeCommands = before ? { modified: before.modified.length, deleted: before.deleted.length, added: before.added.length, reappeared: before.reappeared.length } : null
  if (!before || before.modified.length || before.deleted.length || before.added.length || before.reappeared.length) {
    materialized.verified = false
    await cleanup()
    const extra = before ? [...before.added, ...before.modified, ...before.deleted, ...before.reappeared] : []
    throw new Error(`the remote candidate differs from the revision before any command ran${extra.length ? ` (${extra.slice(0, 5).join(', ')})` : ''}; the directory is not a faithful copy`)
  }

  const finalizerIds=new Set((target.finallyCommands??[]).map(c=>c.id))
  const all = [...(target.commands ?? []), ...(target.finallyCommands ?? [])]
  const units = Object.fromEntries(all.filter(c => c.kind === 'candidate').map(c => [c.id, unitName(remoteDir, c.id)]))
  const options = { control, units, confinement }
  const remoteSpawn = c => ({command:SSH,remoteTimeout:true,args:[...sshArgs,managedRemoteCommand(remoteDir,c,finalizerIds.has(c.id),options)]})
  const stop = async({ services = true } = {})=>{
    try {
      const stopped=await runProcess({command:SSH,args:[...sshArgs,stopRemoteCommands(remoteDir,{ control, services })],signal:AbortSignal.timeout(60000)})
      materialized.remoteTermination={confirmed:stopped.code===0&&!stopped.cancelled,stderr:stopped.stderr?.slice(-2000)}
    }catch(error){materialized.remoteTermination={confirmed:false,error:error.message}}
  }
  result.confinement = { level: 'remote-unconfined', reason: structured ? null : 'the test drive declares no command kinds' }
  if (structured) {
    // Candidate commands run as the unit user; when the SSH account is root
    // the verified candidate is handed to it. Ownership is not in the
    // fingerprint (modes are), so arrival evidence is unaffected.
    const user = hasCandidates ? confinement.user : undefined
    if (hasCandidates) {
      const own = await runProcess({ command: SSH, args: [...sshArgs, `if [ "$(id -u)" = 0 ]; then chown -R -h ${shellQuote(user + ':')} ${shellQuote(remoteDir)}; fi`], signal })
      if (own.code !== 0) throw new Error(`could not hand the candidate to ${user}: ${own.stderr.slice(0, 200)}`)
    }
    // The probe decides the label, never whether the checks run (P6): a
    // target whose fence cannot be proved is reported as unconfined.
    const probe = []
    for (const command of probeCommands(target.projectRoot ?? null, confinement.home, [...(confinement.readOnly ?? []), ...(confinement.writable ?? [])])) {
      if (command.kind === 'candidate' && !hasCandidates) continue
      probe.push(await runOne({ command, cwd: null, dir, clock, signal, spawn: remoteSpawn }))
    }
    const failed = probe.filter(p => !p.passed).map(p => p.id)
    result.confinement = failed.length
      ? { level: 'remote-unconfined', reason: `confinement probe failed: ${failed.join(', ')} (see its log)`, probe: probe.map(p => ({ id: p.id, passed: p.passed, log: p.log })) }
      : { level: 'remote-enforced', user, probe: probe.map(p => ({ id: p.id, passed: p.passed, log: p.log })) }
  }
  try {
    await runCommandSet({ commands: target.commands, result, signal, run: (command) => runOne({ command, cwd: null, dir, clock, signal, spawn: remoteSpawn }) })
  } finally {
    // Services (the started application) outlive this stop: a finalizer may
    // still need them (a report collector). The final stop takes them too.
    await stop({ services: false })
    // A cancelled turn still needs logs and process cleanup. Each finalizer is
    // bounded independently and cannot inherit the already-aborted turn signal.
    for (const command of target.finallyCommands ?? []) {
      result.commands.push(await runOne({ command, cwd: null, dir, clock, spawn: remoteSpawn }))
    }
  }
  await stop()
  materialized.remoteEntries = await listRemote(signal?.aborted ? AbortSignal.timeout(30000) : signal)
  const isFinalizer = (c) => (target.finallyCommands ?? []).some(f => f.id === c.id)
  const failedFinalizers = result.commands.filter(c => isFinalizer(c) && c.required !== false && !c.passed).map(c => c.id)
  // A required command that failed before the finalizers is evidence against
  // the candidate. A collector that then finds nothing to collect (a tester
  // that never booted) is a consequence, and must not turn that failure into
  // `unavailable`: only `failed` gives the author another round.
  const failedCommands = result.commands.filter(c => !isFinalizer(c) && c.required !== false && !c.passed).map(c => c.id)
  if (failedFinalizers.length || !materialized.remoteTermination?.confirmed) {
    // Name what failed: a required finalizer (often a result collector) is not a cleanup fault.
    const causes = [
      ...(failedFinalizers.length ? [`required finalizer ${failedFinalizers.join(', ')} failed`] : []),
      ...(materialized.remoteTermination?.confirmed ? [] : ['remote command termination not confirmed'])
    ]
    result.error = `${failedCommands.length ? `required command ${failedCommands.join(', ')} failed; ` : ''}${causes.join('; ')}; candidate retained at ${remoteDir} for inspection`
    result.result = failedCommands.length ? 'failed' : 'unavailable'
  } else {
    await cleanup()
    judge(result)
  }
  if (signal?.aborted) { result.error = 'cancelled'; result.result = 'unavailable' }

}

/**
 * The remote listing, as fingerprint-shaped entries. `find -printf '%m\t%p'`
 * lines give modes, `sha256sum` lines give content, and the section after
 * `--links--` gives symlink targets, hashed the way the fingerprint hashes them.
 */
export function parseRemoteListing (stdout) {
  const modes = new Map()
  const hashes = new Map()
  const links = new Map()
  let inLinks = false
  for (const raw of stdout.split(NL)) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    if (line === '--links--') { inLinks = true; continue }
    if (inLinks) {
      const [p, target] = line.split('\t')
      if (p) links.set(p.replace(/^\.\//, ''), target ?? '')
      continue
    }
    const tab = line.indexOf('\t')
    if (tab > 0 && /^[0-7]+$/.test(line.slice(0, tab))) { modes.set(line.slice(tab + 1).replace(/^\.\//, ''), line.slice(0, tab)); continue }
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line)
    if (m) hashes.set(m[2].replace(/^\.\//, ''), m[1])
  }
  const entries = []
  for (const [p, hex] of hashes) entries.push({ path: p, status: 'present', contentHash: `sha256:${hex}`, mode: (modes.get(p) ?? '').padStart(6, '0') })
  for (const [p, target] of links) entries.push({ path: p, status: 'present', contentHash: sha256Prefixed(`link:${target}`), mode: 'link' })
  return entries
}

const sha256Prefixed = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`

/** One command, with its log on disk and its outcome in the record. */
/*
 * The test-result lines of a command's whole output, for reviewers: a selftest
 * or browser-check report inside a test drive is usually a non-gating collector
 * whose PASS/FAIL lines are the only evidence for an acceptance criterion, and
 * they sit far past the 2000-character stdout head. Seats cannot read the log
 * files (outside every allowed root), so without this extract a run closes on
 * discretion or ends closure-conditions-unmet. Generic on
 * purpose: line-leading PASS/FAIL/SKIP/ok/not ok/check marks and "N passed"
 * style totals, bounded in count and width; the full log stays beside it.
 */
const RESULT_LINE = /^\s*(?:PASS|FAIL|SKIP|XFAIL|ERROR|ok|not ok|[✓✔✗✘×]|\d+ (?:passed|failed|skipped|tests?|failures?|errors?)\b)/
export function resultLines (text, { maxLines = 200, maxWidth = 300 } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => RESULT_LINE.test(l))
  if (!lines.length) return null
  return { lines: lines.slice(0, maxLines).map((l) => l.trimEnd().slice(0, maxWidth)), total: lines.length, truncated: Math.max(0, lines.length - maxLines) }
}

async function runOne ({ command, cwd, dir, clock, signal, spawn }) {
  const started = clock.now()
  const log = path.join(dir, `${command.id}.log`)
  const timeoutMs = (command.timeoutSeconds ?? 900) * 1000
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const record = { id: command.id, ...(command.kind ? { kind: command.kind } : {}), run: command.run, required: command.required !== false, exitCode: null, signal: null, timedOut: false, durationMs: null, log: path.basename(log), passed: false }
  try {
    const { command: cmd, args, remoteTimeout, env } = spawn(command)
    const out = await runProcess({ command: cmd, args, cwd: cwd ?? undefined, signal: combined, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) })
    await fs.writeFile(log, `$ ${command.run}${NL}${NL}${out.stdout}${out.stderr ? `${NL}--- stderr ---${NL}${out.stderr}` : ''}${NL}--- exit ${out.code ?? out.signal} in ${clock.now() - started} ms${out.cancelled ? ' (terminated)' : ''} ---${NL}`, 'utf8')
    record.exitCode = out.code
    record.signal = out.signal
    record.timedOut = (out.cancelled && timeout.aborted && !(signal?.aborted)) || (remoteTimeout === true && out.code === 124)
    record.passed = out.code === 0 && !out.cancelled
    // Check commands are not reaped: the record says no scan was made, which
    // is not the same as a scan that found nothing.
    record.descendants = out.leftovers?.scan ?? null
    // Bounded excerpts for reviewers (checkSummary passes them on): a command's
    // own digest leads its stdout; failures usually end its stderr. The whole
    // output stays in the log beside it.
    record.stdout = out.stdout.slice(0, 2000)
    await fs.writeFile(path.join(dir, `${command.id}.stdout`), out.stdout, 'utf8')
    record.stderr = out.stderr.slice(-1000)
    const results = resultLines(`${out.stdout}${NL}${out.stderr}`)
    if (results) record.results = results
  } catch (error) {
    await fs.writeFile(log, `$ ${command.run}${NL}${NL}could not run: ${error.message}${NL}`, 'utf8')
  }
  record.durationMs = clock.now() - started
  return record
}

/*
 * Base versus candidate, command by command (compareBaseline): the lines of
 * each command's full stdout that only one side printed, after replacing the
 * per-check directory names. Generic on purpose — a digest that prints one
 * line per failing test or per file with warnings turns into "new failures"
 * and "changed warning counts" without the engine knowing its format. A line
 * printed twice on one side and once on the other counts once.
 */
const CHECK_DIR = /devpanel-check-[0-9a-f-]+/g
export async function compareWithBaseline ({ runDir, baseline, candidate, maxLines = 40 }) {
  const lines = async (check, id) => {
    try { return (await fs.readFile(path.join(runDir, check.dir, `${id}.stdout`), 'utf8')).replace(CHECK_DIR, 'devpanel-check-*').split(NL).map((l) => l.trimEnd()).filter(Boolean) } catch { return null }
  }
  const counted = (list) => { const m = new Map(); for (const l of list) m.set(l, (m.get(l) ?? 0) + 1); return m }
  const commands = []
  for (const c of candidate.commands ?? []) {
    const b = (baseline.commands ?? []).find((x) => x.id === c.id)
    if (!b) { commands.push({ id: c.id, baseline: 'not run', candidatePassed: c.passed }); continue }
    const [bl, cl] = [await lines(baseline, c.id), await lines(candidate, c.id)]
    if (!bl || !cl) { commands.push({ id: c.id, baselinePassed: b.passed, candidatePassed: c.passed, output: 'unavailable' }); continue }
    const [bm, cm] = [counted(bl), counted(cl)]
    const added = [...cm.keys()].filter((l) => (cm.get(l) ?? 0) > (bm.get(l) ?? 0))
    const removed = [...bm.keys()].filter((l) => (bm.get(l) ?? 0) > (cm.get(l) ?? 0))
    if (!added.length && !removed.length && b.passed === c.passed) continue
    commands.push({ id: c.id, baselinePassed: b.passed, candidatePassed: c.passed,
      addedCount: added.length, removedCount: removed.length,
      added: added.slice(0, maxLines).map((l) => l.slice(0, 240)), removed: removed.slice(0, maxLines).map((l) => l.slice(0, 240)) })
  }
  return { baselineDir: baseline.dir, baselineResult: baseline.result, baseCommit: baseline.baseCommit ?? null, commands,
    unchanged: (candidate.commands ?? []).filter((c) => !commands.some((x) => x.id === c.id)).map((c) => c.id),
    instruction: 'Lines only the candidate printed (added) and only the base printed (removed), per command, both runs of the same target on this host. A FAIL line in added is a failure the change introduced; one in removed is a failure it fixed. Commands listed as unchanged printed the same lines and passed or failed alike on both.' }
}
