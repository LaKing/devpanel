import { assessable, availabilityProblem, offers, otherLive, previewWrites, selectionAfterDelete, startAdmitted } from '../src/action-offers.js'

export const name = 'action offers — a guarded write is allowed only where the server would accept it'

/*
 * src/action-offers.js mirrors the server's refusal rule of each guarded route; what the page
 * cannot confirm counts as refused. Each case is one the server refuses after the request.
 */

const issue = { archived: false, packed: false, admissionFrozen: null }
const run = (over = {}) => ({ runId: 'r1', status: 'completed', supportedActions: [], reconcilePending: false, recoveryPending: false, cleanupUnrecorded: false, admission: { writesCheckout: true, cycleId: null }, ...over })

export default async (t) => {
  t.section('Delete (supervisor.mjs:1731-1742)')
  {
    const ok = run({ status: 'blocked' })
    t.ok('a settled run with its reconcile decided may be deleted', offers.delete({ issue, runs: [ok], run: ok }))
    t.eq('an undecided automatic reconcile refuses', offers.delete({ issue, runs: [run({ reconcilePending: true })], run: run({ reconcilePending: true }) }), false)
    t.eq('an unknown reconcile state refuses', offers.delete({ issue, runs: [], run: run({ reconcilePending: undefined }) }), false)
    t.eq('an archived issue refuses', offers.delete({ issue: { archived: true }, runs: [ok], run: ok }), false)
    t.eq('another run active on the issue refuses', offers.delete({ issue, runs: [ok, run({ runId: 'r2', status: 'running' })], run: ok }), false)
    t.eq('a paused run refuses', offers.delete({ issue, runs: [], run: run({ status: 'paused' }) }), false)
  }

  t.section('Abandon (supervisor.mjs:1677-1688)')
  {
    const r = run({ status: 'failed', supportedActions: ['abandon'] })
    t.ok('offered and nothing live', offers.abandon({ issue, runs: [r], run: r }))
    t.eq('another live run refuses', offers.abandon({ issue, runs: [r, run({ runId: 'r2', status: 'preflighting' })], run: r }), false)
  }

  t.section('Apply patch and Merge (index.js:382, :413; apply-artifact.mjs:100-103; integrate.mjs:88-97)')
  {
    const delivered = run({
      supportedActions: ['integrate'],
      delivery: { action: 'commit', completedAt: 'x', reconstruction: { verified: true }, revision: 'sha256:a' },
      closure: { revision: 'sha256:a', authorised: true, conditions: { checks: true } }
    })
    t.ok('a completed, approved delivery may be applied', offers.applyArtifact({ issue, runs: [delivered], run: delivered }))
    t.eq('…not while another run of the issue is active', offers.applyArtifact({ issue, runs: [delivered, run({ runId: 'r2', status: 'running' })], run: delivered }), false)
    t.eq('…nor when the closure is not authorised', offers.applyArtifact({ issue, runs: [], run: { ...delivered, closure: { ...delivered.closure, authorised: false } } }), false)
    t.ok('the delivered revision may be merged', offers.integrate({ issue, runs: [delivered], run: delivered }))
    t.eq('…not while another run is active', offers.integrate({ issue, runs: [delivered, run({ runId: 'r2', status: 'pending' })], run: delivered }), false)
    t.eq('…nor when the approved revision is not the delivered one', offers.integrate({ issue, runs: [], run: { ...delivered, closure: { revision: 'sha256:b' } } }), false)
    const target = { declared: true, sameRepository: true, branch: 'main', head: 'abc' }
    t.ok('a declared target positively in the candidate\'s repository', offers.mergeTarget(target))
    t.eq('an unconfirmed repository (null) refuses', offers.mergeTarget({ ...target, sameRepository: null }), false)
    t.eq('another repository refuses', offers.mergeTarget({ ...target, sameRepository: false }), false)
    t.eq('an undeclared source refuses', offers.mergeTarget({ ...target, declared: false }), false)
  }

  t.section('Close (issues.js:1280-1284; supervisor.mjs:1538-1540)')
  {
    t.ok('every run settled and nothing owed: archive', offers.archive({ runs: [run(), run({ runId: 'r2', status: 'cancelled' })] }))
    t.eq('a paused run refuses the archive', offers.archive({ runs: [run({ status: 'paused' })] }), false)
    t.eq('a live run refuses it', offers.archive({ runs: [run({ status: 'stopping' })] }), false)
    t.eq('an undecided reconcile refuses it', offers.archive({ runs: [run({ reconcilePending: true })] }), false)
    t.eq('a recovery owed refuses it', offers.archive({ runs: [run({ recoveryPending: true })] }), false)
    t.eq('unknown facts (an older server) refuse it', offers.archive({ runs: [{ runId: 'r1', status: 'completed' }] }), false)
    t.ok('Close stops a run that is still live', offers.closeStop({ run: run({ status: 'running' }) }))
    t.eq('…not one that paused meanwhile', offers.closeStop({ run: run({ status: 'paused' }) }), false)
  }

  t.section('Continuations, finalize, pause and stop (supervisor.mjs:755-772, :1585-1597, :1452-1454, :1538-1540)')
  {
    const paused = run({ status: 'paused', supportedActions: ['resume', 'abandon'] })
    t.ok('resume offered on a paused run with nothing live', offers.continuation('resume')({ issue, runs: [paused], run: paused }))
    t.eq('a packed issue refuses', offers.continuation('resume')({ issue: { packed: true }, runs: [paused], run: paused }), false)
    t.eq('another live run refuses', offers.continuation('resume')({ issue, runs: [paused, run({ runId: 'r2', status: 'running' })], run: paused }), false)
    t.eq('an action the run does not offer refuses', offers.continuation('continue')({ issue, runs: [paused], run: paused }), false)
    const blocked = run({ status: 'blocked', supportedActions: ['finalize'] })
    t.ok('finalize offered with nothing live', offers.finalize('finalize')({ issue, runs: [blocked], run: blocked }))
    t.eq('…not beside a live run', offers.finalize('finalize')({ issue, runs: [blocked, run({ runId: 'r2', status: 'running' })], run: blocked }), false)
    t.ok('pause on the live run', offers.pause({ issue, run: run({ status: 'running', supportedActions: ['pause', 'stop'] }) }))
    t.eq('stop on a run that is no longer live refuses', offers.stop({ issue, run: run({ status: 'paused', supportedActions: ['stop'] }) }), false)
  }

  t.section('Cleanup, owner input, follow-ups, Add to issue')
  {
    t.eq('cleanup acknowledgement on a live run refuses (supervisor.mjs:1283)', offers.acknowledgeCleanup({ issue, run: run({ status: 'running', supportedActions: ['acknowledge-cleanup'] }) }), false)
    t.ok('…on a settled run offering it', offers.acknowledgeCleanup({ issue, run: run({ status: 'blocked', supportedActions: ['acknowledge-cleanup'] }) }))
    const asked = run({ ownerInput: { questions: [{ id: 'Q1' }] } })
    t.ok('owner input for unanswered questions (owner-input.mjs:47-48)', offers.ownerInput({ issue, run: asked }))
    t.eq('…not once answered', offers.ownerInput({ issue, run: { ...asked, ownerInput: { ...asked.ownerInput, answer: { by: 'x' } } } }), false)
    t.eq('follow-ups need a closure (issues.js:1159)', offers.followUps({ issue, run: run() }, 1), false)
    t.eq('Add to issue refuses an archived issue (issues.js:1557)', offers.addToIssue({ issue: { archived: true } }), false)
  }

  t.section('Assess (index.js:618-634): the provider confirmed available, a model at an effort it supports')
  {
    const view = { assessors: { provider: { id: 'jev', model: 'm' }, models: [{ id: 'opus', verified: true, efforts: ['low', 'high'] }] }, current: { configured: true, key: 'k', holds: null } }
    t.ok('a configured provider not held', assessable(view, 'provider'))
    t.eq('a failed availability read refuses', assessable({ ...view, current: { error: 'boom' } }, 'provider'), false)
    t.eq('no availability read at all refuses', assessable({ ...view, current: undefined }, 'provider'), false)
    t.eq('a held provider refuses', assessable({ ...view, current: { configured: true, holds: false, reason: 'provider-held' } }, 'provider'), false)
    t.ok('a verified model at a supported effort', assessable(view, 'opus', 'high'))
    t.eq('…not at an effort it lacks', assessable(view, 'opus', 'max'), false)
    const failed = { ...view, assessors: { ...view.assessors, models: [{ id: 'opus', verified: true, efforts: ['high'], heldUntil: null, availabilityError: 'store unreadable' }] } }
    t.eq('a failed availability lookup is not "no hold"', assessable(failed, 'opus', 'high'), false)
    // AC2: the panel reports such a read as failed, with the reason, never as ok.
    t.eq('a clean view has no availability problem', availabilityProblem(view), null)
    t.ok('a failed model lookup is a problem naming the model', /unknown — could not read the availability of opus: store unreadable/.test(availabilityProblem(failed) ?? ''))
    t.ok('a failed provider read is a problem', /unknown — could not read the decision provider's availability: boom/.test(availabilityProblem({ ...view, current: { error: 'boom' } }) ?? ''))
  }

  t.section('Unrecorded cleanup (supervisor.mjs:1742, issues.js:1287): Delete and the final Close write refuse')
  {
    const open = run({ status: 'blocked', cleanupUnrecorded: true })
    t.eq('Delete refuses a run whose open cleanup the barrier does not hold', offers.delete({ issue, runs: [open], run: open }), false)
    t.eq('…and an unknown barrier state', offers.delete({ issue, runs: [], run: run({ status: 'blocked', cleanupUnrecorded: undefined }) }), false)
    t.eq('the archive refuses it too', offers.archive({ runs: [run(), open] }), false)
  }

  t.section('An archived (not packed) issue withdraws every run action (AC5)')
  {
    const archived = { archived: true, packed: false, admissionFrozen: null }
    const r = run({ status: 'blocked', supportedActions: ['resume', 'finalize', 'abandon', 'acknowledge-cleanup', 'integrate'] })
    t.eq('Resume refuses', offers.continuation('resume')({ issue: archived, runs: [r], run: r }), false)
    t.eq('Finalize refuses', offers.finalize('finalize')({ issue: archived, runs: [r], run: r }), false)
    t.eq('Abandon refuses', offers.abandon({ issue: archived, runs: [r], run: r }), false)
    t.eq('Acknowledge cleanup refuses', offers.acknowledgeCleanup({ issue: archived, run: r }), false)
    t.eq('Owner input refuses', offers.ownerInput({ issue: archived, run: run({ ownerInput: { questions: [] } }) }), false)
  }

  t.section('A full verification freeze (supervisor.mjs:368, :770, :1589)')
  {
    const frozen = { ...issue, admissionFrozen: { cycleId: 'c1', at: 'x' } }
    const blocked = run({ status: 'blocked', supportedActions: ['finalize', 'reconcile-delivery', 'resume'] })
    t.eq('Finalize refuses while frozen', offers.finalize('finalize')({ issue: frozen, runs: [blocked], run: blocked }), false)
    t.eq('Reconcile delivery refuses while frozen', offers.finalize('reconcile-delivery')({ issue: frozen, runs: [blocked], run: blocked }), false)
    t.eq('an unknown freeze state refuses Finalize', offers.finalize('finalize')({ issue: { archived: false, packed: false }, runs: [blocked], run: blocked }), false)
    t.eq('a writing run does not resume while frozen', offers.continuation('resume')({ issue: frozen, runs: [blocked], run: blocked }), false)
    const reading = run({ status: 'blocked', supportedActions: ['resume'], admission: { writesCheckout: false, cycleId: null } })
    t.ok('a run that only reads resumes', offers.continuation('resume')({ issue: frozen, runs: [reading], run: reading }))
    const own = run({ status: 'blocked', supportedActions: ['resume'], admission: { writesCheckout: true, cycleId: 'c1' } })
    t.ok('the frozen cycle\'s own run resumes', offers.continuation('resume')({ issue: frozen, runs: [own], run: own }))
    t.eq('a run with no admission reading refuses while frozen', offers.continuation('resume')({ issue: frozen, runs: [], run: { ...blocked, admission: undefined } }), false)
    t.eq('owner input restarting a writing playbook refuses', offers.ownerInput({ issue: frozen, run: run({ ownerInput: { questions: [] } }) }), false)
    const writes = { tactic: 'implementation', workspace: { isolation: 'worktree' }, delivery: { action: 'apply-to-source' } }
    const reads = { tactic: 'analysis', workspace: { isolation: 'worktree' }, delivery: { action: 'none' } }
    t.ok('a delivering playbook writes', previewWrites(writes))
    t.eq('an analysis does not', previewWrites(reads), false)
    t.eq('a writing start refuses while frozen', startAdmitted(frozen, writes), false)
    t.ok('a reading start is admitted', startAdmitted(frozen, reads))
    t.ok('nothing frozen: a writing start is admitted', startAdmitted(issue, writes))
  }

  t.section('A late Delete response keeps a newer selection (AC4)')
  {
    t.eq('the deleted run still selected: the page moves off it', selectionAfterDelete('A', 'A'), null)
    t.eq('another run chosen meanwhile stays chosen', selectionAfterDelete('B', 'A'), 'B')
    t.eq('otherLive ignores the run itself', otherLive([run({ runId: 'r1', status: 'running' })], 'r1'), false)
  }
}
