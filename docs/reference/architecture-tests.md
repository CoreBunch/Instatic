# Architecture Tests

Catalog of every test in `src/__tests__/architecture/`. These are structural gates — they run as part of `bun test` and fail the build when a rule is broken. When *your* change drifts a structural rule, fix the matching test in the **same** change.

---

## TL;DR

- 95 gate files across structural domains: SQL, JSON columns, migrations, CSS, icons, primitives, page tree, sandbox, agent, router, content storage, boundary validation, module size, AI, auth, error handling, etc.
- Naming convention: `<topic>.test.ts` (kebab-case) or `<group>-<topic>.test.ts`. A few legacy `task<N>-*` ids remain for live invariants; new gates should use topic names.
- Run them all: `bun test src/__tests__/architecture/`.
- Most are **import / source scans** — they parse the files in scope and assert / reject patterns. Some are unit-style (a small in-test database, a synthesized page tree).

---

## Catalog by domain

### Barrel imports

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `no-core-barrel-deep-imports.test.ts`         | External callers import through the barrel, never through a concrete internal path (`@core/<module>/<file>`). Files inside a module are exempt — they use relative paths. Enforced for: `@core/page-tree`, `@core/module-engine`, `@core/visualComponents`, `@core/publisher`, `@core/framework`, `@core/framework-schema`, `@core/fonts`. |

See [CLAUDE.md → Barrel imports](../../CLAUDE.md) and [docs/reference/page-tree.md](page-tree.md).

### Database — schema and dialect

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `db-postgres-isms.test.ts`                    | Files that import `DbClient` use only ANSI SQL. Blocks `now()` in DML, `::int`, `::jsonb`, `any($N::...)`, `distinct on`. |
| `db-json-column-naming.test.ts`               | Every `jsonb` PG column has a name ending in `_json`. Same column appears in SQLite migrations as `text`. |
| `migration-parity.test.ts`                    | `migrations-pg.ts` and `migrations-sqlite.ts` have identical migration IDs in the same order. |
| `json-extract-egress.test.ts`                 | `JSON.parse` of stored data goes through a TypeBox boundary helper.              |

See [docs/reference/database-dialects.md](database-dialects.md).

### Content storage

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `data-tables-system-flag.test.ts`             | System tables (`posts`, `pages`, `components`) are seeded with `system: true`.    |
| `no-legacy-content-domain.test.ts`            | The `content_*` tables / handlers don't return. Everything lives in `data_*`.    |
| `no-legacy-pages-table.test.ts`               | No `pages` or `page_versions` tables in migrations.                              |

### Page tree

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `no-vc-mode-branches-in-mutations.test.ts`    | The 11 store actions don't branch on `kind === 'visualComponent'`. Routing happens in `mutateActiveTree`. |
| `visual-components-mutation-contract.test.ts` | VC tree mutations preserve the slot-instance / slot-outlet invariants.           |
| `centralized-site-mutation-history.test.ts`   | Every mutation flows through one entry-point so undo / redo stays consistent.    |
| `no-vc-in-site-shell.test.ts`                 | `SiteShellSchema` does not declare `visualComponents` / `pages`. They live in `data_rows`. |
| `page-tree-single-source.test.ts`             | Form analysis uses shared `@core/page-tree` traversal helpers instead of local recursive tree walkers / parent-map builders. |
| `multiWrapDefaults.test.ts`                   | `wrapNodes` applies defaults uniformly across the wrapped set.                  |

See [docs/reference/page-tree.md](page-tree.md), [docs/features/visual-components.md](../features/visual-components.md).

