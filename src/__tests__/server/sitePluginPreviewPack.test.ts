/**
 * Session-local draft canvas preview — the preview-pack route returns the
 * validate-only modules bundle with no-store caching and registers NOTHING
 * server-side (the plugin row stays untouched).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { getInstalledPlugin } from '../../../server/repositories/plugins'

let harness: CapabilityTestHarness
let ownerCookie: string

beforeAll(async () => {
  harness = await createCapabilityTestHarness()
  ownerCookie = await harness.setupOwner()
  const scaffold = await harness.cms('/admin/api/cms/site-plugins', {
    method: 'POST',
    cookie: ownerCookie,
    json: { name: 'Kit', localId: 'kit', template: 'module' },
  })
  expect(scaffold.status).toBe(201)
})

afterAll(async () => {
  await harness.cleanup()
})

describe('site plugin preview pack', () => {
  test('returns the draft modules bundle with no-store, registering nothing', async () => {
    const res = await harness.cms('/admin/api/cms/site-plugins/kit/preview-pack.js', {
      cookie: ownerCookie,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/javascript')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bundle = await res.text()
    expect(bundle).toContain('site.kit.kit')

    // Preview is session-local by construction — no runtime row appears.
    expect(await getInstalledPlugin(harness.db, 'site.kit')).toBeNull()
  })

  test('404s with diagnostics context for a plugin without modules', async () => {
    const scaffold = await harness.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: ownerCookie,
      json: { name: 'Backend', localId: 'backend', template: 'routes' },
    })
    expect(scaffold.status).toBe(201)

    const res = await harness.cms('/admin/api/cms/site-plugins/backend/preview-pack.js', {
      cookie: ownerCookie,
    })
    expect(res.status).toBe(404)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('no module pack')
  })
})
