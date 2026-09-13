# Loops

The `base.loop` module — iterates a **loop entity source** and renders its child variants per item. Powers post listings, product grids, related-articles sections, media galleries, anything that displays a collection.

Loop sources are pluggable: built-in sources (`data.rows`, `site.pages`, `site.media`) cover the universal store; plugins can register more via the SDK.

---

## TL;DR

- Loop source registry: `loopSourceRegistry` in `src/core/loops/registry.ts`. First-party sources self-register from `src/core/loops/sources/index.ts` at boot.
- `LoopEntitySource` shape: `{ id, label, fields, filterSchema?, orderByOptions?, fetch, preview? }` in `src/core/loops/types.ts`.
- `entry.field` is the contextual exception: it resolves an array on the closest `currentEntry` separately for every outer iteration, so a Project's multi-media `gallery` field can drive an inner loop.
- The `base.loop` module's children are **variants** — different per-item layouts (e.g. "Card", "Featured"). The walker round-robins across them as it iterates.
- At publish time, `loopPrefetch.ts` calls each loop's `fetch()` and stores results on the render context. The walker is then purely synchronous.
- Each iteration renders against a fresh `entryStack` snapshot (`[...baseStack, item]`) carried in a child `RenderConfig`; nodes inside the loop resolve `currentEntry.<field>` against that item via dynamic bindings. The stack is never mutated in place.

---

## Where the code lives

```text
src/core/loops/
├── index.ts                 — public barrel: types + pageToLoopItem + filterPagesForLoop
├── types.ts                 — LoopItem, LoopEntitySource, LoopSourceField, LoopFetchResult, ...
├── registry.ts              — LoopSourceRegistry singleton (`loopSourceRegistry`)
└── sources/
    ├── index.ts             — register the three built-ins at boot
    ├── dataRows.ts          — data.rows (any data_table)
    ├── entryField.ts        — entry.field (array field on currentEntry)
    ├── sitePages.ts         — site.pages (+ shared helpers re-exported via barrel)
    └── siteMedia.ts         — site.media

src/modules/base/loop/        — the base.loop module definition

src/core/publisher/renderLoop.ts  — render-time walker (round-robin variants)
server/publish/loopPrefetch.ts    — server-side pre-fetch before render
```

---

## The `LoopEntitySource` shape

```ts
interface LoopEntitySource {
  /** Namespaced id — 'data.rows', 'site.pages', 'site.media', 'acme.products' */
  id:           string
  label:        string
  description?: string

  /** Field metadata — what's available to dynamic bindings inside the loop. */
  fields:       LoopSourceField[]

  /** PropertySchema of filter controls shown in the Properties panel. */
  filterSchema: PropertySchema

  /** Allowed `orderBy` values; first entry is the default. Each uses `id`, not `value`. */
  orderByOptions: { id: string; label: string }[]

  /** Server-side fetch — runs at publish time (and live at editor render time). */
  fetch(ctx: SourceFetchContext): Promise<LoopFetchResult>

  /** Editor canvas preview — returns synthesized items (no DB access). */
  preview(ctx: SourcePreviewContext): LoopItem[]

  /**
   * Default `false`. Set `true` when the source returns data that varies per
   * request (live API, time-of-day data). Loops using a request-dependent source
   * become Layer C "holes" — the publisher emits a placeholder + a ~1.1 KB client
   * runtime fetches the rendered fragment lazily via
   * `/_instatic/hole/<nodeId>?v=<publishVersion>&u=<page-url>`.
   *
   * A `requestDependent` (non-perVisitor) hole is rendered at request time and
   * cached by Layer B per `(nodeId, query, publishVersion)`.
   *
   * Built-in sources (`data.rows`, `site.pages`, `site.media`) are
   * publish-time-deterministic — leave this unset. Plugin sources that hit
   * live external APIs should set it.
   */
  requestDependent?: boolean

  /**
   * Default `false`. Implies `requestDependent`. Output varies per individual
   * visitor (cookies, randomization). Bypasses the Layer B cache; `fetch()`
   * runs on every page load. Use sparingly.
   */
  perVisitor?: boolean
}

interface LoopSourceField {
  id:      string            // 'title', 'slug', 'featuredMedia', ...
  label:   string
  format?: 'plain' | 'html' | 'url' | 'media'
}

interface LoopItem {
  id:     string             // unique within the loop result
  fields: Record<string, unknown>
}

interface LoopFetchResult {
  items:      LoopItem[]
  totalItems: number         // total across all pages — used for hasMore + paginators
}
```

