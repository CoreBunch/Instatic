/**
 * Automatic site republish after an entry's public state changes.
 *
 * The behaviour under test is "how many full site publishes happen, and when",
 * so every assertion counts rows in `site_snapshots` — `persistSitePublish`
 * writes exactly one per full publish, which makes it the honest counter. The
 * whole suite runs against a real SQLite database through the real
 * repositories: nothing here is mocked, so a run that claims to publish has
 * actually written a snapshot.
 *
 * Covered:
 *   • the scheduled-publish tick asks for a republish (the incident that
 *     started this: a post fires at 09:00 and never reaches the listing)
 *   • coalescing — N entry changes cost ONE site publish
 *   • the recursion guard — a site publish does not trigger a site publish
 *   • the operator switch — disabled means disabled
 *   • the draft-drift guard — an unpublished site edit is never promoted by an
 *     entry publish
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbClient } from '../../../server/db'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import {
  __flushAutoSitePublishForTests,
  isAutoSitePublishEnabled,
  requestAutoSitePublish,
  resetAutoSitePublishForTests,
} from '../../../server/publish/autoSitePublish'
import { resetPublishStateForTests } from '../../../server/publish/publishState'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSiteShell(): SiteShell {
  return {
    id: 'project_1',
    name: 'Listing Site',
    files: [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(undefined),
    createdAt: 1000,
    updatedAt: 2000,
  }
}

/** A minimal home page — it stands in for the baked `/blog` listing. */
function makeHomePage(text: string) {
  return {
    id: 'page_home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: ['text_1'],
        classIds: [],
      },
      text_1: {
        id: 'text_1',
        moduleId: 'base.text',
        props: { text, tag: 'h1' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
  }
}

/**
 * Bring the site to the state the automatic republish requires: one published
 * page, and a draft that matches it. Returns the snapshot count afterwards so a
 * test can assert deltas rather than absolutes.
 */
async function seedPublishedSite(db: DbClient, uploadsDir: string): Promise<void> {
  await saveDraftSite(db, makeSiteShell())
  await createDataRow(
    db,
    { id: 'page_home', tableId: 'pages', cells: pageToCells(makeHomePage('Blog')), slug: 'index' },
  )
  await publishDraftSite(db, null, uploadsDir)
}

/** Insert a post scheduled to publish in the past, so the next tick fires it. */
async function seedDuePost(db: DbClient, rowId: string, slug: string): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, scheduled_publish_at)
    values (
      ${rowId},
      ${'posts'},
      ${{ title: slug, slug }},
      ${slug},
      ${'scheduled'},
      ${new Date(Date.now() - 60_000).toISOString()}
    )
  `
}

/** One row per full site publish — see `persistSitePublish`. */
async function countSitePublishes(db: DbClient): Promise<number> {
  const { rows } = await db<{ count: number }>`select count(*) as count from site_snapshots`
  return Number(rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('automatic site republish', () => {
  const cleanupFns: Array<() => Promise<void>> = []
  let uploadsDir: string

  beforeEach(async () => {
    resetPublishStateForTests()
    resetAutoSitePublishForTests()
    uploadsDir = await mkdtemp(join(tmpdir(), 'auto-site-publish-'))
  })

  afterEach(async () => {
    // A batch armed here would otherwise fire five seconds from now, against a
    // database this test is about to delete.
    resetAutoSitePublishForTests()
    while (cleanupFns.length) await cleanupFns.pop()?.()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function makeDb(): Promise<TestDb> {
    const testDb = await createTestDb()
    cleanupFns.push(testDb.cleanup)
    return testDb
  }

  it('republishes the site after the scheduler fires a due post', async () => {
    const { db } = await makeDb()
    await seedPublishedSite(db, uploadsDir)
    const before = await countSitePublishes(db)
    await seedDuePost(db, 'post_scheduled', 'nine-am-post')

    await tickPublishScheduler(db, uploadsDir)
    // The tick returns without waiting on the rebuild — the author's (here, the
    // scheduler's) work is done the moment the row is published.
    expect(await countSitePublishes(db)).toBe(before)

    await __flushAutoSitePublishForTests()
    expect(await countSitePublishes(db)).toBe(before + 1)
  })

  it('collapses a burst of entry changes into one site publish', async () => {
    const { db } = await makeDb()
    await seedPublishedSite(db, uploadsDir)
    const before = await countSitePublishes(db)

    // Forty posts going live in one sitting — a backlog drain, or one scheduler
    // tick's worth of due rows. All inside one batch window: one publish.
    for (let i = 0; i < 40; i++) requestAutoSitePublish(db, uploadsDir)
    const draining = __flushAutoSitePublishForTests()

    // Forty more land while that publish is in flight. They cannot join the run
    // that is already reading the database, so they are owed a rebuild — but
    // ONE between them, not forty.
    for (let i = 0; i < 40; i++) requestAutoSitePublish(db, uploadsDir)
    await draining

    expect(await countSitePublishes(db)).toBe(before + 2)
  })

  it('does not let a site publish trigger another site publish', async () => {
    const { db } = await makeDb()
    await seedPublishedSite(db, uploadsDir)
    const before = await countSitePublishes(db)

    requestAutoSitePublish(db, uploadsDir)
    await __flushAutoSitePublishForTests()
    expect(await countSitePublishes(db)).toBe(before + 1)

    // Draining again publishes nothing: the completed run left no work behind,
    // so the pipeline it drove cannot have re-armed the queue.
    await __flushAutoSitePublishForTests()
    await __flushAutoSitePublishForTests()
    expect(await countSitePublishes(db)).toBe(before + 1)
  })

  it('publishes nothing when the operator has turned it off', async () => {
    const { db } = await makeDb()
    await seedPublishedSite(db, uploadsDir)
    const before = await countSitePublishes(db)

    process.env.AUTO_SITE_PUBLISH_ON_ENTRY_CHANGE = 'off'
    try {
      requestAutoSitePublish(db, uploadsDir)
      await __flushAutoSitePublishForTests()
    } finally {
      delete process.env.AUTO_SITE_PUBLISH_ON_ENTRY_CHANGE
    }

    expect(await countSitePublishes(db)).toBe(before)
  })

  it('reads the operator switch as on unless explicitly turned off', () => {
    expect(isAutoSitePublishEnabled({})).toBe(true)
    expect(isAutoSitePublishEnabled({ AUTO_SITE_PUBLISH_ON_ENTRY_CHANGE: '1' })).toBe(true)
    // A value nobody recognises keeps the correctness fix on rather than
    // silently disabling it because of a typo.
    expect(isAutoSitePublishEnabled({ AUTO_SITE_PUBLISH_ON_ENTRY_CHANGE: 'maybe' })).toBe(true)
    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' false ']) {
      expect(isAutoSitePublishEnabled({ AUTO_SITE_PUBLISH_ON_ENTRY_CHANGE: off })).toBe(false)
    }
  })

  it('never promotes a site draft that has unpublished edits', async () => {
    const { db } = await makeDb()
    await seedPublishedSite(db, uploadsDir)
    const before = await countSitePublishes(db)

    // The operator is mid-redesign. An entry publish must not push that live.
    await saveDataRowDraft(db, 'page_home', {
      cells: pageToCells(makeHomePage('Half-finished redesign')),
      slug: 'index',
    })

    requestAutoSitePublish(db, uploadsDir)
    await __flushAutoSitePublishForTests()

    expect(await countSitePublishes(db)).toBe(before)
  })

  it('ignores requests from a server with no static slot to rebuild', async () => {
    const { db } = await makeDb()
    await seedPublishedSite(db, uploadsDir)
    const before = await countSitePublishes(db)

    requestAutoSitePublish(db, undefined)
    await __flushAutoSitePublishForTests()

    expect(await countSitePublishes(db)).toBe(before)
  })
})
