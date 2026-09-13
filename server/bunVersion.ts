/**
 * Which Bun this server is built and tested on, and what to do when it runs
 * on something else.
 *
 * Every documented install path carries its own runtime: the Docker image is
 * built `FROM oven/bun:<version>` and the Desktop server artifact is a
 * `bun build --compile` binary with Bun embedded. Only a direct install
 * (`bun run server/index.ts` on the operator's machine) uses whatever Bun is
 * on PATH, and nothing in Bun enforces `engines.bun`, so this module is where
 * the range is checked at runtime.
 *
 * `SUPPORTED_BUN_RANGE` duplicates `engines.bun` from package.json on purpose:
 * the compiled artifact ships without package.json. `bunVersion.test.ts`
 * keeps the two identical.
 */
import { lt as semverLt, satisfies as semverSatisfies } from 'semver'

/** Mirrors `engines.bun` in package.json (gated by `bunVersion.test.ts`). */
export const SUPPORTED_BUN_RANGE = '>=1.4.0 <1.5.0'

/**
 * The oldest Bun `bun run dev` accepts. 1.4.1 fixed the `node:http` upgrade
 * and socket-lifecycle bugs the Vite dev proxy relies on (`ws: true` on
 * `/admin/api` in vite.config.ts); on an older Bun the editor's collab socket
 * hangs in CONNECTING forever with nothing in the log, which is why the dev
 * launchers refuse to start instead of letting that happen.
 */
export const DEV_STACK_MIN_BUN = '1.4.1'

/**
 * The production server keeps booting on an unsupported Bun; a direct install
 * must not go down over a version skew. It logs this line once so the
 * operator finds the cause in the supervisor log, not by bisecting a bug.
 */
export function unsupportedBunWarning(version: string): string | null {
  if (semverSatisfies(version, SUPPORTED_BUN_RANGE, { includePrerelease: true })) return null
  return (
    `[server] Bun ${version} is outside the supported range ${SUPPORTED_BUN_RANGE}. ` +
    'Instatic starts anyway, but releases are built and tested inside that range; ' +
    'run `bun upgrade` to move to a supported Bun.'
  )
}

/** The dev launchers exit on this message instead of starting a stack whose editor cannot connect. */
export function devStackBunError(version: string): string | null {
  if (!semverLt(version, DEV_STACK_MIN_BUN)) return null
  return (
    `Bun ${version} is too old for the dev stack: the Vite proxy forwards the editor's ` +
    `WebSocket, which needs Bun ${DEV_STACK_MIN_BUN} or newer. Run \`bun upgrade\` and start again.`
  )
}
