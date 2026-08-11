import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AdminContextMenuGuard } from '@admin/shared/AdminContextMenuGuard'
import { DataGrid } from '@admin/pages/data/components/DataGrid/DataGrid'
import { DataSidebar } from '@admin/pages/data/components/DataSidebar/DataSidebar'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import type { DataRow, DataTable, DataTableListItem } from '@core/data/schemas'

beforeEach(() => {
  useWorkspaceLayout.setState({
    dataSidebarCollapsed: false,
    leftSidebarWidth: 320,
    rightPanel: { collapsed: false, width: 360 },
  })
})

afterEach(cleanup)

const now = '2026-06-01T10:00:00.000Z'

function makeTable(overrides: Partial<DataTable> = {}): DataTable {
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
      { type: 'text', id: 'title', label: 'Title', required: true },
      { type: 'text', id: 'slug', label: 'Slug', required: true },
    ],
    system: true,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeListItem(overrides: Partial<DataTableListItem> = {}): DataTableListItem {
  return {
    ...makeTable(),
    rowCount: 0,
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

function rowElement(label: string): HTMLElement {
  const text = screen.getByText(label)
  const row = text.closest('[role="row"]')
  if (!(row instanceof HTMLElement)) throw new Error(`No row found for ${label}`)
  return row
}

describe('Data row context menu', () => {
  it('opens page rows with site-editor, status, export, and delete actions', async () => {
    const row = makeRow()
    const onSelectRow = mock()
    const onOpenInSiteEditor = mock()
    const onDuplicateRow = mock()
    const onSetRowStatus = mock(async () => row)
    const onExportRows = mock()
    const onDeleteRow = mock()

    render(
      <DataGrid
        table={makeTable()}
        rows={[row]}
        tables={[makeTable()]}
        selectedRowId={null}
        onSelectRow={onSelectRow}
        onAddRow={() => {}}
        onDeleteRow={onDeleteRow}
        onDuplicateRow={onDuplicateRow}
        onOpenInSiteEditor={onOpenInSiteEditor}
        onSetRowStatus={onSetRowStatus}
        onExportRows={onExportRows}
      />,
    )

    fireEvent.contextMenu(rowElement('Home'), { clientX: 120, clientY: 160 })

    expect(onSelectRow).toHaveBeenCalledWith('row-home')
    expect(screen.getByRole('menu', { name: /row actions/i })).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: /open in site editor/i }))
    expect(onOpenInSiteEditor).toHaveBeenCalledWith(row)

    fireEvent.contextMenu(rowElement('Home'), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: /^publish$/i }))
    expect(onSetRowStatus).toHaveBeenCalledWith('row-home', 'published')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.contextMenu(rowElement('Home'), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: /duplicate row/i }))
    expect(onDuplicateRow).toHaveBeenCalledWith(row)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.contextMenu(rowElement('Home'), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: /export row/i }))
    expect(onExportRows).toHaveBeenCalledWith(['row-home'])

    fireEvent.contextMenu(rowElement('Home'), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: /delete row/i }))
    expect(onDeleteRow).toHaveBeenCalledWith('row-home')
  })

  it('uses the row inspector action for plain data tables and omits publish actions', () => {
    const row = makeRow({ tableId: 'table-products', cells: { title: 'Product A' }, slug: '' })
    const onOpenRow = mock()

    render(
      <DataGrid
        table={makeTable({
          id: 'table-products',
          name: 'products',
          slug: 'products',
          kind: 'data',
          singularLabel: 'Product',
          pluralLabel: 'Products',
          system: false,
        })}
        rows={[row]}
        tables={[]}
        selectedRowId={null}
        onSelectRow={() => {}}
        onAddRow={() => {}}
        onOpenRow={onOpenRow}
      />,
    )

    fireEvent.contextMenu(rowElement('Product A'), { clientX: 80, clientY: 120 })

    fireEvent.click(screen.getByRole('menuitem', { name: /open row/i }))
    expect(onOpenRow).toHaveBeenCalledWith('row-home')
    expect(screen.queryByRole('menuitem', { name: /^publish$/i })).toBeNull()
  })
})

