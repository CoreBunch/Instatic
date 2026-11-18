/** Transactional site-bundle application shared by JSON and ZIP imports. */
import type { DbClient } from '../../db/client'
import type { ImportStrategy, SiteBundle } from '@core/data/bundleSchema'
import { MAIN_BRANCH_ID } from '@core/branches'
import { isMainScope, type BranchScope } from '../../branches/scope'
import { restoreBundlePublication, validateBundlePublication, BundlePublicationError } from '../../repositories/bundlePublication'
import { withPublishLock, bumpPublishVersion } from '../../publish/publishState'
import { prepareInactiveSlot, swapSlot } from '../../publish/staticArtefact'
import { ensureRuntimeDependencyCache } from '../../publish/runtime/dependencyCache'
import { saveDraftSite } from '../../repositories/site'
import { listDataTables, createDataTable, updateDataTable, insertDataTableIfAbsent } from '../../repositories/data/tables'
import { listDataRows, upsertDataRow, insertDataRowIfAbsent, replaceDataRow, type DataRowImportInput } from '../../repositories/data/rows'
import { deleteSiteMediaAssets, type DeletedMediaAsset } from '../../repositories/media'
import { listBranches } from '../../repositories/branches'
import { removeMediaAssetFiles } from './mediaVariants'
import { deleteAllDataRowRedirects, importDataRowRedirect } from '../../repositories/data/publish'
import { deleteAllMediaFolders, importMediaFolder } from '../../repositories/mediaFolders'
import { notifyRowWrite, notifyShellWrite, serializeCollabAwareWrite, type RowWriteKind } from '../../repositories/rowWriteEvents'

// The four system table ids that are always seeded and never deleted.
const SYSTEM_TABLE_IDS = new Set(['posts', 'pages', 'components', 'layouts'])

/**
 * Order folders so every parent precedes its children — `media_folders.parent_id`
 * is a self-referencing foreign key, so inserts must be topological. Any folder
 * whose parent isn't in the set is treated as a root (defensive: a malformed
 * bundle never wedges the import).
 */
function orderFoldersParentFirst<T extends { id: string; parentId: string | null }>(
  folders: readonly T[],
): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const emitted = new Set<string>()
  const ordered: T[] = []

  const visit = (folder: T): void => {
    if (emitted.has(folder.id)) return
    const parent = folder.parentId !== null ? byId.get(folder.parentId) : undefined
    if (parent) visit(parent)
    emitted.add(folder.id)
    ordered.push(folder)
  }

  for (const folder of folders) visit(folder)
  return ordered
}

export interface ApplySiteBundleInput {
  /** The bundle's data. Media bytes, when present, are not read here. */
  bundle: SiteBundle
  runtimeFiles?: ReadonlyMap<string, Uint8Array>
  uploadsDir?: string
  strategy: ImportStrategy
  /**
   * The import carries the media category (the bundle lists media, possibly
   * none). The archive endpoint strips media from `bundle` and streams the
   * bytes itself, so it states this separately.
   */
  carriesMedia: boolean
}

export interface AppliedSiteBundle {
  tablesAffected: number
  rowsInserted: number
  rowsReplaced: number
  rowsSkipped: number
  mediaFoldersImported: number
  redirectsImported: number
  /**
   * Folder ids that actually landed — asset memberships are restored only for
   * these, so an asset's `folderIds` pointing at a folder we didn't import is
   * skipped rather than violating the membership foreign key.
   */
  importedFolderIds: Set<string>
  /** Media rows a `replace` deleted; their bytes are the caller's to remove. */
  deletedMedia: DeletedMediaAsset[]
}

/**
 * Whether a `replace` import also replaces the media library. Media is not
 * branch-scoped, and records outside the import can reference it, so the
 * library is wiped only when nothing that survives the replace can:
 *
 *   - the import carries media at all (a bundle exported without media says
 *     nothing about the library, like folders and redirects);
 *   - it carries the site shell (a kept shell can reference media: favicon,
 *     `@font-face` sources, background images in style rules);
 *   - it runs on main and no other branch exists (branches share main's
 *     library and their rows and shells reference it).
 *
 * Assets owned by surviving records (avatars, plugin-managed media) are
 * spared by `deleteSiteMediaAssets` itself.
 */
