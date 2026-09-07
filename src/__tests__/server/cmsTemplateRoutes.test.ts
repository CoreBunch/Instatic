import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleServerRequest } from '../../../server/router'
import { resetForTests } from '../../../server/publish/renderCache'
import { getPublishVersion, markPublishedArtefactsCurrent } from '../../../server/publish/publishState'
import { getPublishedRouteInventoryForVersion } from '../../../server/publish/publishedRoutes'
import { publishDataRow } from '../../../server/publish/publishRow'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { makePage, makeSite } from '../publisher/helpers'
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
import { createFakeDb } from './dbTestFake'
import { prepareInactiveSlot, writeArtefact, swapSlot } from '../../../server/publish/staticArtefact'

beforeEach(resetForTests)
afterEach(cleanupPublishingTestDbs)

async function fixture(title = 'Dynamic Post', slug = 'dynamic-post') {
  const page = makePage({
    root: { moduleId: 'base.body', children: ['title'] },
    title: { moduleId: 'base.text', props: { text: 'Static title', tag: 'h1' },
      dynamicBindings: { text: { source: 'currentEntry', field: 'title' } } },
  })
  page.id = 'post-template'
  page.slug = 'post-template'
  page.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 100 }
  const db = await createPublishingTestDb(makeSite({ pages: [page] }))
  const row = await createDataRow(db, { tableId: 'posts', slug, cells: { title, body: 'Body' } })
  await publishDataRow(db, row.id, null)
  return { db, row }
}

describe('CMS dynamic template routes', () => {
  it('renders a published data row through its matching published template', async () => {
    const { db } = await fixture()
    const response = await handleServerRequest(new Request('http://localhost/posts/dynamic-post'), { db })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('<h1>Dynamic Post</h1>')
    expect(html).not.toContain('Static title')
  })

  it('serves a validated template route from disk without snapshot hydration', async () => {
    const { db: real } = await fixture()
    let deny = false
    const db = createFakeDb(async (sql, params) => {
      if (deny) throw new Error('Unexpected SQL after inventory warmup')
      return real.unsafe(sql, params)
    })
    await getPublishedRouteInventoryForVersion(db, getPublishVersion())
    deny = true
    const uploadsDir = await mkdtemp(join(tmpdir(), 'template-disk-test-'))
    try {
      const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
      await writeArtefact(slotDir, '/posts/dynamic-post', '<html><h1>Baked template post</h1></html>')
      await swapSlot(uploadsDir, slot)
      markPublishedArtefactsCurrent(getPublishVersion())
      const response = await handleServerRequest(new Request('http://localhost/posts/dynamic-post'), { db, uploadsDir })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('Baked template post')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('bypasses a template artefact for a render-affecting loop-pagination query', async () => {
    const { db } = await fixture('QS Post')
    const uploadsDir = await mkdtemp(join(tmpdir(), 'template-query-test-'))
    try {
      const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
      await writeArtefact(slotDir, '/posts/dynamic-post', '<html>baked</html>')
      await swapSlot(uploadsDir, slot)
      markPublishedArtefactsCurrent(getPublishVersion())
      const response = await handleServerRequest(new Request('http://localhost/posts/dynamic-post?loop_x_page=2'), { db, uploadsDir })
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('QS Post')
      expect(html).not.toContain('>baked<')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('redirects an old published data row slug to the active language version', async () => {
    const { db, row } = await fixture('Post', 'untitled')
    await saveDataRowDraft(db, row.id, { slug: 'post', cells: row.cells })
    await publishDataRow(db, row.id, null)
    const response = await handleServerRequest(new Request('http://localhost/posts/untitled'), { db })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/posts/post')
  })
})
