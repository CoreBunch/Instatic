import { describe, expect, it } from 'bun:test'
import { readEntrySeoOverride, stripPostTypeBuiltInCells } from '../cells'

describe('stripPostTypeBuiltInCells', () => {
  it('drops the six post-type built-in field ids and keeps custom cells', () => {
    const cells = {
      title: 'Hello',
      slug: 'hello',
      body: '# Hello',
      featuredMedia: 'media_1',
      seoTitle: 'Hello — SEO',
      seoDescription: 'A description',
      subtitle: 'World',
      rating: 4,
      tags: ['a', 'b'],
    }

    expect(stripPostTypeBuiltInCells(cells)).toEqual({
      subtitle: 'World',
      rating: 4,
      tags: ['a', 'b'],
    })
  })

  it('returns an empty record when the row only has built-in cells', () => {
    expect(stripPostTypeBuiltInCells({ title: 'Hello', slug: 'hello' })).toEqual({})
  })

  it('returns an empty record for empty cells', () => {
    expect(stripPostTypeBuiltInCells({})).toEqual({})
  })
})

describe('readEntrySeoOverride', () => {
  it('returns both authored SEO fields', () => {
    expect(
      readEntrySeoOverride({ title: 'Plain Title', seoTitle: 'SEO Title', seoDescription: 'SEO Desc' }),
    ).toEqual({ title: 'SEO Title', description: 'SEO Desc' })
  })

  it('omits a field the author left blank so it falls through to site settings', () => {
    expect(readEntrySeoOverride({ title: 'Plain Title', seoTitle: 'SEO Title' })).toEqual({
      title: 'SEO Title',
    })
    expect(readEntrySeoOverride({ seoTitle: '   ', seoDescription: '' })).toEqual({})
  })

  it('never falls back to the plain title — that stays page.title', () => {
    expect(readEntrySeoOverride({ title: 'Plain Title' })).toEqual({})
  })

  it('ignores non-string cells', () => {
    expect(readEntrySeoOverride({ seoTitle: 42, seoDescription: null })).toEqual({})
  })

  it('trims surrounding whitespace', () => {
    expect(readEntrySeoOverride({ seoTitle: '  SEO Title  ' })).toEqual({ title: 'SEO Title' })
  })
})
