/**
 * Font role tokens: every new site starts with `font-heading`, `font-body` and
 * `font-mono`; the Core preset adds the ones a site lacks; existing sites read
 * through the settings fallback never gain them.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  FONT_ROLES,
  buildFontRoleTokens,
  generateFontTokenVariablesCss,
  isUntouchedFontRoleToken,
  mergeFontRoleTokens,
  parseSiteFontsSettings,
  suggestFontTokenName,
  type FontToken,
  type SiteFontsSettings,
} from '@core/fonts'
import { applyFrameworkPreset } from '@core/framework'
import { DEFAULT_SITE_SETTINGS, createNewSiteSettings } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

const ROLE_VARIABLES = ['font-heading', 'font-body', 'font-mono']

function variables(fonts: SiteFontsSettings | undefined): string[] {
  return (fonts?.tokens ?? []).map((token) => token.variable)
}

function customHeading(): FontToken {
  return {
    id: 'mine',
    name: 'Display',
    variable: 'font-heading',
    familyId: 'fam-1',
    fallback: 'serif',
    order: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('font role tokens', () => {
  it('builds fallback-only system-stack tokens for heading, body and mono', () => {
    const tokens = buildFontRoleTokens()
    expect(tokens.map((t) => [t.name, t.variable])).toEqual([
      ['Heading', 'font-heading'],
      ['Body', 'font-body'],
      ['Mono', 'font-mono'],
    ])
    for (const token of tokens) expect(token.familyId).toBeUndefined()
    expect(tokens[2].fallback).toContain('monospace')
    expect(new Set(tokens.map((t) => t.id)).size).toBe(3)
  })

  it('survives the tolerant settings parser unchanged', () => {
    const fonts: SiteFontsSettings = { items: [], tokens: buildFontRoleTokens() }
    expect(parseSiteFontsSettings(structuredClone(fonts))).toEqual(fonts)
  })

  it('emits the role variables into :root', () => {
    const css = generateFontTokenVariablesCss({ items: [], tokens: buildFontRoleTokens() })
    expect(css).toContain('--font-heading: system-ui')
    expect(css).toContain('--font-body: system-ui')
    expect(css).toContain('--font-mono: ui-monospace')
  })

  it('merge adds only the missing roles and keeps an existing token untouched', () => {
    const existing: SiteFontsSettings = { items: [], tokens: [customHeading()] }
    const merged = mergeFontRoleTokens(existing)
    expect(variables(merged)).toEqual(ROLE_VARIABLES)
    expect(merged.tokens![0]).toEqual(customHeading())
    expect(merged.tokens!.map((t) => t.order)).toEqual([0, 1, 2])
    // Pure: the input keeps its single token.
    expect(existing.tokens).toHaveLength(1)
  })

  it('merge matches by normalized variable and returns the input when complete', () => {
    const complete: SiteFontsSettings = { items: [], tokens: buildFontRoleTokens() }
    expect(mergeFontRoleTokens(complete)).toBe(complete)
    expect(variables(mergeFontRoleTokens(undefined))).toEqual(ROLE_VARIABLES)
  })

  it('recognises an untouched seed and rejects any edit to it', () => {
    const [heading] = buildFontRoleTokens()
    expect(isUntouchedFontRoleToken(heading)).toBe(true)
    expect(isUntouchedFontRoleToken({ ...heading, familyId: 'fam-1' })).toBe(false)
    expect(isUntouchedFontRoleToken({ ...heading, fallback: 'serif' })).toBe(false)
    expect(isUntouchedFontRoleToken({ ...heading, name: 'Display' })).toBe(false)
    expect(isUntouchedFontRoleToken({ ...heading, variable: 'font-display' })).toBe(false)
  })

  it('suggests the first missing role name for a new token', () => {
    expect(suggestFontTokenName([])).toBe('Heading')
    expect(suggestFontTokenName([{ variable: 'font-heading' }])).toBe('Body')
    expect(suggestFontTokenName(FONT_ROLES)).toBe('Accent')
  })
})

describe('new-site settings', () => {
  it('seed every role token for a brand-new site', () => {
    expect(variables(createNewSiteSettings().fonts)).toEqual(ROLE_VARIABLES)
  })

  it('leave the read-time fallback without fonts, so existing sites are not modified', () => {
    expect(DEFAULT_SITE_SETTINGS.fonts).toBeUndefined()
  })

  it('are what the editor store creates a draft site with', () => {
    const site = useEditorStore.getState().createSite('Fresh')
    expect(variables(site.settings.fonts)).toEqual(ROLE_VARIABLES)
  })
})

describe('Core preset font roles', () => {
  it('adds the role tokens a site lacks for full and variables', () => {
    for (const target of ['full', 'variables'] as const) {
      const next = applyFrameworkPreset({ fonts: { items: [], tokens: [customHeading()] } }, target)
      expect(variables(next.fonts)).toEqual(ROLE_VARIABLES)
      expect(next.fonts!.tokens![0]).toEqual(customHeading())
    }
  })

  it('leaves font tokens alone when removing the framework', () => {
    const fonts: SiteFontsSettings = { items: [], tokens: [customHeading()] }
    const next = applyFrameworkPreset({ fonts }, 'none')
    expect(next.framework).toBeUndefined()
    expect(next.fonts).toBe(fonts)
  })

  describe('store action', () => {
    beforeEach(() => {
      useEditorStore.setState({
        site: makeSite(),
        activePageId: 'page-1',
        _historyPast: [],
        _historyFuture: [],
      } as Parameters<typeof useEditorStore.setState>[0])
    })

    it('setFrameworkPreset adds the role tokens to a site without fonts', () => {
      expect(useEditorStore.getState().site!.settings.fonts).toBeUndefined()
      useEditorStore.getState().setFrameworkPreset('full')
      expect(variables(useEditorStore.getState().site!.settings.fonts)).toEqual(ROLE_VARIABLES)
    })

    it('setFrameworkPreset keeps the tokens a site already has', () => {
      useEditorStore.setState((state) => {
        state.site!.settings.fonts = { items: [], tokens: [customHeading()] }
      })
      useEditorStore.getState().setFrameworkPreset('variables')
      const fonts = useEditorStore.getState().site!.settings.fonts
      expect(variables(fonts)).toEqual(ROLE_VARIABLES)
      expect(fonts!.tokens![0]).toEqual(customHeading())
    })
  })
})
