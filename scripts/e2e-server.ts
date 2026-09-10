/**
 * Disposable server for the Playwright suite.
 *
 * Builds the admin SPA, then serves it from the same Bun process that serves
 * the published site — ONE origin, exactly the shape a self-hosted install
 * runs in. That is deliberately not the `bun run dev` stack:
 *
 *   - **No Vite.** The suite exercises the bundle users actually get, not a
 *     dev server's on-the-fly transforms. It also removes a dependency on the
 *     Vite dev server surviving inside Bun, which is fragile enough that the
 *     dev proxy already carries its own warning (see `vite.config.ts`) and
 *     which hangs outright on Linux CI runners. `vite build` is a batch step
 *     and runs fine there — it is the long-lived dev server that does not.
 *   - **No `--watch`.** The publish pipeline writes baked HTML into the uploads
 *     dir and churns the SQLite DB; under watch that reloads the server mid
 *     test and drops in-memory state.
 *   - **One origin.** Admin and the public site share a port, so nothing has to
 *     keep two base URLs in step. Anonymous visitor checks stay honest because
 *     they open a fresh browser context (`visitPublicPage`), and the admin
 *     session cookie is scoped to `Path=/admin` so it never rides along on a
 *     public request anyway.
 *
 * This wrapper owns only the `.tmp/e2e-*` data, which it resets on every run.
 */
import { mkdir, rm } from 'node:fs/promises'
import { bunCommand, bunRunCommand } from './lib/bunCommand'
import { ensureDependencies } from './lib/ensureDependencies'

const DATABASE_PATH = './.tmp/e2e-agent.db'
const UPLOADS_DIR = './.tmp/e2e-uploads'
const PORT = process.env.E2E_CMS_PORT ?? '3002'

function log(msg: string): void {
  console.error(`[e2e-server] ${msg}`)
}

// Same guard as `bun run dev`: Playwright starts this stack right after a
// `git pull`, and a stale node_modules would otherwise surface as a crash on
// the first import instead of a missing install.
await ensureDependencies((msg) => log(msg))

await mkdir('./.tmp', { recursive: true })
await rm(DATABASE_PATH, { force: true })
await rm(`${DATABASE_PATH}-shm`, { force: true })
await rm(`${DATABASE_PATH}-wal`, { force: true })
await rm(UPLOADS_DIR, { force: true, recursive: true })

// `bun run build` is `tsc -b && vite build`. Building here rather than in a
// separate CI step keeps one path: whatever a developer runs locally is what
// the runner runs.
log('building the admin SPA (bun run build)')
const build = Bun.spawnSync(bunRunCommand('build'), { stdout: 'inherit', stderr: 'inherit' })
if (build.exitCode !== 0) {
  log(`build failed (exit ${build.exitCode})`)
  process.exit(build.exitCode ?? 1)
}

const origin = `http://127.0.0.1:${PORT}`
log(`starting the CMS on ${origin}`)

const server = Bun.spawn(bunCommand('server/index.ts'), {
  env: {
    ...process.env,
    PORT,
    HOST: '127.0.0.1',
    DATABASE_URL: `sqlite:${DATABASE_PATH}`,
    UPLOADS_DIR,
    STATIC_DIR: './dist',
    // Pin the CSRF origin to the one the suite drives, so the check compares a
    // configured value instead of falling back to the inbound Host header.
    PUBLIC_ORIGIN: origin,
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

let shuttingDown = false

function stopServer(signal: NodeJS.Signals = 'SIGTERM'): void {
  shuttingDown = true
  if (server.exitCode === null) server.kill(signal)
}

process.on('SIGINT', () => stopServer('SIGINT'))
process.on('SIGTERM', () => stopServer('SIGTERM'))

const code = await server.exited
if (!shuttingDown) log(`server exited with code ${code}`)
process.exit(code ?? 0)
