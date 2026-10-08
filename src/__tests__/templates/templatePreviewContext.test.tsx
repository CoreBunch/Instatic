import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { TemplatePreviewDataError, useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import TemplateModeControl from '@site/canvas/TemplateModeControl'
import { useActiveLivePath } from '@site/hooks/useActiveLivePath'
import { useAdminUi } from '@admin/state/adminUi'
import { DynamicBindingControl } from '@site/property-controls/DynamicBindingControl'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'
import { Input } from '@ui/components/Input'
import { makePage, makeSite } from '../fixtures'
import type { DataTable } from '@core/data/schemas'

const originalFetch = globalThis.fetch
const table: DataTable = { id: 'articles', slug: 'articles', name: 'Articles', kind: 'postType', routeBase: '/articles',
  singularLabel: 'Article', pluralLabel: 'Articles', primaryFieldId: 'heading', fields: [
    { id: 'heading', label: 'Heading', type: 'localizedText' },
    { id: 'title', label: 'Title', type: 'text' }, { id: 'slug', label: 'Slug', type: 'text' },
  ], system: false, createdByUserId: null, updatedByUserId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
const captions = { it: 'Sicurezza', de: 'Sicherheit' }
let fail = false
let empty = false
let tableMissing = false
let malformed = false
let queries: string[] = []

function setup() {
  const page = makePage({ id: 'template', language: 'it', template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['articles'] }, priority: 100 } })
  const site = makeSite({ pages: [page] })
  site.settings.language = 'it'
  site.settings.localization = { catalogues: ['it', 'de'].map(language => ({ language, fileId: language })) }
  site.files = ['it', 'de'].map(language => ({ id: language, path: `locales/${language}.json`, type: 'config' as const,
    content: JSON.stringify({ language, messages: { articles: { security: captions[language as keyof typeof captions] } } }), createdAt: 1, updatedAt: 1 }))
  useEditorStore.setState({ site, activePageId: page.id, activeDocument: { kind: 'page', pageId: page.id }, templatePreviewSelection: {} })
}
function contextHook() {
  return renderHook(() => {
    const page = useEditorStore(s => s.site?.pages[0] ?? null)
    return useTemplatePreviewContext(page)
  })
}

beforeEach(() => {
  fail = false; empty = false; tableMissing = false; malformed = false; queries = []
  useEditorStore.getState().clearSite()
  clearDataMetaCache()
  globalThis.fetch = mock(async input => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/data/tables')) return Response.json({ tables: tableMissing ? [] : [{ ...table, rowCount: 1 }] })
    if (url.pathname.endsWith('/data/_meta')) return Response.json({ meta: { tables: [{ ...table, routable: true, versioned: true }] } })
    if (url.pathname.endsWith('/loop-preview')) {
      queries.push(url.search)
      if (fail) return Response.json({ error: 'Catalogue cannot be loaded' }, { status: 422 })
      if (malformed) return Response.json({ totalItems: 0 })
      const language = url.searchParams.get('language') as keyof typeof captions
      if (!captions[language]) return Response.json({ error: 'Explicit language is required' }, { status: 422 })
      return Response.json({ items: empty ? [] : [{ id: 'security', fields: { heading: captions[language], title: 'Ordinary title', permalink: '/articles/security' } }], totalItems: empty ? 0 : 1 })
    }
    return Response.json({ error: 'Unexpected request' }, { status: 404 })
  }) as typeof fetch
  setup()
})
afterEach(() => { cleanup(); useEditorStore.getState().clearSite(); clearDataMetaCache(); globalThis.fetch = originalFetch })

