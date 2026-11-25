/*
 * The live log, written as a terminal would show it.
 *
 * The runtimes run headless and print JSON events, not a screen; this turns
 * those events back into the lines a person would have seen in the CLI —
 * the command, the model's words, each tool call with a short excerpt of what
 * came back, and how it ended. Pure functions of the entries, so the output is
 * the same for a browser that watched live and one that opened later.
 *
 * `createRenderer()` is incremental: feed entries in sequence order, get back
 * the text to write. Raw mode writes stdout/stderr exactly as they arrived.
 */

import { formatHms as hms, formatMTokens as mtok } from './format.js'
import { markdownLines } from './terminal-markdown.js'

const ESC = '\x1b['
const paint = (code) => (text) => `${ESC}${code}m${text}${ESC}0m`
export const style = {
  dim: paint('2'),
  bold: paint('1'),
  italic: paint('3'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  grey: paint('90')
}

const NL = '\r\n'
const BULLET = '●'
const RESULT = '  └ '
const INDENT = '    '

/** Break one line at spaces so no piece is wider than `width`; a longer word is cut. */
export function wrapLine (line, width) {
  if (!width || width < 10 || line.length <= width) return [line]
  const out = []
  let rest = line
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width)
    if (cut < width * 0.5) cut = width
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^ /, '')
  }
  if (rest) out.push(rest)
  return out
}

/** At most `lines` lines of `text`, each at most `width` characters, with a count of what was left out. */
function excerpt (text, { lines = 4, width = 220 } = {}) {
  const all = String(text ?? '').replace(/\r/g, '').replace(/\t/g, '  ').split('\n')
  while (all.length && !all.at(-1).trim()) all.pop()
  const shown = all.slice(0, lines).map((l) => (l.length > width ? `${l.slice(0, width)}…` : l))
  return { shown, hidden: Math.max(0, all.length - shown.length) }
}

/** A tool result under its call: the first lines, dimmed, and how many more there were. */
function resultBlock (text, { error = false, cols = 0 } = {}) {
  const { shown, hidden } = excerpt(text, { width: cols > 20 ? cols - INDENT.length - 1 : 220 })
  if (!shown.length) return style.dim(`${RESULT}(no output)`) + NL
  const colour = error ? style.red : style.dim
  let out = shown.map((line, i) => colour(`${i === 0 ? RESULT : INDENT}${line}`)).join(NL) + NL
  if (hidden) out += style.grey(`${INDENT}… +${hidden} line${hidden === 1 ? '' : 's'}`) + NL
  return out
}

/** The model's words: its Markdown drawn for a terminal (terminal-markdown.js), under a bullet. */
function prose (text, cols = 0, bulletStyle = (s) => s) {
  const lines = markdownLines(text, cols > 20 ? cols - 3 : 0)
  if (!lines.length) return ''
  return lines.map((l, i) => (i === 0 ? `${bulletStyle(BULLET)} ${l}` : `  ${l}`)).join(NL) + NL
}

const oneLine = (text, width = 120) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > width ? `${t.slice(0, width)}…` : t
}

/** What a tool call was about, the way Claude Code titles it: Bash(npm test), Read(src/x.js). */
function toolTitle (name, input = {}) {
  const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? null
  return `${style.bold(name ?? 'tool')}(${oneLine(arg ?? JSON.stringify(input), 110)})`
}


const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`)

/** The command line the spawn entry recorded, as a shell prompt. */
function commandLine (entry) {
  let out = ''
  if (entry.cwd) out += style.grey(`# ${entry.cwd}`) + NL
  if (entry.command) {
    out += `${style.green('$')} ${style.bold(entry.command)} ${(entry.args ?? []).map(quote).join(' ')}` + NL
  }
  out += style.grey(entry.text ?? 'process started') + NL
  return out
}

