import { describe, expect, it } from 'bun:test'
import { generateSiteFontsCss, FontEntrySchema, parseFontDisplay } from '@core/fonts'
import { buildAssetPlan, cssToStyleRules } from '@core/siteImport'
import { parseValue } from '@core/utils/typeboxHelpers'
import { validateSite } from '@core/persistence/validate'
import { addImportedFonts } from '@site/store/slices/site/importedFonts'

describe('imported font-display', () => {
  it.each(['auto', 'block', 'swap', 'fallback', 'optional'] as const)('preserves %s from stylesheet through installed font CSS', (display) => {
    const { fontFaces } = cssToStyleRules(`@font-face { font-family: Icons; font-display: ${display}; src: url('icons.woff2') format('woff2'); }`)
    const { fonts } = buildAssetPlan([], [{ cssPath: 'main.css', rules: [], assetRefs: [], fontFaces }], {
      files: { 'icons.woff2': { bytes: new Uint8Array([1]), mimeType: 'font/woff2' } },
    })
    expect(fonts[0].files[0].fontDisplay).toBe(display)
    fonts[0].files[0].src = '/uploads/icons.woff2'
    const site = { ...validateSite({ id: 'site', name: 'Site', breakpoints: [], files: [], styleRules: {}, settings: {}, createdAt: 0, updatedAt: 0 }), pages: [], visualComponents: [] }
    addImportedFonts(site, fonts)
    const installed = parseValue(FontEntrySchema, site.settings.fonts!.items[0])
    expect(installed.files[0].fontDisplay).toBe(display)
    expect(generateSiteFontsCss({ items: [installed] })).toContain(`font-display: ${display};`)
  })

  it('uses the CSS initial value for imported faces without the descriptor', () => {
    const { fontFaces } = cssToStyleRules('@font-face { font-family: Icons; src: url("icons.woff2"); }')
    expect(fontFaces[0].fontDisplay).toBe('auto')
  })

  it('keeps the default for installed fonts and rejects unsafe descriptor values at emission', () => {
    const entry = parseValue(FontEntrySchema, { id: 'icons', source: 'custom', family: 'Icons', variants: ['400'], subsets: ['latin'], files: [{ variant: '400', subset: 'latin', path: '/uploads/icons.woff2', format: 'woff2' }], createdAt: 0, updatedAt: 0 })
    expect(generateSiteFontsCss({ items: [entry] })).toContain('font-display: swap;')
    const injection = 'block; src: url(https://attacker.example/font)'
    expect(parseFontDisplay(injection)).toBeUndefined()
    Reflect.set(entry.files[0], 'fontDisplay', injection)
    const css = generateSiteFontsCss({ items: [entry] })
    expect(css).toContain('font-display: swap;')
    expect(css).not.toContain('attacker.example')
    expect(() => parseValue(FontEntrySchema, entry)).toThrow()
  })
})
