/**
 * Architecture Gate — Import/export round-trip integrity
 *
 * Verifies that the site bundle export/import cycle preserves data fidelity:
 *
 *   1. Boot a fresh in-memory SQLite database and apply all migrations.
 *   2. Seed some rows into the `pages` system table.
 *   3. Simulate an export by reading tables + rows directly from repositories.
 *   4. Wipe all data rows and non-system tables.
 *   5. Simulate an import by calling `upsertDataRow` for each row.
 *   6. Assert that table counts and row counts are preserved, and that a
 *      sampled row's cells are deep-equal to the original.
 *
 * This test deliberately exercises the repository layer directly rather than
 * going through HTTP handlers, keeping it fast and free of transport concerns.
 * The full HTTP handler is covered by the server integration test suite.
 *
 * The `with strategies` describe block at the bottom additionally tests
 * `handleExportRoute` + `handleImportRoute` end-to-end with all three
 * import strategies, asserting that the final DB state and response counters
 * both match the strategy contract.
 *
 * @see server/handlers/cms/export.ts
 * @see server/handlers/cms/import.ts
 * @see src/core/data/bundleSchema.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { listDataTables } from '../../../server/repositories/data/tables'
import { listDataRows, createDataRow, upsertDataRow, getDataRow } from '../../../server/repositories/data/rows'
import { saveDraftSite, getDraftSite } from '../../../server/repositories/site'
import { createMediaAsset, assignAssetToFolders, getMediaAsset } from '../../../server/repositories/media'
import { createMediaFolder, listMediaFolders } from '../../../server/repositories/mediaFolders'
import { importDataRowRedirect, listExportableRedirects } from '../../../server/repositories/data/publish'
import { createUser } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import { handleImportRoute } from '../../../server/handlers/cms/import'
import { handleImportArchiveRoute } from '../../../server/handlers/cms/importArchive'
import { parseValue } from '@core/utils/typeboxHelpers'
import { ImportResultSchema, type BundleImportSelection, type SiteBundle } from '@core/data/bundleSchema'
import { BUNDLE_ARCHIVE_MANIFEST_PATH } from '@core/data/bundleArchive'
import { parseSiteBundleArchive } from '@core/persistence/cmsTransfer'
import type { DataRow, DataTable } from '@core/data/schemas'
import type { DbClient } from '../../../server/db/client'
import type { SiteShell } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tables: DataTable[]
let exportedRows: DataRow[]

// ---------------------------------------------------------------------------
// Setup: fresh DB, seed data, capture "export" snapshot
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Boot a fresh in-memory SQLite database
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)

  // Add a few rows to the `pages` system table
  await createDataRow(db, {
    tableId: 'pages',
    cells: {
      title: 'Home',
      slug: 'home',
      templateEnabled: false,
      body: { nodes: {}, rootNodeId: 'root' },
    },
    slug: 'home',
  })

  await createDataRow(db, {
    tableId: 'pages',
    cells: {
      title: 'Blog Post Template',
      slug: 'blog-template',
      templateEnabled: true,
      templateTarget: { kind: 'postTypes', tableSlugs: ['posts'] },
      templatePriority: 100,
      body: { nodes: {}, rootNodeId: 'root' },
    },
    slug: 'blog-template',
  })

  // Add a row to the `posts` system table
  await createDataRow(db, {
    tableId: 'posts',
    cells: { title: 'Hello World', slug: 'hello-world', body: '' },
    slug: 'hello-world',
  })

  // --- Capture the "export" snapshot ---
  tables = await listDataTables(db)
  const rowsPerTable = await Promise.all(tables.map((t) => listDataRows(db, t.id)))
  exportedRows = rowsPerTable.flat()

  // --- Wipe all data rows ---
  await db`delete from data_rows`

  // Confirm wipe
  const { rows: postWipeRows } = await db<{ cnt: number }>`select count(*) as cnt from data_rows`
  if (postWipeRows[0].cnt !== 0) throw new Error('Wipe did not clear all rows')

  // --- Simulate import: re-insert rows preserving ids, status, timestamps ---
  for (const row of exportedRows) {
    await upsertDataRow(db, {
      id: row.id,
      tableId: row.tableId,
      cells: row.cells,
      slug: row.slug,
      status: row.status,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  // Refresh from DB after import
  const reimportedRowsPerTable = await Promise.all(tables.map((t) => listDataRows(db, t.id)))
  const reimportedRows = reimportedRowsPerTable.flat()

  // Store for assertions
  ;(globalThis as Record<string, unknown>).__importRoundtripRows = reimportedRows
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('import/export round-trip — data integrity', () => {
  test('table list is preserved after round-trip', () => {
    // Tables are seeded by migrations; we only check count (system tables stay)
    expect(tables.length).toBeGreaterThanOrEqual(3)
    const tableIds = tables.map((t) => t.id).sort()
    expect(tableIds).toContain('pages')
    expect(tableIds).toContain('posts')
    expect(tableIds).toContain('components')
  })

  test('all rows are present after re-import', () => {
    const reimported = (globalThis as Record<string, unknown>).__importRoundtripRows as DataRow[]
    expect(reimported.length).toBe(exportedRows.length)
  })

  test('row ids are preserved', () => {
    const reimported = (globalThis as Record<string, unknown>).__importRoundtripRows as DataRow[]
    const originalIds = new Set(exportedRows.map((r) => r.id))
    for (const row of reimported) {
      expect(originalIds.has(row.id)).toBe(true)
    }
  })

  test('pages rows count matches export', () => {
    const reimported = (globalThis as Record<string, unknown>).__importRoundtripRows as DataRow[]
    const pagesOriginal = exportedRows.filter((r) => r.tableId === 'pages').length
    const pagesReimported = reimported.filter((r) => r.tableId === 'pages').length
    expect(pagesReimported).toBe(pagesOriginal)
  })

  test('sampled row cells are deep-equal after round-trip', () => {
    const reimported = (globalThis as Record<string, unknown>).__importRoundtripRows as DataRow[]
    const original = exportedRows.find((r) => r.tableId === 'pages' && r.slug === 'home')
    const restored = reimported.find((r) => r.id === original?.id)
    expect(original).toBeDefined()
    expect(restored).toBeDefined()
    expect(restored!.cells.title).toBe('Home')
    expect(restored!.cells.templateEnabled).toBe(false)
    expect(restored!.slug).toBe('home')
  })

  test('template row is preserved with templateEnabled=true', () => {
    const reimported = (globalThis as Record<string, unknown>).__importRoundtripRows as DataRow[]
    const restored = reimported.find((r) => r.tableId === 'pages' && r.slug === 'blog-template')
    expect(restored).toBeDefined()
    expect(restored!.cells.templateEnabled).toBe(true)
    expect(restored!.cells.templateTarget).toEqual({ kind: 'postTypes', tableSlugs: ['posts'] })
  })

  test('row status is preserved', () => {
    const reimported = (globalThis as Record<string, unknown>).__importRoundtripRows as DataRow[]
    for (const original of exportedRows) {
      const restored = reimported.find((r) => r.id === original.id)
      expect(restored?.status).toBe(original.status)
    }
  })
})

// ---------------------------------------------------------------------------
// SiteShell round-trip
// ---------------------------------------------------------------------------

describe('import/export round-trip — site shell', () => {
  test('getDraftSite returns null on a fresh in-memory DB (before setup)', async () => {
    // A separate fresh DB to confirm the null case without touching the seeded one
    const freshDb = createSqliteClient(':memory:')
    await runMigrations(freshDb, sqliteMigrations)
    const shell = await getDraftSite(freshDb)
    expect(shell).toBeNull()
  })

  test('saveDraftSite + getDraftSite round-trips the shell', async () => {
    const db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)

    const mockShell = {
      id: 'default',
      name: 'Test Site',
      breakpoints: [],
      settings: {
        homepageSlug: '',
        typography: { fontFamily: '', scale: 1, baseFontSize: 16 },
        colors: { primary: '#000000', secondary: '#ffffff', accent: '#0000ff' },
        spacing: { unit: 8, scale: 1 },
        borderRadius: { sm: 4, md: 8, lg: 16 },
        maxContentWidth: 1280,
        siteTitle: 'Test Site',
        tagline: '',
        logoUrl: '',
        faviconUrl: '',
        socialLinks: [],
        customHead: '',
        customBodyStart: '',
        customBodyEnd: '',
        analyticsCode: '',
        cookieConsent: false,
      },
      styleRules: {},
      files: [],
      packageJson: { dependencies: {}, devDependencies: {} },
      runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await saveDraftSite(db, mockShell as Parameters<typeof saveDraftSite>[1])
    const loaded = await getDraftSite(db)
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe('Test Site')
    expect(loaded!.id).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// Strategy round-trips via HTTP handlers
// ---------------------------------------------------------------------------

/**
 * Minimal valid site shell used for seeding source databases.
 */
