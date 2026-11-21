/**
 * Selecting every visible media asset — Ctrl/Cmd+A, and a toolbar button
 * that makes the shortcut discoverable.
 *
 * Emptying the trash, or tagging a folder's worth of uploads, used to mean
 * clicking every file. Every case renders the real MediaCanvas and presses
 * the real shortcut or button, so the tests fail if the component stops
 * honouring the rule — not just if a copy of the rule changes.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MediaCanvas } from '@admin/pages/media/components/MediaCanvas/MediaCanvas'
import { FOLDER_ALL, type UseMediaWorkspaceResult } from '@admin/pages/media/hooks/useMediaWorkspace'
import { buildFolderTree } from '@admin/pages/media/utils/folderTree'
import { AdminSessionProvider } from '@admin/session'
import type { CoreCapability } from '@core/capabilities'
import type { CmsCurrentUser } from '@core/persistence'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function asset(id: string): CmsMediaAsset {
  return {
    id,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1200,
    publicPath: `/uploads/${id}.png`,
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
  }
}

const CAPABILITIES: CoreCapability[] = ['media.read', 'media.write', 'media.replace', 'media.delete']

function currentUser(): CmsCurrentUser {
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
      capabilities: CAPABILITIES,
    },
    capabilities: CAPABILITIES,
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

/** What the canvas asked the workspace to do. */
interface Calls {
  added: string[][]
  cleared: number
}

function renderCanvas(options: {
  assets?: string[]
  visible?: string[]
  selected?: string[]
} = {}): Calls {
  const assets = (options.assets ?? ['a', 'b', 'c']).map(asset)
  const visibleIds = new Set(options.visible ?? assets.map((a) => a.id))
  const visibleAssets = assets.filter((a) => visibleIds.has(a.id))
  const selectedIds = new Set(options.selected ?? [])
  const calls: Calls = { added: [], cleared: 0 }
  const workspace: UseMediaWorkspaceResult = {
    loading: false,
    error: null,
    clearError: () => {},
    refresh: async () => {},
    folders: [],
    folderTree: buildFolderTree([]),
    folderById: new Map(),
    assets,
    visibleAssets,
    tagPalette: [],
    folderSelection: FOLDER_ALL,
    setFolderSelection: () => {},
    selectedAssetId: null,
    selectedAsset: null,
    setSelectedAssetId: () => {},
    selectedAssetIds: selectedIds,
    selectedAssets: assets.filter((a) => selectedIds.has(a.id)),
    toggleAssetInSelection: () => {},
    addToSelection: (ids: string[]) => {
      calls.added.push(ids)
    },
    selectRange: () => {},
    clearSelection: () => {
      calls.cleared += 1
    },
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
  }
  render(
    <AdminSessionProvider user={currentUser()}>
      <MediaCanvas workspace={workspace} />
    </AdminSessionProvider>,
  )
  return calls
}

/** Ctrl+A on Windows/Linux, Cmd+A on a Mac — both modifiers, so either rule fires. */
function pressSelectAll(target: Element = document.body) {
  fireEvent.keyDown(target, { key: 'a', ctrlKey: true, metaKey: true })
}

function mount(element: HTMLElement): HTMLElement {
  document.body.appendChild(element)
  return element
}

describe('Ctrl/Cmd+A over the media grid', () => {
  it('selects every visible asset', () => {
    const calls = renderCanvas()
    pressSelectAll()
    expect(calls.added).toEqual([['a', 'b', 'c']])
  })

  it('selects what the filter shows, not the whole library', () => {
    // The only reading that makes "select all, then delete" safe in the
    // trash: it can never reach past the filter into assets not on screen.
    const calls = renderCanvas({ assets: ['a', 'b', 'c'], visible: ['a', 'c'] })
    pressSelectAll()
    expect(calls.added).toEqual([['a', 'c']])
  })

  it('clears the selection when it already covers everything visible', () => {
    const calls = renderCanvas({ selected: ['a', 'b', 'c'] })
    pressSelectAll()
    expect(calls.cleared).toBe(1)
    expect(calls.added).toEqual([])
  })

  it('leaves the shortcut to the browser inside the search box', () => {
    const calls = renderCanvas()
    pressSelectAll(screen.getByRole('searchbox', { name: 'Search media' }))
    expect(calls.added).toEqual([])
  })

  it('leaves it alone in a textarea or an editable field', () => {
    const calls = renderCanvas()
    pressSelectAll(mount(document.createElement('textarea')))
    const editable = mount(document.createElement('div'))
    editable.contentEditable = 'true'
    pressSelectAll(editable)
    expect(calls.added).toEqual([])
  })

  it('stands down while a modal dialog is open', () => {
    // A rename or a delete confirmation keeps its own select-all.
    const calls = renderCanvas()
    const modal = mount(document.createElement('div'))
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    pressSelectAll()
    expect(calls.added).toEqual([])
  })

  it('keeps working beside a floating window, which is not modal', () => {
    // Selecting one asset opens the viewer window, which carries
    // role="dialog" but leaves the grid usable behind it. Keying on the role
    // instead of aria-modal switched the shortcut off almost everywhere.
    const calls = renderCanvas()
    mount(document.createElement('div')).setAttribute('role', 'dialog')
    pressSelectAll()
    expect(calls.added).toEqual([['a', 'b', 'c']])
  })

  it('does nothing on an empty grid', () => {
    const calls = renderCanvas({ assets: [] })
    pressSelectAll()
    expect(calls.added).toEqual([])
    expect(calls.cleared).toBe(0)
  })
})

describe('the toolbar button', () => {
  it('names how many it will select, and selects them', () => {
    const calls = renderCanvas()
    fireEvent.click(screen.getByRole('button', { name: 'Select all 3 items' }))
    expect(calls.added).toEqual([['a', 'b', 'c']])
  })

  it('turns into Clear selection once everything visible is selected', () => {
    const calls = renderCanvas({ selected: ['a', 'b', 'c'] })
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(calls.cleared).toBe(1)
  })

  it('is disabled on an empty grid', () => {
    const calls = renderCanvas({ assets: [] })
    const button = screen.getByRole('button', { name: 'Select all 0 items' })
    // `Button` marks a disabled button that carries a tooltip with
    // aria-disabled rather than the native attribute, so the tooltip still
    // shows; a click must still do nothing.
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(calls.added).toEqual([])
  })
})
