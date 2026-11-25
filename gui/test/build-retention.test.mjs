import fs from 'node:fs/promises'
import path from 'node:path'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'a production build keeps earlier builds\' chunks, so open tabs can still open pages'

/*
 * A tab opened before a rebuild fetches a lazily loaded page's chunk only when that page
 * is first opened. A build that empties dist/ deletes it, the SPA fallback answers with
 * index.html, and the drawer click does nothing until the page is refreshed. The fix is
 * vite.config.js `emptyOutDir: false`; this guards it, and the scratch build that relies
 * on passing --emptyOutDir itself now that the config no longer empties.
 */
export default async function (t) {
  const gui = path.join(CONFIG_ROOT, 'gui')
  const config = await fs.readFile(path.join(gui, 'vite.config.js'), 'utf8')
  const scratch = await fs.readFile(path.join(gui, 'tools', 'visual-in-scratch.sh'), 'utf8')

  t.ok('vite.config.js keeps earlier chunks (emptyOutDir: false)', /\bemptyOutDir:\s*false\b/.test(config))
  t.ok('vite.config.js never empties dist on a build (no emptyOutDir: true)', !/\bemptyOutDir:\s*true\b/.test(config))
  t.ok('the scratch build still empties its own outDir explicitly',
    /vite build\b[^\n]*--outDir "\$DEVPANEL_SCRATCH_DIR\/dist"[^\n]*--emptyOutDir\b/.test(scratch))
}