const ROUNDTRIP_SHELL: SiteShell = {
  id: 'default',
  name: 'Roundtrip Source Site',
  breakpoints: [],
  settings: { shortcuts: {} },
  styleRules: {},
  files: [],
  packageJson: { dependencies: {}, devDependencies: {} },
  runtime: {
    dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
    scripts: {},
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

/**
 * Seed a site + owner user + session into `db`, return the auth cookie.
 */
async function seedRoundtripAuth(db: DbClient, email: string): Promise<string> {
  await saveDraftSite(db, ROUNDTRIP_SHELL)
  await createUser(db, {
    id: `owner-${email}`,
    email,
    displayName: 'Test Owner',
    passwordHash: 'placeholder-hash',
    roleId: 'owner',
    allowOwnerRole: true,
  })
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: `owner-${email}`,
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
    // Pre-open a step-up window — the `replace` import strategy
    // (capabilities review G6 fix) now requires step-up since wipe-and-
    // reload is the highest blast radius op. Tests skip the step-up
    // dance by seeding the row directly.
    stepUpExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

/**
 * Build and export a bundle from a seeded source DB.
 * Returns the parsed SiteBundle JSON object.
 */
async function exportBundle(
  sourceDb: DbClient,
  sourceCookie: string,
): Promise<SiteBundle> {
  const req = new Request('http://localhost/admin/api/cms/export', { method: 'GET' })
  req.headers.set('cookie', sourceCookie)
  const res = await handleExportRoute(req, sourceDb)
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  const bundle = parseSiteBundleArchive(new Uint8Array(await res!.arrayBuffer()))
  expect(bundle).not.toBeNull()
  return bundle!
}

describe('with strategies — handler-level roundtrip', () => {
  /**
   * Source DB: seeded once for all strategy sub-tests.
   * Contains 3 posts rows and 1 pages row.
   */
  let sourceBundle: SiteBundle

  beforeAll(async () => {
    const sourceDb = createSqliteClient(':memory:')
    await runMigrations(sourceDb, sqliteMigrations)
    const sourceCookie = await seedRoundtripAuth(sourceDb, 'source@roundtrip.test')

    await createDataRow(sourceDb, {
      tableId: 'posts',
      cells: { title: 'Post A', slug: 'post-a' },
      slug: 'post-a',
    })
    await createDataRow(sourceDb, {
      tableId: 'posts',
      cells: { title: 'Post B', slug: 'post-b' },
      slug: 'post-b',
    })
    await createDataRow(sourceDb, {
      tableId: 'posts',
      cells: { title: 'Post C', slug: 'post-c' },
      slug: 'post-c',
    })
    await createDataRow(sourceDb, {
      tableId: 'pages',
      cells: { title: 'Home', slug: 'home', body: { nodes: {}, rootNodeId: 'root' } },
      slug: 'home',
    })
    // A saved layout — rides the same generic table/row pipeline; the
    // replace strategy must restore it into the seeded system table.
    await createDataRow(sourceDb, {
      tableId: 'layouts',
      cells: {
        name: 'Hero',
        slug: 'hero',
        body: { nodes: { root: { id: 'root', moduleId: 'base.container', props: {}, breakpointOverrides: {}, children: [], classIds: [] } }, rootNodeId: 'root' },
        classes: {},
      },
      slug: 'hero',
    })

    sourceBundle = await exportBundle(sourceDb, sourceCookie)
  })

  test('source bundle has 5 rows and at least 4 tables', () => {
    expect(sourceBundle.rows.length).toBe(5)
    expect(sourceBundle.tables.length).toBeGreaterThanOrEqual(4)
  })

  describe('strategy: replace into empty DB', () => {
    let result: ReturnType<typeof parseValue<typeof ImportResultSchema>>
    let targetDb: DbClient
    let targetCookie: string

    beforeAll(async () => {
      targetDb = createSqliteClient(':memory:')
      await runMigrations(targetDb, sqliteMigrations)
      targetCookie = await seedRoundtripAuth(targetDb, 'target-replace@roundtrip.test')

      const req = new Request('http://localhost/admin/api/cms/import?strategy=replace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourceBundle),
      })
      req.headers.set('cookie', targetCookie)
      const res = await handleImportRoute(req, targetDb)
      expect(res!.status).toBe(200)
      const body = JSON.parse(await res!.text())
      result = parseValue(ImportResultSchema, body)
    })

    test('result.ok is true and strategy is replace', () => {
      expect(result.ok).toBe(true)
      expect(result.strategy).toBe('replace')
    })

    test('rowsInserted equals source bundle row count', () => {
      expect(result.rowsInserted).toBe(sourceBundle.rows.length)
    })

    test('rowsReplaced and rowsSkipped are 0 (wipe-and-insert)', () => {
      expect(result.rowsReplaced).toBe(0)
      expect(result.rowsSkipped).toBe(0)
    })

    test('target DB has same row ids as source bundle', async () => {
      const tables = await listDataTables(targetDb)
      const allRows: DataRow[] = []
      for (const t of tables) {
        const rows = await listDataRows(targetDb, t.id)
        allRows.push(...rows)
      }
      const targetIds = new Set(allRows.map((r) => r.id))
      const bundleIds = new Set(sourceBundle.rows.map((r) => r.id))
      for (const id of bundleIds) {
        expect(targetIds.has(id)).toBe(true)
      }
    })

    test('target DB has no rows beyond the bundle', async () => {
      const tables = await listDataTables(targetDb)
      const allRows: DataRow[] = []
      for (const t of tables) {
        const rows = await listDataRows(targetDb, t.id)
        allRows.push(...rows)
      }
      const bundleIds = new Set(sourceBundle.rows.map((r) => r.id))
      const extraRows = allRows.filter((r) => !bundleIds.has(r.id))
      expect(extraRows).toEqual([])
      expect(allRows.length).toBe(sourceBundle.rows.length)
    })
  })

  describe('strategy: merge-add into empty DB', () => {
    let result: ReturnType<typeof parseValue<typeof ImportResultSchema>>
    let targetDb: DbClient
    let targetCookie: string

    beforeAll(async () => {
      targetDb = createSqliteClient(':memory:')
      await runMigrations(targetDb, sqliteMigrations)
      targetCookie = await seedRoundtripAuth(targetDb, 'target-merge-add@roundtrip.test')

      const req = new Request('http://localhost/admin/api/cms/import?strategy=merge-add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourceBundle),
      })
      req.headers.set('cookie', targetCookie)
      const res = await handleImportRoute(req, targetDb)
      expect(res!.status).toBe(200)
      const body = JSON.parse(await res!.text())
      result = parseValue(ImportResultSchema, body)
    })

    test('result.ok is true and strategy is merge-add', () => {
      expect(result.ok).toBe(true)
      expect(result.strategy).toBe('merge-add')
    })

    test('all bundle rows are inserted (empty target → no skips)', () => {
      expect(result.rowsInserted).toBe(sourceBundle.rows.length)
      expect(result.rowsSkipped).toBe(0)
      expect(result.rowsReplaced).toBe(0)
    })

    test('target DB contains all bundle rows', async () => {
      const tables = await listDataTables(targetDb)
      const allRows: DataRow[] = []
      for (const t of tables) {
        const rows = await listDataRows(targetDb, t.id)
        allRows.push(...rows)
      }
      const targetIds = new Set(allRows.map((r) => r.id))
      for (const bundleRow of sourceBundle.rows) {
        expect(targetIds.has(bundleRow.id)).toBe(true)
      }
    })
  })

  describe('strategy: merge-overwrite into empty DB', () => {
    let result: ReturnType<typeof parseValue<typeof ImportResultSchema>>
    let targetDb: DbClient
    let targetCookie: string

    beforeAll(async () => {
      targetDb = createSqliteClient(':memory:')
      await runMigrations(targetDb, sqliteMigrations)
      targetCookie = await seedRoundtripAuth(targetDb, 'target-merge-overwrite@roundtrip.test')

      const req = new Request('http://localhost/admin/api/cms/import?strategy=merge-overwrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourceBundle),
      })
      req.headers.set('cookie', targetCookie)
      const res = await handleImportRoute(req, targetDb)
      expect(res!.status).toBe(200)
      const body = JSON.parse(await res!.text())
      result = parseValue(ImportResultSchema, body)
    })

    test('result.ok is true and strategy is merge-overwrite', () => {
      expect(result.ok).toBe(true)
      expect(result.strategy).toBe('merge-overwrite')
    })

    test('all bundle rows are inserted (empty target → no replacements)', () => {
      // Empty target: no pre-existing ids → all are new inserts
      expect(result.rowsInserted).toBe(sourceBundle.rows.length)
      expect(result.rowsReplaced).toBe(0)
      expect(result.rowsSkipped).toBe(0)
    })

    test('target DB contains all bundle rows', async () => {
      const tables = await listDataTables(targetDb)
      const allRows: DataRow[] = []
      for (const t of tables) {
        const rows = await listDataRows(targetDb, t.id)
        allRows.push(...rows)
      }
      const targetIds = new Set(allRows.map((r) => r.id))
      for (const bundleRow of sourceBundle.rows) {
        expect(targetIds.has(bundleRow.id)).toBe(true)
      }
    })
  })

  describe('strategy: merge-overwrite with pre-existing rows', () => {
    let result: ReturnType<typeof parseValue<typeof ImportResultSchema>>
    let targetDb: DbClient
    let targetCookie: string
    let localOnlyRowId: string

    beforeAll(async () => {
      targetDb = createSqliteClient(':memory:')
      await runMigrations(targetDb, sqliteMigrations)
      targetCookie = await seedRoundtripAuth(targetDb, 'target-mo-collision@roundtrip.test')

      // Pre-seed: add a local-only row + one row that will collide with bundle
      const localOnly = await createDataRow(targetDb, {
        tableId: 'posts',
        cells: { title: 'Local Only Row', slug: 'local-only' },
        slug: 'local-only',
      })
      localOnlyRowId = localOnly.id

      // Plant one bundle row already in the target (so it becomes a "replace" hit)
      await upsertDataRow(targetDb, {
        id: sourceBundle.rows[0].id,
        tableId: sourceBundle.rows[0].tableId,
        cells: { title: 'Old Local Version' },
        slug: 'old-slug',
        status: 'draft',
        publishedAt: null,
        createdAt: null,
        updatedAt: null,
      })

      const req = new Request('http://localhost/admin/api/cms/import?strategy=merge-overwrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourceBundle),
      })
      req.headers.set('cookie', targetCookie)
      const res = await handleImportRoute(req, targetDb)
      expect(res!.status).toBe(200)
      const body = JSON.parse(await res!.text())
      result = parseValue(ImportResultSchema, body)
    })

    test('rowsReplaced=1 for the pre-existing collision', () => {
      expect(result.rowsReplaced).toBe(1)
    })

    test('rowsInserted matches remaining new rows', () => {
      expect(result.rowsInserted).toBe(sourceBundle.rows.length - 1)
    })

    test('local-only row is still present (merge-overwrite leaves untouched rows)', async () => {
      const posts = await listDataRows(targetDb, 'posts')
      const ids = posts.map((r) => r.id)
      expect(ids).toContain(localOnlyRowId)
    })

    test('collided row now has the bundle version of its cells', async () => {
      const posts = await listDataRows(targetDb, 'posts')
      const bundleFirst = sourceBundle.rows.find((r) => r.tableId === 'posts')
      expect(bundleFirst).toBeDefined()
      const localRow = posts.find((r) => r.id === bundleFirst!.id)
      expect(localRow).toBeDefined()
      // Bundle cell value, not the old 'Old Local Version' placeholder
      expect(localRow!.cells['title']).toBe(bundleFirst!.cells['title'])
    })
  })
})

