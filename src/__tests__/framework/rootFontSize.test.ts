/**
 * Framework root font size: every rem token is converted against
 * `preferences.rootFontSize`, so the framework must also set
 * `html { font-size }` or the tokens render 16 / rootFontSize times too large.
 *
 * The rule is opt-in (`emitRootFontSize`) so sites saved before the field
 * existed keep rendering byte-for-byte as they did; the Core preset opts new
 * frameworks in. The canvas and the publisher share one generator, so both are
 * asserted here.
 */
import { describe, expect, it } from 'bun:test'
import type { FrameworkPreferencesSettings, FrameworkSettings } from '@core/framework-schema'
import {
  applyFrameworkPreset,
  buildCoreFrameworkSettings,
  generateFrameworkRootCss,
  mergeCoreFrameworkSettings,
} from '@core/framework'
import { buildSiteFrameworkCss } from '@core/publisher'
import { createCanvasClassCssMemo } from '@site/canvas/canvasClassCss'
import { makeSite } from '../publisher/helpers'

const ROOT_62_5 = 'html {\n  font-size: 62.5%;\n}'

/** Preferences exactly as a site saved before `emitRootFontSize` existed stores them. */
const LEGACY_PREFERENCES: FrameworkPreferencesSettings = {
  rootFontSize: 10,
  minScreenWidth: 320,
  maxScreenWidth: 1400,
  isRem: true,
  treeShakeGeneratedFrameworkUtilities: true,
}

function siteWithFramework(framework: FrameworkSettings | undefined) {
  const site = makeSite()
  site.settings.framework = framework
  return site
}

function canvasCss(framework: FrameworkSettings) {
  const generate = createCanvasClassCssMemo()
  return generate(
    {},
    [],
    [],
    framework.colors,
    framework.typography,
    framework.spacing,
    framework.preferences,
    null,
  )
}

describe('framework root font size', () => {
  it('a new Core framework sets html font-size to 62.5% in the published CSS and the canvas', () => {
    const framework = applyFrameworkPreset({}, 'full').framework!
    expect(framework.preferences?.emitRootFontSize).toBe(true)

    const published = buildSiteFrameworkCss(siteWithFramework(framework))
    expect(published).toContain(ROOT_62_5)
    // Before the `:root` tokens and every utility, so any authored `html`
    // rule (later in the cascade) still wins.
    expect(published.indexOf(ROOT_62_5)).toBeLessThan(published.indexOf(':root {'))

    expect(canvasCss(framework)).toContain(ROOT_62_5)
  })

  it('the variables-only preset opts in too', () => {
    const framework = applyFrameworkPreset({}, 'variables').framework!
    expect(generateFrameworkRootCss(framework)).toStartWith(ROOT_62_5)
  })

  it('an existing site whose preferences predate the flag renders exactly as before', () => {
    const legacy = buildCoreFrameworkSettings({ includeUtilities: true })
    legacy.preferences = { ...LEGACY_PREFERENCES }

    const published = buildSiteFrameworkCss(siteWithFramework(legacy))
    expect(published).not.toContain('font-size: 62.5%')
    expect(published).not.toMatch(/^html\s*\{/m)
    expect(canvasCss(legacy)).not.toMatch(/^html\s*\{/m)
  })

  it('a framework with no stored preferences, or no framework at all, emits nothing new', () => {
    const noPreferences = buildCoreFrameworkSettings({ includeUtilities: false })
    delete noPreferences.preferences
    expect(generateFrameworkRootCss(noPreferences)).not.toMatch(/^html\s*\{/m)
    expect(buildSiteFrameworkCss(siteWithFramework(undefined))).toBe('')
  })

  it('re-applying the preset keeps an existing site off', () => {
    const withLegacyPreferences = buildCoreFrameworkSettings({ includeUtilities: false })
    withLegacyPreferences.preferences = { ...LEGACY_PREFERENCES }
    const reapplied = applyFrameworkPreset({ framework: withLegacyPreferences }, 'full').framework!
    expect(reapplied.preferences?.emitRootFontSize).toBeUndefined()
    expect(generateFrameworkRootCss(reapplied)).not.toMatch(/^html\s*\{/m)

    // A framework built up by hand (no stored preferences) adopts the preset's
    // preferences on merge, but not the root font-size rule.
    const handBuilt = buildCoreFrameworkSettings({ includeUtilities: false })
    delete handBuilt.preferences
    const merged = mergeCoreFrameworkSettings(handBuilt, { includeUtilities: true })
    expect(merged.preferences?.emitRootFontSize).toBe(false)
    expect(generateFrameworkRootCss(merged)).not.toMatch(/^html\s*\{/m)
  })

  it('derives the percentage from rootFontSize and skips px scales and a 16px root', () => {
    const framework = buildCoreFrameworkSettings({ includeUtilities: false })
    const withPreferences = (patch: Partial<FrameworkPreferencesSettings>) => ({
      ...framework,
      preferences: { ...LEGACY_PREFERENCES, emitRootFontSize: true, ...patch },
    })

    expect(generateFrameworkRootCss(withPreferences({ rootFontSize: 12 }))).toStartWith(
      'html {\n  font-size: 75%;\n}',
    )
    expect(generateFrameworkRootCss(withPreferences({ rootFontSize: 16 }))).not.toMatch(/^html\s*\{/m)
    expect(generateFrameworkRootCss(withPreferences({ isRem: false }))).not.toMatch(/^html\s*\{/m)
  })
})
