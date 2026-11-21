/**
 * Site themes: extract a site's design variables (bundle or live site), plan
 * applying them to another site (the theme's values REPLACE the site's), and
 * commit through the fragment engine's media and font machinery, with an
 * in-memory adapter applying the store transaction to a plain site document
 * (plus the editor's framework reconcile).
 */

import { describe, expect, it } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
  FRAGMENT_PROPERTIES_ORIGIN,
  FragmentCommitError,
  FragmentParseError,
  applyResolvedTheme,
  commitThemePlan,
  extractTheme,
  fragmentSourceFromBundle,
  fragmentSourceFromSite,
  parseSiteTheme,
  planThemeApply,
  readThemePackage,
  writeThemePackage,
  type FragmentMedia,
  type SiteTheme,
  type ThemeApplyAdapter,
} from '@core/fragments'
import type { FontEntry } from '@core/fonts'
import type { SiteDocument, StyleRule } from '@core/page-tree'
import { reconcileFrameworkClasses } from '@site/store/slices/site/framework/reconcile'
import {
  makeSourceBundle,
  makeSourceSite,
  makeTargetSite,
  mediaBytesFor,
  rule,
  sourceWithBytes,
} from './fixtures'

const T = 1_700_000_000_000

/** The source site's theme. Extraction does not mutate its result, so tests share it. */
const sourceTheme = await extractTheme(sourceWithBytes())

function themeWith(change: (theme: SiteTheme) => void): SiteTheme {
  const theme = structuredClone(sourceTheme.theme)
  change(theme)
  return parseSiteTheme(theme)
}

/** The source site with `--texture` on its root pointing at a library image. */
function sourceWithTexture() {
  const site = makeSourceSite()
  site.styleRules['cls-root'].styles['--texture'] = "url('/uploads/bg.jpg')"
  return sourceWithBytes(site)
}

function memoryAdapter(site: SiteDocument, fail?: 'upload' | 'font') {
  const library: { id: string; url: string; filename: string; mimeType: string; sizeBytes: number }[] = []
  let seq = 0
  const adapter: ThemeApplyAdapter = {
    async findMedia(media) {
      const hit = library.find((a) => a.filename === media.filename && a.mimeType === media.mimeType && a.sizeBytes === media.sizeBytes)
      return hit ? { id: hit.id, url: hit.url } : null
    },
    async uploadMedia(file) {
      if (fail === 'upload') throw new Error('disk full')
      seq += 1
      const asset = { id: `m${seq}`, url: `/uploads/new-${seq}-${file.filename}`, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength }
      library.push(asset)
      return { id: asset.id, url: asset.url }
    },
    async installGoogleFont(request) {
      return { id: `g-${request.family}`, source: 'google', family: request.family, variants: request.variants, subsets: request.subsets, files: [], createdAt: 1, updatedAt: 1 }
    },
    async registerCustomFont(request) {
      if (fail === 'font') throw new Error('bad font file')
      const entry: FontEntry = {
        id: `font-${++seq}`,
        source: 'custom',
        family: request.family,
        variants: request.files.map((f) => f.variant),
        subsets: ['latin'],
        files: request.files.map((f) => ({
          variant: f.variant,
          subset: 'latin',
          path: library.find((a) => a.id === f.mediaAssetId)!.url,
          format: 'woff2' as const,
          mediaAssetId: f.mediaAssetId,
        })),
        createdAt: 1,
        updatedAt: 1,
      }
      return entry
    },
    async commit(plan) {
      const applied = applyResolvedTheme(site, plan)
      if (applied.frameworkChanged) reconcileFrameworkClasses(site)
    },
  }
  return adapter
}

const readBytes = (media: FragmentMedia) => mediaBytesFor(media.id)

async function applyTo(site: SiteDocument, theme: SiteTheme = sourceTheme.theme, fail?: 'upload' | 'font') {
  const plan = planThemeApply({ site }, theme)
  const result = await commitThemePlan(plan, memoryAdapter(site, fail), { readMediaBytes: readBytes })
  return { plan, result }
}

