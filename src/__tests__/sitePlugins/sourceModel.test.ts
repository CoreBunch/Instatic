/**
 * Site plugin source model — discovery by folder convention, author-manifest
 * validation (derived fields rejected), runtime manifest derivation, and the
 * content hash the generated version carries.
 */
import { describe, expect, test } from 'bun:test'
import {
  computeSitePluginContentHash,
  contentHashOfVersion,
  computeSitePluginState,
  deriveSitePluginManifest,
  discoverSitePlugins,
  nextSitePluginVersion,
} from '@core/site-plugins'
import type { SiteFile } from '@core/files/schemas'

const file = (path: string, content: string, type: SiteFile['type'] = 'plugin'): SiteFile => ({
  id: path,
  path,
  type,
  content,
  createdAt: 1,
  updatedAt: 1,
})

const draftManifest = JSON.stringify({
  name: 'Newsletter',
  description: 'Email capture',
  permissions: ['cms.routes', 'cms.routes.public'],
})

describe('site plugin discovery', () => {
  test('discovers plugins by folder convention, ignoring non-plugin files', () => {
    const found = discoverSitePlugins([
      file('plugins/newsletter/plugin.json', draftManifest),
      file('plugins/newsletter/server/index.ts', 'export function activate() {}'),
      file('src/scripts/fx.ts', '', 'script'),
      file('plugins/analytics/plugin.json', draftManifest),
    ])
    expect(found.map((p) => p.localId)).toEqual(['analytics', 'newsletter'])
    expect(found[1]!.files).toHaveLength(2)
    expect(found[1]!.manifestFile?.path).toBe('plugins/newsletter/plugin.json')
  })

  test('rejects invalid local ids', () => {
    expect(() =>
      discoverSitePlugins([file('plugins/News.Letter/plugin.json', draftManifest)]),
    ).toThrow(/local id/i)
  })
})

describe('site plugin manifest derivation', () => {
  test('derives id, version, apiVersion, entrypoints, assetBasePath', () => {
    const derived = deriveSitePluginManifest({
      localId: 'newsletter',
      draftManifestJson: draftManifest,
      files: [file('plugins/newsletter/server/index.ts', '')],
      previousVersion: '1.0.6+aaaa1111',
      contentHash: 'bbbb2222',
    })
    expect(derived.id).toBe('site.newsletter')
    expect(derived.version).toBe('1.0.7+bbbb2222')
    expect(derived.apiVersion).toBeGreaterThanOrEqual(1)
    expect(derived.entrypoints?.server).toBe('server/index.js')
    expect(derived.assetBasePath).toBe('/uploads/plugins/site.newsletter/1.0.7+bbbb2222')
  })

  test('first build starts the counter at 1', () => {
    const derived = deriveSitePluginManifest({
      localId: 'newsletter',
      draftManifestJson: draftManifest,
      files: [file('plugins/newsletter/server/index.ts', '')],
      previousVersion: null,
      contentHash: 'cccc3333',
    })
    expect(derived.version).toBe('1.0.1+cccc3333')
  })

  test('derives module entrypoints and pack from folder convention', () => {
    const derived = deriveSitePluginManifest({
      localId: 'kit',
      draftManifestJson: JSON.stringify({ name: 'Kit', permissions: ['modules.register'] }),
      files: [
        file('plugins/kit/plugin.json', ''),
        file('plugins/kit/modules/card.ts', ''),
        file('plugins/kit/pack/site.json', '{}'),
      ],
      previousVersion: null,
      contentHash: 'dddd4444',
    })
    expect(derived.entrypoints?.modules).toBe('modules/index.js')
    expect(derived.pack?.path).toBe('pack/site.json')
  })

  test('rewrites frontend asset source paths to built paths', () => {
    const derived = deriveSitePluginManifest({
      localId: 'tracker',
      draftManifestJson: JSON.stringify({
        name: 'Tracker',
        permissions: ['frontend.assets'],
        frontend: { assets: [{ kind: 'script', src: 'frontend/tracker.ts' }] },
      }),
      files: [file('plugins/tracker/frontend/tracker.ts', '')],
      previousVersion: null,
      contentHash: 'eeee5555',
    })
    const asset = derived.frontend?.assets[0]
    expect(asset && asset.kind === 'script' ? asset.src : null).toBe('frontend/tracker.js')
  })

  test('rewrites and verifies adminPages app entries', () => {
    const appManifest = (entry: string) =>
      JSON.stringify({
        name: 'CRM',
        permissions: ['admin.navigation', 'editor.code'],
        adminPages: [
          {
            id: 'customers',
            title: 'Customers',
            content: { kind: 'app', heading: 'Customers', entry },
          },
        ],
      })
    const files = [
      file('plugins/crm/plugin.json', ''),
      file('plugins/crm/frontend/customers.tsx', ''),
    ]

    // Source path rewrites to the built bundle.
    const derived = deriveSitePluginManifest({
      localId: 'crm',
      draftManifestJson: appManifest('frontend/customers.tsx'),
      files,
      previousVersion: null,
      contentHash: 'abcd1234',
    })
    const page = derived.adminPages[0]
    expect(page && page.content.kind === 'app' ? page.content.entry : null).toBe(
      'frontend/customers.js',
    )

    // A non-JS entry fails at BUILD time (used to only fail at runtime).
    expect(() =>
      deriveSitePluginManifest({
        localId: 'crm',
        draftManifestJson: appManifest('frontend/customers.html'),
        files: [...files, file('plugins/crm/frontend/customers.html', '<html/>')],
        previousVersion: null,
        contentHash: 'abcd1234',
      }),
    ).toThrow(/must be a JS module/i)

    // A dangling entry (no matching source) fails too.
    expect(() =>
      deriveSitePluginManifest({
        localId: 'crm',
        draftManifestJson: appManifest('frontend/missing.ts'),
        files,
        previousVersion: null,
        contentHash: 'abcd1234',
      }),
    ).toThrow(/no matching source/i)
  })

  test('rejects author-set derived fields', () => {
    const withId = JSON.stringify({ id: 'acme.evil', name: 'X', permissions: [] })
    expect(() =>
      deriveSitePluginManifest({
        localId: 'newsletter',
        draftManifestJson: withId,
        files: [],
        previousVersion: null,
        contentHash: 'ffff6666',
      }),
    ).toThrow(/derived by the build/i)
  })
})

