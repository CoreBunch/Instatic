# Plugin System

End-to-end description of the plugin system: what plugins are, how they ship, how they run sandboxed, what they can do, and how to author them.

A plugin is a zip package containing a `plugin.json` manifest and one or more JavaScript entrypoints. The CMS host loads installed plugins at boot and runs the server entrypoint inside a **QuickJS-WASM sandbox** — no Node, no Bun, no host file system, no environment variables, no network unless explicitly granted. Plugins reach the CMS through one SDK surface: `api.plugin.*` and `api.cms.*`.

---

## TL;DR

- **Package shape:** a zip containing `plugin.json` plus entrypoint bundles (`server/index.js`, `editor/index.js`, `admin/dashboard.js`, `modules/index.js`, `frontend/*.js`, optional `pack/site.json`).
- **Runtime:** server entrypoint runs in **QuickJS-WASM** (`server/plugins/quickjs/vm.ts`). Canvas module packs run in a separate QuickJS VM (`server/plugins/modulePackVm.ts`). No host APIs leak.
- **SDK:** every API call goes through `api` — `api.plugin.*` for plugin metadata + logging, `api.cms.*` for routes, storage, hooks, loops, settings, schedule, pages.
- **Lifecycle:** `install` → `activate` → (optionally `deactivate` / `migrate`) → `uninstall`. Each hook is async-capable and isolated; if one throws, the host rolls back and parks the plugin in `error`.
- **Permissions:** declared in `plugin.json`, approved by the site owner at install time, enforced by the SDK at runtime. Outbound network also requires `networkAllowedHosts` allowlist.
- **CLI:** `bun instatic-plugin init|lint|build|dev` covers scaffolding, sandbox validation, bundle build, and hot-sync to a running CMS.
- **Source of truth for permissions:** `src/core/plugin-sdk/capabilities.ts`. Source of truth for manifest shape: `src/core/plugins/manifest.ts`.

---

## Where the code lives

| Concern                        | Lives in                                  |
|--------------------------------|-------------------------------------------|
| SDK (author-facing API surface)| `src/core/plugin-sdk/`                    |
| `instatic-plugin` CLI                | `src/core/plugin-sdk/cli/`                |
| Manifest schema + parser       | `src/core/plugins/manifest.ts`            |
| Admin-page route helpers       | `src/core/plugins/manifestAdminPages.ts`  |
| Host-side plugin runtime       | `src/core/plugins/`                       |
| Lifecycle event schema + types | `src/core/plugins/events.ts`              |
| Sandbox host (server entrypoint)| `server/plugins/quickjs/vm.ts`           |
| Sandbox host (module pack VMs) | `server/plugins/modulePackVm.ts`          |
| VM bootstrap source (typed)    | `server/plugins/quickjs/bootstrap/src/`   |
| VM bootstrap generated artifacts | `server/plugins/quickjs/bootstrap/generated/` (run `bun run bootstrap:sync`) |
| Gated outbound fetch + SSRF guards | `server/plugins/host/network.ts`       |
| Byte-safe body wire format     | `server/plugins/protocol/bodyEncoding.ts` |
| Route request/response I/O     | `server/plugins/host/routeIo.ts`          |
| Plugin asset path containment      | `server/util/pathWithin.ts`            |
| Plugin lifecycle (boot, install, activate, uninstall) | `server/plugins/runtime.ts`, `package.ts` |
| Plugin scheduler               | `server/plugins/scheduler.ts`             |
| Event broadcaster (server fan-out) | `server/plugins/eventBroadcaster.ts`  |
| SSE event endpoint             | `server/handlers/cms/plugins/events.ts`   |
| HTTP route forwarder           | `server/plugins/runtime.ts` (`handleServerPluginRuntimeRequest`) |
| Plugin pages in admin          | `src/admin/pages/plugins/`                |
| SSE event stream (client)      | `src/admin/pages/plugins/utils/pluginEventStream.ts` |
| Admin shell event bridge hook  | `src/admin/pages/plugins/hooks/usePluginEventBridge.ts` |
| Plugin host UI primitives      | `src/admin/plugin-host-ui/`               |
| Plugin host React hooks        | `src/admin/plugin-host-hooks/`            |
| Example template plugin        | `examples/plugins/template/`              |
| Installed plugins on disk      | `uploads/plugins/<id>/<version>/`         |

---

## Package shape

A plugin zip extracted on disk looks like:

```text
plugin.json
server/index.js          ← server entrypoint
editor/index.js          ← editor entrypoint (optional)
admin/dashboard.js       ← admin pages entrypoint (optional)
modules/index.js         ← canvas module pack (optional)
frontend/tracker.js      ← published-page asset (optional)
pack/site.json           ← Visual Components / pages / classes pack (optional)
assets/                  ← static assets shipped in the zip (optional)
```

All `.js` entrypoints are pre-bundled IIFEs that assign to a host-recognized global (`__plugin_exports` for the server entrypoint, `__module_pack` for module packs). `bun instatic-plugin build` produces them. The host scans the bundle for forbidden literals before activation.

---

## Manifest (`plugin.json`)

```jsonc
{
  "id": "acme.workflow",                        // namespaced, lowercase
  "name": "Workflow",                           // display name
  "version": "1.0.0",                           // semver-like
  "apiVersion": 1,                              // only `1` currently
  "description": "Approval workflow for posts.",

  "permissions": [
    "cms.routes",
    "cms.storage",
    "cms.hooks",
    "admin.navigation",   // required by adminPages[]
    "editor.code",        // required by entrypoints.editor (unsandboxed admin-window code)
    "modules.register"    // required by entrypoints.modules
  ],

  "entrypoints": {
    "server":  "server/index.js",
    "editor":  "editor/index.js",
    "admin":   "admin/dashboard.js",
    "modules": "modules/index.js"
  },

  "resources": [
    { "id": "approvals", "label": "Approvals", "fields": [/* … */] }
  ],

  "adminPages": [
    { "id": "dashboard", "label": "Approval Queue", "icon": "checkmark" }
  ],

  "settings": [
    { "id": "apiKey", "type": "string", "label": "API key", "secret": true }
  ],

  "frontend": {
    "assets": [
      { "kind": "script", "src": "frontend/tracker.js",
        "placement": "body-end", "strategy": "defer" }
    ]
  },

  "networkAllowedHosts": [
    "api.weather.example.com",
    "*.cdn.weather.example.com"
  ],

  "pack": { "path": "pack/site.json" }
}
```

### ID rules

| Where the ID appears        | Rule                                                       | Examples                  |
|-----------------------------|------------------------------------------------------------|---------------------------|
| `plugin.json` top-level `id`| Namespaced, lowercase (`vendor.product[.subname]`)         | `acme.workflow`           |
| `resources[].id`, `adminPages[].id` | URL path segment — lowercase kebab-case             | `seo-entries`, `subscribers` |
| `resources[].fields[].id`   | JSON key — any common identifier convention                | `email`, `subscribedAt`   |
| Pack `classes[].id`         | Namespaced under the plugin ID                             | `acme.workflow/hero-root` |

`parsePluginManifest` validates all of these and produces a clear error message. `bun instatic-plugin lint` runs the same checks before upload.

---

## Lifecycle