describe('Data table context menu', () => {
  it('uses inert instead of aria-hidden for the collapsed mounted panel slot', () => {
    useWorkspaceLayout.getState().setDataSidebarCollapsed(true)

    render(
      <DataSidebar
        tables={[makeListItem({ pluralLabel: 'Pages' })]}
        loading={false}
        error={null}
        selectedTableId="table-pages"
        onSelectTable={() => {}}
        onCreateTable={() => {}}
        onOpenExport={() => {}}
        onOpenImport={() => {}}
        onOpenTableSettings={() => {}}
        onDeleteTable={() => {}}
        canCreateTable={true}
        canManage={true}
        canExport={true}
        canImport={true}
      />,
    )

    const panelSlot = screen.getByTestId('data-left-sidebar-panel-slot')
    expect(panelSlot.hasAttribute('inert')).toBe(true)
    expect(panelSlot.getAttribute('aria-hidden')).toBeNull()
  })

  it('does not mount the resize handle while the data sidebar is collapsed', () => {
    useWorkspaceLayout.getState().setDataSidebarCollapsed(true)

    render(
      <DataSidebar
        tables={[makeListItem({ pluralLabel: 'Pages' })]}
        loading={false}
        error={null}
        selectedTableId="table-pages"
        onSelectTable={() => {}}
        onCreateTable={() => {}}
        onOpenExport={() => {}}
        onOpenImport={() => {}}
        onOpenTableSettings={() => {}}
        onDeleteTable={() => {}}
        canCreateTable={true}
        canManage={true}
        canExport={true}
        canImport={true}
      />,
    )

    expect(screen.queryByRole('separator', { name: /resize data sidebar/i })).toBeNull()
    expect(
      screen.getByTestId('data-left-sidebar').style.getPropertyValue('--left-sidebar-panel-width'),
    ).toBe('0px')
    expect(
      screen.getByTestId('data-left-sidebar').style.getPropertyValue('--left-sidebar-panel-layout-width'),
    ).toBe('320px')
  })

  it('opens table settings and guarded delete actions from the sidebar', () => {
    const customTable = makeListItem({
      id: 'table-products',
      name: 'products',
      slug: 'products',
      kind: 'data',
      singularLabel: 'Product',
      pluralLabel: 'Products',
      system: false,
      rowCount: 0,
    })
    const onOpenTableSettings = mock()
    const onDeleteTable = mock()

    render(
      <DataSidebar
        tables={[customTable]}
        loading={false}
        error={null}
        selectedTableId={null}
        onSelectTable={() => {}}
        onCreateTable={() => {}}
        onOpenExport={() => {}}
        onOpenImport={() => {}}
        onOpenTableSettings={onOpenTableSettings}
        onDeleteTable={onDeleteTable}
        canCreateTable={true}
        canManage={true}
        canExport={true}
        canImport={true}
      />,
    )

    expect(screen.getByText('data').closest('[data-accent]')?.getAttribute('data-accent')).toBe('d')

    fireEvent.contextMenu(screen.getByRole('option', { name: /products/i }), {
      clientX: 60,
      clientY: 140,
    })

    fireEvent.click(screen.getByRole('menuitem', { name: /table settings/i }))
    expect(onOpenTableSettings).toHaveBeenCalledWith('table-products')

    fireEvent.contextMenu(screen.getByRole('option', { name: /products/i }), {
      clientX: 60,
      clientY: 140,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /delete table/i }))
    expect(onDeleteTable).toHaveBeenCalledWith(customTable)
  })

  it('assigns a distinct stable accent to every table kind', () => {
    render(
      <DataSidebar
        tables={[
          makeListItem({ id: 'table-pages', kind: 'page', pluralLabel: 'Pages' }),
          makeListItem({ id: 'table-posts', kind: 'postType', pluralLabel: 'Posts' }),
          makeListItem({ id: 'table-components', kind: 'component', pluralLabel: 'Components' }),
          makeListItem({ id: 'table-data', kind: 'data', pluralLabel: 'Products', system: false }),
        ]}
        loading={false}
        error={null}
        selectedTableId={null}
        onSelectTable={() => {}}
        onCreateTable={() => {}}
        onOpenExport={() => {}}
        onOpenImport={() => {}}
        onOpenTableSettings={() => {}}
        onDeleteTable={() => {}}
        canCreateTable
        canManage
        canExport
        canImport
      />,
    )

    const badgeAccents = ['page', 'post-type', 'component', 'data'].map(
      (label) => screen.getByText(label).closest('[data-accent]')?.getAttribute('data-accent'),
    )
    expect(badgeAccents).toEqual(['a', 'b', 'c', 'd'])
    expect(new Set(badgeAccents).size).toBe(badgeAccents.length)
  })

  it('disables deleting protected system tables', () => {
    render(
      <DataSidebar
        tables={[makeListItem({ pluralLabel: 'Pages', system: true, rowCount: 8 })]}
        loading={false}
        error={null}
        selectedTableId="table-pages"
        onSelectTable={() => {}}
        onCreateTable={() => {}}
        onOpenExport={() => {}}
        onOpenImport={() => {}}
        onOpenTableSettings={() => {}}
        onDeleteTable={() => {}}
        canCreateTable={true}
        canManage={true}
        canExport={true}
        canImport={true}
      />,
    )

    fireEvent.contextMenu(screen.getByRole('option', { name: /pages/i }), {
      clientX: 60,
      clientY: 140,
    })

    const deleteItem = screen.getByRole('menuitem', { name: /delete table/i })
    expect(
      deleteItem.hasAttribute('disabled') || deleteItem.getAttribute('aria-disabled') === 'true',
    ).toBe(true)
  })
})

describe('Admin context menu guard', () => {
  it('prevents unhandled native context menus and shows a danger flash', () => {
    render(<AdminContextMenuGuard />)

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 140,
      clientY: 180,
    })

    act(() => {
      expect(document.body.dispatchEvent(event)).toBe(false)
    })
    expect(screen.getByRole('status', { name: /no context menu available/i })).toBeDefined()
  })

  it('does not flash when a real app context menu already handled the event', () => {
    render(
      <>
        <AdminContextMenuGuard />
        <div data-testid="handled-menu-target" />
      </>,
    )

    const target = screen.getByTestId('handled-menu-target')
    target.addEventListener('contextmenu', (event) => event.preventDefault())
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 140,
      clientY: 180,
    })

    expect(target.dispatchEvent(event)).toBe(false)
    expect(screen.queryByRole('status', { name: /no context menu available/i })).toBeNull()
  })

  it('suppresses native right-clicks inside app menus without flashing', () => {
    render(
      <>
        <AdminContextMenuGuard />
        <div role="menu" aria-label="Existing menu" />
      </>,
    )

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 140,
      clientY: 180,
    })

    act(() => {
      expect(screen.getByRole('menu').dispatchEvent(event)).toBe(false)
    })
    expect(screen.queryByRole('status', { name: /no context menu available/i })).toBeNull()
  })
})
