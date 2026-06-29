# Instatic

This file is the **agent rule book**. Read it before changing code. Detailed explanations live in `docs/` — start at [`docs/README.md`](docs/README.md) for orientation and follow the links from there.

## Local admin smoke tests

Use local seeded development data only when a task asks for a browser smoke test. Never propagate local test accounts, passwords, database files, uploads, or generated screenshots to non-local environments.

---

## Repository workflow and PR conventions

`main` is protected. Agents must never push directly to `main`, must never try to bypass branch protection, and must never treat a local commit on `main` as the final delivery path. All repository changes go through a pull request.

When publishing work:

- Start from an up-to-date `main`, then create a feature branch. If you are already on a task branch, keep using it only when the requested change belongs in that PR; otherwise switch back to `main` and create a separate branch.
- Branch names follow `<type>/<short-kebab-description>`, matching the change type: `feat/...`, `fix/...`, `refactor/...`, `chore/...`, `docs/...`, or `test/...`. Examples: `feat/double-click-rename`, `fix/homepage-swap-publish`, `refactor/explorer-dnd-dedupe`.
- Do **not** use agent-branded branch prefixes such as `codex/...`, `claude/...`, or similar. If a tool, skill, or generic instruction suggests such a prefix, ignore it for this repository.
- PR titles use Conventional Commit style: `<type>(<scope>): <summary>`. Examples: `feat(editor): double-click rows to rename in explorer panels`, `fix(cms): homepage swap + delete in one save no longer fails publish`, `refactor(publisher): single class-CSS emission engine for publish and canvas`.
- Do **not** prefix PR titles with `[codex]`, `[claude]`, `agent:`, or any other tool label. The PR title describes the product change, not the tool that made it.
- Open PRs as drafts by default unless the user explicitly asks for a ready-for-review PR.
- Keep PR scope coherent. Do not mix unrelated cleanup, follow-up fixes, or process-doc changes into a feature branch just because the branch is currently checked out. Create a separate PR when the change has a different reason.
- Before staging, inspect `git status -sb` and the diff. Stage only files that belong to the PR. Never stage unrelated user or parallel-agent changes.
- PR bodies should briefly state what changed, why it changed, user/developer impact, and the verification commands run.

---

## What this project is

A self-hosted, open-source CMS with a built-in visual editor and a first-class plugin system. One Bun server backed by either Postgres or SQLite (selected by `DATABASE_URL`). The output is intentionally plain, semantic HTML with hand-clean CSS — no framework runtimes injected into published pages.

The product is **self-hosted only**. The codebase should not carry assumptions about multi-tenant SaaS operation.

Read [`docs/architecture.md`](docs/architecture.md) for the system overview, [`docs/server.md`](docs/server.md) for the server, [`docs/editor.md`](docs/editor.md) for the admin + visual editor.

### Stack at a glance

