import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MediaCanvas } from '@admin/pages/media/components/MediaCanvas/MediaCanvas'
import { MediaFolderPanel } from '@admin/pages/media/components/MediaFolderPanel/MediaFolderPanel'
import { AdminSessionProvider } from '@admin/session'
import {
  FOLDER_ALL,
  type FolderSelection,
  type UseMediaWorkspaceResult,
  useMediaWorkspace,
} from '@admin/pages/media/hooks/useMediaWorkspace'
import { buildFolderTree } from '@admin/pages/media/utils/folderTree'
import { MEDIA_ASSET_DRAG_TYPE } from '@admin/pages/media/utils/mediaDragDrop'
import type { CoreCapability } from '@core/capabilities'
import type { CmsCurrentUser } from '@core/persistence'
import type { CmsMediaAsset, CmsMediaFolder } from '@core/persistence/cmsMedia'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

function asset(overrides: Partial<CmsMediaAsset> = {}): CmsMediaAsset {
  return {
    id: 'asset_1',
    filename: 'logo.png',
    mimeType: 'image/png',
    sizeBytes: 1200,
    publicPath: '/uploads/logo.png',
    uploadedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    altText: '',
    caption: '',
    title: '',
    tags: [],
    width: null,
    height: null,
    durationMs: null,
    dominantColor: null,
    deletedAt: null,
    replacedAt: null,
    folderIds: [],
    blurHash: null,
    variants: [],
    posterPath: null,
    ...overrides,
  }
}

function folder(overrides: Partial<CmsMediaFolder> = {}): CmsMediaFolder {
  return {
    id: 'folder_assets',
    parentId: null,
    name: 'assets',
    slug: 'assets',
    sortOrder: 0,
    createdByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function createDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  const transfer = {
    files: [] as unknown as FileList,
    types: [] as string[],
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) {
      data.set(type, value)
      if (!this.types.includes(type)) this.types.push(type)
    },
    getData(type: string) {
      return data.get(type) ?? ''
    },
    clearData(type?: string) {
      if (type) {
        data.delete(type)
        this.types = this.types.filter((entry) => entry !== type)
        return
      }
      data.clear()
      this.types = []
    },
    setDragImage() {},
  }
  return transfer as unknown as DataTransfer
}

function transferWithAssets(assetIds: string[]): DataTransfer {
  const transfer = createDataTransfer()
  transfer.setData(MEDIA_ASSET_DRAG_TYPE, JSON.stringify({ assetIds }))
  return transfer
}

const MEDIA_MANAGER_CAPABILITIES: CoreCapability[] = [
  'media.read',
  'media.write',
  'media.replace',
  'media.delete',
]

