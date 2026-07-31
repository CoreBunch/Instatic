/**
 * One-command production-mode runner for local use.
 *
 * `bun run start` does what a single deploy would do, but in your dev
 * tree against your dev data:
 *
 *   1. Builds the admin SPA (`bun run build` → `./dist/`).
 *   2. Frees port 3001 — if anything is already listening it prompts
 *      whether to kill the holder and take over (same UX as `bun run dev`).
 *   3. Spawns the server (`bun run server/index.ts`) — no `--watch`, no
 *      Vite, the built SPA served from `./dist`.
 *
 * Defaults map to "production mode on the dev DB":
 *   PORT=3001
 *   DATABASE_URL=sqlite:./.tmp/dev.db (server/config.ts default)
 *   STATIC_DIR=./dist
 *   UPLOADS_DIR=./uploads
 *
 * Override any of these via env (`PORT=4000 bun run start`, etc.).
 */

import { bunRunCommand } from './lib/bunCommand'
import { ensurePortFree } from './lib/freePort'

const CMS_PORT = Number(process.env.PORT ?? '3001')

function log(msg: string): void {
  console.error(`[start] ${msg}`)
}

function runStep(name: string, command: string[]): void {
  log(`${name}...`)
  const result = Bun.spawnSync(command, {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    log(`${name} failed (exit ${result.exitCode}). Aborting.`)
    process.exit(result.exitCode ?? 1)
  }
}

// --- build ---------------------------------------------------------------

runStep('Building admin SPA (bun run build)', bunRunCommand('build'))

// --- port pre-flight -----------------------------------------------------

await ensurePortFree(CMS_PORT, 'cms', log)

// --- spawn server --------------------------------------------------------

log('')
log(`Starting server on http://localhost:${CMS_PORT}`)
log('')

const child = Bun.spawn(bunRunCommand('server/index.ts'), {
  env: { ...process.env, PORT: String(CMS_PORT) },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

let shuttingDown = false
function forward(signal: NodeJS.Signals): void {
  shuttingDown = true
  if (child.exitCode === null) child.kill(signal)
}

process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

const code = await child.exited
if (!shuttingDown && code !== 0) {
  log(`server exited with code ${code}`)
}
process.exit(code ?? 0)
