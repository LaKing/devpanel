import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'Playbooks page — seats are listed, edited in the page and saved as the installation\'s own copy'

export default async function (t) {
  // Its own host-config directory: the page writes there, and the runner's shared empty one must stay empty.
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-playbooks-host-'))
  const stage = await startStage({ env: { DEVPANEL_HOST_CONFIG_DIR: hostDir } })
  const copy = path.join(hostDir, 'playbooks', 'implementation.yaml')
  const seatsOf = async (id) => (await stage.request('/api/playbook-seats')).body.playbooks.find((p) => p.id === id)
  const browser = await openBrowser(`${stage.origin}/playbooks`, { token: stage.token })
  try {
    t.section('the page')
    await browser.until(() => browser.has('Plan and implement') && browser.has('Save seats'), { label: 'the playbooks to be listed' })
    t.ok('the drawer has the entry under Model availability', browser.all('a').some((a) => a.getAttribute('href') === '/playbooks' && a.textContent.includes('Playbooks')))
    const card = () => browser.all('.playbooks__card').find((el) => el.querySelector('.playbooks__name')?.textContent.includes('implementation'))
    t.ok('a playbook card lists its seats with their roles', ['coordinator', 'implementer', 'auditor-1', 'auditor-2'].every((role) => card().textContent.includes(role)), card()?.textContent.slice(0, 300))
    t.ok('the writer and the optional seats are marked', card().textContent.includes('writes code') && card().textContent.includes('optional'))
    t.ok('it is the tracked default, with nothing to save yet', card().textContent.includes('tracked default') && [...card().querySelectorAll('button')].find((b) => b.textContent.includes('Save seats')).disabled)
    t.ok('a bound seat shows its model and effort', card().textContent.includes('Opus 5.5') && card().textContent.includes('low'), card().textContent.slice(0, 600))

    t.section('editing a seat in the page')
    const effortField = () => [...card().querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === 'Effort of coordinator in Implementation')?.closest('.v-field')
    await browser.clickWhen(effortField, { label: 'the coordinator\'s effort select' })
    browser.click(effortField())
    effortField().dispatchEvent(new browser.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await browser.clickWhen(() => browser.all('.v-overlay .v-list-item').find((el) => el.textContent.trim() === 'xhigh'), { label: 'the xhigh item of the open menu' })
    await browser.until(() => card().querySelector('.playbooks__row--changed') != null, { label: 'the changed row to be marked' })
    const save = () => [...card().querySelectorAll('button')].find((b) => b.textContent.includes('Save seats'))
    t.ok('the changed seat is marked and Save is offered', !save().disabled)
    browser.click(save())
    await browser.until(() => browser.has('Your name is required'), { label: 'the missing name to be asked for' })
    t.eq('without a name nothing is sent', (await seatsOf('implementation')).source, 'tree')
    const nameField = browser.all('.playbooks__actor input')[0]
    nameField.value = 'tester'
    nameField.dispatchEvent(new browser.window.Event('input', { bubbles: true }))
    await browser.clickWhen(() => (save().disabled ? null : save()), { label: 'Save seats' })
    await browser.until(() => browser.has('Runs started from now on get these seats'), { label: 'the save to be confirmed' })
    t.ok('the page says what changed', browser.has('coordinator opus-5-5 at low → opus-5-5 at xhigh'), browser.all('.v-alert').map((el) => el.textContent).join(' | '))
    await browser.until(() => card().textContent.includes('host copy'), { label: 'the card to show the host copy' })
    const after = await seatsOf('implementation')
    t.eq('the server holds the edit', [after.source, after.seats.find((s) => s.role === 'coordinator').effort], ['host', 'xhigh'])
    t.ok('the change is recorded with the name given', (await fs.readFile(path.join(hostDir, 'playbooks', '.history.jsonl'), 'utf8')).includes('"actor":"tester"'))
    t.ok('written into this installation\'s host-config, the catalogue untouched', (await fs.readFile(copy, 'utf8')).includes('effort: xhigh') && (await fs.readFile(path.join(stage.configRoot, 'playbooks', 'implementation.yaml'), 'utf8')).includes('effort: low'))

    t.section('a refused edit is shown, not saved')
    const refusedSave = await stage.request('/api/playbook-seats/implementation', { method: 'PUT', body: JSON.stringify({ seats: { implementer: null }, actor: 'test' }) })
    t.eq('the API refuses to empty a required seat', [refusedSave.status, /cannot be left empty/.test(refusedSave.body?.error ?? '')], [400, true])
    t.eq('no render errors', browser.problems.filter((p) => /TypeError|ReferenceError/.test(p)), [])
  } finally { browser.close(); await stage.stop(); await fs.rm(hostDir, { recursive: true, force: true }) }
}