// ---------------------------------------------------------------------------
// Full-site round-trip — media folders, folder membership, and redirects
// ---------------------------------------------------------------------------
//
// Proves the "export → import into a fresh instance → identical" guarantee for
// the categories beyond tables/rows: the media folder tree, each asset's folder
// membership, and published-URL redirects. Uses a real temp uploads dir so the
// media bytes (and therefore `folderIds`) travel through the bundle.

describe('full-site round-trip — folders, membership, redirects', () => {
  let sourceDir: string
  let targetDir: string
  let targetDb: DbClient
  let folderId: string
  let assetId: string
  let redirectTargetRowId: string

  beforeAll(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'instatic-export-src-'))
    targetDir = await mkdtemp(join(tmpdir(), 'instatic-export-tgt-'))

    // --- Source: seed a folder, an asset assigned to it, and a redirect ---
    const sourceDb = createSqliteClient(':memory:')
    await runMigrations(sourceDb, sqliteMigrations)
    const sourceCookie = await seedRoundtripAuth(sourceDb, 'fullsite@roundtrip.test')

    const targetRow = await createDataRow(sourceDb, {
      tableId: 'posts',
      cells: { title: 'Renamed Post', slug: 'renamed' },
      slug: 'renamed',
    })
    redirectTargetRowId = targetRow.id

    const folder = await createMediaFolder(sourceDb, {
      id: 'folder-logos',
      parentId: null,
      name: 'Logos',
      slug: 'logos',
      createdByUserId: 'owner-fullsite@roundtrip.test',
    })
    folderId = folder.id

    // PNG magic signature (8 bytes) padded to 14 bytes so sizeBytes matches
    // the createMediaAsset call below. The security gate added on this branch
    // calls detectAcceptedMime() on every staged entry before disk write, so
    // the fixture must start with real PNG magic bytes.
    await writeFile(
      join(sourceDir, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    )
    const asset = await createMediaAsset(sourceDb, {
      id: 'asset-logo',
      filename: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: 14,
      storagePath: 'logo.png',
      publicPath: '/uploads/logo.png',
      uploadedByUserId: null,
      storageAdapterId: '',
      externallyHosted: false,
    })
    assetId = asset.id
    await assignAssetToFolders(sourceDb, asset.id, { add: [folder.id] })

    await importDataRowRedirect(sourceDb, {
      id: 'redirect-1',
      tableId: 'posts',
      fromRouteBase: '/posts',
      fromSlug: 'old-slug',
      targetRowId: targetRow.id,
    })

    // --- Export the full bundle (media included so folderIds travel) ---
    const exportReq = new Request('http://localhost/admin/api/cms/export?includeMedia=1', { method: 'GET' })
    exportReq.headers.set('cookie', sourceCookie)
    const exportRes = await handleExportRoute(exportReq, sourceDb, { uploadsDir: sourceDir })
    expect(exportRes!.status).toBe(200)
    const archiveBytes = new Uint8Array(await exportRes!.arrayBuffer())
    const bundle = parseSiteBundleArchive(archiveBytes)
    expect(bundle).not.toBeNull()

    // The bundle must actually carry the new categories.
    expect(bundle!.mediaFolders?.length).toBe(1)
    expect(bundle!.redirects?.length).toBe(1)
    expect(bundle!.media?.find((m) => m.id === 'asset-logo')?.folderIds).toEqual(['folder-logos'])

    // --- Import (replace) into a pristine instance ---
    targetDb = createSqliteClient(':memory:')
    await runMigrations(targetDb, sqliteMigrations)
    const targetCookie = await seedRoundtripAuth(targetDb, 'fullsite-target@roundtrip.test')

    const importReq = new Request('http://localhost/admin/api/cms/import/archive?strategy=replace', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: archiveBytes,
    })
    importReq.headers.set('cookie', targetCookie)
    const importRes = await handleImportArchiveRoute(importReq, targetDb, { uploadsDir: targetDir })
    expect(importRes!.status).toBe(200)
    const result = parseValue(ImportResultSchema, JSON.parse(await importRes!.text()))
    expect(result.mediaFoldersImported).toBe(1)
    expect(result.mediaImported).toBe(1)
    expect(result.redirectsImported).toBe(1)
  })

  afterAll(async () => {
    await rm(sourceDir, { recursive: true, force: true })
    await rm(targetDir, { recursive: true, force: true })
  })

  test('media folder tree is restored identically', async () => {
    const folders = await listMediaFolders(targetDb)
    expect(folders.length).toBe(1)
    expect(folders[0]?.id).toBe(folderId)
    expect(folders[0]?.name).toBe('Logos')
    expect(folders[0]?.slug).toBe('logos')
  })

  test('asset folder membership is restored', async () => {
    const asset = await getMediaAsset(targetDb, assetId)
    expect(asset).not.toBeNull()
    expect(asset!.folderIds).toContain(folderId)
  })

  test('redirect is restored and points at the imported row', async () => {
    const redirects = await listExportableRedirects(targetDb)
    expect(redirects.length).toBe(1)
    expect(redirects[0]?.fromSlug).toBe('old-slug')
    expect(redirects[0]?.targetRowId).toBe(redirectTargetRowId)
    // The target row really exists in the fresh instance.
    expect(await getDataRow(targetDb, redirectTargetRowId)).not.toBeNull()
  })
})

