/**
 * Architecture Gate — Site-transfer import strategies
 *
 * Verifies that `handleImportRoute` applies each strategy correctly:
 *
 *   replace         — wipe everything, insert all bundle rows.
 *   merge-add       — insert only new rows (skip collisions).
 *   merge-overwrite — upsert all rows (replace on collision, add new, keep local-only).
 *
 * Each strategy gets its own describe block with a fresh in-memory SQLite DB.
 * Auth is seeded directly via repositories.
 *
 * @see server/handlers/cms/import.ts
 * @see src/core/data/bundleSchema.ts
 * @see docs/plans/2026-05-19-site-transfer-ux.md
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { saveDraftSite, getDraftSite } from '../../../server/repositories/site'
import { createUser } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { createDataRow, listDataRows } from '../../../server/repositories/data/rows'
import { handleImportRoute } from '../../../server/handlers/cms/import'
import { parseValue } from '@core/utils/typeboxHelpers'
import { ImportResultSchema } from '@core/data/bundleSchema'
import { createDefaultSiteExplorerOrganization } from '@core/page-tree'
import type { DbClient } from '../../../server/db/client'
import type { SiteShell } from '@core/page-tree'
import type { DataRow, DataTable } from '@core/data/schemas'
import { MAIN_SCOPE } from '../../../server/branches/scope'

// ---------------------------------------------------------------------------
// Minimal valid site shell for seeding
// ---------------------------------------------------------------------------

const TEST_SHELL: SiteShell = {
  id: 'default',
  name: 'Import Test Site',
  breakpoints: [],
  settings: { shortcuts: {} },
  styleRules: {},
  explorer: createDefaultSiteExplorerOrganization(),
  files: [],
  packageJson: { dependencies: {}, devDependencies: {} },
  runtime: {
    dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
    scripts: {},
    styles: {},
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// A bundle-carried site shell with a distinct name so we can detect overwrites
const BUNDLE_SHELL: SiteShell = {
  ...TEST_SHELL,
  name: 'Bundle Site Name',
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
    email: 'owner@import.test',
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
    // Pre-open a step-up window — the `replace` strategy now requires
    // step-up (see G6 in the capabilities review). Tests skip the
    // dance by seeding the row directly.
    stepUpExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bundleTableEntry(id: string, name: string, kind: DataTable['kind'] = 'postType'): DataTable {
  const now = new Date().toISOString()
  return {
    id,
    name,
    slug: id,
    kind,
    singularLabel: name,
    pluralLabel: `${name}s`,
    routeBase: `/${id}`,
    primaryFieldId: 'title',
    fields: [],
    system: id === 'posts' || id === 'pages' || id === 'components',
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  }
}

function bundleRowEntry(
  id: string,
  tableId: string,
  slug: string = '',
  cellOverrides: Record<string, unknown> = {},
): DataRow {
  const now = new Date().toISOString()
  return {
    id,
    tableId,
    cells: { slug, ...cellOverrides },
    slug,
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

function makeImportRequest(
  cookie: string,
  strategy: 'replace' | 'merge-add' | 'merge-overwrite',
  bundle: unknown,
): Request {
  // The `cookie` header is a forbidden header per WHATWG Fetch spec and is
  // stripped by Bun's Request constructor in test mode. Set it after construction.
  const req = new Request(
    `http://localhost/admin/api/cms/import?strategy=${strategy}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    },
  )
  req.headers.set('cookie', cookie)
  return req
}

// ---------------------------------------------------------------------------
// Strategy: replace
// ---------------------------------------------------------------------------

describe('handleImportRoute — strategy: replace', () => {
  let db: DbClient
  let cookie: string
  let overlapId: string
  let localOnlyId: string

  beforeAll(async () => {
    db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
    cookie = await seedAuth(db)

    // Seed 2 local posts: one that OVERLAPS with the bundle (overlapId),
    // one that is LOCAL-ONLY (localOnlyId — should be deleted by replace)
    const overlap = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Local Overlap', slug: 'overlap' },
      slug: 'overlap',
    })
    const localOnly = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Local Only', slug: 'local-only' },
      slug: 'local-only',
    })
    overlapId = overlap.id
    localOnlyId = localOnly.id
  })

  test('all bundle rows are present after replace', async () => {
    const bundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      site: BUNDLE_SHELL,
      tables: [bundleTableEntry('posts', 'Posts')],
      rows: [
        bundleRowEntry(overlapId, 'posts', 'overlap', { title: 'Bundle Overlap' }),
        bundleRowEntry('bundle-new-a', 'posts', 'new-a', { title: 'New A' }),
        bundleRowEntry('bundle-new-b', 'posts', 'new-b', { title: 'New B' }),
      ],
    }

    const req = makeImportRequest(cookie, 'replace', bundle)
    const res = await handleImportRoute(req, db, MAIN_SCOPE)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const body = JSON.parse(await res!.text())
    const result = parseValue(ImportResultSchema, body)

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('replace')

    // Counters: 3 rows inserted (wipe-and-insert), 0 replaced, 0 skipped
    expect(result.rowsInserted).toBe(3)
    expect(result.rowsReplaced).toBe(0)
    expect(result.rowsSkipped).toBe(0)
  })

  test('local-only row is GONE after replace', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const ids = allRows.map((r) => r.id)
    expect(ids).not.toContain(localOnlyId)
  })

  test('bundle rows are present in the DB', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const ids = allRows.map((r) => r.id)
    expect(ids).toContain(overlapId)
    expect(ids).toContain('bundle-new-a')
    expect(ids).toContain('bundle-new-b')
  })

  test('overlap row has bundle cells after replace', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const overlap = allRows.find((r) => r.id === overlapId)
    expect(overlap).toBeDefined()
    expect(overlap!.cells['title']).toBe('Bundle Overlap')
  })

  test('site shell is overwritten from the bundle', async () => {
    const shell = await getDraftSite(db, MAIN_SCOPE)
    expect(shell).not.toBeNull()
    expect(shell!.name).toBe('Bundle Site Name')
  })
})

// ---------------------------------------------------------------------------
// Strategy: merge-add
// ---------------------------------------------------------------------------

describe('handleImportRoute — strategy: merge-add', () => {
  let db: DbClient
  let cookie: string
  let overlapId: string
  let localOnlyId: string

  beforeAll(async () => {
    db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
    cookie = await seedAuth(db)

    const overlap = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Local Overlap', slug: 'overlap' },
      slug: 'overlap',
    })
    const localOnly = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Local Only', slug: 'local-only' },
      slug: 'local-only',
    })
    overlapId = overlap.id
    localOnlyId = localOnly.id
  })

  test('response counters match merge-add semantics', async () => {
    const bundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      site: BUNDLE_SHELL,
      tables: [bundleTableEntry('posts', 'Posts')],
      rows: [
        // overlap row — already exists locally → skip
        bundleRowEntry(overlapId, 'posts', 'overlap', { title: 'Bundle Overlap' }),
        // 2 new rows → insert
        bundleRowEntry('merge-add-new-a', 'posts', 'ma-new-a'),
        bundleRowEntry('merge-add-new-b', 'posts', 'ma-new-b'),
      ],
    }

    const req = makeImportRequest(cookie, 'merge-add', bundle)
    const res = await handleImportRoute(req, db, MAIN_SCOPE)
    const body = JSON.parse(await res!.text())
    const result = parseValue(ImportResultSchema, body)

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('merge-add')
    expect(result.rowsInserted).toBe(2)   // the 2 new rows
    expect(result.rowsSkipped).toBe(1)    // the overlap row
    expect(result.rowsReplaced).toBe(0)   // merge-add never replaces
  })

  test('local-only row is still present after merge-add (untouched)', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const ids = allRows.map((r) => r.id)
    expect(ids).toContain(localOnlyId)
  })

  test('new bundle rows are added', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const ids = allRows.map((r) => r.id)
    expect(ids).toContain('merge-add-new-a')
    expect(ids).toContain('merge-add-new-b')
  })

  test('overlapping row cells are NOT overwritten (local version preserved)', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const overlap = allRows.find((r) => r.id === overlapId)
    expect(overlap).toBeDefined()
    // Local version kept — bundle version skipped
    expect(overlap!.cells['title']).toBe('Local Overlap')
  })

  test('site shell is NOT overwritten by merge-add', async () => {
    const shell = await getDraftSite(db, MAIN_SCOPE)
    expect(shell).not.toBeNull()
    // Local shell name, not the bundle's shell name
    expect(shell!.name).toBe('Import Test Site')
  })
})

// ---------------------------------------------------------------------------
// Strategy: merge-overwrite
// ---------------------------------------------------------------------------

describe('handleImportRoute — strategy: merge-overwrite', () => {
  let db: DbClient
  let cookie: string
  let overlapId: string
  let localOnlyId: string

  beforeAll(async () => {
    db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
    cookie = await seedAuth(db)

    const overlap = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Local Overlap', slug: 'overlap' },
      slug: 'overlap',
    })
    const localOnly = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Local Only', slug: 'local-only' },
      slug: 'local-only',
    })
    overlapId = overlap.id
    localOnlyId = localOnly.id
  })

  test('response counters match merge-overwrite semantics', async () => {
    const bundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      site: BUNDLE_SHELL,
      tables: [bundleTableEntry('posts', 'Posts')],
      rows: [
        // overlap row — exists locally → replace
        bundleRowEntry(overlapId, 'posts', 'overlap', { title: 'Bundle Overlap' }),
        // 2 new rows → insert
        bundleRowEntry('mo-new-a', 'posts', 'mo-new-a'),
        bundleRowEntry('mo-new-b', 'posts', 'mo-new-b'),
      ],
    }

    const req = makeImportRequest(cookie, 'merge-overwrite', bundle)
    const res = await handleImportRoute(req, db, MAIN_SCOPE)
    const body = JSON.parse(await res!.text())
    const result = parseValue(ImportResultSchema, body)

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('merge-overwrite')
    expect(result.rowsReplaced).toBe(1)   // the overlap row was overwritten
    expect(result.rowsInserted).toBe(2)   // the 2 new rows
    expect(result.rowsSkipped).toBe(0)    // merge-overwrite never skips
  })

  test('local-only row is still present after merge-overwrite (untouched)', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const ids = allRows.map((r) => r.id)
    expect(ids).toContain(localOnlyId)
  })

  test('new bundle rows are added', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const ids = allRows.map((r) => r.id)
    expect(ids).toContain('mo-new-a')
    expect(ids).toContain('mo-new-b')
  })

  test('overlapping row cells ARE overwritten (bundle version wins)', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const overlap = allRows.find((r) => r.id === overlapId)
    expect(overlap).toBeDefined()
    // Bundle version now present
    expect(overlap!.cells['title']).toBe('Bundle Overlap')
  })

  test('local-only row cells are unchanged after merge-overwrite', async () => {
    const allRows = await listDataRows(db, MAIN_SCOPE, 'posts')
    const localOnly = allRows.find((r) => r.id === localOnlyId)
    expect(localOnly).toBeDefined()
    expect(localOnly!.cells['title']).toBe('Local Only')
  })

  test('site shell IS overwritten by merge-overwrite when bundle has one', async () => {
    const shell = await getDraftSite(db, MAIN_SCOPE)
    expect(shell).not.toBeNull()
    expect(shell!.name).toBe('Bundle Site Name')
  })
})

// ---------------------------------------------------------------------------
// Bad strategy parameter
// ---------------------------------------------------------------------------

describe('handleImportRoute — invalid strategy', () => {
  test('returns 400 for unrecognized strategy', async () => {
    const db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
    const cookie = await seedAuth(db)

    const bundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), tables: [], rows: [] }
    const req = new Request('http://localhost/admin/api/cms/import?strategy=wipe-everything', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    req.headers.set('cookie', cookie)
    const res = await handleImportRoute(req, db, MAIN_SCOPE)
    expect(res!.status).toBe(400)
  })
})

describe('handleImportRoute — auth', () => {
  test('returns 401 when no session cookie', async () => {
    const db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
    await seedAuth(db)

    const bundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), tables: [], rows: [] }
    // Deliberately no cookie set on this request
    const req = new Request('http://localhost/admin/api/cms/import?strategy=replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    const res = await handleImportRoute(req, db, MAIN_SCOPE)
    expect(res!.status).toBe(401)
  })
})
