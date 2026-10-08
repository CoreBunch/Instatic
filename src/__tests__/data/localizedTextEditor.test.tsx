import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { LocalizedDataProvider } from '@admin/pages/data/LocalizedDataContext'
import { useLocalizedData } from '@admin/pages/data/localizedData'
import { DataGrid } from '@admin/pages/data/components/DataGrid/DataGrid'
import { RelationPickerDialog } from '@admin/pages/data/components/RelationPickerDialog/RelationPickerDialog'
import { RowDetail } from '@admin/pages/data/components/DataInspector/RowDetail'
import { ContentExplorerPanel } from '@admin/pages/content/components/ContentExplorerPanel/ContentExplorerPanel'
import { LocalizedTextCell } from '@admin/pages/data/components/DataGrid/cells/LocalizedTextCell'
import { filterAndSortRows } from '@admin/pages/data/components/DataGrid/dataGridRows'
import type { DataRow, DataTable } from '@core/data/schemas'
import { LocalizationError } from '@core/localization'

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const field = { id: 'heading', type: 'localizedText', label: 'Heading' } as const
const table: DataTable = { id: 'entries', name: 'Entries', slug: 'entries', kind: 'data', routeBase: '/entries', singularLabel: 'Entry', pluralLabel: 'Entries', primaryFieldId: field.id, fields: [field], system: false, createdByUserId: null, updatedByUserId: null, createdAt: '', updatedAt: '' }
const dictionaries = { it: { titles: { a: 'Zebra italiana', b: 'Albero italiano' } }, de: { titles: { a: 'Apfel Deutsch', b: 'Zebra Deutsch' } } }
const rows: DataRow[] = ['a', 'b'].map(id => ({ id, tableId: table.id, cells: { heading: { key: `titles.${id}` } },
  slug: id, status: 'draft', createdByUserId: null, updatedByUserId: null, authorUserId: null,
  publishedByUserId: null, author: null, createdBy: null, updatedBy: null, publishedBy: null,
  createdAt: '', updatedAt: '', publishedAt: null, scheduledPublishAt: null, deletedAt: null, seq: 0 }))

function GridConsumer() {
  const localization = useLocalizedData()
  return localization?.context ? <DataGrid table={table} rows={rows} tables={[table]}
    selectedRowId={null} onSelectRow={() => {}} readOnly /> : <p>Language projection required</p>
}

function Harness({ initial = null }: { initial?: unknown }) {
  const [value, setValue] = useState(initial)
  return <LocalizedDataProvider tables={[table]} revision={value}>
    <LocalizedTextCell field={field} value={value} onChange={setValue} context="detail" />
    <output data-testid="stored-value">{JSON.stringify(value)}</output>
  </LocalizedDataProvider>
}

function stubCatalogues() {
  const calls: string[] = []
  globalThis.fetch = mock(async input => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.search)
    const language = url.searchParams.get('language')
    const body = { languages: ['it', 'de'], canBrowseCatalogue: true, ...(language ? { language, translations: dictionaries[language as keyof typeof dictionaries] } : {}) }
    return Response.json(body)
  }) as typeof fetch
  return calls
}