function currentUser(capabilities: CoreCapability[] = MEDIA_MANAGER_CAPABILITIES): CmsCurrentUser {
  return {
    id: 'user_media_manager',
    email: 'media-manager@example.com',
    displayName: 'Media Manager',
    status: 'active',
    role: {
      id: 'role_media_manager',
      slug: 'media-manager',
      name: 'Media Manager',
      description: 'Media test role',
      isSystem: false,
      capabilities,
    },
    capabilities,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'password',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function renderWithMediaSession(ui: ReactElement) {
  return render(
    <AdminSessionProvider user={currentUser()}>
      {ui}
    </AdminSessionProvider>,
  )
}

function workspace(overrides: Partial<UseMediaWorkspaceResult> = {}): UseMediaWorkspaceResult {
  const folders = overrides.folders ?? []
  const assets = overrides.assets ?? []
  const folderSelection = overrides.folderSelection ?? FOLDER_ALL
  return {
    loading: false,
    error: null,
    clearError: () => {},
    refresh: async () => {},
    folders,
    folderTree: buildFolderTree(folders),
    folderById: new Map(folders.map((entry) => [entry.id, entry])),
    assets,
    visibleAssets: overrides.visibleAssets ?? assets,
    tagPalette: [],
    folderSelection,
    setFolderSelection: () => {},
    selectedAssetId: null,
    selectedAsset: null,
    setSelectedAssetId: () => {},
    selectedAssetIds: new Set(),
    selectedAssets: [],
    toggleAssetInSelection: () => {},
    addToSelection: () => {},
    selectRange: () => {},
    clearSelection: () => {},
    uploadQueue: {
      items: [],
      active: false,
      enqueue: () => {},
      retry: () => {},
      remove: () => {},
      clearFinished: () => {},
      cancelAll: () => {},
    },
    filters: { type: 'all', q: '', tag: '', sort: 'newest' },
    setFilterType: () => {},
    setQuery: () => {},
    setTag: () => {},
    setSort: () => {},
    uploadFiles: async () => {},
    renameAsset: async () => null,
    updateAsset: async () => null,
    replaceAssetFile: async () => null,
    trashAsset: async () => {},
    restoreAsset: async () => null,
    purgeAsset: async () => {},
    setAssetFolders: async () => null,
    moveAssetsToFolder: async () => {},
    createFolder: async () => null,
    renameFolder: async () => null,
    moveFolder: async () => null,
    deleteFolder: async () => {},
    ...overrides,
  }
}

describe('Media workspace folder grid', () => {
  it('renders child folders as grid entries and opens them from the canvas', () => {
    const setFolderSelection = mock((selection: FolderSelection) => { void selection })
    renderWithMediaSession(
      <MediaCanvas
        workspace={workspace({
          folders: [folder()],
          assets: [asset()],
          visibleAssets: [asset()],
          setFolderSelection,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open folder assets' }))

    expect(setFolderSelection).toHaveBeenCalledWith('folder_assets')
    expect(screen.getByRole('button', { name: 'Open logo.png' })).toBeTruthy()
  })

  it('renders a parent-folder entry inside nested folders', () => {
    const parent = folder()
    const child = folder({
      id: 'folder_screenshots',
      parentId: parent.id,
      name: 'screenshots',
      slug: 'screenshots',
    })
    const setFolderSelection = mock((selection: FolderSelection) => { void selection })

    renderWithMediaSession(
      <MediaCanvas
        workspace={workspace({
          folders: [parent, child],
          folderSelection: child.id,
          assets: [],
          visibleAssets: [],
          setFolderSelection,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back to assets' }))

    expect(setFolderSelection).toHaveBeenCalledWith(parent.id)
  })

  it('moves dragged assets into a grid folder', async () => {
    const moveAssetsToFolder = mock(async (assetIds: string[], folderId: string | null) => {
      void assetIds
      void folderId
    })

    renderWithMediaSession(
      <MediaCanvas
        workspace={workspace({
          folders: [folder()],
          assets: [asset()],
          visibleAssets: [asset()],
          moveAssetsToFolder,
        })}
      />,
    )

    const transfer = createDataTransfer()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Open logo.png' }), { dataTransfer: transfer })
    fireEvent.drop(screen.getByRole('button', { name: 'Open folder assets' }), { dataTransfer: transfer })

    await waitFor(() => {
      expect(moveAssetsToFolder).toHaveBeenCalledWith(['asset_1'], 'folder_assets')
    })
  })

  it('moves dragged assets into a sidebar folder', async () => {
    const moveAssetsToFolder = mock(async (assetIds: string[], folderId: string | null) => {
      void assetIds
      void folderId
    })

    renderWithMediaSession(
      <MediaFolderPanel
        workspace={workspace({
          folders: [folder()],
          assets: [asset()],
          moveAssetsToFolder,
        })}
      />,
    )

    fireEvent.drop(screen.getByRole('treeitem', { name: 'assets' }), {
      dataTransfer: transferWithAssets(['asset_1']),
    })

    await waitFor(() => {
      expect(moveAssetsToFolder).toHaveBeenCalledWith(['asset_1'], 'folder_assets')
    })
  })

  it('counts only images in image-metadata smart folders', () => {
    renderWithMediaSession(
      <MediaFolderPanel
        workspace={workspace({
          assets: [
            asset({ id: 'image_missing_title', mimeType: 'image/png', title: '' }),
            asset({
              id: 'font_missing_title',
              filename: 'PPNeue.woff2',
              mimeType: 'font/woff2',
              title: '',
            }),
            asset({ id: 'image_with_title', mimeType: 'image/png', title: 'Hero' }),
          ],
        })}
      />,
    )

    expect(screen.getByRole('treeitem', { name: 'Missing title — 1 asset' })).toBeTruthy()
  })

  it('counts foldered assets in All files', () => {
    renderWithMediaSession(
      <MediaFolderPanel
        workspace={workspace({
          assets: [
            asset({
              id: 'foldered_image',
              filename: 'foldered.png',
              folderIds: ['folder_assets'],
            }),
          ],
        })}
      />,
    )

    expect(screen.getByRole('treeitem', { name: 'All files — 1 asset' })).toBeTruthy()
  })

  it('keeps foldered images visible in the All files image picker view', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/media/folders')) {
        return new Response(JSON.stringify({ folders: [folder()] }), { status: 200 })
      }
      if (url.endsWith('/media')) {
        return new Response(JSON.stringify({
          assets: [
            asset({
              id: 'foldered_image',
              filename: 'foldered.png',
              folderIds: ['folder_assets'],
            }),
            asset({
              id: 'document',
              filename: 'document.pdf',
              mimeType: 'application/pdf',
              publicPath: '/uploads/document.pdf',
            }),
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'Unexpected URL' }), { status: 404 })
    }) as typeof fetch

    const { result } = renderHook(() => useMediaWorkspace())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setFilterType('image')
    })

    expect(result.current.folderSelection).toBe(FOLDER_ALL)
    expect(result.current.visibleAssets.map((entry) => entry.id)).toEqual(['foldered_image'])
  })

  it('returns multi-selected assets in selection order, not library order', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/media/folders')) {
        return new Response(JSON.stringify({ folders: [] }), { status: 200 })
      }
      if (url.endsWith('/media')) {
        return new Response(JSON.stringify({
          assets: [
            asset({ id: 'library-first', filename: 'first.png' }),
            asset({ id: 'library-second', filename: 'second.png' }),
            asset({ id: 'library-third', filename: 'third.png' }),
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'Unexpected URL' }), { status: 404 })
    }) as typeof fetch

    const { result } = renderHook(() => useMediaWorkspace())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.addToSelection(['library-third', 'library-first'])
    })

    expect(result.current.selectedAssets.map((entry) => entry.id)).toEqual([
      'library-third',
      'library-first',
    ])
  })
})
