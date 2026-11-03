import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * The spending ledger: append-only, replayed, never summarised in place.
 *
 * A standing supervisor cannot be bounded by a lifetime fuse — one that burns
 * out disables the whole plane, including for projects it has never touched. It
 * is bounded by windows instead: so many starts and so much money per day and
 * per month. That only works if the accounting survives a crash, a restart and a
 * New session, and if it is honest about what it does not know.
 *
 * Four properties this file exists to hold:
 *
 *  - **Append-only.** Every fact is a line. Nothing is rewritten, so a crash can
 *    lose the last line but never corrupt an earlier one, and the file is its own
 *    audit trail. State is derived by replay; there is no second copy to disagree.
 *  - **Outstanding means spent.** A reservation with no settlement counts in
 *    full against its window. A crash between reserving and spending therefore
 *    fails CLOSED: the money is treated as gone until something says otherwise.
 *  - **Unknown is never averaged.** A run with no configured cost ceiling does
 *    not get a guess from historical means — it consumes one of an explicit
 *    allowance of unpriced runs, which is a different resource with its own
 *    limit. A mean is a statement about runs that already happened; admission is
 *    a statement about one that has not. An ESTIMATE is not that: it is one call's
 *    own tokens times a sourced price, kept apart from reported cost on its line
 *    (`estimated`, `estimatedUsdMicros`) and counted in the windows, because
 *    leaving known token spending out would keep them blind to it.
 *  - **Overage is recorded, not absorbed.** When the settled cost exceeds what
 *    was reserved, the difference is written down as an overage. The window then
 *    holds what was actually spent, which may be more than its limit — and the
 *    honest consequence is that the window admits nothing further.
 */

const KINDS = ['reserve', 'settle', 'release', 'wake']
const SUBJECTS = ['run-start', 'model-call', 'decision']

/** UTC unless an organisation timezone is configured; recorded, never assumed. */
export const DEFAULT_TIMEZONE = 'UTC'

export function windowsFor (at, timezone = DEFAULT_TIMEZONE) {
  if (timezone !== 'UTC') throw new Error(`unsupported ledger timezone "${timezone}": only UTC windows are implemented`)
  const iso = new Date(at).toISOString()
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) }
}

/*
 * Money is integer micro-USD everywhere it is stored, compared or summed.
 *
 * Floating point rounded at every step accumulates a drift that a ceiling then
 * decides on: $0.1 + $0.2 > $0.3 is true in binary, and a window would refuse a
 * run it had the money for — or, worse, admit one it did not. Dollars exist only
 * at the edges: an operator writes them in the policy, a reader sees them in a
 * summary, and in between there is nothing to round.
 */
const MICROS = 1_000_000
export const toMicros = (usd) => {
  if (usd == null) return null
  if (!Number.isFinite(usd)) return null
  return Math.round(usd * MICROS)
}
export const toUsd = (micros) => (micros ?? 0) / MICROS

const emptyWindow = () => ({
  starts: 0, modelCalls: 0, decisions: 0,
  // What the window is committed to: settled spending plus everything reserved
  // and not yet accounted for. Micros are authoritative; the USD mirrors beside
  // them are for reading, never for deciding.
  settledUsdMicros: 0, reservedUsdMicros: 0, overageUsdMicros: 0,
  // Unpriced work is counted BY SUBJECT. A call whose price nobody knows must not
  // consume a run's allowance: the two are bounded separately, or one silently
  // exhausts the other while remaining unbounded itself.
  unpricedRuns: 0, unpricedCalls: 0, outstanding: 0,
  // Of the model calls settled: estimated (their money is inside settledUsdMicros,
  // said apart here) and unknown (no money anywhere, which is not zero).
  estimatedUsdMicros: 0, estimatedCalls: 0, unknownCalls: 0
})

/**
 * @param file      the .jsonl to append to and replay from
 * @param timezone  window boundaries; only UTC is implemented, and a different
 *                  value is refused rather than silently treated as UTC
 */
