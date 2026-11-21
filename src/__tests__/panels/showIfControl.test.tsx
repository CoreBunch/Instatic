/**
 * The "Show if" control in an element's Visibility view: picking a source,
 * naming the parameter and a value stores a `showIf` condition the
 * publisher reads (`readShowIf`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ShowIfControl } from '@site/panels/PropertiesPanel/ShowIfControl'
import { useEditorStore } from '@site/store/store'
import { readShowIf } from '@core/templates'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)
beforeEach(() => localStorage.clear())

function load(boxProps: Record<string, unknown> = {}) {
  const nodes = {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['box', 'wrap'] }),
    box: makeNode({ id: 'box', moduleId: 'base.container', children: [] }),
    wrap: makeNode({ id: 'wrap', moduleId: 'base.container', props: boxProps, children: ['outlet'] }),
    outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet', children: [] }),
  }
  useEditorStore.setState({
    site: makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: 'root', nodes })] }),
    activePageId: 'page-1',
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const boxProps = () => useEditorStore.getState().site!.pages[0]!.nodes.box!.props

/** The Select primitive drives a hidden native <select> next to its combobox. */
function pick(label: string, value: string) {
  const combobox = screen.getByLabelText(label)
  fireEvent.change(document.getElementById(`${combobox.id}-native`)!, { target: { value } })
}

function renderControl() {
  cleanup()
  render(<ShowIfControl nodeId="box" props={boxProps()} readOnly={false} />)
}

describe('ShowIfControl', () => {
  it('stores a query condition as it is filled in', () => {
    load()
    renderControl()
    pick('Show if', 'query')
    renderControl()
    // No name yet: stored, read as "never", and the hint says so.
    expect(readShowIf(boxProps())).toBe('never')
    expect(screen.getByText(/Until then nobody gets this element/)).toBeTruthy()
    // Typing edits a draft; the condition is saved once, on blur or Enter.
    const before = boxProps()
    fireEvent.change(screen.getByLabelText('Parameter'), { target: { value: 'commerce' } })
    expect(boxProps()).toBe(before)
    fireEvent.blur(screen.getByLabelText('Parameter'))
    renderControl()
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'plan_changed' } })
    fireEvent.keyDown(screen.getByLabelText('Value'), { key: 'Enter' })
    expect(readShowIf(boxProps())).toEqual({ source: 'query', name: 'commerce', test: 'equals', value: 'plan_changed' })

    renderControl()
    pick('Test', 'filled')
    expect(readShowIf(boxProps())).toEqual({ source: 'query', name: 'commerce', test: 'filled' })

    renderControl()
    pick('Show if', 'always')
    expect(readShowIf(boxProps())).toBeNull()
  })

  it('saves a pending draft to the element it was typed for when another is selected', () => {
    load({ showIf: { source: 'query', name: 'commerce', test: 'filled' } })
    const props = (id: 'box' | 'wrap') => useEditorStore.getState().site!.pages[0]!.nodes[id]!.props
    useEditorStore.getState().updateNodeProps('box', { showIf: { source: 'query', name: 'old', test: 'filled' } })
    const { rerender } = render(<ShowIfControl nodeId="box" props={props('box')} readOnly={false} />)
    // Typed, then another element is picked on the canvas: no blur happens.
    fireEvent.change(screen.getByLabelText('Parameter'), { target: { value: 'status' } })
    rerender(<ShowIfControl nodeId="wrap" props={props('wrap')} readOnly={false} />)
    expect(readShowIf(props('box'))).toEqual({ source: 'query', name: 'status', test: 'filled' })
    expect(readShowIf(props('wrap'))).toEqual({ source: 'query', name: 'commerce', test: 'filled' })
  })

  it('discards a pending field if its original node was deleted', () => {
    load()
    useEditorStore.getState().updateNodeProps('box', { showIf: { source: 'query', name: 'old', test: 'filled' } })
    const view = render(<ShowIfControl nodeId="box" props={boxProps()} readOnly={false} />)
    fireEvent.change(screen.getByLabelText('Parameter'), { target: { value: 'pending' } })
    useEditorStore.getState().deleteNode('box')
    expect(() => view.unmount()).not.toThrow()
  })

  it('keeps focus in the field after Enter saves', () => {
    load()
    useEditorStore.getState().updateNodeProps('box', { showIf: { source: 'query', name: '', test: 'filled' } })
    const { rerender } = render(<ShowIfControl nodeId="box" props={boxProps()} readOnly={false} />)
    const field = screen.getByLabelText('Parameter') as HTMLInputElement
    field.focus()
    fireEvent.change(field, { target: { value: 'commerce' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(readShowIf(boxProps())).toEqual({ source: 'query', name: 'commerce', test: 'filled' })
    // The store answers with the saved condition; the same field stays focused.
    rerender(<ShowIfControl nodeId="box" props={boxProps()} readOnly={false} />)
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('commerce')
  })

  it('lets an author clear a condition with an unknown source', () => {
    load()
    useEditorStore.getState().updateNodeProps('box', { showIf: { source: 'unknown' } })
    renderControl()
    expect(screen.getByText(/This condition could not be read/)).toBeTruthy()
    pick('Show if', 'always')
    expect(readShowIf(boxProps())).toBeNull()
  })

  it('names the real problem when the value is too long', () => {
    load()
    const props = { showIf: { source: 'query', name: 'commerce', test: 'equals', value: 'x'.repeat(501) } }
    render(<ShowIfControl nodeId="box" props={props} readOnly={false} />)
    expect(screen.getByText(/Keep the value to 500 characters/)).toBeTruthy()
  })
})
