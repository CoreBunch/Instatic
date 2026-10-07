import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import { DynamicBindingControl } from '@site/property-controls/DynamicBindingControl'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'
import { LanguageFilesField } from '@admin/modals/Settings/sections/LanguageFilesField'
import { PageSettingsDialog } from '@admin/shared/dialogs/PageSettingsDialog'
import { Input } from '@ui/components/Input'

const originalFetch = globalThis.fetch
beforeEach(() => {
  useEditorStore.getState().clearSite()
  clearDataMetaCache()
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ meta: { tables: [] } }), { status: 200 }), { preconnect: originalFetch.preconnect })
})
afterEach(() => {
  cleanup()
  useEditorStore.getState().clearSite()
  clearDataMetaCache()
  globalThis.fetch = originalFetch
})

function setup() {
  const state = useEditorStore.getState()
  const site = state.createSite('Languages')
  const catalogues = ['it', 'en'].map((language) => ({ language,
    fileId: useEditorStore.getState().createFile(`locales/${language}.json`, 'config', JSON.stringify({ language, messages: { header: { contact: language === 'it' ? 'Contatti' : 'Contact us' } } })),
  }))
  useEditorStore.getState().updateSiteSettings({ language: 'it', localization: { catalogues } })
  useEditorStore.getState().setPageLanguage(site.pages[0].id, 'en')
  return { pageId: site.pages[0].id, catalogues }
}