Sources are **stateless** — they receive everything they need via the `ctx` argument. The publisher and editor can call `fetch` independently.

---

## Built-in sources

### `data.rows`

Iterates rows in any `data_table`. The user picks the table in the Properties panel, and optionally one condition on a row's own cell — the difference between "the newest three" and "the three marked featured".

**Filtering by a cell.** Three `filters` keys carry the condition: `cellField` (a field id from the selected table), `cellOperator`, and `cellValue`. The operator set is closed — `is`, `isNot`, `isTrue`, `isFalse`, `isSet`, `isEmpty` — and `parseCellFilter` in `src/core/loops/cellFilter.ts` returns `null` for anything absent or half-configured, so a loop mid-edit keeps listing everything rather than silently emptying.

**Sorting by a cell.** `orderBy` also accepts `cell:<fieldId>`, read by `parseCellOrder`. Riding on `orderBy` rather than a separate prop means every caller that already threads it — the publisher, the canvas preview endpoint, imported `data-order-by` attributes — supports cell sorting without further plumbing. Values compare as text in both dialects: ISO dates sort chronologically, numbers sort lexicographically (`'10' < '9'`).

Both read `cells_json`, the one place the two dialects genuinely differ (`#>> array[$n]` on Postgres, `json_extract` on SQLite). **The field name binds as a parameter, never as SQL text.** `cellFilterSql` and `cellOrderSql` own that switch; `loop-source-sql-safety.test.ts` scans the whole `src/core/loops/` tree for Postgres-isms.

Only fields a single condition can address are offered in either picker — `isCellComparableField` excludes `multiSelect`, `media`, `repeater`, `pageTree`, `fieldSchema`, and multi-value `relation` fields, whose cells hold collections that read back as JSON array text and could never equal one picked value. Changing the loop's table clears the cell filter and any `cell:` order, since those field ids name columns the new table does not have.

```ts
fetch({ db, filter, orderBy, limit }) {
  const rows = await listDataRows(db, filter.tableId, { ... })
  return { items: rows.map(rowToLoopItem), total: rows.length }
}
```

This covers blog posts, products, anything in the universal store.

### `site.pages`

Iterates pages in the site. Filters by template inclusion/exclusion.

Used by sitemaps, "All pages" indexes.

The source exports two helpers through the `@core/loops` barrel:

- **`pageToLoopItem(page)`** — projects a `Page` to a `LoopItem`. Normalizes the slug to a leading-slash permalink (`/index` → `/`). Exposes `title`, `slug`, `permalink`, `isTemplate`, and `templateTableSlug`.
- **`filterPagesForLoop(pages, filters)`** — applies `templateOnly` / `excludeTemplates` filtering.

Both the publisher (`SitePagesSource.fetch` / `.preview`) and the editor canvas hook (`useLoopPreviewItems`) import these from `@core/loops` — they never re-implement the logic. Parity is gated by `src/__tests__/loops/sitePagesLoopItemParity.test.ts`.

The author-facing `fields` list exposes only `title`, `slug`, and `permalink`. Internal fields (`id`, `isTemplate`, `templateTableSlug`) are present in `LoopItem.fields` for code paths that need them but are not offered in the binding picker.

### `site.media`

Iterates `media_assets`. Filters by MIME type prefix.

