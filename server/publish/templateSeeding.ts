/**
 * Default entry-template seeding for `postType` data tables.
 *
 * Every `postType` table needs a page in the `pages` table whose
 * `template.{enabled,target}` fields point at it (a `postTypes` target
 * listing the table slug) — otherwise the public route
 * `/<route-base>/<row-slug>` has no template to bind the row into and the
 * dispatcher 404s. We seed a minimal default template automatically:
 *
 *   - At every table-creation entry point when `kind === 'postType'`
 *     (the admin tables handler and the plugin-host content API call
 *     `ensureDefaultEntryTemplate` right after `createDataTable`).
 *   - On server boot — and after a CMS bundle import — via
 *     `backfillDefaultEntryTemplates`, which walks every postType table and
 *     seeds anything that's missing. Covers the seeded `posts` table from
 *     the baseline migration, imported bundles that carry postType tables
 *     without their own template, and any install where a partial backup
 *     was restored.
 *
 * Seeding PUBLISHES a page row, so this is orchestration, not data access —
 * it lives in the publish layer and calls down into the repositories.
 *
 * The seed is intentionally minimal:
 *
 *   - `base.body` root
 *     - `base.text` <h1> bound to `{currentEntry.title}` via static-token
 *       interpolation (cheap; no DynamicPropBinding overlay required).
 *     - `base.outlet` — the publisher fills every outlet's `html` with the
 *       current entry's body (markdown → HTML) implicitly, so the seed just
 *       needs the bare outlet node; no per-node binding overlay is required.
 *
 * Site owners are expected to customise the template in the editor; the
 * seed exists so the public URL works the moment a row is published, and
 * so removing the fallback `renderDataRowDocumentHtml` is safe.
 *
 * Idempotent: the seed checks for an existing template targeting the
 * table's slug before creating one. Re-running on boot is cheap.
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import type { DataTable } from '@core/data/schemas'
import { createDataRow, listDataTables } from '../repositories/data'
import { publishDataRow } from './publishRow'

/**
 * True when at least one published page in the `pages` table targets the
 * given `tableSlug` as an entry template. We check the DRAFT cells (the
 * `cells_json` on `data_rows`) — published versions are derived from
 * those, so a draft with `templateEnabled=true` is sufficient evidence
 * that a template exists for this slug.
 */
async function hasEntryTemplate(db: DbClient, tableSlug: string): Promise<boolean> {
  // SQLite doesn't support `->>`; Postgres doesn't support `json_extract`
  // unambiguously without `(... ->> '...')`. The repository convention is
  // to read the full cells_json blob and filter in JS — cheap because the
  // pages table is tiny and only runs once per server boot per postType
  // table.
  const { rows } = await db<{ cells_json: Record<string, unknown> }>`
    select cells_json
    from data_rows
    where table_id = 'pages'
      and deleted_at is null
  `
  for (const row of rows) {
    const cells = row.cells_json ?? {}
    const target = cells.templateTarget as { kind?: string; tableSlugs?: unknown } | undefined
    if (cells.templateEnabled === true
      && target?.kind === 'postTypes'
      && Array.isArray(target.tableSlugs)
      && target.tableSlugs.includes(tableSlug)
    ) {
      return true
    }
  }
  return false
}

/**
 * Build the default page tree for a postType template. Returns the
 * cells_json shape ready for `createDataRow`. Node ids are stable per
 * seed call so a re-seed on a wiped row reproduces the same tree.
 */
