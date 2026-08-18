/**
 * useStandaloneMediaEditor — build a `MediaAssetEditor` handle for callers
 * that aren't the Media page (e.g. the docked `MediaExplorerPanel` inside
 * Site/Content). Wraps the same `cmsMedia.ts` mutations the Media page uses
 * under the hood, then notifies the caller of every successful change so
 * its local list cache can stay in sync.
 *
 * The hook expects the caller to own:
 *   - `assets` — the list it already keeps for its grid (used to derive the
 *     tag palette).
 *   - `folders` — empty array is fine if the caller doesn't track folders
 *     yet; folder chip names just won't render.
 *   - `onAssetChanged(asset)` — called after every successful mutation so
 *     the caller replaces the asset in its local list.
 *   - `onAssetRemoved(id)` — called after a successful purge so the caller
 *     drops the row from its local list.
 */
import {
  deleteCmsMediaAsset,
  purgeCmsMediaAsset,
  renameCmsMediaAsset,
  replaceCmsMediaAssetFile,
  restoreCmsMediaAsset,
  updateCmsMediaAsset,
  type CmsMediaAsset,
  type CmsMediaFolder,
  type UpdateCmsMediaAssetInput,
} from '@core/persistence/cmsMedia'
import type { MediaAssetEditor } from '../components/MediaViewerWindow/MediaViewerWindow'
import { refreshCmsMediaAssetCache } from './useCmsMediaAssetByPath'

interface UseStandaloneMediaEditorOptions {
  asset: CmsMediaAsset | null
  assets: CmsMediaAsset[]
  folders?: CmsMediaFolder[]
  onAssetChanged: (asset: CmsMediaAsset) => void
  onAssetRemoved: (assetId: string) => void
}

export function useStandaloneMediaEditor({
  asset,
  assets,
  folders = [],
  onAssetChanged,
  onAssetRemoved,
}: UseStandaloneMediaEditorOptions): MediaAssetEditor | null {
  // Tag palette is derived from the caller's current list — cheaper than a
  // dedicated fetch and stays in sync with whatever they're showing.
  const tagPalette = (() => {
    const set = new Set<string>()
    for (const a of assets) for (const tag of a.tags) set.add(tag)
    return Array.from(set).sort()
  })()

  const folderById = (() => {
    const map = new Map<string, CmsMediaFolder>()
    for (const folder of folders) map.set(folder.id, folder)
    return map
  })()

  const updateAsset = async (id: string, input: UpdateCmsMediaAssetInput) => {
    try {
      const next = await updateCmsMediaAsset(id, input)
      onAssetChanged(next)
      // The editor canvas (`ImageEditor` / `useCmsMediaAssetByPath`)
      // keys its preview off the by-path cache — invalidate so the
      // just-saved alt text / metadata surface on next render.
      refreshCmsMediaAssetCache()
      return next
    } catch (err) {
      console.error('[useStandaloneMediaEditor] updateAsset failed:', err)
      return null
    }
  }

  const renameAsset = async (id: string, filename: string) => {
    try {
      const next = await renameCmsMediaAsset(id, filename)
      onAssetChanged(next)
      refreshCmsMediaAssetCache()
      return next
    } catch (err) {
      console.error('[useStandaloneMediaEditor] renameAsset failed:', err)
      return null
    }
  }

  const replaceAssetFile = async (id: string, file: File) => {
    try {
      const next = await replaceCmsMediaAssetFile(id, file)
      onAssetChanged(next)
      refreshCmsMediaAssetCache()
      return next
    } catch (err) {
      console.error('[useStandaloneMediaEditor] replaceAssetFile failed:', err)
      return null
    }
  }

  // A crop rebuilds the variant ladder, so the by-path cache MUST be
  // invalidated too — otherwise the canvas keeps rendering the previous
  // ladder's URLs, which the server has just swept off disk.
  const onAssetCropped = (next: CmsMediaAsset) => {
    onAssetChanged(next)
    refreshCmsMediaAssetCache()
  }

  const restoreAsset = async (id: string) => {
    try {
      const next = await restoreCmsMediaAsset(id)
      onAssetChanged(next)
      return next
    } catch (err) {
      console.error('[useStandaloneMediaEditor] restoreAsset failed:', err)
      return null
    }
  }

  const purgeAsset = async (id: string) => {
    try {
      // Purge requires the asset to already be soft-deleted server-side. The
      // standalone callers don't expose a Trash view, so they typically won't
      // call this — but if a deleted asset is ever surfaced, follow the
      // same pre-soft-delete → purge contract the Media page uses.
      const current = assets.find((a) => a.id === id) ?? null
      if (current && current.deletedAt === null) {
        await deleteCmsMediaAsset(id)
      }
      await purgeCmsMediaAsset(id)
      onAssetRemoved(id)
    } catch (err) {
      console.error('[useStandaloneMediaEditor] purgeAsset failed:', err)
    }
  }

  if (!asset) return null
  return {
    asset,
    tagPalette,
    folderById,
    updateAsset,
    renameAsset,
    replaceAssetFile,
    onAssetCropped,
    restoreAsset,
    purgeAsset,
  }
}
