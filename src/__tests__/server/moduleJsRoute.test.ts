/**
 * Tests for the `/_instatic/module-js/<moduleId>.js` asset endpoint.
 * Fake DbClient intercepts the published-snapshot query — same pattern as
 * holeRouteHandler.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
afterEach(cleanupPublishingTestDbs)
import {
  handleModuleJsAssetRequest,
  isModuleJsAssetPath,
} from '../../../server/handlers/cms/moduleJs'
import { resetForTests } from '../../../server/publish/renderCache'
import { makeModule } from '../publisher/helpers'
import { registry } from '../../core/module-engine/registry'

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

function moduleJsRequest(path: string, method = 'GET'): [Request, URL] {
  const url = new URL(`http://localhost${path}`)
  url.searchParams.set('u', '/test')
  return [new Request(url, { method }), url]
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
      render: () => ({ html: '<div></div>', js: '(function(){/* test runtime */})();' }),
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
  it('serves a known module with text/javascript and a 1h public cache', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js?v=0')
    const res = await handleModuleJsAssetRequest(req, url, { db: await createPublishingTestDb(makeSnapshot().site) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(await res.text()).toContain('test runtime')
  })

  it('404s for a moduleId with no published js', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.body.js')
    const res = await handleModuleJsAssetRequest(req, url, { db: await createPublishingTestDb(makeSnapshot().site) })
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
      const res = await handleModuleJsAssetRequest(req, url, { db: await createPublishingTestDb(makeSnapshot().site) })
      expect(res.status).toBe(404)
    }
  })

  it('404s when the site has never been published', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js')
    const res = await handleModuleJsAssetRequest(req, url, { db: await createPublishingTestDb(null) })
    expect(res.status).toBe(404)
  })

  it('405s non-GET methods', async () => {
    const [req, url] = moduleJsRequest('/_instatic/module-js/test.jsy.js', 'POST')
    const res = await handleModuleJsAssetRequest(req, url, { db: await createPublishingTestDb(makeSnapshot().site) })
    expect(res.status).toBe(405)
  })
})