export function buildDefaultTemplateCells(table: DataTable, slug: string): Record<string, unknown> {
  const rootId = nanoid()
  const titleId = nanoid()
  const bodyId = nanoid()

  return {
    title: `${table.singularLabel} Template`,
    slug,
    body: {
      rootNodeId: rootId,
      nodes: {
        [rootId]: {
          id: rootId,
          moduleId: 'base.body',
          props: {},
          breakpointOverrides: {},
          children: [titleId, bodyId],
        },
        [titleId]: {
          id: titleId,
          moduleId: 'base.text',
          // Token interpolation in static text props is enough for the
          // title — the publisher walks every string-typed prop and
          // expands `{currentEntry.title}` against the entry frame.
          props: { text: '{currentEntry.title}', tag: 'h1' },
          breakpointOverrides: {},
          children: [],
        },
        [bodyId]: {
          id: bodyId,
          moduleId: 'base.outlet',
          // The outlet needs no binding overlay: the publisher fills every
          // outlet's `html` with the current entry's body (markdown → HTML)
          // implicitly (see `effectiveNodeBindings`), so the seed — like a
          // hand-dropped outlet — just needs the bare node.
          props: { html: '' },
          breakpointOverrides: {},
          children: [],
        },
      },
    },
    templateEnabled: true,
    templateTarget: { kind: 'postTypes', tableSlugs: [table.slug] },
    templatePriority: 0,
  }
}

/**
 * Generate a candidate slug for the seeded template page. We use
 * `<table-slug>-template` and fall back to appending `-<counter>` if the
 * slug is already in use by an unrelated page row. The slug only matters
 * inside the admin (the template is never directly publicly addressable
 * because public requests go through the entry route, not the page slug).
 */
async function pickAvailableSlug(db: DbClient, base: string): Promise<string> {
  let candidate = `${base}-template`
  for (let attempt = 0; attempt < 50; attempt++) {
    const { rows } = await db<{ id: string }>`
      select id from data_rows
      where table_id = 'pages'
        and slug = ${candidate}
        and deleted_at is null
      limit 1
    `
    if (rows.length === 0) return candidate
    attempt += 1
    candidate = `${base}-template-${attempt + 1}`
  }
  // Extremely unlikely (50 collisions). Use a random suffix to break out.
  return `${base}-template-${nanoid(6)}`
}

/**
 * Ensure a default entry template exists for the given postType table.
 * Idempotent: if any page already targets the table's slug as an entry
 * template, this call is a no-op. Otherwise creates and publishes a
 * minimal template page so the public route works immediately.
 *
 * Returns the page row id of the seeded (or pre-existing) template, or
 * `null` when the input table isn't a postType (nothing to seed).
 */
export async function ensureDefaultEntryTemplate(
  db: DbClient,
  table: DataTable,
  actorUserId: string | null = null,
): Promise<string | null> {
  if (table.kind !== 'postType') return null
  if (await hasEntryTemplate(db, table.slug)) return null

  const slug = await pickAvailableSlug(db, table.slug)
  const cells = buildDefaultTemplateCells(table, slug)
  const row = await createDataRow(
    db,
    { tableId: 'pages', cells: cells as never, slug },
    actorUserId,
  )
  // Publish straight away — an unpublished template still won't reach the
  // public renderer because the published-site snapshot only includes
  // published rows. Seeding without publishing would leave the public
  // route broken until the operator opens the page in the editor.
  await publishDataRow(db, row.id, actorUserId)
  return row.id
}

/**
 * Walk every postType table and ensure each has a default entry template.
 * Called from server boot AFTER migrations — and after a CMS bundle import
 * commits — so the seeded `posts` system table (and any custom postType
 * table created or imported without a template) gets its template without
 * operator intervention.
 *
 * Errors on individual tables are logged and don't abort the loop — a
 * broken-but-published row in `pages` shouldn't keep the rest of the
 * site from booting.
 */
export async function backfillDefaultEntryTemplates(db: DbClient): Promise<void> {
  const tables = await listDataTables(db)
  for (const table of tables) {
    if (table.kind !== 'postType') continue
    try {
      const result = await ensureDefaultEntryTemplate(db, table, null)
      if (result) {
        console.warn(`[template-seeding] seeded default entry template for "${table.slug}" (page id: ${result})`)
      }
    } catch (err) {
      console.error(`[template-seeding] failed to seed "${table.slug}":`, err)
    }
  }
}
