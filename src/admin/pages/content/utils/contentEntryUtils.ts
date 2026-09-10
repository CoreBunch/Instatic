import type { CmsMediaAsset } from '@core/persistence'
import type { DataRow } from '@core/data/schemas'

export function updateRowList(rows: DataRow[], row: DataRow): DataRow[] {
  const existing = rows.findIndex((candidate) => candidate.id === row.id)
  if (existing === -1) return [row, ...rows]
  const next = [...rows]
  next[existing] = row
  return next
}

export function mediaTypeFromAsset(asset: CmsMediaAsset): 'image' | 'video' {
  return asset.mimeType.startsWith('video/') ? 'video' : 'image'
}
