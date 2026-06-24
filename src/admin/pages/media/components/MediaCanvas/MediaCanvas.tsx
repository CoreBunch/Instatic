/**
 * MediaCanvas — the central file grid / list for the Media workspace.
 *
 * Owns the filter bar (search / type / view-mode), the asset grid, and the
 * empty / loading / error states. Bulk-select, drag-out, and keyboard
 * navigation land in M3/M4 — this component is the first interactive surface.
 */
import {
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { FileUpload } from '@ui/components/FileUpload'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { Select } from '@ui/components/Select'
import { Skeleton } from '@ui/components/Skeleton'
import {
  ExplorerItemContextMenu,
  ExplorerRenameDialog,
  type ExplorerContextMenuItem,
} from '@site/explorer-actions'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { cn } from '@ui/cn'
// Reuse the editor's canvas surface so the Media page matches Site / Content:
// rounded top-left, `--bg-surface-2` background. Keeps the look consistent.
import canvasStyles from '@site/canvas/CanvasRoot.module.css'
import type { CmsMediaAsset, CmsMediaFolder } from '@core/persistence/cmsMedia'
import type { MediaSort, MediaType } from '../../utils/filters'
import {
  FOLDER_ALL,
  FOLDER_TRASH,
  type UseMediaWorkspaceResult,
} from '../../hooks/useMediaWorkspace'
import { childFoldersForParent } from '../../utils/folderTree'
import {
  writeMediaAssetDragData,
  writeMediaFolderDragData,
} from '../../utils/mediaDragDrop'
import { useMediaDnd } from '../../hooks/useMediaDnd'
import styles from './MediaCanvas.module.css'
import {
  AssetRow,
  AssetTile,
  FolderRow,
  FolderTile,
  ParentFolderRow,
  ParentFolderTile,
  type ParentFolderEntry,
} from './MediaCanvasItems'

interface MediaCanvasProps {
  workspace: UseMediaWorkspaceResult
}

type ViewMode = 'list' | 'grid'

const VIEW_MODE_STORAGE_KEY = 'instatic-media-page-view-mode'

function readStoredViewMode(): ViewMode {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY)
    return raw === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function writeStoredViewMode(mode: ViewMode) {
  try {
    globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // best-effort UI persistence
  }
}

const TYPE_FILTERS: FilterBarItem<MediaType>[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'svg', label: 'SVG' },
  { value: 'video', label: 'Videos' },
  { value: 'other', label: 'Other' },
]

const SORT_OPTIONS: Array<{ value: MediaSort; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
  { value: 'smallest', label: 'Smallest' },
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
]

function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}

interface ContextMenuState {
  x: number
  y: number
  asset: CmsMediaAsset
}

function isMacLike(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
}

function folderAssetCount(assets: CmsMediaAsset[], folderId: string): number {
  return assets.filter((asset) => asset.folderIds.includes(folderId)).length
}

function folderItemMeta(folder: CmsMediaFolder, folders: CmsMediaFolder[], assets: CmsMediaAsset[]): string {
  const count = childFoldersForParent(folders, folder.id).length + folderAssetCount(assets, folder.id)
  return `${count} ${count === 1 ? 'item' : 'items'}`
}

function folderMatchesQuery(folder: CmsMediaFolder, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return folder.name.toLowerCase().includes(normalized)
}

