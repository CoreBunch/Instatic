# Content Storage

The unified content store: every "row in a table" — blog posts, custom post types, product catalogs, form submissions, pages, Visual Components, arbitrary user-defined collections — lives in two tables: `data_tables` (the schema) and `data_rows` (the rows).

There are **no other content tables**. There is no `pages` table, no `page_versions` table, no `posts` table. Pages, posts, and components are all rows in `data_tables` + `data_rows`, distinguished only by the table's `kind`.

---

## TL;DR

- Two tables, four kinds. `data_tables.kind`: `postType | data | page | component`.
- Four system tables seeded at boot — `pages` (kind `page`), `posts` (kind `postType`), `components` (kind `component`), `layouts` (kind `layout`) — protected from rename / delete (but users can still add custom fields). `listDataTables` and `listDataTablesWithCounts` pin them at positions 0–3 in that order; custom tables follow sorted by `created_at`.
- Every row's cells live in `cells_json` keyed by field id. `slug` and `status` are denormalized columns for index / route lookup.
- Post-type rows have a workflow: `draft | published | unpublished | scheduled`, with a version history (`data_row_versions`) for the published copy.
- "Data" tables are simple key-value grids — no workflow, no built-in fields.
- Pages and components are stored the same way: a `pages` table with `pageTree`-typed `body` cells; a `components` table with `pageTree`-typed `tree` + `fieldSchema`-typed `params`.
- Source of truth: `src/core/data/schemas.ts`. Repos: `server/repositories/data/`. Handlers: `server/handlers/cms/data/`.

---

## The two tables

### `data_tables`

The schema for a collection. One row per collection.

| Column            | Type      | Notes                                                            |
|-------------------|-----------|------------------------------------------------------------------|
| `id`              | text PK   |                                                                  |
| `name`            | text      | Human-readable                                                   |
| `slug`            | text      | URL-safe (kebab-case)                                            |
| `kind`            | text      | `'postType' \| 'data' \| 'page' \| 'component'`                  |
| `singular_label`  | text      | "Post"                                                           |
| `plural_label`    | text      | "Posts"                                                          |
| `route_base`      | text      | Empty = not publicly routable. Post-types default to `/<slug>`. |
| `primary_field_id`| text      | Field id used as the row's display name in grids / pickers      |
| `fields_json`     | jsonb     | `DataField[]` — the schema                                       |
| `system`          | boolean   | `true` for seeded tables (`posts`, `pages`, `components`)        |
| `created_*`, `updated_*` | -  | Standard audit fields                                            |

### `data_rows`

One row per content row.

| Column                  | Type       | Notes                                                           |
|-------------------------|------------|-----------------------------------------------------------------|
| `id`                    | text PK    |                                                                 |
| `table_id`              | text FK    | → `data_tables.id`                                              |
| `cells_json`            | jsonb      | `Record<fieldId, cellValue>`                                    |
| `slug`                  | text       | Denormalized from `cells_json.slug` for fast route lookup       |
| `status`                | text       | `'draft' \| 'published' \| 'unpublished' \| 'scheduled'`        |
| `author_user_id`        | text FK    | The post's author (nullable)                                    |
| `created_by_user_id`    | text FK    | Who created the row                                             |
| `updated_by_user_id`    | text FK    |                                                                 |
| `published_by_user_id`  | text FK    |                                                                 |
| `created_at`            | timestamp  |                                                                 |
| `updated_at`            | timestamp  |                                                                 |
| `published_at`          | timestamp  | Nullable                                                        |
| `scheduled_publish_at`  | timestamp  | Set when `status = 'scheduled'`; tick by `publishScheduler.ts`  |
| `deleted_at`            | timestamp  | Non-null = soft-deleted                                         |

### `data_row_versions`

Snapshot of a published row at publish time. One row per version.

| Column          | Type   | Notes                                                  |
|-----------------|--------|--------------------------------------------------------|
| `id`            | text PK|                                                        |
| `row_id`        | text FK| → `data_rows.id`                                       |
| `version_number`| int    | Monotonic per row                                      |
| `cells_json`    | jsonb  | Snapshot at publish time                               |
| `created_at`    | timestamp |                                                     |
| `created_by_user_id` | text FK | Who published this version                       |

Used to render the **currently-published** page (vs. the in-progress draft on the row). The publish handler writes a new version on each `Publish`.

---

## Four kinds

