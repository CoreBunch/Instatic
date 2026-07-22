import { describe, expect, it } from 'bun:test'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import type { SiteDocument } from '@core/page-tree'
import '@core/loops/sources'
import '@modules/base'

function makeFakeDb(): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      return {
        rows: [{
          id: 'admin_1',
          email: 'owner@example.com',
          email_normalized: 'owner@example.com',
          display_name: 'Owner',
          password_hash: 'hash',
          status: 'active',
          role_id: 'owner',
          last_login_at: null,
          created_at: new Date('2026-01-01').toISOString(),
          updated_at: new Date('2026-01-01').toISOString(),
          deleted_at: null,
          role_slug: 'owner',
          role_name: 'Owner',
          role_description: '',
          role_is_system: true,
          role_capabilities_json: ['runtime.dependencies', 'site.read', 'pages.edit'],
        } as Row],
        rowCount: 1,
      }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }
    // `buildRuntimePreviewDocument` now mirrors the published-page path
    // and queries enabled plugins so frontend script tags + CSP relaxations
    // match what visitors will see. The preview tests don't install any
    // plugin, so an empty result is the right answer.
    if (normalized.includes('from installed_plugins')) {
      return { rows: [], rowCount: 0 }
    }
    // `collectFrontendInjections` reads elected media storage adapters so
    // their declared CSP origins can extend `img-src` / `media-src` in
    // the preview iframe's CSP. No adapter is elected in these tests, so
    // an empty result lands the preview on the local-disk defaults.
    if (normalized.includes('from active_media_storage_adapter')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.unsafe = async <Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> =>
    handle<Row>(sql.split(/\$\d+|\?/) as unknown as TemplateStringsArray, ...params)

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

function runtimeRequest(url: string, body: unknown): Request {
  return {
    method: 'POST',
    url,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'cookie') return `${SESSION_COOKIE_NAME}=session-token`
        if (name.toLowerCase() === 'content-type') return 'application/json'
        return null
      },
    },
    json: async () => body,
  } as unknown as Request
}

function site(): SiteDocument {
  return {
    id: 'site_1',
    name: 'Runtime Preview',
    pages: [
      {
        id: 'page_1',
        title: 'Home',
        slug: 'index',
        rootNodeId: 'root',
        nodes: {
          root: {
            id: 'root',
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: [],
          },
        },
      },
    ],
    files: [],
    visualComponents: [],
    packageJson: { dependencies: {}, devDependencies: {} },
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: {
      colorTokens: {},
      shortcuts: {},
    },
    styleRules: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function siteWithVC(): SiteDocument {
  const base = site()
  return {
    ...base,
    visualComponents: [
      {
        id: 'vc_hero',
        name: 'Hero',
        tree: {
          rootNodeId: 'vc_root',
          nodes: {
            vc_root: {
              id: 'vc_root',
              moduleId: 'base.body',
              props: {},
              breakpointOverrides: {},
              children: [],
            },
          },
        },
        params: [],
        breakpoints: [],
        createdAt: 1,
      },
    ],
  }
}

function siteWithLoop(): SiteDocument {
  const base = site()
  return {
    ...base,
    pages: [
      {
        ...base.pages[0],
        nodes: {
          root: {
            id: 'root',
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: ['loop'],
          },
          loop: {
            id: 'loop',
            moduleId: 'base.loop',
            props: {
              sourceId: 'site.pages',
              filters: {},
              orderBy: 'definition',
              direction: 'asc',
              limit: 10,
              offset: 0,
              pagination: 'none',
              pageSize: 10,
              tag: 'div',
              customTag: '',
            },
            breakpointOverrides: {},
            children: ['loop_text'],
          },
          loop_text: {
            id: 'loop_text',
            moduleId: 'base.text',
            props: { text: 'Fallback' },
            dynamicBindings: {
              text: { source: 'currentEntry', field: 'title' },
            },
            breakpointOverrides: {},
            children: [],
          },
        },
      },
      {
        id: 'page_loop_item',
        title: 'ISS-234 SERVER LOOP ROW',
        slug: 'loop-row',
        rootNodeId: 'loop_item_root',
        nodes: {
          loop_item_root: {
            id: 'loop_item_root',
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: [],
          },
        },
      },
    ],
  }
}

describe('CMS runtime handlers', () => {
  it('resolves an empty runtime dependency manifest', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/admin/api/cms/runtime/dependencies/resolve',
      { packageJson: { dependencies: {}, devDependencies: {} } },
    ), makeFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      dependencyLock: { version: 1, packages: {} },
    })
  })

  it('normalizes unsafe and non-runtime dependency manifest entries before resolving', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/admin/api/cms/runtime/dependencies/resolve',
      {
        packageJson: {
          dependencies: {
            'bad;pkg': '^1.0.0',
            '': '^1.0.0',
            'canvas-confetti': '',
            motion: 12,
          },
          devDependencies: {
            vite: '^7.0.0',
          },
        },
      },
    ), makeFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      dependencyLock: {
        version: 1,
        packages: {},
        updatedAt: expect.any(Number),
      },
    })
  })

  it('builds a runtime preview document for a provided site and page', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/admin/api/cms/runtime/preview',
      { site: site(), pageId: 'page_1' },
    ), makeFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      html: expect.stringContaining('<!DOCTYPE html>'),
      assets: [],
      runtimeAssets: { scripts: [] },
      diagnostics: [],
    })
  })

  it('prefetches and renders loop rows in the runtime preview (ISS-234)', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/admin/api/cms/runtime/preview',
      { site: siteWithLoop(), pageId: 'page_1' },
    ), makeFakeDb())

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('ISS-234 SERVER LOOP ROW')
    expect(body).not.toContain('instatic: loop data missing')
  })

  it('builds a runtime preview from a VC virtual page id when the editor is in VC canvas mode', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/admin/api/cms/runtime/preview',
      { site: siteWithVC(), pageId: 'vc-virtual:vc_hero' },
    ), makeFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      html: expect.stringContaining('<!DOCTYPE html>'),
      diagnostics: [],
    })
  })

  it('returns 404 for an unknown VC virtual page id', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/admin/api/cms/runtime/preview',
      { site: siteWithVC(), pageId: 'vc-virtual:unknown_vc' },
    ), makeFakeDb())

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'Page not found' })
  })
})
