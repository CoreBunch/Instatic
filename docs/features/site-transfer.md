# Site Transfer

Export and import — move a complete site between self-hosted instances. One ZIP bundle carries the shell, all data tables, all data rows, the media library (metadata + raw files + the folder tree), and published-URL redirects. Everything that defines the *site* travels in one archive, so re-importing into a fresh instance reproduces an **identical** site.

The transfer format is **self-contained** — no external service, no signed URLs, no incremental sync. Use it for backup, environment promotion (staging → production), or migrating between hosts.

The **Export site** dialog (`src/admin/pages/data/components/ExportDialog`) is a sibling of the Site Import modal: a two-column category navigator with a detail pane. Every category is selected by default — the primary action is a one-click **full export**. Untick any category to narrow the bundle. A live, server-accurate size estimate updates as the selection changes.

---

## TL;DR

- Format: `site-bundle-<timestamp>.zip` — `.instatic/site-bundle.json` plus `media/<storagePath>` entries. The archive manifest schema lives in `src/core/data/bundleArchive.ts`; the internal import payload schema lives in `src/core/data/bundleSchema.ts`.
- Endpoints:
  - `GET /admin/api/cms/export` or `POST /admin/api/cms/export` — produce a bundle from the current site
  - `POST /admin/api/cms/export/estimate` — exact byte size for an `ExportRequest`, without reading media off disk
  - `GET /admin/api/cms/export/summary` — total counts of the non-table categories (media, folders, redirects) so the dialog can label/disable them
  - `POST /admin/api/cms/import/preview` — analyze a bundle without applying (diff summary)
  - `POST /admin/api/cms/import[?strategy=...]` — apply the bundle
  - `POST /admin/api/cms/import/archive[?strategy=...]` — apply the user-facing ZIP archive, validating and staging selected media before data import
- Export categories: **theme & settings** (the shell), each **content table**, the **media library**, **media folders**, and **redirects** — all on by default.
- Import categories use the same selection model: the Site Import Review step can include or exclude the shell, tables/rows, media files, folders, and redirects before applying a bundle.
- The admin dialog starts downloads with a same-origin form POST, not `fetch().blob()`, so large media-heavy bundles are streamed by the browser's download stack instead of being materialized in JavaScript blob storage.
- UI entry (export): **Export site** in the Data workspace opens `src/admin/pages/data/components/ExportDialog`.
- UI entry (import): drop the exported `.zip` into the canonical Site Import modal (`src/admin/modals/SiteImport`). Spotlight and workspace **Import site** actions open this same global shell modal.
- Three import strategies: `replace` (destructive — the full-restore path), `merge-add` (insert if new), `merge-overwrite` (upsert).
- Media bytes are stored as raw files under `media/`. Export and archive import stream media bytes; the browser and server do not assemble a media-heavy archive as a JSON/base64 payload.
- Media folders + redirects are restored by the **`replace`** strategy (the full-restore path); merge strategies leave the local folder tree and redirects untouched.

---

## Where the code lives

```text
src/core/data/bundleArchive.ts
├── SiteBundleArchiveManifestSchema — archive `.instatic/site-bundle.json` shape
├── BUNDLE_ARCHIVE_MANIFEST_PATH    — `.instatic/site-bundle.json`
└── mediaArchivePath()              — maps storagePath → `media/<storagePath>`

src/core/data/bundleSchema.ts
├── MediaAssetMetadataSchema     — one media asset without bytes
├── MediaAssetExportSchema       — internal import payload asset with bytesBase64 + folderIds
├── BundleMediaFolderSchema      — one media-library folder (tree via parentId)
├── BundleRedirectSchema         — one published-URL redirect (raw row)
├── ImportStrategySchema         — 'replace' | 'merge-add' | 'merge-overwrite'
├── ExportRequestSchema          — POST /export body
├── ExportEstimateSchema         — GET/POST /export/estimate response
├── ExportSummarySchema          — GET /export/summary response (category counts)
├── BundlePreviewSchema          — diff summary
├── ImportResultSchema           — what was applied
└── SiteBundleSchema             — the full bundle shape

server/handlers/cms/
├── export.ts                    — GET+POST /admin/api/cms/export
├── import.ts                    — POST /admin/api/cms/import
├── importArchive.ts             — POST /admin/api/cms/import/archive
└── importPreview.ts             — POST /admin/api/cms/import/preview

src/core/persistence/cmsTransfer.ts   — client-side wrapper (typed fetch + archive parse helpers)
```

