import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Value } from '@core/utils/typeboxHelpers'
import { DataRowSchema, type DataRow } from '@core/data/schemas'
import { ContentLocalizationSchema } from '@core/localization-schema'
import { useEditorStore } from '@site/store/store'
import { useSiteExplorerLivePath } from '@site/panels/SiteExplorerPanel/useSiteExplorerLivePath'
import { CMS_PUBLICATION_CHANGED_EVENT } from '@admin/state/adminEvents'
import { makePage, makeSite } from '../fixtures'

afterEach(() => { cleanup(); mock.restore(); useEditorStore.getState().clearSite() })

function prepare() {
  const page = makePage({ id: 'page', slug: 'new-draft-path' })
  const site = makeSite({ pages: [page], localeId: 'de', locales: [
    { id: 'en', code: 'en', name: 'English', enabled: true, isDefault: true, direction: 'ltr', pathPrefix: '' },
    { id: 'de', code: 'de', name: 'Deutsch', enabled: true, isDefault: false, direction: 'ltr', pathPrefix: 'de' },
  ] })
  useEditorStore.getState().loadSite(site)
  return { page, site }
}

function liveRow(localeId: string): DataRow {
  return { ...Value.Create(DataRowSchema), id: 'page', tableId: 'pages', localeId,
    publicPath: localeId === 'de' ? '/de/frozen-path' : '/frozen-path',
    localization: { ...Value.Create(ContentLocalizationSchema), rowId: 'page', localeId, availability: 'online' },
  }
}

it('uses a frozen locale path and removes it after unpublishing or disabling the language', async () => {
  const { page, site } = prepare()
  let row = liveRow('de')
  const requested: string[] = []
  spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    requested.push(String(input))
    return new Response(JSON.stringify({ row }), { headers: { 'Content-Type': 'application/json' } })
  })
  const { result, rerender } = renderHook(({ selected }) => useSiteExplorerLivePath(selected), { initialProps: { selected: page } })
  await waitFor(() => expect(result.current).toBe('/de/frozen-path'))
  expect(requested[0]).toContain('localeId=de')
  row = { ...row, localization: { ...row.localization!, availability: 'offline' } }
  act(() => window.dispatchEvent(new Event(CMS_PUBLICATION_CHANGED_EVENT)))
  await waitFor(() => expect(result.current).toBeNull())
  row = liveRow('de')
  act(() => window.dispatchEvent(new Event(CMS_PUBLICATION_CHANGED_EVENT)))
  await waitFor(() => expect(result.current).toBe('/de/frozen-path'))
  rerender({ selected: { ...page, template: { enabled: true, target: { kind: 'everywhere' }, priority: 100 } } })
  expect(result.current).toBeNull()
  rerender({ selected: page })
  act(() => useEditorStore.setState({ site: { ...site, locales: site.locales!.map((locale) => ({ ...locale, enabled: false })) } }))
  expect(result.current).toBeNull()
})

it('never shows a previous language while the next language request is pending', async () => {
  const { page, site } = prepare()
  let resolveSource!: (value: Response) => void
  spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('localeId=en')) return new Promise((resolve) => { resolveSource = resolve })
    return Response.json({ row: liveRow('de') })
  })
  const { result } = renderHook(() => useSiteExplorerLivePath(page))
  await waitFor(() => expect(result.current).toBe('/de/frozen-path'))
  act(() => useEditorStore.setState({ site: { ...site, localeId: 'en' } }))
  expect(result.current).toBeNull()
  await act(async () => resolveSource(Response.json({ row: liveRow('en') })))
  await waitFor(() => expect(result.current).toBe('/frozen-path'))
})