### Validation / TypeBox

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `boundary-validation.test.ts`                 | Five HTTP / JSON-parse boundary rules: (1) no `res.json() as` in persistence or admin — use `apiRequest` or `readEnvelope`; (2) no `JSON.parse(...) as` in `src/core/persistence/`; (3) no raw `fetch(` in `src/admin/` outside the allowlist (streaming NDJSON, SVG bytes, and FormData multipart uploads are listed with `§3.x` justifications); (4) no `req.json(` in server handlers outside `server/http.ts`; (5) no `body.field as DeepType` after `readEnvelope`/`parseJsonResponse` in `src/core/persistence/` — reference the field's real TypeBox schema in the envelope so the parsed value is already typed; interface-only deep types are allowlisted with `§5.x` justifications. |
| `binding-compatibility-coverage.test.ts`      | All endpoint bindings have client-side schemas defined.                          |

See [docs/reference/typebox-patterns.md](typebox-patterns.md).

### Error handling

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `no-inline-error-ternary.test.ts`             | All `catch (err)` blocks in `src/admin/` extract the error message via `getErrorMessage(err, fallback)` from `@core/utils/errorMessage`, never by hand-writing `err instanceof Error ? err.message : fallback`. Prevents the pattern from being re-implemented per call site (losing the empty-message fallback `getErrorMessage` handles). |

See [docs/reference/error-boundaries.md](error-boundaries.md) and CLAUDE.md → "Error handling rules".

### Auth / capabilities

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `capability-picker-coverage.test.ts`          | Every `CORE_CAPABILITIES` entry appears in `CAPABILITY_META` and one `CAPABILITY_GROUPS` section. Also mirrors the server `CoreCapability` literal union against the client array — they must list the same strings. |
| `cms-handlers-capability-gated.test.ts`       | Every file under `server/handlers/cms/` calls `requireCapability`, `requireAnyCapability`, `requireAuthenticatedUser`, or `requireStepUp` at least once. Files in the allowlist carry an explicit justification. |

See [docs/features/auth-and-access.md](../features/auth-and-access.md), [docs/reference/capabilities.md](capabilities.md).

### CSS / design system

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `css-token-policy.test.ts`                    | CSS Modules under `src/admin/`, `src/admin/pages/site/`, `src/ui/` use only token vars — no raw hex / rgb / hsl. |
| `css-token-vocabulary.test.ts`                | Source and design docs use the current global token vocabulary directly (`--bg-*`, `--text-*`, `--border*`, `--overlay-*`, `--accent-*`, semantic state tokens), with deprecated editor/panel/rail/tag alias token families banned. |
| `admin-spacing-token-policy.test.ts`          | Admin/shared UI chrome uses the fluid spacing scale from `globals.css` for margin/padding/gap and CSS-authored SVG dimensions; inline pixel spacing strings are banned. |
| `admin-typography-token-policy.test.ts`       | Admin/shared UI chrome uses the fluid text scale from `globals.css`; hardcoded pixel `font-size`/font shorthands are banned in admin/ui CSS modules and editor chrome CSS. |
| `no-css-var-fallbacks.test.ts`                | `var(--x, fallback)` is banned — every token must exist; fallbacks hide drift.   |
| `noTailwindUtilities.test.ts`                 | No Tailwind utility class strings in `className=` in `src/admin/`, `src/modules/`, `src/ui/`. |
| `no-tailwind-deps.test.ts`                    | No imports of `clsx`, `tailwind-merge`, `class-variance-authority`, `@radix-ui/*`, `tailwindcss`. No `@tailwind` / `@apply` directives. |
| `scrollbar-chrome.test.ts`                    | Scrollbar tokens declared in `globals.css`; both Firefox (`scrollbar-color`) and WebKit/Blink (`::-webkit-scrollbar`) styled with those tokens; `StyleSurface.module.css` uses `scrollbar-gutter: stable` to keep the properties rail clear of overlaying scrollbars. |

See [docs/design.md](../design.md), [docs/reference/design-tokens.md](design-tokens.md).

