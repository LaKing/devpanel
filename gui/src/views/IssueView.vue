<script setup>
import { computed, nextTick, onMounted, onUnmounted, provide, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { wallClockAt, wallClockPrefill, wallClockUsedMinutes } from '@/wall-clock'
import AddToIssue from '@/components/AddToIssue.vue'
import IssueMaterial from '@/components/IssueMaterial.vue'
import MarkdownText from '@/components/MarkdownText.vue'
import RunTimeline from '@/components/RunTimeline.vue'
import StartRunDialog from '@/components/StartRunDialog.vue'
import AssessBar from '@/components/AssessBar.vue'
import OwnerInput from '@/components/OwnerInput.vue'
import QuestionBrief from '@/components/QuestionBrief.vue'
import TurnDetail from '@/components/TurnDetail.vue'
import RunTerminal from '@/components/RunTerminal.vue'
import CoordinatorChat from '@/components/CoordinatorChat.vue'
import SupervisorQuestion from '@/components/SupervisorQuestion.vue'
import CopyPath from '@/components/CopyPath.vue'
import IssueStats from '@/components/IssueStats.vue'
import IssueFamily from '@/components/IssueFamily.vue'
import IssueOccurrences from '@/components/IssueOccurrences.vue'
import PatchCheck from '@/components/PatchCheck.vue'
import ContinueRun from '@/components/ContinueRun.vue'
import FreshnessIndicator from '@/components/FreshnessIndicator.vue'
import { api } from '@/api'
import { alertDestination, alertSections } from '@/notifications'
import { actorName, proxyUser, rememberedActor } from '@/identity'
import { readFolder, readHidden, revealSectionState, sectionShown, toggleSectionState, writeFolder, writeHidden } from '@/issue-sections'
import { reportTags } from '@/report-tags'
import { connection, socket } from '@/socket'
import { offers, selectionAfterDelete } from '@/action-offers'
import { checkTarget, createChildRegistry, createSeq, createTracker, describe, guardPass, judgeAction, pageCurrent, pickRun, readOwn, runGuard, stopsForClose } from '@/freshness'
import { formatBytes, formatDuration, formatHms, formatMTokens, formatMillis } from '@/format'

const route = useRoute()
const router = useRouter()

const archiving = ref(false)

/* Closing an issue without a disposition is always allowed: the dialog offers
   to record a reason, and whatever is given lands on the record as an override. */
const closeDialog = ref(false)
const closeReason = ref('')
/* What the Close dialog describes: which variant it offers and what it stops or abandons. */
const closeIdentity = () => ({
  variant: liveRun.value ? 'live' : interruptedRuns.value.length ? 'interrupted' : issue.value?.disposition ? 'plain' : 'no-disposition',
  hasDisposition: Boolean(issue.value?.disposition),
  liveRunIds: runs.value.filter((r) => LIVE.includes(r.status)).map((r) => r.runId),
  interruptedRunIds: interruptedRuns.value.map((r) => r.runId)
})
async function archiveIssue () {
  if (archiving.value) return
  if ((!issue.value?.disposition || liveRun.value || interruptedRuns.value.length) && !closeDialog.value) { closeDialog.value = true; return }
  archiving.value = true
  actionError.value = ''
  // Everything the close sends is fixed at this click; a later page (or issue) changes none of it.
  const before = closeIdentity()
  const overrideReason = closeReason.value
  let op = null
  try {
    const guarded = await guard({ label: 'Close issue', runId: null, before, identity: closeIdentity, offered: () => !issue.value?.archived },
      (t) => ({ project: t.project, id: t.issueId, ...before, overrideReason }))
    if (!guarded.sent) return
    op = guarded.value
    const confirmedAbandonments = new Set(op.interruptedRunIds)
    const initialRuns = await api.listRuns(op.project, op.id)
    // Only the runs the confirmation named are stopped; a run that started since means the close changed.
    const { stop, unexpected } = stopsForClose(op.liveRunIds, initialRuns.filter(r => LIVE.includes(r.status)).map((r) => r.runId))
    if (unexpected.length) {
      if (stillOnIssue(op)) await load()
      throw new Error(`A run started after you confirmed (${unexpected.join(', ')}); nothing was stopped. Review it and press Close issue again.`)
    }
    // Every later write passes the guard again: the terms the operator confirmed must still hold at that moment,
    // and each is sent to the captured location. A refusal stops the close and says what changed.
    const termsHold = () => !issue.value?.archived && Boolean(issue.value?.disposition) === op.hasDisposition
    // Each step names the issue (and run) it writes to: if the page now shows another issue, it refuses.
    const step = (label, runId, offered, send) => guard({
      label, issue: { project: op.project, issueId: op.id }, runId, retires: runId != null, offered,
      verify: () => termsHold() || 'The issue changed while it was being closed (an outcome was recorded, or it was archived). Nothing more was sent; review it and close again.'
    }, () => send())
    for (const id of stop) {
      if (!(await step('Stop run', id, offerOn(offers.closeStop), () => api.stopRun(op.project, op.id, id, { wait: true }))).sent) return
    }
    const deadline = Date.now() + 30000
    let currentRuns = await api.listRuns(op.project, op.id)
    while (currentRuns.some(r => LIVE.includes(r.status))) {
      if (Date.now() >= deadline) throw new Error('The run is still stopping. Wait for it to finish, then try closing again.')
      await new Promise(resolve => setTimeout(resolve, 500))
      currentRuns = await api.listRuns(op.project, op.id)
    }
    const pending = currentRuns.filter(r => (r.supportedActions ?? []).includes('abandon'))
    if (pending.some(r => !confirmedAbandonments.has(r.runId))) {
      if (stillOnIssue(op)) await load()
      throw new Error('The run needs recovery. Review the abandonment confirmation and press Close issue again.')
    }
    for (const item of pending) {
      if (!(await step('Abandon run', item.runId, offerOn(offers.abandon), () => api.abandonRun(op.project, op.id, item.runId))).sent) return
    }
    if (!(await step('Close issue', null, offerOn(offers.archive),
      () => api.archiveIssue(op.project, op.id, op.hasDisposition ? {} : { overrideReason: op.overrideReason }))).sent) return
    if (!stillOnIssue(op)) return
    closeDialog.value = false
    await router.push(`/projects/${op.project}`)
  } catch (error) { if (!op || stillOnIssue(op)) actionError.value = error.message } finally { archiving.value = false }
}

async function restoreIssue () {
  archiving.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Restore issue', runId: null, offered: () => Boolean(issue.value?.archived) },
      (t) => api.restoreIssue(t.project, t.issueId))
    if (r.sent) await load()
  } catch (error) { actionError.value = error.message } finally { archiving.value = false }
}

const issue = ref(null)
const runs = ref([])
const run = ref(null)
const selectedRunId = ref(null)
const selectedTurn = ref(null)
const loading = ref(true)
const loadError = ref('')
const showStart = ref(false)
/** The playbook the start dialog opens at: a triage's recommendation, or none (the list). */
const startPlaybook = ref(null)
function openStart (playbook = null) { startPlaybook.value = playbook; showStart.value = true }
const PLAYBOOK_TITLES = { prompt: 'Prompt', 'plan-and-implement': 'Plan and implement' }
const playbookTitle = (id) => PLAYBOOK_TITLES[id] ?? id
const stopRequested = ref(false)
const answerText = ref('')
const answerActor = ref(rememberedActor())
const answerSending = ref(false)
const actionError = ref('')
/* Why an action was not sent: what changed, or that the current state could not be confirmed. */
const actionNotice = ref('')

const project = computed(() => route.params.project)
const issueId = computed(() => route.params.id)
const projectLabel = computed(() => String(project.value).replace(/-project$/, ''))


const RUN_COLOUR = {
  preflighting: 'primary', running: 'primary', stopping: 'warning',
  completed: 'success', blocked: 'warning',
  cancelled: undefined, failed: 'error', pending: undefined, paused: undefined
}

/* A run is live from the moment it is reserved — preflight probes cost money
   before the first turn, so that window is part of the run, not a gap before it. */
const LIVE = ['preflighting', 'pending', 'running', 'stopping']

const elapsed = computed(() => {
  if (!run.value?.startedAt) return null
  const end = run.value.endedAt ? Date.parse(run.value.endedAt) : now.value
  return formatHms(Math.max(0, end - Date.parse(run.value.startedAt)))
})

const now = ref(Date.now())
let clock = null

const budgets = computed(() => {
  const limits = run.value?.budgets?.limits ?? {}
  const used = run.value?.budgets?.used ?? {}
  return Object.entries(limits).map(([key, cap]) => ({
    key,
    cap,
    used: key === 'maxSteps' ? (used.steps ?? 0)
      : key === 'maxTokens' ? (used.tokens ?? 0)
        : key === 'maxCostUsd' ? (used.costUsd ?? 0)
          : wallClockUsedMinutes(run.value, now.value),
    unit: key === 'wallClockMinutes' ? 'min' : ''
  }))
})

/** What a human is expected to do about a stopped run. */
const nextAction = computed(() => {
  if (!run.value) return null
  if (run.value.resultReason === 'triage-completion-mismatch') return run.value.resultSummary
  // A failed run has a reason too, and hiding it leaves the operator with a run
  // that simply stopped for no stated cause.
  if (run.value.status === 'failed') {
    return run.value.blockedReason === 'preflight-refused'
      ? 'The runtime checks did not pass, so no agent was invoked. What the probes found is below.'
      : `This run failed: ${run.value.blockedReason ?? 'no reason was recorded'}`
  }
  if (run.value.status !== 'blocked') return null
  if (run.value.reconcilePending) return 'Approved; automatic reconcile running; do not land by hand. The panel is merging the change onto the project, rechecking it unless only declared inert paths drifted, and delivering it.'
  return {
    'recovery-required': canRecover.value
      ? 'The server restarted while this run was live. Recover run reconciles what was in flight from the runtimes\' own records and continues if nothing is uncertain; Abandon keeps its work and logs and allows a fresh run.'
      : canResolveIntegrity.value
        ? 'A turn left changes the integrity check could not accept. Inspect changes to keep partial work, confirm a restoration, or abandon the run.'
        : 'Execution was interrupted. Its last outcome is unverified. Abandon this run to keep its work and logs and allow a fresh run, or close the issue.',
    'protocol-repair-exhausted': 'A participant could not produce the required output shape after repeated attempts. Review the responses below.',
    'rounds-exhausted': 'The review loop hit its round cap without agreement. The issue stays open.',
    'budget-exhausted': 'A budget ran out. Resume this run with a larger allowance to keep its completed work and sessions.',
    'closure-not-authorised': 'Everything else is satisfied, but the evidence is review-only and this playbook requires verified. Closing is a human decision.',
    'task-incomplete': 'The seat reported the task as not completed. Its summary and the blockers on the closure record say what is missing; nothing was delivered.',
    'candidate-changed-since-approval': 'The candidate moved after approval, so the approval no longer describes what would be delivered.',
    'delivery-unavailable': 'No delivery provider was configured, so nothing could be delivered. Fix the configuration, then press Finalize run.',
    'delivery-unverifiable': 'A patch was written, but rebuilding the candidate from it did not reproduce the approved revision. The worktree is kept; the patch is not a faithful copy. Fix the cause, then press Finalize run to evaluate closure again from the retained worktree.',
    'delivery-failed': 'The delivery action itself failed. The worktree is kept. Fix the cause, then press Finalize run.',
    'source-delivery-blocked': 'Source delivery did not verify. The patch and worktree are retained. If source drifted, use Reconcile with source when it is offered; otherwise apply manually or rerun against the current checkout. Finalize can recognize an exact manual application; it never overrides drift.',
    'source-delivery-interrupted': 'Source delivery was interrupted. Finalize checks the destination: approved revision means done, base means not applied, anything else requires recovery. The patch and worktree are retained.',
    'delivery-return-interrupted': 'The approved patch conflicted with the source, and moving the worktree onto the current source for the author failed part-way. The worktree may hold part of that merge; the approved patch is retained untouched. Apply it manually, or start a new run: it starts from that patch.'
  }[run.value.blockedReason] ?? 'This run stopped and needs a human.'
})

/* One run at a time per issue — the server enforces it with a lock, and the UI
   must not offer a button the server would refuse. */
const liveRun = computed(() => runs.value.find((r) => LIVE.includes(r.status)) ?? null)

/* What may be started is the server's decision, not the page's: a run that ended
   needing recovery declines even a new run, and a button that ignored that would
   promise something the server refuses. */
const interruptedRuns = computed(() => runs.value.filter(r => (r.supportedActions ?? []).includes('abandon')))
const closeTitle = computed(() => liveRun.value ? 'Stop and close this issue?' : interruptedRuns.value.length ? 'Close and abandon interrupted work?' : 'Close without a disposition?')
const runStatus = r => r.blockedReason === 'recovery-required' || (r.status !== 'paused' && (r.supportedActions ?? []).includes('abandon')) ? 'Interrupted — needs recovery' : r.status
// The trash icon deletes on the click, without asking: the operator asked for exactly that.
// The same rule the guard applies before sending (action-offers.js): offered only where the server would delete.
const canDeleteRun = computed(() => offers.delete(offerState({ runId: run.value?.runId })))
const deletingRun = ref(false)
async function deleteRun () {
  if (!run.value) return
  const deleted = run.value.runId
  deletingRun.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Delete run', runId: deleted, retires: true, offered: offerOn(offers.delete) },
      (t) => api.deleteRun(t.project, t.issueId, t.runId))
    if (!r.sent) return
    // Only if the deleted run is still the one shown: a run chosen meanwhile stays chosen.
    selectedRunId.value = selectionAfterDelete(selectedRunId.value, deleted)
    await load()
  } catch (error) { actionError.value = error.message } finally { deletingRun.value = false }
}
const abandoning = ref(false)
async function abandonRun () {
  if (!window.confirm('Abandon this run? Existing work and logs will be kept. The issue will stay open.')) return
  abandoning.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Abandon run', retires: true, offered: offerOn(offers.abandon) },
      (t) => api.abandonRun(t.project, t.issueId, t.runId))
    if (r.sent) await load()
  } catch (error) { actionError.value = error.message } finally { abandoning.value = false }
}

const latestRun = computed(() => runs.value[0] ?? null)
/* What the run cost, in tokens (time is the elapsed figure beside it). */
const costText = computed(() => {
  const used = run.value?.budgets?.used
  return used?.tokens != null ? formatMTokens(used.tokens) : null
})

/*
 * Where the run stands, in plain words. The server writes it
 * (runtime/run-explanation.mjs) so this page, Needs attention and the
 * supervisor say the same thing; a server that predates it gets the old
 * status line and next-action text instead.
 */
const explanation = computed(() => {
  if (!run.value) return null
  if (run.value.explanation) return run.value.explanation
  const tone = LIVE.includes(run.value.status) ? 'progress' : run.value.status === 'failed' ? 'error' : run.value.status === 'completed' ? 'success' : run.value.status === 'paused' ? 'waiting' : 'warning'
  return { tone, headline: runStatus(run.value), detail: nextAction.value }
})
const statusOpen = ref(false)
// A question is read in full before it is answered; only reasoning is folded.
const statusIsLong = computed(() => explanation.value?.tone !== 'waiting' && ((explanation.value?.detail?.length ?? 0) > 180 || (explanation.value?.unmet ?? []).some((u) => (u.text?.length ?? 0) > 110)))
watch(() => run.value?.runId, () => { statusOpen.value = false })
const ended = computed(() => run.value && !LIVE.includes(run.value.status) && run.value.status !== 'paused')

/* A finished run is not a resolved issue: once one ends, say that deciding is next. */
const nextStepForIssue = computed(() => {
  if (!ended.value || issue.value?.archived || issue.value?.disposition) return null
  if (run.value.status !== 'completed' || run.value.outcome !== 'resolved') return null
  return 'Then record the outcome under "Your decision".'
})

