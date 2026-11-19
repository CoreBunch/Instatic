# Plugin System

End-to-end description of the plugin system: what plugins are, how they ship, how they run sandboxed, what they can do, and how to author them.

A plugin is a zip package containing a `plugin.json` manifest and one or more bundled JavaScript entrypoints. The SDK CLI usually authors that zip from `instatic-plugin.config.ts`, then the CMS host loads installed plugins at boot. Each server entrypoint runs in its own Bun `Worker`, and that worker hosts a **QuickJS-WASM sandbox** — no Node, no Bun, no host file system, no environment variables, no network unless explicitly granted. Plugins reach the CMS through SDK surfaces scoped to where they run: `api.plugin.*`, `api.cms.*`, `api.editor.*`, and `api.dashboard.*`.

---

## TL;DR

- **Package shape:** the CLI reads `instatic-plugin.config.ts` and emits a zip containing `plugin.json` plus entrypoint bundles (`server/index.js`, `editor/index.js`, admin app bundles, `modules/index.js`, `frontend/*.js`, optional `pack/site.json`).
- **Runtime:** each server plugin has a Bun `Worker` (`server/plugins/pluginWorker.ts`) that owns one QuickJS VM (`server/plugins/quickjs/vm.ts`). Canvas module packs run in a separate QuickJS VM on the server (`server/plugins/modulePackVm.ts`) and as ESM in the browser editor. No host APIs leak into QuickJS.
- **SDK:** every API call goes through `api` — `api.plugin.*` for metadata + logging, `api.cms.*` for routes, storage, hooks, loops, settings, schedule, content, and media; `api.editor.*` for editor extensions; `api.dashboard.*` for dashboard widgets.
- **Lifecycle:** `install` → `activate` → (optionally `deactivate` / `migrate`) → `uninstall`. Each hook is async-capable and isolated; if one throws, the host rolls back and parks the plugin in `error`.
- **Permissions:** declared in `instatic-plugin.config.ts` / `plugin.json`, approved by the site owner at install time, enforced by the SDK at runtime. Outbound network also requires a `networkAllowedHosts` allowlist.
- **CLI:** `bun instatic-plugin init|lint|build|dev` covers scaffolding, manifest/source validation, bundle build, zip creation, and hot-sync to a running CMS.
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
| Worker host (server entrypoint) | `server/plugins/pluginWorker.ts`, `server/plugins/host/workerPool.ts` |
| QuickJS VM factory (server entrypoint)| `server/plugins/quickjs/vm.ts`       |
| Sandbox host (module pack VMs) | `server/plugins/modulePackVm.ts`          |
| VM bootstrap source (typed)    | `server/plugins/quickjs/bootstrap/src/`   |
| VM bootstrap generated artifacts | `server/plugins/quickjs/bootstrap/generated/` (run `bun run bootstrap:sync`) |
| Host RPC dispatcher            | `server/plugins/host/apiDispatch.ts`, `server/plugins/host/rpc.ts` |
| Gated outbound fetch + SSRF guards | `server/plugins/host/network.ts`       |
| Byte-safe body wire format     | `server/plugins/protocol/bodyEncoding.ts` |
| Route request/response I/O     | `server/plugins/host/routeIo.ts`          |
| Media extension handlers       | `server/plugins/host/handlers/media.ts`, `src/core/plugins/mediaStorageRegistry.ts`, `src/core/plugins/mediaVariantDelegateRegistry.ts` |
| Published-page asset injection | `server/publish/frontendInjections.ts`    |
| Dashboard widget registry      | `src/core/dashboard/registry.ts`          |
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
server/index.js          <- server entrypoint
editor/index.js          <- editor entrypoint (optional)
admin/workflow.js        <- app-kind admin page bundle (optional;
                            referenced by adminPages[].content.entry)
modules/index.js         <- canvas module pack (optional)
frontend/tracker.js      <- published-page asset (optional;
                            referenced by frontend.assets[])
pack/site.json           <- Visual Components / pages / classes / layouts pack (optional;
                           layouts are authored as clean HTML + CSS in
                           definePack({ layouts }) and compiled to snapshot
                           form at build time)
