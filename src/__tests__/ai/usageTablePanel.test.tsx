/**
 * UsageTablePanel — the shared scaffolding behind the audit tables (by model,
 * by user, by surface). These tests pin the behaviour the four-panel
 * de-duplication had to preserve: a titled header with a hint, numeric columns
 * rendered through the real formatNumber/formatCost helpers, and a single
 * colSpan-spanning empty row when there are no rows.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { UsageTablePanel, type UsageTableColumn } from '@admin/pages/ai/tabs/UsageTablePanel'
import { formatCost, formatNumber } from '@admin/ai/usageFormat'

type Row = { id: string; label: string; chatCount: number; costUsd: number }

const COLUMNS: ReadonlyArray<UsageTableColumn<Row>> = [
  { header: 'Label', cell: (row) => row.label },
  { header: 'Chats', numeric: true, cell: (row) => formatNumber(row.chatCount) },
  { header: 'Spend', numeric: true, cell: (row) => formatCost(row.costUsd) },
]

function renderPanel(rows: ReadonlyArray<Row>) {
  return render(
    <UsageTablePanel<Row>
      title="By widget"
      hint={`${rows.length} widgets`}
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.id}
      emptyLabel="No widget activity yet."
    />,
  )
}

describe('UsageTablePanel', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the panel header (title + hint) and every column header', () => {
    renderPanel([{ id: 'a', label: 'Alpha', chatCount: 1, costUsd: 1 }])

    expect(screen.getByRole('heading', { level: 3, name: 'By widget' })).toBeTruthy()
    expect(screen.getByText('1 widgets')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Label' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Chats' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Spend' })).toBeTruthy()
  })

  it('renders numeric columns through formatNumber / formatCost', () => {
    renderPanel([
      { id: 'a', label: 'Alpha', chatCount: 1234567, costUsd: 12.3456 },
      { id: 'b', label: 'Beta', chatCount: 0, costUsd: 0.004 },
    ])

    // formatNumber adds locale grouping and drops the fraction.
    expect(screen.getByText(formatNumber(1234567))).toBeTruthy()
    expect(screen.getByText('1,234,567')).toBeTruthy()
    // formatCost: rounds to cents, and floors tiny non-zero values to "< $0.01".
    expect(screen.getByText('$12.35')).toBeTruthy()
    expect(screen.getByText('< $0.01')).toBeTruthy()
  })

  it('renders a single colSpan empty row spanning all columns when rows is empty', () => {
    const { container } = renderPanel([])

    const emptyCell = screen.getByText('No widget activity yet.')
    expect(emptyCell.tagName).toBe('TD')
    expect(emptyCell.getAttribute('colSpan')).toBe(String(COLUMNS.length))

    // No data rows — only the header row and the single empty row exist.
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    expect(container.querySelectorAll('tbody td').length).toBe(1)
  })
})
