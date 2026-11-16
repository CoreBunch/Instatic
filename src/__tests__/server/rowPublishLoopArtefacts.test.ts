/**
 * A baked page that lists a table through a static `base.loop` must not outlive
 * a change to that table's public rows.
 *
 * Layer A serves the active slot with no knowledge of the publish version, so
 * a row publish, unpublish or delete that only touched the row's own artefact
 * left every listing page (a blog index, "latest posts" in a layout) serving
 * the HTML baked at the last full site publish.
 *
 * Every assertion reads through `renderPublicResolution` WITH an uploads dir,
 * so the disk fast-path is in play exactly as it is for a visitor.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '@core/data/pageFromRow'
import type { DbClient } from '../../../server/db'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { saveDraftSite } from '../../../server/repositories/site'
import { createDataRow, saveDataRowDraft, scheduleDataRowPublish } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import { renderPublicResolution } from '../../../server/publish/publicRouter'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { resetPublishStateForTests } from '../../../server/publish/publishState'

type Nodes = Page['nodes']

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []) {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] }
}

/** A `base.loop` over `tableId` whose single variant prints each row's title. */
function loopNodes(prefix: string, tableId: string): Nodes {
  return {
    [`${prefix}_loop`]: node(`${prefix}_loop`, 'base.loop', {
      sourceId: 'data.rows',
      filters: { tableId },
      orderBy: 'slug',
      direction: 'asc',
      limit: 20,
    }, [`${prefix}_card`]),
    [`${prefix}_card`]: node(`${prefix}_card`, 'base.text', { text: 'card:{currentEntry.title}', tag: 'p' }),
  } as Nodes
}

function page(id: string, slug: string, extra: Nodes, children: string[], template?: Page['template']): Page {
  return {
    id,
    title: id,
    slug,
    rootNodeId: `${id}_root`,
    ...(template ? { template } : {}),
    nodes: {
      [`${id}_root`]: node(`${id}_root`, 'base.body', {}, children),
      ...extra,
    } as Nodes,
  } as Page
}