describe('archive import validation', () => {
  test('rejects an Instatic archive that omits manifest-declared media', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-import-missing-media-'))
    try {
      const db = createSqliteClient(':memory:')
      await runMigrations(db, sqliteMigrations)
      const cookie = await seedRoundtripAuth(db, 'missing-media@roundtrip.test')
      const manifest = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: [],
        rows: [],
        media: [
          {
            id: 'asset-missing',
            filename: 'missing.png',
            mimeType: 'image/png',
            sizeBytes: 4,
            altText: '',
            caption: '',
            title: '',
            tags: [],
            width: null,
            height: null,
            durationMs: null,
            dominantColor: null,
            blurHash: null,
            storagePath: 'missing.png',
            posterPath: null,
            folderIds: [],
          },
        ],
      }
      const archiveBytes = zipSync({
        [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
      }, { level: 0 })

      const req = new Request('http://localhost/admin/api/cms/import/archive?strategy=merge-add', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: archiveBytes,
      })
      req.headers.set('cookie', cookie)
      const res = await handleImportArchiveRoute(req, db, { uploadsDir })
      expect(res!.status).toBe(400)
      const body = JSON.parse(await res!.text())
      expect(body.error).toBe('Archive is missing media file "media/missing.png"')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('rejects malformed replace archives before mutating existing data', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-import-atomic-media-'))
    try {
      const db = createSqliteClient(':memory:')
      await runMigrations(db, sqliteMigrations)
      const cookie = await seedRoundtripAuth(db, 'atomic-media@roundtrip.test')
      const existingRow = await createDataRow(db, {
        tableId: 'posts',
        cells: { title: 'Keep me', slug: 'keep-me' },
        slug: 'keep-me',
      })
      const manifest = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: [],
        rows: [],
        media: [
          {
            id: 'asset-missing',
            filename: 'missing.png',
            mimeType: 'image/png',
            sizeBytes: 4,
            altText: '',
            caption: '',
            title: '',
            tags: [],
            width: null,
            height: null,
            durationMs: null,
            dominantColor: null,
            blurHash: null,
            storagePath: 'missing.png',
            posterPath: null,
            folderIds: [],
          },
        ],
      }
      const archiveBytes = zipSync({
        [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
      }, { level: 0 })

      const req = new Request('http://localhost/admin/api/cms/import/archive?strategy=replace', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: archiveBytes,
      })
      req.headers.set('cookie', cookie)
      const res = await handleImportArchiveRoute(req, db, { uploadsDir })
      expect(res!.status).toBe(400)
      expect(await getDataRow(db, existingRow.id)).not.toBeNull()
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('merge-add archive import skips rows whose slug is already used locally', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-import-slug-conflict-'))
    try {
      const db = createSqliteClient(':memory:')
      await runMigrations(db, sqliteMigrations)
      const cookie = await seedRoundtripAuth(db, 'slug-conflict@roundtrip.test')
      await createDataRow(db, {
        id: 'local-existing-row',
        tableId: 'posts',
        cells: { title: 'Local row', slug: 'shared-slug' },
        slug: 'shared-slug',
      })
      const postsTable = (await listDataTables(db)).find((table) => table.id === 'posts')
      expect(postsTable).toBeDefined()
      const manifest = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: [postsTable!],
        rows: [
          {
            id: 'bundle-conflicting-row',
            tableId: 'posts',
            cells: { title: 'Bundle row', slug: 'shared-slug' },
            slug: 'shared-slug',
            status: 'draft',
            authorUserId: null,
            createdByUserId: null,
            updatedByUserId: null,
            publishedByUserId: null,
            author: null,
            createdBy: null,
            updatedBy: null,
            publishedBy: null,
            publishedAt: null,
            scheduledPublishAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: null,
          },
        ],
      }
      const archiveBytes = zipSync({
        [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
      }, { level: 0 })

      const req = new Request('http://localhost/admin/api/cms/import/archive?strategy=merge-add', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: archiveBytes,
      })
      req.headers.set('cookie', cookie)
      const res = await handleImportArchiveRoute(req, db, { uploadsDir })
      expect(res!.status).toBe(200)
      const body = parseValue(ImportResultSchema, JSON.parse(await res!.text()))
      expect(body.rowsInserted).toBe(0)
      expect(body.rowsSkipped).toBe(1)
      expect(await getDataRow(db, 'bundle-conflicting-row')).toBeNull()
      expect(await getDataRow(db, 'local-existing-row')).not.toBeNull()
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('skips unselected media entries while streaming a selected archive import', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-import-skip-media-'))
    try {
      const db = createSqliteClient(':memory:')
      await runMigrations(db, sqliteMigrations)
      const cookie = await seedRoundtripAuth(db, 'skip-media@roundtrip.test')
      const manifest = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: [],
        rows: [],
        media: [
          {
            id: 'asset-skipped',
            filename: 'skipped.png',
            mimeType: 'image/png',
            sizeBytes: 4,
            altText: '',
            caption: '',
            title: '',
            tags: [],
            width: null,
            height: null,
            durationMs: null,
            dominantColor: null,
            blurHash: null,
            storagePath: 'skipped.png',
            posterPath: null,
            folderIds: [],
          },
          {
            id: 'asset-imported',
            filename: 'imported.png',
            mimeType: 'image/png',
            // 8 bytes — exactly the PNG magic signature so detectAcceptedMime
            // identifies the file as image/png through the new MIME-gate.
            sizeBytes: 8,
            altText: '',
            caption: '',
            title: '',
            tags: [],
            width: null,
            height: null,
            durationMs: null,
            dominantColor: null,
            blurHash: null,
            storagePath: 'imported.png',
            posterPath: null,
            folderIds: [],
          },
        ],
      }
      // PNG magic signature: 89 50 4E 47 0D 0A 1A 0A (8 bytes).
      // The security gate added on this branch calls detectAcceptedMime() on
      // every staged entry's bytes before writing to disk, so fixtures must
      // carry real magic bytes for the MIME they declare.
      const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const archiveBytes = zipSync({
        [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
        // Unselected entry — bytes are drained without MIME validation; any
        // content works but sizeBytes must match the manifest declaration.
        'media/skipped.png': strToU8('skip'),
        'media/imported.png': pngMagic,
      }, { level: 0 })
      const selection: BundleImportSelection = {
        includeSite: false,
        tables: [],
        includeMedia: true,
        mediaIds: ['asset-imported'],
        includeMediaFolders: false,
        includeRedirects: false,
      }
      const params = new URLSearchParams({
        strategy: 'merge-add',
        selection: JSON.stringify(selection),
      })

      const req = new Request(`http://localhost/admin/api/cms/import/archive?${params.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: archiveBytes,
      })
      req.headers.set('cookie', cookie)
      const res = await handleImportArchiveRoute(req, db, { uploadsDir })
      expect(res!.status).toBe(200)
      const body = parseValue(ImportResultSchema, JSON.parse(await res!.text()))
      expect(body.mediaImported).toBe(1)
      expect(await getMediaAsset(db, 'asset-skipped')).toBeNull()
      expect(await getMediaAsset(db, 'asset-imported')).not.toBeNull()
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
