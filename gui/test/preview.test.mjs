import fs from 'node:fs/promises'
import path from 'node:path'

import { previewRun } from '../server/runtime/preview.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { CONFIG_ROOT, sandbox, patch, occupySeat } from './helpers.mjs'

export const name = 'preview — a complete dry run with no side effects'

const SYMBOLIC = /^«.+»$/

/** Every file under a tree, with size and mtime, for before/after comparison. */
async function snapshot (root, prefix = '') {
  const out = {}
  let entries = []
  try { entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, await snapshot(root, rel))
    else {
      const st = await fs.stat(path.join(root, rel))
      out[rel] = `${st.size}:${st.mtimeMs}`
    }
  }
  return out
}

export default async function (t) {
  const f = await engineFixture()
  const issue = { name: 'Engine fixture', openedOn: '2026-09-10', path: f.issuePath, project: 'devpanel-project' }
  const project = { id: 'devpanel-project', path: f.projectPath }
  // The live templates append their context rather than interpolate it; the
  // renderer is exercised by giving the sandbox copies the placeholders an
  // operator may write: values known now, and values only a run can supply.
  const prompts = path.join(f.configRoot, 'strategy-templates/implementation/prompts')
  const prepend = async (file, lines) => fs.writeFile(path.join(prompts, file), lines.join('\n') + '\n\n' + await fs.readFile(path.join(prompts, file), 'utf8'))
  await prepend('orient.md', ['You are the coordinator for **{{issue.name}}** in {{project.id}}.', 'Issue folder: `{{issue.path}}` (workers read it).', 'Playbook: {{playbook.id}} — {{playbook.description}}'])
  await prepend('implement.md', ['Issue **{{issue.name}}** in `{{project.id}}`.', 'Current candidate revision: {{revision.current}}', 'Outstanding findings:', '{{findings.outstanding}}'])

  // ------------------------------------------------------------ no effects
  t.section('the preview creates and touches nothing')
  const issueBefore = await snapshot(f.issuePath)
  const projectBefore = await snapshot(f.projectPath)
  const ledgerBefore = await f.fake.ledger.invocationCount()

  const p = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, issue, project })
  t.ok('it resolved', p.ok, p.errors?.[0]?.message)

  t.eq('the issue tree is byte-identical', await snapshot(f.issuePath), issueBefore)
  t.eq('the project tree is byte-identical', await snapshot(f.projectPath), projectBefore)
  t.eq('no harness invocation', await f.fake.ledger.invocationCount(), ledgerBefore)
  const issueEntries = await fs.readdir(f.issuePath)
  t.ok('no run directory', !issueEntries.includes('runs'), issueEntries.join(','))
  t.ok('no run lock', !issueEntries.includes('.run.lock'))
  t.ok('no step-allocation lock', !issueEntries.includes('.step-alloc.lock'))
  t.ok('no step reservations', !issueEntries.includes('.step-reservations.json'))
  t.ok('no step folders', !issueEntries.some((e) => /^\d{3}-/.test(e)))
  const worktrees = await fs.readdir(path.join(f.issuePath, 'runs')).catch(() => [])
  t.eq('no workspace was created', worktrees.length, 0)

  t.section('and it never probes — previewRun takes no probe at all')
  t.eq('participants report authentication as unproven',
    p.participants.every((q) => SYMBOLIC.test(q.liveAuthentication)), true)
  t.ok('and a prerequisite says so', p.prerequisites.some((x) => x.kind === 'not-probed'))

  // ------------------------------------------------------------ participants
  t.section('resolved participants, connections, efforts, verification')
  const byRole = Object.fromEntries(p.participants.map((q) => [q.role, q]))
  t.eq('three occupied seats, the empty optional ones omitted', p.participants.map((q) => q.role).sort(), ['auditor-1', 'coordinator', 'implementer'])
  t.eq('coordinator model', byRole.coordinator.model, 'opus-5-5')
  t.eq('with its wire identifier', byRole.coordinator.wireModel, 'claude-opus-5-5')
  t.eq('and effort (the playbook sets low for its tool-free coordinator)', byRole.coordinator.effort, 'low')
  t.eq('the implementer is the sole writer', p.participants.filter((q) => q.writesCode).map((q) => q.role), ['implementer'])
  t.eq('a seat with no effort named and no model default shows null', byRole['auditor-1'].effort, null)
  t.ok('every participant carries a connection label', p.participants.every((q) => typeof q.connection.label === 'string'))
  t.ok('and a verification status', p.participants.every((q) => ['verified', 'unverified'].includes(q.verification)))

  t.section('a profile connection is distinguished from the default')
  {
    const root = await sandbox(async (d) => {
      await occupySeat(path.join(d, 'playbooks/implementation.yaml'), '  auditor-1:\n    model: glm-via-claude')
    })
    const g = await previewRun({ playbookId: 'implementation', configRoot: root, issue, project })
    const auditor = g.participants.find((q) => q.role === 'auditor-1')
    t.eq('the label names the profile', auditor.connection.label, 'claude[glm]')
    t.eq('and the endpoint reference is shown, not the secret', auditor.connection.endpointRef, 'file:providers/glm.endpoint')
    t.eq('credential reference likewise', auditor.connection.credentialRef, 'file:~/.config/zai/key')
  }

  // ------------------------------------------------------------ plan
  t.section('phase order, branches, loops and effective limits')
  t.eq('three phases in order', p.phases.map((x) => x.id).join(' '), 'triage implement-review confirm')
  t.eq('numbered from one', p.phases[0].order, 1)
  const triage = p.phases.find((x) => x.id === 'triage')
  t.eq('triage carries its branch', triage.branches[0].when, 'output.fit == false')
  t.eq('to abort', triage.branches[0].to, 'abort')
  t.eq('leaving the issue unresolved', triage.branches[0].outcome, 'unresolved')

  const loops = p.phases.filter((x) => x.kind === 'loop')
  t.eq('one review loop', loops.length, 1)
  t.eq('with its exit condition', loops[0].loop.until, 'review.verdict == approved && !review.substantial')
  t.eq('the round cap', loops[0].loop.maxRounds, 5)
  t.eq('and what exhaustion does', loops[0].loop.onExhausted, 'extend-if-converging')
  t.eq('its steps in order', loops[0].steps.map((s) => s.id).join(' '), 'brief-implement implement audit-implement-1 audit-implement-2 audit-implement-3 audit-implement-4')
  t.eq('only the implement step is fingerprinted', loops[0].steps.filter((s) => s.recordsRevision).map((s) => s.id), ['implement'])

  t.section('effective limits')
  t.eq('narrowed budgets', p.limits.budgets.maxSteps, 120)
  t.eq('wall clock', p.limits.budgets.wallClockMinutes, 240)
  t.eq('per-phase rounds', p.limits.rounds.map((r) => `${r.phase}=${r.maxRounds}`).join(' '), 'implement-review=5')
  t.eq('protocol repair budget', p.reviewPolicy.protocolRepair.maxAttempts, 2)

  // ------------------------------------------------------------ symbolic
  t.section('the coordinator\'s brief reaches the implementer as a symbolic runtime slot')
  const implementStep = loops[0].steps.find((s) => s.id === 'implement')
  t.eq('the implement prompt is the strategy template', implementStep.promptSource.kind, 'template')
  const brief = implementStep.context.find((x) => x.ref === 'steps.brief-implement.output.prompt')
  t.eq('the brief is runtime', brief?.availability, 'runtime')
  t.ok('and the slot is symbolic', SYMBOLIC.test(brief?.slot ?? ''), brief?.slot)
  t.ok('naming where it comes from', (brief?.slot ?? '').includes('brief-implement') && brief.slot.includes('coordinator'))

  t.section('future outputs are symbolic slots')
  t.ok('every step with an output contract has a slot',
    p.phases.flatMap((x) => x.steps).filter((s) => s.output).every((s) => SYMBOLIC.test(s.outputSlot)))
  t.ok('and the slot names the contract',
    p.phases.find((x) => x.id === 'triage').steps[0].outputSlot.includes('triageResult'))

  t.section('runtime context is symbolic and says where it will come from')
  const review = loops[0].steps.find((s) => s.id === 'audit-implement-1')
  const refs = Object.fromEntries(review.context.map((x) => [x.ref, x]))
  t.eq('the current plan is runtime', refs['plan.current'].availability, 'runtime')
  t.ok('and says what it is', refs['plan.current'].slot.includes('latest plan the author produced'))
  t.ok('acceptance criteria explain their origin', refs.acceptanceCriteria.slot.includes('triage'))
  t.ok('outstanding findings too', refs['findings.outstanding'].slot.includes('latest review'))
  t.eq('the candidate diff is runtime', refs['revision.diff'].availability, 'runtime')

  // ------------------------------------------------------------ prompts
  t.section('strategy-owned prompts render with the issue context available now')
  const rendered = p.prompts['orient.md'].rendered
  t.ok('the issue name is filled in', rendered.includes('Engine fixture'), rendered.match(/coordinator for .*/)?.[0])
  t.ok('the project and the issue folder too', rendered.includes('devpanel-project') && rendered.includes(f.issuePath))
  t.ok('and the issue folder', rendered.includes(f.issuePath))
  t.ok('the playbook description is resolved, not symbolic', rendered.includes('Coordinated implementation with configurable occupied seats'))
  t.eq('so orient.md has no symbolic slots left', p.prompts['orient.md'].symbolicSlots.length, 0)

  t.section('but runtime-only values in later prompts stay visibly symbolic')
  // implement.md names the revision the implementer works from, which exists
  // only once a candidate does.
  const implement = p.prompts['implement.md']
  t.ok('implement.md has slots', implement.symbolicSlots.length > 0, implement.symbolicSlots.map((s) => s.ref).join(', '))
  t.ok('and they appear in the text', /«revision\.current[^»]*»/.test(implement.rendered))
  t.ok('never as an empty substitution', !/revision: \s*$/m.test(implement.rendered),
    implement.rendered.match(/revision: .*/)?.[0])
  t.ok('every slot carries a note', implement.symbolicSlots.every((s) => typeof s.note === 'string' && s.note.length > 0))

  // ------------------------------------------------------------ policy
  t.section('checks, delivery and closure policy')
  t.eq('check requirement', p.checks.requirement, 'optional')
  t.eq('no target configured', p.checks.target, null)
  t.eq('delivery action', p.delivery.action, 'worktree-diff')
  t.eq('revalidated before delivery', p.delivery.revalidateBeforeDelivery, true)
  t.eq('autoClose minimum', p.autoClose.minimumVerification, 'review-only')
  t.eq('and where it came from', p.autoClose.source, 'playbook')
  t.eq('closure conditions listed', p.completion.requires.length, 5)

  t.section('configuration hash and prerequisites')
  t.ok('config hash', /^sha256:[0-9a-f]{64}$/.test(p.configHash))
  t.eq('this playbook is live-eligible', p.liveEligible, true)
  t.ok('delivery provider is called out as needed at run time',
    p.prerequisites.some((x) => x.kind === 'delivery-provider'))

  t.section('an unverified participant appears as an unresolved prerequisite')
  {
    const unverifiedRoot = await sandbox(async (d) => {
      await patch(path.join(d, 'roster/gpt-6-astra.yaml'), 'status: verified', 'status: unverified')
      await occupySeat(path.join(d, 'playbooks/implementation.yaml'), '  auditor-1:\n    model: gpt-6-astra')
      await patch(path.join(d, 'playbooks/implementation.yaml'), 'minimumVerification: review-only', 'minimumVerification: verified')
    })
    const u = await previewRun({ playbookId: 'implementation', configRoot: unverifiedRoot, issue, project })
    t.eq('still previewable', u.ok, true)
    t.eq('but not live-eligible', u.liveEligible, false)
    t.ok('the unverified model is named', u.prerequisites.some((x) => x.kind === 'unverified-model'))
    t.ok('and closure being unreachable is called out',
      u.prerequisites.some((x) => x.kind === 'closure-unreachable'), 'autoClose=verified with no target')
    t.eq('unverified model blocks start', u.prerequisites.find((x) => x.kind === 'unverified-model').category, 'blocking')
    t.eq('closure limitation is an outcome, not a start blocker', u.prerequisites.find((x) => x.kind === 'closure-unreachable').category, 'outcome')
    t.eq('unverified configuration cannot start', u.configurationReady, false)
  }

  t.section('launcher capabilities and completion warnings stay distinct')
  {
    const panel = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, deliveryActions: ['worktree-diff', 'commit'] })
    t.eq('agreement policy permits start', panel.configurationReady, true)
    t.ok('agreement policy has no closure warning', !panel.prerequisites.some((x) => x.kind === 'closure-unreachable'))
    t.eq('configured delivery is informational', panel.prerequisites.find((x) => x.kind === 'delivery-provider').category, 'information')
    t.eq('configured delivery is available', panel.prerequisites.find((x) => x.kind === 'delivery-provider').status, 'available')
    t.eq('preflight notice is informational', panel.prerequisites.find((x) => x.kind === 'not-probed').category, 'information')
    t.eq('standalone preview leaves provider unknown', p.prerequisites.find((x) => x.kind === 'delivery-provider').status, 'unknown')
    const missing = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, deliveryActions: [] })
    t.eq('known missing provider blocks start', missing.configurationReady, false)
    const requiredRoot = await sandbox((d) => patch(path.join(d, 'playbooks/implementation.yaml'), 'autoClose:\n', 'checks:\n  requirement: required\nautoClose:\n'))
    const required = await previewRun({ playbookId: 'implementation', configRoot: requiredRoot, deliveryActions: ['apply-to-source', 'worktree-diff', 'commit'] })
    t.eq('required checks without a target block start', required.prerequisites.find((x) => x.kind === 'checks-unsatisfiable').category, 'blocking')
    t.eq('required-check blocker disables configuration', required.configurationReady, false)
  }

  t.section('a playbook that does not resolve reports file and field')
  {
    const broken = await sandbox((d) => patch(path.join(d, 'playbooks/implementation.yaml'), '  implementer:\n    model: opus-5-5', '  implementer:\n    model: nope'))
    const b = await previewRun({ playbookId: 'implementation', configRoot: broken, issue, project })
    t.eq('not ok', b.ok, false)
    t.ok('with a field', b.errors.some((e) => e.field === '/participants/implementer/model'), b.errors[0]?.field)
  }

  await cleanupFixtures()
}
