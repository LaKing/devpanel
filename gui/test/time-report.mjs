import { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/*
 * Where a stretch of a suite's time went, observed rather than inferred. Output
 * only: nothing here changes what a test sees, apart from `sleep` on the PATH of a
 * filtered run being a script that records its argument and execs the real one.
 *
 *   time:     wall; this process's CPU, all threads; its main thread's alone, the
 *             one that can hold everything up; reaped children's (Linux, 1/100 s).
 *             Not the event loop's own idle figure: the profiler's sampling signals
 *             interrupt the poll it is counted across, and it reads near zero
 *   wait:     wall during which a child was in flight, and during which only a
 *             timer of this process was (children overlap; each is a union)
 *   children: per program, how many started and the wall they covered
 *   timers:   per call site, the timers of this process that fired, and their delays
 *   sleeps:   per length, the shell sleeps of children the PATH still reaches: the
 *             launcher's registration poll (0.1) and started-marker poll (0.2) among them
 *   profile:  per suite, the functions holding this process's CPU
 *
 * The last four are for a filtered run (`npm test -- <name>`), which is the one
 * asked about one suite; a whole `npm test` gets the time line alone.
 *
 * Figures are taken while the work runs and belong to what ran in that stretch.
 * Sections that overlap (helpers.mjs overlappingSections) share a process and its
 * CPU, so they get one set of figures as a group, and each only its own wall time. A
 * section that runs alone gets its own. For every section's own figures, `--sequential`
 * (`node test/run.mjs <name> --sequential`) runs the same sections one after another,
 * and its lines say so; it is a measuring run, not the time the suite normally takes.
 */
export const measuring = { sequential: false }
const BEFORE = '(before the first section)'
const AFTER = '(after the sections)'

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
const dim = (text) => `\x1b[2m${text}\x1b[0m`

function cpuMark () {
  const { user, system } = process.cpuUsage()
  let children = null
  let main = null
  try {
    const fieldsOf = (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const whole = fieldsOf(readFileSync('/proc/self/stat', 'utf8'))
    children = (Number(whole[13]) + Number(whole[14])) * 10
    const thread = fieldsOf(readFileSync(`/proc/self/task/${process.pid}/stat`, 'utf8'))
    main = (Number(thread[11]) + Number(thread[12])) * 10
  } catch { /* not Linux: only this process's own */ }
  return { at: performance.now(), self: (user + system) / 1000, children, main }
}

/** Disjoint, sorted ranges of the entries' parts inside [from, to]; an open entry runs to `to`. */
function ranges (entries, from, to) {
  const clipped = entries.map((e) => [Math.max(e.start, from), Math.min(e.end ?? to, to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [a, b] of clipped) {
    const last = merged.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}
const covered = (list) => list.reduce((sum, [a, b]) => sum + b - a, 0)
function overlap (x, y) {
  let sum = 0
  for (const [a, b] of x) for (const [c, d] of y) sum += Math.max(0, Math.min(b, d) - Math.max(a, c))
  return sum
}

/** The first frames that are ours, leaving out this file and the clock every sleep goes through. */
function callSite () {
  const holder = {}
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 12
  Error.captureStackTrace(holder, callSite)
  Error.stackTraceLimit = limit
  const frames = holder.stack.split('\n').slice(1).map((l) => /(?:file:\/\/)?(\/[^\s()]+?):(\d+):\d+\)?$/.exec(l)).filter(Boolean)
    .filter((m) => !m[1].endsWith('/time-report.mjs') && !m[1].endsWith('/clock.mjs')).map((m) => `${path.relative(process.cwd(), m[1])}:${m[2]}`)
  return frames.slice(0, 2).join(' < ') || '(node)'
}

export function installTimeReport ({ detail = false, sequential = false, print = console.log } = {}) {
  const children = []
  const timers = []
  const originalSpawn = ChildProcess.prototype.spawn
  const realTimeout = globalThis.setTimeout
  const originalPath = process.env.PATH
  const tag = sequential ? ' [sequential run]' : ''
  const say = (kind, text, label) => print(`    ${dim(`${kind}: ${text} — ${label}${tag}`)}`)
  let sleepFile = null
  let shimDir = null
  const wasSequential = measuring.sequential
  measuring.sequential = sequential

  if (detail) {
    ChildProcess.prototype.spawn = function (options) {
      const entry = { label: path.basename(String(options?.file ?? '?')), start: performance.now(), end: null }
      children.push(entry)
      try {
        const result = originalSpawn.call(this, options)
        this.once('close', () => { entry.end = performance.now() })
        return result
      } catch (error) { entry.end = performance.now(); throw error }
    }
    const timeout = function (callback, ms, ...args) {
      if (typeof callback !== 'function') return realTimeout(callback, ms, ...args)
      const entry = { label: callSite(), start: performance.now(), end: null, delay: ms ?? 0 }
      return realTimeout((...given) => { entry.end = performance.now(); timers.push(entry); return callback(...given) }, ms, ...args)
    }
    timeout[promisify.custom] = realTimeout[promisify.custom]
    globalThis.setTimeout = timeout

    const real = ['/usr/bin/sleep', '/bin/sleep'].find(existsSync)
    if (real) {
      shimDir = mkdtempSync(path.join(os.tmpdir(), 'devpanel-time-report-'))
      sleepFile = path.join(shimDir, 'sleeps')
      writeFileSync(path.join(shimDir, 'sleep'), `#!/bin/sh\n{ printf '%s\\n' "$1" >> '${sleepFile}'; } 2>/dev/null\nexec ${real} "$@"\n`, { mode: 0o755 })
      process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`
    }
  }

  function line (from, label) {
    const to = cpuMark()
    const onLinux = to.children === null ? '' : `, ${seconds(to.main - from.main)} main thread cpu, ${seconds(to.children - from.children)} child cpu`
    say('time', `${seconds(to.at - from.at)} wall, ${seconds(to.self - from.self)} own cpu${onLinux}`, label)
    if (!detail) return
    const inFlight = ranges(children, from.at, to.at)
    const timerRanges = ranges(timers, from.at, to.at)
    say('wait', `${seconds(covered(inFlight))} child in flight, ${seconds(covered(timerRanges) - overlap(timerRanges, inFlight))} only a timer`, label)
    const tally = (entries) => {
      const groups = new Map()
      for (const e of entries) groups.set(e.label, [...(groups.get(e.label) ?? []), e])
      return [...groups].map(([name, list]) => ({ name, count: list.length, ms: covered(ranges(list, from.at, to.at)) })).sort((a, b) => b.ms - a.ms)
    }
    const inside = (e) => e.start < to.at && (e.end ?? to.at) > from.at
    const started = tally(children.filter(inside))
    if (started.length) say('children', started.slice(0, 8).map((c) => `${c.name} ${c.count}x ${seconds(c.ms)}`).join(', '), label)
    const fired = tally(timers.filter(inside))
    if (fired.length) say('timers', fired.slice(0, 6).map((c) => `${c.name} ${c.count}x ${seconds(c.ms)}`).join(', '), label)
  }

  /*
   * The lengths children's shell sleeps ASKED for: a service's `sleep 120` or the fake's
   * watchdog is killed long before, so a long one is not time spent. Taken by renaming the
   * log, so a sleep starting meanwhile goes in the next stretch rather than being lost.
   */
  const suiteSleeps = new Map()
  function sayCounts (counts, label) {
    if (!counts.size) return
    const total = ([v, n]) => Number.parseFloat(v) * n
    const rows = [...counts].sort((a, b) => total(b) - total(a)).slice(0, 8)
    say('sleeps', `requested ${rows.map(([v, n]) => `${v} s ${n}x`).join(', ')}`, label)
  }
  function sleeps (label) {
    if (!sleepFile) return
    const taken = `${sleepFile}.taken`
    let text = ''
    try { renameSync(sleepFile, taken); text = readFileSync(taken, 'utf8') } catch { /* none yet */ }
    const counts = new Map()
    for (const value of text.split('\n').filter(Boolean)) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
      suiteSleeps.set(value, (suiteSleeps.get(value) ?? 0) + 1)
    }
    sayCounts(counts, label)
  }

  let session = null
  async function startProfile () {
    if (!detail) return
    session = new Session()
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: 5000 })
    await session.post('Profiler.start')
  }
  async function endProfile (label) {
    if (!session) return
    const { profile } = await session.post('Profiler.stop')
    session.disconnect()
    session = null
    const self = new Map()
    const site = new Map(profile.nodes.map((n) => {
      const { functionName, url, lineNumber } = n.callFrame
      return [n.id, `${functionName || '(anonymous)'} ${url ? `${path.basename(url)}:${lineNumber + 1}` : ''}`.trim()]
    }))
    profile.samples.forEach((id, i) => { const name = site.get(id); self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000) })
    const top = [...self].filter(([name]) => name !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, 25)
    say('profile', top.map(([name, ms]) => `${name} ${seconds(ms)}`).join(', '), label)
  }

  /** What a suite's stretches of time are called, as they happen. */
  function sectionClock (file) {
    let section = BEFORE
    let mark = cpuMark()
    const started = mark
    const close = (label) => {
      // A measuring run owes every section its figures; a replayed section took no time here.
      const owed = sequential && label !== BEFORE && label !== AFTER
      if (owed || performance.now() - mark.at >= 50) line(mark, label)
      sleeps(label)
      mark = cpuMark()
    }
    return {
      section (name) { close(section); section = name },
      overlapBegin () { close(section); section = AFTER },
      overlapEnd (count) { const label = `${count} sections overlapping, as one group`; close(label) },
      afterSections () { close(section); section = AFTER },
      async finish () {
        close(section)
        line(started, `suite ${file}`)
        sayCounts(suiteSleeps, `suite ${file}`)
        suiteSleeps.clear()
        await endProfile(`suite ${file}`).catch((error) => print(`    no profile: ${error.message}`))
      }
    }
  }

  return {
    cpuMark,
    line,
    sleeps,
    sectionClock,
    startProfile,
    endProfile,
    cleanup () {
      ChildProcess.prototype.spawn = originalSpawn
      globalThis.setTimeout = realTimeout
      process.env.PATH = originalPath
      measuring.sequential = wasSequential
      if (shimDir) rmSync(shimDir, { recursive: true, force: true })
    }
  }
}
