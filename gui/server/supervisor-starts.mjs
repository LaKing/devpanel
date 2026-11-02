import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { admits, describeRefusal } from './runtime/spending-policy.mjs'

const live = ['pending', 'preflighting', 'running', 'stopping']
const fail = (message) => Object.assign(new Error(message), { status: 409 })
// Refused for what is occupied right now: the identical start may pass later, so it is never guarded or charged.
const occupied = (message) => Object.assign(fail(message), { started: false, retryable: true })
const issueKey = (p) => `${p.project}/${p.issueId}`
const failureKey = (p, key) => JSON.stringify([p.project, p.issueId, key])
export const concurrentStarts = (state) => (state.launches ?? []).filter((a) => ['reserved', 'uncertain'].includes(a.status) || (a.status === 'started' && live.includes(a.runStatus))).length

export const STATE_VERSION = 2

/** Historical usage is kept, never enforced. Session counters are what decide. */
export const emptyHistory = () => ({ sessions: 0, starts: 0, startsByIssue: {}, calls: 0 })

export function accumulateHistory (history, session) {
  const next = { ...emptyHistory(), ...(history ?? {}), startsByIssue: { ...(history?.startsByIssue ?? {}) } }
  next.sessions += 1
  next.starts += session.starts ?? 0
  next.calls += session.calls ?? 0
  for (const [key, count] of Object.entries(session.startsByIssue ?? {})) next.startsByIssue[key] = (next.startsByIssue[key] ?? 0) + count
  return next
}

/*
 * Two migrations, in order.
 *
 * Version 1: old counters described the most recent activation while ownedRuns
 * outlived it. Recover all known starts (including archived conversations)
 * without inventing an exact history for attempts the old format did not preserve.
 *
 * Version 2: run starts, starts per issue and failed-launch guards are SESSION
 * limits now, and New session is the boundary. The version-1 counters were
 * lifetime sums over every archived conversation, so they cannot serve as this
 * session's usage: they move into `history` (accounting, never a gate) and the
 * session's own usage is read back from its launch records — every launch made
 * since the last New session is still in `launches`, because a session never
 * retires its own.
 */
export async function migrateStartLimits (state, dir) {
  let changed = false
  if (state.startBudgetVersion !== 1 && state.startBudgetVersion !== STATE_VERSION) { await migrateToV1(state, dir); changed = true }
  if (state.startBudgetVersion === 1) { migrateToV2(state); changed = true }
  return changed
}

function migrateToV2 (state) {
  const since = state.reset?.at ?? null
  const own = (state.launches ?? []).filter((a) => !a.migrated && typeof a.at === 'string' && (!since || a.at >= since))
  const startsByIssue = {}
  for (const a of own) startsByIssue[issueKey(a)] = (startsByIssue[issueKey(a)] ?? 0) + 1
  state.history = { ...emptyHistory(), sessions: 0, starts: state.starts ?? 0, startsByIssue: { ...(state.startsByIssue ?? {}) }, calls: 0 }
  state.starts = own.length
  state.startsByIssue = startsByIssue
  state.failedLaunches ??= {}
  state.startBudgetVersion = STATE_VERSION
  state.startLimitMigration = { ...(state.startLimitMigration ?? {}), sessionScope: { at: new Date().toISOString(), note: 'Lifetime counters moved into history; this session\'s usage was read back from its own launch records. Nothing here decides admission any more except the session counters.' } }
}

