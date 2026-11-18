/**
 * Frontend-injection CSP relaxation — gates the four tiers the publisher
 * applies to a page's `script-src` and `worker-src` directives when one or
 * more plugins contribute `frontend.assets[]` tags:
 *
 *   1. No frontend assets at all              → CSP unchanged (script-src 'none')
 *   2. Only external `<script src=…>`         → script-src 'self'      + worker-src relaxed
 *   3. Only inline `<script>…</script>`       → script-src 'self' + that script's hash + worker-src relaxed
 *   4. Mix of external and inline             → script-src 'self' + the inline hash + worker-src relaxed
 *
 * `'unsafe-inline'` is never granted to scripts: a policy that carries a hash
 * makes browsers ignore it, so the only inline code that runs is a declared
 * `script-inline` asset.
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
import { publishPage } from '@core/publisher'
import type { AnyModuleDefinition } from '@core/module-engine'
import { VideoModule } from '@modules/base/video'
import { makePage, makeRegistry, makeSite } from './helpers'

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

interface PluginFixture {
  id?: string
  assets?: FrontendAsset[]
  origins?: PluginFrontendOrigins
  hosts?: string[]
  /** Ships a canvas module pack (`entrypoints.modules`). */
  modulePack?: boolean
  /** Omit the manifest's `frontend` block entirely. */
  noFrontend?: boolean
  granted?: string[]
  enabled?: boolean
  lifecycle?: 'active' | 'error'
}