### UI primitives

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `button-primitive-usage.test.ts`              | Bare `<button>` in `src/admin/` goes through the allowlist (with §8 justifications). |
| `ui-primitives-location.test.ts`              | Primitives live in `src/ui/components/<Name>/`. Don't scatter them.              |
| `no-native-browser-dialogs.test.ts`           | No `alert()`, `confirm()`, `prompt()`. Use `Dialog` / Toast.                     |
| `no-native-title-tooltips.test.ts`            | No `title=` for hover hints. Use `<Tooltip>`.                                    |
| `no-third-party-icons.test.ts`                | No `lucide-react`, `heroicons`, etc. Only `pixel-art-icons`.                     |
| `direct-icon-imports.test.ts`                 | Icons imported deep (`pixel-art-icons/icons/<name>`), not from the package root. |
| `vendor-icons-fresh.test.ts`                  | The vendored icon set is up-to-date (run `bun run icons:sync`).                  |
| `icon-catalog-integrity.test.ts`              | Every icon import resolves; the vendored package's index is consistent.          |
| `close-icon-correctness.test.ts`              | Close affordances use the standard close icon glyph.                             |
| `no-plugin-tab-shells.test.ts`                | `role="tablist"` is only allowed inside `src/ui/components/Tabs/` and a small §T-allowlisted set of pre-existing custom controls. Every other tablist in `src/admin/` or `src/editor/` must use `<Tabs>` / `<TabList>` from `@ui/components/Tabs`. |

See [docs/reference/ui-primitives.md](ui-primitives.md).

### Editor / canvas

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `canvasFastRefreshBoundaries.test.ts`         | `.tsx` files don't mix component + non-component exports (breaks HMR).           |
| `no-circular-dependencies.test.ts`            | `madge` finds zero tsconfig-aware circular dependencies across `src` and `server`. |
| `canvas-aware-selectors.test.ts`              | Canvas-related store selectors are subscribed correctly to canvas-state slices.  |
| `admin-router-usage.test.ts`                  | Internal admin navigation uses `@admin/lib/routing`; raw `/admin` anchors and `react-router-dom` are banned. |
| `framework-typography-spacing.test.ts`        | The site framework's typography / spacing tokens compile correctly.              |
| `component-system-placement.test.ts`          | Every VC insertion flow (toolbar picker, context menu) routes through `insertComponentRef`; Site Explorer must not expose a component-to-canvas drag source, and direct `insertNode`/`addNodeToVc` with `'base.visual-component-ref'` is forbidden in placement files. |
| `task414-wrap-to-container.test.ts`           | Wrap-to-container action creates defaulted wrappers and preserves tree structure. |
| `task427-preview-class-css.test.ts`           | Preview-class CSS injection matches publisher output.                            |
| `error-boundary-coverage.test.ts`             | Every workspace page / major surface is wrapped in an `ErrorBoundary` with a unique `location` tag. |
| `non-site-workspaces-no-editor-store.test.ts` | Content, Data, Media, and their shared canvas layout do not import the Site editor store. |

See [docs/editor.md](../editor.md).

### Spotlight

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `spotlight-no-direct-store-mutation.test.ts`  | Providers / scopes don't mutate the editor store. Mutations live in commands.    |
| `keybindings-registry-single-source.test.ts`  | Every global keyboard shortcut goes through the keybinding registry.             |

See [docs/features/spotlight.md](../features/spotlight.md).