/* What reached the project, in one line. */
const deliveryLine = computed(() => {
  const r = run.value
  const d = r?.delivery
  if (r?.artifactApplication?.verified) return { ok: true, text: 'The patch was applied to the project at', where: r.artifactApplication.path }
  if (!d) return { ok: false, text: 'Nothing was delivered.' }
  if (!d.completedAt) return { ok: false, text: 'Delivery did not complete.' }
  switch (d.action) {
    case 'apply-to-source': return { ok: true, text: 'Applied to the project (not committed) at', where: d.application?.path ?? null }
    case 'worktree-diff': return { ok: true, text: 'Saved as a patch. The project itself was not changed.' }
    case 'commit': return r.integration?.mergeCommit
      ? { ok: true, text: `Committed and merged into ${r.integration.targetBranch}.` }
      : { ok: true, text: 'Committed on branch', where: d.branch }
    case 'in-place': return { ok: true, text: 'Changed directly in the project.' }
    case 'none': return { ok: true, text: 'The report is the result; no files changed.' }
    default: return { ok: true, text: `Delivered (${d.action}).` }
  }
})
const verificationText = computed(() => {
  const c = run.value?.closure
  if (!c) return 'Not checked: the run did not get that far.'
  if (c.verificationLevel === 'verified') return 'Verified: the automated checks passed.'
  return run.value?.checks?.requirement === 'none' ? 'Reviewed by agents; this playbook runs no automated checks.' : 'Reviewed by agents only; no automated check passed.'
})

const BUDGET_NAME = { maxSteps: 'turns', maxTokens: 'tokens', wallClockMinutes: 'minutes' }

/* Decision forms stay folded until asked for, except the one a finished run is waiting on. */
const showDisposition = ref(false)
const showPriority = ref(false)

/* The issue folder, in the issue card: open by itself only when there is no
   run to look at, since then it is all there is. Opening or closing it by hand
   is remembered in this browser and then holds on every issue. */
const folderChoice = ref(readFolder())
const showFolder = ref(folderChoice.value ?? false)
function toggleFolder () {
  showFolder.value = !showFolder.value
  folderChoice.value = showFolder.value
  writeFolder(showFolder.value)
}
/* A packed archive's results, newest run first. */
const packedResults = computed(() => [...(issue.value?.archive?.results ?? [])].sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''))))
watch(() => [issueId.value, runs.value.length, issue.value?.packed], () => { if (folderChoice.value === null && !runs.value.length && !issue.value?.packed) showFolder.value = true })

/*
 * What the step column has selected: a step number, 'summary', or
 * 'live:<invocationId>' for a turn still in flight. When nothing valid is
 * selected: the turn in flight, else the summary of a finished run, else the
 * latest step. A live turn that has since been recorded stays selected as the
 * step it became.
 */
function pickTurn (r, current) {
  if (current === 'summary' || current === 'chat') return current
  if (typeof current === 'string' && current.startsWith('live:')) {
    const id = current.slice(5)
    if (r.active.some((a) => a.invocationId === id)) return current
    const recorded = r.timeline.find((t) => t.invocationId === id)
    if (recorded) return recorded.number
  } else if (current && r.timeline.some((t) => t.number === current)) return current
  if (r.active.length) return `live:${r.active[0].invocationId}`
  if (!LIVE.includes(r.status) && r.status !== 'paused') return 'summary'
  return r.timeline.at(-1)?.number ?? 'summary'
}
const liveTurn = computed(() => typeof selectedTurn.value === 'string' && selectedTurn.value.startsWith('live:')
  ? run.value?.active.find((a) => a.invocationId === selectedTurn.value.slice(5)) ?? null
  : null)

/* ---- what remains: residuals, follow-ups, disposition ---- */
const orderedRisks = computed(() => [...(run.value?.closure?.residualRisks ?? [])].map((r, i) => ({ ...r, index: i })).sort((a, b) => (a.accepted === false ? 0 : 1) - (b.accepted === false ? 0 : 1)))
const openRisks = computed(() => orderedRisks.value.filter((r) => r.accepted === false))
const followUpFor = (risk) => (run.value?.closure?.followUps ?? []).find((f) => f.riskIndex === risk.index)?.issueId ?? null
const creatingFollowUps = ref(false)
async function createFollowUps () {
  creatingFollowUps.value = true
  const missing = () => openRisks.value.filter((r) => !followUpFor(r)).map((r) => r.index)
  try {
    const r = await guard({ label: 'Create follow-up issues', identity: missing, offered: (fresh, t) => offers.followUps(offerState(t), missing().length) },
      (t) => api.createFollowUps(t.project, t.issueId, t.runId, actorName(answerActor.value) || undefined))
    if (r.sent) await load()
  } catch (e) { actionError.value = e.message } finally { creatingFollowUps.value = false }
}
const canFinalize = computed(() => (run.value?.supportedActions ?? []).includes('finalize'))
const finalizing = ref(false)
async function finalizeRun () {
  if (!run.value) return
  finalizing.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Finalize run', offered: offerOn(offers.finalize('finalize')) }, (t) => api.finalizeRun(t.project, t.issueId, t.runId))
    if (!r.sent) return
    const result = r.value
    if (result.status !== 'completed') actionError.value = `Closure was evaluated again and is still blocked: ${result.blockedReason}`
    await load()
  } catch (error) { actionError.value = error.message } finally { finalizing.value = false }
}
/* Delivery was refused because the source changed the approved patch's own
   paths: merge the patch onto it, revalidate, deliver (POST …/reconcile-delivery). */
const canReconcile = computed(() => (run.value?.supportedActions ?? []).includes('reconcile-delivery'))
const reconciling = ref(false)
async function reconcileDelivery () {
  if (!run.value) return
  reconciling.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Reconcile with source', offered: offerOn(offers.finalize('reconcile-delivery')) }, (t) => api.reconcileDelivery(t.project, t.issueId, t.runId))
    if (!r.sent) return
    const result = r.value
    const attempt = result.reconciliation
    if (result.status !== 'completed') actionError.value = attempt && attempt.state !== 'accepted'
      ? `Not reconciled (${attempt.state}): ${attempt.error ?? ''}${attempt.conflicts?.length ? ` Paths: ${attempt.conflicts.join(', ')}` : ''}`
      : `Reconciled, but delivery is still blocked: ${result.blockedReason}`
    await load()
  } catch (error) { actionError.value = error.message } finally { reconciling.value = false }
}
/* Reruns the installed checks on the retained candidate (POST …/refresh-checks):
   for a run stopped at closure, or only by failed checks on an approved revision,
   once a flaky or environmental failure is fixed. */
const canRefreshChecks = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('refresh-checks'))
const refreshingChecks = ref(false)
async function refreshChecks () {
  if (!run.value) return
  refreshingChecks.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Refresh checks', offered: offerOn(offers.continuation('refresh-checks')) }, (t) => api.refreshChecks(t.project, t.issueId, t.runId))
    if (r.sent) await load()
  }
  catch (error) { actionError.value = error.message } finally { refreshingChecks.value = false }
}
/* Named failures of an approved revision's check do not stop its delivery
   (POST …/accept-check-result). On a stop with no coordinator confirmation the
   call only asks: nothing is accepted until the coordinator confirms this revision. */
const canAcceptCheck = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('accept-check-result') && Boolean(run.value?.acceptCheck))
const acceptCheckDialog = ref(false)
const acceptCheckReason = ref('')
const acceptingCheck = ref(false)
const acceptCheckIdentity = () => run.value?.acceptCheck ? { revision: run.value.acceptCheck.revision, failures: run.value.acceptCheck.failures.map((f) => f.key).sort() } : null
let acceptCheckShown = null
function openAcceptCheck () {
  acceptCheckShown = { runId: run.value?.runId ?? null, ...acceptCheckIdentity(), keys: (run.value?.acceptCheck?.failures ?? []).map((f) => f.key) }
  acceptCheckReason.value = ''
  actionError.value = ''
  acceptCheckDialog.value = true
}
async function acceptCheckResult () {
  // A withdrawn offer is the guard's to refuse, and the dialog says why (acceptCheckGone, the guard's notice).
  if (!acceptCheckReason.value.trim()) return
  acceptingCheck.value = true
  actionError.value = ''
  try {
    const shown = acceptCheckShown
    const reason = acceptCheckReason.value.trim()
    const r = await guard({ label: 'Accept check result', runId: shown.runId, before: { revision: shown.revision, failures: shown.failures }, identity: acceptCheckIdentity, offered: (fresh, t) => offerOn(offers.continuation('accept-check-result'))(fresh, t) && Boolean(runOf(t.runId)?.acceptCheck) },
      (t) => api.acceptCheckResult(t.project, t.issueId, t.runId, { revision: shown.revision, failures: shown.keys, reason, actor: actorName(answerActor.value) || undefined }))
    if (!r.sent) { actionError.value = r.notice; return }
    acceptCheckDialog.value = false
    await load()
  } catch (error) { actionError.value = error.message } finally { acceptingCheck.value = false }
}
/* A restart left the run without an owner. Recovery reconciles what was in
   flight from the runtimes' own records and continues only when nothing is
   uncertain; otherwise it says what still needs a person. */
const canRecover = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('recover'))
const recovering = ref(false)
async function recoverRun () {
  if (!run.value) return
  recovering.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Recover run', offered: offerOn(offers.continuation('recover')) }, (t) => api.recoverRun(t.project, t.issueId, t.runId, actorName(answerActor.value) || undefined))
    if (!r.sent) return
    const result = r.value
    if (result.recovered === false) actionError.value = `Recovery could not continue the run: ${result.reason}`
    await load()
  } catch (error) { actionError.value = error.message } finally { recovering.value = false }
}
/* Processes a turn started were not proved gone (runtime/cleanup-barrier.mjs).
   A person may record that they are, with what they checked: that lifts the
   run's hold and any barrier it put on the project's checkout. */
const canAcknowledgeCleanup = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('acknowledge-cleanup'))
const cleanupDialog = ref(false)
const cleanupReason = ref('')
const cleanupBusy = ref(false)
const cleanupError = ref('')
let cleanupRunId = null
/** The unproved cleanup entries the operator is acknowledging: a different set means a different acknowledgement. */
let cleanupShown = null
const openCleanupOf = (r) => [...(r?.openCleanup ?? [])].sort()
function openCleanupDialog () {
  cleanupRunId = run.value?.runId ?? null
  cleanupShown = openCleanupOf(run.value)
  cleanupReason.value = ''
  cleanupError.value = ''
  cleanupDialog.value = true
}
async function acknowledgeCleanup () {
  cleanupBusy.value = true
  cleanupError.value = ''
  try {
    const reason = cleanupReason.value
    const r = await guard({
      label: 'Acknowledge cleanup',
      runId: cleanupRunId,
      before: cleanupShown,
      identity: (_, t) => openCleanupOf(runOf(t?.runId ?? cleanupRunId)),
      offered: offerOn(offers.acknowledgeCleanup)
    }, (t) => api.acknowledgeCleanup(t.project, t.issueId, t.runId, reason))
    if (!r.sent) { cleanupError.value = r.notice; return }
    cleanupDialog.value = false
    await load()
  } catch (error) { cleanupError.value = error.message } finally { cleanupBusy.value = false }
}
/* A turn left changes the integrity check could not accept — typically an
   author that failed (quota, crash) after editing. The operator inspects what
   changed and chooses: keep the partial work and continue, confirm it was
   restored, or abandon. The choice is pinned to the inspected state. */
