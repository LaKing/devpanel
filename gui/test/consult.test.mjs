import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CONFIG_ROOT } from './helpers.mjs'
import { createConsult, consultId } from '../server/consult/consult.mjs'
import { loadPanel, resolveSeats } from '../server/consult/panel.mjs'
import { judge, nextOptions, optionsFor, briefFor, answerText } from '../server/consult/rule.mjs'
import { decidePrompt } from '../server/consult/prompt.mjs'
import { consultRoots } from '../server/consult/roots.mjs'

export const name = 'consult panel — two read-only seats answer before a person is asked'

const brief = { question: 'May the list grow?', why: 'The check starts failing otherwise.', options: [{ label: 'Yes', consequence: 'Old cases are listed.' }, { label: 'No', consequence: 'They are fixed now.' }], recommendation: 'Yes, as before.' }
const opinion = (over = {}) => ({ verdict: 'answer', choice: 'recommended', answer: 'Do as recommended.', conditions: [], reasoning: 'Read it.', evidence: [{ location: 'a.mjs:1', observation: 'it says so' }], confidence: 'high', ownerBrief: brief, ...over })
const owner = (over = {}) => ({ verdict: 'owner', ownerReason: 'agreed-rule-change', reasoning: 'It changes a written rule.', confidence: 'high', ownerBrief: brief, ...over })
const reply = (o) => 'My reading.\n```json\n' + JSON.stringify(o) + '\n```'

const roster = new Map([
  ['fable-5-2', { id: 'fable-5-2', harness: 'fake-a', model: 'claude-fable-5-2', efforts: ['medium', 'high'], defaultEffort: 'medium', verification: { status: 'verified' } }],
  ['gpt-6-astra', { id: 'gpt-6-astra', harness: 'fake-b', model: 'gpt-6-astra', efforts: ['medium'], verification: { status: 'verified' } }]
])
const panel = { enabled: true, seats: { 'consultant-1': { model: 'fable-5-2', effort: 'medium' }, 'consultant-2': { model: 'gpt-6-astra', effort: 'medium' } }, maxRounds: 2, turnTimeoutMinutes: 1, maxTurnCostUsd: 5, maxPerRun: 6, maxTechnicalPerRun: 3, alwaysHuman: ['authorization'], readOnly: [], deny: [], hash: 'sha256:test' }

/** A panel whose seats answer from scripts: `script[harness]` is a list of replies (or functions of the call), one per invocation. */
function fakePanel (script, { calls = [], access = 'read', ...over } = {}) {
  const at = {}
  return createConsult({
    root: CONFIG_ROOT,
    loadPanelConfig: async () => panel,
    loadRoster: async () => roster,
    rootsFor: async ({ project }) => ({ cwd: os.tmpdir(), roots: [{ path: os.tmpdir(), what: `checkout of ${project}` }], masks: [] }),
    buildFence: ({ roots, scratchDir }) => ({ cwd: roots.cwd, writable: [scratchDir], readOnly: [], entries: [], masks: [] }),
    language: () => 'hu',
    loadAdapter: async (harness) => ({
      invoke: async (args) => {
        calls.push({ harness, ...args })
        const next = script[harness][at[harness] = (at[harness] ?? -1) + 1]
        if (next === undefined) throw new Error(`no scripted reply ${at[harness]} for ${harness}`)
        const value = typeof next === 'function' ? await next(args) : next
        if (value instanceof Error) throw value
        return { outcome: 'completed', response: typeof value === 'string' ? value : reply(value), session: { id: `${harness}-session` }, usage: { costUsd: 0.5 }, diagnostics: { access } }
      }
    }),
    ...over
  })
}

const request = (over = {}) => ({ key: 'owner-hold:planner:H1', question: 'May the checker open a second frozen list?', reason: 'A rule says the list never grows.', recommendation: 'Open a separate shrink-only list.', options: [{ key: 'b', label: 'Fix the 16 now.' }], category: 'documented-promise', askedBy: { role: 'planner' }, project: 'demo-project', ...over })

