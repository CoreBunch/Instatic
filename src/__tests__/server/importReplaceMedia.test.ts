/**
 * `replace` import and the media library.
 *
 * `replace` is wipe-and-recreate: when the import carries the media category,
 * the previous site's media rows AND bytes go, so a second site that ships a
 * file at the same storage path (two sites that embed the same font file)
 * imports cleanly instead of failing on `media_assets.public_path`. Rows are
 * deleted inside the import transaction; bytes only after it commits. Media
 * owned by records that survive a replace (user avatars, plugin-managed
 * media) and the library shared with other branches are left alone.
 *
 * Runs on SQLite by default and on Postgres with
 * `DB=postgres TEST_POSTGRES_URL=...` (see `createTestDb`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import type { DbClient } from '../../../server/db/client'
import { createUser, setUserAvatarMediaId } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import { createMediaAsset, getMediaAsset, listMediaAssets } from '../../../server/repositories/media'
import { insertBranch } from '../../../server/repositories/branches'
import { handleImportArchiveRoute } from '../../../server/handlers/cms/importArchive'
import { handleImportRoute } from '../../../server/handlers/cms/import'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { BUNDLE_ARCHIVE_MANIFEST_PATH } from '@core/data/bundleArchive'
import { ImportResultSchema } from '@core/data/bundleSchema'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { SiteShell } from '@core/page-tree'
import { MAIN_SCOPE } from '../../../server/branches/scope'

const OWNER_ID = 'owner-replace-media'

const SEED_SHELL: SiteShell = {
  id: 'default',
  name: 'Replace Media Site',
  breakpoints: [],
  settings: { shortcuts: {} },
  styleRules: {},
  files: [],
  packageJson: { dependencies: {}, devDependencies: {} },
  runtime: {
    dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
    scripts: {},
  },
  createdAt: 0,
  updatedAt: 0,
}

/** The seeded shell as the server normalizes it, which is what an export carries. */
let SHELL: SiteShell

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]

/** Magic bytes followed by a one-byte marker, so two files of one type differ. */
function bytesOf(magic: number[], marker: number): Uint8Array {
  return new Uint8Array([...magic, marker])
}

interface ArchiveMedia {
  id: string
  storagePath: string
  mimeType: string
  bytes: Uint8Array
  folderIds?: string[]
}

function mediaEntry(asset: ArchiveMedia) {
  return {
    id: asset.id,
    filename: asset.storagePath,
    mimeType: asset.mimeType,
    sizeBytes: asset.bytes.byteLength,
    altText: '',
    caption: '',
    title: '',
    tags: [],
    width: null,
    height: null,
    durationMs: null,
    dominantColor: null,
    blurHash: null,
    storagePath: asset.storagePath,
    posterPath: null,
    folderIds: asset.folderIds ?? [],
  }
}

function buildArchive(input: {
  media: ArchiveMedia[]
  includeSite?: boolean
  mediaFolders?: Array<{ id: string; parentId: string | null; name: string; slug: string; sortOrder: number }>
  redirects?: Array<{ id: string; tableId: string; fromRouteBase: string; fromSlug: string; targetRowId: string }>
}): Uint8Array {
  const manifest = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    ...(input.includeSite === false ? {} : { site: SHELL }),
    tables: [],
    rows: [],
    media: input.media.map(mediaEntry),
    ...(input.mediaFolders ? { mediaFolders: input.mediaFolders } : {}),
    ...(input.redirects ? { redirects: input.redirects } : {}),
  }
  const entries: Record<string, Uint8Array> = {
    [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
  }
  for (const asset of input.media) entries[`media/${asset.storagePath}`] = asset.bytes
  return zipSync(entries, { level: 0 })
}

