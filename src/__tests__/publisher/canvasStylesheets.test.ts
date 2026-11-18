/**
 * Canvas plugin stylesheets — the editing canvas's share of the frontend
 * asset plan. Locks in:
 *
 *   1. Only `style` / `style-inline` assets reach the canvas; scripts, bare
 *      links and meta tags never do.
 *   2. The same plugins contribute as on a published page (granted
 *      `frontend.assets`, enabled, not errored), in the same order.
 *   3. External stylesheets arrive as text with relative URLs rebased.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_API_VERSION, type FrontendAsset } from '@core/plugin-sdk'
import type { DbResult } from '../../../server/db'
import {
  collectCanvasPluginStylesheets,
  rebaseCssUrls,
} from '../../../server/publish/canvasStylesheets'
import { collectFrontendInjections } from '../../../server/publish/frontendInjections'
import { createFakeDb } from '../server/dbTestFake'

interface PluginFixture {
  id: string
  assets: FrontendAsset[]
  permissions?: string[]
  grantedPermissions?: string[]
  enabled?: boolean
  lifecycleStatus?: string
}

function pluginsDb(plugins: PluginFixture[]) {
  return createFakeDb(async (sql): Promise<DbResult> => {
    if (sql.includes('from installed_plugins')) {
      return {
        rows: plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.id,
          version: '1.0.0',
          enabled: plugin.enabled ?? true,
          lifecycle_status: plugin.lifecycleStatus ?? 'active',
          last_error: null,
          granted_permissions_json: plugin.grantedPermissions ?? ['frontend.assets'],
          manifest_json: {
            id: plugin.id,
            name: plugin.id,
            version: '1.0.0',
            apiVersion: PLUGIN_API_VERSION,
            permissions: plugin.permissions ?? ['frontend.assets'],
            resources: [],
            adminPages: [],
            frontend: { assets: plugin.assets },
            assetBasePath: `/uploads/plugins/${plugin.id}/1.0.0`,
          },
          settings_json: {},
          installed_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        })),
        rowCount: plugins.length,
      }
    }
    if (sql.includes('from active_media_storage_adapter')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected query in canvas stylesheet fixture: ${sql}`)
  })
}

let uploadsDir = ''

async function writePluginFile(pluginId: string, path: string, content: string): Promise<void> {
  const fullPath = join(uploadsDir, 'plugins', pluginId, '1.0.0', path)
  await mkdir(join(fullPath, '..'), { recursive: true })
  await writeFile(fullPath, content)
}

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-canvas-stylesheets-'))
})

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

describe('collectCanvasPluginStylesheets', () => {
  it('returns external and inline stylesheets and leaves every other asset kind out', async () => {
    await writePluginFile('acme.kinds', 'frontend/widget.css', '.widget { color: red; }')
    const stylesheets = await collectCanvasPluginStylesheets(pluginsDb([{
      id: 'acme.kinds',
      assets: [
        { kind: 'script', src: 'frontend/tracker.js' },
        { kind: 'script-inline', content: 'window.tracked = true', placement: 'head' },
        { kind: 'style', href: 'frontend/widget.css', attrs: { media: 'screen' } },
        { kind: 'style-inline', content: '.inline { color: blue; }' },
        { kind: 'link', attrs: { rel: 'stylesheet', href: 'https://cdn.example.com/x.css' } },
        { kind: 'meta', attrs: { name: 'acme', content: 'on' } },
      ],
    }]), uploadsDir)

    expect(stylesheets).toEqual([
      { pluginId: 'acme.kinds', position: 'after-site', media: 'screen', css: '.widget { color: red; }' },
      { pluginId: 'acme.kinds', position: 'after-site', css: '.inline { color: blue; }' },
    ])
  })

  it('checks the granted permission, not the declared one', async () => {
    const asset: FrontendAsset = { kind: 'style-inline', content: 'p { color: red; }' }
    const db = pluginsDb([
      { id: 'acme.declared-only', assets: [asset], permissions: ['frontend.assets'], grantedPermissions: [] },
      { id: 'acme.disabled', assets: [asset], enabled: false },
      { id: 'acme.errored', assets: [asset], lifecycleStatus: 'error' },
      { id: 'acme.granted', assets: [asset] },
    ])

    const stylesheets = await collectCanvasPluginStylesheets(db, uploadsDir)

    expect(stylesheets.map((stylesheet) => stylesheet.pluginId)).toEqual(['acme.granted'])
  })

  it('orders stylesheets the way the published page emits them', async () => {
    const plugins: PluginFixture[] = [
      {
        id: 'zeta.styles',
        assets: [
          { kind: 'style-inline', content: '/* zeta body-end */', placement: 'body-end' },
          { kind: 'style-inline', content: '/* zeta head */', placement: 'head' },
        ],
      },
      {
        id: 'alpha.styles',
        assets: [
          { kind: 'style-inline', content: '/* alpha head-end 1 */' },
          { kind: 'style-inline', content: '/* alpha body-start */', placement: 'body-start' },
          { kind: 'style-inline', content: '/* alpha head-end 2 */' },
        ],
      },
    ]

    const stylesheets = await collectCanvasPluginStylesheets(pluginsDb(plugins), uploadsDir)
    const published = await collectFrontendInjections(pluginsDb(plugins))
    const publishedOrder = [
      ...published.tags.head,
      ...published.tags['head-end'],
      ...published.tags['body-start'],
      ...published.tags['body-end'],
    ]

    expect(stylesheets.map((stylesheet) => stylesheet.css)).toEqual([
      '/* zeta head */',
      '/* alpha head-end 1 */',
      '/* alpha head-end 2 */',
      '/* alpha body-start */',
      '/* zeta body-end */',
    ])
    // Parity: every canvas stylesheet appears in the published plan, in the same order.
    // Each published tag is parsed as markup and its text read back, so the
    // comparison is on the stylesheet body, not on a string-munged tag.
    const publishedCss = publishedOrder.map((tag) => {
      const template = document.createElement('template')
      template.innerHTML = tag
      return template.content.textContent
    })
    expect(publishedCss).toEqual(
      stylesheets.map((stylesheet) => stylesheet.css),
    )
    expect(stylesheets.map((stylesheet) => stylesheet.position)).toEqual([
      'before-site',
      'after-site',
      'after-site',
      'after-site',
      'after-site',
    ])
  })

  it('skips an external stylesheet whose file is missing instead of failing the plan', async () => {
    const stylesheets = await collectCanvasPluginStylesheets(pluginsDb([{
      id: 'acme.missing',
      assets: [
        { kind: 'style', href: 'frontend/gone.css' },
        { kind: 'style-inline', content: 'p { color: red; }' },
      ],
    }]), uploadsDir)

    expect(stylesheets.map((stylesheet) => stylesheet.css)).toEqual(['p { color: red; }'])
  })

  it('rebases relative references in an external stylesheet onto its own URL', async () => {
    await writePluginFile('acme.urls', 'frontend/css/theme.css', '.hero { background: url(../img/hero.png); }')
    const [stylesheet] = await collectCanvasPluginStylesheets(pluginsDb([{
      id: 'acme.urls',
      assets: [{ kind: 'style', href: 'frontend/css/theme.css' }],
    }]), uploadsDir)

    expect(stylesheet?.css).toBe(
      '.hero { background: url("/uploads/plugins/acme.urls/1.0.0/frontend/img/hero.png"); }',
    )
  })
})

describe('rebaseCssUrls', () => {
  const base = '/uploads/plugins/acme/1.0.0/frontend/x.css'

  it('rewrites bare, quoted and @import references', () => {
    expect(rebaseCssUrls(
      `@import "reset.css"; a { background: url('img/a.png') } b { mask: url( img/b.svg#m ) }`,
      base,
    )).toBe(
      '@import "/uploads/plugins/acme/1.0.0/frontend/reset.css"; '
      + 'a { background: url("/uploads/plugins/acme/1.0.0/frontend/img/a.png") } '
      + 'b { mask: url("/uploads/plugins/acme/1.0.0/frontend/img/b.svg#m") }',
    )
  })

  it('leaves absolute, data, fragment and remote references alone', () => {
    const css = 'a { background: url("/uploads/x.png"), url("data:image/png;base64,AAAA"), url("#clip"), url("https://cdn.example.com/y.png") }'
    expect(rebaseCssUrls(css, base)).toBe(css)
  })

  it('does not touch url( text inside comments or strings', () => {
    const css = '/* url(skip.png) */ a::after { content: "url(skip.png)" }'
    expect(rebaseCssUrls(css, base)).toBe(css)
  })
})
