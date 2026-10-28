/**
 * Every full publish stores each page's bundled runtime files under a fresh
 * version path. Nothing re-activates an old version, so only the active and
 * the just-superseded version keep their stored assets; older ones are pruned
 * on publish. Without this the table grew by the site's whole bundle set on
 * every publish (1.5 GB on one production site).
 */
import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { persistSitePublish } from '../../../server/repositories/publish'
import { createDataRow } from '../../../server/repositories/data/rows/mutations'
import { createUser } from '../../../server/repositories/users'
import { hashPassword } from '../../../server/auth/tokens'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import type { DbClient } from '../../../server/db'
import { makePage, makeSite } from '../fixtures'

async function publishOnce(db: DbClient, pageIds: string[], n: number): Promise<string[]> {
  const site = makeSite({ pages: pageIds.map((id) => makePage({ id })) })
  const pages = pageIds.map((pageId) => {
    const versionId = `${pageId}-v${n}`
    return {
      pageId,
      title: pageId,
      slug: pageId,
      versionId,
      versionNumber: n,
      runtimeAssets: null,
      runtimeFiles: ['entry.js', 'chunk.js'].map((name) => ({
        path: name,
        publicPath: `/_instatic/assets/${versionId}/${name}`,
        content: '',
        bytes: new TextEncoder().encode(`// ${versionId} ${name}`),
        contentType: 'text/javascript',
      })),
    }
  })
  await persistSitePublish(db, {
    siteSnapshotId: `snap-${n}`,
    site,
    serializedImportmap: null,
    pages,
    publishedByUserId: 'owner_1',
  })
  return pages.map((page) => page.versionId)
}

async function storedVersions(db: DbClient): Promise<string[]> {
  const { rows } = await db<{ data_row_version_id: string }>`
    select distinct data_row_version_id from published_runtime_assets order by data_row_version_id
  `
  return rows.map((row) => row.data_row_version_id)
}

describe('published runtime asset retention', () => {
  it('keeps only the active and previous version assets per page', async () => {
    const { db, cleanup } = await createTestDb()
    try {
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

      await publishOnce(db, ['home', 'about'], 1)
      await publishOnce(db, ['home', 'about'], 2)
      expect(await storedVersions(db)).toEqual(['about-v1', 'about-v2', 'home-v1', 'home-v2'])

      await publishOnce(db, ['home', 'about'], 3)
      await publishOnce(db, ['home', 'about'], 4)
      expect(await storedVersions(db)).toEqual(['about-v3', 'about-v4', 'home-v3', 'home-v4'])

      // Version history itself is untouched.
      const { rows } = await db<{ n: number }>`select count(*) as n from data_row_versions`
      expect(Number(rows[0]!.n)).toBe(8)
    } finally {
      await cleanup()
    }
  })
})
