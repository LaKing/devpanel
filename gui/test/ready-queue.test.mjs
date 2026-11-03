import { openDependencies } from '../server/issue-dependencies.mjs'
import { buildReadyQueue, freedSince, queueFingerprint, queueObservation, shownQueue } from '../server/ready-queue.mjs'

export const name = 'the ready queue: order, what blocks each issue and until when, campaign scope, what freed'

const P = 'p'
const state = (over = {}) => ({ campaign: null, focus: [], starts: 0, startsByIssue: {}, launches: [], failedLaunches: {}, limits: { maxRuns: 10, maxConcurrent: 3, maxStartsPerIssue: 2 }, ...over })
const issue = (id, over = {}) => ({ id, name: id, status: 'open', openedOn: '2026-01-01', ...over })
const on = (...ids) => ({ issues: ids.map((id) => (id.includes('/') ? { project: id.split('/')[0], id: id.split('/')[1] } : { project: P, id })) })
const row = (queue, id) => queue.rows.find((r) => r.id === id)
const kinds = (r) => (r.blockedBy ?? []).map((b) => b.kind)
const build = (rows, over = {}) => buildReadyQueue({ issuesByProject: { [P]: rows }, state: state(), ...over })

export default async function (t) {
  t.section('dependency order: a prerequisite precedes what waits for it, whatever their priority')
  {
    const q = await build([
      issue('urgent-waiter', { priority: { value: 'urgent' }, dependsOn: on('low-prereq') }),
      issue('normal', { priority: { value: 'normal' } }),
      issue('low-prereq', { priority: { value: 'low' }, openedOn: '2026-03-01' }),
      issue('older', { priority: { value: 'normal' }, openedOn: '2025-01-01' })
    ])
    t.eq('the order', q.rows.map((r) => r.id), ['low-prereq', 'urgent-waiter', 'older', 'normal'])
    t.eq('next is the first ready row', q.next?.id, 'low-prereq')
    t.eq('the waiter is blocked by it', row(q, 'urgent-waiter').blockedBy[0].on, ['low-prereq'])
    const cycle = await build([issue('a', { dependsOn: on('b') }), issue('b', { dependsOn: on('a') })])
    t.eq('a cycle does not hang or drop a row', cycle.rows.map((r) => r.id).sort(), ['a', 'b'])
  }

  t.section('what is a member: open, undecided issues; never an inquiry')
  {
    const q = await build([issue('open'), issue('decided', { disposition: { value: 'resolved' } }), issue('inquiry', { kind: 'inquiry' }), issue('closed', { status: 'resolved' })])
    t.eq('only the open issue', q.rows.map((r) => r.id), ['open'])
  }

  t.section('a dependency reads as start_run reads it')
  {
    const rows = [issue('w1', { dependsOn: on('open-one') }), issue('w2', { dependsOn: on('decided') }), issue('w3', { dependsOn: on('gone') }), issue('w4', { dependsOn: on('o/other') }),
      issue('open-one'), issue('decided', { disposition: { value: 'resolved' } })]
    const other = [issue('other')]
    const q = await buildReadyQueue({ issuesByProject: { [P]: rows, o: other }, state: state() })
    const all = new Map([...rows.map((i) => [`${P}/${i.id}`, i]), ...other.map((i) => [`o/${i.id}`, i])])
    for (const id of ['w1', 'w2', 'w3', 'w4']) {
      const open = await openDependencies(rows.find((i) => i.id === id), { getIssue: async (p, i) => all.get(`${p}/${i}`) ?? null })
      t.eq(`${id}: blocked exactly when openDependencies says so`, kinds(row(q, id)).includes('dependency'), open.length > 0)
    }
    t.eq('another project\'s prerequisite is named with its project', row(q, 'w4').blockedBy[0].on, ['o/other'])
  }

  t.section('every kind of block says what ends it; a time only where one is known')
  {
    const failed = JSON.stringify([P, 'guarded', 'input-key'])
    const q = await buildReadyQueue({
      issuesByProject: { [P]: [
        issue('own', { latestRun: { runId: 'r1', status: 'running', live: true } }),
        issue('paused', { latestRun: { runId: 'r2', status: 'paused', live: true } }),
        issue('owner', { latestRun: { runId: 'r3', status: 'completed', live: false, ownerInput: { answered: false } } }),
        issue('answered', { latestRun: { runId: 'r4', status: 'completed', live: false, ownerInput: { answered: true } } }),
        issue('trust', { report: { trust: 'anonymous' } }),
        issue('assess', { report: { trust: 'request' } }),
        issue('launch'), issue('guarded'), issue('limit'), issue('unreadable', { unreadableNewerRuns: ['r9'] })
      ], free: [issue('free')] },
      holders: { [P]: { issueId: 'own', runId: 'r1' } },
      reportLevels: { [`${P}/trust`]: 'none', [`${P}/assess`]: 'assess' },
      state: state({ launches: [{ project: P, issueId: 'launch', status: 'uncertain' }], failedLaunches: { [failed]: { reason: 'preflight-refused' } }, startsByIssue: { [`${P}/limit`]: 2 } })
    })
    t.eq('a live run is running, not blocked', [row(q, 'own').state, kinds(row(q, 'own'))], ['running', ['own-run']])
    t.ok('a paused run waits for its answer', /answered/.test(row(q, 'paused').blockedBy[0].until.event))
    t.eq('an ended run is a decision, and keeps its blocks', [row(q, 'answered').state, kinds(row(q, 'answered'))], ['decide', ['checkout-held']])
    t.ok('owner input', kinds(row(q, 'owner')).includes('owner-input'))
    t.ok('report trust', kinds(row(q, 'trust')).includes('report-trust'))
    t.eq('assess stays startable, for what it may start', row(q, 'assess').allowedPlaybooks, ['triage', 'analysis'])
    t.ok('an unresolved launch', kinds(row(q, 'launch')).includes('launch-unresolved'))
    t.eq('a failed-launch guard is advisory, with its reason', (({ reason, advisory }) => [reason, advisory])(row(q, 'guarded').blockedBy.find((b) => b.kind === 'failed-launch')), ['preflight-refused', true])
    t.ok('the per-issue limit', kinds(row(q, 'limit')).includes('start-limit'))
    t.ok('an unreadable run', kinds(row(q, 'unreadable')).includes('unreadable-run'))
    const busy = row(q, 'trust').blockedBy.find((b) => b.kind === 'checkout-held')
    t.eq('checkout-held names the holder', [busy.issueId, busy.runId], ['own', 'r1'])
    const beside = await build([issue('live-one', { latestRun: { runId: 'r1', status: 'running', live: true } }), issue('next-one')], {})
    t.eq('another issue\'s ordinary run blocks nothing: the next issue is ready', [row(beside, 'next-one').state, kinds(row(beside, 'next-one'))], ['ready', []])
    t.eq('and is offered', beside.next?.id, 'next-one')
    const everyBlock = q.rows.flatMap((r) => r.blockedBy ?? [])
    t.ok('each block has an event and no invented time', everyBlock.every((b) => typeof b.until.event === 'string' && b.until.at === null))
    t.eq('another project is free', [row(q, 'free').state, q.next?.id], ['ready', 'free'])
  }

  t.section('what stops every start is said once, and only a spending window has a time')
  {
    const full = await build([issue('a')], { state: state({ limits: { maxRuns: 10, maxConcurrent: 1, maxStartsPerIssue: 2 }, launches: [{ project: 'x', issueId: 'y', status: 'reserved' }] }) })
    t.eq('concurrency', [full.canStartNow, full.because.map((b) => b.kind), full.next], [false, ['concurrency'], null])
    t.eq('the row itself is not repeated as blocked', row(full, 'a').state, 'ready')
    t.eq('session starts', (await build([issue('a')], { state: state({ starts: 10 }) })).because.map((b) => b.kind), ['session-starts'])
    t.eq('finishing', (await build([issue('a')], { state: state({ finishing: true }) })).because.map((b) => b.kind), ['finishing'])
    const window = { starts: 1, unpricedRuns: 0, committedUsdMicros: 0, overageUsdMicros: 0, committedUsd: 0, overageUsd: 0 }
    const limits = { starts: 1, usd: 100, unpricedRuns: 100, unpricedCalls: 100 }
    const spent = await build([issue('a')], { now: Date.parse('2026-11-03T12:00:00Z'), usage: { day: window, month: { ...window, starts: 0 } },
      spending: { active: true, policy: { enforceAllowances: true, concurrent: 10, perWakeCalls: 10, daily: limits, monthly: { ...limits, starts: 100 } } } })
    t.eq('a spent window', spent.because.map((b) => [b.kind, b.limit, b.until.at]), [['spending-window', 'daily.starts', '2026-11-04T00:00:00.000Z']])
    const accounting = await build([issue('a')], { usage: { day: window, month: window }, spending: { active: true, policy: { enforceAllowances: false, concurrent: 10, perWakeCalls: 10, daily: limits, monthly: limits } } })
    t.eq('accounting only stops nothing', accounting.canStartNow, true)
  }

  t.section('campaign: membership of this reading; what it leaves out is counted')
  {
    const issuesByProject = { [P]: [issue('a'), issue('reported', { report: { reporter: 'someone', trust: 'fault' } })], o: [issue('b')] }
    const none = await buildReadyQueue({ issuesByProject, state: state() })
    t.eq('no campaign: the whole panel', none.rows.map((r) => r.id).sort(), ['a', 'b', 'reported'])
    t.eq('and says so', none.scope.campaign, null)
    t.eq('focus orders it', (await buildReadyQueue({ issuesByProject, state: state({ focus: ['o'] }) })).rows[0].id, 'b')
    const projects = await buildReadyQueue({ issuesByProject, state: state({ campaign: { projects: ['o'], leaveReporters: [] } }) })
    t.eq('declared projects', [projects.rows.map((r) => r.id), projects.outside], [['b'], { issues: 2, projects: [P] }])
    const reporters = await buildReadyQueue({ issuesByProject, state: state({ campaign: { projects: [], leaveReporters: ['someone'] } }) })
    t.eq('left reporters', reporters.rows.map((r) => r.id).sort(), ['a', 'b'])
    const owned = await buildReadyQueue({ issuesByProject, ownedIssues: [`${P}/a`], state: state({ campaign: { projects: ['o'], leaveReporters: [] } }) })
    t.ok('an issue with an open owned run stays in', owned.rows.some((r) => r.id === 'a'))
  }

  t.section('what a session is shown is bounded and counted; detection works on every member')
  {
    const rows = Array.from({ length: 40 }, (_, n) => issue(`trust-${String(n).padStart(2, '0')}`, { report: { trust: 'anonymous' }, openedOn: '2026-01-01' }))
    rows.push(issue('z-newest', { openedOn: '2026-06-01' }))
    const reportLevels = Object.fromEntries(rows.filter((i) => i.report).map((i) => [`${P}/${i.id}`, 'none']))
    const blocked = await build(rows, { holders: { [P]: { issueId: 'x', runId: 'rx' } }, reportLevels })
    const shown = shownQueue(blocked)
    t.eq('thirty rows are shown', shown.rows.length, 30)
    t.eq('the rest are counted by state', shown.omitted, { blocked: 11 })
    t.ok('the eligible issue is beyond the cap', !shown.rows.some((r) => r.id === 'z-newest'))
    const previous = queueObservation(blocked)
    t.eq('yet it is observed', previous.rows[`${P}/z-newest`], ['checkout-held'])
    const free = await build(rows, { reportLevels })
    const found = freedSince(previous, free)
    t.eq('and freeing it is found', [found?.next.id, found?.freed], ['z-newest', [{ project: P, reason: 'checkout-released', holder: { issueId: 'x', runId: 'rx' } }]])
    t.ok('a ready row is kept over blocked ones when shown', shownQueue(free).rows.some((r) => r.id === 'z-newest'))
  }

  t.section('freedSince: only an issue that waited, and only when it could start now')
  {
    const a = issue('a'), holders = { [P]: { issueId: 'x', runId: 'rx' } }
    const busy = queueObservation(await build([a], { holders }))
    const free = await build([a])
    t.eq('no earlier reading is a baseline, not news', freedSince(null, free), null)
    t.eq('nothing waited', freedSince(queueObservation(free), free), null)
    t.eq('still busy', freedSince(busy, await build([a], { holders })), null)
    t.eq('finishing', freedSince(busy, await build([a], { state: state({ finishing: true }) })), null)
    t.eq('no starts left', freedSince(busy, await build([a], { state: state({ starts: 10 }) })), null)
    const prereq = queueObservation(await build([issue('w', { dependsOn: on('d') }), issue('d', { latestRun: { runId: 'r', status: 'completed' } })]))
    const settledQueue = await build([issue('w', { dependsOn: on('d') }), issue('d', { latestRun: { runId: 'r', status: 'completed' }, disposition: { value: 'resolved' } })])
    t.eq('a prerequisite settling', freedSince(prereq, settledQueue)?.freed, [{ project: P, reason: 'dependency-settled' }])
    const limits = { maxRuns: 10, maxConcurrent: 1, maxStartsPerIssue: 2 }
    const full = queueObservation(await build([a], { state: state({ limits, launches: [{ project: 'x', issueId: 'y', status: 'reserved' }] }) }))
    t.eq('a concurrency slot', freedSince(full, await build([a], { state: state({ limits }) }))?.freed, [{ project: P, reason: 'concurrency-freed' }])
    const rerun = issue('d', { latestRun: { runId: 'r', status: 'blocked' } })
    const rerunBusy = queueObservation(await build([rerun], { holders }))
    t.eq('an issue with an ended run is not offered', freedSince(rerunBusy, await build([rerun])), null)
    const refused = { [`${P}/d`]: 'now' }
    t.eq('unless a start of it was refused as occupied', freedSince(rerunBusy, await build([rerun], { refused }), { refused })?.next.id, 'd')
  }

  t.section('a reading is identified by what it says, not when it was taken')
  {
    const one = await build([issue('a')], { now: 1000 }), two = await build([issue('a')], { now: 2000 })
    t.eq('time changes nothing', queueFingerprint(shownQueue(one)), queueFingerprint(shownQueue(two)))
    t.ok('a change does', queueFingerprint(shownQueue(one)) !== queueFingerprint(shownQueue(await build([issue('a'), issue('b')]))))
  }
}
