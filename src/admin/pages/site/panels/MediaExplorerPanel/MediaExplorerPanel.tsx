import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useEditorStore } from '@site/store/store'
import { checkSizeLimit } from '@core/files/upload'
import {
  deleteCmsMediaAsset,
  listCmsMediaAssets,
  renameCmsMediaAsset,
  uploadCmsMediaAsset,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import { Panel, useAutoFocusPanel } from '@admin/shared/Panel'
import { Button } from '@ui/components/Button'
import { FileUpload } from '@ui/components/FileUpload'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import {
  ExplorerItemContextMenu,
  ExplorerRenameDialog,
  type ExplorerContextMenuItem,
  type ExplorerRenamePayload,
} from '@site/explorer-actions'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { useStandaloneMediaEditor } from '@admin/pages/media/hooks/useStandaloneMediaEditor'
import {
  BUCKET_LABELS,
  type MediaBucket,
  type MediaFilter,
  type MediaViewMode,
} from './mediaExplorerModel'
import {
  filterCmsMediaBuckets,
  groupCmsMediaAssets,
  keyboardMenuPosition,
  readStoredViewMode,
  targetBucket,
  writeStoredViewMode,
} from './mediaExplorerUtils'
import { MediaExplorerSection } from './MediaExplorerSection'
import { MediaExplorerItemList } from './MediaExplorerItem'
import styles from '../SiteExplorerPanel/SiteExplorerPanel.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface MediaExplorerPanelProps {
  variant?: 'docked' | 'tab'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

interface ContextMenuState {
  x: number
  y: number
  target: CmsMediaAsset
}

export function MediaExplorerPanel({
  variant = 'docked',
  open,
  onOpenChange,
}: MediaExplorerPanelProps) {
  const isOpen = open ?? variant === 'tab'
  const site = useEditorStore((s) => s.site)
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const activePageId = useEditorStore((s) => s.activePageId)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const [cmsAssets, setCmsAssets] = useState<CmsMediaAsset[]>([])
  // Single-asset viewer state. Replaces the old `openMediaAssetPreview`
  // store action which routed previews into the CodeEditorPanel. The new
  // viewer is the same MediaViewerWindow the Media page uses, so editing
  // (alt text, caption, tags, replace file, …) works identically here.
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null)
  const viewerAsset =
    cmsAssets.find((asset) => asset.id === viewerAssetId) ?? null
  const viewerEditor = useStandaloneMediaEditor({
    asset: viewerAsset,
    assets: cmsAssets,
    onAssetChanged: (asset) =>
      setCmsAssets((current) => current.map((item) => item.id === asset.id ? asset : item)),
    onAssetRemoved: (id) =>
      setCmsAssets((current) => current.filter((item) => item.id !== id)),
  })
  const openMediaAssetPreview = (asset: CmsMediaAsset) => {
    setViewerAssetId(asset.id)
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<CmsMediaAsset | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [viewMode, setViewModeState] = useState<MediaViewMode>(readStoredViewMode)
  const setViewMode = (mode: MediaViewMode) => {
    setViewModeState(mode)
    writeStoredViewMode(mode)
  }
  const panelRef = useRef<HTMLElement>(null)

  const cmsBuckets = groupCmsMediaAssets(cmsAssets)
  const visibleCmsBuckets = filterCmsMediaBuckets(
    cmsBuckets,
    mediaFilter,
    searchQuery,
  )
  const counts = visibleCmsBuckets
  const hasFilters = searchQuery.trim().length > 0 || mediaFilter !== 'all'
  const emptyLabel = mediaError ?? (hasFilters ? 'No matching media' : 'None yet')
  const selectedNode = (() => {
    if (!site || !activePageId || !selectedNodeId) return null
    const activePage = site.pages.find((page) => page.id === activePageId)
    return activePage?.nodes[selectedNodeId] ?? null
  })()

  function closePanel() {
    onOpenChange?.(false)
  }

  useAutoFocusPanel(panelRef, isOpen)

  useEffect(() => {
    if (!isOpen) return

    let canceled = false
    queueMicrotask(() => {
      if (!canceled) {
        setMediaLoading(true)
        setMediaError(null)
      }
    })
    listCmsMediaAssets()
      .then((assets) => {
        if (!canceled) setCmsAssets(assets)
      })
      .catch((err) => {
        if (!canceled) {
          setMediaError(getErrorMessage(err, 'Unable to load media'))
        }
      })
      .finally(() => {
        if (!canceled) setMediaLoading(false)
      })

    return () => {
      canceled = true
    }
  }, [isOpen])

  if (!isOpen) return null

  async function handleAssetUpload(e: ChangeEvent<HTMLInputElement>) {
    const pickedFiles = Array.from(e.target.files ?? [])
    e.target.value = ''

    for (const file of pickedFiles) {
      const sizeCheck = checkSizeLimit(file.size)
      if (!sizeCheck.ok) {
        console.warn('[MediaExplorerPanel] Upload rejected:', sizeCheck.message)
        continue
      }

      try {
        const asset = await uploadCmsMediaAsset(file)
        setCmsAssets((assets) => [asset, ...assets.filter((item) => item.id !== asset.id)])
      } catch (err) {
        console.error('[MediaExplorerPanel] upload asset error:', err)
      }
    }
  }

  function renderUploadAction() {
    return (
      <FileUpload
        multiple
        onChange={handleAssetUpload}
        buttonProps={{
          variant: 'ghost',
          size: 'xs',
          iconOnly: true,
          title: 'Upload media',
          'aria-label': 'Upload media',
        }}
      >
        <UploadIcon size={13} />
      </FileUpload>
    )
  }

  function openContextMenu(target: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, target })
  }

  function openKeyboardContextMenu(target: CmsMediaAsset, event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ ...keyboardMenuPosition(event.currentTarget), target })
  }

  async function handleRename(payload: ExplorerRenamePayload) {
    if (!renameTarget) return

    const asset = await renameCmsMediaAsset(renameTarget.id, payload.value)
    setCmsAssets((assets) => assets.map((item) => item.id === asset.id ? asset : item))
    // Viewer reads the asset by id from `cmsAssets`, so the rename surfaces
    // automatically — no separate openMediaAssetPreview re-trigger needed.
    setRenameTarget(null)
  }

  async function handleDelete(target: CmsMediaAsset) {
    setCmsAssets((assets) => assets.filter((item) => item.id !== target.id))
    if (viewerAssetId === target.id) {
      setViewerAssetId(null)
    }
    try {
      await deleteCmsMediaAsset(target.id)
    } catch (err) {
      setCmsAssets((assets) => [target, ...assets.filter((item) => item.id !== target.id)])
      setMediaError(getErrorMessage(err, 'Unable to delete media'))
      console.error('[MediaExplorerPanel] delete CMS media error:', err)
    }
    setContextMenu(null)
  }

  function applyTargetToSelectedModule(target: CmsMediaAsset) {
    if (!selectedNodeId || !selectedNode) return

    const publicPath = target.publicPath
    const bucket = targetBucket(target)
    if (selectedNode.moduleId === 'base.image' && bucket === 'images') {
      updateNodeProps(selectedNodeId, { src: publicPath })
    } else if (selectedNode.moduleId === 'base.video' && bucket === 'videos') {
      updateNodeProps(selectedNodeId, { videoUrl: publicPath })
    }
    setContextMenu(null)
  }

  async function copyTargetUrl(target: CmsMediaAsset) {
    setContextMenu(null)
    if (!navigator.clipboard?.writeText) {
      setMediaError('Clipboard is unavailable')
      return
    }

    try {
      await navigator.clipboard.writeText(target.publicPath)
    } catch (err) {
      setMediaError('Unable to copy media URL')
      console.error('[MediaExplorerPanel] copy media URL error:', err)
    }
  }

  function contextMenuItems(target: CmsMediaAsset): ExplorerContextMenuItem[] {
    const items: ExplorerContextMenuItem[] = []
    const bucket = targetBucket(target)

    if (selectedNode?.moduleId === 'base.image' && bucket === 'images') {
      items.push({
        label: 'Use in selected image',
        action: () => applyTargetToSelectedModule(target),
        icon: <CheckIcon size={13} />,
      })
    } else if (selectedNode?.moduleId === 'base.video' && bucket === 'videos') {
      items.push({
        label: 'Use in selected video',
        action: () => applyTargetToSelectedModule(target),
        icon: <CheckIcon size={13} />,
      })
    }

    items.push({
      label: 'Copy URL',
      action: () => { void copyTargetUrl(target) },
      icon: <Copy2SolidIcon size={13} />,
    })

    return items
  }

  function shouldShowBucket(bucket: MediaBucket) {
    return mediaFilter === 'all' || mediaFilter === bucket
  }

  return (
    <>
      <Panel
        ref={panelRef}
        panelId="media-explorer"
        title="Media"
        ariaLabel="Media Explorer"
        testId="media-explorer-panel"
        headerless={variant === 'tab'}
        onClose={closePanel}
      >
        <FilterBar<MediaFilter>
          items={(['all', 'images', 'videos'] as MediaFilter[]).map<FilterBarItem<MediaFilter>>((filter) => ({
            value: filter,
            label: filter === 'all' ? 'All' : BUCKET_LABELS[filter],
          }))}
          value={mediaFilter}
          onValueChange={setMediaFilter}
          search={{
            value: searchQuery,
            onValueChange: setSearchQuery,
            onClear: () => setSearchQuery(''),
            placeholder: 'Search media',
            ariaLabel: 'Search media',
          }}
          groupLabel="Filter media type"
          trailing={
            <div role="group" aria-label="Media view" className={styles.mediaViewGroup}>
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
          }
        />

        {shouldShowBucket('images') && (
          <MediaExplorerSection
            title="Images"
            bucket="images"
            viewMode={viewMode}
            count={counts.images.length}
            loading={mediaLoading}
            emptyLabel={emptyLabel}
            uploadAction={renderUploadAction()}
          >
            <MediaExplorerItemList
              assets={visibleCmsBuckets.images}
              bucket="images"
              viewMode={viewMode}
              onOpen={openMediaAssetPreview}
              onContextMenu={openContextMenu}
              onKeyDown={openKeyboardContextMenu}
            />
          </MediaExplorerSection>
        )}

        {shouldShowBucket('videos') && (
          <MediaExplorerSection
            title="Videos"
            bucket="videos"
            viewMode={viewMode}
            count={counts.videos.length}
            loading={mediaLoading}
            emptyLabel={emptyLabel}
            uploadAction={renderUploadAction()}
          >
            <MediaExplorerItemList
              assets={visibleCmsBuckets.videos}
              bucket="videos"
              viewMode={viewMode}
              onOpen={openMediaAssetPreview}
              onContextMenu={openContextMenu}
              onKeyDown={openKeyboardContextMenu}
            />
          </MediaExplorerSection>
        )}
      </Panel>

      {contextMenu && (
        <ExplorerItemContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Media item options"
          onClose={() => setContextMenu(null)}
          onRename={() => {
            setRenameTarget(contextMenu.target)
            setContextMenu(null)
          }}
          onDelete={() => { void handleDelete(contextMenu.target) }}
          extraItems={contextMenuItems(contextMenu.target)}
        />
      )}

      {renameTarget && (
        <ExplorerRenameDialog
          title="Rename media"
          fieldLabel="Name"
          initialValue={renameTarget.filename}
          onCancel={() => setRenameTarget(null)}
          onRename={handleRename}
        />
      )}

      <MediaViewerWindow
        editor={viewerEditor}
        open={viewerAsset !== null}
        onClose={() => setViewerAssetId(null)}
      />
    </>
  )
}