Used by galleries.

Its author-facing `fields` list exposes filename, path/URL/source URL, MIME type, and upload date. Internal uploader ids stay in `LoopItem.fields` for code that needs them, but they are not binding-picker rows.

### `entry.field`

Iterates an array-valued field on the closest enclosing entry. It is resolved
inside the synchronous render walk rather than prefetched once by loop node id,
because the value can differ for every outer iteration:

```text
Projects loop
  Project A → gallery [a1, a2] → inner loop renders a1, a2
  Project B → gallery [b1]     → inner loop renders b1
```

The Properties panel offers collection fields from the current entry table:
multi-media, multi-relation, and multi-select fields. Primitive items are
available as `currentEntry.value`; object-array members are exposed by key.
Media ids are resolved through the publisher's batched media prefetch and
provide `currentEntry.src`, `url`, `path`, `altText`, `mimeType`, `width`, and
`height`.

Contextual loops preserve authored order by default, can reverse/slice with
direction/offset/limit, and do not support infinite pagination. Infinite
fragments are independent requests and cannot recover an arbitrary outer
entry stack safely.

### Plugin-registered sources

A plugin with `loops.register` registers a custom source via the SDK at activation. The source runs inside the **QuickJS sandbox** — it can use `api.cms.storage.collection(...)` to fetch plugin-owned data or `fetch(...)` (with `network.outbound` permission) for external APIs.

See [docs/features/plugin-system.md](plugin-system.md) and the loop-sources section.

---

## Filters and ordering

Each source declares its filter and order options through `filterSchema` and `orderByOptions`. The editor's Properties panel renders the matching controls when a `base.loop` node is selected and its `sourceId` is set.

```ts
filterSchema: {
  status: {
    type: 'select',
    label: 'Status',
    options: [
      { value: 'published', label: 'Published' },
      { value: 'draft',     label: 'Draft' },
      { value: 'any',       label: 'Any' },
    ],
    defaultValue: 'published',
  },
  category: {
    type: 'select',
    label: 'Category',
    options: [/* populated dynamically — see below */],
  },
}
orderByOptions: [
  { value: 'publishedAt:desc', label: 'Newest first' },
  { value: 'publishedAt:asc',  label: 'Oldest first' },
  { value: 'title:asc',        label: 'Title A→Z' },
]
```

The `base.loop` node carries `props.filter: Record<string, unknown>` and `props.orderBy: string`. The publisher passes them to `fetch(ctx)` as `ctx.filter` and `ctx.orderBy`.

---

## Variants — the loop's children

A `base.loop` node has **N child nodes**, each a "variant". The walker round-robins across them:

```text
Loop with 2 variants ('A', 'B') and 5 items:
  Item 0  → variant A
  Item 1  → variant B
  Item 2  → variant A
  Item 3  → variant B
  Item 4  → variant A
```

Variants are useful for:

- **Featured + standard** — first item uses the "featured" variant, others use the "standard" variant.
- **Heading + items** — a heading variant that renders once between groups.
- **A/B layouts** — alternating layouts for visual variety.

A loop with one variant is the common case (every item uses the same layout).

---

## The render walk

```text
renderLoop(loopNode, config, acc, renderNode):
    │
    ├─→ prefetched = config.loopData.get(loopNode.id)
    │       (results already resolved by loopPrefetch.ts at publish time)
    │
    ├─→ variants = loopNode.children     ← N variant subtrees
    │   baseStack = config.templateContext.entryStack   ← immutable snapshot
    │
    ├─→ const out: string[] = []
    │   for each (item, index) of prefetched.items:
    │       variant = variants[index % variants.length]
    │       childConfig = { ...config, templateContext:
    │                       { ...config.templateContext, entryStack: [...baseStack, item] } }
    │       out.push(renderNode(variant, childConfig, acc))   ← fresh per-iteration snapshot
    │
    └─→ return out.join('')
```

