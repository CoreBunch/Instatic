import { describe, expect, it } from 'bun:test'
import { stripPostTypeBuiltInCells } from '../cells'

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
