import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import {
  createMediaAsset,
  deleteMediaAsset,
  listMediaAssets,
  renameMediaAsset,
} from '../../../server/repositories/media'
import { mediaStorageRegistry } from '../../../src/core/plugins/mediaStorageRegistry'

// Real, sharp-decodable PNG / JPEG bytes used as upload fixtures. The upload
// pipeline runs `processImageVariants` (sharp) on any sniffed image MIME, so
// passing raw magic-byte prefixes would trigger `Input buffer has corrupt
// header` warnings in test output. A tiny (4x4) valid image keeps the test
// fast while exercising the real metadata + BlurHash path. The image is
// smaller than every TARGET_WIDTHS entry (64+), so no on-disk variant files
// are written — only `setMediaAssetVariants` (dimensions + BlurHash) runs.
const PNG_BYTES = new Uint8Array(
  await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } },
  }).png().toBuffer(),
)
const JPEG_BYTES = new Uint8Array(
  await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).jpeg().toBuffer(),
)

function pngFile(name: string): File {
  return new File([PNG_BYTES], name, { type: 'image/png' })
}

/**
 * Build a row that mimics what the real `media_assets` table returns after
 * the M2 migrations (alt_text / tags_json / deleted_at / ...). Used by the
 * fake DB so the repository's SELECTs produce the full shape.
 */
function mediaRow(input: Record<string, unknown>): Record<string, unknown> {
  return {
    alt_text: '',
    caption: '',
    title: '',
    tags_json: [],
    width: null,
    height: null,
    duration_ms: null,
    dominant_color: null,
    deleted_at: null,
    replaced_at: null,
    blur_hash: null,
    variants_json: [],
    poster_path: null,
    storage_adapter_id: '',
    externally_hosted: false,
    ...input,
  }
}

