/**
 * useMediaWorkspace — the single source of truth for the Media page UI.
 *
 * Owns:
 *   - The asset list (active or trashed, never both — the panel selection
 *     drives which active/trash set is loaded).
 *   - The folder list + tree.
 *   - The current folder selection (regular folder id, `'__all__'` sentinel
 *     for the global "All files" view, `'__trash__'` for the Trash view).
 *   - The selected asset id (for the inspector).
 *   - The filter + sort + search state.
 *   - All async mutations (upload, rename, soft-delete, restore, purge,
 *     metadata patch, folder assignment, folder CRUD).
 *
 * Keeps the MediaPage / MediaSidebar / MediaCanvas / MediaViewerWindow
 * dumb: each one renders what this hook exposes and calls a method on the
 * returned object to mutate. No prop-drilling tangles.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createCmsMediaFolder,
  deleteCmsMediaAsset,
  deleteCmsMediaFolder,
  listCmsMediaAssets,
  listCmsMediaFolders,
  normalizeCmsMediaAsset,
  purgeCmsMediaAsset,
  renameCmsMediaAsset,
  replaceCmsMediaAssetFile,
  restoreCmsMediaAsset,
  setCmsMediaAssetFolders,
  updateCmsMediaAsset,
  updateCmsMediaFolder,
  type CmsMediaAsset,
  type CmsMediaFolder,
  type UpdateCmsMediaAssetInput,
} from '@core/persistence/cmsMedia'
import { buildFolderTree, type MediaFolderNode } from '../utils/folderTree'
import { collectMediaTags, filterMediaAssets, type MediaFilters, type MediaSort, type MediaType } from '../utils/filters'
import { useUploadQueue, type UseUploadQueueResult } from './useUploadQueue'
import { primeCmsMediaAssetCache, refreshCmsMediaAssetCache } from './useCmsMediaAssetByPath'
import type { WorkspaceLoadState } from '@admin/lib/workspaceLoadState'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  isSmartFolderId,
  smartFolderPredicate,
  type SmartFolderId,
} from '../utils/smartFolders'

/**
 * Sentinel folder ids used in the sidebar selection state. Real folder ids
 * are nanoids — these strings won't collide.
 */
export const FOLDER_ALL = '__all__' as const
export const FOLDER_TRASH = '__trash__' as const

export type FolderSelection =
  | string
  | typeof FOLDER_ALL
  | typeof FOLDER_TRASH
  | SmartFolderId

export interface UseMediaWorkspaceResult extends WorkspaceLoadState {
  // Async state (loading / error come from WorkspaceLoadState)
  clearError: () => void
  refresh: () => Promise<void>

  // Data
  folders: CmsMediaFolder[]
  folderTree: MediaFolderNode[]
  folderById: Map<string, CmsMediaFolder>

  assets: CmsMediaAsset[]
  visibleAssets: CmsMediaAsset[]
  tagPalette: string[]

  // Selection
  folderSelection: FolderSelection
  setFolderSelection: (selection: FolderSelection) => void
  /** Primary selected asset. Drives the inspector. */
  selectedAssetId: string | null
  selectedAsset: CmsMediaAsset | null
  setSelectedAssetId: (id: string | null) => void
  /** Multi-selection used by bulk-edit. Always includes `selectedAssetId`. */
  selectedAssetIds: ReadonlySet<string>
  selectedAssets: CmsMediaAsset[]
  toggleAssetInSelection: (id: string) => void
  addToSelection: (ids: string[]) => void
  selectRange: (anchorId: string, targetId: string) => void
  clearSelection: () => void

  // Upload queue
  uploadQueue: UseUploadQueueResult

  // Filters
  filters: { type: MediaType; q: string; tag: string; sort: MediaSort }
  setFilterType: (type: MediaType) => void
  setQuery: (q: string) => void
  setTag: (tag: string) => void
  setSort: (sort: MediaSort) => void

  // Mutations — assets
  uploadFiles: (files: File[]) => Promise<void>
  renameAsset: (assetId: string, filename: string) => Promise<CmsMediaAsset | null>
  updateAsset: (assetId: string, input: UpdateCmsMediaAssetInput) => Promise<CmsMediaAsset | null>
  replaceAssetFile: (assetId: string, file: File) => Promise<CmsMediaAsset | null>
  trashAsset: (assetId: string) => Promise<void>
  restoreAsset: (assetId: string) => Promise<CmsMediaAsset | null>
  purgeAsset: (assetId: string) => Promise<void>
  setAssetFolders: (
    assetId: string,
    input: { add?: string[]; remove?: string[] },
  ) => Promise<CmsMediaAsset | null>
  moveAssetsToFolder: (assetIds: string[], targetFolderId: string | null) => Promise<void>

