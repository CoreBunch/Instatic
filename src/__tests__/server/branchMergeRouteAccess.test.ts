/**
 * A branch merge into main can change which route an entry is served at and
 * which rule covers it (an entry moved to a members-only table, an entry
 * deleted). The static slot is read without asking who is asking, so a merge
 * on main must drop what was baked for the old shape, exactly like a table
 * route or access change does. Undoing such a merge is the same kind of
 * change; declining a merge request changes nothing.
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
  getDataTable,
  softDeleteDataRow,
  updateDataRowTable,
  updateDataTable,
} from '../../../server/repositories/data'
import { handleServerRequest } from '../../../server/router'
import { pageToCells } from '../../core/data/pageFromRow'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const BRANCHES = '/admin/api/cms/branches'
const STORY = 'Launch day story'

describe('a branch merge on main and the baked pages', () => {
  let h: CapabilityTestHarness
  let owner = ''
  let author = ''
  let uploadsDir = ''

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'merge-route-access-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    const [home] = await listDataRows(h.db, MAIN_SCOPE, 'pages')
    author = (await getDataRow(h.db, MAIN_SCOPE, home!.id))!.createdByUserId!

    for (const [id, routeBase] of [['news', '/news'], ['club', '/club']] as const) {
      await createDataTable(h.db, MAIN_SCOPE, {
        id, name: id, slug: id, kind: 'postType', routeBase, singularLabel: 'Story', pluralLabel: 'Stories',
      })
    }
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
      template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['news', 'club'] }, priority: 100 },
    } as unknown as Page
    await createDataRow(h.db, MAIN_SCOPE, { id: template.id, tableId: 'pages', cells: pageToCells(template), slug: template.slug }, author)
    expect(await setTableAccess(h.db, 'club', { level: 'members', onDeny: 'hide' }, uploadsDir)).toBe(true)
  })

  afterEach(async () => {
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  function visit(path: string): Promise<Response> {
    return handleServerRequest(new Request(`http://localhost${path}`, { redirect: 'manual' }), { db: h.db, uploadsDir })
  }

  async function leaks(path: string): Promise<boolean> {
    return (await (await visit(path)).text()).includes(STORY)
  }

  /** A published entry, baked to the static slot when its table is public. */
  async function publishedEntry(tableId: 'news' | 'club'): Promise<void> {
    await createDataRow(h.db, MAIN_SCOPE, { id: 'n1', tableId, cells: { title: STORY, slug: 'n1' }, slug: 'n1' }, author)
    await publishDraftSite(h.db, author, uploadsDir)
    await publishDataRow(h.db, 'n1', author, uploadsDir)
  }

  async function fork(name: string): Promise<string> {
    const res = await h.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name } })
    expect(res.status).toBe(201)
    return (await readJson<{ branch: { id: string } }>(res)).branch.id
  }

  async function merge(branchId: string): Promise<void> {
    const res = await h.cms(`${BRANCHES}/${branchId}/merge`, { method: 'POST', cookie: owner, json: {} })
    expect(res.status).toBe(200)
  }

  it('an entry moved to a members-only table on a branch is not served from its old file after the merge', async () => {
    await publishedEntry('news')
    expect(await readArtefact(uploadsDir, '/news/n1')).toContain(STORY)

    const branchId = await fork('Close the story')
    expect((await updateDataRowTable(h.db, { branchId }, 'n1', 'club')).ok).toBe(true)
    await merge(branchId)

    expect((await getDataRow(h.db, MAIN_SCOPE, 'n1'))!.tableId).toBe('club')
    expect(await readArtefact(uploadsDir, '/news/n1')).toBeNull()
    for (const path of ['/news/n1', '/club/n1']) {
      expect({ path, leaked: await leaks(path) }).toEqual({ path, leaked: false })
    }
  })

  it('an entry deleted on a branch is not served from its file after the merge', async () => {
    await publishedEntry('news')
    const branchId = await fork('Retire the story')
    await softDeleteDataRow(h.db, { branchId }, 'n1', null)
    await merge(branchId)

    expect(await readArtefact(uploadsDir, '/news/n1')).toBeNull()
    expect(await leaks('/news/n1')).toBe(false)
  })

  it('undoing a merge that opened an entry closes it again, baked file included', async () => {
    // Members only to begin with: never baked.
    await publishedEntry('club')
    expect(await leaks('/club/n1')).toBe(false)

    const branchId = await fork('Open the story')
    expect((await updateDataRowTable(h.db, { branchId }, 'n1', 'news')).ok).toBe(true)
    await merge(branchId)
    // Public now, and baked by the next publish.
    await publishDraftSite(h.db, author, uploadsDir)
    await publishDataRow(h.db, 'n1', author, uploadsDir)
    expect(await readArtefact(uploadsDir, '/news/n1')).toContain(STORY)

    const undone = await h.cms(`${BRANCHES}/${branchId}/merge/undo`, { method: 'POST', cookie: owner, json: {} })
    expect(undone.status).toBe(200)

    expect((await getDataRow(h.db, MAIN_SCOPE, 'n1'))!.tableId).toBe('club')
    expect(await readArtefact(uploadsDir, '/news/n1')).toBeNull()
    for (const path of ['/news/n1', '/club/n1']) {
      expect({ path, leaked: await leaks(path) }).toEqual({ path, leaked: false })
    }
  })

  it('declining a merge request changes nothing on the live site', async () => {
    await publishedEntry('news')
    const branchId = await fork('Not yet')
    expect((await updateDataRowTable(h.db, { branchId }, 'n1', 'club')).ok).toBe(true)
    expect((await h.cms(`${BRANCHES}/${branchId}/review/request`, { method: 'POST', cookie: owner, json: { note: 'Close it?' } })).status).toBe(201)
    const declined = await h.cms(`${BRANCHES}/${branchId}/review/decline`, {
      method: 'POST', cookie: owner, json: { note: 'Keep it public for now' },
    })
    expect(declined.status).toBe(200)

    expect((await getDataRow(h.db, MAIN_SCOPE, 'n1'))!.tableId).toBe('news')
    expect(await readArtefact(uploadsDir, '/news/n1')).toContain(STORY)
    expect((await visit('/news/n1')).status).toBe(200)
  })

  it('a merge that swaps two table slugs is refused as a merge conflict, not a server error', async () => {
    const branchId = await fork('Swap slugs')
    const scope = { branchId }
    await updateDataTable(h.db, scope, 'news', { slug: 'news-old' })
    await updateDataTable(h.db, scope, 'club', { slug: 'news' })
    await updateDataTable(h.db, scope, 'news', { slug: 'club' })
    const res = await h.cms(`${BRANCHES}/${branchId}/merge`, { method: 'POST', cookie: owner, json: {} })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('merge_apply')
    expect(body.error).not.toContain('UNIQUE')
    // Nothing of the merge landed.
    expect((await getDataTable(h.db, MAIN_SCOPE, 'news'))!.slug).toBe('news')
    expect((await getDataTable(h.db, MAIN_SCOPE, 'club'))!.slug).toBe('club')
  })
})
