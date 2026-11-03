import MarkdownIt from 'markdown-it'
import { h } from 'vue'

// Parse Markdown, then construct Vue nodes from a fixed vocabulary. Source HTML
// and code are text; no parser-generated HTML is inserted into the document.
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false })
// Agent text is written line by line and means its line breaks; this one keeps them.
const lineParser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true })
const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'])

// A page of this panel, as a note written by the engine names one: the server has
// no public address to make it absolute. It opens in this tab, which keeps the
// operator token (sessionStorage); a new tab would ask for it again.
const PANEL_LINK = /^\/projects\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(\?run=[A-Za-z0-9_-]+)?$/

function safeLink (href) {
  if (!href || !parser.validateLink(href)) return null
  if (PANEL_LINK.test(href)) return href
  if (/^#[^\s]*$/.test(href)) return href
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol) ? href : null } catch { return null }
}

function nodes (tokens) {
  const root = { children: [] }
  const stack = [root]
  const append = (node) => stack.at(-1).children.push(node)
  for (const token of tokens) {
    if (token.nesting === 1) {
      let tag = token.hidden || !tags.has(token.tag) ? null : token.tag
      const props = {}
      if (tag === 'a') {
        const href = safeLink(token.attrGet('href'))
        if (href && PANEL_LINK.test(href)) Object.assign(props, { href, title: token.attrGet('title') || undefined })
        else if (href) Object.assign(props, { href, title: token.attrGet('title') || undefined, target: '_blank', rel: 'noopener noreferrer' })
        else tag = 'span'
      }
      if (tag === 'ol' && token.attrGet('start')) props.start = Number(token.attrGet('start'))
      if (tag === 'th' || tag === 'td') {
        const align = /^text-align:(left|center|right)$/.exec(token.attrGet('style') ?? '')
        if (align) props.style = { textAlign: align[1] }
      }
      stack.push({ tag, props, children: [] })
    } else if (token.nesting === -1) {
      const frame = stack.pop()
      if (!frame.tag) stack.at(-1).children.push(...frame.children)
      else {
        const element = h(frame.tag, frame.props, frame.children)
        append(frame.tag === 'table' ? h('div', { class: 'markdown-table', tabindex: 0, role: 'region', 'aria-label': 'Markdown table' }, [element]) : element)
      }
    } else if (token.type === 'inline') {
      stack.at(-1).children.push(...nodes(token.children ?? []))
    } else if (token.type === 'fence' || token.type === 'code_block') {
      append(h('pre', { tabindex: 0 }, [h('code', token.content)]))
    } else if (token.type === 'code_inline') append(h('code', token.content))
    else if (token.type === 'hardbreak') append(h('br'))
    else if (token.type === 'softbreak') append('\n')
    else if (token.type === 'hr') append(h('hr'))
    // Images stay descriptive text: opening a response makes no remote requests.
    else if (token.type === 'image') append(h('span', { class: 'markdown-image' }, `[Image: ${token.content || 'untitled'}]`))
    else append(token.content)
  }
  return root.children
}

export function markdownNodes (source, { breaks = false } = {}) { return nodes((breaks ? lineParser : parser).parse(source ?? '', {})) }
