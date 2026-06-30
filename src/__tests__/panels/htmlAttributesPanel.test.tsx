import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    activeClassId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    focusedPanel: 'canvas',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

function loadSiteWithTrackedImage(): string {
  const rootId = 'root-1'
  const nodeId = 'image-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const imageNode = makeNode({
    id: nodeId,
    moduleId: 'base.image',
    props: {
      src: '',
      loading: 'lazy',
      htmlAttributes: { 'data-track': 'hero', id: 'hero-image' },
    },
    children: [],
  })
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: rootNode, [nodeId]: imageNode } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    selectedNodeId: nodeId,
  } as Parameters<typeof useEditorStore.setState>[0])
  return nodeId
}

function loadSiteWithPlainText(): string {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const textNode = makeNode({
    id: nodeId,
    moduleId: 'base.text',
    props: {
      text: 'Add your text here.',
      tag: 'p',
      htmlAttributes: {},
    },
    children: [],
  })
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: rootNode, [nodeId]: textNode } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    selectedNodeId: nodeId,
  } as Parameters<typeof useEditorStore.setState>[0])
  return nodeId
}

describe('HtmlAttributesPanel', () => {
  it('switches from styles to attributes and applies HTML attribute edits immediately', () => {
    const nodeId = loadSiteWithTrackedImage()
    render(<PropertiesPanel />)

    expect(screen.getByRole('textbox', { name: /add or create a css selector/i })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /^attributes$/i }))

    expect(screen.queryByRole('textbox', { name: /add or create a css selector/i })).toBeNull()
    const attributesPanel = screen.getByTestId('html-attributes-panel')
    expect(attributesPanel).toBeDefined()
    expect(within(attributesPanel).queryByText(/^Attributes$/i)).toBeNull()
    expect(screen.getByDisplayValue('id')).toBeDefined()
    expect(screen.getByDisplayValue('hero-image')).toBeDefined()
    expect(screen.getByDisplayValue('data-track')).toBeDefined()
    expect(screen.queryByRole('button', { name: /^save attributes$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: /id value/i }), {
      target: { value: 'lead-image' },
    })
    expect(useEditorStore.getState().site?.pages[0].nodes[nodeId]?.props.htmlAttributes).toEqual({
      'data-track': 'hero',
      id: 'lead-image',
    })

    fireEvent.click(screen.getByRole('button', { name: /^add attribute$/i }))
    const attributeNameInputs = screen.getAllByRole('textbox', {
      name: /^attribute name$/i,
    }) as HTMLInputElement[]
    expect(attributeNameInputs.map((input) => input.value)).toEqual(['', 'data-track', 'id'])
    fireEvent.change(attributeNameInputs[0]!, {
      target: { value: 'aria-label' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /aria-label value/i }), {
      target: { value: 'Lead image' },
    })

    const node = useEditorStore.getState().site?.pages[0].nodes[nodeId]
    expect(node?.props.htmlAttributes).toEqual({
      'aria-label': 'Lead image',
      'data-track': 'hero',
      id: 'lead-image',
    })
    expect(Object.keys(node?.props.htmlAttributes ?? {})).toEqual([
      'aria-label',
      'data-track',
      'id',
    ])

    fireEvent.click(screen.getByRole('button', { name: /^styles$/i }))

    expect(screen.getByRole('textbox', { name: /add or create a css selector/i })).toBeDefined()
  })

  it('applies the first authored attribute from an empty attributes panel', () => {
    const nodeId = loadSiteWithPlainText()
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /^attributes$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^add attribute$/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /^attribute name$/i }), {
      target: { value: 'id' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /^id value$/i }), {
      target: { value: 'hero-title' },
    })

    const node = useEditorStore.getState().site?.pages[0].nodes[nodeId]
    expect(node?.props.htmlAttributes).toEqual({ id: 'hero-title' })
  })
})
