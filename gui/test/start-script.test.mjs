import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_ROOT } from './helpers.mjs'

const exec = promisify(execFile)

export const name = 'start.sh starts a hand-started production panel with NODE_ENV=production'

export default async function (t) {
  const file = path.join(CONFIG_ROOT, 'gui', 'start.sh')
  const text = await fs.readFile(file, 'utf8')
  const branch = (label) => {
    const start = text.indexOf(`\n  ${label})`)
    return start < 0 ? '' : text.slice(start, text.indexOf('\n    ;;', start))
  }
  const prod = branch("prod|start|''")
  const dev = branch('dev')
  t.ok('the prod branch exports NODE_ENV=production right before it starts the server',
    /export NODE_ENV=production\s*\n\s*exec node server\/index\.js/.test(prod), prod)
  t.ok('after the build, which is left as it was', prod.indexOf('npm run build') >= 0 && prod.indexOf('npm run build') < prod.indexOf('NODE_ENV=production'))
  t.ok('the dev branch does not set it', dev.length > 0 && !dev.includes('NODE_ENV'))
  t.eq('the script is valid bash', await exec('bash', ['-n', file]).then(() => 0, (e) => e.code ?? 1), 0)
}
