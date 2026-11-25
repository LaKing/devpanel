import fs from 'node:fs/promises'

import { alertDestination, alertSections, questionDestination } from '../src/notifications.js'
import { readHidden, revealSectionState, sectionShown, toggleSectionState, writeHidden } from '../src/issue-sections.js'
import { pauseIdOf } from '../server/runtime/store.mjs'

/*
 * Where an alert's link lands (docs/operator-alerts.md), decided by the same functions the issue and supervisor
 * pages use, without a browser: waiting at its action, needing recovery instead, or already handled.
 */

const paused = { runId: 'r', status: 'paused', pause: { id: 'p1', kind: 'policy' }, blockedReason: null }

export default async function (t) {
  t.section('a run question')
  t.eq('not opened from an alert: nothing to say', alertDestination(paused, { run: 'r' }), null)
  t.eq('another run: nothing to say', alertDestination(paused, { run: 'other', pause: 'p1' }), null)
  const waiting = alertDestination(paused, { run: 'r', pause: 'p1' })
  t.eq('the named question still waits: its answer form is the action', `${waiting.state}/${waiting.target}`, 'waiting/answer')
  const answered = alertDestination({ runId: 'r', status: 'running', pause: null }, { run: 'r', pause: 'p1' })
  t.eq('answered by someone else: handled, with the run as it is now', `${answered.state}/${answered.status}`, 'handled/running')
  const another = alertDestination({ ...paused, pause: { id: 'p2', kind: 'policy' } }, { run: 'r', pause: 'p1' })
  t.eq('paused again on a different question: the named one was handled', another.state, 'handled')
  const damaged = alertDestination({ ...paused, journal: { recoveryRequired: true }, supportedActions: ['abandon'] }, { run: 'r', pause: 'p1' })
  t.eq('the journal needs recovery now: no answer is offered, the action the server offers is the target', `${damaged.state}/${damaged.target}`, 'recovery/abandon')
  t.eq('with no action offered, nothing is targeted', alertDestination({ ...paused, journal: { recoveryRequired: true } }, { run: 'r', pause: 'p1' }).target, null)
  const legacyPause = { question: 'Go on?', kind: 'policy', at: '2026-01-01T00:00:00.000Z' }
  const legacyId = pauseIdOf('r', legacyPause)
  t.ok('an older pause without an id gets the derived id every reader uses', legacyId.startsWith('legacy-') && legacyId === pauseIdOf('r', { ...legacyPause }))
  t.eq('and the destination matches it once the detail carries it', alertDestination({ ...paused, pause: { ...legacyPause, id: legacyId } }, { run: 'r', pause: legacyId }).state, 'waiting')

  t.section('a triage question, a recovery')
  t.eq("the triage's questions still open", alertDestination({ runId: 'r', status: 'completed', ownerInput: { at: 'x', answer: null } }, { run: 'r', wait: 'owner-input' }).target, 'owner-input')
  t.eq('answered', alertDestination({ runId: 'r', status: 'running', ownerInput: { at: 'x', answer: { at: 'y' } } }, { run: 'r', wait: 'owner-input' }).state, 'handled')
  const recovering = { runId: 'r', status: 'blocked', blockedReason: 'recovery-required', recovery: { required: true, detectedAt: 'T1', continuesFrom: 'T0' }, supportedActions: ['recover', 'abandon'] }
  t.eq('the same recovery (its occurrence): waiting at Recover run', `${alertDestination(recovering, { run: 'r', recovery: 'T0' }).state}/${alertDestination(recovering, { run: 'r', recovery: 'T0' }).target}`, 'waiting/recover')
  t.eq('a later recovery of the same run: the named one ended, this one needs recovery', alertDestination(recovering, { run: 'r', recovery: 'T-earlier' }).state, 'recovery')
  t.eq('recovered: handled', alertDestination({ runId: 'r', status: 'running', recovery: { required: false } }, { run: 'r', recovery: 'T0' }).state, 'handled')

  t.section('the action a recovery offers, and an abandoned journal recovery')
  const quarantined = { runId: 'r', status: 'blocked', blockedReason: 'recovery-required', recovery: { required: true, detectedAt: 'Q' }, supportedActions: ['resolve-integrity', 'abandon'] }
  t.eq('an integrity quarantine: Inspect changes', alertDestination(quarantined, { run: 'r', recovery: 'Q' }).target, 'resolve-integrity')
  const journal = { runId: 'r', status: 'failed', journal: { recoveryRequired: true }, recovery: { required: true, detectedAt: 'J' }, supportedActions: ['abandon'] }
  t.eq('an inactive run with a damaged journal: Abandon run', alertDestination(journal, { run: 'r', recovery: 'J' }).target, 'abandon')
  t.eq('a question superseded by journal damage targets that action too', alertDestination({ ...paused, journal: { recoveryRequired: true }, supportedActions: ['abandon'] }, { run: 'r', pause: 'p1' }).target, 'abandon')
  t.eq('an owner loss: Recover run', alertDestination({ ...recovering, supportedActions: ['recover', 'abandon'] }, { run: 'r', recovery: 'T0' }).target, 'recover')
  const abandoned = { runId: 'r', status: 'cancelled', journal: { recoveryRequired: true }, recovery: { required: false, resolution: 'abandoned' }, abandonment: { at: 'A', by: 'bea' }, supportedActions: [] }
  const shown = alertDestination(abandoned, { run: 'r', recovery: 'J' })
  t.eq('an abandoned journal recovery reads handled, with the run as it is now', `${shown.state}/${shown.status}`, 'handled/cancelled')

  const activeJournal = { runId: 'r', status: 'running', journal: { recoveryRequired: true }, recovery: { required: true, detectedAt: 'J2' }, supportedActions: ['stop'] }
  t.eq('an active run with a damaged journal (the server offers stop): Stop run is the target', `${alertDestination(activeJournal, { run: 'r', recovery: 'J2' }).state}/${alertDestination(activeJournal, { run: 'r', recovery: 'J2' }).target}`, 'waiting/stop')
  t.eq('a question it superseded targets Stop run too', alertDestination({ ...activeJournal, status: 'paused', pause: { id: 'p1', kind: 'policy' } }, { run: 'r', pause: 'p1' }).target, 'stop')

  t.section('the issue page shows the section that holds the target, even when this browser hid it')
  t.eq('an answer form sits in Status', alertSections('answer').join(), 'run,status')
  t.eq("a triage's answer form too", alertSections('owner-input').join(), 'run,status')
  t.ok('every run control sits in the run picker bar', ['recover', 'resolve-integrity', 'abandon', 'stop'].every((a) => alertSections(a).join() === 'run,runbar'))
  t.eq("an archived run's entry sits in the run card", alertSections('packed').join(), 'run')
  t.eq('a handled item (no action): the run card and its Status, which show the note and the run as it is now', alertSections(null).join(), 'run,status')
  const page = await fs.readFile(new URL('../src/views/IssueView.vue', import.meta.url), 'utf8')
  const ids = new Set([...page.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]))
  t.ok('each of those is a section the Sections bar can hide', ['run', 'status', 'runbar'].every((id) => ids.has(id)))
  for (const target of ['answer', 'owner-input', 'recover', 'resolve-integrity', 'abandon', 'stop']) {
    t.ok(`the page marks the ${target} control`, page.includes(`data-alert-action="${target}"`))
  }

  t.section("the issue page's alert watchers read nothing before it exists")
  {
    // Vue reads a watch source when the watch is registered: every ref and computed the alert watchers read must be
    // declared above them in <script setup>, or setup throws (temporal dead zone) and the packed run never scrolls.
    const script = page.slice(page.indexOf('<script setup>'), page.indexOf('</script>'))
    const at = (needle) => { const i = script.indexOf(needle); if (i < 0) throw new Error(`IssueView.vue lacks ${needle}`); return i }
    const target = at('const alertTarget = computed(')
    const packedWatch = at('watch(() => (issue.value?.packed && route.query.run')
    const actionWatch = at('watch(() => alertTarget.value ?')
    t.ok('alertTarget is declared before the watch that reads it', target < actionWatch)
    // The watch fires for every destination, handled included, and reveals the sections of its action or, with none,
    // of the note and current state (alertSections(null)); it scrolls to the action or to that note.
    const actionBody = script.slice(actionWatch, script.indexOf('}, { immediate: true })', actionWatch))
    t.ok('the watch keys on any destination, not only an actionable one', /alertTarget\.value \? `[^`]*state[^`]*`/.test(actionBody))
    t.ok('a handled destination reveals with no action', /state !== 'handled' \? alertTarget\.value\.target : null/.test(actionBody) && actionBody.includes('revealSections(alertSections(action))'))
    t.ok('and scrolls to the alert note', actionBody.includes('[data-testid="alert-target"]') && page.includes('data-testid="alert-target"'))
    for (const [name, needle] of [['issue', 'const issue = ref('], ['run', 'const run = ref('], ['route', 'const route = useRoute('], ['sections', 'const sections = ref('], ['shown', 'const shown = ']]) {
      t.ok(`${name} is declared before alertTarget and both watchers`, at(needle) < Math.min(target, packedWatch, actionWatch))
    }
    t.eq('both watchers run at registration, so an alert link opened on a loaded page acts at once', (script.slice(packedWatch).match(/\}, \{ immediate: true \}\)/g) ?? []).length >= 2, true)
  }

  t.section('a section an alert showed is never saved as the default')
  {
    // The page's own state functions (IssueView.vue toggleSection / revealSections), with a fake localStorage.
    const items = new Map()
    const storage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) }
    writeHidden(['run', 'runbar', 'status'], storage)
    let state = { hidden: readHidden(storage), revealed: [] }
    // A handled link: no action, so alertSections(null) = run, status.
    state = revealSectionState(state, alertSections(null))
    t.ok('the alert shows Run and Status for this visit', sectionShown(state, 'run') && sectionShown(state, 'status') && !sectionShown(state, 'runbar'))
    t.eq('nothing is written by the reveal', readHidden(storage).join(), 'run,runbar,status')
    // The operator then hides an unrelated section.
    const toggled = toggleSectionState(state, 'issue')
    if (toggled.save) writeHidden(toggled.hidden, storage)
    state = { hidden: toggled.hidden, revealed: toggled.revealed }
    t.eq('the saved list keeps Run and Status hidden, with Issue added', readHidden(storage).join(), 'issue,run,runbar,status')
    t.ok('and this visit still shows what the alert opened', sectionShown(state, 'run') && sectionShown(state, 'status') && !sectionShown(state, 'issue'))
    const hideAgain = toggleSectionState(state, 'status')
    t.ok('hiding a revealed section ends the reveal without a write', !hideAgain.save && !sectionShown(hideAgain, 'status'))
    const showSaved = toggleSectionState(hideAgain, 'runbar')
    if (showSaved.save) writeHidden(showSaved.hidden, storage)
    t.eq('showing a section by hand is saved as before', readHidden(storage).join(), 'issue,run,status')
    t.eq('a fresh visit reads only the saved choice', ['run', 'status'].filter((id) => sectionShown({ hidden: readHidden(storage), revealed: [] }, id)).length, 0)
  }

  t.section('a supervisor question')
  const questions = [{ id: 'sq-1' }, { id: 'sq-2', answer: { actor: 'cy', at: 'T' } }]
  t.eq('still open', questionDestination(questions, 'sq-1').state, 'waiting')
  t.eq('answered, by whom', `${questionDestination(questions, 'sq-2').state}/${questionDestination(questions, 'sq-2').by}`, 'answered/cy')
  t.eq('gone with its session', questionDestination(questions, 'sq-9').state, 'retired')
  t.eq('no question named', questionDestination(questions, undefined), null)
}