### Plugin system

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `plugin-rpc-target-registry.test.ts`          | Three-part lock on the RPC registry: (1) every `ApiCallSchemas` target has exactly one handler in `apiDispatch.ts`; (2) every key in `TARGET_PERMISSIONS` is a real api-call target; (3) the full target→permission table is frozen to the signed security contract — changing any pairing is a deliberate, visible security decision. |
| `plugin-bootstrap-fresh.test.ts`              | Generated bootstrap artifacts in `bootstrap/generated/` match a fresh bundle of `bootstrap/src/`. Fails if `bun run bootstrap:sync` is needed. |
| `plugin-sandbox-invariants.test.ts`           | No `node:`, `bun:`, `require(`, `process.binding` in plugin bundles; network permission gate is centralized in `apiDispatch.ts` and driven by `TARGET_PERMISSIONS`. |
| `plugin-boot-resilience.test.ts`              | One bad plugin doesn't bring the server down. Crashes are isolated.              |
| `plugin-cms-content-surface.test.ts`          | All five `cms.content.*` permissions are wired across all sync-points (permission values, capability matrix, permission alias builder, SDK type surface, host-side dispatch). |
| `plugin-content-access-enforced.test.ts`      | `cms.content.*` permission grant is enforced centrally in `apiDispatch.ts` (driven by `TARGET_PERMISSIONS`); per-table handlers additionally call `assertContentTableAccess` (manifest `contentAccess[]` allowlist). |
| `plugin-content-tree-via-engine.test.ts`      | Plugin content handlers reach page-tree mutations through `applyTreeOperation` from `@core/page-tree`, not by deep-importing `mutations.ts` directly. |
| `plugin-host-import-boundaries.test.ts`       | Worker transport (`server/plugins/host/`) does not import `apiDispatch` — prevents circular dependency between the pool and the dispatch layer. |
| `plugin-host-ui-runtime-parity.test.ts`       | Plugin host UI surfaces match the SDK's declared shape.                          |
| `plugin-schedule-invariants.test.ts`          | Scheduled job cadence + overlap policy validate at registration; `cms.schedule.*` targets are centrally gated by the `cms.schedule` permission in `TARGET_PERMISSIONS`. |
| `plugin-secrets-never-leak.test.ts`           | HTTP handlers never touch plugin secret ciphertext/IVs or the plaintext runtime projection; browser-bound plugin settings project through `projectSecretSettings` / `listPluginSecretStates`. |
| `sandbox-crypto-bridge.test.ts`               | Plugin sandbox's crypto surface is bridged correctly (`subtle.digest`, `subtle.sign`); crypto targets carry no permission gate (pure computation, no I/O). |

See [docs/features/plugin-system.md](../features/plugin-system.md).

### Agent

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `agent-no-raw-html-in-reply-rule.test.ts`     | The agent system prompt contains the narrate-only rule (1–2 sentence replies, no raw HTML/CSS/JSON in the reply body). Prevents accidental removal during prompt refactors. |
| `agent-system-prompt-no-module-enumeration.test.ts` | The system prompt does not enumerate module ids — they're discovered via `site_list_modules` / `site_read_document` at runtime. Also asserts the HTML-native style markers (`site_insert_html`, "Structure as HTML, styling as CSS"). |
| `agent-tool-surface.test.ts`                  | Legacy node-construction tools (`insertNode`, `insertTree`) and retired class-patch tools (`createClass`, `updateClassStyles`) are absent from the site write-tool list; HTML-native replacements (`site_insert_html`, `site_get_node_html`, `site_replace_node_html`) and the unified CSS-authoring tool (`site_apply_css`) are present; document reads, code assets, design-system token tools, template tools, and snapshot capture are present; total count is exactly 29. |

