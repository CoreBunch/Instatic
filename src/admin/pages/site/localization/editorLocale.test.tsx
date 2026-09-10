import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import '@modules/base'
import { makeNode, makePage, makeSite, makeVC } from '../../../../__tests__/fixtures'
import { projectSiteLocale } from '@core/localization'
import { visualComponentToCells } from '@core/data/componentFromRow'
import { useEditorStore } from '@site/store/store'
import { PropertiesPanel } from '@site/panels/PropertiesPanel'
import { ComponentParamsOverview } from '@site/panels/PropertiesPanel/ComponentParamsOverview'
import { ComponentRefView } from '@site/panels/PropertiesPanel/ComponentRefView'
import { CodeEditorPanel } from '@site/code-editor'
import { SiteExplorerPanel } from '@site/panels/SiteExplorerPanel'
import { GeneralSection } from '@admin/modals/Settings/sections/GeneralSection'
import { PublishingSection } from '@admin/modals/Settings/sections/PublishingSection'
import { EditorPermissionsProvider } from '@site/EditorPermissionsProvider'

function prepare() {
  const page = makePage({ id: 'page', nodes: {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text'] }),
    text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } }),
  } })
  const component = makeVC({ id: 'component', name: 'Card', params: [
    { id: 'title', name: 'Title', type: 'string', defaultValue: 'Welcome', required: false },
    { id: 'theme', name: 'Theme', type: 'string', defaultValue: 'light', required: false, localization: 'shared' },
    { id: 'size', name: 'Size', type: 'number', defaultValue: 12, required: false },
  ] })
  const site = makeSite({ pages: [page], visualComponents: [component], localeId: 'en', locales: [
    { id: 'en', code: 'en', name: 'English', isDefault: true, pathPrefix: '', enabled: true, direction: 'ltr' },
    { id: 'de', code: 'de', name: 'Deutsch', isDefault: false, pathPrefix: 'de', enabled: true, direction: 'ltr' },
  ], localization: {
    fieldLocalizations: {
      pages: { title: 'localized', slug: 'localized', body: 'localized', templateEnabled: 'shared' },
      components: { name: 'shared', slug: 'shared', body: 'localized', params: 'shared', classIds: 'shared', parameterDefaults: 'localized' },
    },
    rows: {
      page: { tableId: 'pages', sharedCells: { body: { rootNodeId: 'root', nodes: page.nodes }, templateEnabled: false }, localizations: { en: { cells: { title: 'Home', slug: 'index' }, slug: 'index' } } },
      component: { tableId: 'components', sharedCells: visualComponentToCells(component), localizations: {} },
    },
  } })
  useEditorStore.getState().loadSite(projectSiteLocale(site, 'en'))
  useEditorStore.getState().setActiveLocaleId('de')
  useEditorStore.getState().selectNode('text')
  useEditorStore.setState({ propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 }, activeCodeBuffer: null, codeEditorPanelOpen: false })
}

afterEach(() => { cleanup(); useEditorStore.getState().clearSite() })

