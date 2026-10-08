import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { LocalizationError } from '@core/localization'
import { Value } from '@core/utils/typeboxHelpers'
import { readDisplayTitle, readProjectedDisplayTitle } from '../cells'
import { DataFieldSchema, type DataField } from '../schemas'
import { assertLocalizedDataReferenceAccess, compareDataCellValues, hasLocalizedDataFields, projectLocalizedDataCells, readLocalizedTextReference, resolveLocalizedTextValue } from '../localizedCells'

const title: DataField = { id: 'title', label: 'Title', type: 'localizedText' }
const contexts = {
  it: { language: 'it', translations: { articles: { security: 'Sicurezza' } } },
  de: { language: 'de', translations: { articles: { security: 'Sicherheit' } } },
}

describe('native localized data cells', () => {
  it('declares a first-class field and stores a catalogue reference', () => {
    expect(Value.Check(DataFieldSchema, title)).toBe(true)
    expect(readLocalizedTextReference({ key: 'articles.security' }, 'rows.article.cells.title')).toEqual({ key: 'articles.security' })
    expect(hasLocalizedDataFields([title])).toBe(true)
  })

  it('projects the same stored reference into the explicitly selected language', () => {
    const cells = { title: { key: 'articles.security' }, url: '/security', ordinal: 3 }
    expect(projectLocalizedDataCells(cells, [title], contexts.it, 'rows.article.cells')).toEqual({ title: 'Sicurezza', url: '/security', ordinal: 3 })
    expect(projectLocalizedDataCells(cells, [title], contexts.de, 'rows.article.cells')).toEqual({ title: 'Sicherheit', url: '/security', ordinal: 3 })
    expect(cells.title).toEqual({ key: 'articles.security' })
  })

  it('leaves ordinary text literal, including text resembling a binding expression', () => {
    const cells = { title: '{site.translations.articles.security}' }
    expect(projectLocalizedDataCells(cells, [{ ...title, type: 'text' }], contexts.de, 'rows.article.cells')).toBe(cells)
  })

  it('represents an empty draft reference explicitly as null', () => {
    expect(resolveLocalizedTextValue(null, contexts.it, 'rows.article.cells.title')).toBeNull()
    expect(resolveLocalizedTextValue(undefined, contexts.it, 'rows.article.cells.title')).toBeNull()
  })

  for (const value of ['', 'articles.security', { key: true }, { key: '.articles' }, { key: 'articles..security' }, { key: 'articles.security', text: 'embedded copy' }]) {
    it(`rejects a malformed stored reference ${JSON.stringify(value)}`, () => {
      expect(() => readLocalizedTextReference(value, 'rows.article.cells.title')).toThrow(LocalizationError)
    })
  }

  it('reports the row/field path and retains the missing-key cause', () => {
    try {
      resolveLocalizedTextValue({ key: 'articles.missing' }, contexts.de, 'rows.article.cells.title')
      throw new Error('Expected missing-key error')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalizationError)
      if (!(error instanceof LocalizationError)) throw error
      expect(error.path).toBe('rows.article.cells.title')
      expect(error.cause).toBeInstanceOf(LocalizationError)
      expect(String(error.cause)).toContain('Missing translation for "de"')
    }
  })

  it('rejects an absent language catalogue and non-leaf keys', () => {
    expect(() => resolveLocalizedTextValue({ key: 'articles.security' }, { language: 'fr' }, 'rows.article.cells.title')).toThrow(LocalizationError)
    expect(() => resolveLocalizedTextValue({ key: 'articles' }, contexts.de, 'rows.article.cells.title')).toThrow(LocalizationError)
  })

  it('preserves ordered repeater identities and authored references', () => {
    const field: DataField = { id: 'cards', label: 'Cards', type: 'repeater', fields: [title] }
    const cells = { cards: [{ id: 'first', cells: { title: { key: 'articles.security' } } }, { id: 'second', cells: { title: null } }] }
    const before = structuredClone(cells)
    const projected = projectLocalizedDataCells(cells, [field], contexts.de, 'rows.article.cells')
    expect(projected.cards).toEqual([{ id: 'first', cells: { title: 'Sicherheit' } }, { id: 'second', cells: { title: null } }])
    expect(cells).toEqual(before)
  })

  it('uses the canonical localized primary title without substituting its key', () => {
    const table = { primaryFieldId: 'title', fields: [title] }
    expect(readDisplayTitle({ title: { key: 'articles.security' } }, table, contexts.de)).toBe('Sicherheit')
    expect(() => readDisplayTitle({ title: { key: 'articles.security' } }, table)).toThrow(LocalizationError)
    expect(() => assertLocalizedDataReferenceAccess({ title: { key: 'articles.security' } }, [title], new Set(), 'rows.article.cells')).toThrow(LocalizationError)
    expect(() => assertLocalizedDataReferenceAccess({ title: { key: 'articles.security' } }, [title], new Set(['articles.security']), 'rows.article.cells')).not.toThrow()
    expect(compareDataCellValues('Artikel 2', 'Artikel 10', 'de')).toBeLessThan(0)
    expect(compareDataCellValues(2, 10, 'de', 'desc')).toBeGreaterThan(0)
    expect(compareDataCellValues(null, 10, 'de', 'desc')).toBeGreaterThan(0)
    expect(compareDataCellValues(10, null, 'de', 'asc')).toBeLessThan(0)
  })

  it('names explicit projections with the same primary-field rules and rejects raw references', () => {
    const heading = { ...title, id: 'heading' }
    const table = { primaryFieldId: 'heading', fields: [heading] }
    expect(readProjectedDisplayTitle({ heading: 'Sicherheit', title: 'Ordinary title' }, table)).toBe('Sicherheit')
    expect(() => readProjectedDisplayTitle({ heading: { key: 'articles.security' } }, table)).toThrow(LocalizationError)
    expect(readProjectedDisplayTitle({ heading: null }, table)).toBe('Untitled')
  })

  it('rejects malformed localized repeaters instead of substituting an empty collection', () => {
    const field: DataField = { id: 'cards', label: 'Cards', type: 'repeater', fields: [title] }
    expect(() => projectLocalizedDataCells({ cards: [{ cells: {} }] }, [field], contexts.de, 'rows.article.cells')).toThrow(LocalizationError)
    expect(() => projectLocalizedDataCells({ cards: [{ id: 'same', cells: {} }, { id: 'same', cells: {} }] }, [field], contexts.de, 'rows.article.cells')).toThrow(LocalizationError)
  })

  it('leaves referenced cells and the encoded Y document unchanged while switching presentation language', () => {
    const doc = new Y.Doc()
    const cells = { title: { key: 'articles.security' } }
    doc.getMap('data').set('cells', cells)
    const before = Y.encodeStateAsUpdate(doc)
    expect(projectLocalizedDataCells(cells, [title], contexts.de, 'rows.article.cells').title).toBe('Sicherheit')
    expect(projectLocalizedDataCells(cells, [title], contexts.it, 'rows.article.cells').title).toBe('Sicurezza')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, before)
    expect(peer.getMap('data').get('cells')).toEqual({ title: { key: 'articles.security' } })
    doc.destroy()
    peer.destroy()
  })
})
