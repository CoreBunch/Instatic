/**
 * The dispatcher's runtime contract — what `server/index.ts` hands every
 * route handler. Lives apart from `router.ts` so route modules that the
 * dispatcher imports (`server/publish/publicRoutes.ts`) can type themselves
 * without importing the dispatcher back.
 */
import type { DbClient } from './db/client'
import type { CollabRelay } from './collab/relay'
import type { ManagerConfig } from './manager/config'

/** What the Manager API needs from the process that hosts it. */
export interface ManagerRuntime {
  config: ManagerConfig
  /** Ids of every migration this server build knows, applied or not. */
  knownMigrationIds: string[]
  /**
   * Flush and exit with the "restart me" code so a staged restore is applied
   * on the next boot. Returns immediately; the exit happens after the
   * response is sent.
   */
  requestRestart: () => void
}

export interface ServerRuntime {
  db: DbClient
  staticDir?: string
  uploadsDir?: string
  /**
   * The raw `DATABASE_URL` the server booted with — forwarded down to
   * CMS handlers that need to resolve the on-disk SQLite file (e.g. the
   * storage dashboard widget).
   */
  databaseUrl?: string
  collabRelay?: CollabRelay
  /** Present on every boot; the API itself is live only when a token is configured. */
  manager?: ManagerRuntime
}

/**
 * A route handler returns a `Response` if it owns the request, or `null` if
 * the URL/method doesn't match — the dispatcher walks the `routes` table and
 * returns the first non-null response. Prefix-namespaced handlers (e.g.
 * `/_instatic/css/`, `/_instatic/runtime/cache/`) absorb their entire namespace and emit
 * a 404 themselves rather than falling through, so unknown paths under a
 * known prefix can't accidentally match a later route.
 */
export type RouteHandler = (
  req: Request,
  runtime: ServerRuntime,
  url: URL,
  pathname: string,
) => Promise<Response | null> | Response | null