async function seedOwner(db: DbClient): Promise<string> {
  await saveDraftSite(db, MAIN_SCOPE, SEED_SHELL)
  const normalized = await getDraftSite(db, MAIN_SCOPE)
  if (!normalized) throw new Error('seeded site shell did not load')
  SHELL = normalized
  await createUser(db, {
    id: OWNER_ID,
    email: 'owner@replace-media.test',
    displayName: 'Owner',
    passwordHash: 'placeholder-hash',
    roleId: 'owner',
    allowOwnerRole: true,
  })
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: OWNER_ID,
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
    // `replace` requires a fresh step-up; open the window directly.
    stepUpExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const FONT_PATH = 'inter-400.woff2'
const fontA = bytesOf(WOFF2_MAGIC, 0xa1)
const fontB = bytesOf(WOFF2_MAGIC, 0xb2)

/** Site A: a font plus a logo only site A ships. */
const SITE_A: ArchiveMedia[] = [
  { id: 'a-font', storagePath: FONT_PATH, mimeType: 'font/woff2', bytes: fontA, folderIds: ['folder-a'] },
  { id: 'a-logo', storagePath: 'logo-a.png', mimeType: 'image/png', bytes: bytesOf(PNG_MAGIC, 0xa2) },
]
const SITE_A_FOLDERS = [{ id: 'folder-a', parentId: null, name: 'Fonts', slug: 'fonts-a', sortOrder: 0 }]

/** Site B: a different asset id at the same storage path as site A's font. */
const SITE_B: ArchiveMedia[] = [
  { id: 'b-font', storagePath: FONT_PATH, mimeType: 'font/woff2', bytes: fontB },
]

describe('replace import removes the previous site media', () => {
  let testDb: TestDb
  let db: DbClient
  let uploadsDir: string
  let cookie: string

  async function importArchive(
    archive: Uint8Array,
    strategy: 'replace' | 'merge-add' | 'merge-overwrite' = 'replace',
  ): Promise<Response> {
    const req = new Request(`http://localhost/admin/api/cms/import/archive?strategy=${strategy}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: archive,
    })
    req.headers.set('cookie', cookie)
    const res = await handleImportArchiveRoute(req, db, MAIN_SCOPE, { uploadsDir })
    if (!res) throw new Error('archive import route did not handle the request')
    return res
  }

  async function mediaIds(): Promise<string[]> {
    const active = await listMediaAssets(db)
    const trashed = await listMediaAssets(db, { includeDeleted: true })
    return [...active, ...trashed].map((asset) => asset.id).sort()
  }

  async function membershipCount(): Promise<number> {
    const { rows } = await db<{ n: number | string }>`select count(*) as n from media_asset_folders`
    return Number(rows[0]?.n ?? 0)
  }

  beforeEach(async () => {
    testDb = await createTestDb()
    db = testDb.db
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-replace-media-'))
    // Old files are removed through the asset's pinned storage adapter,
    // exactly like a single hard delete; local disk is adapter ''.
    mediaStorageRegistry.__reset()
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    cookie = await seedOwner(db)
  })

  afterEach(async () => {
    mediaStorageRegistry.__reset()
    await testDb.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  test('a second site sharing a storage path imports and leaves only its own media', async () => {
    const first = await importArchive(buildArchive({ media: SITE_A, mediaFolders: SITE_A_FOLDERS }))
    expect(first.status).toBe(200)
    expect(await mediaIds()).toEqual(['a-font', 'a-logo'])
    expect(await membershipCount()).toBe(1)

    const second = await importArchive(buildArchive({ media: SITE_B }))
    expect(second.status).toBe(200)
    const result = parseValue(ImportResultSchema, await second.json())
    expect(result.mediaImported).toBe(1)

    expect(await mediaIds()).toEqual(['b-font'])
    expect((await getMediaAsset(db, 'b-font'))?.publicPath).toBe(`/uploads/${FONT_PATH}`)
    // Same storage path: the new bytes are on disk, not deleted after writing.
    expect(new Uint8Array(await readFile(join(uploadsDir, FONT_PATH)))).toEqual(fontB)
    // Site A's other file is gone from disk with its row.
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(false)
    // The folder join rows went with the asset rows.
    expect(await membershipCount()).toBe(0)
  })

  test('trashed media of the previous site is removed too', async () => {
    await importArchive(buildArchive({ media: SITE_A }))
    await db`update media_assets set deleted_at = ${new Date().toISOString()} where id = 'a-logo'`

    expect((await importArchive(buildArchive({ media: SITE_B }))).status).toBe(200)
    expect(await mediaIds()).toEqual(['b-font'])
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(false)
  })

  test('a replace that fails inside the transaction keeps the old media rows and files', async () => {
    await importArchive(buildArchive({ media: SITE_A }))

    // The redirect targets a row the bundle does not carry, so its insert
    // violates the foreign key after the media rows were deleted.
    const failing = buildArchive({
      media: SITE_B,
      redirects: [{ id: 'r1', tableId: 'posts', fromRouteBase: '/posts', fromSlug: 'gone', targetRowId: 'missing-row' }],
    })
    await expect(importArchive(failing)).rejects.toThrow()

    expect(await mediaIds()).toEqual(['a-font', 'a-logo'])
    expect(new Uint8Array(await readFile(join(uploadsDir, FONT_PATH)))).toEqual(fontA)
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(true)
  })

  test('the JSON import endpoint applies the same replace semantics', async () => {
    await importArchive(buildArchive({ media: SITE_A }))

    const bundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      site: SHELL,
      tables: [],
      rows: [],
      media: SITE_B.map((asset) => ({
        ...mediaEntry(asset),
        bytesBase64: Buffer.from(asset.bytes).toString('base64'),
      })),
    }
    const req = new Request('http://localhost/admin/api/cms/import?strategy=replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    req.headers.set('cookie', cookie)
    const res = await handleImportRoute(req, db, MAIN_SCOPE, { uploadsDir })
    expect(res?.status).toBe(200)
    expect(parseValue(ImportResultSchema, await res!.json()).mediaImported).toBe(1)

    expect(await mediaIds()).toEqual(['b-font'])
    expect(new Uint8Array(await readFile(join(uploadsDir, FONT_PATH)))).toEqual(fontB)
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(false)
  })

  test('a user avatar survives a replace with its file', async () => {
    await writeFile(join(uploadsDir, 'avatar.png'), bytesOf(PNG_MAGIC, 0x01))
    await createMediaAsset(db, {
      id: 'avatar',
      filename: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 9,
      storagePath: 'avatar.png',
      publicPath: '/uploads/avatar.png',
      uploadedByUserId: OWNER_ID,
      storageAdapterId: '',
      externallyHosted: false,
    })
    await setUserAvatarMediaId(db, OWNER_ID, 'avatar')
    await importArchive(buildArchive({ media: SITE_A }))

    expect((await importArchive(buildArchive({ media: SITE_B }))).status).toBe(200)
    expect(await mediaIds()).toEqual(['avatar', 'b-font'])
    expect(await fileExists(join(uploadsDir, 'avatar.png'))).toBe(true)
  })

  test('a replace without the media category keeps the library', async () => {
    await importArchive(buildArchive({ media: SITE_A }))
    const archive = zipSync({
      [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        site: SHELL,
        tables: [],
        rows: [],
      })),
    }, { level: 0 })

    expect((await importArchive(archive)).status).toBe(200)
    expect(await mediaIds()).toEqual(['a-font', 'a-logo'])
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(true)
  })

  test('a replace that keeps the local site shell keeps the media it may reference', async () => {
    await importArchive(buildArchive({ media: SITE_A }))

    expect((await importArchive(buildArchive({ media: [], includeSite: false }))).status).toBe(200)
    expect(await mediaIds()).toEqual(['a-font', 'a-logo'])
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(true)
  })

  test('a replace on main keeps the library while other branches share it', async () => {
    await importArchive(buildArchive({ media: SITE_A }))
    await insertBranch(db, { id: 'redesign', name: 'Redesign', baseBranchId: 'main', createdByUserId: OWNER_ID })

    expect((await importArchive(buildArchive({ media: [] }))).status).toBe(200)
    expect(await mediaIds()).toEqual(['a-font', 'a-logo'])
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(true)
  })

  test('merge-overwrite keeps local media the bundle does not carry', async () => {
    await importArchive(buildArchive({ media: SITE_A }))
    const res = await importArchive(
      buildArchive({ media: [{ id: 'b-logo', storagePath: 'logo-b.png', mimeType: 'image/png', bytes: bytesOf(PNG_MAGIC, 0xb3) }] }),
      'merge-overwrite',
    )
    expect(res.status).toBe(200)
    expect(await mediaIds()).toEqual(['a-font', 'a-logo', 'b-logo'])
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(true)
  })

  test('merge-add keeps local media the bundle does not carry', async () => {
    await importArchive(buildArchive({ media: SITE_A }))
    const res = await importArchive(
      buildArchive({ media: [{ id: 'b-logo', storagePath: 'logo-b.png', mimeType: 'image/png', bytes: bytesOf(PNG_MAGIC, 0xb3) }] }),
      'merge-add',
    )
    expect(res.status).toBe(200)
    expect(await mediaIds()).toEqual(['a-font', 'a-logo', 'b-logo'])
    expect(await fileExists(join(uploadsDir, 'logo-a.png'))).toBe(true)
  })
})
