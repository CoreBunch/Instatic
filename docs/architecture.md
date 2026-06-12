# Architecture

System-level overview of Instatic — what runs, what depends on what, and where to look first.

Instatic is a self-hosted CMS with a built-in visual editor. One Bun process serves the public website, the admin editor, the CMS API, published pages, and uploaded media, backed by either Postgres or SQLite. The visual editor's output is plain semantic HTML and hand-clean CSS — no framework runtime is injected into published pages.

---

## TL;DR

- **One process, two off-main-thread workers**: `bun server/index.ts`. `Bun.serve` + a hand-written router (`server/router.ts`) routes every request. Plugin server code runs in per-plugin `Bun.Worker`s wrapping a QuickJS-WASM sandbox; image-variant generation (`sharp` + BlurHash) runs in a separate `Bun.Worker` pool. Everything else — HTTP, the admin API, the streaming agent endpoint, the publisher — runs on the main thread.
- **One database, two engines**: Postgres (via `Bun.sql`) or SQLite (`bun:sqlite`), selected by `DATABASE_URL`. Repositories are dialect-naive; migrations are split per dialect with identical IDs.
- **One content model**: posts, pages, and visual components all live in `data_tables` + `data_rows`. No separate `pages` table. Page trees and VC trees both use the `NodeTree<TNode>` primitive.
- **Two frontends, one bundle**: the admin app (`src/admin/`) shells the visual editor (`src/admin/pages/site/`). Both run in the same Vite-built SPA, mounted under `/admin/*`.
- **Plugins run sandboxed**: server entrypoints and canvas module packs execute inside a QuickJS-WASM VM with no host access. They reach the CMS through the SDK at `src/core/plugin-sdk/`.
- **One public-route surface, three publishing layers**: every visitor request for HTML — stand-alone pages and content rows alike — flows through `server/publish/publicRouter.ts:renderPublicResolution`. **Layer A** bakes fully-static pages to `uploads/published/current/<route>.html` at publish time via a two-slot symlink swap (atomic). **Layer B** is an in-memory LRU keyed by `(urlPath, queryString)` for dynamic routes — per-entry version tracking; bumps evict lazily on every publish, and version is captured at render start so mid-flight publishes discard results rather than caching stale HTML. **Layer C** auto-detects dynamic nodes (modules flagged `dynamic: true`, request-dependent bindings or loop sources, VC refs containing dynamic content) and emits `<instatic-hole>` placeholders that lazy-fetch their content via `/_instatic/hole/<nodeId>` using a ~668 B `IntersectionObserver` runtime. Authors don't toggle — `findDynamicNodeIds` in `src/core/publisher/dynamicDetection.ts` classifies automatically. The published `SiteDocument` is stored once per publish in `site_snapshots`; page versions reference it via `data_row_versions.site_snapshot_id`, and the reassembled `PublishedPageSnapshot` remains the canonical audit record. Output is plain semantic HTML + a single hashed CSS bundle per page, no framework runtime on the page.
- **Multi-instance HA on Postgres**: both schedulers (plugin tick + scheduled publish) share a leader-election primitive in `server/db/advisoryLock.ts` (`withSchedulerLeaderLock`) that wraps `pg_try_advisory_lock`, so running multiple containers behind a load balancer doesn't double-fire scheduled work. Each scheduler passes its own distinct lock key; on SQLite (single-instance by definition) the module returns a no-op sentinel.
- **Every untyped boundary uses TypeBox.** HTTP responses, request bodies, persisted JSON, plugin manifests, settings. `zod` is banned repo-wide — drivers talk directly to each provider's REST API and pass TypeBox schemas through as JSON Schema; `zod` has been removed from `package.json`. Gated by `ai-driver-isolation.test.ts`.

---

## Process and layout

