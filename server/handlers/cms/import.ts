/**
 * Site bundle import endpoint.
 *
 *   POST /admin/api/cms/import[?strategy=replace|merge-add|merge-overwrite]
 *
 * Accepts a `SiteBundle` JSON body (as produced by GET/POST /admin/api/cms/export)
 * and applies it to the local instance using the specified strategy.
 *
 * Strategies:
 *   replace         (default) — delete everything, reimport from bundle atomically.
 *   merge-add                 — insert rows/tables that don't exist locally; skip
 *                               those whose id already exists. Never overwrites.
 *   merge-overwrite           — upsert rows/tables: add missing, update existing.
 *
 * All DB mutations run inside a single transaction. Media writes happen after
 * the transaction (filesystem); individual media failures log and continue
 * without aborting the import.
 *
 * Capability matrix (G6 fix — was a single `site.structure.edit` for
 * everything, which let a Designer with structure-edit but no
 * content rights wipe every row via the import endpoint):
 *
 *   ALL strategies require:        `data.import`
 *   `replace` strategy ALSO needs: `content.manage` AND step-up
 *                                  (wipe-and-reload is the highest blast
 *                                  radius operation in the CMS)
 *   bundles carrying a `site`:     ALSO `site.structure.edit` (the site
 *                                  shell replace is a structural edit)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp, userHasCapability } from '../../auth/authz'
import { saveDraftSite } from '../../repositories/site'
import {
  listDataTables,
  createDataTable,
  updateDataTable,
  insertDataTableIfAbsent,
} from '../../repositories/data/tables'
import {
  listDataRows,
  upsertDataRow,
  insertDataRowIfAbsent,
  replaceDataRow,
  type DataRowImportInput,
} from '../../repositories/data/rows'
import { importMediaAsset } from '../../repositories/media'
import { jsonResponse, readValidatedBody } from '../../http'
import { parseValue } from '@core/utils/typeboxHelpers'
import {
  SiteBundleSchema,
  ImportStrategySchema,
  ImportResultSchema,
  type ImportStrategy,
} from '@core/data/bundleSchema'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'

// The four system table ids that are always seeded and never deleted.
const SYSTEM_TABLE_IDS = new Set(['posts', 'pages', 'components', 'layouts'])

export async function handleImportRoute(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/import`) return null
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })

  // Base gate — any import requires `data.import`.
  const user = await requireCapability(req, db, 'data.import')
  if (user instanceof Response) return user

  // Parse strategy from query string (default: replace)
  const strategyParam = url.searchParams.get('strategy') ?? 'replace'
  let strategy: ImportStrategy
  try {
    strategy = parseValue(ImportStrategySchema, strategyParam)
  } catch {
    return jsonResponse(
      { error: 'Invalid strategy — must be replace, merge-add, or merge-overwrite' },
      { status: 400 },
    )
  }

  // `replace` strategy = wipe every data row and reinsert. Highest-blast
  // radius operation in the CMS. Require `content.manage` (so a caller
  // with `data.import` but no content rights can still merge-add but not
  // wipe) AND step-up (mirrors users.ts delete / publish.ts publish).
  if (strategy === 'replace') {
    if (!userHasCapability(user, 'content.manage')) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 })
    }
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }

  // Parse and validate the bundle body
  const bundle = await readValidatedBody(req, SiteBundleSchema)
  if (!bundle) {
    return jsonResponse({ error: 'Invalid bundle: body does not conform to SiteBundleSchema' }, { status: 400 })
  }

  // Bundles that carry a site shell additionally require
  // `site.structure.edit` — replacing the shell is a structural site edit
  // even when the import strategy is merge-overwrite.
  if (bundle.site) {
    if (!userHasCapability(user, 'site.structure.edit')) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // ---------------------------------------------------------------------------
  // Counters
  // ---------------------------------------------------------------------------
  let tablesAffected = 0
  let rowsInserted = 0
  let rowsReplaced = 0
  let rowsSkipped = 0
  let mediaImported = 0

  // ---------------------------------------------------------------------------
  // DB transaction
  // ---------------------------------------------------------------------------

  if (strategy === 'replace') {
    // Wipe-and-replace: delete all rows + custom tables, then reimport.
    await db.transaction(async (tx) => {
      // 1. Delete ALL data rows (covers all tables)
      await tx`delete from data_rows`

      // 2. Delete all non-system data tables
      await tx`delete from data_tables where system = 0 or system = false`

      // 3. Load remaining system tables so we know which bundle tables to
      //    update vs insert.
      const existingTables = await listDataTables(tx)
      const existingTableIds = new Set(existingTables.map((t) => t.id))

      // 4. Upsert tables from the bundle
      for (const table of bundle.tables) {
        if (existingTableIds.has(table.id)) {
          // System table already present — update its fields
          await updateDataTable(tx, table.id, {
            name: table.name,
            slug: table.slug,
            routeBase: table.routeBase,
            singularLabel: table.singularLabel,
            pluralLabel: table.pluralLabel,
            primaryFieldId: table.primaryFieldId,
            fields: table.fields,
          })
          tablesAffected++
        } else if (!SYSTEM_TABLE_IDS.has(table.id)) {
          // Custom table — insert with original id
          await createDataTable(tx, {
            id: table.id,
            name: table.name,
            slug: table.slug,
            kind: table.kind,
            routeBase: table.routeBase,
            singularLabel: table.singularLabel,
            pluralLabel: table.pluralLabel,
            primaryFieldId: table.primaryFieldId,
            fields: table.fields,
          })
          tablesAffected++
        }
        // Bundle tables whose id is a known SYSTEM_TABLE_ID but wasn't seeded
        // locally are silently skipped — they should never occur in practice.
      }

      // 5. Insert all rows (plain insert — table was just wiped)
      for (const row of bundle.rows) {
        const input: DataRowImportInput = {
          id: row.id,
          tableId: row.tableId,
          cells: row.cells,
          slug: row.slug,
          status: row.status,
          publishedAt: row.publishedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
        await replaceDataRow(tx, input)
        rowsInserted++
      }

      // 6. Replace the site shell (only when the bundle carries one)
      if (bundle.site) {
        await saveDraftSite(tx, bundle.site)
      }
    })
  } else if (strategy === 'merge-add') {
    // Add what's missing; never overwrite existing content.
    await db.transaction(async (tx) => {
      // Tables: insert if absent, skip if the id already exists
      for (const table of bundle.tables) {
        const inserted = await insertDataTableIfAbsent(tx, {
          id: table.id,
          name: table.name,
          slug: table.slug,
          kind: table.kind,
          routeBase: table.routeBase,
          singularLabel: table.singularLabel,
          pluralLabel: table.pluralLabel,
          primaryFieldId: table.primaryFieldId,
          fields: table.fields,
        })
        if (inserted) tablesAffected++
      }

      // Rows: insert if absent, skip if the id already exists
      for (const row of bundle.rows) {
        const input: DataRowImportInput = {
          id: row.id,
          tableId: row.tableId,
          cells: row.cells,
          slug: row.slug,
          status: row.status,
          publishedAt: row.publishedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
        const inserted = await insertDataRowIfAbsent(tx, input)
        if (inserted) {
          rowsInserted++
        } else {
          rowsSkipped++
        }
      }

      // Site shell: merge-add never overwrites the site shell — the local site
      // has existing content that must not be destroyed by an additive import.
    })
  } else {
    // merge-overwrite: upsert rows/tables; update existing with bundle values.
    await db.transaction(async (tx) => {
      // Pre-fetch all existing row ids for tables referenced in the bundle so
      // we can classify each row as inserted vs replaced without per-row SELECTs.
      const existingRowIds = new Set<string>()
      for (const table of bundle.tables) {
        const existing = await listDataRows(tx, table.id)
        for (const r of existing) existingRowIds.add(r.id)
      }

      // Tables: insert if absent, update if already present
      for (const table of bundle.tables) {
        const inserted = await insertDataTableIfAbsent(tx, {
          id: table.id,
          name: table.name,
          slug: table.slug,
          kind: table.kind,
          routeBase: table.routeBase,
          singularLabel: table.singularLabel,
          pluralLabel: table.pluralLabel,
          primaryFieldId: table.primaryFieldId,
          fields: table.fields,
        })
        if (!inserted) {
          await updateDataTable(tx, table.id, {
            name: table.name,
            slug: table.slug,
            routeBase: table.routeBase,
            singularLabel: table.singularLabel,
            pluralLabel: table.pluralLabel,
            primaryFieldId: table.primaryFieldId,
            fields: table.fields,
          })
        }
        tablesAffected++
      }

      // Rows: upsert all; track inserted vs replaced via the pre-fetched set
      for (const row of bundle.rows) {
        const input: DataRowImportInput = {
          id: row.id,
          tableId: row.tableId,
          cells: row.cells,
          slug: row.slug,
          status: row.status,
          publishedAt: row.publishedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
        await upsertDataRow(tx, input)
        if (existingRowIds.has(row.id)) {
          rowsReplaced++
        } else {
          rowsInserted++
        }
      }

      // Site shell: overwrite if the bundle carries one
      if (bundle.site) {
        await saveDraftSite(tx, bundle.site)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Media — outside the DB transaction (filesystem writes)
  // ---------------------------------------------------------------------------
  if (bundle.media && bundle.media.length > 0 && options.uploadsDir) {
    const uploadsDir = options.uploadsDir
    await mkdir(uploadsDir, { recursive: true })

    for (const asset of bundle.media) {
      try {
        // Write the file bytes. The schema already forbids leading-slash and
        // `..` segments, but re-assert containment after join() — a media
        // storagePath is otherwise an arbitrary-file-write primitive (ISS-009).
        const bytes = Buffer.from(asset.bytesBase64, 'base64')
        const target = join(uploadsDir, asset.storagePath)
        assertPathWithin(uploadsDir, target)
        await writeFile(target, bytes)

        // Upsert the media_assets row
        await importMediaAsset(db, {
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          storagePath: asset.storagePath,
          publicPath: `/uploads/${asset.storagePath}`,
          altText: asset.altText,
          caption: asset.caption,
          title: asset.title,
          tags: asset.tags,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs,
          dominantColor: asset.dominantColor,
          blurHash: asset.blurHash,
          posterPath: asset.posterPath,
        })
        mediaImported++
      } catch (err) {
        console.error('[import] Failed to import media asset:', asset.id, err)
        // Continue with remaining assets — a single failed asset should not
        // abort the whole import (data is already committed).
      }
    }
  }

  const result = {
    ok: true as const,
    strategy,
    tablesAffected,
    rowsInserted,
    rowsReplaced,
    rowsSkipped,
    mediaImported,
  }

  // Paranoia: validate result shape before returning
  parseValue(ImportResultSchema, result)

  return jsonResponse(result)
}
