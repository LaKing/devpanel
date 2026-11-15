import fs from 'node:fs/promises'
import path from 'node:path'
import { appendDurable, writeAtomic } from './runtime/persistence.mjs'

/*
 * The top-level supervisor's chat, beside its state and never inside it: issues/.supervisor/<state.chatFile>
 * (chat.jsonl, or chat-<time>.jsonl after a New session), one message per line, appended only. A chat of a
 * few megabytes inside state.json was serialised at every save and cloned for every reader of the state, which
 * made the panel's process burn half a core while the supervisor worked. The whole chat stays in memory (the
 * model's history and the mission are read from it); what readers are given is bounded: the latest messages,
 * each in a bounded form (bounded()), older ones a page at a time, one message whole only on request.
 *
 * Nothing a reading does grows with the chat: each message's size and bounded form are worked out once, when it
 * is added (appended, loaded, migrated) or changed, never at a reading, and the usage totals are kept as messages
 * come, so a reading touches only the messages it returns.
 *
 * Writes keep the order of memory: flush() runs one at a time, and lines a failed write leaves are written again
 * first, before anything newer, so a restart reads every message and amendment in the order they were made.
 *
 * A message changed after it was written (a reply's protocol verdict and its parsed text) is an amendment
 * line, {amend: id, set}, folded in at load. A torn final line is dropped and reported, as the ledger does. A
 * message line seen twice (an append whose bytes reached the file but whose fsync failed, written again) is
 * read once, at its first place; an amendment written again lands before the newer ones, so the newest wins.
 */
export const CHAT_FILE = 'chat.jsonl'
const FILE_NAME = /^chat(-[A-Za-z0-9_-]+)?\.jsonl$/
/** A message whose line is longer than this (UTF-8 bytes) is shown bounded: long texts cut, large fields left out. */
export const ENTRY_LIMIT = 16_384
const TEXT_LIMIT = 8000
const FIELD_LIMIT = 2048
const TEXTS = ['text', 'rawResponse']
/** What GET /api/supervisor carries of the chat, and what one page of older messages may hold, in UTF-8 bytes on the wire. */
export const TAIL = { entries: 200, bytes: 262_144 }
export const PAGE = { entries: 500, bytes: 524_288 }
// What a page's JSON holds besides its messages ({"entries":[…],"from":…,"total":…}), counted against its limit.
const ENVELOPE = 64

/** The chat file a state names, or the default; anything else is never a path to follow. */
export const chatFileName = (name) => typeof name === 'string' && FILE_NAME.test(name) ? name : CHAT_FILE

const utf8 = (text) => Buffer.byteLength(text)

/** A reply's tokens as the panel's pages total them (src/format.js usageTokens). */
function usageTokens (usage) {
  if (!usage) return null
  if (Number.isFinite(usage.tokens)) return usage.tokens
  const parts = [usage.input_tokens, usage.output_tokens, usage.inputTokens, usage.outputTokens, usage.cacheCreationTokens, usage.cacheReadTokens].filter(Number.isFinite)
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null
}
// What one message adds to the totals: the pages' rule (usage) and the status bar's (briefUsage, tokens only).
function contribution (m) {
  if (m?.role !== 'assistant' || !m.usage) return null
  const usage = m.usage, durationMs = m.durationMs
  return { tokens: usageTokens(usage) ?? 0, briefTokens: Number(usage.tokens) || 0, durationMs: Number(durationMs) || 0, untimed: Number.isFinite(durationMs) ? 0 : 1 }
}

