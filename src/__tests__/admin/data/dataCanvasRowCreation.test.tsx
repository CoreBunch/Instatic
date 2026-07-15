import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataCanvas } from '@admin/pages/data/components/DataCanvas/DataCanvas'
import type { DataRow, DataTable } from '@core/data/schemas'

afterEach(cleanup)

const now = '2026-07-15T10:00:00.000Z'

function makePagesTable(overrides: Partial<DataTable> = {}): DataTable {
  return {
    id: 'table-pages',
    name: 'pages',
    slug: 'pages',
    kind: 'page',
    singularLabel: 'Page',
    pluralLabel: 'Pages',
    routeBase: '',
    primaryFieldId: 'title',
    fields: [
      { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
      { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
    ],
    system: true,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeRow(overrides: Partial<DataRow> = {}): DataRow {
  return {
    id: 'row-home',
    tableId: 'table-pages',
    cells: { title: 'Home', slug: 'index' },
    slug: 'index',
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
    ...overrides,
  }
}

function renderCanvas(table: DataTable, rows: DataRow[], overrides: Partial<React.ComponentProps<typeof DataCanvas>> = {}) {
  return render(
    <DataCanvas
      table={table}
      tables={[table]}
      rows={rows}
      loading={false}
      loadingTables={false}
      error={null}
      selectedRowId={null}
      onSelectRow={() => {}}
      onAddRow={async () => {}}
      onDeleteRow={() => {}}
      onDuplicateRow={mock()}
      onEditInContent={() => {}}
      onOpenInSiteEditor={() => {}}
      onOpenRow={() => {}}
      onSetRowStatus={async (id, status) => makeRow({ id, status })}
      canCreate
      canEdit
      canDelete
      canExport={false}
      {...overrides}
    />,
  )
}

describe('DataCanvas — row creation on locked system tables', () => {
  it('hides "Add row" and "Duplicate row" when every field on the table is a locked built-in', () => {
    renderCanvas(makePagesTable(), [makeRow()])

    expect(screen.queryByRole('button', { name: /add row/i })).toBeNull()

    fireEvent.contextMenu(screen.getByText('Home').closest('[role="row"]')!, { clientX: 100, clientY: 100 })
    expect(screen.queryByRole('menuitem', { name: /duplicate row/i })).toBeNull()
  })

  it('shows "Add row" and "Duplicate row" once the table has a custom (non-built-in) field', () => {
    const table = makePagesTable({
      fields: [
        { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
        { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
        { type: 'text', id: 'custom-note', label: 'Note', required: false },
      ],
    })
    renderCanvas(table, [makeRow()])

    expect(screen.getByRole('button', { name: /add row/i })).toBeDefined()

    fireEvent.contextMenu(screen.getByText('Home').closest('[role="row"]')!, { clientX: 100, clientY: 100 })
    expect(screen.getByRole('menuitem', { name: /duplicate row/i })).toBeDefined()
  })

  it('still hides "Add row" for a locked table even when the empty state renders', () => {
    renderCanvas(makePagesTable(), [])

    expect(screen.queryByRole('button', { name: /add row/i })).toBeNull()
    expect(screen.getByText(/no pages yet/i)).toBeDefined()
  })
})