/** One runtime event line as terminal text; '' to show nothing. */
export function formatEvent (event, { cols = 0 } = {}) {
  if (!event || typeof event !== 'object') return ''
  switch (event.type) {
    // ---------------------------------------------------------- Claude Code
    case 'system':
      if (event.subtype === 'init') {
        const bits = [event.model && `model ${event.model}`, event.session_id && `session ${event.session_id.slice(0, 8)}`,
          Array.isArray(event.tools) && `${event.tools.length} tool${event.tools.length === 1 ? '' : 's'}`, event.permissionMode && `mode ${event.permissionMode}`]
        return style.grey(`  ${bits.filter(Boolean).join(' · ')}`) + NL + NL
      }
      if (event.subtype === 'thinking_tokens') return ''
      if (event.subtype === 'permission_denied') return style.yellow(`  ✗ ${event.tool_name ?? 'tool'} denied: ${oneLine(event.message, 160)}`) + NL
      if (event.subtype === 'task_started') return style.grey(`  ↳ task: ${oneLine(event.description, 100)}`) + NL
      if (event.subtype === 'task_notification') return style.grey(`  ↳ task ${event.status ?? 'update'}: ${oneLine(event.summary, 100)}`) + NL
      return ''
    case 'assistant': {
      let out = ''
      for (const c of event.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) out += prose(c.text, cols) + NL
        else if (c.type === 'thinking') out += style.italic(style.grey(c.thinking?.trim() ? `✻ ${oneLine(c.thinking, 200)}` : '✻ Thinking…')) + NL
        else if (c.type === 'tool_use') out += `${style.green(BULLET)} ${toolTitle(c.name, c.input)}` + NL
      }
      return out
    }
    case 'user': {
      let out = ''
      for (const c of event.message?.content ?? []) {
        if (c.type !== 'tool_result') continue
        const body = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('')
        out += resultBlock(body, { error: c.is_error, cols }) + NL
      }
      return out
    }
    case 'result': {
      const ok = !event.is_error && event.subtype === 'success'
      const used = event.usage ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(event.usage[k]) || 0), 0) : null
      const bits = [event.num_turns != null && `${event.num_turns} turns`, hms(event.duration_ms), used != null && mtok(used)].filter(Boolean)
      return (ok ? style.green(`✓ ${event.subtype}`) : style.red(`✗ ${event.subtype ?? 'error'}`)) + style.grey(bits.length ? `  ${bits.join(' · ')}` : '') + NL
    }
    case 'rate_limit_event': {
      const info = event.rate_limit_info ?? {}
      return info.status && info.status !== 'allowed' ? style.yellow(`  ⚠ rate limit: ${info.status}${info.rateLimitType ? ` (${info.rateLimitType})` : ''}`) + NL : ''
    }
    // ----------------------------------------------------------------- Codex
    case 'thread.started':
      return style.grey(`  session ${String(event.thread_id ?? '').slice(0, 8)}`) + NL + NL
    case 'turn.started':
      return ''
    case 'turn.completed': {
      const u = event.usage ?? {}
      return style.green('✓ turn completed') + style.grey(`  ${mtok((Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0))}`) + NL
    }
    case 'turn.failed':
      return style.red(`✗ turn failed: ${oneLine(event.error?.message ?? JSON.stringify(event.error ?? {}), 300)}`) + NL
    case 'error':
      return style.red(`✗ ${oneLine(event.message ?? JSON.stringify(event), 300)}`) + NL
    case 'item.started':
    case 'item.completed':
    case 'item.updated': {
      const item = event.item ?? {}
      const done = event.type === 'item.completed'
      switch (item.type) {
        case 'agent_message': return done && item.text ? prose(item.text, cols) + NL : ''
        case 'reasoning': return done && item.text ? style.italic(style.grey(`✻ ${oneLine(item.text, 200)}`)) + NL : ''
        case 'command_execution': {
          const cmd = String(item.command ?? '').replace(/^\/bin\/(ba)?sh -lc /, '')
          if (!done) return `${style.green(BULLET)} ${style.bold('Shell')}(${oneLine(cmd.replace(/^['"]|['"]$/g, ''), 110)})` + NL
          const failed = item.exit_code != null && item.exit_code !== 0
          return resultBlock(item.aggregated_output || (failed ? `exit ${item.exit_code}` : ''), { error: failed, cols }) + NL
        }
        case 'file_change': {
          if (!done) return ''
          const paths = (item.changes ?? []).map((c) => `${c.kind ?? 'edit'} ${c.path}`)
          return `${style.green(BULLET)} ${style.bold('Edit')}(${oneLine(paths.join(', '), 110)})` + NL
        }
        case 'mcp_tool_call': return done ? '' : `${style.green(BULLET)} ${toolTitle(item.tool ?? item.server, item.arguments ?? {})}` + NL
        case 'web_search': return done ? '' : `${style.green(BULLET)} ${style.bold('Search')}(${oneLine(item.query, 110)})` + NL
        case 'todo_list': return ''
        case 'error': return style.yellow(`  ⚠ ${oneLine(item.message, 240)}`) + NL
        default: return ''
      }
    }
    default:
      return ''
  }
}

/**
 * An incremental renderer. `write(entry)` returns what to append to the
 * terminal for that entry; stdout lines are only formatted once complete.
 * A line that never ends is held only up to MAX_PARTIAL: past it, what is held
 * is written unformatted and dropped, so a newline-free stream cannot grow it.
 */
export const MAX_PARTIAL = 64 * 1024

/** The last `max` characters of `text`, cut at a line start when one is near (the plain-text terminal's bound). */
export function keepTail (text, max) {
  if (text.length <= max) return text
  const cut = text.length - max
  const nl = text.indexOf('\n', cut)
  return text.slice(nl >= 0 && nl - cut < 4096 ? nl + 1 : cut)
}
export function createRenderer ({ raw = false, cols = 0 } = {}) {
  let partial = ''
  const line = (text) => {
    const t = text.trim()
    if (!t) return ''
    if (t.startsWith('{')) {
      try { return formatEvent(JSON.parse(t), { cols }) } catch { /* not an event line */ }
    }
    return text + NL
  }
  return {
    write (entry) {
      if (!entry) return ''
      if (entry.kind === 'spawn') return commandLine(entry) + NL
      if (entry.kind === 'exit') {
        const ok = /completed/.test(entry.text ?? '')
        return NL + (ok ? style.grey : style.red)(`── ${entry.text} ──`) + NL
      }
      if (entry.kind === 'truncated') return style.yellow(`⚠ ${entry.text}`) + NL
      if (entry.kind === 'stderr') return style.red(String(entry.text).replace(/\r?\n/g, NL))
      if (entry.kind !== 'stdout') return style.grey(String(entry.text ?? '')) + NL
      if (raw) return String(entry.text).replace(/\r?\n/g, NL)
      partial += entry.text
      let out = ''
      let nl
      while ((nl = partial.indexOf('\n')) >= 0) {
        out += line(partial.slice(0, nl))
        partial = partial.slice(nl + 1)
      }
      if (partial.length > MAX_PARTIAL) {
        out += partial + NL + style.grey('(line continues)') + NL
        partial = ''
      }
      return out
    },
    /** How much of an unfinished line is held. */
    pendingBytes: () => partial.length
  }
}