const canResolveIntegrity = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('resolve-integrity'))
const integrityDialog = ref(false)
const integrityState = ref(null)
const integrityReason = ref('')
const integrityBusy = ref(false)
const integrityError = ref('')
/* Reads scoped to an issue and run: a reply is shown only if it is the newest for the run still selected. */
const runKey = (runId) => `${project.value}/${issueId.value}/${runId}`
const integritySeq = createSeq()
let integrityRunId = null
async function openIntegrity () {
  integrityRunId = run.value?.runId ?? null
  integrityDialog.value = true
  integrityState.value = null
  integrityReason.value = ''
  integrityError.value = ''
  integrityBusy.value = true
  const key = runKey(integrityRunId)
  const ticket = integritySeq.next(key)
  const shown = () => integritySeq.isLatest(ticket, key) && runKey(selectedRunId.value) === key
  try {
    const state = await api.inspectIntegrity(project.value, issueId.value, integrityRunId)
    if (shown()) integrityState.value = state
  } catch (error) { if (shown()) integrityError.value = error.message } finally { if (shown()) integrityBusy.value = false }
}
async function resolveIntegrity (disposition) {
  integrityBusy.value = true
  integrityError.value = ''
  try {
    const stateHash = integrityState.value.stateHash
    const reason = integrityReason.value
    const r = await guard({
      label: 'Resolve integrity',
      runId: integrityRunId,
      offered: offerOn(offers.continuation('resolve-integrity')),
      // The inspected changes are read again from their source: the state hash must still be the one shown.
      source: () => ownRead(integritySeq, runKey(integrityRunId), () => api.inspectIntegrity(project.value, issueId.value, integrityRunId)),
      verify: (fresh) => {
        if (fresh.stateHash === stateHash && (fresh.dispositions ?? []).includes(disposition)) return true
        integrityState.value = fresh
        return 'The changes moved since you inspected them; review them again. Nothing was sent.'
      }
    }, (t) => api.resolveIntegrity(t.project, t.issueId, t.runId, { disposition, expectedStateHash: stateHash, reason }))
    if (!r.sent) { integrityError.value = r.notice; return }
    integrityDialog.value = false
    await load()
  } catch (error) { integrityError.value = error.message } finally { integrityBusy.value = false }
}
const INTEGRITY_ACTIONS = {
  'accept-partial': { label: 'Keep partial work and continue', color: 'primary' },
  restored: { label: 'Restored — continue', color: undefined },
  abandon: { label: 'Abandon run', color: 'warning' }
}
const canIntegrate = computed(() => (run.value?.supportedActions ?? []).includes('integrate'))
const applyingArtifact = ref(false)
async function applyArtifact () {
  applyingArtifact.value = true
  actionError.value = ''
  try {
    const revision = run.value.delivery.revision
    const r = await guard({
      label: 'Apply patch to project',
      before: { revision },
      identity: () => ({ revision: run.value?.delivery?.revision }),
      offered: offerOn(offers.applyArtifact)
    }, (t) => api.applyArtifact(t.project, t.issueId, t.runId, revision))
    if (r.sent) await load()
  } catch (error) { actionError.value = error.message } finally { applyingArtifact.value = false }
}
async function downloadPatch () {
  try {
    const blob = await api.downloadRunPatch(project.value, issueId.value, run.value.runId)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${run.value.runId}.patch`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) { actionError.value = error.message }
}
const integrationTargetInfo = ref(null)
const loadingTarget = ref(false)
const integrating = ref(false)
const integrationError = ref('')
const integrationSeq = createSeq()
async function loadIntegrationTarget () {
  const runId = run.value.runId
  const key = runKey(runId)
  const ticket = integrationSeq.next(key)
  const shown = () => integrationSeq.isLatest(ticket, key) && runKey(selectedRunId.value) === key
  loadingTarget.value = true
  integrationError.value = ''
  try {
    const info = await api.integrationTarget(project.value, issueId.value, runId)
    if (shown()) integrationTargetInfo.value = info
  } catch (e) { if (shown()) integrationError.value = e.message } finally { if (shown()) loadingTarget.value = false }
}
// Leaving the run (or the issue) invalidates every inspection read in flight, so none lands after a return to it.
watch([() => run.value?.runId, project, issueId], () => {
  integrationSeq.next(null)
  integritySeq.next(null)
  integrationTargetInfo.value = null
  loadingTarget.value = false
})
const integrationPhase = (_, t) => runOf(t?.runId ?? run.value?.runId)?.integration?.phase ?? null
async function reconcileIntegration () {
  try {
    const r = await guard({ label: 'Finish it now', identity: integrationPhase, offered: offerOn(offers.reconcileIntegration) },
      (t) => api.reconcileIntegration(t.project, t.issueId, t.runId))
    if (r.sent) await load()
  } catch (e) { integrationError.value = e.message }
}
async function integrate () {
  const target = integrationTargetInfo.value
  if (!target?.branch || !target.head) return
  const revision = run.value.closure?.revision
  const runId = run.value.runId
  if (!window.confirm(`Integrate revision ${revision?.slice(0, 23)}… into ${target.branch} at ${target.head.slice(0, 12)}? This merges the candidate's commit.`)) return
  integrating.value = true
  integrationError.value = ''
  try {
    const r = await guard({
      label: 'Merge the change',
      runId,
      before: { revision },
      identity: () => ({ revision: run.value?.closure?.revision }),
      offered: offerOn(offers.integrate),
      // The target branch is read again: the merge goes only onto the head that was shown.
      source: () => ownRead(integrationSeq, runKey(runId), () => api.integrationTarget(project.value, issueId.value, runId)),
      verify: (fresh) => {
        const sameTarget = offers.mergeTarget(fresh) &&
          fresh.repository === target.repository && fresh.branch === target.branch && fresh.head === target.head
        if (sameTarget) return true
        integrationTargetInfo.value = fresh
        if (!offers.mergeTarget(fresh) || fresh.repository !== target.repository) return 'The merge target is no longer confirmed as the candidate\'s repository (it changed, or could not be read). Review it again; nothing was sent.'
        return `The target branch moved (${short(target.head)} → ${short(fresh.head)}) since you prepared the merge. Review it again; nothing was sent.`
      }
    }, (t) => api.integrateRun(t.project, t.issueId, t.runId, { expectedRevision: revision, targetBranch: target.branch, expectedTargetHead: target.head }))
    if (!r.sent) { integrationError.value = r.notice; return }
    const result = r.value
    if (result.error) integrationError.value = result.error
    integrationTargetInfo.value = null
    await load()
  } catch (e) { integrationError.value = e.message } finally { integrating.value = false }
}
/* Where this issue sits in the execution order. Not severity, and not a guess
   from the text: someone decides it, says why, and that is recorded. */
const priorityValue = ref('normal')
const priorityReason = ref('')
const priorityError = ref('')
const savingPriority = ref(false)
async function savePriority () {
  savingPriority.value = true
  priorityError.value = ''
  try {
    const body = { value: priorityValue.value, reason: priorityReason.value }
    const r = await guard({ label: 'Set priority', runId: null, before: priorityShown, identity: () => issue.value?.priority?.value ?? null, offered: () => !issue.value?.archived },
      (t) => api.setPriority(t.project, t.issueId, body))
    if (!r.sent) { priorityError.value = r.notice; return }
    priorityReason.value = ''
    showPriority.value = false
    await load()
  } catch (e) { priorityError.value = e.message } finally { savingPriority.value = false }
}
let priorityShown = null
watch(showPriority, (open) => { if (open) priorityShown = issue.value?.priority?.value ?? null })
const priorityColour = (value) => ({ urgent: 'error', high: 'warning', normal: 'primary', low: 'surface-variant' })[value] ?? undefined

const DISPOSITION_OPTIONS = [
  { value: 'resolved', hint: 'The defect is gone' },
  { value: 'partially-resolved', hint: 'Some of it is fixed; follow-ups track the rest' },
  { value: 'split', hint: 'Broken down into the named issues' },
  { value: 'duplicate', hint: 'Already tracked by the named issue' },
  { value: 'declined', hint: 'Will not be fixed; say why' },
  { value: 'not-reproducible', hint: 'Could not be confirmed; say what was tried' },
  { value: 'superseded', hint: 'Made irrelevant by other work' },
  { value: 'not-resolved', hint: 'Closed without a fix for another reason' }
]
const dispositionValue = ref('partially-resolved')
const dispositionEvidence = ref('')
const dispositionRelated = ref('')
const dispositionNeedsRelated = computed(() => ['split', 'duplicate'].includes(dispositionValue.value))
const dispositionColour = (value) => value === 'resolved' ? 'success' : ['not-resolved', 'declined'].includes(value) ? 'error' : ['split', 'duplicate'].includes(value) ? 'info' : 'warning'
const reportFindings = computed(() => run.value?.findings ?? [])
let dispositionShown = { runId: null, disposition: null }
watch(showDisposition, (open) => { if (open) dispositionShown = { runId: run.value?.runId ?? null, disposition: issue.value?.disposition?.value ?? null } })
const dispositionError = ref('')
const savingDisposition = ref(false)
async function saveDisposition () {
  savingDisposition.value = true
  dispositionError.value = ''
  try {
    const related = dispositionNeedsRelated.value ? dispositionRelated.value.split(/[\s,]+/).filter(Boolean) : null
    const shown = dispositionShown
    const body = { value: dispositionValue.value, evidence: dispositionEvidence.value, related }
    // The decision cites the run whose findings the form showed: it must still be the one on screen.
    const r = await guard({ label: 'Record the outcome', runId: shown.runId, before: shown.disposition, identity: () => issue.value?.disposition?.value ?? null, offered: () => !issue.value?.archived },
      (t) => api.setDisposition(t.project, t.issueId, { ...body, runId: t.runId }))
    if (!r.sent) { dispositionError.value = shown.runId && !runs.value.some((x) => x.runId === shown.runId) ? `The run this decision cites (${shown.runId}) no longer exists; review it again. Nothing was sent.` : r.notice; return }
    dispositionEvidence.value = ''
    dispositionRelated.value = ''
    showDisposition.value = false
    await load()
  } catch (e) { dispositionError.value = e.message } finally { savingDisposition.value = false }
}
const canStart = computed(() => {
  if (issue.value?.archived) return false
  if (liveRun.value) return false
  if (!latestRun.value) return true
  return (latestRun.value.supportedActions ?? []).includes('start-new')
})
const canPause = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('pause'))
const canResume = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('resume'))
const canContinue = computed(() => !issue.value?.archived && (run.value?.supportedActions ?? []).includes('continue'))
const pausing = ref(false)
const resuming = ref(false)
const resumeDialog = ref(false)
const resumeBudgets = ref({})
const acceptShortWallClock = ref(false)
const resumeClock = computed(() => wallClockAt(run.value?.wallClock, resumeBudgets.value.wallClockMinutes))
async function requestPause () {
  pausing.value = true
  actionError.value = ''
  try {
    const r = await guard({ label: 'Pause run', offered: offerOn(offers.pause) }, (t) => api.pauseRun(t.project, t.issueId, t.runId))
    if (r.sent) await load()
  }
  catch (error) { actionError.value = error.message }
  finally { pausing.value = false }
}
function openResume () {
  const limits = run.value.budgets?.limits ?? {}
  const used = run.value.budgets?.used ?? {}
  acceptShortWallClock.value = false
  resumeBudgets.value = limits.wallClockMinutes ? { wallClockMinutes: wallClockPrefill(run.value.wallClock, { resume: true }) } : {}
  for (const key of ['maxSteps', 'maxTokens']) {
    if (limits[key]) resumeBudgets.value[key] = Math.max(limits[key], (used[key === 'maxSteps' ? 'steps' : 'tokens'] ?? 0) + 1)
  }
  if (limits.maxSteps && used.steps >= limits.maxSteps) resumeBudgets.value.maxSteps = used.steps + limits.maxSteps
  if (limits.maxTokens && used.tokens >= limits.maxTokens) resumeBudgets.value.maxTokens = used.tokens + limits.maxTokens
  actionError.value = ''
  resumeRunId = run.value.runId
  resumeDialog.value = true
}
let resumeRunId = null
async function resumeRun () {
  resuming.value = true
  actionError.value = ''
  try {
    const budgets = { ...resumeBudgets.value }
    const acceptShort = resumeClock.value?.short === true && acceptShortWallClock.value
    const r = await guard({ label: 'Resume run', runId: resumeRunId, offered: offerOn(offers.continuation('resume')) },
      (t) => api.resumeRun(t.project, t.issueId, t.runId, budgets, actorName(answerActor.value) || undefined, acceptShort))
    if (!r.sent) { actionError.value = r.notice; return }
    resumeDialog.value = false
    await load()
  } catch (error) { actionError.value = error.message }
  finally { resuming.value = false }
}
const canStop = computed(() => (run.value?.supportedActions ?? []).includes('stop'))
const isStopping = computed(() => run.value?.status === 'stopping')
const isPreflighting = computed(() => run.value?.status === 'preflighting')

/** What the paid probes cost, whatever they concluded. */
const preflight = computed(() => run.value?.preflight ?? null)

/* Agent time against wall clock. A run that took an hour of which four minutes
   were agents is a different problem from one that was busy throughout. */
const timing = computed(() => run.value?.timing ?? null)

/*
 * How the run converged, read off the record by the server: loop rounds beside
 * cycle restarts (an evidence refresh or a plan restart resets the round
 * counter, so the two are shown together), the time split between agents and
 * waiting for a person, and distinct findings versus other seats confirming them.
 */
const metrics = computed(() => {
  const m = run.value?.metrics
  if (!m) return null
  const phases = Object.entries(m.rounds?.byPhase ?? {}).filter(([, p]) => p.roundExecutions > 0)
  const rounds = phases.map(([id, p]) => {
    const name = id.replace(/-review$/, '')
    // "13 rounds in 13 cycles" is the shape of a run that kept restarting;
    // "3 rounds" alone would have read as three rounds of one review.
    return p.cycles > 1 ? `${name} ${p.roundExecutions} rounds in ${p.cycles} cycles, depth ${p.maxDepth}` : `${name} ${p.roundExecutions}`
  }).join(' · ') || 'no rounds yet'
  const restarts = [m.rounds?.cycleRestarts ? `${m.rounds.cycleRestarts} restart${m.rounds.cycleRestarts === 1 ? '' : 's'}${m.rounds.restartsInferred ? ` (${m.rounds.restartsInferred} inferred)` : ''}` : null,
    m.rounds?.ignoredRestartRequests ? `${m.rounds.ignoredRestartRequests} ignored` : null].filter(Boolean)
  const t = m.time ?? {}
  const time = [`${formatMillis(t.agentMs ?? 0)} agents`,
    t.operatorWaitMs ? `${formatMillis(t.operatorWaitMs)} waiting on operator` : null,
    t.suspendedMs ? `${formatMillis(t.suspendedMs)} suspended${t.basis === 'inferred' ? ' (inferred)' : ''}` : null,
    t.checksMs ? `${formatMillis(t.checksMs)} checks, ${formatMillis(t.waitingForChecksMs ?? 0)} of it with no agent working` : null,
    t.inconsistentMs ? `record inconsistent by ${formatMillis(t.inconsistentMs)}` : null].filter(Boolean).join(' · ')
  const f = m.findings
  return {
    roundsText: restarts.length ? `${rounds} (${restarts.join(', ')})` : rounds,
    timeText: time,
    regressionsText: m.regressionsAfterApproval ? `${m.regressionsAfterApproval} check${m.regressionsAfterApproval === 1 ? '' : 's'} failed after approval${m.regressionsBasis !== 'recorded' ? ' (partly inferred)' : ''}` : null,
    findingsText: f && f.reported ? `${f.reported} findings: ${f.distinctSlugs} distinct slug${f.distinctSlugs === 1 ? '' : 's'}, ${f.matchedAcrossSeats} matched by another seat${f.repeatedLater ? `, ${f.repeatedLater} repeated later` : ''} (slug match, not the same defect proven)` : null
  }
})


const runDate = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
})
function runTitle (item) {
  const name = item.playbook.title || item.playbook.id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const date = new Date(item.startedAt)
  return `${name} · ${Number.isNaN(date.getTime()) ? 'Date unknown' : runDate.format(date)}`
}

const short = (f) => (f ? `${f.slice(0, 19)}…` : '—')

let disposed = false
/*
 * How current this page is (freshness.js). One refresh at a time: the issue, its
 * runs, the supervisor's questions and the selected run are read together and
 * shown together, only by the latest refresh and only on the issue still open.
 * Panels that read their own endpoints report into `children`.
 */
const freshState = reactive({})
const tracker = createTracker(freshState)
const children = createChildRegistry(reactive({}))
const freshRetry = ref(0)
const freshSynced = ref(0)
const view = computed(() => describe(freshState, connection, children.summary()))
/** A run chosen in the picker (or the URL) whose read has not landed yet. */
const pendingRunId = ref(null)
const runNotice = ref('')
/* The issue this page was mounted for (App.vue keys the page by issue): once the route names another,
   this page reads nothing more and every guard refuses, whatever form or dialog it still holds. */
const mountedOn = { project: route.params.project, id: route.params.id }
function currentIssue () {
  if (disposed || route.name !== 'issue' || !project.value || !issueId.value) return null
  if (project.value !== mountedOn.project || issueId.value !== mountedOn.id) return null
  return { project: project.value, id: issueId.value }
}
function stillOnIssue (location) {
  const current = currentIssue()
  return current && current.project === location.project && current.id === location.id
}

/** Counts issue reloads, so panels that read their own endpoints follow the page. */
const issueVersion = ref(0)
// Open questions the top-level supervisor asked about this issue (ask_operator), read with the issue.
const supervisorQuestions = ref([])

/*
 * The Sections bar: any card or section can be hidden so the rest get the
 * room. One choice for every issue, remembered in this browser
 * (issue-sections.js). A section cannot be toggled while the card it sits in
 * is hidden; the bar itself is outside every card, so nothing is ever lost.
 */
// The saved choice, and what an alert link shows on top of it for this visit only (issue-sections.js).
const sections = ref({ hidden: readHidden(), revealed: [] })
const shown = (id) => sectionShown(sections.value, id)
function toggleSection (id) {
  const { save, ...next } = toggleSectionState(sections.value, id)
  sections.value = next
  if (save) writeHidden(next.hidden)
}
const pageSections = computed(() => {
  const i = issue.value
  if (!i) return []
  const withRun = Boolean(run.value) && !i.packed
  return [
    { id: 'issue', label: 'Issue' },
    { id: 'decision', label: 'Decision', parents: ['issue'] },
    !i.packed && { id: 'assess', label: 'Assess', parents: ['issue'] },
    supervisorQuestions.value.length > 0 && { id: 'questions', label: `Questions (${supervisorQuestions.value.length})` },
    i.archived && { id: 'stats', label: 'Time spent' },
    { id: 'run', label: i.packed ? 'Run results' : 'Run' },
    withRun && { id: 'runbar', label: 'Run picker', parents: ['run'] },
    !i.packed && { id: 'status', label: 'Status', parents: ['run'] },
    withRun && { id: 'timeline', label: 'Steps', parents: ['run'] },
    withRun && { id: 'detail', label: 'Step detail', parents: ['run'] },
    withRun && { id: 'outcome', label: 'Outcome', parents: ['run', 'detail'] },
    withRun && { id: 'tech', label: 'Technical details', parents: ['run', 'detail'] }
  ].filter(Boolean)
})
const workspaceColumns = computed(() => Number(shown('timeline')) + Number(shown('detail')))
/* Read from what the run card actually renders: without a run it holds only
   the status. A card with nothing left in it leaves the page; on wide screens
   it takes the height only while it shows something that can use it (the
   status or the workspace), otherwise the issue card does. */
const runEmpty = computed(() => !issue.value?.packed && !shown('status') && !(run.value && (shown('runbar') || workspaceColumns.value > 0)))
const runFills = computed(() => shown('run') && (Boolean(issue.value?.packed) || shown('status') || (Boolean(run.value) && workspaceColumns.value > 0)))