```text
Fresh install:    install → activate
Disable:          deactivate
Enable again:     activate
Upgrade to v2:    (old) deactivate → (new) migrate({fromVersion}) → (new) activate
Uninstall:        (if active) deactivate → uninstall
```

Each hook receives the `api` object (see below). All hooks may be sync or async. If any hook throws, the host:

1. Rolls back to the previous lifecycle state.
2. Records the error in the plugin row's `lastError`.
3. Sets `lifecycleStatus = 'error'`.

| Status       | Meaning                                                                          |
|--------------|----------------------------------------------------------------------------------|
| `installed`  | Package on disk, `install` succeeded, `activate` not run yet.                    |
| `active`     | Plugin enabled, `activate` succeeded, routes/hooks/loops live.                   |
| `disabled`   | Plugin disabled by the owner (`deactivate` succeeded if exported).               |
| `error`      | A hook threw or the worker crashed past its budget. `lastError` carries details. |

### Hook signatures

```js
export function install(api)        {}
export function activate(api)       {}
export function deactivate(api)     {}
export function uninstall(api)      {}
export function migrate(ctx, api)   {} // ctx = { fromVersion: '1.0.0' }
```

### Force-uninstall

A throwing (or unloadable) hook must never be able to block removal permanently. When a normal uninstall fails on a hook error, the plugin stays installed (parked in `error` with `lastError` set) and the response says force-remove is available. `DELETE /admin/api/cms/plugins/:id?force=true` skips the lifecycle hooks entirely and tears everything down anyway: the worker, canvas modules, the DB row (settings live on it; records and schedules cascade via FK), crash events and schedule run history (no FK — swept explicitly), and the plugin's whole `uploads/plugins/<id>/` tree, including stale version dirs left behind by interrupted upgrades. The same teardown serves corrupt-manifest plugins, which have no valid code to run hooks on.

The admin UI offers force-removal as "Remove anyway" after a failed uninstall, behind an explicit confirmation that warns the plugin's own cleanup code is skipped — external resources the plugin set up (webhooks, third-party registrations) may remain. Capability and step-up requirements are identical to a normal uninstall (`plugins.install` + step-up); the audit event carries `forced: true`.

### Crash recovery

Each plugin's server entrypoint runs in its own worker. If the worker crashes:

1. The host logs `[plugin:<id>]` and records a `plugin_crash_events` row.
2. The worker is terminated. Sibling plugins are unaffected.
3. The host auto-respawns the worker and re-runs `activate`.
4. If the same plugin crashes more than `CRASH_THRESHOLD` (3) times within `CRASH_WINDOW_MS` (5 minutes), auto-respawn stops and the plugin is parked in `error`. The owner restarts it manually from the Plugins admin page.

### Lifecycle events (SSE)

Every lifecycle transition broadcasts a named SSE event to every connected admin tab. The admin UI uses these for real-time feedback (toasts, badge, live list refresh) without polling.

**Event flow:**

```text
Plugin worker host / install handler
  → broadcastPluginEvent(event)                   server/plugins/eventBroadcaster.ts
  → ReadableStream SSE frame (event: <kind>)      server/handlers/cms/plugins/events.ts
  → GET /admin/api/cms/plugins/events
  → pluginEventStream.ts (frame validated)        src/admin/pages/plugins/utils/
  → usePluginEventBridge (toast / badge)          src/admin/pages/plugins/hooks/
```

**Event kinds**, derived from `PluginEventSchema` in `src/core/plugins/events.ts`:

| Kind         | Trigger                                | Admin effect                         |
|--------------|----------------------------------------|--------------------------------------|
| `crash`      | Worker crashed, within budget          | Warning toast                        |
| `recovered`  | Auto-respawn succeeded                 | Clears in-error badge                |
| `parked`     | Crash budget exhausted                 | Error toast + in-error badge         |
| `restarted`  | Owner restarted manually               | Clears in-error badge                |
| `installed`  | Plugin installed                       | Re-fetches plugin list               |
| `updated`    | Plugin updated to a new version        | Re-fetches plugin list               |
| `uninstalled`| Plugin removed                         | Re-fetches plugin list               |
| `enabled`    | Plugin enabled                         | Re-fetches plugin list               |
| `disabled`   | Plugin disabled                        | Clears in-error badge                |

`src/core/plugins/events.ts` is the single source of truth. Both the server broadcaster and the client stream derive their `PluginEvent` type from `Static<typeof PluginEventSchema>` — there is no parallel hand-written union.

The client-side `EventSource` connection is lazy: it opens on the first subscriber and closes when the last one unsubscribes. Every incoming frame is validated with `safeParseValue(PluginEventSchema, JSON.parse(frame.data))` before dispatch — malformed frames are dropped with a `console.warn`. The server sends an initial `ping` event on connect and a `': heartbeat'` SSE comment every 30 s to keep proxies from idle-closing the long-lived connection.

---

## The sandbox

Plugin server code and canvas module packs run inside QuickJS compiled to WebAssembly. The sandbox is a separate JavaScript engine — it has its own globals, its own runtime, no FFI, no syscalls.

### What is NOT sandboxed — `editor.code`

Editor entrypoints (`entrypoints.editor`) and app-kind admin pages (`adminPages[].content.kind === "app"`) are **not sandboxed**. The host dynamically `import()`s those bundles into the main admin window, where they run with the same privileges as the admin UI itself: every admin API with the operator's session cookie, browser storage, the full DOM. This is deliberate — editor extensions need real React and real host UI — but it is a categorically different trust level than the QuickJS surfaces.

That trust level is gated by one permission: **`editor.code`** (risk: dangerous).

- The manifest parser rejects an editor entrypoint or app-kind admin page that doesn't declare `editor.code` (`parsePluginManifest` coherence checks; `instatic-plugin lint` reports the same error pre-upload).
- The editor loader (`src/core/plugins/editorPluginLoader.ts`) refuses to import an editor entrypoint without the `editor.code` *grant*, and records a visible "permission not granted" failure on the plugin card instead of skipping silently. Module packs get the same treatment for `modules.register`.
- The admin-app loader (`src/core/plugins/adminRuntime.ts`) refuses to import an app page without the grant; the page body renders the refusal.
- `adminPages[].content.assetPath` is pinned to the plugin's own `/uploads/plugins/{id}/{version}` subtree so a manifest can't point the dynamic import at foreign code.
- The install review dialog (always shown — even for zero-permission plugins) calls out `editor.code` with a dedicated unsandboxed-code warning.

Inside the admin window, plugin React surfaces (panels, app pages, canvas overlays) mount under a `PluginContext` carrying the granted permission set; permission-gated host hooks enforce against it — `useEditorStore` from `@instatic/host-hooks` requires `editor.store.read` and exposes no write accessor (writes go through `api.editor.store.transaction`, which requires `editor.store.write`).

### What's available inside

- **The SDK** — `api.plugin.*` and `api.cms.*` (see next section).
- **Standard JavaScript** — `JSON`, `Math`, `Date`, `Promise`, `async`/`await`, `Map`, `Set`, `WeakMap`, `WeakSet`, ES2020+ syntax (optional chaining, nullish coalescing, BigInt literals).
- **`console.{log, info, warn, error, debug, trace}`** — routes to `api.plugin.log`.
- **`fetch(url, init)`** — opt-in: requires `network.outbound` permission AND the URL host on the `networkAllowedHosts` allowlist. Byte-safe: `arrayBuffer()` returns exact bytes; request bodies accept `string | ArrayBuffer | TypedArray/DataView`.

