import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublishingTestDb, cleanupPublishingTestDbs, seedPublishingPage } from '../helpers/publishingTestDb'
import { createUser } from '../../../server/repositories/users'
import { makeSite, makePage } from '../publisher/helpers'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { markPublishedArtefactsCurrent, getPublishVersion } from '../../../server/publish/publishState'
import { getPublishedRouteInventoryForVersion } from '../../../server/publish/publishedRoutes'
import { resetForTests } from '../../../server/publish/renderCache'
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

async function makeDb(counts: FakeDbCounts = { site: 0, owners: 0 }): Promise<DbClient> {
  const db = await createPublishingTestDb(counts.site ? makeSite() : null, false)
  if (counts.owners) await createUser(db, { email: 'router@local.test', displayName: 'Owner', passwordHash: 'unused-test-hash', roleId: 'owner', allowOwnerRole: true })
  return db
}

async function publishRoute(db: DbClient, slug: string): Promise<void> {
  await seedPublishingPage(db, { ...makePage({ root: { moduleId: 'base.body' } }), id: slug, slug })
  await publishDraftSite(db, null, undefined, { variants: [{ rowId: slug, localeId: 'default' }] })
  markPublishedArtefactsCurrent(getPublishVersion())
}

beforeEach(() => resetForTests())
afterEach(cleanupPublishingTestDbs)

describe('server router', () => {
  it('serves health checks', async () => {
    const res = await handleServerRequest(new Request('http://localhost/health'), { db: await makeDb() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok' })
  })

  it('routes cms setup status', async () => {
    const res = await handleServerRequest(new Request('http://localhost/admin/api/cms/setup/status'), { db: await makeDb() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ needsSetup: true })
  })

  it('redirects unmatched public routes to /admin on a fresh install', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/'),
      { db: await makeDb({ site: 0, owners: 0 }) },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin')
  })

  it('returns 404 for unknown routes once setup is complete', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/nope'),
      { db: await makeDb({ site: 1, owners: 1 }) },
    )
    expect(res.status).toBe(404)
  })

  it('explains where the admin UI lives when /admin is hit on the cms port without a build', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin'),
      { db: await makeDb() },
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
    const db = await makeDb({ site: 1, owners: 1 })
    await publishRoute(db, 'about')
    await getPublishedRouteInventoryForVersion(db, getPublishVersion())
    const originalHandle = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<DbResult>
    const trackingDb = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]): Promise<DbResult> => {
        const sql = strings.reduce<string>((acc, s, i) => (i === 0 ? s : `${acc}$${i}${s}`), '')
        if (sql.toLowerCase().includes('site_snapshots')) snapshotQueried = true
        return originalHandle(strings, ...values)
      },
      { transaction: db.transaction, unsafe: db.unsafe, dialect: db.dialect },
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
      { db: await makeDb({ site: 1, owners: 1 }), uploadsDir },
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
      { db: await makeDb({ site: 1, owners: 1 }), uploadsDir },
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

    const db = await makeDb({ site: 1, owners: 1 })
    await publishRoute(db, 'kontakt')
    const runtime = { db, uploadsDir }
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
      { db: await makeDb({ site: 0, owners: 0 }) },
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin')
  })

  it('answers HEAD on a JSON API route like GET instead of 405', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin/api/cms/setup/status', { method: 'HEAD' }),
      { db: await makeDb() },
    )

    expect(res.status).toBe(200)
  })

  it('still rejects a method that GET-only routes genuinely do not support', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin/api/cms/setup/status', { method: 'DELETE' }),
      { db: await makeDb() },
    )

    expect(res.status).not.toBe(200)
  })
})
