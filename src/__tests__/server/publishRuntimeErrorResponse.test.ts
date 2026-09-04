import { describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { saveDraftSite } from '../../../server/repositories/site'
import {
  createCapabilityTestHarness,
  readJson,
} from '../helpers/capabilityHarness'

describe('publish runtime validation response', () => {
  it('returns live compiler diagnostics without attempting a publish', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const siteResponse = await harness.cms('/admin/api/cms/site', { cookie })
      const { site } = await readJson<{ site: SiteShell }>(siteResponse)
      const draft = {
        ...site,
        pages: [],
        visualComponents: [],
        files: [
          ...site.files,
          {
            id: 'live-broken-script',
            path: 'src/scripts/live-broken.ts',
            type: 'script' as const,
            content: `const value from 'broken'`,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        runtime: normalizeSiteRuntimeConfig({
          ...site.runtime,
          scripts: {
            ...site.runtime?.scripts,
            'live-broken-script': { placement: 'body-end' },
          },
        }),
      }

      const response = await harness.cms('/admin/api/cms/runtime/validate', {
        method: 'POST',
        cookie,
        json: { site: draft },
      })

      expect(response.status).toBe(200)
      const body = await readJson<{ diagnostics: Array<Record<string, unknown>> }>(response)
      expect(body.diagnostics).toEqual([
        expect.objectContaining({
          fileId: 'live-broken-script',
          path: 'src/scripts/live-broken.ts',
          line: 1,
          severity: 'error',
          message: 'Expected ";" but found "from"',
        }),
      ])
    } finally {
      await harness.cleanup()
    }
  }, 15_000)

  it('returns an actionable 422 for an invalid authored runtime script', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const siteResponse = await harness.cms('/admin/api/cms/site', { cookie })
      expect(siteResponse.status).toBe(200)
      const { site } = await readJson<{ site: SiteShell }>(siteResponse)

      await saveDraftSite(harness.db, {
        ...site,
        files: [
          ...site.files,
          {
            id: 'forgotten-test-script',
            path: 'src/scripts/forgotten-test.ts',
            type: 'script',
            content: `const value from 'broken'`,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        runtime: normalizeSiteRuntimeConfig({
          ...site.runtime,
          scripts: {
            ...site.runtime?.scripts,
            'forgotten-test-script': {
              placement: 'body-end',
              priority: 10,
            },
          },
        }),
      })

      const response = await harness.cms('/admin/api/cms/publish', {
        method: 'POST',
        cookie,
      })
      expect(response.status).toBe(422)
      const body = await readJson<{ error: string }>(response)
      expect(body.error).toContain(
        'src/scripts/forgotten-test.ts:1:',
      )
      expect(body.error).toContain('Expected ";" but found "from"')
    } finally {
      await harness.cleanup()
    }
  }, 15_000)
})
