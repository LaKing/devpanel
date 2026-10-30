#!/usr/bin/env node
/*
 * Print where the panel keeps one of its own files, for the shell scripts
 * (start.sh, make-cert.sh): `cert`, `logs`, `token` or `issues`. The same rule
 * as the server (server/project-path.mjs): the variable, else <dataRoot>/<name>
 * from the host settings, else the panel's checkout.
 */
import { certDir, issuesRoot, logDir, tokenFile } from '../server/project-path.mjs'

const paths = { cert: certDir, logs: logDir, token: tokenFile, issues: issuesRoot }
const which = paths[process.argv[2]]
if (!which) {
  console.error(`usage: data-path.mjs ${Object.keys(paths).join('|')}`)
  process.exit(2)
}
console.log(which())
