import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'issue family — the list nests children, the issue page names parent and prerequisites'

export default async function (t) {
  const stage = await startStage()
  const parent = await stage.createIssue('Parent with a finding')
  const child = await stage.createIssue('Child finding')
  const rule = await stage.createIssue('Rule to settle first')
  // Provenance is written at creation by the engine; a folder edit stands in for a finding here.
  const file = path.join(stage.issuesDir, stage.project, child.id, 'issue.json')
  const meta = JSON.parse(await fs.readFile(file, 'utf8'))
  meta.openedBy = { user: 'engine', host: 'h', from: { project: stage.project, issueId: parent.id, runId: null, via: 'finding' } }
  await fs.writeFile(file, JSON.stringify(meta))
  await stage.request(`/api/projects/${stage.project}/issues/${child.id}/dependencies`, { method: 'POST', body: JSON.stringify({ dependsOn: [rule.id], reason: 'needs the rule' }) })

  let browser = await openBrowser(`${stage.origin}/projects/${stage.project}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Child finding'))
    const names = () => browser.all('tbody tr').map((tr) => tr.querySelector('.issues__name')?.textContent ?? '')
    const order = names()
    t.ok('the child is listed right under its parent', order.indexOf('Child finding') === order.indexOf('Parent with a finding') + 1, order.join(' | '))
    const node = browser.all('.issues__node').find((el) => el.textContent.includes('Child finding'))
    t.eq('indented one level', node?.style.getPropertyValue('--depth'), '1')
    t.ok('the parent says it has an open sub-issue', browser.has('1 open sub-issue'))
    t.ok('the child says what it waits for', browser.has('waits for Rule to settle first'))
    t.ok('the prerequisite says what it holds up', browser.has('holds up 1'))
    await browser.clickWhen(() => browser.all('button').find((el) => el.getAttribute('aria-label') === 'Hide the issues that came out of this one'))
    await browser.until(() => !names().includes('Child finding'))
    t.ok('collapsing hides the child', !names().includes('Child finding'))
    browser.close()

    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${child.id}`, { token: stage.token })
    await browser.until(() => browser.has('Finding of'))
    const family = () => browser.all('.family')[0]?.textContent ?? ''
    t.ok('the issue page names its parent', family().includes('Parent with a finding'), family())
    t.ok('and its prerequisite with the reason', family().includes('Rule to settle first') && family().includes('needs the rule'), family())
    browser.close()

    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${rule.id}`, { token: stage.token })
    await browser.until(() => browser.has('Waiting for this'))
    t.ok('the prerequisite lists what waits for it', family().includes('Child finding'), family())
    browser.close()

    // What a report's record says, written by hand: the report route refuses a loopback peer.
    const write = async (issue, fields) => {
      const recordFile = path.join(stage.issuesDir, stage.project, issue.id, 'issue.json')
      await fs.writeFile(recordFile, JSON.stringify({ ...JSON.parse(await fs.readFile(recordFile, 'utf8')), ...fields }))
    }
    const archive = (issue) => stage.request(`/api/projects/${stage.project}/issues/${issue.id}/archive`, { method: 'POST', body: JSON.stringify({ overrideReason: 'test' }) })
    const older = await stage.createIssue('Older fault history')
    await archive(older)
    const repeat = await stage.createIssue('Newer report of it')
    await write(repeat, { repeats: { project: stage.project, id: older.id, evidence: 'fingerprint', fingerprint: 'abc123def' } })
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${repeat.id}`, { token: stage.token })
    await browser.until(() => browser.has('Repeats (same fingerprint'))
    t.ok('an open report names what it repeats, with the fingerprint', family().includes('Older fault history') && family().includes('abc123def'), family())
    t.ok('as a link to that history', browser.all('.family__repeats a').some((a) => a.getAttribute('href')?.endsWith(`/${older.id}`)))
    browser.close()

    await archive(repeat)
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${repeat.id}`, { token: stage.token })
    await browser.until(() => browser.has('Repeats (same fingerprint'))
    t.ok('so does a packed report', browser.has('Archived and packed') && browser.all('.family__repeats a').some((a) => a.getAttribute('href')?.endsWith(`/${older.id}`)))
    browser.close()

    const titled = await stage.createIssue('Shares only a title')
    await write(titled, { sameTitleAs: { project: stage.project, id: older.id } })
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${titled.id}`, { token: stage.token })
    await browser.until(() => browser.has('Same title as'))
    t.ok('a shared title says it is not shown to be the same fault', family().includes('not shown to be the same fault') && !family().includes('Repeats'), family())
    browser.close()

    const pending = await stage.createIssue('Pending report')
    await write(pending, { repeatLookup: { unread: [older.id], at: 'x' } })
    await archive(pending)
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${pending.id}`, { token: stage.token })
    await browser.until(() => browser.has('Could not check'))
    t.ok('a packed report still pending names what it could not check', family().includes('1 archived issue') && family().includes(older.id), family())
    browser.close()

    const listing = await stage.createIssue('Unlisted report')
    await write(listing, { repeatLookup: { listing: true, at: 'x' } })
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${listing.id}`, { token: stage.token })
    await browser.until(() => browser.has('could not be listed'))
    t.ok('and one whose listing failed says so', family().includes('not known yet'), family())
    browser.close()

    // A folder beside a bundle of its id, as an id that once named two left it.
    const twin = await stage.createIssue('Older twin')
    await archive(twin)
    const twinDir = path.join(stage.issuesDir, stage.project, twin.id)
    await fs.mkdir(twinDir)
    await fs.writeFile(path.join(twinDir, 'issue.json'), JSON.stringify({ name: 'Newer twin', project: stage.project }))
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${twin.id}`, { token: stage.token })
    await browser.until(() => browser.has('An older archived issue has this same id'))
    t.ok('the folder\'s page keeps the older issue readable', browser.has('Older twin') && browser.has('Newer twin'))
  } finally { browser.close() }
}
