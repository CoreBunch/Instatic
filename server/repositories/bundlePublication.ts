/** Publication storage for portable site bundles. Never publishes the editable row cells. */
import { nanoid } from 'nanoid'
import type { DataRow } from '@core/data/schemas'
import type { BundlePublication } from '@core/data/bundlePublication'
import type { DbClient } from '../db/client'
import type { BranchScope } from '../branches/scope'
import { isMainScope } from '../branches/scope'
import { contentHash } from '../branches/contentHash'
import { isoDate } from '@core/utils/isoDate'
import { savePublishedRuntimeAssets } from './runtimeAsset'

export async function exportBundlePublication(db: DbClient, scope: BranchScope, rowIds: readonly string[]): Promise<{ publication: BundlePublication; bytes: Uint8Array[] }> {
  const publication: BundlePublication = { rows: [], snapshots: [], files: [] }
  const bytes: Uint8Array[] = []
  if (!isMainScope(scope)) {
    publication.rows = rowIds.map((rowId) => ({ rowId, activeVersionId: null, versions: [] }))
    return { publication, bytes }
  }
  const snapshotIds = new Set<string>()
  for (const rowId of rowIds) {
    const { rows: pointers } = await db<{ active_version_id: string | null }>`select active_version_id from data_rows where id = ${rowId}`
    const { rows: versions } = await db<{
      id: string; version_number: number; cells_json: Record<string, unknown>; slug: string;
      site_snapshot_id: string | null; runtime_assets_json: BundlePublication['rows'][number]['versions'][number]['runtimeAssets'];
      published_at: string | Date; created_at: string | Date
    }>`select id, version_number, cells_json, slug, site_snapshot_id, runtime_assets_json, published_at, created_at
       from data_row_versions where row_id = ${rowId} order by version_number`
    publication.rows.push({ rowId, activeVersionId: pointers[0]?.active_version_id ?? null, versions: versions.map((v) => ({
      id: v.id, versionNumber: Number(v.version_number), cells: v.cells_json, slug: v.slug,
      siteSnapshotId: v.site_snapshot_id, runtimeAssets: v.runtime_assets_json,
      publishedAt: isoDate(v.published_at), createdAt: isoDate(v.created_at),
    })) })
    for (const version of versions) {
      if (version.site_snapshot_id) snapshotIds.add(version.site_snapshot_id)
      const { rows: files } = await db<{ asset_path: string; public_path: string; content_type: string; content_bytes: Uint8Array }>`
        select asset_path, public_path, content_type, content_bytes from published_runtime_assets
        where data_row_version_id = ${version.id} order by public_path`
      for (const file of files) {
        publication.files.push({ versionId: version.id, path: file.asset_path, publicPath: file.public_path, contentType: file.content_type, sizeBytes: file.content_bytes.length })
        bytes.push(file.content_bytes)
      }
    }
  }
  for (const id of snapshotIds) {
    const { rows } = await db<{ site_json: BundlePublication['snapshots'][number]['site']; importmap_body: string | null; importmap_sha256: string | null; created_at: string | Date }>`
      select site_json, importmap_body, importmap_sha256, created_at from site_snapshots where id = ${id}`
    const snapshot = rows[0]
    if (!snapshot) throw new BundlePublicationError('Published version references a missing site snapshot')
    publication.snapshots.push({ id, site: snapshot.site_json, importmapBody: snapshot.importmap_body, importmapSha256: snapshot.importmap_sha256, createdAt: isoDate(snapshot.created_at) })
  }
  return { publication, bytes }
}

export class BundlePublicationError extends Error {
  constructor(message: string) { super(message); this.name = 'BundlePublicationError' }
}

