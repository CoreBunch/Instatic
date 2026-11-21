import { describe, expect, it } from 'bun:test'
import {
  extractCssSelectorClasses,
  replaceCssSelectorClassName,
  selectorBindingClassName,
  splitCssSelectorList,
} from '@core/page-tree'

describe('CSS selector class tokens', () => {
  it('decodes escaped Tailwind class names', () => {
    expect(extractCssSelectorClasses('.hover\\:bg-blue-700:hover')).toEqual([
      {
        name: 'hover:bg-blue-700',
        start: 0,
        end: 19,
        functionalDepth: 0,
      },
    ])
    expect(extractCssSelectorClasses('.\\32xl\\:grid')).toEqual([
      {
        name: '2xl:grid',
        start: 0,
        end: 12,
        functionalDepth: 0,
      },
    ])
  })

  it('finds dependency and subject classes without reading attribute values', () => {
    expect(
      extractCssSelectorClasses(
        '.group:hover .group-hover\\:block[data-file=".ignored"]',
      ).map((token) => token.name),
    ).toEqual(['group', 'group-hover:block'])
  })

  it('renames a class-word selector and preserves attribute comparisons with different semantics', () => {
    const selector = '[class~="md:flex"] > [class~=other] [class~="md:flex" i][data-label=\'[class~=other]\']'
    expect(extractCssSelectorClasses(selector).map((token) => token.name)).toEqual(['md:flex', 'other'])
    expect(replaceCssSelectorClassName(selector, 'md:flex', 'confined')).toBe(
      '.confined > [class~=other] [class~="md:flex" i][data-label=\'[class~=other]\']',
    )
  })

  it('uses the rightmost class as the binding subject', () => {
    expect(selectorBindingClassName('.group:hover .group-hover\\:block')).toBe(
      'group-hover:block',
    )
    expect(
      selectorBindingClassName('.space-x-4 > :not([hidden]) ~ :not([hidden])'),
    ).toBe('space-x-4')
    expect(selectorBindingClassName('h1 > span')).toBeNull()
  })

  it('does not mistake classes inside functional pseudos for the styled subject', () => {
    expect(selectorBindingClassName('.button:not(.disabled)')).toBe('button')
    expect(selectorBindingClassName('.card:has(.badge)')).toBe('card')
    expect(selectorBindingClassName(':is(.notice, .warning)')).toBeNull()
    expect(
      extractCssSelectorClasses('.button:not(.disabled)').map((token) => ({
        name: token.name,
        depth: token.functionalDepth,
      })),
    ).toEqual([
      { name: 'button', depth: 0 },
      { name: 'disabled', depth: 1 },
    ])
  })

  it('splits only top-level selector-list commas', () => {
    expect(splitCssSelectorList('.a:is(.b, .c), [data-label="x,y"] .d')).toEqual([
      '.a:is(.b, .c)',
      '[data-label="x,y"] .d',
    ])
  })

  it('renames decoded class tokens without touching prefixes or attribute values', () => {
    expect(
      replaceCssSelectorClassName(
        '.hover\\:bg-blue:hover .hover\\:bg-blue-x[data-x=".hover:bg-blue"]',
        'hover:bg-blue',
        'focus\\:bg-red',
      ),
    ).toBe(
      '.focus\\:bg-red:hover .hover\\:bg-blue-x[data-x=".hover:bg-blue"]',
    )
  })
})
