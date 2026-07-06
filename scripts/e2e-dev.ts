/**
 * Disposable local server for automated browser E2E tests.
 *
 * This wrapper owns only the `.tmp/e2e-*` data used by Playwright. It resets
 * that data, then runs the same Vite + Bun CMS stack a developer uses — with one
 * deliberate difference: the CMS runs WITHOUT `--watch`.
 *
 * Why no watch: under `bun --watch`, the publish pipeline writing baked HTML into
 * the uploads dir (and the SQLite DB churning) can trigger a server reload mid
 * test, which drops in-memory state and tears the stack down. A regression suite
 * needs a stable server, so E2E pins one. Vite is additionally told to ignore the
 * runtime-written paths (see `vite.config.ts`), so publishing never reloads the
 * admin app mid-test either.
 */
import { mkdir, rm } from 'node:fs/promises'
import { bunCommand, bunRunCommand } from './lib/bunCommand'

const DATABASE_PATH = './.tmp/e2e-agent.db'
const UPLOADS_DIR = './.tmp/e2e-uploads'
const CMS_PORT = process.env.E2E_CMS_PORT ?? '3002'
const VITE_PORT = process.env.E2E_VITE_PORT ?? '5174'

await mkdir('./.tmp', { recursive: true })
await rm(DATABASE_PATH, { force: true })
await rm(`${DATABASE_PATH}-shm`, { force: true })
await rm(`${DATABASE_PATH}-wal`, { force: true })
await rm(UPLOADS_DIR, { force: true, recursive: true })

// Shared by both children: the CMS port drives the Vite dev proxy target, so the
// admin UI talks to this disposable CMS instead of any regular dev server.
const sharedEnv = {
  ...process.env,
  PORT: CMS_PORT,
  DATABASE_URL: `sqlite:${DATABASE_PATH}`,
  UPLOADS_DIR,
}

const children: Bun.Subprocess[] = []
let shuttingDown = false

function stopChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal)
  }
}

for (const command of [
  bunCommand('server/index.ts'),
  bunRunCommand('vite', '--host', '127.0.0.1', '--port', VITE_PORT, '--strictPort'),
]) {
  const child = Bun.spawn(command, {
    env: sharedEnv,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  children.push(child)
  void child.exited.then((code) => {
    if (shuttingDown) return
    // One half of the stack died on its own — bring the other down and exit so
    // Playwright sees the failure instead of half a stack.
    stopChildren()
    process.exit(code ?? 1)
  })
}

process.on('SIGINT', () => stopChildren('SIGINT'))
process.on('SIGTERM', () => stopChildren('SIGTERM'))
