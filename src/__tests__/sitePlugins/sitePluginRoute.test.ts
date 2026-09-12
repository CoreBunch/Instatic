import { describe, expect, test } from 'bun:test'
import { sitePluginRoute } from '@core/plugin-sdk'

describe('sitePluginRoute', () => {
  test('resolves to the reserved plugin runtime route', () => {
    expect(sitePluginRoute('newsletter', '/subscribe'))
      .toBe('/admin/api/cms/plugins/site.newsletter/runtime/subscribe')
    expect(sitePluginRoute('newsletter', 'subscribe'))
      .toBe('/admin/api/cms/plugins/site.newsletter/runtime/subscribe')
  })
})
