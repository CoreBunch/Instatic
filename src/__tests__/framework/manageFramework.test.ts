import { describe, expect, it } from 'bun:test'
import {
  buildCoreFrameworkSettings,
  generateFrameworkUtilityClasses,
  mergeCoreFrameworkSettings,
  pruneUnusedFrameworkTokens,
} from '@core/framework'

describe('mergeCoreFrameworkSettings', () => {
  it('is a fresh seed when there is no existing framework', () => {
    const merged = mergeCoreFrameworkSettings(undefined, { includeUtilities: true })
    expect(merged.colors.tokens.length).toBe(13)
  })

  it('adds only color tokens whose slug is missing, preserving existing ones', () => {
    const existing = buildCoreFrameworkSettings({ includeUtilities: true })
    existing.colors.tokens = existing.colors.tokens
      .filter((t) => t.slug !== 'success' && t.slug !== 'error')
      .map((t) => (t.slug === 'primary' ? { ...t, lightValue: 'hsla(1, 2%, 3%, 1)' } : t))

    const merged = mergeCoreFrameworkSettings(existing, { includeUtilities: true })
    const slugs = merged.colors.tokens.map((t) => t.slug)

    expect(slugs).toContain('success')
    expect(slugs).toContain('error')
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(merged.colors.tokens.find((t) => t.slug === 'primary')!.lightValue).toBe(
      'hsla(1, 2%, 3%, 1)',
    )
  })

  it('keeps existing preferences and only fills absent keys', () => {
    const existing = buildCoreFrameworkSettings({ includeUtilities: false })
    existing.preferences = { ...existing.preferences!, rootFontSize: 16 }
    const merged = mergeCoreFrameworkSettings(existing, { includeUtilities: true })
    expect(merged.preferences!.rootFontSize).toBe(16)
  })

  it('adds a typography group when its namingConvention is absent', () => {
    const existing = buildCoreFrameworkSettings({ includeUtilities: true })
    existing.typography = { groups: [], classes: [] }
    const merged = mergeCoreFrameworkSettings(existing, { includeUtilities: true })
    expect(merged.typography!.groups.length).toBeGreaterThan(0)
  })
})

describe('pruneUnusedFrameworkTokens', () => {
  it('drops color tokens whose generated classes are all unused', () => {
    const settings = buildCoreFrameworkSettings({ includeUtilities: true })
    const classes = generateFrameworkUtilityClasses(settings)
    const usedClassIds = new Set(
      Object.entries(classes)
        .filter(
          ([, rule]) => rule.generated?.family === 'color' && rule.generated.tokenName === 'primary',
        )
        .map(([classId]) => classId),
    )
    const { next, removedSlugs } = pruneUnusedFrameworkTokens(settings, usedClassIds)
    const keptSlugs = next.colors.tokens.map((t) => t.slug)
    expect(keptSlugs).toContain('primary')
    expect(removedSlugs).toContain('secondary')
    expect(keptSlugs).not.toContain('secondary')
  })

  it('keeps variable-only tokens that generate no classes (e.g. shadow-primary)', () => {
    const settings = buildCoreFrameworkSettings({ includeUtilities: true })
    const { next } = pruneUnusedFrameworkTokens(settings, new Set())
    expect(next.colors.tokens.map((t) => t.slug)).toContain('shadow-primary')
  })
})