assets/                  <- static assets shipped in the zip (optional)
```

`bun instatic-plugin build` produces this runtime layout from `instatic-plugin.config.ts`. Bundle formats are intentionally different per surface:

| Bundle | Format | Loaded by |
|---|---|---|
| `server/index.js` | IIFE facade assigning `globalThis.__plugin_exports` | Bun worker → QuickJS VM |
| `modules/index.js` | ESM default export | Browser editor via dynamic import; server QuickJS after `server/plugins/modulePackVm.ts` rewrites the default export to `globalThis.__module_pack` |
| `editor/index.js` | ESM | Unsandboxed admin window via dynamic import |
| Admin app bundles | ESM | Unsandboxed admin window via `adminPages[].content.kind === "app"` |
| `frontend/*.js` | ESM | Published pages via manifest-declared `frontend.assets[]` |

Sandboxed bundles are scanned for forbidden literals during `build`, during `lint`, and again when the zip is uploaded.

---

## Manifest (`plugin.json`)

Authors normally write `instatic-plugin.config.ts` with `definePlugin(...)`; the CLI emits the runtime `plugin.json`. The runtime manifest is still the install-time contract, and `parsePluginManifest` in `src/core/plugins/manifest.ts` is the source of truth.

```jsonc
{
  "id": "acme.workflow",                        // namespaced, lowercase
  "name": "Workflow",                           // display name
  "version": "1.0.0",                           // semver-like
  "apiVersion": 1,                              // only `1` currently
  "description": "Approval workflow for posts.",

  "permissions": [
    "cms.routes",
    "cms.routes.public",
    "cms.storage",
    "cms.hooks",
    "admin.navigation",   // required by adminPages[]
    "editor.code",        // required by entrypoints.editor (unsandboxed admin-window code)
    "modules.register",   // required by entrypoints.modules
    "frontend.assets",    // required by frontend.assets[]
    "network.outbound"    // required by fetch() in the server sandbox
  ],

  "entrypoints": {
    "server":  "server/index.js",
    "editor":  "editor/index.js",
    "modules": "modules/index.js"
  },

  "resources": [
    {
      "id": "approvals",
      "title": "Approvals",
      "singularLabel": "Approval",
      "pluralLabel": "Approvals",
      "fields": [
        { "id": "title", "label": "Title", "type": "text", "required": true },
        { "id": "notes", "label": "Notes", "type": "longtext" },
        { "id": "approved", "label": "Approved", "type": "boolean" }
      ]
    }
  ],

  "adminPages": [
    {
      "id": "dashboard",
      "title": "Approval Queue",
      "navLabel": "Approvals",
      "icon": "checkmark",
      "content": {
        "kind": "resource",
        "heading": "Approval Queue",
        "resource": "approvals"
      }
    },
    {
      "id": "app",
      "title": "Workflow App",
      "navLabel": "Workflow",
      "icon": "dashboard",
      "content": {
        "kind": "app",
        "heading": "Workflow",
        "entry": "admin/workflow.js"
      }
    }
  ],

  "settings": [
    { "id": "apiKey", "type": "password", "label": "API key", "secret": true },
    { "id": "mode", "type": "select", "label": "Mode",
      "options": [
        { "label": "Draft", "value": "draft" },
        { "label": "Live", "value": "live" }
      ],
      "default": "draft"
    }
  ],

  "frontend": {
    "assets": [
      { "kind": "script", "src": "frontend/tracker.js",
        "placement": "body-end", "strategy": "defer" }
    ],
    // Optional: third-party hosts published pages may load scripts / frames from.
    "origins": { "scripts": ["js.example.com"], "frames": ["widgets.example.com"] }
  },

  // Optional: the emails the plugin can send (needs `mail.send` or `mail.send.external`).
  "mail": {
    "templates": [
      { "key": "welcome", "label": "Welcome", "description": "Sent after sign-up.",
        "variables": [{ "name": "link", "label": "Link", "sample": "https://example.com/start", "kind": "link" }],
        "subject": "Welcome to {site.name}", "body": "[Get started]({link})" }
    ]
  },

  "networkAllowedHosts": [
    "api.weather.example.com",
    "*.cdn.weather.example.com"
  ],

  "appScopes": [
    { "name": "read", "description": "See your saved forecasts" }
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
| `resources[].uniqueField`   | The `id` of one of that resource's `text` fields           | `email`                   |
| Pack `classes[].id`         | Namespaced under the plugin ID                             | `acme.workflow/hero-root` |
| Pack `layouts[].id`         | Namespaced under the plugin ID                             | `acme.workflow/hero-section` |

`parsePluginManifest` validates all of these and produces a clear error message. `bun instatic-plugin lint` runs the same checks before upload. Coherence checks also enforce permission-dependent shape:

- `entrypoints.editor` and app-kind admin pages require `editor.code`.
- `entrypoints.modules` requires `modules.register`.
- Any `adminPages[]` entry requires `admin.navigation`.
- `frontend.assets[]` and `frontend.origins` require `frontend.assets`.
- `mail.templates[]` requires `mail.send` or `mail.send.external`; template keys and variable names are unique, and a template may not declare a `site.*` variable.
- Public routes require both `cms.routes` and `cms.routes.public`.
- Server `fetch()` requires `network.outbound` and a matching `networkAllowedHosts[]` entry.
- `appScopes[]` requires `members.read`, and each `name` (lowercase kebab-case) is declared once. A `description` must say something once cleaned for display (not only spaces), contain no control or invisible formatting characters, and not repeat the text of a built-in app scope. `definePlugin({ appScopes })` writes the field; `instatic-plugin lint` additionally reports a server source that opens a route under a scope `appScopes` does not declare (`{ app: { scope: 'x' } }` written as a string literal).
- Any `cms.content.*` permission requires a non-empty `contentAccess[]`, and every mode an entry declares requires its permission (`CONTENT_ACCESS_MODE_PERMISSIONS` in `src/core/plugin-sdk/contentSchemas.ts` is the one mode-to-permission table both checks read). `instatic-plugin lint` additionally warns when a `cms.content.*` permission is requested but no entry declares its mode, since the host fails closed per table and mode and every call under it would be rejected.

---

## Lifecycle

```text
Fresh install:    install → activate
Disable:          deactivate
Enable again:     activate
Upgrade to v2:    (old) deactivate → (new) migrate({fromVersion}) → (new) activate
Uninstall:        (if active) deactivate → uninstall
```

**An upgrade does not delete the previous version's files.** Published pages link a plugin's frontend assets by version (`/uploads/plugins/<id>/<version>/frontend/…`, which is what makes the URL cache-bustable), and those artefacts are only rewritten by a **publish**. Deleting on upgrade therefore 404'd every page already baked to disk — on a real site an upgrade took out jQuery, GSAP, Lenis, Splide and the boot script across every page at once, with no warning and no prompt to re-publish.

The old directory is retired by the next publish instead, which is the exact moment those URLs stop pointing at it (`sweepStalePluginVersionAssets`, `server/publish/stalePluginAssets.ts`, called after the slot swap). Between an upgrade and the next publish both versions sit on disk: the installed one for new renders, the previous one for pages not yet re-baked. A plugin with no installed record is never swept — uninstall already removes its tree, so anything left is unexplained, and a publish is a bad moment to act on that.

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
4. If the same plugin reaches `CRASH_THRESHOLD` (3) crashes within `CRASH_WINDOW_MS` (5 minutes), auto-respawn stops and the plugin is parked in `error`. The owner restarts it manually from the Plugins admin page.

If re-activation in step 3 fails, the plugin is unloaded (routes and hooks it registered before failing are gone) and its status is set to `error` with the reason.

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
- **`crypto.subtle`** — pure computation bridge: `digest(...)`, `importKey('raw', ..., { name: 'HMAC', hash })`, and `sign('HMAC', ...)`. These map to ungated `crypto.digest` / `crypto.signHmac` RPC targets because they do no I/O.
- **`crypto.getRandomValues(view)` / `crypto.randomUUID()`** — CSPRNG entropy from the host, for tokens, nonces, invitation codes and one-time links. Unlike the digest/HMAC pair these do **not** use the `__hostCall` RPC bridge, because that returns a Promise and `getRandomValues` is synchronous by spec; they call the dedicated synchronous `__hostRandomBytes` host function instead. Also ungated (no I/O, nothing to escalate). `getRandomValues` accepts integer-typed views only, throwing `TypeMismatchError` for float or non-view arguments, and caps a single call at 65536 bytes with `QuotaExceededError` above it — the WebCrypto quota, enforced in both the shim and the host function. `randomUUID` returns an RFC 9562 version-4 UUID.

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

1. **`instatic-plugin build`** emits the correct bundle format for each surface and scans sandboxed bundles for the forbidden literals above.
2. **`instatic-plugin lint`** runs the same scan plus manifest + permission/allowlist coherence checks. Run this before upload.
3. **Install handler** (`server/plugins/package.ts → assertSandboxSafe`) scans **again** when the zip is uploaded — defense in depth in case the dev skipped `lint`.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`.

### Resource limits and timeouts

VM and request limits live in `server/plugins/quickjs/limits.ts`; the host-side RPC timeout in `server/plugins/host/workerPool.ts`.

| Limit | Value | Enforced by |
|---|---|---|
| VM heap | 64 MB (`DEFAULT_MEMORY_LIMIT_BYTES`) | QuickJS `setMemoryLimit` — allocations beyond it throw inside the VM |
| VM stack | 1 MB (`DEFAULT_STACK_SIZE_BYTES`) | QuickJS `setMaxStackSize` — fatal for runaway recursion |
| Eval deadline | 5 s (`DEFAULT_EVAL_TIMEOUT_MS`) | interrupt on the QuickJS runtime. Counts time spent **running** plugin code, not time spent awaiting a host call |
| Call budget | 20 s (`PLUGIN_CALL_BUDGET_MS`) | wall clock for one whole call (lifecycle, route, hook, loop fetch, media call), awaits included; checked by the settle loop in `quickjs/eval.ts`. Only that call fails |
| Module-pack eval deadline | 2 s (`MODULE_PACK_EVAL_TIMEOUT_MS`) | same interrupt — canvas `render()`/`preview()` are pure sync transforms |
| Schedule fire | the schedule's `maxDurationMs` (host-capped at 5 min) | replaces both the eval deadline and the call budget for that one call |
| Outbound request | 15 s (`DEFAULT_PLUGIN_FETCH_TIMEOUT_MS`), or the request's `timeout`, never more than the time left in the call less a handling margin | host timer in `performGatedFetch`; covers DNS, every redirect hop and the response body |
| Worker RPC | 30 s (`DEFAULT_RPC_TIMEOUT_MS`); schedule runs get `maxDurationMs` + 10 s slack | host-side timeout in `requestFromWorker` |

**The eval deadline covers every way plugin code can execute.** Each entry into VM execution — the bootstrap eval, the plugin bundle's top-level eval, every `__run*` dispatch (lifecycle, route, hook, loop, schedule, media), and the pending-jobs pump that runs timer callbacks (`setTimeout`/`setInterval` continuations) — registers a wall-clock deadline in a per-runtime registry (`server/plugins/quickjs/eval.ts`). One persistent interrupt handler aborts the runtime once the clock passes the latest active deadline, so concurrent evals on one context cannot strip each other's protection and a `while (true) {}` anywhere (top level, route handler, timer callback) is interrupted instead of wedging the worker thread.

**What the plugin author sees on a deadline hit:** the call fails with QuickJS's `interrupted` error — schedule runs record it as `status: 'timeout'`, every other entry point surfaces it as an ordinary error (lifecycle failure, route 500, hook listener log line). Plugins that legitimately need more time should yield back to the host (await host calls, split work across schedule fires) rather than block in a tight loop.

**The call budget bounds waiting.** The eval deadline cannot fire while a handler awaits a host call, so a handler waiting on something slow is bounded by the call budget instead. A call still pending when it runs out fails with `Plugin call exceeded its 20s time budget` (`PluginCallBudgetError`): a route answers **504** with that message, a schedule run records `status: 'timeout'`, and a lifecycle hook, hook listener or loop fetch fails like any thrown error. Only that call fails. The worker, the VM and every other call in flight carry on, which is why the budget sits below the worker RPC timeout.

- **A 504 from a plugin route means the outcome is unknown.** Plugin code cannot be cancelled mid-`await`: the abandoned handler may resume when its host call returns and finish its work, including any write, after its caller was told it failed. The caller may retry, so a handler that writes must be idempotent (key the write on the event or request id). The tools for that are `createIfAbsent` and `update(..., { ifVersion })` in plugin storage; see "Plugin-owned records".
- **A slow upstream does not have to end in a 504.** An outbound request times out at 15 s by default and always ends before the call does, with time left to handle the failure (see "Outbound HTTP" → Timeouts). A handler that catches the `TimeoutError` answers normally.
- A pending call does not spin: it sleeps until a host-call or timer resolution advances the VM, re-checking every 50 ms.

**The worker RPC timeout is the backstop for a truly wedged worker.** A worker that hangs never *crashes*, so without it the awaiting HTTP request or publish render would hang forever and crash recovery would never engage. When `requestFromWorker` times out, the call rejects with `Plugin "<id>" did not respond to <kind> within <ms>ms` and the worker goes through the same teardown as a crash (`handleWorkerCrash`): terminated, sibling pending calls rejected, host-side registrations dropped, a crash event recorded for the admin UI, and the sliding-window counter decides auto-respawn vs parking the plugin in `error` state.

**Error stacks:** VM errors keep their QuickJS stack frames (plugin bundles are evaluated with the filename `plugin:<id>`, and the ESM shim adds zero line offset, so frames map 1:1 onto the shipped bundle). The frames travel worker→host on the optional `stack` field of the `*-result` protocol messages and appear in `[plugin:<id>]` server logs only — HTTP responses and API replies carry just the error message.

### The VM bootstrap (and how to regenerate it)

Before any plugin code runs, the host evaluates a **bootstrap** program inside the
VM: Web-Platform polyfills (URL, TextEncoder, console, AbortController, timers,
crypto.subtle, crypto.getRandomValues, fetch) plus the SDK factory `__buildApi()` and the `__run*`
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

### Editor and dashboard APIs — unsandboxed admin-window code

`entrypoints.editor` and app-kind admin pages run in the admin window, not in QuickJS. They use the browser-side API from `src/core/plugin-sdk/types/editorApi.ts`.

```js
export function activate(api) {
  api.editor.commands.register({
    id: 'acme.workflow.approve',
    label: 'Approve current item',
    iconName: 'check',
    run: async () => {
      // command body
    },
  })

  api.editor.toolbar.addButton({
    id: 'acme.workflow.approve-button',
    label: 'Approve',
    command: 'acme.workflow.approve',
  })

  api.editor.palette.registerProvider({
    id: 'acme.workflow.search',
    label: 'Workflow',
    search: async (query) => [],
  })
}
```

Editor surfaces are permission-split:

| API | Permission |
|---|---|
| `api.editor.commands.register`, `api.editor.palette.registerCommand`, `api.editor.palette.registerProvider` | `editor.commands` |
| `api.editor.toolbar.addButton` | `editor.toolbar` |
| `api.editor.panels.register` | `editor.panels` |
| `api.editor.canvas.registerOverlay` | `editor.canvas` |
| `api.editor.store.read` | `editor.store.read` |
| `api.editor.store.transaction` | `editor.store.write` |
| `api.cms.storage.collection(...)` from browser plugin code | `cms.storage` |

Dashboard widgets are registered from the same unsandboxed browser entrypoint through `api.dashboard.widgets.register(...)` and require `dashboard.widgets.register`:

```jsx
import { StatValue, Widget } from '@instatic/host-ui'

function ApprovalWidget({ span, editing }) {
  return (
    <Widget
      widgetId="acme.workflow.approvals"
      title="Approvals"
      tint="mint"
      span={span}
      editing={editing}
    >
      <StatValue value="12" sub="Open approvals" />
    </Widget>
  )
}

export function activate(api) {
  api.dashboard.widgets.register({
    id: 'acme.workflow.approvals',
    name: 'Approval Queue',
    description: 'Open approvals waiting for review.',
    iconName: 'chart',
    defaultSize: 4,
    tint: 'mint',
    component: ApprovalWidget,
  })
}
```

Widget ids must be namespaced under the plugin id (`<pluginId>.<rest>`). The component should compose the host `Widget` primitive so plugin tiles use the same card chrome, drag handle, menu, loading state, and tint behavior as first-party widgets.

### CMS routes — requires `cms.routes` (public routes also require `cms.routes.public`)

```js
api.cms.routes.get('/status', 'plugins.read', handler)         // capability-gated
api.cms.routes.post('/action', 'plugins.configure', handler)
api.cms.routes.patch('/item/:id', 'plugins.configure', handler)
api.cms.routes.delete('/item/:id', 'plugins.configure', handler)
api.cms.routes.authenticated.get('/me', handler)               // any logged-in user
api.cms.routes.public.post('/subscribe', handler)              // anonymous — also requires cms.routes.public
```

Routes mount under `/admin/api/cms/plugins/<id>/runtime/*`. The host enforces the admin session check + the declared capability before invoking the handler. Handlers receive `{ req, body, user }`. The `user` is `null` for public routes.

Request bodies are **byte-safe end to end**. The host reads the incoming body once as raw bytes and carries it to the sandbox tagged `utf8` (text verbatim) or `base64` (binary), so `req.text()` / `req.json()` decode correctly (including multibyte UTF-8) and `req.arrayBuffer()` returns the exact payload bytes. Pre-parsed `body` fields cover `application/json`, `application/x-www-form-urlencoded` (repeated keys become arrays), and `multipart/form-data` — text fields arrive as strings, file fields as uploaded-file facades (`{ name, type, size, arrayBuffer(), text() }`) whose bytes are uncorrupted, so plugins can accept image/PDF uploads. (De)serialization lives in `server/plugins/host/routeIo.ts`; the wire codec in `server/plugins/protocol/bodyEncoding.ts`.

Route handlers never receive Instatic's own cookies. The host removes every `instatic_` cookie (admin session, member session, branch preview) from `req.headers.cookie` before the request reaches the sandbox (`server/sessionCookies.ts`); who the caller is arrives as `ctx.user`. Other cookies pass through. An `Authorization` header that names a member app token is removed the same way (see "Apps" below); any other value passes through.

Custom responses (status, headers, non-JSON bodies) use the raw-response escape hatch: return `{ __response: true, status, headers, body }` instead of a plain object. `body` accepts a string (sent as UTF-8 text) or an `ArrayBuffer` / TypedArray / `DataView` (sent byte-exactly — serve images, zips, PDFs directly); anything else throws a `TypeError`.

### Site members — requires `members.read` / `members.write` / `members.tags`

Site members are the people with an account on the published site (see [members](members.md)). They are not admin users: `ctx.user` is an admin, `ctx.member` is a member.

**The public mount.** Routes for the published site are served at `/_instatic/plugins/<pluginId>/<path>` (`server/plugins/publicRoutes.ts`), outside `/admin`. It serves a plugin's `routes.public.*` and `routes.member.*` routes; capability-gated and `authenticated` routes answer 404 there. Public routes are still reachable on the admin mount too; member routes are only on the public one. Bodies over 1 MiB are refused.

```js
// Only a signed-in member reaches the handler; ctx.member is always set.
api.cms.routes.member.get('/orders', (ctx) => listOrders(ctx.member.id))
// Only a member holding the tag; others get 403.
api.cms.routes.member.post('/download', { tag: 'pro' }, handler)
// A public route sees ctx.member too when the plugin holds members.read.
api.cms.routes.public.get('/price', (ctx) => priceFor(ctx.member))
```

- `ctx.member` is `{ id, email, tags, profile }` or `null`. The host resolves it; the member's session cookie is still stripped from `req.headers`.
- A signed-out visitor gets 401 from a member route. A member-route write (POST, PATCH, DELETE) must name this site's origin, as the member endpoints require; a public-route write may omit it (webhooks) but may not name another site.
- A response for a member is sent `Cache-Control: private, no-store` unless the handler sets its own.

**Apps.** A site member can sign in to an app the owner registered (a desktop app, say; see [members](members.md) → "Sign-in for apps"). By default a member route answers only the member's browser. A plugin lets apps in route by route:

```json
"appScopes": [{ "name": "read", "description": "See your purchases and plan" }]
```

```js
// The member's browser, or an app whose sign-in carries plugin:<pluginId>:read.
api.cms.routes.member.get('/orders', { app: { scope: 'read' } }, (ctx) => {
  // ctx.app is { id, name, scope } for an app, null for the browser.
  return listOrders(ctx.member.id)
})
// No `app`: an app's token gets 403 here, whatever it carries.
api.cms.routes.member.post('/cancel', (ctx) => cancel(ctx.member.id))
```

- Each `appScopes` entry becomes the scope `plugin:<pluginId>:<name>`. The owner sees the list at install, picks from it when registering an app, and the member reads `description` on the approval page before allowing the app.
- A route can only name a scope the manifest declares; anything else fails activation (and `instatic-plugin lint` reports it before upload).
- A `description` is what the member agrees to, so `parsePluginManifest` holds it to that: no control or invisible formatting characters, not blank after the cleaning the approval page applies (`plainLine`), and not the words of a built-in scope (`readsAsBuiltInAppScope`, compared without letter case, alone or inside a longer text). On the approval page and in the Apps dialog a plugin scope reads `Through the plugin “<name>”: <description>` (`pluginAppScopeText` in `@core/members`). Core's words come first and the plugin's name sits between quotation marks core chose: double quotation marks of every kind are stripped from the name so it cannot close the quote, and a name that is blank after cleaning or repeats a built-in scope's text is replaced by the plugin id (the install is not refused). So neither the name nor the description can make one plugin scope read as a built-in entry or as several entries.
- An update keeps an approval only while the scope still reads the same. `storePluginManifest` (`server/handlers/cms/plugins/install.ts`) compares the installed manifest's `appScopes` with the new one (`diffPluginAppScopes`) and, in the transaction that replaces the plugin row, withdraws every scope that was removed or whose `description` changed: the sign-ins that carried it end and the scope comes off the registered apps, so the owner gives it back and the member is asked again in the new words. Unchanged scopes keep their approvals. This also holds for a reinstall of the same version and a JSON install over an existing row; a failed upgrade that rolls back does not restore what was withdrawn. The update's review screen marks each scope New, Reworded, Unchanged or Removed, warns that members will be asked again, and does not say "No new permissions in this update" when the scopes differ. The `plugin.update` audit event lists `withdrawnAppScopes`.
- Uninstalling the plugin ends every app sign-in that carried one of its scopes and takes those scopes off the registered apps (`withdrawPluginAppScopes`), in the same transaction that deletes the plugin row, so no failure later in the removal leaves an approval behind. A fresh install withdraws whatever is still recorded for its id as well, so a package installed later under the same id inherits nothing.
- The app calls with `Authorization: Bearer <access token>`. The host checks the token, the member behind it and the scope, then hands the handler `ctx.member` and `ctx.app`. The token is removed from `req.headers`, as the session cookie is, and not only there: `serializeRouteRequest` (`server/plugins/host/routeIo.ts`) drops the `Authorization` header from every request handed to plugin code whenever its value names a member app token (`imem_at_` or `imem_rt_`, in any letter case, anywhere in the value), under any scheme (`Bearer`, `DPoP`, `Token`, none) and on every kind of route, so an app that sends its token to everything on the mount does not hand it to a handler. A plugin's own secrets (a webhook signature, a proxy's Basic credentials) do not look like one and pass through. A request with a `Bearer` header (the scheme in any letter case) is treated as the app's even when a session cookie rides along; any other `Authorization` scheme is ignored when deciding who is calling and the cookie decides.
- An app call needs no `Origin` (no cookie is acting). A `tag` on the route still applies, through the member.
- 401 means the token is not live; 403 means the route is closed to apps, the sign-in lacks the scope, or the member lacks the tag.
- Keep writes closed unless an app really needs them: open read routes under one scope and leave anything that changes the account to the browser.

```js
const member = await api.cms.members.get({ email })            // or { id }; null when there is none
await api.cms.members.invite({ email, tags: ['pro'] })         // members.write (+ members.tags for tags)
await api.cms.members.tags.grant(member.id, 'pro', { expiresAt })  // members.tags
await api.cms.members.tags.revoke(member.id, 'pro')            // only this plugin's own grant
```

- A tag a plugin grants is recorded with the plugin id as its source. `revoke` withdraws that grant only: a tag an administrator or another plugin gave stays. Tags starting with `instatic:` cannot be granted.
- `invite` sends the site's invitation email. It rejects when the address already has an account, and when the site has no configured public address or no outgoing email (there is no request to take a link address from).

**Member events** (need `cms.hooks` and `members.read`): `member.created`, `member.verified`, `member.signedIn` (`{ memberId, email }`), `member.tagged` (`{ memberId, tag, source, expiresAt }`), `member.deleted` (`{ memberId }`). They are sent without waiting, so a listener cannot delay or cancel a sign-in.

### Email — requires `mail.send` / `mail.send.external`

A plugin sends only email it declared. The manifest lists its templates; each is a subject and a Markdown body with `{variables}`:

```jsonc
{
  "permissions": ["mail.send"],
  "mail": {
    "templates": [
      {
        "key": "ticket.reply",
        "label": "Ticket reply",
        "description": "Sent to the customer when the team answers a ticket.",
        "variables": [
          { "name": "subject", "label": "Ticket subject", "sample": "Publishing stops at 80%" },
          { "name": "link", "label": "Link to the ticket", "sample": "https://example.com/account/support/1042", "kind": "link" }
        ],
        "subject": "Re: {subject}",
        "body": "We answered **{subject}**.\n\n[Open the ticket]({link})"
      }
    ]
  }
}
```

```js
await api.cms.mail.send({
  template: 'ticket.reply',
  to: { member: memberId },              // mail.send: the host looks the address up
  variables: { subject, link },
  reference: `ticket-${id}`,             // optional, handed back with the outcome
})
await api.cms.mail.send({ template: 'ticket.opened', to: { address: 'support@example.com' }, variables })  // mail.send.external

const site = await api.cms.site.publicUrl()   // 'https://example.com' or null; no permission
```

- **Templates only.** There is no free-form subject, body, sender, cc, attachment or header. While the plugin is enabled its templates are in the mail catalogue as `plugin.<pluginId>~<key>`, grouped under the plugin's name in Email → Templates, where the owner can reword them, preview them and send a test. The owner's wording survives an upgrade (unless the upgrade drops that template) and is deleted on uninstall. (`server/mail/pluginTemplates.ts`, `src/core/plugins/manifestMail.ts`.)
- **What a template may contain.** The Markdown subset and nothing else: raw HTML is stripped to it by the sanitizer, so no forms, scripts, frames or styles. Each variable has a `kind`: `text` (the default) or `link`. A `text` variable may sit anywhere in a sentence (`Ticket #{id}`). A `link` variable must stand alone, with spaces, a line break or sentence punctuation around it, or be the whole address of a link (`[Open]({link})`); the manifest parser and `instatic-plugin lint` refuse a template that glues one into text (`Open:{link}`, `other.example/?t={link}`), puts a `text` variable against another variable or against text that reads as an address (`{a}.{b}`, `www.{name}`), or uses a variable it does not declare, so a template that installs is one that fills (see [email](email.md) → Templates).
- **Reviewed before install.** The install and upgrade review shows each template's subject and body in a script-less frame. An upgrade that adds a template or changes one (its subject, body, label, description, or the name or kind of a variable) flags it for approval, like an added permission.
- **Values are held to their kind.** A `link` value must be an `http(s)` address. A `text` value may not contain what could become a clickable address: `://`, `www.`, an `@`, `/` or `\\` between two words, a `.` or `:` joining two things other than digits (`3.5` and `12:30` pass; `evil.example`, `node.js`, `host:8080` do not), an IP address, or a control character. Every variable the template's current wording uses must be given, or `send` rejects with `variable_missing:` (an empty `link` counts as not given; a variable the template does not declare is refused). A refused value rejects `send` with a message starting `variable_not_allowed:`; if the email would still go out with a variable left in it, `send` rejects with `template_invalid:`. Nothing is queued in either case. The rule is simple on purpose and refuses some honest text (`node.js`, `and/or`): put such words into the template, not into a value. A value is sent as written, with only invisible characters removed; a value that would finish an address begun by the template's text around it (`.example` after `shop`) rejects with `template_invalid:`.
- **What this protects, and what it does not.** Members' single-use links exist only in the core's templates and never reach a plugin. The risk in plugin email is a plugin the owner installed and granted `mail.send` putting a clickable address into wording the owner approved. The value rule is a best-effort barrier against that, not a guarantee ([email](email.md) → Templates has the full threat model).
- **Braces are reserved.** A `{name}` that is not a declared variable (or `site.name` / `site.url`) is refused in the manifest and in the owner's edit; `\{name}` writes literal braces.
- **Values are text.** `variables` may only name variables the template declares; `site.name` and `site.url` are the site's and cannot be set. The renderer escapes every value, and a value becomes a link only when it is the whole address and `http(s)` (see [email](email.md) → Templates). Build links from `api.cms.site.publicUrl()`, never from a request's `Host` header.
- **Two permissions, two RPC targets.** `{ member }` goes through `cms.mail.send` (`mail.send`). The template and variables are checked first; then an id that is not an active member is refused with one answer, the same for an unknown, a deleted and a suspended member. `{ address }` goes through `cms.mail.sendExternal` (`mail.send.external`) and takes exactly one address. Holding one permission does not imply the other. Email to an address carries whatever the plugin puts in the variables off the site, so `mail.send.external` is a data channel that `networkAllowedHosts` does not restrict; the permission text says so.
- **Queued, not sent.** `send` resolves `queued` once the site's mail queue holds the email (or `captured` on a development server with no connector), and rejects when email is not set up in production. The queue sends in the background, after the core's own mail, and retries temporary failures until the email's deadline, a day after it was accepted ([email](email.md) → The queue). While the site's connector is paused for a wrong key or password, a plugin's email is accepted and held with everyone else's. The outcome arrives as an event.
- **Limits** (`server/mail/limits.ts`). Load is never refused: mail waits its turn. Three things are: more than 20 emails from one plugin to one recipient within a clock hour, more than 200 emails from one plugin to addresses (members do not count) within a clock hour, and more than 10,000 of one plugin's emails waiting. All are counted atomically in the database, so parallel sends cannot slip past them. A member is counted by id and an address by itself, never together, so a refusal cannot reveal which address a member has.
- **Outcome events** (need `cms.hooks`): `mail.delivered` (`{ template, to, reference }`) and `mail.failed` (`{ template, to, reference, reason }`). `to` is the recipient exactly as the plugin named it, `{ member }` or `{ address }`, and `reason` is one of `recipient_rejected`, `expired`, `template_removed`, `unreadable`, `recipient_unavailable` (the member was suspended or deleted before the email went out), `template_invalid` (it would have gone out with a variable still in it). A plugin never receives a member's address or the provider's own error text (which can quote one); the full sentence is in the admin's Activity. So `mail.send` is not a way to read members without `members.read`. Only the plugin that queued the email hears them (`hookBus.emitTo`). An outcome that arrives while the plugin is not listening (disabled, being reloaded or upgraded) is held in memory (500 per plugin, a day at most) and delivered when it next subscribes; a server restart in between loses it. Delivery is at most once: if the plugin's sandbox is torn down between the emit and the listener running, that outcome is not sent again (the admin's Activity has it). An install hears only about email it queued itself: each install has a random id that its queued email carries, so uninstalling and installing the same id again starts with nothing.
- **When the plugin goes away.** A disabled plugin's templates leave the catalogue and what it had waiting waits with them: it is sent when the plugin is enabled again, or fails as `expired` at its deadline. Reloading the plugins (another plugin's uninstall, any upgrade) never fails waiting email. Uninstalling removes the plugin's waiting email from the queue at once, and an upgrade that drops a template fails what was waiting for it (`template_removed`).

### Plugin-owned records — requires `cms.storage`

```js
const items = api.cms.storage.collection('items')
const all   = await items.list()
const made  = await items.create({ title: 'Draft', status: 'pending' })
const same  = await items.get(made.id)                       // record or null
await items.update(made.id, { title: 'Draft', status: 'approved' })
await items.delete(made.id)
```

Plugin storage is per-plugin, per-collection: every call is scoped to the calling plugin's id, so a plugin can neither read another plugin's records nor collide with its keys. The collection name must match a `resources[].id` declared in the manifest. The repository is `server/repositories/pluginRecords.ts`; the host handlers are `server/plugins/host/handlers/storage.ts`.

| Method | Resolves | Notes |
|---|---|---|
| `list(options?)` | `{ records, totalCount }` | `StorageListOptions` (`src/core/plugin-sdk/storageSchemas.ts`): filter, orderBy, limit (default 100, max 1000), offset. Semantics below. |
| `get(id)` | record or `null` | |
| `getByKey(value)` | record or `null` | Needs a `uniqueField` on the resource. |
| `create(data)` | record | Rejects with `storage_duplicate:` when the unique key is taken. |
| `createIfAbsent(data)` | `{ record, created }` | Needs a `uniqueField` and a value for it. Atomic. |
| `update(id, data, { ifVersion }?)` | record or `null` | Replaces the whole `data`; `version` goes up by one. With `ifVersion`, rejects with `storage_conflict:` unless the record is still at that version. |
| `delete(id, { ifVersion }?)` | `boolean` | Same `ifVersion` rule. |

A record is `{ id, pluginId, resourceId, data, uniqueKey, version, createdAt, updatedAt }`. `version` starts at 0.

`list` means the same on SQLite and Postgres (one case table runs against both: `src/__tests__/helpers/pluginRecordFilterCases.ts`):

- **Filters are typed by the value you compare with.** `{ amount: 9 }` matches records whose `amount` is the number 9, never the string `"9"`; `{ paid: true }` matches booleans only; `{ id: 'x' }` strings only. The operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` (values of mixed types allowed) and `like` (strings; `%` and `_` are wildcards, a backslash escapes them, and only ASCII letters ignore case: `'ÉCOLE'` matches `'École%'`, `'école'` does not). A row whose field holds another type matches no comparison, `ne` included.
- **`null` means "missing or null".** `{ field: null }` matches records without the field or with `null` in it; `{ field: { ne: null } }` matches the rest. `null` cannot be used with the ordering operators.
- **Strings compare byte-wise** (`'B' < 'a'`), not by the database's locale, for `gt` / `lt` and for ordering.
- **`orderBy` sorts by type, then value:** records without the field first, then booleans (false, true), then numbers by value, then strings. `desc` reverses the whole sequence. Ties, and a list with no `orderBy`, fall back to newest first.
- Filters and ordering reach top-level fields only, and field names must be plain identifiers.

Record data is a JSON object, at most 512 levels deep. Text Postgres cannot store is refused on create and update on both databases, so a plugin behaves the same on either: the NUL character (`\u0000`) and an unpaired surrogate, in a key or a value at any depth.

**Unreadable records.** A stored row whose data is not a JSON object (or nests deeper than 512 levels) does not fail the list: it comes back with `data: {}` and `unreadable: true`, and is logged once as `[plugin:<id>]`. The admin resource page says the record could not be read. `update` on such a record is refused (`PluginRecordUnreadableError`), because it would silently replace whatever the row held; `delete` works. On Postgres, a row still in the old string form (see `036_plugin_records_json_repair` in `docs/reference/database-dialects.md`) is not unreadable: it reads and updates normally. `list` filters do not match it until it is saved again; the server log gives the count of such rows after the migration (`[migrations]`).

**Unique keys.** A resource may name one `text` field as its `uniqueField`. The host copies that field's value into an indexed column with a unique index over `(plugin, resource, key)`. The key is the value with surrounding whitespace trimmed and nothing else changed, at most 512 characters: it is case-sensitive and compares by code point, so `Evt_1` and `evt_1` are two keys, and so are a precomposed and a decomposed accent. Normalise in the plugin if you need otherwise. A record that leaves the field empty has no key and never collides. `getByKey` trims its argument the same way (`deriveRecordUniqueKey` in `src/core/plugins/resourceRecords.ts` is the one derivation). `parsePluginManifest` and `bun instatic-plugin lint` reject a `uniqueField` that is not a declared `text` field.

```ts
resources: [{
  id: 'events',
  title: 'Events',
  uniqueField: 'eventId',
  fields: [
    { id: 'eventId', type: 'text', label: 'Event id', required: true },
    { id: 'state', type: 'text', label: 'State' },
  ],
}]
```

**Handlers interleave. Write for it.** A plugin has one worker per server process and no queue in front of it: two route calls, or a route and a hook, run interleaved at every `await`, and each server instance sharing a Postgres database runs its own worker. "`list`, then `create` if nothing came back" is therefore a race: two deliveries of one webhook both see nothing and both create. Use the two calls the database decides in a single statement:

- **Exactly once: `createIfAbsent`.** Of any number of concurrent calls with the same key, on one instance or several, exactly one gets `created: true`; the rest get the stored record and `created: false`.
- **Read, change, write back: `update(..., { ifVersion })`.** Of several writers that read the same version, one succeeds; the others reject with `storage_conflict:` and should read again and retry.

```js
// A webhook that may be delivered twice, or twice at once.
api.cms.routes.public.post('/webhook', async ({ body }) => {
  const claim = await events.createIfAbsent({ eventId: body.id, state: 'received' })
  if (!claim.created) return { ok: true }          // already handled, or being handled
  await grantAccess(body)                           // must itself be safe to repeat
  await events.update(claim.record.id, { eventId: body.id, state: 'done' }, { ifVersion: claim.record.version })
  return { ok: true }
})
```

If the handler can fail between the claim and the work, key the record on the event and store its progress in `state`, so a retry finds `received` and finishes the job instead of skipping it.

**Refusals are message prefixes.** The plugin RPC carries only an error message, so tell refusals apart with `err.message.startsWith(...)`: `storage_duplicate:` (the unique key belongs to another record) and `storage_conflict:` (the record changed since `ifVersion` was read). The constants are `STORAGE_DUPLICATE_PREFIX` and `STORAGE_CONFLICT_PREFIX` in `storageSchemas.ts`.

**When the declaration changes.** Stored keys follow the manifest. Whenever an install or upgrade (package or JSON) declares a resource whose `uniqueField` differs from what was stored before, including a resource declared for the first time over records that already exist, the host rebuilds every key of that resource from the new field (`rekeyPluginRecords`) in the same transaction that stores the manifest. It is refused up front, with the old version still running, when two existing records share a value or a value is longer than 512 characters, and, when the plugin gives an existing resource a different `uniqueField`, when that resource holds more than 50,000 records. The record limit never applies to a rollback or to a resource the previous manifest did not declare: restoring keys must not be blocked by size. That re-key runs in one transaction however many records the resource holds, so on a very large resource it holds its row locks, and the install request, until every key is written. Removing the `uniqueField` clears the keys. A failed upgrade's rollback restores the previous manifest and keys in one transaction; if that itself fails (records written by the failed version can make the old keys collide) the plugin is unloaded and left in `error` with the reason, its manifest and keys still those of the last transaction that succeeded, never half-keyed.

Migration `037_plugin_record_keys` adds the two columns and the unique index. On Postgres, building the index blocks writes to `plugin_records` for as long as it takes to scan the table (well under a second for the sizes plugins hold; a few seconds per million rows).

Editor-side plugin code (`api.cms.storage` in an editor entrypoint) and the admin resource pages go through `/admin/api/cms/plugins/:id/resources/:rid/records`, which offers list, create, update and delete only. A create or update that hits the unique key answers `409` with the message, which the resource page shows as a toast.

### CMS hooks — requires `cms.hooks`

```js
api.cms.hooks.on('publish.after', async (event) => { /* … */ })
api.cms.hooks.filter('publish.html', async (html) => html + '<!-- plugin -->')
const name = await api.cms.hooks.emit('sync.done', { /* … */ })
// name === 'plugin.<your-plugin-id>.sync.done'
```

**Host-emitted events** (the reserved core list, `CoreHookEvent` in `src/core/plugins/hookBus.ts`): the `member.*` events (see "Site members" above), `publish.before`, `publish.after`, `content.entry.created`, `content.entry.updated`, `content.entry.deleted`, `settings.changed`. **Filters**: `publish.html`, `publish.headers`, `content.entry.cells`.

A page rendered for a signed-in member on a protected route is passed to a plugin's `publish.html` filter only when the plugin also holds `members.read`; without it the filter is skipped for that render and the page is sent as it is.

Every filter handler returns the same runtime value type it received. `src/core/plugins/hookBus.ts` checks each result before passing it to the next handler; a mismatched result keeps the previous value and logs the offending plugin ID. For example, `publish.html` returns a string and `content.entry.cells` returns an object, never `null`.

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
  cookies: Record<string, string> // populated ONLY for perVisitor sources; session cookies are removed
  member?: { id, email, tags, profile } | null // perVisitor sources of a plugin holding members.read
}
```