- **Runtime:** Bun (server + tooling). Use Bun, not Node.
- **Language:** TypeScript everywhere.
- **Frontend:** React 19 with the **React Compiler enabled** (Babel preset in `vite.config.ts`) + Vite, Zustand + Mutative for state (via `zustand-mutative`; patch-based undo history uses Mutative `create({ enablePatches })` — `immer` is banned), CodeMirror for code-editing UI, `@dnd-kit/core` for drag-and-drop. The compiler auto-memoizes — do not hand-write `useMemo`/`useCallback`/`memo`. See "React Compiler and memoization". Store mutations use draft-mutation style (`set((s) => { s.x = … })`); a recipe that returns a partial must wrap it in `rawReturn(...)` or Mutative emits a perf warning.
- **Server:** `Bun.serve` with a hand-written router (`server/router.ts`). CMS modules at `server/{repositories,handlers/cms,auth,plugins,publish}/`. Deep dive: [`docs/server.md`](docs/server.md).
- **Database:** Postgres (`Bun.sql`) OR SQLite (`bun:sqlite`), selected by `DATABASE_URL`. One `DbClient` interface, two adapters, two migration files with identical IDs. Rules: [`docs/reference/database-dialects.md`](docs/reference/database-dialects.md).
- **Content model:** All content lives in `data_tables` + `data_rows`. The four system tables (`posts`, `pages`, `components`, `layouts`) are seeded and locked from rename/delete. There are no separate `pages` or `page_versions` tables.
- **Validation:** TypeBox at every untyped boundary. Schemas are source of truth (`type Foo = Static<typeof FooSchema>`, never a parallel `interface`). `zod` is banned repo-wide (the AI drivers pass TypeBox schemas through as JSON Schema, so no typebox→zod adapter is needed). Helpers + patterns: [`docs/reference/typebox-patterns.md`](docs/reference/typebox-patterns.md).
- **Sanitization:** DOMPurify at the publisher boundary (`src/core/sanitize.ts`).
- **Plugins:** Zip packages with a `plugin.json` manifest, lifecycle hooks. Server entrypoints and canvas module packs run inside a **QuickJS-WASM sandbox** — no Node/Bun ambient access, network gated by `network.outbound` permission + `networkAllowedHosts`. The VM bootstrap (SDK factory + `__run*` dispatchers) is authored as typed TS in `server/plugins/quickjs/bootstrap/src/` and bundled to committed string artifacts in `bootstrap/generated/` — after editing the source run `bun run bootstrap:sync` (gated by `plugin-bootstrap-fresh.test.ts`). Permission enforcement everywhere (VM, host, editor) validates against `grantedPermissions`, never the declared `permissions` array. Feature doc: [`docs/features/plugin-system.md`](docs/features/plugin-system.md).
- **Routing:** In-house router at `src/admin/lib/routing/`. Replaces `react-router-dom`. Use it for all internal admin navigation, including links rendered from the site editor. `react-router-dom` is banned, raw `<a href="/admin...">` hard navigations are banned in admin UI, and `src/core/` + `src/modules/` must not import the admin router. Gated by `admin-router-usage.test.ts`.
- **Icons:** `pixel-art-icons/icons/<name>` — deep-imported, tree-shakeable. Vendored at `vendor/pixel-art-icons/`. No `lucide-react`, no inline SVG strings — gated by `no-third-party-icons.test.ts`, `direct-icon-imports.test.ts`. Add a new icon by importing it and running `bun run icons:sync`.
- **AI providers:** No provider SDKs. Each driver in `server/ai/drivers/` talks directly to its provider's REST API over HTTP/SSE, sharing one multi-turn tool loop (`drivers/http/toolLoop.ts`). `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, and `@openrouter/agent` are banned repo-wide. `@modelcontextprotocol/sdk` is **scoped, not banned**: allowed only under `server/ai/mcp/` (Instatic's MCP *server* implements a real wire protocol), still banned in the drivers and the browser. Gated by `ai-driver-isolation.test.ts`.
- **MCP server:** Instatic exposes its CMS tools to external MCP clients (Claude Code, Codex, remote agents) at `/_instatic/mcp`, authenticated by per-connector bearer tokens. Thin adapter over the existing tool engine: headless reads (content reads + `read_styles`) run in-process; ALL page editing (the full set of browser-execution editor tools) is relayed to the connector owner's **open editor** via the live editor bridge (`server/ai/mcp/editorBridge.ts` + `useEditorMcpBridge` in `SitePage`), reusing the chat bridge machinery — the live editor store is the single source of truth (no headless DB-mutating page-tree tool, which would desync). Feature doc: [`docs/features/mcp-connectors.md`](docs/features/mcp-connectors.md).
- **Tree primitive:** Every tree-of-nodes — pages, Visual Components, slot fills — uses one shape: `NodeTree<TNode>` in `src/core/page-tree/treeSchema.ts`. Mutations are tree-agnostic. Reference: [`docs/reference/page-tree.md`](docs/reference/page-tree.md).
- **Publishing:** Three-layer pipeline. **Layer A** bakes fully-static pages to `uploads/published/current/<route>.html` at publish time via a two-slot symlink swap (`server/publish/staticArtefact.ts`). **Layer B** is an in-memory LRU keyed by `(urlPath, queryString, publishVersion)` for dynamic routes (`server/publish/renderCache.ts`); `bumpPublishVersion()` evicts wholesale on every publish. **Layer C** emits `<instatic-hole>` placeholders for nodes auto-detected as request-dependent; a ~668 B `IntersectionObserver` runtime lazy-fetches each fragment from `/_instatic/hole/<nodeId>`. Auto-detection lives in `src/core/publisher/dynamicDetection.ts` — one walker, four rules. Single entry: `server/publish/publicRouter.ts:renderPublicResolution`. Full design: [`docs/features/publisher.md`](docs/features/publisher.md).
- **Tests:** `bun test`. Architectural rules in `src/__tests__/architecture/*` — when *your* change drifts a structural rule, fix the rule's gate test in the same change.