describe('language authoring controls', () => {
  it('keeps text and visibility editable while hiding shared property controls', () => {
    prepare()
    render(<EditorPermissionsProvider value={{ canEditContent: true, canEditStructure: false, canEditStyle: false }}><PropertiesPanel variant="docked" /></EditorPermissionsProvider>)
    expect(screen.getByText(/Structure, styles and site settings are shared/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Styles', exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: /Convert.*component/i })).toBeNull()
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Hallo' } })
    expect(useEditorStore.getState().site!.pages[0].nodes.text.props.text).toBe('Hallo')
    fireEvent.click(screen.getByRole('switch', { name: 'Visible in this language' }))
    expect(useEditorStore.getState().site!.pages[0].nodes.text.hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }))
    expect(useEditorStore.getState().site!.pages[0].nodes.text.props.text).toBe('Hello')
    expect(useEditorStore.getState().site!.pages[0].nodes.text.hidden).not.toBe(true)
  })

  it('translates component defaults and offers only content instance parameters', () => {
    prepare()
    const component = useEditorStore.getState().site!.visualComponents[0]
    const rendered = render(<ComponentParamsOverview vc={component} />)
    expect(screen.queryByLabelText('Theme')).toBeNull()
    expect(screen.queryByLabelText('Size')).toBeNull()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Willkommen' } })
    expect(useEditorStore.getState().site!.visualComponents[0].params[0].defaultValue).toBe('Willkommen')
    rendered.unmount()
    render(<ComponentRefView nodeId="unused" componentId="component" propOverrides={{}} />)
    expect(screen.getByTestId('vc-param-row-Title')).toBeDefined()
    expect(screen.queryByTestId('vc-param-row-Theme')).toBeNull()
    expect(screen.queryByTestId('vc-param-row-Size')).toBeNull()
    act(() => useEditorStore.getState().setActiveLocaleId('en'))
    expect(useEditorStore.getState().site!.visualComponents[0].params[0].defaultValue).toBe('Welcome')
  })

  it('keeps page creation available and disables shared explorer and settings actions', () => {
    prepare()
    const rendered = render(<SiteExplorerPanel sectionGroup="site" />)
    expect(screen.getByRole('button', { name: 'New page', exact: true }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'New template', exact: true }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'New component', exact: true }).getAttribute('aria-disabled')).toBe('true')
    rendered.unmount()
    const general = render(<GeneralSection />)
    expect(screen.queryByLabelText('Site Name')).toBeNull()
    expect(screen.getByRole('button', { name: 'Switch to English' })).toBeDefined()
    general.unmount()
    render(<PublishingSection />)
    expect(screen.queryByLabelText('Public website URL')).toBeNull()
    expect(screen.getByRole('button', { name: 'Switch to English' })).toBeDefined()
  })

  it('closes a page settings draft when another workspace action switches language', () => {
    prepare()
    render(<SiteExplorerPanel sectionGroup="site" />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open page Home', exact: true }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Page settings', exact: true }))
    expect(screen.getByRole('dialog')).toBeDefined()
    act(() => useEditorStore.getState().setActiveLocaleId('en'))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => useEditorStore.getState().setActiveLocaleId('de'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useEditorStore.getState().site!.pages[0].title).toBe('Home')
  })

  it('immediately moves an authored page into Templates through the explorer dialog', () => {
    prepare()
    useEditorStore.getState().setActiveLocaleId('en')
    const page = useEditorStore.getState().addPage('Post Template', 'post-template')
    render(<SiteExplorerPanel sectionGroup="site" />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open page Post Template', exact: true }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use as template', exact: true }))
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'postTypes' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Posts', exact: true }))
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    expect(useEditorStore.getState().site!.pages.find((item) => item.id === page.id)?.template)
      .toEqual({ enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 100 })
    expect(screen.getByRole('button', { name: 'Open template Post Template', exact: true })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open page Post Template', exact: true })).toBeNull()
  })

  it('commits code-buffer edits before switching language and remounts the translated buffer', async () => {
    prepare()
    useEditorStore.getState().openPropInEditor({ nodeId: 'text', propKey: 'text', title: 'Edit text', language: 'text' })
    render(<CodeEditorPanel />)
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull())
    const first = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
    act(() => {
      first.dispatch({ changes: { from: 0, to: first.state.doc.length, insert: 'Sofort gespeichert' } })
      useEditorStore.getState().setActiveLocaleId('en')
    })
    expect(useEditorStore.getState().site!.pages[0].nodes.text.props.text).toBe('Hello')
    await waitFor(() => expect(EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)?.state.doc.toString()).toBe('Hello'))
    act(() => useEditorStore.getState().setActiveLocaleId('de'))
    await waitFor(() => expect(EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)?.state.doc.toString()).toBe('Sofort gespeichert'))
  })
})
