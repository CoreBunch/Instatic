/**
 * Tokenised loop filters on the infinite-loop pagination endpoint.
 *
 * Page 1 of a loop is rendered with the page, and its `cellValue` tokens
 * resolve in `prefetchLoopData`. Page 2+ comes from `/_instatic/loop/<id>`,
 * outside any page render. That endpoint used to hand the RAW filters to the
 * source, so "Load more" queried for the literal text `{currentEntry.slug}`:
 * nothing with `is`, nearly the whole table with `isNot`. These pin that it
 * resolves against the page the visitor is on, and empties the loop when it
 * cannot.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { handleLoopRequest } from '../../../server/handlers/cms/loop'
import { resetForTests } from '../../../server/publish/renderCache'
import { createFakeDb } from './dbTestFake'
import { makePage, makeSite } from '../publisher/helpers'

import '../../../src/modules/base'
import '@core/loops/sources'

function siteWithLoop(cellValue: string, cellOperator = 'is') {
  const page = {
    ...makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        props: {
          sourceId: 'data.rows',
          filters: { tableId: 'terms', cellField: 'course', cellOperator, cellValue },
          orderBy: 'publishedAt',
          direction: 'desc',
          pagination: 'infinite',
          pageSize: 1,
          limit: 1,
          offset: 0,
        },
        children: ['item'],
      },
      item: { moduleId: 'base.text', props: { text: 'term' } },
    }),
    slug: 'kurzy',
    title: 'Kurzy',
  }
  return makeSite({ pages: [page] })
}

/**
 * Serves the published site to the loop index and to a page-by-slug lookup
 * for its one page, a `data` table for the source, and a table of three rows.
 * Records whether the source reached the table at all.
 */
function publishedDb(site: ReturnType<typeof makeSite>) {
  const params: unknown[][] = []
  let sourceQueried = false
  const db = createFakeDb(async (sql, args): Promise<DbResult> => {
    if (sql.includes('site_snapshots.site_json')) {
      // The page-by-slug lookup answers only for the page that exists.
      const bySlug = sql.includes('data_rows.slug =')
      if (bySlug && !(args ?? []).includes(site.pages[0]!.slug)) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          row_id: site.pages[0]!.id,
          site_json: site,
          runtime_assets_json: null,
          importmap_body: null,
          importmap_sha256: null,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('from data_tables')) {
      sourceQueried = true
      return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
    }
    params.push(args ?? [])
    if (sql.includes('count(*)')) return { rows: [{ total: 3 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  return { db, params, sourceQueried: () => sourceQueried }
}

async function loadMore(db: ReturnType<typeof createFakeDb>, pagePath = '/kurzy') {
  const url = new URL(`http://localhost/_instatic/loop/loop?page=2&pagePath=${encodeURIComponent(pagePath)}`)
  const res = await handleLoopRequest(new Request(url), url, { db })
  return { status: res.status, body: await res.json() as { html: string; hasMore: boolean } }
}

beforeEach(() => {
  // Clears the version-keyed snapshot and loop-index memos between tests.
  resetForTests()
})

describe('loop pagination endpoint: tokenised filters', () => {
  it('resolves a filter token against the page the visitor is on', async () => {
    const { db, params } = publishedDb(siteWithLoop('{page.slug}'))

    const { status } = await loadMore(db)

    expect(status).toBe(200)
    expect(params.some((args) => args.includes('kurzy'))).toBe(true)
    expect(params.some((args) => args.includes('{page.slug}'))).toBe(false)
  })

  it('renders nothing instead of the whole table when a token cannot resolve', async () => {
    // A plain page has no entry in scope. With `isNot`, the literal token
    // would match every row of the table — the spill the guard exists for.
    const { db, sourceQueried } = publishedDb(siteWithLoop('{currentEntry.slug}', 'isNot'))

    const { status, body } = await loadMore(db)

    expect(status).toBe(200)
    expect(body).toMatchObject({ html: '', hasMore: false })
    expect(sourceQueried()).toBe(false)
  })

  it('renders nothing when the visitor path resolves to no published page', async () => {
    const { db, sourceQueried } = publishedDb(siteWithLoop('{page.slug}'))

    const { body } = await loadMore(db, '/missing/page')

    expect(body).toMatchObject({ html: '', hasMore: false })
    expect(sourceQueried()).toBe(false)
  })

  it('leaves an untokenised filter alone and skips the route lookup', async () => {
    const { db, params } = publishedDb(siteWithLoop('time-management'))

    const { status } = await loadMore(db, '/missing/page')

    expect(status).toBe(200)
    expect(params.some((args) => args.includes('time-management'))).toBe(true)
  })
})
