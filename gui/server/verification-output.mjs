import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * What a full verification's drives print, for the Full verification page: per entry of the cycle the commands
 * of its drive in the order they ran, and the text of one of them from a byte offset on, so the page can follow
 * a running command like a terminal.
 *
 * Mechanism: a command that is running has `<id>.live` in its check directory (runtime/checks.mjs `runOne`
 * appends its output there as it arrives); one that has ended has `<id>.log`, the whole output with the command
 * line and its exit. The directories are the entry's own: `<runDir>/checks/full-verification` and, when failed
 * tests were rerun alone, `checks/full-verification-rerun-<n>`.
 * Decision: read-only and bounded. The entry is taken from the cycle record, never from the request, so a request
 * names only a project and a command the listing itself offered; a reading returns at most `limit` bytes.
 * Pitfall: the offset is in BYTES of the file, and a reading may end inside a multi-byte character: the text is cut
 * back to the last whole character and `next` says where the next reading starts.
 */

const refuse = (message, status) => Object.assign(new Error(message), { status })
const DIR = /^full-verification(-rerun-\d+)?$/
const COMMAND = /^[A-Za-z0-9._-]+$/

async function commandsIn (checks, dirName) {
  const dir = path.join(checks, dirName)
  const names = await fs.readdir(dir).catch(() => [])
  const found = new Map()
  for (const name of names) {
    const match = name.match(/^(.+)\.(live|log)$/)
    if (!match || !COMMAND.test(match[1])) continue
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (!stat?.isFile()) continue
    // A command that is running has both only for an instant; the live file says it has not ended.
    const known = found.get(match[1])
    if (known && known.running) continue
    found.set(match[1], { key: `${dirName}/${match[1]}`, id: match[1], rerun: dirName !== 'full-verification', running: match[2] === 'live', bytes: stat.size, changedAt: stat.mtime.toISOString(), birth: stat.birthtimeMs || stat.mtimeMs })
  }
  return [...found.values()]
}

/** How many of the first `length` bytes are whole UTF-8 characters: a reading may stop inside the last one. */
export function wholeCharacters (buffer, length) {
  let lead = length
  let continuation = 0
  while (lead > 0 && continuation < 3 && (buffer[lead - 1] & 0xc0) === 0x80) { lead--; continuation++ }
  if (lead === 0) return length
  const byte = buffer[lead - 1]
  const needs = byte >= 0xf0 ? 3 : byte >= 0xe0 ? 2 : byte >= 0xc0 ? 1 : 0
  return continuation >= needs ? length : lead - 1
}

/** The entry of `project` in a cycle record, with the directory its drive wrote into; null when it has none. */
const entryOf = (cycle, project) => (cycle?.projects ?? []).find((p) => p.project === project && typeof p.runDir === 'string') ?? null

/**
 * The commands of one entry's drive, oldest first, and optionally the text of one from `after` on.
 * `{ commands: [{ key, id, rerun, running, bytes, changedAt }], output: { key, text, next, running, truncated } | null }`
 */
export async function cycleOutput ({ cycle, project, command = null, after = 0, limit = 262144 }) {
  const entry = entryOf(cycle, project)
  if (!entry) throw refuse(`the latest cycle has no drive of ${project}`, 404)
  const checks = path.join(entry.runDir, 'checks')
  const dirs = (await fs.readdir(checks).catch(() => [])).filter((name) => DIR.test(name)).sort((a, b) => a.length - b.length || a.localeCompare(b, undefined, { numeric: true }))
  const commands = []
  for (const dirName of dirs) commands.push(...(await commandsIn(checks, dirName)).sort((a, b) => a.birth - b.birth))
  const listed = commands.map(({ birth, ...rest }) => rest)
  if (command == null) return { commands: listed, output: null }

  const wanted = listed.find((c) => c.key === command)
  if (!wanted) throw refuse(`no command ${command} in the drive of ${project}`, 404)
  const offset = Number.isInteger(after) && after >= 0 ? after : 0
  const file = path.join(checks, `${wanted.key}.${wanted.running ? 'live' : 'log'}`)
  const handle = await fs.open(file, 'r').catch(() => null)
  // It ended between the listing and this read: the page asks again and gets the log.
  if (!handle) return { commands: listed, output: { key: wanted.key, text: '', next: 0, running: false, truncated: false, restarted: true } }
  try {
    const { size } = await handle.stat()
    // The live file is replaced by a log that begins differently: an offset past the end starts over.
    const from = offset > size ? 0 : offset
    const length = Math.min(limit, size - from)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, from)
    const end = wholeCharacters(buffer, bytesRead)
    return { commands: listed, output: { key: wanted.key, text: buffer.subarray(0, end).toString('utf8'), next: from + end, running: wanted.running, truncated: from + end < size, restarted: from !== offset } }
  } finally { await handle.close() }
}
