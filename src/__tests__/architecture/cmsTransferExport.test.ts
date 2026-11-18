/**
 * Architecture Gate — Site-transfer export filters
 *
 * Verifies that `handleExportRoute` correctly applies the `tables`, `rowIds`,
 * `includeMedia`, and `includeSite` filter options for both GET (query string)
 * and POST (JSON body) requests.
 *
 * Uses a real in-memory SQLite database with all migrations applied. Auth is
 * seeded directly via repositories (no HTTP round-trip to /setup).
 *
 * @see server/handlers/cms/export.ts
 * @see src/core/data/bundleSchema.ts
 * @see docs/plans/2026-05-19-site-transfer-ux.md
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { saveDraftSite } from '../../../server/repositories/site'
import { createUser } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import { createMediaAsset } from '../../../server/repositories/media'
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { createDataTable } from '../../../server/repositories/data/tables'
import { createDataRow } from '../../../server/repositories/data/rows'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import type { SiteBundle } from '@core/data/bundleSchema'
import { BUNDLE_ARCHIVE_MANIFEST_PATH } from '@core/data/bundleArchive'
import type { DbClient } from '../../../server/db/client'
import type { SiteShell } from '@core/page-tree'
import { MAIN_SCOPE } from '../../../server/branches/scope'

// ---------------------------------------------------------------------------
// Minimal valid site shell for seeding
// ---------------------------------------------------------------------------

const TEST_SHELL: SiteShell = {
  id: 'default',
  name: 'Transfer Test Site',
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

// ---------------------------------------------------------------------------
// seedAuth — seeds site + owner user + session; returns the cookie string
// ---------------------------------------------------------------------------

async function seedAuth(db: DbClient): Promise<string> {
  await saveDraftSite(db, MAIN_SCOPE, TEST_SHELL)
  await createUser(db, {
    id: 'test-owner',
    email: 'owner@export.test',
    displayName: 'Test Owner',
    passwordHash: 'placeholder-hash',
    roleId: 'owner',
    allowOwnerRole: true,
  })
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: 'test-owner',
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGetRequest(path: string, cookie: string): Request {
  const req = new Request(`http://localhost${path}`, { method: 'GET' })
  // The `cookie` header is a forbidden header per WHATWG Fetch spec and is
  // stripped by Bun's Request constructor. Set it after construction instead.
  req.headers.set('cookie', cookie)
  return req
}

function makePostRequest(path: string, cookie: string, body: unknown): Request {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.headers.set('cookie', cookie)
  return req
}

function makeFormPostRequest(path: string, cookie: string, body: unknown): Request {
  const form = new URLSearchParams()
  form.set('exportRequest', JSON.stringify(body))
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  req.headers.set('cookie', cookie)
  return req
}

type ArchiveBundle = Omit<SiteBundle, 'media'> & {
  media?: Array<Omit<NonNullable<SiteBundle['media']>[number], 'bytesBase64'>>
}

async function readExportArchive(res: Response): Promise<{
  bundle: ArchiveBundle
  entries: Record<string, Uint8Array>
}> {
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/zip')
  expect(res.headers.get('content-disposition')).toContain('attachment')
  expect(res.headers.get('content-disposition')).toContain('.zip')

  const bytes = new Uint8Array(await res.arrayBuffer())
  const entries = unzipSync(bytes)
  const manifestBytes = entries[BUNDLE_ARCHIVE_MANIFEST_PATH]
  expect(manifestBytes).toBeDefined()

  const bundle = JSON.parse(strFromU8(manifestBytes!)) as ArchiveBundle
  expect(bundle.schemaVersion).toBe(1)
  return { bundle, entries }
}

// ---------------------------------------------------------------------------
// Shared state set up in beforeAll
// ---------------------------------------------------------------------------

let db: DbClient
let cookie: string
let post1Id: string
let post2Id: string
let pageId: string
let customRowId: string
const CUSTOM_TABLE_ID = 'my-data-test'

beforeAll(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  cookie = await seedAuth(db)

  // Create 1 custom table ("My Data")
  await createDataTable(db, MAIN_SCOPE, {
    id: CUSTOM_TABLE_ID,
    name: 'My Data',
    slug: 'my-data-test',
    kind: 'data',
    singularLabel: 'My Item',
    pluralLabel: 'My Data',
  })

  // Seed 2 rows in posts
  const p1 = await createDataRow(db, MAIN_SCOPE, {
    tableId: 'posts',
    cells: { title: 'Post One', slug: 'post-one' },
    slug: 'post-one',
  })
  const p2 = await createDataRow(db, MAIN_SCOPE, {
    tableId: 'posts',
    cells: { title: 'Post Two', slug: 'post-two' },
    slug: 'post-two',
  })
  post1Id = p1.id
  post2Id = p2.id

  // Seed 1 row in pages
  const pg = await createDataRow(db, MAIN_SCOPE, {
    tableId: 'pages',
    cells: { title: 'Home Page', slug: 'home', body: { nodes: {}, rootNodeId: 'root' } },
    slug: 'home',
  })
  pageId = pg.id

  // Seed 1 row in My Data
  const cr = await createDataRow(db, MAIN_SCOPE, {
    tableId: CUSTOM_TABLE_ID,
    cells: { name: 'Custom Item One' },
    slug: '',
  })
  customRowId = cr.id
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleExportRoute — GET no filters', () => {
  test('returns all 4 rows across all tables', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    expect(res).not.toBeNull()

    const { bundle } = await readExportArchive(res!)

    expect(bundle.rows.length).toBe(4)
  })

  test('includes all tables (system + custom)', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    const tableIds = bundle.tables.map((t) => t.id)
    expect(tableIds).toContain('posts')
    expect(tableIds).toContain('pages')
    expect(tableIds).toContain('components')
    expect(tableIds).toContain(CUSTOM_TABLE_ID)
  })

  test('site shell is present by default', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.site).toBeDefined()
    expect(bundle.site!.name).toBe('Transfer Test Site')
  })

  test('sourceSiteName is set from the site shell name', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.sourceSiteName).toBe('Transfer Test Site')
  })

  test('media is absent (not requested)', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.media).toBeUndefined()
  })
})

describe('handleExportRoute — GET ?tables=posts', () => {
  test('returns only the posts table', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('posts')
  })

  test('returns only the 2 posts rows', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.rows.length).toBe(2)
    expect(bundle.rows.every((r) => r.tableId === 'posts')).toBe(true)
  })

  test('site is still present when only tables are filtered', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.site).toBeDefined()
  })
})

describe('handleExportRoute — POST { tables: [{ tableId: "posts", rowIds: [id1, id2] }] }', () => {
  test('returns only the 2 specified rows', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'posts', rowIds: [post1Id, post2Id] }],
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    const returnedIds = bundle.rows.map((r) => r.id)
    expect(returnedIds).toContain(post1Id)
    expect(returnedIds).toContain(post2Id)
    expect(returnedIds).not.toContain(pageId)
    expect(returnedIds).not.toContain(customRowId)
    expect(bundle.rows.length).toBe(2)
  })

  test('only the selected table is included (others are excluded)', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'posts', rowIds: [post1Id, post2Id] }],
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    const tableIds = bundle.tables.map((t) => t.id)
    expect(tableIds).toContain('posts')
    expect(tableIds).not.toContain('pages')
    expect(tableIds).not.toContain(CUSTOM_TABLE_ID)
  })

  test('accepts form-encoded exportRequest for browser-native downloads', async () => {
    const req = makeFormPostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'posts', rowIds: [post1Id] }],
      includeMedia: true,
      includeSite: false,
      includeMediaFolders: false,
      includeRedirects: false,
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE, { uploadsDir: '/tmp/test-uploads-export' })
    const { bundle } = await readExportArchive(res!)

    expect(bundle.site).toBeUndefined()
    expect(bundle.rows.map((r) => r.id)).toEqual([post1Id])
    expect(bundle.media).toEqual([])
    expect(bundle.mediaFolders).toBeUndefined()
    expect(bundle.redirects).toBeUndefined()
  })
})

describe('handleExportRoute — GET ?includeMedia=1', () => {
  test('streams archive downloads instead of materializing media and the zip in memory', async () => {
    const source = await readFile(
      join(process.cwd(), 'server/handlers/cms/export.ts'),
      'utf-8',
    )

    expect(source).not.toContain('zipSync')
    expect(source).not.toContain('readFile(join(uploadsDir')
  })

  test('returns a zip archive with media metadata in the Instatic manifest and bytes under media/', async () => {
    const mediaDb = createSqliteClient(':memory:')
    await runMigrations(mediaDb, sqliteMigrations)
    const mediaCookie = await seedAuth(mediaDb)
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-export-media-'))
    try {
      await writeFile(join(uploadsDir, 'logo.png'), Buffer.from('fake-png-bytes'))
      await createMediaAsset(mediaDb, {
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

      const req = makeGetRequest('/admin/api/cms/export?includeMedia=1', mediaCookie)
      const res = await handleExportRoute(req, mediaDb, MAIN_SCOPE, { uploadsDir })
      const { bundle, entries } = await readExportArchive(res!)

      expect(bundle.media?.map((asset) => asset.id)).toEqual(['asset-logo'])
      expect(bundle.media?.[0]).not.toHaveProperty('bytesBase64')
      expect(entries['media/logo.png']).toEqual(new Uint8Array(Buffer.from('fake-png-bytes')))
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})

describe('handleExportRoute — GET ?includeSite=0', () => {
  test('site shell is absent', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeSite=0', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.site).toBeUndefined()
  })

  test('sourceSiteName is still set even when includeSite=0', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeSite=0', cookie)
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.sourceSiteName).toBe('Transfer Test Site')
  })
})

describe('handleExportRoute — POST { tables: ["pages"], includeSite: false }', () => {
  test('returns only the pages table', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages' }],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('pages')
  })

  test('returns only the 1 pages row', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages' }],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.rows.length).toBe(1)
    expect(bundle.rows[0].tableId).toBe('pages')
    expect(bundle.rows[0].id).toBe(pageId)
  })

  test('site is absent when includeSite: false', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages' }],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.site).toBeUndefined()
  })
})

describe('handleExportRoute — POST { tables: [{ tableId: "pages", rowIds: [bogusId] }] }', () => {
  test('returns empty rows when the row subset matches nothing', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages', rowIds: ['completely-bogus-row-id-that-does-not-exist'] }],
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    expect(bundle.rows.length).toBe(0)
  })

  test('still includes the selected table structure (a subset keeps its table)', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages', rowIds: ['completely-bogus-row-id-that-does-not-exist'] }],
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    const { bundle } = await readExportArchive(res!)

    // New model: a table named in `tables` is exported (its structure) even
    // when its row subset is empty — only tables NOT listed are dropped.
    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('pages')
  })
})

describe('handleExportRoute — auth', () => {
  test('returns 401 when no session cookie', async () => {
    // Deliberately no cookie set
    const req = new Request('http://localhost/admin/api/cms/export', { method: 'GET' })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    expect(res!.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Estimate endpoint — must equal the real download size exactly, because both
// run the same selection logic. The estimate just skips reading media bytes
// and sizes them analytically (Base64 length) instead.
// ---------------------------------------------------------------------------

async function estimateBytes(path: string, body: unknown, cookieStr: string, opts?: { uploadsDir?: string }): Promise<number> {
  const res = await handleExportRoute(makePostRequest(path, cookieStr, body), db, MAIN_SCOPE, opts)
  expect(res!.status).toBe(200)
  const parsed = JSON.parse(await res!.text()) as { bytes: number }
  return parsed.bytes
}

describe('handleExportRoute — POST /export/estimate', () => {
  test('estimate equals the real download byte length exactly (no media)', async () => {
    const dl = await handleExportRoute(makePostRequest('/admin/api/cms/export', cookie, {}), db, MAIN_SCOPE)
    const realBytes = (await dl!.arrayBuffer()).byteLength

    const bytes = await estimateBytes('/admin/api/cms/export/estimate', {}, cookie)
    expect(bytes).toBe(realBytes)
  })

  test('estimate drops the shell cost when includeSite is false, still matching the real download', async () => {
    const withSite = await estimateBytes('/admin/api/cms/export/estimate', { includeSite: true }, cookie)
    const withoutSite = await estimateBytes('/admin/api/cms/export/estimate', { includeSite: false }, cookie)
    expect(withoutSite).toBeLessThan(withSite)

    const realNoSite = await handleExportRoute(
      makePostRequest('/admin/api/cms/export', cookie, { includeSite: false }),
      db,
      MAIN_SCOPE,
    )
    expect(withoutSite).toBe((await realNoSite!.arrayBuffer()).byteLength)
  })

  test('requires a session (401 without a cookie)', async () => {
    const req = new Request('http://localhost/admin/api/cms/export/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const res = await handleExportRoute(req, db, MAIN_SCOPE)
    expect(res!.status).toBe(401)
  })
})

describe('handleExportRoute — POST /export/estimate with embedded media', () => {
  test('estimate equals the real zip byte length exactly, including media file entries', async () => {
    const mediaDb = createSqliteClient(':memory:')
    await runMigrations(mediaDb, sqliteMigrations)
    const mediaCookie = await seedAuth(mediaDb)

    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-export-estimate-'))
    try {
      // Seed one media asset whose bytes live on disk. 5000 raw bytes → a
      // Base64 payload that isn't a clean multiple of 3 (exercises padding).
      const fileBytes = Buffer.alloc(5000, 7)
      await writeFile(join(uploadsDir, 'seed.bin'), fileBytes)
      await createMediaAsset(mediaDb, {
        id: 'asset-1',
        filename: 'seed.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: fileBytes.length,
        storagePath: 'seed.bin',
        publicPath: '/uploads/seed.bin',
        uploadedByUserId: null,
        storageAdapterId: '',
        externallyHosted: false,
      })

      const dl = await handleExportRoute(
        makePostRequest('/admin/api/cms/export', mediaCookie, { includeMedia: true }),
        mediaDb,
        MAIN_SCOPE,
        { uploadsDir },
      )
      const realBytes = (await dl!.arrayBuffer()).byteLength

      const estRes = await handleExportRoute(
        makePostRequest('/admin/api/cms/export/estimate', mediaCookie, { includeMedia: true }),
        mediaDb,
        MAIN_SCOPE,
        { uploadsDir },
      )
      const { bytes } = JSON.parse(await estRes!.text()) as { bytes: number }

      expect(bytes).toBe(realBytes)
      // Sanity: media actually contributes as an archive entry.
      expect(bytes).toBeGreaterThan(5000)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
