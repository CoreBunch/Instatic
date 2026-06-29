import { describe, expect, it } from 'bun:test'
import {
  buildCoreFrameworkColorSettings,
  buildCoreFrameworkSettings,
  generateFrameworkRootCss,
  generateFrameworkUtilityClasses,
} from '@core/framework'

describe('Core Framework preset — color mapping', () => {
  it('maps the 13 default tokens across the 6 default groups', () => {
    const { tokens } = buildCoreFrameworkColorSettings({ includeUtilities: true })
    expect(tokens).toHaveLength(13)

    const categories = [...new Set(tokens.map((t) => t.category))]
    expect(categories).toEqual(['Brand', 'Background', 'Text', 'Base', 'Neutral', 'Status'])

    const slugs = tokens.map((t) => t.slug)
    expect(slugs).toContain('primary')
    expect(slugs).toContain('bg-surface')
    expect(slugs).toContain('shadow-primary')
    expect(slugs).toContain('success')
  })

  it('carries the Core Framework hsla values and dark-mode pairs', () => {
    const { tokens } = buildCoreFrameworkColorSettings({ includeUtilities: true })
    const primary = tokens.find((t) => t.slug === 'primary')!
    expect(primary.lightValue).toBe('hsla(238, 100%, 62%, 1)')
    expect(primary.darkModeEnabled).toBe(false)

    const bgBody = tokens.find((t) => t.slug === 'bg-body')!
    expect(bgBody.lightValue).toBe('hsla(0, 0%, 90%, 1)')
    expect(bgBody.darkValue).toBe('hsla(0, 0%, 5%, 1)')
    expect(bgBody.darkModeEnabled).toBe(true)
  })

  it('enables brand shades/tints from a count and disables them elsewhere', () => {
    const { tokens } = buildCoreFrameworkColorSettings({ includeUtilities: true })
    const primary = tokens.find((t) => t.slug === 'primary')!
    expect(primary.generateShades).toEqual({ enabled: true, count: 4 })
    expect(primary.generateTints).toEqual({ enabled: true, count: 4 })
    expect(primary.generateTransparent).toBe(true)

    const neutralLight = tokens.find((t) => t.slug === 'light')!
    expect(neutralLight.generateShades.enabled).toBe(false)
    expect(neutralLight.generateTints.enabled).toBe(false)
    expect(neutralLight.generateTransparent).toBe(true)
  })
})

describe('Core Framework preset — full vs variables-only', () => {
  it('full import enables utility kinds from the Core Framework gen list', () => {
    const { tokens } = buildCoreFrameworkColorSettings({ includeUtilities: true })
    const primary = tokens.find((t) => t.slug === 'primary')!
    expect(primary.generateUtilities).toEqual({
      text: true,
      background: true,
      border: true,
      fill: false,
    })
    // shadow-primary has no `gen` — never a utility class.
    const shadow = tokens.find((t) => t.slug === 'shadow-primary')!
    expect(shadow.generateUtilities).toEqual({
      text: false,
      background: false,
      border: false,
      fill: false,
    })
  })

  it('variables-only import turns every color utility kind off', () => {
    const { tokens } = buildCoreFrameworkColorSettings({ includeUtilities: false })
    for (const token of tokens) {
      expect(token.generateUtilities).toEqual({
        text: false,
        background: false,
        border: false,
        fill: false,
      })
    }
  })

  it('full import ships class generators and disables tree-shaking', () => {
    const settings = buildCoreFrameworkSettings({ includeUtilities: true })
    expect(settings.typography?.classes?.length).toBeGreaterThan(0)
    expect(settings.spacing?.classes?.length).toBeGreaterThan(0)
    expect(settings.preferences?.treeShakeGeneratedFrameworkUtilities).toBe(false)
  })

  it('variables-only import drops the scale class generators but keeps groups', () => {
    const settings = buildCoreFrameworkSettings({ includeUtilities: false })
    expect(settings.typography?.groups.length).toBeGreaterThan(0)
    expect(settings.spacing?.groups.length).toBeGreaterThan(0)
    expect(settings.typography?.classes).toEqual([])
    expect(settings.spacing?.classes).toEqual([])
  })
})

describe('Core Framework preset — generated CSS', () => {
  it('full import emits both :root variables and utility classes', () => {
    const settings = buildCoreFrameworkSettings({ includeUtilities: true })
    const rootCss = generateFrameworkRootCss(settings)
    const classes = generateFrameworkUtilityClasses(settings)

    expect(rootCss).toContain('--primary: hsla(238, 100%, 62%, 1);')
    // Scale variables emit too.
    expect(rootCss).toContain('--text-m:')
    expect(rootCss).toContain('--space-m:')

    const classNames = Object.values(classes).map((rule) => rule.name)
    expect(classNames).toContain('bg-primary')
    expect(classNames).toContain('text-primary')
  })

  it('variables-only import emits :root variables but no utility classes', () => {
    const settings = buildCoreFrameworkSettings({ includeUtilities: false })
    const rootCss = generateFrameworkRootCss(settings)
    const classes = generateFrameworkUtilityClasses(settings)

    // Base + variant variables still present.
    expect(rootCss).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(rootCss).toContain('--primary-d-1:')
    expect(rootCss).toContain('--text-m:')

    expect(Object.keys(classes)).toHaveLength(0)
  })
})