export function createLedger ({ file, clock = { now: () => Date.now(), iso: () => new Date().toISOString() }, timezone = DEFAULT_TIMEZONE }) {
  /** Reservations by id, in the order they were made. The replay's only state. */
  let reservations = new Map()
  /** Wakes are their own record: an event chain is not a reservation. */
  let wakes = new Map()
  let lines = 0
  let recovered = null
  let loaded = false
  // Appends are serialised in-process: two concurrent writes could interleave a
  // partial line, which is the one way an append-only file can lose an old fact.
  let writing = Promise.resolve()

  const apply = (entry) => {
    if (entry.kind === 'reserve') {
      reservations.set(entry.id, { ...entry, settled: null, released: null })
    } else if (entry.kind === 'settle') {
      const held = reservations.get(entry.id)
      if (held) held.settled = entry
    } else if (entry.kind === 'release') {
      const held = reservations.get(entry.id)
      if (held) held.released = entry
    } else if (entry.kind === 'wake') {
      wakes.set(entry.id, entry)
    }
  }

  async function load () {
    reservations = new Map()
    wakes = new Map()
    lines = 0
    recovered = null
    let text = ''
    try { text = await fs.readFile(file, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
      loaded = true
      return { entries: 0, recovered: null }
    }
    // A crash can leave only the final line half-written: appends are serialised
    // and newline-terminated, so a torn write is always the unterminated tail.
    // That tail is dropped and the file truncated to the last complete line —
    // recorded, because silently losing a reservation is exactly the failure
    // this ledger exists to prevent. A TERMINATED line that does not parse is
    // not a torn write but damage; truncating there would erase every later
    // reservation and fail open, so the ledger refuses to load instead.
    const complete = text.lastIndexOf('\n') + 1
    const body = text.slice(0, complete)
    const tail = text.slice(complete)
    const parse = (line) => {
      try { const entry = JSON.parse(line); return KINDS.includes(entry?.kind) ? entry : null } catch { return null }
    }
    for (const [index, line] of body.split('\n').entries()) {
      if (!line) continue
      const entry = parse(line)
      if (!entry) throw new Error(`spending ledger ${file} line ${index + 1} is not a ledger entry; refusing to load (repair or move the file — later entries would otherwise be lost)`)
      apply(entry)
      lines++
    }
    if (tail) {
      const entry = parse(tail)
      if (entry) {
        // Complete but unterminated: keep it, and terminate it so the next
        // append does not join it into one unparseable line.
        apply(entry)
        lines++
        await fs.appendFile(file, '\n')
      } else {
        await fs.truncate(file, complete)
        recovered = { truncatedBytes: Buffer.byteLength(tail), at: clock.iso(), note: 'an incomplete final line was dropped; every earlier entry is intact' }
      }
    }
    loaded = true
    return { entries: lines, recovered }
  }

  const append = (entry) => {
    const line = JSON.stringify(entry) + '\n'
    const write = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, line)
      apply(entry)
      lines++
    })
    writing = write.catch(() => {})
    return write.then(() => entry)
  }

  const assertLoaded = () => { if (!loaded) throw new Error('ledger.load() must run before it is read or written') }

  return {
    file,
    timezone,
    load,
    get recovered () { return recovered },
    get entryCount () { return lines },

    /**
     * Commit a window to a cost before it is incurred.
     *
     * `maxCostUsd` must be an explicitly configured ceiling — a playbook budget,
     * an operator's cap. Absent one, the reservation is `unpriced` and draws on
     * the unpriced allowance instead of on money. It is never estimated from
     * what similar runs have cost.
     */
    async reserve ({ id, subject, at = clock.now(), maxCostUsd = null, meta = {} }) {
      assertLoaded()
      if (!SUBJECTS.includes(subject)) throw new Error(`unknown ledger subject "${subject}"`)
      if (!id) throw new Error('a reservation needs an id')
      if (reservations.has(id)) throw new Error(`reservation ${id} already exists; ids are the idempotency key`)
      if (maxCostUsd != null && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error('maxCostUsd must be a positive number when given')
      // An advisory decision has a published price and a configured per-call
      // ceiling. It has no unpriced allowance to draw on, so it may not be unpriced.
      if (subject === 'decision' && maxCostUsd == null) throw new Error('a decision reservation needs its per-call maxCostUsd')
      return append({
        kind: 'reserve', id, subject, at: new Date(at).toISOString(),
        ...windowsFor(at, timezone),
        reservedUsdMicros: toMicros(maxCostUsd) ?? 0,
        unpriced: maxCostUsd == null,
        meta
      })
    },

    /**
     * What it actually cost. An unknown settled cost stays unknown. An estimate
     * ({usd, ...how it was reached}, runtime/call-cost.mjs) is not a known cost:
     * `costUsdMicros` stays null, so nothing summing reported cost can mistake it.
     */
    async settle ({ id, costUsd = null, estimate = null, at = clock.now(), meta = {} }) {
      assertLoaded()
      const held = reservations.get(id)
      if (!held) throw new Error(`no reservation ${id} to settle`)
      if (held.settled) throw new Error(`reservation ${id} is already settled`)
      if (held.released) throw new Error(`reservation ${id} was released; it cannot also be settled`)
      const known = costUsd != null && Number.isFinite(costUsd)
      if (known && estimate) throw new Error(`reservation ${id} cannot settle both a known cost and an estimate`)
      const estimated = estimate && Number.isFinite(estimate.usd) ? estimate : null
      const costUsdMicros = known ? toMicros(costUsd) : null
      // An overage is spending BEYOND a reservation, which only exists where a
      // reservation held money. An unpriced subject — a model call, whose price
      // is known only afterwards — reserved none on purpose, so its whole cost
      // would otherwise read as overage and close windows that were never
      // exceeded. What it cost is cost; there was nothing to exceed.
      const overageUsdMicros = known && !held.unpriced ? Math.max(0, costUsdMicros - held.reservedUsdMicros) : 0
      return append({
        kind: 'settle', id, at: new Date(at).toISOString(),
        costUsdMicros, costKnown: known, overageUsdMicros,
        ...(estimated ? (({ usd, ...detail }) => ({ estimated: true, estimatedUsdMicros: toMicros(usd), estimate: detail }))(estimated) : {}),
        meta
      })
    },

    /** It never happened: the reservation goes back, in full. */
    async release ({ id, reason, at = clock.now() }) {
      assertLoaded()
      const held = reservations.get(id)
      if (!held) throw new Error(`no reservation ${id} to release`)
      if (held.settled) throw new Error(`reservation ${id} is settled; a spend cannot be released`)
      if (held.released) return held.released
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('releasing a reservation needs a reason')
      return append({ kind: 'release', id, at: new Date(at).toISOString(), reason: reason.trim() })
    },

    /** Reservations that are neither settled nor released — still committed. */
    outstanding () {
      assertLoaded()
      return [...reservations.values()].filter((r) => !r.settled && !r.released)
    },

    /**
     * What each window holds right now.
     *
     * A settled reservation contributes what it cost; an outstanding one
     * contributes what it reserved. A call settled at an estimate contributes that
     * estimate, also said apart as `estimatedUsdMicros`; a reservation never does.
     */
    usage (at = clock.now()) {
      assertLoaded()
      const here = windowsFor(at, timezone)
      const day = emptyWindow()
      const month = emptyWindow()
      for (const held of reservations.values()) {
        if (held.released) continue
        for (const [key, into] of [[here.day, day], [here.month, month]]) {
          const mine = key.length === 10 ? held.day === key : held.month === key
          if (!mine) continue
          if (held.subject === 'run-start') into.starts++
          if (held.subject === 'model-call') into.modelCalls++
          if (held.subject === 'decision') into.decisions++
          // An unpriced reservation counts against ITS OWN subject's allowance,
          // whether it has settled or not: what makes it unpriced is that no
          // ceiling was ever configured for it, which a settlement does not undo.
          const unpricedInto = held.subject === 'model-call' ? 'unpricedCalls' : 'unpricedRuns'
          if (held.settled) {
            if (held.settled.costKnown) into.settledUsdMicros += held.settled.costUsdMicros
            else if (held.settled.estimated) {
              into.settledUsdMicros += held.settled.estimatedUsdMicros
              into.estimatedUsdMicros += held.settled.estimatedUsdMicros
              if (held.subject === 'model-call') into.estimatedCalls++
            } else if (held.subject === 'model-call') into.unknownCalls++
            if (held.unpriced) into[unpricedInto]++
            into.overageUsdMicros += held.settled.overageUsdMicros ?? 0
          } else {
            into.outstanding++
            if (held.unpriced) into[unpricedInto]++
            else into.reservedUsdMicros += held.reservedUsdMicros
          }
        }
      }
      for (const w of [day, month]) {
        w.committedUsdMicros = w.settledUsdMicros + w.reservedUsdMicros
        // Dollars for reading. Every decision above was taken in integers.
        w.settledUsd = toUsd(w.settledUsdMicros)
        w.reservedUsd = toUsd(w.reservedUsdMicros)
        w.overageUsd = toUsd(w.overageUsdMicros)
        w.committedUsd = toUsd(w.committedUsdMicros)
        w.estimatedUsd = toUsd(w.estimatedUsdMicros)
      }
      return { at: new Date(at).toISOString(), timezone, windows: here, day, month }
    },

    /**
     * A wake is one durable event-processing chain, and its call count is on
     * disk: a restart mid-chain resumes the same wake rather than handing the
     * supervisor a fresh allowance by losing count.
     */
    async openWake ({ id, at = clock.now(), reason = null }) {
      assertLoaded()
      if (wakes.has(id)) return { id, calls: this.wakeCalls(id), resumed: true }
      await append({ kind: 'wake', id, at: new Date(at).toISOString(), reason, ...windowsFor(at, timezone) })
      return { id, calls: 0, resumed: false }
    },

    /** Calls made in this wake, counted from the ledger rather than from memory. */
    wakeCalls (id) {
      assertLoaded()
      return [...reservations.values()].filter((r) => r.subject === 'model-call' && r.meta?.wake === id).length
    }
  }
}