### Repo layout

```
server/         Bun server: router, handlers, repositories, auth, plugins, publish, db
src/admin/      Admin app (React) — shell, workspaces, plugin host UI
src/admin/pages/site/   Visual editor (canvas, panels, toolbar, editor store)
src/core/       Engine: page tree, publisher, plugin SDK + runtime, persistence
src/modules/    First-party block modules (container, text, image, button, …)
src/ui/         Shared UI primitives (Button, Input, Tree, icons, cn)
src/styles/     Global tokens (globals.css)
docs/           Documentation (start at docs/README.md)
examples/       Plugin templates
vendor/         Vendored pixel-art-icons package
```

Source of truth for layout details: [`docs/architecture.md`](docs/architecture.md) → "Folders, at a glance".

---

## Development status — READ THIS FIRST

**This project is in PRE-RELEASE. There are no external users. There is no production traffic. There is no installed base. Nothing is shipped.**

That has direct consequences for how Claude must approach changes in this repo.

### No backward compatibility. Ever.

There is nothing to be backward compatible with.

- **Do not preserve old function signatures, schemas, types, or APIs out of compatibility concern.** If a cleaner shape exists, change it everywhere and delete the old one.
- **Do not add deprecation shims.** Don't keep a `legacyFoo()` that forwards to `foo()`. Just rename it and update callers.
- **Do not add migration paths from old behavior to new behavior** unless it is genuinely required for currently developed code to keep functioning.
- **Do not gate new behavior behind feature flags or version checks "to be safe."** If the new behavior is correct, that is the only behavior.
- **Do not leave both an old and new implementation side-by-side.** Pick the right one and delete the other.

### No band-aids. No "we'll clean it up later."

If a piece of code is in the wrong place, has the wrong shape, has confusing naming, or carries leftover assumptions — **fix it at the source, even if it means refactoring multiple files**.

You are explicitly authorized — and expected — to:

- Rename modules, files, types, and functions across the whole codebase to match the cleaner architecture.
- Move responsibilities between layers (e.g. push logic out of a handler into a repository, or out of a component into the engine) when that is correct.
- Delete dead code, unused exports, half-finished abstractions, and "just in case" parameters.
- Restructure folders if the current layout no longer reflects the architecture.
- Break and fix many call sites in a single change set when that is what the cleaner design requires.

What you must not do:

- Wrap new logic around old logic to "avoid touching it."
- Add a second way of doing something because the first way is awkward — fix the first way.
- Leave TODO/FIXME notes about cleanup instead of doing the cleanup.
- Hide the wrong abstraction behind a thin adapter so callers "don't notice."
- Justify a workaround with "to keep this PR small" or "to avoid breaking other things." Other things can break in this PR. Fix them in this PR.

### Database, schema, and stored data

There is no production data to protect. Treat the schema like code:

- If a column, table, or migration is wrong, change the migration. Do not write a "compatibility migration" on top of a bad migration.
- If stored shapes (page trees, plugin manifests, settings) need to change, change them and update everything that reads/writes them.
- Local dev databases are disposable. It is acceptable for a change to require dropping the local DB and re-running migrations from scratch.

### Plugin SDK and public-looking surfaces