### AI infrastructure

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `ai-tool-input-object.test.ts`                | Every provider-facing site/content tool schema has a plain `type: object` root with no root-level `anyOf`, `oneOf`, or `allOf`, matching Anthropic's tool-schema contract while keeping one cross-provider registry. |
| `ai-tool-schema-ssot.test.ts`                 | Site write-tool input schemas live once in `src/core/ai/toolSchemas.ts` (re-exported from `@core/ai`). Every registered tool's `inputSchema` is the exact object from `@core/ai` (referential identity check); consumer modules (`writeTools.ts`, `executor.ts`, `tokenRunners.ts`) import from `@core/ai` and do not redeclare local copies. |
| `ai-driver-isolation.test.ts`                 | Provider SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@openrouter/agent`), `zod`, and `@anthropic-ai/sdk` are banned repo-wide with no allowed callers. `@modelcontextprotocol/sdk` is **scoped**: allowed only under `server/ai/mcp/` (the MCP server), banned everywhere else (drivers + browser). Drivers talk directly to each provider's REST API over HTTP/SSE and pass TypeBox schemas through as JSON Schema. `src/` and `server/` are both scanned. |
| `ai-mcp-connectors-never-leak.test.ts`        | The MCP connection wire projection (`toConnectionView`) and `McpConnectionViewSchema` never expose personal access tokens, OAuth tokens, or their hashes. Mirrors `ai-credentials-never-leak.test.ts`. |
| `ai-driver-shared-helpers.test.ts`            | Two cross-provider helpers must have exactly one source: (1) `parseToolArguments` is exported only from `server/ai/drivers/http/toolArgs.ts` — every driver imports it; private copies (`parseJsonOrEmpty`, etc.) are banned. (2) `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is declared only in `server/ai/runtime/types.ts` — prompt builders and drivers import it. Divergent copies silently produce different error handling or break prompt caching per provider. |
| `ai-handlers-capability-gated.test.ts`        | Every handler under `server/ai/handlers/` calls `requireCapability` or `requireAnyCapability` before doing work. Prevents unauthenticated access to AI endpoints. |
| `ai-credentials-never-leak.test.ts`           | AI handler response bodies do not contain credential ciphertext or raw `apiKey` fields. Handlers must project through `toCredentialView()` before serialising a `CredentialRecord`. |
| `ai-tools-typebox-only.test.ts`               | Every file under `server/ai/tools/` defines schemas with TypeBox, not Zod. Tool files satisfy the gate either by using TypeBox directly or by importing from `@core/ai` (the shared schema leaf). |

See [docs/features/agent.md](../features/agent.md).

### Media

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `media-migration-invariants.test.ts`          | Migrating an asset between adapters preserves all variants and references.       |
| `media-presentation-pipeline.test.ts`         | Publisher's `<picture>` / `srcset` materialization is correct.                   |
| `media-signed-redirect-serving.test.ts`       | `/_instatic/media/<adapterId>/<storagePath>` redirects with a fresh signed URL.  |
| `media-storage-no-bytes-in-sandbox.test.ts`   | Plugin sandboxes can't read raw media bytes; only host adapters can.             |
| `media-storage-panel.test.ts`                 | Media storage panel UI matches the registered adapter set.                       |

See [docs/features/media.md](../features/media.md).

### Publisher

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `dispatcher-html-pipeline.test.ts`            | The publisher's HTML pipeline (sanitize → plugin filters → injections) runs in order. |
| `publish-html-filter-context.test.ts`         | Plugin `publish.html` filters receive the right context shape.                   |
| `static-artefact-served-before-render.test.ts`| `publicRouter.ts` calls `readArtefact` BEFORE `resolvePublicRoute`; the fast-path fires when `canonicalRenderQuery(url.searchParams) === ''` — junk params (UTM, etc.) collapse to `''` and serve the artefact, only render-affecting loop-pagination params (`loop_<nodeId>_page`) fall through to the live renderer. |
| `publish-bumps-cache-version.test.ts`         | Every publish / unpublish entry point (`publishDraftSite`, `publishDataRow`, `updateDataRowStatus`) calls `bumpPublishVersion()` imported from `publishState.ts` so Layer B evicts on every state change visitors can see. |
| `hole-runtime-asset-route.test.ts`            | The router registers `tryServeHoleRuntimeAsset` and `tryServeHole` BEFORE `tryServePublicRoute`. The `/_instatic/hole/*` namespace can never fall through to slug resolution. |
| `module-js-asset-route.test.ts`               | The router registers `tryServeModuleJsAsset` BEFORE `tryServePublicRoute`, and wires it from `server/handlers/cms/moduleJs`, so `/_instatic/module-js/*` requests cannot be swallowed by public-slug resolution. |

