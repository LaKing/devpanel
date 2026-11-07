import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { addReporter, readReporters, removeReporter, reporterForKey, reportStartRefusal, setPolicy } from '../server/reporters.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { startAdmission } from '../server/start-admission.mjs'

const wait = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) } }

export const name = 'reporters — keyed deployments, and what the supervisor may start on what they report'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-reporters-'))
  const previous = process.env.DEVPANEL_REPORTERS_FILE
  process.env.DEVPANEL_REPORTERS_FILE = path.join(dir, '.reporters.json')
  try {
    t.section('1. a key is shown once and stored as a hash')
    const key = await addReporter({ name: 'example-prod', project: 'example.invalid-project' })
    const stored = await fs.readFile(process.env.DEVPANEL_REPORTERS_FILE, 'utf8')
    t.eq('the key is not on disk', stored.includes(key), false)
    t.eq('the store is 0600', (await fs.stat(process.env.DEVPANEL_REPORTERS_FILE)).mode & 0o777, 0o600)
    t.eq('the key names its reporter', await reporterForKey(key), { name: 'example-prod', project: 'example.invalid-project', policy: { fault: 'any', request: 'assess' } })
    t.eq('another key names no one', await reporterForKey('nope'), null)
    const rotated = await addReporter({ name: 'example-prod', project: 'example.invalid-project' })
    t.eq('a new key replaces the old one', [await reporterForKey(key), (await reporterForKey(rotated))?.name], [null, 'example-prod'])
    let refused = null
    try { await addReporter({ name: 'x', project: 'p', policy: { fault: 'all' } }) } catch (error) { refused = error.message }
    t.ok('an unknown level is refused', /fault must be one of/.test(refused ?? ''))

    t.section('2. the supervisor is bounded by the trust, read from the current record')
    const issue = (trust, reporter = 'example-prod') => ({ id: 'i1', report: { kind: trust === 'request' ? 'request' : 'fault', reporter: trust === 'anonymous' ? null : reporter, trust } })
    t.eq('an issue that is not a report is never refused', await reportStartRefusal({ id: 'plain' }, 'implementation'), null)
    t.ok('anonymous: nothing, not even triage', /may start no playbook/.test(await reportStartRefusal(issue('anonymous'), 'triage')))
    t.eq('fault (default any): implementation may start', await reportStartRefusal(issue('fault'), 'implementation'), null)
    t.eq('request (default assess): triage may start', await reportStartRefusal(issue('request'), 'triage'), null)
    t.ok('request: implementation is refused', /may start only triage or analysis/.test(await reportStartRefusal(issue('request'), 'implementation')))
    await setPolicy('example-prod', { fault: 'assess' })
    t.ok('a tightened policy applies to issues already open', /only triage or analysis/.test(await reportStartRefusal(issue('fault'), 'implementation')))
    await removeReporter('example-prod')
    t.ok('a removed reporter counts as anonymous', /may start no playbook/.test(await reportStartRefusal(issue('fault'), 'analysis')))
    t.eq('and is gone', await readReporters(), {})

    t.section('3. the top-level supervisor is refused a start the trust does not allow')
    {
      const reporters = { 'aid-relay': { project: 'p', policy: { fault: 'any', request: 'assess' } } }
      const reported = { id: 'feature', report: { kind: 'request', category: 'feature', reporter: 'aid-relay', trust: 'request' } }
      const started = []
      let script = []
      const adapter = { invoke: async (args) => {
        const event = JSON.parse(args.prompt).event
        const action = script.shift()?.(event) ?? null
        return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
      } }
      const tools = {
        projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [],
        getIssue: async () => ({ issue: reported, reports: [], runs: [] }),
        preview: async () => ({ ok: true, configHash: 'h' }),
        start: async (a) => { started.push(a.playbook); return { runId: `r${started.length}`, status: 'running' } },
        getRun: async () => ({ status: 'completed' }),
        startAdmission: async (a) => startAdmission({ issue: reported, playbook: a.playbook }, { reporters })
      }
      const sup = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-report-'))
      const agent = await createTopSupervisor({ dir: sup, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
      script = [
        () => ({ type: 'preview', project: 'p', issueId: 'feature', playbook: 'implementation' }),
        (e) => ({ type: 'start_run', project: 'p', issueId: 'feature', previewId: e.result.previewId }),
        () => ({ type: 'preview', project: 'p', issueId: 'feature', playbook: 'triage' }),
        (e) => ({ type: 'start_run', project: 'p', issueId: 'feature', previewId: e.result.previewId }),
        () => ({ type: 'finish' })
      ]
      await agent.start({ model: 'm', projects: ['p'], message: 'go', limits: { maxCalls: 20, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } })
      await wait(() => agent.get().finishing === true)
      const tool = (i) => agent.get().messages.filter((m) => m.role === 'tool')[i]?.text ?? ''
      t.ok('a person\'s feature request is not implemented by the supervisor', tool(1).includes('may start only triage or analysis'), tool(1))
      t.eq('triage of it may start', started, ['triage'])
      await agent.shutdown()
      await fs.rm(sup, { recursive: true, force: true })
    }
  } finally {
    if (previous === undefined) delete process.env.DEVPANEL_REPORTERS_FILE
    else process.env.DEVPANEL_REPORTERS_FILE = previous
    await fs.rm(dir, { recursive: true, force: true })
  }
}