```text
┌──────────────────────── Bun process ────────────────────────┐
│                                                             │
│   server/index.ts          ← entrypoint, boots router       │
│      ↓                                                      │
│   server/router.ts         ← routes every URL               │
│      ↓                                                      │
│   ┌──────────────┬──────────────┬──────────────┐            │
│   │ CMS handlers │ Static SPA   │ Published    │            │
│   │ /admin/api/  │ /admin/*     │ pages, files │            │
│   │              │  → dist/     │  → uploads/  │            │
│   │ → repos      │              │              │            │
│   │ → db client  │              │              │            │
│   └──────────────┴──────────────┴──────────────┘            │
│      ↓                                                      │
│   server/db/client.ts      ← Postgres OR SQLite             │
│                                                             │
│  ┌─── Bun.Worker pool ──────────────────────────────────┐   │
│  │ image-variant worker (sharp + blurhash; CPU off the │   │
│  │ main thread, see server/handlers/cms/imageVariant*) │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─── Bun.Worker — one per active plugin ───────────────┐  │
│  │ QuickJS-WASM sandbox (no Node/Bun ambient access);   │  │
│  │ crash isolation; capability-gated SDK only           │  │
│  │ (server/plugins/host/, server/plugins/quickjs/)      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The same process serves visitors, admins, the API, the streaming agent endpoint, and uploads. Two kinds of work that would otherwise block the main thread are pushed into `Bun.Worker`s:

- **Plugin server entrypoints + canvas module packs** run inside a per-plugin `Bun.Worker` that hosts a QuickJS-WASM sandbox. The host process never imports plugin code. A crash in one plugin worker only affects that plugin; the host respawns it with a crash budget (`server/plugins/host/crashRecovery.ts`).
- **Image-variant generation** (`sharp` resize + WebP encode + BlurHash) runs in a small pool of `Bun.Worker`s. A 4 MP JPEG is ~200–500 ms of CPU per upload; offloading it keeps visitor requests and the admin API responsive when an admin (or a future first-party feature) uploads images in bulk.

There is no message queue, no managed service surface. Scaling out is a horizontal-Postgres play: both schedulers (plugin tick + scheduled-publish tick) share a leader-election primitive at `server/db/advisoryLock.ts` (`withSchedulerLeaderLock`) that wraps `pg_try_advisory_lock` so multiple instances behind a load balancer don't double-fire scheduled work. SQLite mode is single-instance by definition; the module falls through to a no-op sentinel there.

---

## Folders, at a glance

```text
server/         Bun server: router, handlers, repositories, plugin runtime, DB
src/admin/      Admin app shell (auth, navigation, workspaces, plugin host UI)
src/admin/pages/site/   Visual editor (canvas, panels, toolbar, store)
src/core/       Engine: page tree, publisher, plugin SDK + runtime, persistence
src/modules/    First-party block modules (container, text, image, button, …)
src/ui/         Shared UI primitives (Button, Input, Tree, icons, cn helper)
src/styles/     Global tokens (globals.css)
src/__tests__/architecture/   Gate tests that enforce structural rules
tests/          Playwright E2E specs (*.e2e.ts); config in playwright.config.ts
docs/           This documentation tree
examples/       Plugin templates, type declarations
vendor/         Vendored pixel-art-icons package
scripts/        Build, dev, icon sync, benchmark, audit report scripts
```

---

## Layer responsibilities

The repo is organized by responsibility, not by feature. Every file has one reason to exist.

| Layer                        | Lives in                              | Owns                                                                 |
|------------------------------|---------------------------------------|----------------------------------------------------------------------|
| HTTP & routing               | `server/router.ts`, `server/http.ts`  | Request dispatch, body parsing, error envelopes                      |
| CMS endpoints                | `server/handlers/cms/*.ts`            | Per-resource handlers (pages, posts, components, media, plugins, …)  |
| Auth & sessions              | `server/auth/*`                       | Session validation, capability checks, login flow                    |
| Repositories                 | `server/repositories/*.ts`            | Database access; dialect-naive ANSI SQL only                         |
| Database adapters            | `server/db/postgres.ts`, `sqlite.ts`  | Engine-specific `DbClient` implementation                            |
| Migrations                   | `server/db/migrations-*.ts`           | Schema in both dialects, parity-gated                                |
| Publisher                    | `src/core/publisher/*`                | Page tree → clean HTML/CSS (`publishPage`, deterministic, no host I/O). Includes `dynamicDetection.ts`, the single walker for the auto-detection rules that power Layer A shell-vs-complete bakes and Layer C holes. |
| Public-route surface         | `server/publish/publicRouter.ts`      | Resolve URL → page snapshot or data row + template. Layer A disk fast-path + Layer B in-memory LRU live here. |
| Static artefact IO           | `server/publish/staticArtefact.ts`    | Layer A: two-slot symlink swap, atomic per-file rename, slot-aware read/write/purge. |
| Render cache                 | `server/publish/renderCache.ts`       | Layer B: bounded LRU keyed by `(urlPath, queryString)`, each entry versioned. Single-flight, `bumpPublishVersion()` invalidates lazily; version captured at render start so a publish landing mid-render discards the result rather than caching stale HTML. |
| Server-island runtime        | `server/publish/holeRuntime.ts`       | Layer C: ~668 B hand-written `IntersectionObserver` runtime served at `/_instatic/hole-runtime.js`. |
| Hole endpoint                | `server/handlers/cms/hole.ts`         | `GET /_instatic/hole/<nodeId>?v=<publishVersion>` renders one node subtree; response cached via Layer B. |
| Plugin SDK                   | `src/core/plugin-sdk/*`               | Author-facing API + `instatic-plugin` CLI                                  |
| Plugin runtime (host)        | `src/core/plugins/*`                  | In-process plugin lifecycle: install/activate/uninstall              |
| Plugin sandbox (worker)      | `server/plugins/*`                    | QuickJS-WASM execution of plugin server code + module packs          |
| Image-variant worker         | `server/handlers/cms/imageVariant*`   | `Bun.Worker` pool running sharp + blurhash off the main thread       |
| Page tree primitive          | `src/core/page-tree/*`                | `NodeTree<TNode>` + tree-agnostic mutations                          |
| Framework engine             | `src/core/framework/*`                | Color token CSS generation, fluid typography/spacing scales, CSS variable output; imports from `@core/framework-schema` for persisted shapes and from `@core/css-sanitize` for value sanitization |
| Framework schemas (leaf)     | `src/core/framework-schema/*`         | Pure TypeBox schemas + derived types for persisted framework settings (`FrameworkSettings`, `GeneratedClassMetadata`, etc.); no dependency on the engine or page-tree |
| CSS value sanitiser (leaf)   | `src/core/css-sanitize/*`             | Single canonical `sanitiseCssValue` — dependency-free leaf shared by `@core/publisher` and `@core/framework`; blocks `expression()` / `javascript:` / `{}` / `</` injection at the CSS value level |
| Visual components            | `src/core/visualComponents/*`         | VC tree shape, slot synchronization, recursion checks                |
| Persistence (client-side)    | `src/core/persistence/*`              | HTTP envelopes, response schemas, site validation                    |
| Validation utilities         | `src/core/utils/*`                    | TypeBox helpers, JSON boundary helpers, sanitization                 |
| Admin shell                  | `src/admin/*` (excluding `pages/site/`)| Auth, routing, workspaces, plugin host UI, modals                   |
| Visual editor                | `src/admin/pages/site/*`              | Canvas, panels, toolbar, editor store                                |
| First-party modules          | `src/modules/*`                       | Built-in block modules (container, text, image, …)                   |
| UI primitives                | `src/ui/components/*`                 | Button, Input, Switch, Tree, etc. — shared across admin + editor     |
| Design tokens                | `src/styles/globals.css`              | All CSS custom properties                                            |
| Architecture gates           | `src/__tests__/architecture/*.test.ts`| Structural rules executed as part of `bun test`                      |

---

## Request lifecycle

```text
HTTP request
    │
    ▼
server/index.ts          ← Bun.serve fetch handler
    │
    ▼
server/router.ts         ← match path
    │
    ├─→ /admin/api/cms/*    → server/handlers/cms/<resource>.ts
    │       │
    │       ├─→ server/auth         (session + capability checks)
    │       ├─→ server/repositories (DB access)
    │       └─→ server/db/client    (Postgres or SQLite)
    │
    ├─→ /admin/api/cms/plugins/<id>/runtime/* → plugin worker (QuickJS)
    │
    ├─→ /admin/*            → static SPA (dist/index.html)
    │
    ├─→ /uploads/*          → server/static.ts (file disk)
    │
    └─→ /*  (everything else) → server/publish/publicRouter.ts
                                  → page snapshot OR data row + template
                                  → publishPage() (live render) → HTML
                                  → applyPublishedHtmlPipeline (plugin
                                    injection + publish.html filter)
                                  → 301 redirect / 200 HTML / 404
```

Handlers validate request bodies with TypeBox before doing work, talk to repositories for persistence, and return `{ error: string }` envelopes on failure. Validation helpers live in `server/http.ts`. Per-handler logging uses the prefix `console.error('[<module>]', err)`.

---

## Data model

Everything content-shaped lives in two tables.

### `data_tables` (system table)

A user-defined collection — a "post type" in WordPress terms. Has a `kind`:

| `kind`       | Used for                                      |
|--------------|-----------------------------------------------|
| `postType`   | Blog posts, products, anything list-like      |
| `page`       | Stand-alone pages with URLs                   |
| `component`  | Visual components (reusable subtrees)         |

The four system tables (`posts`, `pages`, `components`, `layouts`) are seeded by the baseline migration and are locked from rename/delete.

### `data_rows`

Rows in a `data_tables` collection. Stored cells are typed — a row in the `pages` table has a `body` cell of type `pageTree`; a row in `components` has a `tree` cell of type `pageTree` plus a `params` cell of type `fieldSchema`.

The shape and cell types are defined by the `data_tables` schema. There is no separate `pages` table, no `page_versions` table, no per-feature row layout. Adding a new "post type" means inserting a `data_tables` row with the right `cells` schema.

### Storage conventions

- JSON columns end in `_json`. The SQLite adapter auto-parses any `*_json` string on read and auto-stringifies any plain object on write. Gated by `db-json-column-naming.test.ts`.
- Migrations are split per dialect with identical IDs. PG uses `jsonb`, `timestamptz`, `bigint`, `distinct on`; SQLite uses `text`, `text`, `integer`, window-function rewrites. Parity gated by `migration-parity.test.ts`.
- Repositories use only ANSI-standard SQL. The five Postgres-isms — `now()` in DML, `::int`, `::jsonb`, `any($N::...)`, `distinct on` — are banned in any `DbClient`-importing file. Gated by `db-postgres-isms.test.ts`.

See [docs/reference/database-dialects.md](reference/database-dialects.md) for the full rules.

---

## The page tree primitive

Every tree-of-nodes in the CMS — page trees, Visual Component trees, slot fills — has one shape:

```ts
type NodeTree<TNode> = {
  nodes: Record<string, TNode>
  rootNodeId: string
}
```

Defined in `src/core/page-tree/treeSchema.ts` (single source of truth). Mutations operate on any `NodeTree` generically via `src/core/page-tree/mutations.ts`.

Routing to the active tree (page vs. VC mode) is the **sole** job of `mutateActiveTree(fn)` in `src/admin/pages/site/store/siteSlice.ts`. The 11 named tree-mutation store actions (`insertNode`, `deleteNode`, `updateNodeProps`, `setBreakpointOverride`, `clearBreakpointOverride`, `renameNode`, `toggleNodeLocked`, `toggleNodeHidden`, `moveNode`, `duplicateNode`, `wrapNode`) are one-liners that call `mutateActiveTree`. They must not contain their own `kind === 'visualComponent'` routing branch — gated by `no-vc-mode-branches-in-mutations.test.ts`.

See [docs/reference/page-tree.md](reference/page-tree.md) for the type shape and mutation cookbook.

---

## Publishing pipeline

The pipeline is **static-by-default, dynamic-by-auto-detection**. Authors don't toggle anything — `findDynamicNodeIds` in `src/core/publisher/dynamicDetection.ts` classifies each node, and the publisher routes through three layers accordingly.

```text
Editor state (Zustand store)
    │
    │  user clicks Publish (or `publishDataRow` for posts/etc.)
    ▼
publishDraftSite / publishDataRow      ← server/publish/publishSite.ts / publishRow.ts
    │
    │  1. write the SiteDocument once to site_snapshots; each page's
    │     data_row_versions row references it via site_snapshot_id
    │  2. for each page (complete doc, or static shell with <instatic-hole>):
    │       render via publishPage + applyPublishedHtmlPipeline
    │       writeArtefact(<inactive slot>, urlPath, html)   ← Layer A
    │  3. bake every published data-row route through its entry template
    │       into the same slot (bakeDataRows.ts)            ← Layer A
    │  4. bake CSS bundles + runtime JS to the slot (writeStaticAsset)
    │  5. swapSlot — atomic symlink flip of uploads/published/current
    │  6. bumpPublishVersion()  → invalidates Layer B cache
    │
    ▼
visitor request → server/router.ts → tryServePublicRoute
    │
    ▼ renderPublicResolution(db, url, uploadsDir?)
    │
    ├─ Layer A: disk fast-path  (only if canonicalRenderQuery(url.searchParams) === '')
    │     readArtefact(uploadsDir, url.pathname)
    │     junk params (UTM, etc.) collapse to '' and still hit disk;
    │     loop-pagination params (loop_x_page=N) fall through to Layer B
    │     hit → stream HTML, 0.6–1.4 ms, no DB, no render
    │
    ├─ Layer B: in-memory LRU cache (live-render fallback)
    │     warm peek FIRST: a version-matched cached 200 is served with zero
    │       DB work (route retractions bump publishVersion, so this is safe)
    │     miss → resolvePublicRoute → page / row / redirect / not-found
    │       redirects + not-founds bypass the cache
    │       pages/rows: getOrRender(key + publishVersion)
    │         → publishPage + applyPublishedHtmlPipeline
    │       single-flight: concurrent identical keys → one factory call
    │     bumpPublishVersion() invalidates lazily on next read
    │
    └─ Layer C: server islands (holes) — only when the rendered page has
       any node in findDynamicNodeIds(...). Publisher emits a <instatic-hole>
       placeholder with optional staticPlaceholder(props) skeleton + a
       ~668 B IntersectionObserver runtime injected once into <head>.
       Browser fetches /_instatic/hole/<nodeId>?v=<publishVersion> lazily when
       each placeholder approaches viewport (rootMargin 200px). Each hole
       response is also cached via Layer B's LRU.
```

Key properties:

- **One published-route surface.** `server/publish/publicRouter.ts:renderPublicResolution` is the single entry for every visitor URL. Stand-alone pages (`/about`) and content rows rendered through a postType's entry template (`/posts/hello`) both flow through it; only the lookup strategy differs. The earlier split between `tryServePublishedPage` and `tryServeContentRoute` collapsed into one path after the pages → `data_rows` migration finished.
- **Atomic publishing.** `uploads/published/current` is a symlink that targets either `slot-a/` or `slot-b/`. Full publishes build the inactive slot then atomic-rename the symlink — `rename(2)` of a symlink is a single-inode swap and is atomic across POSIX filesystems. There is no moment when `current` is missing or partially populated. In-flight readers that already resolved the old symlink hold file descriptors into the old slot — Unix semantics keep those files alive until they close. Incremental row publish (`publishDataRow`) writes a single file via tmp + rename into the active slot.
- **Auto-detection is the seam.** `findDynamicNodeIds(page, site, registry)` is backed by the single walker that powers Layer A's shell-vs-complete decision and Layer C's placeholder emission. The detection rules — `dynamic: true` modules, request-dependent bindings, request-dependent loop sources, loop-body promotion, VC-ref recursion — live in exactly one file. Cannot drift between layers.
- **`publish.html` runs at publish time** for static routes (baked into the disk artefact). For dynamic routes, the filter still fires inside the Layer B factory but caches the result so it runs at most once per `(url, querystring, publishVersion)` triple.
- **Three layers, automatic routing.** Layer A bakes fully-static pages to disk at publish time (`uploads/published/current/<route>.html`, atomic two-slot symlink swap). Layer B is an in-memory LRU keyed by `(urlPath, queryString)` for dynamic routes — single-flight, lazily invalidated on publish; version is captured at render start so a publish landing mid-render discards the result rather than caching stale HTML. Layer C emits `<instatic-hole>` placeholders for nodes that auto-detect as request-dependent; a tiny client runtime lazy-loads each fragment via `IntersectionObserver`. The published `SiteDocument` lives once per publish in `site_snapshots` (referenced by `data_row_versions.site_snapshot_id`); the reassembled `PublishedPageSnapshot` remains the canonical audit record from which all three layers derive.
- **Pure render, no framework runtime on the page.** Published HTML is plain semantic HTML + CSS. Plugins can inject frontend assets (`server/publish/frontendInjections.ts`). The only first-party client script is the ~668 B Layer C hole runtime, and it's injected ONLY on pages that contain at least one `<instatic-hole>` — fully-static pages ship zero JS from us.
- **Sanitization happens at the publisher boundary.** DOMPurify in `src/core/sanitize.ts` cleans rich-text, HTML strings, AND `staticPlaceholder` output before they're frozen into a snapshot or baked into a disk artefact. Browser code uses the browser DOM; the Bun server installs an explicit happy-dom-backed DOMPurify runtime from `server/richtextSanitizer.ts` without adding DOM globals. CSS property values are sanitised at the value level by `sanitiseCssValue` from `src/core/css-sanitize/` — a dependency-free leaf shared by both `@core/publisher` (every value emitted via `bagToCSS` / `bagToInlineStyle`) and `@core/framework` (every `:root {}` token variable), blocking `expression()`, `javascript:`, `{}` selector breakout, and `</` RAWTEXT escape.
- **Visual components are inlined.** Each VC instance is expanded with its slot fills materialized as locked child nodes in the consumer page tree. The publisher pairs each `base.slot-instance` with the matching `base.slot-outlet` by `slotName`. A VC ref whose definition tree contains any dynamic node becomes a single `<instatic-hole>` at the ref boundary (the inner subtree renders inside the hole endpoint).

---

## Plugin system

Plugins are zip packages containing a `plugin.json` manifest and bundled entrypoints. The host runs plugin code in a **QuickJS-WASM sandbox**:

- `entrypoints.server` runs in `server/plugins/quickjs/vm.ts`
- `entrypoints.modules` (canvas module packs) run in `server/plugins/modulePackVm.ts`
- Author-facing API lives in `src/core/plugin-sdk/`
- Host-side runtime (install, activate, deactivate, uninstall) lives in `src/core/plugins/`

The sandbox has no Node, no Bun, no file system, no environment variables, and no network unless the plugin declares `network.outbound` permission and a `networkAllowedHosts` allowlist. The `instatic-plugin build` CLI emits IIFE bundles and scans for forbidden literals (`'node:'`, `'bun:'`, `require(`, `process.binding`); the install handler scans again as defense-in-depth.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`.

See [docs/features/plugin-system.md](features/plugin-system.md) for the full feature doc.

---

## Frontend architecture

### Two apps, one bundle

The browser bundle is a single Vite-built React 19 SPA, mounted at `/admin`. Inside it:

- `src/admin/` — the **admin shell**: routing, sessions, top-level navigation, the workspaces for content / media / plugins / users / dashboard, and the plugin host UI.
- `src/admin/pages/site/` — the **visual editor**: the canvas, panels, toolbar, picker, property controls, and the editor store (Zustand + Mutative). This is the editor itself.

The split exists because the editor is a self-contained app with its own state and lifecycle, but it shares the admin's auth, routing, and theming.

### Routing

In-house router at `src/admin/lib/routing/`. Replaces `react-router-dom` for the admin app. Use it for all internal admin navigation, including links rendered from the site editor. `src/core/` and `src/modules/` must not import the admin router.

### State

- Admin shell: small contexts in `src/admin/state/` and `src/admin/sessionContext.ts`.
- Editor: Zustand store at `src/admin/pages/site/store/`, mutating page tree state via Mutative (`zustand-mutative`). The store routes mutations to the active tree (page or VC) through `mutateActiveTree(fn)`. Undo/redo is patch-based — O(change) per step.

### Styling

- CSS Modules only in `src/admin/` and `src/admin/pages/site/`. No Tailwind utility classes — gated by `noTailwindUtilities.test.ts`.
- All colors and radii come from CSS custom properties in `src/styles/globals.css`. No hardcoded hex / rgb / hsl. See [docs/design.md](design.md).
- Class composition uses the in-house `cn` helper at `src/ui/cn.ts`. No `clsx`, `tailwind-merge`, `class-variance-authority`, or `@radix-ui/*`. Gated by `no-tailwind-deps.test.ts`.

See [docs/editor.md](editor.md) for the visual editor deep-dive.

---

## Validation at every boundary

The codebase enforces "validate, then trust": every untyped input goes through a [TypeBox](https://github.com/sinclairzx81/typebox) schema. Inside the boundary, code trusts the parsed value.

| Boundary                             | Helper                                                | Lives in                              |
|--------------------------------------|-------------------------------------------------------|---------------------------------------|
| HTTP request (client, canonical)     | `apiRequest(path, { schema, … })` → throws `ApiError` | `src/core/http/apiClient.ts`          |
| HTTP response from a held `Response`  | `readEnvelope(res, Schema, fallbackMessage)`          | `src/core/http/apiClient.ts`          |
| Raw JSON response validation         | `parseJsonResponse(res, Schema)`                      | `src/core/utils/jsonValidate.ts`      |
| `JSON.parse` of persisted strings    | `safeParseJson(raw, Schema)` / `parseJsonWithFallback`| `src/core/utils/jsonValidate.ts`      |
| Request body (server)                | TypeBox schema in handler                             | `server/http.ts` helpers              |
| Plugin manifest                      | `parsePluginManifest`                                 | `src/core/plugins/manifest.ts`        |
| Site document on load                | `validateSite`                                        | `src/core/persistence/validate.ts`    |

Domain types come from `Static<typeof Schema>`. There is no parallel `interface Foo` next to `FooSchema`. **Schemas are the source of truth.**

Repeated `Check` / `Decode` / `Errors` paths use the cached TypeCompiler helpers in `src/core/utils/typeboxCompiler.ts`. Keep `parseValue` on TypeBox's full `Value.Parse` pipeline when defaulting, conversion, or cleaning semantics matter.

`zod` is banned repo-wide. The AI drivers talk directly to each provider's REST API and pass TypeBox schemas straight through as JSON Schema (TypeBox schemas ARE JSON Schema). `zod` has been removed from `package.json`; the `ai-driver-isolation.test.ts` gate enforces the ban with no allowed callers anywhere in `src/` or `server/`.

See [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) for the cookbook.

---

## Where things live — decision table

When making a change, this table answers "where does it go?"

| You're adding…                                         | Put it in                                                  |
|--------------------------------------------------------|------------------------------------------------------------|
| A new HTTP endpoint                                    | `server/handlers/cms/<resource>.ts` + route in `router.ts` |
| A new database table                                   | Both `server/db/migrations-pg.ts` and `migrations-sqlite.ts` (same ID) |
| A new repository function                              | `server/repositories/<resource>.ts`                        |
| A new editor mutation                                  | `src/core/page-tree/mutations.ts` (tree-agnostic, takes `NodeTree`) |
| A new editor store action                              | `src/admin/pages/site/store/siteSlice.ts` (one-liner calling `mutateActiveTree`) |
| A new first-party module (block)                       | `src/modules/<module-name>/`                               |
| A new UI primitive                                     | `src/ui/components/<Component>/`                           |
| A new plugin SDK surface                               | `src/core/plugin-sdk/` + update `examples/plugins/template`|
| A new design token                                     | `src/styles/globals.css`                                   |
| A new icon                                             | Import from `pixel-art-icons/icons/<name>`, then `bun run icons:sync` |
| A new admin route                                      | `src/admin/pages/<route>/` + register in `src/admin/router.tsx` |
| A new structural rule                                  | `src/__tests__/architecture/<rule>.test.ts`                |

---

## Invariants enforced by tests

Architectural rules live as tests in `src/__tests__/architecture/*.test.ts` and run as part of `bun test`. Changing a structural rule means updating the matching test. The most load-bearing gates:

| Rule                                                                                                  | Gate                                                            |
|-------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|
| Migrations parity between PG and SQLite                                                               | `migration-parity.test.ts`                                      |
| JSON columns end in `_json`                                                                           | `db-json-column-naming.test.ts`                                 |
| No Postgres-isms in repositories                                                                      | `db-postgres-isms.test.ts`                                      |
| Page tree uses the flat `NodeTree<TNode>` shape                                                       | `src/__tests__/persistence/treeSchemaShape.test.ts`             |
| Store mutations don't branch on VC mode                                                               | `no-vc-mode-branches-in-mutations.test.ts`                      |
| No Tailwind utility classes (covers all palette names: `bg-zinc-*`, `text-blue-*`, etc.)              | `noTailwindUtilities.test.ts`, `no-tailwind-deps.test.ts`       |
| Every color in admin / ui CSS modules comes from a token (no hardcoded hex / rgb / hsl)               | `css-token-policy.test.ts`                                      |
| Admin navigation uses the in-house router; no raw `/admin` anchors or `react-router-dom`              | `admin-router-usage.test.ts`                                    |
| All buttons go through the `Button` primitive                                                         | `button-primitive-usage.test.ts`                                |
| Icons come from `pixel-art-icons`                                                                     | `no-third-party-icons.test.ts`, `direct-icon-imports.test.ts`   |
| Vendored icon set is fresh                                                                            | `vendor-icons-fresh.test.ts`                                    |
| Plugin sandbox invariants (no `node:`, `bun:`, `require`, etc.)                                       | `plugin-sandbox-invariants.test.ts`                             |
| All provider SDKs banned repo-wide (no exceptions); drivers talk directly to each provider's REST API  | `ai-driver-isolation.test.ts`                                   |
| UI primitives live in `src/ui/components/`                                                            | `ui-primitives-location.test.ts`                                |

See [docs/reference/architecture-tests.md](reference/architecture-tests.md) for the complete catalog (81 gate files).

---

## Build, run, test

```sh
# install
bun install

# develop
bun run dev              # SQLite at .tmp/dev.db, no Docker
DATABASE_URL=postgres://… bun run dev   # Postgres mode

# verify
bun run build            # tsc -b && vite build (typecheck + bundle)
bun test                 # unit + architecture tests
bun run lint             # eslint with cache

# automated browser E2E (Playwright; runs a disposable local stack)
bun run test:e2e:install  # install Chromium once
bun run test:e2e          # run specs in tests/e2e/*.e2e.ts
```

`bun run build` runs both `tsc -b` and `vite build` — a change that runs in dev but fails `tsc` is not done. Verification is an end-of-task gate, not a per-edit ritual; see `CLAUDE.md` for the rules around pre-existing failures from parallel sessions.

---

## Related

- `CLAUDE.md` — the agent rule book (start there before changing code)
- [docs/CONVENTIONS.md](CONVENTIONS.md) — how docs in this repo are structured
- [docs/design.md](design.md) — visual design system
- [docs/server.md](server.md) — server-side deep dive
- [docs/editor.md](editor.md) — admin + canvas editor deep dive
- [docs/features/plugin-system.md](features/plugin-system.md) — the plugin system
- [docs/reference/page-tree.md](reference/page-tree.md) — the tree primitive
- [docs/reference/database-dialects.md](reference/database-dialects.md) — PG vs. SQLite rules
- Source-of-truth files:
  - `server/router.ts` — request dispatch
  - `server/publish/publicRouter.ts` — single entry for visitor HTML; orchestrates Layer A disk + Layer B cache
  - `server/publish/staticArtefact.ts` — Layer A two-slot symlink swap
  - `server/publish/renderCache.ts` — Layer B in-memory LRU + `bumpPublishVersion`
  - `server/publish/holeRuntime.ts` + `server/handlers/cms/hole.ts` — Layer C client runtime + fragment endpoint
  - `src/core/publisher/dynamicDetection.ts` — the single walker; rules for auto-classifying dynamic nodes
  - `server/handlers/cms/imageVariantWorkerHost.ts` — `Bun.Worker` pool for sharp + blurhash (keeps image processing off the main thread)
  - `server/db/client.ts` — database abstraction
  - `src/core/page-tree/treeSchema.ts` — `NodeTree` primitive
  - `src/admin/pages/site/store/siteSlice.ts` — `mutateActiveTree`
  - `src/core/publisher/` — publishing pipeline
  - `src/styles/globals.css` — design tokens
- Gate tests: `src/__tests__/architecture/*.test.ts`