| `kind`       | Authored in                       | Built-in fields | Workflow | Notes                                          |
|--------------|-----------------------------------|-----------------|----------|------------------------------------------------|
| `postType`   | Content workspace (`/admin/content`) | `title`, `slug`, `body` (text), `featuredMedia`, `seo` (structured `SeoMetadata`) | `draft / published / unpublished / scheduled` + versions | Built-in fields cannot be renamed or deleted, only enabled / disabled. |
| `data`       | Data workspace grid (`/admin/data`) | none           | none     | Pure user-defined fields. Like a database table.|
| `page`       | Site workspace (`/admin/site`)    | `title`, `slug`, `body` (pageTree) | same as `postType` | Each row is a CMS page. `body` cell holds the `NodeTree<PageNode>`. |
| `component`  | Site workspace, VC mode           | `name`, `tree` (pageTree), `params` (fieldSchema), `description` | none | Each row is a Visual Component. See [docs/features/visual-components.md](visual-components.md). |

System tables protect their `kind`:

- `posts` is `system: true, kind: 'postType'` — cannot become a `data` table.
- `pages` is `system: true, kind: 'page'` — cannot be renamed or deleted.
- `components` is `system: true, kind: 'component'` — cannot be renamed or deleted.

Users can add their own custom fields to system tables.

---

## Field types

`DataFieldType` (`src/core/data/schemas.ts`):

| Field type     | `cells_json[fieldId]` shape                | Notes                                       |
|----------------|-------------------------------------------|---------------------------------------------|
| `text`         | `string \| null`                          | Single-line                                 |
| `longText`     | `string \| null`                          | Multi-line                                  |
| `richText`     | `string \| null`                          | HTML (sanitized at publish)                 |
| `number`       | `number \| null`                          |                                             |
| `boolean`      | `boolean \| null`                         |                                             |
| `date`         | ISO date string \| null                   | Date only                                   |
| `dateTime`     | ISO datetime string \| null               |                                             |
| `select`       | option id (string) \| null                | Options stored on the field definition      |
| `multiSelect`  | option ids (`string[]`)                   |                                             |
| `url`          | `string \| null`                          |                                             |
| `email`        | `string \| null`                          |                                             |
| `media`        | single: `mediaId \| null`; multi: `string[]` | References `media_assets`                |
| `relation`     | single: `rowId \| null`; multi: `string[]`| Relates to rows in another `data_table`     |
| `pageTree`     | `NodeTree<PageNode>` JSON                 | The visual tree (pages, VC trees)           |
| `fieldSchema`  | JSON describing fields                    | Used by VCs to declare `params`             |

The `DataField` discriminated union (`DataFieldSchema`) carries type-specific fields (e.g. `options` on `select`, `targetTableId` on `relation`).

### Reading cells safely

Cells are typed `unknown` at the schema level. Use the reader helpers in `src/core/data/cells.ts`:

```ts
readStringCell(cells, 'title')                  // → string ('' fallback)
readNumberCell(cells, 'price')                  // → number | null
readBooleanCell(cells, 'featured')              // → boolean
readStringArrayCell(cells, 'tags')              // → string[]
readTitleCell(cells)                            // → string  (reads 'title')
readSlugCell(cells)                             // → string  (reads 'slug')
readBodyCell(cells)                             // → string  (reads 'body')
readFeaturedMediaCell(cells)                    // → string | null
readSeoTitleCell(cells), readSeoDescriptionCell(cells)
readNodeTreeCell(cells, 'body')                 // → NodeTree<PageNode> | null
readFieldSchemaCell(cells, 'params')            // → DataField[] | null
```

These do the boundary validation — handlers and modules read through them rather than typing `cells.foo as string`.

To compute the denormalized, URL-normalized slug for a row (empty string when the table has no `slug` field):

```ts
slugForTable(table, cells)   // → string  (applies slugFromTitle; empty for tables without a slug field)
```

This is the single source of truth for slug derivation used by all admin write paths (`rows.ts`, `tables.ts`). Pass the result directly to `createDataRow` / `saveDataRowDraft`.

---

## Server side

### Repositories

