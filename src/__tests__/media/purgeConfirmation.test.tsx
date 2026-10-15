/**
 * Permanent deletion of a media asset has to ask first.
 *
 * "Delete permanently" removes the original binary AND every generated size
 * from the storage adapter — not just the row. It is the only media action
 * with no undo, and it sat one unguarded click away inside the trash preview,
 * beside the Restore button it visually matches.
 *
 * These tests pin the confirmation itself rather than the wording: that the
 * mutation does NOT fire on the first click, that Cancel leaves the asset
 * alone, and that the second click is what commits.
 *
 * The dialog is local to the window on purpose. `useConfirmDelete` falls back
 * to running `commit()` immediately when no `ConfirmDeleteProvider` is mounted
 * (confirmDeleteHook.ts), and this window also renders from the dashboard
 * media widget, which mounts none — so routing through that hook would have
 * left one surface silently unguarded while looking covered everywhere.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { AdminSessionContext } from '@admin/sessionContext'

afterEach(cleanup)

/** A trashed asset — the only state in which the purge button renders. */
function trashedAsset() {
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
    deletedAt: '2026-02-01T00:00:00.000Z',
    replacedAt: null,
    folderIds: [],
    blurHash: null,
    variants: [],
    posterPath: null,
  }
}

function renderViewer() {
  const purged: string[] = []
  const editor = {
    asset: trashedAsset(),
    tagPalette: [],
    folderById: new Map(),
    updateAsset: async () => undefined,
    renameAsset: async () => undefined,
    replaceAssetFile: async () => undefined,
    restoreAsset: async () => undefined,
    purgeAsset: async (id: string) => {
      purged.push(id)
    },
  }
  // `media.delete` is what renders the purge button at all.
  const session = {
    user: { id: 'u1', capabilities: ['media.delete', 'media.write'] },
    setUser: () => {},
  }
  render(
    <AdminSessionContext value={session as never}>
      <MediaViewerWindow
        editor={editor as unknown as Parameters<typeof MediaViewerWindow>[0]['editor']}
        open
        onClose={() => {}}
      />
    </AdminSessionContext>,
  )
  return { purged }
}

/** The button in the sidebar, not the one inside the dialog footer. */
function clickPurgeButton() {
  const buttons = screen.getAllByRole('button', { name: /delete permanently/i })
  fireEvent.click(buttons[0]!)
}

describe('permanent media deletion asks first', () => {
  it('does not purge on the first click', () => {
    const { purged } = renderViewer()
    clickPurgeButton()
    expect(purged).toEqual([])
  })

  it('names the asset so the operator can see what they are about to lose', () => {
    renderViewer()
    clickPurgeButton()
    // The filename also appears in the window chrome, so match the dialog's
    // own heading rather than any occurrence of it.
    expect(screen.getByText('Delete "logo.png" permanently?')).toBeTruthy()
  })

  it('cancelling leaves the asset alone', () => {
    const { purged } = renderViewer()
    clickPurgeButton()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(purged).toEqual([])
  })

  it('confirming is what commits the purge', () => {
    const { purged } = renderViewer()
    clickPurgeButton()
    // The footer button — the last match, since the sidebar button is still
    // mounted behind the dialog.
    const buttons = screen.getAllByRole('button', { name: /delete permanently/i })
    fireEvent.click(buttons[buttons.length - 1]!)
    expect(purged).toEqual(['asset_1'])
  })
})