Each iteration builds a **new** `entryStack` array (`[...baseStack, item]`) inside a fresh child config — there is no in-place push/pop on a shared array, so iterations are independent and a nested loop or VC ref in the body sees a stable per-item snapshot.

The `renderNode` callback is the publisher's normal walker — so a variant's subtree renders exactly like any other tree, including:

- `currentEntry.<field>` bindings resolve against the iteration's item (the top of the per-iteration stack).
- Nested loops can push a deeper item; the outer loop's item becomes `parentEntry`.
- VC refs inside variants render with their own slot fills, with `currentEntry` still pointing at the loop item.

See [docs/features/publisher.md](publisher.md) → "renderLoop" for the broader pipeline.

### The wrapper element

`renderLoop` emits one wrapper around the iterations, and the canvas
(`LoopEditor.tsx`) mirrors it attribute for attribute so user CSS targeting
`[data-instatic-loop] > article` matches in both places.

| Source | Attributes |
|---|---|
| Runtime | `data-instatic-loop`, `data-instatic-loop-page`, plus `data-instatic-loop-mode` / `-has-more` / `-page-size` in infinite mode |
| Author | `tag` / `customTag` choose the element; `htmlAttributes` adds arbitrary attributes, same control as `base.container` |
| Node | `classIds` → class names, `inlineStyles` → `style` |

The `htmlAttributes` bag is what lets a repeated list be *addressed*: `role="list"`
and `aria-label` for assistive technology, or a `data-*` hook for a carousel,
filter, or marquee script that has to find the collection wrapper. Values pass
through the shared sanitiser (`src/core/htmlAttributes/`), which reserves the
`data-instatic-*` and `data-canvas-*` prefixes — so the loop's own bookkeeping
cannot be redirected from the attributes panel.

---

## Prefetch

The walker is **purely synchronous**. Async data (prefetched loop sources and
media) is resolved up-front so the publisher doesn't have to `await` per node.
`entry.field` stays synchronous by deriving its items from the already-present
entry stack.

`server/publish/loopPrefetch.ts`:

```ts
// collectLoopNodes uses walkRenderTree (server/publish/renderTreeWalk.ts) so
// base.loop nodes inside Visual Component definition trees are included —
// a loop inside a VC body is fetched and rendered with real data.
async function prefetchLoops(page, site, db) {
  const loopNodes = collectLoopNodes(page, site)   // descends page tree + all VC trees
  const results = await Promise.all(
    loopNodes.map(async (node) => {
      const source = loopSourceRegistry.get(node.props.sourceId)
      const result = await source.fetch({ db, filter: node.props.filter, ... })
      return [node.id, result] as const
    })
  )
  return new Map(results)
}
```

The map is passed into `RenderConfig.loopData`. The walker reads from it; no async at render time.

The public renderer and the editor's full-page **Preview page** overlay both
use this server-side prefetch path. Preview sends the current in-memory draft
to `/admin/api/cms/runtime/preview`; the server resolves loop and media data
before calling `publishPage`. Calling the pure publisher without `loopData`
is intentionally not a preview fallback — the loop emits its missing-data
marker instead.

---

## Editor canvas preview

In the editor, `useLoopPreviewItems` (`src/admin/pages/site/canvas/useLoopPreviewItems.ts`) provides loop iteration data for the canvas. It dispatches per source:

| Source | Canvas path |
|---|---|
| `data.rows` | GETs `/data/tables/:id/loop-preview` — same projection as the publisher, and takes `cellField` / `cellOperator` / `cellValue` plus a `cell:<fieldId>` `orderBy` so the canvas shows the rows the published page will emit. On a site branch the preview reads the branch's draft rows (the branch has nothing published), mirroring `renderBranchPreview`. Falls back to synthetic items from the table's field definitions when no rows exist yet. |
| `site.pages` | Reads pages from the in-memory site document via `selectSitePagesLoopItems`. Applies `filterPagesForLoop` + `pageToLoopItem` imported from `@core/loops` — identical to the publisher path. |
| `site.media` | Fetches via `listCmsMediaAssets()`, filters by MIME prefix, sorts + slices client-side. |
| Plugin sources | Calls `source.preview(ctx)` synchronously. |

