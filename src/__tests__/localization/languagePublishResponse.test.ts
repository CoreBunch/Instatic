import { describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { saveDraftSite } from '../../../server/repositories/site'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createDataRow, updateDataRowDraftCells } from '../../../server/repositories/data/rows'
import { createCapabilityTestHarness, readJson } from '../helpers/capabilityHarness'

describe('language publication response', () => {
  it('rejects an ambiguous translation group before creating any snapshots or versions', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const { rows } = await harness.db<{ id: string; slug: string; cells_json: Record<string, unknown> }>`select id, slug, cells_json from data_rows where table_id = 'pages'`
      const original = rows[0]!
      await updateDataRowDraftCells(harness.db, MAIN_SCOPE, original.id, { slug: original.slug, cells: { ...original.cells_json, language: 'en', translationGroup: 'home' } })
      await createDataRow(harness.db, MAIN_SCOPE, { tableId: 'pages', slug: 'other', cells: { ...original.cells_json, slug: 'other', language: 'EN', translationGroup: 'home' } })
      const published = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie })
      expect(published.status).toBe(422)
      expect((await readJson<{ error: string }>(published)).error).toContain('more than one page')
      const snapshots = await harness.db<{ count: number }>`select count(*) as count from site_snapshots`
      const versions = await harness.db<{ count: number }>`select count(*) as count from data_row_versions`
      expect(snapshots.rows[0]?.count).toBe(0)
      expect(versions.rows[0]?.count).toBe(0)
    } finally {
      await harness.cleanup()
    }
  }, 15_000)

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