/** A target that already binds `font-heading` to a Google family. */
function targetWithFonts(families: FontEntry[], familyId: string): SiteDocument {
  const site = makeTargetSite()
  site.settings.fonts = {
    items: families,
    tokens: [{ id: 'tk-h', name: 'Headline', variable: 'font-heading', familyId, fallback: 'serif', order: 0, createdAt: T, updatedAt: T }],
  }
  return site
}

const roboto: FontEntry = { id: 'f-roboto', source: 'google', family: 'Roboto', variants: ['400'], subsets: ['latin'], files: [], createdAt: T, updatedAt: T }

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

describe('extractTheme', () => {
  it('takes every design variable of a live site and none of its content', () => {
    const { theme, mediaBytes, warnings } = sourceTheme
    expect(theme.format).toBe('instatic-theme')
    expect(theme.colors.map((c) => c.slug)).toEqual(['primary', 'accent', 'unused'])
    expect(theme.colors[0].generateShades).toEqual({ enabled: true, count: 3 })
    expect(theme.fontTokens.map((t) => [t.variable, t.familyId])).toEqual([['font-heading', 'font-inter']])
    expect(theme.fontFamilies.map((f) => f.family)).toEqual(['Inter'])
    expect(theme.typography.map((g) => [g.namingConvention, g.steps, g.baseScaleIndex])).toEqual([['text', 'xs,s,m,l,xl,2xl', 2]])
    expect(theme.spacing.map((g) => [g.namingConvention, g.steps])).toEqual([['space', 's,m,l']])
    expect(theme.customProperties).toEqual({ '--radius': '12px', '--shadow': '0 0 4px var(--primary-50)', '--unused-prop': '1px' })
    // Only the custom font file travels; the page's images do not.
    expect(theme.media.map((m) => m.filename)).toEqual(['inter.woff2'])
    expect(theme.media[0].src).toMatch(/^media\/[0-9a-f]{64}\.woff2$/)
    expect([...mediaBytes.keys()]).toEqual(['media-font'])
    expect(warnings).toEqual([])
    expect(Object.keys(theme).sort()).toEqual(
      ['colors', 'customProperties', 'fontFamilies', 'fontTokens', 'format', 'media', 'spacing', 'typography', 'version'],
    )
  })

  it('extracts the same theme from a site-transfer bundle', async () => {
    const fromBundle = await extractTheme(fragmentSourceFromBundle(makeSourceBundle()))
    expect(fromBundle.theme).toEqual(sourceTheme.theme)
  })

  it('carries media a custom property points at', async () => {
    const { theme } = await extractTheme(sourceWithTexture())
    expect(theme.customProperties['--texture']).toBe("url('/uploads/bg.jpg')")
    expect(theme.media.map((m) => m.filename).sort()).toEqual(['bg.jpg', 'inter.woff2'])
  })

  it('drops a font token binding to a family the library lacks, with a warning', async () => {
    const site = makeSourceSite()
    site.settings.fonts!.items = []
    const { theme, warnings } = await extractTheme(fragmentSourceFromSite(site))
    expect(theme.fontTokens[0].familyId).toBeUndefined()
    expect(theme.fontFamilies).toEqual([])
    expect(warnings.map((w) => w.code)).toEqual(['missing-font-family'])
  })

  it('round-trips through a theme package', () => {
    const pkg = readThemePackage(writeThemePackage(sourceTheme.theme, sourceTheme.mediaBytes))
    expect(pkg.theme).toEqual(sourceTheme.theme)
    expect(pkg.readMedia(sourceTheme.theme.media[0])).toEqual(mediaBytesFor('media-font'))
    expect(() => readThemePackage(zipSync({ 'fragment.json': strToU8('{}') }))).toThrow(FragmentParseError)
  })
})

