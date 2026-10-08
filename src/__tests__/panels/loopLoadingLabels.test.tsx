import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LoopModule } from '@modules/base/loop'
import { renderModuleTabContent } from '@site/panels/PropertiesPanel/renderModuleTabContent'
import { LoopPropertiesView } from '@site/panels/PropertiesPanel/LoopPropertiesView'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'
import { ToastProvider } from '@ui/components/Toast'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { DataTableListItemSchema } from '@core/data/schemas'
import { Value } from '@sinclair/typebox/value'
import { publishedLoopSite } from '../helpers/publishedLoopFixture'
import { makeNode, makePage, makeVC, makeVCTree } from '../fixtures'

const originalFetch = globalThis.fetch
beforeEach(() => {
  clearDataMetaCache()
  __resetToastBusForTests()
  globalThis.fetch = async () => new Response(JSON.stringify({ meta: { tables: [] } }), { headers: { 'content-type': 'application/json' } })
})
afterEach(() => {
  cleanup()
  clearDataMetaCache()
  __resetToastBusForTests()
  globalThis.fetch = originalFetch
  useEditorStore.setState({ site: null, activePageId: null, activeDocument: null, selectedNodeId: null })
})

function LoopSettings() {
  const page = useEditorStore(selectActiveCanvasPage)
  const activeDocument = useEditorStore((state) => state.activeDocument)
  const node = page?.nodes.loop ?? null
  return renderModuleTabContent({
    selectedNode: node, selectedNodeId: 'loop', definition: LoopModule,
    resolvedPropsForBreakpoint: node?.props ?? null, overrideKeys: new Set(), activeDocument,
    activePage: page, dynamicBindingsEnabled: true, enclosingLoopSource: undefined, enclosingLoopTableId: null,
    handleChange: (key, value) => useEditorStore.getState().updateNodeProps('loop', { [key]: value }),
    handlePatch: (patch) => useEditorStore.getState().updateNodeProps('loop', patch),
    onSetDynamicBinding: (key, binding) => useEditorStore.getState().setNodeDynamicBinding('loop', key, binding),
    onClearDynamicBinding: (key) => useEditorStore.getState().clearNodeDynamicBinding('loop', key),
  })
}

function loadLoop(visualComponent = false) {
  const site = publishedLoopSite()
  const loop = makeNode({ id: 'loop', moduleId: 'base.loop', props: { ...LoopModule.defaults, pagination: 'infinite' } })
  const page = makePage({ id: 'labels', language: 'en', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: ['loop'] }), loop } })
  site.pages = [page]
  if (visualComponent) site.visualComponents = [makeVC({ id: 'labels', name: 'Labels', tree: makeVCTree('loop', [loop]) })]
  useEditorStore.setState({ site, activePageId: page.id, selectedNodeId: 'loop', selectedNodeIds: ['loop'],
    activeDocument: visualComponent ? { kind: 'visualComponent', vcId: 'labels' } : { kind: 'page', pageId: page.id } })
  return { page, site }
}

describe('native loop caption authoring', () => {
  it('offers the ordinary catalogue picker and writes its language token', async () => {
    loadLoop()
    render(<LoopSettings />)
    expect(screen.getByRole('button', { name: 'Insert binding for Loading label' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Insert binding for Retry label' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Insert binding for Load more label' }))
    const message = await waitFor(() => screen.getByText('loop.more'))
    fireEvent.click(message)
    expect(useEditorStore.getState().site?.pages[0]?.nodes.loop.props.loadMoreLabel).toContain('{site.translations.loop.more}')
    expect(screen.getAllByTestId('property-control-loadMoreLabel')).toHaveLength(1)
  })

  it('exposes a loading caption as an ordinary component parameter', async () => {
    loadLoop(true)
    render(<LoopSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Expose loadMoreLabel as param' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add param' }))
    await waitFor(() => expect(useEditorStore.getState().site?.visualComponents[0]?.params).toHaveLength(1))
    const component = useEditorStore.getState().site!.visualComponents[0]!
    expect(component.params[0]?.name).toBe('loadMoreLabel')
    expect(component.tree.nodes.loop.propBindings?.loadMoreLabel?.paramId).toBe(component.params[0]?.id)
  })

  it('surfaces a failed table load as a toast and retries the actual request', async () => {
    const { page } = loadLoop()
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      return requests === 1
        ? new Response(JSON.stringify({ error: 'Permission denied' }), { status: 403, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ tables: [] }), { headers: { 'content-type': 'application/json' } })
    }
    render(<><ToastProvider /><LoopPropertiesView nodeId="loop" activePage={page} props={{ ...LoopModule.defaults, sourceId: 'data.rows' }} /></>)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Permission denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(requests).toBe(2))
  })

  it('surfaces a failed relation-row load instead of displaying an empty collection', async () => {
    const { page } = loadLoop()
    const table = Value.Create(DataTableListItemSchema)
    table.id = 'posts'
    table.name = 'Posts'
    table.fields = [{ id: 'related', label: 'Related', type: 'relation', targetTableId: 'related' }]
    let rowRequests = 0
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('/data/tables')) return new Response(JSON.stringify({ tables: [table] }), { headers: { 'content-type': 'application/json' } })
      rowRequests++
      return rowRequests === 1
        ? new Response(JSON.stringify({ error: 'Related rows unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ rows: [] }), { headers: { 'content-type': 'application/json' } })
    }
    render(<><ToastProvider /><LoopPropertiesView nodeId="loop" activePage={page}
      props={{ ...LoopModule.defaults, sourceId: 'data.rows', filters: { tableId: 'posts', cellField: 'related' } }} /></>)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Related rows unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(rowRequests).toBe(2))
  })
})
