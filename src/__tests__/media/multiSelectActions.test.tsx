/**
 * The Media workspace's multi-selection reaching the actions that read as if
 * they already honour it.
 *
 * Reported from a real install:
 *
 *   1. Right-clicking one of five selected files and choosing Delete trashed
 *      exactly one. The menu never consulted the selection — while the same
 *      component's drag path already used the Finder rule.
 *   2. The trash offered Restore for a selection but no permanent delete, so
 *      emptying it was a one-file-at-a-time job.
 *
 * Every case renders the real component and drives it the way an operator
 * does — the menu, the drag, the confirmation — so the tests fail if the
 * component stops using the rule, not just if the rule changes.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { BulkEditWindow } from '@admin/pages/media/components/BulkEditWindow/BulkEditWindow'
import { MediaCanvas } from '@admin/pages/media/components/MediaCanvas/MediaCanvas'
import {
  FOLDER_ALL,
  FOLDER_TRASH,
  type UseMediaWorkspaceResult,
} from '@admin/pages/media/hooks/useMediaWorkspace'
import { actionTargets } from '@admin/pages/media/utils/actionTargets'
import { buildFolderTree } from '@admin/pages/media/utils/folderTree'
import { MEDIA_ASSET_DRAG_TYPE } from '@admin/pages/media/utils/mediaDragDrop'
import { AdminSessionProvider } from '@admin/session'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { CoreCapability } from '@core/capabilities'
import type { CmsCurrentUser } from '@core/persistence'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'

afterEach(cleanup)

const TRASHED = '2026-02-01T00:00:00.000Z'

function asset(id: string, deletedAt: string | null = null): CmsMediaAsset {
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
    deletedAt,
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

/** What an operator's clicks made the component do, in order. */
interface Calls {
  trashed: string[]
  purged: string[]
}

function workspace(
  assets: CmsMediaAsset[],
  selected: string[],
  options: { trash?: boolean } = {},
): { workspace: UseMediaWorkspaceResult; calls: Calls } {
  const calls: Calls = { trashed: [], purged: [] }
  const selectedIds = new Set(selected)
  const ws: UseMediaWorkspaceResult = {
    loading: false,
    error: null,
    clearError: () => {},
    refresh: async () => {},
    folders: [],
    folderTree: buildFolderTree([]),
    folderById: new Map(),
    assets,
    visibleAssets: assets,
    tagPalette: [],
    folderSelection: options.trash ? FOLDER_TRASH : FOLDER_ALL,
    setFolderSelection: () => {},
    selectedAssetId: null,
    selectedAsset: null,
    setSelectedAssetId: () => {},
    selectedAssetIds: selectedIds,
    selectedAssets: assets.filter((a) => selectedIds.has(a.id)),
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
    trashAsset: async (id: string) => {
      calls.trashed.push(id)
    },
    restoreAsset: async () => null,
    purgeAsset: async (id: string) => {
      calls.purged.push(id)
    },
    setAssetFolders: async () => null,
    moveAssetsToFolder: async () => {},
    createFolder: async () => null,
    renameFolder: async () => null,
    moveFolder: async () => null,
    deleteFolder: async () => {},
  }
  return { workspace: ws, calls }
}

/** The tree the canvas really runs in: the session and the one confirm host. */
function renderInAdmin(ui: ReactElement) {
  return render(
    <AdminSessionProvider user={currentUser()}>
      <ConfirmDeleteProvider>{ui}</ConfirmDeleteProvider>
    </AdminSessionProvider>,
  )
}

function rightClick(filename: string) {
  fireEvent.contextMenu(screen.getByRole('button', { name: `Open ${filename}` }))
}

