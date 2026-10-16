/**
 * Engine tests for the framework typography & spacing modules.
 *
 * The math is ported verbatim from Core Framework, so the goal here is twofold:
 *   1. Pin the high-traffic shapes (root CSS, utility classes) so future
 *      refactors stay byte-compatible with the reference implementation.
 *   2. Sanity-check the integration points (preferences, manual mode, class
 *      generators) so the editor → publisher pipeline does not regress.
 */

import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { FrameworkPreferencesSettingsSchema } from '@core/framework-schema'
import {
  generateFrameworkRootCss,
  generateFrameworkTypographyUtilityClasses,
  generateFrameworkTypographyVariables,
} from '@core/framework'
import {
  generateFrameworkSpacingUtilityClasses,
  generateFrameworkSpacingVariables,
} from '@core/framework'
import { generateClassCSS } from '@core/publisher'
import { DEFAULT_FRAMEWORK_PREFERENCES } from '@core/framework'
import { resolveFrameworkPreferences } from '@core/framework'
import {
  buildDefaultSpacingSettings,
  buildDefaultTypographySettings,
} from '@core/framework'
import type {
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'

const NOW = 1_700_000_000_000

function fixedTypographySettings(): FrameworkTypographySettings {
  return {
    groups: [
      {
        id: 'group-text',
        name: 'Typography',
        namingConvention: 'text',
        min: { fontSize: 16, scaleRatio: 1.125 },
        max: { fontSize: 18, scaleRatio: 1.333 },
        steps: 'xs,s,m,l,xl,2xl,3xl,4xl',
        baseScaleIndex: 2,
        mode: 'fluid',
        order: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    classes: [
      {
        id: 'gen-1',
        name: 'text-*',
        property: ['font-size'],
        tabId: 'group-text',
      },
    ],
  }
}

function fixedSpacingSettings(): FrameworkSpacingSettings {
  return {
    groups: [
      {
        id: 'group-space',
        name: 'Spacing',
        namingConvention: 'space',
        min: { size: 16, scaleRatio: 1.25 },
        max: { size: 28, scaleRatio: 1.414 },
        steps: '4xs,3xs,2xs,xs,s,m,l,xl,2xl,3xl,4xl',
        baseScaleIndex: 5,
        mode: 'fluid',
        order: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    classes: [
      // `padding-*` expands to all four sides — the shorthand `padding` key
      // does not exist in CSSPropertyBag (the publisher collapses sides at
      // emission time).
      {
        id: 'gen-pad',
        name: 'padding-*',
        property: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
        tabId: 'group-space',
      },
      { id: 'gen-gap', name: 'gap-*', property: ['gap'], tabId: 'group-space' },
    ],
  }
}

describe('framework/typography', () => {
  it('emits one CSS variable per step in step order', () => {
    const variables = generateFrameworkTypographyVariables(
      fixedTypographySettings(),
      DEFAULT_FRAMEWORK_PREFERENCES,
    )
    expect(variables.map((v) => v.name)).toEqual([
      '--text-xs',
      '--text-s',
      '--text-m',
      '--text-l',
      '--text-xl',
      '--text-2xl',
      '--text-3xl',
      '--text-4xl',
    ])
    for (const variable of variables) {
      expect(variable.value).toMatch(/^clamp\(/)
      expect(variable.value).toContain('vw')
    }
  })

  it('honours the baseScaleIndex (--text-m equals min/max font sizes verbatim)', () => {
    const variables = generateFrameworkTypographyVariables(
      fixedTypographySettings(),
      DEFAULT_FRAMEWORK_PREFERENCES,
    )
    const baseVar = variables.find((v) => v.name === '--text-m')
    expect(baseVar).toBeDefined()
    // Default preferences emit rem; root_font_size = 10 → 16px → 1.6rem; 18px → 1.8rem
    expect(baseVar!.value).toContain('1.6rem')
    expect(baseVar!.value).toContain('1.8rem')
  })

  it('produces a :root block when generating root CSS', () => {
    const css = generateFrameworkRootCss({ typography: fixedTypographySettings() })
    expect(css).toMatch(/^:root \{/)
    expect(css).toContain('--text-m:')
  })

  it('returns an empty string when the module is disabled', () => {
    const css = generateFrameworkRootCss({
      typography: { ...fixedTypographySettings(), isDisabled: true },
    })
    expect(css).toBe('')
  })

  it('expands * patterns in the class generator into one class per step', () => {
    const classes = generateFrameworkTypographyUtilityClasses(fixedTypographySettings())
    const names = Object.values(classes).map((c) => c.name).sort()
    expect(names).toContain('text-xs')
    expect(names).toContain('text-m')
    expect(names).toContain('text-4xl')
    // Every generated class must reference its own step variable
    for (const cls of Object.values(classes)) {
      const step = (cls.generated as { step: string }).step
      expect(cls.styles.fontSize).toBe(`var(--text-${step})`)
    }
  })

  it('skips class generators that are disabled', () => {
    const settings = fixedTypographySettings()
    settings.classes![0].isDisabled = true
    const classes = generateFrameworkTypographyUtilityClasses(settings)
    expect(Object.keys(classes)).toHaveLength(0)
  })

  it('generates one variable per manual size in fluid_manual mode', () => {
    const manualSettings: FrameworkTypographySettings = {
      groups: [
        {
          id: 'group-manual',
          name: 'Manual',
          namingConvention: 'text',
          min: { fontSize: 16, scaleRatio: 1.125 },
          max: { fontSize: 18, scaleRatio: 1.333 },
          steps: 'm,l',
          baseScaleIndex: 0,
          mode: 'fluid_manual',
          manualSizes: [
            { id: 'a', name: 'text-m', min: 16, max: 18 },
            { id: 'b', name: 'text-l', min: 18, max: 24 },
          ],
          order: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }
    const variables = generateFrameworkTypographyVariables(
      manualSettings,
      DEFAULT_FRAMEWORK_PREFERENCES,
    )
    expect(variables.map((v) => v.name)).toEqual(['--text-m', '--text-l'])
  })
})

describe('framework/spacing', () => {
  it('emits the full step list as :root variables', () => {
    const variables = generateFrameworkSpacingVariables(
      fixedSpacingSettings(),
      DEFAULT_FRAMEWORK_PREFERENCES,
    )
    expect(variables.map((v) => v.name)).toEqual([
      '--space-4xs',
      '--space-3xs',
      '--space-2xs',
      '--space-xs',
      '--space-s',
      '--space-m',
      '--space-l',
      '--space-xl',
      '--space-2xl',
      '--space-3xl',
      '--space-4xl',
    ])
  })

  it('renders both padding-* and gap-* classes from two generators', () => {
    const classes = generateFrameworkSpacingUtilityClasses(fixedSpacingSettings())
    const names = Object.values(classes).map((c) => c.name)
    expect(names.filter((n) => n.startsWith('padding-')).length).toBe(11)
    expect(names.filter((n) => n.startsWith('gap-')).length).toBe(11)
    // Sanity: padding-* writes the four per-side keys (the schema doesn't
    // store a `padding` shorthand — that's collapsed at the publisher); gap-*
    // writes the `gap` key directly.
    for (const cls of Object.values(classes)) {
      if (cls.name.startsWith('padding-')) {
        expect(cls.styles.paddingTop).toBeDefined()
        expect(cls.styles.paddingRight).toBeDefined()
        expect(cls.styles.paddingBottom).toBeDefined()
        expect(cls.styles.paddingLeft).toBeDefined()
      }
      if (cls.name.startsWith('gap-')) {
        expect(cls.styles.gap).toBeDefined()
      }
    }
  })

  it('expands shorthand padding and margin generators into publishable per-side styles', () => {
    const settings = fixedSpacingSettings()
    settings.classes = [
      { id: 'gen-pad', name: 'padding-*', property: ['padding'], tabId: 'group-space' },
      { id: 'gen-margin', name: 'margin-*', property: ['margin'], tabId: 'group-space' },
    ]

    const classes = generateFrameworkSpacingUtilityClasses(settings)
    const padM = Object.values(classes).find((c) => c.name === 'padding-m')!
    const marginM = Object.values(classes).find((c) => c.name === 'margin-m')!
    const css = generateClassCSS({ [padM.id]: padM, [marginM.id]: marginM }, [])

    expect(padM.styles).toMatchObject({
      paddingTop: 'var(--space-m)',
      paddingRight: 'var(--space-m)',
      paddingBottom: 'var(--space-m)',
      paddingLeft: 'var(--space-m)',
    })
    expect(marginM.styles).toMatchObject({
      marginTop: 'var(--space-m)',
      marginRight: 'var(--space-m)',
      marginBottom: 'var(--space-m)',
      marginLeft: 'var(--space-m)',
    })
    expect(css).toContain('.padding-m {')
    expect(css).toContain('padding: var(--space-m);')
    expect(css).toContain('.margin-m {')
    expect(css).toContain('margin: var(--space-m);')
  })

  it('emits CSS for the published page even when no class generators are configured', () => {
    const css = generateFrameworkRootCss({
      spacing: { ...fixedSpacingSettings(), classes: undefined },
    })
    expect(css).toMatch(/^:root \{/)
    expect(css).toContain('--space-m:')
  })
})

describe('framework/preferences', () => {
  it('falls back to Core Framework defaults when settings.preferences is missing', () => {
    const resolved = resolveFrameworkPreferences(undefined)
    expect(resolved).toEqual(DEFAULT_FRAMEWORK_PREFERENCES)
  })

  it('honours per-site overrides (root font size, screen widths, isRem)', () => {
    const resolved = resolveFrameworkPreferences({
      rootFontSize: 16,
      minScreenWidth: 480,
      maxScreenWidth: 1920,
      isRem: false,
    })
    expect(resolved.rootFontSize).toBe(16)
    expect(resolved.minScreenWidth).toBe(480)
    expect(resolved.maxScreenWidth).toBe(1920)
    expect(resolved.isRem).toBe(false)
  })

  it('emits px values when isRem is false', () => {
    const css = generateFrameworkRootCss({
      typography: fixedTypographySettings(),
      preferences: { rootFontSize: 16, minScreenWidth: 320, maxScreenWidth: 1400, isRem: false },
    })
    expect(css).toContain('px,')
    expect(css).not.toMatch(/\b\d+rem\b/)
  })

  it('layers defaults over a partial settings object without re-validating', () => {
    const resolved = resolveFrameworkPreferences({
      rootFontSize: 16,
      minScreenWidth: 480,
      maxScreenWidth: 1920,
      isRem: false,
      treeShakeGeneratedFrameworkUtilities: false,
    })
    expect(resolved).toEqual({
      rootFontSize: 16,
      minScreenWidth: 480,
      maxScreenWidth: 1920,
      isRem: false,
      treeShakeGeneratedFrameworkUtilities: false,
      // Absent from the stored settings, so the default (off) is layered in.
      emitRootFontSize: false,
    })
  })

  it('rejects rootFontSize <= 0 at the schema boundary (px→rem divisor guard)', () => {
    // The constraint lives in TypeBox, not an imperative guard in
    // resolveFrameworkPreferences — division-by-zero is impossible once parsed.
    const valid = {
      rootFontSize: 10,
      minScreenWidth: 320,
      maxScreenWidth: 1400,
      isRem: true,
      treeShakeGeneratedFrameworkUtilities: true,
    }
    expect(Value.Check(FrameworkPreferencesSettingsSchema, valid)).toBe(true)
    expect(Value.Check(FrameworkPreferencesSettingsSchema, { ...valid, rootFontSize: 0 })).toBe(false)
    expect(Value.Check(FrameworkPreferencesSettingsSchema, { ...valid, rootFontSize: -5 })).toBe(false)
  })
})

describe('framework/defaults', () => {
  it('seeds typography with the Core Framework default group + class generator', () => {
    const settings = buildDefaultTypographySettings()
    expect(settings.groups).toHaveLength(1)
    expect(settings.groups[0].namingConvention).toBe('text')
    expect(settings.groups[0].steps).toBe('xs,s,m,l,xl,2xl,3xl,4xl')
    expect(settings.classes).toHaveLength(1)
    expect(settings.classes![0].name).toBe('text-*')
    expect(settings.classes![0].property).toEqual(['font-size'])
  })

  it('seeds spacing with the Core Framework default class generators (padding, margin, gap)', () => {
    const settings = buildDefaultSpacingSettings()
    expect(settings.groups).toHaveLength(1)
    expect(settings.groups[0].steps).toBe('4xs,3xs,2xs,xs,s,m,l,xl,2xl,3xl,4xl')
    const classNames = settings.classes!.map((c) => c.name)
    // Sample a few to confirm we ported the full Core Framework defaults.
    expect(classNames).toContain('padding-*')
    expect(classNames).toContain('padding-horizontal-*')
    expect(classNames).toContain('margin-vertical-*')
    expect(classNames).toContain('gap-*')
  })
})