describe('content hash + version', () => {
  test('content hash is stable and order-independent', () => {
    const a = [file('plugins/n/plugin.json', draftManifest), file('plugins/n/server/index.ts', 'x')]
    const b = [...a].reverse()
    expect(computeSitePluginContentHash(a)).toBe(computeSitePluginContentHash(b))
    const changed = [file('plugins/n/plugin.json', draftManifest), file('plugins/n/server/index.ts', 'y')]
    expect(computeSitePluginContentHash(changed)).not.toBe(computeSitePluginContentHash(a))
  })

  test('version round-trips its content hash', () => {
    const hash = computeSitePluginContentHash([file('plugins/n/plugin.json', draftManifest)])
    const version = nextSitePluginVersion(null, hash)
    expect(contentHashOfVersion(version)).toBe(hash)
    expect(nextSitePluginVersion(version, 'aaaa')).toBe(`1.0.2+aaaa`)
  })
})

describe('runtime state machine', () => {
  const base = {
    hasDraftSource: true,
    row: { version: '1.0.3+abc', lifecycleStatus: 'active' as const, enabled: true },
    manifestError: null,
    draftContentHash: 'abc',
    activeContentHash: 'abc',
  }

  test('precedence: source-missing > runtime-error > disabled > build-failed > draft-changed > active', () => {
    expect(computeSitePluginState(base)).toBe('active')
    expect(computeSitePluginState({ ...base, draftContentHash: 'zzz' })).toBe('draft-changed')
    expect(computeSitePluginState({ ...base, manifestError: 'bad json' })).toBe('build-failed')
    expect(
      computeSitePluginState({
        ...base,
        row: { ...base.row, enabled: false, lifecycleStatus: 'disabled' },
      }),
    ).toBe('disabled')
    expect(
      computeSitePluginState({ ...base, row: { ...base.row, lifecycleStatus: 'error' } }),
    ).toBe('runtime-error')
    expect(computeSitePluginState({ ...base, hasDraftSource: false })).toBe('source-missing')
    expect(computeSitePluginState({ ...base, row: null })).toBe('draft-changed')
  })
})
