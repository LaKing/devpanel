import fs from 'node:fs/promises'
import path from 'node:path'

import { engineFixture } from './fakes/fixture.mjs'
import { PANEL_HOST, derivedOpenedBy, describeOpener, clientHost } from '../server/opened-by.mjs'

export const name = 'issue provenance — who opened an issue (user@host) and the issue it came from'

export default async function (t) {
  const f = await engineFixture()
  const project = 'devpanel-project'

  t.section('1. a person opening an issue is recorded as user@host')
  {
    const issue = await f.issues.createIssue(project, { input: 'Opened from the panel', openedBy: { user: 'Alice', host: 'workstation.lan' } })
    t.eq('on the issue as read', [issue.openedBy?.user, issue.openedBy?.host, issue.openedBy?.from], ['Alice', 'workstation.lan', null])
    const meta = JSON.parse(await fs.readFile(path.join(issue.path, 'issue.json'), 'utf8'))
    t.eq('and written to issue.json', meta.openedBy?.user, 'Alice')
    t.eq('described as user@host', describeOpener(issue.openedBy), 'Alice@workstation.lan')
    t.eq('its copyable location is its folder', issue.location, issue.path)
  }

  t.section('2. an opener that says nothing is recorded as unknown on this host, never omitted')
  {
    const issue = await f.issues.createIssue(project, { input: 'Opened by a caller that named nobody' })
    t.eq('unknown@panel host', [issue.openedBy?.user, issue.openedBy?.host], ['unknown', PANEL_HOST])
    let refused = null
    try { await f.issues.createIssue(project, { input: 'Bad provenance', openedBy: { user: 'x', from: { issueId: 'a', via: 'rumour' } } }) } catch (error) { refused = error }
    t.eq('an unknown kind of descent is refused', refused?.status, 400)
    t.eq('and nothing was created for it', (await f.issues.listIssues(project)).some((i) => i.name === 'Bad provenance'), false)
  }

  t.section('3. a follow-up names the issue and run it came from, and who asked for it')
  {
    const source = await f.issues.createIssue(project, { input: 'Source of a follow-up', openedBy: { user: 'Alice', host: 'ws' } })
    const runDir = path.join(source.path, 'runs', 'run-1')
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'run-1', closure: { at: '2026-10-04T00:00:00Z', residualRisks: [{ description: 'Cache is not invalidated on rename', accepted: false }] } }))
    const result = await f.issues.createFollowUps(project, source.id, 'run-1', { by: { user: 'supervisor' } })
    const followUp = await f.issues.getIssue(project, result.followUps[0].issueId)
    t.eq('opened by the supervisor on this host', [followUp.openedBy?.user, followUp.openedBy?.host], ['supervisor', PANEL_HOST])
    t.eq('from the source issue and run, as a follow-up', [followUp.openedBy?.from?.issueId, followUp.openedBy?.from?.runId, followUp.openedBy?.from?.via], [source.id, 'run-1', 'follow-up'])
  }

  t.section('3b. a red daily full verification names its cycle, not a parent issue')
  {
    const issue = await f.issues.createIssue(project, { input: 'Full verification 2026-11-07: devpanel-project red on stage', openedBy: { user: 'engine', from: { project, runId: 'run-9', via: 'full-verification', cycle: '2026-11-07.1' } } })
    t.eq('from the cycle and its stage run, with no parent issue', issue.openedBy?.from, { project, issueId: null, runId: 'run-9', via: 'full-verification', cycle: '2026-11-07.1' })
    let refused = null
    try { await f.issues.createIssue(project, { input: 'No cycle named', openedBy: { user: 'engine', from: { project, via: 'full-verification' } } }) } catch (error) { refused = error }
    t.eq('a full verification descent without its cycle is refused', refused?.status, 400)
  }

  t.section('4. issues opened before this was recorded say what their own record implies, marked derived')
  {
    t.eq('from an inquiry proposal', derivedOpenedBy({ fromInquiry: { inquiryId: 'inq', runId: 'r' } }, 'p')?.from?.via, 'inquiry')
    t.eq('from a run finding', derivedOpenedBy({ origin: { issue: 'src', runId: 'r', key: 'k' } }, 'p')?.from?.issueId, 'src')
    t.eq('an inquiry knows who asked it', derivedOpenedBy({ inquiry: { createdBy: 'operator' } }, 'p')?.user, 'operator')
    t.eq('derived, never presented as recorded', derivedOpenedBy({ origin: { issue: 'src' } }, 'p')?.derived, true)
    t.eq('nothing on record is unknown, not invented', derivedOpenedBy({}, 'p'), null)
  }

  t.section('5. the host is the machine the request came from')
  {
    t.eq('loopback is this panel host', await clientHost({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), PANEL_HOST)
    const remote = await clientHost({ socket: { remoteAddress: '::ffff:192.0.2.7' } }, { timeoutMs: 200 })
    t.ok('a remote address is its reverse name or the address itself', typeof remote === 'string' && remote.length > 0 && !remote.startsWith('::ffff:'), remote)
  }
}
