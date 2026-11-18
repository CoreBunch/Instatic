/**
 * Unit tests for colorTokens — root-scope colour custom-property extraction.
 */

import { describe, it, expect } from 'bun:test'
import { extractRootColorTokens, isCssColorValue, normalizeImportedTokens } from '@core/siteImport'
import type { NewStyleRule } from '@core/siteImport'

function ambient(selector: string, styles: Record<string, unknown>): NewStyleRule {
  return { name: selector, kind: 'ambient', selector, order: 0, styles, contextStyles: {} }
}

describe('isCssColorValue', () => {
  it('accepts hex, rgb/hsl functions, and named colours', () => {
    for (const v of ['#fff', '#0a0a0a', '#ffffff80', 'rgb(0,0,0)', 'rgba(0,0,0,.5)',
      'hsl(0 0% 100%)', 'hsla(0,0%,0%,1)', 'oklch(0.7 0.1 200)', 'red', 'transparent',
      'rebeccapurple', 'CurrentColor']) {
      expect(isCssColorValue(v)).toBe(true)
    }
  })

  it('rejects non-colours and substitution/computed values', () => {
    for (const v of ['16px', '1.5', 'var(--bg)', 'calc(1px + 2px)', '1px solid red',
      'sans-serif', 'optimizeLegibility', '']) {
      expect(isCssColorValue(v)).toBe(false)
    }
  })
})

describe('extractRootColorTokens', () => {
  it('pulls colour custom properties out of a :root rule and removes them', () => {
    const rules = [ambient(':root', {
      '--bg': '#0a0a0a',
      '--ink': 'hsl(0 0% 96%)',
      '--font-sans': 'Inter, sans-serif',
      '--radius': '4px',
    })]
    const { rules: out, colorTokens } = extractRootColorTokens(rules)

    expect(colorTokens).toEqual([
      { slug: 'bg', value: '#0a0a0a' },
      { slug: 'ink', value: 'hsl(0 0% 96%)' },
    ])
    // The non-colour custom properties stay on the surviving :root rule.
    expect(out).toHaveLength(1)
    expect(out[0].styles).toEqual({ '--font-sans': 'Inter, sans-serif', '--radius': '4px' })
  })

  it('drops a root rule that becomes empty after extraction', () => {
    const rules = [ambient('html, body', { '--bg': '#fff', '--ink': '#111' })]
    const { rules: out, colorTokens } = extractRootColorTokens(rules)
    expect(colorTokens).toHaveLength(2)
    expect(out).toHaveLength(0)
  })

  it('leaves non-root rules and non-custom declarations untouched', () => {
    const rules = [
      ambient('.card', { '--bg': '#fff', color: 'red' }), // not root scope
      ambient(':root.theme-alt', { '--bg': '#000' }),      // qualified — not plain root
    ]
    const { rules: out, colorTokens } = extractRootColorTokens(rules)
    expect(colorTokens).toHaveLength(0)
    expect(out).toHaveLength(2)
    expect(out[0].styles).toEqual({ '--bg': '#fff', color: 'red' })
  })

  it('keeps a colour-valued NON-custom property (e.g. `color`) on the rule', () => {
    // Only `--*` custom properties become tokens; a literal `color: red` stays.
    const rules = [ambient(':root', { '--brand': '#f00', color: 'red' })]
    const { rules: out, colorTokens } = extractRootColorTokens(rules)
    expect(colorTokens).toEqual([{ slug: 'brand', value: '#f00' }])
    expect(out[0].styles).toEqual({ color: 'red' })
  })

  it('leaves an important custom property authored instead of losing its priority', () => {
    const rule = ambient(':root', { '--brand': '#f00', '--plain': '#0f0' })
    rule.stylePriorities = { '--brand': 'important' }
    const { rules: out, colorTokens } = extractRootColorTokens([rule])

    expect(colorTokens).toEqual([{ slug: 'plain', value: '#0f0' }])
    expect(out[0].styles).toEqual({ '--brand': '#f00' })
    expect(out[0].stylePriorities).toEqual({ '--brand': 'important' })
  })
})

describe('normalizeImportedTokens', () => {
  const font = (variable: string) => ({ name: variable, variable, family: 'Inter', fallback: 'sans-serif' })

  it('gives each colour token its emitted slug and maps every changed name (#615)', () => {
    const { colors, renames } = normalizeImportedTokens({
      colors: [
        { slug: 'brand---neutral--700', value: '#4f5459' },
        { slug: 'brand-primary', value: '#0575d6' },
        { slug: 'Brand-Accent', value: '#fc834b' },
      ],
      fonts: [],
    })
    expect(colors).toEqual([
      { slug: 'brand-neutral-700', value: '#4f5459' },
      { slug: 'brand-primary', value: '#0575d6' },
      { slug: 'brand-accent', value: '#fc834b' },
    ])
    expect([...renames]).toEqual([
      ['brand---neutral--700', 'brand-neutral-700'],
      ['Brand-Accent', 'brand-accent'],
    ])
  })

  it('keeps both tokens when two names normalise to the same slug', () => {
    // The name already in emitted form keeps it, wherever it appears.
    const { colors, renames } = normalizeImportedTokens({
      colors: [
        { slug: 'Brand', value: '#111' },
        { slug: 'brand', value: '#222' },
        { slug: 'brand--', value: '#333' },
      ],
      fonts: [],
    })
    expect(colors.map((t) => t.slug)).toEqual(['brand-2', 'brand', 'brand-3'])
    expect([...renames]).toEqual([['Brand', 'brand-2'], ['brand--', 'brand-3']])
  })

  it('does not rename a token onto another variable the import declares', () => {
    const { colors, renames } = normalizeImportedTokens(
      { colors: [{ slug: 'a--b', value: '#111' }, { slug: 'bg', value: '#fff' }], fonts: [] },
      // `a-b` is an unrelated variable; `bg` is the token's own override.
      new Set(['a-b', 'bg']),
    )
    expect(colors.map((t) => t.slug)).toEqual(['a-b-2', 'bg'])
    expect([...renames]).toEqual([['a--b', 'a-b-2']])
  })

  it('returns no renames when every name is already in emitted form', () => {
    const colorTokens = [{ slug: 'bg', value: '#fff' }, { slug: 'ink-2', value: '#000' }]
    const { colors, fonts, renames } = normalizeImportedTokens({ colors: colorTokens, fonts: [font('font-body')] })
    expect(colors).toEqual(colorTokens)
    expect(fonts).toEqual([font('font-body')])
    expect(renames.size).toBe(0)
  })

  it('does not rename a colour onto a font token\'s name (#619)', () => {
    const { colors, fonts, renames } = normalizeImportedTokens({
      colors: [{ slug: 'font--accent', value: '#fff' }],
      fonts: [font('font-accent')],
    })
    expect(colors.map((t) => t.slug)).toEqual(['font-accent-2'])
    expect(fonts.map((t) => t.variable)).toEqual(['font-accent'])
    expect([...renames]).toEqual([['font--accent', 'font-accent-2']])
  })

  it('does not rename a font onto a colour token\'s name (#619)', () => {
    const { colors, fonts, renames } = normalizeImportedTokens({
      colors: [{ slug: 'font-accent', value: '#fff' }],
      fonts: [font('font-Accent')],
    })
    expect(colors.map((t) => t.slug)).toEqual(['font-accent'])
    expect(fonts.map((t) => [t.name, t.variable])).toEqual([['Accent 2', 'font-accent-2']])
    expect([...renames]).toEqual([['font-Accent', 'font-accent-2']])
  })
})
