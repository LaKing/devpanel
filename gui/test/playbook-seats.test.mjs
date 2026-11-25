import fs from 'node:fs/promises'
import path from 'node:path'
import { playbookSeats, savePlaybookSeats } from '../server/playbook-seats.mjs'
import { CONFIG_ROOT } from '../server/config/load.mjs'
import { sandbox, patch } from './helpers.mjs'

export const name = 'playbook seats — the Playbooks page reads every playbook\'s seats and writes an edit as a host copy'

const exists = (file) => fs.stat(file).then(() => true, () => false)
const refused = async (work) => { try { await work(); return null } catch (error) { return error } }

export default async function (t) {
  const root = await sandbox()
  const hostDir = path.join(root, 'host-config')
  const at = { root, hostDir }
  const tracked = path.join(root, 'playbooks', 'implementation.yaml')
  const copy = path.join(hostDir, 'playbooks', 'implementation.yaml')
  const trackedText = await fs.readFile(tracked, 'utf8')
  const read = async (id = 'implementation') => (await playbookSeats(at)).playbooks.find((p) => p.id === id)
  const seat = (playbook, role) => playbook.seats.find((s) => s.role === role)

  t.section('the view')
  const first = await playbookSeats(at)
  const implementation = first.playbooks.find((p) => p.id === 'implementation')
  t.ok('every playbook of the catalogue is listed', ['analysis', 'triage', 'implementation', 'plan-and-implement', 'deployment'].every((id) => first.playbooks.some((p) => p.id === id)), first.playbooks.map((p) => p.id).join(', '))
  t.eq('a tracked playbook says so', [implementation.source, implementation.drift], ['tree', false])
  t.eq('a bound seat names its model and effort', [seat(implementation, 'coordinator').model, seat(implementation, 'coordinator').effort], ['opus-5-5', 'low'])
  t.ok('an optional seat nobody occupies is listed empty', seat(implementation, 'auditor-2').optional === true && seat(implementation, 'auditor-2').model === null, JSON.stringify(seat(implementation, 'auditor-2')))
  t.ok('the writer is marked', seat(implementation, 'implementer').writesCode === true && seat(implementation, 'coordinator').writesCode === false)
  t.ok('it resolves and nothing keeps it from starting', implementation.resolves === true && implementation.errors.length === 0 && /^sha256:/.test(implementation.configHash ?? ''), `${implementation.configHash} ${implementation.errors.join('; ')}`)
  const opus = first.models.find((m) => m.id === 'opus-5-5')
  t.ok('the roster comes with each model\'s efforts and verification', opus.verified === true && opus.efforts.includes('xhigh') && first.models.find((m) => m.id === 'gemini-4-argon').efforts.length === 0, JSON.stringify(opus))

  t.section('an edit is the installation\'s own copy; the tracked file is untouched')
  const saved = await savePlaybookSeats('implementation', { coordinator: { model: 'opus-5-5', effort: 'medium' } }, { ...at, actor: 'tester', now: () => new Date('2026-11-21T00:00:00Z') })
  t.eq('it reports the change and where it went', [saved.changed, saved.written, saved.removed], [true, copy, false])
  t.eq('the tracked file keeps its bytes', await fs.readFile(tracked, 'utf8'), trackedText)
  const copyText = await fs.readFile(copy, 'utf8')
  t.ok('the copy says it is one', copyText.startsWith('# Host copy of playbooks/implementation.yaml'), copyText.slice(0, 160))
  t.ok('only the seat changed: the rest of the file and its comments are kept', copyText.includes('maxSteps: 120') && copyText.includes('# Opus 5.5 medium by default since 2026-09-26') && copyText.includes('performed; absent tests never count as passed.'), `${copyText.length} bytes`)
  t.ok('the comment that explained the old value is gone with it', !copyText.includes('a low-effort coordinator everywhere'), `${copyText.length} bytes`)
  const edited = await read()
  t.eq('the view reads the copy', [edited.source, edited.drift, seat(edited, 'coordinator').effort], ['host', false, 'medium'])
  t.ok('new seats are a new configuration group', edited.configHash !== implementation.configHash && edited.resolves === true, `${implementation.configHash} -> ${edited.configHash}`)
  const history = (await fs.readFile(path.join(hostDir, 'playbooks', '.history.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  t.eq('who changed what is recorded beside the copies', [history.length, history[0].actor, history[0].changes[0].role, history[0].changes[0].from.effort, history[0].changes[0].to.effort, history[0].at], [1, 'tester', 'coordinator', 'low', 'medium', '2026-11-21T00:00:00.000Z'])
  t.ok('the history is not read as a playbook', (await playbookSeats(at)).errors.length === first.errors.length)

  t.section('optional seats, and an effort left to the model')
  await savePlaybookSeats('implementation', { 'auditor-2': { model: 'gpt-6.2-sol', effort: 'high' }, implementer: { model: 'opus-5-5' } }, at)
  const two = await read()
  t.eq('an empty optional seat can be occupied', [seat(two, 'auditor-2').model, seat(two, 'auditor-2').effort], ['gpt-6.2-sol', 'high'])
  t.eq('no effort means the model\'s default', [seat(two, 'implementer').effort, seat(two, 'implementer').resolvedEffort], [null, 'high'])
  await savePlaybookSeats('implementation', { 'auditor-2': null }, at)
  t.eq('and emptied again', seat(await read(), 'auditor-2').model, null)

  t.section('refusals write nothing')
  const before = await fs.readFile(copy, 'utf8')
  const cases = [
    ['an unknown playbook', () => savePlaybookSeats('nope', { coordinator: { model: 'opus-5-5' } }, at), 404],
    ['a role the strategy does not have', () => savePlaybookSeats('implementation', { reviewer: { model: 'opus-5-5' } }, at), 400],
    ['emptying a required seat', () => savePlaybookSeats('implementation', { implementer: null }, at), 400],
    ['a model that is not in the roster', () => savePlaybookSeats('implementation', { coordinator: { model: 'no-such-model', effort: 'low' } }, at), 422],
    ['an effort the model does not take', () => savePlaybookSeats('implementation', { 'auditor-1': { model: 'gemini-4-argon', effort: 'high' } }, at), 422],
    ['a field that is not a seat\'s default', () => savePlaybookSeats('implementation', { coordinator: { model: 'opus-5-5', instructions: 'x' } }, at), 400],
    ['no seat named', () => savePlaybookSeats('implementation', {}, at), 400]
  ]
  for (const [label, work, status] of cases) {
    const error = await refused(work)
    t.ok(`${label} is refused (${status})`, error?.status === status, `${error?.status} ${error?.message} ${(error?.detail ?? []).join(' | ')}`)
  }
  const unknown = await refused(() => savePlaybookSeats('implementation', { coordinator: { model: 'no-such-model', effort: 'low' } }, at))
  t.ok('the refusal says what does not resolve', (unknown?.detail ?? []).some((line) => /no-such-model/.test(line)), JSON.stringify(unknown?.detail))
  await patch(path.join(root, 'roster', 'gpt-6-sol.yaml'), 'status: verified', 'status: unverified')
  const unverified = await refused(() => savePlaybookSeats('implementation', { 'auditor-2': { model: 'gpt-6-sol', effort: 'medium' } }, at))
  t.ok('a seat that would keep the playbook from starting is refused: an unverified model', unverified?.status === 422 && (unverified.detail ?? []).some((line) => /unverified/.test(line)), `${unverified?.status} ${JSON.stringify(unverified?.detail)}`)
  const deployment = (await playbookSeats(at)).playbooks.find((p) => p.id === 'deployment')
  const onDeployment = await refused(() => savePlaybookSeats('deployment', { [deployment.seats.find((s) => s.model).role]: { model: 'gpt-6-sol', effort: 'medium' } }, at))
  t.ok('and so it is on a playbook that something else already keeps from starting', onDeployment?.status === 422 && (onDeployment.detail ?? []).every((line) => /unverified/.test(line)), `${deployment.errors.join('; ')} => ${onDeployment?.status} ${JSON.stringify(onDeployment?.detail)}`)
  t.eq('after all of them the copy has the bytes it had', await fs.readFile(copy, 'utf8'), before)
  const same = await savePlaybookSeats('implementation', { coordinator: { model: 'opus-5-5', effort: 'medium' } }, at)
  t.eq('seats as they already are change nothing', [same.changed, same.written], [false, null])

  t.section('a copy that shadows a changed tracked file says so')
  await patch(tracked, 'maxSteps: 120', 'maxSteps: 150')
  t.eq('drift is reported', (await read()).drift, true)
  await patch(tracked, 'maxSteps: 150', 'maxSteps: 120')

  t.section('back to the tracked seats: no copy is left to shadow the catalogue')
  const back = await savePlaybookSeats('implementation', { coordinator: { model: 'opus-5-5', effort: 'low' }, implementer: { model: 'opus-5-5', effort: 'medium' } }, at)
  t.eq('the copy is removed', [back.changed, back.removed, back.written, await exists(copy)], [true, true, null, false])
  const restored = await read()
  t.eq('the playbook is the tracked one again, in its old configuration group', [restored.source, restored.configHash], ['tree', implementation.configHash])
  t.section('Consultation: the consult panel, seated and edited like a playbook')
  t.eq('without a panel file there is no such entry', (await playbookSeats(at)).playbooks.some((p) => p.id === 'consultation'), false)
  const trackedPanel = path.join(root, 'consult', 'panel.yaml')
  const hostPanel = path.join(hostDir, 'consult', 'panel.yaml')
  await fs.mkdir(path.dirname(trackedPanel), { recursive: true })
  await fs.copyFile(path.join(CONFIG_ROOT, 'consult', 'panel.yaml'), trackedPanel)
  const panelText = await fs.readFile(trackedPanel, 'utf8')
  let panel = await read('consultation')
  t.eq('it is listed with three optional seats, the third empty', [panel.title, panel.kind, panel.source, panel.resolves, panel.seats.map((s) => [s.role, s.optional, s.model])],
    ['Consultation', 'consultation', 'tree', true, [['consultant-1', true, 'fable-5-2'], ['consultant-2', true, 'gpt-6.2-astra'], ['consultant-3', true, null]]])
  const seated = await savePlaybookSeats('consultation', { 'consultant-3': { model: 'gemini-4-neon' }, 'consultant-2': { model: 'gpt-6.2-sol', effort: 'low' } }, { ...at, actor: 'tester', now: () => new Date('2026-11-25T00:00:00Z') })
  t.eq('an edit is written as the installation\'s own panel file', [seated.changed, seated.written, await fs.readFile(trackedPanel, 'utf8') === panelText], [true, hostPanel, true])
  const hostText = await fs.readFile(hostPanel, 'utf8')
  t.ok('which says it is a copy and keeps everything but the seats', hostText.startsWith('# Host copy of consult/panel.yaml') && hostText.includes('maxRounds: 2') && hostText.includes('alwaysHuman:'), hostText.slice(0, 200))
  panel = seated.playbooks.find((p) => p.id === 'consultation')
  t.eq('the view shows the three seats, a model without efforts taking none', [panel.source, panel.seats.map((s) => [s.model, s.effort])], ['host', [['fable-5-2', 'medium'], ['gpt-6.2-sol', 'low'], ['gemini-4-neon', null]]])
  t.eq('the change is recorded with who made it', JSON.parse((await fs.readFile(path.join(hostDir, 'consult', '.history.jsonl'), 'utf8')).trim().split('\n').at(-1)).actor, 'tester')

  const single = await savePlaybookSeats('consultation', { 'consultant-1': null, 'consultant-3': null }, at)
  t.eq('two seats may be emptied: one occupied seat is a panel', single.playbooks.find((p) => p.id === 'consultation').seats.map((s) => s.model), [null, 'gpt-6.2-sol', null])
  const empty = await refused(() => savePlaybookSeats('consultation', { 'consultant-2': null }, at))
  t.ok('the last seat cannot be emptied', empty?.status === 422 && /at least one occupied seat/.test(empty.message), empty?.message)
  const noSuchSeat = await refused(() => savePlaybookSeats('consultation', { 'consultant-4': { model: 'fable-5-2' } }, at))
  t.ok('a seat the panel does not have is refused', noSuchSeat?.status === 400 && /not a seat of the panel/.test(noSuchSeat.message), noSuchSeat?.message)
  const noEffort = await refused(() => savePlaybookSeats('consultation', { 'consultant-1': { model: 'gemini-4-neon', effort: 'high' } }, at))
  t.ok('an effort the model does not take is refused, naming it', noEffort?.status === 422 && noEffort.detail.some((d) => /has no effort "high"/.test(d)), JSON.stringify(noEffort?.detail))
  t.eq('a refusal wrote nothing', (await read('consultation')).seats.map((s) => s.model), [null, 'gpt-6.2-sol', null])

  const tracking = await savePlaybookSeats('consultation', { 'consultant-1': { model: 'fable-5-2', effort: 'medium' }, 'consultant-2': { model: 'gpt-6.2-astra', effort: 'medium' } }, at)
  t.eq('back to the tracked seats: the copy is removed', [tracking.removed, await exists(hostPanel), tracking.playbooks.find((p) => p.id === 'consultation').source], [true, false, 'tree'])
}

