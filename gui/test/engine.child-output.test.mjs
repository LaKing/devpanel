import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { assertFenced } from '../../harness/fence.mjs'
import { FAILURE_CLASSES, classifyFailure } from '../server/runtime/failure.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { ProcessError } from '../server/runtime/process.mjs'
import { CHILD_OUTPUT_MEANING, CHILD_OUTPUT_UNCHECKED, CHILD_OUTPUT_UNOBSERVABLE, childOutputScan } from '../server/runtime/tooling-commands.mjs'
import { cleanupFixtures, engineFixture } from './fakes/fixture.mjs'

export const name = 'empty output from a Node child that could not be observed, on the record apart from every failure class'

const PANEL = path.resolve(import.meta.dirname, '..', '..')

// Built here, so reading this file cannot put a real line in anyone's output.
const unobservable = (nonce = randomUUID()) => `${CHILD_OUTPUT_UNOBSERVABLE} [${nonce}]: a Node child's output came back empty`
const unchecked = (nonce = randomUUID()) => `${CHILD_OUTPUT_UNCHECKED} [${nonce}]: the measurement gave no answer`
// A command's output as the Codex stream carries it.
const asStream = (output) => `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, status: 'completed', aggregated_output: `${output}\n` } })}\n`
const REFUSED = 'This content was flagged for possible cybersecurity risk.'

async function drive (f, invoke) {
  const engine = await startRun({
    playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
    workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
  })
  let thrown = null
  try { await engine.drive() } catch (error) { thrown = error }
  const run = engine.run
  await releaseWorkspace(engine)
  return { run, thrown, implement: run.steps.find((s) => s.stepId === 'implement') ?? null }
}

/** One run whose implement turn writes `chunks` to its stream first. */
async function turnSaying (chunks) {
  const f = await engineFixture()
  return drive(f, async (args) => {
    if (args.meta.stepId === 'implement') for (const chunk of chunks) args.observe.onOutput('stdout', chunk)
    return f.fake.invoke(args)
  })
}

/** One run whose implement turn writes the line and then fails with `error`. */
async function turnFailing (line, error) {
  const f = await engineFixture()
  return drive(f, async (args) => {
    if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
    args.observe.onOutput('stdout', asStream(line))
    throw error(args)
  })
}

