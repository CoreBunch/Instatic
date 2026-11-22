/**
 * The fragment endpoints render from the composed page a visitor was served:
 * the page spliced into its layouts. Page content under a layout carries the
 * composition prefix (`c0_<id>`), and a layout element around the outlet
 * holds the page there.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, SiteShell } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopEntitySource, SourceFetchContext } from '@core/loops/types'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const SOURCE = 'test.composed.items'
type Node = Page['nodes'][string]

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []): Node {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] } as Node
}

function pageOf(id: string, slug: string, nodes: Node[], template?: Page['template']): Page {
  return {
    id, title: slug, slug, rootNodeId: `${id}_root`,
    nodes: Object.fromEntries([node(`${id}_root`, 'base.body', {}, nodes.filter((n) => n.id.endsWith('__top')).map((n) => n.id)), ...nodes].map((n) => [n.id, n])),
    ...(template ? { template } : {}),
  } as Page
}

const source: LoopEntitySource = {
  id: SOURCE,
  label: SOURCE,
  filterSchema: {},
  orderByOptions: [],
  fields: [{ id: 'label', label: 'Label' }],
  fetch: async (ctx: SourceFetchContext) => {
    const items = ['one', 'two', 'three'].map((label) => ({ id: label, fields: { label } }))
    return { items: items.slice(ctx.offset, ctx.offset + ctx.limit), totalItems: items.length }
  },
  preview: () => [],
}

describe('fragments of a page inside a site-wide layout', () => {
  let t: TestDb
  let uploadsDir: string

  beforeEach(async () => {
    resetForTests()
    loopSourceRegistry.registerOrReplace(source)
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'holes-composed-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
    const shell: SiteShell = {
      id: 'site_1', name: 'Composed Site', files: [], visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { shortcuts: {} }, styleRules: {}, packageJson: { dependencies: {}, devDependencies: {} },
      runtime: normalizeSiteRuntimeConfig(undefined), createdAt: 1000, updatedAt: 2000,
    }
    await saveDraftSite(t.db, MAIN_SCOPE, shell)
    const layout = pageOf('lay', 'layout', [
      // A wrapper around the outlet that is a fragment of its own: it shows the address's query.
      node('lay_main__top', 'base.container', { htmlAttributes: { 'data-q': '{route.query.f}' } }, ['lay_outlet']),
      node('lay_outlet', 'base.outlet', {}),
    ], { enabled: true, target: { kind: 'everywhere' }, priority: 0 })
    const home = pageOf('home', 'index', [
      node('home_q__top', 'base.text', { text: 'QUERY[{route.query.f}]', tag: 'p' }),
      node('home_list__top', 'base.loop', {
        sourceId: SOURCE, filters: {}, orderBy: '', limit: 10, offset: 0,
        pagination: 'infinite', pageSize: 1, tag: 'div', customTag: '',
      }, ['home_item']),
      node('home_item', 'base.text', { text: 'ITEM[{currentEntry.label}] ROUTE[{route.query.f}]', tag: 'p' }),
    ])
    for (const page of [layout, home]) {
      await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
    }
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
  })

  afterEach(async () => {
    loopSourceRegistry.unregister(SOURCE)
    await t.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  const get = (path: string) => handleServerRequest(new Request(`http://localhost${path}`), { db: t.db, uploadsDir })

  async function hole(id: string, u: string): Promise<Response> {
    const site = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
    return get(`/_instatic/hole/${encodeURIComponent(id)}?v=${site!.snapshotHash}&u=${encodeURIComponent(u)}`)
  }

  it('serves a page element by the id the page was served with', async () => {
    const served = await (await get('/?f=hi')).text()
    // The wrapper around the outlet is the fragment; the page content is inside it.
    expect(served).toContain('data-instatic-hole="lay_main__top"')
    const res = await hole('lay_main__top', '/?f=hi')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-q="hi"')
    expect(html).toContain('QUERY[hi]')
  })

  it('renders a composed page node on its own', async () => {
    const res = await hole('c0_home_q__top', '/?f=there')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('QUERY[there]')
  })

  it('does not serve a node from a route it is not on', async () => {
    expect((await hole('c0_home_q__top', '/missing-page')).status).toBe(404)
  })

  it('loads the next page of a list in the page content', async () => {
    const shell = await (await get('/?f=hi')).text()
    expect(shell).toContain('/_instatic/assets/loop-runtime.js')
    const wrapper = await (await hole('lay_main__top', '/?f=hi')).text()
    expect(wrapper).toContain('ITEM[one]')
    const id = wrapper.match(/data-instatic-loop="([^"]+)"/)?.[1]
    expect(id).toBeDefined()
    for (const [pageNumber, label, hasMore] of [[2, 'two', true], [3, 'three', false]] as const) {
      const res = await get(`/_instatic/loop/${encodeURIComponent(id!)}?page=${pageNumber}&pagePath=%2F%3Ff%3Dhi`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({ pageNumber, hasMore })
      expect(body.html).toContain(`ITEM[${label}]`)
      expect(body.html).toContain('ROUTE[hi]')
    }
  })
})