**The signed-in member.** A `perVisitor` source of a plugin that holds `members.read` also gets `ctx.request.member`: the same record a route's `ctx.member` carries, or `null` when nobody is signed in (and in a branch preview, which has no visitor). It is set on any page, protected or not, so an account menu on a public page works, and on the later pages of a paged list (`/_instatic/loop/<id>`) as on the first. Suspended and deleted members have no session, so they arrive as `null`. Without `members.read` the source gets the cookies and no `member` field, and the host does not look the member up. The request is built per source (`sourceRequestFor` in `server/publish/loopSourceRequest.ts`): a source that is not per-visitor gets empty cookies and no `member`, even when its list sits beside or inside a per-visitor one, and `requestForPluginSource` (`server/plugins/host/handlers/loops.ts`) enforces the same on every fetch, so withdrawing the permission takes effect at once. A fragment holding any per-visitor list (the node itself, a list nested in another list's item, a list inside a Visual Component) is rendered for one visitor, never cached, and sent `Cache-Control: private, no-store`.

At publish time (built-in, non-dynamic loops) `ctx.request` is `undefined` and the source must be deterministic. `ctx.db` and the full `site` are NOT sent to the worker — reach data via `api.cms.storage.*` or a gated `fetch(...)`.

### How a hole hydrates