export function MediaCanvas({ workspace }: MediaCanvasProps) {
  const [viewMode, setViewModeState] = useState<ViewMode>(readStoredViewMode)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<CmsMediaAsset | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dnd = useMediaDnd(workspace)

  function setViewMode(mode: ViewMode) {
    setViewModeState(mode)
    writeStoredViewMode(mode)
  }

  const trashView = workspace.folderSelection === FOLDER_TRASH
  const activeFolder = typeof workspace.folderSelection === 'string'
    ? workspace.folderById.get(workspace.folderSelection) ?? null
    : null
  const parentFolder = activeFolder?.parentId
    ? workspace.folderById.get(activeFolder.parentId) ?? null
    : null
  const parentEntry: ParentFolderEntry | null = activeFolder
    ? {
        label: activeFolder.parentId ? (parentFolder?.name ?? 'parent folder') : 'All files',
        targetFolderId: activeFolder.parentId,
        selection: activeFolder.parentId ?? FOLDER_ALL,
      }
    : null
  const folderEntriesVisible =
    !trashView &&
    workspace.filters.type === 'all' &&
    workspace.filters.tag.trim() === ''
  const childFolders = folderEntriesVisible
    ? childFoldersForParent(workspace.folders, activeFolder?.id ?? null)
      .filter((folder) => folderMatchesQuery(folder, workspace.filters.q))
    : []

  // Modifier-aware click dispatch:
  //   - plain click → set primary selection (collapses to one)
  //   - Cmd/Ctrl-click → toggle in/out of the multi-selection
  //   - Shift-click → range-select between the current primary and this row
  // Mirrors the convention every grid-style file manager (Finder, Explorer,
  // Photos, Drive, …) uses, so the muscle memory is free.
  function handleAssetClick(asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) {
    const meta = isMacLike() ? event.metaKey : event.ctrlKey
    if (event.shiftKey && workspace.selectedAssetId) {
      event.preventDefault()
      workspace.selectRange(workspace.selectedAssetId, asset.id)
      return
    }
    if (meta) {
      event.preventDefault()
      workspace.toggleAssetInSelection(asset.id)
      return
    }
    workspace.setSelectedAssetId(asset.id)
  }

  function handleAssetDragStart(asset: CmsMediaAsset, event: DragEvent<HTMLButtonElement>) {
    const selectedIds = Array.from(workspace.selectedAssetIds)
    const dragIds = workspace.selectedAssetIds.has(asset.id) && selectedIds.length > 0
      ? selectedIds
      : [asset.id]
    writeMediaAssetDragData(event.dataTransfer, dragIds)
  }

  function handleFolderDragStart(folder: CmsMediaFolder, event: DragEvent<HTMLButtonElement>) {
    writeMediaFolderDragData(event.dataTransfer, folder.id)
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return
    await workspace.uploadFiles(files)
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragActive(false)
    if (trashView) return
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) return
    await workspace.uploadFiles(files)
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (trashView) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDragActive(true)
  }
  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (trashView) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
  }
  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget === event.target) setDragActive(false)
  }

  function openContextMenu(asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ asset, x: event.clientX, y: event.clientY })
  }

  function openKeyboardContextMenu(asset: CmsMediaAsset, event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ asset, ...keyboardMenuPosition(event.currentTarget) })
  }

  async function copyAssetUrl(asset: CmsMediaAsset) {
    setContextMenu(null)
    if (!navigator.clipboard?.writeText) {
      console.warn('[MediaCanvas] clipboard unavailable; cannot copy URL')
      return
    }
    try {
      await navigator.clipboard.writeText(asset.publicPath)
    } catch (err) {
      console.error('[MediaCanvas] copy URL failed:', err)
    }
  }

  function buildExtraMenuItems(asset: CmsMediaAsset): ExplorerContextMenuItem[] {
    const items: ExplorerContextMenuItem[] = [
      {
        label: 'Copy URL',
        action: () => { void copyAssetUrl(asset) },
        icon: <Copy2SolidIcon size={13} />,
      },
    ]
    if (trashView) {
      items.unshift({
        label: 'Restore',
        action: () => {
          setContextMenu(null)
          void workspace.restoreAsset(asset.id)
        },
        icon: <CheckIcon size={13} />,
      })
    }
    return items
  }

  const visibleAssets = workspace.visibleAssets
  const contentMatching = visibleAssets.length + childFolders.length
  const showingTotal = workspace.assets.length + (trashView ? 0 : workspace.folders.length)
  const showingMatching = contentMatching + (parentEntry ? 1 : 0)

  // The big EmptyState below carries the message whenever `showingMatching === 0`,
  // so the status bar only narrates the non-empty cases (count, error).
  // While loading we leave the label empty — the canvas's own skeleton
  // (or the empty grid) carries the "loading" signal visually; doubling
  // it up with a text label is redundant.
  const headerLabel = (() => {
    if (workspace.loading) return null
    if (workspace.error) return workspace.error
    if (contentMatching === 0) return null
    return `${contentMatching} ${contentMatching === 1 ? 'item' : 'items'}`
  })()

  // Grid and list views render the same folders/assets with the same handlers —
  // only the tile-vs-row component set differs. Pick it once, render one block.
  const isGrid = viewMode === 'grid'
  const { Parent, Folder, Asset } = isGrid
    ? { Parent: ParentFolderTile, Folder: FolderTile, Asset: AssetTile }
    : { Parent: ParentFolderRow, Folder: FolderRow, Asset: AssetRow }

  return (
    <section
      className={cn(canvasStyles.canvas, styles.canvas, dragActive && styles.canvasDropping)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
      aria-label="Media library"
      data-testid="media-canvas"
    >
      <header className={styles.toolbar}>
        <FilterBar<MediaType>
          items={TYPE_FILTERS}
          value={workspace.filters.type}
          onValueChange={workspace.setFilterType}
          search={{
            value: workspace.filters.q,
            onValueChange: workspace.setQuery,
            onClear: () => workspace.setQuery(''),
            placeholder: 'Search media',
            ariaLabel: 'Search media',
          }}
          searchLeading={!trashView && (
            <FileUpload
              multiple
              onChange={(e) => void handleUpload(e)}
              buttonProps={{
                variant: 'primary',
                size: 'sm',
                'aria-label': 'Upload media',
              }}
            >
              <UploadIcon size={13} />
              <span>Upload</span>
            </FileUpload>
          )}
          groupLabel="Filter media type"
          trailing={(
            <div role="group" aria-label="Media view" className={styles.viewGroup}>
              <SortMenu
                value={workspace.filters.sort}
                onChange={workspace.setSort}
              />
              <Button
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                size="xs"
                iconOnly
                pressed={viewMode === 'list'}
                tooltip="List view"
                aria-label="List view"
                onClick={() => setViewMode('list')}
              >
                <BulletlistSolidIcon size={13} />
              </Button>
              <Button
                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                size="xs"
                iconOnly
                pressed={viewMode === 'grid'}
                tooltip="Grid view"
                aria-label="Grid view"
                onClick={() => setViewMode('grid')}
              >
                <Grid2x22SolidIcon size={13} />
              </Button>
            </div>
          )}
        />
      </header>

      {headerLabel !== null && (
        <div className={styles.statusBar} role="status" aria-live="polite">
          {headerLabel}
        </div>
      )}

      <div className={styles.body}>
        {workspace.loading && showingMatching === 0 ? (
          // Skeleton mirrors the actual `AssetTile` / `AssetRow`
          // layout 1:1 so the swap is silent:
          //   - Grid mode: square preview block + filename + size meta
          //   - List mode: small preview + filename + size meta
          // Each skeleton wraps in the same `.tileItem` / `.rowItem`
          // chrome so the grid track / row spacing matches the
          // populated state.
          isGrid ? (
            <ul
              className={styles.grid}
              role="list"
              aria-busy="true"
              aria-label="Loading media"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <li
                  key={`skeleton-tile-${i}`}
                  className={styles.tileItem}
                  aria-hidden="true"
                >
                  <span className={styles.tile}>
                    <span className={styles.tilePreview}>
                      <Skeleton width="100%" height="100%" />
                    </span>
                    <span className={styles.tileBody}>
                      <span className={styles.tileLabel}>
                        <Skeleton width={`${60 + (i % 4) * 10}%`} height={12} />
                      </span>
                      <span className={styles.tileMeta}>
                        <Skeleton width={48} height={10} />
                      </span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ul
              className={styles.list}
              role="list"
              aria-busy="true"
              aria-label="Loading media"
            >
              {Array.from({ length: 6 }, (_, i) => (
                <li
                  key={`skeleton-row-${i}`}
                  className={styles.rowItem}
                  aria-hidden="true"
                >
                  <span className={styles.row}>
                    <span className={styles.rowPreview}>
                      <Skeleton width="100%" height="100%" />
                    </span>
                    <span className={styles.rowLabel}>
                      <Skeleton width={`${50 + (i % 3) * 14}%`} height={12} />
                    </span>
                    <span className={styles.rowMeta}>
                      <Skeleton width={56} height={10} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : showingMatching === 0 ? (
          <EmptyState
            variant="centered"
            icon={<ImagesSolidIcon size={28} />}
            title={
              trashView
                ? 'Trash is empty'
                : showingTotal > 0
                  ? 'No matching media'
                  : 'No media yet'
            }
            description={
              trashView
                ? 'Soft-deleted assets show up here.'
                : showingTotal > 0
                  ? 'Try a different search or filter.'
                  : 'Drag files into this window or click Upload.'
            }
          />
        ) : (
          <ul
            className={isGrid ? styles.grid : styles.list}
            role="list"
            data-testid={isGrid ? 'media-grid' : 'media-list'}
          >
            {parentEntry && (
              <Parent
                entry={parentEntry}
                dropActive={dnd.isDropTarget(parentEntry.targetFolderId)}
                onOpen={() => workspace.setFolderSelection(parentEntry.selection)}
                onDragOver={dnd.handleDragOver}
                onDragLeave={dnd.handleDragLeave}
                onDrop={(event) => void dnd.handleDrop(event, parentEntry.targetFolderId)}
              />
            )}
            {childFolders.map((folder) => (
              <Folder
                key={folder.id}
                folder={folder}
                meta={folderItemMeta(folder, workspace.folders, workspace.assets)}
                dropActive={dnd.isDropTarget(folder.id)}
                onOpen={() => workspace.setFolderSelection(folder.id)}
                onDragStart={handleFolderDragStart}
                onDragOver={dnd.handleDragOver}
                onDragLeave={dnd.handleDragLeave}
                onDrop={(event) => void dnd.handleDrop(event, folder.id)}
              />
            ))}
            {visibleAssets.map((asset) => (
              <Asset
                key={asset.id}
                asset={asset}
                selected={workspace.selectedAssetIds.has(asset.id)}
                onSelect={(event) => handleAssetClick(asset, event)}
                onDragStart={handleAssetDragStart}
                onDragEnd={dnd.clearDropTarget}
                onContextMenu={openContextMenu}
                onKeyboardMenu={openKeyboardContextMenu}
              />
            ))}
          </ul>
        )}
      </div>

      {contextMenu && (
        <ExplorerItemContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Media item options"
          onClose={() => setContextMenu(null)}
          onRename={() => {
            setRenameTarget(contextMenu.asset)
            setContextMenu(null)
          }}
          onDelete={() => {
            const target = contextMenu.asset
            setContextMenu(null)
            if (trashView) void workspace.purgeAsset(target.id)
            else void workspace.trashAsset(target.id)
          }}
          extraItems={buildExtraMenuItems(contextMenu.asset)}
        />
      )}

      {renameTarget && (
        <ExplorerRenameDialog
          title="Rename media"
          fieldLabel="Name"
          initialValue={renameTarget.filename}
          onCancel={() => setRenameTarget(null)}
          onRename={async (payload) => {
            await workspace.renameAsset(renameTarget.id, payload.value)
            setRenameTarget(null)
          }}
        />
      )}
    </section>
  )
}

interface SortMenuProps {
  value: MediaSort
  onChange: (next: MediaSort) => void
}

function SortMenu({ value, onChange }: SortMenuProps) {
  return (
    <Select
      aria-label="Sort media"
      fieldSize="xs"
      value={value}
      onChange={(event) => onChange(event.target.value as MediaSort)}
      options={SORT_OPTIONS.map((option) => ({
        value: option.value,
        label: `Sort ${option.label}`,
        textValue: option.label,
      }))}
    />
  )
}
