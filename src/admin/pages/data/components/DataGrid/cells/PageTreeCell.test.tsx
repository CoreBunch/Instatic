import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createNode } from '@core/page-tree'
import type { DataField } from '@core/data/schemas'
import { PageTreeCell } from './PageTreeCell'

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

describe('PageTreeCell', () => {
  it('keeps visual-editor navigation enabled when the Data cell is read-only', () => {
    const onOpenEditor = mock()
    renderCell({ readOnly: true, onOpenEditor })

    const button = screen.getByRole('button', { name: 'Body: Open editor' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onOpenEditor).toHaveBeenCalledTimes(1)
  })

  it('disables navigation when no visual-editor handler is available', () => {
    renderCell({ readOnly: false })

    const button = screen.getByRole('button', { name: 'Body: Open editor' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
