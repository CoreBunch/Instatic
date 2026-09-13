import { describe, expect, it } from 'bun:test'
import { UNTITLED_ROW_TITLE, readDisplayTitle } from '@core/data/cells'
import type { DataField } from '@core/data/schemas'

const text = (id: string): DataField => ({ type: 'text', id, label: id })

describe('readDisplayTitle', () => {
  it('prefers the primary field, then the title, then the first text field', () => {
    const table = { primaryFieldId: 'name', fields: [text('name'), text('question'), text('title')] }
    expect(readDisplayTitle({ name: ' Ada ', title: 'Not this', question: 'Nor this' }, table)).toBe('Ada')
    expect(readDisplayTitle({ title: 'A title', question: 'Nor this' }, table)).toBe('A title')
    expect(readDisplayTitle({ question: 'Does the row travel?' }, table)).toBe('Does the row travel?')
  })

  it('never names a row by its id or slug', () => {
    const table = { primaryFieldId: '', fields: [text('question')] }
    expect(readDisplayTitle({ id: 'uq5VO9', slug: 'why', question: '   ' }, table)).toBe(UNTITLED_ROW_TITLE)
    expect(readDisplayTitle({ slug: 'about' })).toBe(UNTITLED_ROW_TITLE)
  })

  it('skips fields that are not text', () => {
    const table = { primaryFieldId: '', fields: [{ type: 'number', id: 'count', label: 'Count' } as DataField, text('note')] }
    expect(readDisplayTitle({ count: 3, note: 'Three' }, table)).toBe('Three')
  })
})
