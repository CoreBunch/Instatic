/** Frozen publication state, independent of the editable rows in a site bundle. */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { SiteShellSchema, PageSchema } from '@core/page-tree'
import { VisualComponentSchema } from '@core/visual-components-schema'
import { SavedLayoutSchema } from '@core/layouts-schema'
import { PublishedPageRuntimeAssetsSchema } from '@core/site-runtime'
import { DataRowSchema } from './schemas'

const Id = Type.String({ pattern: '^[A-Za-z0-9_-]+$' })
const NullableId = Type.Union([Id, Type.Null()])

export const BundlePublicationSchema = Type.Object({
  rows: Type.Array(Type.Object({
    rowId: Type.String(),
    activeVersionId: NullableId,
    versions: Type.Array(Type.Object({
      id: Id,
      versionNumber: Type.Integer({ minimum: 1 }),
      cells: DataRowSchema.properties.cells,
      slug: Type.String(),
      siteSnapshotId: NullableId,
      runtimeAssets: Type.Union([PublishedPageRuntimeAssetsSchema, Type.Null()]),
      publishedAt: Type.String(),
      createdAt: Type.String(),
    })),
  })),
  snapshots: Type.Array(Type.Object({
    id: Id,
    site: Type.Intersect([SiteShellSchema, Type.Object({ pages: Type.Array(PageSchema), visualComponents: Type.Array(VisualComponentSchema), layouts: Type.Array(SavedLayoutSchema) })]),
    importmapBody: Type.Union([Type.String(), Type.Null()]),
    importmapSha256: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
  })),
  files: Type.Array(Type.Object({
    versionId: Id,
    path: Type.String(),
    publicPath: Type.String({ pattern: '^/_instatic/assets/' }),
    contentType: Type.String(),
    sizeBytes: Type.Integer({ minimum: 0 }),
    /** Only direct JSON imports embed bytes. ZIPs carry raw runtime/<index> entries. */
    bytesBase64: Type.Optional(Type.String()),
  })),
})

export type BundlePublication = Static<typeof BundlePublicationSchema>

export function runtimeArchivePath(index: number): string {
  return `runtime/${index}`
}

/** Selection keeps only the versions and dependencies belonging to included rows. */
export function selectBundlePublication(publication: BundlePublication, rowIds: ReadonlySet<string>): BundlePublication {
  const rows = publication.rows.filter((row) => rowIds.has(row.rowId))
  const versions = new Set(rows.flatMap((row) => row.versions.map((version) => version.id)))
  const snapshots = new Set(rows.flatMap((row) => row.versions.flatMap((version) => version.siteSnapshotId ? [version.siteSnapshotId] : [])))
  return {
    rows,
    snapshots: publication.snapshots.filter((snapshot) => snapshots.has(snapshot.id)),
    files: publication.files.filter((file) => versions.has(file.versionId)),
  }
}