The plugin SDK, runtime, and manifest format *look* like a public contract but they are also pre-release. Nothing external depends on them yet.

- If the SDK shape is wrong, change it. Update `examples/plugins/template/` and [`docs/features/plugin-system.md`](docs/features/plugin-system.md) in the same change.
- The `apiVersion` field is not yet a stability promise. Don't invent legacy adapters for older `apiVersion` values.

### Default disposition on every change

Choose (A) the cleaner architecture, requiring edits across several files, over (B) a smaller diff that leaves the architecture slightly worse. **Always choose (A).** The whole point of being pre-release is that this is the cheapest moment in the project's life to do (A).

If you are unsure whether a refactor is in scope, default to *yes, do it*, and explain in the summary what you cleaned up and why. Do not ask permission to delete dead code, rename a poorly-named symbol, or fix a bad abstraction — just do it.

---

## Design and styling rules

Detailed system: [`docs/design.md`](docs/design.md). The rules:

- **No hardcoded hex / rgb / hsl in admin / ui CSS modules.** Every color comes from a `var(--*)` token in `src/styles/globals.css`. If a needed token doesn't exist, add it. Gated by `css-token-policy.test.ts`.
- **No `var(--name, fallback)` in admin / ui CSS modules.** Use bare `var(--name)`. If the token doesn't exist, define it in `globals.css`. Fallbacks hide missing tokens. For JS-driven custom properties, set defaults in a CSS rule instead of in every `var()`. Gated by `no-css-var-fallbacks.test.ts`.
- **Two-layer color model.** Surfaces, borders, and default text are achromatic. Color is used as **identity** (rail tints `--rail-tint-mint/lilac/sky/peach` for categorical identity), as **state** (`--editor-danger`, `--editor-warning`, `--editor-success-*`, `--editor-info-*`), or as **canvas affordance** (`--canvas-selection-ring`, `--canvas-hover-ring`). Never decorative.
- **Card surface pattern.** Tile cards (dashboard widgets and equivalents) are borderless: `--editor-surface-2` on a darker `--editor-surface` parent with a 1px grid gap, 16px radius. Hover lifts the surface tone — never recolor a border. Canonical implementation: `src/ui/components/Widget/Widget.module.css`.
- **Border radius scale.** `--editor-radius-sm` (3px) for tight chips. `--editor-radius` (6px) for default editor controls and buttons. `--panel-radius` (12px) for floating overlay panels. 16px for tile cards. `--input-radius` (1em) for pill-shaped inputs. Don't introduce ad-hoc radius values.
- **CSS Modules only** in `src/admin/`, `src/modules/`, `src/ui/`. No Tailwind utility classes — gated by `noTailwindUtilities.test.ts`. No Tailwind ecosystem deps (`clsx`, `tailwind-merge`, `class-variance-authority`, `@radix-ui/*`) — gated by `no-tailwind-deps.test.ts`.
- **No inline `style={{ ... }}`** *except* for dynamic CSS custom properties (`style={{ '--x': value } as CSSProperties}`) that the module reads back via `var(--x)`.
- **No `!important`** in component CSS modules. Two legitimate exceptions: `globals.css` (`prefers-reduced-motion`), `Button.module.css` (specificity reset).
- **CSS Modules file naming:** `Component.module.css` next to `Component.tsx`. Class names use `camelCase`.

### UI primitive rules

Shared primitives at `src/ui/components/`. **Every interactive control in `src/admin/` MUST use these primitives.**

- **`Button`** — every action button. Bare `<button>` is gated by `button-primitive-usage.test.ts`; exceptions listed in that file's `ALLOWLIST` with §8 justifications. New exceptions need an §8 entry.
- **`Input`, `Switch`, `Select`, `SearchBar`, `ColorInput`, `FileUpload`, `Separator`, `ContextMenu`, `FilterBar`** — for the corresponding control type.
- **`Tree*`** (`src/admin/pages/site/ui/Tree/`) — for tree rows in DOM/site panels.
- **Class composition:** `cn` from `@ui/cn` — an in-house 3-line helper.

