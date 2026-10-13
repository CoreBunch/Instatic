import { describe, expect, it } from 'bun:test'
import { Value } from '@core/utils/typeboxHelpers'
import { parseSiteDocument } from '@core/page-tree'
import { makeSite } from './publisher/helpers'
import {
  DEFAULT_SITE_VISITOR_PREFERENCES,
  VisitorPreferenceOverridesSchema,
  VisitorPreferencesValidationError,
} from '@core/visitor-preferences-schema'
import { resolveVisitorPreferences } from '@core/visitor-preferences'
import * as Y from 'yjs'
import { projectSiteDoc, seedSiteDoc } from '@core/collab'

describe('native visitor preference contract', () => {
  it('keeps authored defaults and partial visitor choices distinct', () => {
    const settings = parseSiteDocument(makeSite({ settings: { shortcuts: {}, visitorPreferences: DEFAULT_SITE_VISITOR_PREFERENCES } })).settings
    expect(settings.visitorPreferences).toEqual({ theme: 'system', motion: 'system', media: 'full' })
    expect(Value.Check(VisitorPreferenceOverridesSchema, {})).toBe(true)
    expect(Value.Check(VisitorPreferenceOverridesSchema, { theme: 'alt' })).toBe(true)
    expect(Value.Check(VisitorPreferenceOverridesSchema, { theme: 'eco' })).toBe(false)
    expect(Value.Check(VisitorPreferenceOverridesSchema, { arbitrary: true })).toBe(false)
    const raw = { ...makeSite(), settings: { visitorPreferences: { theme: 'eco' } } }
    expect(() => parseSiteDocument(raw)).toThrow(VisitorPreferencesValidationError)
  })

  it('follows the OS palette until the visitor makes an explicit choice', () => {
    expect(resolveVisitorPreferences(DEFAULT_SITE_VISITOR_PREFERENCES, {}, { dark: true, reducedMotion: false }).theme).toBe('alt')
    expect(resolveVisitorPreferences(DEFAULT_SITE_VISITOR_PREFERENCES, { theme: 'default' }, { dark: true, reducedMotion: false }).theme).toBe('default')
    expect(resolveVisitorPreferences({ ...DEFAULT_SITE_VISITOR_PREFERENCES, theme: 'alt' }, { theme: 'system' }, { dark: false, reducedMotion: false }).theme).toBe('default')
  })

  it('preserves authored defaults through native JSON and site-shell co-editing roundtrips', () => {
    const site = makeSite({ layouts: [], settings: { shortcuts: {}, visitorPreferences: { theme: 'alt', motion: 'reduced', media: 'reduced' } } })
    const exported: unknown = JSON.parse(JSON.stringify(site))
    const imported = parseSiteDocument(exported)
    const source = new Y.Doc()
    const remote = new Y.Doc()
    try {
      seedSiteDoc(source, { ...site, ...imported })
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(source))
      expect(projectSiteDoc(remote).shell.settings).toEqual(imported.settings)
      expect(projectSiteDoc(remote).shell).not.toHaveProperty('visitorOverrides')
    } finally { source.destroy(); remote.destroy() }
  })

  it('never cancels OS reduced motion and keeps media independent from palette', () => {
    const os = resolveVisitorPreferences(DEFAULT_SITE_VISITOR_PREFERENCES, { motion: 'system', theme: 'alt' }, { dark: false, reducedMotion: true })
    expect(os.reducedMotion).toBe(true)
    expect(os.reducedMedia).toBe(false)
    const explicit = resolveVisitorPreferences(DEFAULT_SITE_VISITOR_PREFERENCES, { motion: 'reduced', media: 'reduced', theme: 'default' }, { dark: false, reducedMotion: false })
    expect(explicit.reducedMotion).toBe(true)
    expect(explicit.reducedMedia).toBe(true)
    expect(explicit.theme).toBe('default')
  })
})
