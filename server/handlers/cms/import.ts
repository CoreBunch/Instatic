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
 * `replace` also wipes the media library when the import replaces everything
 * that can reference it (`replacesMediaLibrary`). The rows go inside the
 * transaction; their stored bytes are removed after it commits and BEFORE the
 * bundle's media is written, so a bundle file at a deleted asset's storage
 * path lands after the old one is gone.
 *
 * `applySiteBundle` is the DB half both import endpoints share: this JSON
 * endpoint and `/import/archive` (`./importArchive.ts`), which streams media
 * from the ZIP instead of Base64.
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
 *   bundles that publish:          ALSO `pages.publish`, `content.publish.any`
 *                                  AND step-up (published versions, or a
 *                                  `scheduled` row on main)
 */
import { validateBundlePublication, BundlePublicationError } from '../../repositories/bundlePublication'
import { applySiteBundle, removeDeletedMediaFiles, SYSTEM_TABLE_IDS } from './importApply'
import { canManageTable } from '../../auth/dataAccess'
import { isGrantableMemberTag } from '@core/members'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DbClient } from '../../db/client'
import { validateAndSanitizeMediaBytes, resolveMediaWriteTarget } from './importMediaValidation'
import { requireCapability, requireStepUp, userHasCapability } from '../../auth/authz'
import type { AuthUser } from '../../repositories/users'
import { importMediaAsset, assignAssetToFolders } from '../../repositories/media'
import { jsonResponse, readValidatedBody } from '../../http'
import { parseValue } from '@core/utils/typeboxHelpers'
import { SiteBundleSchema, ImportStrategySchema, ImportResultSchema, type ImportStrategy, type SiteBundle } from '@core/data/bundleSchema'
import { CMS_API_PREFIX, requestAuditContext, type CmsHandlerOptions } from './shared'
import { createAuditEvent } from '../../repositories/audit'
import { isMainScope, type BranchScope } from '../../branches/scope'

