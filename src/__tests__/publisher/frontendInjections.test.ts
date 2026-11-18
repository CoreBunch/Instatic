/**
 * Frontend-injection CSP relaxation — gates the four tiers the publisher
 * applies to a page's `script-src` and `worker-src` directives when one or
 * more plugins contribute `frontend.assets[]` tags:
 *
 *   1. No frontend assets at all              → CSP unchanged (script-src 'none')
 *   2. Only external `<script src=…>`         → script-src 'self'      + worker-src relaxed
 *   3. Only inline `<script>…</script>`       → script-src 'self' 'unsafe-inline' + worker-src relaxed
 *   4. Mix of external and inline             → script-src 'self' 'unsafe-inline' + worker-src relaxed
 *
 * The bug this test fleet locks in: case 2 (external-only) previously failed
 * to relax `script-src`, leaving it at `'none'` so the browser blocked the
 * tag the publisher had just injected. Every analytics / observability /
 * tracker plugin with a single external script hit this.
 */
import { describe, it, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { PLUGIN_API_VERSION, type FrontendAsset, type PluginFrontendOrigins } from '@core/plugin-sdk'
import type { DbResult } from '../../../server/db'
import {
  collectFrontendInjections,
  injectFrontendAssets,
  type FrontendInjections,
} from '../../../server/publish/frontendInjections'
import { createFakeDb } from '../server/dbTestFake'

const PAGE_WITH_CSP_META = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; worker-src 'none'; style-src 'self'; img-src 'self' data:; connect-src 'self';">
</head>
<body></body>
</html>`

function emptyPlan(): FrontendInjections {
  return {
    tags: { head: [], 'head-end': [], 'body-start': [], 'body-end': [] },
    hasInlineScript: false,
    hasExternalScript: false,
    hasInlineStyle: false,
    networkAllowedHosts: [],
    inlineScriptHashes: [],
    scriptOrigins: [],
    frameOrigins: [],
    mediaCspOrigins: [],
  }
}

function frontendAssetDb(
  assets: FrontendAsset[],
  opts: { origins?: PluginFrontendOrigins; granted?: string[]; enabled?: boolean } = {},
) {
  const manifest = {
    id: 'acme.assets',
    name: 'Asset fixtures',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    permissions: ['frontend.assets'],
    grantedPermissions: opts.granted ?? ['frontend.assets'],
    resources: [],
    adminPages: [],
    frontend: { assets, ...(opts.origins ? { origins: opts.origins } : {}) },
    assetBasePath: '/uploads/plugins/acme.assets/1.0.0',
  }

  return createFakeDb(async (sql): Promise<DbResult> => {
    if (sql.includes('from installed_plugins')) {
      return {
        rows: [{
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          enabled: opts.enabled ?? true,
          lifecycle_status: 'active',
          last_error: null,
          granted_permissions_json: manifest.grantedPermissions,
          manifest_json: manifest,
          settings_json: {},
          installed_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('from active_media_storage_adapter')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected query in frontend asset fixture: ${sql}`)
  })
}

describe('frontend injection — asset attributes', () => {
  it('preserves JSON-LD type and bare link attributes', async () => {
    const jsonLd = '{"@context":"https://schema.org","@type":"Article"}'
    const plan = await collectFrontendInjections(frontendAssetDb([
      {
        kind: 'script-inline',
        placement: 'head-end',
        attrs: { type: 'application/ld+json' },
        content: jsonLd,
      },
      {
        kind: 'link',
        attrs: { rel: 'preconnect', href: 'https://cdn.example.com' },
      },
    ]))

    expect(plan.tags['head-end']).toEqual([
      `<script type="application/ld+json" data-plugin-id="acme.assets">${jsonLd}</script>`,
      '<link rel="preconnect" href="https://cdn.example.com" data-plugin-id="acme.assets">',
    ])
  })

  it('keeps host-owned asset attributes authoritative', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      {
        kind: 'script',
        src: 'frontend/app.js',
        strategy: 'module',
        attrs: {
          src: 'https://attacker.example/app.js',
          type: 'application/ld+json',
          async: '',
          integrity: 'sha384-fixture',
        },
      },
      {
        kind: 'style',
        href: 'frontend/app.css',
        attrs: {
          href: 'https://attacker.example/app.css',
          rel: 'alternate',
          media: 'print',
        },
      },
      {
        kind: 'script-inline',
        content: '{}',
        attrs: {
          src: 'https://attacker.example/app.js',
          type: 'application/ld+json',
        },
      },
    ]))

    expect(plan.tags['body-end']).toEqual([
      '<script src="/uploads/plugins/acme.assets/1.0.0/frontend/app.js" type="module" integrity="sha384-fixture" data-plugin-id="acme.assets"></script>',
      '<script type="application/ld+json" data-plugin-id="acme.assets">{}</script>',
    ])
    expect(plan.tags['head-end']).toEqual([
      '<link rel="stylesheet" href="/uploads/plugins/acme.assets/1.0.0/frontend/app.css" media="print" data-plugin-id="acme.assets">',
    ])
  })
})