---

## Archive Shape

```text
site-bundle-2026-06-17T15-58-44.zip
├── .instatic/
│   └── site-bundle.json
└── media/
    └── <storagePath>
```

`.instatic/site-bundle.json` is the first stored ZIP entry and is a `SiteBundleArchiveManifest`:

```ts
interface SiteBundleArchiveManifest {
  schemaVersion:  1
  exportedAt:     string                    // ISO datetime
  sourceSiteName?: string                   // human-readable name of source site

  /** Optional site shell — settings, breakpoints, classes, files, runtime, package.json */
  site?: SiteShell

  /** All (or selected) data tables — `data_tables` rows */
  tables: DataTable[]

  /** All (or selected) data rows — `data_rows` rows. Cells included verbatim. */
  rows:   DataRow[]

  /** Optional: media asset metadata. Bytes live at media/<storagePath>. */
  media?: MediaAssetMetadata[]

  /** Optional: the media-library folder tree (rebuilt from `parentId` links). */
  mediaFolders?: BundleMediaFolder[]

  /** Optional: published-URL redirects. Each targets a row present in `rows`. */
  redirects?: BundleRedirect[]
}
```

`media[].folderIds` carries each asset's folder membership; on import it's restored only into folders that arrived in `mediaFolders`. The export keeps the bundle self-consistent: it only includes a redirect when both its table and its target row are part of the same bundle, so the import never hits a dangling foreign key.

The archive manifest parses through TypeBox before import. The admin import path reads only the first stored manifest entry for preview. Commit sends the original ZIP to `/admin/api/cms/import/archive`, which applies the validated manifest and streams selected `media/<storagePath>` entries through temporary files before moving them to `uploads/<storagePath>`.

`MediaAssetExport.storagePath` (and `posterPath`) are constrained at the schema level: the TypeBox pattern forbids a leading `/` and any `..` segment. The import handler enforces a second containment check at the write sink — `assertPathWithin(uploadsDir, join(uploadsDir, storagePath))` in `server/handlers/cms/import.ts` — so a tampered bundle cannot write bytes outside the uploads root even if the schema check were bypassed.

### What's NOT in a bundle

A portable bundle deliberately carries **no secrets and no instance-runtime state** — it travels between hosts and lands as a downloadable file, so credentials must never be in it.

| Excluded                | Why                                                                   |
|-------------------------|-----------------------------------------------------------------------|
| Sessions                | Per-device, security-sensitive                                        |
| Users / roles + passwords | Bundles are for site content, not account migration; password hashes must not travel |
| AI provider keys        | Credentials — never in a portable file                                |
| Audit / login logs      | Local to the host                                                     |
| Published HTML files    | Re-rendered on first publish after import                             |
| Media variants          | Omitted; imported assets fall back to originals until a later upload/replace regenerates variants |
| Plugin packages + install state | Plugin-owned `data_rows` are in `rows`; the installed-plugin set + package bytes are a separate subsystem |
| Per-user preferences    | Per-device — `localStorage` + `user_preferences` rows                 |

Folder and row authorship (`created_by_user_id`) is **reset to null** on import — the users it referenced don't exist on a fresh instance, exactly like data-row author references.

---

## Export

`GET /admin/api/cms/export` or `POST /admin/api/cms/export`

GET accepts filter options as query-string params. POST accepts either a JSON body matching `ExportRequestSchema` or an HTML form field named `exportRequest` containing that same JSON shape:

```ts
{
  // Tables to include, each with an optional row subset. OMIT the whole field
  // for a full export (all tables, all rows). Per entry: omit `rowIds` for the
  // whole table, or list specific row ids for a subset. A table absent from
  // this array is not exported at all.
  tables?:              { tableId: string; rowIds?: string[] }[]
  includeMedia?:        boolean     // include media files; default: false (the dialog sends true)
  includeSite?:         boolean     // include site shell; default: true
  includeMediaFolders?: boolean     // include the folder tree + asset membership; default: true
  includeRedirects?:    boolean     // include published-URL redirects; default: true
}
```

