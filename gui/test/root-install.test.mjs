import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_ROOT } from './helpers.mjs'

const exec = promisify(execFile)

export const name = 'install.sh as root: what it will run and install is shown first, and refused when anyone but root and the checkout owner could change it'

/*
 * install.sh --service runs as "root" here through an `id` shim; nothing is
 * installed (install, systemctl, pgrep and getcap are shims too). Owners, groups
 * and modes a test user cannot set (root, gid 0, a sticky regular file, another
 * user) are reported through a `stat` shim that answers from a map for listed
 * paths and runs the real stat for the rest; getfacl reports an ACL only where
 * the case says so. Every folder above the temporary checkout is mapped as
 * root:root 755, so the outcome does not depend on where the suite runs.
 */
const realTool = (name) => ['/usr/bin', '/bin'].map((d) => path.join(d, name)).find((p) => existsSync(p))

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-root-install-')))
  const user = os.userInfo().username
  const bin = path.join(tmp, 'bin')
  const base = path.join(tmp, 'real')
  const checkout = path.join(base, 'checkout')
  const gui = path.join(checkout, 'gui')
  const helper = path.join(gui, 'tools', 'install-sandbox.sh')
  const template = path.join(gui, 'systemd', 'devpanel.service.in')
  // The staging parent the installer is told to use, and a TMPDIR anyone could write, which it must ignore.
  const stage = path.join(tmp, 'stage'), unsafeTmp = path.join(tmp, 'unsafe-tmp')
  const statMap = path.join(tmp, 'stat-map'), installRecord = path.join(tmp, 'install-calls'), marker = path.join(tmp, 'helper-ran')

  const shims = {
    id: ['#!/bin/bash', 'if [ "$1" = -u ]; then echo 0; else exec ' + realTool('id') + ' "$@"; fi'],
    install: ['#!/bin/bash', 'printf "%s\\n" "$*" >> "$RECORD_INSTALL"'],
    systemctl: ['#!/bin/bash', 'exit 0'],
    pgrep: ['#!/bin/bash', 'exit 1'],
    getcap: ['#!/bin/bash', 'exit 0'],
    getfacl: ['#!/bin/bash', 'p="${@: -1}"', 'if [ -n "$ACL_FAIL" ] && [ "$p" = "$ACL_FAIL" ]; then exit 1; fi', 'if [ -n "$ACL_PATH" ] && [ "$p" = "$ACL_PATH" ]; then echo "user:intruder:rw-"; fi', 'exit 0'],
    sha256sum: ['#!/bin/bash', 'if [ -n "$SHA_FAIL" ]; then exit 1; fi', 'exec ' + realTool('sha256sum') + ' "$@"'],
    stat: [
      '#!/bin/bash',
      'fmt=""; prev=""; for a in "$@"; do [ "$prev" = -c ] && fmt="$a"; prev="$a"; done',
      'p="${@: -1}"',
      'line="$(awk -F "\\t" -v p="$p" \'$1==p {print; exit}\' "$STAT_MAP")"',
      'if [ -n "$line" ]; then',
      '  IFS=$\'\\t\' read -r _ u g a <<< "$line"',
      '  out="${fmt//%U/$u}"; out="${out//%G/$g}"; out="${out//%a/$a}"',
      '  printf "%s\\n" "$out"; exit 0',
      'fi',
      'exec ' + realTool('stat') + ' "$@"'
    ]
  }
  await fs.mkdir(bin, { recursive: true })
  for (const [shim, lines] of Object.entries(shims)) await fs.writeFile(path.join(bin, shim), lines.join('\n') + '\n', { mode: 0o755 })

  for (const dir of [base, checkout, gui, path.join(gui, 'tools'), path.join(gui, 'systemd'), stage]) { await fs.mkdir(dir, { recursive: true }); await fs.chmod(dir, 0o755) }
  await fs.mkdir(unsafeTmp); await fs.chmod(unsafeTmp, 0o777)
  await fs.copyFile(path.join(CONFIG_ROOT, 'gui', 'install.sh'), path.join(gui, 'install.sh'))
  await fs.chmod(path.join(gui, 'install.sh'), 0o755)
  await fs.copyFile(path.join(CONFIG_ROOT, 'gui', 'systemd', 'devpanel.service.in'), template)
  await fs.writeFile(path.join(gui, 'systemd', 'run-devpanel-proc.mount'), '[Mount]\n')
  await fs.writeFile(path.join(gui, 'systemd', 'devpanel-sandbox.conf'), '[Unit]\n')
  await fs.writeFile(helper, '#!/bin/bash\necho HELPER-RAN\ntouch "$MARKER"\n')
  for (const f of [template, helper, path.join(gui, 'systemd', 'run-devpanel-proc.mount'), path.join(gui, 'systemd', 'devpanel-sandbox.conf')]) await fs.chmod(f, 0o644)
  const helperSha = crypto.createHash('sha256').update(await fs.readFile(helper)).digest('hex')

  // Every folder above the checkout: root-owned 755 unless a case says otherwise.
  const above = []
  for (let d = base; ; d = path.dirname(d)) { above.push(d); if (d === '/') break }
  const run = async ({ map = {}, acl = '', aclFail = '', shaFail = '', mode = '--service', entry = path.join(gui, 'install.sh') } = {}) => {
    const rows = { ...Object.fromEntries(above.map((d) => [d, ['root', 'root', '755']])), [stage]: ['root', 'root', '755'], ...map }
    await fs.writeFile(statMap, Object.entries(rows).map(([p, v]) => [p, ...v].join('\t')).join('\n') + '\n')
    await fs.rm(installRecord, { force: true }); await fs.rm(marker, { force: true })
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAT_MAP: statMap, ACL_PATH: acl, ACL_FAIL: aclFail, SHA_FAIL: shaFail, RECORD_INSTALL: installRecord, MARKER: marker,
      TMPDIR: unsafeTmp, DEVPANEL_INSTALL_STAGE_PARENT: stage }
    let code = 0, stdout = '', stderr = ''
    try { ({ stdout, stderr } = await exec('bash', [entry, mode], { env })) } catch (e) { code = e.code ?? 1; stdout = e.stdout ?? ''; stderr = e.stderr ?? '' }
    const installs = await fs.readFile(installRecord, 'utf8').catch(() => '')
    return { code, stdout, stderr, installs, helperRan: existsSync(marker) }
  }
  const refused = async (label, opts, reason) => {
    const r = await run(opts)
    t.ok(`refused: ${label}`, r.code !== 0 && /refusing to run as root/.test(r.stderr) && reason.test(r.stderr) && !r.helperRan && r.installs === '', `${r.code} ${r.stderr.trim().split('\n').at(-1)} helperRan=${r.helperRan} installs=${r.installs.trim()}`)
  }

  try {
    t.section('a safe checkout: shown first, then installed from a root-owned copy')
    {
      const r = await run()
      t.eq("it completes", r.code, 0, r.stderr + r.stdout.slice(-400))
      const ran = r.stdout.indexOf('HELPER-RAN')
      t.ok('the helper\'s sha256 and the rendered unit are printed before the helper runs',
        ran > 0 && r.stdout.indexOf(`sha256 of tools/install-sandbox.sh: ${helperSha}`) >= 0 && r.stdout.indexOf(`sha256 of tools/install-sandbox.sh: ${helperSha}`) < ran &&
        r.stdout.indexOf(`WorkingDirectory=${gui}`) >= 0 && r.stdout.indexOf(`WorkingDirectory=${gui}`) < ran, r.stdout)
      const call = r.installs.trim().split(' ')
      t.ok('the unit is installed from a copy outside the checkout', call[0] === '-m' && call[1] === '0644' && !call[2].startsWith(checkout) && call[3] === '/etc/systemd/system/devpanel.service', r.installs)
      t.ok('staged in the checked root-owned parent, not in the inherited TMPDIR anyone can write', call[2].startsWith(stage + '/devpanel-unit.') && !call[2].startsWith(unsafeTmp), r.installs)
      t.eq('the staging folder is removed afterwards', (await fs.readdir(stage)).length, 0)
      t.eq('nothing is rendered into the checkout', existsSync(path.join(gui, 'systemd', 'devpanel.service')), false)
    }

    t.section('anyone but root and the checkout owner could change an input: refused before anything runs')
    await fs.chmod(helper, 0o646)
    await refused('the helper is writable by others (646)', {}, /install-sandbox\.sh is writable by others/)
    await fs.chmod(helper, 0o644)
    await refused('the helper is writable by others with the sticky bit (1646): sticky protects folders only', { map: { [helper]: [user, user, '1646'] } }, /install-sandbox\.sh is writable by others/)
    await fs.chmod(path.join(gui, 'tools'), 0o757)
    await refused('a folder in the checkout is writable by others without the sticky bit (757)', {}, /tools is writable by others/)
    await fs.chmod(path.join(gui, 'tools'), 0o755)
    await fs.chmod(template, 0o664)
    await refused('the template is writable by the owner\'s own group (664)', {}, /devpanel\.service\.in is writable by its group/)
    await fs.chmod(template, 0o644)
    await refused('the template is writable by root\'s group (gid 0, 664)', { map: { [template]: [user, 'root', '664'] } }, /devpanel\.service\.in is writable by its group/)
    await fs.chmod(path.join(gui, 'systemd'), 0o775)
    await refused('a folder in the checkout is writable by its group (775)', {}, /systemd is writable by its group/)
    await fs.chmod(path.join(gui, 'systemd'), 0o755)
    await refused('a folder above the checkout is writable by others without the sticky bit (757)', { map: { [base]: ['root', 'root', '757'] } }, /real is writable by others/)
    await refused('a folder above the checkout is writable by its group even with the sticky bit (1777)', { map: { [base]: ['root', 'root', '1777'] } }, /real is writable by its group/)
    await refused('the helper carries an ACL', { acl: helper }, /carries an ACL/)
    await refused('the ACL probe fails: an unknown is not clean', { aclFail: helper }, /could not be checked for an ACL/)
    await refused('the staging parent is writable by others', { map: { [stage]: ['root', 'root', '757'] } }, /stage is writable by others/)
    await refused('the staging parent is owned by the checkout owner (755): only root is trusted for it', { map: { [stage]: [user, user, '755'] } }, new RegExp(`stage is owned by ${user}, not root`))
    await refused('the sha256 cannot be computed', { shaFail: '1' }, /sha256 of the rendered unit could not be computed/)
    await refused('--sandbox: the helper\'s sha256 cannot be computed', { shaFail: '1', mode: '--sandbox' }, /sha256 of tools\/install-sandbox\.sh could not be computed/)
    await refused('gui/ is owned by someone other than the checkout owner', { map: { [gui]: ['intruder', 'intruder', '755'] } }, /gui is owned by intruder/)
    await refused('an input is owned by another user', { map: { [helper]: ['intruder', 'intruder', '644'] } }, /is owned by intruder/)

    t.section('links inside the checkout are refused, however many hops they take')
    {
      const safe = path.join(checkout, 'safe')
      await fs.mkdir(safe); await fs.chmod(safe, 0o755)
      await fs.rename(helper, path.join(safe, 'install-sandbox.sh'))
      await fs.symlink(path.join(safe, 'install-sandbox.sh'), helper)
      await refused('single hop: the helper is a link to a file in a safe folder', {}, /install-sandbox\.sh is a symlink inside the checkout/)
      await fs.rm(helper)
      await fs.rename(path.join(safe, 'install-sandbox.sh'), helper)

      // gui/tools -> A/l -> T, where A is a folder anyone can write and T holds the helper.
      const A = path.join(base, 'A'), T = path.join(base, 'T')
      await fs.mkdir(A); await fs.chmod(A, 0o777)
      await fs.rename(path.join(gui, 'tools'), T)
      await fs.symlink(T, path.join(A, 'l'))
      await fs.symlink(path.join(A, 'l'), path.join(gui, 'tools'))
      await refused('two hops through a folder others can write', {}, /gui\/tools is a symlink inside the checkout/)
      await fs.rm(path.join(gui, 'tools'))
      await fs.rename(T, path.join(gui, 'tools'))
    }

    t.section('what is accepted')
    {
      const sticky = await run({ map: { [base]: ['root', 'root', '1757'] } })
      t.eq('a folder above the checkout that others may write, with the sticky bit (1757)', sticky.code, 0, sticky.stderr)
      const link = path.join(tmp, 'link')
      await fs.symlink(base, link)
      const through = await run({ entry: path.join(link, 'checkout', 'gui', 'install.sh') })
      t.ok('a checkout reached through a linked parent: checked and rendered through its real path', through.code === 0 && through.stdout.includes(`WorkingDirectory=${gui}`) && !through.stdout.includes(`WorkingDirectory=${link}`), `${through.code} ${through.stderr}`)
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