The canvas caps preview results at 6 items (`CANVAS_MAX_ITEMS`) regardless of the loop's configured `limit`. Published pages render the full set.

Subscription granularity: the hook never subscribes to the whole `site` document for built-in sources. `site.pages` loops subscribe through `selectSitePagesLoopItems`, which keeps the items array (and each `LoopItem`) referentially stable across site mutations that don't change the loop's actual items — so typing in an unrelated text node doesn't re-render loop body subtrees. Only the plugin-source fallback subscribes to `site` (its `preview()` contractually receives the full document), and only while such a source is selected. Stability is gated by `src/__tests__/loops/loopPreviewItemStability.test.ts`.

---

## Cookbook

### Use the built-in `data.rows` source

1. Insert a `base.loop` node into the page.
2. In the Properties panel, set `sourceId = 'data.rows'`, pick the `data_table` (e.g. "Posts").
3. Optionally set a condition — *Filter by* a field, then *Condition* (and *Value* where the operator needs one).
4. Set order — one of the row's built-in columns, or `Field: <name>` to sort by a cell.
5. Configure variants:
   - Drop a `base.container` as the loop's first child — this is variant A.
   - Add nodes inside: a heading bound to `currentEntry.title`, content bound to `currentEntry.body`, an image bound to `currentEntry.featuredMedia`.
6. Publish. Each iteration renders the variant with the item's fields substituted.

### Build a per-project media gallery

1. Add a Media field named `gallery` to the Projects post type and enable
   **Allow multiple**.
2. On the Project entry template, insert a Loop.
3. Set Source to **Current entry field** and Field to **Gallery**.
4. Add an Image as the loop's child template.
5. Bind the Image source to **Current entry field → Media source** and,
   optionally, its alt text to **Alt text**.
6. Publish the site and a Project entry. Each project route renders only that
   project's gallery items, in the field's authored order.

### Build a loop with the AI agent

The site-scope AI agent stays on the HTML-native edit surface. It calls `list_loop_sources` to get valid source ids, table ids, order options, and `{currentEntry.field}` tokens, then inserts an `<instatic-loop>` marker through `insertHtml` / `replaceNodeHtml`:

```html
<instatic-loop data-source-id="data.rows" data-table-id="tbl_posts" data-order-by="publishedAt" data-direction="desc" data-limit="3">
  <article>
    <a href="{currentEntry.permalink}">
      <img src="{currentEntry.featuredMedia}">
      <h3>{currentEntry.title}</h3>
    </a>
  </article>
</instatic-loop>
```

The HTML importer maps the marker to a real `base.loop` node, preserving classes and styles the same way it does for ordinary imported HTML. Token syntax is single-brace `{currentEntry.field}`; `{{post.title}}` and other alias-style tokens are not valid.

### Register a plugin loop source

```js
// plugin server/index.js
export function activate(api) {
  const products = api.cms.storage.collection('products')

  api.cms.loops.registerSource({
    id:    'acme.products',
    label: 'Acme products',
    fields: [
      { id: 'name',  label: 'Name',  format: 'plain' },
      { id: 'price', label: 'Price', format: 'plain' },
      { id: 'image', label: 'Image', format: 'media' },
    ],
    filterSchema: {
      category: {
        type:    'select',
        label:   'Category',
        options: [
          { value: '',           label: 'All' },
          { value: 'new',        label: 'New arrivals' },
          { value: 'clearance',  label: 'Clearance' },
        ],
      },
    },
    orderByOptions: [
      { id: 'createdAt:desc', label: 'Newest' },
      { id: 'price:asc',      label: 'Price low → high' },
    ],
    async fetch(ctx) {
      const { records } = await products.list({ limit: ctx.limit ?? 100 })
      const items = records
        .map((record) => ({ id: record.id, ...record.data }))
        .filter((p) => !ctx.filters?.category || p.category === ctx.filters.category)
        .sort(/* by ctx.orderBy */)
        .slice(0, ctx.limit)
        .map((p) => ({ id: p.id, fields: p }))
      return { items, totalItems: items.length }
    },
    preview(ctx) {
      return [
        { id: 'preview-1', fields: { name: 'Example product', price: 99 } },
      ]
    },
  })
}
```

