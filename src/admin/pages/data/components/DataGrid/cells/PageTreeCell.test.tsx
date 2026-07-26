import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createNode } from '@core/page-tree'
import { PageTreeCell } from './PageTreeCell'
import type { DataField } from '@core/data/schemas'

afterEach(cleanup)

const bodyField: Extract<DataField, { type: 'pageTree' }> = {
  type: 'pageTree',
  id: 'body',
  label: 'Body',
  builtIn: true,
}

const rootNode = createNode('base.body')
const tree = { rootNodeId: rootNode.id, nodes: { [rootNode.id]: rootNode } }

function renderCell(props: { readOnly?: boolean; onOpenEditor?: () => void }) {
  return render(
    <PageTreeCell
      field={bodyField}
      value={tree}
      onChange={() => {}}
      context="detail"
      readOnly={props.readOnly}
      onOpenEditor={props.onOpenEditor}
    />,
  )
}

function button(): HTMLButtonElement {
  return screen.getByRole('button') as HTMLButtonElement
}

describe('PageTreeCell', () => {
  // A `pageTree` cell on a system table is ALWAYS readOnly — every built-in
  // field of `pages` / `components` / `layouts` is value-locked. The button
  // navigates to the visual editor rather than editing the cell, so gating it
  // on readOnly disabled it on exactly the rows it exists for.
  it('stays enabled on a read-only cell when a handler is wired', async () => {
    let opened = 0
    renderCell({ readOnly: true, onOpenEditor: () => { opened += 1 } })

    expect(button().disabled).toBe(false)

    await userEvent.click(button())
    expect(opened).toBe(1)
  })

  it('is disabled when no handler is wired', () => {
    renderCell({ readOnly: false })
    expect(button().disabled).toBe(true)
  })

  it('labels the button for the row it can open', () => {
    renderCell({ readOnly: true, onOpenEditor: () => {} })
    expect(button().getAttribute('aria-label')).toBe('Body: Open editor')
  })
})