export function createChat ({ dir, file = CHAT_FILE }) {
  file = chatFileName(file)
  const target = path.join(dir, file)
  let entries = []
  // Per message, worked out once and dropped when it changes: its line's UTF-8 length, its bounded form and that form's length, its share of the totals.
  let sizes = new WeakMap(), shown = new WeakMap(), shares = new WeakMap()
  let pending = []
  let writing = Promise.resolve()
  let recovered = null
  // A write failed: its bytes may have reached the file without their newline, so the next one starts on a line of its own.
  let interrupted = false
  const totals = { tokens: 0, briefTokens: 0, durationMs: 0, untimed: 0 }
  const count = (entry, sign) => {
    const share = sign > 0 ? contribution(entry) : shares.get(entry)
    if (sign > 0) { if (share) shares.set(entry, share); else shares.delete(entry) } else shares.delete(entry)
    if (share) for (const key of Object.keys(totals)) totals[key] += sign * share[key]
  }
  const sizeOf = (entry) => {
    let size = sizes.get(entry)
    if (size === undefined) { size = utf8(JSON.stringify(entry)); sizes.set(entry, size) }
    return size
  }
  const byId = (id) => entries.findLast((e) => e.id === id)
  const add = (entry, size) => {
    identify(entry, entries.length)
    entries.push(entry)
    if (size !== undefined) sizes.set(entry, size)
    count(entry, 1)
    bounded(entry)
  }
  const forget = (entry) => { count(entry, -1); sizes.delete(entry); shown.delete(entry) }
  // A message from before ids: one that does not change, so the chat view can ask for it whole.
  const identify = (entry, index) => { if (typeof entry.id !== 'string') entry.id = `m-legacy-${index}` }

  /** A message as a reader is given it, with its UTF-8 length: whole when its line is short, else long texts cut and large fields left out, saying so. */
  function bounded (entry) {
    const cached = shown.get(entry)
    if (cached) return cached
    const bytes = sizeOf(entry)
    let out = entry
    if (bytes > ENTRY_LIMIT) {
      out = {}
      const fields = []
      for (const [key, value] of Object.entries(entry)) {
        if (TEXTS.includes(key) && typeof value === 'string') {
          out[key] = value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value
          if (value.length > TEXT_LIMIT) fields.push(key)
          continue
        }
        if (typeof value === 'string' ? value.length <= FIELD_LIMIT : (JSON.stringify(value) ?? '').length <= FIELD_LIMIT) { out[key] = value; continue }
        fields.push(key)
        // What the page names a tool message by.
        if (key === 'action' && value && typeof value === 'object') out.action = Object.fromEntries(['type', 'project', 'issueId', 'runId'].filter((k) => typeof value[k] === 'string').map((k) => [k, value[k].slice(0, 200)]))
      }
      out.truncated = { bytes, fields }
    }
    const result = { entry: out, bytes: out === entry ? bytes : utf8(JSON.stringify(out)) }
    shown.set(entry, result)
    return result
  }
  // Messages before `end`, newest last, bounded, as many as the limits allow (always at least one: a bounded message is far below either byte limit).
  function slice (end, { entries: maxEntries, bytes: maxBytes }) {
    const out = []
    let bytes = ENVELOPE, from = end
    while (from > 0 && out.length < maxEntries) {
      const { entry, bytes: size } = bounded(entries[from - 1])
      if (out.length && bytes + size + 1 > maxBytes) break
      bytes += size + 1
      out.push(entry)
      from--
    }
    return { entries: out.reverse(), from, total: entries.length }
  }
  function apply (record, size, seen) {
    if (record && typeof record.amend === 'string') {
      const entry = byId(record.amend)
      if (entry) { forget(entry); Object.assign(entry, record.set ?? {}); count(entry, 1); bounded(entry) }
      return
    }
    if (typeof record?.id === 'string') {
      if (seen.has(record.id)) return
      seen.add(record.id)
    }
    add(record, size)
  }

  return {
    file,
    get entries () { return entries },
    get total () { return entries.length },
    get recovered () { return recovered },
    async load () {
      let text
      try { text = await fs.readFile(target, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
      const seen = new Set()
      let start = 0, damaged = 0
      for (let end = text.indexOf('\n'); end !== -1; start = end + 1, end = text.indexOf('\n', start)) {
        const line = text.slice(start, end)
        if (!line) continue
        // A terminated line that does not parse is damage, not a torn write: it is skipped and counted, every other message kept.
        let record
        try { record = JSON.parse(line) } catch { damaged++; continue }
        apply(record, utf8(line), seen)
      }
      const tail = text.slice(start)
      if (tail) {
        let entry = null
        try { entry = JSON.parse(tail) } catch { /* torn */ }
        if (entry) { apply(entry, utf8(tail), seen); await fs.appendFile(target, '\n') } else {
          await fs.truncate(target, utf8(text.slice(0, start)))
          recovered = { truncatedBytes: utf8(tail), note: 'an incomplete final line was dropped; every earlier message is intact' }
        }
      }
      if (damaged) recovered = { ...(recovered ?? {}), damagedLines: damaged }
    },
    /** A new message: kept in memory now, written at the next save. */
    append (entry) {
      const line = JSON.stringify(entry)
      add(entry, utf8(line))
      pending.push(line)
    },
    /** A message changed after it was written: changed in memory, written as an amendment line. */
    amend (entry, set) {
      forget(entry)
      Object.assign(entry, set)
      count(entry, 1)
      bounded(entry)
      if (typeof entry.id === 'string') pending.push(JSON.stringify({ amend: entry.id, set }))
    },
    /** How many lines are not yet written. */
    get pending () { return pending.length },
    /**
     * Appends what is not yet written, one flush at a time: the lines are taken when this flush's turn comes, and a
     * failure puts them back in front of anything newer, so the next flush writes them first and order is kept.
     */
    flush () {
      const turn = writing.then(async () => {
        if (!pending.length) return
        const lines = pending
        pending = []
        try {
          await appendDurable(target, (interrupted ? '\n' : '') + lines.join('\n') + '\n')
          interrupted = false
        } catch (error) { interrupted = true; pending = [...lines, ...pending]; throw error }
      })
      writing = turn.catch(() => {})
      return turn
    },
    /** The whole chat written at once (a migration), replacing whatever the file held; a message from before ids gets one. */
    async rewrite (messages) {
      entries = []
      sizes = new WeakMap(); shown = new WeakMap(); shares = new WeakMap()
      for (const key of Object.keys(totals)) totals[key] = 0
      pending = []
      messages.forEach(identify)
      const lines = messages.map((e) => { const line = JSON.stringify(e); add(e, utf8(line)); return line + '\n' })
      await writeAtomic(target, lines.join(''))
    },
    entry: (id) => byId(id) ?? null,
    tail: () => slice(entries.length, TAIL),
    page ({ before, limit } = {}) {
      const end = Number.isSafeInteger(before) ? Math.max(0, Math.min(before, entries.length)) : entries.length
      const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, PAGE.entries) : PAGE.entries
      return slice(end, { entries: count, bytes: PAGE.bytes })
    },
    /** The session's model calls as the pages total them (src/format.js supervisorUsage), kept as messages come. */
    usage: () => ({ tokens: totals.tokens, durationMs: totals.durationMs, untimed: totals.untimed }),
    /** The same as the status bar has always totalled them (only a reply's own `tokens`). */
    briefUsage: () => ({ tokens: totals.briefTokens, durationMs: totals.durationMs, untimed: totals.untimed })
  }
}
