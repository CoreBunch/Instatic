import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { SiteFile } from '@core/files/schemas'
import { usePublicFilePreview } from '@site/hooks/usePublicFilePreview'
import { resolveDynamicProps } from '@core/templates/dynamicBindings'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

function source(base64 = 'AAAA'): SiteFile {
  return { id: 'logo', path: 'public/logo.png', type: 'asset', blob: { mimeType: 'image/png', base64 }, createdAt: 1, updatedAt: 1 }
}
function envelope(url: string) {
  return new Response(JSON.stringify({ files: { logo: { id: 'logo', path: 'public/logo.png', url, mimeType: 'image/png' } } }))
}

describe('native file references in the editable canvas', () => {
  it('uses private references without a script build and discards stale references after a binary edit', async () => {
    const calls: string[] = []
    let resolveNext: ((response: Response) => void) | undefined
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      if (calls.length === 1) return envelope('/admin/api/cms/runtime/files/first/logo')
      return new Promise<Response>((resolve) => { resolveNext = resolve })
    }) as typeof fetch
    const initial = [source()]
    const { result, rerender } = renderHook(({ files }) => usePublicFilePreview(files), { initialProps: { files: initial } })
    await waitFor(() => expect(result.current.files.logo?.url).toBe('/admin/api/cms/runtime/files/first/logo'))
    expect(calls).toEqual(['/admin/api/cms/runtime/files'])
    const props = resolveDynamicProps({ src: '{file.logo.url}' }, undefined, { entryStack: [], files: result.current.files })
    expect(props.src).toBe('/admin/api/cms/runtime/files/first/logo')
    rerender({ files: initial })
    expect(calls).toHaveLength(1)
    rerender({ files: [source('AQID')] })
    expect(result.current.files.logo).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(calls).toHaveLength(2))
    await act(async () => { resolveNext!(envelope('/admin/api/cms/runtime/files/second/logo')) })
    expect(result.current.files.logo.url).toBe('/admin/api/cms/runtime/files/second/logo')
    expect(result.current.loading).toBe(false)
  })

  it('does not request private capabilities for non-binary files or incomplete placeholders', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); return envelope('unused') }) as typeof fetch
    const files: SiteFile[] = [{ ...source(), blob: undefined }, { ...source(), id: 'doc', type: 'doc', content: 'private', blob: undefined }]
    const { result } = renderHook(() => usePublicFilePreview(files))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.files).toEqual({})
    expect(calls).toEqual([])
  })
})
