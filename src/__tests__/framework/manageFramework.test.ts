import { describe, expect, it } from 'bun:test'
import {
  buildCoreFrameworkSettings,
  frameworkUtilityState,
  generateFrameworkUtilityClasses,
  mergeCoreFrameworkSettings,
  setFrameworkUtilities,
} from '@core/framework'

describe('frameworkUtilityState', () => {
  it('classifies absent / variables-only / full frameworks', () => {
    expect(frameworkUtilityState(undefined)).toBe('none')
    expect(frameworkUtilityState(buildCoreFrameworkSettings({ includeUtilities: false }))).toBe('variables')
    expect(frameworkUtilityState(buildCoreFrameworkSettings({ includeUtilities: true }))).toBe('full')
  })
})

describe('setFrameworkUtilities', () => {
  it('strips every generated utility class while keeping the framework (→ variables)', () => {
    const full = buildCoreFrameworkSettings({ includeUtilities: true })
    expect(Object.keys(generateFrameworkUtilityClasses(full)).length).toBeGreaterThan(0)

    const stripped = setFrameworkUtilities(full, false)
    expect(Object.keys(generateFrameworkUtilityClasses(stripped)).length).toBe(0)
    expect(frameworkUtilityState(stripped)).toBe('variables')
    // Variables still present — same token count, just no utility flags.
    expect(stripped.colors.tokens.length).toBe(full.colors.tokens.length)
    expect(stripped.preferences?.treeShakeGeneratedFrameworkUtilities).toBe(true)
  })

  it('restores the preset utilities after a variables round-trip (→ full)', () => {
    const variables = buildCoreFrameworkSettings({ includeUtilities: false })
    expect(Object.keys(generateFrameworkUtilityClasses(variables)).length).toBe(0)

    // Merge re-seeds the class generators; setFrameworkUtilities re-enables colors.
    const merged = mergeCoreFrameworkSettings(variables, { includeUtilities: true })
    const restored = setFrameworkUtilities(merged, true)
    expect(Object.keys(generateFrameworkUtilityClasses(restored)).length).toBeGreaterThan(0)
    expect(frameworkUtilityState(restored)).toBe('full')
  })

  it('is pure — it does not mutate the input settings', () => {
    const full = buildCoreFrameworkSettings({ includeUtilities: true })
    const before = Object.keys(generateFrameworkUtilityClasses(full)).length
    setFrameworkUtilities(full, false)
    expect(Object.keys(generateFrameworkUtilityClasses(full)).length).toBe(before)
  })
})

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

  it('preserves user class generators when the framework has no colors yet', () => {
    // A type/spacing-only framework (no colors) must NOT be treated as empty and
    // reset to a fresh preset — that would drop user-authored class generators.
    const existing = buildCoreFrameworkSettings({ includeUtilities: true })
    existing.colors.tokens = []
    expect(existing.spacing!.classes!.length).toBeGreaterThan(0)
    existing.spacing!.classes![0]!.id = 'user-custom-gen'

    const merged = mergeCoreFrameworkSettings(existing, { includeUtilities: true })
    // Colors get seeded in...
    expect(merged.colors.tokens.length).toBe(13)
    // ...without nuking the user's generator.
    expect(merged.spacing!.classes!.map((c) => c.id)).toContain('user-custom-gen')
  })
})
