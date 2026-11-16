/**
 * Every full publish stores the whole site document once in `site_snapshots`.
 * Readers only reach a snapshot through a page row's active version, so a
 * publish prunes the snapshots no active version references. Without this the
 * table grew by one full site copy per publish (439 MB on one production
 * site, 7 of 293 snapshots still in use).
 */
import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { getPublishedPageBySlug, persistSitePublish } from '../../../server/repositories/publish'
import { createDataRow } from '../../../server/repositories/data/rows/mutations'
import { createUser } from '../../../server/repositories/users'
import { hashPassword } from '../../../server/auth/tokens'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import type { DbClient } from '../../../server/db'
import { makePage, makeSite } from '../fixtures'

async function publishOnce(db: DbClient, pageIds: string[], n: number): Promise<void> {
  const site = makeSite({ pages: pageIds.map((id) => makePage({ id, slug: id })) })
  await persistSitePublish(db, {
    siteSnapshotId: `snap-${n}`,
    site,
    serializedImportmap: null,
    pages: pageIds.map((pageId) => ({
      pageId,
      title: pageId,
      slug: pageId,
      versionId: `${pageId}-v${n}`,
      versionNumber: n,
      runtimeAssets: null,
      runtimeFiles: [],
    })),
    publishedByUserId: 'owner_1',
  })
}

async function storedSnapshots(db: DbClient): Promise<string[]> {
  const { rows } = await db<{ id: string }>`select id from site_snapshots order by id`
  return rows.map((row) => row.id)
}

async function setup(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const { db, cleanup } = await createTestDb()
  await createUser(db, {
    id: 'owner_1',
    email: 'owner@example.com',
    displayName: 'Owner',
    passwordHash: await hashPassword('long-enough-password'),
    roleId: 'owner',
    allowOwnerRole: true,
  })
  for (const id of ['home', 'about']) {
    await createDataRow(db, MAIN_SCOPE, { id, tableId: 'pages', cells: { title: id }, slug: id })
  }
  return { db, cleanup }
}

describe('site snapshot retention', () => {
  it('keeps only the snapshot the active versions reference', async () => {
    const { db, cleanup } = await setup()
    try {
      await publishOnce(db, ['home', 'about'], 1)
      await publishOnce(db, ['home', 'about'], 2)
      await publishOnce(db, ['home', 'about'], 3)
      expect(await storedSnapshots(db)).toEqual(['snap-3'])

      // Version history is kept; superseded rows just lose their snapshot link.
      const { rows } = await db<{ id: string; site_snapshot_id: string | null }>`
        select id, site_snapshot_id from data_row_versions order by id
      `
      expect(rows).toEqual([
        { id: 'about-v1', site_snapshot_id: null },
        { id: 'about-v2', site_snapshot_id: null },
        { id: 'about-v3', site_snapshot_id: 'snap-3' },
        { id: 'home-v1', site_snapshot_id: null },
        { id: 'home-v2', site_snapshot_id: null },
        { id: 'home-v3', site_snapshot_id: 'snap-3' },
      ])

      expect((await getPublishedPageBySlug(db, 'about'))?.pageRowId).toBe('about')
    } finally {
      await cleanup()
    }
  })

  it('keeps an older snapshot while a page is still served from it', async () => {
    const { db, cleanup } = await setup()
    try {
      await publishOnce(db, ['home', 'about'], 1)
      // A publish that does not cover `about` leaves its active version on snap-1.
      await publishOnce(db, ['home'], 2)
      expect(await storedSnapshots(db)).toEqual(['snap-1', 'snap-2'])
      expect((await getPublishedPageBySlug(db, 'about'))?.pageRowId).toBe('about')

      await publishOnce(db, ['home', 'about'], 3)
      expect(await storedSnapshots(db)).toEqual(['snap-3'])
    } finally {
      await cleanup()
    }
  })
})
