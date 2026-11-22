/**
 * Tests for the `/_instatic/module-js/<moduleId>.js` asset endpoint.
 * Fake DbClient intercepts the published-snapshot query — same pattern as
 * holeRouteHandler.test.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import {
  handleModuleJsAssetRequest,
  isModuleJsAssetPath,
} from '../../../server/handlers/cms/moduleJs'
import { resetForTests } from '../../../server/publish/renderCache'
import { assetContentVersion } from '../../../server/publish/assetVersion'
import { makeModule } from '../publisher/helpers'
import { registry } from '../../core/module-engine/registry'

const TEST_RUNTIME_JS = '(function(){/* test runtime */})();'

function makeSnapshot() {
  return {
    cmsSnapshotVersion: 1 as const,
    pageRowId: 'page_1',
    site: {
      id: 'site_1',
      name: 'Test Site',
      pages: [
        {
          id: 'page_1',
          title: 'Test Page',
          slug: 'test',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'test.body',
              props: {},
              breakpointOverrides: {},
              children: ['widget'],
              classIds: [],
            },
            widget: {
              id: 'widget',
              moduleId: 'test.jsy',
              props: {},
              breakpointOverrides: {},
              children: [],
              classIds: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { metaTitle: 'Test', shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
      packageJson: { dependencies: {}, devDependencies: {} },
      runtime: {
        dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
        scripts: {},
      },
    },
  }
}

function makeFakeDb(snapshot: ReturnType<typeof makeSnapshot> | null): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    // The snapshot getters join site_snapshots and reassemble the
    // PublishedPageSnapshot shape from this row (see repositories/publish.ts).
    if (normalized.includes('site_snapshots.site_json')) {
      return {
        rows: snapshot
          ? [{
              row_id: snapshot.pageRowId,
              site_json: snapshot.site,
              runtime_assets_json: null,
              importmap_body: null,
              importmap_sha256: null,
            } as unknown as Row]
          : [],
        rowCount: snapshot ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return handle as DbClient
}

function moduleJsRequest(path: string, method = 'GET', headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`http://localhost${path}`)
  return [new Request(url, { method, headers }), url]
}

beforeEach(() => {
  resetForTests()
  registry.registerOrReplace(
    makeModule('test.body', {
      canHaveChildren: true,
      render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
    }),
  )
  registry.registerOrReplace(
    makeModule('test.jsy', {
      render: () => ({ html: '<div></div>', js: TEST_RUNTIME_JS }),
    }),
  )
})

describe('isModuleJsAssetPath', () => {
  it('matches the namespace prefix only', () => {
    expect(isModuleJsAssetPath('/_instatic/module-js/test.jsy.js')).toBe(true)
    expect(isModuleJsAssetPath('/_instatic/module-js/')).toBe(true)
    expect(isModuleJsAssetPath('/_instatic/module-js')).toBe(false)
    expect(isModuleJsAssetPath('/_instatic/hole-runtime.js')).toBe(false)
  })
})

describe('handleModuleJsAssetRequest', () => {
  it('serves a known module with text/javascript and a 1h public cache under its content-hash URL', async () => {
    const version = assetContentVersion(TEST_RUNTIME_JS)
    const [req, url] = moduleJsRequest(`/_instatic/module-js/test.jsy.js?v=${version}`)
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(res.headers.get('etag')).toBe(`"${version}"`)
    expect(await res.text()).toBe(TEST_RUNTIME_JS)
  })

  it('serves the current body uncached when ?v= does not name it', async () => {
    // A page baked before the script changed, a legacy counter URL, no ?v=.
    for (const query of ['?v=000000000000', '?v=0', '']) {
      const [req, url] = moduleJsRequest(`/_instatic/module-js/test.jsy.js${query}`)
      const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(res.headers.get('etag')).toBe(`"${assetContentVersion(TEST_RUNTIME_JS)}"`)
      expect(await res.text()).toBe(TEST_RUNTIME_JS)
    }
  })

  it('answers 304 with no body when If-None-Match names the body, on a stale and on a current URL', async () => {
    const version = assetContentVersion(TEST_RUNTIME_JS)
    const cases: Array<[query: string, ifNoneMatch: string, cacheControl: string]> = [
      // A page baked before an upgrade: revalidates instead of re-downloading.
      ['?v=000000000000', `"${version}"`, 'no-cache'],
      ['', `W/"${version}"`, 'no-cache'],
      ['?v=0', `"other", W/"${version}"`, 'no-cache'],
      [`?v=${version}`, `"${version}"`, 'public, max-age=3600'],
    ]
    for (const [query, ifNoneMatch, cacheControl] of cases) {
      const [req, url] = moduleJsRequest(`/_instatic/module-js/test.jsy.js${query}`, 'GET', {
        'if-none-match': ifNoneMatch,
      })
      const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
      expect(res.status).toBe(304)
      expect(res.headers.get('etag')).toBe(`"${version}"`)
      expect(res.headers.get('cache-control')).toBe(cacheControl)
      expect(await res.text()).toBe('')
    }
  })

  it('serves the full body when If-None-Match names another body', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js?v=000000000000', 'GET', {
      'if-none-match': '"000000000000"',
    })
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toBe(TEST_RUNTIME_JS)
  })

  it('404s for a moduleId with no published js', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.body.js')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(404)
  })

  it('404s for malformed / traversal-shaped ids without touching the map', async () => {
    for (const path of [
      '/_instatic/module-js/..%2F..%2Fetc%2Fpasswd.js',
      '/_instatic/module-js/UPPER.Case.js',
      '/_instatic/module-js/no-namespace.js',
      '/_instatic/module-js/test.jsy', // missing .js extension
      '/_instatic/module-js/',
    ]) {
      const [req, url] = moduleJsRequest(path)
      const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
      expect(res.status).toBe(404)
    }
  })

  it('404s when the site has never been published', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(null) })
    expect(res.status).toBe(404)
  })

  it('405s non-GET methods', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js', 'POST')
    const res = await handleModuleJsAssetRequest(req, url, { db: makeFakeDb(makeSnapshot()) })
    expect(res.status).toBe(405)
  })
})
