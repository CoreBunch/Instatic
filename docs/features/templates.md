# Templates

Templates are pages that wrap other content — every page on the site (everywhere layouts) or every entry in a post type. They are the mechanism for shared headers, footers, and layout chrome. A third target, `notFound`, designates the page served on public 404s (it doesn't wrap anything — it IS the content, wrapped by the everywhere layout like any page).

A template is an ordinary `pages` row carrying a `target` (everywhere, one/more post types, or notFound) and a `priority`. When the public router resolves a URL, it collects every matching template, orders them broadest→narrowest, and a composer splices each inner tree into the outer template's single `base.outlet`, producing one merged page tree. That tree feeds the existing `publishPage` pipeline unchanged.

---

## TL;DR

- A template declares `target: { kind: 'everywhere' } | { kind: 'postTypes', tableSlugs } | { kind: 'notFound' }` and a `priority`.
- **Chain resolver:** `resolveTemplateChain(site, ctx)` in `src/core/templates/templateMatching.ts` → `Page[]` ordered outer → inner. At most one template per breadth level (highest priority wins, document order breaks ties). Two breadth levels today: `everywhere` (outermost) → `postTypes` (innermost).
- **404 resolver:** `resolveNotFoundTemplate(site)` → the highest-priority `notFound` template or null. A `notFound` template never enters a route chain — the public router renders it directly when a GET falls through every route (see "The Not found (404) template" below).
- **Chain composer:** `composeTemplateChain(chain, terminal)` in `src/core/templates/templateCompose.ts` → one merged `Page` ready for `publishPage`.
- **`base.outlet`** is the polymorphic outlet content flows into. A template *should* contain one. Having NO outlet is not blocked (you add it after converting the page to a template — requiring it first would be circular). The editor enforces a one-outlet-per-document invariant at the store's mutation chokepoints (`insertNode`, `duplicateNode(s)`, `pasteNode`), each surfacing a warning toast when blocked; the module pickers additionally render the outlet as a disabled tile with the reason (non-template page, VC mode, or outlet already placed) so authors rarely hit the block at all. The composer remains defensive for data pre-dating the guard: no outlet → template skipped; multiple → first wins.
- Template pages are never served at their own slug; the live router and the static bake both skip them.
- Dynamic bindings and token interpolation work exactly as before — the merged tree is a plain page tree.
- **`templateTargetLabel(page)`** returns a short human-readable string for a template's target (e.g. `"Everywhere"` or `"posts, news"`); import from `@core/templates`.

---

## Where the code lives

```text
src/core/page-tree/pageTemplate.ts     — TemplateTarget, PageTemplateConfig, parsePageTemplate
src/core/templates/
├── templateMatching.ts                — resolveTemplateChain, resolveNotFoundTemplate, isTemplatePage, templateTargetLabel, RouteResolutionContext
├── templateCompose.ts                 — composeTemplateChain, TerminalContent
├── contextFrames.ts                   — PageFrame, SiteFrame, RouteFrame + builders
├── dynamicBindings.ts                 — TemplateRenderDataContext + resolveDynamicProps
├── templatePreviewData.ts             — buildPreviewCells, dataTablePreviewToLoopItem
└── tokenInterpolation.ts             — parseTokenString, interpolateTokens, walkFieldPath

src/modules/base/outlet/               — base.outlet module (Content Outlet)
server/publish/templateSeeding.ts  — seed + backfill for default entry templates
server/publish/publicRouter.ts         — isTemplatePage guard on direct slug routing
server/publish/publicRenderer.ts       — chain-aware render paths
```

---

## Template schema

```ts
// src/core/page-tree/pageTemplate.ts
type TemplateTarget =
  | { kind: 'everywhere' }
  | { kind: 'postTypes'; tableSlugs: string[] }   // ≥1 slug
  | { kind: 'notFound' }                          // the public 404 page

interface PageTemplateConfig {
  enabled: true
  target: TemplateTarget
  priority: number   // higher = preferred when multiple match the same breadth level
}
```

A `Page` carries `template?: PageTemplateConfig`. When `template.enabled === true` the page is a template; `isTemplatePage(page)` is the single predicate used everywhere.

`parsePageTemplate(raw)` is the tolerant boundary parser — the single validator; row⇄page adapters delegate to it. A stray `conditions` key in stored data is silently ignored (conditions were cut from the model; there is no `conditions` field).

### Storage columns

In the `data_rows` table the `pages` system table stores template config in three columns:

| Column            | Type    | Description                                           |
|-------------------|---------|-------------------------------------------------------|
| `templateEnabled` | boolean | `true` when this page is a template                   |
| `templateTarget`  | JSON    | Serialized `TemplateTarget` — `{ kind, tableSlugs? }` |
| `templatePriority`| number  | Higher wins when multiple templates match one level   |

`templateTarget` is a single JSON column that replaced three earlier separate fields (`templateContext`, `templateTableSlug`, `templateConditions`). The row⇄page adapter parses it through `parsePageTemplate`.

---

## Chain resolution

`resolveTemplateChain(site, ctx)` walks the two breadth levels (outer → inner) and picks the highest-priority matching template at each level:

```ts
type RouteResolutionContext =
  | { kind: 'page' }
  | { kind: 'entry'; tableSlug: string }
```

| Route kind | Breadth 0 (everywhere) | Breadth 1 (postTypes) |
|------------|------------------------|------------------------|
| `page`     | matched if exists      | never matched          |
| `entry`    | matched if exists      | matched if `tableSlugs.includes(tableSlug)` |

Within a level, the template with the highest `priority` wins; document order breaks ties.

**Adding a new breadth level** (e.g. path-prefix sections) means inserting a new entry into the `LEVELS` constant in `templateMatching.ts` — the resolver loop is level-agnostic.

---

## Chain composition

`composeTemplateChain(chain, terminal)` merges the ordered template list + a terminal into one `Page`:

```ts
type TerminalContent =
  | { kind: 'page'; page: Page }   // inject a normal page's content into the chain
  | { kind: 'entry' }              // leave the innermost base.outlet to render currentEntry.body
```

Splice rule (applied from innermost outward):
- Templates with **no `base.outlet`** are filtered out of the chain first — an unfinished template can't host content, so it simply doesn't apply (never an error). If that leaves the chain empty, a page renders as-is and an entry renders its innermost matched template as chrome only.
- Each remaining template's **first `base.outlet` node** is the splice point; any extra outlets are left in place and render empty.
- The inner content is spliced at the outlet position. Inner node ids are re-keyed with a prefix so merged trees never have collisions.
- **Inner `base.body` drop:** the inner tree's `base.body` wrapper is removed on splice — the outermost template owns the document `<body>`. If the inner `base.body` carries non-empty `props` or `breakpointOverrides`, its children are wrapped in a `base.container` bearing those values so body-level styling is not lost.

Result: one merged `Page` consumed by `publishPage` unchanged — one CSS bundle pass, one media prefetch, one HTML emit.

---

## base.outlet

`base.outlet` is the single, polymorphic outlet module:

- **Tag:** the outlet renders as an author-chosen semantic element (`tag` / `customTag` props, default `<main>`), sharing `htmlTagControl` / `customHtmlTagControl` with `base.container` / `base.loop`. The Properties panel exposes the tag dropdown.
- **Render:** emits `<{tag} data-instatic-content-region>{props.html}</{tag}>`. When `props.html` is empty, the empty element is the live-edit anchor for the Content workspace.
- **Binding (entry route):** the seed attaches `dynamicBindings: { html: { source: 'currentEntry', field: 'body', format: 'html' } }` to the outlet node so the entry's body flows in at render time. The `html` prop is a binding target ONLY — it carries no panel control (you never hand-edit it). This keeps the Content workspace's Tiptap mount working via the `data-instatic-content-region` marker.
- **Splice (page route):** `composeTemplateChain` removes the `base.outlet` node and inserts the page's content in its place before `publishPage` is called. No outlet node reaches the renderer on page routes.
- **Canvas preview:** `OutletEditor` renders the matched content READ-ONLY so the author sees what flows in — the first non-template page (`everywhere` target) via `ReadOnlyNodeTree`, or the entry body (`postTypes` target, resolved into `props.html`). It carries the editor wrapper bag so the outlet has a proper selection overlay; an empty match falls back to the shared placeholder.

A template normally contains exactly one `base.outlet`. Having **no outlet** is not blocked — you set a page as a template first and add the outlet afterward (the outlet block is only meaningful on templates, so requiring it before save would be circular). A **second outlet** is prevented in two layers:

- **Picker availability (UX):** `moduleAvailability` (`src/admin/pages/site/module-picker/moduleInserterModel.ts`) renders the Content Outlet tile disabled — with the reason as tooltip/description — on non-template pages, in VC mode, and on templates that already hold an outlet. All picker surfaces (inserter dialog, context-menu `ModulePicker`, notch favorites) share this via `useModuleInsertionContext`.
- **Store invariant (structural):** every mutation path that could mint a second outlet is guarded at the store chokepoint and surfaces a warning toast when blocked — `insertNode`, `duplicateNode` / `duplicateNodes` (a duplicated subtree carrying the outlet is refused/skipped), and `pasteNode` (a copied payload containing an outlet won't paste into a document that already has one). All in `nodeActions.ts` / `clipboardSlice.ts`, backed by the shared `treeHasOutlet` / `subtreeHasOutlet` helpers in `@core/templates`.

The composer remains defensive for data that pre-dates or bypasses the guard: no outlet → the template is skipped; multiple → the first wins.

---

## Routing — templates are not directly accessible

Template pages are never served at their own slug:

- **Live router** (`server/publish/publicRouter.ts`): after fetching `pageSnapshot` by slug, skips the page if `isTemplatePage(page)` and falls through to the row/redirect/not-found path.
- **Static bake** (`server/publish/publishSite.ts`): the `publishDraftSiteLocked` bake loop skips any page where `isTemplatePage(page)` so no `/<template-slug>.html` artefact is written.

---

## Render paths

```text
public GET /<slug>  →  resolvePublicRoute
                            │
                    (page route) pageSnapshot
                            │
                    resolveTemplateChain(site, { kind: 'page' })
                    composeTemplateChain(chain, { kind: 'page', page })
                    publishPage(merged, …)

public GET /<routeBase>/<rowSlug>  →  resolvePublicRoute
                            │
                    (entry route) dataRow + tableSlug
                            │
                    resolveTemplateChain(site, { kind: 'entry', tableSlug })
                    composeTemplateChain(chain, { kind: 'entry' })
                    publishPage(merged, …, templateContext: { entryStack: [row] })
```

Render paths: `server/publish/publicRenderer.ts` — `renderPublishedSnapshot` (page route), `renderPublishedDataRowTemplate` (entry route), `renderPublishedNotFound` (fall-through 404).

### Chain for each route kind (v1)

| Route | Chain (outer→inner) | Terminal |
|-------|--------------------|----|
| `/about` (page)          | `[everywhere-layout?]`                           | the `/about` page tree |
| `/posts/hello` (entry)   | `[everywhere-layout?, posts-entry-template]`     | `{ kind: 'entry' }` — outlet renders the row body |
| any unmatched GET (404)  | `[everywhere-layout?]`                           | the `notFound` template's tree |

If no `everywhere` layout exists, a plain page renders exactly as a page with no templates. If no postTypes template exists for a route, the entry URL 404s.

### Static re-bake on template edit

A full `publishDraftSite` re-bakes every non-template page through `renderPublishedSnapshot`, which runs the chain each time — so editing an `everywhere` layout and publishing re-bakes all page artefacts automatically. Entry-detail artefacts (`/posts/hello.html`) are written incrementally by `publishDataRow` (chain-aware since v1) and wiped on the next full slot swap.

---

## The Not found (404) template

A page with `target: { kind: 'notFound' }` is the site's designed 404 page. It is not a wrapper — it carries real content (no `base.outlet` needed) and is itself wrapped by the `everywhere` layout, exactly like a regular page.

- **Resolution:** `resolveNotFoundTemplate(site)` (in `templateMatching.ts`) — highest `priority` wins, document order breaks ties. It never appears in `resolveTemplateChain` output; route matching never "matches" a 404.
- **Serving:** the dispatcher's last route (`tryServeNotFoundPage` in `server/router.ts`) catches every GET no earlier route claimed and calls `renderNotFoundResponse` (`publicRouter.ts`): baked `404.html` artefact first (one disk read, no DB — what bot probes hit), else a live render through the Layer B LRU under the reserved `/404` key. Always **status 404**. Namespaced prefixes (`/admin/api/*`, `/_instatic/*`, `/uploads/*`) emit their own 404s and never reach it. No notFound template → the dispatcher's bare JSON 404, as before.
- **Bake:** `publishDraftSite` renders the template through `renderPublishedNotFound` and writes `404.html` into the slot — deliberately the static-hosting convention, so a raw static export of the slot keeps a working error page on Netlify / GitHub Pages.
- **`/404` direct hit:** serves the baked artefact with status 200 (same convention as static hosts). The template's own slug stays non-routable like every template.
- **Editor:** Template settings → Applies to → "Not found (404)". No preview-source dropdown (there is no entry to preview); the toolbar's **Open live page** button resolves to `/404`.

---

## Context frames and dynamic bindings

Context frames are unchanged from before templates were added — the merged tree is still a plain page tree that resolves the same binding sources:

```ts
interface TemplateRenderDataContext {
  page?:        PageFrame       // page id, slug, title, templateTableSlug
  site?:        SiteFrame       // site name, settings, breakpoints
  route?:       RouteFrame      // URL parts
  entryStack:   LoopItem[]      // pushed by loops + entry route render
}
```

`resolveDynamicProps(node.props, node.dynamicBindings, ctx)` runs on every node in the merged tree. Template authors bind to `currentEntry.<field>` (top of `entryStack`) just as before.

See the "Dynamic bindings" section below for the full source table.

### Available binding sources

| Source         | Frame                     | Use case                                                |
|----------------|---------------------------|---------------------------------------------------------|
| `currentEntry` | Top of `entryStack`       | Inside loops, inside entry templates                    |
| `parentEntry`  | Second-from-top           | Nested loops                                            |
| `site`         | `ctx.site`                | Anywhere — site name, primary color                     |
| `route`        | `ctx.route`               | URL-driven (route.segments, route.slug)                 |
| `page`         | `ctx.page`                | Current page metadata                                   |

---

## Token interpolation

Text props mix literal text + tokens:

```text
"Hello {currentEntry.title} — read more at {site.name}"
```

`parseTokenString(input)` returns `TokenSegmentNode[]`; `interpolateTokens(input, ctx)` evaluates and concatenates. Tokens that resolve to `undefined` render as the empty string.

Source: `src/core/templates/tokenInterpolation.ts`.

---

## Editor canvas preview

When editing a template page, the canvas previews against **live data**, falling back to synthetic sample data only when none exists. `useTemplatePreviewContext` in `src/admin/pages/site/hooks/useTemplatePreviewContext.ts` builds the `currentEntry`:

- **`postTypes` target:** fetches a window of published rows for `target.tableSlugs[0]` via `previewCmsDataLoopItems` and seeds the entry stack with the first one (or the author-picked one — see below). When the table has **no** published rows, it falls back to a synthetic sample row via `dataTablePreviewToLoopItem(table)` so the layout stays visible.
- **`everywhere` target:** no current entry — the outlet previews the first non-template page's tree read-only via `ReadOnlyNodeTree` (or the author-picked page).

Synthetic fallback values are generic placeholders: `'Example Post Title'` for the `title` field, `null` for `media` fields. Modules must handle `null` media gracefully — the canvas shows "No image selected" for an unbound or null image source.

#### Floating controls — `TemplateModeControl` / `VisualComponentModeControl`

While editing a template (or a Visual Component), a borderless floating control mounts in the `CanvasNotch` `floatingControl` slot. Both controls share a **`DocumentSwitcher`** (`src/admin/pages/site/canvas/DocumentSwitcher.tsx`) — a compact, searchable dropdown grouped **Pages / Templates / Components** that jumps the canvas to any other document (`openPageInCanvas` for pages/templates, `setActiveDocument` for components). The current document shows as the trigger value (via the Select's `placeholder`) and is excluded from the list. Renaming lives in the Site panel — the switcher replaces the old inline rename. The VC control additionally keeps a "Back to page" exit.

Grouped menus rely on a small `Select` primitive capability: an `<optgroup label>` renders its label as a non-interactive header row (`isSelectableOption` skips headers in keyboard nav + selection; an active search query flattens to matches with headers dropped).

`TemplateModeControl` also shows a **Previewing** dropdown:

- `everywhere` → lists the non-template pages; the chosen page fills the outlet preview.
- `postTypes` → lists the table's published posts; the chosen post drives `currentEntry`.

The preview selection lives in `templatePreviewSelection` (UI slice, `templateId → sourceId`). It is **session-only** — a pure preview convenience that never dirties or persists to the site document. Unset → the first real page / published row is previewed. Both `OutletEditor` (everywhere) and `useTemplatePreviewContext` (postTypes) read it.

`useActiveLivePath` (`src/admin/pages/site/hooks/useActiveLivePath.ts`) also reads `templatePreviewSelection` to determine the target for the toolbar's **Open live page** button. Template pages have no routable slug of their own (the live router and bake loop both skip them), so opening the template slug directly would 404. Instead the hook resolves to the same source the preview dropdown shows: the previewed page's public path for `everywhere` templates, or the previewed row's permalink for `postTypes` templates. A `notFound` template resolves to `/404` (its baked artefact's path). The fallback is the first real page / first published row, matching the preview dropdown's own default.

### Edit-in-context composition

The design canvas renders the active document the way it publishes: **inside its matching template chain**. `CanvasComposedTree` (`src/admin/pages/site/canvas/CanvasComposedTree.tsx`) is the single render entry used by both `BreakpointFrame` and `CanvasLiveSurface`:

- `resolveEditorWrapperTemplates(site, activeDoc)` (`canvasComposition.ts`) returns the templates that WRAP the active document, outermost-first — the editor-side mirror of `resolveTemplateChain`. Editing a page, a `postTypes` template, or a `notFound` template ⇒ wrapped by the `everywhere` layout; editing the `everywhere` layout ⇒ nothing wraps it.
- Wrappers render **read-only** via `ReadOnlyNodeTree` with the editable document spliced into the innermost wrapper's `base.outlet` (the `outletSlot` prop replaces the outlet node, mirroring `spliceIntoOutlet`). Only the active document's nodes keep `data-node-id` + handlers, so selection / hover / DnD stay scoped to it; the chrome is pixel-identical but non-interactive.
- Body ownership mirrors the publisher: the iframe `<body>` carries the OUTERMOST wrapper body's classes, and the active document renders as its body *children* (its own `base.body` is dropped, just as the composer drops the inner body).
- `ReadOnlyNodeTree` (`src/modules/base/utils/ReadOnlyNodeTree.tsx`) is the shared non-interactive tree renderer — also used by `VCInlineTree` for inlined Visual Component bodies. It mirrors the publisher's per-node output: `classIds` resolve to class names AND `inlineStyles` are applied as the element's `style` (via `bagToReactStyle` from `@core/publisher`, the same sanitisation gate as the published `style="…"` attribute) — so composed content (template chrome, outlet previews, VC bodies) renders with the same inline styles as the editable canvas and the published page.
- **Navigation guard:** the canvas iframe is an editing surface, never a browsing surface. `IframeFrameSurface` installs a capture-phase `click`/`auxclick`/`submit` listener on the iframe document that `preventDefault`s link navigation and form submission (without `stopPropagation`, so node selection still works) — so clicking a logo/link in the read-only template chrome, an inlined component, or any authored content never reloads the frame. Applies to both the design canvas and the live/preview frame.
- **Read-only affordance:** `ReadOnlyNodeTree` stamps `data-instatic-readonly-{label,kind,id}` on every read-only element (the source is named by `CanvasComposedTree`, `OutletEditor`, and `VCInlineTree`). `BreakpointFrame` shows a cursor-following `CursorTooltip` ("Part of X — double-click to edit") on hover, and `IframeFrameSurface` opens the source on double-click (`onReadonlyOpen` → `openPageInCanvas` / `setActiveDocument`). The read-only markers ride the optional fields on `NodeWrapperProps`.

### Dynamic binding picker

The Properties panel wraps every bindable control in `DynamicBindingControl` (`src/admin/pages/site/property-controls/DynamicBindingControl/`). Two interaction modes:

- **Insert mode** (text / string controls): clicking the `{}` affordance opens a picker popover. Clicking a field row inserts a `{source.field}` token into the text value at the caret. The popover **stays open** so authors can insert multiple tokens in one session without re-opening.
- **Bind mode** (image / media controls): clicking the affordance opens the picker. Clicking a field commits a structured entry to `node.dynamicBindings[propKey]` and the picker **closes immediately**.

Neither mode has a Confirm step — a single click is the action.

**Auto-scope:** when the active page is a `postTypes` template, the picker auto-scopes to the first targeted table. Field rows appear directly under a `"<TableName> fields"` group header with a chip labelled `"Current row — <TableName>"`. No source-selection step is shown.

**Unscoped state:** when the node is outside a loop or template context, table fields are not offered. A footer hint reads: *"Wrap in a Loop or open a postType template to bind to row fields."*

Loop nodes supply `availableFields` / `sourceLabel` props to show loop-specific synthetic fields in a `"<SourceLabel> fields"` group in the same single-pane layout.

DataMeta is fetched once from `/data/_meta` and cached module-level in `cache.ts`; import `clearDataMetaCache()` in tests to reset between cases.

---

## Template management in the editor

The **Site Explorer** panel (`src/admin/pages/site/panels/SiteExplorerPanel/`) shows **Pages** and **Templates** in separate labelled sections. Clicking a template row opens it in the canvas like a page; the canvas preview uses the synthetic entry from `useTemplatePreviewContext`.

### Converting a page to a template

Right-click a page row → **Use as template** → the **Template settings** dialog opens:

| Field | Description |
|---|---|
| Applies to | `Everywhere` (outer layout for all pages and entries), `Post types` (entry template for ≥1 post-type tables), or `Not found (404)` (the public 404 page) |
| Post types | Checkbox list of all post-type tables — visible when "Post types" is selected |
| Priority | Higher number wins when multiple templates match the same breadth level |

The dialog has no outlet requirement — save is never gated on outlet count. Add `base.outlet` after the page is already a template (the outlet block is only meaningful on templates; requiring it before save would be circular). See [base.outlet](#baseoutlet) for how the composer handles templates with missing or multiple outlets.

Store action: `convertPageToTemplate(pageId, { target, priority })` in `siteSlice`.

### Converting a template back to a page

Right-click a template row → **Convert to page**. This:

1. Clears `page.template` (removes the template config entirely).
2. Strips `dynamicBindings` from every node in the page tree (bindings are meaningless without a template context).

Store action: `convertTemplateToPage(pageId)` in `siteSlice`.

---

## Seeding — default entry templates

When a postType `data_table` is created, `ensureDefaultEntryTemplate(db, table)` in `server/publish/templateSeeding.ts` inserts a default template page (idempotent — it no-ops if one already targets the table):

- `templateEnabled: true`, `templateTarget: { kind: 'postTypes', tableSlugs: [table.slug] }`, `templatePriority: 0`
- Page tree: `base.body` > `base.text` (`<h1>` bound to `currentEntry.title` via token interpolation) + `base.outlet` (bound to `currentEntry.body` via `html` format)

`backfillDefaultEntryTemplates(db)` at boot covers postType tables created before the template system was added.

---

## Cookbook

### Add a site-wide layout (everywhere template)

1. Create a new page. Set it as a template ("Template settings…" in the page menu).
2. Choose target: **Everywhere**.
3. Build the layout — a header block, a `base.outlet` (Content Outlet from the block list), a footer block.
4. Publish. Every page and post now renders inside this layout.

### Add an entry template for a postType

When a postType is created, the system seeds a default entry template automatically. To customize:

1. Open the template page in the visual editor.
2. Edit it like any page — bind nodes to `currentEntry.<field>` via the Properties panel.
3. Add `base.outlet` anywhere you want the post body to flow.
4. Publish.

### Share a layout across post types

In the Template settings dialog, set **Applies to** to "Post types" and check multiple post-type tables. A single template can list several `tableSlugs`: `{ kind: 'postTypes', tableSlugs: ['posts', 'news'] }`.

### Add a 404 page (notFound template)

1. Create a new page and design the "not found" content — no `base.outlet` needed.
2. Set it as a template ("Template settings…"), choose target: **Not found (404)**.
3. Publish. Every URL that matches nothing now serves this page (wrapped in the everywhere layout) with HTTP status 404, straight from the baked `404.html` artefact.

### Build a template with the AI agent

The site-scope AI agent can author templates end-to-end:

1. Build the chrome on a page with `insertHtml`, including one `<instatic-outlet>` element where the wrapped content should appear (the importer maps it to a `base.outlet` node).
2. Call `setPageTemplate(pageId, target, priority?)` — `target` is `{ kind: 'everywhere' }` or `{ kind: 'postTypes', tableSlugs: [...] }`. For a postTypes target, the agent reads valid slugs from `list_post_types` first.
3. `clearPageTemplate(pageId)` reverts a template to an ordinary page. `list_pages` reports each page's current `template` config.

No outlet save-guard applies here either — an agent-built template with no outlet simply doesn't apply. See [agent.md → Templates](agent.md) for the tool surface.

### Custom token in text

```ts
// In an editor property control:
node.props.text = 'Posted by {currentEntry.author.displayName} on {currentEntry.publishedAt}'
```

`interpolateTokens(props.text, ctx)` runs at publish time. Paths that resolve to `undefined` render as the empty string.

---

## Forbidden patterns

| Pattern | Use instead |
|---------|------------|
| Reading `currentEntry` from a module's `render` without bindings | Set `dynamicBindings` on the node — keeps the schema honest |
| Hardcoding a template's slug in server handlers | Use `resolveTemplateChain(site, ctx)` |
| Creating a template page via raw `INSERT INTO pages` | Use `ensureDefaultEntryTemplate(...)` or the admin dialog |
| Walking a deep binding path with `JSON.parse(JSON.stringify(...))` | Use `walkFieldPath(frame, 'a.b.c')` |
| Expecting to visit a template page at its own slug | Template pages are never directly routable — the live router and bake loop both skip them |
| Inlining `page.template?.target.kind === 'everywhere' ? … : …` in UI code | Use `templateTargetLabel(page)` from `@core/templates` |
| Adding a save-time guard that blocks a template without an outlet | Don't — it's circular (you add the outlet after the page becomes a template). The composer degrades gracefully for zero-outlet templates. Duplicate-outlet insertion IS blocked by the editor insert guard and store backstop. |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/features/content-storage.md](content-storage.md) — `data_tables.routeBase` + `data_rows.slug`
- [docs/features/publisher.md](publisher.md) — walker runs on the merged tree
- [docs/features/loops.md](loops.md) — loops push items onto the same entry stack
- [docs/reference/page-tree.md](../reference/page-tree.md) — `PageNode.dynamicBindings`
- Source-of-truth files:
  - `src/core/page-tree/pageTemplate.ts` — `TemplateTarget`, `PageTemplateConfig`, `parsePageTemplate`
  - `src/core/templates/templateMatching.ts` — `resolveTemplateChain`, `isTemplatePage`, `templateTargetLabel`
  - `src/core/templates/templateCompose.ts` — `composeTemplateChain`
  - `src/core/templates/contextFrames.ts` — frame shapes + builders
  - `src/core/templates/dynamicBindings.ts` — `TemplateRenderDataContext`, `resolveDynamicProps`
  - `src/core/templates/tokenInterpolation.ts` — `parseTokenString`, `interpolateTokens`
  - `src/modules/base/outlet/index.ts` — `base.outlet` module
  - `src/admin/pages/site/property-controls/DynamicBindingControl/` — binding affordance + picker popover
  - `src/admin/pages/site/hooks/useTemplatePreviewContext.ts` — synthetic preview context for the canvas
  - `src/admin/pages/site/hooks/useActiveLivePath.ts` — resolves the toolbar "Open live page" path for templates
  - `src/core/templates/templatePreviewData.ts` — `buildPreviewCells`, `dataTablePreviewToLoopItem`
  - `server/publish/templateSeeding.ts` — default-template seeding
  - `server/publish/publicRenderer.ts` — chain-aware render paths
  - `src/admin/pages/site/hooks/useInsertModule.ts` — hook-level outlet guard (toast + null return)
  - `src/admin/pages/site/store/slices/site/nodeActions.ts` — store-level outlet backstop in `insertNode`
- Integration tests:
  - `src/__tests__/templates/templateModel.test.ts` — template metadata round-trip; `convertTemplateToPage` strips template config and all bindings; `setNodeDynamicBinding`/`clearNodeDynamicBinding` modify bindings without touching static prop fallbacks
