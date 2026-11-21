/**
 * Minimizing a floating window instead of dismissing it.
 *
 * The upload queue mid-transfer, a bulk edit mid-review, the viewer beside
 * the grid: closing loses the panel, keeping it covers the grid. A
 * minimizable window folds to its title bar and comes back where it was.
 *
 * These render the real windows and press the real control.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { AdminSessionContext } from '@admin/sessionContext'
import { FloatingWindow } from '@admin/shared/FloatingWindow'

afterEach(cleanup)

function renderWindow(minimizable: boolean) {
  render(
    <FloatingWindow
      panelId="mediaUploadQueue"
      open
      title="Uploads"
      defaultPosition={{ x: 16, y: 80 }}
      minimizable={minimizable}
      headerActions={<button type="button">Clear finished</button>}
      onClose={() => {}}
    >
      <p>Three files uploading</p>
    </FloatingWindow>,
  )
}

describe('a minimizable FloatingWindow', () => {
  it('folds to its title bar', () => {
    renderWindow(true)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Uploads' }))

    expect(screen.queryByText('Three files uploading')).toBeNull()
    // Header actions act on the body, so they fold with it.
    expect(screen.queryByRole('button', { name: 'Clear finished' })).toBeNull()
    // The title bar stays: it is what the user drags and expands from.
    expect(screen.getByText('Uploads')).toBeTruthy()
  })

  it('says which state it is in', () => {
    renderWindow(true)
    const control = screen.getByRole('button', { name: 'Minimize Uploads' })
    expect(control.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(control)
    expect(screen.getByRole('button', { name: 'Expand Uploads' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('comes back with its content when expanded', () => {
    renderWindow(true)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Uploads' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Uploads' }))

    expect(screen.getByText('Three files uploading')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear finished' })).toBeTruthy()
  })

  it('offers no control unless the window opts in', () => {
    renderWindow(false)
    expect(screen.queryByRole('button', { name: /minimize/i })).toBeNull()
    expect(screen.getByText('Three files uploading')).toBeTruthy()
  })
})

describe('the media viewer window', () => {
  // It builds its own shell rather than FloatingWindow, so it wires the
  // control itself and needs its own check.
  function renderViewer() {
    const editor = {
      asset: {
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
      },
      tagPalette: [],
      folderById: new Map(),
      updateAsset: async () => undefined,
      renameAsset: async () => undefined,
      replaceAssetFile: async () => undefined,
      restoreAsset: async () => undefined,
      purgeAsset: async () => undefined,
    }
    const session = {
      user: { id: 'u1', capabilities: ['media.write', 'media.delete'] },
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
  }

  it('folds to its title bar and collapses its height with it', () => {
    renderViewer()
    expect(screen.getByRole('textbox', { name: 'Alt text' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Minimize logo.png' }))

    expect(screen.queryByRole('textbox', { name: 'Alt text' })).toBeNull()
    // The window's height is a fixed length; hiding the body alone left a
    // full-size empty pane under the title bar. The attribute is what the
    // stylesheet collapses it on.
    const viewer = screen.getByRole('dialog', { name: 'Viewer: logo.png' })
    expect(viewer.getAttribute('data-minimized')).toBe('true')
  })

  it('comes back when expanded', () => {
    renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Minimize logo.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand logo.png' }))

    expect(screen.getByRole('textbox', { name: 'Alt text' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Viewer: logo.png' }).hasAttribute('data-minimized')).toBe(false)
  })
})