/** All references are checked before any imported row can become public. */
export function validateBundlePublication(publication: BundlePublication, dataRows: readonly Pick<DataRow, 'id' | 'tableId' | 'status'>[]): void {
  const rowIds = new Set(dataRows.map((row) => row.id))
  const snapshotIds = new Set(publication.snapshots.map((snapshot) => snapshot.id))
  const versionIds = new Set<string>()
  const seenRows = new Set<string>()
  if (snapshotIds.size !== publication.snapshots.length) throw new BundlePublicationError('Duplicate published site snapshot')
  for (const row of publication.rows) {
    if (!rowIds.has(row.rowId) || seenRows.has(row.rowId)) throw new BundlePublicationError('Invalid publication row reference')
    seenRows.add(row.rowId)
    const numbers = new Set<number>()
    for (const version of row.versions) {
      if (versionIds.has(version.id) || numbers.has(version.versionNumber)) throw new BundlePublicationError('Duplicate published version')
      versionIds.add(version.id)
      numbers.add(version.versionNumber)
      if (version.siteSnapshotId && !snapshotIds.has(version.siteSnapshotId)) throw new BundlePublicationError('Missing published site snapshot')
    }
    if (row.activeVersionId && !row.versions.some((version) => version.id === row.activeVersionId)) throw new BundlePublicationError('Missing active published version')
  }
  for (const dataRow of dataRows) {
    const row = publication.rows.find((candidate) => candidate.rowId === dataRow.id)
    if (!row || (dataRow.status === 'published' && !row.activeVersionId)) throw new BundlePublicationError('Published state is missing for an imported row')
    const active = row.versions.find((version) => version.id === row.activeVersionId)
    if (dataRow.tableId === 'pages' && active) {
      const snapshot = publication.snapshots.find((candidate) => candidate.id === active.siteSnapshotId)
      if (!snapshot?.site.pages.some((page) => page.id === row.rowId && page.slug === active.slug)) throw new BundlePublicationError('Published page is missing from its site snapshot')
    }
  }
  const paths = new Set<string>()
  for (const file of publication.files) {
    if (!versionIds.has(file.versionId) || paths.has(file.publicPath) || !file.publicPath.startsWith(`/_instatic/assets/${file.versionId}/`)) throw new BundlePublicationError('Invalid published runtime asset')
    paths.add(file.publicPath)
  }
  for (const row of publication.rows) {
    const active = row.versions.find((version) => version.id === row.activeVersionId)
    for (const script of active?.runtimeAssets?.scripts ?? []) {
      if (!publication.files.some((file) => file.versionId === active?.id && file.publicPath === script.src)) throw new BundlePublicationError('Active published script is missing from the bundle')
    }
  }
}

export async function restoreBundlePublication(db: DbClient, publication: BundlePublication, importedRowIds: ReadonlySet<string>, runtimeFiles: ReadonlyMap<string, Uint8Array>): Promise<void> {
  // Snapshot ids are local identities; remap them so merge imports cannot overwrite other rows' snapshots.
  const snapshotIds = new Map<string, string>()
  const neededSnapshots = new Set(publication.rows.filter((row) => importedRowIds.has(row.rowId)).flatMap((row) => row.versions.flatMap((v) => v.siteSnapshotId ? [v.siteSnapshotId] : [])))
  for (const snapshot of publication.snapshots) {
    if (!neededSnapshots.has(snapshot.id)) continue
    const id = nanoid()
    snapshotIds.set(snapshot.id, id)
    await db`insert into site_snapshots (id, site_json, content_hash, importmap_body, importmap_sha256, created_at)
      values (${id}, ${snapshot.site}, ${contentHash(snapshot.site)}, ${snapshot.importmapBody}, ${snapshot.importmapSha256}, ${snapshot.createdAt})`
  }
  for (const row of publication.rows) {
    if (!importedRowIds.has(row.rowId)) continue
    await db`update data_rows set active_version_id = null where id = ${row.rowId}`
    await db`delete from data_row_versions where row_id = ${row.rowId}`
    for (const version of row.versions) {
      // Preserve version ids: compiled chunks and manifests contain their immutable public URLs.
      await db`insert into data_row_versions (id, row_id, version_number, cells_json, slug, site_snapshot_id, runtime_assets_json, published_at, created_at)
        values (${version.id}, ${row.rowId}, ${version.versionNumber}, ${version.cells}, ${version.slug}, ${version.siteSnapshotId ? snapshotIds.get(version.siteSnapshotId) : null}, ${version.runtimeAssets}, ${version.publishedAt}, ${version.createdAt})`
      for (const file of publication.files.filter((candidate) => candidate.versionId === version.id)) {
        const bytes = runtimeFiles.get(file.publicPath) ?? (file.bytesBase64 === undefined ? undefined : Buffer.from(file.bytesBase64, 'base64'))
        if (!bytes || bytes.length !== file.sizeBytes) throw new BundlePublicationError('Missing or invalid published runtime file')
        await savePublishedRuntimeAssets(db, version.id, [{ path: file.path, publicPath: file.publicPath, contentType: file.contentType, bytes }])
      }
    }
    await db`update data_rows set active_version_id = ${row.activeVersionId} where id = ${row.rowId}`
  }
  const { rows: publicRows } = await db<{ id: string; table_id: string; slug: string }>`
    select data_rows.id, data_rows.table_id, data_row_versions.slug
    from data_rows join data_row_versions on data_row_versions.id = data_rows.active_version_id
    where data_rows.status = 'published' and data_rows.deleted_at is null`
  const routes = new Map<string, string>()
  for (const row of publicRows) {
    const key = JSON.stringify([row.table_id, row.slug])
    const previous = routes.get(key)
    if (previous && (importedRowIds.has(previous) || importedRowIds.has(row.id))) {
      throw new BundlePublicationError(`Published route conflicts with another row: ${row.slug}`)
    }
    routes.set(key, row.id)
  }
}