/** A fake DB whose `installed_plugins` holds one row per fixture. */
function pluginsDb(fixtures: PluginFixture[]) {
  const rows = fixtures.map((fixture) => {
    const id = fixture.id ?? 'acme.assets'
    const permissions = [
      'frontend.assets',
      ...(fixture.hosts ? ['network.outbound'] : []),
      ...(fixture.modulePack ? ['modules.register'] : []),
    ]
    const manifest = {
      id,
      name: 'Asset fixtures',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      permissions,
      grantedPermissions: fixture.granted ?? permissions,
      resources: [],
      adminPages: [],
      ...(fixture.noFrontend
        ? {}
        : { frontend: { assets: fixture.assets ?? [], ...(fixture.origins ? { origins: fixture.origins } : {}) } }),
      ...(fixture.modulePack ? { entrypoints: { modules: 'modules/index.js' } } : {}),
      ...(fixture.hosts ? { networkAllowedHosts: fixture.hosts } : {}),
      assetBasePath: `/uploads/plugins/${id}/1.0.0`,
    }
    return {
      id,
      name: manifest.name,
      version: manifest.version,
      enabled: fixture.enabled ?? true,
      lifecycle_status: fixture.lifecycle ?? 'active',
      last_error: null,
      granted_permissions_json: manifest.grantedPermissions,
      manifest_json: manifest,
      settings_json: {},
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }
  })

  return createFakeDb(async (sql): Promise<DbResult> => {
    if (sql.includes('from installed_plugins')) return { rows, rowCount: rows.length }
    if (sql.includes('from active_media_storage_adapter')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected query in frontend asset fixture: ${sql}`)
  })
}

function frontendAssetDb(
  assets: FrontendAsset[],
  opts: Omit<PluginFixture, 'id' | 'assets'> = {},
) {
  return pluginsDb([{ assets, ...opts }])
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

  it('relaxes script-src to `self` + the script hash for inline scripts, never `unsafe-inline`', () => {
    const plan = emptyPlan()
    plan.hasInlineScript = true
    plan.inlineScriptHashes = ["'sha256-INLINE='"]
    plan.tags['body-end'] = [`<script>console.log('hi')</script>`]
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(directive(out, 'script-src')).toEqual(["'self'", "'sha256-INLINE='"])
    expect(out).toContain("worker-src 'self' blob:;")
  })

  it('relaxes script-src to `self` + the script hash for mixed external + inline plans', () => {
    const plan = emptyPlan()
    plan.hasExternalScript = true
    plan.hasInlineScript = true
    plan.inlineScriptHashes = ["'sha256-INLINE='"]
    plan.tags.head = [`<script>window.X=1</script>`]
    plan.tags['body-end'] = [`<script src="/uploads/plugins/x/1.0.0/frontend/t.js"></script>`]
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(directive(out, 'script-src')).toEqual(["'self'", "'sha256-INLINE='"])
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
    expect(directive(out, 'script-src')).toEqual(expect.arrayContaining([IMPORTMAP_HASH, hash]))
  })

  it('never grants `unsafe-inline` to scripts: only declared inline scripts run', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      { kind: 'script-inline', content: 'window.a = 1' },
      { kind: 'script', src: 'frontend/app.js' },
    ]))
    for (const page of [PAGE_WITH_IMPORTMAP, PAGE_WITH_CSP_META]) {
      expect(directive(injectFrontendAssets(page, plan), 'script-src')).not.toContain("'unsafe-inline'")
    }
  })

  it('hashes an inline script as the browser sees it: CRLF and lone CR become LF', async () => {
    // The HTML parser normalises newlines before the script's text exists, so
    // a hash over the raw CRLF bytes would never match and the script would
    // be blocked.
    const content = 'window.a = 1;\r\nwindow.b = 2;\rwindow.c = 3;\r\n'
    const plan = await collectFrontendInjections(frontendAssetDb([{ kind: 'script-inline', content }]))
    const out = injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)
    const emitted = /<script data-plugin-id="acme.assets">([\s\S]*?)<\/script>/.exec(out)?.[1] ?? ''
    expect(emitted).toBe('window.a = 1;\nwindow.b = 2;\nwindow.c = 3;\n')
    const browserHash = `'sha256-${createHash('sha256').update('window.a = 1;\nwindow.b = 2;\nwindow.c = 3;\n').digest('base64')}'`
    expect(plan.inlineScriptHashes).toEqual([browserHash])
    expect(directive(out, 'script-src')).toContain(browserHash)
  })

  it('leaves the policy alone for a data block, which a browser never executes', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      { kind: 'script-inline', content: '{"@context":"https://schema.org"}', attrs: { type: 'application/ld+json' } },
    ]))
    expect(plan.hasInlineScript).toBe(false)
    expect(plan.inlineScriptHashes).toEqual([])
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(out).toContain('application/ld+json')
    expect(out).toContain("script-src 'none'")
    expect(out).toContain("worker-src 'none'")
  })

  // "Prepare the script element" in the HTML standard decides what runs.
  it.each<[string, Record<string, string> | undefined]>([
    ['no attributes', undefined],
    ['an empty type', { type: '' }],
    ['text/javascript', { type: 'text/javascript' }],
    ['a JavaScript MIME type in another case', { type: 'Application/JavaScript' }],
    ['a legacy JavaScript MIME type', { type: 'text/jscript' }],
    ['ASCII whitespace around the type', { type: ' \t\ntext/javascript\f\r ' }],
    ['module', { type: 'module' }],
    ['module in another case, with whitespace', { type: ' MODULE ' }],
    ['importmap', { type: 'importmap' }],
    ['speculationrules', { type: 'speculationrules' }],
    ['an uppercase attribute name', { TYPE: 'module' }],
    ['a nomodule classic script', { nomodule: '' }],
    ['no type and an empty language', { language: '' }],
    ['no type and a JavaScript language', { language: 'JavaScript' }],
    ['the first of two type attributes', { type: 'module', TYPE: 'text/plain' }],
  ])('hashes an inline script a browser executes: %s', async (_label, attrs) => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      { kind: 'script-inline', content: 'window.a = 1', ...(attrs ? { attrs } : {}) },
    ]))
    expect(plan.hasInlineScript).toBe(true)
    expect(plan.inlineScriptHashes).toHaveLength(1)
  })

  it.each<[string, Record<string, string>]>([
    ['JSON-LD', { type: 'application/ld+json' }],
    ['plain JSON', { type: 'application/json' }],
    ['a template type', { type: 'text/template' }],
    ['a JavaScript type with parameters', { type: 'text/javascript; charset=utf-8' }],
    ['a whitespace-only type', { type: ' ' }],
    ['module with a non-ASCII space', { type: '\u00a0module' }],
    ['a misspelt module', { type: 'modules' }],
    ['no type and a non-JavaScript language', { language: 'vbscript' }],
    ['the first of two type attributes', { type: 'text/plain', TYPE: 'module' }],
  ])('leaves a data block unhashed: %s', async (_label, attrs) => {
    const plan = await collectFrontendInjections(frontendAssetDb([
      { kind: 'script-inline', content: 'window.a = 1', attrs },
    ]))
    expect(plan.hasInlineScript).toBe(false)
    expect(plan.inlineScriptHashes).toEqual([])
    expect(injectFrontendAssets(PAGE_WITH_CSP_META, plan)).toContain("script-src 'none'")
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

  it('lets an origins-only plugin reach its own hosts: connect-src needs no tag', async () => {
    // The third-party script a plugin module loads calls the provider's API.
    const plan = await collectFrontendInjections(frontendAssetDb([], { origins, hosts: ['api.example.com'] }))
    expect(plan.networkAllowedHosts).toEqual(['api.example.com'])
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(directive(out, 'connect-src')).toEqual(["'self'", 'https://api.example.com'])
  })

  it('lets a plugin with a module pack only (no tag, no origin) reach its own hosts', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb([], { hosts: ['api.example.com'], modulePack: true }))
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(directive(out, 'connect-src')).toEqual(["'self'", 'https://api.example.com'])
    expect(out).toContain("script-src 'none'")
  })

  it.each([
    ['an empty frontend block', {}],
    ['no frontend block at all', { noFrontend: true }],
  ])('leaves the page untouched for a plugin with server-side hosts only: %s', async (_label, shape) => {
    // Granted `frontend.assets`, but nothing of it can run in a browser.
    const plan = await collectFrontendInjections(frontendAssetDb([], { hosts: ['api.example.com'], ...shape }))
    expect(plan.networkAllowedHosts).toEqual([])
    expect(injectFrontendAssets(PAGE_WITH_CSP_META, plan)).toBe(PAGE_WITH_CSP_META)
    expect(injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)).toBe(PAGE_WITH_IMPORTMAP)
  })

  it('does not let a server-only plugin ride on another plugin\'s tag', async () => {
    const plan = await collectFrontendInjections(pluginsDb([
      { id: 'acme.tagged', assets: [{ kind: 'script', src: 'frontend/app.js' }] },
      { id: 'acme.server-only', hosts: ['api.example.com'] },
    ]))
    expect(plan.networkAllowedHosts).toEqual([])
  })

  it('never lets another plugin\'s tag open connect-src for a plugin without the grant', async () => {
    const plan = await collectFrontendInjections(pluginsDb([
      { id: 'acme.tagged', assets: [{ kind: 'script', src: 'frontend/app.js' }] },
      { id: 'acme.ungranted', origins, hosts: ['api.example.com'], granted: ['network.outbound'] },
    ]))
    expect(plan.networkAllowedHosts).toEqual([])
    expect(plan.scriptOrigins).toEqual([])
    const out = injectFrontendAssets(PAGE_WITH_CSP_META, plan)
    expect(directive(out, 'connect-src')).toEqual(["'self'"])
  })

  it('contributes nothing when the plugin is in the error state', async () => {
    const plan = await collectFrontendInjections(frontendAssetDb(
      [{ kind: 'script', src: 'https://js.example.com/v3' }],
      { origins, hosts: ['api.example.com'], lifecycle: 'error' },
    ))
    expect(injectFrontendAssets(PAGE_WITH_IMPORTMAP, plan)).toBe(PAGE_WITH_IMPORTMAP)
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

describe('frontend injection — on a page the publisher really emits', () => {
  it('unions plugin origins, hashes and hosts into the published policy without displacing it', async () => {
    const page = makePage({
      root: { moduleId: 'base.video', props: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    })
    const { html } = publishPage(page, makeSite(), makeRegistry({ 'base.video': VideoModule as AnyModuleDefinition }))
    const published = {
      frames: directive(html, 'frame-src'),
      styles: directive(html, 'style-src'),
      images: directive(html, 'img-src'),
    }
    expect(published.frames).toContain('https://www.youtube.com')

    const plan = await collectFrontendInjections(frontendAssetDb(
      [
        { kind: 'script', src: 'https://js.example.com/v3', placement: 'head', strategy: 'sync' },
        { kind: 'script-inline', content: 'window.pay = 1;\r\n' },
      ],
      { origins: { scripts: ['js.example.com'], frames: ['pay.example.com'] }, hosts: ['api.example.com'] },
    ))
    const out = injectFrontendAssets(html, plan)

    // What the publisher granted is all still there; the plugin's is added.
    expect(directive(out, 'frame-src')).toEqual([...published.frames, 'https://pay.example.com'].sort())
    expect(directive(out, 'style-src')).toEqual(published.styles)
    expect(directive(out, 'img-src')).toEqual(published.images)
    expect(directive(out, 'connect-src')).toEqual(["'self'", 'https://api.example.com'])
    const scripts = directive(out, 'script-src')
    const inlineHash = `'sha256-${createHash('sha256').update('window.pay = 1;\n').digest('base64')}'`
    expect(scripts).toEqual(expect.arrayContaining(["'self'", 'https://js.example.com', inlineHash]))
    expect(scripts).not.toContain("'unsafe-inline'")
    expect(scripts).not.toContain("'none'")

    // The head-placed third-party script sits below the policy that allows it.
    expect(out.indexOf('https://js.example.com/v3')).toBeGreaterThan(out.indexOf('http-equiv="Content-Security-Policy"'))
    expect(out).toContain('<script data-plugin-id="acme.assets">window.pay = 1;\n</script>')
  })
})
