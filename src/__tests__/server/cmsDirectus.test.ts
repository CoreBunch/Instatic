import { afterEach, describe, expect, it } from 'bun:test'
import { createDirectusService, setDirectusServiceForTests } from '../../../server/directus'
import { syncSystemRoles } from '../../../server/repositories/roles'
import { createCapabilityTestHarness, expectForbidden, readJson } from '../helpers/capabilityHarness'

afterEach(() => {
  setDirectusServiceForTests(null)
})

async function harnessWithRoles() {
  const harness = await createCapabilityTestHarness()
  await syncSystemRoles(harness.db)
  return harness
}

describe('CMS Directus routes', () => {
  it('returns 401 without a session', async () => {
    const harness = await harnessWithRoles()
    try {
      const res = await harness.cms('/admin/api/cms/directus/health')
      expect(res.status).toBe(401)
    } finally {
      await harness.cleanup()
    }
  })

  it('returns 403 without directus.read', async () => {
    const harness = await harnessWithRoles()
    try {
      await harness.setupOwner()
      const user = await harness.createRoleUser({
        name: 'Site reader',
        slug: 'site-reader',
        capabilities: ['site.read'],
      })
      const res = await harness.cms('/admin/api/cms/directus/health', { cookie: user.cookie })
      await expectForbidden(res)
    } finally {
      await harness.cleanup()
    }
  })

  it('returns 503 when Directus is not configured', async () => {
    const harness = await harnessWithRoles()
    try {
      const cookie = await harness.setupOwner()
      setDirectusServiceForTests(createDirectusService({ config: null }))
      const res = await harness.cms('/admin/api/cms/directus/health', { cookie })
      expect(res.status).toBe(503)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toBe('Directus is not configured')
    } finally {
      await harness.cleanup()
    }
  })

  it('serves the strengths catalog even when Directus is not configured', async () => {
    const harness = await harnessWithRoles()
    try {
      const cookie = await harness.setupOwner()
      setDirectusServiceForTests(createDirectusService({ config: null }))
      const res = await harness.cms('/admin/api/cms/directus/strengths?locale=nl-BE', { cookie })
      expect(res.status).toBe(200)
      const body = await readJson<{ count: number; data: Array<{ id: string; icon: string; name: string }> }>(res)
      expect(body.count).toBe(20)
      expect(body.data[0]).toMatchObject({
        id: 'owner-on-site',
        icon: 'hard-hat',
        name: 'Zaakvoerder op de werf',
      })

      const bad = await harness.cms('/admin/api/cms/directus/strengths?ids=nope', { cookie })
      expect(bad.status).toBe(400)
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects an unknown geography level and a bad uuid', async () => {
    const harness = await harnessWithRoles()
    try {
      const cookie = await harness.setupOwner()
      setDirectusServiceForTests(createDirectusService({
        config: { url: 'https://cms.example.com', token: 't' },
        fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      }))
      const unknown = await harness.cms('/admin/api/cms/directus/geography/continents', { cookie })
      expect(unknown.status).toBe(400)
      const badUuid = await harness.cms(
        '/admin/api/cms/directus/geography/municipalities?parent_id=not-a-uuid',
        { cookie },
      )
      expect(badUuid.status).toBe(400)
      const body = await readJson<{ error: string }>(badUuid)
      expect(body.error).toBe("'parent_id' must be a uuid")
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects control characters', async () => {
    const harness = await harnessWithRoles()
    try {
      const cookie = await harness.setupOwner()
      setDirectusServiceForTests(createDirectusService({
        config: { url: 'https://cms.example.com', token: 't' },
        fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      }))
      const res = await harness.cms(
        `/admin/api/cms/directus/workfields?search=${encodeURIComponent('foo\u0000bar')}`,
        { cookie },
      )
      expect(res.status).toBe(400)
    } finally {
      await harness.cleanup()
    }
  })

  it('returns 405 for POST', async () => {
    const harness = await harnessWithRoles()
    try {
      const cookie = await harness.setupOwner()
      const res = await harness.cms('/admin/api/cms/directus/health', { method: 'POST', cookie, json: {} })
      expect(res.status).toBe(405)
    } finally {
      await harness.cleanup()
    }
  })

  it('returns health when the reader is configured', async () => {
    const harness = await harnessWithRoles()
    try {
      const cookie = await harness.setupOwner()
      setDirectusServiceForTests(createDirectusService({
        config: { url: 'https://cms.example.com', token: 't' },
        fetch: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      }))
      const res = await harness.cms('/admin/api/cms/directus/health', { cookie })
      expect(res.status).toBe(200)
      const body = await readJson<{ reachable: boolean; configured: true }>(res)
      expect(body.reachable).toBe(true)
      expect(body.configured).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })
})