describe('frontend injection — CSP relaxation', () => {
  it('keeps script-src `none` when no plugin contributes a tag', () => {
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, emptyPlan())
    expect(out).toContain("script-src 'none'")
    expect(out).toContain("worker-src 'none'")
  })

  it('relaxes script-src to `self` for external-only scripts (regression: tracker plugins)', () => {
    const plan = emptyPlan()
    plan.hasExternalScript = true
    plan.tags['body-end'] = [`<script src="/uploads/plugins/acme.analytics/1.0.0/frontend/tracker.js" defer></script>`]
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(out).toContain("script-src 'self';")
    // NOT 'unsafe-inline' — the plan is external-only
    expect(out).not.toContain("script-src 'self' 'unsafe-inline'")
    // worker-src relaxed too, in case the plugin script spawns a worker
    expect(out).toContain("worker-src 'self' blob:;")
  })

  it('relaxes script-src to `self` + `unsafe-inline` for inline scripts', () => {
    const plan = emptyPlan()
    plan.hasInlineScript = true
    plan.tags['body-end'] = [`<script>console.log('hi')</script>`]
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(out).toContain("script-src 'self' 'unsafe-inline';")
    expect(out).toContain("worker-src 'self' blob:;")
  })

  it('relaxes script-src to `self` + `unsafe-inline` for mixed external + inline plans', () => {
    const plan = emptyPlan()
    plan.hasExternalScript = true
    plan.hasInlineScript = true
    plan.tags.head = [`<script>window.X=1</script>`]
    plan.tags['body-end'] = [`<script src="/uploads/plugins/x/1.0.0/frontend/t.js"></script>`]
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(out).toContain("script-src 'self' 'unsafe-inline';")
    expect(out).toContain("worker-src 'self' blob:;")
  })
})

// A page as the publisher emits it when the site uses runtime packages: the
// importmap's hash sits in `script-src`, and frames are off.
const IMPORTMAP_HASH = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"
const PAGE_WITH_IMPORTMAP = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; frame-src 'none'; script-src 'self' ${IMPORTMAP_HASH}; style-src 'self' 'unsafe-inline' https://fonts.example.com; worker-src 'self' blob:;">
</head>
<body></body>
</html>`

function directive(html: string, name: string): string[] {
  const content = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
  const chunk = content.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `))
  return chunk ? chunk.split(/\s+/).slice(1) : []
}

describe('frontend injection — relaxations add to the policy', () => {
  it('keeps the importmap hash when a plugin ships a script', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([{ kind: 'script', src: 'frontend/app.js' }]))
    const out = injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)
    expect(directive(out, 'script-src')).toContain(IMPORTMAP_HASH)
    expect(directive(out, 'script-src')).toContain("'self'")
  })

  it('allows an inline script by its own hash, which a policy carrying a hash needs', async () => {
    const content = 'window.acme = { ready: "</script>" }'
    const plan = await collectFrontendInjections(frontendAssetDb([{ kind: 'script-inline', content }]))
    const out = injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)
    const emitted = /<script data-plugin-id="acme.assets">([\s\S]*?)<\/script>/.exec(out)?.[1] ?? ''
    const hash = `'sha256-${createHash('sha256').update(emitted).digest('base64')}'`
    expect(emitted).not.toBe('')
    expect(directive(out, 'script-src')).toEqual(expect.arrayContaining([IMPORTMAP_HASH, hash, "'unsafe-inline'"]))
  })

  it('keeps existing style sources when a plugin ships an inline style', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([{ kind: 'style-inline', content: 'a{}' }]))
    const out = injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)
    expect(directive(out, 'style-src')).toContain('https://fonts.example.com')
  })
})

