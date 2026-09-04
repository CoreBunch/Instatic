/**
 * Site plugin export/import — the site bundle carries plugin SOURCE
 * (`type: 'plugin'` shell files) and never generated artifacts or runtime
 * rows. On import the source lands as draft; the operator rebuilds and
 * activates on the target instance so grants and secrets are reviewed there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { unzipSync, strFromU8 } from 'fflate'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { getDraftSite } from '../../../server/repositories/site'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { getInstalledPlugin } from '../../../server/repositories/plugins'

let source: CapabilityTestHarness
let target: CapabilityTestHarness
let sourceCookie: string
let targetCookie: string

beforeAll(async () => {
  source = await createCapabilityTestHarness()
  target = await createCapabilityTestHarness()
  sourceCookie = await source.setupOwner()
  targetCookie = await target.setupOwner()
})

afterAll(async () => {
  await source.cleanup()
  await target.cleanup()
})

describe('site plugin export/import', () => {
  test('export carries plugin source files, never generated artifacts', async () => {
    const scaffold = await source.cms('/admin/api/cms/site-plugins', {
      method: 'POST',
      cookie: sourceCookie,
      json: { name: 'Newsletter', localId: 'newsletter', template: 'routes' },
    })
    expect(scaffold.status).toBe(201)

    const res = await source.cms('/admin/api/cms/export', { cookie: sourceCookie })
    expect(res.status).toBe(200)
    const archive = unzipSync(new Uint8Array(await res.arrayBuffer()))

    const manifestEntry = archive['.instatic/site-bundle.json']
    expect(manifestEntry).toBeDefined()
    // The bundle manifest is this test's own fixture — parsed for assertions
    // only, not consumed as typed data.
    const manifest = JSON.parse(strFromU8(manifestEntry!)) as {
      site?: { files?: Array<{ path: string; type: string }> }
    }
    const pluginFiles = (manifest.site?.files ?? []).filter((file) => file.type === 'plugin')
    expect(pluginFiles.map((file) => file.path).sort()).toEqual([
      'plugins/newsletter/plugin.json',
      'plugins/newsletter/server/index.ts',
    ])

    // Generated packages never enter the archive.
    const entryNames = Object.keys(archive)
    expect(entryNames.some((name) => name.includes('uploads/plugins'))).toBe(false)
  })

  test('import lands source as draft with NO runtime record', async () => {
    const exportRes = await source.cms('/admin/api/cms/export', { cookie: sourceCookie })
    const archive = unzipSync(new Uint8Array(await exportRes.arrayBuffer()))
    const bundle = JSON.parse(strFromU8(archive['.instatic/site-bundle.json']!)) as unknown

    const importRes = await target.cms('/admin/api/cms/import', {
      method: 'POST',
      cookie: targetCookie,
      json: bundle,
    })
    expect(importRes.status).toBe(200)
    await readJson(importRes)

    const shell = await getDraftSite(target.db, MAIN_SCOPE)
    const pluginFiles = shell?.files.filter((file) => file.type === 'plugin') ?? []
    expect(pluginFiles.map((file) => file.path).sort()).toEqual([
      'plugins/newsletter/plugin.json',
      'plugins/newsletter/server/index.ts',
    ])

    // Powers never transfer — the operator rebuilds + activates on the target.
    expect(await getInstalledPlugin(target.db, 'site.newsletter')).toBeNull()

    // And the imported draft is immediately buildable.
    const validate = await target.cms('/admin/api/cms/site-plugins/newsletter/validate', {
      method: 'POST',
      cookie: targetCookie,
    })
    expect(validate.status).toBe(200)
    expect(await readJson(validate)).toEqual({ ok: true, diagnostics: [] })
  })
})