function makeFakeDb() {
  const admins: Record<string, unknown>[] = [
    {
      id: 'admin_1',
      email: 'owner@example.com',
      password_hash: 'hash',
      created_at: new Date('2026-01-01').toISOString(),
    },
  ]
  const sessions: Record<string, unknown>[] = []
  const media: Record<string, unknown>[] = []

  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      const admin = admins.find((a) => a.id === session.user_id)
      return {
        rows: admin ? [{
          ...admin,
          email_normalized: admin.email,
          display_name: 'Owner',
          status: 'active',
          role_id: 'owner',
          last_login_at: null,
          updated_at: admin.created_at,
          deleted_at: null,
          role_slug: 'owner',
          role_name: 'Owner',
          role_description: '',
          role_is_system: true,
          role_capabilities_json: ['media.read', 'media.write', 'media.replace', 'media.delete'],
        } as Row] : [],
        rowCount: admin ? 1 : 0,
      }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }

    // Folder membership lookup — `loadFolderIdsForAssets` issues a single
    // batched `… from media_asset_folders where asset_id in (…)` during
    // list/get/update paths. None of the assets in this suite are assigned to
    // a folder; return an empty result set.
    if (normalized.includes('from media_asset_folders')) {
      return { rows: [], rowCount: 0 }
    }

    // Media storage adapter election lookup — `getElectedAdapterId` issues
    // this for every upload to resolve which adapter handles the role. The
    // fake DB always returns no rows, which the helper resolves as `''`
    // (the built-in local-disk adapter).
    if (normalized.includes('from active_media_storage_adapter')) {
      return { rows: [], rowCount: 0 }
    }
    // Variant delegate election — `getElectedVariantDelegate` issues this
    // for every image upload to decide between the local sharp ladder and
    // a delegate's URL template. No delegate is elected in these tests, so
    // the empty result lands the pipeline on the local sharp ladder.
    if (normalized.includes('from active_media_variant_delegate')) {
      return { rows: [], rowCount: 0 }
    }

    // createMediaAsset — values[0..9] = id, filename, mimeType, sizeBytes,
    // storagePath, publicPath, uploadedByUserId, storageAdapterId,
    // externallyHosted, altText. The fake DB router matches before
    // importMediaAsset because importMediaAsset's column list is much longer.
    if (normalized.includes('insert into media_assets') && values.length === 10) {
      const row = mediaRow({
        id: values[0],
        filename: values[1],
        mime_type: values[2],
        size_bytes: values[3],
        storage_path: values[4],
        public_path: values[5],
        uploaded_by_user_id: values[6],
        storage_adapter_id: values[7],
        externally_hosted: values[8],
        alt_text: values[9],
        created_at: new Date('2026-01-03').toISOString(),
      })
      media.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }

    // getMediaAsset — single-row SELECT scoped by id. Matched BEFORE the
    // listMediaAssets branch because the column prefix substring overlaps.
    if (normalized.includes('select id, filename, mime_type') && normalized.includes('where id =')) {
      const row = media.find((asset) => asset.id === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }

    // listMediaAssets — active path (deleted_at is null) and trash path
    // (deleted_at is not null) share the same SELECT column prefix.
    if (normalized.includes('select id, filename, mime_type')) {
      const wantsTrash = normalized.includes('deleted_at is not null')
      const filtered = media.filter((asset) => Boolean(asset.deleted_at) === wantsTrash)
      return { rows: [...filtered].reverse() as Row[], rowCount: filtered.length }
    }

    // updateMediaAssetMetadata — COALESCE update with field order:
    // filename, alt_text, caption, title, tags_json, id
    // MUST be matched BEFORE the bare rename branch below — the prefixes
    // overlap and `startsWith` would otherwise route here incorrectly.
    if (normalized.startsWith('update media_assets set filename = coalesce')) {
      const row = media.find((asset) => asset.id === values[5])
      if (!row) return { rows: [], rowCount: 0 }
      if (values[0] !== null) row.filename = values[0]
      if (values[1] !== null) row.alt_text = values[1]
      if (values[2] !== null) row.caption = values[2]
      if (values[3] !== null) row.title = values[3]
      if (values[4] !== null) row.tags_json = values[4]
      return { rows: [row as Row], rowCount: 1 }
    }

    // renameMediaAsset — values[0] = filename, values[1] = id
    if (normalized.startsWith('update media_assets set filename =')) {
      const row = media.find((asset) => asset.id === values[1])
      if (!row) return { rows: [], rowCount: 0 }
      row.filename = values[0]
      return { rows: [row as Row], rowCount: 1 }
    }

    // setMediaAssetVariants — stamps responsive-pipeline output:
    // width, height, blur_hash, variants_json, id (values[0..4])
    if (normalized.startsWith('update media_assets set width =')) {
      const row = media.find((asset) => asset.id === values[4])
      if (!row) return { rows: [], rowCount: 0 }
      row.width = values[0]
      row.height = values[1]
      row.blur_hash = values[2]
      row.variants_json = values[3]
      return { rows: [row as Row], rowCount: 1 }
    }

    // softDeleteMediaAsset — values[0] = deletedAt timestamp, values[1] = id
    if (normalized.startsWith('update media_assets set deleted_at')) {
      // Two branches share this prefix: the soft-delete (sets a timestamp)
      // and the restore (clears it back to null). Disambiguate via values.
      const isRestore = values[0] === null || values.length === 1
      if (isRestore) {
        const row = media.find((asset) => asset.id === values[0])
        if (!row) return { rows: [], rowCount: 0 }
        row.deleted_at = null
        return { rows: [row as Row], rowCount: 1 }
      }
      const row = media.find((asset) => asset.id === values[1])
      if (!row) return { rows: [], rowCount: 0 }
      row.deleted_at = values[0]
      return { rows: [row as Row], rowCount: 1 }
    }

    // getMediaAssetStoragePath — bare storage_path lookup used by the purge
    // flow to find the file to remove.
    if (normalized.startsWith('select storage_path from media_assets')) {
      const row = media.find((asset) => asset.id === values[0])
      return { rows: row ? [{ storage_path: row.storage_path } as Row] : [], rowCount: row ? 1 : 0 }
    }

    // deleteMediaAsset — values[0] = id, returns storage_path
    if (normalized.startsWith('delete from media_assets')) {
      const index = media.findIndex((asset) => asset.id === values[0])
      if (index === -1) return { rows: [], rowCount: 0 }
      const [row] = media.splice(index, 1)
      return { rows: [row as Row], rowCount: 1 }
    }

    throw new Error(`Unhandled SQL: ${sql}`)
  }

  // users + sessions repositories issue their hydrating SELECTs through
  // db.unsafe(rawSql, params); re-dispatch them through the tagged-template
  // matcher by splitting the raw SQL on its positional placeholders.
  handle.unsafe = async <Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> =>
    handle<Row>(sql.split(/\$\d+|\?/) as unknown as TemplateStringsArray, ...params)
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return Object.assign(handle as DbClient, { admins, sessions, media })
}

async function createCookie(db: ReturnType<typeof makeFakeDb>): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

