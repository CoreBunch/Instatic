import { afterEach, describe, expect, it } from 'bun:test'
import { createSiteImportAdapter } from '@admin/modals/SiteImport/shared/createSiteImportAdapter'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createSiteImportAdapter', () => {
  it('uploads imported assets through the CMS media client contract', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      const url = String(input)

      if (url === '/admin/api/cms/media') {
        return jsonResponse({
          asset: {
            id: 'asset/one',
            filename: 'hero.png',
            mimeType: 'image/png',
            sizeBytes: 12,
            publicPath: '/uploads/hero.png',
            uploadedByUserId: null,
            createdAt: '2026-01-03T00:00:00.000Z',
          },
        }, 201)
      }

      if (url === '/admin/api/cms/media/folders') {
        if (init?.method === 'GET') {
          return jsonResponse({ folders: [] })
        }
        return jsonResponse({
          folder: {
            id: 'folder-hero',
            name: 'images',
            slug: 'images',
            parentId: null,
            sortOrder: 0,
            createdByUserId: null,
            createdAt: '2026-01-03T00:00:00.000Z',
          },
        }, 201)
      }

      if (url === '/admin/api/cms/media/asset%2Fone/folders') {
        return jsonResponse({
          asset: {
            id: 'asset/one',
            filename: 'hero.png',
            mimeType: 'image/png',
            sizeBytes: 12,
            publicPath: '/uploads/hero.png',
            uploadedByUserId: null,
            createdAt: '2026-01-03T00:00:00.000Z',
            folderIds: ['folder-hero'],
          },
        })
      }

      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    const adapter = createSiteImportAdapter({ sessionId: 'test-session' })
    await expect(adapter.uploadAsset({
      path: 'images/hero.png',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
    })).resolves.toEqual({ url: '/uploads/hero.png', warnings: [] })

    expect(calls).toHaveLength(4)
    expect(calls.map((call) => String(call.input))).toEqual([
      '/admin/api/cms/media',
      '/admin/api/cms/media/folders',
      '/admin/api/cms/media/folders',
      '/admin/api/cms/media/asset%2Fone/folders',
    ])
    for (const call of calls) {
      expect(call.init?.credentials).toBe('include')
    }
    expect(calls[0].init?.body).toBeInstanceOf(FormData)
    expect(calls[2].init?.body).toBe(JSON.stringify({ name: 'images', parentId: null }))
    expect(calls[3].init?.body).toBe(JSON.stringify({ add: ['folder-hero'] }))
  })
})

describe('createSiteImportAdapter — upload contract', () => {
  function uploadedAsset(publicPath: string) {
    return {
      id: 'asset-1',
      filename: publicPath.split('/').pop() ?? 'file',
      mimeType: 'image/png',
      sizeBytes: 3,
      publicPath,
      uploadedByUserId: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    }
  }

  it('keeps the uploaded public path when folder placement fails (#409)', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url === '/admin/api/cms/media') {
        return jsonResponse({ asset: uploadedAsset('/uploads/example.webp') }, 201)
      }
      if (url === '/admin/api/cms/media/folders') {
        return jsonResponse({ error: 'folders unavailable' }, 500)
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    const adapter = createSiteImportAdapter({ sessionId: 'test-session' })
    const uploaded = await adapter.uploadAsset({
      path: 'assets/case-studies/example.webp',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/webp',
    })

    expect(uploaded.url).toBe('/uploads/example.webp')
    expect(uploaded.warnings).toEqual([
      expect.objectContaining({ kind: 'asset-folder-failed', path: 'assets/case-studies/example.webp' }),
    ])
    expect(uploaded.warnings[0]!.message).toContain('folders unavailable')
  })

  it('sends the authored alt text with the upload so the Media Library record starts with it (#411)', async () => {
    let uploadBody: FormData | null = null
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === '/admin/api/cms/media') {
        uploadBody = init?.body instanceof FormData ? init.body : null
        return jsonResponse({ asset: uploadedAsset('/uploads/hero.png') }, 201)
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    const adapter = createSiteImportAdapter({ sessionId: 'test-session' })
    const uploaded = await adapter.uploadAsset({
      path: 'hero.png',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      altText: 'Team photo',
    })

    expect(uploaded).toEqual({ url: '/uploads/hero.png', warnings: [] })
    expect(uploadBody).not.toBeNull()
    expect(uploadBody!.get('altText')).toBe('Team photo')
  })

  it('omits the alt field when the source image had none, so the record keeps the server default', async () => {
    let uploadBody: FormData | null = null
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === '/admin/api/cms/media') {
        uploadBody = init?.body instanceof FormData ? init.body : null
        return jsonResponse({ asset: uploadedAsset('/uploads/hero.png') }, 201)
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    const adapter = createSiteImportAdapter({ sessionId: 'test-session' })
    await adapter.uploadAsset({ path: 'hero.png', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })

    expect(uploadBody!.has('altText')).toBe(false)
  })
})
