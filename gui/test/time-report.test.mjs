import { ChildProcess, execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { overlappingSections, sideBySide } from './helpers.mjs'
import { installTimeReport, measuring } from './time-report.mjs'

export const name = 'time report — figures belong to the stretch that did the work, on known loads'

const exec = promisify(execFile)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const burn = () => exec('/bin/sh', ['-c', 'i=0; while [ "$i" -lt 60000 ]; do i=$((i+1)); done'])
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '').trim()

/** A suite's stretches against a report that prints into a list; `run` gets a t like the runner's. */
async function measured ({ sequential = false }, run) {
  const lines = []
  const report = installTimeReport({ detail: true, sequential, print: (text) => lines.push(plain(text)) })
  try {
    const clock = report.sectionClock('known-loads')
    const t = { section: clock.section, overlapBegin: clock.overlapBegin, overlapEnd: clock.overlapEnd, afterSections: clock.afterSections, ok () {}, eq () {}, skip () {} }
    await run(t)
    await clock.finish()
  } finally { report.cleanup() }
  const about = (label) => lines.filter((l) => l.includes(`— ${label}`))
  const figure = (label, kind) => about(label).find((l) => l.startsWith(`${kind}:`)) ?? ''
  const wall = (label) => Number.parseFloat(figure(label, 'time').slice('time: '.length))
  return { lines, about, figure, wall }
}

export default async function (t) {
  // A group, a section alone that sleeps, then one that only waits on nothing of the others'.
  const sections = (log = []) => [
    ['sleeping child', async () => { log.push('child starts'); await exec('sleep', ['0.4']); log.push('child ends') }],
    ['timer only', async () => { log.push('timer starts'); await wait(300); log.push('timer ends') }]
  ]
  const lone = ['alone', async () => { await exec('sleep', ['0.6']) }]
  const quiet = ['quiet', async () => { await wait(60) }]

  t.section('an overlapped group, then a section alone: each stretch has its own figures')
  {
    const log = []
    const m = await measured({}, async (t) => {
      await overlappingSections(t, sections(log))
      await overlappingSections(t, [lone])
      await overlappingSections(t, [quiet])
    })
    t.eq('the group really overlapped', log.slice(0, 2), ['child starts', 'timer starts'])
    const group = '2 sections overlapping, as one group'
    // Each upper bound is the sum of the two stretches: a stretch that took the other's time passes it.
    t.ok('the group has its time, and not the next section\'s', m.wall(group) >= 0.35 && m.wall(group) < 0.95, m.figure(group, 'time'))
    t.ok('its child, in flight', m.figure(group, 'children').includes('sleep 1x'), m.figure(group, 'children'))
    t.ok('its sleep', m.figure(group, 'sleeps').includes('requested 0.4 s 1x'), m.figure(group, 'sleeps'))
    t.ok('its timer', /1x 0\.\d s/.test(m.figure(group, 'timers')), m.figure(group, 'timers'))
    t.eq('no figures under either member\'s name', [m.about('sleeping child'), m.about('timer only')], [[], []])
    t.ok('the section alone has its time, and not the group\'s', m.wall('alone') >= 0.55 && m.wall('alone') < 0.95, m.figure('alone', 'time'))
    t.ok('its child', m.figure('alone', 'children').includes('sleep 1x'), m.figure('alone', 'children'))
    t.eq('and its sleep, none of the group\'s', m.figure('alone', 'sleeps').replace(/ — .*/, ''), 'sleeps: requested 0.6 s 1x')
    t.eq('the section after it has no child and no sleep of its', [m.figure('quiet', 'children'), m.figure('quiet', 'sleeps')], ['', ''])
    t.ok('but the timer it did run', /1x 0\.\d s/.test(m.figure('quiet', 'timers')), m.figure('quiet', 'timers'))
    t.ok('the suite\'s sleeps are the whole of them', m.figure('suite known-loads', 'sleeps').includes('0.4 s 1x') && m.figure('suite known-loads', 'sleeps').includes('0.6 s 1x'), m.figure('suite known-loads', 'sleeps'))
  }

  t.section('a measuring run: every section its own figures, one after another, and it says so')
  {
    const log = []
    const m = await measured({ sequential: true }, async (t) => {
      await overlappingSections(t, sections(log))
      await overlappingSections(t, [lone])
      await overlappingSections(t, [['burning', async () => { await burn() }]])
      await overlappingSections(t, [['nearly nothing', async () => {}]])
    })
    t.eq('they ran in turn', log, ['child starts', 'child ends', 'timer starts', 'timer ends'])
    t.ok('the sleeping section has its child and its sleep', m.figure('sleeping child', 'children').includes('sleep 1x') && m.figure('sleeping child', 'sleeps').includes('requested 0.4 s 1x'), m.about('sleeping child').join(' | '))
    t.ok('and no child CPU to speak of', /, 0\.[01] s child cpu/.test(m.figure('sleeping child', 'time')), m.figure('sleeping child', 'time'))
    t.ok('the timer\'s has only a timer', /0\.0 s child in flight, 0\.[3-9] s only a timer/.test(m.figure('timer only', 'wait')), m.figure('timer only', 'wait'))
    t.eq('and no child', m.figure('timer only', 'children'), '')
    t.ok('a section with next to nothing to measure still has its figures', m.figure('nearly nothing', 'time') !== '' && m.figure('nearly nothing', 'wait') !== '', m.lines.join(' | '))
    t.ok('the burning one has the child CPU', !/, 0\.0 s child cpu/.test(m.figure('burning', 'time')), m.figure('burning', 'time'))
    t.ok('every figure says which run it came from', m.lines.filter((l) => /^(time|wait|children|timers|sleeps|profile):/.test(l)).every((l) => l.endsWith('[sequential run]')), m.lines.join(' | '))
  }

  t.section('a normal run does not call itself a measuring run, and drives go side by side or in turn')
  {
    const log = []
    const task = (id) => async () => { log.push(`${id} starts`); await wait(20); log.push(`${id} ends`); return id }
    const m = await measured({}, async () => {
      t.eq('side by side', await sideBySide([task('a'), task('b')]), ['a', 'b'])
      t.eq('both began before either ended', log.slice(0, 2), ['a starts', 'b starts'])
    })
    t.ok('no line says sequential', !m.lines.some((l) => l.includes('[sequential run]')), m.lines.join(' | '))
    log.length = 0
    await measured({ sequential: true }, async () => { t.eq('in turn', await sideBySide([task('a'), task('b')]), ['a', 'b']) })
    t.eq('one finished before the next began', log, ['a starts', 'a ends', 'b starts', 'b ends'])
  }

  t.section('leaving: nothing of the report stays behind')
  {
    const [path, timeout, spawn] = [process.env.PATH, globalThis.setTimeout, ChildProcess.prototype.spawn]
    await measured({ sequential: true }, async () => { t.ok('PATH is its own while it runs', process.env.PATH !== path) })
    t.eq('the PATH is back', process.env.PATH, path)
    t.ok('and setTimeout', globalThis.setTimeout === timeout)
    t.ok('and spawn', ChildProcess.prototype.spawn === spawn)
    const outer = installTimeReport({ sequential: true, print () {} })
    const inner = installTimeReport({ sequential: false, print () {} })
    inner.cleanup()
    t.eq('and the mode it found', measuring.sequential, true)
    outer.cleanup()
  }
}