When a `base.loop` is bound to a `requestDependent` / `perVisitor` source, the publisher does NOT bake it. It emits a `<instatic-hole>` placeholder (`display: contents`, so it adds no wrapper box) and injects the ~1.1 KB hole runtime once per page (`/_instatic/hole-runtime.js?v=<contentHash>` — the hash of the runtime itself, so a CMS update busts the cache). The runtime fetches each fragment from `/_instatic/hole/<nodeId>?v=<snapshotHash>&u=<page-url>` — lazily via `IntersectionObserver` when the placeholder has visible skeleton content, eagerly on load otherwise — then swaps it in. It forwards the visitor's page path + query, and cookies ride along for `perVisitor` holes. Fully-static pages ship zero JS from the publisher.

See [docs/features/publisher.md](publisher.md) for the full three-layer pipeline.

### Module JS on published pages — requires `frontend.assets`

A plugin module's `render()` may return `js` (see `PluginRenderOutput`). It crosses the QuickJS boundary string-typed (non-strings are dropped by the VM normalizer) and is then gated host-side in `moduleAdapter.ts`: unless the plugin's **granted** permissions include `frontend.assets` — the same authority that already controls script tags via `frontend.assets[]` — the `js` is dropped with one `console.warn` per module. Enforcement always checks `grantedPermissions`, never the declared `permissions` array. With the grant, the JS is deduped per moduleId and served at `/_instatic/module-js/<moduleId>.js?v=<contentHash>` on pages that use the module. Manifest format is unchanged.