Plugin config:

```ts
import { definePlugin, permissions } from '@instatic/plugin-sdk'

export default definePlugin({
  id: 'acme.catalog',
  name: 'Acme Catalog',
  version: '1.0.0',
  permissions: [permissions.cmsStorage, permissions.loopsRegister],
  resources: [
    {
      id: 'products',
      title: 'Products',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'price', label: 'Price', type: 'number' },
        { id: 'image', label: 'Image', type: 'text' },
        { id: 'category', label: 'Category', type: 'text' },
      ],
    },
  ],
})
```

### Add variants to a loop

Drop multiple children inside the `base.loop` node. The walker round-robins them. Use a small icon overlay or DOM-panel label to remember which variant is which.

### Two-source list (e.g. featured posts + recent posts)

Use **two `base.loop` nodes** side by side, one filtered by `featured: true` and the other by everything else. Loops can't merge results.

### Pagination

Two modes are available via the loop node's `pagination` prop:

**`pagination: 'none'` (default)** — renders up to `limit` items at publish time. No load-more affordance.

**`pagination: 'infinite'`** — renders the first `pageSize` items and appends a **"Load more"** button. Each click fetches the next page from `/_instatic/loop/<loopId>?page=N&pagePath=<path>` and appends the returned HTML before the button. When `hasMore` is false the button is removed automatically.

To enable infinite loading:
1. Set `props.pagination = 'infinite'` on the loop node.
2. Set `props.pageSize` (items per click; defaults to 10).
3. The publisher auto-injects `<script type="module" src="/_instatic/assets/loop-runtime.js">` when at least one infinite loop exists on the page (see `server/publish/loopRuntime.ts`). The runtime is < 2 KB and ships only when needed.

For static multi-page navigation (no JS required):
- Set `pagination: 'infinite'` and link the pages with the query parameter below — the server renders each page. See "Deep-link to a loop page".
- Use separate `base.loop` nodes with an `offset` filter — one per "page" — and static links between pages.

### Deep-link to a loop page

An infinite-mode loop also renders any page of its own results server-side, driven by a query parameter. `loopPageQueryKey` (`server/publish/loopPrefetch.ts:177`) builds the name as `loop_<loopNodeId>_page`, so every loop on a page paginates independently:

```text
/blog?loop_Oz1G1FKV5FyxdlFDNKeZP_page=2
```

`readPageNumber` (`server/publish/loopPrefetch.ts:204`) reads it 1-based. A missing, empty, non-numeric, or sub-1 value falls back to page 1 — there is no error and no 400. The slice is `props.offset + (pageNumber - 1) * props.pageSize` (`loopPrefetch.ts:229-236`).

`publicRouter.ts:224-240` routes any request whose canonical query is non-empty past the Layer A disk artefact and into a live Layer B render, so the response is fully server-rendered and the result set differs with JavaScript disabled. `canonicalRenderQuery` (`loopPrefetch.ts:194`) keeps only `loop_<nodeId>_page` params, sorted, and discards the rest — `?utm_source=x` still collapses to `''` and hits the baked artefact.

Four constraints bound what this can express:

