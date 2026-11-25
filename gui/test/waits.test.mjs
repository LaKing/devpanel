import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectWaits, questionWait, runWaits, summariseWaits, supervisorQuestionHistory } from '../server/notifications/waits.mjs'
import { journalOverlay } from '../server/runtime/store.mjs'

/* Time to response from the timestamps runs already record (docs/operator-alerts.md "Time to response"). */

const at = (m) => new Date(Date.parse('2026-11-25T10:00:00Z') + m * 60_000).toISOString()

export default async function (t) {
  t.section('pauses')
  {
    const run = {
      runId: 'r', status: 'paused', pause: { id: 'p3', kind: 'policy', at: at(50) },
      steps: [
        { role: 'operator', decision: { pauseId: 'p1', askedAt: at(0), at: at(12), actor: 'ana' } },
        { role: 'operator', decision: { pauseId: 'p2', askedAt: at(20), at: at(21), actor: 'engine' } },
        { role: 'operator', decision: { pauseId: 'p4', askedAt: at(30), at: at(31), actor: 'consult panel (x)', consult: { id: 'c' } } }
      ]
    }
    const rows = runWaits(run, { project: 'p', issueId: 'i' })
    const answered = rows.find((r) => r.key === 'pause:p/i/r/p1')
    t.eq('an answered question: asked → answered, by whom', `${answered.enteredAt}>${answered.handledAt}/${answered.by}`, `${at(0)}>${at(12)}/ana`)
    t.ok("the engine's and the consult panel's answers are not a person's wait", !rows.some((r) => /p2|p4/.test(r.key)))
    const open = rows.find((r) => r.key === 'pause:p/i/r/p3')
    t.eq('the open question is measured from its stored time, handling pending', `${open.enteredAt}/${open.handledBasis}`, `${at(50)}/pending`)
    const manual = runWaits({ runId: 'r', status: 'paused', pause: { id: 'm', kind: 'manual', at: at(0) }, steps: [] }, { project: 'p', issueId: 'i' })
    t.eq('a manual pause is not a wait on a person', manual.length, 0)
  }

  t.section('owner questions, supervisor questions')
  {
    const rows = runWaits({ runId: 'r', ownerInput: { at: at(0), answer: { at: at(7), by: 'bea' } }, steps: [] }, { project: 'p', issueId: 'i' })
    t.eq("a triage's question to the owner", `${rows[0].key}:${rows[0].enteredAt}>${rows[0].handledAt}/${rows[0].by}`, `owner-input:p/i/r:${at(0)}>${at(7)}/bea`)
    t.eq('a supervisor question answered', questionWait({ id: 'sq', at: at(0), answer: { at: at(3), actor: 'cy' } }).handledAt, at(3))
    t.eq('one still open', questionWait({ id: 'sq', at: at(0) }).handledBasis, 'pending')
  }

  t.section('recoveries')
  {
    const run = {
      runId: 'r', steps: [],
      recoveries: [{ occurrence: at(0), detectedAt: at(5), resolvedAt: at(30), how: 'recovered', by: 'ana' }],
      ownerRecoveries: [{ detectedAt: at(5), recoveredAt: at(30) }, { detectedAt: at(40), recoveredAt: at(45) }],
      integrity: { dispositions: [
        { disposition: 'restored', at: at(70), suspendedMs: 10 * 60_000, actor: 'bea' },
        { disposition: 'accept-partial', at: at(80), suspendedMs: 60_000, recoveryDetectedAt: at(79) }
      ] }
    }
    const rows = runWaits(run, { project: 'p', issueId: 'i' }).filter((r) => r.kind === 'recovery')
    t.eq('an exact interval from run.recoveries, keyed by its occurrence', rows[0].key, `recovery:p/i/r/${at(0)}`)
    t.ok('an older owner recovery is not counted twice', rows.filter((r) => r.handledAt === at(30)).length === 1)
    t.ok('an older owner recovery without a newer record is read', rows.some((r) => r.enteredAt === at(40) && r.handledAt === at(45)))
    t.ok('an older integrity disposition: entered when its excused wait began', rows.some((r) => r.enteredAt === at(60) && r.handledAt === at(70) && r.by === 'bea'))
    t.ok('a newer disposition is read from run.recoveries, never as a legacy row', !rows.some((r) => r.handledAt === at(80)))
    const open = runWaits({ runId: 'r', steps: [], blockedReason: 'recovery-required', recovery: { required: true, detectedAt: at(90), continuesFrom: at(85) } }, { project: 'p', issueId: 'i' })
    t.eq('an open recovery continues its first occurrence', `${open[0].enteredAt}/${open[0].handledBasis}`, `${at(85)}/pending`)
  }

  t.section('questions nobody answered, older records, journal recoveries')
  {
    const abandoned = runWaits({ runId: 'r', status: 'cancelled', pause: { id: 'p1', kind: 'policy', at: at(0) }, abandonment: { at: at(25), by: 'ana' }, steps: [] }, { project: 'p', issueId: 'i' })
    t.eq('an abandoned paused run: the question ends at the abandonment, by whom', `${abandoned[0].handledAt}/${abandoned[0].by}/${abandoned[0].how}`, `${at(25)}/ana/abandoned`)
    const ended = runWaits({ runId: 'r', status: 'failed', endedAt: at(40), pause: { id: 'p1', kind: 'policy', at: at(0) }, steps: [] }, { project: 'p', issueId: 'i' })
    t.eq('a run that ended without an answer: at its end', `${ended[0].handledAt}/${ended[0].how}`, `${at(40)}/run-ended`)
    const legacyPause = runWaits({ runId: 'r', status: 'paused', pause: { kind: 'policy', at: at(0), question: 'Go on?' }, steps: [] }, { project: 'p', issueId: 'i' })
    t.ok('an older pause without an id is keyed by the id every reader derives', /^pause:p\/i\/r\/legacy-/.test(legacyPause[0].key))
    const amendment = runWaits({ runId: 'r', steps: [], integrity: { latest: { role: 'operator', invocationId: 'amend-1', at: at(3) }, dispositions: [{ disposition: 'abandon', invocationId: 'amend-1', at: at(9), actor: 'bea' }] } }, { project: 'p', issueId: 'i' })
    t.eq("an older operator amendment's quarantine is dated by its own record", amendment[0].enteredAt, at(3))
    // A journal-only recovery, as the inbox reads it (the finding overlaid on run.json).
    const journalRun = journalOverlay({ runId: 'r', status: 'paused', pause: { id: 'p1', kind: 'policy', at: at(0) }, steps: [] }, { recoveryRequired: true, finding: { detectedAt: at(5) }, message: 'damaged' })
    const journalRows = runWaits(journalRun, { project: 'p', issueId: 'i' }).filter((r) => r.kind === 'recovery')
    t.eq('a journal-only recovery is measured from its finding', `${journalRows[0]?.enteredAt}/${journalRows[0]?.handledBasis}`, `${at(5)}/pending`)
  }

  t.section('a retired journal recovery')
  {
    const retired = journalOverlay({ runId: 'r', status: 'failed', steps: [] }, { recoveryRequired: false, retired: true, disposition: { at: at(30) }, finding: { detectedAt: at(2) } })
    const rows = runWaits(retired, { project: 'p', issueId: 'i' }).filter((r) => r.kind === 'recovery')
    t.eq('closes at the retirement, entered at its finding', `${rows[0]?.enteredAt}>${rows[0]?.handledAt}/${rows[0]?.how}`, `${at(2)}>${at(30)}/retired`)
  }

  t.section('supervisor questions across sessions')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-history-'))
    try {
      await fs.writeFile(path.join(dir, 'state.2026-11-25T09-00-00-000Z.json'), JSON.stringify({ questions: [
        { id: 'sq-old-answered', at: at(-60), answer: { actor: 'ana', at: at(-50) } },
        { id: 'sq-old-open', at: at(-40), answer: null }
      ] }))
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ questions: [{ id: 'sq-now', at: at(0), answer: { actor: 'bea', at: at(4) } }, { id: 'sq-open', at: at(10), answer: null }] }))
      const history = await supervisorQuestionHistory(dir)
      const rows = Object.fromEntries(history.map((e) => questionWait(e.q, { retiredAt: e.retiredAt })).map((r) => [r.key, r]))
      t.eq('an answered question of the current session', rows['supervisor-question:sq-now'].handledAt, at(4))
      t.eq('an answered question of an archived session', rows['supervisor-question:sq-old-answered'].by, 'ana')
      t.eq('one left open when its session was archived: retired at the archive time', `${rows['supervisor-question:sq-old-open'].how}/${rows['supervisor-question:sq-old-open'].handledAt}`, 'retired/2026-11-25T09:00:00.000Z')
      t.eq('one open now: pending', rows['supervisor-question:sq-open'].handledBasis, 'pending')
      const report = await collectWaits({ listProjects: async () => [], listIssues: async () => [], readRunRecords: async () => [], questions: history })
      t.eq('all of them reach the report', report.rows.length, 4)
      t.eq('an absent directory is no history', (await supervisorQuestionHistory(path.join(dir, 'none'))).length, 0)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  }

  t.section('summary')
  {
    const rows = [
      { enteredAt: at(0), enteredBasis: 'recorded', handledAt: at(10), handledBasis: 'recorded' },
      { enteredAt: at(100), enteredBasis: 'recorded', handledAt: at(102), handledBasis: 'recorded', alerted: true },
      { enteredAt: at(110), enteredBasis: 'recorded', handledAt: at(116), handledBasis: 'recorded', alerted: false },
      { enteredAt: at(120), enteredBasis: 'recorded', handledAt: null, handledBasis: 'pending' },
      { enteredAt: null, enteredBasis: 'not-recorded', handledAt: at(5), handledBasis: 'recorded' }
    ]
    const s = summariseWaits(rows, { installedAt: at(50) })
    t.eq('before installation', `${s.before.count}/${s.before.medianMs}`, `1/${10 * 60_000}`)
    t.eq('after installation', `${s.after.count}/${s.after.medianMs}`, `2/${4 * 60_000}`)
    t.eq('alerted and not alerted apart', `${s.alerted.medianMs}/${s.notAlerted.medianMs}`, `${2 * 60_000}/${6 * 60_000}`)
    t.eq('open and unrecorded waits counted, not guessed', `${s.pending}/${s.notRecorded}`, '1/1')
  }
}
