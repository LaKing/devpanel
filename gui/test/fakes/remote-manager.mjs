import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
// A shim's answer to the `ssh -G` every drive reads its host with (drive-slots.mjs). $1 only, so a remote command naming -G cannot trigger it.
export const SSH_ANSWERS_G = 'if [ "$1" = -G ]; then for last; do :; done; echo "hostname $last"; exit 0; fi'

export async function installRemoteManager (dir) {
 const source=await fs.readFile(new URL('./remote-manager.sh',import.meta.url))
 for(const name of ['systemd-run','systemctl'])await fs.writeFile(path.join(dir,name),source,{mode:0o755})
 return `export PATH='${dir}':"$PATH"\nexport DEVPANEL_TEST_UNITS='${dir}/units'\n${SSH_ANSWERS_G}`
}

/** Play a timer's firing: it leaves the waiting state and its command runs. */
export async function fireTimer (dir, unit) {
 const file = path.join(dir, 'units', `${unit}.timer.json`)
 const { script } = JSON.parse(await fs.readFile(file, 'utf8'))
 await fs.rm(file, { force: true })
 await run('/bin/bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVPANEL_TEST_UNITS: path.join(dir, 'units') } })
}