describe('native language-file authoring', () => {
  it('offers real translated page URLs in the native picker and refreshes them after a slug change', async () => {
    const { pageId } = setup()
    const italian = useEditorStore.getState().addPage('Italian page', 'it/about')
    useEditorStore.getState().setPageLanguage(italian.id, 'it')
    useEditorStore.getState().setPageTranslationGroup(italian.id, 'about')
    useEditorStore.getState().setPageTranslationGroup(pageId, 'about')
    useEditorStore.getState().openPageInCanvas(pageId)
    const insert = mock(() => {})
    render(<DynamicBindingControl propKey="href" label="URL" control={{ type: 'url', label: 'URL' }}
      insertMode onInsertToken={insert} onSet={() => {}} onClear={() => {}}>
      <Input aria-label="URL" />
    </DynamicBindingControl>)
    fireEvent.click(screen.getByRole('button', { name: 'Insert binding for URL' }))
    await waitFor(() => expect(screen.getByText('it — URL')).toBeDefined())
    expect(screen.getByText('/it/about')).toBeDefined()
    act(() => useEditorStore.getState().renamePage(italian.id, italian.title, 'it/renamed'))
    await waitFor(() => expect(screen.getByText('/it/renamed')).toBeDefined())
    fireEvent.click(screen.getByText('it — URL'))
    expect(insert).toHaveBeenCalledWith('{page.translations.it.permalink}')
  })

  it('reports an ambiguous draft group in the canvas while keeping its authoring controls usable', async () => {
    const { pageId } = setup()
    const other = useEditorStore.getState().addPage('Other', 'other')
    useEditorStore.getState().setPageLanguage(other.id, 'en')
    useEditorStore.getState().setPageTranslationGroup(pageId, 'about')
    const hook = renderHook(() => {
      const page = useEditorStore((state) => state.site?.pages.find((candidate) => candidate.id === pageId) ?? null)
      return useTemplatePreviewContext(page)
    })
    expect(hook.result.current.context?.page?.translations?.en?.id).toBe(pageId)
    act(() => useEditorStore.getState().setPageTranslationGroup(other.id, 'about'))
    expect(hook.result.current.error?.message).toContain('more than one page')
    expect(hook.result.current.context).toBeUndefined()
    render(<DynamicBindingControl propKey="href" label="URL" control={{ type: 'url', label: 'URL' }}
      onSet={() => {}} onClear={() => {}}><Input aria-label="Editable URL" /></DynamicBindingControl>)
    expect(screen.getByLabelText('Editable URL').hasAttribute('disabled')).toBeFalse()
    act(() => useEditorStore.getState().setPageTranslationGroup(other.id, undefined))
    await waitFor(() => expect(hook.result.current.context?.page?.translations?.en?.id).toBe(pageId))
    expect(hook.result.current.error).toBeUndefined()
  })

  it('authors explicit relationships, rejects duplicate languages and respects structural permissions', () => {
    const { pageId } = setup()
    const other = useEditorStore.getState().addPage('Italian', 'it/about')
    useEditorStore.getState().setPageLanguage(other.id, 'it')
    useEditorStore.getState().setPageTranslationGroup(other.id, 'about')
    const site = useEditorStore.getState().site!
    const page = site.pages.find((candidate) => candidate.id === pageId)!
    const save = mock(() => {})
    const view = render(<PageSettingsDialog page={page} pages={site.pages} onCancel={() => {}} onSave={save} />)
    fireEvent.change(screen.getByLabelText('Translation group'), { target: { value: 'about' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'en', translationGroup: 'about' }))
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'IT' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBeTrue()
    expect(screen.getByRole('alert').textContent).toContain('already contains')
    view.rerender(<PageSettingsDialog page={page} pages={site.pages} canEditStructure={false} onCancel={() => {}} onSave={save} />)
    expect(screen.getByLabelText('Translation group').hasAttribute('disabled')).toBeTrue()
  })

  it('renders current page language and recovers preview after invalid JSON is corrected', async () => {
    const { catalogues } = setup()
    const hook = renderHook(() => {
      const page = useEditorStore((state) => state.site?.pages[0] ?? null)
      return useTemplatePreviewContext(page)
    })
    expect(hook.result.current.context?.site?.translations?.header).toEqual({ contact: 'Contact us' })
    act(() => useEditorStore.getState().updateFileContent(catalogues[1].fileId, '{'))
    expect(hook.result.current.error?.message).toContain('Invalid language catalogue')
    expect(hook.result.current.context).toBeUndefined()
    act(() => useEditorStore.getState().updateFileContent(catalogues[1].fileId, JSON.stringify({ language: 'en', messages: { header: { contact: 'Write to us' } } })))
    await waitFor(() => expect(hook.result.current.context?.site?.translations?.header).toEqual({ contact: 'Write to us' }))
    expect(hook.result.current.error).toBeUndefined()
  })

  it('offers dictionary keys and translated value previews through the native binding picker', async () => {
    setup()
    const insert = mock(() => {})
    render(<DynamicBindingControl propKey="text" label="Text" control={{ type: 'text', label: 'Text' }}
      insertMode onInsertToken={insert} onSet={() => {}} onClear={() => {}}>
      <Input aria-label="Text" />
    </DynamicBindingControl>)
    fireEvent.click(screen.getByRole('button', { name: 'Insert binding for Text' }))
    await waitFor(() => expect(screen.getByText('header.contact')).toBeDefined())
    expect(screen.getByText('Contact us')).toBeDefined()
    fireEvent.click(screen.getByText('header.contact'))
    expect(insert).toHaveBeenCalledWith('{site.translations.header.contact}')
    expect(screen.getByText('Translations')).toBeDefined()
  })

  it('opens the same native JSON file editor rather than editing component copy', () => {
    const { catalogues } = setup()
    const site = useEditorStore.getState().site!
    render(<LanguageFilesField settings={site.settings} onChange={useEditorStore.getState().updateSiteSettings} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit translations' })[1])
    expect(useEditorStore.getState().activeEditorFileId).toBe(catalogues[1].fileId)
    expect(useEditorStore.getState().codeEditorPanelOpen).toBeTrue()
  })

  it('creates language files in the collaborative site shell with untranslated empty values', () => {
    setup()
    const site = useEditorStore.getState().site!
    render(<LanguageFilesField settings={site.settings} onChange={useEditorStore.getState().updateSiteSettings} />)
    fireEvent.change(screen.getByLabelText('New language'), { target: { value: 'fr' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add language file' }))
    const next = useEditorStore.getState().site!
    const file = next.files.find((candidate) => candidate.path === 'locales/fr.json')!
    expect(file.type).toBe('config')
    expect(file.content).toContain('"contact": ""')
    expect(file.content).not.toContain('Contatti')
    expect(next.settings.localization?.catalogues.find((entry) => entry.language === 'fr')?.fileId).toBe(file.id)
    expect(useEditorStore.getState().activeEditorFileId).toBe(file.id)
  })

  it('edits explicit page language and can restore inheritance', () => {
    setup()
    const site = useEditorStore.getState().site!
    const save = mock(() => {})
    render(<PageSettingsDialog page={site.pages[0]} pages={site.pages} onCancel={() => {}} onSave={save} />)
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'pt-br' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenLastCalledWith({ title: site.pages[0].title, slug: site.pages[0].slug, language: 'pt-BR' })
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenLastCalledWith({ title: site.pages[0].title, slug: site.pages[0].slug })
  })
})