The redesigned **Export site** dialog defaults every category on and content tables to all rows, so its one-click action is a complete full-site export. Opening a content table reveals a **per-row checklist** (pages, posts, components, …) with per-table All / None, so an operator can include or exclude individual entries; the dialog then sends that table with an explicit `rowIds` subset. A table left untouched is sent with no `rowIds` (the whole table) and never needs its rows fetched. `GET` supports whole-table selection only (`?tables=posts,pages`); row-level subsets are POST-only.

The form field exists for the admin dialog's native attachment download path. It preserves row-level POST selection without forcing the returned bundle through a JS `Blob`.

The handler:

1. Capability-gates on `data.export`.
2. Loads the shell (always, for `sourceSiteName` even when `includeSite: false`), tables, rows.
3. If `includeMedia: true`, stats each existing media file under `uploadsDir` and writes it as a streamed `media/<storagePath>` archive entry.
4. Assembles `.instatic/site-bundle.json` as the first stored entry.
5. Returns a stored ZIP64 stream with `Content-Type: application/zip` and `Content-Disposition: attachment`.

Row visibility: callers without `content.edit.any` / `content.publish.any` / `content.manage` only export their own rows (gated by `canSeeAllDataRows`).

---

## Import preview

`POST /admin/api/cms/import/preview`

Body: an internal `SiteBundle` JSON (verbatim — no wrapper object). The admin importer builds this from the exported ZIP before previewing.
For user-facing ZIP archives, the admin importer builds this preview payload from `.instatic/site-bundle.json` only; media entries use empty `bytesBase64` placeholders because preview never needs file bytes.

Returns a `BundlePreview`:

```ts
{
  meta: {
    exportedAt:      string        // from the bundle
    sourceSiteName:  string | null // from the bundle
    schemaVersion:   1
  }
  tables: Array<{
    id:           string
    name:         string
    kind:         DataTableKind
    inBundle:     number    // rows in bundle for this table
    willReplace:  number    // bundle rows whose id exists locally
    willAdd:      number    // bundle rows whose id does not exist locally
    currentLocal: number    // current non-deleted rows on local instance
  }>
  totals: {
    rows:          number   // total rows in bundle
    mediaFiles:    number   // total media assets in bundle
    mediaEmbedded: boolean  // true if media bytes are present in the internal import payload
    mediaFolders:  number   // total folders in bundle
    redirects:     number   // total redirects in bundle
  }
  rowConflicts: Array<{
    tableId:       string
    tableName:     string
    rowId:         string
    rowTitle:      string
    slug:          string
    existingRowId: string
    suggestedSlug: string
  }>
}
```

The preview runs a **dry-run** of the import logic — same code path, just doesn't write. It also reports row slug collisions where an incoming row id is new but its slug is already used by another active local row in the same table. Super Import routes those rows through the shared Conflicts step before applying.

Capability-gated by `data.export`.

---

## Import

`POST /admin/api/cms/import[?strategy=replace|merge-add|merge-overwrite]`

Body: an internal `SiteBundle` JSON (verbatim). Strategy is a query-string parameter (default: `replace`).

`POST /admin/api/cms/import/archive[?strategy=replace|merge-add|merge-overwrite]`

Body: the user-facing ZIP archive emitted by export. The manifest must be the first stored entry at `.instatic/site-bundle.json`; media entries must be stored under `media/<storagePath>`. This is the path used by Super Import when a dropped ZIP is an Instatic transfer archive.

The archive endpoint also accepts a `selection` query parameter containing `BundleImportSelection` JSON. The browser still posts the original ZIP Blob; the server filters the manifest before delegating to the JSON import handler and streams only selected media entries to disk, draining unselected archive entries as needed. Row slug conflict resolutions travel in the same selection as `rowSlugOverrides: { tableId, rowId, slug }[]`; the server applies those overrides to the manifest row before import.

```ts
type ImportStrategy = 'replace' | 'merge-add' | 'merge-overwrite'
```