describe('native template entry preview authority', () => {
  it('loads real entries in the canonical page language and excludes stale language values', async () => {
    const hook = contextHook()
    await waitFor(() => expect(hook.result.current.context?.entryStack[0]?.fields.heading).toBe('Sicurezza'))
    expect(hook.result.current.context?.site?.language).toBe('it')
    act(() => useEditorStore.getState().setPageLanguage('template', 'de'))
    expect(hook.result.current.context).toBeUndefined()
    await waitFor(() => expect(hook.result.current.context?.entryStack[0]?.fields.heading).toBe('Sicherheit'))
    expect(hook.result.current.context?.site?.language).toBe('de')
    expect(queries.some(query => query.includes('language=it'))).toBeTrue()
    expect(queries.some(query => query.includes('language=de'))).toBeTrue()
  })

  it('surfaces a failed read and retries rather than substituting sample content', async () => {
    fail = true
    const hook = contextHook()
    await waitFor(() => expect(hook.result.current.error).toBeInstanceOf(TemplatePreviewDataError))
    expect(hook.result.current.context).toBeUndefined()
    expect(hook.result.current.rows).toEqual([])
    expect(hook.result.current.error?.message).toContain('Catalogue cannot be loaded')
    fail = false
    act(() => hook.result.current.refresh())
    await waitFor(() => expect(hook.result.current.context?.entryStack[0]?.id).toBe('security'))
    expect(hook.result.current.error).toBeUndefined()
  })

  it('keeps a successfully empty table empty without creating a current entry', async () => {
    empty = true
    const hook = contextHook()
    await waitFor(() => expect(hook.result.current.loading).toBeFalse())
    expect(hook.result.current.context?.entryStack).toEqual([])
    expect(hook.result.current.rows).toEqual([])
    expect(hook.result.current.error).toBeUndefined()
  })

  it('rejects a malformed successful response rather than inventing an empty collection', async () => {
    malformed = true
    const hook = contextHook()
    await waitFor(() => expect(hook.result.current.error).toBeInstanceOf(TemplatePreviewDataError))
    expect(hook.result.current.context).toBeUndefined()
    expect(hook.result.current.error?.message).toContain('/items')
  })

  it('reports a missing table and an unavailable explicit selection without choosing another row', async () => {
    tableMissing = true
    const hook = contextHook()
    await waitFor(() => expect(hook.result.current.error?.message).toContain('not found'))
    tableMissing = false
    act(() => hook.result.current.refresh())
    await waitFor(() => expect(hook.result.current.context?.entryStack[0]?.id).toBe('security'))
    act(() => useEditorStore.getState().setTemplatePreviewSelection('template', 'not-readable'))
    expect(hook.result.current.context).toBeUndefined()
    expect(hook.result.current.error?.message).toContain('selected entry')
    act(() => useEditorStore.getState().setTemplatePreviewSelection('template', 'security'))
    expect(hook.result.current.context?.entryStack[0]?.id).toBe('security')
  })

  it('uses the same localized primary title in the real template source selector and live path', async () => {
    render(<TemplateModeControl />)
    const live = renderHook(() => useActiveLivePath())
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Preview source' }).getAttribute('value')).toBe('Sicurezza'))
    await waitFor(() => expect(useAdminUi.getState().activeLivePath).toBe('/articles/security'))
    act(() => useEditorStore.getState().setPageLanguage('template', 'de'))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Preview source' }).getAttribute('value')).toBe('Sicherheit'))
    act(() => useEditorStore.getState().setTemplatePreviewSelection('template', 'unavailable'))
    await waitFor(() => expect(useAdminUi.getState().activeLivePath).toBeNull())
    expect(screen.getByRole('alert').textContent).toContain('selected entry')
    fireEvent.click(screen.getByRole('combobox', { name: 'Preview source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Sicherheit' }))
    await waitFor(() => expect(useAdminUi.getState().activeLivePath).toBe('/articles/security'))
    live.unmount()
  })

  it('shows real localized values in the normal binding picker and retries failures', async () => {
    fail = true
    render(<DynamicBindingControl propKey="text" label="Text" control={{ type: 'text', label: 'Text' }} onSet={() => {}} onClear={() => {}}>
      <Input aria-label="Text" />
    </DynamicBindingControl>)
    fireEvent.click(screen.getByRole('button', { name: 'Bind Text' }))
    const retry = await screen.findByRole('button', { name: 'Retry values' })
    expect(screen.getByText('Heading').closest('button')?.textContent).not.toContain('Sicurezza')
    fail = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByText('Heading').closest('button')?.textContent).toContain('Sicurezza'))
    expect(queries.every(query => query.includes('language=it'))).toBeTrue()
  })
})
