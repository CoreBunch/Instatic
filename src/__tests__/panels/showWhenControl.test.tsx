/**
 * The "Show to" control on an element that holds the outlet.
 *
 * The outlet is where a page or an entry is placed. A rule on an element
 * around it cannot be applied to that content, so the control is switched
 * off there with a note that says what to use instead. A rule that is
 * already stored can still be removed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { ShowWhenControl } from '@site/panels/PropertiesPanel/ShowWhenControl'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

function load(boxProps: Record<string, unknown> = {}) {
  const nodes = {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['box', 'plain'] }),
    box: makeNode({ id: 'box', moduleId: 'base.container', props: boxProps, children: ['outlet'] }),
    outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet', children: [] }),
    plain: makeNode({ id: 'plain', moduleId: 'base.container', children: [] }),
  }
  const page = makePage({ id: 'page-1', rootNodeId: 'root', nodes })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  return nodes
}

beforeEach(() => {
  localStorage.clear()
})

describe('ShowWhenControl', () => {
  it('is switched off, with the reason, on an element that holds the outlet', () => {
    const nodes = load()
    render(<ShowWhenControl nodeId="box" props={nodes.box.props} readOnly={false} />)
    expect((screen.getByLabelText('Show to') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText(/holds the page content, so it cannot be limited here/)).toBeTruthy()
  })

  it('stays usable on any other element', () => {
    const nodes = load()
    render(<ShowWhenControl nodeId="plain" props={nodes.plain.props} readOnly={false} />)
    expect((screen.getByLabelText('Show to') as HTMLSelectElement).disabled).toBe(false)
    expect(screen.getByText('Every visitor gets this element.')).toBeTruthy()
  })

  it('lets a rule that is already there be removed, and says why it should be', () => {
    const nodes = load({ showWhen: { visitor: 'signedIn' } })
    render(<ShowWhenControl nodeId="box" props={nodes.box.props} readOnly={false} />)
    expect((screen.getByLabelText('Show to') as HTMLSelectElement).disabled).toBe(false)
    expect(screen.getByText(/leaves out for every visitor/)).toBeTruthy()
  })
})