/** ZIP local-file-header magic (`PK\x03\x04`) — enough to tell an archive from JSON. */
function looksLikeZipArchive(body: ArrayBuffer): boolean {
  if (body.byteLength < 4) return false
  const head = new Uint8Array(body, 0, 4)
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

export async function handleImportRoute(
  req: Request,
  db: DbClient,
  scope: BranchScope,
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

  const strategyDenied = await authorizeImportStrategy(req, db, user, strategy)
  if (strategyDenied) return strategyDenied

  // Parse and validate the bundle body. This endpoint takes the JSON bundle;
  // the ZIP archive the export UI downloads belongs to /import/archive. Sent
  // here it fails schema validation, and a bare schema error sends the caller
  // hunting a bug in their bundle instead of at the wrong door — so name the
  // mistake when the body is recognisably an archive.
  const rawBody = await req.clone().arrayBuffer()
  if (looksLikeZipArchive(rawBody)) {
    return jsonResponse(
      {
        error:
          'This endpoint accepts a JSON site bundle. The exported .zip archive goes to '
          + `${CMS_API_PREFIX}/import/archive (same strategy query parameter).`,
      },
      { status: 400 },
    )
  }
  const bundle = await readValidatedBody(req, SiteBundleSchema)
  if (!bundle) {
    return jsonResponse({ error: 'Invalid bundle: body does not conform to SiteBundleSchema' }, { status: 400 })
  }

  const shellDenied = authorizeImportedShell(user, bundle.site !== undefined)
  if (shellDenied) return shellDenied

  const tableAccessDenied = await authorizeImportedTableAccess(req, db, user, bundle)
  if (tableAccessDenied) return tableAccessDenied

  const publicationInvalid = validateImportedPublication(bundle)
  if (publicationInvalid) return publicationInvalid
  const publicationDenied = await authorizeImportedPublication(req, db, user, scope, bundle)
  if (publicationDenied) return publicationDenied

  const applied = await applySiteBundle(db, scope, {
    bundle,
    strategy,
    carriesMedia: bundle.media !== undefined,
    mayChangePageAccess: userHasCapability(user, 'site.structure.edit'),
    uploadsDir: options.uploadsDir,
  }).catch((err: unknown) => {
    if (err instanceof BundlePublicationError) return jsonResponse({ error: err.message }, { status: 400 })
    throw err
  })
  if (applied instanceof Response) return applied
  await recordImportedTableAccess(req, db, user, applied.tableAccessAdded)
  // After commit, before the bundle's media lands: a bundle file at a deleted
  // asset's storage path must be written after the old bytes are removed.
  await removeDeletedMediaFiles(applied.deletedMedia)

  let mediaImported = 0

  // ---------------------------------------------------------------------------
  // Media — outside the DB transaction (filesystem writes)
  // ---------------------------------------------------------------------------
  if (bundle.media && bundle.media.length > 0 && options.uploadsDir) {
    const uploadsDir = options.uploadsDir
    await mkdir(uploadsDir, { recursive: true })

    for (const asset of bundle.media) {
      try {
        // Same security gate the archive import and upload pipeline apply:
        //   - destination: no traversal, never a reserved served subtree
        //     (published/plugins/fonts) — `resolveMediaWriteTarget`;
        //   - content: real MIME must match the declared type + extension and
        //     SVG is sanitised — `validateAndSanitizeMediaBytes`.
        // Without this, a `data.import` caller could write arbitrary HTML/JS
        // (e.g. `published/current/index.html`) served same-origin as /admin.
        const target = resolveMediaWriteTarget(uploadsDir, asset.storagePath)
        const safeBytes = validateAndSanitizeMediaBytes(
          Buffer.from(asset.bytesBase64, 'base64'),
          asset,
        )
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, safeBytes)

        // Upsert the media_assets row
        await importMediaAsset(db, {
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: safeBytes.length,
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

        // Restore folder membership — but only into folders we actually
        // imported, so a stale folderId can't violate the membership FK.
        const targetFolders = asset.folderIds.filter((id) => applied.importedFolderIds.has(id))
        if (targetFolders.length > 0) {
          await assignAssetToFolders(db, asset.id, { add: targetFolders })
        }

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
    tablesAffected: applied.tablesAffected,
    rowsInserted: applied.rowsInserted,
    rowsReplaced: applied.rowsReplaced,
    rowsSkipped: applied.rowsSkipped,
    rowsImportedAsDraft: applied.rowsImportedAsDraft,
    mediaImported,
    mediaFoldersImported: applied.mediaFoldersImported,
    redirectsImported: applied.redirectsImported,
  }

  // Paranoia: validate result shape before returning
  parseValue(ImportResultSchema, result)

  return jsonResponse(result)
}

/**
 * Strategy gate every bundle import passes on top of `data.import` (G6 fix —
 * was a single `site.structure.edit` for everything, which let a Designer
 * with structure-edit but no content rights wipe every row via the import
 * endpoint). Checked before the body is read. Shared with the archive
 * endpoint. Returns the error response, or `null` to proceed.
 *
 * `replace` = wipe every data row and reinsert, the highest-blast-radius
 * operation in the CMS. It requires `content.manage` (so a caller with
 * `data.import` but no content rights can still merge-add but not wipe) AND
 * step-up (mirrors users.ts delete / publish.ts publish).
 */
export async function authorizeImportStrategy(
  req: Request,
  db: DbClient,
  user: AuthUser,
  strategy: ImportStrategy,
): Promise<Response | null> {
  if (strategy !== 'replace') return null
  if (!userHasCapability(user, 'content.manage')) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }
  return requireStepUp(req, db, user)
}

/**
 * Bundles that carry a site shell additionally require `site.structure.edit`:
 * replacing the shell is a structural site edit even when the strategy is
 * merge-overwrite. Shared with the archive endpoint.
 */
export function authorizeImportedShell(user: AuthUser, carriesSite: boolean): Response | null {
  if (carriesSite && !userHasCapability(user, 'site.structure.edit')) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

/**
 * A bundle that limits a table to members sets who may open it, which is what
 * the table access endpoint does. It asks for the same: the right to manage
 * each such table, tags a member can be granted, and step-up.
 */
export async function authorizeImportedTableAccess(
  req: Request,
  db: DbClient,
  user: AuthUser,
  bundle: Pick<SiteBundle, 'tables' | 'tableAccess'>,
): Promise<Response | null> {
  const limited = bundle.tables.flatMap((table) => {
    const rule = bundle.tableAccess?.[table.id]
    return rule && rule.level !== 'public' ? [{ table, rule }] : []
  })
  if (limited.length === 0) return null
  if (limited.some(({ rule }) => rule.level === 'tags' && !rule.tags.every(isGrantableMemberTag))) {
    return jsonResponse({ error: 'A tag in a table access rule cannot be granted to a member' }, { status: 400 })
  }
  const mayManage = limited.every(({ table }) => canManageTable(user, { system: table.system || SYSTEM_TABLE_IDS.has(table.id) }))
  if (!mayManage) {
    return jsonResponse({ error: 'Importing table access rules requires permission to manage those tables' }, { status: 403 })
  }
  return requireStepUp(req, db, user)
}

/** An import that limited a table changed who may open it; the audit log says so. */
export async function recordImportedTableAccess(
  req: Request,
  db: DbClient,
  user: AuthUser,
  added: ReadonlyArray<{ tableId: string; slug: string }>,
): Promise<void> {
  for (const table of added) {
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'data.table.access',
      targetType: 'data_table',
      targetId: table.tableId,
      metadata: { slug: table.slug, source: 'import' },
      ...requestAuditContext(req),
    })
  }
}

export function validateImportedPublication(bundle: SiteBundle): Response | null {
  try {
    if (bundle.publication) validateBundlePublication(bundle.publication, bundle.rows)
    return null
  } catch (err) {
    if (err instanceof BundlePublicationError) return jsonResponse({ error: err.message }, { status: 400 })
    throw err
  }
}

/**
 * Making imported content public is a publish operation. A bundle does that
 * in two ways: it restores published versions (with their scripts and shared
 * resources), or it carries a `scheduled` row, which on main the scheduler
 * publishes when it falls due. A branch has no scheduler, so a schedule
 * imported into one publishes nothing.
 */
export async function authorizeImportedPublication(
  req: Request,
  db: DbClient,
  user: AuthUser,
  scope: BranchScope,
  bundle: SiteBundle,
): Promise<Response | null> {
  const restoresVersions = bundle.publication?.rows.some((row) => row.versions.length > 0) ?? false
  const schedulesPublish = isMainScope(scope) && bundle.rows.some((row) => row.status === 'scheduled')
  if (!restoresVersions && !schedulesPublish) return null
  if (!userHasCapability(user, 'pages.publish') || !userHasCapability(user, 'content.publish.any')) {
    return jsonResponse({ error: 'Importing published or scheduled content requires page and content publishing permissions' }, { status: 403 })
  }
  return requireStepUp(req, db, user)
}
