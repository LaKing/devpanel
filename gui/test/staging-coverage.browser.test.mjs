import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'staging coverage notes — a kept note shows on an archived issue, with a link to the release run in this tab'

export default async function (t) {
  const stage = await startStage()
  const release = await stage.createIssue('Release issue')
  const archived = await stage.createIssue('Issue the release carried')
  const root = `/api/projects/${stage.project}/issues`
  await stage.request(`${root}/${archived.id}/archive`, { method: 'POST', body: JSON.stringify({ overrideReason: 'test: archived before the release' }) })
  // What createEngineNote keeps for an archived issue: a release cannot run here, its note can stand.
  await fs.writeFile(path.join(stage.issuesDir, '.archive', stage.project, `${archived.id}.notes.json`), JSON.stringify([
    { name: 'staging-coverage', invocationId: 'staging-coverage:rel', at: new Date().toISOString(),
      text: `# Staging release failed\n\n[Release run rel](/projects/${stage.project}/${release.id}?run=rel) on issue ${release.id}.` }
  ]))

  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${archived.id}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Notes since this issue was archived'))
    t.ok('the kept note is shown on the archived issue', browser.has('Staging release failed'))
    // JSDOM does not navigate on an anchor click: this says what the link is, not that following it works.
    const link = browser.all('a').find((a) => a.textContent.includes('Release run rel'))
    t.eq('its link is the panel path of the release run', link?.getAttribute('href'), `/projects/${stage.project}/${release.id}?run=rel`)
    t.eq('with no target, so it stays in this tab', link?.getAttribute('target'), null)
    t.eq('and no rel', link?.getAttribute('rel'), null)
  } finally { browser.close() }
}