| File                                             | Owns                                                                  |
|--------------------------------------------------|-----------------------------------------------------------------------|
| `server/repositories/data/tables.ts`             | CRUD on `data_tables`: list (system tables first: pages → posts → components → layouts, then custom by `created_at`), get, get-by-slug (indexed via `data_tables_slug_active_idx`), create, update, delete (system-protected) |
| `server/repositories/data/rows/read.ts`          | Hydrated read queries: `listDataRows`, `getDataRow`, `getDataRowMany` (one IN-list query for bulk validation), `getDataRowBySlug`, `countDataRows`, `listDataAuthorOptions` |
| `server/repositories/data/rows/mutations.ts`     | Single-row writes: create, save draft, soft-delete, move to table, update status / author. `softDeleteDataRow` returns the narrow `DeletedRowSummary` (not a full `DataRow`) — the row's `deleted_at is null` filter makes re-reading impossible, and callers only need `id / tableId / slug / status / deletedAt`. |
| `server/repositories/data/rows/bulk.ts`          | Transactional batch writes: `createDataRowMany`, `saveDataRowDraftMany`, `softDeleteDataRowMany` |
| `server/repositories/data/rows/filter.ts`        | Operator-object filter querying with pagination (`listDataRowsWithFilter`) — used by the plugin content surface |
| `server/repositories/data/rows/search.ts`        | Cross-table slug search (`searchDataRows`) — used by the spotlight content provider |
| `server/repositories/data/rows/schedule.ts`      | Scheduled-publish lifecycle: schedule, cancel, list due rows         |
| `server/repositories/data/rows/import.ts`        | Bundle-import upserts (id-preserving): `upsertDataRow`, `insertDataRowIfAbsent`, `replaceDataRow` |
| `server/repositories/data/rows/mapper.ts`        | Internal: hydrated SELECT builder + `DataRowRow → DataRow` mapper (not part of the public barrel) |
| `server/repositories/data/rows/index.ts`         | Barrel for the `rows/` directory                                     |
| `server/repositories/data/publish.ts`            | Publish persistence (`persistDataRowPublish` writes `data_row_versions`) + public-route lookups; the orchestration (lock, artefacts, cache bump) is `server/publish/publishRow.ts` |
| `server/repositories/data/shared.ts`             | Shared helpers: `userRefAt` (typed accessor per prefix — unknown prefix is a compile error), `userRefColumns` / `userRefJoin` (SQL fragment builders — the single source for the four `<prefix>_*` user-ref join columns and LEFT JOIN clauses, spliced verbatim by both `rows/mapper.ts` and `publish.ts`), `UserJoinColumns` (interface for all four `<prefix>_*` column groups — always present via LEFT JOIN, `null` when no user matched) |
| `server/repositories/data/index.ts`              | Barrel for the whole `data/` directory                               |

All repository functions are dialect-naive ANSI SQL. JSON columns end in `_json`; the SQLite adapter auto-parses on read. See [docs/reference/database-dialects.md](../reference/database-dialects.md).

### Handlers

| File                                          | Owns                                                                    |
|-----------------------------------------------|-------------------------------------------------------------------------|
| `server/handlers/cms/data/`                   | Generic `/admin/api/cms/data/tables[/:id]` + `/admin/api/cms/data/rows[/:id]` endpoints |
| `server/handlers/cms/pages.ts`                | `pages`-specific endpoints (batch upsert of the page roster from the editor; uses an optimistic-concurrency `baselinePageIds` token so a saving client never deletes a page a sibling session created concurrently) |
| `server/handlers/cms/components.ts`           | `components`-specific endpoints                                        |
| `server/handlers/cms/publish.ts`              | Publish a row, write a version, emit `publish.before/.html/.after` hooks |

Pages and components have their own typed endpoints (because the editor mutates trees, not arbitrary cells), but they still **write to `data_rows`**.

---

## Conversions: row ↔ domain object

The data store holds `cells_json` keyed by field id. The editor and publisher work with strongly-typed `Page` and `VisualComponent` objects. The conversion layer lives in `src/core/data/`:

| File                            | Function                                       | Direction                                   |
|---------------------------------|------------------------------------------------|---------------------------------------------|
| `src/core/data/pageFromRow.ts`  | `pageFromRow(row, table)`                      | `DataRow` → `Page` (reads `title`, `slug`, `body`)  |
| `src/core/data/pageFromRow.ts`  | `pageToCells(page)`                            | `Page` → `DataRowCells`                     |
| `src/core/data/componentFromRow.ts` | `visualComponentFromRow(row)`              | `DataRow` → `VisualComponent`               |
| `src/core/data/componentFromRow.ts` | `visualComponentToCells(vc)`               | `VisualComponent` → `DataRowCells`          |
| `src/core/data/fields.ts`       | `normalizeDataTableFields(value)`              | Tolerant parse of `fields_json`             |
| `src/core/data/fields.ts`       | `dataTableHasField(table, fieldId)`            |                                              |
| `src/core/data/fields.ts`       | `isPostTypeBuiltInFieldId(fieldId)`            | Identify the reserved post-type field ids   |

Handlers use these — repositories don't. Repositories return raw `DataRow` objects (with `cells: DataRowCells`); handlers convert to `Page` / `VisualComponent` before returning to the client.

---

## Publishing flow

