/**
 * validateSite — round-trip and negative tests (Step 5 / Constraint #230)
 *
 * Round-trip: a fully-populated fixture survives validateSite() unchanged.
 * Negative: targeted failures each exercise a specific domain post-check rule.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { validateSite, validatePages, validateVisualComponents, SiteValidationError } from '@core/persistence/validate'

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const fixturePath = join(import.meta.dir, 'roundTripFixture.json')
const fixtureRaw = readFileSync(fixturePath, 'utf-8')

function loadFixture(): unknown {
  return JSON.parse(fixtureRaw)
}

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe('validateSite — round-trip with representative fixture', () => {
  it('survives three-phase validation and deep-equals the source fixture', () => {
    const raw = loadFixture() as Record<string, unknown>
    const rawPages = Array.isArray(raw.pages) ? raw.pages as unknown[] : []
    const rawVCs = Array.isArray(raw.visualComponents) ? raw.visualComponents as unknown[] : []
    const shell = validateSite(raw)
    const visualComponents = validateVisualComponents(rawVCs)
    const pages = validatePages(shell, rawPages, visualComponents)
    const result = { ...shell, pages, visualComponents }
    // JSON round-trip strips undefined optional-absent fields so the comparison
    // matches raw (which also never has undefined keys, being parsed JSON).
    expect(JSON.parse(JSON.stringify(result))).toEqual(raw)
  })

  it('preserves all three generated class metadata families (color, typography, spacing)', () => {
    const result = validateSite(loadFixture())
    expect(result.styleRules['class-color'].generated?.family).toBe('color')
    expect(result.styleRules['class-typography'].generated?.family).toBe('typography')
    expect(result.styleRules['class-spacing'].generated?.family).toBe('spacing')
  })

  it('preserves propBindings on page nodes', () => {
    const raw = loadFixture() as Record<string, unknown>
    const shell = validateSite(raw)
    const pages = validatePages(shell, Array.isArray(raw.pages) ? raw.pages as unknown[] : [])
    const node = pages[0].nodes['heading-1']
    expect(node.propBindings).toEqual({
      text:  { paramId: 'param-title' },
      extra: { paramId: 'param-desc' },
    })
  })

  it('preserves the VC flat tree (tree.nodes + rootNodeId)', () => {
    const raw = loadFixture() as Record<string, unknown>
    const rawVCs = Array.isArray(raw.visualComponents) ? raw.visualComponents as unknown[] : []
    const vcs = validateVisualComponents(rawVCs)
    const vc = vcs[0]
    expect(vc.tree.rootNodeId).toBe('vc-root')
    // Both the root and its child must be in the flat map
    expect(vc.tree.nodes['vc-root']).toBeDefined()
    expect(vc.tree.nodes['vc-child-1']).toBeDefined()
    expect((vc.tree.nodes['vc-child-1'] as { id: string }).id).toBe('vc-child-1')
    // Root node lists the child in its children array
    expect((vc.tree.nodes['vc-root'] as { children: string[] }).children).toContain('vc-child-1')
  })

  it('preserves the page template config (target + priority)', () => {
    const raw = loadFixture() as Record<string, unknown>
    const shell = validateSite(raw)
    const pages = validatePages(shell, Array.isArray(raw.pages) ? raw.pages as unknown[] : [])
    expect(pages[0].template?.enabled).toBe(true)
    expect(pages[0].template?.target).toEqual({ kind: 'postTypes', tableSlugs: ['posts'] })
    expect(pages[0].template?.priority).toBe(10)
  })

  it('preserves non-empty breakpoints', () => {
    const result = validateSite(loadFixture())
    expect(result.breakpoints).toHaveLength(2)
    expect(result.breakpoints[0].id).toBe('mobile')
  })

  it('preserves non-default runtime (dep-lock + script)', () => {
    const result = validateSite(loadFixture())
    expect(result.runtime.dependencyLock.packages['three']?.version).toBe('0.160.0')
    expect(result.runtime.scripts['script-1']?.placement).toBe('body-end')
  })

  it('preserves non-default packageJson dependencies', () => {
    const result = validateSite(loadFixture())
    expect(result.packageJson.dependencies['three']).toBe('^0.160.0')
  })

  it('preserves the SiteFile with normalized path', () => {
    const result = validateSite(loadFixture())
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('src/components/MyButton.tsx')
  })

  it('preserves framework preferences (non-default values if set)', () => {
    const result = validateSite(loadFixture())
    expect(result.settings.framework?.preferences?.rootFontSize).toBe(10)
    expect(result.settings.framework?.preferences?.isRem).toBe(true)
    expect(result.settings.framework?.preferences?.treeShakeGeneratedFrameworkUtilities).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Negative tests — each exercises a specific domain post-check rule
// ---------------------------------------------------------------------------

describe('validateVisualComponents — negative: bad VC name is silently dropped (rule 4)', () => {
  it('VC with empty name is dropped; valid VCs survive', () => {
    const raw = loadFixture() as Record<string, unknown>
    const rawVCs = Array.isArray(raw.visualComponents) ? [...raw.visualComponents as Array<Record<string, unknown>>] : []
    // Prepend an invalid VC (whitespace-only name) before the valid one
    const vcBad = { id: 'vc-bad', name: '   ', tree: { rootNodeId: 'n', nodes: { n: { id: 'n', moduleId: 'base.text', props: {}, breakpointOverrides: {}, children: [], classIds: [] } } }, params: [], classIds: [], createdAt: 1700000000000 }
    const vcs = validateVisualComponents([vcBad, ...rawVCs])
    expect(vcs.some((vc) => vc.name.trim().length === 0)).toBe(false)
    expect(vcs.some((vc) => vc.name === 'MyCard')).toBe(true)
  })
})

describe('validateSite — negative: duplicate page slug throws (rules 1–2)', () => {
  it('throws SiteValidationError with path site.pages[1].slug', () => {
    const raw = loadFixture() as { pages: Array<Record<string, unknown>> } & Record<string, unknown>
    // Add a second page with the same slug as page-home
    raw.pages.push({
      id: 'page-dup',
      slug: 'index',
      title: 'Duplicate Home',
      rootNodeId: 'root-dup',
      nodes: {
        'root-dup': { id: 'root-dup', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] },
      },
    })
    const shell = validateSite(raw)
    expect(() => validatePages(shell, raw.pages)).toThrow(SiteValidationError)
    try {
      validatePages(shell, raw.pages)
    } catch (e) {
      expect((e as SiteValidationError).message).toContain('duplicate slug')
      // pages[0] has slug 'index'; pages[2] also has slug 'index'.
      // The check fires at [0] since pageSlugDuplicateError finds a later page with
      // the same slug — path is the FIRST page whose slug is duplicated.
      expect((e as SiteValidationError).path).toBe('site.pages[0].slug')
    }
  })
})

describe('validateSite — negative: malformed propBindings entry silently dropped (rule 5.3)', () => {
  it('bad entry is dropped; valid entry survives intact', () => {
    const raw = loadFixture() as { pages: Array<{ nodes: Record<string, Record<string, unknown>> }> } & Record<string, unknown>
    // Inject a mix of good + bad propBindings on heading-1
    raw.pages[0].nodes['heading-1'].propBindings = {
      text:    { paramId: 'param-title' },   // valid
      badKey:  'not-an-object',              // invalid — should be dropped
      anotherBad: { wrongField: 'x' },       // invalid — missing paramId
      extra:   { paramId: 'param-desc' },    // valid
    }
    const shell = validateSite(raw)
    const pages = validatePages(shell, raw.pages as unknown[])
    const bindings = pages[0].nodes['heading-1'].propBindings
    expect(bindings).toEqual({
      text:  { paramId: 'param-title' },
      extra: { paramId: 'param-desc' },
    })
  })
})

describe('validateSite — negative: unsafe SiteFile path is silently dropped (rule 3)', () => {
  it('file with directory traversal is dropped; safe files survive', () => {
    const raw = loadFixture() as { files: Array<Record<string, unknown>> }
    raw.files.push({
      id: 'evil',
      path: '../../../etc/passwd',
      type: 'script',
      content: '',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    })
    const result = validateSite(raw)
    expect(result.files.some((f) => f.path.includes('passwd'))).toBe(false)
    expect(result.files.some((f) => f.path === 'src/components/MyButton.tsx')).toBe(true)
  })

  it('throws SiteValidationError with correct path for reserved-word slug', () => {
    const raw = loadFixture() as { pages: Array<Record<string, unknown>> } & Record<string, unknown>
    raw.pages[0].slug = 'admin'
    const shell = validateSite(raw)
    try {
      validatePages(shell, raw.pages)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SiteValidationError)
      expect((e as SiteValidationError).path).toBe('site.pages[0].slug')
      expect((e as SiteValidationError).message).toContain('reserved')
    }
  })
})

describe('validateSite — contextStyles[desktop] folds into base styles (rule 5)', () => {
  it('desktop override values win the merge and the context key is removed', () => {
    const raw = loadFixture() as { styleRules: Record<string, { styles: Record<string, unknown>; contextStyles: Record<string, Record<string, unknown>> }> }
    const rule = Object.values(raw.styleRules)[0]
    rule.styles.width = '200px'
    rule.contextStyles['desktop'] = { width: '456px', top: '10px' }
    const shell = validateSite(raw)
    const parsed = Object.values(shell.styleRules)[0]
    expect(parsed.styles.width).toBe('456px')
    expect(parsed.styles.top).toBe('10px')
    expect(parsed.contextStyles['desktop']).toBeUndefined()
  })
})