---

## React Compiler and memoization

The **React Compiler is enabled** for the whole app (`babel({ presets: [reactCompilerPreset()] })` in `vite.config.ts`, linted by `eslint-plugin-react-compiler`). It auto-memoizes every component and hook. Manual memoization is therefore **noise** — it adds clutter without improving performance and must not be written.

- **Default: no `useMemo`, no `useCallback`, no `memo()`.** Write the plain value, the plain function, the plain component. The compiler memoizes them for you. New code MUST NOT introduce manual memoization, and existing manual memoization is being removed.
- **`useState(() => …)` lazy initializers and `useRef(…)` are NOT memoization** — they are always fine and unaffected by this rule.

There are exactly three exceptions where memoization stays — keep it, and add a one-line comment saying why:

1. **The value/function is referenced in a `useEffect` (or other hook) dependency array.** The static `react-hooks/exhaustive-deps` lint rule can't see the compiler's runtime memoization, so it still demands a stable identity there. Wrapping a *function* used as a dep in `useCallback` (and the transitive closure it depends on) is required to keep `bun run lint` clean. If a removable plain value feeds a dep array, that's fine — only functions trip the rule.
2. **A `React.memo` re-render bailout on a hot, list-rendered component** (e.g. a recursive per-node canvas renderer). `React.memo` skips re-rendering on equal props — a *different* mechanism from the compiler's within-component memoization — so dropping it on an O(N) critical path is not behavior-preserving without runtime perf validation. Rare; justify in a comment.
3. **The compiler genuinely cannot compile a function** (escape hatch). Add the `"use no memo"` directive at the top of that function body, or the existing `eslint-disable react-compiler/react-compiler` pattern, and keep the manual memoization it needs.

**Gate:** `eslint-plugin-react-compiler` (runs in `bun run lint` / CI) is the enforcement gate — it flags both compiler bailouts and `react-compiler/react-compiler` violations. `react-doctor` (`bun run doctor`) also surfaces `react-doctor/react-compiler-no-manual-memoization`, but as a **warning** only (React Compiler rules are downgraded to warn in `react-doctor.config.json`; `bun run doctor` fails only on error-tier Security/Correctness diagnostics). A new component that ships `useMemo`/`useCallback`/`memo` outside the three exceptions above is drift — remove the memoization. Full detail: [`docs/reference/react-compiler.md`](docs/reference/react-compiler.md).

---

## Error handling rules

Detailed patterns: [`docs/reference/typebox-patterns.md`](docs/reference/typebox-patterns.md). The rules:

### Boundaries — validate, then trust

Every untyped boundary uses TypeBox. Inside the boundary, code trusts the parsed value.

- **HTTP responses (client):** `@core/http` is a single three-layer stack — there is exactly ONE way to validate a response, expressed at the altitude you need:
  - **`apiRequest(path, { schema, … })`** — the canonical entry. Does the `fetch` itself: sets `credentials`, serializes a JSON body (FormData passes through untouched), validates the success body against `schema`, and throws a single `ApiError` (carrying the HTTP status) on failure. Detect cancellation with `isAbortError(err)`. **Default to this** — do NOT hand-roll `fetch` + `res.ok` + `res.json()` in admin code.
  - **`readEnvelope(res, Schema, fallbackMessage)`** — for the persistence layer, which performs its own injectable `fetch` (test seam) and then hands the `Response` here. Checks `res.ok` (throws `ApiError` with status + the `{ error }` envelope message), then validates the body. Its no-body sibling is `assertOk(res, fallback)` for `void`/Blob/streaming/text responses.
  - **`parseJsonResponse(res, Schema)`** — the low-level body-validation primitive that `apiRequest` and `readEnvelope` are *built on*. It validates a body with NO HTTP-status semantics. Reserved for genuine primitives only: the `@core/http` internals, the XHR upload path (`useUploadQueue`), and server-side fetches of external APIs. Do NOT reach for it in admin/persistence code — `assertOk(res, m); parseJsonResponse(res, S)` is exactly `readEnvelope(res, S, m)`; always write the latter.