The following test lives in `src/__tests__/server/` (not `architecture/`) but enforces a load-bearing publisher performance invariant:

| Test (server/)                                | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `siteCssBundleMemo.test.ts`                   | `buildPublishedSiteCssBundle` memoises the three page-invariant CSS bundles (reset/framework/style) by `publishVersion + site object`: the O(all-pages) walk runs once per publish snapshot, not once per render; `bumpPublishVersion()` invalidates the memo; memoized output is byte-identical to `buildSiteCssBundle`; `userStyles` is rebuilt per call (page-scoped, never memoized). |

See [docs/features/publisher.md](../features/publisher.md).

### Site import

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `siteImport-headless.test.ts`                 | `src/core/siteImport/` imports no `src/admin/`, `server/`, or `react`/`react-dom` modules and contains no `.tsx` files — keeps the Super Import pipeline framework-agnostic and runnable in headless environments. |

See [docs/features/site-import.md](../features/site-import.md).

### Site transfer (export / import)

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `cmsTransferExport.test.ts`                   | Export produces a valid `SiteBundle`.                                            |
| `cmsTransferPreview.test.ts`                  | Preview matches what apply would do (no drift).                                  |
| `cmsTransferImport.test.ts`                   | Importing a bundle yields a site equivalent to the source.                       |
| `import-export-roundtrip.test.ts`             | Full round-trip parity: export → import → re-export = original.                  |

The following test lives in `src/__tests__/server/` (not `architecture/`) but enforces a load-bearing media-import invariant:

| Test (server/)                                | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `importPathTraversal.test.ts`                 | `assertPathWithin` blocks `..` traversal and absolute escapes; `MediaAssetExportSchema.storagePath` pattern rejects traversal at the schema boundary (ISS-009). |

See [docs/features/site-transfer.md](../features/site-transfer.md).

### Loop sources

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `loop-source-id-format.test.ts`               | Loop source ids are namespaced lowercase (`base.x`, `acme.y`).                  |
| `loop-source-sql-safety.test.ts`              | Built-in loop sources don't issue dialect-specific or unsanitized SQL.           |

### Bundle / performance

| Test                                          | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `admin-startup-imports.test.ts`               | Pre-auth code (`src/admin/preauth/`) does not import `@core/persistence` barrel — only narrow auth/boot entrypoints. Keeps the login-screen chunk free of data/media/plugin clients. |
| `bundle-size-budgets.test.ts`                 | Per-chunk byte budgets after `bun run build`. Enforces that key chunks (AdminPageLayout, AdminWorkspaceCanvasLayout, SitePage, ContentPage, CodeMirrorEditor, …) stay within their measured caps. |
| `module-size-budgets.test.ts`                 | Per-module line-count cap. No new source module over 700 lines; a grandfathered ledger of existing god-files is frozen and ratchets down only. Source-side sibling of `bundle-size-budgets`. |
| `codemirror-lazy-only.test.ts`                | CodeMirror is loaded only via `lazy()` — it's heavy and shouldn't be in the entry bundle. |
| `site-editor-shell-lazy-body.test.ts`         | Enforces that `SitePage` renders the real shell via `AdminCanvasLayout` (no bespoke startup skeleton), that the heavy editor body (DnD, canvas, panels, first-party modules) stays behind a post-paint lazy boundary, that `ImportHtmlModal` stays behind its open-state lazy boundary, and that `CanvasFrameSkeletonFrame` from `@admin/shared/CanvasFrameSkeleton` is used for startup and no-site states. |
| `singleInstallManagedHosting.test.ts`         | Single-install assumptions hold across the codebase (no multi-tenant leakage).   |

### Docker / deployment

The following test lives in `src/__tests__/server/` (not `architecture/`) but enforces load-bearing structural invariants for the Docker image and Compose configuration:

