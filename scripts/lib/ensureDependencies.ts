import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bunCommand } from './bunCommand'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const lockfilePath = join(repoRoot, 'bun.lock')
const markerPath = join(repoRoot, 'node_modules', '.instatic-lockfile-hash')

/**
 * Bring `node_modules` in line with `bun.lock` before the dev servers start.
 *
 * A checkout pulled after a dependency change starts the CMS child, which
 * then dies on the first import it cannot resolve ("Cannot find module
 * 'jsdom'") with nothing pointing at `bun install`. Installing here fixes
 * that at the source. `--frozen-lockfile` keeps the dev script from
 * rewriting `bun.lock` when `package.json` was edited by hand.
 *
 * The lockfile's hash is remembered in `node_modules/.instatic-lockfile-hash`
 * after a successful install, so the common case (nothing changed) costs one
 * file read. Running bun unconditionally would be simpler, but bun re-copies
 * `file:` dependencies such as the vendored `pixel-art-icons` on every
 * install, which is 50 to 150 ms of churn and a spurious "1 package
 * installed" line on every start. Deleting `node_modules` deletes the marker,
 * so a fresh clone installs too.
 *
 * Uses the running bun binary (`bunCommand`) so it works on Windows, where
 * spawning `bun` by name fails with ENOENT.
 */
export async function ensureDependencies(log: (msg: string) => void): Promise<void> {
  const lockfileHash = Bun.hash(await readFile(lockfilePath)).toString(16)
  const installedHash = existsSync(markerPath) ? (await readFile(markerPath, 'utf8')).trim() : null
  if (installedHash === lockfileHash) return

  log('bun.lock changed since the last install, running `bun install --frozen-lockfile`')
  const result = Bun.spawnSync(bunCommand('install', '--frozen-lockfile'), {
    cwd: repoRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    log('`bun install --frozen-lockfile` failed. If you changed package.json, run `bun install` once to update bun.lock, then start again.')
    process.exit(result.exitCode || 1)
  }
  await writeFile(markerPath, `${lockfileHash}\n`)
}
