/**
 * Hidden nodes: what the publish prefetches is what it renders.
 *
 * `walkRenderTree` decides which loops are fetched and which media are looked
 * up before a page renders. It must stop exactly where the renderer does: at
 * a hidden node, and not at a hidden slot instance, whose children the
 * renderer grafts into the component's slot outlet regardless. The fixture
 * holds every case, and the page is published for real.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registry } from '@core/module-engine'
import type { Page, SiteDocument, SiteShell } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops'
import type { LoopEntitySource, SourceFetchContext } from '@core/loops/types'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import type { DbClient } from '../../../server/db/client'
import { collectLoopNodes } from '../../../server/publish/loopPrefetch'
import { prefetchMediaAssets } from '../../../server/publish/mediaPrefetch'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow } from '../../../server/repositories/data'
import { getDraftSiteDocument } from '../../../server/repositories/publish'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const SOURCE = 'test.hidden.items'

type Node = Page['nodes'][string]

function node(id: string, moduleId: string, props: Record<string, unknown> = {}, children: string[] = [], hidden = false): Node {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [], ...(hidden ? { hidden: true } : {}) } as Node
}

/** A loop that names itself to the source, with one row of text that names it in the output. */
function loop(id: string, hidden = false): Node[] {
  return [
    node(id, 'base.loop', {
      sourceId: SOURCE, filters: { loop: id }, orderBy: '', direction: 'asc', limit: 10, offset: 0,
      pagination: 'none', pageSize: 10, tag: 'div', customTag: '',
    }, [`${id}_row`], hidden),
    node(`${id}_row`, 'base.text', { text: `LOOP[${id}:{currentEntry.label}]`, tag: 'p' }),
  ]
}

function image(id: string, hidden = false): Node {
  return node(id, 'base.image', { src: `/uploads/${id}.png`, alt: id }, [], hidden)
}

const COMPONENT_HIDDEN_REF = {
  rootNodeId: 'a_root',
  nodes: Object.fromEntries([node('a_root', 'base.container', {}, ['a_loop']), ...loop('a_loop')].map((n) => [n.id, n])),
}

const COMPONENT_USED = {
  rootNodeId: 'b_root',
  nodes: Object.fromEntries([
    node('b_root', 'base.container', {}, ['b_hidden_box', 'b_outlet', 'b_loop']),
    node('b_hidden_box', 'base.container', {}, ['b_inner_loop'], true),
    ...loop('b_inner_loop'),
    node('b_outlet', 'base.slot-outlet', { slotName: 'body' }),
    ...loop('b_loop'),
  ].map((n) => [n.id, n])),
}

function fixturePage(): Page {
  const nodes = [
    node('root', 'base.body', {}, [
      'hidden_loop', 'hidden_box', 'hidden_ref', 'ref', 'hidden_image', 'visible_loop', 'visible_image',
    ]),
    ...loop('hidden_loop', true),
    node('hidden_box', 'base.container', {}, ['box_loop', 'box_image'], true),
    ...loop('box_loop'),
    image('box_image'),
    node('hidden_ref', 'base.visual-component-ref', { componentId: 'vc_a' }, [], true),
    node('ref', 'base.visual-component-ref', { componentId: 'vc_b' }, ['ref__slot']),
    // Hidden, and still rendered: the renderer grafts its children into the outlet.
    node('ref__slot', 'base.slot-instance', { slotName: 'body' }, ['slot_loop', 'slot_image'], true),
    ...loop('slot_loop'),
    image('slot_image'),
    image('hidden_image', true),
    ...loop('visible_loop'),
    image('visible_image'),
  ]
  return {
    id: 'page_hidden', title: 'Hidden', slug: 'index', rootNodeId: 'root',
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
  } as Page
}

function shell(): SiteShell {
  return {
    id: 'site_1', name: 'Hidden', files: [], visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} }, styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(undefined), createdAt: 1000, updatedAt: 2000,
  }
}

const RENDERED_LOOPS = ['b_loop', 'slot_loop', 'visible_loop']
const SKIPPED_LOOPS = ['hidden_loop', 'box_loop', 'a_loop', 'b_inner_loop']

describe('hidden nodes in a publish', () => {
  let t: TestDb
  let uploadsDir: string
  let fetched: string[]
  let site: SiteDocument

  beforeEach(async () => {
    resetForTests()
    fetched = []
    const source: LoopEntitySource = {
      id: SOURCE, label: SOURCE, filterSchema: {}, orderByOptions: [],
      fields: [{ id: 'label', label: 'Label' }],
      fetch: async (ctx: SourceFetchContext) => {
        fetched.push(String(ctx.filters.loop))
        return { items: [{ id: '1', fields: { label: 'item' } }], totalItems: 1 }
      },
    }
    loopSourceRegistry.registerOrReplace(source)
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'hidden-walk-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
    await saveDraftSite(t.db, MAIN_SCOPE, shell())
    for (const [id, body] of [['vc_a', COMPONENT_HIDDEN_REF], ['vc_b', COMPONENT_USED]] as const) {
      await createDataRow(t.db, MAIN_SCOPE, {
        id, tableId: 'components', slug: id, cells: { name: id, body, params: [], classIds: [] },
      }, 'admin_1')
    }
    const page = fixturePage()
    await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
    site = (await getDraftSiteDocument(t.db, MAIN_SCOPE))!
  })

  afterEach(async () => {
    loopSourceRegistry.unregister(SOURCE)
    await t.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('collects the loops the renderer renders, the hidden slot instance\'s included', () => {
    const page = site.pages.find((entry) => entry.id === 'page_hidden')!
    expect(collectLoopNodes(page, site).map((entry) => entry.id).sort()).toEqual(RENDERED_LOOPS)
  })

  it('looks up the media the renderer renders, the hidden slot instance\'s included', async () => {
    const page = site.pages.find((entry) => entry.id === 'page_hidden')!
    const asked: unknown[] = []
    const recording = {
      dialect: 'sqlite',
      unsafe: async (_sql: string, params?: unknown[]) => {
        asked.push(...(params ?? []))
        return { rows: [], rowCount: 0 }
      },
    } as unknown as DbClient
    await prefetchMediaAssets(page, site, registry, recording)
    const paths = asked.filter((value): value is string => typeof value === 'string' && value.startsWith('/uploads/'))
    expect([...new Set(paths)].sort()).toEqual(['/uploads/slot_image.png', '/uploads/visible_image.png'])
  })

  it('publishes each rendered loop with its data and fetches nothing for a hidden one', async () => {
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
    expect([...new Set(fetched)].sort()).toEqual(RENDERED_LOOPS)

    const html = await (await handleServerRequest(new Request('http://localhost/'), { db: t.db, uploadsDir })).text()
    for (const id of RENDERED_LOOPS) expect(html).toContain(`LOOP[${id}:item]`)
    for (const id of SKIPPED_LOOPS) expect(html).not.toContain(`LOOP[${id}:`)
    // A loop that renders without prefetched data says so in a comment: none may.
    expect(html).not.toContain('has no resolved data')
    expect(html).toContain('/uploads/slot_image.png')
    expect(html).toContain('/uploads/visible_image.png')
    for (const id of ['box_image', 'hidden_image']) expect(html).not.toContain(`/uploads/${id}.png`)
  })
})
