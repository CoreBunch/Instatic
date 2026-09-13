import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleServerRequest } from '../../../server/router'
import type { DbClient, DbResult } from '../../../server/db'
import {
  prepareInactiveSlot,
  writeArtefact,
  swapSlot,
} from '../../../server/publish/staticArtefact'

interface FakeDbCounts {
  site: number
  owners: number
}

function makeFakeDb(counts: FakeDbCounts = { site: 0, owners: 0 }): DbClient {
  const handle = async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.toLowerCase()
    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: counts.site } as Row], rowCount: 1 }
    }
    if (normalized.includes('from users') && normalized.includes('role_id')) {
      return { rows: [{ count: counts.owners } as Row], rowCount: 1 }
    }
    // Catch-all: unknown queries (e.g. publishRepository.getPublishedPageBySlug) return empty
    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

describe('server router', () => {
  it('serves health checks', async () => {
    const res = await handleServerRequest(new Request('http://localhost/health'), { db: makeFakeDb() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok' })
  })

  it('routes cms setup status', async () => {
    const res = await handleServerRequest(new Request('http://localhost/admin/api/cms/setup/status'), { db: makeFakeDb() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ needsSetup: true })
  })

  it('redirects unmatched public routes to /admin on a fresh install', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/'),
      { db: makeFakeDb({ site: 0, owners: 0 }) },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin')
  })

  it('returns 404 for unknown routes once setup is complete', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/nope'),
      { db: makeFakeDb({ site: 1, owners: 1 }) },
    )
    expect(res.status).toBe(404)
  })

  it('explains where the admin UI lives when /admin is hit on the cms port without a build', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin'),
      { db: makeFakeDb() },
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('http://localhost:5173/admin')
  })
})

describe('server router — Layer A disk artefact fast-path', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'router-disk-test-'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('serves a baked disk artefact without a DB snapshot lookup', async () => {
    // Bake an artefact for /about
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html><body>Baked about</body></html>')
    await swapSlot(uploadsDir, slot)

    // DB that tracks snapshot lookups — should never be called for a disk hit
    let snapshotQueried = false
    const db = makeFakeDb({ site: 1, owners: 1 })
    const originalHandle = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<DbResult>
    const trackingDb = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]): Promise<DbResult> => {
        const sql = strings.reduce<string>((acc, s, i) => (i === 0 ? s : `${acc}$${i}${s}`), '')
        if (sql.toLowerCase().includes('site_snapshots')) snapshotQueried = true
        return originalHandle(strings, ...values)
      },
      { transaction: db.transaction, unsafe: db.unsafe },
    ) as DbClient

    const res = await handleServerRequest(
      new Request('http://localhost/about'),
      { db: trackingDb, uploadsDir },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Baked about')
    expect(snapshotQueried).toBe(false)
  })

  it('falls through to the resolver when the URL has a render-affecting (loop pagination) query', async () => {
    // Bake an artefact for /about
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html><body>Baked about</body></html>')
    await swapSlot(uploadsDir, slot)

    // A loop-pagination query affects rendering, so the disk path is skipped
    // (junk queries instead serve the baked artefact — ISS-032).
    const res = await handleServerRequest(
      new Request('http://localhost/about?loop_x_page=2'),
      { db: makeFakeDb({ site: 1, owners: 1 }), uploadsDir },
    )

    // The DB has no snapshot → resolvePublicRoute returns not-found → 404
    // (not the baked content)
    expect(res.status).toBe(404)
  })

  it('falls through to the resolver when no artefact exists for the URL', async () => {
    // uploadsDir exists but has no artefact for /contact
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html>about</html>')
    await swapSlot(uploadsDir, slot)

    const res = await handleServerRequest(
      new Request('http://localhost/contact'),
      { db: makeFakeDb({ site: 1, owners: 1 }), uploadsDir },
    )

    // No DB snapshot → 404
    expect(res.status).toBe(404)
  })
})

/**
 * RFC 9110 §9.3.2 — HEAD is identical to GET except that the server must not
 * send content. Every route below the dispatcher gates on `GET`, so an
 * un-normalised HEAD used to fall past all of them to the terminal JSON 404:
 * uptime monitors and link checkers probe with HEAD and concluded a healthy
 * published site was gone. See issue #306.
 */
describe('server router — HEAD is GET minus the body', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'router-head-test-'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('answers HEAD on a published page with the same status and content-type as GET', async () => {
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/kontakt', '<html><body>Kontakt</body></html>')
    await swapSlot(uploadsDir, slot)

    const runtime = { db: makeFakeDb({ site: 1, owners: 1 }), uploadsDir }
    const get = await handleServerRequest(new Request('http://localhost/kontakt'), runtime)
    const head = await handleServerRequest(
      new Request('http://localhost/kontakt', { method: 'HEAD' }),
      runtime,
    )

    expect(get.status).toBe(200)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
  })

  it('answers HEAD with the setup redirect on a fresh install, like GET', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/', { method: 'HEAD' }),
      { db: makeFakeDb({ site: 0, owners: 0 }) },
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin')
  })

  it('answers HEAD on a JSON API route like GET instead of 405', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin/api/cms/setup/status', { method: 'HEAD' }),
      { db: makeFakeDb() },
    )

    expect(res.status).toBe(200)
  })

  it('still rejects a method that GET-only routes genuinely do not support', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin/api/cms/setup/status', { method: 'DELETE' }),
      { db: makeFakeDb() },
    )

    expect(res.status).not.toBe(200)
  })
})