/*
 * An operator alert opens this page at one waiting event of one run (docs/operator-alerts.md): ?run= picks the run,
 * pause= / recovery= / wait=owner-input say which wait. src/notifications.js alertDestination decides from the run as
 * it is now: still waiting (the page scrolls to that action), needing recovery instead, or already handled.
 * Declared after issue, run and the Sections bar, because a watch reads its source at setup. The sections holding
 * the target are shown for this visit (alertSections), never written to the remembered choice.
 */
const alertTarget = computed(() => alertDestination(run.value, route.query))
function revealSections (ids) {
  if (ids.some((id) => !shown(id))) sections.value = revealSectionState(sections.value, ids)
}
// An archived issue lists its runs from the archive: an alert's ?run= opens and marks the one it named.
watch(() => (issue.value?.packed && route.query.run ? `${issue.value.id}:${route.query.run}` : null), async (key) => {
  if (!key) return
  revealSections(alertSections('packed'))
  await nextTick()
  document.querySelector(`[data-packed-run="${CSS.escape(String(route.query.run))}"]`)?.scrollIntoView({ block: 'center' })
}, { immediate: true })
// Every alert link shows where it landed: the action while it waits, otherwise the note and the run as it is now.
watch(() => alertTarget.value ? `${run.value?.runId}:${alertTarget.value.state}:${alertTarget.value.target}` : null, async (key) => {
  if (!key) return
  const action = alertTarget.value.state !== 'handled' ? alertTarget.value.target : null
  revealSections(alertSections(action))
  await nextTick()
  document.querySelector(action ? `[data-alert-action="${action}"]` : '[data-testid="alert-target"]')?.scrollIntoView({ block: 'center' })
}, { immediate: true })

/**
 * Read the issue, its runs, the supervisor's questions and the run to show, and
 * show them all at once. Nothing is replaced unless every read succeeded for the
 * latest refresh of the issue still open; a failure keeps the last complete view
 * and the indicator offers Retry. Resolves 'ok' when it published, 'superseded' when a newer
 * refresh (or the issue left) took over, 'failed' when a read failed.
 */
async function load ({ runId = null } = {}) {
  const location = currentIssue()
  if (!location) return 'superseded'
  const ticket = tracker.begin()
  const current = () => tracker.isLatest(ticket) && stillOnIssue(location)
  try {
    const [nextIssue, nextRuns, questions] = await Promise.all([
      api.getIssue(location.project, location.id),
      api.listRuns(location.project, location.id),
      api.supervisorQuestions()
    ])
    if (!current()) return 'superseded'
    const pick = pickRun({ list: nextRuns, explicit: runId ?? pendingRunId.value, query: route.query.run ?? null, current: selectedRunId.value })
    const nextRun = pick.runId ? await api.getRun(location.project, location.id, pick.runId) : null
    if (!current()) return 'superseded'
    issue.value = nextIssue
    runs.value = nextRuns
    supervisorQuestions.value = questions.filter((q) => q.project === location.project && q.issueId === location.id)
    if (selectedRunId.value !== pick.runId) selectedTurn.value = null
    selectedRunId.value = pick.runId
    run.value = nextRun
    if (nextRun) selectedTurn.value = pickTurn(nextRun, selectedTurn.value)
    pendingRunId.value = null
    runNotice.value = pick.missing ? `The run you chose (${pick.missing}) no longer exists; showing ${nextRun ? runTitle(nextRun) : 'no run'}.` : ''
    loadError.value = ''
    issueVersion.value++
    tracker.succeed(ticket, { epoch: connection.epoch })
    freshSynced.value++
    return 'ok'
  } catch (err) {
    if (!current()) return 'superseded'
    tracker.fail(ticket, err)
    loadError.value = err.message
    return 'failed'
  } finally {
    if (stillOnIssue(location)) loading.value = false
  }
}

/** Retry: the page and every panel that reports into it read again. */
function retry () {
  freshRetry.value++
  return load()
}

/** Pick another run: the old one stays on screen until the new one has been read. */
function chooseRun (runId) {
  if (!runId || (runId === selectedRunId.value && pendingRunId.value == null)) return
  pendingRunId.value = runId
  load({ runId })
}

/** Adopt the new run immediately: it has an id before it has any turns. */
function onStarted (started) {
  actionError.value = ''
  pendingRunId.value = started.runId
  load({ runId: started.runId })
}

/*
 * Before anything is sent: is what the person acted on still true? (AC5.)
 * When the page's own refresh is not current it refreshes first; the action's own
 * source (a pre-gate, a merge target, the chat) is read again; then, with nothing
 * awaited before the send, the refresh must not have been overtaken, the issue and
 * run must still be the ones acted on, and the action still offered and unchanged.
 * An overtaken check runs once more; anything else refuses and says why.
 */
const REFUSAL = {
  gone: (label) => `"${label}" is no longer offered${explanation.value?.headline ? `: ${explanation.value.headline}` : ''}. Nothing was sent.`,
  changed: (label) => `${label}: what you were shown changed. Review it again; nothing was sent.`,
  unconfirmed: () => `Could not confirm the current state (${freshState.error ?? 'the refresh did not finish'}); nothing was sent. Retry when the view is up to date.`,
  superseded: () => 'The view changed while this was being checked; review it again. Nothing was sent.',
  disposed: () => 'The page was left before this could be checked; nothing was sent.'
}
async function guard (spec, send) {
  // The issue an action names (a later Close step names the one it was confirmed on); the current one otherwise.
  const target = { project: spec.issue?.project ?? project.value, issueId: spec.issue?.issueId ?? issueId.value, runId: 'runId' in spec ? spec.runId : (run.value?.runId ?? null) }
  const before = 'before' in spec ? spec.before : (spec.identity ? spec.identity() : null)
  actionNotice.value = ''
  const result = await runGuard(() => guardPass({
    alive: () => !disposed,
    current: () => pageCurrent(freshState, connection),
    load: () => load(),
    seq: () => freshState.seq,
    source: spec.source ?? null,
    check (fresh) {
      const where = checkTarget({ target, retires: spec.retires, current: currentIssue() && { project: project.value, issueId: issueId.value, selectedRunId: selectedRunId.value, listedRunIds: runs.value.map((r) => r.runId) } })
      if (!where.ok) return { reason: where.reason }
      // Offered is judged on the run the action was taken on, never on whichever run is selected now.
      const verdict = judgeAction({ offered: spec.offered(fresh, target), before, after: spec.identity ? spec.identity(fresh, target) : before })
      if (!verdict.send) return { reason: verdict.reason }
      const verified = spec.verify ? spec.verify(fresh) : true
      return verified === true ? null : { reason: 'changed', message: verified }
    },
    send: (fresh) => send(target, fresh)
  }))
  if (result.kind === 'send') return { sent: true, value: await result.value }
  const notice = result.message ?? REFUSAL[result.reason](spec.label)
  if (stillOnIssue({ project: target.project, id: target.issueId })) actionNotice.value = notice
  return { sent: false, notice }
}
/**
 * A read of an action's own source under its panel's latest-only sequence. A panel passes its
 * reporter: this read supersedes the panel's display read, so it settles the panel's state too.
 */
const ownRead = readOwn
/** A run as the page knows it: the selected one in full, any other from the run list. */
const runOf = (runId) => (run.value?.runId === runId ? run.value : runs.value.find((r) => r.runId === runId)) ?? null
/** The page's fresh state for an action's rule (action-offers.js): the issue, its runs, and the run acted on. */
const offerState = (t) => ({ issue: issue.value, runs: runs.value, run: runOf(t?.runId) })
const offerOn = (rule) => (_, t) => rule(offerState(t))
/*
 * An open confirmation whose offer a refresh withdrew says so inside the dialog and cannot be submitted
 * (AC5): judged by the same rule as its guard, on the run the dialog was opened for.
 */
const goneIn = (open, runIdOf, rule, label) => computed(() => (open.value && !rule(offerState({ runId: runIdOf() })) ? REFUSAL.gone(label) : ''))
const acceptCheckGone = goneIn(acceptCheckDialog, () => acceptCheckShown?.runId, (s) => offers.continuation('accept-check-result')(s) && Boolean(s.run?.acceptCheck), 'Accept check result')
const resumeGone = goneIn(resumeDialog, () => resumeRunId, offers.continuation('resume'), 'Resume run')
const cleanupGone = goneIn(cleanupDialog, () => cleanupRunId, offers.acknowledgeCleanup, 'Acknowledge cleanup')
const integrityGone = goneIn(integrityDialog, () => integrityRunId, offers.continuation('resolve-integrity'), 'Resolve integrity')
const closeGone = goneIn(closeDialog, () => null, (s) => Boolean(s.issue) && !s.issue.archived, 'Close issue')
provide('issueFreshness', {
  guard, ownRead, registry: children, retry: freshRetry, synced: freshSynced,
  // What starting a run depends on, for the start dialog's guard.
  startable: () => canStart.value,
  // The run as the page last published it: props reach children only at the next render.
  run: () => run.value,
  runOf,
  offerOn,
  issue: () => issue.value,
  startIdentity: () => ({ latestRunId: latestRun.value?.runId ?? null, live: Boolean(liveRun.value) })
})

/**
 * Ask the run to stop. The answer is `stopping`, not `stopped`: the run settles
 * only once termination is confirmed. Repeated requests are harmless, so the
 * only reason the button disables is to stop the operator wondering.
 */
/**
 * Answer the question a paused run asked. The engine records the answer as an
 * operator step and the run continues; a structured question accepts only one
 * of its options, which the buttons below reflect.
 */
watch(() => run.value?.pause?.id, () => { answerText.value = '' })

async function sendAnswer (choice = null) {
  if (!run.value?.pause) return
  const answer = (choice ?? answerText.value).trim()
  if (!answer || !actorName(answerActor.value)) { actionError.value = 'An answer and your name are both required.'; return }
  answerSending.value = true
  actionError.value = ''
  const shown = { pauseId: run.value.pause.id, question: run.value.pause.question ?? null }
  const actor = actorName(answerActor.value)
  try {
    const r = await guard({
      label: 'Answer',
      before: shown,
      identity: () => ({ pauseId: run.value?.pause?.id ?? null, question: run.value?.pause?.question ?? null }),
      offered: (fresh, t) => { const r = runOf(t.runId); return offerOn(offers.continuation('answer'))(fresh, t) && Boolean(r?.pause) && !['manual', 'full-verification'].includes(r.pause.kind) }
    }, (t) => api.answerRun(t.project, t.issueId, t.runId, answer, actor, shown.pauseId))
    if (r.sent) answerText.value = ''
  } catch (err) {
    actionError.value = err.message
  } finally {
    answerSending.value = false
    await load()
  }
}

async function requestStop () {
  if (!run.value) return
  stopRequested.value = true
  actionError.value = ''
  try {
    await guard({ label: 'Stop run', offered: offerOn(offers.stop) }, (t) => api.stopRun(t.project, t.issueId, t.runId))
  } catch (err) {
    actionError.value = err.message
  } finally {
    stopRequested.value = false
    await load()
  }
}

const selectedTurnData = computed(() =>
  run.value?.timeline.find((t) => t.number === selectedTurn.value) ?? null)


/* Socket events refresh the display, but the display is always rebuilt from
   persisted state — a refresh or a lost connection reconstructs the same view. */
function onChanged (payload) {
  if (!payload?.id || (payload.id === issueId.value && payload.project === project.value)) { tracker.invalidate(); load() }
}
/* A run event can be about a run this browser has never seen — a start from
   another tab, or one that outlived a reload — so the list is refreshed too. */
let pending = null
function onRunEvent (payload) {
  if (payload?.project !== project.value || payload?.issueId !== issueId.value) return
  // Output chunks arrive many times a second during a turn and change nothing
  // persisted here; LiveOutput reads them itself. Reloading the issue, its runs
  // and the whole run (megabytes) for each one was the cost. Activity only
  // refreshes the timeline's "last seen" line, so it reloads at most every 15 s.
  if (payload?.type === 'live') return
  if (payload?.type === 'activity') {
    if (Date.now() - activityLoadAt < 15_000) return
    activityLoadAt = Date.now()
  }
  // The server moved on: a refresh already in flight may no longer settle as current.
  tracker.invalidate()
  clearTimeout(pending)
  pending = setTimeout(() => load(), 120)
}
let activityLoadAt = 0

/* Reconnecting, or coming back to a hidden or sleeping tab, re-reads persisted
   state. Nothing is replayed from a buffer: the view a reconnecting browser builds
   is the same one a fresh browser builds. */
watch(() => connection.epoch, () => { tracker.invalidate(); load() })
watch(() => connection.resumes, () => { tracker.invalidate(); load() })
// A full verification freezes and thaws admission (the issue read's admissionFrozen) with no event of this issue.
watch(() => connection.verification?.seq, () => { tracker.invalidate(); load() })

onMounted(() => {
  children.setKey(`${project.value}/${issueId.value}`)
  load()
  clock = setInterval(() => { now.value = Date.now() }, 1000)
  socket.on('issues:changed', onChanged)
  socket.on('run:event', onRunEvent)
})

onUnmounted(() => {
  disposed = true
  tracker.reset()
  clearInterval(clock)
  clearTimeout(pending)
  socket.off('issues:changed', onChanged)
  socket.off('run:event', onRunEvent)
})

watch(() => route.query.run, (runId) => {
  if (runId && runId !== selectedRunId.value && currentIssue()) chooseRun(runId)
})
</script>

