/**
 * Tests for GET /admin/api/cms/data/_meta.
 *
 * Uses the createFakeDb pattern from dbTestFake.ts and the session-stub
 * approach from cmsSiteHandlers.test.ts to avoid a real DB connection.
 */
import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { DataMetaSchema } from '@core/data/schemas'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import { createFakeDb } from './dbTestFake'

// ---------------------------------------------------------------------------
// Shared fake row data
// ---------------------------------------------------------------------------

const fakeDataTableRow = {
  id: 'posts',
  name: 'Posts',
  slug: 'posts',
  kind: 'postType',
  route_base: '/posts',
  singular_label: 'Post',
  plural_label: 'Posts',
  primary_field_id: 'title',
  fields_json: [
    { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
    { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
    { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
    { type: 'media', id: 'featuredMedia', label: 'Featured media', mediaKind: 'image', builtIn: true },
  ],
  created_by_user_id: null,
  updated_by_user_id: null,
  created_at: new Date('2026-05-01T10:00:00Z'),
  updated_at: new Date('2026-05-01T10:00:00Z'),
}

// Minimal user row that satisfies rowToUser() — roles carry content.edit.any.
const contentManagerUserRow = {
  id: 'user_1',
  email: 'manager@example.com',
  email_normalized: 'manager@example.com',
  display_name: 'Content Manager',
  password_hash: 'hash',
  status: 'active',
  role_id: 'content-manager',
  last_login_at: null,
  failed_login_count: 0,
  locked_until: null,
  avatar_media_id: null,
  password_updated_at: null,
  mfa_enabled: false,
  mfa_enabled_at: null,
  mfa_totp_secret_ciphertext: null,
  mfa_totp_secret_iv: null,
  mfa_totp_secret_key_fingerprint: null,
  mfa_recovery_code_hashes_json: [],
  created_at: new Date('2026-05-01T10:00:00Z'),
  updated_at: new Date('2026-05-01T10:00:00Z'),
  deleted_at: null,
  role_slug: 'content-manager',
  role_name: 'Content Manager',
  role_description: '',
  role_is_system: true,
  role_capabilities_json: ['content.edit.any'],
  avatar_public_path: null,
  session_mfa_passed_at: null,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake DB that handles session auth and listDataTables queries. */
function makeAuthDb(sessionIdHash: string) {
  return createFakeDb(async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // Session lookup: findSessionUserRow
    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      if (String(params[0]) === sessionIdHash) {
        return { rows: [contentManagerUserRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // Session touch: last_seen_at update after successful auth
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }

    // listDataTables
    if (normalized.startsWith('select id, name, slug, kind, route_base')) {
      return { rows: [fakeDataTableRow], rowCount: 1 }
    }

    throw new Error(`Unhandled SQL in makeAuthDb: ${sql}`)
  })
}

/**
 * Build a minimal GET Request for the given path, optionally with a cookie.
 *
 * Uses a plain-object cast rather than `new Request()` so that the cookie
 * header survives — happy-dom's Request (which backs globalThis.Request in
 * tests) follows the browser spec that strips the Cookie header on
 * construction. Plain-object approach is the same as cmsSiteHandlers.test.ts.
 */
function makeRequest(path: string, cookie?: string): Request {
  const headerMap = new Map<string, string>()
  if (cookie) headerMap.set('cookie', cookie)
  return {
    url: `http://localhost${path}`,
    method: 'GET',
    headers: {
      get(name: string): string | null {
        return headerMap.get(name.toLowerCase()) ?? null
      },
    },
    async json() { return {} },
  } as unknown as Request
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /admin/api/cms/data/_meta', () => {
  it('returns 401 for unauthenticated requests', async () => {
    // No session query will be issued — auth short-circuits on missing cookie.
    const db = createFakeDb(async (sql) => {
      throw new Error(`Unexpected DB query for unauthenticated request: ${sql}`)
    })
    const res = await handleCmsRequest(makeRequest('/admin/api/cms/data/_meta'), db)
    expect(res.status).toBe(401)
  })

  it('returns 200 with meta for authenticated users with data access', async () => {
    const token = 'meta-route-test-token'
    const idHash = await hashSessionToken(token)
    const db = makeAuthDb(idHash)
    const cookie = `${SESSION_COOKIE_NAME}=${token}`

    const res = await handleCmsRequest(makeRequest('/admin/api/cms/data/_meta', cookie), db)
    expect(res.status).toBe(200)

    const body = await res.json() as { meta: { tables: Array<Record<string, unknown>> } }
    expect(body).toHaveProperty('meta')
    expect(body.meta).toHaveProperty('tables')
    expect(body.meta.tables).toHaveLength(1)
    expect(body.meta.tables[0]).toMatchObject({
      id: 'posts',
      slug: 'posts',
      name: 'Posts',
      kind: 'postType',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      routable: true,
      versioned: true,
      system: false,
    })
  })

  it('response payload validates against DataMetaSchema', async () => {
    const token = 'meta-schema-test-token'
    const idHash = await hashSessionToken(token)
    const db = makeAuthDb(idHash)
    const cookie = `${SESSION_COOKIE_NAME}=${token}`

    const res = await handleCmsRequest(makeRequest('/admin/api/cms/data/_meta', cookie), db)
    expect(res.status).toBe(200)

    const body = await res.json() as { meta: unknown }
    expect(Value.Check(DataMetaSchema, body.meta)).toBe(true)
  })
})
