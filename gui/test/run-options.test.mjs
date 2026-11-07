import fs from 'node:fs/promises'
import path from 'node:path'
import { resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'per-run settings — validation, preview binding, snapshots and browser controls'

export default async function (t) {
  const id = 'implementation'
  const { resolved: base } = await resolvePlaybook(id)
  const options = { budgets: { maxSteps: 12, wallClockMinutes: 30, maxTokens: 2000 }, rounds: { 'implement-review': 3 }, repairAttempts: 1,
    participants: { implementer: { model: 'haiku-4-5', effort: null }, coordinator: { effort: 'high' } } }
  const r = await resolvePlaybook(id, { runOptions: options })
  t.ok('valid per-run settings resolve', r.ok, JSON.stringify(r.errors))
  t.eq('limits applied', r.resolved.budgets, options.budgets)
  t.eq('rounds applied', r.resolved.phases.find((p) => p.id === 'implement-review').loop.maxRounds, 3)
  t.eq('repair budget applied', r.resolved.reviewPolicy.protocolRepair.maxAttempts, 1)
  t.eq('model resolved to roster wire id', r.resolved.participants.implementer.model.wire, 'claude-haiku-4-5')
  t.eq('old model effort does not leak', r.resolved.participants.implementer.effort, null)
  t.eq('effort override applied', r.resolved.participants.coordinator.effort, 'high')
  t.ok('settings change the hash', r.resolved.configHash !== base.configHash)
  const reordered = Object.fromEntries(Object.entries(options).reverse())
  t.eq('argument order does not change hash', (await resolvePlaybook(id, { runOptions: reordered })).resolved.configHash, r.resolved.configHash)
  t.eq('saved defaults unchanged', (await resolvePlaybook(id)).resolved.configHash, base.configHash)
  for (const [label, runOptions] of [
    ['negative limit', { budgets: { maxSteps: -1 } }],
    ['fractional limit', { budgets: { maxSteps: 1.5 } }],
    ['string limit', { budgets: { maxSteps: '12' } }],
    ['strategy ceiling', { budgets: { maxSteps: 161 } }],
    ['unknown limit', { budgets: { maxCost: 10 } }],
    ['unknown argument', { delivery: { action: 'merge' } }],
    ['unknown phase', { rounds: { nowhere: 2 } }],
    ['non-loop phase', { rounds: { triage: 2 } }],
    ['zero rounds', { rounds: { 'implement-review': 0 } }],
    ['excess repair', { repairAttempts: 3 }],
    ['unknown role', { participants: { stranger: { model: 'haiku-4-5' } } }],
    ['unknown model', { participants: { implementer: { model: 'invented' } } }],
    ['unsupported effort', { participants: { 'auditor-1': { model: 'haiku-4-5', effort: 'high' } } }],
    ['unknown efforts', { participants: { 'auditor-1': { model: 'deepseek-flash', effort: 'high' } } }],
    ['instructions path', { participants: { implementer: { instructions: '/etc/passwd' } } }],
    ['null arguments', null], ['array arguments', []]
  ]) t.eq(`${label} rejected`, (await resolvePlaybook(id, { runOptions })).ok, false)
  /*
   * A playbook's participants are DEFAULTS, not the set of permitted choices.
   * A supervisor that reads the playbook listing and concludes otherwise refuses
   * work it can do — so the claim is pinned here: any verified roster id may
   * fill any seat, including one from a provider no playbook names.
   */
  const { loadConfig } = await import('../server/config/load.mjs')
  const roster = [...(await loadConfig({})).roster.values()]
  const foreign = roster.find((m) => m.verification?.status === 'verified' &&
    !Object.values(base.participants).some((p2) => p2.model.id === m.id))
  if (!foreign) t.skip('a roster model outside this playbook\'s defaults', 'every verified roster entry is already a default')
  else {
    const reseated = await resolvePlaybook(id, { runOptions: { participants: { implementer: { model: foreign.id } } } })
    t.ok(`a seat takes ${foreign.id}, which no default names`, reseated.ok, JSON.stringify(reseated.errors))
    t.eq('and it is the model the engine will use', reseated.resolved?.participants?.implementer?.model?.id, foreign.id)
    t.eq('under its own harness and profile', [reseated.resolved?.participants?.implementer?.model?.harness, reseated.resolved?.participants?.implementer?.model?.profile], [foreign.harness, foreign.profile ?? 'default'])
  }

  const p = await previewRun({ playbookId: id, runOptions: options })
  t.eq('preview resolves the identical hash', p.configHash, r.resolved.configHash)
  t.eq('preview exposes effective limits', p.limits.budgets, options.budgets)

  const stage = await startStage({ control: { delayMs: 100 } })
  const issue = await stage.createIssue('Adjust this run')
  const previewUrl = `/api/playbooks/${id}/preview`
  const runsUrl = `/api/projects/${stage.project}/issues/${issue.id}/runs`
  const preview = async (runOptions) => stage.request(`${previewUrl}?options=${encodeURIComponent(JSON.stringify(runOptions))}`)
  const post = (body) => stage.request(runsUrl, { method: 'POST', body: JSON.stringify(body) })
  t.section('API binds arguments before any spending or run creation')
  const shown = await preview(options)
  t.eq('preview succeeds', shown.status, 200)
  t.eq('invalid arguments rejected by API', (await preview({ budgets: { maxSteps: 0 } })).status, 422)
  t.eq('malformed JSON rejected', (await stage.request(`${previewUrl}?options=broken`)).status, 400)
  t.eq('options need a reviewed hash', (await post({ playbook: id, runOptions: options })).status, 400)
  t.eq('tampered options rejected', (await post({ playbook: id, configHash: shown.body.configHash, runOptions: { budgets: { maxSteps: 2 } } })).status, 409)
  t.eq('invalid start options rejected', (await post({ playbook: id, runOptions: { command: 'sh' } })).status, 422)
  t.eq('refusals left no runs', (await stage.runs(issue.id)).length, 0)
  t.eq('no runtime invoked', await fs.readFile(stage.ledger, 'utf8').catch(() => ''), '')

  t.section('browser edits are per-run, resettable, and must be previewed')
  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    await browser.clickWhen(() => browser.find('button', 'Run a playbook'))
    await browser.clickWhen(() => browser.all('.pick').find((el) => el.textContent.includes(id)))
    await browser.until(() => browser.has('Settings for this run'))
    await browser.until(() => browser.all('[data-setting="maxSteps"]')[0]?.value === '120')
    const change = async (selector, value, event = 'input') => {
      const el = browser.all(selector)[0]
      el.value = value
      el.dispatchEvent(new browser.window.Event(event, { bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
    }
    await change('[data-setting="maxSteps"]', '1')
    t.ok('editing immediately disables Start', browser.find('button', 'Start run').disabled)
    await change('[data-setting="wallClockMinutes"]', '25')
    await change('[data-setting="implement-review"]', '3')
    await change('[data-setting="repairAttempts"]', '1')
    await change('select[aria-label="implementer model"]', 'haiku-4-5', 'change')
    t.ok('effort disabled for a model without the setting', browser.all('select[aria-label="implementer effort"]')[0].disabled)
    await browser.click(browser.find('button', 'Preview settings'))
    await browser.until(() => !browser.find('button', 'Start run').disabled)
    t.ok('preview shows adjusted turn limit', browser.has('maxSteps=1'))
    browser.stall(/options=/, 400)
    await change('[data-setting="maxSteps"]', '2')
    await browser.click(browser.find('button', 'Preview settings'))
    await change('[data-setting="maxSteps"]', '3')
    t.ok('a response for earlier arguments cannot enable Start', browser.find('button', 'Start run').disabled)
    // The edit is previewed on its own after a pause; the stale answer for 2 is
    // discarded and only the answer for 3 may paint and enable Start.
    await browser.until(() => browser.has('maxSteps=3'))
    t.ok('earlier argument results are not painted', !browser.has('maxSteps=2'))
    t.ok('the edit was previewed without the button', !browser.find('button', 'Start run').disabled)
    browser.clearStalls()
    await change('[data-setting="maxSteps"]', '999')
    await browser.click(browser.find('button', 'Preview settings'))
    await browser.until(() => browser.has('widens maxSteps'))
    t.ok('invalid preview cannot start', browser.find('button', 'Start run').disabled)
    t.eq('invalid form remains editable', browser.all('[data-setting="maxSteps"]')[0].value, '999')
    await browser.click(browser.find('button', 'Reset to defaults'))
    await browser.until(() => browser.all('[data-setting="maxSteps"]')[0]?.value === '120')
    t.eq('reset restores the model', browser.all('select[aria-label="implementer model"]')[0].value, 'opus-5-5')
    await change('[data-setting="maxSteps"]', '1')
    await change('[data-setting="wallClockMinutes"]', '25')
    await change('[data-setting="implement-review"]', '3')
    await change('[data-setting="repairAttempts"]', '1')
    await change('select[aria-label="implementer model"]', 'haiku-4-5', 'change')
    await browser.click(browser.find('button', 'Preview settings'))
    await browser.until(() => !browser.find('button', 'Start run').disabled)
    await browser.click(browser.find('button', 'Start run'))
    const deadline = Date.now() + 20000
    while ((await stage.runs(issue.id))[0]?.status !== 'blocked') {
      if (Date.now() > deadline) throw new Error('adjusted run never settled')
      await new Promise((r) => setTimeout(r, 80))
    }
    const [run] = await stage.runs(issue.id)
    const detail = await stage.run(issue.id, run.runId)
    t.eq('engine enforces the adjusted limit', detail.timeline.length, 1)
    t.eq('stops for the budget', detail.blockedReason, 'budget-exhausted')
    const snapshot = JSON.parse(await fs.readFile(path.join(stage.issuesDir, stage.project, issue.id, 'runs', run.runId, 'resolved-playbook.json'), 'utf8'))
    t.eq('chosen arguments persisted in the snapshot', snapshot.runOptions.budgets.maxSteps, 1)
    t.eq('effective snapshot matches', snapshot.budgets.maxSteps, 1)
    t.eq('run read exposes its chosen arguments', detail.runOptions.budgets.maxSteps, 1)
    t.eq('time limit reaches the engine snapshot', snapshot.budgets.wallClockMinutes, 25)
    t.eq('model selection reaches the snapshot', snapshot.participants.implementer.model.wire, 'claude-haiku-4-5')
    t.eq('round limit reaches the snapshot', snapshot.phases.find((p) => p.id === 'implement-review').loop.maxRounds, 3)
    t.eq('repair limit reaches the snapshot', snapshot.reviewPolicy.protocolRepair.maxAttempts, 1)
    t.eq('saved playbook remains unchanged', (await preview({})).body.limits.budgets.maxSteps, 120)
    await browser.clickWhen(() => browser.find('button', 'Run a playbook'))
    await browser.clickWhen(() => browser.all('.pick').find((el) => el.textContent.includes(id)))
    await browser.until(() => browser.has('Settings for this run'))
    await browser.until(() => browser.all('[data-setting="maxSteps"]')[0]?.value === '120')
    t.eq('next start uses defaults', browser.all('[data-setting="maxSteps"]')[0].value, '120')
    t.eq('no browser errors', browser.problems, [])
  } finally { browser.close() }
}
