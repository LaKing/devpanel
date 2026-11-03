import fs from 'node:fs/promises'
import path from 'node:path'
import { h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { JSDOM } from 'jsdom'
import { markdownNodes } from '../src/markdown.js'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'Markdown — formatted responses, exact raw text, and inert unsafe content'
const source = `# Closing report

The **fix** is *ready*, with ~~old behaviour~~ removed and \`inline code\`.

- First item
  - Nested item
- Second item

3. Third
4. Fourth

> Reviewed against the acceptance criteria.

| Criterion | Result |
| :--- | ---: |
| AC1 | Passed |

\`\`\`js
const example = '<script>alert(1)</script>';
\`\`\`

[Documentation](https://example.com/docs) and [unsafe](javascript:alert(1)).

<script>window.markdownExecuted = true</script>
<img src=x onerror="window.markdownExecuted = true">

![Tracking image](https://example.com/tracker.png)
`

export default async function (t) {
  const html = await renderToString(h('div', markdownNodes(source)))
  const dom = new JSDOM(html, { runScripts: 'dangerously' })
  const doc = dom.window.document
  t.eq('heading rendered', doc.querySelector('h1')?.textContent, 'Closing report')
  t.eq('bold rendered', doc.querySelector('strong')?.textContent, 'fix')
  t.eq('italic rendered', doc.querySelector('em')?.textContent, 'ready')
  t.eq('strikethrough rendered', doc.querySelector('s')?.textContent, 'old behaviour')
  t.eq('nested lists rendered', doc.querySelectorAll('ul ul li').length, 1)
  t.eq('ordered list start retained', doc.querySelector('ol')?.start, 3)
  t.ok('blockquote rendered', Boolean(doc.querySelector('blockquote')))
  t.eq('table rendered', doc.querySelectorAll('table tbody tr').length, 1)
  t.eq('table alignment retained', doc.querySelectorAll('th')[1]?.style.textAlign, 'right')
  t.eq('code remains literal', doc.querySelector('pre code')?.textContent, "const example = '<script>alert(1)</script>';\n")
  t.eq('safe link retained', doc.querySelector('a')?.href, 'https://example.com/docs')
  t.eq('link protects opener and referrer', doc.querySelector('a')?.rel, 'noopener noreferrer')
  t.eq('embedded content creates no active elements', doc.querySelectorAll('script,img,iframe,svg,style,form').length, 0)
  t.eq('script did not execute', dom.window.markdownExecuted, undefined)
  t.ok('source HTML remains visible', doc.body.textContent.includes('<script>window.markdownExecuted'))
  t.ok('image alt text retained', doc.body.textContent.includes('Tracking image'))
  dom.window.close()
  for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,hello', 'vbscript:alert(1)', 'file:///etc/passwd', '//example.com/tracker', '/api/projects', '/projects/../x', '/projects/p/i?x=1', '/projects/p/i/j', '/projects//i']) {
    const html = await renderToString(h('div', markdownNodes(`[link](${target})`)))
    const doc = new JSDOM(html)
    t.eq(`unsafe or unresolved target stays unlinked: ${target}`, doc.window.document.querySelectorAll('a').length, 0)
    doc.window.close()
  }

  for (const target of ['/projects/d250.hu-project/2026-01-01-issue', '/projects/p/i?run=2026-01-01T00-00-00-000Z-abc']) {
    const doc = new JSDOM(await renderToString(h('div', markdownNodes(`[link](${target})`))))
    const link = doc.window.document.querySelector('a')
    t.eq(`a panel page links: ${target}`, link?.getAttribute('href'), target)
    t.eq('in this tab, which keeps the operator token', link?.getAttribute('target'), null)
    doc.window.close()
  }

  t.section('the built browser renders attachments and response bodies')
  const stage = await startStage()
  const issue = await stage.createIssue('Markdown view')
  const root = `/api/projects/${stage.project}/issues/${issue.id}`
  const step = await stage.request(`${root}/steps`, { method: 'POST', body: JSON.stringify({ name: 'Markdown note', text: source }) })
  const started = await stage.request(`${root}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
  const deadline = Date.now() + 20000
  let run
  do {
    run = await stage.run(issue.id, started.body.runId)
    if (run.status === 'completed') break
    if (Date.now() > deadline) throw new Error(`scripted run did not complete: ${run.status}`)
    await new Promise((r) => setTimeout(r, 80))
  } while (true)
  // Populate a persisted scratch response with the rendering fixture.
  const last = run.timeline.at(-1)
  const issueData = (await stage.request(root)).body
  const folder = issueData.steps.find((s) => s.number === last.number)
  await fs.writeFile(path.join(stage.issuesDir, stage.project, issue.id, folder.id, 'response.md'), source)
  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    await browser.clickWhen(() => browser.all('.turn').find((el) => el.querySelector('.turn__number')?.textContent === last.number))
    await browser.until(() => browser.all('.detail [role="tab"]').length === 4)
    t.eq('step tabs have the requested order', browser.all('.detail [role="tab"]').map((el) => el.textContent.trim()), ['Runtime log', 'Prompt', 'Response', 'Output'])
    t.eq('the runtime log is selected initially', browser.all('.detail [role="tab"][aria-selected="true"]')[0].textContent.trim(), 'Runtime log')
    await browser.click(browser.find('.detail [role="tab"]', 'Response'))
    await browser.until(() => browser.all('.detail .v-window-item--active .markdown-content h1')[0]?.textContent === 'Closing report')
    t.eq('agent response has a formatted heading', browser.all('.detail .v-window-item--active .markdown-content h1').length, 1)
    t.eq('agent response has a formatted table', browser.all('.detail .v-window-item--active .markdown-content table').length, 1)
    t.eq('agent HTML stays inert in the app', browser.window.markdownExecuted, undefined)
    await browser.click(browser.find('.detail .v-window-item--active button', 'Raw text'))
    await browser.until(() => browser.all('.detail .v-window-item--active .markdown-raw').length === 1)
    t.eq('raw response is exact', browser.all('.detail .v-window-item--active .markdown-raw')[0].textContent, source)
    await browser.click(browser.find('.detail .v-window-item--active button', 'Formatted'))
    await browser.until(() => browser.all('.detail .v-window-item--active .markdown-content h1').length === 1)
    t.ok('formatted view can be restored', browser.all('.detail .v-window-item--active .markdown-content strong').length > 0)
    await browser.click(browser.find('.detail [role="tab"]', 'Prompt'))
    await browser.until(() => browser.all('.detail .v-window-item--active .markdown-content').some((el) => el.textContent.includes('coordinator')))
    // The engine's appended sections ("## Context supplied by the engine",
    // "### issue", …) render as headings when the prompt is formatted.
    t.ok('prompts also offer formatting', browser.all('.detail .v-window-item--active .markdown-content h2, .detail .v-window-item--active .markdown-content h3').length > 0)
    // An implementation turn renders from its template; the coordinator's handoff
    // reaches it as supplied context, so the Prompt tab must carry that text.
    const handedOff = run.timeline.find((turn) => turn.stepId === 'implement')
    const handoffText = 'Work on brief-implement (round 0)'
    await browser.clickWhen(() => browser.all('.turn').find((el) => el.querySelector('.turn__number')?.textContent === handedOff.number), { label: 'the implement turn' })
    await browser.until(() => browser.all('.detail .v-window-item--active .markdown-content').some((el) => el.textContent.includes(handoffText)), { label: 'the handoff inside Prompt' })
    t.eq('handed-off turns still have exactly four tabs', browser.all('.detail [role="tab"]').map((el) => el.textContent.trim()), ['Runtime log', 'Prompt', 'Response', 'Output'])
    t.ok('handoff is preserved inside Prompt', browser.all('.detail .v-window-item--active .markdown-content').some((el) => el.textContent.includes(handoffText)))
    await browser.clickWhen(() => browser.all('.head__folder-toggle')[0], { label: 'the Issue folder toggle' })
    await browser.clickWhen(() => browser.all('.material__row').find((el) => el.textContent.toLowerCase().includes('markdown note')))
    await browser.until(() => browser.all('.file .markdown-content h1').length > 0)
    t.ok('Markdown attachment formatted', browser.all('.file .markdown-content table').length > 0)
    await browser.click(browser.find('.file button', 'Raw text'))
    await browser.until(() => browser.all('.file .markdown-raw').length > 0)
    const saved = await fs.readFile(path.join(stage.issuesDir, stage.project, issue.id, step.body.id, 'note.md'), 'utf8')
    t.eq('raw attachment is exact', browser.all('.file .markdown-raw')[0].textContent, saved)
    t.eq('no embedded image requests or script elements', browser.all('.markdown-view img,.markdown-view script').length, 0)
    t.eq('no browser errors', browser.problems, [])
  } finally { browser.close() }
}
