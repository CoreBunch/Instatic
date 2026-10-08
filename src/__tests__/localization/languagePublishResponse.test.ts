import { describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { saveDraftSite } from '../../../server/repositories/site'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createCapabilityTestHarness, readJson } from '../helpers/capabilityHarness'

describe('language publication response', () => {
  it('returns the catalogue path in an actionable 422 envelope without publishing a snapshot', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const response = await harness.cms('/admin/api/cms/site', { cookie })
      const { site } = await readJson<{ site: SiteShell }>(response)
      await saveDraftSite(harness.db, MAIN_SCOPE, {
        ...site,
        settings: { ...site.settings, language: 'it', localization: { catalogues: [{ language: 'it', fileId: 'it' }] } },
        files: [{ id: 'it', path: 'locales/it.json', type: 'config', content: '{', createdAt: 0, updatedAt: 0 }],
      })
      const published = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie })
      expect(published.status).toBe(422)
      expect(await readJson<{ error: string }>(published)).toEqual({ error: 'locales/it.json: Invalid language catalogue' })
      const { rows } = await harness.db<{ count: number }>`select count(*) as count from site_snapshots`
      expect(rows[0].count).toBe(0)
    } finally {
      await harness.cleanup()
    }
  }, 15_000)
})
