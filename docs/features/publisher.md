# Publisher

The publisher — the page-tree-to-HTML/CSS renderer. Takes a `Page` (a `NodeTree<PageNode>`) plus a `SiteDocument` and emits a clean, standalone HTML document with a single per-page CSS bundle.

The published output has **no framework runtime**, **no client-side hydration of layout**, and **no decorative markup** the browser doesn't need. Plugins can inject frontend assets at four anchor points (`head`, `head-end`, `body-start`, `body-end`), but the page structure itself is static.

---

## TL;DR

- Entry point: `publishPage(page, site, registry, options?)` in `src/core/publisher/render.ts`. Returns the full HTML document string.
- Recursion: `renderNode(nodeId, config, acc)` in `renderNode.ts`. Bottom-up walk. Two specialized renderers hook in for `base.visual-component-ref` and `base.loop`.
- Hidden nodes (`node.hidden`) are pruned at the top of `renderNode`, before unknown-module comments, dynamic holes, specialized renderers, standard rendering, or CSS collection.
- Per-node flow: render children → resolve effective + dynamic props → `escapeProps` → call `module.render(props, renderedChildren)` → collect deduped CSS → inject author class names.
- CSS is deduped by `moduleId` via `CssCollector` (~60–80% size reduction on typical pages).
- Module `render()` is a **pure function**: no DOM, no React, no side effects (Constraint #179).
- Every node's props pass through `escapeProps` before `render()` (Constraint #211).
- Server-side wrappers (`server/publish/publicRouter.ts` → `publicRenderer.ts` → `publishedHtmlPipeline.ts`) call `publishPage`, run plugin filters, and return the HTML in the visitor response.
- Output is routed through a three-layer publishing pipeline: **Layer A** bakes fully-static pages to `uploads/published/current/<route>.html` at publish time (atomic two-slot symlink swap). **Layer B** memoises dynamic pages in an in-memory LRU keyed by `(urlPath, canonicalQuery)` with per-entry version tracking; `canonicalQuery` is the output of `canonicalRenderQuery()` (in `loopPrefetch.ts`), which keeps only `loop_<nodeId>_page` pagination params — arbitrary junk params collapse to `''` so they never mint new cache slots; `bumpPublishVersion()` evicts lazily and version capture at render start discards results from mid-flight publishes. **Layer C** emits `<instatic-hole>` placeholders for nodes auto-classified as request-dependent; a ~668 B `IntersectionObserver` runtime lazy-loads each fragment via `/_instatic/hole/<nodeId>`.
- Auto-classification lives in `src/core/publisher/dynamicDetection.ts:findDynamicNodeIds` — one walker, four detection rules plus a loop body promotion step (Rule 3.5), used by `render.ts`'s empty-set static check (Layer A) and `renderNode`'s placeholder emission (Layer C). Authors don't toggle anything.

---

## Where the code lives

```text
src/core/publisher/
├── render.ts                       — publishPage (entry point + page-level orchestration)
├── renderNode.ts                   — recursive node walker; emits <instatic-hole> for nodes in dynamicNodeIds
├── renderConfig.ts                 — RenderConfig (read-only inputs) + RenderAccumulators (mutable outputs) + RenderNodeFn
├── renderVisualComponentRef.ts     — inline a Visual Component instance into the page
├── renderLoop.ts                   — iterate a loop source, round-robin child variants
├── escapeProps.ts                  — escape string props at the render boundary, dispatched per-prop on the schema control `type`
├── classInjection.ts               — inject author classIds into rendered HTML
├── classCss.ts                     — compile user StyleRule entries → CSS, including supported raw @keyframes
├── cssCollector.ts                 — CssCollector + collectClassCSS + sanitizeModuleCSS
├── reset.ts                        — PUBLISHER_RESET_CSS (cross-browser baseline)
├── frameworkCss.ts                 — site framework CSS (spacing scale, typography)
├── userStylesheets.ts              — site-level user stylesheets
├── siteCssBundle.ts                — hash-named bundle composition (reset + framework + style)
├── sizesResolver.ts                — `<img sizes>` derived from the layout: linear width model (caps, fractions, grid tracks) per viewport tier
├── dynamicDetection.ts             — Single walker for the 4 auto-detection rules; powers Layers A and C
└── utils.ts                        — escapeHtml, isSafeUrl, sanitiseCssValue (re-exported from @core/css-sanitize)

server/publish/
├── publicRouter.ts                 — gateway: Layer A disk fast-path → Layer B LRU → live resolver
├── staticArtefact.ts               — two-slot symlink swap + read/write/purge artefacts (Layer A); all URL-derived paths are validated by `resolveArtefactPath` (URL-decode + `..`-rejection + containment check after `path.join`)
├── renderCache.ts                  — in-memory LRU (Layer B); reads publishVersion from publishState
├── publishState.ts                 — publishVersion (bump/get) + withPublishLock + createVersionedSingleFlight
├── holeRuntime.ts                  — Layer C client runtime; exports runInstaticHoleRuntime (TS source) + HOLE_RUNTIME_JS (IIFE-serialized, ~668 B)
├── publicRenderer.ts               — renderPublishedSnapshot, renderPublishedDataRowTemplate
├── publishedHtmlPipeline.ts        — post-process (sanitize + plugin filters + injections)
├── siteCssBundle.ts                — server-side hashing + file emission
├── frontendInjections.ts           — splice plugin <script>/<link>/<meta> into HTML
├── mediaPresentation.ts            — <picture>/<srcset> materialization at publish time
├── renderTreeWalk.ts               — walkRenderTree: visits every node that contributes to a rendered page (page nodes + VC definition trees, cycle-guarded); single source of truth for loop-prefetch and media-prefetch
├── mediaPrefetch.ts, loopPrefetch.ts — pre-warm caches needed by the renderer
├── republish.ts                    — bulk re-publish on site-level changes
├── publishScheduler.ts             — scheduled publish jobs
├── runtime/                        — per-site bun install workspace serving
└── loopRuntime.ts                  — loop runtime asset
```

---

## The `publishPage` flow

```text
publishPage(page, site, registry, options)  ← src/core/publisher/render.ts
    │
    ├─→ resolve template-context frames (page / site / route)
    ├─→ inject root node's classIds into <body> tag
    ├─→ build <head>: title, description, favicon, lang, importmap, runtime <script>s, CSP
    ├─→ renderNode(rootNodeId, config, acc)
    │       │
    │       ├─→ if node.hidden, return '' before any renderer or CSS path
    │       ├─→ specialised renderer for `base.visual-component-ref`  → renderVisualComponentRef
    │       ├─→ specialised renderer for `base.loop`                  → renderLoop
    │       └─→ renderStandardNode for everything else (the bulk of the tree)
    │
    ├─→ collect deduped module CSS via CssCollector
    ├─→ collect author StyleRule CSS via collectClassCSS
    ├─→ assemble: reset CSS + framework CSS + module CSS + class CSS + user stylesheets
    └─→ emit final HTML document
```

### `renderStandardNode` per-node flow

```text
For each node, bottom-up:

  1. children = node.children.map(renderNode)            ← recurse first
  2. resolvedProps  = resolveProps(node, breakpoint)     ← merge breakpoint overrides
  3. dynamicProps   = resolveDynamicProps(...)           ← apply data bindings
  4. safeProps      = escapeProps(dynamicProps, schema)  ← escape per schema TYPE
  5. attachResolvedMediaByKey(safeProps, def, ...)       ← attach <picture>/<srcset>
  6. attachAutoSizes(safeProps, def, ...)                ← auto <img sizes>
  7. { html, css } = def.render(safeProps, children)                  ← MODULE BOUNDARY
  8. acc.cssMap.set(moduleId, sanitizeModuleCSS(css))    ← neutralise </style (Constraint #228), dedup by moduleId
  9. html = injectNodeClassIds(html, node, site)         ← splice classIds into root tag
 10. html = injectNodeInlineStyles(html, node.inlineStyles) ← splice inline styles onto root tag
 11. [annotateNodeIds] html = injectNodeId(html, node.id)   ← editor-only uid="<id>" on root element
```

The walker is recursive. Each node's HTML output is a pure function of its node + its already-rendered children — no cross-node coupling. The only shared mutable state is the `RenderAccumulators` bag (`cssMap`, `infiniteLoopIds`, `holeNodeIds`), which is threaded as an explicit parameter rather than hidden in the read-only config — so every place that appends to it is visible at the call site.

---

## RenderConfig vs RenderAccumulators

`renderNode` (and every specialised renderer) takes **two** explicit parameters — `(nodeId, config, acc)` — that separate the two structurally different roles a render pass mixes. Both shapes live in `renderConfig.ts`.

- **`RenderConfig` (read-only inputs).** `page`, `site`, `registry`, `breakpointId`, `templateContext`, `dynamicNodeIds`, `publishVersion`, `annotateNodeIds`, plus the pre-fetched I/O (`loopData`, `mediaAssets`). Every field is `readonly`; collections are `ReadonlyMap` / `ReadonlySet`. A renderer that needs a different page (VC ref) or a different template frame (loop iteration) **derives a new child config** via `{ ...config, page }` — it never mutates the one it received. A function that takes only a `RenderConfig` is genuinely a pure string transform.

- **`RenderAccumulators` (mutable outputs).** `cssMap` (deduped module CSS), `infiniteLoopIds` (loops that requested the infinite runtime), `holeNodeIds` (nodes that actually emitted a `<instatic-hole>`). `publishPage` owns this bag, initialises all three up-front (no lazy `undefined`), and threads the **same instances** by reference down the whole walk; renderers append to them. After the walk, the head builders read `acc.cssMap` / `acc.infiniteLoopIds.size` / `acc.holeNodeIds.size`.

This split is why the loop and VC renderers are honest about their effects: `renderLoop` extends the entry stack by constructing a child config (no shared-array push/pop), and `renderVisualComponentRef` shares `cssMap` by passing the same `acc` through — both visible at the call site instead of smuggled through a cloned god-object.

The `TemplateRenderDataContext.entryStack` carried inside `config.templateContext` is correspondingly `readonly` — the per-iteration `[...baseStack, item]` derivation is the only way to extend it.

---

## Module render API

A module's `render()` is the only thing the walker calls per node. It's a **pure** function:

```ts
type ModuleRender<TProps> = (
  props:             TProps,       // already HTML-escaped + bindings resolved
  renderedChildren:  string[],     // pre-rendered child HTML strings
) => { html: string; css?: string }
```

- **No DOM access**, **no React**, **no side effects**. The result is a string of HTML and an optional string of CSS.
- String props are HTML-safe after `escapeProps` — interpolate them directly. For URL attributes (`href`, `src`, `action`) use `safeUrl(value)` from `src/core/publisher/utils.ts`.
- Join children as `renderedChildren.join('')`; leaf modules receive an empty array.
- The returned `css` is collected and deduped — emitting the same CSS for every instance of a module is fine; it appears once in the page bundle.

Constraints (gated by tests):

- **Constraint #179** — render() is pure.
- **Constraint #211** — `escapeProps` runs on every node before render(); modules can trust string props are HTML-safe.

---

## Specialised renderers

### `base.visual-component-ref` — Visual Component instances

When the walker hits a `base.visual-component-ref` node, it calls `renderVisualComponentRef`:

1. Resolves the target Visual Component from the site's `components` table.
2. Builds `slotInstancesByName` from the ref's `base.slot-instance` children in the consumer page tree.
3. Calls `instantiateVCAtRef(vc, propOverrides, slotInstancesByName, config.page.nodes, node.id)` to materialise a flat node map where slot outlets are already filled with consumer content.
4. Wraps the instantiated node map in a synthetic `Page` and derives a child `RenderConfig` via `{ ...config, page: syntheticPage, dynamicNodeIds: undefined, annotateNodeIds: undefined }`. **The child config inherits `loopData`, `mediaAssets`, `publishVersion`, `templateContext`, etc. from the outer config**, so `base.loop` nodes and image props inside the VC body resolve with data exactly as they would on a plain page. `dynamicNodeIds` is cleared (VC-internal holes aren't supported — the outer ref is what gets holed) and `annotateNodeIds` is cleared (VC-definition node ids are not part of the agent's page read surface). Only the page-level ref node's `uid` lands on the VC root (applied in step 5 below).
5. Renders via `renderNode(rootNodeId, syntheticConfig, acc)`. The **same `acc` accumulators are passed through unchanged** — sharing the one `cssMap` instance is what dedups CSS across the VC boundary (a VC used three times contributes module CSS once). Because `acc` is an explicit parameter, this sharing is visible at the call site, not smuggled through a cloned context. After recursive rendering, the ref node's classIds and inline styles are injected onto the VC root element; when `annotateNodeIds` is set, the ref node's own `uid="<id>"` is also injected — one `uid` per element, targeting the page-tree node the agent can address.

See [docs/features/visual-components.md](visual-components.md) for the VC modeling details.

### `base.loop` — loop sources

When the walker hits a `base.loop` node, it calls `renderLoop`:

1. Resolves the loop's entity source (a built-in source like `content.entries`, `site.pages`, `site.media`, or a plugin-registered source).
2. Pulls items from the loop fetch result (pre-warmed by `loopPrefetch.ts` during publish).
3. Walks the loop's child variants in round-robin. For each item it derives a fresh child `RenderConfig` whose `templateContext.entryStack` is a **new array** `[...baseStack, item]` — there is no in-place push/pop on a shared array, so child nodes' `dynamicBindings` resolve `currentEntry.<field>` against that item while a VC ref (or nested loop) in the body sees an immutable per-iteration snapshot. The outer config is never mutated, so the loop's siblings keep seeing the outer template entry.
4. Concatenates the rendered variant HTML and returns it. If `pagination === 'infinite'`, the loop id is added to `acc.infiniteLoopIds` so `publishPage` knows to inject the loop runtime.

See [docs/features/loops.md](loops.md) for sources, filters, and registration.

---

## Dynamic node detection

`findDynamicNodeIds` (`src/core/publisher/dynamicDetection.ts`) classifies every node in a page tree as static or dynamic in a single walk. The result set drives both Layer A's shell-vs-complete decision and Layer C's `<instatic-hole>` placeholder emission. The rules:

| Rule | Condition | Result |
|------|-----------|--------|
| 1    | Module flagged `dynamic: true` in the registry | Node is a hole |
| 2    | Node has a `dynamicBindings` entry whose source is request-dependent (`route.query.*`) | Node is a hole |
| 2b   | A string prop contains a `{source.field}` token whose source is request-dependent | Node is a hole |
| 3    | `moduleId === 'base.loop'` AND the loop source declares `requestDependent: true` or `perVisitor: true` | Loop is a hole |
| 3.5  | `moduleId === 'base.loop'` AND the loop source is static, but its body (transitively, including nested loops and referenced VC trees) contains any request-dependent node | Loop is promoted to a single hole; all body descendants are suppressed |
| 4    | `moduleId === 'base.visual-component-ref'` whose VC definition tree contains any dynamic node | The outer VC ref node is a hole; inner VC node ids are never promoted |

**Rule 3.5** prevents a broken publish artifact: if a static loop rendered its body's dynamic child as a per-node hole, the loop would emit N `<instatic-hole id="X">` elements with the same id — one per iteration — all resolving to the same context-less fragment. By promoting the loop itself to a single hole, the renderer emits one placeholder and the hole endpoint re-runs the entire loop at request time with full per-item context.

All five rules live in **one predicate**, `classifyNode(node, site, registry, seenVcs)`. The main per-node pass and the Rule 3.5 static-loop-body pre-pass both route every node decision through it (the pre-pass walks the loop subtree via `collectSubtreeReasons`, calling `classifyNode` on each visited node). There is exactly one definition of "is this node request-dependent?", so the two passes cannot drift — adding a future rule is a single edit in `classifyNode`, and a static loop whose body becomes dynamic by that rule is promoted automatically.

VC ref subtlety (Rule 4): when a VC definition tree is dynamic, the *outer* `base.visual-component-ref` node id in the page tree goes into `dynamicPageNodeIds` — not the inner VC node ids. The hole boundary is the ref, not any inner node.

---

## CSS pipeline

A published page links **four** hashed CSS bundles (`buildSiteCssBundle`), in
cascade order. Source order resolves specificity ties: user CSS wins over the
class registry, which wins over framework, which wins over reset.

```text
reset-<hash>.css       = PUBLISHER_RESET_CSS                       ← reset.ts (cross-browser baseline)
framework-<hash>.css   = buildSiteFrameworkCss(site)               ← frameworkCss.ts (spacing, typography, …)
                       + collectModuleCSS(via CssCollector)        ← deduped per-moduleId CSS
style-<hash>.css       = collectClassCSS(site)                     ← user-defined StyleRule entries, incl. raw @keyframes
userStyles-<hash>.css  = collectUserStylesheetCss(site, page)      ← author stylesheets, scoped to this page
```

`reset` / `framework` / `style` are page-invariant — every page on the site
shares the same hash. `userStyles` is **page-scoped**: each author stylesheet
(`site.files[type === 'style']`) carries a `SiteStyleRuntimeConfig` (in
`site.runtime.styles[fileId]`) with an enable flag, a page/template scope, and
a cascade priority. `collectUserStylesheetCss(site, page)` selects the
stylesheets that target `page`, orders them by `priority` then `path`, and
concatenates them — so two pages with different stylesheet targeting get
different `userStyles` content (and hash). This mirrors how scripts are scoped
per page; the shared `assetScopeAppliesToPage` helper decides targeting for
both.

Because `framework` is built by walking **every** page's node tree to harvest
module CSS — O(all nodes across the whole site), not the rendered page — the
published-snapshot renderer uses `buildPublishedSiteCssBundle`, which memoises
the three page-invariant files by `publishVersion` + site object. The all-pages
walk then runs **once per published snapshot object** instead of once per render,
so a Layer-B cache miss or a background republish no longer repays it per page.
The site-object guard matters during a full publish: HTML is baked before
`bumpPublishVersion()`, so a new snapshot at the still-current version must not
reuse CSS from the previous published site. `userStyles` is still rebuilt per
call (page-scoped). `bumpPublishVersion()` invalidates the memo, so a content
change can never serve stale framework/style CSS. Callers that pass draft or
arbitrary sites at the live version (preview, AI render, the CSS-route fallback)
keep using the un-memoised `buildSiteCssBundle`.

### CSS dedup via `CssCollector`

```ts
const collector = new CssCollector()
collector.add(moduleId, css)   // first call per moduleId is stored; subsequent calls are no-ops
collector.flush()              // returns the deduped CSS string
```

This is what shrinks published CSS by ~60–80% on typical pages (Decision #308). Every `<button>` module instance emits the same CSS once.

### CSS sanitization

Two sanitizers run in the publisher pipeline, each guarding a different injection surface.

**Value-level: `sanitiseCssValue`** (`src/core/css-sanitize/sanitiseCssValue.ts`) — the canonical CSS value sanitizer shared across the entire codebase. Blocks `expression(...)`, `javascript:`, `behavior:`, `-moz-binding`, `data:text/...`, `{}` (selector breakout), and `</` (RAWTEXT end-tag escape). Every CSS property value passes through it before being emitted — in `bagToCSS` / `bagToInlineStyle` (publisher), in `ClassStyleInjector` (editor live preview), and in `formatCssVariableDeclarations` (framework `:root {}` variable block). The canonical implementation lives in `src/core/css-sanitize/`, a dependency-free leaf module both `@core/publisher` and `@core/framework` depend on; `@core/publisher` re-exports it from `utils.ts` for publisher-side consumers that haven't switched import paths. Framework CSS variable emission adds a second guard: values containing `;` are also dropped, because in a custom-property context a bare `;` terminates the declaration and could inject a sibling — unlike the publisher's declaration-block context, where `;` is valid inside a quoted `url("data:image/png;base64,…")`.

**Block-level: `sanitizeModuleCSS`** (`src/core/publisher/cssCollector.ts`) — neutralises the `</style` sequence in CSS blocks before injection into a `<style>` element. The substitution replaces `</style` with `<\/style` — the HTML5 RAWTEXT tokenizer never recognises the end tag regardless of the trailer character, and CSS string literals resolve `\/` back to `/` so URL values round-trip correctly. This prevents stored XSS via user stylesheets or module CSS that would otherwise close the `<style>` element early and inject script (CWE-79, Constraint #228).

Two block-level passes run at publish time (inline mode):

1. **Per-module pass** — inside `renderStandardNode` when storing module CSS in `cssMap`. Module CSS is sanitised before dedup storage.
2. **Full-assembly pass** — in `buildStyleHead` after concatenating reset + framework + module + class + user stylesheets into the final `<style>` block. This pass protects user-authored stylesheets, which are the higher-risk vector (stored user content). The second pass is idempotent on already-sanitised module CSS.

### Hashed bundle filenames

The server's `siteCssBundle.ts` and the client's `siteCssBundle.ts` together name each bundle file `<group>-<contentHash>.css`. The publisher emits `<link rel="stylesheet" href="/_instatic/css/<bundle>-<hash>.css">` per non-empty bundle. `Cache-Control: immutable` (1 year) is safe because the hash changes whenever the content does.

Four bundles per page (each hashed independently): `reset`, `framework`,
`style`, `userStyles` — see the cascade table above.

### Static publishing — everything baked to disk

A full publish (`publishDraftSite`) bakes **every page** plus all of its assets
into the publish slot:

- **HTML** — fully-static pages bake to a complete document; pages with dynamic
  nodes bake their static **shell** with `<instatic-hole>` placeholders (the hole
  runtime hydrates each fragment from `/_instatic/hole/`). Either way the HTML is on
  disk. A page that fails to render (e.g. a VC ref cycle) is skipped and falls
  through to the live renderer.
- **CSS bundles** — `/_instatic/css/<bundle>-<hash>.css`, for every page.
- **Runtime JS** — `/_instatic/assets/<versionId>/…`, for every page.

The visitor router serves all of these straight off disk (`readArtefact` /
`readStaticAsset`) — no DB round-trip, no per-request rebuild. The slot is a
self-contained static export: **a published page never hits the server to
generate its HTML, CSS, or JS. The only request that touches the DB is the
`/_instatic/hole/` fragment fetch** for a page's dynamic islands.

Hole shells are stamped with the *next* publish version (`getPublishVersion() +
1`) at bake time, because `bumpPublishVersion()` runs as the synchronous
statement right after the slot swap — so a baked `<instatic-hole data-instatic-version>`
always matches what the hole endpoint expects (a mismatch would make the
endpoint refuse to hydrate).

The exclusive namespaces `/_instatic/css/*` (`serveSiteCss`) and `/_instatic/assets/*`
(`tryServeRuntimeAsset`) are served **disk-first**, falling back to a rebuild
(`serveSiteCss`) or the DB (`published_runtime_assets`) only for preview or a
publish whose disk write failed. Unknown paths under either prefix 404 rather
than falling through.

---

## `<head>` assembly

The publisher emits `<head>` in this order:

1. `<meta charset="utf-8">`
2. `<meta name="viewport" content="width=device-width, initial-scale=1">`
3. `<title>` from `page.title`
4. `<meta name="description">` if present in page settings
5. `<link rel="icon">` if a favicon is configured
6. `<script type="importmap">` mapping bare specifiers (e.g. `three`) to `/_instatic/runtime/cache/<hash>/...` URLs
7. Runtime asset `<script>` tags (`scriptTagsForRuntimeAssets`)
8. `<link rel="stylesheet" href="/_instatic/css/<bundle>-<hash>.css">` per bundle
9. **`head` placement** plugin-injected tags (after the publisher's own head, before custom user head content)
10. `<meta http-equiv="Content-Security-Policy" content="...">` — assembled based on what's actually in the page

Installed fonts are emitted through the CSS bundle, not external `<link>` tags. The font CSS includes self-hosted `@font-face` rules for `site.settings.fonts.items` plus `:root` declarations for editable tokens such as `--font-primary`. A page rule can therefore keep `font-family: var(--font-primary)` while the token assignment changes site-wide.

Plugins inject at four anchors. The order matters — see [docs/features/plugin-system.md](plugin-system.md) for the splicing rules.

### CSP

The CSP is modelled as **data**, not a string assembled with regex. `src/core/publisher/cspPlan.ts` owns one `CspPlan` (`Map<directive, Set<source>>`) and the deterministic `serializeCsp` (directives sorted by name, sources sorted within each directive). Every stage contributes to the same plan:

- `createBaseCspPlan` (in `render.ts`) emits the base policy: `default-src 'self'`, restricted `script-src` (`'none'` → `'self'` + importmap `sha256` once any script tag is present), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: https:`, `frame-src 'none'`, and `worker-src` (`'none'` → `'self' blob:`).
- The server injection pipeline (`server/publish/frontendInjections.ts`) merges plugin `frontend.assets[]` relaxations + elected media-adapter origins into the plan in **one** pass via `rewriteCspMeta` — no second regex pass, no per-directive `RegExp`.
- The module-JS injector (`injectModuleScripts` in `server/publish/moduleJsBundle.ts`) merges `script-src 'self'` through the same `rewriteCspMeta` helper — only when at least one `/_instatic/module-js/<moduleId>.js` script tag was injected.

Because `serializeCsp` sorts, the same plugins + adapters always emit a **byte-identical** policy across runs (gated by `src/__tests__/publisher/cspPlan.test.ts`) — important for content-hashing and stable tests. Editing the emitted CSP string manually is **not** safe — it's a derived value. Mutate the plan (`setCspDirective` to replace, `addCspSources` to union) and re-serialize.

---

## Module JS channel

`render()` may return `js` next to `html`/`css` (`RenderOutput`, `src/core/module-engine/types.ts`). The walker dedupes it per moduleId into `RenderAccumulators.jsMap`; `publishPage` reports per-page candidates (`jsModuleIds` = render-emitted ids ∪ every moduleId inside the page's hole subtrees via `collectHoleSubtreeModuleIds`); the server intersects candidates with the site-wide map (`buildPublishedSiteModuleJsMap`) and injects one external `<script defer>` per module before `</body>`. JS is never inlined — no `</script>` escaping anywhere. Pages with no module JS ship zero script tags and keep `script-src 'none'`. The CMS form runtime is the first consumer: `base.form` emits it when `mode === 'cms'` (`src/modules/base/forms/formRuntimeJs.ts`); token stamping stays server-side (`stampFormPageTokens`, applied to baked pages and hole fragments).

---

## Server-side wrappers

`src/core/publisher/` is pure (no Bun, no Node, no fs). The server wraps it.

| File                                            | Role                                                                |
|-------------------------------------------------|---------------------------------------------------------------------|
| `server/publish/publicRouter.ts`                | Gateway: Layer A disk fast-path → Layer B LRU → live `resolvePublicRoute` + `renderPublicResolution`. |
| `server/publish/staticArtefact.ts`              | Two-slot symlink swap (`swapSlot`), per-file atomic writes (`writeArtefact`, `updateArtefactInPlace`), and reads (`readArtefact`). Layer A. |
| `server/publish/renderCache.ts`                 | In-memory LRU keyed by `(urlPath, canonicalQuery)`, entries versioned. `getOrRender` (single-flight). Reads the version from `publishState`; version captured at render start — a publish landing mid-render discards the result rather than caching stale HTML. Layer B. |
| `server/publish/publishState.ts`                | Publish-time process state: `publishVersion` (`bumpPublishVersion`/`getPublishVersion`), `withPublishLock` (ISS-038 publish serializer), and `createVersionedSingleFlight` — the generalized version-keyed single-flight memo the hole endpoint reuses. Repositories import the version + lock from here (not from the cache). |
| `server/publish/holeRuntime.ts`                 | Exports `runInstaticHoleRuntime` (the TypeScript source of the Layer C runtime) and `HOLE_RUNTIME_JS` (IIFE-serialized string, ~668 B, served to browsers). Tests call `runInstaticHoleRuntime()` directly to avoid dynamic eval. |
| `server/publish/publicRenderer.ts`              | `renderPublishedSnapshot`, `renderPublishedDataRowTemplate` — thin wrappers (resolve + compose the template chain, seed the context) over one shared `renderMergedTemplate` (CSS bundle + loop/media prefetch + `publishPage` + publish-version stamping). |
| `server/publish/publishedHtmlPipeline.ts`       | Post-process: DOMPurify the final HTML, run plugin `publish.html` filter, splice in declarative tags from plugin manifests, inject runtime assets. Runs at publish time only — never per-request. |
| `server/publish/siteCssBundle.ts`               | Hash the three CSS strings, write `uploads/css/...` files. The framework bundle's module-CSS half comes from the shared walk in `siteModuleAssets.ts`. |
| `server/publish/siteModuleAssets.ts`            | `collectSiteModuleAssets` — the one full-site render walk whose accumulators feed BOTH the framework CSS bundle (`cssMap`) and the published module-JS map (`jsMap`). |
| `server/publish/moduleJsBundle.ts`              | Module-JS channel: `buildSiteModuleJsMap` (fresh), `buildPublishedSiteModuleJsMap` (memoised per publishVersion + site, invalidated by `bumpPublishVersion()`), and `injectModuleScripts` (per-page `<script defer>` tags + CSP `script-src 'self'` relaxation). |
| `server/publish/republish.ts`                   | Bulk re-publish on settings change (touches every page).            |
| `server/publish/publishScheduler.ts`            | Scheduled publish jobs (cron-style).                                |
| `server/publish/frontendInjections.ts`          | Compute plugin `<script>`/`<link>`/`<meta>` tags + CSP entries.     |
| `server/publish/mediaPresentation.ts`           | At publish time, build `<picture>` / `<img srcset>` markup from `media_assets.variants_json`. |
| `server/publish/mediaPrefetch.ts`               | Collect every image/media-typed prop from the full render tree — including VC definition trees — via `walkRenderTree`, then batch-fetch matching `media_assets` rows into a `Map<publicPath, MediaAsset>` before render. Uses `MEDIA_ASSET_COLUMNS` and `mapMediaAssetRow` from `server/repositories/mediaAssetMapping.ts` (shared with the admin repository) so the published page and the admin panel always see one identical asset shape. |
| `server/publish/loopPrefetch.ts`                | Collect every `base.loop` node from the full render tree — including VC definition trees — via `walkRenderTree`, fetch each source's items, and return a `Map<nodeId, ResolvedLoopData>` before render so the walker is purely synchronous. Also exports `canonicalRenderQuery(searchParams)` — strips all non-loop-pagination params from a URL's query, returning only `loop_<nodeId>_page` keys in sorted order (or `''` when none remain). Used by `publicRouter.ts` to normalise the Layer B cache key and Layer A fast-path eligibility. |
| `server/publish/renderTreeWalk.ts`              | `walkRenderTree(nodes, rootNodeId, site, onNode)` — visits every node that contributes to a rendered page: all page-tree nodes reachable from `rootNodeId`, plus all nodes inside each referenced VC's definition tree (recursively, cycle-guarded by a `Set<vcId>`). Used by both `mediaPrefetch.ts` and `loopPrefetch.ts` so their traversal logic can't drift apart. |
| `server/publish/runtime/packageServer.ts`       | Serve per-site `bun install` workspace under `/_instatic/runtime/cache/`. |
| `server/publish/loopRuntime.ts`                 | The loop runtime asset (small JS shim used by certain loop variants).|
| `server/handlers/cms/hole.ts`                   | `GET /_instatic/hole-runtime.js` (serves `HOLE_RUNTIME_JS`) and `GET /_instatic/hole/<nodeId>` (renders a node subtree at request time for Layer C islands). |
| `server/handlers/cms/moduleJs.ts`               | `GET /_instatic/module-js/<moduleId>.js?v=<publishVersion>` — serves a module's render-emitted JS from the memoised site map; validates the untrusted moduleId segment; 404 unknown; `text/javascript`; `cache-control: public, max-age=3600`. |
| `server/richtextSanitizer.ts`                   | Installs the server's happy-dom-backed DOMPurify runtime without global DOM objects. |

### `publishedHtmlPipeline.ts` — the plugin filter point

After `publishPage` returns, the server runs:

```text
publishPage(page, site, registry, options) → rawHtml
    │
    ▼
applyPublishedHtmlPipeline(renderedOutput, db)
    │
    ├─→ Emit `publish.before` hook (plugins can prepare state)
    ├─→ Splice in declarative tags from plugin manifests' `frontend.assets[]`
    ├─→ Stamp form page tokens onto CMS-native <form> tags (`stampFormPageTokens`)
    ├─→ Inject per-module published JS: one `<script src="/_instatic/module-js/<id>.js?v=N" defer data-instatic-module-js="<id>">` per moduleId in the page's injection set (render-emitted ∪ hole-subtree ∩ site jsMap), sorted; CSP script-src → 'self' iff ≥ 1 tag
    ├─→ Run `publish.html` filters in registration order (plugins transform the HTML string)
    ├─→ Emit `publish.after` hook
    └─→ Return final HTML
```

Plugins shouldn't need to know about the publisher internals — they get the HTML string and return the transformed string.

---

## Publishing a single page

```text
POST /admin/api/cms/publish/site
    │
    ▼
publishDraftSite (server/publish/publishSite.ts)
    │
    ├─→ load draft site shell + all page-table rows + all VC rows
    ├─→ build runtime scripts + runtime package importmap
    ├─→ build EVERYTHING expensive first, outside any transaction — dependency
    │     cache (`bun install`), importmap, per-page esbuild runtime builds.
    │     The SQLite adapter serializes all transactions through one chain, so
    │     this work inside the transaction would stall every concurrent write.
    ├─→ short transaction: write the SiteDocument ONCE into site_snapshots
    │     (content hash stamped for the publish-status check); each page's
    │     data_row_versions row references it via site_snapshot_id + carries
    │     its runtime_assets_json
    ├─→ flip data_rows.status = 'published', set active_version_id
    │
    ├─→ Layer A bake — the 404 page (when a notFound template exists):
    │     renderPublishedNotFound (notFound template wrapped in the everywhere
    │     chain) → same pipeline → writeArtefact(<inactiveSlot>, '/404')
    │     (`404.html` — the static-hosting convention, so Netlify/GH Pages
    │      pick it up in a raw static export; baked first so a literal page
    │      with slug `404` would overwrite it and stay authoritative)
    │
    ├─→ Layer A bake — every page (complete doc, or static shell with <instatic-hole>):
    │     ├── renderPublishedSnapshot(snapshot, { db, url, publishVersion }) → HTML
    │     ├── applyPublishedHtmlPipeline(rendered, db) → final HTML
    │     │   (plugin filters + frontend asset injection baked in)
    │     └── writeArtefact(<inactiveSlot>, urlPath, html)
    │
    ├─→ Layer A bake — every published data-row route (bakeDataRows.ts):
    │     entry-template render through the same pipeline → writeArtefact
    │     (without this, the slot swap would strand every row artefact)
    │
    ├─→ Layer A bake — CSS bundles + runtime JS → writeStaticAsset(<slot>)
    │     (page-invariant CSS trio computed once per publish via the
    │      version-keyed memo in siteCssBundle.ts; userStyles per page)
    │         (atomic per-file: tmp + rename; per-page try/catch)
    │
    ├─→ swapSlot(uploadsDir, newActiveSlot)
    │     uploads/published/current → flips atomically (rename of a symlink
    │     is a single-inode swap; in-flight readers keep fds into the OLD
    │     slot until they close)
    │
    └─→ bumpPublishVersion() → Layer B LRU evicts lazily on next read

— and on the visitor request side —

GET /<slug>  OR  /<route-base>/<row-slug>
    │
    ▼
tryServePublicRoute (server/router.ts)
    │
    └─→ server/publish/publicRouter.ts:renderPublicResolution
          │
          ├─→ canonicalRenderQuery(url.searchParams) → canonicalQuery
          │     keeps only loop_<nodeId>_page params (sorted); everything else → ''
          │     e.g. ?utm=foo → '' (junk collapses);  ?loop_x_page=2 → '?loop_x_page=2'
          │
          ├─→ Layer A disk fast-path (only if canonicalQuery === ''):
          │     readArtefact(uploadsDir, url.pathname)
          │     hit → stream HTML (~0.6–1.4 ms, no DB, no render, no filter)
          │     (URLs with only junk params hit Layer A just like bare URLs)
          │
          ├─→ Layer B peek (warm fast-path): a version-matched cached 200 for
          │     (urlPath, canonicalQuery) is served immediately — zero DB work.
          │     Safe because every route retraction (unpublish, soft-delete,
          │     table move) bumps publishVersion, evicting the whole cache.
          │
          ├─→ resolvePublicRoute(db, url) → page | row | redirect | not-found
          │     page slug hit skipped when page.template.enabled === true (template pages
          │     are never directly routable — falls through to row/redirect/not-found)
          │     row resolutions read the site snapshot via the per-version memo
          │     (publishedSnapshotCache.ts) — no per-request full-site parse
          │     redirects → 301 (not cached)
          │     not-found → null (router falls through: trySetupRedirect, then
          │     tryServeNotFoundPage → renderNotFoundResponse serves the site's
          │     404 page — baked `404.html` artefact first, else live render
          │     through the LRU under the reserved `/404` key — with status 404;
          │     no notFound template → the dispatcher's bare JSON 404)
          │
          └─→ Layer B in-memory LRU (miss path):
                getOrRender({urlPath, queryString: canonicalQuery}, async () => {
                  publishPage(page, site, registry, options) using snapshot bytes
                  applyPublishedHtmlPipeline (plugin filters)
                  return { body, headers, status: 200 }
                })
                hit → return cached body (~0.8 ms)
                miss → factory runs once (single-flight on concurrent keys)
                publishVersion bumped at publish → entries evict lazily on next read
                version captured at factory start → mid-flight publish discards result (not cached)
```

The visitor-facing artefacts are:
1. **Disk files in the active slot** (`uploads/published/current/<route>.html`) — for fully-static routes. Final HTML, post-filter, frontend assets baked in. Rebuilt on each full publish.
2. **In-memory LRU entries** — for dynamic routes (loops, request-dependent bindings). Filled lazily, evicted on every publish.
3. **`<instatic-hole>` fragment responses** at `/_instatic/hole/<nodeId>` — for dynamic nodes inside otherwise-cacheable pages. Fetched lazily by the IntersectionObserver runtime; also cached in Layer B.

The published `SiteDocument` is stored once per publish in `site_snapshots` and referenced by `data_row_versions.site_snapshot_id`; the `PublishedPageSnapshot` reassembled from that join remains the canonical audit record — all three layers derive from it. At request time it is memoised per publish version (`server/publish/publishedSnapshotCache.ts`, shared by the public router's row resolution, the hole endpoint, and the loop endpoint), and `renderPublicResolution` serves a warm Layer B entry *before* any route resolution — a cache hit does zero DB work.

---

## Adding a new module renderer

The publisher doesn't know about specific modules — it asks the registry. To add a new first-party module that renders correctly:

1. Define a `ModuleDefinition<TProps>` and call `registry.registerOrReplace(...)` from `src/modules/base/index.ts` (see [docs/features/modules.md](modules.md) and [docs/reference/module-engine.md](../reference/module-engine.md)).
2. Implement `render(props, renderedChildren) → { html, css? }` as a pure function.

That's it. The walker, escape, class injection, and CSS dedup all work automatically.

### Adding a new specialised renderer (rare)

The two existing specialised renderers (`renderVisualComponentRef`, `renderLoop`) hook in because they fundamentally **replace** the normal walk — VC ref inlines a different tree; loop iterates and round-robins. If you have a new module that needs to replace the walk:

1. Write the renderer in `src/core/publisher/<your>Renderer.ts`.
2. Take `renderNode` as a callback to keep the file graph acyclic.
3. Hook into `renderNode.ts`'s dispatch on `moduleId`.

This is rare and requires architectural review — most "new behavior" fits within the standard module render contract.

---

## Forbidden patterns

| Pattern                                                       | Use instead                                                |
|---------------------------------------------------------------|------------------------------------------------------------|
| Mutating the page tree inside a module's `render()`           | Render is pure. Compute, don't mutate.                     |
| Reading `document` / `window` inside `render()`               | The publisher runs server-side. There is no DOM.           |
| Calling `await` inside `render()`                             | Render is synchronous. Pre-warm async data via prefetch (loop, media). |
| Hardcoding `<link>` to a CSS file the publisher didn't emit   | Add a CSS string to the module's `render()` return — collected and deduped automatically. |
| Bypassing `escapeProps` by reading `node.props` directly inside `render()` | Read from the `props` argument — it's already escaped. |
| Hand-writing `<picture>` / `<img srcset>` in a module         | Set `props.<key>` to a media URL; `mediaPresentation.ts` materializes the markup. |
| Adding `@import url(...)` to module CSS                       | The final document passes through DOMPurify in `publishedHtmlPipeline.ts`, which strips dangerous CSS constructs. Add it to the site's user stylesheets instead (where it is intentional). |
| Editing the CSP meta tag string manually                      | Edit the CSP source list — the tag is derived.             |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — server-side publishing wrappers
- [docs/features/visual-components.md](visual-components.md) — VC instances + slots
- [docs/features/loops.md](loops.md) — loop sources + the round-robin walk
- [docs/features/modules.md](modules.md) — defining a module
- [docs/features/media.md](media.md) — media variants + presentation
- [docs/features/plugin-system.md](plugin-system.md) — `publish.before/.html/.after` filters
- Source-of-truth files:
  - `src/core/publisher/render.ts` — `publishPage`
  - `src/core/publisher/renderNode.ts` — the walker
  - `src/core/publisher/renderConfig.ts` — `RenderConfig` + `RenderAccumulators` + `RenderNodeFn`
  - `src/core/publisher/renderVisualComponentRef.ts` — VC inlining + config/accumulator threading
  - `src/core/publisher/dynamicDetection.ts` — `findDynamicNodeIds` (all detection rules)
  - `src/core/publisher/cssCollector.ts` — `CssCollector` + block-level sanitization
  - `src/core/publisher/escapeProps.ts` — Constraint #211 enforcement
  - `src/core/css-sanitize/sanitiseCssValue.ts` — canonical CSS value sanitizer (shared with `@core/framework`)
  - `server/publish/publishedHtmlPipeline.ts` — plugin filter point
  - `server/publish/publicRenderer.ts` — server wrappers
  - `server/publish/renderTreeWalk.ts` — `walkRenderTree` (shared render-tree visitor)
- Gate tests:
  - `src/__tests__/architecture/dispatcher-html-pipeline.test.ts`
  - `src/__tests__/architecture/publish-html-filter-context.test.ts`
  - `src/__tests__/architecture/media-presentation-pipeline.test.ts`
  - `src/__tests__/architecture/publish-bumps-cache-version.test.ts` — every publish/unpublish entry point calls `bumpPublishVersion()` imported from `publishState.ts`
  - `src/__tests__/publisher/cspPlan.test.ts` — CSP determinism (byte-identical output for the same inputs)
  - `src/__tests__/server/dynamicDetection.test.ts` — Rules 1–4 (module flag, bindings, tokens, loop source, VC ref)
  - `src/__tests__/server/dynamicDetectionLoop.test.ts` — Rule 3.5 static loop body promotion
  - `src/__tests__/server/dynamicIslandsPlugin.test.ts` — end-to-end confirmation of plugin loop sources as Layer C holes: protocol schema accepts `requestDependent`/`perVisitor`; dynamic detection classifies them under Rule 3; shared holes cache per query; per-visitor holes bypass the cache (`no-store`) and re-render every request; the versioned snapshot memo loads from DB once per publish version
  - `src/__tests__/server/siteCssBundleMemo.test.ts` — `buildPublishedSiteCssBundle` memo: the O(all-pages) walk runs once per publish snapshot, `bumpPublishVersion()` invalidates the memo, memoized output is byte-identical to the un-memoized builder, and `userStyles` is never memoized (page-scoped)
