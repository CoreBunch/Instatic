/**
 * Tests for the `/_instatic/assets/loop-runtime.js` asset endpoint: the body,
 * the cache rule keyed on `?v=`, and `ETag` / `304` revalidation.
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import { isLoopRuntimeAssetPath, serveLoopRuntimeAsset } from '../../../server/handlers/cms/loop'
import { LOOP_RUNTIME_JS, LOOP_RUNTIME_VERSION } from '../../../server/publish/loopRuntime'
import { assetContentVersion } from '../../../server/publish/assetVersion'
import { handleServerRequest } from '../../../server/router'

function loopRuntimeRequest(query = '', headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`http://localhost/_instatic/assets/loop-runtime.js${query}`)
  return [new Request(url, { headers }), url]
}

function makeThrowingDb(): { db: DbClient; wasQueried: () => boolean } {
  let queried = false
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    queried = true
    throw new Error('unexpected database query while serving the loop runtime')
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return { db: handle as DbClient, wasQueried: () => queried }
}

describe('isLoopRuntimeAssetPath', () => {
  it('matches the exact asset path only', () => {
    expect(isLoopRuntimeAssetPath('/_instatic/assets/loop-runtime.js')).toBe(true)
    expect(isLoopRuntimeAssetPath('/_instatic/loop-runtime.js')).toBe(false)
    expect(isLoopRuntimeAssetPath('/_instatic/loop/some-loop')).toBe(false)
  })
})

describe('serveLoopRuntimeAsset', () => {
  it('versions the runtime by its content', () => {
    expect(LOOP_RUNTIME_VERSION).toBe(assetContentVersion(LOOP_RUNTIME_JS))
  })

  it('serves LOOP_RUNTIME_JS with a 1h public cache under the URL that names it', async () => {
    const res = serveLoopRuntimeAsset(...loopRuntimeRequest(`?v=${LOOP_RUNTIME_VERSION}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(res.headers.get('etag')).toBe(`"${LOOP_RUNTIME_VERSION}"`)
    expect(await res.text()).toBe(LOOP_RUNTIME_JS)
  })

  it('serves the runtime uncached when ?v= does not name it', async () => {
    // A page baked before an upgrade, and the unversioned tag older pages carry.
    for (const query of ['?v=000000000000', '']) {
      const res = serveLoopRuntimeAsset(...loopRuntimeRequest(query))
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(res.headers.get('etag')).toBe(`"${LOOP_RUNTIME_VERSION}"`)
      expect(await res.text()).toBe(LOOP_RUNTIME_JS)
    }
  })

  it('answers 304 with no body when If-None-Match names the runtime', async () => {
    const cases: Array<[query: string, ifNoneMatch: string, cacheControl: string]> = [
      ['', `"${LOOP_RUNTIME_VERSION}"`, 'no-cache'],
      ['?v=000000000000', `"other", W/"${LOOP_RUNTIME_VERSION}"`, 'no-cache'],
      [`?v=${LOOP_RUNTIME_VERSION}`, `W/"${LOOP_RUNTIME_VERSION}"`, 'public, max-age=3600'],
    ]
    for (const [query, ifNoneMatch, cacheControl] of cases) {
      const res = serveLoopRuntimeAsset(...loopRuntimeRequest(query, { 'if-none-match': ifNoneMatch }))
      expect(res.status).toBe(304)
      expect(res.headers.get('etag')).toBe(`"${LOOP_RUNTIME_VERSION}"`)
      expect(res.headers.get('cache-control')).toBe(cacheControl)
      expect(await res.text()).toBe('')
    }
  })

  it('serves the full body when If-None-Match names another body', async () => {
    const res = serveLoopRuntimeAsset(...loopRuntimeRequest('', { 'if-none-match': '"000000000000"' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(LOOP_RUNTIME_JS)
  })
})

describe('server router: loop runtime asset', () => {
  it('serves the runtime, passing the request through for the cache rule', async () => {
    const { db, wasQueried } = makeThrowingDb()

    const fresh = await handleServerRequest(
      new Request(`http://localhost/_instatic/assets/loop-runtime.js?v=${LOOP_RUNTIME_VERSION}`),
      { db },
    )
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(await fresh.text()).toBe(LOOP_RUNTIME_JS)

    const revalidated = await handleServerRequest(
      new Request('http://localhost/_instatic/assets/loop-runtime.js', {
        headers: { 'if-none-match': `"${LOOP_RUNTIME_VERSION}"` },
      }),
      { db },
    )
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('cache-control')).toBe('no-cache')
    expect(wasQueried()).toBe(false)
  })
})