### Frontend assets — requires `frontend.assets`

Published-page tags are declarative. A plugin declares `frontend.assets[]` in the manifest; `server/publish/frontendInjections.ts` reads that array at publish/render time and splices the tags into every published page. There is no imperative runtime registration call.

```jsonc
{
  "permissions": ["frontend.assets"],
  "frontend": {
    "assets": [
      { "kind": "script", "src": "frontend/tracker.js", "placement": "body-end", "strategy": "defer" },
      { "kind": "style", "href": "frontend/widget.css", "placement": "head-end" },
      { "kind": "meta", "attrs": { "name": "acme-widget", "content": "enabled" } },
      { "kind": "link", "attrs": { "rel": "preconnect", "href": "https://cdn.example.com" } }
    ]
  }
}
```

Supported `kind` values are `script`, `script-inline`, `style`, `style-inline`, `link`, and `meta`. Placements are `head`, `head-end`, `body-start`, and `body-end`; defaults are chosen by tag type when omitted. `head` lands directly below the page's CSP `<meta>` rather than at the very top, because a `<meta>` policy does not govern anything the parser reaches before it. `script.strategy` maps to `defer`, `async`, `module`, or sync script emission. `src` / `href` paths are plugin-package-relative safe paths resolved under `/uploads/plugins/<id>/<version>/`. The one exception is a `script` whose `src` is an absolute `https://` address on a host the plugin declared in `frontend.origins.scripts` (below); a stylesheet `href` is always package-relative.

`attrs` passes through to the emitted tag except where `server/publish/frontendInjections.ts` owns the value: `data-plugin-id` on every tag, `src` on every script, strategy attributes on external scripts, and `href` plus `rel` on stylesheet assets. Bare `link` and `meta` declarations rely entirely on `attrs`. Inline JSON-LD uses `{ "kind": "script-inline", "attrs": { "type": "application/ld+json" }, "content": "..." }`.

The injection pipeline derives CSP changes from the plan, and every change adds to the policy the publisher emitted; none replaces a directive, so the importmap hash and the module-JS grant survive. Any script tag adds `'self'` to `script-src`. An inline style adds `'unsafe-inline'` to `style-src`.

**Inline scripts run by hash, never by `'unsafe-inline'`.** A `script-inline` asset a browser executes adds its own `'sha256-…'` to `script-src`. "Executes" follows the HTML standard: no `type` (or `type=""`), a `type` that is exactly a JavaScript MIME type, `module`, `importmap` or `speculationrules` (ASCII case-insensitive, surrounding ASCII whitespace ignored), or no `type` with a JavaScript `language`. A type with parameters (`text/javascript; charset=utf-8`) is a data block, as it is in a browser. The publisher never adds `'unsafe-inline'` for scripts: a policy that carries any hash makes browsers ignore it, so granting it would only describe behaviour that does not exist. What follows for plugin authors:

- The only inline code that runs on a published page is a declared `script-inline` asset. Inline event handlers (`onclick="…"`) and an inline `<script>` added any other way, including through the `publish.html` filter, are blocked by the browser. Attach handlers from a script, and ship code as an asset.
- The hash covers the text the browser sees: CR LF and lone CR in `content` are emitted as LF, which is what the HTML parser would make of them anyway. Inline `content` (script or style) may not contain U+0000, which the parser would replace; the manifest parser refuses it.
- A data block (`type="application/ld+json"`, a template, any non-script type) is not executed, needs no grant, and leaves the policy untouched: a page whose only plugin tag is JSON-LD keeps `script-src 'none'`.

**`connect-src` follows the plugin, not its tags.** An enabled plugin granted `frontend.assets` contributes its `networkAllowedHosts[]` to `connect-src` on every published page once it can run code in a visitor's browser: it declares at least one `frontend.assets[]` entry or `frontend.origins` host, or it ships a canvas module pack (`entrypoints.modules`, the per-plugin stand-in for "may render module JS", since which modules emit JS is only known per render). A plugin whose hosts serve its server code alone contributes nothing, and one plugin's tag never opens another plugin's hosts. A frontend tracker that calls its own or a third-party ingest endpoint must list that host as well as hold `frontend.assets`.