describe('frontend injection — declared third-party origins', () => {
  const origins = { scripts: ['js.example.com', '*.js.example.com'], frames: ['pay.example.com'] }

  it('emits a script on a declared host and adds the origins to script-src and frame-src', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb(
      [{ kind: 'script', src: 'https://js.example.com/v3', strategy: 'async' }],
      { origins },
    ))
    expect(plan.tags['body-end']).toEqual([
      '<script src="https://js.example.com/v3" async data-plugin-id="acme.assets"></script>',
    ])
    const out = injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)
    expect(directive(out, 'script-src')).toEqual(
      expect.arrayContaining(['https://js.example.com', 'https://*.js.example.com', IMPORTMAP_HASH]),
    )
    expect(directive(out, 'frame-src')).toEqual(['https://pay.example.com'])
  })

  it('matches a wildcard origin at any subdomain depth', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb(
      [{ kind: 'script', src: 'https://a.b.js.example.com/x.js' }],
      { origins: { scripts: ['*.js.example.com'] } },
    ))
    expect(plan.tags['body-end']).toHaveLength(1)
    expect(plan.tags['body-end'][0]).toContain('https://a.b.js.example.com/x.js')
  })

  it('does not let a wildcard origin cover the bare domain', async () => {
    // The stored manifest fails to parse, so the whole plugin contributes nothing.
    const plan = await collectFrontendInjections(frontendAssetDb(
      [{ kind: 'script', src: 'https://js.example.com/x.js' }],
      { origins: { scripts: ['*.js.example.com'] } },
    ))
    expect(plan.tags['body-end']).toEqual([])
    expect(plan.scriptOrigins).toEqual([])
  })

  it('drops a script whose host the plugin did not declare', async () => {
    // Refused by the manifest parser when the stored row is read back.
    const plan = await collectFrontendInjections(frontendAssetDb(
      [{ kind: 'script', src: 'https://evil.example.net/x.js' }],
      { origins },
    ))
    expect(plan.tags['body-end']).toEqual([])
    expect(plan.hasExternalScript).toBe(false)
  })

  it('adds origins for a plugin that declares them without any tag', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([], { origins }))
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(directive(out, 'frame-src')).toEqual(['https://pay.example.com'])
    expect(directive(out, 'script-src')).toEqual(['https://*.js.example.com', 'https://js.example.com'])
    // No tag was injected, so nothing else is relaxed.
    expect(out).toContain("worker-src 'none'")
  })

  it('contributes nothing when frontend.assets is declared but not granted', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb(
      [{ kind: 'script', src: 'https://js.example.com/v3' }],
      { origins, granted: [] },
    ))
    expect(plan.scriptOrigins).toEqual([])
    expect(plan.frameOrigins).toEqual([])
    expect(injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)).toBe(PAGE_WITH_IMPORTMAP)
  })

  it('contributes nothing when the plugin is disabled', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([], { origins, enabled: false }))
    expect(injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)).toBe(PAGE_WITH_IMPORTMAP)
  })

  it('serializes the same policy whatever order the origins were declared in', async () => {
    const a = await collectFrontendInjections(frontendAssetDb([], { origins: { scripts: ['b.example.com', 'a.example.com'] } }))
    const b = await collectFrontendInjections(frontendAssetDb([], { origins: { scripts: ['a.example.com', 'b.example.com'] } }))
    expect(injectFrontendAssets(PAGE_WITH_IMPORTMAP, a)).toBe(injectFrontendAssets(PAGE_WITH_IMPORTMAP, b))
  })
})

describe('frontend injection — head placement', () => {
  it('puts head tags below the page policy, never above it', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      { kind: 'script', src: 'frontend/early.js', placement: 'head', strategy: 'sync' },
    ]))
    const out = injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)
    const policyAt = out.indexOf('http-equiv="Content-Security-Policy"')
    const scriptAt = out.indexOf('frontend/early.js')
    expect(policyAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeGreaterThan(policyAt)
    expect(scriptAt).toBeLessThan(out.indexOf('</head>'))
  })

  it('still opens the head when the document carries no policy', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      { kind: 'script', src: 'frontend/early.js', placement: 'head' },
    ]))
    const out = injectFrontendAssets('<html><head><title>x</title></head><body></body></html>', plan)
    expect(out.indexOf('frontend/early.js')).toBeLessThan(out.indexOf('<title>'))
  })
})