  // Mutations — folders
  createFolder: (name: string, parentId: string | null) => Promise<CmsMediaFolder | null>
  renameFolder: (folderId: string, name: string) => Promise<CmsMediaFolder | null>
  moveFolder: (folderId: string, parentId: string | null) => Promise<CmsMediaFolder | null>
  deleteFolder: (folderId: string) => Promise<void>
}

export function useMediaWorkspace(): UseMediaWorkspaceResult {
  const [folders, setFolders] = useState<CmsMediaFolder[]>([])
  const [assets, setAssets] = useState<CmsMediaAsset[]>([])
  // Start in `loading: true` so the canvas renders its skeleton on
  // first mount — without this the empty `assets` array would flash
  // the "No media yet" empty state for the duration of the first
  // round-trip, which reads like a fresh-install empty library.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [folderSelection, setFolderSelectionState] = useState<FolderSelection>(FOLDER_ALL)
  const [selectedAssetId, setSelectedAssetIdState] = useState<string | null>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(() => new Set())
  const [filterType, setFilterType] = useState<MediaType>('all')
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [sort, setSort] = useState<MediaSort>('newest')

  // Pure expression so the React Compiler memoizes it keyed on `folders` —
  // the previous pre-declared-then-mutated Map defeated auto-memoization and
  // rebuilt on every render.
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))

  const folderTree = buildFolderTree(folders)

  // Selecting Trash flips the asset query into `?trash=1` mode. Anything else
  // — All / a real folder id / a smart folder — loads the active set.
  // Kept memoized: `refresh` is referenced in a useEffect dependency array
  // below, so it must keep a stable identity to satisfy exhaustive-deps
  // (the static lint rule can't see the React Compiler's runtime memoization).
  const loadAssets = useCallback(async (selection: FolderSelection): Promise<CmsMediaAsset[]> => {
    return listCmsMediaAssets({ trash: selection === FOLDER_TRASH })
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextFolders, nextAssets] = await Promise.all([
        listCmsMediaFolders(),
        loadAssets(folderSelection),
      ])
      setFolders(nextFolders)
      setAssets(nextAssets)
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to load media library'))
    } finally {
      setLoading(false)
    }
  }, [folderSelection, loadAssets])

  // Initial + folder-selection-driven reload. `refresh` calls setState (loading
  // → data → loading off), which the React 19 lint rule guards against — same
  // shape as `useContentEntryDraft` uses with the same disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void refresh()
  }, [refresh])
  /* eslint-enable react-hooks/set-state-in-effect */

  const setFolderSelection = (selection: FolderSelection) => {
    // Clear the inspector AND multi-selection when switching folder context —
    // the previous selection's asset may no longer be visible in the new view.
    setSelectedAssetIdState(null)
    setSelectedAssetIds(new Set())
    setFolderSelectionState(selection)
  }

  // Setting the primary asset implicitly collapses the multi-selection to that
  // single item. Use `toggleAssetInSelection` / `selectRange` to keep both in
  // sync when the user shift/cmd-clicks.
  const setSelectedAssetId = (id: string | null) => {
    setSelectedAssetIdState(id)
    setSelectedAssetIds(id ? new Set([id]) : new Set())
  }

  const toggleAssetInSelection = (id: string) => {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectedAssetIdState(id)
  }

  const addToSelection = (ids: string[]) => {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    if (ids.length > 0) setSelectedAssetIdState(ids[ids.length - 1])
  }

  const clearSelection = () => {
    setSelectedAssetIdState(null)
    setSelectedAssetIds(new Set())
  }

  // Smart folders and All files are global library views, so they don't filter
  // by folder id. Concrete folders keep filtering by their folder id. Smart
  // folder predicates apply AFTER the standard filter pass so things like the
  // type chip + the search box still work inside a smart-folder view.
  const isSmartFolder = isSmartFolderId(folderSelection)
  const filterFolder: MediaFilters['folderId'] =
    isSmartFolder || folderSelection === FOLDER_TRASH || folderSelection === FOLDER_ALL
      ? undefined
      : folderSelection
  const filteredAssets = filterMediaAssets(assets, {
    folderId: filterFolder,
    type: filterType,
    q: query,
    tag,
    sort,
  })
  const visibleAssets = isSmartFolder
    ? filteredAssets.filter(smartFolderPredicate(folderSelection))
    : filteredAssets

  // Mirror the latest computed list into a ref so `selectRange` can read the
  // current canvas order without re-deriving the filter in the callback. The
  // effect (not render) updates the ref — the React 19 compiler refuses ref
  // writes inside useMemo / render bodies.
  useEffect(() => {
    visibleAssetsRef.current = visibleAssets
  }, [visibleAssets])

  const tagPalette = collectMediaTags(assets)

  const selectedAsset = selectedAssetId
    ? assets.find((asset) => asset.id === selectedAssetId) ?? null
    : null

  const selectedAssets = assets.filter((asset) => selectedAssetIds.has(asset.id))

  // Range select — shift-click between two anchors in the visible canvas
  // order, so the user-visible range matches what they actually see.
  const visibleAssetsRef = useRef<CmsMediaAsset[]>([])
  const selectRange = (anchorId: string, targetId: string) => {
    const list = visibleAssetsRef.current
    const anchorIdx = list.findIndex((a: CmsMediaAsset) => a.id === anchorId)
    const targetIdx = list.findIndex((a: CmsMediaAsset) => a.id === targetId)
    if (anchorIdx === -1 || targetIdx === -1) {
      setSelectedAssetIdState(targetId)
      setSelectedAssetIds((prev) => {
        const next = new Set(prev)
        next.add(targetId)
        return next
      })
      return
    }
    const start = Math.min(anchorIdx, targetIdx)
    const end = Math.max(anchorIdx, targetIdx)
    const range = list.slice(start, end + 1).map((a: CmsMediaAsset) => a.id)
    setSelectedAssetIds((prev) => {
      const next = new Set(prev)
      for (const id of range) next.add(id)
      return next
    })
    setSelectedAssetIdState(targetId)
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────
  // Each mutation updates the local cache optimistically (when safe) so the UI
  // feels instant; on server reject we surface the error and reload to recover.

  // Shared mutation envelope: clear the error, run the op, and on throw surface
  // the failure under `label` (the cache update lives inside `fn`). Returns the
  // op's value, or null on failure — so every mutation collapses to one call
  // instead of re-implementing the setError(null)/try/catch dance. Genuinely
  // different flows (moveAssetsToFolder, which reloads on error) stay bespoke.
  const assetMut = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(getErrorMessage(err, label))
      return null
    }
  }

  const replaceAsset = (next: CmsMediaAsset) => {
    setAssets((current) => current.map((asset) => asset.id === next.id ? next : asset))
  }

  const removeAsset = (assetId: string) => {
    setAssets((current) => current.filter((asset) => asset.id !== assetId))
    setSelectedAssetIdState((current) => current === assetId ? null : current)
    setSelectedAssetIds((current) => {
      if (!current.has(assetId)) return current
      const next = new Set(current)
      next.delete(assetId)
      return next
    })
  }

  // Splice an uploaded asset into the workspace cache when the queue
  // reports success. Folder assignment (if any) happens inside the queue.
  // Also seed the shared by-path cache so the editor canvas
  // (`ImageEditor` / `useCmsMediaAssetByPath`) picks up the new asset
  // immediately without racing a follow-up list request.
  const onUploaded = (asset: CmsMediaAsset) => {
    setAssets((current) => [asset, ...current.filter((existing) => existing.id !== asset.id)])
    primeCmsMediaAssetCache(asset)
  }

  const uploadQueue = useUploadQueue({
    normalize: normalizeCmsMediaAsset,
    onUploaded,
  })

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    setError(null)
    const targetFolder =
      typeof folderSelection === 'string' &&
      folderSelection !== FOLDER_ALL &&
      folderSelection !== FOLDER_TRASH &&
      !isSmartFolderId(folderSelection)
        ? folderSelection
        : null
    uploadQueue.enqueue(files, targetFolder)
  }

  const renameAsset = (assetId: string, filename: string) =>
    assetMut('Could not rename asset', async () => {
      const next = await renameCmsMediaAsset(assetId, filename)
      replaceAsset(next)
      return next
    })

  const updateAsset = (assetId: string, input: UpdateCmsMediaAssetInput) =>
    assetMut('Could not update asset', async () => {
      const next = await updateCmsMediaAsset(assetId, input)
      replaceAsset(next)
      // Metadata edits (alt text especially) feed the canvas preview's
      // library-alt fallback — keep the cache in sync so the next render
      // shows the just-saved value instead of the stale row.
      refreshCmsMediaAssetCache()
      return next
    })

  const replaceAssetFile = (assetId: string, file: File) =>
    assetMut('Could not replace file', async () => {
      const next = await replaceCmsMediaAssetFile(assetId, file)
      replaceAsset(next)
      // Variants / blurhash / dimensions all change on replace — invalidate
      // the by-path cache so editor previews (which key on publicPath) drop
      // their stale rows on next render.
      refreshCmsMediaAssetCache()
      return next
    })

  const trashAsset = async (assetId: string): Promise<void> => {
    await assetMut('Could not move asset to trash', async () => {
      // Soft-delete moves the asset out of the active list view; the response
      // carries the soft-deleted row but we never want it in the active set,
      // so just remove it from `assets`. Switching to the Trash panel will
      // reload from the server.
      await deleteCmsMediaAsset(assetId)
      removeAsset(assetId)
    })
  }

  const restoreAsset = (assetId: string) =>
    assetMut('Could not restore asset', async () => {
      await restoreCmsMediaAsset(assetId)
      // The asset is now active; if we're on the Trash view, remove it from
      // the visible list. The next active-view load picks it back up.
      removeAsset(assetId)
      return null
    })

  const purgeAsset = async (assetId: string): Promise<void> => {
    await assetMut('Could not delete asset permanently', async () => {
      await purgeCmsMediaAsset(assetId)
      removeAsset(assetId)
    })
  }

  const setAssetFolders = (
    assetId: string,
    input: { add?: string[]; remove?: string[] },
  ) =>
    assetMut('Could not update folders', async () => {
      const next = await setCmsMediaAssetFolders(assetId, input)
      replaceAsset(next)
      return next
    })

  const moveAssetsToFolder = async (assetIds: string[], targetFolderId: string | null) => {
    const uniqueIds = Array.from(new Set(assetIds.map((id) => id.trim()).filter(Boolean)))
    if (uniqueIds.length === 0) return

    setError(null)
    try {
      const assetById = new Map(assets.map((asset) => [asset.id, asset]))
      const moved = await Promise.all(uniqueIds.map(async (assetId) => {
        const existing = assetById.get(assetId) ?? null
        const currentFolderIds = existing?.folderIds ?? []
        const remove = currentFolderIds.filter((folderId) => folderId !== targetFolderId)
        const add = targetFolderId && !currentFolderIds.includes(targetFolderId)
          ? [targetFolderId]
          : []

        if (remove.length === 0 && add.length === 0) return existing
        return setCmsMediaAssetFolders(assetId, { add, remove })
      }))
      const movedById = new Map(
        moved
          .filter((asset): asset is CmsMediaAsset => asset !== null)
          .map((asset) => [asset.id, asset]),
      )
      if (movedById.size > 0) {
        setAssets((current) => current.map((asset) => movedById.get(asset.id) ?? asset))
        refreshCmsMediaAssetCache()
      }
      setSelectedAssetIdState((current) => (current && uniqueIds.includes(current) ? null : current))
      setSelectedAssetIds((current) => {
        const next = new Set(current)
        for (const id of uniqueIds) next.delete(id)
        return next
      })
    } catch (err) {
      setError(getErrorMessage(err, 'Could not move assets'))
      void refresh()
    }
  }

  // ── Folder mutations ───────────────────────────────────────────────────────

  const createFolder = (name: string, parentId: string | null) =>
    assetMut('Could not create folder', async () => {
      const folder = await createCmsMediaFolder({ name, parentId })
      setFolders((current) => [...current, folder])
      return folder
    })

  const replaceFolder = (next: CmsMediaFolder) => {
    setFolders((current) => current.map((folder) => folder.id === next.id ? next : folder))
  }

  const renameFolder = (folderId: string, name: string) =>
    assetMut('Could not rename folder', async () => {
      const next = await updateCmsMediaFolder(folderId, { name })
      replaceFolder(next)
      return next
    })

  const moveFolder = (folderId: string, parentId: string | null) =>
    assetMut('Could not move folder', async () => {
      const next = await updateCmsMediaFolder(folderId, { parentId })
      replaceFolder(next)
      return next
    })

  const deleteFolder = async (folderId: string): Promise<void> => {
    await assetMut('Could not delete folder', async () => {
      await deleteCmsMediaFolder(folderId)
      setFolders((current) => current.filter((folder) => folder.id !== folderId))
      // Deleting a folder unassigns every asset in it (via FK cascade). Reload
      // so the asset folder_ids reflect the new reality without a stale UI.
      void refresh()
      if (folderSelection === folderId) setFolderSelectionState(FOLDER_ALL)
    })
  }

  return {
    loading,
    error,
    clearError: () => setError(null),
    refresh,
    folders,
    folderTree,
    folderById,
    assets,
    visibleAssets,
    tagPalette,
    folderSelection,
    setFolderSelection,
    selectedAssetId,
    selectedAsset,
    setSelectedAssetId,
    selectedAssetIds,
    selectedAssets,
    toggleAssetInSelection,
    addToSelection,
    selectRange,
    clearSelection,
    uploadQueue,
    filters: { type: filterType, q: query, tag, sort },
    setFilterType,
    setQuery,
    setTag,
    setSort,
    uploadFiles,
    renameAsset,
    updateAsset,
    replaceAssetFile,
    trashAsset,
    restoreAsset,
    purgeAsset,
    setAssetFolders,
    moveAssetsToFolder,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
  }
}