### What's denied

These produce a build-time error and a runtime error if attempted:

| Forbidden                                | Replacement                                          |
|------------------------------------------|------------------------------------------------------|
| `import 'node:fs'`, any `node:*`         | `api.cms.storage.*` for plugin data                  |
| `import 'bun:*'`                         | The SDK                                              |
| `Bun.spawn`, `Bun.connect`, `Bun.serve`, `Bun.sql`, `Bun.write`, `Bun.$` | `api.cms.hooks.emit` / `api.cms.storage.*` |
| `process.env`, `process.exit`, `process.binding` | `api.cms.settings.*`                          |
| `require()`                              | ES module imports (resolved at build time)           |
| `globalThis.fetch` without permission    | Declare `network.outbound` + `networkAllowedHosts`   |
| `WebSocket`, `XMLHttpRequest`            | Not in the VM                                        |
| `eval`, `new Function(...)`              | Blocked                                              |

### Three layers of enforcement

1. **`instatic-plugin build`** emits IIFE bundles and scans for the forbidden literals above.
2. **`instatic-plugin lint`** runs the same scan plus manifest + permission/allowlist coherence checks. Run this before upload.
3. **Install handler** (`server/plugins/package.ts → assertSandboxSafe`) scans **again** when the zip is uploaded — defense in depth in case the dev skipped `lint`.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`.

### Resource limits and timeouts

VM budgets live in `server/plugins/quickjs/limits.ts`; the host-side RPC timeout lives in `server/plugins/host/workerPool.ts`.

| Limit | Value | Enforced by |
|---|---|---|
| VM heap | 64 MB (`DEFAULT_MEMORY_LIMIT_BYTES`) | QuickJS `setMemoryLimit` — allocations beyond it throw inside the VM |
| VM stack | 1 MB (`DEFAULT_STACK_SIZE_BYTES`) | QuickJS `setMaxStackSize` — fatal for runaway recursion |
| Eval deadline | 5 s (`DEFAULT_EVAL_TIMEOUT_MS`) | wall-clock interrupt on the QuickJS runtime |
| Module-pack eval deadline | 2 s (`MODULE_PACK_EVAL_TIMEOUT_MS`) | same interrupt — canvas `render()`/`preview()` are pure sync transforms |
| Schedule fire | the schedule's `maxDurationMs` (host-capped at 5 min) | replaces the 5 s eval budget for that one call |
| Worker RPC | 30 s (`DEFAULT_RPC_TIMEOUT_MS`); schedule runs get `maxDurationMs` + 10 s slack | host-side timeout in `requestFromWorker` |

**The eval deadline covers every way plugin code can execute.** Each entry into VM execution — the bootstrap eval, the plugin bundle's top-level eval, every `__run*` dispatch (lifecycle, route, hook, loop, schedule, media), and the pending-jobs pump that runs timer callbacks (`setTimeout`/`setInterval` continuations) — registers a wall-clock deadline in a per-runtime registry (`server/plugins/quickjs/eval.ts`). One persistent interrupt handler aborts the runtime once the clock passes the latest active deadline, so concurrent evals on one context cannot strip each other's protection and a `while (true) {}` anywhere (top level, route handler, timer callback) is interrupted instead of wedging the worker thread.

**What the plugin author sees on a deadline hit:** the call fails with QuickJS's `interrupted` error — schedule runs record it as `status: 'timeout'`, every other entry point surfaces it as an ordinary error (lifecycle failure, route 500, hook listener log line). Plugins that legitimately need more time should yield back to the host (await host calls, split work across schedule fires) rather than block in a tight loop.

**The worker RPC timeout is the backstop for a truly wedged worker.** A worker that hangs never *crashes*, so without it the awaiting HTTP request or publish render would hang forever and crash recovery would never engage. When `requestFromWorker` times out, the call rejects with `Plugin "<id>" did not respond to <kind> within <ms>ms` and the worker goes through the same teardown as a crash (`handleWorkerCrash`): terminated, sibling pending calls rejected, host-side registrations dropped, a crash event recorded for the admin UI, and the sliding-window counter decides auto-respawn vs parking the plugin in `error` state.

**Error stacks:** VM errors keep their QuickJS stack frames (plugin bundles are evaluated with the filename `plugin:<id>`, and the ESM shim adds zero line offset, so frames map 1:1 onto the shipped bundle). The frames travel worker→host on the optional `stack` field of the `*-result` protocol messages and appear in `[plugin:<id>]` server logs only — HTTP responses and API replies carry just the error message.

### The VM bootstrap (and how to regenerate it)

Before any plugin code runs, the host evaluates a **bootstrap** program inside the
VM: Web-Platform polyfills (URL, TextEncoder, console, AbortController, timers,
crypto.subtle, fetch) plus the SDK factory `__buildApi()` and the `__run*`
dispatchers the host calls to drive plugin code. QuickJS has no module loader, so
this bootstrap must reach the VM as a single source **string** — but that string
is a build artifact, not the authoring surface.

- **Authored** as real, typed, lintable TypeScript under
  `server/plugins/quickjs/bootstrap/src/` — `pluginRuntime.ts` (full plugin VM),
  `modulePackRuntime.ts` (canvas module-pack VM), and the shared host⇄VM JSON
  marshaling in `boundary.ts`. Host-injected globals (`__hostCall`, `__plugin_meta`,
  …) are declared in `globals.d.ts`.
- **Bundled** to committed IIFE-string artifacts under
  `server/plugins/quickjs/bootstrap/generated/` by `scripts/sync-plugin-bootstrap.ts`
  (via `Bun.build`). The shared `boundary.ts` is inlined into both — one
  source-level definition, no divergent inline copies.
- **Consumed** by `bootstrap/index.ts` (concatenated after the polyfill shims for
  the full-plugin VM) and `modulePackVm.ts` (module-pack VM).

**Regenerate after editing anything under `bootstrap/src/`:**

```sh
bun run bootstrap:sync     # rewrite the generated artifacts
bun run bootstrap:check    # CI-style drift check (no writes)
```

The architecture gate `src/__tests__/architecture/plugin-bootstrap-fresh.test.ts`
re-bundles in memory and fails if the committed artifact drifts from its source —
the same pattern as `vendor-icons-fresh.test.ts` for vendored icons. The eval
boundary is unavoidable; the authoring surface is not.

### VM lifecycle and disposal

Each `activateSandboxedPluginModulePack` call constructs one QuickJS context via `createModulePackVm` and registers it in `packsByPlugin` (`src/core/plugins/modulePackLoader.ts`). The emscripten runtime backing the QuickJS WASM is **not reclaimed by JS GC** — explicit disposal is mandatory.

`deactivatePluginModulePack` disposes the tracked VM (if any) before unregistering modules, and before installing the replacement on re-activation. `resetPluginModulePacks` (called on server reload) disposes every live VM. Without this discipline each activate/upgrade/restart cycle leaks one native context for the host-process lifetime.

The browser editor path (`activatePluginModulePack`) evaluates the pack in the browser's own JS engine and registers no VM, so `packsByPlugin` stays empty on that path and dispose is a no-op.

### Disk-path containment

Every server-side read of a plugin's on-disk files goes through `assertPathWithin(uploadsDir, resolvedPath)` from `server/util/pathWithin.ts` before any `readFile` or `rm` is issued. This covers:

- Server entrypoint resolution (`resolvePluginServerEntrypoint` in `server/plugins/runtime.ts`)
- Module pack resolution (`loadPluginModulePack` in `server/plugins/runtime.ts`)
- Pack file loading (`loadPluginPackFile` in `server/plugins/pack.ts`)
- Asset removal (`removePluginAssets` in `server/handlers/cms/plugins/shared.ts`)

`assertPathWithin` checks that the final resolved path is strictly inside `uploadsDir` — no `..` escape, no absolute path outside the root, and not the root itself. It throws on any violation, which the caller surfaces as a lifecycle error. This is defense-in-depth: the manifest parser and schema already reject traversal in `assetBasePath`, but `path.join` can still produce an escaping path if a stored manifest is corrupted or a schema rule is regressed.

---

## The `api` object

Every lifecycle hook receives one `api` object. Its surface:

### Plugin metadata + logging

```js
api.plugin.id              // 'acme.workflow'
api.plugin.version         // '1.0.0'
api.plugin.permissions     // ['cms.routes', 'cms.storage']
api.plugin.log(...args)    // routes to host's [plugin:<id>] logger
api.plugin.assetUrl(p)     // '/uploads/plugins/<id>/<version>/<path>'
```

### CMS routes — requires `cms.routes`

```js
api.cms.routes.get('/status', 'plugins.manage', handler)       // capability-gated
api.cms.routes.post('/action', 'plugins.manage', handler)
api.cms.routes.patch('/item/:id', 'plugins.manage', handler)
api.cms.routes.delete('/item/:id', 'plugins.manage', handler)
api.cms.routes.authenticated.get('/me', handler)               // any logged-in user
api.cms.routes.public.post('/subscribe', handler)              // anonymous — also requires cms.routes.public
```

Routes mount under `/admin/api/cms/plugins/<id>/runtime/*`. The host enforces the admin session check + the declared capability before invoking the handler. Handlers receive `{ req, body, user }`. The `user` is `null` for public routes.

Request bodies are **byte-safe end to end**. The host reads the incoming body once as raw bytes and carries it to the sandbox tagged `utf8` (text verbatim) or `base64` (binary), so `req.text()` / `req.json()` decode correctly (including multibyte UTF-8) and `req.arrayBuffer()` returns the exact payload bytes. Pre-parsed `body` fields cover `application/json`, `application/x-www-form-urlencoded` (repeated keys become arrays), and `multipart/form-data` — text fields arrive as strings, file fields as uploaded-file facades (`{ name, type, size, arrayBuffer(), text() }`) whose bytes are uncorrupted, so plugins can accept image/PDF uploads. (De)serialization lives in `server/plugins/host/routeIo.ts`; the wire codec in `server/plugins/protocol/bodyEncoding.ts`.

Custom responses (status, headers, non-JSON bodies) use the raw-response escape hatch: return `{ __response: true, status, headers, body }` instead of a plain object. `body` accepts a string (sent as UTF-8 text) or an `ArrayBuffer` / TypedArray / `DataView` (sent byte-exactly — serve images, zips, PDFs directly); anything else throws a `TypeError`.

### Plugin-owned records — requires `cms.storage`

```js
const items = api.cms.storage.collection('items')
const all   = await items.list()
const one   = await items.get(id)
const made  = await items.create({ title: 'Draft', status: 'pending' })
await items.update(made.id, { status: 'approved' })
await items.delete(made.id)
```

Plugin storage is per-plugin, per-collection. The collection name must match a `resources[].id` declared in the manifest.

### CMS hooks — requires `cms.hooks`

```js
api.cms.hooks.on('publish.after', async (event) => { /* … */ })
api.cms.hooks.filter('publish.html', async (html) => html + '<!-- plugin -->')
const name = await api.cms.hooks.emit('sync.done', { /* … */ })
// name === 'plugin.<your-plugin-id>.sync.done'
```

**Host-emitted events** (the reserved core list, `CORE_HOOK_EVENTS` in `src/core/plugins/hookBus.ts`): `publish.before`, `publish.after`, `content.entry.created`, `content.entry.updated`, `content.entry.deleted`, `settings.changed`. **Filters**: `publish.html`, `publish.headers`, `content.entry.cells`.

**Plugin emits are namespaced.** The host rewrites every `emit('<name>', …)` to `plugin.<your-plugin-id>.<name>` (a name already in your own namespace passes through unchanged), so event provenance is unforgeable — a plugin cannot fire `content.entry.created` or any other core event at other listeners, and emitting a name in *another* plugin's namespace (`plugin.<other-id>.*`) is rejected with an error. `emit` resolves to the canonical namespaced name. Cross-plugin eventing still works: subscribing is unrestricted, so a plugin listens to another plugin's events by their full namespaced name, e.g. `api.cms.hooks.on('plugin.acme.analytics.page-view', …)`.

### Loop sources — requires `loops.register`

```js
api.cms.loops.registerSource({
  id: 'acme.products',
  label: 'Acme products',
  fields: [/* LoopSourceField[] */],
  filterSchema: { /* PropertySchema */ },
  orderByOptions: [/* allowed sort keys */],
  fetch: async (ctx) => ({ items: [/* LoopItem[] */], totalItems: 0 }),

  // Optional. Default false. Marks the source request-dependent: any
  // `base.loop` using it becomes a Layer C "hole" — the page bakes a
  // placeholder and a tiny client runtime fetches the rendered loop
  // fragment lazily via /_instatic/hole/<nodeId>. SHARED tier: the fragment is
  // cached per (nodeId, page-query, publishVersion), so `fetch()` runs at
  // most once per publish per distinct query. Use for live external APIs.
  requestDependent: true,

  // Optional. Default false. Implies requestDependent. PER-VISITOR tier:
  // the hole BYPASSES the cache (Cache-Control: no-store), runs `fetch()`
  // on every page load, and `ctx.request.cookies` is populated. Use for
  // cookie / randomised / wall-clock content. Use sparingly — every
  // per-visitor hole is an uncached request-time render.
  perVisitor: false,
})
```

Loop sources back the `base.loop` module. Plugin fetch handlers run inside the sandbox worker — use `api.cms.storage.*` or a permitted `fetch(...)` to source items. Sources backed by CMS data should leave both flags unset so the loop bakes into the static disk artefact at publish time.

**Request context.** When a source is request-dependent, its `fetch(ctx)` receives the originating page request on `ctx.request`:

```ts
ctx.request: {
  query: Record<string, string>   // parsed page query string (?q=shoes → { q: 'shoes' })
  path: string                    // originating page path (e.g. '/search')
  slug: string | null
  cookies: Record<string, string> // populated ONLY for perVisitor sources
}
```

At publish time (built-in, non-dynamic loops) `ctx.request` is `undefined` and the source must be deterministic. `ctx.db` and the full `site` are NOT sent to the worker — reach data via `api.cms.storage.*` or a gated `fetch(...)`.

### How a hole hydrates

When a `base.loop` is bound to a `requestDependent` / `perVisitor` source, the publisher does NOT bake it. It emits a `<instatic-hole>` placeholder (`display: contents`, so it adds no wrapper box) and injects a tiny runtime once per page (`/_instatic/hole-runtime.js?v=<publishVersion>` — versioned so a CMS update busts the cache). The runtime fetches each fragment from `/_instatic/hole/<nodeId>?v=<version>&u=<page-url>` — lazily via `IntersectionObserver` when the placeholder has visible skeleton content, eagerly on load otherwise — then swaps it in. It forwards the visitor's page path + query, and cookies ride along for `perVisitor` holes. Fully-static pages ship zero JS from the publisher.

See [docs/features/publisher.md](publisher.md) for the full three-layer pipeline.

### Module JS on published pages — requires `frontend.assets`

A plugin module's `render()` may return `js` (see `PluginRenderOutput`). It crosses the QuickJS boundary string-typed (non-strings are dropped by the VM normalizer) and is then gated host-side in `moduleAdapter.ts`: unless the plugin's **granted** permissions include `frontend.assets` — the same authority that already controls script tags via `frontend.assets[]` — the `js` is dropped with one `console.warn` per module. Enforcement always checks `grantedPermissions`, never the declared `permissions` array. With the grant, the JS is deduped per moduleId and served at `/_instatic/module-js/<moduleId>.js` on pages that use the module. Manifest format is unchanged.

### Settings — declared in `plugin.json`

```js
const key = api.cms.settings.get('apiKey')
const all = api.cms.settings.getAll()
await api.cms.settings.replace({ apiKey: 'new-value' })
```

Settings are typed (`string` / `number` / `boolean` / `secret`) and rendered automatically on the plugin admin page. Only string-typed settings (text / textarea / password / url / color / select) may be declared `secret: true` — the manifest parser rejects a secret toggle or number.

Settings writes go live immediately. When an operator saves the admin form (or the plugin calls `settings.replace`), the host persists the record, refreshes its load-time cache, pushes the merged runtime values into the running VM's mirror (an `update-settings` worker message — a no-op when the plugin isn't loaded), and only then emits the `settings.changed` hook. `api.cms.settings.get(...)` therefore returns the new value without a plugin reload — including inside a `settings.changed` listener.

**Secrets are encrypted at rest.** A setting declared with `secret: true` never enters `installed_plugins.settings_json`. Both write paths — the admin settings PUT and the plugin's own `api.cms.settings.replace` — converge on one repository choke point (`setPluginSettings` in `server/repositories/plugins.ts`), which splits the record: secret fields are AES-256-GCM-encrypted with the process master key (`INSTATIC_SECRET_KEY` — the same key that protects AI provider credentials and TOTP MFA seeds; mandatory in production, dev fallback at `.tmp/secret.key`) and stored in the dedicated `plugin_secrets` table (`server/repositories/pluginSecrets.ts`), one row per `(plugin_id, setting_id)` with a fresh IV and the master key's fingerprint. Manifest-declared secret defaults are encrypted the same way at install time. Uninstall removes the rows via the FK cascade; upgrades preserve them (the seed is insert-if-absent, so a rotated secret survives the upgrade upsert).

**Secrets never reach the browser — structurally.** Reads of the plugin row surface `''` for every secret field; browser-bound payloads (the plugins list, install/upgrade/enable/disable/restart responses, the settings GET/PUT responses, admin-page route snapshots via `usePluginSettings`, and editor-panel settings snapshots) project each secret field through `projectSecretSettings` (`server/handlers/cms/plugins/shared.ts`): `'***'` when an encrypted row exists, `''` when not. Only server-side plugin code running in the QuickJS worker reads the real value, via `api.cms.settings.get` / `getAll` — the worker mirror and the `settings.changed` hook payload are seeded from `server/plugins/settingsCache.ts`, the one sanctioned consumer of the decrypting `resolvePluginSecretsForRuntime` projection (gated by `plugin-secrets-never-leak.test.ts`). Editor-side and admin-app plugin code that needs a secret-derived capability must proxy through a plugin server route instead of reading the value directly.

The settings form round-trips the mask: a PUT where a secret field still carries the `'***'` sentinel keeps the stored encrypted row, a PUT with a new string rotates it, and a PUT with an empty string deletes it (which also means a secret can never literally be `'***'`). The sentinel constant lives in `src/core/plugin-sdk/builders/settings.ts` (`SECRET_SETTING_MASK`); the persistence semantics live in `applyPluginSecretSettings` (`server/repositories/pluginSecrets.ts`).

**Master-key rotation.** If `INSTATIC_SECRET_KEY` changes, stored plugin secrets can no longer be decrypted. The host does not crash plugin load — the worker simply sees those fields empty, and the server logs a `[plugin:<id>]` re-entry notice. The settings GET reports the affected field ids in `secretsNeedingReentry`, and the settings dialog shows a warning prompting the operator to re-enter them. Re-saving a value heals the row under the new key.

### Scheduled jobs — requires `cms.schedule`

```js
api.cms.schedule.daily('cleanup', '03:00', async () => { /* … */ })
api.cms.schedule.hourly('refresh', async () => { /* … */ })
api.cms.schedule.every(5, 'poll', async () => { /* … */ })

