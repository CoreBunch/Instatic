/**
 * The `site.` plugin-id namespace is reserved for site plugins generated
 * from the site draft. The zip-install boundary (`readPluginPackage`) must
 * reject uploaded packages that claim it — otherwise a zip could hijack a
 * site plugin's runtime identity, grants, settings, and secrets. The
 * manifest PARSER keeps accepting `site.*` ids because generated site-plugin
 * packages parse through it.
 */
import { describe, expect, it } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { isReservedSitePluginId, parsePluginManifest } from '@core/plugins/manifest'
import { readPluginPackage } from '../../../server/plugins/package'

function pluginZip(files: Record<string, string>): File {
  const zipped = zipSync(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
  ))
  return new File([zipped], 'site-newsletter.zip', { type: 'application/zip' })
}

describe('site.* plugin id namespace', () => {
  it('isReservedSitePluginId flags the reserved namespace', () => {
    expect(isReservedSitePluginId('site.newsletter')).toBe(true)
    expect(isReservedSitePluginId('site.a.b')).toBe(true)
    expect(isReservedSitePluginId('acme.workflow')).toBe(false)
    // 'sitemap.tools' must NOT be caught by a naive startsWith('site')
    expect(isReservedSitePluginId('sitemap.tools')).toBe(false)
  })

  it('the zip boundary rejects site.* package ids', async () => {
    const manifest = {
      id: 'site.newsletter',
      name: 'Newsletter',
      version: '1.0.0',
      apiVersion: 1,
      permissions: [],
      adminPages: [],
    }
    await expect(readPluginPackage(pluginZip({
      'plugin.json': JSON.stringify(manifest),
    }))).rejects.toThrow(/reserved "site\." namespace/)
  })

  it('the manifest parser still accepts site.* ids (generated packages)', () => {
    const parsed = parsePluginManifest({
      id: 'site.newsletter',
      name: 'Newsletter',
      version: '1.0.1+abcd1234',
      apiVersion: 1,
      permissions: [],
      resources: [],
      adminPages: [],
    })
    expect(parsed.id).toBe('site.newsletter')
  })
})