async function migrateToV1 (state, dir) {
  const sources = [state]
  for (const file of (await fs.readdir(dir)).filter((f) => /^state\..+\.json$/.test(f))) {
    sources.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')))
  }
  const owned = new Map()
  const uncertain = new Map()
  const counts = {}
  let starts = 0
  for (const source of [...sources.slice(1), state]) {
    starts += source.starts ?? 0
    for (const [key, count] of Object.entries(source.startsByIssue ?? {})) counts[key] = (counts[key] ?? 0) + count
    for (const r of source.ownedRuns ?? []) owned.set(JSON.stringify([r.project, r.issueId, r.runId]), r)
    const action = source.pending?.kind === 'action' ? source.pending.action : null
    if (action?.type === 'start_run' && action.project && action.issueId) {
      const p = source.previews?.[action.previewId] ?? { project: action.project, issueId: action.issueId }
      const identity = JSON.stringify([source.pending, p])
      uncertain.set(identity, { id: crypto.randomUUID(), ...p, status: 'uncertain', inputKey: null, migrated: true, error: 'Legacy launch was interrupted without an attributable receipt' })
    }
  }
  const ownedCounts = {}
  for (const r of owned.values()) ownedCounts[issueKey(r)] = (ownedCounts[issueKey(r)] ?? 0) + 1
  for (const r of uncertain.values()) ownedCounts[issueKey(r)] = (ownedCounts[issueKey(r)] ?? 0) + 1
  for (const [key, count] of Object.entries(ownedCounts)) counts[key] = Math.max(counts[key] ?? 0, count)
  state.startsByIssue = counts
  state.starts = Math.max(starts, owned.size + uncertain.size, Object.values(counts).reduce((a, b) => a + b, 0))
  state.ownedRuns = [...owned.values()]
  state.launches = state.ownedRuns.map((r) => ({ id: crypto.randomUUID(), ...r, status: live.includes(r.status) ? 'started' : 'finished', runStatus: r.status, inputKey: null, migrated: true }))
  state.launches.push(...uncertain.values())
  state.failedLaunches = {}
  state.activationStarts = 0
  state.startBudgetVersion = 1
  state.startLimitMigration = { at: new Date().toISOString(), knownStarts: state.starts, note: 'Includes retained and archived ownership. Historical attempts missing from both counters and ownership cannot be reconstructed.' }
}