**When a change reaches a page.** Tags, origins and hosts are written into the page at render time: baked pages carry them from the publish that baked them. Installing, upgrading, enabling, disabling or removing a plugin does not rebake anything, so a baked page keeps what it had (a disabled plugin's tags and origins included) until the next publish.

#### Third-party origins — `frontend.origins`

A published page blocks every script and frame that is not its own (`script-src 'self'` at most, `frame-src 'none'`). A plugin that needs a third party's hosted code, such as a payment provider's script and the frames it opens, declares the hosts:

```jsonc
{
  "permissions": ["frontend.assets"],
  "networkAllowedHosts": ["api.payments.example"],
  "frontend": {
    "assets": [
      { "kind": "script", "src": "https://js.payments.example/v3", "strategy": "async" },
      { "kind": "script", "src": "frontend/checkout.js" }
    ],
    "origins": {
      "scripts": ["js.payments.example"],
      "frames": ["js.payments.example", "hooks.payments.example"]
    }
  }
}
```

- `scripts` are added to the page's `script-src`, `frames` to `frame-src`, each as `https://<host>`. Calls the page makes (`fetch`, XHR) still go through `networkAllowedHosts` → `connect-src`. Fonts, styles and other directives cannot be widened.
- An entry is a bare lowercase hostname or a leading-`*.` wildcard (`*.payments.example`, any subdomain depth, never the bare domain). No scheme, port, path, IP literal, single-label name, CSP keyword, or wildcard over a whole TLD (`*.com`); up to 20 per list. `FRONTEND_ORIGIN_HOST_PATTERN` in `src/core/plugins/manifestFrontend.ts` is the grammar.
- Names nobody owns as a whole are refused on top of the grammar (`frontendOriginRejection`, same file): private-network names (`*.local`, `app.localhost`, `*.internal`), the country-code public suffixes listed in that file (`co.uk`, `com.au`, …), and a wildcard directly under a shared-hosting domain (`*.github.io`, `*.vercel.app`, `*.cloudfront.net`, anything under `amazonaws.com`, and the rest of the list in that file). Name the exact host instead (`acme.github.io`). The list is a floor, not the Public Suffix List, so the review screen also prints a warning under every wildcard origin ("Any subdomain of …").
- A `script` asset may point at an absolute `https://` address only when its host matches one of the plugin's own `scripts` entries. The manifest parser refuses anything else, and the publisher checks again when it emits the tag. A `frames` entry does not authorise a script.
- Origins are granted with `frontend.assets` and enforced against the granted set: a plugin that is disabled, errored, or was not granted the permission contributes none to a page rendered from then on (a page baked earlier keeps them until the next publish, as above). A plugin may declare origins with an empty `assets` list when its module JS is what loads the third-party code; its `networkAllowedHosts` still reach `connect-src`.
- The install and upgrade review lists every origin in plain words ("May load scripts from …", "May embed frames from …"), and an upgrade that adds one flags it as new.
- There is no `integrity` requirement on an external script. Providers that need this (payment scripts in particular) update the file in place, which a pinned hash would break; the declared host is the control. Add `integrity` through `attrs` when the provider publishes versioned, immutable files.

**The editing canvas loads the stylesheets, and only the stylesheets.** A page styled by a plugin stylesheet has to look the same while editing as it does published, so the site editor's canvas loads every `style` and `style-inline` asset, in the published order (placement anchor, then plugin id, then manifest order). `script`, `script-inline`, `link` and `meta` assets never load in the canvas: it shares the admin origin and is an editing surface, so plugin frontend scripts must not run there. (The runtime preview is built by `buildRuntimePreviewDocument`, which runs the full `injectFrontendAssets` pass, so it gets every tag.)

Both surfaces start from one eligibility rule, `listFrontendAssetPlugins` in `server/publish/frontendInjections.ts`: the plugin is enabled, not in the error state, and was **granted** `frontend.assets`. `collectFrontendInjections` builds the published tags from it; `collectCanvasPluginStylesheets` (`server/publish/canvasStylesheets.ts`) builds the canvas list, served by `GET /admin/api/cms/runtime/canvas-stylesheets` (`site.read`). The canvas receives CSS text, not URLs: external files are read from the plugin's upload directory and their relative `url(...)` / `@import` references rebased onto the stylesheet URL, so the canvas can pin viewport units and keep plugin CSS in the author cascade layer. The `media` attribute is kept; an `@import` inside a plugin stylesheet is not followed in the canvas. Canvas side: [`docs/editor.md`](../editor.md) → "CSS injection into the iframe".

### Settings — declared in `instatic-plugin.config.ts` / `plugin.json`

```js
const key = api.cms.settings.get('apiKey')
const all = api.cms.settings.getAll()
await api.cms.settings.replace({ apiKey: 'new-value' })
```

Settings are typed with the current manifest field kinds: `text`, `textarea`, `number`, `toggle`, `select`, `color`, `url`, and `password`. The host renders them automatically on the plugin admin page. Only string-typed settings (`text`, `textarea`, `password`, `url`, `color`, `select`) may be declared `secret: true` — the manifest parser rejects a secret toggle or number.

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

### CMS content — requires `cms.content.*`; entry access also requires `contentAccess[]`

Plugins read and write CMS content (pages, posts, custom tables) through `api.cms.content.*`. Five permissions are split so most plugins (SEO assistants, translators, search indexers, AI helpers) get only what they need:

| Permission                    | Risk      | Plugin can                                                                 |
|-------------------------------|-----------|-----------------------------------------------------------------------------|
| `cms.content.read`            | Low       | List / read entries; read tree-shaped fields; read published snapshots; search |
| `cms.content.write`           | High      | Create / update entries; mutate tree-shaped fields; move entries between tables |
| `cms.content.publish`         | High      | Publish or schedule-publish entries; `republishAll()`                       |
| `cms.content.delete`          | High      | Soft-delete entries                                                          |
| `cms.content.tables.manage`   | Dangerous | Create user-managed tables (never system tables)                            |

The manifest's `contentAccess[]` lists every table whose entries the plugin can touch, with per-table modes. The host fails closed without both the permission and a covering allowlist entry for entry reads/writes/publishes/deletes. `content.tables.create(...)` is different: it requires `cms.content.tables.manage`, creates a new user-managed table, and does not require a pre-existing `contentAccess[]` row for that table.

An entry's `table` is a concrete slug, or the **`@own-created` marker** (`OWN_CREATED_TABLES_MARKER` in the SDK): it covers every table this plugin itself created through `content.tables.create(...)`. The create handler stamps the host-authenticated plugin id on the table row (`data_tables.created_by_plugin_id`), and the marker resolves against that stored creator — never against the slug — so it is durable across restarts and admin-side slug renames, and one plugin's marker never reaches another plugin's (or a user's) tables. This is the shape importer/migration plugins need: their table names are chosen by the operator at runtime and can't be pre-declared. Entries combine as a union — an operation is allowed when any matching entry declares the mode — and marker modes go through the same install-time modes↔permissions coherence check as slug entries.

```jsonc
{
  "permissions": ["cms.content.read", "cms.content.write", "cms.content.tables.manage"],
  "contentAccess": [
    { "table": "pages", "modes": ["read", "write"] },
    { "table": "posts", "modes": ["read"] },
    { "table": "@own-created", "modes": ["read", "write"] }
  ]
}
```

Usage:

```js
// Schema introspection
const tables = await api.cms.content.tables.list()
const pagesTable = await api.cms.content.tables.get('pages')
const createdTable = await api.cms.content.tables.create({
  name: 'Landing Pages',
  slug: 'landing-pages',
  singularLabel: 'Landing page',
  pluralLabel: 'Landing pages',
  fields: [
    { id: 'title', label: 'Title', type: 'text', required: true },
    { id: 'body', label: 'Body', type: 'pageTree' },
  ],
})

// Per-table CRUD
const pages = api.cms.content.table('pages')
const result = await pages.list({ status: 'published', limit: 50 })
const entry = await pages.get(entryId)
const bySlug = await pages.getBySlug('home')
await pages.update(entryId, { cells: { seoTitle: 'New title' } })
await pages.publish(entryId)
await pages.delete(entryId)

// Bulk
await pages.createMany([
  { slug: 'one', cells: { title: 'One', body: tree } },
  { slug: 'two', cells: { title: 'Two', body: tree } },
])
await pages.updateMany([
  { id: entryId, patch: { cells: { seoTitle: 'Updated title' } } },
])
await pages.deleteMany([entryId])

// Tree mutation — runs through the SAME engine as the visual editor
const bodyTree = api.cms.content.tree(entryId, 'body')
const currentTree = await bodyTree.read()
await bodyTree.mutate([
  { kind: 'insertNode', parentId: 'nd_root', index: 999, node: generatedNode },
])
await bodyTree.replace(currentTree)

// Cross-table
await api.cms.content.search('hello world', 25)
const snap = await api.cms.content.getPublishedSnapshot(entryId)
const { count } = await api.cms.content.republishAll()
```

`tables.create(input)` accepts the plugin-facing field projection, then maps it to the host's canonical `DataField` schema before storage. The created table records the calling plugin as `createdByPluginId`, which the `@own-created` contentAccess marker resolves against for all subsequent entry access; the table slug is restricted to kebab-case (leading letter), reserving the `@` namespace for markers. `richText` fields default to Markdown format, `select` / `multiSelect` option `value`s become stable option IDs, and `relation.targetTableSlug` must resolve to an existing table slug. `repeater` accepts a one-level `fields` schema made from ordinary authorable fields; nested relation slugs are resolved through the same gate, while recursive repeaters, `pageTree`, and `fieldSchema` item fields are rejected by the boundary schema.

`republishAll` fires the full publish pipeline (`publish.before` → `publish.html` → `publish.after`), so other plugins' filters and listeners participate.

Tree mutation and replacement payloads are validated against the canonical `@core/page-tree` TypeBox schemas before host dispatch. `insertNode.node` must be a complete `PageNode`, and `replace(tree)` must receive a complete `NodeTree` with a valid `rootNodeId`, matching node-map keys, resolvable child IDs, and no reachable cycles.

The host protocol names the per-table entry calls as `cms.content.entries.list`, `cms.content.entries.get`, `cms.content.entries.getBySlug`, `cms.content.entries.create`, `cms.content.entries.update`, `cms.content.entries.delete`, `cms.content.entries.publish`, `cms.content.entries.moveTable`, `cms.content.entries.createMany`, `cms.content.entries.updateMany`, and `cms.content.entries.deleteMany`. Tree calls dispatch as `cms.content.tree.read`, `cms.content.tree.mutate`, and `cms.content.tree.replace`; `getPublishedSnapshot(...)` dispatches as `cms.content.snapshot`.

`publish`, `delete` and `deleteMany` keep the baked publish slot in step, exactly as the Content workspace does: the entry's own page is written or removed, and baked pages that list its table through a loop are refreshed. See [publisher.md](publisher.md) → "Publishing one row, and the pages that list it".

#### Content events

Three event channels fire alongside every content write. Plugins use `actor` to skip their own writes (avoid feedback loops):

Successful CMS-native public form submissions emit `content.entry.created` with `{ kind: 'system' }`, so notification and automation plugins observe them through the same channel as other row creation.

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

### CMS media ingestion and extensions

The media plugin surface lives at `api.cms.media.*` and is implemented by `server/plugins/host/handlers/media.ts`. Managed-media ingestion is separate from the three extension tiers so an integration does not need storage-adapter authority, and a CDN URL rewrite plugin does not receive media-write authority.

#### Managed-media ingestion — requires `media.import`

Plugins can import remote images or package assets into the managed Media library without moving bytes through QuickJS. `sourceKey` is scoped to the calling plugin and makes the operation idempotent; `sourceVersion` lets an unchanged sync return immediately without reading the source. When the version changes, the host ingests the source and replaces the existing asset while preserving its id.

```js
const result = await api.cms.media.upsert({
  sourceKey: `catalog:${item.id}:hero`,
  source: { kind: 'remote', url: item.heroUrl },
  sourceVersion: item.updatedAt,
  filename: item.heroFilename,
  altText: item.name,
})

// Store result.asset.id in the content's media field.
```

Remote sources additionally require `network.outbound`. The URL must use HTTPS and every redirect host must match `networkAllowedHosts`. The Bun host downloads through the shared DNS-pinned SSRF guard and caps the response at 50 MB.

Plugins can also promote a bundled file into managed media without network authority:

```js
await api.cms.media.upsert({
  sourceKey: 'starter:default-hero',
  source: { kind: 'pluginAsset', path: 'assets/default-hero.jpg' },
  sourceVersion: api.plugin.version,
  filename: 'default-hero.jpg',
})
```

Package paths are resolved beneath the plugin's installed asset root; arbitrary host filesystem paths, traversal, and symlink escapes are rejected. Both sources are MIME-sniffed and passed through the ordinary upload pipeline. JPEG, PNG, WebP, and AVIF receive the WebP ladder, intrinsic dimensions, and BlurHash; storage adapters and variant delegates apply exactly as they do to an admin upload. If `sourceVersion` is unavailable, the host reads the source and compares a SHA-256 content hash instead.

#### Storage adapters — requires `media.storage.adapter`

Storage adapters replace local media storage for elected asset roles (`original`, `variant`, `avatar`, `font`). The admin elects adapters in the media storage settings UI; a plugin can register an adapter without becoming active for every role.

