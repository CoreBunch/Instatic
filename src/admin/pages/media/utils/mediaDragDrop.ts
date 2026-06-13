import { Type } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'

export const MEDIA_ASSET_DRAG_TYPE = 'application/x-instatic-media-assets'
const MEDIA_FOLDER_DRAG_TYPE = 'application/x-instatic-media-folder'

const MediaAssetDragPayloadSchema = Type.Object({
  assetIds: Type.Array(Type.String()),
})

const MediaFolderDragPayloadSchema = Type.Object({
  folderId: Type.String(),
})

export type MediaDropPayload =
  | { kind: 'assets'; assetIds: string[] }
  | { kind: 'folder'; folderId: string }

function hasType(dataTransfer: DataTransfer, type: string): boolean {
  return Array.from(dataTransfer.types).includes(type)
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function hasMediaDropData(dataTransfer: DataTransfer): boolean {
  return hasType(dataTransfer, MEDIA_ASSET_DRAG_TYPE) || hasType(dataTransfer, MEDIA_FOLDER_DRAG_TYPE)
}

export function writeMediaAssetDragData(dataTransfer: DataTransfer, assetIds: string[]) {
  const cleanIds = uniqueNonEmpty(assetIds)
  if (cleanIds.length === 0) return
  dataTransfer.setData(MEDIA_ASSET_DRAG_TYPE, JSON.stringify({ assetIds: cleanIds }))
  dataTransfer.effectAllowed = 'move'
}

export function writeMediaFolderDragData(dataTransfer: DataTransfer, folderId: string) {
  const cleanId = folderId.trim()
  if (!cleanId) return
  dataTransfer.setData(MEDIA_FOLDER_DRAG_TYPE, JSON.stringify({ folderId: cleanId }))
  dataTransfer.effectAllowed = 'move'
}

export function readMediaDropPayload(dataTransfer: DataTransfer): MediaDropPayload | null {
  const assetRaw = dataTransfer.getData(MEDIA_ASSET_DRAG_TYPE)
  if (assetRaw) {
    const parsed = safeParseJson(assetRaw, MediaAssetDragPayloadSchema)
    if (parsed.ok) {
      const assetIds = uniqueNonEmpty(parsed.value.assetIds)
      if (assetIds.length > 0) return { kind: 'assets', assetIds }
    }
  }

  const folderRaw = dataTransfer.getData(MEDIA_FOLDER_DRAG_TYPE)
  if (folderRaw) {
    const parsed = safeParseJson(folderRaw, MediaFolderDragPayloadSchema)
    if (parsed.ok) return { kind: 'folder', folderId: parsed.value.folderId }
  }

  return null
}