/** Admission and reservation share one queue; the launch itself may run concurrently. */
export function createStartGate ({ getState, save, tools, stopping = () => false, ledger = null, policy = { active: false }, clock = { now: () => Date.now() } }) {
  let queue = Promise.resolve()
  const serial = (fn) => { const result = queue.then(fn); queue = result.catch(() => {}); return result }

  /**
   * Close a reservation with what the run really cost.
   *
   * An unpriced provider settles as unknown rather than as zero: a run nobody
   * could price is not a free run, and the unpriced allowance is what bounds it.
   */
  async function settleRun (attempt, run) {
    if (!ledger || !attempt.reservationId) return
    const costUsd = run?.budgets?.used?.costUsd
    try {
      await ledger.settle({
        id: attempt.reservationId,
        costUsd: typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : null,
        at: clock.now(),
        meta: { runId: attempt.runId ?? null, status: run?.status ?? null }
      })
      delete attempt.settleError
    } catch (error) {
      // Settling twice is the ledger's own guard and means the work is done.
      // Anything else is a write that failed: the reservation stays outstanding,
      // so the window keeps holding the money, and the reason is on the attempt
      // rather than lost.
      if (/already settled|was released/.test(error.message)) return
      attempt.settleError = error.message
    }
  }

  function recordFailure (state, attempt, reason) {
    if (attempt.inputKey == null) return
    state.failedLaunches[failureKey(attempt, attempt.inputKey)] = { launchId: attempt.id, runId: attempt.runId ?? null, reason, at: new Date().toISOString() }
  }

  function returnCharge (state, attempt) {
    const key = issueKey(attempt)
    state.starts = Math.max(0, state.starts - 1)
    state.activationStarts = Math.max(0, (state.activationStarts ?? 0) - 1)
    if ((state.startsByIssue[key] ?? 0) > 1) state.startsByIssue[key]--
    else delete state.startsByIssue[key]
    attempt.chargeReturned = true
  }

  async function refresh (state) {
    // One unreadable run keeps its own slot (below) but does not stop the others being refreshed; the
    // failures are thrown together once every attempt has been read.
    const failures = []
    for (const attempt of state.launches) {
      try { await refreshAttempt(state, attempt) } catch (error) { failures.push(`${attempt.runId}: ${error.message}`) }
    }
    if (failures.length) throw fail(`Cannot establish the state of owned runs: ${failures.join('; ')}`)
  }

  async function refreshAttempt (state, attempt) {
    if (!['started', 'finished'].includes(attempt.status)) return
    // An unreadable run is not evidence that a concurrent slot is free.
    let run
    try { run = await tools.getRun(attempt.project, attempt.issueId, attempt.runId) } catch (error) {
      if (attempt.status === 'finished') return
      if (error.status === 404 || error.code === 'ENOENT') {
        if (await tools.wasDeleted?.(attempt)) {
          attempt.status='finished'; attempt.runStatus='deleted'; attempt.retirement={at:new Date().toISOString(),reason:'Verified issue deletion receipt'}
          const owned=state.ownedRuns.find(r=>r.runId===attempt.runId && issueKey(r)===issueKey(attempt))
          if(owned)owned.status='deleted'
        } else {
          attempt.status='uncertain'; attempt.error='Previously started run is missing; reconcile its retirement before releasing this slot'
        }
        return
      }
      throw error
    }
    if (!run?.status) throw fail(`Cannot establish the state of owned run ${attempt.runId}`)
    attempt.runStatus = run.status
    const owned = state.ownedRuns.find((r) => r.runId === attempt.runId && r.project === attempt.project && r.issueId === attempt.issueId)
    if (owned) owned.status = run.status
    const failure = ['failed', 'blocked'].includes(run.status) ? (run.blockedReason ?? run.status) : null
    // A preflight refused only for want of proof (a probe timed out) is not a fact about the inputs, so
    // the same start may succeed and is not guarded; maxStartsPerIssue still bounds the retries.
    const unproven = failure === 'preflight-refused' && run.preflight?.counts?.failures === 0 && run.preflight.counts.unproven > 0
    if (failure && !unproven && attempt.failureObserved !== failure) recordFailure(state, attempt, failure)
    attempt.failureObserved = failure
    if (!live.includes(run.status)) {
      // A run that has stopped has a final cost. Settling here, where its
      // outcome is first observed, keeps the window's committed money equal to
      // what was actually spent rather than to what was feared.
      if (attempt.status !== 'finished') await settleRun(attempt, run)
      attempt.status = 'finished'
    } else attempt.status = 'started'
  }

  return {
    // Saved even when one launch could not be read: the others' refreshed state must not be lost with it.
    refresh: () => serial(async () => { try { await refresh(getState()) } finally { await save() } }),
    start: async (preview) => {
      const attempt = await serial(async () => {
        const state = getState()
        if (stopping() || state.finishing) throw occupied('Supervisor is stopping or finishing; no further starts')
        await refresh(state)
        await save()
        const key = issueKey(preview)
        /*
         * Two kinds of limit, separated by what they protect.
         *
         * Session limits (maxRuns, maxStartsPerIssue) bound what one conversation
         * may start; an operator's New session is the only thing that opens a
         * fresh allowance, so Start and a server restart resume the same one.
         * Spending windows, when a policy is on disk, bound money and starts per
         * UTC day and month regardless of sessions, because they describe
         * spending over calendar time. Both gate; neither is a lifetime cap.
         */
        if (state.starts >= state.limits.maxRuns) throw fail(`Session run-start limit reached: ${state.starts} of ${state.limits.maxRuns} starts used this session. Raise maxRuns on Start or begin a New session.`)
        if ((state.startsByIssue[key] ?? 0) >= state.limits.maxStartsPerIssue) throw fail(`Start limit reached for this issue: ${state.startsByIssue[key]} of ${state.limits.maxStartsPerIssue} starts used this session. Raise maxStartsPerIssue on Start or begin a New session.`)
        if (policy.active) {
          const usage = ledger.usage(clock.now())
          const verdict = admits({
            policy: policy.policy, usage, subject: 'run-start',
            maxCostUsd: preview.maxCostUsd ?? null,
            concurrent: concurrentStarts(state)
          })
          if (!verdict.ok) throw Object.assign(fail(`Refused by ${verdict.limit}: ${describeRefusal(verdict)}`), { limit: verdict.limit, until: verdict.until, ...(verdict.limit === 'concurrent' ? { started: false, retryable: true } : {}) })
        }
        if (state.launches.some((a) => ['reserved', 'uncertain'].includes(a.status) && issueKey(a) === key)) throw fail('This issue has an unresolved launch reservation; reconcile it before retrying')
        if (concurrentStarts(state) >= state.limits.maxConcurrent) throw occupied('Concurrent-run limit reached, including pending launch reservations')
        const condition = tools.launchState ? await tools.launchState(preview) : { key: preview.configHash }
        // The condition classified itself; pass that on, or the supervisor is told
        // only that something is wrong and not whether it may act on it.
        if (condition.blockedReason) throw Object.assign(fail(`Launch condition unresolved: ${condition.blockedReason}`), { started: false, ...(condition.code ? { code: condition.code } : {}), ...(condition.resolvableBy ? { resolvableBy: condition.resolvableBy } : {}) })
        const inputKey = condition.key
        if (typeof inputKey !== 'string' || !inputKey) throw fail('Cannot establish launch input state')
        const previous = state.failedLaunches[failureKey(preview, inputKey)]
        if (previous) throw fail(`Unchanged failed launch is blocked: ${previous.reason}. Resolve the condition or change the relevant launch inputs before retrying.`)
        if (stopping() || state.finishing) throw occupied('Supervisor stopping')
        const reservation = { id: crypto.randomUUID(), ...preview, inputKey, status: 'reserved', activationId: state.activationId, at: new Date().toISOString() }
        // Committed before the external call, so a crash between the two leaves
        // the money held rather than spendable twice. The ledger id is the
        // launch's own id: one reservation, one attempt, no way to double-count.
        if (ledger) {
          await ledger.reserve({ id: reservation.id, subject: 'run-start', at: clock.now(), maxCostUsd: preview.maxCostUsd ?? null, meta: { project: preview.project, issueId: preview.issueId, playbook: preview.playbook ?? null } })
          reservation.reservationId = reservation.id
        }
        state.starts++
        state.activationStarts = (state.activationStarts ?? 0) + 1
        state.startsByIssue[key] = (state.startsByIssue[key] ?? 0) + 1
        state.launches.push(reservation)
        // Persisted before the external operation; a crash never refunds it, and
        // only a start positively refused for occupancy does (returnCharge).
        await save()
        return reservation
      })
      let result
      try {
        if (stopping() || getState().finishing) throw occupied('Supervisor stopped before launch')
        result = await tools.start({ ...preview, launchId: attempt.id })
        if (!result?.runId || !result.status) throw new Error('Launch returned no attributable run')
      } catch (error) {
        await serial(async () => {
          const state = getState()
          // Only positive non-start evidence releases concurrency. Unknown
          // outcomes retain their reservation across restarts and New session.
          attempt.status = error.started === false ? 'failed' : 'uncertain'
          attempt.error = error.message
          if (!error.retryable) recordFailure(state, attempt, error.message)
          // Refused for momentary occupancy: nothing started and nothing is wrong with
          // the inputs, so the attempt gives back the charge taken at reservation.
          // Otherwise repeated refusals would use up the start they only delayed.
          else if (error.started === false) returnCharge(state, attempt)
          // A definite non-start spent nothing, so the window gets it back — with
          // the reason on the record. An UNCERTAIN outcome does not: nobody knows
          // whether it is running, and the honest accounting is that the money is
          // still committed until a person reconciles it.
          if (ledger && attempt.reservationId && error.started === false) {
            await ledger.release({ id: attempt.reservationId, reason: `the start did not happen: ${error.message}`, at: clock.now() }).catch(() => {})
          }
          await save()
        })
        throw error
      }
      await serial(async () => {
        const state = getState()
        attempt.status = 'started'
        attempt.runId = result.runId
        attempt.runStatus = result.status
        // observedStatus is the monitoring poll's own baseline, set here because refresh() rewrites `status`.
        // The settle timer runs refresh() while a supervisor call is in flight (status 'working') and the poll
        // is not, so a run that ended during that call would otherwise already read as seen and never wake it.
        state.ownedRuns.push({ project: preview.project, issueId: preview.issueId, runId: result.runId, status: result.status, observedStatus: result.status, launchId: attempt.id })
        await save()
      })
      return result
    },
    // Operator-only reconciliation. It releases or attributes concurrency but
    // never refunds session or per-issue usage and is not an agent action.
    reconcile: ({ launchId, runId = null, notStarted = false, retired = false, reason }) => serial(async () => {
      const state = getState()
      if (typeof reason !== 'string' || !reason.trim()) throw fail('Reconciliation requires evidence in reason')
      if (typeof notStarted !== 'boolean' || (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)))) throw fail('Invalid reconciliation outcome')
      const attempt = state.launches.find((a) => a.id === launchId)
      if (typeof retired !== 'boolean') throw Object.assign(new Error('retired must be a boolean'), { status: 422 })
      if (retired) {
        if (!attempt?.runId || !['started','uncertain'].includes(attempt.status) || runId || notStarted) throw fail('Retirement requires a missing previously started run')
        try { await tools.getRun(attempt.project,attempt.issueId,attempt.runId); throw fail('Run still exists; use its normal lifecycle') }
        catch(error) { if(error.status!==404 && error.code!=='ENOENT')throw error }
        attempt.status='finished'; attempt.runStatus='retired'; attempt.retirement={at:new Date().toISOString(),reason}
        const owned=state.ownedRuns.find(r=>r.runId===attempt.runId && issueKey(r)===issueKey(attempt))
        if(owned)owned.status='retired'
        await save(); return attempt
      }
      if (!attempt || !['reserved', 'uncertain'].includes(attempt.status)) throw fail('No unresolved reservation with that launchId')
      if (Boolean(runId) === Boolean(notStarted)) throw fail('Name the resulting run or explicitly confirm notStarted')
      if (runId) {
        const run = await tools.getRun(attempt.project, attempt.issueId, runId)
        if (!run?.status) throw fail('Resulting run was not found')
        if (!attempt.migrated && run.supervisorLaunchId !== launchId) throw fail('That run does not carry this launch reservation identifier')
        if (state.launches.some((a) => a !== attempt && a.runId === runId && a.project === attempt.project && a.issueId === attempt.issueId)) throw fail('That run is already attributed to another reservation')
        attempt.status = 'started'; attempt.runId = runId; attempt.runStatus = run.status
        state.ownedRuns.push({ project: attempt.project, issueId: attempt.issueId, runId, status: run.status, observedStatus: run.status, launchId: attempt.id })
      } else attempt.status = 'failed'
      attempt.reconciliation = { reason, notStarted, runId, at: new Date().toISOString() }
      await save()
      return structuredClone(attempt)
    }),
    retry: ({ launchId, reason }) => serial(async () => {
      if (typeof reason !== 'string' || !reason.trim()) throw fail('A retry disposition requires evidence in reason')
      const state = getState()
      const attempt = state.launches.find((a) => a.id === launchId)
      if (!attempt || !['failed', 'finished'].includes(attempt.status)) throw fail('Reconcile an unresolved launch before authorizing a retry')
      if (!Object.values(state.failedLaunches).some((f) => f.launchId === launchId)) throw fail('No failed-input guard exists for this launch')
      const condition = tools.launchState ? await tools.launchState(attempt) : { key: attempt.inputKey }
      if (condition.blockedReason) throw fail(`Launch condition unresolved: ${condition.blockedReason}`)
      for (const [key, value] of Object.entries(state.failedLaunches)) if (value.launchId === launchId) delete state.failedLaunches[key]
      attempt.retryDispositions ??= []
      attempt.retryDispositions.push({ reason, at: new Date().toISOString() })
      await save()
      return structuredClone(attempt)
    })
  }
}
