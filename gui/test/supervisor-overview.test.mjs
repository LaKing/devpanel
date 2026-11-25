import { buildOverview } from '../server/supervisor-overview.mjs'

export const name = 'management plane — one panel-wide reading, and priority as an audited decision'

const NOW = Date.parse('2026-09-15T00:00:00.000Z')
const day = (n) => new Date(NOW - n * 86_400_000).toISOString()

/** A run record reduced to what an overview reads. */
const run = (o) => ({
  runId: o.runId ?? 'r', status: o.status, outcome: o.outcome ?? null,
  playbook: { id: o.playbook ?? 'implementation', version: o.version ?? 2, intent: o.intent ?? null, configHash: o.configHash ?? 'sha256:aaaaaaaaaaaabbbb' },
  participants: o.participants ?? { implementer: { model: 'deepseek-flash' } },
  startedAt: o.startedAt ?? day(2), endedAt: o.endedAt ?? day(2),
  budgets: { used: o.used ?? {} },
  ...(o.recovery ? { recovery: o.recovery } : {}),
  ...(o.blockedReason ? { blockedReason: o.blockedReason } : {})
})

const issue = (o) => ({
  id: o.id, name: o.id, path: `/fake/${o.id}`, project: o.project ?? 'alpha-project',
  openedAt: day(o.ageDays ?? 1), openedOn: day(o.ageDays ?? 1).slice(0, 10),
  status: 'open', archived: Boolean(o.archived),
  disposition: o.disposition ? { value: o.disposition } : null,
  priority: o.priority ? { value: o.priority, reason: 'because', by: 'supervisor' } : null
})

