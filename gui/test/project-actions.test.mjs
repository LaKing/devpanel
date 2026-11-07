import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

import { sandbox } from './helpers.mjs'
import { listProjectActions, parseScriptHeader, readOperation, startProjectAction, stopProjectAction, operationReport } from '../server/project-actions.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

/*
 * Project actions never touch a real checkout here: the "project" is a temp
 * directory with its own checkpoint.sh, and the records land in a temp issues dir.
 */
export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-actions-'))
  const projectsDir = path.join(dir, 'srv')
  const issuesDir = path.join(dir, 'issues')
  const root = await sandbox()
  const project = 'fixture-project'
  const projectPath = path.join(projectsDir, project)
  await fs.mkdir(path.join(projectPath, '@boilerplate'), { recursive: true })
  await fs.mkdir(path.join(projectsDir, 'plain-project'), { recursive: true })
  await fs.mkdir(path.join(root, 'projects'), { recursive: true })
  const push = [
    '#!/bin/bash',
    '# DEVPANEL icon: mdi-source-repository',
    '# DEVPANEL hint: Commit a versioned application snapshot',
    '# DEVPANEL cmd: Commit application changes',
    '# DEVPANEL popup: false',
    'cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1',
    'printf "version %s\\n" "$(cat version 2>/dev/null || echo 0)"',
    'echo "$(( $(cat version 2>/dev/null || echo 0) + 1 ))" > version',
    'echo "committed as $DEVPANEL_PROJECT_ACTION/$DEVPANEL_OPERATION_ID" >&2',
    'test -z "$PUSH_FAIL" || { echo "nothing to commit" >&2; exit 3; }',
    'test -z "$PUSH_SLEEP" || sleep "$PUSH_SLEEP"',
    'echo "args:[$#:$1]"',
    'echo done'
  ].join('\n') + '\n'
  await fs.writeFile(path.join(projectPath, 'checkpoint.sh'), push, { mode: 0o755 })
  const opts = { root, projectsDir, issuesDir }
  const events = []
  const emit = (e) => events.push(e)

  try {
    t.section('discovery')
    t.eq('script headers are parsed', parseScriptHeader(push), { icon: 'mdi-source-repository', hint: 'Commit a versioned application snapshot', cmd: 'Commit application changes', popup: 'false' })
    const editor = '#!/bin/bash\n# EDITOR icon: mdi-pencil\n# EDITOR effect: commit-checkout\n# DEVPANELX hint: not a marker\n'
    t.eq('another marker word is not read by default', parseScriptHeader(editor), {})
    t.eq('it is read when the host settings name it (projectActions.headerMarkers), DEVPANEL still too', parseScriptHeader(editor + '# DEVPANEL cmd: Go\n', ['DEVPANEL', 'EDITOR']), { icon: 'mdi-pencil', effect: 'commit-checkout', cmd: 'Go' })
    const listing = await listProjectActions(project, opts)
    t.eq('a project with checkpoint.sh gets the checkpoint action', listing.actions.map((a) => a.id), ['checkpoint'])
    t.eq('checkpoint runs the script in the project root', [listing.actions[0].run, listing.actions[0].cwd], ['bash ./checkpoint.sh', projectPath])
    t.eq('the label comes from the script header', listing.actions[0].label, 'Commit application changes')
    t.eq('a boilerplate checkout is recognised', [listing.boilerplate, listing.checkpointRequired], [true, true])
    // Capability is declared, never inferred from a name. A checkpoint.sh that says
    // nothing about what it does is not an action an agent may run on its own
    // reasoning: it may version, publish to a remote, restart or deploy.
    t.eq('a script that declares no effect claims none', listing.actions[0].effect, null)
    const plain = await listProjectActions('plain-project', opts)
    t.eq('a project without checkpoint.sh offers nothing', [plain.actions.length, plain.boilerplate], [0, false])
    let missing = null
    try { await listProjectActions('nope-project', opts) } catch (e) { missing = e.status }
    t.eq('an unknown project is 404', missing, 404)
    let traversal = null
    try { await listProjectActions('../etc', opts) } catch (e) { traversal = e.status }
    t.eq('a path-like project id is refused', traversal, 404)

    t.section('running checkpoint')
    const started = await startProjectAction({ project, actionId: 'checkpoint', emit, actor: 'test', ...opts })
    t.eq('the record is returned as soon as the operation exists', started.operation.status, 'running')
    t.ok('the start event carries the record', events[0]?.type === 'started' && events[0].operation.id === started.operation.id)
    const finished = await started.done
    t.eq('a zero exit completes the operation', [finished.status, finished.exitCode], ['completed', 0])
    t.eq('the script ran in the project root', (await fs.readFile(path.join(projectPath, 'version'), 'utf8')).trim(), '1')
    t.ok('stdout and stderr tails are kept on the record', finished.stdoutTail.includes('done') && finished.stderrTail.includes('committed as checkpoint/'))
    const read = await readOperation(project, finished.id, { issuesDir })
    const kinds = read.entries.map((e) => e.kind)
    t.eq('spawn marker first and exit marker last', [kinds[0], kinds.at(-1)], ['spawn', 'exit'])
    t.ok('both streams are recorded in order', kinds.includes('stdout') && kinds.includes('stderr'))
    t.ok('sequence numbers are contiguous', read.entries.every((e, i) => e.seq === i + 1))
    const outputs = events.filter((e) => e.type === 'output' && e.operationId === finished.id)
    t.eq('every persisted entry was emitted, in order', outputs.map((e) => e.entry.seq), read.entries.map((e) => e.seq))
    t.eq('the end event carries the final record', events.at(-1).type === 'ended' && events.at(-1).operation.status, 'completed')
    t.eq('catch-up reads only entries after a sequence', (await readOperation(project, finished.id, { issuesDir, after: read.next - 1 })).entries.length, 1)
    t.eq('the listing shows the last operation per action', (await listProjectActions(project, opts)).actions[0].last?.id, finished.id)
    const report = operationReport(finished)
    t.ok('the model report carries bounded output, not just an exit code', report.stdout.includes('done') && typeof report.outputBounded === 'string' && !('stdoutTail' in report))

    t.section('engine arguments (the daily full verification\'s --minor)')
    t.eq('without arguments the action gets none', finished.args, [])
    t.ok('… and the script sees none', finished.stdoutTail.includes('args:[0:]'))
    const minor = await (await startProjectAction({ project, actionId: 'checkpoint', args: ['--minor'], ...opts })).done
    t.eq('an argument completes and is recorded on the operation', [minor.status, minor.args], ['completed', ['--minor']])
    t.ok('it reaches the script as one separate word', minor.stdoutTail.includes('args:[1:--minor]'))
    const minorRead = await readOperation(project, minor.id, { issuesDir })
    t.ok('the spawn line names it', minorRead.entries[0].text.includes('bash ./checkpoint.sh --minor'))
    for (const bad of [';rm -rf .', '--minor x', '$(id)', 'minor', '--Minor', 42]) {
      let refused = null
      const before = (await fs.readFile(path.join(projectPath, 'version'), 'utf8')).trim()
      try { await startProjectAction({ project, actionId: 'checkpoint', args: [bad], ...opts }) } catch (e) { refused = e.status }
      t.eq(`argument ${JSON.stringify(bad)} is refused before anything runs`, [refused, (await fs.readFile(path.join(projectPath, 'version'), 'utf8')).trim()], [400, before])
    }

    t.section('failure, concurrency, stop, deadline')
    process.env.PUSH_FAIL = '1'
    let failed
    try { failed = await (await startProjectAction({ project, actionId: 'checkpoint', ...opts })).done } finally { delete process.env.PUSH_FAIL }
    t.eq('a non-zero exit is a failed operation with its code', [failed.status, failed.exitCode], ['failed', 3])
    t.ok('the failure text is in the record', failed.stderrTail.includes('nothing to commit'))

    process.env.PUSH_SLEEP = '5'
    let slow
    try { slow = await startProjectAction({ project, actionId: 'checkpoint', ...opts }) } finally { delete process.env.PUSH_SLEEP }
    let busy = null
    try { await startProjectAction({ project, actionId: 'checkpoint', ...opts }) } catch (e) { busy = e }
    t.eq('a second action on the project is refused while one runs', [busy?.status, busy?.operationId], [409, slow.operation.id])
    t.eq('the listing names the running operation', (await listProjectActions(project, opts)).running?.id, slow.operation.id)
    const stopped = await stopProjectAction(project, slow.operation.id, { issuesDir })
    t.eq('stop interrupts and confirms termination', [stopped.status, stopped.cancelled, stopped.timedOut], ['interrupted', true, false])
    t.ok('the process is gone', !processAlive(stopped.pid))
    t.eq('the lock is released after an interruption', (await (await startProjectAction({ project, actionId: 'checkpoint', ...opts })).done).status, 'completed')

    t.section('declared actions')
    await fs.writeFile(path.join(root, 'projects', `${project}.yaml`), YAML.stringify({ id: project, actions: [
      { id: 'checkpoint', label: 'Custom checkpoint', run: 'printf custom', timeoutSeconds: 5, effect: 'commit-checkout' },
      { id: 'slow', run: 'sleep 5', timeoutSeconds: 1 }
    ] }))
    const declared = await listProjectActions(project, opts)
    t.eq('a declared action replaces the built-in checkpoint', [declared.actions.find((a) => a.id === 'checkpoint').run, declared.actions.find((a) => a.id === 'checkpoint').source], ['printf custom', `projects/${project}.yaml`])
    t.eq('declared actions are listed after it', declared.actions.map((a) => a.id), ['checkpoint', 'slow'])
    t.eq('a declared effect is reported, and only where it was declared', declared.actions.map((a) => a.effect), ['commit-checkout', null])
    const custom = await (await startProjectAction({ project, actionId: 'checkpoint', ...opts })).done
    t.eq('the declared command runs', custom.stdoutTail, 'custom')
    const timedOut = await (await startProjectAction({ project, actionId: 'slow', ...opts })).done
    t.eq('a deadline interrupts and says so', [timedOut.status, timedOut.timedOut], ['interrupted', true])
    let unknown = null
    try { await startProjectAction({ project, actionId: 'deploy', ...opts }) } catch (e) { unknown = e.status }
    t.eq('an action the project does not declare is refused', unknown, 404)
    await fs.writeFile(path.join(root, 'projects', `${project}.yaml`), YAML.stringify({ id: project, actions: [{ id: 'bad id', run: 'true' }] }))
    let invalid = null
    try { await listProjectActions(project, opts) } catch (e) { invalid = e.status }
    t.eq('invalid configuration is an error, not a silent fallback', invalid, 422)
    await fs.rm(path.join(root, 'projects', `${project}.yaml`))

    t.section('the supervisor has no way to run one')
    /*
     * Project actions act on the live checkout. The top-level supervisor is the
     * management plane and takes no technical action at all, so this is not a
     * permission it is refused — it is a verb its vocabulary does not contain.
     * Operators run these from the panel; runs get the work through an issue.
     */
    let vocabulary = null
    try { parseSupervisorResponse('{"message":"Pushing","action":{"type":"run_project_action","project":"fixture-project","action":"push"}}') } catch (e) { vocabulary = e.message }
    t.ok('asking for one is not a recognised supervisor action', /Unknown or malformed supervisor action/.test(vocabulary ?? ''), vocabulary)
    let arbitrary = false
    try { parseSupervisorResponse('{"message":"x","action":{"type":"add_note","project":"p","issueId":"i","text":"t","run":"rm -rf /"}}') } catch { arbitrary = true }
    t.ok('and no action carries shell text', arbitrary)

  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function processAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
