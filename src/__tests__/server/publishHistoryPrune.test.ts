/**
 * publishHistoryPrune.test.ts — repeated publishing must not grow the
 * database without bound.
 *
 * Every full publish stores a new site document and a fresh copy of every
 * page's runtime scripts. On a live site that added the whole site to the
 * database on each publish (1.4 GB after a few hundred publishes).
 * `prunePublishHistory` keeps the newest snapshots, anything an active page
 * version still points at, and drops the rest.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import type { DbClient } from '../../../server/db/client'
import { createDataRow } from '../../../server/repositories/data'
import { nextDataRowVersionNumber } from '../../../server/repositories/data/versions'
import {
  getPublishedPageBySlug,
  persistSitePublish,
  prunePublishHistory,
  PUBLISH_HISTORY_KEEP,
} from '../../../server/repositories/publish'
import { getPublishedRuntimeAsset } from '../../../server/repositories/runtimeAsset'
import { MAIN_SCOPE } from '../../../server/branches/scope'

async function setupDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-prune-'))
  const db = createSqliteClient(join(dir, 'test.db'))
  await runMigrations(db, sqliteMigrations)
  return {
    db,
    cleanup: async () => {
      await db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const PAGES = { a: { id: 'page_a', slug: 'a' }, b: { id: 'page_b', slug: 'b' } } as const

async function seedPages(db: DbClient): Promise<void> {
  await db`insert into users (id, email, email_normalized, display_name, password_hash, role_id)
           values (${'admin_1'}, ${'a@example.com'}, ${'a@example.com'}, ${'A'}, ${'hash'}, ${'member'})`
  for (const page of Object.values(PAGES)) {
    await createDataRow(db, MAIN_SCOPE, {
      id: page.id,
      tableId: 'pages',
      cells: { title: page.slug, slug: page.slug },
      slug: page.slug,
    })
  }
}

/** One full publish of the given pages; returns each page's new asset path. */
async function publish(db: DbClient, pageKeys: Array<keyof typeof PAGES>): Promise<Record<string, string>> {
  const assetPaths: Record<string, string> = {}
  const pages = []
  for (const key of pageKeys) {
    const page = PAGES[key]
    const versionId = nanoid()
    const publicPath = `/_instatic/assets/${versionId}/page.js`
    assetPaths[key] = publicPath
    pages.push({
      pageId: page.id,
      title: page.slug,
      slug: page.slug,
      versionId,
      versionNumber: await nextDataRowVersionNumber(db, page.id),
      runtimeAssets: null,
      runtimeFiles: [{
        path: 'page.js',
        publicPath,
        content: 'console.log(1)',
        bytes: new TextEncoder().encode('console.log(1)'),
        contentType: 'text/javascript',
      }],
    })
  }
  await persistSitePublish(db, {
    siteSnapshotId: nanoid(),
    site: { pages: [] } as unknown as SiteDocument,
    serializedImportmap: null,
    pages,
    publishedByUserId: 'admin_1',
  })
  // created_at has millisecond precision; keep publishes strictly ordered.
  await Bun.sleep(5)
  return assetPaths
}

async function count(db: DbClient, table: string): Promise<number> {
  const { rows } = await db.unsafe<{ n: number }>(`select count(*) as n from ${table}`)
  return Number(rows[0]?.n ?? 0)
}

describe('prunePublishHistory', () => {
  it('keeps recent and active publishes, drops the rest, and keeps version history', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await seedPages(db)
      const p1 = await publish(db, ['a', 'b'])
      const p2 = await publish(db, ['a', 'b'])
      const p3 = await publish(db, ['a'])
      const p4 = await publish(db, ['a'])

      await prunePublishHistory(db, 2)

      // p3 + p4 are the newest two; p2 stays because page b is still live on it.
      expect(await count(db, 'site_snapshots')).toBe(3)
      // a's p1/p2 scripts and b's p1 scripts are gone; the rest still serve.
      expect(await getPublishedRuntimeAsset(db, p1.a!)).toBeNull()
      expect(await getPublishedRuntimeAsset(db, p2.a!)).toBeNull()
      expect(await getPublishedRuntimeAsset(db, p1.b!)).toBeNull()
      expect(await getPublishedRuntimeAsset(db, p2.b!)).not.toBeNull()
      expect(await getPublishedRuntimeAsset(db, p3.a!)).not.toBeNull()
      expect(await getPublishedRuntimeAsset(db, p4.a!)).not.toBeNull()

      // Both pages still render from their active versions.
      expect(await getPublishedPageBySlug(db, 'a')).not.toBeNull()
      expect(await getPublishedPageBySlug(db, 'b')).not.toBeNull()

      // Version history keeps every version; pruned ones lose only the snapshot link.
      expect(await count(db, 'data_row_versions')).toBe(6)
      const { rows } = await db<{ n: number }>`
        select count(*) as n from data_row_versions where site_snapshot_id is null
      `
      expect(Number(rows[0]?.n)).toBe(2)
    } finally {
      await cleanup()
    }
  })

  it('runs on every publish, so storage stays bounded', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await seedPages(db)
      for (let i = 0; i < PUBLISH_HISTORY_KEEP + 3; i++) {
        await publish(db, ['a', 'b'])
      }
      expect(await count(db, 'site_snapshots')).toBe(PUBLISH_HISTORY_KEEP)
      expect(await count(db, 'published_runtime_assets')).toBe(PUBLISH_HISTORY_KEEP * 2)
      expect(await count(db, 'data_row_versions')).toBe((PUBLISH_HISTORY_KEEP + 3) * 2)
    } finally {
      await cleanup()
    }
  })
})
