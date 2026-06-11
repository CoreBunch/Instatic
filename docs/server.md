# Server

Deep dive on the server-side of Instatic — the Bun process, the router, the handlers, the auth model, the DB adapter, and how a request becomes a response.

The server is a single `Bun.serve` process that boots the DB, runs migrations, activates installed plugins, then accepts HTTP requests and dispatches them through an ordered route table. There are no other processes, no message queues, no workers. The runtime entrypoint is `server/index.ts`.

---

## TL;DR

- **Entrypoint:** `server/index.ts` (boots DB → migrations → role sync → plugin activation → `Bun.serve`).
- **Router:** `server/router.ts` — ordered route table, first-match wins. Each route is a `tryServeX(req, runtime, url, pathname)` function returning `Response | null`.
- **CMS API:** every `/admin/api/cms/*` request goes through `server/handlers/cms/index.ts`, which runs a CSRF origin check and dispatches to per-resource handler groups.
- **Auth:** session cookie (`SESSION_COOKIE_NAME`) → `findUserBySessionHash` → `requireCapability(req, db, 'site.read')`. Every state-changing handler starts with one of these guards.
- **DB:** one `DbClient` interface (`server/db/client.ts`) — tagged-template callable returning `{ rows, rowCount }`. Two adapters: `postgres.ts` (via `Bun.sql`) and `sqlite.ts` (via `bun:sqlite`). Selected by `DATABASE_URL`.
- **Repositories** (`server/repositories/`) hold all SQL. Handlers never write SQL directly.
- **Plugins:** `server/plugins/runtime.ts` activates installed plugins at boot; per-plugin code runs in QuickJS-WASM sandboxes (`server/plugins/quickjs/vm.ts`, `modulePackVm.ts`).
- **Published pages and content rows** are served by `tryServePublicRoute`, which delegates resolution + render to `server/publish/publicRouter.ts`. A warm Layer B cache entry is served before any DB work; on a miss the live render reads the published `SiteDocument` from `site_snapshots` (stored once per publish, referenced by `data_row_versions.site_snapshot_id`, memoised per publish version). Uploads + admin SPA assets are served from disk by `tryServeUpload` and `tryServeStaticAsset`.

---

## Boot sequence

```text
server/index.ts
    │
    ├─→ readServerConfig()                   ← env vars: PORT, DATABASE_URL, UPLOADS_DIR, STATIC_DIR, PUBLIC_ORIGIN, TRUSTED_PROXY_CIDRS
    │
    ├─→ createDbClient(DATABASE_URL)         ← server/db/index.ts
    │     │
    │     ├─ DATABASE_URL=sqlite:... | file:... | *.db  → createSqliteClient
    │     └─ DATABASE_URL=postgres://...  | postgresql://...  → createPostgresClient
    │
    ├─→ runMigrations(db, migrations)        ← server/db/runMigrations.ts
    │     (selects migrations-pg.ts OR migrations-sqlite.ts based on dialect)
    │
    ├─→ syncSystemRoles(db)                  ← force-resets Owner capabilities every boot
    ├─→ backfillDefaultEntryTemplates(db)    ← ensures every postType table has a default entry tpl
    ├─→ mediaStorageRegistry.configureLocalDisk({ uploadsDir })   ← register local-disk media adapter
    ├─→ activateInstalledServerPlugins(db, uploadsDir)            ← run plugin lifecycle: activate
    │
    └─→ Bun.serve({ fetch: req => handleServerRequest(req, runtime) })
```

Boot is sequential and fail-fast. If migrations fail, the process exits. If a plugin's `activate` throws, the host logs `[plugin:<id>]` and continues — one bad plugin doesn't bring the server down.

---

## Routing

`server/router.ts` exposes one function:

```ts
export async function handleServerRequest(req: Request, runtime: ServerRuntime): Promise<Response>
```

It walks an ordered `routes` array of `RouteHandler` functions. Each handler returns `Response` (it owns the request) or `null` (try the next handler). The first non-null wins. Unknown paths fall through to a `404`.

### The route table

```ts
const routes: readonly RouteHandler[] = [
  tryServeHealth,                  // /health
  tryServeAi,                      // /admin/api/ai/*         → server/ai/handlers/
  tryServeCmsApi,                  // /admin/api/cms/*        → handlers/cms/index.ts
  tryServeLoopRuntimeAsset,        // /_instatic/loop-runtime.js (fixed CMS asset)
  tryServeLoop,                    // /_instatic/loop/*       → handlers/cms/loop.ts
  tryServeHoleRuntimeAsset,        // /_instatic/hole-runtime.js (fixed CMS asset)
  tryServeHole,                    // /_instatic/hole/*       → handlers/cms/hole.ts
  tryServeModuleJsAsset,           // /_instatic/module-js/*  → handlers/cms/moduleJs.ts
  tryServePublicForm,              // /_instatic/form/*       → forms/handler.ts
  tryServeRuntimeAsset,            // /_instatic/assets/*     → published runtime assets
  tryServeRuntimePackageNamespace, // /_instatic/runtime/cache/<hash>/<...> → bun install workspace
  tryServeSiteCssNamespace,        // /_instatic/css/*        → hashed CSS bundles
  tryServeMediaRedirect,           // /_instatic/media/<adapterId>/<path> → 302 to signed read URL
  tryServeStaticAsset,             // /assets/* → dist/ (admin app)
  tryServeUpload,                  // /uploads/* → uploadsDir (with nosniff hardening)
  tryServeAdminApp,                // /admin/* → dist/index.html (SPA fallback)
  tryServePublicRoute,             // /<slug> OR /<route-base>/<row-slug>
                                   //   → server/publish/publicRouter.ts
                                   //   resolves to page snapshot OR data row + template,
                                   //   live-renders, runs publish.html pipeline
  trySetupRedirect,                // first-run redirect → /admin/setup
]
```