export default async function (t) {
  const world = {
    'alpha-project': {
      open: [
        issue({ id: 'old-unset', ageDays: 30 }),
        issue({ id: 'new-urgent', ageDays: 1, priority: 'urgent' }),
        issue({ id: 'mid-low', ageDays: 10, priority: 'low' }),
        issue({ id: 'decided', ageDays: 5, priority: 'normal', disposition: 'resolved' })
      ],
      archived: [issue({ id: 'put-away', archived: true, disposition: 'not-resolved' })]
    },
    'beta-project': { open: [issue({ id: 'lonely', project: 'beta-project', ageDays: 3 })], archived: [] }
  }
  const runs = {
    '/fake/old-unset': [run({ status: 'completed', outcome: 'resolved', used: { costUsd: 1.5, tokens: 100 } })],
    '/fake/new-urgent': [run({ status: 'running' }), run({ status: 'paused' })],
    '/fake/mid-low': [run({ status: 'failed', outcome: 'unresolved' }), run({ status: 'completed', outcome: 'unresolved' })],
    '/fake/decided': [run({ status: 'blocked', outcome: 'unresolved', blockedReason: 'recovery-required' })],
    // Archived work is still history. A "record of past runs" that omits what was
    // put away is exactly the record that omits everything finished.
    '/fake/put-away': [run({ status: 'completed', outcome: 'resolved', playbook: 'triage', used: {} })],
    '/fake/lonely': []
  }
  const overview = await buildOverview({
    projects: ['alpha-project', 'beta-project'],
    focus: ['beta-project'],
    listIssues: async (project, { archived = false } = {}) => world[project]?.[archived ? 'archived' : 'open'] ?? [],
    readRuns: async (issuePath) => runs[issuePath] ?? [],
    now: NOW
  })

  t.section('1. a rate never hides its fraction, and never counts work still in flight')
  {
    const all = overview.totals.runs
    t.eq('every run is counted', all.total, 7)
    t.eq('but the two in flight are not terminal', [all.live, all.paused, all.terminal], [1, 1, 5])
    t.eq('the denominator is terminal runs only', all.successRate.total, 5)
    t.eq('with its numerator beside it', all.successRate.of, 2)
    t.eq('and the percentage derived from both', all.successRate.percent, 40)
    t.ok('naming what it counts', /completed AND resolved/.test(all.successRate.means), all.successRate.means)
    t.eq('a completed-but-unresolved run is not a success, and is counted as itself', all.completedUnresolved, 1)
    t.eq('failed, blocked and cancelled are separate counts', [all.failed, all.blocked, all.cancelled], [1, 1, 0])
    t.eq('a run whose true state is unknown is counted as interrupted', all.interrupted, 1)
  }

  t.section('2. unknown cost stays unknown instead of being averaged into zero')
  {
    const cost = overview.totals.runs.cost
    t.eq('only priced runs contribute to the total', cost.usd, 1.5)
    t.eq('and the unpriced ones are counted as unpriced', [cost.priced, cost.unpriced], [1, 4])
    t.eq('duration is measured only where both ends are known', overview.totals.runs.durationMs.counted, 5)
    t.eq('nothing estimated in old records, no partial run among them', [cost.estimatedUsd, cost.estimatedSteps, cost.partial], [0, 0, 0])
  }

  t.section('2b. reported, estimated and unknown cost apart; a partially priced run is not priced')
  {
    const priced = await buildOverview({
      projects: ['alpha-project'],
      listIssues: async (project, { archived = false } = {}) => archived ? [] : [issue({ id: 'costs' })],
      readRuns: async () => [
        run({ runId: 'reported', status: 'completed', outcome: 'resolved', used: { costUsd: 2 } }),
        run({ runId: 'partial', status: 'completed', outcome: 'resolved', used: { costUsd: 1, estimatedCostUsd: 0.25, costEstimatedSteps: 1, costUnknownSteps: 2 } }),
        run({ runId: 'estimated', status: 'completed', outcome: 'resolved', used: { estimatedCostUsd: 0.5, costEstimatedSteps: 4 } }),
        run({ runId: 'probe-only', status: 'failed', outcome: 'unresolved', used: { costUsd: 0, costUnknownSteps: 1 } })
      ],
      now: NOW
    })
    const cost = priced.totals.runs.cost
    t.eq('reported and estimated money are summed apart', [cost.usd, cost.estimatedUsd], [3, 0.75])
    t.eq('unknown and estimated steps are counted apart', [cost.unpricedSteps, cost.estimatedSteps], [3, 5])
    t.eq('priced, partial and unpriced runs', [cost.priced, cost.partial, cost.unpriced], [2, 1, 1])
  }

  t.section('3. a run\'s outcome is not the issue\'s state')
  {
    t.eq('dispositions are counted as themselves', Object.entries(overview.issues.dispositions).sort(), [['not-resolved', 1], ['resolved', 1], ['undecided', 4]])
    t.eq('resolution is over decided issues, not over all of them', [overview.issues.resolutionRate.of, overview.issues.resolutionRate.total], [1, 2])
    t.ok('and says that undecided issues count neither way', /not counted either way/.test(overview.issues.resolutionRate.means))
    t.ok('the two are never merged into one number', overview.issues.resolutionRate.percent !== overview.totals.runs.successRate.percent)
  }

  t.section('4. the backlog is ordered for a manager: decided order first, then what nobody has ordered')
  {
    const alpha = overview.projects.find((p) => p.project === 'alpha-project')
    t.eq('priority decides the order', alpha.openIssues.map((i) => i.id), ['new-urgent', 'decided', 'mid-low', 'old-unset'])
    t.eq('the oldest unset issue is last but visible, not buried', alpha.openIssues.at(-1).ageDays, 30)
    t.eq('unset is reported as unset, never as low', Object.entries(overview.issues.priorities).sort(), [['low', 1], ['normal', 1], ['unset', 2], ['urgent', 1]])
    t.eq('and how much of the backlog nobody has ordered is a number', overview.totals.unprioritised, 2)
    t.ok('with the reason and author of each decision', alpha.openIssues[0].priorityReason === 'because' && alpha.openIssues[0].priorityBy === 'supervisor')
  }

  t.section('5. focus orders the reading; it never removes anything from it')
  {
    t.eq('both projects are present', overview.projects.map((p) => p.project), ['beta-project', 'alpha-project'])
    t.eq('the focused one is marked and first', [overview.projects[0].project, overview.projects[0].focused], ['beta-project', true])
    t.ok('the unfocused one keeps all its detail', overview.projects[1].openIssues.length === 4)
    const triage = Object.entries(overview.byPlaybook).find(([k]) => k.startsWith('triage · '))
    t.eq('archived work is counted and its runs are in the history', [overview.totals.archivedIssues, triage?.[1]?.total], [1, 1])
  }

  t.section('5a. every group carries its convergence measurements, kept apart')
  {
    const m = overview.totals.runs.metrics
    t.eq('terminal runs are measured', m.measured, 5)
    t.ok('agent time, operator wait and suspended time are separate fields', ['agentMs', 'operatorWaitMs', 'suspendedMs'].every((k) => typeof m[k] === 'number'))
    t.ok('rounds and restarts are separate fields', 'cycleRestarts' in m && 'ignoredRestartRequests' in m && 'planReviewRoundExecutions' in m)
    t.eq('runs without a plan phase do not fake a plan round', m.planReviewRoundExecutions.counted, 0)
    t.ok('and the reading says how to use it', /same configuration/.test(overview.means.metrics))
    const seatGroup = Object.values(overview.bySeat)[0]
    t.ok('a seat group carries the seat\'s own effort apart from the cohort figures', seatGroup.metrics.seat && typeof seatGroup.metrics.seat.agentMs === 'number' && /participation cohort/.test(seatGroup.metrics.means), JSON.stringify(seatGroup.metrics.seat))
    t.eq('a group that is not a seat has no seat figures', overview.totals.runs.metrics.seat, null)
  }

  t.section('5b. an edited playbook starts a new group instead of rewriting old statistics')
  {
    // Same id, same version number — a version nobody remembered to raise — but
    // a different resolved configuration. Merging these would make an edit
    // retroactively change what the earlier runs were runs of.
    const edited = await buildOverview({
      projects: ['alpha-project'],
      listIssues: async (project, { archived = false } = {}) => archived ? [] : [issue({ id: 'one' }), issue({ id: 'two' })],
      readRuns: async (issuePath) => issuePath.endsWith('one')
        ? [run({ status: 'completed', outcome: 'resolved', configHash: 'sha256:1111111111111111' })]
        : [run({ status: 'failed', outcome: 'unresolved', configHash: 'sha256:2222222222222222' })],
      now: NOW
    })
    const keys = Object.keys(edited.byPlaybook)
    t.eq('two configurations, two groups', keys.length, 2)
    t.ok('each named by the configuration it counts', keys.every((k) => /config [0-9a-f]{12}$/.test(k)), keys.join(' | '))
    t.ok('and they are not merged into one rate', Object.values(edited.byPlaybook).every((g) => g.terminal === 1), JSON.stringify(keys))

    const unrecorded = await buildOverview({
      projects: ['alpha-project'],
      listIssues: async (project, { archived = false } = {}) => archived ? [] : [issue({ id: 'old' })],
      // A run from before the hash was recorded, with no snapshot to read it from.
      readRuns: async () => [{ ...run({ status: 'completed', outcome: 'resolved' }), playbook: { id: 'implementation', version: 2, intent: null } }],
      now: NOW
    })
    t.ok('a run whose configuration cannot be established says so', Object.keys(unrecorded.byPlaybook).some((k) => k.endsWith('config unrecorded')), Object.keys(unrecorded.byPlaybook).join(' | '))
  }

  t.section('5c. deliveries by the engine and landings by hand are counted apart')
  {
    const landed = (by, at) => ({ by, applied: 'the patch', commit: 'abc1234', checkout: null, handChanges: 'none', landedAt: at, recordedAt: at })
    const delivered = (o, delivery) => ({ ...run(o), revisions: [{ fingerprint: 'r' }], delivery })
    const world = {
      'gamma-project': {
        open: [issue({ id: 'umbrella', project: 'gamma-project', ageDays: 20 }), issue({ id: 'engine-only', project: 'gamma-project' })],
        archived: [{ ...issue({ id: 'packed-away', project: 'gamma-project', archived: true, disposition: 'resolved' }), packed: true }]
      }
    }
    const runs = {
      // An umbrella issue worked in batches: one patch landed by hand inside the
      // week, one landed long ago, one batch blocked and never landed.
      '/fake/umbrella': [
        { ...delivered({ runId: 'b1', status: 'completed', outcome: 'resolved', startedAt: day(15), endedAt: day(15) }, { action: 'worktree-diff', completedAt: day(15) }), landed: landed('alice', day(14)) },
        { ...delivered({ runId: 'b2', status: 'blocked', outcome: 'unresolved', blockedReason: 'source-delivery-blocked' }, { action: 'apply-to-source', completedAt: null }), landed: landed('supervisor', day(1)) },
        delivered({ runId: 'b3', status: 'failed', outcome: 'unresolved' }, null)
      ],
      '/fake/engine-only': [delivered({ runId: 'e1', status: 'completed', outcome: 'resolved' }, { action: 'apply-to-source', completedAt: day(2) })]
    }
    const packed = { 'packed-away': [{ ...delivered({ runId: 'p1', status: 'completed', outcome: 'resolved' }, { action: 'worktree-diff', completedAt: day(3) }), landed: landed('alice', day(3)) }] }
    const o = await buildOverview({
      projects: ['gamma-project'],
      listIssues: async (project, { archived = false } = {}) => world[project]?.[archived ? 'archived' : 'open'] ?? [],
      readRuns: async (issuePath) => runs[issuePath] ?? [],
      readPackedRuns: async (_project, id) => packed[id] ?? [],
      now: NOW
    })
    const g = o.projects[0]
    t.eq('each terminal run counts once, a landed patch as the landing', [g.runs.delivered.engine, g.runs.delivered.manual], [1, 3])
    t.eq('the delivery rate shows both kinds beside its fraction', [g.runs.deliveryRate.of, g.runs.deliveryRate.total, g.runs.deliveryRate.engine, g.runs.deliveryRate.manual], [4, 5, 1, 3])
    t.eq('flow7d counts issues by how they were delivered inside the week, the packed one included', [g.flow7d.deliveredIssues, g.flow7d.delivered.engine, g.flow7d.delivered.manual], [3, 1, 2])
    const umbrella = g.openIssues.find((l) => l.id === 'umbrella')
    t.eq('an open umbrella issue lists its landed batches', umbrella.delivered.map((d) => [d.runId, d.kind, d.by]), [['b1', 'manual', 'alice'], ['b2', 'manual', 'supervisor']])
    t.eq('and an engine delivery names its action', g.openIssues.find((l) => l.id === 'engine-only').delivered, [{ runId: 'e1', kind: 'engine', at: day(2), action: 'apply-to-source' }])
    t.eq('the panel totals keep the archived landing', o.totals.runs.delivered.manual, 3)
  }

  t.section('6. results are grouped by what actually varies between runs')
  {
    t.ok('playbook groups carry version, intent and the exact configuration', Object.keys(overview.byPlaybook).every((k) => /· v\d+ · .* · config /.test(k)), Object.keys(overview.byPlaybook).join(' | '))
    t.ok('seats are grouped by role and model', Object.keys(overview.bySeat).includes('implementer · deepseek-flash'), Object.keys(overview.bySeat).join(' | '))
    t.eq('each group carries its own fraction', overview.bySeat['implementer · deepseek-flash'].successRate.total, 5)
  }

  t.section('7. priority is an audited decision on disk, not a label')
  {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-priority-'))
    process.env.DEVPANEL_ISSUES_DIR = dir
    const issues = await import(`../server/issues.js?priority=${Date.now()}`)
    const project = (await issues.listProjects())[0]?.id
    if (!project) { t.skip('an audited priority round-trip', 'no project directory on this host'); return }
    const opened = await issues.createIssue(project, { name: 'Priority fixture' })

    t.eq('a new issue carries no decision anybody made', opened.priority, null)
    for (const [label, args] of [
      ['an invented level', { value: 'whenever', reason: 'x' }],
      ['a level with no reason', { value: 'high', reason: '   ' }],
      // A coordinator may RECOMMEND a priority in its result; the order of the
      // company's work is not something a run rewrites from inside itself.
      ['an author other than a person or the supervisor', { value: 'high', reason: 'x', by: 'coordinator' }]
    ]) {
      let refused = null
      try { await issues.setIssuePriority(project, opened.id, args) } catch (e) { refused = e.message }
      t.ok(`${label} is refused`, Boolean(refused), refused ?? 'accepted')
    }

    const set = await issues.setIssuePriority(project, opened.id, { value: 'high', reason: 'Customer-facing regression', by: 'supervisor' })
    t.eq('the decision is recorded with its author and reason', [set.priority.value, set.priority.by, set.priority.reason], ['high', 'supervisor', 'Customer-facing regression'])
    t.ok('and when it was taken', Number.isFinite(Date.parse(set.priority.at ?? '')), set.priority.at)
    t.eq('with nothing before it', set.priority.previous, null)

    const changed = await issues.setIssuePriority(project, opened.id, { value: 'low', reason: 'Customer moved off the feature' })
    t.eq('a reordering keeps what it replaced, so it reads as a decision', changed.priority.previous?.value, 'high')
    t.eq('and the new author', changed.priority.by, 'operator')

    // The trail is the record. One "previous" value would mean the third
    // decision erased the first, and "who keeps moving this" would be
    // unanswerable from disk.
    const third = await issues.setIssuePriority(project, opened.id, { value: 'urgent', reason: 'Regression returned', by: 'supervisor' })
    t.eq('every decision is kept, in order', third.priorityHistory.map((h) => h.value), ['high', 'low', 'urgent'])
    t.eq('with each one\'s author and reason intact', third.priorityHistory.map((h) => h.by), ['supervisor', 'operator', 'supervisor'])
    t.ok('each stamped when it was taken', third.priorityHistory.every((h) => Number.isFinite(Date.parse(h.at ?? ''))))
    t.eq('the one in force is the last of them', third.priority.value, 'urgent')
    t.eq('and how often it has moved is a number', third.priority.changes, 3)
    t.eq('earlier decisions are never rewritten', third.priorityHistory[0].reason, 'Customer-facing regression')
    await fs.rm(path.join(dir, project, opened.id), { recursive: true, force: true })
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.DEVPANEL_ISSUES_DIR
  }

  t.section('8. readiness reads conditions now, takes nothing, and keeps them apart')
  {
    const { launchReadiness } = await import('../server/supervisor-readiness.mjs')
    const budget = { starts: { used: 8, limit: 2, remaining: 0, exhausted: true } }

    // The gap this closes: admission stops at the first refusal, so a
    // budget-blocked supervisor never re-reads the source and reports whichever
    // fault it last saw — here, an ownership failure fixed days ago.
    const both = await launchReadiness({
      project: 'p', issueId: 'i', projectPath: '/fake', budget, perIssueLeft: 2, now: NOW,
      inspect: async () => ({ code: 'EMPTY_REPOSITORY', message: 'no valid HEAD', remedy: 'commit the starting files', resolvableBy: 'commit-action', detail: 'refs/heads/master' })
    })
    t.eq('the budget and the repository are separate prerequisites', both.prerequisites.map((p) => p.condition), ['budget', 'repository'])
    t.eq('the repository condition is read, not remembered', both.repository.code, 'EMPTY_REPOSITORY')
    t.eq('and ownership is reported as its own fact', both.ownership.status, 'valid')
    t.ok('saying why it is not the blocker', /ownership is not what blocks it/.test(both.ownership.detail), both.ownership.detail)
    t.eq('nothing is baseline-ready while either stands', both.baselineReady, false)
    t.ok('and the reading says the conditions are independent', /does not imply a budget fault/.test(both.means))
    t.ok('an existing preview is not treated as evidence of launchability', /not a preview/.test(both.detail), both.detail)

    // An exhausted budget must not make a healthy checkout look broken.
    const budgetOnly = await launchReadiness({ project: 'p', projectPath: '/fake', budget, now: NOW, inspect: async () => null })
    t.eq('a healthy checkout reports healthy even while the budget is spent', [budgetOnly.repository.ok, budgetOnly.ownership.status], [true, 'valid'])
    t.eq('with only the budget in the way', budgetOnly.prerequisites.map((p) => p.condition), ['budget'])
    t.ok('and the way out stated: the operator\'s New session, not the supervisor', /New session/.test(budgetOnly.prerequisites[0].needs ?? ''), budgetOnly.prerequisites[0].needs)

    // And an ownership refusal is named as ownership, not as "unreadable".
    const owned = await launchReadiness({
      project: 'p', projectPath: '/fake', budget: null, now: NOW,
      inspect: async () => ({ code: 'UNSAFE_REPOSITORY', message: 'owned by another user', remedy: 'chown it', resolvableBy: 'operator' })
    })
    t.eq('git refusing the checkout is an ownership fact', owned.ownership.status, 'refused-by-git')
    t.eq('with no budget claimed either way', owned.budget, null)

    const clear = await launchReadiness({ project: 'p', projectPath: '/fake', budget: { starts: { used: 1, limit: 20, remaining: 19 } }, perIssueLeft: 2, now: NOW, inspect: async () => null })
    t.eq('nothing universal in the way reads as baseline-ready', [clear.baselineReady, clear.prerequisites.length], [true, 0])
    // Deliberately not called "runnable": the selected playbook's own base policy
    // has not been looked at, and saying runnable would be a claim about a
    // question nobody asked.
    t.eq('and no configuration is claimed either way', clear.configuration, null)
    t.ok('with the limit of the reading stated', /not launchability/.test(clear.means), clear.means)
  }

  t.section('9. naming a playbook adds its own source policy, under the hash it belongs to')
  {
    const { launchReadiness } = await import('../server/supervisor-readiness.mjs')
    const resolve = async () => ({ ok: true, resolved: { configHash: 'sha256:abc123', intent: { id: 'bugfix' }, workspace: { base: 'head' } } })
    const healthy = { project: 'p', projectPath: '/fake', budget: { starts: { used: 0, limit: 20, remaining: 20 } }, now: NOW, inspect: async () => null, resolve }

    const dirty = await launchReadiness({
      ...healthy, playbook: 'implementation',
      inspectLaunch: async () => ({ key: 'fingerprint-1', head: 'abcdef', code: 'DIRTY_BASE', resolvableBy: 'commit-action', blockedReason: 'base policy "head" requires a clean checkout' })
    })
    t.eq('the universal reading still passes', dirty.baselineReady, true)
    t.eq('while the configuration does not', dirty.configuration.ready, false)
    t.eq('named as a base-policy condition', [dirty.configuration.prerequisites[0].condition, dirty.configuration.prerequisites[0].code], ['base policy', 'DIRTY_BASE'])
    t.eq('bound to the exact configuration it was read for', [dirty.configuration.configHash, dirty.configuration.intent, dirty.configuration.base], ['sha256:abc123', 'bugfix', 'head'])

    const ok = await launchReadiness({ ...healthy, playbook: 'implementation', inspectLaunch: async () => ({ key: 'fingerprint-2', head: 'deadbee' }) })
    t.eq('a clean configuration reads ready', ok.configuration.ready, true)
    t.eq('with what the source WAS when it was read', [ok.configuration.observed.head, ok.configuration.observed.sourceFingerprint], ['deadbee', 'fingerprint-2'])
    t.ok('and when', Number.isFinite(Date.parse(ok.configuration.observedAt)))
    t.ok('still an observation, not a guarantee', /start_run re-checks every condition/.test(ok.detail), ok.detail)

    // A base policy over a checkout git cannot read has no answer; inventing one
    // would be worse than saying so.
    const unreadable = await launchReadiness({
      ...healthy, playbook: 'implementation',
      inspect: async () => ({ code: 'EMPTY_REPOSITORY', message: 'no valid HEAD', remedy: 'commit', resolvableBy: 'commit-action' }),
      inspectLaunch: async () => { throw new Error('must not be asked') }
    })
    t.eq('an unreadable repository leaves the base policy unevaluated, not passed', unreadable.configuration.ready, false)
    t.ok('and says it was not evaluated', /not evaluated/.test(unreadable.configuration.prerequisites[0].state), unreadable.configuration.prerequisites[0].state)

    const broken = await launchReadiness({ ...healthy, playbook: 'nope', resolve: async () => ({ ok: false, errors: [{ message: 'no such playbook' }] }), inspectLaunch: async () => ({}) })
    t.eq('a configuration that does not resolve is reported, not assumed', [broken.configuration.ready, broken.configuration.configHash], [false, null])
    t.ok('with the resolution error', /no such playbook/.test(broken.configuration.prerequisites[0].state))
  }
}