async function select(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

describe('native localized-text editor', () => {
  it('requires a language choice, authors one key and changes the projection without writing text', async () => {
    const calls = stubCatalogues()
    render(<Harness />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(screen.getByRole('combobox', { name: 'Content language' }).textContent).not.toContain('it')
    expect(screen.getByTestId('stored-value').textContent).toBe('null')
    await select('Content language', 'it')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Heading catalogue key' }).getAttribute('aria-disabled')).not.toBe('true'))
    await select('Heading catalogue key', 'titles.a — Zebra italiana')
    expect(screen.getByTestId('stored-value').textContent).toBe('{"key":"titles.a"}')
    await screen.findByText('Zebra italiana')
    await select('Content language', 'de')
    await screen.findByText('Apfel Deutsch')
    expect(screen.getByTestId('stored-value').textContent).toBe('{"key":"titles.a"}')
    expect(calls.some(query => query.includes('language=de'))).toBe(true)
    await select('Heading catalogue key', 'No catalogue key')
    expect(screen.getByTestId('stored-value').textContent).toBe('null')
    expect(screen.queryByText('Apfel Deutsch')).toBeNull()
  })

  it('shows a malformed reference error beside the native key editor', async () => {
    stubCatalogues()
    render(<Harness initial={{ key: 'titles.a', text: 'embedded' }} />)
    expect(screen.getByRole('alert').textContent).toContain('Expected a language-catalogue text reference')
    expect(screen.getByTestId('stored-value').textContent).toContain('embedded')
    await waitFor(() => expect(document.querySelector('select')?.options.length).toBe(2))
  })

  it('keeps language choices recoverable after a failed projection and retries without writing a different language', async () => {
    let failure = true
    globalThis.fetch = mock(async input => {
      const language = new URL(String(input), 'http://localhost').searchParams.get('language')
      if (language === 'de' && failure) return Response.json({ error: 'German catalogue is unavailable' }, { status: 422 })
      return Response.json({ languages: ['it', 'de'], canBrowseCatalogue: true,
        ...(language ? { language, translations: dictionaries[language as keyof typeof dictionaries] } : {}) })
    }) as typeof fetch
    render(<Harness initial={{ key: 'titles.a' }} />)
    await select('Content language', 'it')
    await screen.findByText('Zebra italiana')
    await select('Content language', 'de')
    const retry = await screen.findByRole('button', { name: 'Retry language data' })
    expect(screen.queryByText('Zebra italiana')).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Content language' }))
    expect(await screen.findByRole('option', { name: 'it' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Content language' }), { key: 'Escape' })
    failure = false
    fireEvent.click(retry)
    await screen.findByText('Apfel Deutsch')
    expect(screen.getByTestId('stored-value').textContent).toBe('{"key":"titles.a"}')
  })

  it('uses the selected projection for actual grid titles, sorting and search', async () => {
    stubCatalogues()
    render(<LocalizedDataProvider tables={[table]} revision={rows}><GridConsumer /></LocalizedDataProvider>)
    await select('Content language', 'it')
    const grid = await screen.findByRole('grid', { name: 'Entries data grid' })
    await within(grid).findByText('Zebra italiana')
    fireEvent.click(screen.getByRole('columnheader', { name: 'Heading' }))
    expect([...grid.querySelectorAll('[role="row"][data-data-grid-row-id]')].map(element => element.getAttribute('data-data-grid-row-id'))).toEqual(['b', 'a'])
    await select('Content language', 'de')
    await within(await screen.findByRole('grid')).findByText('Apfel Deutsch')
    expect([...screen.getByRole('grid').querySelectorAll('[role="row"][data-data-grid-row-id]')].map(element => element.getAttribute('data-data-grid-row-id'))).toEqual(['a', 'b'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Apfel' } })
    await waitFor(() => expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('1'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'titles.a' } })
    await waitFor(() => expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('0'))
    expect(rows[0]?.cells.heading).toEqual({ key: 'titles.a' })
  })

  it('shows and searches related row titles in the chosen language while selection stores row identities', async () => {
    const pick = mock(() => {})
    globalThis.fetch = mock(async input => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/rows')) return Response.json({ rows })
      const language = url.searchParams.get('language')
      return Response.json({ languages: ['it', 'de'], canBrowseCatalogue: false,
        ...(language ? { language, translations: dictionaries[language as keyof typeof dictionaries] } : {}) })
    }) as typeof fetch
    render(<LocalizedDataProvider tables={[table]} revision={rows}>
      <RelationPickerDialog open targetTable={table} currentValue={null} allowMultiple={false} onClose={() => {}} onPick={pick} />
    </LocalizedDataProvider>)
    await screen.findByText('Choose a content language')
    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true)
    await select('Content language', 'de')
    const option = await screen.findByRole('option', { name: 'Apfel Deutsch' })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Apfel' } })
    expect(screen.queryByRole('option', { name: 'Zebra Deutsch' })).toBeNull()
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(pick).toHaveBeenCalledWith('a')
    expect(rows[0]?.cells.heading).toEqual({ key: 'titles.a' })
  })

  it('uses the same localized primary title in the inspector and Content explorer', async () => {
    stubCatalogues()
    const postTable: DataTable = { ...table, kind: 'postType' }
    const inert = () => {}
    render(<LocalizedDataProvider tables={[postTable]} revision={rows}>
      <section aria-label="Inspector proof"><RowDetail row={rows[0]!} table={postTable} tables={[postTable]}
        onSaveRow={async () => rows[0]!} resolveRow={() => null} canEdit={false} /></section>
      <section aria-label="Explorer proof"><ContentExplorerPanel loading={false} error={null} collections={[postTable]}
        entries={rows} selectedCollection={postTable} selectedCollectionId={postTable.id} selectedEntryId="a"
        canCreateCollection={false} canCreateEntry={false} canManageCollections={false} canEditEntry={() => false}
        canMoveEntry={() => false} canPublishEntry={() => false} getFeaturedMediaAssetForEntry={() => null}
        onSelectCollection={inert} onSelectEntry={inert} onClose={inert} entryActions={{ createCollection: inert,
          updateCollection: inert, deleteCollection: inert, createEntry: inert, renameEntry: inert, publishEntry: inert,
          convertEntryToDraft: inert, deleteEntry: inert, duplicateEntry: inert, moveEntryToCollection: inert }} /></section>
    </LocalizedDataProvider>)
    expect(within(screen.getByRole('region', { name: 'Inspector proof' })).queryByText('Zebra italiana')).toBeNull()
    await select('Content language', 'de')
    await within(screen.getByRole('region', { name: 'Explorer proof' })).findByText('Apfel Deutsch')
    expect(within(screen.getByRole('region', { name: 'Inspector proof' })).getAllByText('Apfel Deutsch').length).toBeGreaterThan(0)
    expect(screen.queryByText('Zebra italiana')).toBeNull()
    expect(rows[0]?.cells.heading).toEqual({ key: 'titles.a' })
  })

  it('filters and sorts derived texts while returning the original row objects', () => {
    const a = { id: 'a', cells: { heading: { key: 'titles.a' } }, status: 'draft' } as DataRow
    const b = { id: 'b', cells: { heading: { key: 'titles.b' } }, status: 'draft' } as DataRow
    const input = { rows: [a, b], table, hasPublishWorkflow: false, statusFilter: 'all' as const, query: '', sort: { fieldId: field.id, dir: 'asc' as const } }
    expect(filterAndSortRows({ ...input, localization: { language: 'it', translations: dictionaries.it } })).toEqual([b, a])
    expect(filterAndSortRows({ ...input, localization: { language: 'de', translations: dictionaries.de } })).toEqual([a, b])
    expect(filterAndSortRows({ ...input, query: 'Apfel', localization: { language: 'de', translations: dictionaries.de } })[0]).toBe(a)
    expect(filterAndSortRows({ ...input, query: 'titles.a', localization: { language: 'de', translations: dictionaries.de } })).toEqual([])
    expect(() => filterAndSortRows(input)).toThrow(LocalizationError)
    expect(a.cells.heading).toEqual({ key: 'titles.a' })
  })
})
