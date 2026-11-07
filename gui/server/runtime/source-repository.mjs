import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/*
 * The source checkout, proven readable before a run is reserved.
 *
 * The git worktree provider reads the project's repository when it provisions a
 * workspace — which is after preflight has already probed every participant at
 * model depth. A checkout git refuses to read therefore used to cost a paid
 * launch and leave behind a failed run whose whole account of itself was a raw
 * `Command failed: git -C … rev-parse HEAD`. None of these faults are anything
 * an agent could have acted on: they belong to the host, and they are cheap to
 * prove. So they are proven here, before anything is reserved or spent, and
 * reported with a stable code and the remedy.
 *
 * Because the check runs before reservation there is deliberately no run to
 * carry `run.failure`; the classification travels on the rejected start instead
 * (`class: 'environment'`, `started: false`, `retryable: false`).
 *
 * What is NOT judged here: whether the checkout is clean, and what the base
 * policy makes of it. A dirty checkout is a legitimate start under
 * `working-tree`, and refusing it under `head` is the provider's decision
 * (DIRTY_BASE) — made against the tree as it is at provisioning time, not
 * against a reading taken earlier.
 */

/**
 * Does a run cut its workspace from the project's own repository?
 *
 * A production deployment does not: it unpacks the archive of a release that
 * was already staged, so the state of the source checkout says nothing about
 * whether it can run, and refusing it over one would be a fault invented by this
 * gate. A deployment to staging, or staging-then-production, snapshots the
 * checkout like the removed Staging playbook did (config/release-plan.mjs).
 */
export const usesSourceRepository = (resolved) => resolved?.tactic !== 'deployment' || Boolean(resolved.release?.mode && resolved.release.mode !== 'production')

/** Every fault this gate can report. Stable: callers and the panel key off them. */
export const REPOSITORY_FAULTS = ['UNSAFE_REPOSITORY', 'NOT_A_REPOSITORY', 'EMPTY_REPOSITORY', 'UNREADABLE_REPOSITORY']

/**
 * Run git and report what it said either way. A fault is diagnosed from the
 * runtime's own words, so the words are kept and reported with it.
 */
const gitReader = async (projectPath, args) => {
  try {
    const { stdout } = await exec('git', ['-C', projectPath, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 8 * 1024 * 1024
    })
    return { ok: true, stdout: stdout.trim(), stderr: '' }
  } catch (error) {
    // A git that cannot be spawned at all has no stderr; its message is the evidence.
    return { ok: false, stdout: (error.stdout ?? '').trim(), stderr: (error.stderr ?? '').trim() || (error.message ?? '').trim() }
  }
}

/*
 * `resolvableBy` states CAPABILITY, not permission. 'commit-action' says only
 * that an action which commits the checkout would clear this fault — not that
 * anyone may run one. Committing changes the user's working state, and what a
 * given script does is known only from what it declares (`effect:
 * commit-checkout`), never from being called push. Whether it may be run is a
 * separate question, answered by the mission, and it is answered elsewhere.
 *
 * 'operator' says no configured action can clear it at all: ownership, a missing
 * repository and a broken HEAD are changes to the host. Naming those as
 * agent-fixable would only buy a failed action and a second identical refusal.
 */
const fault = (code, message, remedy, detail, resolvableBy = 'operator') =>
  ({ code, message, remedy, resolvableBy, detail: detail ? detail.slice(0, 1000) : null })

/**
 * Can a run be cut from this checkout?
 *
 * @returns null when the repository is readable and has a commit to cut from,
 *          otherwise { code, message, remedy, detail }.
 */
export async function inspectSourceRepository ({ projectPath, git = gitReader }) {
  const repository = await git(projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!repository.ok) {
    if (/dubious ownership/i.test(repository.stderr)) {
      return fault('UNSAFE_REPOSITORY',
        `git refuses to read the source checkout at ${projectPath}: it is owned by another user than the one this panel runs as.`,
        `Give the checkout to the panel's own user (chown -R), or record the exception deliberately: git config --global --add safe.directory ${projectPath}`,
        repository.stderr)
    }
    if (/not a git repository/i.test(repository.stderr)) {
      return fault('NOT_A_REPOSITORY',
        `the source checkout at ${projectPath} is not a git repository, so a run has no workspace to be cut from.`,
        'Initialise it and commit its starting files (git init && git add -A && git commit), or point the project at a checkout that is a repository.',
        repository.stderr)
    }
    return fault('UNREADABLE_REPOSITORY',
      `the source checkout at ${projectPath} could not be read by git.`,
      'Read the error below on the host and make the checkout readable before starting a run.',
      repository.stderr)
  }

  // --quiet, so an absent HEAD is an exit code rather than a diagnostic: what
  // distinguishes an unborn branch from a broken one is whether HEAD still
  // names a ref at all.
  const head = await git(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (!head.ok) {
    const unborn = await git(projectPath, ['symbolic-ref', '--quiet', 'HEAD'])
    if (unborn.ok) {
      return fault('EMPTY_REPOSITORY',
        `the source checkout at ${projectPath} has no valid HEAD: ${unborn.stdout} has no commits, so there is no base commit to cut a run's worktree from.`,
        'Commit the intended starting files (git add -A && git commit), or run a project action that declares it commits the checkout, then start the run again.',
        unborn.stdout || head.stderr, 'commit-action')
    }
    return fault('UNREADABLE_REPOSITORY',
      `HEAD cannot be resolved in the source checkout at ${projectPath}.`,
      'Restore HEAD to a commit on the host before starting a run.',
      head.stderr || unborn.stderr)
  }
  return null
}

/**
 * The refusal, as the start API rejects it. There is no run yet — on purpose —
 * so everything an operator or the top-level supervisor needs to act on is on
 * the error: which fault, that it is the environment's, that it did not start,
 * and that retrying it unchanged cannot help.
 */
export function repositoryFaultError (detected) {
  return Object.assign(new Error(`${detected.message} ${detected.remedy}`), {
    status: 422,
    code: detected.code,
    resolvableBy: detected.resolvableBy,
    class: 'environment',
    started: false,
    retryable: false,
    remedy: detected.remedy,
    detail: detected.detail
  })
}