// Full form with overlap policy + duration override:
api.cms.schedule.register({
  id: 'shopify-sync',
  cadence: { interval: 'monthly', at: '02:00', dayOfMonth: 1 },
  overlap: 'skip',          // 'skip' | 'queue' | 'parallel'
  maxDurationMs: 60_000,    // default 5s budget
  handler: async () => { /* … */ },
})
```

All times are UTC. Each fire runs inside the sandbox with a wall-clock budget. The host's `server/plugins/scheduler.ts` drives dispatch and records run history.

Schedule ids are namespaced as `<pluginId>.<localId>` (the `pluginScheduleFullId` helper in `server/plugins/pluginScheduleRegistration.ts`); both `register` and `cancel` accept the plugin-local id and target the same row.

**Pause vs. cancel — two independent flags on each schedule row:**

- **`enabled` (registration state).** `register` sets it true, `api.cms.schedule.cancel(id)` sets it false. The row stays for audit; a later `register` re-enables it.
- **`paused` (operator/failure intervention).** Set by the admin **Pause** button and by the auto-pause after 5 consecutive failures; cleared only by the admin **Resume** button (which also resets the failure counter). Registration never touches `paused`, so a pause survives server restarts and plugin re-activations. A paused schedule is skipped by the tick but can still be fired explicitly via **Run now** so the operator can verify a fix before resuming.

A schedule fires only when it is `enabled`, not `paused`, and its plugin is enabled — schedules of disabled plugins never dispatch.

**Orphan sweep.** Schedules must be (re-)registered during `activate()`. After each activation pass the host disables every schedule row of that plugin that was not re-registered during the pass (keyed on the row's `claimed_at` registration stamp — see `disableSchedulesNotReclaimedSince` in `server/repositories/pluginSchedules.ts`). This prevents "ghost" schedules: when a plugin upgrade stops registering a schedule, the old row stops firing after the new version activates instead of dispatching into a VM with no handler forever.

### CMS content — requires `cms.content.*` + `contentAccess[]`

Plugins read and write CMS content (pages, posts, custom tables) through `api.cms.content.*`. Five permissions are split so most plugins (SEO assistants, translators, search indexers, AI helpers) get only what they need:

| Permission                    | Risk      | Plugin can                                                                 |
|-------------------------------|-----------|-----------------------------------------------------------------------------|
| `cms.content.read`            | Low       | List / read entries; read tree-shaped fields; read published snapshots; search |
| `cms.content.write`           | High      | Create / update entries; mutate tree-shaped fields; move entries between tables |
| `cms.content.publish`         | High      | Publish or schedule-publish entries; `republishAll()`                       |
| `cms.content.delete`          | High      | Soft-delete entries                                                          |
| `cms.content.tables.manage`   | Dangerous | Create user-managed tables (never system tables)                            |

The manifest's `contentAccess[]` lists every table the plugin can touch, with per-table modes. The host fails closed without both the permission and the allowlist entry:

```jsonc
{
  "permissions": ["cms.content.read", "cms.content.write"],
  "contentAccess": [
    { "table": "pages", "modes": ["read", "write"] },
    { "table": "posts", "modes": ["read"] }
  ]
}
```

Usage:

```js
// Schema introspection
const tables = await api.cms.content.tables.list()
const pagesTable = await api.cms.content.tables.get('pages')