<template>
  <div :class="['issue', { 'issue--head-fills': !runFills }]">
    <StartRunDialog
      v-if="issue"
      v-model="showStart"
      :project="project"
      :issue-id="issueId"
      :prior-runs="runs.filter((r) => ['completed', 'blocked', 'failed', 'cancelled'].includes(r.status)).length"
      :initial-playbook="startPlaybook"
      @started="onStarted"
    />

    <!-- What is on the page: each card and section can be hidden, and stays so. -->
    <div v-if="issue" class="issue__sections" role="group" aria-label="Sections">
      <span class="issue__sections-label">Sections</span>
      <button v-for="s in pageSections" :key="s.id" type="button" class="section-toggle" :aria-pressed="shown(s.id)"
              :disabled="(s.parents ?? []).some((p) => !shown(p))" :title="`${shown(s.id) ? 'Hide' : 'Show'} ${s.label.toLowerCase()}`"
              @click="toggleSection(s.id)">{{ s.label }}</button>
      <FreshnessIndicator :view="view" class="issue__fresh" @retry="retry" />
    </div>

    <!-- ============================================== card 1: the issue -->
    <v-card v-if="issue" v-show="shown('issue')" elevation="0" border class="card head">
      <div class="head__top issue__head">
        <div class="head__titles">
          <div class="issue__crumb">
            <v-btn :to="`/projects/${project}`" variant="text" size="small" prepend-icon="$arrowLeft" class="issue__back">{{ projectLabel }}</v-btn>
          </div>
          <h1 class="issue__title">{{ issue.name }}</h1>
          <!-- Where it is on disk: its folder, or its bundle once packed. -->
          <CopyPath v-if="issue.location ?? issue.path" class="issue__location" :path="issue.location ?? issue.path"
                    :label="issue.packed ? 'Copy the archive bundle path' : 'Copy the issue folder path'" />
          <div class="issue__meta">
            <v-chip v-if="issue.kind" size="x-small" variant="tonal">{{ issue.kind === 'bug' ? 'Bug' : 'Feature' }}</v-chip>
            <v-chip v-if="issue.archived" size="x-small" variant="tonal">closed</v-chip>
            <v-chip v-for="tag in reportTags(issue.report, issue.openedBy?.host ? `${issue.openedBy.user}@${issue.openedBy.host}` : issue.openedBy?.user)" :key="tag.key"
                    size="x-small" variant="tonal" :color="tag.color" :title="tag.title"><v-icon :icon="tag.icon" size="12" class="mr-1" />{{ tag.text }}</v-chip>
            <span>opened {{ issue.openedOn }}<template v-if="issue.openedBy?.user"> by <strong :title="issue.openedBy.derived ? 'read from the issue\'s own record; it was opened before openers were recorded' : ''">{{ issue.openedBy.host ? `${issue.openedBy.user}@${issue.openedBy.host}` : issue.openedBy.user }}</strong></template></span>
            <span v-if="issue.packed" class="head__packed">
              <v-icon icon="$archive" size="15" /> Archived and packed<template v-if="issue.archive?.bundle"> · {{ formatBytes(issue.archive.bundle.bytes) }} ({{ formatBytes(issue.archive.bundle.unpackedBytes) }} unpacked)</template>
            </span>
            <button v-else type="button" class="head__folder-toggle" :aria-expanded="showFolder" @click="toggleFolder">
              <v-icon icon="$folder" size="15" /> Issue folder · {{ issue.steps.length }} {{ issue.steps.length === 1 ? 'entry' : 'entries' }}
              <span class="head__caret" :class="{ 'head__caret--open': showFolder }">▸</span>
            </button>
          </div>
          <IssueFamily :project="String(project)" :issue-id="issue.id" />
          <IssueOccurrences v-if="issue.occurrences?.count" :occurrences="issue.occurrences" :packed="Boolean(issue.packed)" />
          <!-- An older issue archived under this id: restoring it is refused while this folder stands. -->
          <section v-if="issue.archivedTwin" class="head__twin" aria-label="An archived issue with this id">
            <p class="head__twin-title">
              <v-icon icon="$archive" size="15" /> An older archived issue has this same id: <strong>{{ issue.archivedTwin.name }}</strong>
              <template v-if="issue.archivedTwin.disposition"> · {{ issue.archivedTwin.disposition.value.replace(/-/g, ' ') }}</template>
              <template v-if="issue.archivedTwin.packedAt"> · packed {{ issue.archivedTwin.packedAt }}</template>
            </p>
            <p class="head__twin-note">This page is the newer issue. Neither can replace the other, so this one cannot be archived and the older one cannot be restored while both hold the id.</p>
            <CopyPath class="issue__location" :path="issue.archivedTwin.location" label="Copy the archive bundle path" />
            <details v-for="result in issue.archivedTwin.results" :key="result.runId" class="head__twin-result">
              <summary>Result of run {{ result.runId }}</summary>
              <pre>{{ result.text }}</pre>
            </details>
          </section>
        </div>

        <!-- The issue's own facts, which no run sets. -->
        <div v-show="shown('decision')" class="head__decide">
    <!-- ---------------------------------------------------- your decision -->
    <!-- The issue's own facts, which no run sets: whether it is dealt with,
         and where it sits in the order. -->
    <section class="decision">

      <div class="decide">
        <span class="decide__label">Outcome</span>
        <div class="decide__value">
          <template v-if="issue.disposition">
            <v-chip size="x-small" variant="tonal" :color="dispositionColour(issue.disposition.value)">{{ issue.disposition.value.replace(/-/g, ' ') }}</v-chip>
            <span class="muted"> by {{ issue.disposition.by }}</span>
            <span v-if="issue.disposition.related?.length" class="muted"> →
              <template v-for="(r, i) in issue.disposition.related" :key="`${r.project}/${r.id}`">{{ i ? ', ' : '' }}<router-link :to="`/projects/${r.project}/${r.id}`">{{ r.project === project ? r.id : `${r.project}/${r.id}` }}</router-link></template>
            </span>
            <div class="decide__why" :title="issue.disposition.evidence">{{ issue.disposition.evidence }}</div>
          </template>
          <span v-else class="muted">Not decided yet</span>
        </div>
        <v-btn v-if="!issue.archived && !showDisposition" size="x-small" :variant="nextStepForIssue ? 'flat' : 'text'" :color="nextStepForIssue ? 'primary' : undefined" @click="showDisposition = true">{{ issue.disposition ? 'Change' : 'Record' }}</v-btn>
      </div>
      <form v-if="showDisposition && !issue.archived" class="form" @submit.prevent="saveDisposition">
        <select v-model="dispositionValue" aria-label="Disposition">
          <option v-for="d in DISPOSITION_OPTIONS" :key="d.value" :value="d.value">{{ d.value.replace(/-/g, ' ') }} — {{ d.hint }}</option>
        </select>
        <input v-if="dispositionNeedsRelated" v-model="dispositionRelated" aria-label="Related issues" :placeholder="dispositionValue === 'duplicate' ? 'Original issue id' : 'Issue ids, comma separated'" />
        <input v-model="dispositionEvidence" aria-label="Disposition evidence" placeholder="What was checked, and where" />
        <div class="form__buttons">
          <v-btn size="small" variant="text" @click="showDisposition = false">Cancel</v-btn>
          <v-btn type="submit" size="small" variant="flat" color="primary" :loading="savingDisposition" :disabled="!dispositionEvidence.trim() || (dispositionNeedsRelated && !dispositionRelated.trim())">Save</v-btn>
        </div>
      </form>
      <p v-if="dispositionError" class="error-text">{{ dispositionError }}</p>

      <div class="decide">
        <span class="decide__label">Priority</span>
        <div class="decide__value">
          <template v-if="issue.priority">
            <v-chip size="x-small" variant="tonal" :color="priorityColour(issue.priority.value)">{{ issue.priority.value }}</v-chip>
            <span class="muted"> by {{ issue.priority.by }}</span>
            <div class="decide__why" :title="issue.priority.reason">{{ issue.priority.reason }}</div>
          </template>
          <span v-else class="muted">Not set</span>
        </div>
        <v-btn v-if="!issue.archived && !showPriority" size="x-small" variant="text" @click="showPriority = true">{{ issue.priority ? 'Change' : 'Set' }}</v-btn>
      </div>
      <form v-if="showPriority && !issue.archived" class="form" @submit.prevent="savePriority">
        <select v-model="priorityValue" aria-label="Priority">
          <option value="urgent">urgent</option>
          <option value="high">high</option>
          <option value="normal">normal</option>
          <option value="low">low</option>
        </select>
        <input v-model="priorityReason" aria-label="Priority reason" placeholder="Why this order" />
        <div class="form__buttons">
          <v-btn size="small" variant="text" @click="showPriority = false">Cancel</v-btn>
          <v-btn type="submit" size="small" variant="flat" color="primary" :loading="savingPriority" :disabled="!priorityReason.trim()">Save</v-btn>
        </div>
      </form>
      <p v-if="priorityError" class="error-text">{{ priorityError }}</p>
      <!-- The latest triage's two-seat sizing (issue.json sizing): the size, each
           seat's sentence, the affected modules and the playbook it recommends. -->
      <div class="decide" data-testid="issue-sizing">
        <span class="decide__label">Size</span>
        <div class="decide__value">
          <template v-if="issue.sizing">
            <v-chip size="x-small" variant="tonal" :color="issue.sizing.size === 'minor' ? 'success' : 'warning'">{{ issue.sizing.size === 'minor' ? 'Minor issue' : 'Major issue' }}</v-chip>
            <span class="muted"> recommends {{ playbookTitle(issue.sizing.recommendedPlaybook) }}</span>
            <div v-for="seat in issue.sizing.seats ?? []" :key="seat.role" class="decide__why sizing__seat">
              <strong>{{ seat.size }}</strong> — {{ seat.reason }} <span class="muted">({{ seat.role }}{{ seat.model ? `, ${seat.model}` : '' }})</span>
            </div>
            <div v-if="issue.sizing.affectedModules?.length" class="sizing__modules">
              <code v-for="m in issue.sizing.affectedModules" :key="m">{{ m }}</code>
            </div>
          </template>
          <span v-else class="muted">Not sized yet: a Triage sizes it</span>
        </div>
        <v-btn v-if="issue.sizing?.recommendedPlaybook && canStart" size="x-small" variant="text"
               :aria-label="`Start ${playbookTitle(issue.sizing.recommendedPlaybook)}`"
               @click="openStart(issue.sizing.recommendedPlaybook)">Start {{ playbookTitle(issue.sizing.recommendedPlaybook) }}</v-btn>
      </div>
      <details v-if="(issue.priorityHistory?.length ?? 0) > 1" class="more">
        <summary>Priority history ({{ issue.priorityHistory.length }})</summary>
        <p v-for="(entry, i) in issue.priorityHistory" :key="i" class="muted">
          <strong>{{ entry.value }}</strong> — {{ entry.reason }} ({{ entry.by }}, {{ entry.at }})
        </p>
      </details>
    </section>

        </div>

        <div class="issue__actions" role="group" aria-label="Issue actions">
          <v-btn v-if="canStart" variant="flat" color="primary" size="small" prepend-icon="$play"
                 aria-label="Run a playbook" @click="openStart()">Run a playbook</v-btn>
          <v-btn v-if="!issue.archived" variant="text" size="small"
                 aria-label="Close issue" :title="liveRun ? 'Stop and close issue' : 'Close and archive issue'"
                 :disabled="archiving" :loading="archiving" @click="archiveIssue">Close</v-btn>
          <v-btn variant="text" size="small" icon="$refresh" :loading="loading"
                 aria-label="Reload" title="Reload issue" @click="load()" />
        </div>
      </div>

      <!-- Assess: what should happen to this issue next, asked of the decision
           provider or any roster model; on screen unless hidden from the Sections bar. -->
      <AssessBar v-if="!issue.packed" v-show="shown('assess')" :project="project" :issue-id="issueId" :archived="issue.archived" :version="issueVersion" @changed="load()" />

      <!-- The issue folder: what a person put there and what the agents wrote. -->
      <div v-if="showFolder" class="head__folder folder">
        <IssueMaterial :project="project" :issue-id="issueId" :steps="issue.steps" />
        <AddToIssue
          v-if="!issue.archived"
          class="mt-3"
          :project="project"
          :issue-id="issueId"
          @added="load()"
        />
      </div>
    </v-card>
    <div v-else class="issue__crumb">
      <v-btn :to="`/projects/${project}`" variant="text" size="small" prepend-icon="$arrowLeft">{{ projectLabel }}</v-btn>
    </div>

    <div v-if="supervisorQuestions.length" v-show="shown('questions')" class="issue__questions">
      <SupervisorQuestion v-for="q in supervisorQuestions" :key="q.id" :question="q" @answered="load()" />
    </div>

    <div class="issue__alerts">
      <!-- Before the first successful read there is no page to mark stale: say what failed. -->
      <v-alert v-if="loadError && !issue" type="error" variant="tonal" density="compact">
        {{ loadError }}
        <v-btn variant="text" size="small" :loading="loading" @click="retry()">Reload issue</v-btn>
      </v-alert>
      <v-alert v-if="actionNotice" type="info" variant="tonal" density="compact" closable data-test="action-notice" @click:close="actionNotice = ''">
        {{ actionNotice }}
      </v-alert>
      <v-alert v-if="runNotice" type="info" variant="tonal" density="compact" closable @click:close="runNotice = ''">{{ runNotice }}</v-alert>
      <v-alert v-if="actionError" type="error" variant="tonal" density="compact" closable @click:close="actionError = ''">
        {{ actionError }}
      </v-alert>
      <!-- The run keeps going without this browser; only the view goes stale. -->
      <v-alert v-if="connection.status !== 'online' && liveRun" type="warning" variant="tonal" density="compact">
        Connection lost. The run continues on the server; this page shows the last state it read and refreshes when the connection returns.
      </v-alert>
      <v-alert v-if="issue?.archived" type="info" variant="tonal" density="compact">
        Archived issue. All files have been preserved.
        <v-btn variant="text" size="small" :loading="archiving" @click="restoreIssue">Restore issue</v-btn>
      </v-alert>
    </div>


    <template v-if="issue">
      <!-- ----------------------------------------------------------- dialogs -->
      <v-dialog v-model="closeDialog" max-width="520">
        <v-card class="pa-4">
          <h2 class="issue__dialog-title">{{ closeTitle }}</h2>
          <p v-if="liveRun" class="muted">Stop the active run and close this issue after execution finishes. Existing work and logs will be kept.</p>
          <p v-else-if="interruptedRuns.length" class="muted">Close this issue and abandon its interrupted or paused runs? Existing work and logs will be kept. Their outcomes remain unverified.</p>
          <p v-if="!issue.disposition" class="muted">No outcome is recorded for this issue. You can record one under "Your decision", or close it now. A reason is optional and is kept on the issue.</p>
          <v-text-field v-model="closeReason" label="Reason for closing without a disposition (optional)" aria-label="Reason for closing without a disposition" autofocus />
          <v-alert v-if="closeGone" type="warning" variant="tonal" class="mb-3">{{ closeGone }}</v-alert>
          <v-alert v-if="actionError" type="error" variant="tonal" class="mb-3">{{ actionError }}</v-alert>
          <v-alert v-if="actionNotice" type="info" variant="tonal" class="mb-3">{{ actionNotice }}</v-alert>
          <div class="issue__dialog-actions">
            <v-btn variant="text" size="small" @click="closeDialog = false">Cancel</v-btn>
            <v-btn color="warning" variant="tonal" size="small" :disabled="archiving || Boolean(closeGone)" :loading="archiving" @click="archiveIssue">Close issue</v-btn>
          </div>
        </v-card>
      </v-dialog>

      <v-dialog v-model="integrityDialog" max-width="720" scrollable>
        <v-card>
          <v-card-title>Changes the integrity check held back</v-card-title>
          <v-card-text>
            <div v-if="integrityBusy && !integrityState" class="muted">Comparing the workspace with the state the turn received…</div>
            <v-alert v-if="integrityGone" type="warning" variant="tonal" density="compact" class="mb-3">{{ integrityGone }}</v-alert>
            <v-alert v-if="integrityError" type="error" variant="tonal" density="compact" class="mb-3">{{ integrityError }}</v-alert>
            <template v-if="integrityState">
              <p><strong>{{ integrityState.role }}</strong> — {{ integrityState.reason }}<template v-if="integrityState.cause"> ({{ integrityState.cause.class }}: {{ integrityState.cause.message }})</template></p>
              <p class="muted">Workspace: <code>{{ integrityState.workspace }}</code></p>
              <p v-if="integrityState.restored" class="muted">The workspace matches the state the turn received.</p>
              <template v-if="integrityState.changes">
                <p class="muted">{{ integrityState.changes.pathCount }} changed path(s)<template v-if="integrityState.changes.head">, Git history changed</template><template v-if="integrityState.changes.index">, index changed</template>:</p>
                <pre class="integrity__paths">{{ integrityState.changes.paths.join('\n') }}<template v-if="integrityState.changes.pathCount > integrityState.changes.paths.length">\n…</template></pre>
              </template>
              <v-text-field v-model="integrityReason" label="Reason (recorded with the decision)" density="compact" class="mt-3" />
            </template>
          </v-card-text>
          <v-card-actions class="integrity__actions">
            <v-btn :disabled="integrityBusy" @click="integrityDialog = false">Cancel</v-btn>
            <v-spacer />
            <template v-if="integrityState">
              <v-btn v-for="d in integrityState.dispositions" :key="d" :color="INTEGRITY_ACTIONS[d].color" :loading="integrityBusy" :disabled="!integrityReason.trim() || Boolean(integrityGone)" @click="resolveIntegrity(d)">{{ INTEGRITY_ACTIONS[d].label }}</v-btn>
            </template>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-dialog v-model="acceptCheckDialog" max-width="560" scrollable>
        <v-card title="Accept check result and deliver">
          <v-card-text>
            <p class="mb-2">Every reviewer approved this version. These failures would no longer stop its delivery; the run will read as not verified, and normal delivery still applies.</p>
            <ul class="mb-2"><li v-for="f in run?.acceptCheck?.failures ?? []" :key="f.key"><code>{{ f.key }}</code><template v-if="f.message"> — {{ f.message }}</template></li></ul>
            <p v-if="run?.acceptCheck?.notRun?.length" class="mb-2">Required commands that did not run because of them: <code>{{ run.acceptCheck.notRun.join(', ') }}</code></p>
            <p class="mb-4">If the coordinator has not confirmed this version, it is asked first, and nothing is accepted or delivered unless it confirms. The run page then says which happened.</p>
            <v-textarea v-model="acceptCheckReason" label="Why these failures are unrelated to this change" rows="3" density="compact" variant="outlined" />
            <v-alert v-if="acceptCheckGone" type="warning" variant="tonal" class="mb-2">{{ acceptCheckGone }}</v-alert>
            <v-alert v-if="actionError" type="error" variant="tonal">{{ actionError }}</v-alert>
          </v-card-text>
          <v-card-actions><v-spacer /><v-btn :disabled="acceptingCheck" @click="acceptCheckDialog = false">Cancel</v-btn><v-btn color="primary" :loading="acceptingCheck" :disabled="!acceptCheckReason.trim() || Boolean(acceptCheckGone)" @click="acceptCheckResult">Accept and deliver</v-btn></v-card-actions>
        </v-card>
      </v-dialog>

      <v-dialog v-model="resumeDialog" max-width="520">
        <v-card title="Resume this run">
          <v-card-text>
            <p class="mb-4">Continue with the saved workspace, sessions and completed steps. Time spent paused, or waiting for checks with no seat working, is excluded; previous usage remains recorded.</p>
            <p v-if="run?.blockedReason === 'rounds-exhausted'" class="mb-4">Resume grants one more review round.</p>
            <p v-if="run?.blockedReason === 'protocol-repair-exhausted'" class="mb-4">Resume grants one more response repair attempt.</p>
            <v-text-field type="number" v-for="(_, key) in resumeBudgets" :key="key" v-model.number="resumeBudgets[key]"
              :label="key === 'wallClockMinutes' ? 'Total active time limit (minutes)' : key === 'maxSteps' ? 'Total step limit' : 'Total token limit'"
              :min="run?.budgets?.limits?.[key] ?? 1" density="compact" variant="outlined" />
            <p v-if="resumeClock" class="mb-2">{{ resumeClock.text }}</p>
            <v-alert v-if="resumeClock?.exhausted" type="warning" variant="tonal" class="mb-2">No time is left under this limit: raise it to resume.</v-alert>
            <v-checkbox v-if="resumeClock?.short" v-model="acceptShortWallClock" density="compact" hide-details label="Less than a mean round is left: resume anyway. A turn may be cut at the deadline." />
            <v-alert v-if="resumeGone" type="warning" variant="tonal" class="mb-2">{{ resumeGone }}</v-alert>
            <v-alert v-if="actionError" type="error" variant="tonal">{{ actionError }}</v-alert>
          </v-card-text>
          <v-card-actions><v-spacer /><v-btn :disabled="resuming" @click="resumeDialog = false">Cancel</v-btn><v-btn color="primary" :loading="resuming" :disabled="Boolean(resumeGone)" @click="resumeRun">Resume saved run</v-btn></v-card-actions>
        </v-card>
      </v-dialog>

      <v-dialog v-model="cleanupDialog" max-width="560">
        <v-card title="Acknowledge cleanup">
          <v-card-text>
            <p class="mb-2">{{ run?.explanation?.detail }}</p>
            <p v-if="run?.explanation?.cause" class="muted mb-2"><code>{{ run.explanation.cause }}</code></p>
            <p class="mb-4">You are recording that no process a turn started is still running. Your name and reason are kept on the run and on the project.</p>
            <v-textarea v-model="cleanupReason" label="What you checked (required)" rows="3" auto-grow counter="2000" density="compact" variant="outlined" />
            <v-alert v-if="cleanupGone" type="warning" variant="tonal" class="mb-2">{{ cleanupGone }}</v-alert>
            <v-alert v-if="cleanupError" type="error" variant="tonal">{{ cleanupError }}</v-alert>
          </v-card-text>
          <v-card-actions><v-spacer /><v-btn :disabled="cleanupBusy" @click="cleanupDialog = false">Cancel</v-btn><v-btn color="primary" :loading="cleanupBusy" :disabled="!cleanupReason.trim() || Boolean(cleanupGone)" @click="acknowledgeCleanup">Acknowledge</v-btn></v-card-actions>
        </v-card>
      </v-dialog>


      <!-- ================================================ card 2: the run -->
      <!-- An archived issue: where its time went, per seat, model and standing. -->
      <v-card v-if="issue.archived" v-show="shown('stats')" elevation="0" border class="card">
        <IssueStats :project="project" :issue-id="issueId" :version="issueVersion" />
      </v-card>
      <!-- A packed archive: what each run came to, read from its summary. -->
      <v-card v-if="issue.archivedNotes?.length" elevation="0" border class="card" data-testid="archived-notes">
        <h2 class="packed__title">Notes since this issue was archived</h2>
        <p class="muted">Restoring the issue makes each a step.</p>
        <MarkdownText v-for="note in issue.archivedNotes" :key="note.invocationId" :text="note.text" compact />
      </v-card>

      <v-card v-if="issue.packed" v-show="shown('run')" elevation="0" border class="card runcard packed">
        <div class="packed__head">
          <h2 class="packed__title">What the runs came to</h2>
          <span class="muted">{{ packedResults.length }} run{{ packedResults.length === 1 ? '' : 's' }}<template v-if="issue.archive?.packedAt"> · packed {{ issue.archive.packedAt.slice(0, 10) }}</template> · restore the issue to see every turn</span>
        </div>
        <div class="packed__list">
          <p v-if="!packedResults.length" class="muted">No run was ever started on this issue.</p>
          <details v-for="(r, i) in packedResults" :key="r.runId" class="packed__run" :open="route.query.run ? r.runId === route.query.run : i === 0" :data-packed-run="r.runId" :class="{ 'alert-focus': route.query.run === r.runId }">
            <summary>
              <span class="packed__headline">{{ r.text.split('\n')[0].replace(/^#\s*/, '') }}</span>
              <span class="muted">{{ r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : '' }} · {{ r.status }}</span>
            </summary>
            <MarkdownText :text="r.text.split('\n').slice(1).join('\n').trim()" compact />
          </details>
          <p v-for="op in issue.archive?.operations ?? []" :key="op.id" class="muted" data-testid="packed-operation">Shared staging deployment {{ op.id }} · {{ op.status }}{{ op.startedAt ? ` · ${op.startedAt.slice(0, 16).replace('T', ' ')}` : '' }}</p>
        </div>
      </v-card>

      <v-card v-else v-show="shown('run') && !runEmpty" elevation="0" border :class="['card', 'runcard', { 'runcard--status-fills': run && !workspaceColumns }]">
        <!-- ------------------------------------------- where this stands -->
        <div v-if="!run" v-show="shown('status')" class="status status--neutral">
          <div class="status__headline">No runs yet</div>
          <p class="status__detail">
            <template v-if="issue.archived">Restore the issue to start a playbook.</template>
            <template v-else>Run a playbook to have agents work on this issue. The issue's description and files are in the issue folder above.</template>
          </p>
        </div>


        <template v-if="run">
          <v-alert v-if="alertTarget" :type="alertTarget.state === 'handled' ? 'success' : alertTarget.state === 'recovery' ? 'warning' : 'info'" variant="tonal" density="compact" class="mb-2" data-testid="alert-target">
            <template v-if="alertTarget.state === 'waiting'">This run is still waiting on the {{ alertTarget.what }} the alert named: its action is highlighted below.</template>
            <template v-else-if="alertTarget.state === 'recovery'">The run now needs recovery, so the {{ alertTarget.what }} the alert named cannot be answered until it is recovered.</template>
            <template v-else>The {{ alertTarget.what }} the alert named was already handled. The run is now {{ alertTarget.status }}<template v-if="alertTarget.blockedReason"> ({{ alertTarget.blockedReason.replace(/-/g, ' ') }})</template>.</template>
          </v-alert>
          <div v-show="shown('runbar')" class="runbar">
            <v-select
              :model-value="pendingRunId ?? selectedRunId"
              :loading="pendingRunId != null"
              :items="runs"
              :item-title="runTitle"
              item-value="runId"
              class="runs__select"
              :label="`Run ${runs.length - runs.findIndex((r) => r.runId === selectedRunId)} of ${runs.length}`"
              density="compact"
              variant="outlined"
              hide-details
              @update:model-value="chooseRun"
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps" role="option" :title="runTitle(item)">
                  <template #subtitle>{{ item.explanation?.headline ?? runStatus(item) }}</template>
                </v-list-item>
              </template>
            </v-select>
            <div class="runbar__meta">
              <v-chip size="small" variant="tonal" :color="RUN_COLOUR[run.status]">{{ run.status }}</v-chip>
              <!-- Ran without the seat fence (macOS under the install's opt-in): always shown for that run. -->
              <v-chip v-if="run.unfenced" size="small" variant="tonal" color="warning" :title="run.unfenced.reason">unfenced</v-chip>
              <span>{{ elapsed ?? '—' }}</span>
              <span v-if="costText">{{ costText }}</span>
              <code class="runbar__id">{{ run.runId }}</code>
            </div>
          <div v-if="!issue.archived" class="runbar__actions">
            <v-btn v-if="canAcknowledgeCleanup" size="small" variant="tonal" color="warning" @click="openCleanupDialog">Acknowledge cleanup…</v-btn>
            <v-btn v-if="canResume" size="small" variant="flat" color="primary" :loading="resuming" @click="openResume">Resume run</v-btn>
            <ContinueRun v-if="canContinue" :project="project" :issue-id="issueId" :run="run" @continued="load()" />
            <v-btn v-if="canRefreshChecks" size="small" variant="tonal" color="primary" :loading="refreshingChecks" @click="refreshChecks">Refresh checks</v-btn>
            <v-btn v-if="canAcceptCheck" size="small" variant="tonal" color="warning" @click="openAcceptCheck">Accept check result…</v-btn>
            <v-btn v-if="canReconcile" size="small" variant="flat" color="primary" :loading="reconciling" @click="reconcileDelivery">Reconcile with source</v-btn>
            <v-btn v-if="canFinalize" size="small" variant="flat" color="primary" :loading="finalizing" @click="finalizeRun">Finalize run</v-btn>
            <v-btn v-if="canRecover" size="small" variant="flat" color="primary" :loading="recovering" data-alert-action="recover" :class="{ 'alert-focus': alertTarget?.target === 'recover' }" @click="recoverRun">Recover run</v-btn>
            <v-btn v-if="canResolveIntegrity" size="small" variant="flat" color="primary" data-alert-action="resolve-integrity" :class="{ 'alert-focus': alertTarget?.target === 'resolve-integrity' }" @click="openIntegrity">Inspect changes</v-btn>
            <v-btn v-if="canPause" size="small" variant="tonal" :loading="pausing" @click="requestPause">Pause run</v-btn>
            <!-- Stopping is a state, not an instant. It ends when the runtime
                 confirms termination, so the button stays spent until then. -->
            <v-btn v-if="isStopping" size="small" variant="tonal" color="warning" disabled prepend-icon="$stop">Stopping…</v-btn>
            <v-btn v-else-if="canStop" size="small" variant="tonal" color="warning"
                   prepend-icon="$stop" :loading="stopRequested" data-alert-action="stop" :class="{ 'alert-focus': alertTarget?.target === 'stop' }" @click="requestStop">Stop run</v-btn>
            <v-btn v-if="(run.supportedActions ?? []).includes('abandon')" size="small" variant="text" color="warning" :loading="abandoning" data-alert-action="abandon" :class="{ 'alert-focus': alertTarget?.target === 'abandon' }" @click="abandonRun">Abandon run</v-btn>
            <v-btn v-if="canDeleteRun" icon="$delete" size="small" variant="text" color="error" title="Delete this run (workspace, record and its steps)" aria-label="Delete this run" :loading="deletingRun" @click="deleteRun" />
          </div>
          </div>

        <div v-show="shown('status')" :class="['status', `status--${explanation.tone}`]">
          <div class="status__top">
            <v-progress-circular v-if="explanation.tone === 'progress'" indeterminate size="16" width="2" color="primary" />
            <div class="status__headline">{{ explanation.headline }}</div>
          </div>
          <p v-if="explanation.detail" :class="['status__detail', { 'is-clamped': statusIsLong && !statusOpen }]">{{ explanation.detail }}</p>
          <pre v-if="explanation.cause" class="status__cause">{{ explanation.cause }}</pre>

          <ul v-if="explanation.unmet?.length" class="status__unmet">
            <li v-for="(u, i) in explanation.unmet" :key="i" :class="{ 'is-clamped': statusIsLong && !statusOpen }">
              <strong v-if="u.id">{{ u.id }}</strong><span v-if="u.id && u.text"> · </span>{{ u.text ?? 'not met' }}
            </li>
          </ul>
          <button v-if="statusIsLong" type="button" class="status__more" @click="statusOpen = !statusOpen">
            {{ statusOpen ? 'Show less' : 'Show the full reasoning' }}
          </button>

          <!-- What a triage's autoStart did when the run ended (auto-start.mjs). -->
          <div v-if="run.autoStart" class="status__suggest" data-testid="auto-start">
            <template v-if="run.autoStart.startedRunId">
              <strong>Started {{ playbookTitle(run.autoStart.playbook) }}</strong>
              <span class="muted"> — run {{ run.autoStart.startedRunId }}, as this triage recommended</span>
            </template>
            <template v-else-if="run.autoStart.refusal">
              <strong>{{ playbookTitle(run.autoStart.playbook) }} was not started</strong>
              <span class="status__suggest-why" :title="run.autoStart.refusal.message"> — {{ run.autoStart.refusal.message }}</span>
            </template>
            <template v-else>
              <strong>Nothing started automatically</strong>
              <span class="muted"> — {{ run.autoStart.reason?.startsWith('verdict:') ? `the triage verdict was ${run.autoStart.reason.slice(8)}` : run.autoStart.reason }}</span>
            </template>
          </div>
          <!-- What triage advised doing with the issue: a suggestion, never an action. -->
          <div v-if="run.triageSuggestion?.action" class="status__suggest">
            <strong>Triage suggests: {{ run.triageSuggestion.label }}</strong>
            <span v-if="run.triageSuggestion.source === 'operator'" class="muted"> (set by an operator)</span>
            <span v-if="run.triageSuggestion.reason" class="status__suggest-why" :title="run.triageSuggestion.reason"> — {{ run.triageSuggestion.reason }}</span>
          </div>

          <!-- A paused run asked a question. Nothing is in flight; the answer is
               recorded as a step of its own and the run goes on from it. -->
          <div v-if="run.status === 'paused' && run.pause && !['manual', 'full-verification'].includes(run.pause.kind) && !run.journal?.recoveryRequired" class="answer" data-alert-action="answer" :class="{ 'alert-focus': alertTarget?.target === 'answer' && alertTarget.state === 'waiting' }">
            <!-- The consult panel's wording of the question for a person; an option fills the answer. -->
            <QuestionBrief v-if="run.pause.brief" :brief="run.pause.brief" :consult="run.pause.consult" @choose="answerText = $event" />
            <v-text-field v-if="!proxyUser" v-model="answerActor" label="Your name" density="compact"
                          variant="outlined" hide-details class="answer__actor" />
            <div v-if="run.pause.options" class="answer__options">
              <v-btn v-for="option in run.pause.options" :key="option" size="small" variant="tonal"
                     color="primary" :loading="answerSending" @click="sendAnswer(option)">{{ option }}</v-btn>
            </div>
            <template v-else>
              <v-textarea v-model="answerText" label="Answer" rows="3" auto-grow density="compact"
                          variant="outlined" hide-details />
              <v-btn size="small" variant="flat" color="primary" :loading="answerSending" @click="sendAnswer()">
                Send answer and continue
              </v-btn>
            </template>
          </div>

          <!-- Triage asked the owner before starting; the run has ended and holds nothing. -->
          <OwnerInput v-if="run.ownerInput && !run.ownerInput.answer" :project="project" :issue-id="issueId" :run="run" data-alert-action="owner-input" :class="{ 'alert-focus': alertTarget?.target === 'owner-input' && alertTarget.state === 'waiting' }" @answered="load()" />

          <p v-if="explanation.next || explanation.kept" class="status__next">
            {{ [explanation.kept, explanation.next].filter(Boolean).join(' ') }}
          </p>

          <p v-if="run.pauseRequested" class="status__note" role="status">{{ isPreflighting ? 'Pausing after setup finishes…' : 'Pausing after the current turn…' }}</p>
        </div>
          <!-- Steps on the left, the selected one on the right. The summary
               entry holds what the run left behind; an in-flight turn opens
               its live terminal. -->
          <div v-show="workspaceColumns" :class="['workspace', { 'workspace--one': workspaceColumns === 1 }]">
            <div v-show="shown('timeline')" class="workspace__timeline">
              <button type="button" class="summary-entry" :class="{ 'summary-entry--on': selectedTurn === 'summary' }"
                      :aria-pressed="selectedTurn === 'summary'" @click="selectedTurn = 'summary'">
                <v-icon icon="$issues" size="16" />
                <span>Run summary</span>
                <span class="summary-entry__hint">outcome · left open · technical details</span>
              </button>
              <button v-if="run.participants?.coordinator" type="button" class="summary-entry" :class="{ 'summary-entry--on': selectedTurn === 'chat' }"
                      :aria-pressed="selectedTurn === 'chat'" @click="selectedTurn = 'chat'">
                <v-icon icon="$chat" size="16" />
                <span>Coordinator chat</span>
                <span class="summary-entry__hint">reasoning · ask · instruct</span>
              </button>
              <RunTimeline
                :timeline="run.timeline"
                :active="run.active"
                :selected="selectedTurn"
                @select="selectedTurn = $event"
              />
            </div>
            <div v-show="shown('detail')" class="workspace__detail">
              <CoordinatorChat v-if="selectedTurn === 'chat'" :project="project" :issue-id="issueId" :run="run"
                               class="chat-detail" @open-turn="selectedTurn = $event" />
              <div v-else-if="selectedTurn === 'summary'" class="summary">
          <!-- --------------------------------------------------------- outcome -->
          <!-- Only once a run has ended: a finished run is not a resolved issue.
               What was delivered, and what it left open. -->
          <section v-if="ended" v-show="shown('outcome')" class="block">
            <h2 class="block__title">Outcome</h2>

            <div class="line">
              <v-icon :icon="deliveryLine.ok ? '$checkCircle' : '$alertCircle'" size="16" :color="deliveryLine.ok ? 'success' : undefined" />
              <span>{{ deliveryLine.text }}{{ deliveryLine.where ? ' ' : '' }}<code v-if="deliveryLine.where">{{ deliveryLine.where }}</code></span>
            </div>
            <div class="line">
              <v-icon :icon="run.closure?.verificationLevel === 'verified' ? '$checkCircle' : '$circleOutline'" size="16" :color="run.closure?.verificationLevel === 'verified' ? 'success' : undefined" />
              <span>{{ verificationText }}</span>
            </div>

            <PatchCheck v-if="run.delivery?.artifactRef && !issue.packed" :project="project" :issue-id="issueId" :run="run" />
            <div v-if="run.delivery?.artifactRef" class="block__actions">
              <v-btn size="small" variant="tonal" @click="downloadPatch">Download patch</v-btn>
              <v-btn v-if="run.status === 'completed' && ['worktree-diff', 'commit'].includes(run.delivery.action) && !run.artifactApplication?.verified && !run.integration?.mergeCommit" size="small" variant="tonal" :loading="applyingArtifact" @click="applyArtifact">Apply patch to project</v-btn>
            </div>
            <p v-if="run.artifactApplication?.error" class="error-text">{{ run.artifactApplication.error }}</p>

            <!-- Commit delivery: merging into the integration branch is an operator's call. -->
            <p v-if="run.integration?.error" class="error-text">Merge refused: {{ run.integration.error }}</p>
            <div v-if="run.integration?.warning" class="warning-text">
              <strong>Merged; a checkout needs attention.</strong> {{ run.integration.warning }}
              <ul><li v-for="w in run.integration.worktrees?.stale ?? []" :key="w.worktree"><code>{{ w.worktree }}</code>: {{ w.error }}<template v-if="w.remedy"> — {{ w.remedy }}</template></li></ul>
            </div>
            <div v-if="run.integration && ['publishing', 'published'].includes(run.integration.phase)" class="warning-text">
              <strong>Merge unfinished</strong> (interrupted at "{{ run.integration.phase }}").
              <v-btn size="x-small" variant="tonal" @click="reconcileIntegration">Finish it now</v-btn>
            </div>
            <div v-if="canIntegrate" class="block__actions">
              <template v-if="integrationTargetInfo">
                <span v-if="!integrationTargetInfo.declared" class="muted">No source repository is declared for this project (projects/{{ project }}.yaml), so merging is refused.</span>
                <span v-else-if="integrationTargetInfo.sameRepository === false" class="muted">The change was committed in a different repository than the project's; merging is refused.</span>
                <template v-else>
                  <span class="muted">into <code>{{ integrationTargetInfo.branch }}</code> at <code>{{ short(integrationTargetInfo.head) }}</code></span>
                  <v-btn size="small" variant="tonal" color="primary" :loading="integrating" @click="integrate">Merge the change</v-btn>
                </template>
              </template>
              <v-btn v-else size="small" variant="tonal" :loading="loadingTarget" @click="loadIntegrationTarget">Prepare merge</v-btn>
            </div>
            <p v-if="integrationError" class="error-text">{{ integrationError }}</p>

            <!-- A report's findings, each filed as its own issue. -->
            <template v-if="reportFindings.length">
              <h3 class="block__sub">Findings</h3>
              <ol class="findings">
                <li v-for="finding in reportFindings" :key="finding.key">
                  {{ finding.title ?? finding.key }}
                  <router-link v-if="finding.issueId && finding.issueId !== issueId" :to="`/projects/${project}/${finding.issueId}`" class="muted">open issue</router-link>
                </li>
              </ol>
            </template>

            <template v-if="run.release">
              <h3 class="block__sub">Release to {{ run.release.environment }}: {{ run.release.status }}</h3>
              <details v-for="command in run.release.commands" :key="command.startedAt + command.id" class="more">
                <summary>{{ command.id }}: {{ command.status }}</summary>
                <p v-if="command.error" class="error-text">{{ command.error }}</p>
                <pre class="mono-block">{{ command.stdout }}{{ command.stderr }}</pre>
              </details>
            </template>
            <!-- The production half of "Staging first, Deployment on success", after staging passed. -->
            <template v-if="run.productionRelease">
              <h3 class="block__sub">Then production release to {{ run.productionRelease.environment }}: {{ run.productionRelease.status }}</h3>
              <details v-for="command in run.productionRelease.commands" :key="'production' + command.startedAt + command.id" class="more">
                <summary>{{ command.id }}: {{ command.status }}</summary>
                <p v-if="command.error" class="error-text">{{ command.error }}</p>
                <pre class="mono-block">{{ command.stdout }}{{ command.stderr }}</pre>
              </details>
            </template>

            <!-- What the coordinator said remains. Never summarised away. -->
            <template v-if="orderedRisks.length">
              <h3 class="block__sub">Left open</h3>
              <div v-for="risk in orderedRisks" :key="risk.index" class="line line--top">
                <v-icon :icon="risk.accepted === false ? '$alertCircle' : '$checkCircle'" size="16" :color="risk.accepted === false ? 'warning' : undefined" />
                <span>
                  {{ risk.description }}
                  <span class="muted">{{ risk.accepted === false ? '· needs follow-up' : '· accepted' }}</span>
                  <RouterLink v-if="followUpFor(risk)" :to="`/projects/${project}/${followUpFor(risk)}`"> · follow-up issue</RouterLink>
                </span>
              </div>
              <v-btn v-if="openRisks.length && !issue.archived && openRisks.some((r) => !followUpFor(r))" size="small" variant="tonal" class="mt-2" :loading="creatingFollowUps" @click="createFollowUps">
                Open follow-up issues ({{ openRisks.filter((r) => !followUpFor(r)).length }})
              </v-btn>
            </template>
          </section>

                <p v-if="!ended" class="muted">The run is still going; its outcome is written here when it ends.</p>
          <!-- ----------------------------------------------- technical details -->
          <!-- Everything the record holds, unchanged, for whoever needs to dig. -->
          <details v-show="shown('tech')" class="tech">
            <summary>Technical details</summary>

            <div class="tech__body">

              <p class="kv"><span>Folder</span><code>{{ issue.path }}</code></p>

              <template v-if="run">
                <p class="kv"><span>Playbook</span>{{ run.playbook.id }} <span class="muted">({{ run.playbook.strategy }} v{{ run.playbook.strategyVersion }})</span></p>
                <p class="kv"><span>Status</span>{{ run.status }}<template v-if="run.blockedReason"> · <code>{{ run.blockedReason }}</code></template></p>
                <p v-if="run.result" class="kv"><span>Result</span>{{ run.resultLabel ?? run.result }}</p>
                <p class="kv"><span>Phase</span>{{ run.phase?.id ?? '—' }}<template v-if="run.phase && run.phase.round > 0"> · round {{ run.phase.round + 1 }}</template></p>
                <p v-if="timing" class="kv"><span>Agent time</span>{{ formatHms(timing.agentMs) }} in agents, of {{ elapsed }} total</p>
                <p v-if="metrics" class="kv"><span>Rounds</span>{{ metrics.roundsText }}</p>
                <p v-if="metrics" class="kv"><span>Time split</span>{{ metrics.timeText }}</p>
                <p v-if="metrics?.findingsText" class="kv"><span>Findings</span>{{ metrics.findingsText }}</p>
                <p v-if="metrics?.regressionsText" class="kv"><span>Regressions</span>{{ metrics.regressionsText }}</p>
                <p v-if="run.landed" class="kv"><span>Landed by hand</span>{{ run.landed.by }} · {{ run.landed.commit ? `commit ${run.landed.commit}` : run.landed.checkout }} · {{ run.landed.landedAt }} · {{ run.landed.applied }} · beyond the patch: {{ run.landed.handChanges }}</p>
                <p v-if="timing && (timing.abandonedMs > 0 || timing.unknownSteps > 0)" class="kv"><span>Unaccounted</span>{{ formatMillis(timing.abandonedMs) }} abandoned turns<template v-if="timing.unknownSteps"> · {{ timing.unknownSteps }} step(s) unmeasured</template></p>
                <p v-if="preflight" class="kv"><span>Preflight</span>{{ preflight.state }} · {{ preflight.attempts }} probe{{ preflight.attempts === 1 ? '' : 's' }}<template v-if="preflight.usage?.tokens"> · {{ formatMTokens(preflight.usage.tokens) }}</template></p>
                <pre v-if="preflight?.detail" class="mono-block">{{ preflight.detail }}</pre>

                <h3 class="block__sub">Budgets</h3>
                <div class="budgets">
                  <div v-for="b in budgets.filter((x) => x.key !== 'maxCostUsd')" :key="b.key" class="budget">
                    <span class="budget__name">{{ BUDGET_NAME[b.key] ?? b.key }}</span>
                    <v-progress-linear :model-value="Math.min(100, (b.used / b.cap) * 100)" height="4" rounded
                                       :color="b.used / b.cap > 0.9 ? 'error' : b.used / b.cap > 0.75 ? 'warning' : 'primary'" />
                    <span class="budget__figure">{{ b.used }} / {{ b.cap }}{{ b.unit }}</span>
                  </div>
                </div>

                <template v-if="run.failure">
                  <h3 class="block__sub">Runtime failure</h3>
                  <p class="kv"><span>Class</span>{{ run.failure.class }} in {{ run.failure.role }} · {{ run.failure.stepId }}<template v-if="run.failure.retries"> · retried {{ run.failure.retries }}×</template></p>
                  <pre class="mono-block">{{ run.failure.message }}</pre>
                </template>
                <template v-if="run.integrity?.status === 'quarantined'">
                  <h3 class="block__sub">Integrity quarantine</h3>
                  <p class="muted">{{ run.integrity.latest?.reason }} · {{ run.integrity.latest?.role }} · turn {{ run.integrity.latest?.invocationId }}</p>
                  <pre class="mono-block">{{ (run.integrity.latest?.changes?.paths ?? []).map((e) => `${e.change}: ${e.path}`).join('\n') }}</pre>
                </template>
                <p v-if="run.journal?.recoveryRequired" class="error-text">{{ run.journal.message }} Only the readable event prefix is shown; the original journal and workspace are retained.</p>
                <p v-if="run.recovery?.reason" class="kv"><span>Recovery</span>{{ run.recovery.reason }}</p>

                <h3 class="block__sub">Workspace</h3>
                <p class="kv"><span>Path</span><code>{{ run.workspace?.path ?? '—' }}</code> <span class="muted">{{ run.workspace?.state }}</span></p>
                <p v-if="run.workspace?.base" class="kv"><span>Base</span>{{ run.workspace.base.policy }} · {{ short(run.workspace.baseCommit) }}<template v-if="run.workspace.base.dirtyPaths"> · {{ run.workspace.base.dirtyPaths }} modified path(s)</template></p>
                <p v-if="run.currentWindow" class="kv"><span>Evidence window</span>{{ run.currentWindow.capturedAt }} · {{ run.currentWindow.coverage }}</p>

                <h3 class="block__sub">Candidate</h3>
                <p v-if="!run.currentRevision" class="muted">No code candidate was produced.</p>
                <p v-else class="kv"><span>Revision</span><code class="wrap">{{ run.currentRevision }}</code> <span class="muted">({{ run.revisions.length }} recorded)</span></p>
                <template v-if="run.revisions.at(-1)?.modules">
                  <p class="kv"><span>Changed modules</span><template v-if="run.revisions.at(-1).modules.changed.length"><code v-for="m in run.revisions.at(-1).modules.changed" :key="m" class="mr-2">{{ m }}</code></template><span v-else class="muted">none</span></p>
                  <p v-if="run.revisions.at(-1).affectedModules?.unlisted?.length" class="kv"><span>Not in the triage list</span><code v-for="m in run.revisions.at(-1).affectedModules.unlisted" :key="m" class="mr-2">{{ m }}</code></p>
                  <p v-if="run.revisions.at(-1).affectedModules?.core" class="kv"><span>Core directories</span><code v-for="d in run.revisions.at(-1).affectedModules.core.dirs" :key="d" class="mr-2">{{ d }}</code></p>
                </template>

                <h3 class="block__sub">Approvals</h3>
                <p v-if="!run.approvals.length" class="muted">None.</p>
                <p v-for="a in run.approvals" :key="a.step" class="kv"><span>{{ a.role }}</span>step {{ a.step }} · {{ a.appliesToCurrentRevision ? 'applies' : 'superseded' }} · <code>{{ short(a.revision) }}</code></p>

                <h3 class="block__sub">Checks</h3>
                <p class="muted">requirement {{ run.checks?.requirement ?? '—' }} · target {{ run.checks?.target?.kind ?? 'none' }}</p>
                <div v-for="c in run.checkResults" :key="`${c.revision}:${c.at}`" class="check">
                  <p class="kv"><span>{{ c.result }}</span><code>{{ short(c.revision) }}</code> · {{ c.target ?? 'no target' }}<template v-if="c.tier"> · {{ c.tier }} tier</template><template v-if="c.materialization"> · candidate {{ c.materialization.verified ? 'verified' : 'NOT verified' }}</template><template v-if="c.carriedFrom"> · carried from <code>{{ short(c.carriedFrom) }}</code>, no drive</template><template v-if="c.continuedFrom"> · continued the smoke's instance</template><template v-else-if="c.continuation"> · from scratch ({{ c.continuation.reason }})</template><template v-if="!c.appliesToCurrentRevision"> · superseded</template></p>
                  <p v-if="c.error" class="muted">{{ c.error }}</p>
                  <p v-for="m in c.modules?.tests ?? []" :key="m.id" class="kv kv--indent"><code>{{ m.id }}</code> {{ m.slot }} of <code>{{ m.module ?? `core ${m.core}` }}</code></p>
                  <p v-for="cmd in c.commands ?? []" :key="cmd.id" class="kv kv--indent">
                    <v-icon :icon="cmd.passed ? '$checkCircle' : '$alertCircle'" size="14" :color="cmd.passed ? 'success' : cmd.required ? 'error' : 'warning'" />
                    <code>{{ cmd.id }}</code> exit {{ cmd.exitCode ?? cmd.signal ?? '—' }}{{ cmd.timedOut ? ' (timed out)' : '' }}{{ cmd.required === false ? ' · optional' : '' }}<template v-if="cmd.durationMs != null"> · {{ Math.round(cmd.durationMs / 1000) }}s</template> · <code>{{ c.dir }}/{{ cmd.log }}</code>
                  </p>
                </div>

                <template v-if="run.diagnosticDrives?.length">
                  <h3 class="block__sub">Diagnostic drives</h3>
                  <p class="muted">Variants of a revision, driven for evidence: not checks, not reviewed, not delivered.</p>
                  <div v-for="d in run.diagnosticDrives" :key="d.n" class="check">
                    <p class="kv"><span>{{ d.result ?? d.status }}</span>of <code>{{ short(d.ofRevision) }}</code> · {{ d.target ?? 'no drive' }} · {{ d.reason }}</p>
                    <p v-if="d.error" class="muted">{{ d.error }}</p>
                    <p v-for="cmd in d.commands ?? []" :key="cmd.id" class="kv kv--indent">
                      <v-icon :icon="cmd.passed ? '$checkCircle' : '$alertCircle'" size="14" :color="cmd.passed ? 'success' : 'warning'" />
                      <code>{{ cmd.id }}</code> exit {{ cmd.exitCode ?? cmd.signal ?? '—' }} · <code>{{ d.dir }}/{{ cmd.log }}</code>
                    </p>
                  </div>
                </template>

                <h3 class="block__sub">Outstanding findings</h3>
                <p v-if="!run.outstandingFindings.length" class="muted">None.</p>
                <p v-for="f in run.outstandingFindings" :key="f.id" class="kv"><span>{{ f.severity }}</span>{{ f.description }}</p>

                <h3 class="block__sub">Delivery</h3>
                <p v-if="!run.delivery" class="muted">Nothing delivered.</p>
                <template v-else>
                  <p class="kv"><span>{{ run.delivery.action }}</span>{{ run.delivery.completedAt ? 'completed' : 'not completed' }}<template v-if="run.delivery.artifactRef"> · <code>{{ run.delivery.artifactRef }}</code></template><template v-if="run.delivery.bytes != null"> · {{ formatBytes(run.delivery.bytes) }}</template></p>
                  <p v-if="run.delivery.reconstruction" class="muted">{{ run.delivery.reconstruction.verified ? 'Reconstruction verified against the approved fingerprint.' : (run.delivery.reconstruction.detail || 'Reconstruction did not match.') }}</p>
                  <p v-if="run.delivery.error" class="muted">{{ run.delivery.error }}</p>
                </template>

                <h3 class="block__sub">Closure</h3>
                <p v-if="!run.closure" class="muted">Not evaluated.</p>
                <template v-else>
                  <p v-if="run.closure.acceptedCheckRisk" class="kv"><span>Accepted check failures</span>{{ run.closure.acceptedCheckRisk.by }} · {{ run.closure.acceptedCheckRisk.failures.map((f) => f.key).join(', ') }} · {{ run.closure.acceptedCheckRisk.reason }}</p>
                  <p class="kv"><span>Verification</span>{{ run.closure.verificationLevel }} · authority {{ run.autoClose?.minimumVerification ?? '—' }}<template v-if="run.closure.independentAudit === false"> · no independent reviewer</template></p>
                  <p v-for="(met, name) in run.closure.conditions" :key="name" class="kv kv--indent">
                    <v-icon :icon="met ? '$checkCircle' : '$alertCircle'" size="14" :color="met ? 'success' : undefined" />
                    <code>{{ name }}</code>
                  </p>
                </template>
              </template>
            </div>
          </details>
              </div>
              <div v-else-if="liveTurn" class="live-detail">
                <RunTerminal
                  :key="liveTurn.invocationId"
                  :project="project" :issue-id="issueId" :run-id="run.runId"
                  :invocation-id="liveTurn.invocationId" :role="liveTurn.role" :step-id="liveTurn.stepId" :live="true"
                  :model="run.participants?.[liveTurn.role]?.model ?? null"
                />
              </div>
              <TurnDetail
                v-else
                fill
                :turn="selectedTurnData"
                :project="project"
                :issue-id="issueId"
                :run-id="run.runId"
                :current-revision="run.currentRevision"
              />
            </div>
          </div>
        </template>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
/*
 * Two cards. The issue (title, decisions, folder) and the run (picker, status,
 * then steps beside the selected step). On wide screens the page is a fixed
 * height: the run card takes what the issue card leaves, and the step list
 * and the step detail scroll on their own. Narrow screens stack and scroll.
 */
.issue { padding: 12px 20px 20px; display: flex; flex-direction: column; gap: 12px; }
.card { flex: none; }
.runcard { display: flex; flex-direction: column; min-height: 0; }
@media (min-width: 1100px) {
  .issue { height: calc(100dvh - 60px); overflow: hidden; }
  .runcard { flex: 1; }
  /* The steps get the height; a long status scrolls in its own box. */
  .runcard > .status { flex: none; max-height: min(30vh, 240px); overflow-y: auto; }
  .workspace { flex: 1; min-height: 0; }
  .workspace__timeline, .workspace__detail { min-height: 0; overflow-y: auto; }
  .head__folder { max-height: 40vh; overflow-y: auto; }
  /* Hidden sections give their height to what is shown: the status, when the
     steps and the detail are both hidden; the issue card, when the run card
     has nothing left that uses height. */
  .runcard--status-fills > .status { flex: 1; max-height: none; }
  .issue--head-fills > .head { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .issue--head-fills .head__folder { max-height: none; }
  .issue--head-fills > .runcard { flex: none; }
}
@media (max-width: 1099px) {
  .workspace__timeline { max-height: 50vh; overflow-y: auto; }
}

/* ---- header */
.head { padding: 10px 16px 12px; }
.head__top { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px 20px; }
.head__titles { flex: 1 1 18rem; min-width: 0; }
.head__decide { flex: 0 1 17rem; min-width: min(100%, 14rem); padding-top: 4px; }
.head .issue__actions { flex: none; }
.head__folder-toggle { display: inline-flex; align-items: center; gap: 5px; border: 0; background: none; color: rgb(var(--v-theme-primary)); font: inherit; font-weight: 600; cursor: pointer; padding: 0; }
.head__caret { display: inline-block; transition: transform 0.12s; }
.head__caret--open { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .head__caret { transition: none; } }
.head__packed { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; opacity: 0.8; }
.head__twin { margin-top: 8px; font-size: 0.8125rem; }
.head__twin-title, .head__twin-note { margin: 0 0 4px; overflow-wrap: anywhere; }
.head__twin-note { opacity: 0.7; }
.head__twin-result pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.75rem; }
.packed { overflow: hidden; }
.packed__head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; padding: 14px 18px 8px; }
.packed__title { font-size: 1rem; font-weight: 650; }
.packed__list { padding: 4px 18px 18px; overflow-y: auto; min-height: 0; flex: 1; }
.packed__run { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); padding: 10px 0; }
.packed__run > summary { cursor: pointer; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.packed__headline { font-weight: 650; }
.packed__run[open] > summary { margin-bottom: 8px; }
.head__folder { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
.decision .decide:first-child { padding-top: 0; }
.issue__back { margin-left: -8px; }
.issue__titles { flex: 1 1 20rem; min-width: 0; }
.issue__title { font-size: 1.1875rem; font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; overflow-wrap: anywhere; }
.issue__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 4px; font-size: 0.8125rem; }
.issue__meta > span { opacity: 0.6; }
.issue__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.issue__sections { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 2px 12px; font-size: 0.75rem; }
.issue__sections-label { opacity: 0.6; }
.section-toggle { border: 0; background: none; padding: 2px 0; color: rgb(var(--v-theme-primary)); font: inherit; font-weight: 600; cursor: pointer; }
.section-toggle[aria-pressed="false"] { color: inherit; opacity: 0.55; text-decoration: line-through; }
.section-toggle:disabled { cursor: default; opacity: 0.35; }
.issue__questions { display: flex; flex-direction: column; gap: 6px; }
.issue__fresh { margin-left: auto; }
.issue__alerts { display: flex; flex-direction: column; gap: 6px; }
.issue__alerts:empty { display: none; }
.issue__dialog-title { font-size: 1rem; font-weight: 650; margin-bottom: 6px; }
.issue__dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

/* ---- the status card: tone is a coloured edge, the words carry the meaning */
.status { margin: 0 16px 12px; padding: 10px 14px; border-left: 4px solid rgba(var(--v-theme-on-surface), 0.2); border-radius: 4px; background: rgba(var(--v-theme-on-surface), 0.025); }
.status--neutral { margin-top: 14px; }
.status--progress { border-left-color: rgb(var(--v-theme-primary)); }
.status--waiting { border-left-color: rgb(var(--v-theme-info)); }
.status--success { border-left-color: rgb(var(--v-theme-success)); }
.status--warning { border-left-color: rgb(var(--v-theme-warning)); }
.status--error { border-left-color: rgb(var(--v-theme-error)); }
.status__top { display: flex; align-items: center; gap: 10px; }
.status__headline { font-size: 1.0625rem; font-weight: 650; line-height: 1.35; }
.status__detail { margin-top: 8px; font-size: 0.875rem; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.status__cause {
  margin-top: 8px; padding: 8px 10px; border-radius: 6px; max-height: 9rem; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 5%, transparent);
}
.status__unmet { margin: 6px 0 0; padding-left: 1.1rem; font-size: 0.8125rem; line-height: 1.5; }
.status__unmet li { margin-bottom: 2px; overflow-wrap: anywhere; }
/* Coordinator reasoning can run to a page; the gist is the first lines. */
.status__detail.is-clamped { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.status__unmet li.is-clamped { display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.status__more { margin-top: 6px; padding: 0; border: 0; background: none; color: rgb(var(--v-theme-primary)); font: inherit; font-size: 0.8125rem; cursor: pointer; }
.status__next { margin-top: 6px; font-size: 0.8125rem; line-height: 1.5; opacity: 0.75; }
.status__suggest { margin-top: 8px; font-size: 0.8125rem; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status__suggest-why { opacity: 0.75; }


.status__note { margin-top: 8px; font-size: 0.75rem; opacity: 0.6; }

.answer { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.answer__actor { max-width: 260px; }
.answer__options { display: flex; flex-wrap: wrap; gap: 8px; }
.answer .v-btn { align-self: flex-start; }

/* ---- run bar: which run, how it stands, what can be done */
.runbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 12px 16px 10px; }
.runbar .runs__select { flex: 0 1 26rem; min-width: min(100%, 16rem); }
.runbar__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; font-size: 0.8125rem; min-width: 0; }
.runbar__meta > span { opacity: 0.7; }
.runbar__id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; opacity: 0.5; overflow-wrap: anywhere; }
.runbar__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.runbar__actions:empty { display: none; }

/* ---- blocks in the side column */
.block { padding: 2px 2px 0; }
.block__title { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.55; margin-bottom: 8px; }
.block__sub { font-size: 0.8125rem; font-weight: 600; margin: 12px 0 4px; }
.block__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.line { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; line-height: 1.5; padding: 2px 0; overflow-wrap: anywhere; }
.line--top { align-items: flex-start; }
.line--top .v-icon { margin-top: 2px; }
.findings { margin: 4px 0 0 1.2rem; font-size: 0.8125rem; line-height: 1.5; }
.findings a { margin-left: 6px; }

.decide { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) auto; align-items: baseline; gap: 8px; font-size: 0.8125rem; padding: 4px 0; }
.decide__label { opacity: 0.6; }
.sizing__modules { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.sizing__modules code { font-size: 0.75rem; }
.decide__why { margin-top: 3px; line-height: 1.45; opacity: 0.8; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.form { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 10px; }
.form select, .form input {
  font: inherit; font-size: 0.8125rem; padding: 7px 9px; border-radius: 6px; background: transparent; color: inherit;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 25%, transparent);
}
.form select option { background: rgb(var(--v-theme-surface)); }
.form__buttons { display: flex; justify-content: flex-end; gap: 6px; }

/* ---- technical details */
.tech { border-top: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent); padding-top: 10px; }
.tech > summary, .more > summary { cursor: pointer; font-size: 0.8125rem; font-weight: 550; opacity: 0.75; }
.tech__body { margin-top: 10px; display: flex; flex-direction: column; gap: 2px; }
.kv { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 0.75rem; line-height: 1.5; overflow-wrap: anywhere; }
.kv > span:first-child { min-width: 6.5rem; opacity: 0.55; }
.kv--indent { padding-left: 12px; align-items: center; }
.kv code, .wrap { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; overflow-wrap: anywhere; }
.check { margin-bottom: 4px; }
.budgets { display: grid; gap: 6px; }
.budget { display: grid; grid-template-columns: 4.5rem 1fr auto; align-items: center; gap: 8px; }
.budget__name { font-size: 0.75rem; opacity: 0.6; }
.budget__figure { font-size: 0.75rem; font-variant-numeric: tabular-nums; opacity: 0.6; }
.mono-block {
  margin: 4px 0; padding: 8px 10px; border-radius: 6px; max-height: 14rem; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 5%, transparent);
}

/* ---- steps and the selected step */
.workspace { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
.workspace__timeline { padding: 8px 8px 12px; border-right: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
.workspace__detail { min-width: 0; }
/* One of the two columns hidden: the other takes the width. */
.workspace--one { grid-template-columns: minmax(0, 1fr); }
.workspace--one .workspace__timeline { border-right: 0; }
@media (max-width: 800px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .workspace__timeline { border-right: 0; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1); }
}
.summary-entry {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; width: 100%; padding: 9px 10px; margin-bottom: 4px;
  border: 1px solid transparent; border-radius: 8px; background: none; color: inherit; font: inherit; font-weight: 600; font-size: 0.875rem; text-align: left; cursor: pointer;
}
.summary-entry:hover { border-color: rgba(var(--v-theme-on-surface), 0.15); }
.summary-entry--on { background: rgb(var(--v-theme-surface-variant)); border-color: rgb(var(--v-theme-primary)); }
.summary-entry__hint { flex-basis: 100%; padding-left: 24px; font-weight: 400; font-size: 0.75rem; opacity: 0.55; }
.summary { padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
.live-detail { height: 100%; min-height: 360px; padding: 12px; }
.issue__location { margin: 2px 0 4px; }
.chat-detail { height: 100%; min-height: 420px; padding: 12px; }

.muted { font-size: 0.8125rem; opacity: 0.6; }
.error-text { color: rgb(var(--v-theme-error)); font-size: 0.8125rem; margin-top: 6px; }
.warning-text { color: rgb(var(--v-theme-warning)); font-size: 0.8125rem; margin-top: 8px; }
.warning-text ul { margin: 4px 0 0 18px; }
/* Up to three long dispositions beside Cancel: on a phone they wrap rather than run off the card. */
.integrity__actions { flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.integrity__paths { max-height: 240px; overflow: auto; font-size: 0.75rem; padding: 8px; background: rgb(var(--v-theme-surface-variant)); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.alert-focus { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 4px; border-radius: 6px; }
</style>