describe('parseSiteTheme', () => {
  it('refuses malformed themes', () => {
    const base = sourceTheme.theme
    expect(() => parseSiteTheme({ ...base, format: 'instatic-fragment' })).toThrow(FragmentParseError)
    expect(() => parseSiteTheme({ ...base, colors: [base.colors[0], { ...base.colors[1], slug: 'Primary' }] })).toThrow('colour slugs must be unique')
    expect(() => parseSiteTheme({ ...base, fontFamilies: [] })).toThrow('is not in fontFamilies')
    expect(() => parseSiteTheme({ ...base, customProperties: { radius: '1px' } })).toThrow(FragmentParseError)
    expect(() => parseSiteTheme({ ...base, typography: [base.typography[0], base.typography[0]] })).toThrow('typography scale names must be unique')
  })
})

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

describe('planThemeApply', () => {
  it('reports every change with before and after values', () => {
    const { report, media } = planThemeApply({ site: makeTargetSite() }, sourceTheme.theme)
    expect(report.colors).toEqual({
      changed: [{
        slug: 'primary',
        before: { lightValue: '#111111', darkValue: '', darkModeEnabled: false },
        after: { lightValue: '#3366ff', darkValue: '', darkModeEnabled: false },
      }],
      added: [
        { slug: 'accent', after: { lightValue: '#ff8800', darkValue: '', darkModeEnabled: false } },
        { slug: 'unused', after: { lightValue: '#00aa00', darkValue: '', darkModeEnabled: false } },
      ],
      kept: [],
    })
    expect(report.fonts).toEqual({
      tokensRebound: [],
      tokensAdded: [{ variable: 'font-heading', family: 'Inter' }],
      tokensKept: [],
      familiesToInstall: ['Inter'],
      familiesReused: [],
    })
    expect(report.scales.changed).toEqual([
      {
        family: 'typography',
        convention: 'text',
        before: { minSize: 16, maxSize: 18, minRatio: 1.125, maxRatio: 1.333, steps: 'xs,s,m,l', baseStep: 'm' },
        after: { minSize: 16, maxSize: 18, minRatio: 1.125, maxRatio: 1.333, steps: 'xs,s,m,l,xl,2xl', baseStep: 'm' },
      },
      {
        family: 'spacing',
        convention: 'space',
        before: { minSize: 16, maxSize: 28, minRatio: 1.25, maxRatio: 1.414, steps: 'm,l', baseStep: 'm' },
        after: { minSize: 16, maxSize: 28, minRatio: 1.25, maxRatio: 1.414, steps: 's,m,l', baseStep: 'm' },
      },
    ])
    expect(report.scales.added).toEqual([])
    expect(report.customProperties).toEqual({
      changed: [{ name: '--radius', before: '2px', after: '12px' }],
      added: [{ name: '--shadow', value: '0 0 4px var(--primary-50)' }, { name: '--unused-prop', value: '1px' }],
      kept: [],
    })
    expect(report.media.total).toBe(1)
    expect(media.map((m) => m.filename)).toEqual(['inter.woff2'])
    expect(report.warnings).toEqual([])
  })

  it('a site already on the theme keeps everything and plans nothing', () => {
    const plan = planThemeApply({ site: makeSourceSite() }, sourceTheme.theme)
    expect(plan.colors).toEqual([])
    expect(plan.fontTokens).toEqual([])
    expect(plan.fontFamilies).toEqual([])
    expect(plan.scaleGroups).toEqual({ typography: [], spacing: [] })
    expect(plan.customProperties).toEqual([])
    expect(plan.media).toEqual([])
    expect(plan.report.colors.kept).toEqual(['primary', 'accent', 'unused'])
    expect(plan.report.fonts.tokensKept).toEqual(['font-heading'])
    expect(plan.report.scales.kept).toEqual([{ family: 'typography', convention: 'text' }, { family: 'spacing', convention: 'space' }])
    expect(plan.report.customProperties.kept).toEqual(['--radius', '--shadow', '--unused-prop'])
  })

  it('rebinds an existing font token to the theme family, reusing a family of the same name', () => {
    const toInstall = planThemeApply({ site: targetWithFonts([roboto], 'f-roboto') }, sourceTheme.theme)
    expect(toInstall.report.fonts.tokensRebound).toEqual([{ variable: 'font-heading', before: 'Roboto', after: 'Inter' }])
    expect(toInstall.report.fonts.familiesToInstall).toEqual(['Inter'])
    expect(toInstall.fontTokens[0]).toMatchObject({ action: 'rebind', installFamilyId: 'font-inter', token: { id: 'tk-h', name: 'Headline', fallback: 'sans-serif' } })
    expect(toInstall.fontTokens[0].token.familyId).toBeUndefined()

    const inter: FontEntry = { ...roboto, id: 'f-inter-g', family: 'Inter' }
    const reused = planThemeApply({ site: targetWithFonts([roboto, inter], 'f-roboto') }, sourceTheme.theme)
    expect(reused.report.fonts.familiesReused).toEqual(['Inter'])
    expect(reused.fontFamilies).toEqual([])
    expect(reused.media).toEqual([])
    expect(reused.fontTokens[0].token.familyId).toBe('f-inter-g')
  })

  it('adds a scale group the site lacks and warns about steps a replaced group loses', () => {
    const site = makeTargetSite()
    site.settings.framework!.spacing!.groups[0].steps = 'xs,s,m,l,xl'
    const theme = themeWith((t) => {
      t.typography.push({ ...t.typography[0], id: 'type-h', name: 'Heading', namingConvention: 'heading' })
    })
    const plan = planThemeApply({ site }, theme)
    expect(plan.report.scales.added.map((a) => a.convention)).toEqual(['heading'])
    expect(plan.scaleGroups.typography.map((p) => p.action)).toEqual(['replace', 'add'])
    expect(plan.scaleGroups.typography[1].group.id).not.toBe('type-h')
    expect(plan.report.warnings.map((w) => [w.code, w.subject])).toEqual([['scale-step-removed', 'space']])
    expect(plan.report.warnings[0].message).toContain('--space-xs, --space-xl')
  })

  it('writes a property no site root rule declares into the engine-owned rule, keeping equal values', () => {
    const site = makeTargetSite()
    site.styleRules.owned = rule('owned', {
      name: ':root', kind: 'ambient', selector: ':root', order: 9,
      styles: { '--shadow': '0 0 4px var(--primary-50)' },
      origin: { source: FRAGMENT_PROPERTIES_ORIGIN, ordinal: 0 },
    })
    const plan = planThemeApply({ site }, sourceTheme.theme)
    expect(plan.report.customProperties.kept).toEqual(['--shadow'])
    expect(plan.customProperties).toEqual([
      { ruleId: 't-root', order: 0, properties: { '--radius': '12px' } },
      { ruleId: 'owned', order: 9, properties: { '--unused-prop': '1px' } },
    ])
  })
})

