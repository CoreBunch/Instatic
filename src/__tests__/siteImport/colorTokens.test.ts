/**
 * Unit tests for colorTokens — root-scope colour custom-property extraction.
 */

import { describe, it, expect } from 'bun:test'
import { extractRootColorTokens, isCssColorValue } from '@core/siteImport'
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
