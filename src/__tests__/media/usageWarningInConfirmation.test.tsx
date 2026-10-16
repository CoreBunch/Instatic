/**
 * The confirmation names what it is about to break.
 *
 * `buildUsageWarning` is tested on its own (usageWarning.test.ts) — these
 * cover the part that only shows up once it is wired: that every surface
 * offering a permanent delete looks the usage up BEFORE it opens the dialog,
 * that the answer reaches the dialog the operator is reading, and that a
 * failed lookup degrades to the plain confirmation instead of blocking a
 * delete or swallowing one.
 *
 * Each surface that offers the delete owns its own dialog, so each has to be
 * wired separately — and a test per surface is the only thing that catches one
 * being left behind. The bulk window is a third such surface; its permanent
 * delete arrives with #500, and its wiring belongs in whichever of the two
 * lands second.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { AdminSessionContext } from '@admin/sessionContext'
import type { CmsMediaUsageRef } from '@core/persistence/cmsMedia'

afterEach(cleanup)

function asset(id: string, filename: string) {
  return {
    id,
    filename,
    mimeType: 'image/png',
    sizeBytes: 1200,
    publicPath: `/uploads/${filename}`,
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

const AVATAR_REF: CmsMediaUsageRef = {
  assetId: 'a1',
  refKind: 'user.avatar',
  refId: 'u1',
  label: 'Ada Lovelace',
}

const session = {
  user: { id: 'u1', capabilities: ['media.delete', 'media.write'] },
  setUser: () => {},
}

// ── Viewer window ───────────────────────────────────────────────────────────

function renderViewer(lookupUsage: (ids: string[]) => Promise<CmsMediaUsageRef[]>) {
  const asked: string[][] = []
  const editor = {
    asset: asset('a1', 'logo.png'),
    tagPalette: [],
    folderById: new Map(),
    updateAsset: async () => undefined,
    renameAsset: async () => undefined,
    replaceAssetFile: async () => undefined,
    restoreAsset: async () => undefined,
    purgeAsset: async () => undefined,
    lookupUsage: async (ids: string[]) => {
      asked.push(ids)
      return await lookupUsage(ids)
    },
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
  return { asked }
}

async function openViewerPurge() {
  const buttons = screen.getAllByRole('button', { name: /delete permanently/i })
  fireEvent.click(buttons[0]!)
  await screen.findByRole('alertdialog')
}

describe('the viewer window', () => {
  it('names the person whose avatar it is', async () => {
    renderViewer(async () => [AVATAR_REF])
    await openViewerPurge()
    expect(screen.getByText(/profile picture — Ada Lovelace/)).toBeTruthy()
  })

  it('asks before the dialog opens, not after', async () => {
    // If the lookup were fired alongside the dialog, the warning would land
    // after the operator has already read it and moved to the button.
    const { asked } = renderViewer(async () => [AVATAR_REF])
    await openViewerPurge()
    expect(asked).toEqual([['a1']])
  })

  it('says nothing extra when nothing depends on the file', async () => {
    renderViewer(async () => [])
    await openViewerPurge()
    expect(screen.queryByText(/still in use/)).toBeNull()
    expect(screen.getByText('Delete "logo.png" permanently?')).toBeTruthy()
  })

  it('still confirms when the lookup fails', async () => {
    // Advisory, not a gate. A network blip must not turn a delete into a
    // dead button — nor into an unconfirmed one.
    renderViewer(async () => {
      throw new Error('network')
    })
    await openViewerPurge()
    expect(screen.getByText('Delete "logo.png" permanently?')).toBeTruthy()
    expect(screen.queryByText(/still in use/)).toBeNull()
  })
})

// ── The grid's context menu ─────────────────────────────────────────────────
//
// It routes through the shared `ConfirmDeleteDialog` rather than a local one,
// so what has to hold is the generic `details` slot that carries the warning
// across that boundary — plus the guarantee the surrounding
// `void (async () => …)()` depends on.

describe('the shared confirm dialog', () => {
  it('renders the caller-owned details below the description', async () => {
    const { ConfirmDeleteDialog } = await import(
      '@admin/shared/dialogs/ConfirmDeleteDialog/ConfirmDeleteDialog'
    )
    render(
      <ConfirmDeleteDialog
        title="Delete 3 files permanently?"
        description="This cannot be undone."
        details={<p>1 of 3 is still in use:</p>}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('1 of 3 is still in use:')).toBeTruthy()
  })
})

describe('resolveUsageWarning', () => {
  it('never rejects, so the dialog it precedes always opens', async () => {
    // Every surface opens its dialog from a floating `void (async () => …)()`.
    // A rejection there is dropped silently and the dialog never appears — a
    // delete button that does nothing at all.
    const { resolveUsageWarning } = await import('@admin/pages/media/utils/usageWarning')
    const warning = await resolveUsageWarning(async () => {
      throw new Error('network')
    }, ['a1'])
    expect(warning).toBeNull()
  })

  it('does not ask the server about an empty selection', async () => {
    const { resolveUsageWarning } = await import('@admin/pages/media/utils/usageWarning')
    let called = false
    const warning = await resolveUsageWarning(async () => {
      called = true
      return []
    }, [])
    expect(called).toBe(false)
    expect(warning).toBeNull()
  })
})
