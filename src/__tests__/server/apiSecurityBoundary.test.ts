import { describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import {
  configurePublicOrigins,
  configureTrustedProxyCidrs,
  resetPublicOrigins,
  resetTrustedProxyCidrs,
  stampSocketIp,
} from '../../../server/auth/security'
import { handleServerRequest } from '../../../server/router'
import {
  createCapabilityTestHarness,
  readJson,
} from '../helpers/capabilityHarness'

function makeThrowingDb(): { db: DbClient; wasQueried: () => boolean } {
  let queried = false
  const handle = async <Row = Record<string, unknown>>(
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    queried = true
    throw new Error('unexpected database query before API security boundary rejected request')
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return { db: handle as DbClient, wasQueried: () => queried }
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  const req = new Request(`http://cms.test${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (body !== undefined) req.headers.set('content-type', 'application/json')
  for (const [name, value] of Object.entries(headers)) req.headers.set(name, value)
  return req
}

async function withPublicOrigins<T>(
  origins: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  configurePublicOrigins(origins)
  try {
    return await fn()
  } finally {
    resetPublicOrigins()
  }
}

async function withTrustedProxyCidrs<T>(
  cidrs: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  configureTrustedProxyCidrs(cidrs)
  try {
    return await fn()
  } finally {
    resetTrustedProxyCidrs()
  }
}

interface MutationRoute {
  method: string
  path: string
}

const CMS_MUTATION_ROUTES: MutationRoute[] = [
  { method: 'POST', path: '/admin/api/cms/setup' },
  { method: 'POST', path: '/admin/api/cms/login' },
  { method: 'POST', path: '/admin/api/cms/auth/mfa/verify' },
  { method: 'POST', path: '/admin/api/cms/logout' },
  { method: 'DELETE', path: '/admin/api/cms/auth/sessions/session-1' },
  { method: 'POST', path: '/admin/api/cms/auth/step-up' },
  { method: 'POST', path: '/admin/api/cms/auth/logout-all' },
  { method: 'PATCH', path: '/admin/api/cms/me' },
  { method: 'POST', path: '/admin/api/cms/me/avatar' },
  { method: 'DELETE', path: '/admin/api/cms/me/avatar' },
  { method: 'PATCH', path: '/admin/api/cms/me/password' },
  { method: 'POST', path: '/admin/api/cms/me/mfa/totp/start' },
  { method: 'POST', path: '/admin/api/cms/me/mfa/totp/enable' },
  { method: 'DELETE', path: '/admin/api/cms/me/mfa/totp' },
  { method: 'POST', path: '/admin/api/cms/me/mfa/recovery-codes' },
  { method: 'PATCH', path: '/admin/api/cms/me/security/step-up' },
  { method: 'PUT', path: '/admin/api/cms/me/preferences/editor.panel' },
  { method: 'DELETE', path: '/admin/api/cms/me/preferences/editor.panel' },
  { method: 'POST', path: '/admin/api/cms/users' },
  { method: 'PATCH', path: '/admin/api/cms/users/user-1' },
  { method: 'DELETE', path: '/admin/api/cms/users/user-1' },
  { method: 'POST', path: '/admin/api/cms/roles' },
  { method: 'PATCH', path: '/admin/api/cms/roles/role-1' },
  { method: 'DELETE', path: '/admin/api/cms/roles/role-1' },
  { method: 'PUT', path: '/admin/api/cms/site-document' },
  { method: 'POST', path: '/admin/api/cms/runtime/dependencies/resolve' },
  { method: 'POST', path: '/admin/api/cms/runtime/preview' },
  { method: 'POST', path: '/admin/api/cms/media/folders' },
  { method: 'PATCH', path: '/admin/api/cms/media/folders/folder-1' },
  { method: 'DELETE', path: '/admin/api/cms/media/folders/folder-1' },
  { method: 'POST', path: '/admin/api/cms/media/storage/elect' },
  { method: 'POST', path: '/admin/api/cms/media/storage/delegate' },
  { method: 'POST', path: '/admin/api/cms/media/storage/migrate' },
  { method: 'POST', path: '/admin/api/cms/media/storage/verify/adapter-1' },
  { method: 'POST', path: '/admin/api/cms/media' },
  { method: 'PATCH', path: '/admin/api/cms/media/asset-1' },
  { method: 'DELETE', path: '/admin/api/cms/media/asset-1' },
  { method: 'POST', path: '/admin/api/cms/media/asset-1/restore' },
  { method: 'POST', path: '/admin/api/cms/media/asset-1/replace' },
  { method: 'POST', path: '/admin/api/cms/media/asset-1/folders' },
  { method: 'POST', path: '/admin/api/cms/plugins' },
  { method: 'POST', path: '/admin/api/cms/plugins/package' },
  { method: 'POST', path: '/admin/api/cms/plugins/inspect-package' },
  { method: 'PATCH', path: '/admin/api/cms/plugins/plugin-1' },
  { method: 'DELETE', path: '/admin/api/cms/plugins/plugin-1' },
  { method: 'POST', path: '/admin/api/cms/plugins/plugin-1/restart' },
  { method: 'PUT', path: '/admin/api/cms/plugins/plugin-1/settings' },
  { method: 'POST', path: '/admin/api/cms/plugins/plugin-1/pack/install' },
  { method: 'POST', path: '/admin/api/cms/plugins/plugin-1/schedules/schedule-1/run-now' },
  { method: 'POST', path: '/admin/api/cms/plugins/plugin-1/schedules/schedule-1/pause' },
  { method: 'POST', path: '/admin/api/cms/plugins/plugin-1/schedules/schedule-1/resume' },
  {
    method: 'POST',
    path: '/admin/api/cms/plugins/plugin-1/resources/resource-1/records',
  },
  {
    method: 'PATCH',
    path: '/admin/api/cms/plugins/plugin-1/resources/resource-1/records/record-1',
  },
  {
    method: 'DELETE',
    path: '/admin/api/cms/plugins/plugin-1/resources/resource-1/records/record-1',
  },
  { method: 'POST', path: '/admin/api/cms/data/tables' },
  { method: 'PATCH', path: '/admin/api/cms/data/tables/table-1' },
  { method: 'DELETE', path: '/admin/api/cms/data/tables/table-1' },
  { method: 'POST', path: '/admin/api/cms/data/tables/table-1/rows' },
  { method: 'PUT', path: '/admin/api/cms/data/rows/row-1' },
  { method: 'PATCH', path: '/admin/api/cms/data/rows/row-1' },
  { method: 'DELETE', path: '/admin/api/cms/data/rows/row-1' },
  { method: 'POST', path: '/admin/api/cms/data/rows/row-1/publish' },
  { method: 'PATCH', path: '/admin/api/cms/data/rows/row-1/status' },
  { method: 'PATCH', path: '/admin/api/cms/data/rows/row-1/author' },
  { method: 'PATCH', path: '/admin/api/cms/data/rows/row-1/table' },
  { method: 'POST', path: '/admin/api/cms/fonts/estimate' },
  { method: 'POST', path: '/admin/api/cms/fonts/install' },
  { method: 'POST', path: '/admin/api/cms/fonts/custom' },
  { method: 'DELETE', path: '/admin/api/cms/fonts/family/Inter' },
  { method: 'POST', path: '/admin/api/cms/publish' },
  { method: 'POST', path: '/admin/api/cms/export' },
  { method: 'POST', path: '/admin/api/cms/export/estimate' },
  { method: 'POST', path: '/admin/api/cms/import/preview' },
  { method: 'POST', path: '/admin/api/cms/import' },
]

const AI_MUTATION_ROUTES: MutationRoute[] = [
  { method: 'POST', path: '/admin/api/ai/chat/site' },
  { method: 'POST', path: '/admin/api/ai/tool-result' },
  { method: 'POST', path: '/admin/api/ai/credentials' },
  { method: 'PUT', path: '/admin/api/ai/credentials/credential-1' },
  { method: 'DELETE', path: '/admin/api/ai/credentials/credential-1' },
  { method: 'POST', path: '/admin/api/ai/credentials/credential-1/test' },
  { method: 'POST', path: '/admin/api/ai/conversations' },
  { method: 'PUT', path: '/admin/api/ai/conversations/conversation-1' },
  { method: 'DELETE', path: '/admin/api/ai/conversations/conversation-1' },
  { method: 'PUT', path: '/admin/api/ai/defaults/site' },
  { method: 'DELETE', path: '/admin/api/ai/defaults/site' },
]

describe('admin API security boundary', () => {
  it.each(CMS_MUTATION_ROUTES)(
    'rejects forged CMS mutation $method $path before touching the database',
    async ({ method, path }) => {
      const { db, wasQueried } = makeThrowingDb()

      const response = await handleServerRequest(
        makeRequest(method, path, { probe: true }, { origin: 'https://evil.example' }),
        { db },
      )

      expect(response.status).toBe(403)
      expect(await readJson<{ error: string }>(response)).toEqual({
        error: 'Forbidden: invalid origin',
      })
      expect(wasQueried()).toBe(false)
    },
  )

  it.each(AI_MUTATION_ROUTES)(
    'rejects forged AI mutation $method $path before touching the database',
    async ({ method, path }) => {
      const { db, wasQueried } = makeThrowingDb()

      const response = await handleServerRequest(
        makeRequest(method, path, { probe: true }, { origin: 'https://evil.example' }),
        { db },
      )

      expect(response.status).toBe(403)
      expect(await readJson<{ error: string }>(response)).toEqual({
        error: 'Forbidden: invalid origin',
      })
      expect(wasQueried()).toBe(false)
    },
  )

  it('accepts custom and platform public origins at the CMS boundary', async () => {
    await withPublicOrigins(['https://cms.example.com', 'https://site.onrender.com'], async () => {
      const harness = await createCapabilityTestHarness()
      try {
        await harness.setupOwner()

        for (const origin of ['https://cms.example.com', 'https://site.onrender.com']) {
          const response = await harness.cms('/admin/api/cms/login', {
            method: 'POST',
            headers: { origin },
            json: { email: 'owner@example.com', password: 'wrong-password' },
          })

          expect(response.status).not.toBe(403)
          expect(await readJson<{ error: string }>(response)).toEqual({
            error: 'Invalid email or password',
          })
        }
      } finally {
        await harness.cleanup()
      }
    })
  })

  it('accepts custom and platform public origins at the AI boundary', async () => {
    await withPublicOrigins(['https://cms.example.com', 'https://site.onrender.com'], async () => {
      const harness = await createCapabilityTestHarness()
      try {
        for (const origin of ['https://cms.example.com', 'https://site.onrender.com']) {
          const response = await harness.ai('/admin/api/ai/defaults/site', {
            method: 'PUT',
            headers: { origin },
            json: { credentialId: 'cred-1', modelId: 'model-1' },
          })

          expect(response.status).not.toBe(403)
          expect(await readJson<{ error: string }>(response)).toEqual({
            error: 'Unauthorized',
          })
        }
      } finally {
        await harness.cleanup()
      }
    })
  })

  it('rejects forwarded-host origin spoofing at the CMS boundary even from trusted proxies', async () => {
    await withPublicOrigins(['https://cms.example.com'], async () => {
      await withTrustedProxyCidrs(['172.16.0.0/12'], async () => {
        const { db, wasQueried } = makeThrowingDb()
        const req = makeRequest(
          'POST',
          '/admin/api/cms/login',
          { email: 'owner@example.com', password: 'password' },
          {
            origin: 'https://evil.example.com',
            'x-forwarded-host': 'evil.example.com',
            'x-forwarded-proto': 'https',
          },
        )
        stampSocketIp(req, '172.18.0.4')

        const response = await handleServerRequest(req, { db })

        expect(response.status).toBe(403)
        expect(await readJson<{ error: string }>(response)).toEqual({
          error: 'Forbidden: invalid origin',
        })
        expect(wasQueried()).toBe(false)
      })
    })
  })

  it('rejects forwarded-host origin spoofing at the AI boundary even from trusted proxies', async () => {
    await withPublicOrigins(['https://cms.example.com'], async () => {
      await withTrustedProxyCidrs(['172.16.0.0/12'], async () => {
        const { db, wasQueried } = makeThrowingDb()
        const req = makeRequest(
          'PUT',
          '/admin/api/ai/defaults/site',
          { credentialId: 'cred-1', modelId: 'model-1' },
          {
            origin: 'https://evil.example.com',
            'x-forwarded-host': 'evil.example.com',
            'x-forwarded-proto': 'https',
          },
        )
        stampSocketIp(req, '172.18.0.4')

        const response = await handleServerRequest(req, { db })

        expect(response.status).toBe(403)
        expect(await readJson<{ error: string }>(response)).toEqual({
          error: 'Forbidden: invalid origin',
        })
        expect(wasQueried()).toBe(false)
      })
    })
  })

  it('rejects forged CMS mutations at the router boundary before touching the database', async () => {
    const { db, wasQueried } = makeThrowingDb()

    const response = await handleServerRequest(
      makeRequest('POST', '/admin/api/cms/login', { email: 'owner@example.com', password: 'password' }, {
        origin: 'https://evil.example',
      }),
      { db },
    )

    expect(response.status).toBe(403)
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Forbidden: invalid origin' })
    expect(wasQueried()).toBe(false)
  })

  it('rejects forged AI mutations at the router boundary before touching the database', async () => {
    const { db, wasQueried } = makeThrowingDb()

    const response = await handleServerRequest(
      makeRequest('PUT', '/admin/api/ai/defaults/site', { credentialId: 'cred-1', modelId: 'model-1' }, {
        origin: 'https://evil.example',
      }),
      { db },
    )

    expect(response.status).toBe(403)
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Forbidden: invalid origin' })
    expect(wasQueried()).toBe(false)
  })

  it('does not apply the Origin gate to safe CMS reads', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const response = await harness.cms('/admin/api/cms/site', {
        method: 'GET',
        headers: { origin: 'https://evil.example' },
      })

      expect(response.status).toBe(401)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Unauthorized' })
    } finally {
      await harness.cleanup()
    }
  })

  it('keeps owned CMS paths inside the namespace when the method is unsupported', async () => {
    const { db, wasQueried } = makeThrowingDb()

    const response = await handleServerRequest(
      makeRequest('PATCH', '/admin/api/cms/pages'),
      { db },
    )

    expect(response.status).toBe(405)
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Method not allowed' })
    expect(wasQueried()).toBe(false)
  })

  it('checks CMS write capability before parsing a malformed body', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const reader = await harness.createRoleUser({
        name: 'Security Reader',
        slug: 'security-reader',
        capabilities: ['site.read'],
      })

      const response = await harness.cms('/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: reader.cookie,
        json: { definitelyNotThePagesEnvelope: true },
      })

      expect(response.status).toBe(403)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Forbidden' })
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects malformed CMS write bodies after authentication and capability checks pass', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const response = await harness.cms('/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: ownerCookie,
        json: { definitelyNotThePagesEnvelope: true },
      })

      expect(response.status).toBe(400)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Invalid request body' })
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects syntactically invalid JSON after CMS authentication and capability checks pass', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const response = await harness.cms('/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: ownerCookie,
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      })

      expect(response.status).toBe(400)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Invalid request body' })
    } finally {
      await harness.cleanup()
    }
  })

  it('checks AI management capability before accepting default mutations', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const chatOnly = await harness.createRoleUser({
        name: 'AI Chat Only',
        slug: 'ai-chat-only',
        capabilities: ['ai.chat'],
      })

      const response = await harness.ai('/admin/api/ai/defaults/site', {
        method: 'PUT',
        cookie: chatOnly.cookie,
        json: { credentialId: 'cred-1', modelId: 'model-1' },
      })

      expect(response.status).toBe(403)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Forbidden' })
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects syntactically invalid JSON after AI management capability passes', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const response = await harness.ai('/admin/api/ai/defaults/site', {
        method: 'PUT',
        cookie: ownerCookie,
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      })

      expect(response.status).toBe(400)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Invalid request body.' })
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects malformed AI default bodies after management capability passes', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const response = await harness.ai('/admin/api/ai/defaults/site', {
        method: 'PUT',
        cookie: ownerCookie,
        json: { credentialId: '', modelId: '' },
      })

      expect(response.status).toBe(400)
      expect(await readJson<{ error: string }>(response)).toEqual({ error: 'Invalid request body.' })
    } finally {
      await harness.cleanup()
    }
  })
})
