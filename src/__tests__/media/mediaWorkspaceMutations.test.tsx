import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useMediaWorkspace } from '@admin/pages/media/hooks/useMediaWorkspace'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

function assetRow(overrides: Record<string, unknown> = {}) {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Routes media API calls. The initial workspace mount fires GET /media and
 * GET /media/folders; `onMutation` handles whatever the test triggers next.
 */
function routeFetch(
  initialAssets: Record<string, unknown>[],
  onMutation: (url: string, init: RequestInit | undefined) => Response,
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.includes('/media/folders')) {
      return jsonResponse({ folders: [] })
    }
    if (method === 'GET' && url.includes('/media')) {
      return jsonResponse({ assets: initialAssets })
    }
    return onMutation(url, init)
  }) as typeof fetch
}

async function mountWorkspace(initialAssets: Record<string, unknown>[]) {
  const view = renderHook(() => useMediaWorkspace())
  // Wait for the initial load to settle so `assets` is populated.
  await waitFor(() => {
    expect(view.result.current.loading).toBe(false)
  })
  expect(view.result.current.assets).toHaveLength(initialAssets.length)
  return view
}

describe('useMediaWorkspace mutation envelope (assetMut)', () => {
  it('can reselect an asset after moving it out of an ordered selection', async () => {
    routeFetch([
      assetRow({ id: 'asset_1', folderIds: [] }),
      assetRow({ id: 'asset_2', filename: 'two.png', folderIds: [] }),
    ], (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { add?: string[] }
      return jsonResponse({
        asset: assetRow({
          id: body.add?.[0] === 'folder_2' ? 'asset_2' : 'asset_1',
          folderIds: body.add ?? [],
        }),
      })
    })
    const view = await mountWorkspace([
      assetRow({ id: 'asset_1', folderIds: [] }),
      assetRow({ id: 'asset_2', filename: 'two.png', folderIds: [] }),
    ])

    act(() => {
      view.result.current.addToSelection(['asset_1', 'asset_2'])
    })
    await act(async () => {
      await view.result.current.moveAssetsToFolder(['asset_1'], 'folder_1')
    })
    act(() => {
      view.result.current.toggleAssetInSelection('asset_1')
    })

    expect(view.result.current.selectedAssets.map((asset) => asset.id)).toEqual([
      'asset_2',
      'asset_1',
    ])
  })

  it('a thrown op sets the error and returns null without throwing', async () => {
    routeFetch([assetRow()], () =>
      jsonResponse({ error: 'Filename already taken' }, 409),
    )
    const view = await mountWorkspace([assetRow()])

    let returned: unknown = 'untouched'
    await act(async () => {
      returned = await view.result.current.renameAsset('asset_1', 'renamed.png')
    })

    expect(returned).toBeNull()
    expect(view.result.current.error).toBe('Filename already taken')
    // The cache is untouched — the optimistic replace only runs on success.
    expect(view.result.current.assets[0].filename).toBe('logo.png')
  })

  it('a successful op clears the error and updates the cache', async () => {
    routeFetch([assetRow()], () =>
      jsonResponse({ asset: assetRow({ filename: 'renamed.png' }) }),
    )
    const view = await mountWorkspace([assetRow()])

    // Seed a sticky error so we can prove a successful op clears it.
    act(() => {
      view.result.current.setSelectedAssetId('asset_1')
    })

    let returned: { filename: string } | null = null
    await act(async () => {
      returned = (await view.result.current.renameAsset('asset_1', 'renamed.png')) as
        | { filename: string }
        | null
    })

    expect(returned).not.toBeNull()
    expect(returned!.filename).toBe('renamed.png')
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.assets[0].filename).toBe('renamed.png')
  })

  it('a thrown folder op surfaces the error and returns null', async () => {
    routeFetch([], () => jsonResponse({ error: 'Folder name in use' }, 409))
    const view = await mountWorkspace([])

    let returned: unknown = 'untouched'
    await act(async () => {
      returned = await view.result.current.createFolder('assets', null)
    })

    expect(returned).toBeNull()
    expect(view.result.current.error).toBe('Folder name in use')
  })
})