export default async function (t) {
  const dirs = []
  const callerDir = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'consult-test-')); dirs.push(d); return d }

  t.section('the rule is mechanical')
  const options = optionsFor(request())
  t.eq('the recommendation is the first option, the asker\'s own follow', options.map((o) => o.key), ['recommended', 'b'])
  const two = (a, b) => [{ seat: 'consultant-1', opinion: a }, { seat: 'consultant-2', opinion: b }]
  t.eq('the same option with confidence resolves', judge(options, two(opinion({ conditions: ['keep the old list'] }), opinion({ conditions: ['keep the old list', 'date the census'] }))),
    { outcome: 'resolved', choice: 'recommended', answer: 'Open a separate shrink-only list.', conditions: ['keep the old list', 'date the census'] })
  t.eq('agreement on another option resolves to that option', judge(options, two(opinion({ choice: 'b' }), opinion({ choice: 'b' }))).answer, 'Fix the 16 now.')
  t.eq('one low confidence is not agreement', judge(options, two(opinion(), opinion({ confidence: 'low' }))).outcome, 'undecided')
  t.eq('different options are not agreement', judge(options, two(opinion(), opinion({ choice: 'b' }))).outcome, 'undecided')
  t.eq('two answers of their own are not agreement', judge(options, two(opinion({ choice: 'other' }), opinion({ choice: 'other' }))).outcome, 'undecided')
  t.eq('one seat leaving it to a person escalates', judge(options, two(opinion(), owner())).outcome, 'escalated')
  t.eq('a seat without an opinion makes it unavailable', judge(options, two(opinion(), null)).outcome, 'unavailable')
  const grown = nextOptions(options, two(opinion({ choice: 'other', answer: 'List 16, annotate 56.', conditions: ['annotate in this run'] }), opinion()))
  t.eq('an answer of its own becomes a named option of the next round', grown.at(-1), { key: 'alt-1', label: 'List 16, annotate 56.', conditions: ['annotate in this run'] })
  t.eq('adopting it resolves, with its conditions', judge(grown, two(opinion({ choice: 'alt-1' }), opinion({ choice: 'alt-1' }))),
    { outcome: 'resolved', choice: 'alt-1', answer: 'List 16, annotate 56.', conditions: ['annotate in this run'] })
  t.ok('the answer text lists the conditions', answerText({ answer: 'Yes.', conditions: ['a', 'b'] }).includes('- a\n- b'))
  const b = briefFor(two(opinion(), opinion({ choice: 'b' })), 'the seats chose differently')
  t.eq('an escalation carries the first seat\'s brief and both positions', [b.question, b.positions.map((p) => p.choice), b.undecidedBecause], ['May the list grow?', ['recommended', 'b'], 'the seats chose differently'])

  t.section('the shipped panel resolves')
  const shipped = await loadPanel({ root: CONFIG_ROOT })
  t.eq('two seats, the owner\'s defaults', [shipped.seats['consultant-1'], shipped.seats['consultant-2']], [{ model: 'fable-5-2', effort: 'medium' }, { model: 'gpt-6.2-astra', effort: 'medium' }])
  const seats = await resolveSeats(panel, { roster })
  t.eq('both seats resolve against the roster', [seats.seats.map((s) => s.model.id), seats.problems], [['fable-5-2', 'gpt-6-astra'], []])
  const unverified = new Map([...roster, ['gpt-6-astra', { ...roster.get('gpt-6-astra'), verification: { status: 'unverified' } }]])
  t.ok('an unverified seat is a problem, not an exception', /not verified/.test((await resolveSeats(panel, { roster: unverified })).problems[0]))
  const held = await resolveSeats(panel, { roster, availability: { check: async (id) => (id === 'fable-5-2' ? { exhaustedUntil: '2030-01-01T00:00:00Z', reason: 'quota' } : null) } })
  t.ok('a held model is a problem naming when it is back', /unavailable until 2030/.test(held.problems[0]))
  const gemini = new Map([...roster, ['fable-5-2', { ...roster.get('fable-5-2'), harness: 'gemini' }]])
  t.ok('a gemini seat is refused', /gemini/.test((await resolveSeats(panel, { roster: gemini })).problems[0]))

  t.section('the seat prompt')
  const prompt = decidePrompt({ request: request(), options, roots: [{ path: '/opt/demo', what: 'the live checkout' }], scratchDir: '/tmp/x', language: 'hu' })
  t.ok('it names the question, the options and what can be read', prompt.includes('second frozen list') && prompt.includes('`recommended`') && prompt.includes('/opt/demo'))
  t.ok('the brief is asked for in the operator\'s language', prompt.includes('Write it in Hungarian'))
  t.ok('it does not show another opinion', !prompt.includes('other consultant answered'))

  t.section('agreement in the first round')
  let calls = []
  let dir = await callerDir()
  let service = fakePanel({ 'fake-a': [opinion({ conditions: ['keep the old list'] })], 'fake-b': [opinion()] }, { calls })
  let result = await service.consult(request(), { callerDir: dir })
  t.eq('resolved with the recommended answer', [result.outcome, result.choice, result.answer, result.rounds], ['resolved', 'recommended', 'Open a separate shrink-only list.', 1])
  t.ok('the answer text carries the conditions', result.answerText.includes('keep the old list'))
  t.eq('one turn per seat', calls.length, 2)
  t.ok('each seat ran as a read seat inside a fence', calls.every((c) => c.readOnlyTools === true && c.supervisorOnly === true && c.fence && c.tooling.writesCode === false))
  t.eq('cost is the sum of the turns', result.costUsd, 1)
  const id = consultId(request())
  const recorded = JSON.parse(await fs.readFile(path.join(dir, 'consults', id, 'result.json'), 'utf8'))
  t.eq('the result is on disk before it is returned', [recorded.outcome, recorded.opinions.length], ['resolved', 2])
  t.ok('prompts, responses and turns are recorded', (await fs.readdir(path.join(dir, 'consults', id, 'round-1'))).sort().join(',').includes('consultant-1.prompt.md,consultant-1.response.md,consultant-1.turn.json'))
  const again = await service.consult(request(), { callerDir: dir })
  t.eq('the same question is read from the record, with no seat turn', [again.replayed, again.outcome, calls.length], [true, 'resolved', 2])
  t.eq('recorded() reads it too', (await service.recorded(request(), { callerDir: dir })).outcome, 'resolved')

  t.section('disagreement, then a second round')
  calls = []
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion(), opinion({ choice: 'alt-1' })], 'fake-b': [opinion({ choice: 'other', answer: 'List the 16 only.' }), opinion({ choice: 'alt-1' })] }, { calls })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('the other seat adopts the alternative', [result.outcome, result.choice, result.answer, result.rounds], ['resolved', 'alt-1', 'List the 16 only.', 2])
  t.ok('round two resumes each seat\'s own session and shows the other\'s opinion', calls[2].session?.id && calls.slice(2).every((c) => c.prompt.includes('The other consultant answered')))
  t.ok('the first seat is shown the second\'s answer, not its own', calls.slice(2).find((c) => c.harness === 'fake-a').prompt.includes('List the 16 only.'))

  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion(), opinion()], 'fake-b': [opinion({ choice: 'b' }), opinion({ choice: 'b' })] })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('no convergence escalates with a brief naming both positions', [result.outcome, result.brief.positions.map((p) => p.choice), result.rounds], ['escalated', ['recommended', 'b'], 2])

  t.section('a person\'s decision')
  calls = []
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [owner()], 'fake-b': [opinion()] }, { calls })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('one "owner" escalates without a second round', [result.outcome, calls.length, result.brief.question], ['escalated', 2, 'May the list grow?'])
  calls = []
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [owner()], 'fake-b': [] }, { calls })
  result = await service.consult(request({ mode: 'brief' }), { callerDir: dir })
  t.eq('mode brief asks the first seat only and returns the brief', [result.outcome, calls.length, calls[0].harness, result.brief.recommendation], ['escalated', 1, 'fake-a', 'Yes, as before.'])
  t.ok('brief and decide of one question are separate consults', consultId(request({ mode: 'brief' })) !== consultId(request()))

  t.section('a reply that breaks the contract')
  calls = []
  dir = await callerDir()
  service = fakePanel({ 'fake-a': ['I think yes.', opinion()], 'fake-b': [opinion()] }, { calls })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('one repair turn, then resolved', [result.outcome, calls.length], ['resolved', 3])
  t.ok('the repair says what was wrong', calls.find((c) => c.prompt.startsWith('Your reply could not be used')).prompt.includes('verdict'))
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion({ evidence: [] }), opinion({ evidence: [] })], 'fake-b': [opinion()] })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('an answer without evidence is not an opinion', [result.outcome, /consultant-1/.test(result.reason)], ['unavailable', true])
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion({ choice: 'z' }), opinion({ choice: 'z' })], 'fake-b': [opinion()] })
  t.eq('a choice that is no option is refused', (await service.consult(request(), { callerDir: dir })).outcome, 'unavailable')

  t.section('what makes it unavailable')
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [new Error('connection reset')] })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('a failed seat', [result.outcome, /consultant-2/.test(result.reason)], ['unavailable', true])
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [opinion()] }, { access: 'none (fence not proved)' })
  t.eq('a seat that could not read', (await service.consult(request(), { callerDir: dir })).outcome, 'unavailable')
  dir = await callerDir()
  calls = []
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [opinion()] }, { calls, buildFence: () => null })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('a host without the fence, and nothing is invoked', [result.outcome, calls.length], ['unavailable', 0])
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [opinion()] }, { loadPanelConfig: async () => ({ ...panel, enabled: false }) })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('a panel switched off is not recorded, so enabling it asks', [result.outcome, await service.recorded(request(), { callerDir: dir })], ['unavailable', null])

  t.section('the spending ledger')
  const lines = []
  const ledger = { reserve: async (l) => lines.push({ kind: 'reserve', ...l }), settle: async (l) => lines.push({ kind: 'settle', ...l }), release: async (l) => lines.push({ kind: 'release', ...l }) }
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [opinion()] }, { spending: () => ({ ledger, admit: () => ({ ok: true }) }) })
  await service.consult(request(), { callerDir: dir })
  t.eq('each seat turn is reserved and settled at its cost', [lines.filter((l) => l.kind === 'reserve').map((l) => [l.subject, l.maxCostUsd, l.meta.purpose]), lines.filter((l) => l.kind === 'settle').map((l) => l.costUsd)],
    [[['decision', 5, 'consult'], ['decision', 5, 'consult']], [0.5, 0.5]])
  dir = await callerDir()
  calls = []
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [opinion()] }, { calls, spending: () => ({ ledger, admit: () => ({ ok: false, detail: 'daily window exhausted' }) }) })
  result = await service.consult(request(), { callerDir: dir })
  t.eq('a refused reservation is unavailable, with nothing invoked', [result.outcome, calls.length, /daily window/.test(result.reason)], ['unavailable', 0, true])

  t.section('an interrupted consult resumes from its record')
  calls = []
  dir = await callerDir()
  const abort = new AbortController()
  service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [async () => { abort.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e }, opinion()] }, { calls })
  let threw = null
  try { await service.consult(request(), { callerDir: dir, signal: abort.signal }) } catch (error) { threw = error }
  t.eq('a cancelled consult throws and records no result', [threw?.name, await service.recorded(request(), { callerDir: dir })], ['AbortError', null])
  result = await service.consult(request(), { callerDir: dir })
  t.eq('asked again, only the missing turn runs', [result.outcome, calls.filter((c) => c.harness === 'fake-a').length, calls.filter((c) => c.harness === 'fake-b').length], ['resolved', 1, 2])

  t.section('two callers with one question share one consult')
  calls = []
  dir = await callerDir()
  service = fakePanel({ 'fake-a': [async () => { await new Promise((r) => setTimeout(r, 30)); return opinion() }], 'fake-b': [opinion()] }, { calls })
  const both = await Promise.all([service.consult(request(), { callerDir: dir }), service.consult(request(), { callerDir: dir })])
  t.eq('one turn per seat, the second caller reads the record', [calls.length, both.map((r) => r.outcome), both.map((r) => r.replayed).sort()], [2, ['resolved', 'resolved'], [false, true]])

  t.section('admission sees the other seat\'s reservation')
  {
    let reserved = 0
    const order = []
    const gate = { ledger: { reserve: async () => { await new Promise((r) => setTimeout(r, 10)); reserved += 5; order.push('reserve') }, settle: async () => {}, release: async () => {} },
      admit: () => { order.push('admit'); return reserved + 5 <= 5 ? { ok: true } : { ok: false, detail: 'only 5 dollars left' } } }
    calls = []
    dir = await callerDir()
    service = fakePanel({ 'fake-a': [opinion()], 'fake-b': [opinion()] }, { calls, spending: () => gate })
    result = await service.consult(request(), { callerDir: dir })
    t.eq('with money for one turn, one seat runs and the other is refused', [order, calls.length, result.outcome], [['admit', 'reserve', 'admit'], 1, 'unavailable'])
  }
  {
    const lines = []
    const ledger = { reserve: async (l) => lines.push({ kind: 'reserve', id: l.id }), settle: async (l) => lines.push({ kind: 'settle', costUsd: l.costUsd }), release: async (l) => lines.push({ kind: 'release' }) }
    const failed = Object.assign(new Error('provider error'), { usage: { costUsd: 0.25 } })
    const unstarted = Object.assign(new Error('no such binary'), { started: false })
    dir = await callerDir()
    service = fakePanel({ 'fake-a': [failed], 'fake-b': [unstarted] }, { spending: () => ({ ledger, admit: () => ({ ok: true }) }) })
    await service.consult(request(), { callerDir: dir })
    t.eq('a failed turn that states its cost is settled at it, one that never started is released', lines.filter((l) => l.kind !== 'reserve').map((l) => l.kind === 'settle' ? l.costUsd : l.kind).sort(), [0.25, 'release'])
  }

  t.section('what a seat may read')
  {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'consult-roots-')))
    dirs.push(base)
    const projects = path.join(base, 'srv')
    const home = path.join(base, 'home')
    for (const d of ['srv/demo-project/logs', 'srv/fw/core', 'srv/related-project', 'srv/production.demo/data', 'home/.ssh', 'outside/secret', 'outside/logs', 'srv/demo-project/private']) await fs.mkdir(path.join(base, d), { recursive: true })
    const link = (name, target) => fs.symlink(target, path.join(projects, 'demo-project', name))
    await link('@core', path.join(projects, 'fw'))
    await link('keys', path.join(home, '.ssh'))
    await link('everything', projects)
    await link('stage', path.join(projects, 'production.demo'))
    await link('elsewhere', path.join(base, 'outside', 'secret'))
    await link('denied', path.join(base, 'outside', 'logs'))
    await fs.writeFile(path.join(base, 'outside', 'demo-project.yaml'), 'id: demo-project\n')
    const got = await consultRoots({ project: 'demo-project', related: ['related-project', 'missing-project'], projectsDir: projects, home, files: [{ path: path.join(base, 'outside', 'demo-project.yaml'), what: 'its configuration' }],
      panel: { readOnly: [path.join(base, 'outside', 'logs'), home], deny: [path.join(projects, 'demo-project', 'private'), path.join(base, 'outside', 'logs')] } })
    const granted = got.roots.map((r) => path.relative(base, r.path)).sort()
    t.eq('the checkout, its related project, a link to a directory under the projects root, and its configuration file', granted, ['outside/demo-project.yaml', 'srv/demo-project', 'srv/fw', 'srv/related-project'])
    const why = Object.fromEntries(got.refused.map((r) => [path.relative(base, r.path), r.why]))
    t.ok('a link into the home\'s keys is refused', /login or key directory/.test(why['home/.ssh']))
    t.ok('a link to the whole projects root is refused', /projects root/.test(why.srv))
    t.ok('a link to a container filesystem is refused', /no seat reads/.test(why['srv/production.demo']))
    t.ok('a link out of the projects root is not followed', /under the projects root/.test(why['outside/secret']))
    t.ok('the home is never granted, even by the installation\'s list', /home directory/.test(why.home))
    t.ok('a root that is itself denied is refused, not granted unmasked', /never readable/.test(why['outside/logs']))
    t.eq('a denied path inside a root is masked', got.masks.map((m) => path.relative(base, m)), ['srv/demo-project/private'])
  }

  t.section('the operator\'s CLI configuration (config-guard.mjs): an interrupted seat is checked by id before it is asked again')
  {
    const dir = await callerDir()
    const req = request({ key: 'cfg-guard:repair' })
    const round = path.join(dir, 'consults', consultId(req), 'round-1')
    await fs.mkdir(round, { recursive: true })
    // The panel died during consultant-1's repair call: both of its ids were persisted before their calls.
    await fs.writeFile(path.join(round, 'consultant-1.pending.json'), JSON.stringify({ initial: 'I-1', repair: 'R-1' }))
    const asked = []
    const recovered = []
    const resolved = []
    const integrity = { kind: 'cli-config', invocationId: 'R-1', violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantined', quarantinedTo: '/h/.codex/q/hooks.json.abc' }] }
    const service = fakePanel({}, {
      loadAdapter: async (harness) => ({
        invoke: async (args) => { asked.push(harness); return { outcome: 'completed', response: reply(opinion()), session: { id: 's' }, usage: { costUsd: 0 }, diagnostics: { access: 'read' } } },
        recoverPending: async ({ invocationId }) => { recovered.push(invocationId); return invocationId === 'R-1' ? { invocationId, integrity } : null },
        resolveConfig: async (id) => { resolved.push(id) }
      })
    })
    await service.consult(req, { callerDir: dir })
    const turn = JSON.parse(await fs.readFile(path.join(round, 'consultant-1.turn.json'), 'utf8'))
    t.eq('both of the seat\'s own ids were checked, and only those', recovered.slice(0, 2), ['I-1', 'R-1'])
    t.eq('the interrupted seat was not asked again', asked.filter((h) => h === 'fake-a').length, 0)
    t.eq('its turn records the violation of the repair call', [turn.error?.class, turn.error?.integrity?.invocationId], ['environment', 'R-1'])
    t.eq('the adapter is acknowledged once the turn is recorded', resolved, ['R-1'])

    // The round's directory chain is durable before either seat writes or is asked.
    const fresh = await callerDir()
    const original = fs.open
    const events = []
    fs.open = async (p, ...rest) => {
      const handle = await original(p, ...rest)
      events.push(['open', String(p)])
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { events.push(['sync', String(p)]); return sync() }
      return handle
    }
    let barrier
    try {
      const watched = fakePanel({ 'fake-a': [(a) => { events.push(['invoke', 'fake-a']); return opinion() }], 'fake-b': [(a) => { events.push(['invoke', 'fake-b']); return opinion() }] })
      await watched.consult(request({ key: 'cfg-guard:barrier' }), { callerDir: fresh })
      const roundDir = path.join(fresh, 'consults', consultId(request({ key: 'cfg-guard:barrier' })), 'round-1')
      const lastBarrierSync = events.findLastIndex((e, i) => e[0] === 'sync' && e[1] === roundDir && events.slice(0, i).every((x) => !(x[0] === 'open' && x[1].startsWith(path.join(roundDir, 'consultant-')))))
      const firstSeatWrite = events.findIndex((e) => e[0] === 'open' && e[1].startsWith(path.join(roundDir, 'consultant-')))
      const firstInvoke = events.findIndex((e) => e[0] === 'invoke')
      barrier = { lastBarrierSync, firstSeatWrite, firstInvoke, parentSynced: events.slice(0, firstSeatWrite).some((e) => e[0] === 'sync' && e[1] === path.dirname(roundDir)) }
    } finally { fs.open = original }
    t.ok('round-1/ and its parent are synced before either seat\'s first write or call', barrier.lastBarrierSync >= 0 && barrier.parentSynced && barrier.lastBarrierSync < barrier.firstSeatWrite && barrier.lastBarrierSync < barrier.firstInvoke, JSON.stringify(barrier))

    // The brief path (a single seat) passes the same barrier.
    const briefDir = await callerDir()
    const briefEvents = []
    fs.open = async (p, ...rest) => {
      const handle = await original(p, ...rest)
      briefEvents.push(['open', String(p)])
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { briefEvents.push(['sync', String(p)]); return sync() }
      return handle
    }
    let briefBarrier
    try {
      const briefReq = request({ key: 'cfg-guard:brief', mode: 'brief' })
      await fakePanel({ 'fake-a': [() => { briefEvents.push(['invoke', 'fake-a']); return opinion() }] }).consult(briefReq, { callerDir: briefDir })
      const roundDir = path.join(briefDir, 'consults', consultId(briefReq), 'round-1')
      const firstSeatWrite = briefEvents.findIndex((e) => e[0] === 'open' && e[1].startsWith(path.join(roundDir, 'consultant-')))
      const firstInvoke = briefEvents.findIndex((e) => e[0] === 'invoke')
      const roundSync = briefEvents.findIndex((e) => e[0] === 'sync' && e[1] === roundDir)
      briefBarrier = { roundSync, firstSeatWrite, firstInvoke, parentSynced: briefEvents.slice(0, firstSeatWrite).some((e) => e[0] === 'sync' && e[1] === path.dirname(roundDir)) }
    } finally { fs.open = original }
    t.ok('the brief seat waits for the same barrier', briefBarrier.roundSync >= 0 && briefBarrier.parentSynced && briefBarrier.roundSync < briefBarrier.firstSeatWrite && briefBarrier.roundSync < briefBarrier.firstInvoke, JSON.stringify(briefBarrier))

    // A recorded seat turn whose violation the adapter could not yet acknowledge is returned to on replay.
    const unackDir = await callerDir()
    let acknowledge = false
    const unackIds = []
    const unackRecovered = []
    const unackAdapter = {
      invoke: async (args) => { unackIds.push(args.meta.invocationId); throw Object.assign(new Error('integrity violation: …'), { kind: 'environment-error', integrity: { kind: 'cli-config', invocationId: args.meta.invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantine-unsynced' }] } }) },
      recoverPending: async ({ invocationId }) => { unackRecovered.push(invocationId); return null },
      resolveConfig: async () => acknowledge
    }
    const unackService = fakePanel({}, { loadAdapter: async (harness) => (harness === 'fake-a' ? unackAdapter : { invoke: async () => ({ outcome: 'completed', response: reply(opinion()), session: { id: 's' }, usage: { costUsd: 0 }, diagnostics: { access: 'read' } }) }) })
    const unackReq = request({ key: 'cfg-guard:unacknowledged' })
    const unackFirst = await unackService.consult(unackReq, { callerDir: unackDir })
    const unackResult = path.join(unackDir, 'consults', consultId(unackReq), 'result.json')
    t.eq('the seat\'s violation was recorded and not acknowledged: the consult stays open (audit 085)', [unackIds.length, unackFirst.pendingRecovery, await fs.readFile(unackResult, 'utf8').then(() => 'written', () => 'absent')], [1, true, 'absent'])
    const stillUnack = await unackService.consult(unackReq, { callerDir: unackDir })
    t.eq('asked again while resolveConfig still says false: still pending, still uncached', [stillUnack.pendingRecovery, await fs.readFile(unackResult, 'utf8').then(() => 'written', () => 'absent')], [true, 'absent'])
    acknowledge = true
    const replayed = await unackService.consult(unackReq, { callerDir: unackDir })
    t.eq('once acknowledged, the consult returns to the adapter for that invocation, settles and is recorded', [replayed.pendingRecovery ?? false, unackRecovered.includes(unackIds[0]), await fs.readFile(unackResult, 'utf8').then(() => 'written', () => 'absent'), unackIds.length], [false, true, 'written', 1])

    // The engine reads a recorded consult through recorded() (engine.mjs consultFirst): that path settles too,
    // and a replayed verdict that found more is saved on the turn before the adapter is acknowledged.
    const engineDir = await callerDir()
    let ack = false
    const seen = []
    const engineIds = []
    const engineAdapter = {
      invoke: async (args) => { engineIds.push(args.meta.invocationId); throw Object.assign(new Error('integrity violation: …'), { kind: 'environment-error', integrity: { kind: 'cli-config', invocationId: args.meta.invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantine-unsynced' }] } }) },
      recoverPending: async ({ invocationId }) => ({ invocationId, integrity: { kind: 'cli-config', invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantined' }, { path: '/h/.codex/.env', change: 'created', status: 'quarantined' }] } }),
      resolveConfig: async (id) => { seen.push(id); return ack }
    }
    const engineService = fakePanel({}, { loadAdapter: async (harness) => (harness === 'fake-a' ? engineAdapter : { invoke: async () => ({ outcome: 'completed', response: reply(opinion()), session: { id: 's' }, usage: { costUsd: 0 }, diagnostics: { access: 'read' } }) }) })
    const engineReq = request({ key: 'cfg-guard:engine-recorded' })
    await engineService.consult(engineReq, { callerDir: engineDir })
    const turnFile = path.join(engineDir, 'consults', consultId(engineReq), 'round-1', 'consultant-1.turn.json')
    ack = true
    seen.length = 0
    engineAdapter.resolveConfig = async (id) => { seen.push({ id, recorded: JSON.parse(await fs.readFile(turnFile, 'utf8')).error.integrity.violations.length }); return true }
    t.eq('recorded() has nothing for an unsettled consult, so the engine consults again', await engineService.recorded(engineReq, { callerDir: engineDir }), null)
    const viaConsult = await engineService.consult(engineReq, { callerDir: engineDir })
    t.ok('that consult returns to the adapter for the unacknowledged seat turn and settles', !viaConsult.pendingRecovery && seen.some((s) => s.id === engineIds[0]), JSON.stringify(seen))
    t.eq('the replayed verdict (two paths) is on the turn before it is acknowledged', seen.find((s) => s.id === engineIds[0])?.recorded, 2)
    t.ok('recorded() now returns the result', Boolean(await engineService.recorded(engineReq, { callerDir: engineDir })))

    // Audit 088, acknowledgment contract: a seat settles only when resolveConfig returns exactly true.
    const violating = (resolved) => ({
      invoke: async (args) => { throw Object.assign(new Error('integrity violation: …'), { kind: 'environment-error', integrity: { kind: 'cli-config', invocationId: args.meta.invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantined' }] } }) },
      recoverPending: async () => null,
      resolveConfig: async () => resolved
    })
    const other = { invoke: async () => ({ outcome: 'completed', response: reply(opinion()), session: { id: 's' }, usage: { costUsd: 0 }, diagnostics: { access: 'read' } }) }
    for (const [label, value] of [['undefined', undefined], ['null', null], ['false', false], ['true', true]]) {
      const d = await callerDir()
      const r = request({ key: `cfg-guard:ack-${label}` })
      const out = await fakePanel({}, { loadAdapter: async (harness) => (harness === 'fake-a' ? violating(value) : other) }).consult(r, { callerDir: d })
      const c = path.join(d, 'consults', consultId(r))
      const settled = await fs.readFile(path.join(c, 'round-1', 'consultant-1.settled.json'), 'utf8').then(() => true, () => false)
      const cached = await fs.readFile(path.join(c, 'result.json'), 'utf8').then(() => true, () => false)
      t.eq(`resolveConfig returning ${label}: ${value === true ? 'settled and recorded' : 'not settled, pending, nothing cached'}`, [Boolean(out.pendingRecovery), settled, cached], value === true ? [false, true, true] : [true, false, false])
    }

    // Audit 088, scan errors: a round that cannot be read counts as pending, never as none.
    const eioDir = await callerDir()
    const eioReq = request({ key: 'cfg-guard:scan-eio' })
    const eioRound = path.join(eioDir, 'consults', consultId(eioReq), 'round-1')
    await fs.mkdir(eioRound, { recursive: true })
    await fs.writeFile(path.join(eioRound, 'consultant-1.pending.json'), JSON.stringify({ harness: 'fake-old', initial: 'EIO-1' }))
    const readdir = fs.readdir
    fs.readdir = async (p, ...rest) => { if (p === eioRound) throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' }); return readdir.call(fs, p, ...rest) }
    let eioOut, eioOpen
    try {
      const svc = fakePanel({}, { loadRoster: async () => new Map() })
      eioOut = await svc.consult(eioReq, { callerDir: eioDir })
      eioOpen = await svc.unsettled(eioReq, { callerDir: eioDir })
    } finally { fs.readdir = readdir }
    t.eq('an injected EIO reading a round: the early return is pendingRecovery and unsettled() names the round', [eioOut.pendingRecovery, eioOpen.length > 0 && /round-1.*EIO/.test(eioOpen[0])], [true, true])
    t.eq('…and no result.json is written', await fs.readFile(path.join(eioDir, 'consults', consultId(eioReq), 'result.json'), 'utf8').then(() => 'written', () => 'absent'), 'absent')

    // Audit 088, stale integrity: after a successful sync retry, turn.json, the result and the cache agree.
    const staleDir = await callerDir()
    const staleReq = request({ key: 'cfg-guard:stale' })
    let staleAck = false
    const staleAdapter = {
      invoke: async (args) => { throw Object.assign(new Error('integrity violation: …'), { kind: 'environment-error', integrity: { kind: 'cli-config', invocationId: args.meta.invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantine-unsynced' }] } }) },
      recoverPending: async ({ invocationId }) => ({ invocationId, integrity: { kind: 'cli-config', invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantined', quarantinedTo: '/h/.codex/q/hooks.json.x' }] } }),
      resolveConfig: async () => staleAck
    }
    const staleSvc = fakePanel({}, { loadAdapter: async (harness) => (harness === 'fake-a' ? staleAdapter : other) })
    t.eq('the unsynced verdict leaves the consult pending', (await staleSvc.consult(staleReq, { callerDir: staleDir })).pendingRecovery, true)
    staleAck = true
    const staleFresh = await staleSvc.consult(staleReq, { callerDir: staleDir })
    const staleTurn = JSON.parse(await fs.readFile(path.join(staleDir, 'consults', consultId(staleReq), 'round-1', 'consultant-1.turn.json'), 'utf8'))
    const staleCache = JSON.parse(await fs.readFile(path.join(staleDir, 'consults', consultId(staleReq), 'result.json'), 'utf8'))
    const statusOf = (opinions) => opinions.find((o) => o.seat === 'consultant-1')?.error?.integrity?.violations?.[0]?.status
    t.eq('after the sync retry: turn.json, the returned result and the cached result all say quarantined', [staleTurn.error.integrity.violations[0].status, statusOf(staleFresh.opinions), statusOf(staleCache.opinions)], ['quarantined', 'quarantined', 'quarantined'])

    // A replay that throws (the verdict could not be persisted) settles nothing: pending, uncached.
    const throwDir = await callerDir()
    const throwReq = request({ key: 'cfg-guard:replay-throws' })
    const throwRound = path.join(throwDir, 'consults', consultId(throwReq), 'round-1')
    await fs.mkdir(throwRound, { recursive: true })
    await fs.writeFile(path.join(throwRound, 'consultant-1.pending.json'), JSON.stringify({ harness: 'fake-a', initial: 'THROW-1' }))
    const throwing = { invoke: async () => { throw new Error('not asked') }, recoverPending: async () => { throw new Error('config-checked could not be persisted') }, resolveConfig: async () => true }
    const thrown = await fakePanel({}, { loadAdapter: async (harness) => (harness === 'fake-a' ? throwing : { invoke: async () => ({ outcome: 'completed', response: reply(opinion()), session: { id: 's' }, usage: { costUsd: 0 }, diagnostics: { access: 'read' } }) }) }).consult(throwReq, { callerDir: throwDir })
    t.eq('a replay that throws leaves the seat pending: pendingRecovery, no turn, no result', [thrown.pendingRecovery, await fs.readFile(path.join(throwRound, 'consultant-1.turn.json'), 'utf8').then(() => 'written', () => 'absent'), await fs.readFile(path.join(throwDir, 'consults', consultId(throwReq), 'result.json'), 'utf8').then(() => 'written', () => 'absent')], [true, 'absent', 'absent'])

    // An interrupted seat turn is replayed through the harness recorded with its ids, not the one the seat resolves to now.
    const movedDir = await callerDir()
    const movedReq = request({ key: 'cfg-guard:moved-harness' })
    const movedRound = path.join(movedDir, 'consults', consultId(movedReq), 'round-1')
    await fs.mkdir(movedRound, { recursive: true })
    const pendingFile = path.join(movedRound, 'consultant-1.pending.json')
    await fs.writeFile(pendingFile, JSON.stringify({ harness: 'fake-old', initial: 'OLD-1' }))
    const calls = { old: [], current: [] }
    const loader = (oldAvailable) => async (harness) => {
      if (harness === 'fake-old') { if (!oldAvailable) throw new Error('no such harness'); return { recoverPending: async ({ invocationId }) => { calls.old.push(invocationId); return { invocationId, integrity: { kind: 'cli-config', invocationId, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantined' }] } } }, resolveConfig: async () => true } }
      return { invoke: async () => { calls.current.push('invoke'); return { outcome: 'completed', response: reply(opinion()), session: { id: 's' }, usage: { costUsd: 0 }, diagnostics: { access: 'read' } } }, recoverPending: async () => { calls.current.push('recover'); return null }, resolveConfig: async () => true }
    }
    await fakePanel({}, { loadAdapter: loader(false) }).consult(movedReq, { callerDir: movedDir }).catch(() => null)
    const notAsked = await fs.readFile(path.join(movedRound, 'consultant-1.turn.json'), 'utf8').then(() => false, () => true)
    t.eq('with the recorded harness unavailable that seat is not asked, nothing is recorded for it, and its pending ids are kept', [notAsked, JSON.parse(await fs.readFile(pendingFile, 'utf8')).initial], [true, 'OLD-1'])
    const resultFile = path.join(movedDir, 'consults', consultId(movedReq), 'result.json')
    t.eq('and the consult caches no result that would hide the pending seat', await fs.readFile(resultFile, 'utf8').then(() => 'written', () => 'absent'), 'absent')
    t.eq('recorded() has nothing to return yet, so the caller consults again', await fakePanel({}, { loadAdapter: loader(false) }).recorded(movedReq, { callerDir: movedDir }), null)
    const stillOut = await fakePanel({}, { loadAdapter: loader(false) }).consult(movedReq, { callerDir: movedDir })
    t.eq('asked again while the harness is still out: not replayed, still unrecorded, ids kept', [stillOut.replayed, await fs.readFile(resultFile, 'utf8').then(() => 'written', () => 'absent'), JSON.parse(await fs.readFile(pendingFile, 'utf8')).initial], [false, 'absent', 'OLD-1'])
    calls.current.length = 0
    // The adapter is back: the next consult() settles the seat (no file removed by hand).
    await fakePanel({}, { loadAdapter: loader(true) }).consult(movedReq, { callerDir: movedDir })
    const movedTurn = JSON.parse(await fs.readFile(path.join(movedRound, 'consultant-1.turn.json'), 'utf8'))

    // An early return before any seat turn (the roster failing) caches nothing while pending ids exist.
    const earlyDir = await callerDir()
    const earlyReq = request({ key: 'cfg-guard:early-return' })
    const earlyRound = path.join(earlyDir, 'consults', consultId(earlyReq), 'round-1')
    await fs.mkdir(earlyRound, { recursive: true })
    await fs.writeFile(path.join(earlyRound, 'consultant-1.pending.json'), JSON.stringify({ harness: 'fake-old', initial: 'EARLY-1' }))
    const noRoster = await fakePanel({}, { loadRoster: async () => new Map() }).consult(earlyReq, { callerDir: earlyDir })
    t.eq('a roster failure with a seat still pending: unavailable, marked pendingRecovery, naming the seat', [noRoster.outcome, noRoster.pendingRecovery, noRoster.unsettled], ['unavailable', true, ['round-1/consultant-1']])
    t.eq('…and no result.json is cached, so the seat stays reachable', await fs.readFile(path.join(earlyDir, 'consults', consultId(earlyReq), 'result.json'), 'utf8').then(() => 'written', () => 'absent'), 'absent')
    t.eq('the seat-turn path says pendingRecovery too', stillOut.pendingRecovery, true)
    t.eq('recovery went through the recorded harness, by id', calls.old, ['OLD-1'])
    t.eq('the seat\'s current harness was not used for that recovery', calls.current.includes('recover'), false)
    t.eq('the violation is the turn\'s answer', movedTurn.error?.integrity?.invocationId, 'OLD-1')
  }

  for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
}