```text
PATCH /admin/api/cms/data/rows/:id  { status: 'published' }
    │
    ▼
handlePublishRoute / publishDataRow
    │
    ├─→ load the row (with draft cells)
    ├─→ insert into data_row_versions with current cells + version_number = next
    ├─→ update row: status = 'published', published_at = now, published_by_user_id, etc.
    ├─→ if dependent pages reference this row (loops / queries), republish them
    └─→ emit publish.after hook
```

The published `SiteDocument` is stored ONCE per full publish in `site_snapshots` (with a content hash used by the publish-status check); each page's `data_row_versions` row references it via `site_snapshot_id` and carries only its page-scoped `runtime_assets_json`. Readers reassemble the `PublishedPageSnapshot` from the join — that snapshot is the canonical audit record. After it's written, the publisher routes through the three-layer pipeline:

- **Layer A** — the publisher renders **every** page (for postType rows, the matched entry template), runs the full `applyPublishedHtmlPipeline`, and writes the final HTML to `uploads/published/<inactive-slot>/<route>.html` — a fully-static page bakes a complete document, a page with dynamic nodes bakes a static shell with `<instatic-hole>` placeholders. The CSS bundles + runtime JS are baked into the same slot. After all pages are written the symlink `current` atomic-flips to the new slot. Served entirely from disk — no DB for HTML/CSS/JS.
- **Layer B** — the in-memory render cache evicts lazily via `bumpPublishVersion()`.
- **Layer C** — when a page contains dynamic nodes (auto-detected from binding sources, loop sources, module flags, VC refs), the publisher emits `<instatic-hole>` placeholders in the rendered HTML; the hole runtime fetches each fragment lazily from `/_instatic/hole/<nodeId>?v=<publishVersion>`.

For postType rows, `publishDataRow` does the same but incrementally: writes the single row's artefact into the ACTIVE slot via `tmp + rename` (no full slot swap), bumps publishVersion, and removes the old slug's artefact if the slug changed.

See [docs/features/publisher.md](publisher.md) for the full pipeline.

For **post-types**, public row routes require an explicitly authored entry template (a `pages` row with `template.target = { kind: 'postTypes', tableSlugs: [table.slug] }`). When you publish a post, the renderer resolves the template chain for the entry route (`resolveTemplateChain`) and renders the merged tree with the post row pushed onto the entry stack as `currentEntry`. Dynamic bindings on the template nodes resolve `currentEntry.title`, `currentEntry.body`, etc. Without a matching entry template, the published row exists in the CMS but its public detail URL returns 404. See [docs/features/templates.md](templates.md) for the full template model.

### Scheduled publishing

`status: 'scheduled'` with `scheduled_publish_at: <ISO datetime>`. The publisher's scheduler tick (`server/publish/publishScheduler.ts`) polls for rows where `scheduled_publish_at <= now()`, fires `publishDataRow(...)`, and flips the row to `published`. On failure, the row drops back to `draft`.

---

## Cookbook

### Add a new field to a postType

1. Open the postType in the Data workspace.
2. Add a field (pick a type from `DataFieldType`).
3. Optionally mark it `required` or set a `defaultValue`.

The field appears in the postType's edit form and is queryable from loops.

### Create a custom post-type

1. Open the Data workspace.
2. Create a new `data_table` with `kind: 'postType'`.
3. The system seeds the built-in fields (`title`, `slug`, `body`, `featuredMedia`, `seo`).
4. Add custom fields as needed.
5. Add posts via the Content workspace.
6. Create a post-type template in the Site workspace if the collection needs public detail pages.

### Create a "data" table (no workflow)

1. Open the Data workspace.
2. Create a `data_table` with `kind: 'data'`.
3. Add fields. No built-ins.
4. Add rows via the grid. No publish workflow.

Useful for form submissions, settings tables, or any arbitrary key-value collection.

### Read a row's content from a plugin

Plugins access content via the SDK's `api.cms.storage.collection(id)`:

```ts
const posts = api.cms.storage.collection('posts')
const rows  = await posts.list()
```

See [docs/features/plugin-system.md](plugin-system.md). Note the collection id matches the `data_tables.slug`.

### Render a postType row as a page

When a published row has a non-empty `data_tables.route_base`, the public URL is `/<routeBase>/<rowSlug>`. The router's `tryServePublicRoute` (in `server/router.ts`) delegates to `resolvePublicRoute` in `server/publish/publicRouter.ts`, which resolves the row + table, picks the matching entry template from the latest published site snapshot, and renders the template with the row pushed onto the entry stack.

---

## Forbidden patterns

