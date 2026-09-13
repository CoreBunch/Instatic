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
import { PLUGIN_API_VERSION, type FrontendAsset } from '@core/plugin-sdk'
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
    mediaCspOrigins: [],
  }
}

function frontendAssetDb(assets: FrontendAsset[]) {
  const manifest = {
    id: 'acme.assets',
    name: 'Asset fixtures',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    permissions: ['frontend.assets'],
    grantedPermissions: ['frontend.assets'],
    resources: [],
    adminPages: [],
    frontend: { assets },
    assetBasePath: '/uploads/plugins/acme.assets/1.0.0',
  }

  return createFakeDb(async (sql): Promise<DbResult> => {
    if (sql.includes('from installed_plugins')) {
      return {
        rows: [{
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          enabled: true,
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