- **`JSON.parse` of persisted data:** `safeParseJson(raw, Schema)` for hard, `parseJsonWithFallback(raw, Schema, default)` for soft.
- **Request bodies (server):** validate with a TypeBox schema before handing to handlers. The single shared body-parsing entry point is `readValidatedBody(req, Schema)` in `server/http.ts`.
- **Plugin manifests:** `parsePluginManifest` in `src/core/plugins/manifest.ts`.
- **Site documents loaded from storage:** `validateSite` in `src/core/persistence/validate.ts`.

### Error classes

- Domain validation errors are typed `Error` subclasses with a `path` field. Examples: `SiteValidationError`, `VisualComponentNameError`, `VisualComponentParamNameError`, `VisualComponentRecursionError`. **Add a typed class when callers need to distinguish causes** — UI states, retry decisions, etc.
- Generic `throw new Error(...)` is fine for "this should never happen" invariants. It is not fine when the UI needs to render a specific error state.

### Server error envelope

- Server endpoints return `{ error: string }` on failure (validated by `ErrorEnvelopeSchema` in `@core/http`).
- `apiRequest`/`readEnvelope` surface this message automatically via `responseErrorMessage(res, fallback)` (also in `@core/http`), which prefers the `{ error }` envelope, then raw response text, then the fallback.
- Server logs use the prefix `console.error('[<module>]', err)` — example: `'[plugin:acme.workflow]'`.

### UI error handling

- Async UI handlers wrap in `try/catch`. Logged errors use the prefix `console.error('[<component>] <description>:', err)`.
- User-visible errors go through component state + `role="alert"` (or `role="status"` for non-blocking). Never `alert()` / `confirm()` / `prompt()` — gated by `no-native-browser-dialogs.test.ts`.
- Error message extraction: `getErrorMessage(err, 'Unknown <thing> error')` from `src/core/utils/errorMessage.ts` — handles the `instanceof Error` check and the empty-message fallback in one place.
- Soft fallbacks (corrupted localStorage, missing optional config): `parseJsonWithFallback` + continue with defaults.
- Hard fallbacks (corrupted required document, broken HTTP envelope): let the error bubble to the nearest error boundary. Do not silently mask.

### Forbidden patterns

