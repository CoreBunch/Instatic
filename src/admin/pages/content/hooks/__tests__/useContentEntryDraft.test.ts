/**
 * useContentEntryDraft — custom (non-built-in) field coverage.
 *
 * Custom fields live in the same `cells_json` record as the built-ins but are
 * edited generically through `setCustomCell`. This pins the three behaviors
 * the Content settings panel relies on: custom values hydrate into the draft,
 * editing one flips `isDirty`, and saving merges them back into the payload
 * without clobbering the built-in cells.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DataRow } from '@core/data/schemas'
import { useContentEntryDraft } from '../useContentEntryDraft'

afterEach(() => {
  cleanup()
  mock.restore()
})

function fakeRow(cells: DataRow['cells']): DataRow {
  return {
    id: 'row_1',
    tableId: 'tbl_posts',
    cells,
    slug: typeof cells.slug === 'string' ? cells.slug : '',
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

function renderDraft(entry: DataRow) {
  const updateSelectedEntry = mock(() => {})
  const setError = mock(() => {})
  const rendered = renderHook(() =>
    useContentEntryDraft({ selectedEntry: entry, updateSelectedEntry, setError }),
  )
  return { ...rendered, updateSelectedEntry, setError }
}

describe('useContentEntryDraft custom cells', () => {
  it('hydrates customCells from the entry, excluding built-in field ids', () => {
    const { result } = renderDraft(fakeRow({
      title: 'Hello',
      slug: 'hello',
      body: '# Hello',
      subtitle: 'World',
      rating: 4,
    }))

    expect(result.current.customCells).toEqual({ subtitle: 'World', rating: 4 })
    expect(result.current.isDirty).toBe(false)
  })

  it('marks the draft dirty when a custom cell changes', () => {
    const { result } = renderDraft(fakeRow({ title: 'Hello', slug: 'hello', subtitle: 'World' }))

    act(() => result.current.setCustomCell('subtitle', 'Universe'))

    expect(result.current.customCells).toEqual({ subtitle: 'Universe' })
    expect(result.current.isDirty).toBe(true)
  })

  it('saves custom cells merged with the built-in cells', async () => {
    const entry = fakeRow({ title: 'Hello', slug: 'hello', body: '# Hello', subtitle: 'World' })
    let patchBody: unknown = null
    spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      patchBody = JSON.parse(String(init?.body))
      const saved = fakeRow({ ...entry.cells, subtitle: 'Universe' })
      return new Response(JSON.stringify({ row: saved }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const { result, updateSelectedEntry } = renderDraft(entry)
    act(() => result.current.setCustomCell('subtitle', 'Universe'))
    await act(() => result.current.handleSaveDraft())

    await waitFor(() => expect(result.current.saveMessage).toBe('saved'))
    expect(patchBody).toEqual({
      cells: {
        title: 'Hello',
        slug: 'hello',
        body: '# Hello',
        subtitle: 'Universe',
        featuredMedia: null,
        seoTitle: '',
        seoDescription: '',
      },
    })
    expect(updateSelectedEntry).toHaveBeenCalledTimes(1)
  })
})