| Constraint | Behaviour |
|---|---|
| `pagination` must be `'infinite'` | `loopPrefetch.ts:229` consults the URL only in that mode. Under `'none'` the parameter is ignored silently and the loop always renders page 1. |
| Contextual sources are excluded | `entry.field` never resolves a page number (`loopPrefetch.ts:292-299`, `src/core/publisher/renderLoop.ts:155-159`). |
| Out-of-range pages render nothing | Zero items makes `renderLoop` return the empty string (`src/core/publisher/renderLoop.ts:78-80`) — no wrapper element, no attributes, no fallback text at the loop's position. |
| No total is exposed | The wrapper carries `data-instatic-loop-page` and `data-instatic-loop-has-more` (`renderLoop.ts:111-116`), and `/_instatic/loop/<loopId>` returns `{ html, hasMore, pageNumber }` (`server/handlers/cms/loop.ts:131`, `:169`). Neither carries an item or page count, so "Page 3 of 12" is not derivable. |

Link the pages with ordinary anchors, and bound the upper page number from the authored data rather than probing for it:

```html
<a href="?loop_Oz1G1FKV5FyxdlFDNKeZP_page=2">Next</a>
```

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| `await fetch(...)` inside the loop walker                            | Pre-fetch via `loopPrefetch.ts`                          |
| Plugin sources that hit the host DB directly                         | Use `api.cms.storage.*`                                  |
| Reaching across loop iterations (e.g. "the previous item")           | Items are independent. Use a server-side fetch + materialize the relation. |
| Per-iteration state (e.g. counter)                                   | Loop iterations are independent. The walker doesn't preserve state. |
| Rendering a loop without prefetched data                             | `RenderConfig.loopData` must be populated — otherwise the loop renders a marker comment. |
| Cycling variants by index `% items.length` instead of `% variants.length` | Round-robin is by variants. Read `node.children.length`. |
| Source ids without a namespace (just `products`)                     | Namespace by plugin (`acme.products`) — collisions otherwise |
| `?loop_<nodeId>_page=N` on a `pagination: 'none'` loop               | Silently ignored — the loop always renders page 1. Set `pagination: 'infinite'`. |

---

## Related

- [docs/architecture.md](../architecture.md) — universal `entryStack`
- [docs/features/publisher.md](publisher.md) — `renderLoop` is one of two specialized renderers
- [docs/features/templates.md](templates.md) — `currentEntry` resolves the same way for templates and loops
- [docs/features/content-storage.md](content-storage.md) — `data_tables` + `data_rows` is the source for `data.rows`
- [docs/features/plugin-system.md](plugin-system.md) — plugin loop sources
- Source-of-truth files:
  - `src/core/loops/index.ts` — public barrel (`pageToLoopItem`, `filterPagesForLoop`, types)
  - `src/core/loops/types.ts` — `LoopEntitySource`, `LoopItem`, `LoopFetchResult`
  - `src/core/loops/registry.ts` — registry singleton
  - `src/core/loops/sources/dataRows.ts`, `sitePages.ts`, `siteMedia.ts` — built-in sources
  - `src/modules/base/loop/` — the `base.loop` module
  - `src/core/publisher/renderLoop.ts` — render walker
  - `server/publish/loopPrefetch.ts` — pre-fetch
  - `server/publish/loopRuntime.ts`, `server/handlers/cms/loop.ts` — runtime asset + live-fetch endpoint
  - `server/publish/publicRouter.ts` — routes `loop_<nodeId>_page` requests past the static artefact
- Gate tests:
  - `src/__tests__/architecture/loop-source-id-format.test.ts`
  - `src/__tests__/architecture/loop-source-sql-safety.test.ts`
  - `src/__tests__/loops/sitePagesLoopItemParity.test.ts` — canvas preview ↔ publisher parity for `site.pages`
  - `src/__tests__/publisher/canonicalRenderQuery.test.ts` — which query params survive canonicalisation
  - `src/__tests__/architecture/static-artefact-served-before-render.test.ts` — Layer A fast-path eligibility