- `catch (err) {}` — silently swallowing. If genuinely safe, name it (`catch (_err)`) and add a one-line comment.
- `console.log` in production code. Use `console.error` / `console.warn` with a `[<module>]` prefix, or remove the log.
- Re-throwing a wrapped `Error` that loses the original stack. Use `new Error(message, { cause: err })`.
- `as Foo` at a JSON / HTTP / `JSON.parse` boundary. Use a TypeBox schema instead. Gated by `boundary-validation.test.ts` (rules 1–5: `res.json() as`, `JSON.parse as`, raw `fetch()`, raw `req.json()`, and `body.field as DeepType` after `readEnvelope`/`parseJsonResponse` — embed the field's TypeBox schema in the envelope instead; allowlist interface-only deep types with a `§5.x` entry).
- Importing `zod` anywhere. It is banned repo-wide: the AI drivers hit each provider's REST API directly and pass TypeBox schemas through as JSON Schema, so there is no longer a typebox→zod adapter. Gated by `ai-driver-isolation.test.ts`.

---

## Database dialect rules

Detailed: [`docs/reference/database-dialects.md`](docs/reference/database-dialects.md). The three rules:

1. **Repositories are dialect-naive.** Use ANSI-standard SQL only. The five Postgres-isms — `now()` in DML, `::int`, `::jsonb`, `any($N::...)`, `distinct on` — are banned in any `DbClient`-importing file under `server/`. Gated by `db-postgres-isms.test.ts`.
2. **JSON columns end in `_json`.** The SQLite adapter auto-parses `*_json` strings on read and auto-stringifies plain objects on write. Gated by `db-json-column-naming.test.ts`.
3. **Migrations are split per dialect with identical IDs.** `server/db/migrations-pg.ts` (PG dialect) and `server/db/migrations-sqlite.ts` (SQLite dialect). Parity gated by `migration-parity.test.ts`.

**Adding a new migration:** add it to BOTH `migrations-pg.ts` and `migrations-sqlite.ts` with the same ID and the same semantic effect.

**Adding a JSON column:** name it `*_json`.

---

## Mutation API

Detailed: [`docs/reference/page-tree.md`](docs/reference/page-tree.md). The rule:

Every mutation in `src/core/page-tree/mutations.ts` takes a `NodeTree<TNode>` and is **tree-agnostic** — it knows nothing about pages vs. Visual Components. The only place that knows which tree is active is `resolveActiveTreeTarget` in `src/admin/pages/site/store/slices/site/helpers.ts`, consumed through `mutateActiveTree(fn)`.

The 11 named tree-mutation store actions (`insertNode`, `deleteNode`, `updateNodeProps`, `setBreakpointOverride`, `clearBreakpointOverride`, `renameNode`, `toggleNodeLocked`, `toggleNodeHidden`, `moveNode`, `duplicateNode`, `wrapNode`) are one-liners that call `mutateActiveTree`. They MUST NOT contain their own `kind === 'visualComponent'` routing branch — gated by `no-vc-mode-branches-in-mutations.test.ts`.

Plugins reach the same 11 mutations through `applyTreeOperation(tree, op)` — exported from `@core/page-tree`, dispatched on `op.kind`. It is the same engine the editor exercises via `mutateActiveTree`; the plugin RPC `cms.content.tree.mutate` runs each operation through it so plugin code rides the editor's gates instead of bypassing them.

---

## Visual Components and slots

When a `base.visual-component-ref` is dropped, it auto-spawns one **`base.slot-instance`** child per slot param via `syncSlotInstances` (`src/core/visualComponents/slotSync.ts`). User content lives as ordinary children of the slot-instance, in the same page tree as everything else. The publisher pairs each `base.slot-instance` (consumer side) with the matching `base.slot-outlet` (in the VC's definition tree) by `slotName`.

There is no `slotContent` prop — all slot fills are materialized, locked nodes in the page tree.

---

## Barrel imports

Modules that publish a public API (an `index.ts` in a folder under `src/core/`, `src/ui/components/<Component>/`, etc.) own that barrel as their canonical entrypoint. **Everything outside the module imports through the barrel; internal files within the module import from each other via relative paths.**

- ✅ Outside `src/core/page-tree/`: `import { Page, PageNode } from '@core/page-tree'`
- ✅ Inside `src/core/page-tree/`: `import type { Page } from './page'` (relative, NEVER `from '@core/page-tree'`)
- ❌ Outside the module: `import { Page } from '@core/page-tree/page'` — bypasses the barrel

Deep imports into these engine modules are enforced by `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts`:

- `@core/page-tree`, `@core/module-engine`, `@core/visualComponents`, `@core/publisher`
- `@core/framework` — the framework engine (color, typography, spacing CSS generation)
- `@core/framework-schema` — pure leaf: TypeBox schemas + derived types for persisted framework token settings; no dependency on the engine or page-tree
- `@core/fonts`

Note: `@core/framework-schema` is a dependency of both `@core/page-tree` (for `FrameworkSettingsSchema` and `GeneratedClassMetadataSchema`) and `@core/framework` (for the persisted data shapes). This arrangement keeps the module graph one-directional — the engine depends on the schema leaf, not on the page tree. Any other module barrel is still a convention without a gate; treat deep imports in those as drift and migrate them to the barrel as part of whatever change you're making.

---

## Code quality bar

- **Clear logic over clever logic.** Straight-line code beats a generic abstraction with two callers.
- **Names must be honest.** A function called `renderPage` renders a page.
- **One reason per module.** Files in `server/{repositories,handlers/cms,auth,plugins,publish}/*` and `src/core/*` are organized by responsibility — keep them that way.
- **No dead code.** Unused exports, parameters, types, files: delete them. `fallow` (`npx fallow dead-code`) is the canonical tool; `knip`, `madge`, and `jscpd` remain available for second-opinion checks.
- **Health checks with coverage.** `bun run fallow:health` runs `bun test --coverage` and feeds the result to `fallow health --coverage`. Run before deciding whether a hotspot needs more tests vs. more refactoring.
- **No `any` to escape a type problem.** Fix the type.
- **No commented-out code.** Git remembers.
- **Validate at the boundary, trust inside.** Don't `as Foo` your way past it.
- **Schemas are source of truth.** `type Foo = Static<typeof FooSchema>` — never a parallel `interface Foo` next to `FooSchema`.
- **Architecture tests are first-class.** When you change a structural rule (folder layout, allowed imports, banned APIs, design tokens), update the matching test in `src/__tests__/architecture/`.
- **Documentation tracks code.** When you change code that a doc describes, update the doc in the same change. Doc rules: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).
- **At the end of the task, your own changes must pass `bun test`, `bun run build`, and `bun run lint`.** Verification is an end-of-task gate, not a per-edit ritual.

## Tooling rules

- Always use `bun` (not `npm` / `pnpm` / `yarn`) for installs, scripts, and tests.
- Lockfile is `bun.lock`. Do not introduce `package-lock.json` or `yarn.lock`.
- Server scripts run with `bun --watch server/index.ts`. Frontend dev runs with `vite`.
- Run the full stack locally with `bun run dev` (defaults to SQLite at `.tmp/dev.db` — no external dependencies) or `docker compose up --build` (everything in containers with Postgres). Set `DATABASE_URL=postgres://...` before `bun run dev` to use Postgres instead.
- **`bun run build` runs `tsc -b && vite build`** — both type-checking and bundling. A change that runs in dev but fails `tsc` is not done.

## Verification

```sh
bun install
bun run build         # tsc -b && vite build
bun test
bun run lint
```

### When to run

Run verification **once, at the end of the task**, before declaring work complete. You do not need to run `bun test` / `bun run build` / `bun run lint` after every edit — that wastes time. Make your changes, then verify.

Use `bun run build` and `bun test` for any non-trivial change. Add `bun run lint` if you touched `.ts`/`.tsx` files.

### Parallel sessions and pre-existing failures

**Multiple Claude sessions may be working on this repo at the same time.** The working tree may already contain failing tests, type errors, or lint errors from work-in-progress in another session. **That is not your problem to fix.**

- Confirm that **the code you wrote / files you touched** typecheck, lint, and pass their tests.
- A pre-existing failure in an area you did not touch is not a blocker. Note it in your summary, then move on.
- **Do not try to "fix" failures unrelated to your work** — you'll collide with whoever is editing those files. Don't add band-aids, don't comment out failing tests, don't revert someone else's half-finished change.
- **Do not skip verification entirely** because "tests are probably broken anyway." Always run the checks, then triage: yours vs. not-yours.
- If a failure is ambiguous, `git status` / `git diff` will show what you actually changed. Anything outside that diff is not yours.

The bar is: **your work is clean.**

---

## TL;DR

1. Pre-release. No users to protect.
2. Never preserve backward compatibility, never leave band-aids, never duplicate "old vs new" code paths.
3. If the architecture would be cleaner with a multi-file refactor — do the refactor, in this change.
4. Every untyped boundary goes through TypeBox. `as Foo` at a JSON boundary is a bug. `zod` is banned repo-wide — AI drivers pass TypeBox schemas straight to providers as JSON Schema.
5. UI uses shared primitives from `src/ui/`, design tokens from `src/styles/globals.css`, CSS Modules only. The React Compiler is on — no manual `useMemo`/`useCallback`/`memo` (see "React Compiler and memoization" for the three exceptions).
6. Published output stays clean: clean HTML, clean CSS, clean TypeScript. No exceptions.
7. Documentation tracks code — update [`docs/`](docs/) in the same change. Read [`docs/README.md`](docs/README.md) for orientation.
8. Verify once at the end. Pre-existing failures from parallel sessions are not yours to fix.