```js
api.cms.media.registerStorageAdapter({
  id: 'acme.media.r2',
  label: 'Cloudflare R2',
  roles: ['original', 'variant'],
  servingMode: 'signed-redirect',
  cspOrigins: [{ directive: 'img-src', origin: 'https://cdn.example.com' }],

  async beginWrite(input) {
    return {
      storagePath: `media/${input.contentHash}`,
      steps: [{
        method: 'PUT',
        url: `https://uploads.example.com/${input.contentHash}`,
        headers: { 'content-type': input.mimeType },
      }],
      expiresAt: Date.now() + 60_000,
    }
  },
  async finalizeWrite(input) {
    return { publicUrl: `/uploads/${input.storagePath}` }
  },
  async abortWrite(input) {},
  async getReadUrl(storagePath, ttlSeconds) {
    return {
      url: `https://cdn.example.com/${storagePath}?ttl=${ttlSeconds}`,
      expiresAt: Date.now() + ttlSeconds * 1000,
    }
  },
  async delete(storagePath) {},
  async verify() {
    return { ok: true }
  },
})
```

Writes are two-phase. The adapter returns a signed upload plan from `beginWrite`; the **host** streams the bytes to the plan URLs; then the adapter confirms with `finalizeWrite`. The plan URLs are plugin-controlled, so the host streams them through the same DNS-pinned SSRF guard it uses for adapter reads — internal addresses are refused and every redirect hop is re-validated, so `media.storage.adapter` cannot be used as `network.outbound` reach. There is no host allowlist on either side: an object-store endpoint is an arbitrary operator-chosen public host. Media bytes do not cross the QuickJS boundary for ordinary writes, which keeps large uploads out of the VM heap. `servingMode` controls reads: `public-url` emits the adapter URL directly, `signed-redirect` lets the host 302 to a short-lived URL, and `proxy` streams chunks through the host via `readStream`.

#### URL transformers — requires `media.url.transform`

URL transformers are pure path rewriters. They run wherever the renderer materializes a media URL: publisher, editor preview, and admin media views. Returning `null` passes the URL to the next transformer unchanged.

```js
api.cms.media.registerUrlTransformer((path, ctx) => {
  if (!path.startsWith('/uploads/')) return null
  const width = ctx.kind === 'variant' ? `?w=${ctx.width}` : ''
  return `https://cdn.example.com${path}${width}`
})
```

#### Variant delegates — requires `media.variant.delegate`

Variant delegates replace the local responsive-image ladder with a URL template. When one is elected, the host stores the original and BlurHash, but variant URLs are computed from the delegate template on demand.

```js
api.cms.media.registerVariantDelegate({
  id: 'acme.media.imgix',
  variantUrlTemplate: 'https://img.example.com{path}?w={width}&fm={format}&q={quality}',
  widths: [320, 640, 960, 1280, 1600],
  formats: ['webp', 'avif'],
})
```

Storage adapter and variant delegate ids must be namespaced under the plugin id (`<pluginId>.<rest>`). Registration is host-side state; re-registering the same id on re-activation replaces the previous definition.

### Outbound HTTP — requires `network.outbound` + `networkAllowedHosts`

```js
const res  = await fetch('https://api.example.com/data')
const data = await res.json()

// Binary is first-class in both directions:
const img   = await fetch('https://cdn.example.com/pixel.png')
const bytes = new Uint8Array(await img.arrayBuffer())   // exact upstream bytes
await fetch('https://api.example.com/upload', { method: 'POST', body: bytes })

// Ask for a redirect instead of following it (a signed download link, say):
const hop  = await fetch('https://api.example.com/asset/42', { redirect: 'manual' })
const link = hop.status === 302 ? hop.headers.get('location') : null
```

Bodies are **byte-safe in both directions**. The host reads upstream responses as raw bytes and ships them to the sandbox tagged `utf8` (text verbatim) or `base64` (binary), so `res.text()` / `res.json()` decode correctly (including multibyte UTF-8) and `res.arrayBuffer()` returns the exact bytes — fetching images, gzip, or protobuf works. Request bodies accept `string | ArrayBuffer | TypedArray/DataView`; anything else (`FormData`, `Blob`, `URLSearchParams`, streams) throws a `TypeError` naming the supported types — serialize to a string or bytes first. The VM `fetch(...)` polyfill dispatches through the `network.fetch` host target; aborts use `network.abort`. Wire codec: `server/plugins/protocol/bodyEncoding.ts`.

The permission alone is insufficient. `performGatedFetch` in `server/plugins/host/network.ts` enforces three checks on **every request and every redirect hop**:

1. **Allowlist check.** The URL host must match an entry in `manifest.networkAllowedHosts`. Wildcards (`*.cdn.example.com`) match one level deep — `*.foo.com` matches `bar.foo.com` but not `foo.com` or `a.bar.foo.com`. An empty or missing allowlist fails closed (all outbound denied).

2. **DNS resolution + SSRF guard.** The hostname is resolved to its addresses via the system DNS resolver **before** the connection is made. If any resolved address falls in a blocked range, the request is rejected — even when the host is allowlisted. Blocked ranges: loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), unique-local (`fc00::/7`), unspecified (`0.0.0.0/8`, `::`), and IPv4-mapped IPv6 forms of all of the above. This prevents DNS rebinding attacks (an allowlisted hostname that resolves to an internal IP is blocked).

3. **Manual redirect following with re-validation.** The host does not use transparent redirect following (Bun is always told `redirect: 'manual'`). Each redirect location is validated with both the allowlist and the DNS SSRF guard before the next hop. The chain is capped at 5 hops. Method downgrade (303 → GET; 301/302 non-GET → GET) follows the Fetch spec. A hop to another origin (scheme, host or port) drops exactly three request headers, `Authorization`, `Cookie` and `Proxy-Authorization` (matched case-insensitively), for that hop and every later one. Nothing else is removed: a secret in a custom header (`X-Api-Key`, say) and the request body of a 307 or 308 still travel to the redirect target, which must itself be on the allowlist. A plugin that sends secrets that way should use `redirect: 'manual'` and decide for itself. A redirect status with no `Location` header is returned as the response. This applies to every `guardedFetch` caller, including media uploads and downloads.

**Timeouts.** A request that takes longer than 15 s in total (`DEFAULT_PLUGIN_FETCH_TIMEOUT_MS`), with the DNS lookup, every redirect hop and the response body included, is cancelled upstream and the `fetch` rejects with an error named `TimeoutError` (`Plugin "<id>" fetch timed out after <ms>ms`; the host marks it with `code: 'fetch_timeout'` on the api-reply). `fetch(url, { timeout: ms })` sets another limit for that request: a whole number of milliseconds from 1 to 300000, anything else throws a `TypeError`. Whatever the limit, the sandbox cuts it down so the request ends while its call can still handle the answer: the time left in the call, less a handling margin (a tenth of the call's budget, at least 1 s, at most half of it: 2 s for a route). A request that would get under 250 ms is not started and rejects at once with the same `TimeoutError`. So two requests in a row to a host that is down cost one timeout and one immediate rejection, both catchable, and the handler still has time to answer. Handlers interleave on one VM and a host call cannot be tied to the call that made it (QuickJS does not say which call a running job belongs to), so "the call" is whichever one in flight has the least time left: **any call in flight caps every request started meanwhile.** A schedule with a 60 s budget can see its request cut to under a second, or refused, while a route is in flight. That is a catchable timeout. Long downloads belong in a schedule that treats it as "try again next run", or better, in several short requests. A refusal (allowlist, blocked address) is always reported as that refusal, even when it arrives after the limit. An `AbortSignal` cancels a request sooner, as before. The timeout applies to plugin `fetch` only; the host's own media transfers through `guardedFetch` have no fixed limit, since a large upload or download has no sensible one.

**The `redirect` option.** `fetch(url, { redirect })` accepts `'follow'` (default, as above), `'manual'` and `'error'`; any other value throws a `TypeError` in the sandbox.

- `'manual'` returns the redirect response itself for any redirect status (301, 302, 303, 307, 308): `res.status` is the 3xx, `res.ok` is `false`, and `res.headers.get('location')` is the target as the server sent it (it may be relative or absent; several `Location` headers arrive joined with `, `). It is an ordinary response, not the browser's opaque redirect, and it has **no body**: the host drops a redirect's body without reading it. The first hop passes checks 1 and 2 exactly as any request does; the target is never resolved or contacted, so it does **not** need to be in `networkAllowedHosts`. The `Location` value is a string the upstream server chose: treat it as untrusted (it can name any address, internal ones included) and never fetch it from the plugin without it passing the allowlist like any other URL. Handing it to a visitor's browser in a redirect is the intended use.
- `'error'` rejects on any redirect status, with or without a `Location`.
- `res.redirected` is `true` when the host followed at least one hop.

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

Targets intentionally absent from `TARGET_PERMISSIONS` require no permission and are explicitly ungated: `cms.settings.replace` (any active plugin may update its own settings), `network.abort` (no active id without `network.outbound`), `crypto.digest` and `crypto.signHmac` (pure computation, no I/O — same model as `Math`/`JSON`), and `cms.site.publicUrl` (the site's public address). Two conditional checks that a static map cannot express remain in their handlers: `cms.routes.register` with `access.kind === 'public'` additionally requires `cms.routes.public` and with `access.kind === 'member'` requires `members.read`, `cms.hooks.on` for a `member.*` event requires `members.read`, `cms.members.invite` with tags requires `members.tags`, and every `cms.content.*` handler additionally calls `assertContentTableAccess` for the per-table manifest allowlist.

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
| `cms.routes.public`         | Server               | Dangerous | Register anonymously-callable routes; requires `cms.routes` too          |
| `members.read`              | Server               | High      | See the signed-in member on its routes and per-visitor loop sources, register member routes, look members up, hear member events |
| `members.write`             | Server               | High      | Invite site members                                                      |
| `members.tags`              | Server               | Dangerous | Grant and withdraw member access tags (what a member may open)           |
| `mail.send`                 | Server               | High      | Send the plugin's own email templates to site members                    |
| `mail.send.external`        | Server               | Dangerous | Send the plugin's own email templates to any address                     |
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
| `visualComponents.register` | Admin / manifest     | Medium    | Ship VCs / page templates / class / layout packs (via `pack/site.json`) |
| `dashboard.widgets.register`| Admin                | Medium    | Register cards in the admin dashboard widget grid                       |
| `frontend.assets`           | Frontend / manifest  | High      | Inject declarative tags into every published page; also gates module render() `js` and `frontend.origins` (third-party script / frame hosts) |
| `network.outbound`          | Server               | High      | Make outbound HTTP requests (with `networkAllowedHosts` allowlist)      |
| `media.import`              | Server / CMS media   | High      | Upsert managed media from a remote URL or contained package asset       |
| `media.storage.adapter`     | Server / CMS media   | Dangerous | Register an electable media storage backend                             |
| `media.url.transform`       | Server / CMS media   | Medium    | Rewrite media URLs at render/preview/admin read time                    |
| `media.variant.delegate`    | Server / CMS media   | High      | Replace local responsive variant generation with URL templates          |
| `unstable.internals`        | Admin / editor / server | Dangerous | Reserved for trusted first-party plugins                            |

Full descriptions and labels live in `src/core/plugin-sdk/capabilities.ts` — the source of truth.

---

## CLI workflow

`bun instatic-plugin <command>` runs the SDK CLI at `src/core/plugin-sdk/cli/` (`bun run instatic-plugin <command>` works too inside this repo). The CLI's primary input is `instatic-plugin.config.ts`.

```sh
bun instatic-plugin init acme.hero    # scaffold a module plugin
bun instatic-plugin init acme.seo --kind content-editor
bun instatic-plugin lint              # validate config + manifest + sources + bundles
bun instatic-plugin build             # produce dist/ + .plugin.zip
bun instatic-plugin dev               # watch + sync into a running CMS
```

The default scaffold kind is `module` (one canvas module). `--kind content-editor` scaffolds a server plugin that subscribes to content events and uses `api.cms.content.*`.

Minimal typed config:

```ts
import { definePlugin, permissions } from '@instatic/plugin-sdk'

