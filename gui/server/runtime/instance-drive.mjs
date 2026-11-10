import crypto from 'node:crypto'

/*
 * A modules tier on a dynamic stage instance (docs/project-infrastructure.md
 * "A stage instance per run"): `testDrive.modules.instance` declares how the
 * stage host creates, starts and destroys an instance, and the tier's commands
 * name it with `{{instance}}` (its root) and `{{instanceName}}`. This file is
 * the part that reads no host: the name, the substitution, which commands a
 * drive runs, and what a finished drive says about the instance. The slots and
 * the destroy are stage-instances.mjs.
 *
 * Without `instance` the tier is the base-instance mode: its commands name one
 * fixed instance, and a drive holds the staging host whole (drive-slots.mjs).
 */

// What the stage's own tooling accepts as a name; the engine never sends another.
export const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
export const CREATE_ID = 'instance-create'
export const START_ID = 'instance-start'

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

/**
 * The instance of a run: its id, lower-cased, when that is a valid name (so the
 * stage's own listing shows which run an instance belongs to), else a hash of
 * it. `scope` names another tree of the same run (a hook subscriber's project),
 * which needs an instance of its own. The same input always gives the same name:
 * a run finds, and removes, what an earlier process of it left.
 */
export function instanceName (runId, scope = null) {
  const plain = `dp-${String(runId).toLowerCase()}`
  if (!scope && INSTANCE_NAME.test(plain)) return plain
  return `dp-${scope ? 's' : 'r'}-${sha(scope ? `${runId}\0${scope}` : String(runId)).slice(0, 24)}`
}

const PLACEHOLDER = /\{\{instance(Name)?\}\}/

/** Whether a command text names the instance. */
export const namesInstance = (run) => typeof run === 'string' && PLACEHOLDER.test(run)

const fill = (command, { name, root }) => ({ ...command, run: command.run.replaceAll('{{instanceName}}', name).replaceAll('{{instance}}', root) })

/**
 * A drive's target bound to its instance: every command names it, and
 * `stageInstance` carries what the check runner needs to create it on the
 * first drive and to remove it. The commands stay the reuse form (load,
 * restart); `driveCommands` gives the first drive's.
 */
export function withInstance (target, modules, name) {
  if (!INSTANCE_NAME.test(name ?? '')) throw new Error(`a modules tier with a stage instance needs a valid instance name, got ${JSON.stringify(name)}`)
  const declared = modules.instance
  const at = { name, root: `${declared.root.replace(/\/+$/, '')}/${name}` }
  return {
    ...target,
    commands: target.commands.map((c) => fill(c, at)),
    ...(target.finallyCommands ? { finallyCommands: target.finallyCommands.map((c) => fill(c, at)) } : {}),
    stageInstance: {
      ...at,
      ...(Number.isInteger(declared.max) ? { max: declared.max } : {}),
      create: { ...fill(declared.create, at), id: CREATE_ID },
      start: { ...fill(declared.start, at), id: START_ID },
      destroy: fill(declared.destroy, at),
      ids: { lint: modules.lint.id, load: modules.load.id, restart: modules.restart.id, ready: modules.ready.id }
    }
  }
}

/**
 * The commands of one drive. On an instance that runs already they are the
 * tier's own: lint, load, restart, ready, tests. A first drive creates the
 * instance from the candidate instead of loading into one, so create comes
 * first (lint reads the instance's toolchain), start takes restart's place and
 * load is left out.
 */
export function driveCommands (target, fresh) {
  const instance = target.stageInstance
  if (!instance || !fresh) return target.commands
  const { load, restart } = instance.ids
  return [instance.create, ...target.commands.filter((c) => c.id !== load).map((c) => c.id === restart ? instance.start : c)]
}

/**
 * What a finished drive leaves of its instance:
 *   live       the commands that bring it up all passed: the next drive loads into it
 *   untouched  none of them ran (the candidate never arrived): as it was before the drive
 *   doubt      one failed, was cut short or was skipped: what runs there is unknown, so it
 *              is destroyed and the next drive, a retry included, creates a fresh one
 */
export function instanceVerdict (target, fresh, result) {
  const { ids } = target.stageInstance
  const steps = fresh ? [CREATE_ID, START_ID, ids.ready] : [ids.load, ids.restart, ids.ready]
  const records = steps.map((id) => (result.commands ?? []).find((c) => c.id === id))
  if (!records[0]) return 'untouched'
  return records.every((c) => c?.passed) ? 'live' : 'doubt'
}

/** How long each lifecycle step of a drive took, from its command records. */
export function instanceTimings (target, fresh, result) {
  const { ids } = target.stageInstance
  const of = (id) => (result.commands ?? []).find((c) => c.id === id)
  const ms = (id) => of(id)?.durationMs ?? null
  const startWait = of(START_ID)?.busyWaitMs
  return fresh
    ? { created: of(CREATE_ID)?.passed === true, createMs: ms(CREATE_ID), startMs: ms(START_ID), ...(startWait ? { startWaitMs: startWait } : {}), readyMs: ms(ids.ready) }
    : { loadMs: ms(ids.load), restartMs: ms(ids.restart), readyMs: ms(ids.ready) }
}

const seconds = (ms) => ms == null ? 'not run' : `${Math.round(ms / 1000)} s`

/**
 * A check's stage instance in a sentence, for reviewers and the run explanation:
 * which instance, whether this drive created it, what that cost and what became of
 * it. Empty for a drive in base-instance mode.
 */
export function instanceWords (check) {
  const used = check?.stageInstance
  if (!used) return ''
  const waited = (used.slotWaitMs ?? 0) + (used.startWaitMs ?? 0)
  const how = used.state === 'not-created' ? `The drive ended before stage instance ${used.name} was created on ${used.host}.`
    : used.fresh && used.created === false ? `Stage instance ${used.name} could not be created on ${used.host} from this candidate (create ${seconds(used.createMs)}); nothing was started or tested.`
    : used.fresh ? `This drive created stage instance ${used.name} on ${used.host} for the run (create ${seconds(used.createMs)}, start ${seconds(used.startMs)}, ready ${seconds(used.readyMs)}${waited ? `, after waiting ${seconds(waited)} for room on the host` : ''}).`
      : `This drive loaded the candidate into the run's stage instance ${used.name} on ${used.host} (load ${seconds(used.loadMs)}, restart ${seconds(used.restartMs)}, ready ${seconds(used.readyMs)}).`
  const gone = !used.destroyed || used.created === false ? ''
    : ` The instance ${used.fresh ? 'did not come up' : 'did not come back after the load'}, so it was ${used.destroyed.passed ? 'destroyed' : `to be destroyed, which failed (${used.destroyed.error}); it keeps its slot until that succeeds`}: the next drive creates a new one.`
  return how + gone
}