function chooseMenuItem(label: RegExp) {
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

const FIVE = ['a', 'b', 'c', 'd', 'e']

describe('the Finder rule', () => {
  it('acts on the whole selection when the clicked item is part of it', () => {
    expect(actionTargets('c', new Set(FIVE))).toEqual(FIVE)
  })

  it('acts on the clicked item alone when it sits outside the selection', () => {
    expect(actionTargets('z', new Set(['a', 'b']))).toEqual(['z'])
  })

  it('acts on the clicked item when nothing is selected', () => {
    expect(actionTargets('a', new Set())).toEqual(['a'])
  })
})

describe('the Media context menu acts on the selection', () => {
  it('trashes every selected file when one of them is right-clicked', () => {
    const { workspace: ws, calls } = workspace(FIVE.map((id) => asset(id)), FIVE)
    renderInAdmin(<MediaCanvas workspace={ws} />)

    rightClick('c.png')
    chooseMenuItem(/trash 5 files/i)

    expect(calls.trashed).toEqual(FIVE)
  })

  it('trashes only the right-clicked file when it is outside the selection', () => {
    const { workspace: ws, calls } = workspace(['a', 'b', 'z'].map((id) => asset(id)), ['a', 'b'])
    renderInAdmin(<MediaCanvas workspace={ws} />)

    rightClick('z.png')
    chooseMenuItem(/move to trash/i)

    expect(calls.trashed).toEqual(['z'])
  })

  it('drags the same set the menu acts on', () => {
    const { workspace: ws } = workspace(FIVE.map((id) => asset(id)), FIVE)
    renderInAdmin(<MediaCanvas workspace={ws} />)

    const data = new Map<string, string>()
    const transfer = {
      types: [] as string[],
      effectAllowed: 'uninitialized',
      setData: (type: string, value: string) => {
        data.set(type, value)
      },
      getData: (type: string) => data.get(type) ?? '',
      setDragImage: () => {},
    }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Open c.png' }), { dataTransfer: transfer })

    expect(JSON.parse(data.get(MEDIA_ASSET_DRAG_TYPE) ?? '{}').assetIds).toEqual(FIVE)
  })
})

describe('a permanent delete from the trash menu asks first', () => {
  function inTrash(selected: string[]): Calls {
    const setup = workspace(FIVE.map((id) => asset(id, TRASHED)), selected, { trash: true })
    renderInAdmin(<MediaCanvas workspace={setup.workspace} />)
    return setup.calls
  }

  it('does not purge the selection on the menu click', () => {
    const calls = inTrash(['a', 'b', 'c'])
    rightClick('b.png')
    chooseMenuItem(/delete 3 files/i)

    expect(calls.purged).toEqual([])
    expect(screen.getByText(/delete 3 files permanently\?/i)).toBeTruthy()
  })

  it('purges every selected file once the operator confirms', () => {
    const calls = inTrash(['a', 'b', 'c'])
    rightClick('b.png')
    chooseMenuItem(/delete 3 files/i)
    fireEvent.click(screen.getByRole('button', { name: /^delete 3 files$/i }))

    expect(calls.purged).toEqual(['a', 'b', 'c'])
  })

  it('purges nothing when the operator cancels', () => {
    const calls = inTrash(['a', 'b', 'c'])
    rightClick('b.png')
    chooseMenuItem(/delete 3 files/i)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(calls.purged).toEqual([])
  })

  it('asks for a single file too', () => {
    const calls = inTrash([])
    rightClick('d.png')
    chooseMenuItem(/delete permanently/i)

    expect(calls.purged).toEqual([])
    expect(screen.getByText(/delete "d\.png" permanently\?/i)).toBeTruthy()
  })
})

describe('the bulk window deletes exactly what it counts', () => {
  it('counts and purges only the trashed members of a mixed selection', async () => {
    const assets = [asset('t1', TRASHED), asset('live'), asset('t2', TRASHED)]
    const { workspace: ws, calls } = workspace(assets, ['t1', 'live', 't2'])
    renderInAdmin(<BulkEditWindow workspace={ws} open onClose={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }))
    expect(screen.getByText(/delete 2 files permanently\?/i)).toBeTruthy()

    // The dialog's own confirm button renders after the window's.
    fireEvent.click(screen.getAllByRole('button', { name: /delete permanently/i }).at(-1)!)

    // `purgeAsset` 400s on a live asset: the purge must skip it, not just
    // the count.
    await waitFor(() => expect(calls.purged).toEqual(['t1', 't2']))
  })
})