// Per-table CRUD
const pages = api.cms.content.table('pages')
const result = await pages.list({ status: 'published', limit: 50 })
const entry = await pages.get(entryId)
await pages.update(entryId, { cells: { seoTitle: 'New title' } })
await pages.publish(entryId)
await pages.delete(entryId)

// Bulk
await pages.createMany([
  { slug: 'one', cells: { title: 'One', body: tree } },
  { slug: 'two', cells: { title: 'Two', body: tree } },
])

// Tree mutation — runs through the SAME engine as the visual editor
await api.cms.content.tree(entryId, 'body').mutate([
  { kind: 'insertNode', parentId: 'nd_root', index: 999, node: generatedNode },
])

// Cross-table
await api.cms.content.search('hello world', 25)
const snap = await api.cms.content.getPublishedSnapshot(entryId)
const { count } = await api.cms.content.republishAll()
```

`tables.create(input)` accepts the plugin-facing field projection, then maps it to the host's canonical `DataField` schema before storage. `richText` fields default to Markdown format, `select` / `multiSelect` option `value`s become stable option IDs, and `relation.targetTableSlug` must resolve to an existing table slug.

`republishAll` fires the full publish pipeline (`publish.before` → `publish.html` → `publish.after`), so other plugins' filters and listeners participate.

Tree mutation and replacement payloads are validated against the canonical `@core/page-tree` TypeBox schemas before host dispatch. `insertNode.node` must be a complete `PageNode`, and `replace(tree)` must receive a complete `NodeTree` with a valid `rootNodeId`, matching node-map keys, resolvable child IDs, and no reachable cycles.

#### Content events

Three event channels fire alongside every content write. Plugins use `actor` to skip their own writes (avoid feedback loops):

```js
api.cms.hooks.on('content.entry.updated', async ({ tableSlug, entryId, changedFieldIds, actor }) => {
  if (actor.kind === 'plugin' && actor.pluginId === api.plugin.id) return
  // …
})
```

Filter that runs before persistence — validate, normalize, auto-fill:

```js
api.cms.hooks.filter('content.entry.cells', (cells, { tableSlug, entryId, actor }) => {
  if (tableSlug !== 'pages') return cells
  if (!cells.metaDescription && typeof cells.body === 'string') {
    return { ...cells, metaDescription: cells.body.slice(0, 160) }
  }
  return cells
})
```

### Outbound HTTP — requires `network.outbound` + `networkAllowedHosts`

```js
const res  = await fetch('https://api.example.com/data')
const data = await res.json()

