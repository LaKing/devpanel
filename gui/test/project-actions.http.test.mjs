import fs from 'node:fs/promises'
import path from 'node:path'
import { io } from 'socket.io-client'

import { startStage } from './browser/stage.mjs'

/*
 * The project-action routes and the `project:action` socket stream, against a
 * real server process on a throwaway port with its own fake project directory.
 * Nothing here touches /srv or a real checkout.
 */
export default async function (t) {
  const stage = await startStage()
  const projectPath = path.join(stage.projectsDir, stage.project)
  await fs.writeFile(path.join(projectPath, 'checkpoint.sh'), [
    '#!/bin/bash',
    '# DEVPANEL cmd: Commit application changes',
    'cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1',
    'echo "line one"; sleep 0.2; echo "line two" >&2; sleep 0.2; echo "line three"',
    'test -z "$(cat fail 2>/dev/null)" || exit 4'
  ].join('\n') + '\n', { mode: 0o755 })
  const socket = io(stage.origin, { transports: ['websocket'], auth: { token: stage.token } })
  const events = []
  socket.on('project:action', (e) => events.push(e))
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
  const until = async (pred, ms = 10000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)) } }
  try {
    t.section('listing')
    const listing = await stage.request(`/api/projects/${stage.project}/actions`)
    t.eq('the checkpoint action is listed for a project with checkpoint.sh', [listing.status, listing.body.actions.map((a) => a.id)], [200, ['checkpoint']])
    t.eq('the label comes from the script header', listing.body.actions[0].label, 'Commit application changes')
    t.eq('an unknown project is 404', (await stage.request('/api/projects/nope-project/actions')).status, 404)
    t.eq('an unknown action is 404', (await stage.request(`/api/projects/${stage.project}/actions/deploy`, { method: 'POST' })).status, 404)

    t.section('starting and streaming')
    // A browser cannot pass arguments: only the daily full verification appends any.
    const started = await stage.request(`/api/projects/${stage.project}/actions/checkpoint`, { method: 'POST', body: JSON.stringify({ args: ['--minor'] }) })
    t.eq('starting answers 202 with the running record', [started.status, started.body.operation.status, started.body.operation.action], [202, 'running', 'checkpoint'])
    t.eq('arguments in the request body are ignored', started.body.operation.args, [])
    const id = started.body.operation.id
    await until(() => events.some((e) => e.type === 'ended' && e.operationId === id))
    const output = events.filter((e) => e.type === 'output' && e.operationId === id).map((e) => e.entry)
    t.ok('every chunk arrived over the socket with a sequence number', output.length >= 4 && output.every((e, i) => e.seq === i + 1))
    t.ok('stdout and stderr are both streamed', output.some((e) => e.kind === 'stdout' && e.text.includes('line one')) && output.some((e) => e.kind === 'stderr' && e.text.includes('line two')))
    const ended = events.find((e) => e.type === 'ended' && e.operationId === id)
    t.eq('the end event carries the completed record', [ended.operation.status, ended.operation.exitCode], ['completed', 0])
    const read = await stage.request(`/api/projects/${stage.project}/actions/operations/${id}`)
    t.eq('the record is readable afterwards with the same entries', [read.status, read.body.entries.map((e) => e.seq)], [200, output.map((e) => e.seq)])
    const partial = await stage.request(`/api/projects/${stage.project}/actions/operations/${id}?after=${read.body.next - 1}`)
    t.eq('catch-up from a sequence returns only what follows', partial.body.entries.length, 1)
    t.eq('the listing shows it as the last checkpoint', (await stage.request(`/api/projects/${stage.project}/actions`)).body.actions[0].last?.id, id)
    t.eq('an unknown operation is 404', (await stage.request(`/api/projects/${stage.project}/actions/operations/2026-01-01T00-00-00-000Z-deadbeef`)).status, 404)

    t.section('failure and stop')
    await fs.writeFile(path.join(projectPath, 'fail'), 'yes')
    const failing = await stage.request(`/api/projects/${stage.project}/actions/checkpoint`, { method: 'POST' })
    await until(() => events.some((e) => e.type === 'ended' && e.operationId === failing.body.operation.id))
    const failed = events.find((e) => e.type === 'ended' && e.operationId === failing.body.operation.id).operation
    t.eq('a non-zero exit is reported as failed with its code', [failed.status, failed.exitCode], ['failed', 4])
    await fs.rm(path.join(projectPath, 'fail'))
    await fs.writeFile(path.join(projectPath, 'checkpoint.sh'), '#!/bin/bash\necho waiting; sleep 30\n', { mode: 0o755 })
    const slow = await stage.request(`/api/projects/${stage.project}/actions/checkpoint`, { method: 'POST' })
    const busy = await stage.request(`/api/projects/${stage.project}/actions/checkpoint`, { method: 'POST' })
    t.eq('a second start while one runs is 409', busy.status, 409)
    const stopped = await stage.request(`/api/projects/${stage.project}/actions/operations/${slow.body.operation.id}/stop`, { method: 'POST' })
    t.eq('stop interrupts the operation', [stopped.status, stopped.body.operation.status], [200, 'interrupted'])
    t.eq('the ended event says so too', events.find((e) => e.type === 'ended' && e.operationId === slow.body.operation.id)?.operation.status, 'interrupted')
  } finally {
    socket.close()
    await stage.stop()
  }
}