export default definePlugin({
  id: 'acme.workflow',
  name: 'Workflow',
  version: '1.0.0',
  description: 'Approval workflow for pages.',
  permissions: [
    permissions.cmsRoutes,
    permissions.cmsStorage,
    permissions.adminNavigation,
  ],
  resources: [
    {
      id: 'approvals',
      title: 'Approvals',
      fields: [
        { id: 'title', label: 'Title', type: 'text', required: true },
        { id: 'approved', label: 'Approved', type: 'boolean' },
      ],
    },
  ],
  adminPages: [
    {
      id: 'approvals',
      title: 'Approvals',
      icon: 'checkmark',
      content: { kind: 'resource', heading: 'Approvals', resource: 'approvals' },
    },
  ],
})
```

The build script auto-wires entrypoints from source folders: `server/index.{ts,js}`, `editor/index.{ts,js}`, top-level `frontend/*.ts(x)`, app-kind admin page entries referenced by `adminPages[].content.entry`, and `modules/*.ts(x)` declared through `modules: [...]`.

### Local dev with hot sync

`instatic-plugin dev` writes built files **directly** into the host's `uploads/plugins/<id>/<version>/`. Subsequent rebuilds are picked up on the next activation cycle.

When running inside the instatic monorepo, the CLI auto-detects the host's `uploads/` by walking up the tree. From a separate plugin repo:

```sh
INSTATIC_UPLOADS_DIR=../instatic/uploads bun instatic-plugin dev
# or
bun instatic-plugin dev --uploads ../instatic/uploads
```

First install still goes through the admin UI (`/admin/plugins` → Upload Plugin) so the owner approves permissions. Every `instatic-plugin dev` rebuild after that flows in without another upload.

**The SDK import specifier is monorepo-only today.** `@instatic/plugin-sdk` is not a published package, and `@core/plugin-sdk` (what `instatic-plugin init` scaffolds) resolves through this repo's `tsconfig.json` `paths`, so neither works from a plugin repo that does not sit inside an Instatic checkout. Until the SDK ships to a registry, an out-of-tree plugin has to point at the SDK itself — for example a single indirection module re-exporting `<instatic>/src/core/plugin-sdk/index.ts`, with the path written from an env var at build time so it lives in exactly one place. The CLI, the lint pass and the sandbox scan all work fine that way; only the bare specifier does not resolve.

---

## Adding a new plugin

1. **Scaffold:**
   ```sh
   bun instatic-plugin init my-plugin
   cd my-plugin
   ```
2. **Edit `instatic-plugin.config.ts`.** Pick a namespaced ID (`vendor.product`), declare only the permissions you use, and add resources, settings, admin pages, modules, frontend assets, content access, or packs there.
3. **Write entrypoint source files.** Add `server/index.ts` for sandboxed server hooks/routes/schedules/media, `editor/index.tsx` for unsandboxed editor/dashboard surfaces, top-level `frontend/*.ts` files for published-page scripts, and app entries referenced by `adminPages[].content.entry` for custom admin pages.
4. **Use SDK builders.** Import from `@instatic/plugin-sdk` for `definePlugin`, `permissions`, `defineModule`, `definePack`, controls, and types. The CLI emits `plugin.json` and runtime bundles into `dist/`.
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

  api.cms.routes.post('/subscribe', 'plugins.configure', async ({ body, user }) => {
    const sub = await subscribers.create({ email: body.email, addedBy: user.id })
    return { ok: true, id: sub.id }
  })

  api.cms.routes.get('/subscribers', 'plugins.read', async () => {
    return { rows: await subscribers.list() }
  })
}
```

Manifest:

```ts
// instatic-plugin.config.ts
import { definePlugin, permissions } from '@instatic/plugin-sdk'

export default definePlugin({
  id: 'acme.subscribers',
  name: 'Subscribers',
  version: '1.0.0',
  permissions: [permissions.cmsRoutes, permissions.cmsStorage],
  resources: [
    {
      id: 'subscribers',
      title: 'Subscribers',
      fields: [
        { id: 'email', type: 'text', label: 'Email', required: true },
        { id: 'addedBy', type: 'text', label: 'Added by' },
      ],
    },
  ],
})
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
| Calling a host capability without the matching permission                | Declare it in `instatic-plugin.config.ts` / `plugin.json` permissions |
| Reaching the DB directly from a plugin                                   | Use `api.cms.storage.*`                                      |
| IP literals or `localhost` in `networkAllowedHosts`                      | Use a hostname — rejected at manifest parse time             |
| `FormData`, `Blob`, `URLSearchParams`, or streams as sandbox `fetch` bodies | Serialize to `string`, `ArrayBuffer`, or a typed-array view |
| `entrypoints.admin` for custom admin pages                               | Use `adminPages[].content.kind === "app"` with `content.entry` |
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
  - `src/core/plugin-sdk/types/editorApi.ts` — editor / dashboard browser API
  - `src/core/plugin-sdk/types/frontend.ts` — published-page frontend asset declarations
  - `src/core/plugins/manifestFrontend.ts` — `frontend` manifest schema, coherence rules, third-party origin matching
  - `src/core/plugins/manifestMail.ts` — `mail` manifest schema, coherence rules, catalogue keys of a plugin's templates
  - `server/plugins/host/handlers/mail.ts` — `cms.mail.*` and `cms.site.publicUrl`, outcome events
  - `server/mail/pluginTemplates.ts`, `server/mail/limits.ts` — a plugin's templates in the mail catalogue, the per-plugin limits
  - `src/core/plugin-sdk/types/media.ts` — media storage / URL / variant plugin API
  - `src/core/plugin-sdk/builders/definePlugin.ts` — typed config builder
  - `src/core/plugin-sdk/builders/permissions.ts` — permission aliases for plugin authors
  - `src/core/plugin-sdk/builders/settings.ts` — setting field shapes and secret sentinel
  - `src/core/plugin-sdk/cli/` — `instatic-plugin` CLI
  - `src/core/plugins/manifest.ts` — manifest parser + validator
  - `src/core/plugins/events.ts` — `PluginEventSchema`, `PluginEvent` type, `PLUGIN_EVENT_KINDS`
  - `src/core/plugins/` — host-side runtime
  - `server/plugins/runtime.ts` — boot-time plugin activation
  - `server/plugins/pluginWorker.ts` — Bun worker bridge that hosts QuickJS per plugin
  - `server/plugins/host/workerPool.ts` — per-plugin worker lifecycle and RPC timeouts
  - `server/plugins/host/apiDispatch.ts` — centralized host-side RPC permission enforcement
  - `server/plugins/protocol/apiCallSchema.ts` — RPC target schemas
  - `server/plugins/host/handlers/media.ts` — media extension RPC handlers
  - `src/core/plugins/mediaStorageRegistry.ts` — registered/elected media storage adapters
  - `src/core/plugins/mediaVariantDelegateRegistry.ts` — registered/elected variant delegates
  - `src/core/dashboard/registry.ts` — dashboard widget registration
  - `server/publish/frontendInjections.ts` — published-page frontend asset injection + CSP
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
  - `src/__tests__/architecture/plugin-secrets-never-leak.test.ts`
  - `src/__tests__/architecture/no-plugin-tab-shells.test.ts`
  - `src/__tests__/architecture/sandbox-crypto-bridge.test.ts`
  - `src/__tests__/architecture/plugin-bootstrap-fresh.test.ts` — generated bootstrap artifacts match source; fails if `bun run bootstrap:sync` is needed
  - `src/__tests__/architecture/module-js-asset-route.test.ts`
  - `src/__tests__/architecture/media-storage-no-bytes-in-sandbox.test.ts`
  - `src/__tests__/architecture/media-storage-panel.test.ts`
  - `src/__tests__/architecture/media-signed-redirect-serving.test.ts`
  - `src/__tests__/architecture/media-presentation-pipeline.test.ts`
  - `src/__tests__/plugins/gatedFetchSsrf.test.ts` — SSRF guards: allowlist, DNS rebinding, redirect re-validation, redirect cap, `redirect: 'manual' | 'error'`, credential headers dropped on a cross-origin hop
  - `src/__tests__/plugins/pluginBinaryIo.test.ts` — host-side byte safety: wire codec round-trips, binary fetch bodies, multipart file fields, binary route responses
  - `src/__tests__/plugins/pluginDashboardWidgets.test.ts` — dashboard widget registration surface
  - `src/__tests__/plugins/pluginSettings.test.ts` — settings rendering and persistence behavior
  - `src/__tests__/publisher/frontendInjections.test.ts` — frontend asset tag injection and CSP rewriting
  - `src/__tests__/server/pluginMediaAdapterBoundary.test.ts` — media adapter RPC boundary
  - `src/__tests__/server/pluginVmBinaryIo.test.ts` — VM-side byte safety: fetch `arrayBuffer()`/`text()`/`json()` decoding, binary request bodies, unsupported-body TypeError, route file facades + binary `__response`
  - `src/__tests__/plugins/pluginModulePack.test.ts` — module pack activation, re-activation, deactivation, and VM disposal
  - `src/__tests__/server/pluginVmPermissions.test.ts` — VM-side permission check: declared-but-not-granted permissions are denied at the VM boundary before host dispatch
  - `src/__tests__/server/pluginVmLoopDispatch.test.ts` — loop fetch/preview dispatcher robustness (no-return fallbacks, async-preview detection)
  - `src/__tests__/server/pluginVmDeadlines.test.ts` — hang hardening: top-level loops abort at load, overlapping evals keep their deadlines, runaway timer callbacks are interrupted, VM stacks survive with the `plugin:<id>` filename
  - `src/__tests__/server/pluginWorkerRpcTimeout.test.ts` — host-side RPC timeout: wedged workers are reset through the crash machinery instead of hanging callers
  - `src/admin/pages/plugins/utils/pluginEventStream.test.ts` — SSE frame validation: well-formed events dispatched, unknown-shape frames dropped with `console.warn`