async function replacesMediaLibrary(
  db: DbClient,
  scope: BranchScope,
  input: ApplySiteBundleInput,
): Promise<boolean> {
  if (!input.carriesMedia || input.bundle.site === undefined) return false
  if (!isMainScope(scope)) return false
  const branches = await listBranches(db)
  return branches.every((branch) => branch.id === MAIN_BRANCH_ID)
}

/**
 * Remove the bytes of media rows a committed `replace` deleted. Call it after
 * `applySiteBundle` returns and before writing the bundle's media.
 */
export async function removeDeletedMediaFiles(deleted: readonly DeletedMediaAsset[]): Promise<void> {
  for (const asset of deleted) await removeMediaAssetFiles(asset)
}

/**
 * Apply a bundle's site, tables, rows, folders, and redirects (and, for
 * `replace`, delete the media library) per `strategy`, in one transaction on
 * the collab-aware write lane, then notify open editors. Media bytes and
 * media rows are written by the caller afterwards.
 */
export async function applySiteBundle(db: DbClient, scope: BranchScope, input: ApplySiteBundleInput): Promise<AppliedSiteBundle> {
  const publication = input.bundle.publication
  if (publication) validateBundlePublication(publication, input.bundle.rows)
  for (const file of publication?.files ?? []) {
    const bytes = input.runtimeFiles?.get(file.publicPath) ?? (file.bytesBase64 === undefined ? undefined : Buffer.from(file.bytesBase64, 'base64'))
    if (!bytes || bytes.length !== file.sizeBytes) throw new BundlePublicationError('Missing or invalid published runtime file')
  }
  if (isMainScope(scope)) {
    const activeSnapshots = new Set(publication?.rows.flatMap((row) => row.versions
      .filter((version) => version.id === row.activeVersionId && version.siteSnapshotId)
      .map((version) => version.siteSnapshotId)))
    for (const snapshot of publication?.snapshots ?? []) {
      if (!activeSnapshots.has(snapshot.id)) continue
      const lock = snapshot.site.runtime?.dependencyLock
      if (lock && Object.keys(lock.packages).length > 0) await ensureRuntimeDependencyCache(lock)
    }
  }
  return withPublishLock(async () => {
    const slot = isMainScope(scope) && input.uploadsDir
      ? (await prepareInactiveSlot(input.uploadsDir)).slot
      : undefined
    const result = await applySiteBundleLocked(db, scope, input)
    if (isMainScope(scope)) {
      // Baked files belong to the previous publication. An empty slot makes the
      // existing public renderer serve the restored snapshots, never draft data.
      try {
        if (input.uploadsDir && slot) await swapSlot(input.uploadsDir, slot)
      } finally {
        bumpPublishVersion()
      }
    }
    return result
  })
}