// ---------------------------------------------------------------------------
// Commit + apply
// ---------------------------------------------------------------------------

describe('commitThemePlan', () => {
  it('replaces the site design variables and leaves its content alone', async () => {
    const site = makeTargetSite()
    const before = structuredClone(site)
    const { result } = await applyTo(site)
    const framework = site.settings.framework!

    // Colours: the site token keeps its id and order and takes the theme's definition.
    const [primary, accent, unused] = framework.colors.tokens
    expect(primary).toMatchObject({ id: 't-primary', order: 0, slug: 'primary', lightValue: '#3366ff', generateShades: { enabled: true, count: 3 } })
    expect([accent.slug, accent.order, unused.slug, unused.order]).toEqual(['accent', 1, 'unused', 2])

    // Scales: the site group keeps its id, name and generators and takes the theme's sizing.
    expect(framework.typography!.groups[0]).toMatchObject({ id: 't-type', name: 'Text', steps: 'xs,s,m,l,xl,2xl', baseScaleIndex: 2 })
    expect(framework.typography!.classes).toEqual(before.settings.framework!.typography!.classes)
    expect(framework.spacing!.groups[0]).toMatchObject({ id: 't-space', steps: 's,m,l', baseScaleIndex: 1 })
    // Framework utilities regenerated for the new steps and colours.
    const names = new Set(Object.values(site.styleRules).map((r) => r.name))
    expect(names.has('text-2xl')).toBe(true)

    // Fonts: Inter registered from the uploaded file and bound to the new token.
    const inter = site.settings.fonts!.items.find((f) => f.family === 'Inter')!
    expect(inter.files[0].path).toMatch(/^\/uploads\/new-\d+-inter\.woff2$/)
    expect(site.settings.fonts!.tokens!.find((t) => t.variable === 'font-heading')!.familyId).toBe(inter.id)
    expect(result.report.media).toEqual({ total: 1, uploaded: 1, reused: 0 })

    // Custom properties: the user's root rule is updated in place; the rest
    // lands in the engine-owned rule.
    expect(site.styleRules['t-root'].styles).toEqual({ '--radius': '12px' })
    const owned = Object.values(site.styleRules).find((r) => r.origin?.source === FRAGMENT_PROPERTIES_ORIGIN)!
    expect(owned.styles).toEqual({ '--shadow': '0 0 4px var(--primary-50)', '--unused-prop': '1px' })

    // Content untouched: pages, components, the site's own classes.
    expect(site.pages).toEqual(before.pages)
    expect(site.visualComponents).toEqual(before.visualComponents)
    const ownRules = (doc: SiteDocument): StyleRule[] =>
      ['t-hero', 't-hover'].map((id) => doc.styleRules[id])
    expect(ownRules(site)).toEqual(ownRules(before))
  })

  it('applying the same theme again changes nothing', async () => {
    const site = makeTargetSite()
    await applyTo(site)
    const after = structuredClone(site)
    const { plan } = await applyTo(site)
    expect(plan.report.colors.changed).toEqual([])
    expect(plan.report.colors.added).toEqual([])
    expect(plan.report.customProperties.kept).toEqual(['--radius', '--shadow', '--unused-prop'])
    expect(plan.report.fonts.tokensKept).toEqual(['font-heading'])
    expect(site).toEqual(after)
  })

  it('rebinds a font token, keeping its id and name', async () => {
    const site = targetWithFonts([roboto], 'f-roboto')
    await applyTo(site)
    const token = site.settings.fonts!.tokens![0]
    const inter = site.settings.fonts!.items.find((f) => f.family === 'Inter')!
    expect(token).toMatchObject({ id: 'tk-h', name: 'Headline', variable: 'font-heading', familyId: inter.id, fallback: 'sans-serif' })
    expect(site.settings.fonts!.tokens).toHaveLength(1)
  })

  it('a font that fails to install leaves a rebound token on its family, with a warning', async () => {
    const site = targetWithFonts([roboto], 'f-roboto')
    const { result } = await applyTo(site, sourceTheme.theme, 'font')
    expect(site.settings.fonts!.tokens![0]).toMatchObject({ familyId: 'f-roboto', fallback: 'serif' })
    expect(result.report.warnings.map((w) => w.code)).toEqual(['font-install-failed'])
    // Everything else still applied.
    expect(site.styleRules['t-root'].styles['--radius']).toBe('12px')
  })

  it('rewrites media paths in custom properties to the uploaded copies', async () => {
    const { theme } = await extractTheme(sourceWithTexture())
    const site = makeTargetSite()
    await applyTo(site, theme)
    const owned = Object.values(site.styleRules).find((r) => r.origin?.source === FRAGMENT_PROPERTIES_ORIGIN)!
    expect(owned.styles['--texture']).toMatch(/^url\('\/uploads\/new-\d+-bg\.jpg'\)$/)
  })

  it('stops before touching the site when an upload fails', async () => {
    const site = makeTargetSite()
    const before = structuredClone(site)
    await expect(applyTo(site, sourceTheme.theme, 'upload')).rejects.toBeInstanceOf(FragmentCommitError)
    expect(site).toEqual(before)
  })

  it('honours cancellation before the transaction', async () => {
    const site = makeTargetSite()
    const before = structuredClone(site)
    const plan = planThemeApply({ site }, sourceTheme.theme)
    const controller = new AbortController()
    controller.abort()
    await expect(commitThemePlan(plan, memoryAdapter(site), { readMediaBytes: readBytes, signal: controller.signal })).rejects.toThrow()
    expect(site).toEqual(before)
  })
})
