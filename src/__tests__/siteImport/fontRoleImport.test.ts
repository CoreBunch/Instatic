/**
 * Importing a static site that defines a font role variable into a new site.
 *
 * New sites start with seeded `font-heading` / `font-body` / `font-mono` tokens.
 * An imported `--font-body` must fill the untouched seed in place (default
 * overwrite) so references keep `var(--font-body)`, while a role token the user
 * edited keeps the pre-existing default (rename to `font-body-2`).
 *
 * Drives the real store commit through `createSiteImportAdapter`.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { applyConflictResolutions, buildImportPlan, commitImportPlan } from '@core/siteImport'
import type { FileMap, ImportPlan, SiteImportAdapter } from '@core/siteImport'
import type { FontEntry } from '@core/fonts'
import { createSiteImportAdapter } from '@admin/modals/SiteImport/shared/createSiteImportAdapter'

const enc = new TextEncoder()
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap'
const HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p>Hi</p></body></html>'
const CSS = `
  @import url("${FONT_URL}");
  :root { --font-body: "Manrope", sans-serif; }
  p { font-family: var(--font-body); }
`

function fileMap(): FileMap {
  return {
    files: {
      'index.html': { bytes: enc.encode(HTML), mimeType: 'text/html' },
      'style.css': { bytes: enc.encode(CSS), mimeType: 'text/css' },
    },
  }
}

const MANROPE: FontEntry = {
  id: 'font_manrope',
  source: 'google',
  family: 'Manrope',
  variants: ['400', '700'],
  subsets: ['latin'],
  files: [{ variant: '400', subset: 'latin', path: '/uploads/fonts/manrope/400.woff2', format: 'woff2' }],
  createdAt: 1,
  updatedAt: 1,
}

function plan(): ImportPlan {
  return buildImportPlan({ fileMap: fileMap(), currentSite: useEditorStore.getState().site! })
}

async function commit(built: ImportPlan): Promise<void> {
  const resolved = applyConflictResolutions(
    built,
    built.conflicts.pages,
    built.conflicts.rules,
    built.conflicts.tokens,
    built.conflicts.crossSheetClasses,
  )
  const adapter: SiteImportAdapter = {
    ...createSiteImportAdapter({ sessionId: 'font-role-import-test' }),
    uploadAsset: async () => {
      throw new Error('this fixture has no assets')
    },
    installGoogleFont: async () => structuredClone(MANROPE),
  }
  await commitImportPlan(resolved, adapter)
}

function fontTokens() {
  return useEditorStore.getState().site!.settings.fonts?.tokens ?? []
}

function paragraphFontFamilies(): unknown[] {
  return Object.values(useEditorStore.getState().site!.styleRules)
    .filter((rule) => rule.selector === 'p')
    .map((rule) => rule.styles.fontFamily)
}

describe('site import into a new site with font role tokens', () => {
  beforeEach(() => {
    useEditorStore.setState({ site: null } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().createSite('New')
  })

  it('fills an untouched seeded role token instead of renaming the import', async () => {
    const built = plan()
    const conflict = built.conflicts.tokens.find((c) => c.desiredVariable === 'font-body')
    expect(conflict?.defaultResolution.action).toBe('overwrite')

    await commit(built)

    const tokens = fontTokens()
    expect(tokens.map((t) => t.variable)).toEqual(['font-heading', 'font-body', 'font-mono'])
    const body = tokens.find((t) => t.variable === 'font-body')!
    expect(body.familyId).toBe('font_manrope')
    expect(body.fallback).toBe('sans-serif')
    expect(paragraphFontFamilies()).toEqual(['var(--font-body)'])
  })

  it('keeps the rename default when the user edited the role token', async () => {
    useEditorStore.setState((state) => {
      const body = state.site!.settings.fonts!.tokens!.find((t) => t.variable === 'font-body')!
      body.fallback = 'Georgia, serif'
    })

    const built = plan()
    const conflict = built.conflicts.tokens.find((c) => c.desiredVariable === 'font-body')
    expect(conflict?.defaultResolution).toEqual({ action: 'auto-rename', resolvedVariable: 'font-body-2' })

    await commit(built)

    const tokens = fontTokens()
    expect(tokens.find((t) => t.variable === 'font-body')!.fallback).toBe('Georgia, serif')
    expect(tokens.find((t) => t.variable === 'font-body-2')!.familyId).toBe('font_manrope')
    expect(paragraphFontFamilies()).toEqual(['var(--font-body-2)'])
  })
})
