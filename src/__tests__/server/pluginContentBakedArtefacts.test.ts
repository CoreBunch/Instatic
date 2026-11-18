/**
 * A plugin that publishes or deletes an entry through `cms.content.entries.*`
 * must leave the baked publish slot in the same state the Content workspace
 * would: the entry's own page written or removed, and the baked pages that
 * list its table refreshed.
 *
 * Layer A serves the active slot with no knowledge of the database, so a host
 * handler that only touched the row and the publish version left a deleted
 * entry's page on disk, never baked a published one, and kept every listing.
 *
 * Calls go through `dispatchApiCall`, so the host context wiring is covered.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '@core/data/pageFromRow'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { saveDraftSite } from '../../../server/repositories/site'
import { createDataRow } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { renderPublicResolution } from '../../../server/publish/publicRouter'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { resetPublishStateForTests } from '../../../server/publish/publishState'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import type { HostPluginRecord } from '../../../server/plugins/host/types'
import type { ValidatedApiCall } from '../../../server/plugins/protocol/apiCallSchema'

const PLUGIN_ID = 'acme.importer'

type Nodes = Page['nodes']

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []) {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] }
}

function page(id: string, slug: string, extra: Nodes, children: string[], template?: Page['template']): Page {
  return {
    id,
    title: id,
    slug,
    rootNodeId: `${id}_root`,
    ...(template ? { template } : {}),
    nodes: { [`${id}_root`]: node(`${id}_root`, 'base.body', {}, children), ...extra } as Nodes,
  } as Page
}

/** A page at `/journal` that lists every post's title. */
function journal(): Page {
  return page('journal', 'journal', {
    journal_loop: node('journal_loop', 'base.loop', {
      sourceId: 'data.rows',
      filters: { tableId: 'posts' },
      orderBy: 'slug',
      direction: 'asc',
      limit: 20,
    }, ['journal_card']),
    journal_card: node('journal_card', 'base.text', { text: 'card:{currentEntry.title}', tag: 'p' }),
  } as Nodes, ['journal_loop'])
}

/** The entry template every post renders through. */
function postTemplate(): Page {
  return page('post_template', 'post-template', {
    post_title: node('post_title', 'base.text', { text: 'entry:{currentEntry.title}', tag: 'h1' }),
  } as Nodes, ['post_title'], { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 })
}

function shell(): SiteShell {
  return {
    id: 'project_1',
    name: 'Plugin site',
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

function pluginRecord(): HostPluginRecord {
  return {
    manifest: {
      id: PLUGIN_ID,
      grantedPermissions: ['cms.content.publish', 'cms.content.delete'],
      contentAccess: [{ table: 'posts', modes: ['publish', 'delete'] }],
    },
    assetRootPath: '',
    routes: new Map(),
    hookListeners: [],
    hookFilters: [],
    loopSources: [],
    mediaAdapters: [],
    mediaUrlTransformers: [],
    inflightFetches: new Map(),
  } as unknown as HostPluginRecord
}

describe('plugin content calls keep the baked slot in step', () => {
  let harness: CapabilityTestHarness
  let uploadsDir: string
  let ownerId: string

  async function visit(path: string): Promise<{ status: number; html: string }> {
    const response = await renderPublicResolution(harness.db, new URL(`http://localhost${path}`), uploadsDir)
    return { status: response?.status ?? 404, html: response ? await response.text() : '' }
  }

  function call(target: string, args: unknown[]): Promise<void> {
    return dispatchApiCall({ kind: 'api-call', correlationId: 'c1', pluginId: PLUGIN_ID, target, args } as ValidatedApiCall)
  }

  async function createPost(id: string, title: string): Promise<void> {
    await createDataRow(harness.db, MAIN_SCOPE, { id, tableId: 'posts', slug: id, cells: { title, body: 'Body' } })
  }

  beforeEach(async () => {
    resetPublishStateForTests()
    uploadsDir = await mkdtemp(join(tmpdir(), 'plugin-artefacts-'))
    harness = await createCapabilityTestHarness({ uploadsDir })
    await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    ownerId = rows[0]!.id
    await harness.db`delete from data_rows where table_id in ('pages', 'posts', 'components')`
    await saveDraftSite(harness.db, MAIN_SCOPE, shell())
    for (const p of [journal(), postTemplate()]) {
      await createDataRow(harness.db, MAIN_SCOPE, { id: p.id, tableId: 'pages', slug: p.slug, cells: pageToCells(p) })
    }
    hostPlugins.set(PLUGIN_ID, pluginRecord())
    setPluginHostContext({ db: harness.db, uploadsDir })
  })

  afterEach(async () => {
    hostPlugins.delete(PLUGIN_ID)
    await harness.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('bakes a plugin-published entry and lists it', async () => {
    await publishDraftSite(harness.db, ownerId, uploadsDir)
    await createPost('first', 'First post')

    await call('cms.content.entries.publish', ['posts', 'first', {}])

    expect(await readArtefact(uploadsDir, '/posts/first')).toContain('entry:First post')
    expect((await visit('/journal')).html).toContain('card:First post')
  })

  it('stops serving a plugin-deleted entry and drops it from the listing', async () => {
    await createPost('first', 'First post')
    await publishDataRow(harness.db, 'first', ownerId, uploadsDir)
    await publishDraftSite(harness.db, ownerId, uploadsDir)
    expect(await readArtefact(uploadsDir, '/posts/first')).toContain('entry:First post')
    expect(await readArtefact(uploadsDir, '/journal')).toContain('card:First post')

    await call('cms.content.entries.delete', ['posts', 'first'])

    expect(await readArtefact(uploadsDir, '/posts/first')).toBeNull()
    expect((await visit('/posts/first')).html).not.toContain('entry:First post')
    expect((await visit('/journal')).html).not.toContain('card:First post')
  })

  it('does the same for a bulk delete', async () => {
    await createPost('first', 'First post')
    await createPost('second', 'Second post')
    await createPost('third', 'Third post')
    for (const id of ['first', 'second', 'third']) await publishDataRow(harness.db, id, ownerId, uploadsDir)
    await publishDraftSite(harness.db, ownerId, uploadsDir)

    await call('cms.content.entries.deleteMany', ['posts', ['first', 'second']])

    expect(await readArtefact(uploadsDir, '/posts/first')).toBeNull()
    expect(await readArtefact(uploadsDir, '/posts/second')).toBeNull()
    expect(await readArtefact(uploadsDir, '/posts/third')).toContain('entry:Third post')
    const listing = (await visit('/journal')).html
    expect(listing).not.toContain('card:First post')
    expect(listing).not.toContain('card:Second post')
    expect(listing).toContain('card:Third post')
  })
})