| Pattern                                                       | Use instead                                                  |
|---------------------------------------------------------------|--------------------------------------------------------------|
| Creating a new content table outside `data_tables`            | Add a row to `data_tables`. There are no other content tables. |
| Reading `cells.foo as string`                                 | Use the readers in `src/core/data/cells.ts`                  |
| Renaming or deleting a system table                           | Blocked at the repository layer; UI hides the affordance     |
| Renaming a `builtIn: true` field on a postType                | Disable instead — the underlying field id is reserved        |
| Writing into `cells_json` directly without re-denormalizing `slug` | Use `slugForTable(table, cells)` from `src/core/data/cells.ts`, then pass the result to the repository function |
| Computing the published URL by stringing `id` together        | Use `routeBase` + the row's `slug`                           |
| Skipping the version write on publish                         | `publishDataRow` always writes a `data_row_versions` row     |
| Manually setting `status: 'published'` without going through the publish path | The publish path runs the renderer, writes a version, and fires hooks |

---

## Plugin events on content writes

Every successful content write fires one of three events on the hook bus alongside an `actor` field plugins can use to skip their own writes:

| Event                       | Fires when                                                                 | Payload                                                                                  |
|-----------------------------|-----------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `content.entry.created`     | A new row is inserted (admin CMS, plugin via `api.cms.content`)              | `{ tableSlug, entryId, actor }`                                                          |
| `content.entry.updated`     | A row's cells / slug / status change (draft save, publish, schedule, move)  | `{ tableSlug, entryId, changedFieldIds, actor }`                                         |
| `content.entry.deleted`     | A row is soft-deleted                                                       | `{ tableSlug, entryId, actor }`                                                          |

The `actor` shape:

```ts
type ContentEntryActor =
  | { kind: 'user'; userId: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'system' }  // schedulers, scheduled-publish tick
```

There's also one filter — `content.entry.cells` — that runs over the cell bag BEFORE persistence. All write paths — admin HTTP handlers (`rows.ts`, `tables.ts`) and the plugin `api.cms.content.*` surface — apply it via `applyContentEntryCellsFilter` from `server/publish/contentEvents.ts`. Plugins use it to validate, normalize, or auto-fill cells:

```ts
api.cms.hooks.filter('content.entry.cells', (cells, { tableSlug, entryId, actor }) => {
  if (tableSlug !== 'pages') return cells
  if (actor.kind === 'plugin' && actor.pluginId === api.plugin.id) return cells
  const seo = (cells.seo ?? {}) as { description?: string }
  if (!seo.description && typeof cells.body === 'string') {
    return { ...cells, seo: { ...seo, description: cells.body.slice(0, 160) } }
  }
  return cells
})
```

Events are emitted from `server/publish/contentEvents.ts`, which also exports `applyContentEntryCellsFilter`. Admin CMS handlers and plugin handlers both call these helpers directly; the publish scheduler emits the `system` actor variant.

---

## Related

- [docs/architecture.md](../architecture.md) — system overview ("All content lives in `data_tables` + `data_rows`")
- [docs/server.md](../server.md) — repository + handler layer
- [docs/features/publisher.md](publisher.md) — how `pageTree`-typed cells become HTML
- [docs/features/visual-components.md](visual-components.md) — components are rows in this store
- [docs/features/templates.md](templates.md) — entry templates for postType rendering
- [docs/features/site-transfer.md](site-transfer.md) — export / import bundles round-trip every table + row
- [docs/reference/database-dialects.md](../reference/database-dialects.md) — `_json` column convention + migration parity
- Source-of-truth files:
  - `src/core/data/schemas.ts` — `DataTableSchema`, `DataRowSchema`, `DataField` union, status enum, `DeletedRowSummary` / `DeletedRowSummarySchema` (narrow type returned by `softDeleteDataRow`)
  - `src/core/data/cells.ts` — typed cell readers + `slugForTable` (slug derivation)
  - `src/core/data/fields.ts` — field normalization, built-in field detection
  - `src/core/data/pageFromRow.ts` — Page ↔ row
  - `src/core/data/componentFromRow.ts` — VC ↔ row
  - `server/repositories/data/` — `tables.ts`, `rows/` (split by responsibility), `publish.ts`, `shared.ts`
  - `server/handlers/cms/data/` — generic data endpoints
  - `server/handlers/cms/pages.ts`, `components.ts`, `layouts.ts` — typed endpoints for the system tables
  - `server/publish/publishRow.ts` — per-row publish orchestration
  - `server/publish/publishScheduler.ts` — scheduled-publish tick
- Gate tests:
  - `src/__tests__/architecture/data-tables-system-flag.test.ts`
  - `src/__tests__/architecture/no-legacy-content-domain.test.ts`
  - `src/__tests__/architecture/no-legacy-pages-table.test.ts`
