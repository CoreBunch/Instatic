/**
 * What a plugin route learns about where the caller is (`ctx.ip`), and the
 * plugin's own rate-limit counters (`api.cms.rateLimit.take`), end to end:
 * a real plugin package installed through the cms handler, running in its
 * sandboxed worker.
 *
 * `x-bun-socket-ip` stands in for the socket peer that `stampSocketIp`
 * writes at the `Bun.serve` boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { configureTrustedProxyCidrs, resetTrustedProxyCidrs } from '../../../server/auth/security'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { createMember } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { handleServerRequest } from '../../../server/router'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const ORIGIN = 'http://localhost'
const PLUGIN_ID = 'acme.counter'
const MOUNT = `/_instatic/plugins/${PLUGIN_ID}`
const ADMIN_MOUNT = `/admin/api/cms/plugins/${PLUGIN_ID}/runtime`
const PERMISSIONS = ['cms.routes', 'cms.routes.public', 'members.read']

const PLUGIN_SOURCE = `
  export function activate(api) {
    const seen = (ctx) => ({
      ip: ctx.ip,
      peer: ctx.req.headers.get('x-bun-socket-ip'),
      forwarded: ctx.req.headers.get('x-forwarded-for'),
    })
    api.cms.routes.public.get('/ip', seen)
    api.cms.routes.member.get('/me-ip', seen)
    api.cms.routes.get('/admin-ip', 'plugins.read', seen)
    api.cms.routes.authenticated.get('/ip-any', seen)

    api.cms.routes.public.post('/take', async (ctx) => {
      try {
        return await api.cms.rateLimit.take(ctx.body.key, ctx.body.limit, ctx.body.windowMs)
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
    })
  }
`

describe('plugin routes and the caller', () => {
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'plugin-ip-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    resetTrustedProxyCidrs()
    expect((await install()).status).toBe(201)
  })

  afterEach(async () => {
    resetTrustedProxyCidrs()
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(): Promise<Response> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify({
        id: PLUGIN_ID,
        name: 'Counter',
        version: '1.0.0',
        apiVersion: 1,
        permissions: PERMISSIONS,
        entrypoints: { server: 'server/index.js' },
        resources: [],
        adminPages: [],
      })),
      'server/index.js': strToU8(PLUGIN_SOURCE),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(PERMISSIONS))
    const req = {
      url: `${ORIGIN}/admin/api/cms/plugins/package`,
      method: 'POST',
      headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
      formData: async () => formData,
    } as unknown as Request
    return handleCmsRequest(req, h.db, { uploadsDir })
  }

  async function visit(
    path: string,
    init: { peer?: string; forwardedFor?: string; cookie?: string; method?: string; json?: unknown } = {},
  ): Promise<Response> {
    const method = init.method ?? 'GET'
    const req = new Request(`${ORIGIN}${path}`, {
      method,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    })
    if (init.json !== undefined) req.headers.set('content-type', 'application/json')
    if (init.peer) req.headers.set('x-bun-socket-ip', init.peer)
    if (init.forwardedFor) req.headers.set('x-forwarded-for', init.forwardedFor)
    if (init.cookie) req.headers.set('cookie', init.cookie)
    if (method !== 'GET') req.headers.set('origin', ORIGIN)
    return handleServerRequest(req, { db: h.db, uploadsDir })
  }

  const seen = async (path: string, init: Parameters<typeof visit>[1] = {}) => {
    const res = await visit(path, init)
    expect(res.status).toBe(200)
    return (await res.json()) as { ip: string | null; peer: string | null; forwarded: string | null }
  }

  describe('ctx.ip', () => {
    it('is the socket peer for a direct caller, and the peer header itself is not passed on', async () => {
      expect(await seen(`${MOUNT}/ip`, { peer: '203.0.113.7' })).toEqual({ ip: '203.0.113.7', peer: null, forwarded: null })
    })

    it('is one spelling per address', async () => {
      expect((await seen(`${MOUNT}/ip`, { peer: '::ffff:203.0.113.7' })).ip).toBe('203.0.113.7')
      expect((await seen(`${MOUNT}/ip`, { peer: '2001:DB8:0:0:0:0:0:1' })).ip).toBe('2001:db8::1')
      configureTrustedProxyCidrs(['10.0.0.0/8'])
      expect((await seen(`${MOUNT}/ip`, { peer: '10.0.0.2', forwardedFor: '2001:0db8::0001' })).ip).toBe('2001:db8::1')
    })

    it('is null when the server cannot tell', async () => {
      expect((await seen(`${MOUNT}/ip`)).ip).toBeNull()
    })

    it('is the forwarded client behind a trusted proxy', async () => {
      configureTrustedProxyCidrs(['10.0.0.0/8'])
      const view = await seen(`${MOUNT}/ip`, { peer: '10.0.0.2', forwardedFor: '198.51.100.20, 10.0.0.9' })
      expect(view.ip).toBe('198.51.100.20')
      // The header itself is the client's to send, so the plugin sees it as it came.
      expect(view.forwarded).toBe('198.51.100.20, 10.0.0.9')
    })

    it('ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
      configureTrustedProxyCidrs(['10.0.0.0/8'])
      expect((await seen(`${MOUNT}/ip`, { peer: '203.0.113.7', forwardedFor: '198.51.100.20' })).ip).toBe('203.0.113.7')
      resetTrustedProxyCidrs()
      expect((await seen(`${MOUNT}/ip`, { peer: '10.0.0.2', forwardedFor: '198.51.100.20' })).ip).toBe('10.0.0.2')
    })

    it('is set on member routes', async () => {
      const created = await createMember(h.db, { email: 'ada@example.com', passwordHash: 'x', profile: {}, verified: true })
      const session = await createMemberSession(h.db, created!.id, { ipAddress: null, userAgent: null })
      const view = await seen(`${MOUNT}/me-ip`, { peer: '203.0.113.8', cookie: `instatic_member=${session.token}` })
      expect(view.ip).toBe('203.0.113.8')
    })

    it('is set on admin routes', async () => {
      expect((await seen(`${ADMIN_MOUNT}/admin-ip`, { peer: '203.0.113.9', cookie: owner })).ip).toBe('203.0.113.9')
      expect((await seen(`${ADMIN_MOUNT}/ip-any`, { peer: '203.0.113.9', cookie: owner })).ip).toBe('203.0.113.9')
    })
  })

  describe('api.cms.rateLimit.take', () => {
    const take = async (body: Record<string, unknown>) =>
      (await (await visit(`${MOUNT}/take`, { method: 'POST', json: body })).json()) as {
        ok?: boolean
        remaining?: number
        retryAfterMs?: number
        reason?: string
        error?: string
      }

    it('allows up to the limit per key, then refuses with a wait', async () => {
      const results = []
      for (let i = 0; i < 4; i++) results.push(await take({ key: 'ip:203.0.113.7', limit: 3, windowMs: 60_000 }))
      expect(results.slice(0, 3).map((r) => [r.ok, r.remaining, r.reason])).toEqual([[true, 2, undefined], [true, 1, undefined], [true, 0, undefined]])
      expect(results[3]?.ok).toBe(false)
      expect(results[3]?.reason).toBe('limit')
      expect(results[3]?.retryAfterMs).toBeGreaterThan(0)
      expect(results[3]?.retryAfterMs).toBeLessThanOrEqual(60_000)
      // Another key has its own window.
      expect((await take({ key: 'ip:203.0.113.8', limit: 3, windowMs: 60_000 })).ok).toBe(true)
    })

    it('refuses arguments outside its bounds', async () => {
      expect((await take({ key: 'k', limit: 0, windowMs: 60_000 })).error).toBeDefined()
      expect((await take({ key: 'k', limit: 3, windowMs: 10 })).error).toBeDefined()
      expect((await take({ key: '', limit: 3, windowMs: 60_000 })).error).toBeDefined()
    })

    it('keeps a separate counter for the same key under another limit', async () => {
      expect((await take({ key: 'k', limit: 1, windowMs: 60_000 })).ok).toBe(true)
      expect((await take({ key: 'k', limit: 1, windowMs: 60_000 })).ok).toBe(false)
      expect((await take({ key: 'k', limit: 2, windowMs: 60_000 })).ok).toBe(true)
    })
  })
})
