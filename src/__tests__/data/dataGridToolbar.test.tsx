import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { DataGridToolbar } from '@admin/pages/data/components/DataGrid/DataGridToolbar'
import type { DataTable } from '@core/data/schemas'

afterEach(cleanup)

const table: DataTable = {
  id: 'portfolio-projects',
  name: 'Portfolio projects',
  slug: 'portfolio-projects',
  kind: 'data',
  singularLabel: 'Portfolio project',
  pluralLabel: 'Portfolio projects',
  routeBase: '',
  primaryFieldId: 'name',
  system: false,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
  fields: [{ type: 'text', id: 'name', label: 'Name' }],
}

const statusCounts = {
  all: 0,
  pages: 0,
  templates: 0,
  published: 0,
  scheduled: 0,
  draft: 0,
  unpublished: 0,
}

function renderToolbar(totalCount: number) {
  return render(
    <DataGridToolbar
      table={table}
      totalCount={totalCount}
      loading={false}
      readOnly={false}
      query=""
      onQueryChange={() => undefined}
      onAddRow={() => undefined}
      hasPublishWorkflow={false}
      statusViewOrder={[]}
      statusFilter="all"
      onStatusFilterChange={() => undefined}
      statusCounts={statusCounts}
      sort={null}
      sortLabel={null}
      onClearSort={() => undefined}
    />,
  )
}

describe('DataGridToolbar', () => {
  it('uses the table name once and keeps supporting copy generic', () => {
    const { rerender } = renderToolbar(1)

    expect(screen.getAllByText('Portfolio projects')).toHaveLength(1)
    expect(screen.getByText('1 row')).toBeTruthy()
    expect(screen.getByLabelText('Search').getAttribute('placeholder')).toBe('Search…')

    rerender(
      <DataGridToolbar
        table={table}
        totalCount={2}
        loading={false}
        readOnly={false}
        query=""
        onQueryChange={() => undefined}
        onAddRow={() => undefined}
        hasPublishWorkflow={false}
        statusViewOrder={[]}
        statusFilter="all"
        onStatusFilterChange={() => undefined}
        statusCounts={statusCounts}
        sort={null}
        sortLabel={null}
        onClearSort={() => undefined}
      />,
    )

    expect(screen.getByText('2 rows')).toBeTruthy()
  })
})
