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

function load() {
  const nodes = {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['box'] }),
    box: makeNode({ id: 'box', moduleId: 'base.container', children: [] }),
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
    fireEvent.change(screen.getByLabelText('Parameter'), { target: { value: 'commerce' } })
    renderControl()
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'plan_changed' } })
    expect(readShowIf(boxProps())).toEqual({ source: 'query', name: 'commerce', test: 'equals', value: 'plan_changed' })

    renderControl()
    pick('Test', 'filled')
    expect(readShowIf(boxProps())).toEqual({ source: 'query', name: 'commerce', test: 'filled' })

    renderControl()
    pick('Show if', 'always')
    expect(readShowIf(boxProps())).toBeNull()
  })
})
