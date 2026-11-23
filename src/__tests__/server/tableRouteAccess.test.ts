/**
 * A members-only table stays members-only whatever its owner then changes
 * about the table: its route base, its slug, or anything else that moves
 * where its entries are served.
 *
 * The principle: after any admin change to a table that could affect who may
 * see a route, a visitor who is not signed in never gets a protected entry,
 * before or after the next publish. The access rule of an entry route is
 * found by the table's id, which no rename can make stale.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@core/page-tree'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { publishDataRow } from '../../../server/publish/publishRow'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { setTableAccess } from '../../../server/publish/tableAccess'
import {
  createDataRow,
  createDataTable,
  getDataRow,
  listDataRows,
  updateDataTable,
} from '../../../server/repositories/data'
import { handleServerRequest } from '../../../server/router'
import { pageFromRow, pageToCells } from '../../core/data/pageFromRow'
import { getAccessIndex, pageAudience } from '../../../server/publish/accessGate'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const SECRET = 'Members-only club note'
const CHROME = 'Club members corner'

describe('a members-only table after its owner changes the table', () => {
  let h: CapabilityTestHarness
  let owner = ''
  let author = ''
  let uploadsDir = ''

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'table-route-access-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    const [home] = await listDataRows(h.db, MAIN_SCOPE, 'pages')
    author = (await getDataRow(h.db, MAIN_SCOPE, home!.id))!.createdByUserId!

    await createDataTable(h.db, MAIN_SCOPE, {
      id: 'club', name: 'Club', slug: 'club', kind: 'postType', routeBase: '/club',
      singularLabel: 'Note', pluralLabel: 'Notes',
    })
    const template = {
      id: 'page_club_tpl',
      title: 'Club template',
      slug: 'club-template',
      rootNodeId: 'club_tpl_root',
      nodes: {
        club_tpl_root: { id: 'club_tpl_root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['club_tpl_line', 'club_tpl_chrome'], classIds: [] },
        club_tpl_line: {
          id: 'club_tpl_line', moduleId: 'base.text', props: { text: 'title', tag: 'h1' }, breakpointOverrides: {}, children: [], classIds: [],
          dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
        },
        club_tpl_chrome: {
          id: 'club_tpl_chrome', moduleId: 'base.text', props: { text: CHROME, tag: 'p' }, breakpointOverrides: {}, children: [], classIds: [],
        },
      },
      template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['club'] }, priority: 100 },
    } as unknown as Page
    await createDataRow(h.db, MAIN_SCOPE, {
      id: template.id, tableId: 'pages', cells: pageToCells(template), slug: template.slug,
    }, author)
    await createDataRow(h.db, MAIN_SCOPE, { id: 'c1', tableId: 'club', cells: { title: SECRET, slug: 'c1' }, slug: 'c1' }, author)
    await publishDraftSite(h.db, author, uploadsDir)
    await publishDataRow(h.db, 'c1', author, uploadsDir)

    // Open first, so the test proves the entry really is served…
    const open = await visit('/club/c1')
    expect(open.status).toBe(200)
    expect(await open.text()).toContain(SECRET)
    // …then members only.
    expect(await setTableAccess(h.db, 'club', { level: 'members', onDeny: 'hide' }, uploadsDir)).toBe(true)
    expect(await leaks('/club/c1')).toBe(false)
  })

  afterEach(async () => {
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  function visit(path: string): Promise<Response> {
    return handleServerRequest(new Request(`http://localhost${path}`, { redirect: 'manual' }), { db: h.db, uploadsDir })
  }

  async function leaks(path: string): Promise<boolean> {
    return (await (await visit(path)).text()).includes(SECRET)
  }

  async function patchTable(body: Record<string, unknown>): Promise<void> {
    const res = await h.cms('/admin/api/cms/data/tables/club', { method: 'PATCH', cookie: owner, json: body })
    expect(res.status).toBe(200)
  }

  async function republish(): Promise<void> {
    await publishDraftSite(h.db, author, uploadsDir)
    await publishDataRow(h.db, 'c1', author, uploadsDir)
  }

  it('a new route base does not open its entries, before or after the next publish', async () => {
    await patchTable({ routeBase: '/open2' })
    for (const path of ['/open2/c1', '/open2/c1/', '/Open2/c1', '/club/c1']) {
      expect({ path, leaked: await leaks(path) }).toEqual({ path, leaked: false })
    }
    await republish()
    for (const path of ['/open2/c1', '/club/c1']) {
      expect({ path, leaked: await leaks(path) }).toEqual({ path, leaked: false })
    }
  })

  it('a new slug does not open its entries, before or after the next publish', async () => {
    await patchTable({ slug: 'society' })
    expect(await leaks('/club/c1')).toBe(false)
    await republish()
    expect(await leaks('/club/c1')).toBe(false)
  })

  it('holds even when the cached access index was never told the table moved', async () => {
    // What a write path that forgets to announce itself would leave behind:
    // the live route base moved, the index still keyed by the old one.
    await updateDataTable(h.db, MAIN_SCOPE, 'club', { routeBase: '/drift' })
    for (const path of ['/drift/c1', '/club/c1']) {
      expect({ path, leaked: await leaks(path) }).toEqual({ path, leaked: false })
    }
  })

  it('an entry moved to another table is no longer served at its old address', async () => {
    // A public table this time: the entry is baked to the static slot.
    await createDataTable(h.db, MAIN_SCOPE, {
      id: 'news', name: 'News', slug: 'news', kind: 'postType', routeBase: '/news',
      singularLabel: 'Story', pluralLabel: 'Stories',
    })
    await createDataTable(h.db, MAIN_SCOPE, {
      id: 'archive', name: 'Archive', slug: 'archive', kind: 'postType', routeBase: '/archive',
      singularLabel: 'Story', pluralLabel: 'Stories',
    })
    const template = {
      id: 'page_story_tpl',
      title: 'Story template',
      slug: 'story-template',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['line'], classIds: [] },
        line: {
          id: 'line', moduleId: 'base.text', props: { text: 'title', tag: 'h1' }, breakpointOverrides: {}, children: [], classIds: [],
          dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
        },
      },
      template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['news', 'archive'] }, priority: 100 },
    } as unknown as Page
    await createDataRow(h.db, MAIN_SCOPE, {
      id: template.id, tableId: 'pages', cells: pageToCells(template), slug: template.slug,
    }, author)
    await createDataRow(h.db, MAIN_SCOPE, { id: 'n1', tableId: 'news', cells: { title: 'Launch day story', slug: 'n1' }, slug: 'n1' }, author)
    await publishDraftSite(h.db, author, uploadsDir)
    await publishDataRow(h.db, 'n1', author, uploadsDir)
    expect((await visit('/news/n1')).status).toBe(200)
    expect(await readArtefact(uploadsDir, '/news/n1')).toContain('Launch day story')

    const moved = await h.cms('/admin/api/cms/data/rows/n1/table', { method: 'PATCH', cookie: owner, json: { tableId: 'archive' } })
    expect(moved.status).toBe(200)

    expect(await readArtefact(uploadsDir, '/news/n1')).toBeNull()
    expect((await visit('/news/n1')).status).not.toBe(200)
    // A moved published entry stays published, at its new table's address.
    const there = await visit('/archive/n1')
    expect(there.status).toBe(200)
    expect(await there.text()).toContain('Launch day story')
  })

  it('keeps the entry template members-only after the table slug changes, fragments and background renders included', async () => {
    const templateRow = (await getDataRow(h.db, MAIN_SCOPE, 'page_club_tpl'))!
    const template = pageFromRow(templateRow)
    const holeOf = async () => {
      const index = await getPublishedNodeIndexForVersion(h.db, getPublishVersion())
      return visit(`/_instatic/hole/club_tpl_chrome?v=${index!.snapshotHash}&u=${encodeURIComponent('/')}`)
    }
    const audience = async () => pageAudience(await getAccessIndex(h.db, getPublishVersion()), template)
    // Members only to begin with.
    expect((await holeOf()).status).toBe(404)
    expect(await audience()).toBe('member')

    // The template still targets `club`, a slug no table holds any more.
    await patchTable({ slug: 'society' })
    const before = await holeOf()
    expect({ status: before.status, leaked: (await before.text()).includes(CHROME) }).toEqual({ status: 404, leaked: false })
    expect(await audience()).toBe('member')

    await republish()
    const after = await holeOf()
    expect({ status: after.status, leaked: (await after.text()).includes(CHROME) }).toEqual({ status: 404, leaked: false })
    expect(await audience()).toBe('member')
  })
})
