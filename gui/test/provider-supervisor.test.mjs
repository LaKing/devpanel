import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-supervisor-'))
  let model = { id: 'provider', harness: 'claude', model: 'provider-model', profile: 'provider', endpointRef: 'env:PROVIDER_URL', credentialRef: 'env:PROVIDER_KEY', verification: { status: 'verified' } }
  const calls = []
  const agent = await createTopSupervisor({
    dir, models: async () => [{ ...model }],
    adapter: { invoke: async args => {
      calls.push(args)
      return { session: args.session ?? { id: `session-${calls.length}` }, response: '{"message":"Ready","action":null}', usage: { costUsd: null } }
    } },
    tools: { playbooks: async () => [], projects: async () => [{ id: 'project' }], listIssues: async () => [], infrastructure: async () => null },
    pollMs: 10000
  })
  const turn = async () => {
    const expected = calls.length + 1
    await agent.start({ model: 'provider', projects: ['project'], message: 'Check status' })
    const deadline = Date.now() + 4000
    while (calls.length < expected || agent.get().status !== 'active' || !agent.get().session) {
      if (Date.now() > deadline) throw Error('Supervisor did not finish')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await agent.stop()
    return calls.at(-1)
  }
  try {
    t.ok('verified provider is selectable for supervisor', (await agent.models())[0].launchReady)
    const first = await turn()
    t.eq('supervisor forwards the provider profile', first.profile, 'provider')
    t.eq('supervisor forwards connection references', [first.endpointRef, first.credentialRef], ['env:PROVIDER_URL', 'env:PROVIDER_KEY'])
    t.eq('same provider resumes the native session', (await turn()).session?.id, 'session-1')
    model = { ...model, endpointRef: 'env:OTHER_URL' }
    t.eq('changing the endpoint reference starts fresh', (await turn()).session, null)
    model = { ...model, profile: 'deepseek', model: 'deepseek-flash', credentialRef: 'env:DEEPSEEK_KEY' }
    const switched = await turn()
    t.eq('switching provider starts fresh', switched.session, null)
    t.eq('DeepSeek model reaches supervisor adapter', switched.model, 'deepseek-flash')
  } finally {
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
