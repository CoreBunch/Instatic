/**
 * collectSiteCustomProperties — every CSS custom property that exists on the
 * published site: framework-generated token variables plus the properties
 * authors declared in style rules and style code assets. Admin-only editor
 * tokens never appear (they are not sourced from the site document at all).
 */
import { describe, expect, it } from 'bun:test'
import type { SiteFile } from '@core/files/schemas'
import type { StyleRule } from '@core/page-tree'
import type { FrameworkSettings } from '@core/framework-schema'
import { buildDefaultSpacingSettings } from '@core/framework'
import { collectSiteCustomProperties } from '@core/cssProjection'

const framework: FrameworkSettings = {
  colors: {
    tokens: [
      {
        id: 'primary-token',
        category: 'Brand',
        slug: 'primary',
        lightValue: 'hsla(238, 100%, 62%, 1)',
        darkValue: 'hsla(238, 100%, 42%, 1)',
        darkModeEnabled: true,
        generateUtilities: { text: true, background: true, border: false, fill: false },
        generateTransparent: false,
        generateShades: { enabled: true, count: 1 },
        generateTints: { enabled: false, count: 0 },
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
  spacing: buildDefaultSpacingSettings(),
}

function rule(overrides: Partial<StyleRule> & Pick<StyleRule, 'id' | 'name' | 'selector' | 'kind'>): StyleRule {
  return { order: 0, styles: {}, contextStyles: {}, createdAt: 1, updatedAt: 1, ...overrides }
}

function styleFile(path: string, content: string): SiteFile {
  return { id: path, path, type: 'style', content }
}

describe('collectSiteCustomProperties', () => {
  it('lists framework token variables with their values, colors then scales', () => {
    const properties = collectSiteCustomProperties({ settings: { framework }, styleRules: {}, files: [] })
    const names = properties.map((p) => p.name)
    expect(names).toContain('--primary')
    expect(names).toContain('--primary-d-1')
    expect(names).toContain('--space-m')
    expect(names.indexOf('--primary')).toBeLessThan(names.indexOf('--space-m'))
    const primary = properties.find((p) => p.name === '--primary')!
    expect(primary.origin).toBe('framework')
    expect(primary.value).toContain('hsla(238')
    expect(primary.declaredIn).toBe('Framework · colors')
  })

  it('collects properties declared in style rules, base and context styles, in cascade order', () => {
    const properties = collectSiteCustomProperties({
      settings: { framework: { colors: { tokens: [] } } },
      styleRules: {
        b: rule({ id: 'b', name: 'hero', kind: 'class', selector: '.hero', order: 2, styles: { '--hero-gap': '2rem' } }),
        a: rule({
          id: 'a',
          name: 'card',
          kind: 'class',
          selector: '.card',
          order: 1,
          styles: { '--card-pad': '12px', color: 'red' },
          contextStyles: { tablet: { '--card-pad-tablet': '8px' } },
        }),
      },
      files: [],
    })
    expect(properties.map((p) => p.name)).toEqual(['--card-pad', '--card-pad-tablet', '--hero-gap'])
    expect(properties[0]).toEqual({ name: '--card-pad', value: '12px', origin: 'rule', declaredIn: '.card' })
  })

  it('collects properties declared in style code assets, ignoring comments and other file types', () => {
    const properties = collectSiteCustomProperties({
      settings: { framework: { colors: { tokens: [] } } },
      styleRules: {},
      files: [
        styleFile('src/styles/main.css', ':root {\n  --brand: #123456;\n  --radius-xl: 2rem; /* --not-this: 1px */\n}\n.x { padding: var(--radius-xl); }'),
        { id: 'js', path: 'src/scripts/a.js', type: 'script', content: 'const x = "--fake: 1"' },
      ],
    })
    expect(properties).toEqual([
      { name: '--brand', value: '#123456', origin: 'asset', declaredIn: 'src/styles/main.css' },
      { name: '--radius-xl', value: '2rem', origin: 'asset', declaredIn: 'src/styles/main.css' },
    ])
  })

  it('keeps one entry per name — the first declaration wins across framework, rules, assets', () => {
    const properties = collectSiteCustomProperties({
      settings: { framework },
      styleRules: {
        a: rule({ id: 'a', name: 'card', kind: 'class', selector: '.card', styles: { '--primary': 'blue', '--own': '1px' } }),
      },
      files: [styleFile('src/styles/main.css', ':root { --own: 2px; --asset-only: 3px; }')],
    })
    const byName = new Map(properties.map((p) => [p.name, p]))
    expect(byName.get('--primary')?.origin).toBe('framework')
    expect(byName.get('--own')).toEqual({ name: '--own', value: '1px', origin: 'rule', declaredIn: '.card' })
    expect(byName.get('--asset-only')?.origin).toBe('asset')
    expect(properties.filter((p) => p.name === '--own')).toHaveLength(1)
  })

  it('never includes admin editor tokens', () => {
    const properties = collectSiteCustomProperties({ settings: { framework }, styleRules: {}, files: [] })
    expect(properties.some((p) => p.name.startsWith('--editor-'))).toBe(false)
  })
})