function shell(): SiteShell {
  return {
    id: 'project_1',
    name: 'Listing site',
    files: [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(undefined),
    createdAt: 1000,
    updatedAt: 2000,
  }
}

async function savePages(db: DbClient, pages: Page[]): Promise<void> {
  for (const p of pages) {
    await createDataRow(db, MAIN_SCOPE, { id: p.id, tableId: 'pages', slug: p.slug, cells: pageToCells(p) })
  }
}

async function createPost(db: DbClient, id: string, title: string): Promise<void> {
  await createDataRow(db, MAIN_SCOPE, { id, tableId: 'posts', slug: id, cells: { title, body: 'Body' } })
}

describe('baked pages that loop over a table follow its row changes', () => {
  let harness: CapabilityTestHarness
  let uploadsDir: string
  let ownerId: string
  let cookie: string

  /** What a visitor gets for `path`, through the public router with Layer A on. */
  async function visit(path: string): Promise<string> {
    const response = await renderPublicResolution(harness.db, new URL(`http://localhost${path}`), uploadsDir)
    return response ? await response.text() : ''
  }

  beforeEach(async () => {
    resetPublishStateForTests()
    uploadsDir = await mkdtemp(join(tmpdir(), 'loop-artefacts-'))
    harness = await createCapabilityTestHarness({ uploadsDir })
    cookie = await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    ownerId = rows[0]!.id
    // Start from an empty site so each test controls every page.
    await harness.db`delete from data_rows where table_id in ('pages', 'posts', 'components')`
  })

  afterEach(async () => {
    await harness.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function publishSiteWith(pages: Page[]): Promise<void> {
    await saveDraftSite(harness.db, MAIN_SCOPE, shell())
    await savePages(harness.db, pages)
    await publishDraftSite(harness.db, ownerId, uploadsDir)
  }

  const journal = () => page('journal', 'journal', loopNodes('journal', 'posts'), ['journal_loop'])
  const about = () => page('about', 'about', {
    about_text: node('about_text', 'base.text', { text: 'About us', tag: 'h1' }),
  } as Nodes, ['about_text'])

  it('lists a newly published row without a site publish', async () => {
    await publishSiteWith([journal(), about()])
    await createPost(harness.db, 'first', 'First post')
    expect(await visit('/journal')).not.toContain('card:First post')

    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)

    expect(await visit('/journal')).toContain('card:First post')
  })

  it('lists a row published by the scheduler', async () => {
    await publishSiteWith([journal()])
    await createPost(harness.db, 'first', 'First post')
    await scheduleDataRowPublish(harness.db, MAIN_SCOPE, 'first', new Date(Date.now() - 1000).toISOString())

    await tickPublishScheduler(harness.db, uploadsDir)

    expect(await visit('/journal')).toContain('card:First post')
  })

  it('shows a republished row with its new title', async () => {
    await publishSiteWith([journal()])
    await createPost(harness.db, 'first', 'First post')
    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)
    await publishDraftSite(harness.db, ownerId, uploadsDir)
    expect(await visit('/journal')).toContain('card:First post')

    await saveDataRowDraft(harness.db, MAIN_SCOPE, 'first', { cells: { title: 'Renamed post', body: 'Body' }, slug: 'first' }, ownerId)
    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)

    const html = await visit('/journal')
    expect(html).toContain('card:Renamed post')
    expect(html).not.toContain('card:First post')
  })

  it('drops an unpublished row from the listing (status route)', async () => {
    await publishSiteWith([journal()])
    await createPost(harness.db, 'first', 'First post')
    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)
    await publishDraftSite(harness.db, ownerId, uploadsDir)
    expect(await readArtefact(uploadsDir, '/journal')).toContain('card:First post')

    const response = await harness.cms('/admin/api/cms/data/rows/first/status', {
      method: 'PATCH',
      cookie,
      json: { status: 'unpublished' },
    })
    expect(response.status).toBe(200)

    expect(await visit('/journal')).not.toContain('card:First post')
  })

  it('drops a deleted row from the listing (delete route)', async () => {
    await publishSiteWith([journal()])
    await createPost(harness.db, 'first', 'First post')
    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)
    await publishDraftSite(harness.db, ownerId, uploadsDir)
    expect(await readArtefact(uploadsDir, '/journal')).toContain('card:First post')

    const response = await harness.cms('/admin/api/cms/data/rows/first', { method: 'DELETE', cookie })
    expect(response.status).toBe(200)

    expect(await visit('/journal')).not.toContain('card:First post')
  })

  it('keeps pages that do not loop over the table on disk', async () => {
    const products = page('products', 'products', loopNodes('products', 'some-other-table'), ['products_loop'])
    await publishSiteWith([journal(), about(), products])
    const aboutBefore = await readArtefact(uploadsDir, '/about')
    const productsBefore = await readArtefact(uploadsDir, '/products')
    expect(aboutBefore).toContain('About us')
    await createPost(harness.db, 'first', 'First post')

    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)

    expect(await readArtefact(uploadsDir, '/about')).toBe(aboutBefore)
    expect(await readArtefact(uploadsDir, '/products')).toBe(productsBefore)
  })

  it('follows a loop that lives in a layout template, on pages and entry routes', async () => {
    // One `everywhere` layout wraps every page AND every post's entry route.
    const layout = page('layout', 'layout', {
      ...loopNodes('layout', 'posts'),
      layout_outlet: node('layout_outlet', 'base.outlet', {}),
    } as Nodes, ['layout_outlet', 'layout_loop'], { enabled: true, target: { kind: 'everywhere' }, priority: 0 })
    await publishSiteWith([layout, about()])
    await createPost(harness.db, 'first', 'First post')
    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)
    await publishDraftSite(harness.db, ownerId, uploadsDir)
    expect(await readArtefact(uploadsDir, '/posts/first')).toContain('<title>First post</title>')
    await createPost(harness.db, 'second', 'Second post')

    await publishDataRow(harness.db, 'second', ownerId, uploadsDir)

    // The plain page inherits the layout's loop.
    expect(await visit('/about')).toContain('card:Second post')
    // So does the other row's entry route.
    const firstEntry = await visit('/posts/first')
    expect(firstEntry).toContain('<title>First post</title>')
    expect(firstEntry).toContain('card:Second post')
    // The published row's own artefact is baked fresh and stays on disk.
    expect(await readArtefact(uploadsDir, '/posts/second')).toContain('card:Second post')
  })

  it('follows a loop that lives inside a visual component', async () => {
    const body = {
      rootNodeId: 'vc_root',
      nodes: {
        vc_root: node('vc_root', 'base.container', {}, ['vc_loop']),
        ...loopNodes('vc', 'posts'),
      },
    }
    await createDataRow(harness.db, MAIN_SCOPE, {
      id: 'latest', tableId: 'components', slug: 'latest', cells: { name: 'Latest', body, params: [], classIds: [] },
    })
    const home = page('home', 'index', {
      home_ref: node('home_ref', 'base.visual-component-ref', { componentId: 'latest' }),
    } as Nodes, ['home_ref'])
    await publishSiteWith([home])
    await createPost(harness.db, 'first', 'First post')
    expect(await visit('/')).not.toContain('card:First post')

    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)

    expect(await visit('/')).toContain('card:First post')
  })
})