| Strategy           | Tables                            | Rows                              | Media                              | Folders + redirects          |
|--------------------|-----------------------------------|-----------------------------------|------------------------------------|------------------------------|
| `replace`          | Wipe + recreate from bundle       | Wipe + recreate                   | Wipe + write all bytes             | Wipe + recreate from bundle  |
| `merge-add`        | Skip if exists; add if new        | Skip if id or active slug exists; add if new | Skip if exists; add if new         | Left untouched               |
| `merge-overwrite`  | Upsert (incoming wins)            | Upsert (incoming wins)            | Upsert (incoming bytes win)        | Left untouched               |

Folder membership (`media_asset_folders`) is restored **after** the media bytes land, and only into folders the bundle actually carried. Redirect rows are inserted after their target rows exist (in `replace`, the rows' cascade-delete clears the old redirects first). Folders + redirects ride only the `replace` (full-restore) path because merging a folder tree or redirect set into a populated instance risks unique-key collisions — the same reason the site shell is `replace`/`merge-overwrite`-only.

The JSON handler:

1. Validates the bundle against `SiteBundleSchema`.
2. Runs the same preview logic to compute the change set.
3. Wraps the apply in a **single DB transaction**:
   - Tables: insert / update / delete per strategy.
   - Rows: insert / update / soft-delete per strategy.
   - Site shell: if the bundle carries `site`, overwrite the `site` row.
4. **Outside the transaction**, writes media bytes to `uploads/<storagePath>`. Before writing, the handler calls `assertPathWithin(uploadsDir, target)` (from `server/util/pathWithin.ts`) as a defense-in-depth check — the schema already forbids traversal, but the sink re-asserts containment after `path.join()` resolves symlinks. Media writes are best-effort — if a disk write fails, the row import has already committed and the asset is skipped with a log entry.
5. Returns `ImportResult` with counts.

The archive handler:

1. Capability-gates on `data.import`.
2. Reads and validates the first ZIP entry as `.instatic/site-bundle.json`.
3. Applies the optional selection filter and row slug overrides to the manifest.
4. Streams selected media entries into temporary files, validating declared size, CRC descriptors, missing selected entries, and unexpected archive entries before data is mutated.
5. Delegates the manifest's site/data/folder/redirect content to the JSON import handler without media bytes.
6. Moves staged media into `uploads/<storagePath>` and upserts the matching media row.
7. Returns the same `ImportResult` shape with `mediaImported` from the staged entries.

The transaction is **all-or-nothing** for the DB side — if any insert fails, the DB rolls back. Malformed archive media is rejected before the DB transaction starts. A disk failure while moving already-validated staged media can still leave media partially written after the data import, matching the JSON import handler's best-effort filesystem semantics.

### Conflict resolution

Per strategy:

- **`replace`**: incoming bundle wins for everything.
- **`merge-add`**: existing rows / tables / media are untouched. Incoming-only items added.
- **`merge-overwrite`**: matching ids upsert. Items not in the bundle are **kept** (vs. `replace` which deletes them).

Primary merge identity is **id**: a row in the bundle with the same id as an existing row is the same row. Row slugs still have a table-scoped uniqueness constraint for active rows, so a new incoming row can collide with an unrelated local row's slug. Preview reports those collisions as `rowConflicts`; Super Import lets the operator rename or skip them. The `merge-add` repository path also uses `on conflict do nothing`, so a missed slug collision is skipped instead of surfacing as a 500.

### Capability gates

| Operation                             | Required capability                                 |
|---------------------------------------|-----------------------------------------------------|
| Export                                | `data.export`                                       |
| Preview                               | `data.export`                                       |
| Apply (any strategy)                  | `data.import`                                       |
| Apply with `replace` strategy         | `data.import` AND `content.manage` AND step-up      |
| Apply bundle that carries `site` shell| ALSO `site.structure.edit`                          |

---

## Round-trip parity

The export → import path round-trips losslessly for everything in the bundle. This is verified by:

- `src/__tests__/architecture/cmsTransferExport.test.ts` — export produces a valid bundle.
- `src/__tests__/architecture/cmsTransferPreview.test.ts` — preview matches what import would do.
- `src/__tests__/architecture/cmsTransferImport.test.ts` — applying then re-exporting produces a bundle equivalent to the original.
- `src/__tests__/architecture/import-export-roundtrip.test.ts` — full round-trip, including a dedicated block that proves the **media folder tree, asset folder membership, and redirects** survive an export → `replace`-import into a pristine instance.

If you change a persisted shape (a new column on `data_rows`, a new field on `data_tables`), you also need to:

1. Add the new field to the matching schema in `bundleSchema.ts`.
2. Handle the new field in `export.ts` (read into the bundle).
3. Handle it in `import.ts` (write from the bundle).
4. Update the round-trip tests so they cover the new field.

---

## Cookbook

### Export everything

```text
POST /admin/api/cms/export
{
  "includeSite": true,
  "includeMedia": true
}
```

Save the response ZIP to disk (browser handles the download automatically).

### Move a site between hosts

1. On the source host: export with `includeSite: true, includeMedia: true`.
2. On the destination host: setup wizard completes (creates an owner account, empty site).
3. On the destination host: open **Import Site** from Spotlight or the Data workspace, then drop the exported ZIP bundle.
4. Review the preview and import with `strategy: replace`.
5. After import, the published HTML is regenerated on next publish (or `republish-all`).

### Selective export (one table only)

```text
POST /admin/api/cms/export
{
  "includeSite": false,
  "tables": [{ "tableId": "posts" }],
  "includeMedia": true
}
```

Or a specific subset of rows from one table:

```text
POST /admin/api/cms/export
{
  "includeSite": false,
  "tables": [{ "tableId": "posts", "rowIds": ["row_abc", "row_def"] }]
}
```

Useful for moving content (not styling) between sites with similar layouts.

### Backup script

A nightly cron can hit `/admin/api/cms/export` with an admin session cookie and pipe the response to disk. For larger sites, prefer the DB-level `pg_dump` (Postgres) or file copy (SQLite + `Litestream`) — see [docs/deployment/backup-restore.md](../deployment/backup-restore.md).

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Importing without a preview                                          | Always preview first — `replace` is destructive          |
| Customising the export to add server secrets (DB URL, API keys)      | Bundles travel between hosts — never include secrets     |
| Hand-editing a bundle JSON to patch a row                            | The bundle is validated against `SiteBundleSchema`. Hand edits will be rejected if the shape's wrong; use the admin UI for one-off edits. |
| Renaming a `data_table.id` between export and import                 | Match is by id — different id = different table         |
| Importing media without the matching `data_rows` references           | Orphan media is fine but won't render anywhere          |
| Concurrent imports on the same site                                  | Wrap import in a transaction (already done) but don't run two at once — capability gate + step-up reduces accidental concurrency |
| Storing bundles in version control                                   | Large + binary media bloats the repo. Use object storage / drive. |
| Crafting a bundle with a `storagePath` containing `..` or a leading `/` | Rejected by `MediaAssetExportSchema` at parse time and by `assertPathWithin` at the write sink. Do not rely on either check alone — both must hold. |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — handler patterns + transactions
- [docs/features/content-storage.md](content-storage.md) — `data_tables` + `data_rows` schemas
- [docs/features/media.md](media.md) — imported media falls back to originals when variants are absent
- [docs/features/site-shell.md](site-shell.md) — site shell shape
- [docs/deployment/backup-restore.md](../deployment/backup-restore.md) — broader backup options
- Source-of-truth files:
  - `src/core/data/bundleSchema.ts` — `SiteBundleSchema`, `ImportStrategySchema`, `BundlePreviewSchema`, `ImportResultSchema`
  - `server/handlers/cms/export.ts` — `GET+POST /export`
  - `server/handlers/cms/import.ts` — `POST /import`
  - `server/handlers/cms/importArchive.ts` — `POST /import/archive`
  - `server/handlers/cms/importPreview.ts` — `POST /import/preview`
  - `src/core/persistence/cmsTransfer.ts` — client-side transfer helpers, including native export form submission
  - `server/util/pathWithin.ts` — `assertPathWithin` containment helper (media write sink)
- Gate tests:
  - `src/__tests__/architecture/cmsTransferExport.test.ts`
  - `src/__tests__/architecture/cmsTransferPreview.test.ts`
  - `src/__tests__/architecture/cmsTransferImport.test.ts`
  - `src/__tests__/architecture/import-export-roundtrip.test.ts`
