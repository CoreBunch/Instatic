/**
 * MediaPage — the dedicated Media workspace.
 *
 * Canvas-style admin shell through AdminWorkspaceCanvasLayout. Folder tree in
 * the left sidebar, file grid/list in the canvas. Every interactive overlay —
 * the asset viewer, the upload queue, the bulk-edit pane — is a floating
 * window (per design: no docked right rail on this page).
 *
 * Window visibility lives in local state here; `useDraggablePanel` only owns
 * each window's POSITION via `workspaceLayoutStorage`. The upload queue
 * auto-opens when something starts uploading; the bulk-edit window
 * auto-opens once the user has 2+ assets selected; the viewer opens whenever
 * the user has a primary selection.
 */
import { useEffect, useState } from 'react'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout'
import {
  readWorkspaceLayout,
  writeWorkspaceLayout,
} from '@admin/state/workspaceLayoutStorage'
import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { MediaSidebar, type MediaSidebarPanelId } from './components/MediaSidebar/MediaSidebar'
import { MediaCanvas } from './components/MediaCanvas/MediaCanvas'
import { MediaViewerWindow } from './components/MediaViewerWindow/MediaViewerWindow'
import { UploadQueueWindow } from './components/UploadQueueWindow/UploadQueueWindow'
import { UnsplashPicker } from './components/UnsplashPicker'
import { useUnsplashConfigured } from './hooks/useUnsplashConfigured'
import { BulkEditWindow } from './components/BulkEditWindow/BulkEditWindow'
import { useMediaWorkspace } from './hooks/useMediaWorkspace'

const MEDIA_PANEL_IDS: ReadonlySet<MediaSidebarPanelId> = new Set(['folders', 'storage'])

function readPersistedMediaPanel(): MediaSidebarPanelId | null {
  const stored = readWorkspaceLayout('media').activeLeftPanel
  if (stored === null) return null
  if (typeof stored === 'string' && MEDIA_PANEL_IDS.has(stored as MediaSidebarPanelId)) {
    return stored as MediaSidebarPanelId
  }
  return 'folders'
}

export function MediaPage() {
  const workspace = useMediaWorkspace()
  // Initial value pulls from the per-workspace stored layout so the rail
  // remembers the last panel the user had open in the Media workspace.
  const [activePanel, setActivePanel] = useState<MediaSidebarPanelId | null>(
    readPersistedMediaPanel,
  )
  // Persist rail toggles so the next visit to /admin/media reopens the same
  // panel (or stays closed if the user closed it).
  useEffect(() => {
    writeWorkspaceLayout('media', { activeLeftPanel: activePanel })
  }, [activePanel])
  const [uploadQueueOpen, setUploadQueueOpen] = useState(false)
  const [unsplashOpen, setUnsplashOpen] = useState(false)
  const unsplashConfigured = useUnsplashConfigured()

  // Build the thin viewer-editor handle from the workspace. Same contract the
  // standalone MediaExplorerPanel-driven viewer uses, so the viewer doesn't
  // need to know it lives inside the full Media page.
  const viewerEditor = workspace.selectedAsset
    ? {
        asset: workspace.selectedAsset,
        tagPalette: workspace.tagPalette,
        folderById: workspace.folderById,
        updateAsset: workspace.updateAsset,
        renameAsset: workspace.renameAsset,
        replaceAssetFile: workspace.replaceAssetFile,
        onAssetCropped: workspace.onAssetCropped,
        restoreAsset: workspace.restoreAsset,
        purgeAsset: workspace.purgeAsset,
      }
    : null

  // Viewer and Bulk Edit visibility derive directly from the current
  // selection — there is no independent "open" state because every close
  // path also clears the selection ("closed" ≡ "no selection"). Deriving
  // during render instead of syncing via an effect avoids the extra render
  // commit (no-chain-state-updates) and the one-frame open lag.
  //   - Viewer: a single primary selection (≤ 1 item) is showing.
  //   - Bulk Edit: a 2+ multi-selection is in flight (mutually exclusive
  //     with the viewer).
  const viewerOpen =
    workspace.selectedAssetId !== null && workspace.selectedAssetIds.size <= 1
  const bulkEditOpen = workspace.selectedAssetIds.size >= 2

  // The upload queue IS genuinely stateful — it stays open after a transfer
  // completes (the user dismisses it) and the toolbar button toggles it — so
  // it can't be derived. Auto-opening on the async upload transition is the
  // legitimate "sync UI to an external async system" use of an effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (workspace.uploadQueue.active && !uploadQueueOpen) {
      setUploadQueueOpen(true)
    }
  }, [workspace.uploadQueue.active, uploadQueueOpen])
  /* eslint-enable react-hooks/set-state-in-effect */

  const toolbarRightSlot = (
    <>
      {unsplashConfigured && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setUnsplashOpen(true)}
          aria-label="Add a photo from Unsplash"
          tooltip="Browse Unsplash and import a photo into this library"
        >
          <ImagesSolidIcon size={13} />
          <span>Unsplash</span>
        </Button>
      )}
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setUploadQueueOpen((open) => !open)}
      aria-label="Toggle upload queue"
      pressed={uploadQueueOpen}
    >
      <UploadIcon size={13} />
      <span>Uploads</span>
      {workspace.uploadQueue.active && (
        <span aria-hidden="true" style={{ marginLeft: 4 }}>·</span>
      )}
    </Button>
    </>
  )

  return (
    <>
      <AdminWorkspaceCanvasLayout
        workspace="media"
        toolbarRightSlot={toolbarRightSlot}
        contentSidebar={(
          <MediaSidebar
            workspace={workspace}
            activePanel={activePanel}
            onActivePanelChange={setActivePanel}
          />
        )}
        contentCanvas={<MediaCanvas workspace={workspace} />}
        // No `contentRightPanel` — the asset inspector is a window now.
      />

      <MediaViewerWindow
        editor={viewerEditor}
        open={viewerOpen}
        onClose={() => workspace.clearSelection()}
      />

      <UnsplashPicker
        open={unsplashOpen}
        onClose={() => setUnsplashOpen(false)}
        onImported={() => void workspace.refresh()}
      />

      <UploadQueueWindow
        queue={workspace.uploadQueue}
        open={uploadQueueOpen}
        onClose={() => setUploadQueueOpen(false)}
      />

      <BulkEditWindow
        workspace={workspace}
        open={bulkEditOpen}
        onClose={() => workspace.clearSelection()}
      />
    </>
  )
}