| Test (server/)                                | What it enforces                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------------|
| `dockerConfig.test.ts`                        | Dockerfile uses a multi-stage build (build → production-deps → runtime), `ARG INSTATIC_VERSION` and OCI version label are present, TypeScript path aliases (`tsconfig*.json`) are copied into the runtime stage, `esbuild` is in `dependencies` (not `devDependencies`) so the runtime script bundler is available in production. `compose.prod.yml` uses the GHCR image, has healthchecks, persistent volumes, and `depends_on: condition: service_healthy`. `POSTGRES_PASSWORD` carries a `CHANGEME` placeholder default (no `:?` guard) so the file loads in SQLite mode without a `.env`. `INSTATIC_SECRET_KEY` is documented in `.env.production.example` and referenced in `compose.prod.yml`. |

See [docs/deployment/](../deployment/).

## Anatomy of an architecture test

Most tests follow one of three shapes.

### Source-scan

Walks files under a root, applies a regex, asserts no matches (or specific matches):

```ts
import { readFileSync } from 'fs'
import { describe, it, expect } from 'bun:test'

describe('No `as Foo` at JSON boundaries', () => {
  it('every JSON.parse goes through a TypeBox schema', () => {
    const offenders: string[] = []
    for (const file of walk('src/')) {
      const src = readFileSync(file, 'utf8')
      if (/JSON\.parse\([^)]*\)\s+as\s+/.test(src)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
```

### Schema check

Reads a typed manifest (e.g. `pgMigrations`) and asserts shape:

```ts
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'

it('migration IDs match across dialects', () => {
  const pgIds     = pgMigrations.map((m) => m.id)
  const sqliteIds = sqliteMigrations.map((m) => m.id)
  expect(sqliteIds).toEqual(pgIds)
})
```

### Integration-style

Spins up a small in-memory SQLite, runs migrations, exercises a code path, asserts:

```ts
const db = createSqliteClient(':memory:')
await runMigrations(db, sqliteMigrations)
await createDataRow(db, ...)
const rows = await listDataRows(db, 'posts')
expect(rows).toHaveLength(1)
```

---

## When to add a new gate

Add an architecture test when:

- A structural invariant is easy to violate accidentally (e.g. "all icons come from `pixel-art-icons`").
- A naming convention is load-bearing (e.g. JSON columns end in `_json` because the SQLite adapter auto-parses them).
- A directory boundary needs enforcement (e.g. "no `react-router-dom` in admin code").
- A new permission / capability / event kind needs all sync-points wired (e.g. `cms.pages.read` exists in 4 places).

Don't add a gate for:

- One-off correctness checks — those are unit tests under `src/__tests__/<topic>/`.
- Style preferences without a load-bearing reason — code review catches those.
- "Future-proofing" without a current risk — gates have a maintenance cost.

### Naming the new gate

- Use kebab-case, topic first: `<topic>.test.ts` or `<group>-<topic>.test.ts`.
- Avoid `task<N>` / `phase<N>` / `guideline<N>` unless you genuinely tracking a multi-PR refactor mid-flight (and rename when the refactor lands).
- Keep file names short — agents grep these. `db-postgres-isms.test.ts` is good. `database-dialect-mismatch-detector-no-postgresisms.test.ts` is bad.

---

## When you break a gate

The build fails with a specific message and a list of offending files / lines. Two cases:

1. **The gate is right, your change is wrong.** Fix your change.
2. **Your change is the new architecture; the gate is the old one.** Update the gate. Per CLAUDE.md: "when *your* change drifts a structural rule, fix the rule's gate test in the same change." Don't commit a gate-broken state.

---

## Related

- `CLAUDE.md` — the rule book (mentions architecture gates as first-class)
- [docs/architecture.md](../architecture.md) — system-level invariants
- [docs/CONVENTIONS.md](../CONVENTIONS.md) — when a doc claim should link a gate
- Source root: `src/__tests__/architecture/`
