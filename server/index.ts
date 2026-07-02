import { createDbClient } from './db'
import { runMigrations } from './db/runMigrations'
import { syncSystemRoles } from './repositories/roles'
import { readServerConfig } from './config'
import { DEV_ORIGIN_ALLOWLIST, configurePublicOrigins, configureTrustedProxyCidrs, stampSocketIp } from './auth/security'
import { applySecurityHeaders } from './securityHeaders'
import { startConversationPurgeTick } from './ai/boot'

await import('./richtextSanitizer')
const { handleServerRequest } = await import('./router')
const { activateInstalledServerPlugins } = await import('./plugins/runtime')
const { mediaStorageRegistry } = await import('@core/plugins/mediaStorageRegistry')
const { setSiteEventPublisher } = await import('./events/siteEvents')
const { SITE_SOCKET_PATH, createSiteSocketHandlers, handleSiteSocketUpgrade } =
  await import('./events/siteSocket')

const config = readServerConfig()
configureTrustedProxyCidrs(config.trustedProxyCidrs)
configurePublicOrigins(config.publicOrigins)
const { db, migrations } = createDbClient(config.databaseUrl)
await runMigrations(db, migrations)
// System role sync runs after migrations on every boot — the Owner row's
// capabilities are force-reset to `CORE_CAPABILITIES` so existing
// installations don't strand owners on a stale grant list when new
// capabilities are added in code. See `syncSystemRoles` for the policy.
await syncSystemRoles(db)
// Wire the built-in local-disk media adapter BEFORE plugins activate —
// plugin adapters register through the same registry but local-disk is
// always the fallback for unset roles. See `mediaStorageRegistry.ts`.
mediaStorageRegistry.configureLocalDisk({ uploadsDir: config.uploadsDir })
await activateInstalledServerPlugins(db, config.uploadsDir)
// AI runtime: start the nightly conversation-purge tick. Operators add
// their own provider credentials via /admin/ai/providers on first install.
startConversationPurgeTick(db)

/**
 * Build the CORS response headers for an incoming request.
 *
 * Returns headers ONLY when the request's `Origin` is on the dev allowlist
 * (the production admin shell is same-origin behind Caddy, so no ACAO is
 * needed). Anything else gets an empty header set — the browser then blocks
 * cross-origin reads naturally instead of us "allow"-ing a wrong value.
 *
 * Echoing an unrelated allowlist entry with `Access-Control-Allow-Credentials: true`
 * (the previous behaviour) was harmless in practice — browsers reject the
 * response when ACAO doesn't match the requesting Origin — but it was the
 * same shape as classic broken-CORS bugs and made misconfigured
 * `VITE_ALLOWED_ORIGIN` values silently open the API up.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !DEV_ORIGIN_ALLOWLIST.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // The response body varies by Origin (we either include ACAO or don't),
    // so caches must key on Origin to avoid serving a permissive response to
    // a non-allowlisted origin.
    'Vary': 'Origin',
  }
}

const server = Bun.serve({
  port: config.port,

  // Disable Bun's default 10-second idle timeout. The agent endpoint streams
  // NDJSON for as long as Claude's loop is running — Claude's "thinking"
  // gaps between tool calls regularly exceed 10s on multi-step builds, and
  // hitting the default would kill the streaming response mid-flight, leave
  // the bridge resolver hanging server-side, and stall the agent. Other
  // routes finish as normal HTTP request/response cycles, so removing the
  // idle timeout has no downside for them.
  idleTimeout: 0,

  async fetch(req: Request, server: Bun.Server<unknown>) {
    const origin = req.headers.get('origin')
    const cors = corsHeaders(origin)
    const pathname = new URL(req.url).pathname

    // Stamp the socket peer address onto the request so downstream
    // `clientIp(req)` returns a real value when no `X-Forwarded-For` is
    // present (dev, self-hosted without a proxy). Strips any inbound spoof.
    stampSocketIp(req, server.requestIP(req)?.address ?? null)

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return applySecurityHeaders(
        new Response(null, { status: 204, headers: cors }),
        pathname,
      )
    }

    // Multi-admin live-sync socket — a WebSocket upgrade is a different
    // protocol lifecycle from the request/response router, so it dispatches
    // here at the `Bun.serve` boundary (the only place `server.upgrade` is
    // available). Returning `undefined` hands the connection to the
    // `websocket` handlers below.
    if (pathname === SITE_SOCKET_PATH) {
      const rejection = await handleSiteSocketUpgrade(req, db, server)
      if (rejection === null) return undefined
      return applySecurityHeaders(rejection, pathname)
    }

    try {
      const res = await handleServerRequest(req, {
        db,
        staticDir: config.staticDir,
        uploadsDir: config.uploadsDir,
        databaseUrl: config.databaseUrl,
      })
      for (const [k, v] of Object.entries(cors)) {
        res.headers.set(k, v)
      }
      return applySecurityHeaders(res, pathname)
    } catch (err) {
      // Never echo `err.message` to the client — inner handlers already return
      // structured error bodies for the failure modes they expect; anything
      // that escapes to here is an unexpected crash whose message can leak
      // SQL fragments, absolute paths, spawn() arguments, etc. Log fully,
      // respond generically.
      console.error('[server] Unhandled request error:', err)
      return applySecurityHeaders(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        }),
        pathname,
      )
    }
  },

  websocket: createSiteSocketHandlers(db),

  error(err: Error) {
    console.error('[server] Unhandled error:', err)
    return new Response('Internal Server Error', { status: 500 })
  },
})

// The bus needs the live server handle for Bun pub/sub fan-out — register it
// now that `Bun.serve` returned. Save events emitted before this line (none
// in practice) would drop harmlessly: they are hints, the delta is truth.
setSiteEventPublisher(server)

console.log(`[server] Listening on http://localhost:${config.port}`)
