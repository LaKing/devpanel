import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createQuotaFallback } from '../server/runtime/model-fallback.mjs'
import { classifyFailure, backoffMs, parseRetryAfter, createAvailabilityStore } from '../server/runtime/failure.mjs'
import { codexErrors } from '../../harness/codex.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { ProcessError } from '../server/runtime/process.mjs'
import { resumeUnavailable } from '../server/runtime/run-control.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { manualClock } from '../server/runtime/clock.mjs'

const NL = String.fromCharCode(10)

// The recorded sample: run.failures[] of a resumed audit turn on gpt-6.1-sol.
const REFUSED = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you're doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying."
const CODEX_NOISE = ['Reading prompt from stdin...', 'ERROR codex_core::session: failed to record rollout items: thread 01a1a1a6-647b-7f53-a095-1343c8eaff2c not found'].join(NL)

export default async (t) => {
  t.section('1. runtime failures are classified from the runtime\'s own words')
  {
    const c = (message, detail = {}) => classifyFailure(new ProcessError(message, { kind: 'runtime-error', ...detail }))
    t.eq('a 429 is a rate limit', c('claude exited 1', { stderr: 'API Error: 429 Too Many Requests' }).class, 'rate-limit')
    t.eq('and retryable', c('claude exited 1', { stderr: 'rate limit reached' }).retryable, true)
    t.eq('a quota exhaustion is a quota', c('codex exited 1', { stderr: 'You have hit your usage limit. Resets at 2026-09-14T00:00:00Z' }).class, 'quota')
    t.eq('and not retryable within the run', c('codex exited 1', { stderr: 'insufficient_quota' }).retryable, false)
    t.eq('a credential failure is auth', c('claude exited 1', { stderr: 'Error: 401 unauthorized' }).class, 'auth')
    t.eq('a broken sandbox is environment', c('claude exited 1', { stderr: 'Error: sandbox required but unavailable: bubblewrap (bwrap) not installed' }).class, 'environment')
    t.eq('an unknown CLI flag is environment', c('codex exited 2', { stderr: "error: unexpected argument '--sandbox' found" }).class, 'environment')
    t.eq('a spawn error is environment', classifyFailure(Object.assign(new Error('spawn claude ENOENT'), { kind: 'spawn-error', started: false })).class, 'environment')
    t.eq('a 503 is transient', c('claude exited 1', { stderr: '503 Service Unavailable' }).class, 'transient')
    t.eq('anything else is runtime', c('claude exited 1', { stderr: 'something odd happened' }).class, 'runtime')
    t.eq('quota beats rate-limit when both words appear', c('x', { stderr: 'usage limit reached; rate limit' }).class, 'quota')
    t.ok('the evidence is kept', c('claude exited 1', { stderr: 'API Error: 429' }).evidence.includes('429'))
    const expired = 'authentication_failed: Failed to authenticate: OAuth session expired and could not be refreshed'
    t.eq('an expired OAuth session is auth, not runtime', c('claude exited 1', { stdout: expired }).class, 'auth')
    t.eq('with the credential file unchanged, still auth', c('claude exited 1', { stdout: expired, credentials: { changed: false, how: null } }).class, 'auth')
    const rotated = c('claude exited 1', { stdout: expired, credentials: { changed: true, how: 'replaced' } })
    t.eq('replaced under the turn, transient and retried once, at once', `${rotated.class}:${rotated.retryable}:${rotated.maxRetries}:${rotated.retryAfterMs}`, 'transient:true:1:0')
    t.eq('with the change on the classification', rotated.credentials?.how, 'replaced')
    t.eq('a removed file is a change too: transient', c('claude exited 1', { stdout: expired, credentials: { changed: true, how: 'removed' } }).class, 'transient')
  }

  t.section('1b. a provider content refusal is its own class, with its words as the message')
  {
    const c = (detail) => classifyFailure(new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, ...detail }))
    const viaStderr = c({ stderr: [CODEX_NOISE, REFUSED].join(NL) })
    t.eq('the sample on stderr is a refusal', viaStderr.class, 'refusal')
    t.eq('not retryable', viaStderr.retryable, false)
    t.eq('its words verbatim, not the exit line', viaStderr.message, REFUSED)
    t.ok('the exit line stays in the evidence', viaStderr.evidence.startsWith('codex exited 1'), viaStderr.evidence)
    const stream = JSON.stringify({ type: 'turn.failed', error: { message: REFUSED } })
    const viaStream = c({ stderr: CODEX_NOISE, stdout: codexErrors(stream) })
    t.eq('in the stream\'s error events, the same', `${viaStream.class}:${viaStream.message}`, `refusal:${REFUSED}`)
    t.eq('as the error\'s own message, the same', classifyFailure(new Error(REFUSED)).class, 'refusal')

    const quoting = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: REFUSED } })
    t.eq('a model quoting it in a raw stream is not one', c({ stdout: quoting }).class, 'runtime')
    t.eq('nor through the adapter, which keeps only error events', c({ stdout: codexErrors(quoting) }).class, 'runtime')
    t.eq('nor inside a longer line', c({ stderr: `the issue says: ${REFUSED}` }).class, 'runtime')
    t.eq('an unrelated failure keeps its first line', c({ stderr: 'something odd happened' }).message, 'codex exited 1')
  }

  t.section('2. retry-after is honoured, else exponential backoff with a cap')
  {
    t.eq('seconds', parseRetryAfter('retry-after: 45'), 45_000)
    t.eq('minutes', parseRetryAfter('please try again in 2 minutes'), 120_000)
    t.eq('an absolute reset', parseRetryAfter('resets at 2026-09-13T00:10:00Z', Date.parse('2026-09-13T00:00:00Z')), 600_000)
    t.eq('nothing when nothing is said', parseRetryAfter('nope'), null)
    t.eq('first attempt waits the base', backoffMs(1, { baseMs: 30_000 }), 30_000)
    t.eq('third attempt waits four times the base', backoffMs(3, { baseMs: 30_000 }), 120_000)
    t.eq('never beyond the cap', backoffMs(10, { baseMs: 30_000, maxMs: 600_000 }), 600_000)
    t.eq('the provider\'s own retry-after wins', backoffMs(1, { baseMs: 30_000, retryAfterMs: 5_000 }), 5_000)
  }

  t.section('3. the availability store remembers exhaustion, honestly marked')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-avail-'))
    const clock = manualClock()
    const s = createAvailabilityStore(path.join(dir, 'a.json'), { clock, defaultHoldMs: 60_000 })
    t.eq('unknown models are available', await s.check('opus-5'), null)
    const rec = await s.recordExhausted({ modelId: 'opus-5', reason: 'usage limit', runId: 'r1' })
    t.eq('an unparsed reset is an assumed hold', rec.assumed, true)
    t.ok('with the default hold', Date.parse(rec.exhaustedUntil) === clock.now() + 60_000)
    t.ok('checked as exhausted', (await s.check('opus-5'))?.runId === 'r1')
    const exact = await s.recordExhausted({ modelId: 'opus-5', reason: 'resets later', retryAfterMs: 30 * 60_000 })
    t.eq('a provider-stated reset supersedes the assumption', exact.assumed, false)
    clock.advance(31 * 60_000)
    t.eq('and expires on its own', await s.check('opus-5'), null)
    await s.recordExhausted({ modelId: 'gpt', reason: 'x' })
    t.eq('active lists what is still cooling', (await s.active()).map((r) => r.modelId).join(), 'gpt')
    t.eq('clear removes a record', await s.clear('gpt'), true)
    t.eq('and reports when there was none', await s.clear('gpt'), false)
    await fs.writeFile(path.join(dir, 'a.json'), '{not json')
    let threw = null
    try { await s.check('gpt') } catch (error) { threw = error }
    t.ok('a corrupt store fails closed rather than meaning "available"', threw?.status === 503, threw?.message)
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('4. a rate-limited turn is retried after a wait, and the run goes on')
  {
    const f = await engineFixture()
    let calls = 0
    const invoke = async (args) => {
      if (args.meta.stepId === 'implement' && calls++ < 2) throw new ProcessError('claude exited 1', { kind: 'runtime-error', code: 1, stderr: 'API Error: 429 rate_limit_error retry-after: 7', invocationId: args.meta.invocationId })
      return f.fake.invoke(args)
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    // The engine waits on the injected clock's sleep, which the manual clock
    // satisfies instantly by advancing time: no real waiting, no ticking.
    const before = f.clock.now()
    const run = await engine.drive()
    t.eq('the two waits advanced the clock by exactly the provider\'s retry-after', f.clock.now() - before, 14_000)
    t.eq('the run completed', run.status, 'completed', run.blockedReason)
    t.eq('two retries were recorded', run.failures.filter((x) => x.retried).length, 2)
    t.eq('classified', run.failures[0].class, 'rate-limit')
    t.eq('honouring the provider\'s retry-after', run.failures[0].retryInMs, 7_000)
    t.eq('the second wait honours it too', run.failures[1].retryInMs, 7_000)
    t.eq('nothing ended the run', run.failure, null)
    t.ok('the implement step was recorded once', run.steps.filter((s) => s.stepId === 'implement').length === 1)
    t.ok('no participant was left pending', Object.values(run.participants).every((p) => !p.pendingInvocation))
    await releaseWorkspace(engine)
  }

  t.section('5. retries are bounded; the run fails with the classification on record')
  {
    const f = await engineFixture()
    const invoke = async (args) => {
      if (args.meta.stepId === 'implement') throw new ProcessError('claude exited 1', { kind: 'runtime-error', code: 1, stderr: '503 service unavailable', invocationId: args.meta.invocationId })
      return f.fake.invoke(args)
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    const before = f.clock.now()
    let thrown = null
    try { await engine.drive() } catch (error) { thrown = error }
    t.eq('the waits doubled: 30s, 60s, 120s', f.clock.now() - before, 210_000)
    t.ok('drive threw the runtime error, as before', thrown?.kind === 'runtime-error', thrown?.message)
    t.eq('three retries, then the fourth failure ended it', engine.run.failures.length, 4)
    t.eq('with the class on the run', engine.run.failure?.class, 'transient')
    t.eq('and the retry count', engine.run.failure?.retries, 3)
    await releaseWorkspace(engine)
  }

  t.section('5a. a refusal is recorded once and stops the run; the next move is a person\'s')
  {
    const f = await engineFixture()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-refusal-'))
    const availability = createAvailabilityStore(path.join(dir, 'availability.json'))
    let refusals = 0
    let refuse = true
    const invoke = async (args) => {
      if (args.meta.stepId === 'implement' && refuse) {
        refusals++
        throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: [CODEX_NOISE, REFUSED].join(NL), invocationId: args.meta.invocationId })
      }
      return f.fake.invoke(args)
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    engine.availability = availability
    let advised = 0
    engine.failureAdvisor = async () => { advised++; return { class: 'transient', record: {} } }
    const before = f.clock.now()
    let thrown = null
    try { await engine.drive() } catch (error) { thrown = error }
    t.ok('the run failed on it', thrown?.kind === 'runtime-error', thrown?.message)
    t.eq('the turn was invoked once', refusals, 1)
    t.eq('with no wait', f.clock.now(), before)
    t.eq('the advisory provider was not asked', advised, 0)
    t.eq('one attempt on run.failures, not retried', engine.run.failures.map((x) => `${x.class}:${x.retried}`), ['refusal:false'])
    t.eq('run.failures carries the provider\'s words', engine.run.failures[0].message, REFUSED)
    t.eq('run.failure carries the class', engine.run.failure?.class, 'refusal')
    t.eq('and the provider\'s words', engine.run.failure?.message, REFUSED)
    const model = engine.snapshot.participants.implementer.model.id
    t.eq('the model stays available', await availability.check(model), null)
    t.eq('the store holds nothing', await availability.all(), [])
    t.eq('the record carries no availability', engine.run.failure?.availability, null)
    t.eq('the seat keeps its model', engine.run.modelOverrides, undefined)

    // What the supervisor does with the error drive threw (failRecord).
    Object.assign(engine.run, { status: 'failed', blockedReason: thrown.message, outcome: 'unresolved', endedAt: f.clock.iso() })
    const told = explainRun(engine.run)
    t.ok('the explanation of the real record says refused', /provider refused the content/.test(told.headline), told.headline)
    t.eq('and quotes the provider', told.cause, REFUSED)
    t.ok('and offers Resume, which this record allows', /^Resume once/.test(told.next), told.next)

    refuse = false
    await engine.resumeExecution({})
    t.eq('Resume clears the failure', engine.run.failure, null)
    await engine.drive()
    t.ok('and sends the turn again: it is past the refusal', engine.run.steps.some((s) => s.stepId === 'implement'))
    t.eq('the refused attempt stays on record', engine.run.failures.map((x) => x.class), ['refusal'])
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('5a-bis. a refused writer turn that left edits: the refusal on record, the recovery decision still required')
  {
    const f = await engineFixture()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-refusal-'))
    const availability = createAvailabilityStore(path.join(dir, 'availability.json'))
    let refusals = 0
    let refuse = true
    const invoke = async (args) => {
      if (args.meta.stepId === 'implement' && refuse) {
        refusals++
        await fs.writeFile(path.join(args.cwd, 'partial.txt'), 'half done\n')
        throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: [CODEX_NOISE, REFUSED].join(NL), invocationId: args.meta.invocationId })
      }
      return f.fake.invoke(args)
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    engine.availability = availability
    let advised = 0
    engine.failureAdvisor = async () => { advised++; return { class: 'transient', record: {} } }
    const before = f.clock.now()
    await engine.drive()
    t.eq('the quarantine still ends it', `${engine.run.status}:${engine.run.blockedReason}:${engine.run.integrity.status}`, 'blocked:recovery-required:quarantined')
    t.eq('the turn was invoked once', refusals, 1)
    t.eq('with no wait', f.clock.now(), before)
    t.eq('the advisory provider was not asked', advised, 0)
    t.eq('one attempt on run.failures, not retried', engine.run.failures.map((x) => `${x.class}:${x.retried}:${x.quarantined}`), ['refusal:false:true'])
    t.eq('run.failures carries the provider\'s words', engine.run.failures[0].message, REFUSED)
    t.eq('run.failure carries the class', engine.run.failure?.class, 'refusal')
    t.eq('and the provider\'s words', engine.run.failure?.message, REFUSED)
    t.eq('the store holds nothing', await availability.all(), [])
    t.eq('the seat keeps its model', engine.run.modelOverrides, undefined)
    t.ok('the edits are preserved on disk', await fs.access(path.join(engine.run.workspace.path, 'partial.txt')).then(() => true, () => false))

    const told = explainRun(engine.run)
    t.ok('the explanation says refused', /provider refused the content of the implementer's turn/.test(told.headline), told.headline)
    t.ok('nothing says it crashed', !/crash/i.test(JSON.stringify(told)), JSON.stringify(told))
    t.eq('it quotes the provider', told.cause, REFUSED)
    t.ok('it requires the recovery decision', /keep the partial edits, restore them, or abandon/.test(told.next), told.next)
    t.ok('and says how Resume behaves', /Resume is refused until you record that decision/.test(told.next), told.next)
    t.ok('and how to change the seat', /different model for that seat/.test(told.next), told.next)
    t.ok('Resume really is refused', Boolean(resumeUnavailable(engine.run)))

    await engine.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: engine.run.integrity.latest.stateHash, reason: 'inspected', actor: 'operator' })
    t.eq('a disposition reopens the run', `${engine.run.status}:${engine.run.integrity.status}`, 'pending:clear')
    t.eq('without the failure it answered', engine.run.failure, null)
    refuse = false
    await engine.drive()
    t.ok('and the turn is sent again', engine.run.steps.some((s) => s.stepId === 'implement'))
    t.eq('the refused attempt stays on record', engine.run.failures.map((x) => x.class), ['refusal'])
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }
  {
    const f = await engineFixture()
    const invoke = async (args) => {
      if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
      await fs.writeFile(path.join(args.cwd, 'partial.txt'), 'half done\n')
      throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: 'something odd happened', invocationId: args.meta.invocationId })
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    await engine.drive()
    t.eq('another class leaves run.failure unset, as before', engine.run.failure ?? null, null)
    t.eq('and its record is the same class', engine.run.failures.map((x) => x.class), ['runtime'])
    t.eq('and the generic recovery words', explainRun(engine.run).headline, 'Stopped: a turn left source changes that need a recovery decision')
    await releaseWorkspace(engine)
  }

  t.section('5b. a turn that ran out of output is retried, told so; a writer keeps its edits')
  {
    const f = await engineFixture()
    const stream = JSON.stringify({ type: 'turn.failed', error: { message: 'Incomplete response returned, reason: max_output_tokens' } })
    const prompts = []
    let calls = 0
    const invoke = async (args) => {
      if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
      prompts.push(args.prompt)
      if (calls++ < 2) {
        await fs.writeFile(path.join(args.cwd, `partial-${calls}.txt`), 'half done\n')
        throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stdout: codexErrors(stream), invocationId: args.meta.invocationId })
      }
      return f.fake.invoke(args)
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    const before = f.clock.now()
    const run = await engine.drive()
    t.eq('the run completed', run.status, 'completed', run.blockedReason)
    t.eq('the policy\'s backoff: 30s, 60s', f.clock.now() - before, 90_000)
    t.eq('both attempts on record, retried', run.failures.map((x) => `${x.class}:${x.retried}`), ['output-limit:true', 'output-limit:true'])
    t.eq('with the writer\'s edits accepted for the retry', run.failures.map((x) => x.partialAccepted?.reason), ['output-limit', 'output-limit'])
    t.ok('the first attempt was not told anything', !/ran out of output/.test(prompts[0]))
    t.ok('the retry is told it ran out of output', /ran out of output/.test(prompts[1]) && /Answer sooner/.test(prompts[1]))
    t.ok('and the one after that', /ran out of output/.test(prompts[2]))
    await releaseWorkspace(engine)
  }

  t.section('5c. retries spent: the run fails naming the limit; a last attempt\'s edits stay quarantined, not vouched for')
  for (const writes of [false, true]) {
    const f = await engineFixture()
    let calls = 0
    const invoke = async (args) => {
      if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
      calls++
      if (writes) await fs.writeFile(path.join(args.cwd, `partial-${calls}.txt`), 'half done\n')
      throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stdout: 'Incomplete response returned, reason: max_output_tokens', invocationId: args.meta.invocationId })
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    const before = f.clock.now()
    let thrown = null
    try { await engine.drive() } catch (error) { thrown = error }
    const label = writes ? 'with edits' : 'without edits'
    t.eq(`${label}: the waits were the policy's`, f.clock.now() - before, 210_000)
    t.eq(`${label}: every attempt recorded, maxAttempts retried`, engine.run.failures.map((x) => x.retried), [true, true, true, false])
    t.ok(`${label}: all of the class`, engine.run.failures.every((x) => x.class === 'output-limit'))
    t.eq(`${label}: no more attempts than allowed`, calls, 4)
    if (writes) {
      t.ok('drive did not throw: the engine ended the run itself', thrown === null, thrown?.message)
      t.eq('the run failed, not blocked', engine.run.status, 'failed')
      t.eq('the class is on the run', engine.run.failure?.class, 'output-limit')
      t.eq('with the retry count', engine.run.failure?.retries, 3)
      t.ok('and an end time', Boolean(engine.run.endedAt))
      t.eq('the last attempt\'s edits stay quarantined', engine.run.integrity.status, 'quarantined')
      t.eq('its failure is on the record as quarantined', engine.run.failures.at(-1).quarantined, true)
      t.eq('those edits were not accepted', [engine.run.failures.at(-1).partialAccepted, engine.run.integrity.latest.partialAccepted], [undefined, undefined])
      t.eq('and they are exactly the last attempt\'s', engine.run.integrity.latest.changes.paths.map((c) => c.path), ['partial-4.txt'])
      t.eq('the earlier attempts\' were accepted for their retries', engine.run.failures.slice(0, 3).map((x) => x.partialAccepted?.reason), ['output-limit', 'output-limit', 'output-limit'])
      t.ok('the edits are preserved on disk', await fs.access(path.join(engine.run.workspace.path, 'partial-4.txt')).then(() => true, () => false))
      const said = explainRun(engine.run)
      t.ok('the headline names the limit', /output token limit/.test(said.headline), said.headline)
      t.ok('without a crash or a refusing provider', !/crashed|refusing/.test(`${said.headline} ${said.detail} ${said.next}`))
      t.ok('and says the edits need a decision', /not accepted/.test(said.next), said.next)
      await engine.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: engine.run.integrity.latest.stateHash, reason: 'inspected', actor: 'operator' })
      t.eq('a recorded disposition still reopens the run', `${engine.run.status}:${engine.run.integrity.status}`, 'pending:clear')
      t.eq('without the failure it answered', engine.run.failure, null)
    } else {
      t.ok('drive threw the runtime error', thrown?.kind === 'runtime-error', thrown?.message)
      t.eq('the class is on the run', engine.run.failure?.class, 'output-limit')
      t.eq('with the retry count', engine.run.failure?.retries, 3)
    }
    await releaseWorkspace(engine)
  }

  t.section('6. a quota failure is not retried and is remembered for every other start')
  {
    const f = await engineFixture()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-avail-'))
    const availability = createAvailabilityStore(path.join(dir, 'a.json'), { clock: f.clock })
    const invoke = async (args) => {
      if (args.meta.stepId === 'implement') throw new ProcessError('claude exited 1', { kind: 'runtime-error', code: 1, stderr: 'You have hit your weekly limit. Resets at 2026-09-12T00:00:00Z', invocationId: args.meta.invocationId })
      return f.fake.invoke(args)
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    engine.availability = availability
    let thrown = null
    try { await engine.drive() } catch (error) { thrown = error }
    t.ok('the run failed at once', thrown?.kind === 'runtime-error')
    t.eq('no retry', engine.run.failures.length, 1)
    t.eq('classified as quota', engine.run.failure?.class, 'quota')
    const model = engine.snapshot.participants.implementer.model.id
    const cooling = await availability.check(model)
    t.ok('the implementer model is recorded as exhausted', Boolean(cooling), JSON.stringify(cooling))
    t.eq('by this run', cooling?.runId, engine.runId)
    t.eq('with the provider\'s reset instant honoured', cooling?.assumed, false)
    t.ok('on the run record too', engine.run.failure?.availability?.modelId === model)
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('7. reported dollar spending never stops a healthy run')
  {
    const f = await engineFixture()
    const invoke = async (args) => {
      const r = await f.fake.invoke(args)
      return { ...r, usage: { tokens: 10, costUsd: 4 } }
    }
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: { fake: { ...f.fake, invoke } }, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
    })
    // The limit travels with the snapshot's budgets in a real run; set on the
    // run record here, which is exactly where budgetExceeded reads it.
    engine.run.budgets.limits = { ...engine.run.budgets.limits, maxCostUsd: 10 }
    const run = await engine.drive()
    t.eq('the run completes past the dollar allowance', run.status, 'completed')
    t.ok('spending remains recorded', run.budgets.used.costUsd > 10)
    await releaseWorkspace(engine)
  }

  t.section('8. a quota-exhausted seat continues with a new model and a fresh session')
  {
    const f = await engineFixture()
    const seen = []
    let failed = false
    const invoke = async args => {
      seen.push({ model: args.model, session: args.session, step: args.meta.stepId })
      if (args.meta.stepId === 'implement' && !failed) {
        failed = true
        throw new ProcessError('quota exhausted', { kind: 'runtime-error', code: 1, stderr: 'insufficient_quota', invocationId: args.meta.invocationId })
      }
      return f.fake.invoke(args)
    }
    const engine = await startRun({ ...f, deliveryProvider: f.delivery, harnesses: { fake: { ...f.fake, invoke } } })
    const original = engine.snapshot.participants.implementer.model.id
    engine.quotaFallback = createQuotaFallback({
      loadModels: async () => [{ id: 'replacement', model: 'replacement-wire', harness: 'fake', verification: { status: 'verified' }, efforts: ['high'], defaultEffort: 'high' }],
      availability: { check: async () => null }, probeFor: () => f.probe, root: f.configRoot
    })
    await engine.drive()
    t.eq('same run completes', engine.run.status, 'completed')
    t.eq('original snapshot remains immutable', engine.snapshot.participants.implementer.model.id, original)
    t.eq('substitution recorded', engine.run.modelSubstitutions[0].to, 'replacement')
    t.eq('replacement has a fresh native session', seen.find(x => x.model === 'replacement-wire').session, null)
    t.eq('failed step completed once', engine.run.steps.filter(s => s.stepId === 'implement').length, 1)
    t.eq('quota evidence retained', engine.run.failures[0].class, 'quota')
    t.eq('override persists across load', JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'))).modelOverrides.implementer.model.id, 'replacement')
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
  void NL
}
