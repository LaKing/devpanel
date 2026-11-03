import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { sandbox } from '../helpers.mjs'

const exec = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUI = path.resolve(HERE, '..', '..')
const NL = String.fromCharCode(10)

/*
 * A real devpanel server, in its own process, on a throwaway port.
 *
 * It has to be a separate process: "execution continues after closing the
 * browser" is only a real claim if the run is not living inside the test.
 */

const stages = []

async function freePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function temp (prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * @param control  initial fake-runtime control (see fakes/harness-module.mjs)
 * @param env      added to the server's environment
 */
export async function startStage ({ control = {}, project = 'devpanel-project', env: extraEnv = {} } = {}) {
  const projectsDir = await temp('devpanel-stage-srv-')
  const issuesDir = await temp('devpanel-stage-issues-')
  const stateDir = await temp('devpanel-stage-state-')

  // A real git repository: the worktree provider is not stubbed either.
  const projectPath = path.join(projectsDir, project)
  await fs.mkdir(projectPath, { recursive: true })
  await exec('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await exec('git', ['-C', projectPath, 'config', 'user.email', 'stage@example.invalid'])
  await exec('git', ['-C', projectPath, 'config', 'user.name', 'Stage'])
  await fs.writeFile(path.join(projectPath, 'source.txt'), 'original' + NL)
  await exec('git', ['-C', projectPath, 'add', '-A'])
  await exec('git', ['-C', projectPath, 'commit', '-qm', 'base'])

  const controlFile = path.join(stateDir, 'control.json')
  const ledger = path.join(stateDir, 'ledger.jsonl')
  const write = async (next) => {
    const merged = { ledger, delayMs: 0, ...next }
    await fs.writeFile(controlFile, JSON.stringify(merged, null, 2))
    return merged
  }
  await write(control)

  // A config root whose roster points every participant at the fake runtime, and
  // whose harness directory holds nothing else. The real adapters are not merely
  // unused here — they are absent, so no path through this stage can reach a
  // real runtime or spend anything.
  const configRoot = await sandbox(async (dir) => {
    // These compatibility suites exercise the original pinned playbooks. Keep
    // them visible in this isolated fixture; production hides deprecated IDs.
    for (const file of await fs.readdir(path.join(dir,'playbooks'))) {
      const full=path.join(dir,'playbooks',file)
      await fs.writeFile(full,(await fs.readFile(full,'utf8')).replace(/^deprecated: true$/m,'deprecated: false'))
    }
    for (const file of await fs.readdir(path.join(dir, 'roster'))) {
      const full = path.join(dir, 'roster', file)
      const text = (await fs.readFile(full, 'utf8'))
        .replace(/^harness: .*$/m, 'harness: fake')
        .replace(/^ {2}status: unverified$/m, '  status: verified')
      await fs.writeFile(full, text)
    }
    for (const file of await fs.readdir(path.join(dir, 'harness'))) {
      if (file.endsWith('.mjs')) await fs.rm(path.join(dir, 'harness', file))
    }
    await fs.writeFile(
      path.join(dir, 'harness', 'fake.mjs'),
      `export * from ${JSON.stringify(path.join(GUI, 'test', 'fakes', 'harness-module.mjs'))}${NL}`
    )
  })

  const harnessDir = path.join(configRoot, 'harness')

  const port = await freePort()
  const token = 'stage-token-0123456789abcdef'
  const origin = `http://127.0.0.1:${port}`

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DEVPANEL_TLS: '0',
    DEVPANEL_LOG_DIR: path.join(stateDir, 'logs'),
    DEVPANEL_TOKEN: token,
    DEVPANEL_TICK_MS: '60000',
    DEVPANEL_PROJECTS_DIR: projectsDir,
    DEVPANEL_ISSUES_DIR: issuesDir,
    DEVPANEL_CONFIG_ROOT: configRoot,
    DEVPANEL_HARNESS_DIR: harnessDir,
    DEVPANEL_FAKE_CONTROL: controlFile,
    // Staleness is recomputed per request here, so a test does not wait out a cache.
    DEVPANEL_SOURCE_CACHE_MS: '0',
    ...extraEnv
  }

  const log = []
  let child = null

  const spawnServer = () => {
    const next = spawn(process.execPath, [path.join(GUI, 'server', 'index.js')], {
      env, cwd: GUI, stdio: ['ignore', 'pipe', 'pipe']
    })
    next.stdout.on('data', (d) => log.push(String(d)))
    next.stderr.on('data', (d) => log.push(String(d)))
    return next
  }

  const waitForHealth = async ({ timeout = 15000 } = {}) => {
    const until = Date.now() + timeout
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${log.join('')}`)
      try {
        const health = await fetch(`${origin}/api/health`)
        if (health.ok) return
      } catch { /* not listening yet */ }
      if (Date.now() > until) throw new Error(`server never came up: ${log.join('')}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  const killServer = async (signal = 'SIGKILL') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill(signal)
    await exited
  }

  child = spawnServer()

  const request = async (route, options = {}) => {
    const response = await fetch(`${origin}${route}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {})
      }
    })
    const body = await response.json().catch(() => null)
    return { status: response.status, body }
  }

  // Wait for it to answer, rather than guessing at a delay.
  await waitForHealth()

  // eslint-disable-next-line prefer-const -- stop() refers to the object it lives on
  var stage = {
    origin, token, port, project, projectsDir, issuesDir, configRoot, harnessDir, controlFile, ledger, log, logDir: path.join(stateDir, 'logs'),
    request,
    /** Change what the runtime does — including part-way through a run. */
    setControl: write,
    async createIssue (name) {
      const { body } = await request(`/api/projects/${project}/issues`, {
        method: 'POST', body: JSON.stringify({ name })
      })
      return body
    },
    async runs (issueId) {
      return (await request(`/api/projects/${project}/issues/${issueId}/runs`)).body
    },
    async run (issueId, runId) {
      return (await request(`/api/projects/${project}/issues/${issueId}/runs/${runId}`)).body
    },
    /** Kill the server outright — a crash, not a shutdown. */
    kill: (signal = 'SIGKILL') => killServer(signal),
    /**
     * Restart the server against the same directories.
     * `signal` picks what kind of death it is: SIGKILL crashes it mid-flight,
     * SIGTERM lets its shutdown path run.
     */
    async restart ({ signal = 'SIGKILL' } = {}) {
      await killServer(signal)
      child = spawnServer()
      await waitForHealth()
    },
    async stop () {
      // Idempotent: the suite stops its own stage, and the runner sweeps again.
      const index = stages.indexOf(stage)
      if (index >= 0) stages.splice(index, 1)
      await killServer('SIGKILL')
      await Promise.all([projectsDir, issuesDir, stateDir]
        .map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
    }
  }

  stages.push(stage)
  return stage
}

export async function cleanupStages () {
  await Promise.all(stages.splice(0).map((s) => s.stop().catch(() => {})))
}