Order matters. Two examples:

- `tryServeAi` is matched **before** `tryServeCmsApi` so the AI endpoints (`/admin/api/ai/*`) aren't swallowed by the broader CMS dispatcher (`/admin/api/cms/*`).
- `tryServeUpload` is matched **before** `tryServeAdminApp` because `/uploads/...` is a sub-tree the SPA fallback would otherwise consume.

Adding a new endpoint is a one-line edit to `routes` plus a focused `tryServeX` function.

### Exclusive namespaces

Several handlers own an entire prefix and 404 internally rather than falling through:

- `/_instatic/runtime/cache/*` — never falls through to the public-slug renderer
- `/_instatic/css/*` — never falls through
- `/_instatic/media/*` — never falls through

This prevents an unknown path under a known namespace from accidentally matching a later handler.

### Cross-cutting middleware

`Bun.serve.fetch` in `server/index.ts` wraps every request with:

1. **CORS preflight** — `OPTIONS` returns 204 immediately with `corsHeaders(origin)`. ACAO is only set when the request's `Origin` is in `DEV_ORIGIN_ALLOWLIST` (production is same-origin behind Caddy, so no ACAO is needed).
2. **Socket IP stamping** — `stampSocketIp(req, ...)` writes the actual socket peer address onto the request so downstream `clientIp(req)` can ignore spoofed forwarding headers on direct requests. `X-Forwarded-For` is used only when the socket peer matches `TRUSTED_PROXY_CIDRS`; the chain is walked from right to left and the nearest untrusted IP becomes the client IP.
3. **Top-level error catch** — any error that escapes `handleServerRequest` is logged with `console.error('[server] Unhandled request error:', err)` and responded to with a generic `500 Internal server error`. The raw error message is **never** echoed to the client (it can leak SQL fragments, absolute paths, etc.).

`idleTimeout: 0` is set explicitly: the agent endpoint streams NDJSON over Claude's thinking gaps, which can easily exceed Bun's 10s default.

---

## CMS handlers

`/admin/api/cms/*` is handled by `server/handlers/cms/index.ts`. The flow:

1. **CSRF defense in depth.** State-changing methods (`POST/PUT/PATCH/DELETE`) must come from an `Origin` matching a configured public origin (`PUBLIC_ORIGIN`, auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN`), or a dev allowlist entry. With nothing configured the check falls back to the inbound `Host` header. Forwarded headers (`X-Forwarded-Host` / `X-Forwarded-Proto`) are never consulted, so `TRUSTED_PROXY_CIDRS` has no bearing on CSRF. `SameSite=Lax` already covers most CSRF; this catches the same-site-different-subdomain edge.

2. **Group dispatch.** The handler walks an ordered chain of route-group handlers, each owning a resource:

```ts
const response =
  (await handleSetupRoutes(req, db))
  ?? (await handleAuthRoutes(req, db))
  ?? (await handleMeRoutes(req, db, options))
  ?? (await handleUserPreferencesRoutes(req, db))
  ?? (await handleUsersRoutes(req, db))
  ?? (await handleRolesRoutes(req, db))
  ?? (await handleAuditRoutes(req, db))
  ?? (await handleSiteRoutes(req, db))
  ?? (await handlePagesRoutes(req, db))
  ?? (await handleComponentsRoutes(req, db))
  ?? (await handleRuntimeRoutes(req, db))
  ?? (await handleMediaFolderRoutes(req, db))           // before /media/:id
  ?? (await handleMediaStorageAdminRoutes(req, db, …))  // before /media/:id
  ?? (await handleMediaRoutes(req, db, …))
  ?? (await handlePluginsRoutes(req, db, …))
  ?? (await handleDataRoutes(req, db))
  ?? (await handleDashboardRoutes(req, db))
  ?? (await handleFontsRoutes(req, db, …))
  ?? (await handlePublishRoutes(req, db))
  ?? (await handleExportRoute(req, db, options))
  ?? (await handleImportPreviewRoute(req, db))          // before /import (longer path)
  ?? (await handleImportRoute(req, db, options))
```

Each group module owns its URL matching and returns `Response | null`. The first non-null wins. Order matters — handler order comments in `index.ts` document the load-bearing precedence (e.g. media folder/storage routes must run before `/media/:id` because that pattern would otherwise eat them).

### Route dispatch — `routeTable.ts`

Every handler group uses the shared `runRouteTable` dispatcher from `server/handlers/cms/routeTable.ts` rather than hand-rolling its own `(method, path)` matching. Each group declares a flat `Route[]` table and hands it to `runRouteTable`:

```ts
const PAGES_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/pages`, handler: handleListPages },
  { method: 'PUT', pattern: `${CMS_API_PREFIX}/pages`, handler: handleUpdatePages },
]

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, PAGES_ROUTES)
}
```

`runRouteTable` implements the one correct 404-vs-405 rule in a single place:

- Path matches some route, but no route has the right method → **405 Method Not Allowed**
- No route's pattern matches the path → **`null`**, so the CMS entry point tries the next group and ultimately 404s.

Parameterised routes use a `RegExp` with **named capture groups** (`(?<id>[^/]+)`). The dispatcher decodes each captured value once via `decodeURIComponent`, so handlers receive already-decoded params and never call `decodeURIComponent` themselves.

Handler groups that need per-request context beyond `(req, db)` (e.g. `CmsHandlerOptions`) pass it as a variadic `...extra` argument through both the route table and the individual handlers:

```ts
// Handler signature — three fixed args, then the typed extra
async function handleInstallFont(
  req: Request,
  db: DbClient,
  _params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> { … }

// Route table — typed with the extra tuple
const FONTS_ROUTES: readonly Route<[CmsHandlerOptions]>[] = [
  { method: 'POST', pattern: `${CMS_API_PREFIX}/fonts/install`, handler: handleInstallFont },
]

export async function handleFontsRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  return runRouteTable(req, db, FONTS_ROUTES, options)
}
```

### Handler shape

Every per-route handler in `server/handlers/cms/` follows the same skeleton:

```ts
async function handleListPages(req: Request, db: DbClient, _params: RouteParams): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user      // 401 / 403 — return early

  const rows = await listDataRows(db, 'pages')
  return jsonResponse({ rows })
}

async function handleUpdatePages(
  req: Request,
  db: DbClient,
  _params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'site.structure.edit')
  if (user instanceof Response) return user

  const BodySchema = Type.Object({ pages: Type.Array(Type.Unknown()), /* … */ })
  const body = await readValidatedBody(req, BodySchema)
  if (!body) return badRequest('Invalid request body')
  // … mutate via repository, return jsonResponse(…)
}
```

Conventions:

- **Require capability first**, return early on auth failure.
- **Validate body second** via TypeBox.
- **Talk to repositories third.** Handlers don't write SQL.
- **Return `jsonResponse({ … })` or an error envelope last.**
- Path matching and 404/405 discrimination are handled entirely by `runRouteTable` — individual handlers never check `req.method` or `url.pathname`.

---

## HTTP helpers

`server/http.ts` owns the small set of cross-handler helpers:

| Helper                           | Purpose                                                              |
|----------------------------------|----------------------------------------------------------------------|
| `jsonResponse(body, init?)`      | Returns a `Response` with `content-type: application/json`           |
| `readValidatedBody(req, schema)` | Parses the request body and validates it against a TypeBox schema. Returns the typed value on success, `null` on JSON parse failure or schema mismatch. Callers return `badRequest(msg)` on null. |
| `methodNotAllowed()`             | `405` with `{ error: 'Method not allowed' }`                         |
| `badRequest(message)`            | `400` with `{ error: message }`                                      |
| `setCookieHeader(res, value)`    | Appends a `Set-Cookie` header                                        |

`readValidatedBody` is the canonical body parser: it parses JSON and validates the shape against a TypeBox schema in one step, so handlers receive a fully typed value or return `badRequest` immediately.

### Binary helpers (`server/binary.ts`)

`server/binary.ts` provides two helpers for safely handing `Uint8Array` bytes to `Response` bodies and worker `postMessage` transfers:

| Helper                             | Purpose                                                              |
|------------------------------------|----------------------------------------------------------------------|
| `toArrayBuffer(bytes: Uint8Array)` | Copies the view's logical range into a fresh, exactly-sized `ArrayBuffer`. Required because a `Uint8Array` is only a view — its `.buffer` may be larger (pooled or sliced backing store) and resolves to `ArrayBuffer \| SharedArrayBuffer` which transfer/body slots reject. |
| `binaryResponse(bytes, init?)`     | Convenience wrapper: calls `toArrayBuffer` then wraps the result in a `new Response(...)`. Use for every "serve raw bytes" response in route handlers. |

Use `binaryResponse` whenever a route handler returns binary content (runtime assets, CSS bundles, images). Use `toArrayBuffer` when bytes must cross a worker `postMessage` boundary as a transferable.

**Error envelope.** Every CMS handler error returns `{ error: string }` and is validated client-side by `ErrorEnvelopeSchema` in `src/core/http/apiClient.ts` (re-exported from `responseSchemas.ts`). The canonical client `apiRequest` (and `readEnvelope`) extract the message via `responseErrorMessage(res, fallback)` and throw an `ApiError` carrying the HTTP status.

---

## Auth and capabilities

`server/auth/` owns the entire authentication surface.

| File              | Owns                                                                       |
|-------------------|----------------------------------------------------------------------------|
| `tokens.ts`       | Session cookie name, token hashing                                         |
| `sessions.ts`     | Session lookup, MFA gate, step-up timer                                    |
| `authz.ts`        | `requireAuthenticatedUser`, `requireCapability`, `requireAnyCapability`    |
| `capabilities.ts` | `CoreCapability` enum and per-capability membership rules                  |
| `lockout.ts`      | Failed-login lockout policy                                                |
| `mfa.ts`          | TOTP enrollment, verification                                              |
| `rateLimit.ts`    | Token-bucket rate limiters                                                 |
| `security.ts`     | `isStateChangingMethod`, `originAllowed`, `configurePublicOrigins`, `DEV_ORIGIN_ALLOWLIST`, IP stamp |
| `deviceLabel.ts`  | Device-fingerprint label for the sessions panel                            |

### The session flow

```text
Cookie: instatic_admin_session=<token>
    │
    ▼
hashSessionToken(token)
    │
    ▼
findUserBySessionHash(db, hash)
    │
    ├─→ no row              → 401 Unauthorized
    ├─→ row but MFA needed  → 401 { error: 'mfa_required' }
    └─→ row OK              → AuthUser { id, email, capabilities, ... }
```

`findUserBySessionHash` hydrates the `AuthUser` with a single `from sessions …
join users …` SELECT (the column list lives once in `USER_JOINED_COLUMNS`,
shared with the `users` repository). It then touches `sessions.last_seen_at`,
but that write is **debounced** to at most once per session per ~30s via an
in-memory tracker — the idle timeout is 30 days, so up-to-30s staleness is
irrelevant, and the hot per-request write (WAL-serialized on SQLite, a hot-row
lock on Postgres) is gone.

**Resolve the session once per request.** A handler calls exactly one of
`requireAuthenticatedUser` / `requireCapability` / `requireAnyCapability` to get
its `AuthUser`, then reuses that value for any further checks. Additional
capability checks in the same handler use the pure `userHasCapability(user, …)`
predicate rather than calling another guard, and the step-up gate takes the
already-resolved user (see below). No handler should hydrate the session twice.

### The capability gate

```ts
const user = await requireCapability(req, db, 'site.read')
if (user instanceof Response) return user   // 401 or 403 already encoded
// ... user is now AuthUser
```

`requireCapability` and `requireAnyCapability` are the only auth surfaces a handler should call. Capabilities are strings like `site.read`, `site.structure.edit`, `media.write`, `plugins.install`, `users.manage`, etc. Owner accounts get all `CORE_CAPABILITIES` automatically. The full list is in `src/core/capabilities.ts` (`@core/capabilities`); `docs/reference/capabilities.md` catalogs every one.

### Step-up auth

Sensitive actions (delete user, revoke another device, sign out all devices) gate on `requireStepUp(req, db, user, options?)`. It takes the **already-resolved `AuthUser`** — it does NOT re-authenticate — and returns `Response | null`: a 401 `{ error: 'step_up_required' }` when the window is stale, or `null` to proceed. The canonical pattern is therefore:

```ts
const user = await requireCapability(req, db, 'users.manage')
if (user instanceof Response) return user
const stepUp = await requireStepUp(req, db, user)
if (stepUp) return stepUp
// ... re-authenticated, proceed with `user`
```

This is what keeps a capability-gated sensitive write to one session lookup: the capability guard hydrates the session once, and `requireStepUp` only reads `step_up_expires_at` for that session. (Handlers with no preceding capability guard — e.g. the `/me/*` security routes — call `requireAuthenticatedUser` first to obtain `user`.)

Step-up is required by default with a 15-minute window, can be configured per user from Account -> Security, and can be disabled per user. The expiry lives on the session row as `step_up_expires_at` and is refreshed by `POST /admin/api/cms/auth/step-up`.

---

## Repositories

All SQL lives in `server/repositories/`. Each file owns one resource:

| File                       | Owns                                              |
|----------------------------|---------------------------------------------------|
| `audit.ts`                 | Audit log writes and queries                      |
| `data/`                    | `data_tables` + `data_rows` (the universal store) |
| `fonts.ts`                 | Font assets                                       |
| `loginAttempts.ts`         | Failed-login records for lockout                  |
| `media.ts`                 | Media assets                                      |
| `mediaFolders.ts`          | Folder tree for media                             |
| `mediaMigration.ts`        | Migration of media between storage adapters      |
| `mediaStorageAdapters.ts`  | Registered storage backends                       |
| `pluginSchedules.ts`       | Plugin-registered scheduled jobs                  |
| `plugins.ts`               | Installed plugins + lifecycle state               |
| `publish.ts`               | Published-page roster                             |
| `roles.ts`                 | System and custom roles                           |
| `runtimeAsset.ts`          | Published runtime assets (JS, CSS, fonts)         |
| `sessions.ts`              | User sessions                                     |
| `setup.ts`                 | Setup wizard state (`isSetup`, first-run owner)   |
| `site.ts`                  | The single site shell row                         |
| `userPreferences.ts`       | Per-user editor preferences                       |
| `users.ts`                 | Users + auth fields                               |

### Repository rules

1. **Repositories are dialect-naive.** They use ANSI-standard SQL only. The five Postgres-isms (`now()` in DML, `::int`, `::jsonb`, `any($N::...)`, `distinct on`) are banned in any file that imports `DbClient`. Gated by `db-postgres-isms.test.ts`.

2. **JSON columns end in `_json`.** The SQLite adapter auto-parses `*_json` strings on read and auto-stringifies plain objects on write — so repository code does the same `${jsObject}` interpolation regardless of dialect. Gated by `db-json-column-naming.test.ts`. See [docs/reference/database-dialects.md](reference/database-dialects.md).

3. **Repositories return typed rows.** Use `Row` generics on `db<Row>` calls so handlers don't `as Foo` results.

4. **Repositories validate persisted JSON.** Anything read from a `*_json` column passes through a TypeBox schema (e.g. `validateSite` for the site shell). The DB is not a trusted source — a previous migration or external tool may have written garbage.

5. **Transactions.** `db.transaction(async (tx) => { ... })` wraps a callback in a transaction. The callback receives a `DbClient` that scopes its queries to the transaction. Use it whenever a single request mutates multiple rows that must be consistent (e.g. batch upsert of pages).

---

## The `DbClient` interface

`server/db/client.ts`:

```ts
export type Dialect = 'postgres' | 'sqlite'

export interface DbClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>>
  unsafe<Row>(sql: string, params?: unknown[]): Promise<DbResult<Row>>
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>
  readonly dialect: Dialect
}

export interface DbResult<Row> {
  rows: Row[]
  rowCount: number
}
```

`DbClient` is callable as a tagged template:

```ts
const { rows } = await db<{ id: string }>`select id from users where email = ${email}`
```

Interpolations are bound as parameters in both dialects (`$1, $2, …` on PG; `?` on SQLite). The SQLite adapter additionally converts plain objects and arrays to JSON strings at bind time, so:

```ts
await db`insert into site (id, settings_json) values (${id}, ${settings})`
//                                                             ▲
//                                            JS object becomes JSON in SQLite, JSONB in PG
```

Same code, both engines.

### The two adapters

- **`server/db/postgres.ts`** wraps `Bun.sql` (native Bun Postgres client). `rowCount` is read from `result.count` (Bun's CommandComplete affected-row count) rather than `result.length`, which is always 0 for non-RETURNING writes.
- **`server/db/sqlite.ts`** wraps `bun:sqlite`, with four custom behaviors:
  1. `toBindable(value)` converts JS values (objects, dates, booleans, `Uint8Array`) to SQLite-bindable types.
  2. On read, any column ending in `_json` whose value is a non-empty string is auto-`JSON.parse`d.
  3. On boot, PRAGMAs are set: `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`, `busy_timeout = 5000`.
  4. Transaction serialization: concurrent `db.transaction()` calls are queued via a promise chain so `BEGIN` is never issued while another transaction is open on the single shared connection. This prevents "cannot start a transaction within a transaction" errors when transaction callbacks `await` async work.

Both adapters return the same `DbResult<Row>` shape, so callers never branch on dialect.

### Migrations

`server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts` hold the per-dialect migration list. Each migration is `{ id, label, statements: string[] }`. The two lists must have **identical IDs in the same order** — gated by `migration-parity.test.ts`. The PG version uses `jsonb`, `timestamptz`, `bigint`, `boolean`, `distinct on`; the SQLite version uses `text`, `text`, `integer`, `integer`, and window-function rewrites.

`server/db/runMigrations.ts` runs the migrations idempotently at boot, tracking applied IDs in a `_migrations` table.

See [docs/reference/database-dialects.md](reference/database-dialects.md) for the full rules.

### HA leader election

`server/db/advisoryLock.ts` owns the shared Postgres advisory-lock primitive used by every recurring tick loop:

```ts
await withSchedulerLeaderLock(db, LOCK_KEY, '[my-scheduler]', async () => {
  // Only one instance runs this body per tick.
})
```

`withSchedulerLeaderLock` issues `pg_try_advisory_lock(lockKey)` — returning the lock immediately or not at all. If this instance wins, it runs `fn` and releases the lock in a `finally` block. If another instance holds the lock, it returns `undefined` and the body is skipped.

Each tick loop passes its own distinct `lockKey` so the plugin scheduler and the publish scheduler don't contend with each other. On SQLite (single-instance by definition) the module catches the "no such function" error and returns a no-op sentinel — the body always runs.

The lock is **released between ticks**, so a crashed leader hands off naturally at the next interval. Tested by `server/db/__tests__/advisoryLock.test.ts` (unit, with a fake DbClient) and `server/__tests__/schedulers-advisory-lock.test.ts` (integration, against a real SQLite client).

---

## Publishing pipeline

Three-layer model: **static-by-default, dynamic-by-auto-detection**.

- **Layer A — static-to-disk.** **Every** page is baked at publish time. A fully-static page (no dynamic modules, no request-dependent bindings/loop sources, no VC refs to dynamic VCs) bakes a complete document; a page with dynamic nodes bakes its static **shell** with `<instatic-hole>` placeholders (the dynamic nodes are Layer C holes). HTML is written to `uploads/published/current/<route>.html`, and the CSS bundles (`/_instatic/css/…`) and runtime JS (`/_instatic/assets/…`) are baked into the same slot. The visitor router reads all of these directly off disk (`readArtefact` / `readStaticAsset`) — **a published page never touches the DB for HTML, CSS, or JS.** TTFB ≤ 1.5 ms.
- **Layer B — in-memory LRU.** Requests that vary by query string (loops with `?page=N`, request-dependent bindings) bypass the disk fast-path and render live, memoised by `(urlPath, queryString)`. Single-flight. Every publish bumps `publishVersion` so the entire cache evicts lazily. The version is captured at render start — if a publish lands before the factory resolves, the result is returned to the caller but not stored; the next request re-renders against the fresh snapshot.
- **Layer C — server islands ("holes").** When `findDynamicNodeIds(...)` classifies a node as dynamic (module flagged `dynamic: true`, or its bindings/loop source declare `requestDependent: true`, or it's a VC ref to a dynamic VC), the publisher emits a `<instatic-hole>` placeholder with an optional `staticPlaceholder(props)` skeleton. A ~668 B `IntersectionObserver` runtime fetches `/_instatic/hole/<nodeId>?v=<publishVersion>` lazily as the placeholder enters the viewport. **The hole fragment is the only request that reads the DB for an otherwise-static page.** Hole responses are cached via Layer B's LRU.

Authors don't toggle anything. `src/core/publisher/dynamicDetection.ts:findDynamicNodeIds` is backed by the single walker that powers Layer A's shell-vs-complete bake and Layer C's placeholder emission. The rules live in exactly one file.

```text
                            on publish
                                ↓
            publishDraftSite / publishDataRow
                                │
              ├── write SiteDocument once → site_snapshots
              │     (page versions reference it via site_snapshot_id)
              ├── for each page (complete doc, or static shell with <instatic-hole>):
              │     publishPage + applyPublishedHtmlPipeline
              │     writeArtefact(inactiveSlot, urlPath, html)
              ├── bake every published data-row route into the same slot
              │     (bakeDataRows.ts — entry-template render, same pipeline)
              ├── bake CSS bundles + runtime JS → writeStaticAsset(inactiveSlot)
              ├── swapSlot — atomic symlink rename of uploads/published/current
              └── bumpPublishVersion() — Layer B cache evicts lazily

                          on visitor request
                                ↓
            server/router.ts → tryServePublicRoute
                                ↓
                  renderPublicResolution(db, url, uploadsDir)
                                │
       ┌────────────────────────┼────────────────────────────┐
       ▼                        ▼                            ▼
  Layer A disk           resolvePublicRoute             (page contains holes)
  readArtefact            page / row / redirect          /_instatic/hole/<id>?v=<ver>
  (only if no ?           / not-found                    handled by
  query string)                  │                       server/handlers/cms/hole.ts
       │                  ┌──────┴───────┐                     │
   hit → stream    redirect → 301  page/row → Layer B          ▼
                                          getOrRender         render one node
                                          (LRU + single-      cached in Layer B
                                           flight + version)
```

Server-side publishing helpers live in `server/publish/`:

| File                              | Role                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `publicRouter.ts`                 | Visitor URL → resolution → Response. Composes Layer A disk-read + Layer B cache. Single entry for every visitor HTML request. |
| `staticArtefact.ts`               | Layer A. Two-slot symlink swap (`current → slot-{a,b}`), atomic per-file `tmp + rename`, slot-aware read/write/purge. |
| `renderCache.ts`                  | Layer B. Bounded LRU keyed by `(urlPath, queryString)`, entries versioned. Single-flight on cache miss. `bumpPublishVersion()` invalidates lazily; version captured at render start so mid-flight publishes discard without caching stale HTML. |
| `holeRuntime.ts`                  | Layer C client-side runtime (~668 B). Exports `runInstaticHoleRuntime` (TS source) and `HOLE_RUNTIME_JS` (IIFE-serialized for browser delivery). |
| `publicRenderer.ts`               | `renderPublishedSnapshot`, `renderPublishedDataRowTemplate` — snapshot-aware wrappers around `publishPage`. |
| `publishedHtmlPipeline.ts`        | Plugin frontend-asset injection + `publish.html` filter chain. Runs at publish time for every baked page (complete doc or hole shell); also runs in the Layer B factory for query-string / live renders (cached). |
| `siteCssBundle.ts`                | Per-site reset / framework / style CSS bundles (hashed filenames).  |
| `republish.ts`                    | Bulk re-publish (after a settings change touches all pages).        |
| `publishScheduler.ts`             | Scheduled publish jobs.                                             |
| `frontendInjections.ts`           | Plugin-contributed frontend scripts injected into published HTML.   |
| `mediaPresentation.ts`            | `<picture>` / `<img srcset>` materialization at publish time.       |
| `mediaPrefetch.ts`, `loopPrefetch.ts` | Pre-warm caches needed by published pages.                      |
| `runtime/packageServer.ts`        | Serve per-site `bun install` workspace under `/_instatic/runtime/cache/`. |

Plus the hole endpoint at `server/handlers/cms/hole.ts` — registered in the router BEFORE `tryServePublicRoute` so `/_instatic/hole/*` requests never fall through to slug resolution.

Published pages are HTML + a single hashed CSS bundle per page. The ONLY first-party client script is the Layer C hole runtime, and it's injected ONLY on pages that contain at least one `<instatic-hole>`. Fully-static pages ship zero JS from us. Plugins can inject frontend assets explicitly via `frontendInjections.ts`.

For the full design including invariants, atomic-publish protocol, and the auto-detection rules, see [docs/features/publisher.md](features/publisher.md).

---

## Plugin runtime

Plugins ship as zip packages with a `plugin.json` manifest. The host:

1. **Installs** the package (unzips into `uploads/plugins/<id>/<version>/`) — `server/plugins/package.ts`.
2. **Validates** the manifest and scans the bundled JS for forbidden sandbox-incompatible patterns — `assertSandboxSafe` in `package.ts` + `parsePluginManifest` in `src/core/plugins/manifest.ts`.
3. **Activates** the plugin at boot or on user action — `server/plugins/runtime.ts`. Activation loads the server entrypoint into a per-plugin QuickJS-WASM VM (`server/plugins/quickjs/vm.ts`) and runs its `activate(api)` lifecycle hook.
4. **Routes** plugin-registered HTTP routes through `/admin/api/cms/plugins/<id>/runtime/…` (handled by `handleRuntimeRoutes`).
5. **Brokers** the SDK boundary — `api.cms.routes.*`, `api.cms.storage.*`, `api.cms.hooks.*`, `api.cms.loops.*`, `api.cms.settings.*`, `api.cms.schedule.*`. The SDK shape is defined in `src/core/plugin-sdk/`.

The sandbox has **no host access** — no Node, no Bun, no file system, no env vars, no network unless `network.outbound` permission + `networkAllowedHosts` allowlist is granted.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`. Module-pack VMs (canvas-side plugin modules) run in `modulePackVm.ts`.

See [docs/features/plugin-system.md](features/plugin-system.md) for the full feature doc.

---

## Static serving

Three static handlers, in order:

| Handler                | Owns                                                                  |
|------------------------|-----------------------------------------------------------------------|
| `tryServeStaticAsset`  | `/assets/*` from `dist/` (Vite-built admin SPA assets)                |
| `tryServeUpload`       | `/uploads/*` from `uploadsDir` with `hardenUploadResponse` (nosniff, attachment for non-inert MIMEs, CORS for plugin bundles) |
| `tryServeAdminApp`     | `/admin/*` — serves the admin shell from `dist/index.html` with path-specific injections (see below) |

`server/static.ts` owns all three. Key behaviors:

- **Range requests** are honored for media (`Range: bytes=...`).
- **Conditional GET** via `If-None-Match` / `If-Modified-Since` is honored.
- **MIME-type allowlist** (`INERT_UPLOAD_MIMES`) — non-allowlisted uploads get `Content-Disposition: attachment` so they can't be top-level navigated and rendered as HTML on the admin origin.
- **Plugin bundles** (`/uploads/plugins/*`) get `Access-Control-Allow-Origin: *` because the editor preview iframe loads them from an opaque origin (`sandbox="allow-scripts"` without `allow-same-origin`).
- **Admin shell path-specific serving** (`serveAdminApp`): the two visitor paths inject different content into the shell HTML to minimize perceived load time:
  - **Unauthenticated** (no session cookie): injects a styled login skeleton into `<div id="root">` and a `BOOT_API_KICKOFF` inline script that fires `setupStatus`, `/me`, and `publicSite` fetches at HTML-parse time. FCP shifts from ~400 ms (React mount) to ~DCL (~50 ms), and `useAdminBoot` finds pre-resolved promises instead of waiting for `useEffect`.
  - **Authenticated**: keeps the existing spinner shell, but injects `BOOT_API_KICKOFF`, an `__instaticAuthed = 1` flag (lets `main.tsx` skip the post-Suspense concurrent re-render delay), and `<link rel="modulepreload">` hints for the authenticated shell chunk (`AuthenticatedAdmin-*.js`). Only the shell chunk is preloaded here; workspace-page pre-warming is handled in `AuthenticatedAdmin` via `requestIdleCallback` after first paint.

---

## Adding a new endpoint

1. **Pick the right layer.**
   - CMS resource (e.g. `/admin/api/cms/feature`) → new handler file in `server/handlers/cms/feature.ts`, register in `server/handlers/cms/index.ts`.
   - Top-level (e.g. `/_instatic/something`) → new `tryServeX` in `server/router.ts`, add to the `routes` array in the right order.

2. **Write the handler.** Require capability → validate body → call repository → return `jsonResponse`. One function per route. Add a `Route` entry to the group's `ROUTES` table; path matching and 404/405 discrimination are handled by `runRouteTable` — do not hand-roll `if (url.pathname !== ...)` or `return methodNotAllowed()` in the handler itself. Parameterised paths use a `RegExp` with named capture groups; the dispatcher decodes each captured value once.

3. **If new SQL is needed,** add the function to the matching `server/repositories/<resource>.ts`. Do not write SQL inside the handler.

4. **If new persisted shape is involved,** add the migration to both `migrations-pg.ts` and `migrations-sqlite.ts` with the same ID. JSON columns end in `_json`. Run `bun test src/__tests__/architecture/migration-parity.test.ts` and `db-json-column-naming.test.ts` to confirm.

5. **If client-side calls the endpoint,** add a TypeBox response schema (in `src/core/persistence/responseSchemas.ts` for CMS endpoints, or alongside the caller) and fetch via the canonical `apiRequest(path, { schema })` from `@core/http`. Persistence-layer functions that inject their own `fetch` validate via `readEnvelope`.

---

## Adding a new repository

1. Create `server/repositories/<resource>.ts`. Export typed functions: `listX`, `getX(id)`, `createX(...)`, `updateX(id, patch)`, `deleteX(id)`.
2. Use ANSI-standard SQL only. No Postgres-isms.
3. JSON columns must end in `_json`. Interpolate plain JS objects via `${obj}` — both adapters handle the conversion.
4. Use `db.transaction(async (tx) => ...)` for multi-row writes that must be atomic.
5. Validate any JSON read from disk with a TypeBox schema before returning it.

---

## Error handling

- **Server logs** use the prefix `console.error('[<module>]', err)` — e.g. `'[router] adapter "<id>" getReadUrl failed:'`, `'[server] Unhandled request error:'`.
- **Domain errors** are typed `Error` subclasses with a `path` (or similar) field — e.g. `SiteValidationError`, `VisualComponentNameError`. Add a typed class when callers need to distinguish causes.
- **Generic `throw new Error(...)`** is fine for "this should never happen" invariants.
- **Never echo raw error messages to the client.** The top-level catch in `server/index.ts` returns a generic 500. Handlers return `{ error: <safe message> }`.
- **`catch (err)` → client error string:** use `getErrorMessage(err, 'fallback message')` from `src/core/utils/errorMessage.ts`. The hand-rolled `err instanceof Error ? err.message : 'fallback'` pattern is forbidden because it surfaces a blank string for `new Error('')` — `getErrorMessage` falls back when the message is empty or whitespace-only.

See [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) for boundary validation patterns.

---

## Related

- [docs/architecture.md](architecture.md) — system overview
- [docs/editor.md](editor.md) — what the admin / editor frontends do
- [docs/features/plugin-system.md](features/plugin-system.md) — plugin runtime details
- [docs/reference/database-dialects.md](reference/database-dialects.md) — PG vs SQLite rules
- [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `server/index.ts` — entrypoint and boot
  - `server/router.ts` — request dispatch
  - `server/http.ts` — JSON / error HTTP helpers
  - `server/binary.ts` — binary response helpers (`toArrayBuffer`, `binaryResponse`)
  - `src/core/utils/errorMessage.ts` — `getErrorMessage(err, fallback)` canonical catch-block extractor
  - `server/handlers/cms/index.ts` — CMS dispatcher
  - `server/handlers/cms/routeTable.ts` — shared `runRouteTable` dispatcher (404-vs-405 rule, named param decoding)
  - `server/auth/authz.ts` — `requireCapability` and friends
  - `server/db/client.ts` — `DbClient` interface
  - `server/db/index.ts` — adapter selection
  - `server/db/postgres.ts`, `server/db/sqlite.ts` — adapters
  - `server/db/migrations-pg.ts`, `server/db/migrations-sqlite.ts` — schemas
- Gate tests:
  - `src/__tests__/architecture/db-postgres-isms.test.ts`
  - `src/__tests__/architecture/db-json-column-naming.test.ts`
  - `src/__tests__/architecture/migration-parity.test.ts`
  - `src/__tests__/architecture/cms-handlers-capability-gated.test.ts` — every file under `server/handlers/cms/` calls an auth guard; allowlist entries carry explicit justifications
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/server/routeTable.test.ts` — unit coverage of `runRouteTable`: dispatch, named params, 405 vs null, extra context forwarding, real-world patterns (data rows, plugins)
