/**
 * Drop-legality rules for the Media workspace — the single source of truth for
 * which folder/asset drags are allowed and what each drop commits.
 *
 * Both surfaces that accept media drops (the canvas grid/list and the sidebar
 * folder tree) consume these helpers via `useMediaDnd`, so the no-self-drop /
 * no-drop-onto-own-parent / no-descendant-cycle rules live in exactly one place.
 */
import type { CmsMediaFolder } from '@core/persistence/cmsMedia'
import { isFolderDescendant } from './folderTree'
import type { MediaDropPayload } from './mediaDragDrop'

const ROOT_FOLDER_DROP_KEY = '__media-root__'

/** Stable key for a drop target; `null` (the root / "All files") maps to a sentinel. */
export function folderDropKey(folderId: string | null): string {
  return folderId ?? ROOT_FOLDER_DROP_KEY
}

/** The subset of the media workspace the drop guards and commit path need. */
export interface MediaDndTarget {
  folders: CmsMediaFolder[]
  folderById: Map<string, CmsMediaFolder>
  moveAssetsToFolder: (assetIds: string[], targetFolderId: string | null) => Promise<void>
  moveFolder: (folderId: string, parentId: string | null) => Promise<CmsMediaFolder | null>
}

export function canMoveFolderTo(
  workspace: MediaDndTarget,
  folderId: string,
  targetFolderId: string | null,
): boolean {
  const folder = workspace.folderById.get(folderId)
  if (!folder) return false
  if (folderId === targetFolderId) return false
  if (folder.parentId === targetFolderId) return false
  if (targetFolderId && isFolderDescendant(workspace.folders, folderId, targetFolderId)) return false
  return true
}

export function canAcceptDrop(
  workspace: MediaDndTarget,
  payload: MediaDropPayload | null,
  targetFolderId: string | null,
): boolean {
  if (!payload) return true
  if (payload.kind === 'assets') return true
  return canMoveFolderTo(workspace, payload.folderId, targetFolderId)
}

export async function commitDropPayload(
  workspace: MediaDndTarget,
  payload: MediaDropPayload,
  targetFolderId: string | null,
): Promise<void> {
  if (payload.kind === 'assets') {
    await workspace.moveAssetsToFolder(payload.assetIds, targetFolderId)
    return
  }
  if (canMoveFolderTo(workspace, payload.folderId, targetFolderId)) {
    await workspace.moveFolder(payload.folderId, targetFolderId)
  }
}