function cmsRequest(
  url: string,
  init: { method?: string; formData?: FormData; headers?: Record<string, string>; body?: string } = {},
): Request {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: init.method ?? 'GET',
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
    async formData() {
      return init.formData ?? new FormData()
    },
    async json() {
      return init.body ? JSON.parse(init.body) : {}
    },
  } as Request
}

describe('CMS media repository', () => {
  it('stores and lists media asset metadata newest-first', async () => {
    const db = makeFakeDb()

    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })

    const assets = await listMediaAssets(db)

    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      altText: '',
      tags: [],
      folderIds: [],
      deletedAt: null,
    })
  })

  it('renames media asset metadata', async () => {
    const db = makeFakeDb()

    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })

    const asset = await renameMediaAsset(db, 'asset_1', 'Hero renamed.png')

    expect(asset?.filename).toBe('Hero renamed.png')
    expect(db.media[0].filename).toBe('Hero renamed.png')
  })

  it('hard-deletes media asset metadata and returns its storage path', async () => {
    const db = makeFakeDb()

    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })

    const deleted = await deleteMediaAsset(db, 'asset_1')

    expect(deleted?.storagePath).toBe('asset_1-hero.png')
    expect(db.media).toHaveLength(0)
  })
})

describe('CMS media handlers', () => {
  it('requires an admin session for media listing', async () => {
    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/media'),
      makeFakeDb(),
    )

    expect(res.status).toBe(401)
  })

  it('uploads image files to disk and stores metadata for authenticated admins', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    const body = new FormData()
    body.set('file', pngFile('Hero Image.png'))

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media', {
          method: 'POST',
          headers: { cookie },
          formData: body,
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(201)
      const payload = await res.json() as {
        asset: { filename: string; publicPath: string; mimeType: string; uploadedByUserId: string }
      }
      expect(payload.asset).toMatchObject({
        filename: 'Hero Image.png',
        mimeType: 'image/png',
        uploadedByUserId: 'admin_1',
      })
      expect(payload.asset.publicPath).toStartWith('/uploads/')
      expect(db.media).toHaveLength(1)
      // The on-disk extension is server-chosen (`.png`), not user-supplied —
      // the original filename's extension is irrelevant once stripped.
      expect(extname(String(db.media[0].storage_path))).toBe('.png')
      expect(new Uint8Array(await readFile(join(uploadsDir, String(db.media[0].storage_path))))).toEqual(PNG_BYTES)
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  // F-0002 regression: stored XSS via spoofed Content-Type was the entry
   it('stores the alt text sent with the upload on the new asset row (#411)', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    const body = new FormData()
    body.set('file', pngFile('hero.png'))
    body.set('altText', 'Team photo in the Berlin office')

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media', {
          method: 'POST',
          headers: { cookie },
          formData: body,
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(201)
      const payload = await res.json() as { asset: { altText: string } }
      expect(payload.asset.altText).toBe('Team photo in the Berlin office')
      expect(db.media[0].alt_text).toBe('Team photo in the Berlin office')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

 // point. The upload handler MUST reject any file whose actual bytes do
  // not match an accepted image/video signature, regardless of what the
  // client claimed in the multipart `Content-Type` header.
  it('rejects an HTML payload that lies about its Content-Type as image/png (F-0002)', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    const body = new FormData()
    // Attacker plants `<script>` HTML but sets the multipart Content-Type
    // to `image/png`. Old code accepted this and wrote `pwn.html` to disk.
    body.set(
      'file',
      new File(['<!doctype html><script>alert(1)</script>'], 'pwn.html', { type: 'image/png' }),
    )

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media', {
          method: 'POST',
          headers: { cookie },
          formData: body,
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('JPEG'),
      })
      expect(db.media).toHaveLength(0)
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  // F-0002 regression: even when the bytes ARE valid (e.g. a real PNG), the
  // user-supplied filename extension must not survive — otherwise an
  // attacker could plant `pwn.html` filename containing real PNG bytes
  // (still gets `text/html` from the static handler's extension lookup) or
  // vary other tricks. The on-disk filename extension MUST be server-chosen.
  it('strips the user-supplied filename extension and uses a server-chosen one (F-0002)', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    const body = new FormData()
    // Real PNG bytes, but the filename claims `.html`. Server must rename
    // it to `.png` (the magic-byte-derived extension) on disk.
    body.set('file', new File([PNG_BYTES], 'pwn.html', { type: 'image/png' }))

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media', {
          method: 'POST',
          headers: { cookie },
          formData: body,
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(201)
      expect(db.media).toHaveLength(1)
      const storagePath = String(db.media[0].storage_path)
      expect(extname(storagePath)).toBe('.png')
      expect(storagePath.endsWith('.html')).toBe(false)
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('accepts an SVG upload but sanitises the script gadget out of the stored bytes', async () => {
    // SVG is now an accepted media type (fonts + SVG were added so static-site
    // imports keep their iconography). The security boundary moved from
    // "reject all SVG" to "sanitise via DOMPurify before persistence": the
    // upload succeeds, but the stored bytes have the <script> stripped.
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    const body = new FormData()
    const originalConsoleError = console.error
    const loggedErrors = mock(() => {})
    console.error = loggedErrors as typeof console.error
    body.set(
      'file',
      new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><script>alert(1)</script><rect width="10" height="10"/></svg>'],
        'logo.svg',
        { type: 'image/svg+xml' },
      ),
    )

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media', {
          method: 'POST',
          headers: { cookie },
          formData: body,
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(201)
      expect(db.media).toHaveLength(1)
      expect(extname(String(db.media[0].storage_path))).toBe('.svg')

      // The stored file on disk must NOT contain the script gadget.
      const storagePath = String(db.media[0].storage_path)
      const onDisk = readFileSync(join(uploadsDir, storagePath), 'utf8')
      expect(onDisk).not.toContain('<script')
      expect(onDisk).not.toContain('alert(1)')
      // The benign geometry survives.
      expect(onDisk.toLowerCase()).toContain('rect')
      expect(
        loggedErrors.mock.calls.some(([prefix]) => String(prefix).startsWith('[mediaVariants]')),
      ).toBe(false)
    } finally {
      console.error = originalConsoleError
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('accepts a JPEG when bytes match the JPEG signature', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    const body = new FormData()
    body.set('file', new File([JPEG_BYTES], 'photo.jpg', { type: 'image/jpeg' }))

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media', {
          method: 'POST',
          headers: { cookie },
          formData: body,
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(201)
      expect(db.media).toHaveLength(1)
      expect(db.media[0].mime_type).toBe('image/jpeg')
      expect(extname(String(db.media[0].storage_path))).toBe('.jpg')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('lists uploaded media assets for authenticated admins', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })

    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/media', {
        headers: { cookie },
      }),
      db,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      assets: [{ filename: 'hero.png', publicPath: '/uploads/asset_1-hero.png' }],
    })
  })

  it('renames uploaded media assets for authenticated admins', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })

    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/media/asset_1', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'Hero renamed.png' }),
      }),
      db,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      asset: { filename: 'Hero renamed.png', publicPath: '/uploads/asset_1-hero.png' },
    })
  })

  it('soft-deletes uploaded media assets and keeps their file on disk', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })
    await writeFile(join(uploadsDir, 'asset_1-hero.png'), 'image-bytes')

    try {
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media/asset_1', {
          method: 'DELETE',
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )

      expect(res.status).toBe(200)
      const payload = await res.json() as { asset: { deletedAt: string | null } }
      // Soft delete stamps `deleted_at` and returns the row.
      expect(payload.asset.deletedAt).toBeTruthy()
      // Row stays in the table; file stays on disk until ?purge=1.
      expect(db.media).toHaveLength(1)
      await expect(readFile(join(uploadsDir, 'asset_1-hero.png'), 'utf-8')).resolves.toBe('image-bytes')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('purges soft-deleted media assets and removes their stored file', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
    await createMediaAsset(db, {
      id: 'asset_1',
      filename: 'hero.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'asset_1-hero.png',
      publicPath: '/uploads/asset_1-hero.png',
      uploadedByUserId: 'user_1',
      storageAdapterId: '',
      externallyHosted: false,
    })
    await writeFile(join(uploadsDir, 'asset_1-hero.png'), 'image-bytes')

    try {
      // Soft delete first — the purge endpoint requires it (no one-click bypass).
      const soft = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media/asset_1', {
          method: 'DELETE',
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(soft.status).toBe(200)

      const purge = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/media/asset_1?purge=1', {
          method: 'DELETE',
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )

      expect(purge.status).toBe(200)
      expect(await purge.json()).toEqual({ ok: true })
      expect(db.media).toHaveLength(0)
      await expect(readFile(join(uploadsDir, 'asset_1-hero.png'), 'utf-8')).rejects.toThrow()
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })
})
