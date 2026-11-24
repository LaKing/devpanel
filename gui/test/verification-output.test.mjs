import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cycleOutput, wholeCharacters } from '../server/verification-output.mjs'

export const name = 'verification output — a cycle entry\'s commands and the text of one, read like a terminal'

const refused = async (work) => { try { await work(); return null } catch (error) { return error } }

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-output-'))
  const runDir = path.join(root, 'd250')
  const put = async (file, text, at) => {
    await fs.mkdir(path.dirname(path.join(runDir, file)), { recursive: true })
    await fs.writeFile(path.join(runDir, file), text)
    if (at) await fs.utimes(path.join(runDir, file), at, at)
  }
  const cycle = { projects: [{ project: 'd250', mode: 'instance', runDir }, { project: 'framework', mode: 'derived' }] }
  await put('checks/full-verification/instance-create.log', '$ create\n\ncreated\n--- exit 0 in 7 ms\n')
  await new Promise((resolve) => setTimeout(resolve, 15))
  await put('checks/full-verification/ready.log', '$ ready\n\n12/12 READY\n--- exit 0 in 9 ms\n')
  await put('checks/full-verification/ready.stdout', '12/12 READY\n')
  await new Promise((resolve) => setTimeout(resolve, 15))
  await put('checks/full-verification/full-suite.live', '$ suite\n\nworker: PASS one\nworker: PASS két ✓\n')
  await put('checks/full-verification/remote-entries.json', '{}')

  t.section('the listing')
  const listing = await cycleOutput({ cycle, project: 'd250' })
  t.eq('commands in the order they ran, the running one last', listing.commands.map((c) => [c.key, c.running]), [['full-verification/instance-create', false], ['full-verification/ready', false], ['full-verification/full-suite', true]])
  t.eq('nothing is read without a command', listing.output, null)
  t.ok('only logs and live copies are commands', !listing.commands.some((c) => /stdout|remote-entries/.test(c.key)))

  t.section('reading a command from an offset')
  const first = await cycleOutput({ cycle, project: 'd250', command: 'full-verification/full-suite' })
  t.eq('the whole live copy so far', [first.output.text, first.output.running, first.output.truncated], ['$ suite\n\nworker: PASS one\nworker: PASS két ✓\n', true, false])
  await fs.appendFile(path.join(runDir, 'checks/full-verification/full-suite.live'), 'worker: FAIL three\n')
  const more = await cycleOutput({ cycle, project: 'd250', command: 'full-verification/full-suite', after: first.output.next })
  t.eq('the next reading is only what was printed since', more.output.text, 'worker: FAIL three\n')
  const small = await cycleOutput({ cycle, project: 'd250', command: 'full-verification/full-suite', after: 0, limit: 41 })
  t.ok('a reading that would stop inside a character stops before it and says more is left', small.output.truncated && small.output.text.endsWith('worker: PASS k') && small.output.next === Buffer.byteLength(small.output.text), JSON.stringify(small.output))
  const rest = await cycleOutput({ cycle, project: 'd250', command: 'full-verification/full-suite', after: small.output.next, limit: 64 })
  t.ok('and the next one begins with that character', rest.output.text.startsWith('ét ✓'), rest.output.text)
  t.eq('whole characters: an incomplete two-, three- and four-byte tail is cut, a complete one kept', [wholeCharacters(Buffer.from([0x61, 0xc3]), 2), wholeCharacters(Buffer.from([0x61, 0xe2, 0x9c]), 3), wholeCharacters(Buffer.from([0xf0, 0x9f, 0x98]), 3), wholeCharacters(Buffer.from('a✓'), 4), wholeCharacters(Buffer.from('abc'), 3)], [1, 1, 0, 4, 3])

  t.section('a command that ended is read from its log; an offset past it starts over')
  await fs.rm(path.join(runDir, 'checks/full-verification/full-suite.live'))
  await put('checks/full-verification/full-suite.log', '$ suite\n\nshort\n--- exit 1 in 5 ms\n')
  const ended = await cycleOutput({ cycle, project: 'd250', command: 'full-verification/full-suite', after: more.output.next })
  t.eq('from the start, flagged', [ended.output.running, ended.output.restarted, ended.output.text.includes('--- exit 1')], [false, true, true])

  t.section('a rerun of failed tests is listed after the drive')
  await put('checks/full-verification-rerun-1/rerun-tests-rerun-1.log', '$ rerun\n\nPASS alone\n')
  const withRerun = await cycleOutput({ cycle, project: 'd250' })
  t.eq('with its directory in the key', [withRerun.commands.at(-1).key, withRerun.commands.at(-1).rerun], ['full-verification-rerun-1/rerun-tests-rerun-1', true])

  t.section('refusals')
  t.eq('a project with no drive in the cycle', (await refused(() => cycleOutput({ cycle, project: 'framework' })))?.status, 404)
  t.eq('a project the cycle does not have', (await refused(() => cycleOutput({ cycle, project: 'nope' })))?.status, 404)
  t.eq('a command the listing does not offer, a path among them', [(await refused(() => cycleOutput({ cycle, project: 'd250', command: 'full-verification/nope' })))?.status, (await refused(() => cycleOutput({ cycle, project: 'd250', command: '../../etc/passwd' })))?.status], [404, 404])
  await fs.rm(root, { recursive: true, force: true })
}
