import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import type { DbClient } from '../../../server/db/client'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { syncSystemRoles } from '../../../server/repositories/roles'
import { handleCmsRequest } from '../../../server/handlers/cms'
import {
  getStagingEnvironment,
  resolveStagingEnvironment,
  saveStagingEnvironment,
} from '../../../server/repositories/stagingEnvironment'
import { normalizeStagingOrigin } from '../../../server/handlers/cms/staging'
import { handleStagingSyncRequest } from '../../../server/staging/receiver'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

const TEST_MASTER_KEY = Buffer.alloc(32, 19).toString('base64')

describe('staging environment', () => {
  let db: DbClient
  let ownerId: string
  let ownerCookie: string
  let originalSecretKey: string | undefined

  beforeAll(async () => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
    db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
    await syncSystemRoles(db)
    await cms('/admin/api/cms/setup', {
      method: 'POST',
      json: {
        siteName: 'Staging test',
        email: 'owner@staging.test',
        password: 'long-enough-password',
      },
    })
    const login = await cms('/admin/api/cms/login', {
      method: 'POST',
      json: { email: 'owner@staging.test', password: 'long-enough-password' },
    })
    ownerCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
    const { rows } = await db<{ id: string }>`
      select id from users where role_id = ${'owner'} limit 1
    `
    ownerId = rows[0]!.id
  })

  afterAll(async () => {
    await db.close()
    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
    __resetMasterKeyCacheForTesting()
  })

  it('accepts HTTPS origins and loopback HTTP only', () => {
    expect(normalizeStagingOrigin('https://Staging.Example.com/')).toBe('https://staging.example.com')
    expect(normalizeStagingOrigin('http://localhost:3002')).toBe('http://localhost:3002')
    expect(normalizeStagingOrigin('http://staging.example.com')).toBeNull()
    expect(normalizeStagingOrigin('https://staging.example.com/admin')).toBeNull()
    expect(normalizeStagingOrigin('https://user:pass@staging.example.com')).toBeNull()
  })

  it('encrypts the receiver token and exposes only wire-safe state', async () => {
    await saveStagingEnvironment(db, {
      origin: 'https://staging.example.com',
      token: 'a-long-random-staging-token',
      tableIds: ['posts'],
      includeSite: true,
    }, ownerId)

    const view = await getStagingEnvironment(db)
    expect(view).toMatchObject({
      configured: true,
      origin: 'https://staging.example.com',
      hasToken: true,
      keyFingerprintCurrent: true,
      tableIds: ['posts'],
    })
    expect(JSON.stringify(view)).not.toContain('a-long-random-staging-token')

    const { rows } = await db<{ token_ciphertext: Uint8Array }>`
      select token_ciphertext from staging_environment where id = 1
    `
    expect(new TextDecoder().decode(rows[0]!.token_ciphertext)).not.toContain('a-long-random-staging-token')
    expect((await resolveStagingEnvironment(db)).token).toBe('a-long-random-staging-token')
  })

  it('requires authentication and deployment.manage for the admin route', async () => {
    expect((await cms('/admin/api/cms/staging')).status).toBe(401)
    const response = await cms('/admin/api/cms/staging', { cookie: ownerCookie })
    expect(response.status).toBe(200)
  })

  it('keeps the receiver disabled on production and authenticates staging requests', async () => {
    const production = await handleStagingSyncRequest(
      new Request('https://staging.example.com/_instatic/staging-sync'),
      db,
      { environment: 'production', syncToken: 'receiver-token' },
    )
    expect(production.status).toBe(404)

    const unauthorized = await handleStagingSyncRequest(
      new Request('https://staging.example.com/_instatic/staging-sync'),
      db,
      { environment: 'staging', syncToken: 'receiver-token' },
    )
    expect(unauthorized.status).toBe(401)

    const authorizedRequest = new Request('https://staging.example.com/_instatic/staging-sync')
    authorizedRequest.headers.set('authorization', 'Bearer receiver-token')
    const authorized = await handleStagingSyncRequest(authorizedRequest, db, {
      environment: 'staging',
      syncToken: 'receiver-token',
    })
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toEqual({ ok: true, environment: 'staging' })

    const oversizedRequest = new Request('https://staging.example.com/_instatic/staging-sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    oversizedRequest.headers.set('content-length', String(64 * 1024 * 1024 + 1))
    const oversized = await handleStagingSyncRequest(oversizedRequest, db, {
      environment: 'staging',
      syncToken: 'receiver-token',
    })
    expect(oversized.status).toBe(413)
  })

  function cms(
    path: string,
    options: { method?: string; cookie?: string; json?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers()
    if (options.json !== undefined) headers.set('content-type', 'application/json')
    const request = new Request(`http://localhost${path}`, {
      method: options.method,
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    })
    if (options.cookie) request.headers.set('cookie', options.cookie)
    return handleCmsRequest(request, db)
  }
})