// Binary is first-class in both directions:
const img   = await fetch('https://cdn.example.com/pixel.png')
const bytes = new Uint8Array(await img.arrayBuffer())   // exact upstream bytes
await fetch('https://api.example.com/upload', { method: 'POST', body: bytes })
```

Bodies are **byte-safe in both directions**. The host reads upstream responses as raw bytes and ships them to the sandbox tagged `utf8` (text verbatim) or `base64` (binary), so `res.text()` / `res.json()` decode correctly (including multibyte UTF-8) and `res.arrayBuffer()` returns the exact bytes — fetching images, gzip, or protobuf works. Request bodies accept `string | ArrayBuffer | TypedArray/DataView`; anything else (`FormData`, `Blob`, `URLSearchParams`, streams) throws a `TypeError` naming the supported types — serialize to a string or bytes first. Wire codec: `server/plugins/protocol/bodyEncoding.ts`.

The permission alone is insufficient. `performGatedFetch` in `server/plugins/host/network.ts` enforces three checks on **every request and every redirect hop**:

1. **Allowlist check.** The URL host must match an entry in `manifest.networkAllowedHosts`. Wildcards (`*.cdn.example.com`) match one level deep — `*.foo.com` matches `bar.foo.com` but not `foo.com` or `a.bar.foo.com`. An empty or missing allowlist fails closed (all outbound denied).

2. **DNS resolution + SSRF guard.** The hostname is resolved to its addresses via the system DNS resolver **before** the connection is made. If any resolved address falls in a blocked range, the request is rejected — even when the host is allowlisted. Blocked ranges: loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), unique-local (`fc00::/7`), unspecified (`0.0.0.0/8`, `::`), and IPv4-mapped IPv6 forms of all of the above. This prevents DNS rebinding attacks (an allowlisted hostname that resolves to an internal IP is blocked).

3. **Manual redirect following with re-validation.** The host does not use transparent redirect following (`redirect: 'manual'` is always set). Each redirect location is validated with both the allowlist and the DNS SSRF guard before the next hop. The chain is capped at 5 hops. Method downgrade (303 → GET; 301/302 non-GET → GET) follows the Fetch spec.

**`networkAllowedHosts` entry constraints (checked at manifest parse time).** The manifest parser validates every entry before a plugin can be installed. Only plain or wildcard hostnames are accepted — the entry pattern already rejects IPv6 literals, ports, paths, and query strings. Two additional checks run on top:

- `localhost` and `*.localhost` are rejected — localhost is not a valid outbound target.
- IPv4 dotted-quad literals (e.g. `127.0.0.1`, `169.254.169.254`) are rejected — IP literals bypass DNS resolution and are incoherent with the SSRF guard model. Use a hostname instead.

The DNS SSRF guard in `performGatedFetch` remains the load-bearing defense; the manifest check is defense-in-depth so operators see the problem at install time rather than at the first fetch call.

---

## Permissions

Permissions are requested in `plugin.json` and approved by the site owner at install time. Granted permissions are stored on the plugin row. Every SDK call checks the **granted** permission set, not just the request.

The install endpoints enforce **grants = declared**, in both directions: every declared permission must be granted (install is all-or-nothing — there is no optional-permissions concept), and every granted permission must be declared (`assertPluginPermissionGrants` in `server/handlers/cms/plugins/shared.ts` rejects a tampered client that grants capabilities the manifest never disclosed). The install review dialog is shown for **every** install and upgrade — a zero-permission plugin renders "No permissions requested" rather than installing silently.

**One authority, three checkpoints.** The declared `permissions` array (what the
plugin *asked for*) is used only by the install/consent UI. Enforcement always
validates against `grantedPermissions` (what the operator *approved*), at three
independent layers that agree on that single authority:

| Layer | Check | Where |
|-------|-------|-------|
| VM (sandbox) | `assertTargetPermission` looks up the required permission in `TARGET_PERMISSIONS` from `server/plugins/protocol/targets.ts` and throws synchronously if it is not granted | `server/plugins/quickjs/bootstrap/src/buildApi.ts` |
| Host (dispatch) | Centralized `assertHostPluginPermission` in `apiDispatch.ts` — looks up `TARGET_PERMISSIONS[target]` and asserts before the handler runs; individual handlers only add the conditional checks a static map cannot express | `server/plugins/host/apiDispatch.ts` |
| Editor (SDK) | `assertPluginPermission` against `manifest.grantedPermissions` | `src/core/plugins/runtime.ts` |

Both the VM layer and the host layer drive from the same `TARGET_PERMISSIONS` map in `server/plugins/protocol/targets.ts`. This single table is the source of truth for which permission each RPC target requires — the VM and host can never silently assert different permissions for the same target.

Targets intentionally absent from `TARGET_PERMISSIONS` require no permission and are explicitly ungated: `cms.settings.replace` (any active plugin may update its own settings), `network.abort` (no active id without `network.outbound`), `crypto.digest` and `crypto.signHmac` (pure computation, no I/O — same model as `Math`/`JSON`). Two conditional checks that a static map cannot express remain in their handlers: `cms.routes.register` with `access.kind === 'public'` additionally requires `cms.routes.public`, and every `cms.content.*` handler additionally calls `assertContentTableAccess` for the per-table manifest allowlist.

The VM-side check throws **synchronously** inside the sandbox, so a plugin that
declares a permission it was denied is rejected before any host dispatch is even
attempted; the host check is the authoritative backstop (defense in depth). A
declared-but-not-granted permission being denied at the VM boundary is pinned by
`src/__tests__/server/pluginVmPermissions.test.ts`.

Risk levels:

- **Low** — visible UI additions with limited data access
- **Medium** — reads/writes plugin-owned data or changes editor UI
- **High** — mutates editor state, registers backend behavior, runs code on visitor browsers
- **Dangerous** — reserved for trusted first-party plugins

### Capability matrix (summary)

| Permission                  | Surface              | Risk      | Meaning                                                                 |
|-----------------------------|----------------------|-----------|-------------------------------------------------------------------------|
| `admin.navigation`          | Admin                | Medium    | Add admin navigation entries (declarative pages; app pages also need `editor.code`) |
| `editor.code`               | Admin / editor       | Dangerous | Run plugin JavaScript **unsandboxed** in the admin window (editor entrypoint, app-kind admin pages) |
| `cms.storage`               | Admin / editor / server| Medium  | Read/write plugin-owned records                                         |
| `cms.routes`                | Server               | High      | Register authenticated backend routes                                   |
| `cms.hooks`                 | Server               | High      | Listen to CMS events / filter values                                    |
| `cms.schedule`              | Server               | High      | Register cadence-driven handlers                                        |
| `cms.content.read`          | Server               | Low       | List / read entries; read trees; search; published snapshots             |
| `cms.content.write`         | Server               | High      | Create / update entries; mutate trees; move between tables               |
| `cms.content.publish`       | Server               | High      | Publish / schedule-publish entries; `republishAll()`                     |
| `cms.content.delete`        | Server               | High      | Soft-delete entries                                                      |
| `cms.content.tables.manage` | Server               | Dangerous | Create user-managed tables                                               |
| `editor.toolbar`            | Editor               | Medium    | Add toolbar buttons                                                     |
| `editor.commands`           | Editor               | Medium    | Register editor commands + Spotlight palette commands / providers       |
| `editor.store.read`         | Editor               | Medium    | Read editor store state                                                 |
| `editor.store.write`        | Editor               | High      | Mutate editor store state through a host transaction                    |
| `editor.canvas`             | Editor               | High      | Register canvas overlay React components                                |
| `editor.panels`             | Editor               | Medium    | Register left-sidebar panels. Use `definePluginPanel({ id, label, iconName, accent? })` from the SDK — `accent` pins a specific rail tint; omit it to let the host derive one automatically from the panel identity. |
| `modules.register`          | Editor / manifest    | High      | Ship new modules to the canvas module library                           |
| `loops.register`            | Editor / server / manifest | Medium | Register custom `base.loop` sources                                  |
| `visualComponents.register` | Admin / manifest     | Medium    | Ship VCs / page templates / class packs (via `pack/site.json`)          |
| `frontend.assets`           | Frontend / manifest  | High      | Inject declarative tags into every published page; also gates module render() `js` |
| `network.outbound`          | Server               | High      | Make outbound HTTP requests (with `networkAllowedHosts` allowlist)      |
| `unstable.internals`        | Admin / editor / server | Dangerous | Reserved for trusted first-party plugins                            |

Full descriptions and labels live in `src/core/plugin-sdk/capabilities.ts` — the source of truth.

---

## CLI workflow

`bun instatic-plugin <command>` runs the SDK CLI at `src/core/plugin-sdk/cli/`.

```sh
bun instatic-plugin init my-plugin    # scaffold a new plugin
bun instatic-plugin lint              # validate manifest + sources + bundles (sandbox-safe)
bun instatic-plugin build             # produce dist/ + .plugin.zip
bun instatic-plugin dev               # watch + sync into a running CMS
```

### Local dev with hot sync

`instatic-plugin dev` writes built files **directly** into the host's `uploads/plugins/<id>/<version>/`. Subsequent rebuilds are picked up on the next activation cycle.

When running inside the instatic monorepo, the CLI auto-detects the host's `uploads/` by walking up the tree. From a separate plugin repo:

```sh
INSTATIC_UPLOADS_DIR=../instatic/uploads bun instatic-plugin dev
# or
bun instatic-plugin dev --uploads ../instatic/uploads
```

First install still goes through the admin UI (`/admin/plugins` → Upload Plugin) so the owner approves permissions. Every `instatic-plugin dev` rebuild after that flows in without another upload.

---

## Adding a new plugin

1. **Scaffold:**
   ```sh
   bun instatic-plugin init my-plugin
   cd my-plugin
   ```
2. **Set the manifest.** Pick a namespaced ID (`vendor.product`), set `apiVersion: 1`, declare the permissions you'll actually use.
3. **Write the server entrypoint** in `server/index.js`. Export `activate(api)` and register what you need (routes, hooks, storage collections, scheduled jobs).
4. **(Optional) Add editor / admin / modules entrypoints.** Declare them in `entrypoints` and import from the SDK.
5. **Lint:**
   ```sh
   bun instatic-plugin lint
   ```
6. **Build:**
   ```sh
   bun instatic-plugin build
   ```
7. **Install via admin UI** (`/admin/plugins` → Upload Plugin), approve permissions.
8. **Iterate** with `bun instatic-plugin dev`.

### Cookbook: a server route + storage collection

```js
// server/index.js
export function activate(api) {
  const subscribers = api.cms.storage.collection('subscribers')

  api.cms.routes.post('/subscribe', 'plugins.manage', async ({ body, user }) => {
    const sub = await subscribers.create({ email: body.email, addedBy: user.id })
    return { ok: true, id: sub.id }
  })

  api.cms.routes.get('/subscribers', 'plugins.manage', async () => {
    return { rows: await subscribers.list() }
  })
}
```

Manifest:

```json
{
  "id": "acme.subscribers",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["cms.routes", "cms.storage"],
  "resources": [
    {
      "id": "subscribers",
      "label": "Subscribers",
      "fields": [
        { "id": "email", "type": "string", "label": "Email" },
        { "id": "addedBy", "type": "string", "label": "Added by" }
      ]
    }
  ],
  "entrypoints": { "server": "server/index.js" }
}
```

---

## Forbidden patterns

| Pattern                                                                  | Use instead                                                  |
|--------------------------------------------------------------------------|--------------------------------------------------------------|
| `import fs from 'node:fs'` or any Node API                               | `api.cms.storage.*` for data, `api.plugin.assetUrl(p)` for files |
| `import { Database } from 'bun:sqlite'` or any `bun:*` module            | The SDK                                                      |
| `Bun.spawn` / `Bun.serve` / `Bun.write` / `Bun.sql` / `Bun.$`            | Hooks (`api.cms.hooks.emit`) for cross-plugin signals        |
| `process.env.SECRET_KEY`                                                 | `api.cms.settings.get('secretKey')`                          |
| `require('module')`                                                      | ES module `import` (resolved at build time)                  |
| `globalThis.fetch(...)` without permission                               | Declare `network.outbound` + `networkAllowedHosts`           |
| `eval(...)` / `new Function(...)`                                        | Blocked — no replacement                                     |
| Calling a host capability without the matching permission                | Declare it in `plugin.json`'s `permissions`                  |
| Reaching the DB directly from a plugin                                   | Use `api.cms.storage.*`                                      |
| IP literals or `localhost` in `networkAllowedHosts`                      | Use a hostname — rejected at manifest parse time             |
| Skipping `instatic-plugin lint` before upload                                  | Always lint — the host scans anyway and refuses the upload   |
| Calling host APIs from inside a constructor / module top-level           | Use lifecycle hooks (`activate(api)`) — host APIs are only bound there |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — server runtime (plugins activate during server boot)
- [docs/editor.md](../editor.md) — admin / editor frontend (plugin host UI + hooks)
- Source-of-truth files:
  - `src/core/plugin-sdk/` — SDK API surface
  - `src/core/plugin-sdk/capabilities.ts` — permission catalog
  - `src/core/plugin-sdk/cli/` — `instatic-plugin` CLI
  - `src/core/plugins/manifest.ts` — manifest parser + validator
  - `src/core/plugins/events.ts` — `PluginEventSchema`, `PluginEvent` type, `PLUGIN_EVENT_KINDS`
  - `src/core/plugins/` — host-side runtime
  - `server/plugins/runtime.ts` — boot-time plugin activation
  - `server/plugins/eventBroadcaster.ts` — server-side SSE fan-out (`subscribePluginEvents`, `broadcastPluginEvent`)
  - `server/handlers/cms/plugins/events.ts` — `GET /admin/api/cms/plugins/events` SSE endpoint
  - `src/admin/pages/plugins/utils/pluginEventStream.ts` — client-side lazy EventSource subscriber (validates frames)
  - `src/admin/pages/plugins/hooks/usePluginEventBridge.ts` — admin shell hook (toasts, badge, list resync)
  - `server/plugins/protocol/targets.ts` — `TARGET_PERMISSIONS` map (SSOT for RPC target→permission pairs; consumed by both the host dispatcher and VM bootstrap)
  - `server/plugins/quickjs/vm.ts` — server entrypoint sandbox (QuickJS VM factory)
  - `server/plugins/quickjs/bootstrap/src/` — bootstrap TypeScript source (authored, typed, lintable)
  - `server/plugins/quickjs/bootstrap/generated/` — committed bootstrap artifacts (regenerate with `bun run bootstrap:sync`)
  - `scripts/sync-plugin-bootstrap.ts` — bundler that writes the generated artifacts
  - `server/plugins/modulePackVm.ts` — module pack VM constructor
  - `src/core/plugins/modulePackLoader.ts` — module pack lifecycle coordinator (activate, deactivate, reset, VM tracking)
  - `server/plugins/package.ts` — install / `assertSandboxSafe`
  - `server/plugins/scheduler.ts` — scheduled job dispatcher
  - `server/plugins/host/network.ts` — gated outbound fetch + SSRF guards
  - `server/plugins/protocol/bodyEncoding.ts` — byte-safe body wire format (utf8/base64)
  - `server/plugins/host/routeIo.ts` — route request/response (de)serialization
  - `server/plugins/runtime.ts` — plugin HTTP route forwarder (`handleServerPluginRuntimeRequest`)
  - `examples/plugins/template/` — example plugin
- Gate tests:
  - `src/__tests__/architecture/plugin-rpc-target-registry.test.ts` — every schema target has a handler; every `TARGET_PERMISSIONS` key is a real target; the full target→permission table is locked to the security contract
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/architecture/plugin-boot-resilience.test.ts`
  - `src/__tests__/architecture/plugin-cms-content-surface.test.ts`
  - `src/__tests__/architecture/plugin-content-access-enforced.test.ts`
  - `src/__tests__/architecture/plugin-content-tree-via-engine.test.ts`
  - `src/__tests__/architecture/plugin-host-import-boundaries.test.ts`
  - `src/__tests__/architecture/plugin-host-ui-runtime-parity.test.ts`
  - `src/__tests__/architecture/plugin-schedule-invariants.test.ts`
  - `src/__tests__/architecture/no-plugin-tab-shells.test.ts`
  - `src/__tests__/architecture/sandbox-crypto-bridge.test.ts`
  - `src/__tests__/architecture/plugin-bootstrap-fresh.test.ts` — generated bootstrap artifacts match source; fails if `bun run bootstrap:sync` is needed
  - `src/__tests__/plugins/gatedFetchSsrf.test.ts` — SSRF guards: allowlist, DNS rebinding, redirect re-validation, redirect cap
  - `src/__tests__/plugins/pluginBinaryIo.test.ts` — host-side byte safety: wire codec round-trips, binary fetch bodies, multipart file fields, binary route responses
  - `src/__tests__/server/pluginVmBinaryIo.test.ts` — VM-side byte safety: fetch `arrayBuffer()`/`text()`/`json()` decoding, binary request bodies, unsupported-body TypeError, route file facades + binary `__response`
  - `src/__tests__/plugins/pluginModulePack.test.ts` — module pack activation, re-activation, deactivation, and VM disposal
  - `src/__tests__/server/pluginVmPermissions.test.ts` — VM-side permission check: declared-but-not-granted permissions are denied at the VM boundary before host dispatch
  - `src/__tests__/server/pluginVmLoopDispatch.test.ts` — loop fetch/preview dispatcher robustness (no-return fallbacks, async-preview detection)
  - `src/__tests__/server/pluginVmDeadlines.test.ts` — hang hardening: top-level loops abort at load, overlapping evals keep their deadlines, runaway timer callbacks are interrupted, VM stacks survive with the `plugin:<id>` filename
  - `src/__tests__/server/pluginWorkerRpcTimeout.test.ts` — host-side RPC timeout: wedged workers are reset through the crash machinery instead of hanging callers
  - `src/admin/pages/plugins/utils/pluginEventStream.test.ts` — SSE frame validation: well-formed events dispatched, unknown-shape frames dropped with `console.warn`