export default async function (t) {
  t.section('the scanner reads the wrapper\'s lines and nothing that only names them')
  {
    const nonce = randomUUID()
    const scan = childOutputScan()
    const line = unobservable(nonce)
    t.eq('nothing yet', scan('some output\n'), null)
    const cut = Math.floor(line.length / 2)
    t.eq('half a line is not one', scan(line.slice(0, cut)), null)
    t.eq('a line split across chunks is read whole', scan(`${line.slice(cut)}\n`), { unobservable: 1, unchecked: 0, line })
    t.eq('the same call seen again counts once', scan(asStream(line)).unobservable, 1)
    const other = unchecked()
    t.eq('another call counts apart, and the unobservable line stays the one kept', scan(`${other}\n`), { unobservable: 1, unchecked: 1, line })
    t.eq('unchecked alone keeps its own line', childOutputScan()(`${other}\n`), { unobservable: 0, unchecked: 1, line: other })
    t.eq('inside a JSON string the line ends at the escape', childOutputScan()(asStream(line)).line, line)
    t.eq('the prefix with a placeholder is not one', childOutputScan()(`${CHILD_OUTPUT_UNOBSERVABLE} [<nonce>]: text\n`), null)
    t.eq('the prompt\'s own sentence is not one', childOutputScan()(asStream(CHILD_OUTPUT_MEANING)), null)
  }

  t.section('(a) a turn that saw the line: on its step, and not a failure of any class (AC2)')
  {
    const line = unobservable()
    const cut = 40
    const { run, thrown, implement } = await turnSaying([asStream(line).slice(0, cut), asStream(line).slice(cut)])
    t.eq('nothing thrown', thrown, null)
    t.eq('the run went on to complete', run.status, 'completed', run.blockedReason)
    t.eq('it reads on the step', implement.childOutput, { unobservable: 1, unchecked: 0, line })
    t.ok('only on that step', run.steps.filter((s) => s.childOutput).length === 1)
    t.eq('no failure is recorded', [run.failure, run.failures], [null, []])

    const control = await turnSaying(['nothing of note\n'])
    t.eq('it does not read as a fence failure: step.fence is what it is without the line', implement.fence ?? null, control.implement.fence ?? null)
    t.ok('and FAILURE_CLASSES did not grow a class for it', !FAILURE_CLASSES.some((c) => /output|child|observ/.test(c) && c !== 'output-limit'))
  }

  t.section('a turn that really saw nothing has nothing recorded (AC4)')
  {
    const { run, implement } = await turnSaying([asStream('')])
    t.eq('empty command output: no field on the step', 'childOutput' in implement, false)
    t.ok('nor on any other', run.steps.every((s) => !('childOutput' in s)))
    const naming = await turnSaying([asStream(CHILD_OUTPUT_MEANING), `${CHILD_OUTPUT_UNOBSERVABLE} [<nonce>]\n`])
    t.eq('a seat reading the prompt or the docs records nothing', 'childOutput' in naming.implement, false)
  }

  t.section('(b), (c), (d) keep their own classes with the line beside them, and do not read as (a) (AC2)')
  {
    const line = unobservable()
    const stdout = `${line}\n`
    const fenceError = (() => { try { assertFenced({ applied: false, reason: 'probe failed' }, { turn: 'a seat turn', mounts: [{ target: 'gui/node_modules', source: '/x' }] }) } catch (error) { return error } })()
    t.eq('assertFenced refuses: the fixture is the real fence failure', fenceError?.kind, 'environment-error')
    t.eq('the line alone is not a class of its own: a bare runtime error stays runtime', classifyFailure(new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stdout })).class, 'runtime')
    t.eq('unchecked likewise', classifyFailure(new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stdout: `${unchecked()}\n` })).class, 'runtime')
    // The wrapper's own wording, since the classifier reads a failed turn's stdout for words.
    const wrapperLines = (await fs.readFile(path.join(PANEL, 'harness', 'tooling', 'offline'), 'utf8')).split('\n').filter((l) => l.includes('echo "devpanel-offline: child output'))
    t.eq('the wrapper has its three lines', wrapperLines.length, 3)
    for (const words of wrapperLines) t.eq(`the wrapper's words stay runtime: ${words.trim().slice(0, 60)}`, classifyFailure(new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stdout: words })).class, 'runtime')

    const refusal = await turnFailing(line, (args) => new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: REFUSED, stdout, invocationId: args.meta.invocationId }))
    t.eq('(b) a provider refusal is class refusal', refusal.run.failure?.class, 'refusal')
    t.eq('with its own words', refusal.run.failure?.message, REFUSED)

    const adapter = await turnFailing(line, (args) => new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: 'something odd happened', stdout, invocationId: args.meta.invocationId }))
    t.eq('(c) an adapter failure is class runtime', adapter.run.failure?.class, 'runtime')

    const fence = await turnFailing(line, () => fenceError)
    t.eq('(d) a fence failure is class environment', fence.run.failure?.class, 'environment')

    for (const [label, r] of [['(b)', refusal], ['(c)', adapter], ['(d)', fence]]) {
      t.eq(`${label} leaves no implement step, so nothing there reads as (a)`, r.implement, null)
      t.ok(`${label} no step carries the field`, r.run.steps.every((s) => !('childOutput' in s)))
    }
    t.eq('the three are three different classes', new Set([refusal, adapter, fence].map((r) => r.run.failure?.class)).size, 3)
  }

  await cleanupFixtures()
}