async function applySiteBundleLocked(
  db: DbClient,
  scope: BranchScope,
  input: ApplySiteBundleInput,
): Promise<AppliedSiteBundle> {
  const { bundle, strategy } = input
  let tablesAffected = 0
  let rowsInserted = 0
  let rowsReplaced = 0
  let rowsSkipped = 0
  let mediaFoldersImported = 0
  let redirectsImported = 0
  let deletedMedia: DeletedMediaAsset[] = []
  const importedFolderIds = new Set<string>()
  const importedRowIds = new Set<string>()
  const transaction = (operation: (tx: DbClient) => Promise<void>) => db.transaction(async (tx) => {
    await operation(tx)
    if (isMainScope(scope) && bundle.publication) {
      await restoreBundlePublication(tx, bundle.publication, importedRowIds, input.runtimeFiles ?? new Map())
    }
  })

  await serializeCollabAwareWrite(async () => {
    const affectedCollabRows = new Map(
      ['pages', 'components', 'layouts'].map((tableId) => [tableId, new Set<string>()]),
    )
    const removedCollabRows = new Map(
      ['pages', 'components', 'layouts'].map((tableId) => [tableId, new Set<string>()]),
    )
    const createdCollabRows = new Map(
      ['pages', 'components', 'layouts'].map((tableId) => [tableId, new Set<string>()]),
    )
    let shellWasWritten = false
    if (strategy === 'replace') {
      for (const tableId of affectedCollabRows.keys()) {
        for (const row of await listDataRows(db, scope, tableId)) {
          affectedCollabRows.get(tableId)?.add(row.id)
        }
      }
    }

    if (strategy === 'replace') {
      // Wipe-and-replace: delete all rows + custom tables, then reimport.
      await transaction(async (tx) => {
        // 1. Delete ALL of this branch's data rows (covers all tables)
        await tx`delete from data_rows where branch_id = ${scope.branchId}`

        // 2. Delete this branch's non-system data tables. The flag is bound,
        //    not written as a literal: `system = 0` is `boolean = integer` on
        //    Postgres (an error), and the SQLite adapter binds `false` as 0.
        await tx`
          delete from data_tables
          where branch_id = ${scope.branchId}
            and system = ${false}
        `

        // 3. Load remaining system tables so we know which bundle tables to
        //    update vs insert.
        const existingTables = await listDataTables(tx, scope)
        const existingTableIds = new Set(existingTables.map((t) => t.id))

        // 4. Upsert tables from the bundle
        for (const table of bundle.tables) {
          if (existingTableIds.has(table.id)) {
            // System table already present — update its fields
            await updateDataTable(tx, scope, table.id, {
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
            // Custom table — insert with original id. `createdByPluginId` is
            // access-control state (the `@own-created` contentAccess marker
            // resolves against it), so a restore keeps plugin-created tables
            // owned by their plugin.
            await createDataTable(tx, scope, {
              id: table.id,
              name: table.name,
              slug: table.slug,
              kind: table.kind,
              routeBase: table.routeBase,
              singularLabel: table.singularLabel,
              pluralLabel: table.pluralLabel,
              primaryFieldId: table.primaryFieldId,
              fields: table.fields,
              createdByPluginId: table.createdByPluginId ?? null,
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
            scheduledPublishAt: row.scheduledPublishAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }
          await replaceDataRow(tx, scope, input)
          importedRowIds.add(row.id)
          affectedCollabRows.get(row.tableId)?.add(row.id)
          rowsInserted++
        }

        // 6. Replace the site shell (only when the bundle carries one)
        if (bundle.site) {
          await saveDraftSite(tx, scope, bundle.site, null, { collabInternal: true })
          shellWasWritten = true
        }

        // 7. Media library. Wiped only when this import replaces everything
        //    that can reference it (see `replacesMediaLibrary`). Rows go
        //    here, inside the transaction; their bytes are removed by the
        //    caller after commit, so a rolled-back import never loses a file.
        if (await replacesMediaLibrary(tx, scope, input)) {
          deletedMedia = await deleteSiteMediaAssets(tx)
        }

        // 8. Media folder tree. `delete from data_rows` above does NOT touch
        //    media_folders (unrelated FK), so wipe explicitly, then insert
        //    parent-first to satisfy the self-referencing parent_id FK.
        if (bundle.mediaFolders) {
          await deleteAllMediaFolders(tx)
          for (const folder of orderFoldersParentFirst(bundle.mediaFolders)) {
            await importMediaFolder(tx, folder)
            importedFolderIds.add(folder.id)
            mediaFoldersImported++
          }
        }

        // 9. Redirects. Old ones already cascade-deleted with their target rows
        //    in step 1; wipe explicitly for clarity, then reinsert from the
        //    bundle now that the target rows exist.
        if (bundle.redirects) {
          await deleteAllDataRowRedirects(tx)
          for (const redirect of bundle.redirects) {
            await importDataRowRedirect(tx, redirect)
            redirectsImported++
          }
        }
      })
    } else if (strategy === 'merge-add') {
      // Add what's missing; never overwrite existing content.
      await transaction(async (tx) => {
        // Tables: insert if absent, skip if the id already exists
        for (const table of bundle.tables) {
          const inserted = await insertDataTableIfAbsent(tx, scope, {
            id: table.id,
            name: table.name,
            slug: table.slug,
            kind: table.kind,
            routeBase: table.routeBase,
            singularLabel: table.singularLabel,
            pluralLabel: table.pluralLabel,
            primaryFieldId: table.primaryFieldId,
            fields: table.fields,
            createdByPluginId: table.createdByPluginId ?? null,
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
            scheduledPublishAt: row.scheduledPublishAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }
          const inserted = await insertDataRowIfAbsent(tx, scope, input)
          if (inserted) {
            importedRowIds.add(row.id)
            affectedCollabRows.get(row.tableId)?.add(row.id)
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
      await transaction(async (tx) => {
        // Pre-fetch all existing rows. An upsert can move an id from a table the
        // bundle does not mention, and both its old and new collab docs/rosters
        // must be invalidated after commit.
        const existingRowTables = new Map<string, string>()
        for (const table of await listDataTables(tx, scope)) {
          const existing = await listDataRows(tx, scope, table.id)
          for (const row of existing) existingRowTables.set(row.id, row.tableId)
        }

        // Tables: insert if absent, update if already present
        for (const table of bundle.tables) {
          const inserted = await insertDataTableIfAbsent(tx, scope, {
            id: table.id,
            name: table.name,
            slug: table.slug,
            kind: table.kind,
            routeBase: table.routeBase,
            singularLabel: table.singularLabel,
            pluralLabel: table.pluralLabel,
            primaryFieldId: table.primaryFieldId,
            fields: table.fields,
            createdByPluginId: table.createdByPluginId ?? null,
          })
          if (!inserted) {
            await updateDataTable(tx, scope, table.id, {
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
            scheduledPublishAt: row.scheduledPublishAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }
          await upsertDataRow(tx, scope, input)
          importedRowIds.add(row.id)
          const previousTableId = existingRowTables.get(row.id)
          if (previousTableId === undefined) {
            createdCollabRows.get(row.tableId)?.add(row.id)
          } else if (previousTableId !== row.tableId) {
            removedCollabRows.get(previousTableId)?.add(row.id)
            createdCollabRows.get(row.tableId)?.add(row.id)
          } else {
            affectedCollabRows.get(row.tableId)?.add(row.id)
          }
          if (previousTableId !== undefined) {
            rowsReplaced++
          } else {
            rowsInserted++
          }
        }

        // Site shell: overwrite if the bundle carries one
        if (bundle.site) {
          await saveDraftSite(tx, scope, bundle.site, null, { collabInternal: true })
          shellWasWritten = true
        }
      })
    }

    const branchId = scope.branchId
    if (shellWasWritten) notifyShellWrite(branchId)
    if (strategy === 'merge-overwrite') {
      for (const [tableId, ids] of affectedCollabRows) {
        if (ids.size > 0) notifyRowWrite({ branchId, tableId, rowIds: [...ids], kind: 'update' })
      }
      for (const [tableId, ids] of removedCollabRows) {
        if (ids.size > 0) notifyRowWrite({ branchId, tableId, rowIds: [...ids], kind: 'delete' })
      }
      for (const [tableId, ids] of createdCollabRows) {
        if (ids.size > 0) notifyRowWrite({ branchId, tableId, rowIds: [...ids], kind: 'create' })
      }
    } else {
      const eventKind: RowWriteKind = strategy === 'replace' ? 'delete' : 'create'
      for (const [tableId, ids] of affectedCollabRows) {
        if (ids.size > 0) notifyRowWrite({ branchId, tableId, rowIds: [...ids], kind: eventKind })
      }
    }
  })

  return {
    tablesAffected,
    rowsInserted,
    rowsReplaced,
    rowsSkipped,
    mediaFoldersImported,
    redirectsImported,
    importedFolderIds,
    deletedMedia,
  }
}
