/**
 * Security + determinism tests for framework CSS generation.
 *
 * 1. The framework `:root {}` variable block is now emitted through the single
 *    canonical `sanitiseCssValue` (shared with the publisher) plus a custom-
 *    property `;` guard. A token value can no longer break out of the `<style>`
 *    block, inject a sibling declaration, or smuggle a JS vector.
 * 2. Unparseable colors are dropped at the boundary instead of raw-passed.
 * 3. `generateUtilityClasses` is a pure function of its settings (static-0
 *    timestamp contract).
 */

import { describe, expect, it } from 'bun:test'
import type {
  FrameworkColorSettings,
  FrameworkSpacingSettings,
} from '@core/framework-schema'
import {
  formatCssVariableBlock,
  generateFrameworkColorVariableSets,
  generateFrameworkRootCss,
  generateFrameworkSpacingUtilityClasses,
} from '@core/framework'

// Exercise the real production emission path (the unified `:root` builder the
// publisher uses) rather than a family-specific helper, so these security
// assertions track what actually ships.
function colorRootCss(settings: FrameworkColorSettings): string {
  return generateFrameworkRootCss({ colors: settings })
}

function colorToken(lightValue: string): FrameworkColorSettings {
  return {
    tokens: [
      {
        id: 'tok',
        category: '',
        slug: 'primary',
        lightValue,
        darkValue: '',
        darkModeEnabled: false,
        generateUtilities: { text: true, background: true, border: true, fill: false },
        generateTransparent: true,
        generateShades: { enabled: true, count: 2 },
        generateTints: { enabled: true, count: 2 },
        order: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  }
}

const MALICIOUS_VALUES = [
  '</style/>',
  '</style/foo>',
  'red; --evil: url(x)',
  'expression(alert(1))',
  'javascript:x',
  'a{}b',
]

describe('framework :root variable sanitisation', () => {
  it('drops every malicious value and never emits an injected/broken declaration', () => {
    for (const bad of MALICIOUS_VALUES) {
      const css = formatCssVariableBlock(':root', [
        { name: '--safe', value: 'hsla(0, 0%, 0%, 1)' },
        { name: '--x', value: bad },
      ])
      // The single safe declaration survives; the malicious one is dropped.
      expect(css).toContain('--safe: hsla(0, 0%, 0%, 1);')
      expect(css).not.toContain('--x:')
      // No breakout / injection primitives reach the output.
      expect(css).not.toContain('</')
      expect(css).not.toContain('{}')
      expect(css.includes('--evil')).toBe(false)
      // Exactly one declaration line — no injected sibling.
      const declarationLines = css.split('\n').filter((line) => line.trim().endsWith(';'))
      expect(declarationLines).toHaveLength(1)
    }
  })

  it('emits a block with no body as empty string (every value dropped)', () => {
    const css = formatCssVariableBlock(':root', [{ name: '--x', value: 'a{}b' }])
    expect(css).toBe('')
  })

  it('neutralises a malicious color token through the full color pipeline', () => {
    const css = colorRootCss(colorToken('red; --evil: url(x)'))
    expect(css.includes('--evil')).toBe(false)
    expect(css.includes('</')).toBe(false)
    expect(css.includes('{}')).toBe(false)
    // The unparseable injected base color emits no `--primary` declaration at all.
    expect(css).not.toContain('--primary:')
  })

  it('passes a plain safe value through formatCssVariableBlock verbatim', () => {
    const css = formatCssVariableBlock(':root', [{ name: '--accent', value: '#aabbcc' }])
    expect(css).toBe(':root {\n  --accent: #aabbcc;\n}')
  })

  it('emits valid hex and hsl color tokens with their base declaration', () => {
    const hexCss = colorRootCss(colorToken('#aabbcc'))
    expect(hexCss).toContain('--primary: hsla(210, 25%, 73.33%, 1);')

    const hslCss = colorRootCss(colorToken('hsl(238, 100%, 62%)'))
    expect(hslCss).toContain('--primary: hsla(238, 100%, 62%, 1);')
  })

  it('emits an unparseable base value verbatim; derived variants are skipped', () => {
    // The base `--<slug>` must always emit — dropping it severs every
    // `var(--<slug>)` reference in imported CSS. Safety holds because
    // `formatCssVariableBlock` sanitises each value at emission.
    const sets = generateFrameworkColorVariableSets(colorToken('not-a-color'))
    expect(sets.light.map((variable) => variable.name)).toEqual(['--primary'])
    expect(sets.light[0]?.value).toBe('not-a-color')
    const css = colorRootCss(colorToken('not-a-color'))
    expect(css).toContain('--primary: not-a-color;')
  })

  it('a malicious unparseable base value is neutralised at emission, never raw-passed', () => {
    const css = colorRootCss(colorToken('red; } body { display: none'))
    expect(css).not.toContain('display: none')
    expect(css).not.toContain('}')
  })
})

function spacingSettings(): FrameworkSpacingSettings {
  return {
    groups: [
      {
        id: 'group-space',
        name: 'Spacing',
        namingConvention: 'space',
        min: { size: 16, scaleRatio: 1.25 },
        max: { size: 28, scaleRatio: 1.414 },
        steps: '2xs,xs,s,m,l,xl,2xl',
        baseScaleIndex: 3,
        mode: 'fluid',
        order: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    classes: [{ id: 'gen-gap', name: 'gap-*', property: ['gap'], tabId: 'group-space' }],
  }
}

describe('framework generateUtilityClasses determinism', () => {
  it('is a pure function of settings when updatedAt === 0', () => {
    const a = generateFrameworkSpacingUtilityClasses(spacingSettings())
    const b = generateFrameworkSpacingUtilityClasses(spacingSettings())
    expect(a).toEqual(b)
    // Static-0 contract: no live timestamp leaks in.
    for (const rule of Object.values(a)) {
      expect(rule.createdAt).toBe(0)
      expect(rule.updatedAt).toBe(0)
    }
  })
})
