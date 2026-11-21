/**
 * Re-syncing a plugin's pack after the owner deleted what it installed.
 *
 * A deleted page is soft-deleted: its row keeps its id. The pack sync used to
 * look only at live rows, decide the page was new, and insert it again under
 * the id that was still taken, which failed with a 500. A re-sync has to
 * bring a deleted pack page back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { createDataRow, getDataRow, listDataRows, softDeleteDataRow } from '../../../server/repositories/data'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const ORIGIN = 'http://localhost'
const PLUGIN_ID = 'acme.pages'
const PAGE_ID = `${PLUGIN_ID}.welcome`

function packPage(text: string) {
  const root = `${PAGE_ID}.root`
  const line = `${PAGE_ID}.line`
  const node = (id: string, moduleId: string, props: Record<string, unknown>, children: string[]) =>
    ({ id, moduleId, props, breakpointOverrides: {}, children, classIds: [] })
  return {
    id: PAGE_ID,
    title: 'Welcome',
    slug: 'welcome-pack',
    rootNodeId: root,
    nodes: { [root]: node(root, 'base.body', {}, [line]), [line]: node(line, 'base.text', { text, tag: 'p' }, []) },
  }
}

describe('plugin pack re-sync', () => {
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'plugin-pack-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
  })

  afterEach(async () => {
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(): Promise<Response> {
    const manifest = {
      id: PLUGIN_ID, name: 'Pages', version: '1.0.0', apiVersion: 1,
      permissions: ['visualComponents.register'], pack: { path: 'pack/site.json' },
    }
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest)),
      'pack/site.json': strToU8(JSON.stringify({ pages: [packPage('From the pack')] })),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(manifest.permissions))
    // The test DOM cannot carry a multipart body through `new Request`, so the form is handed over directly.
    const req = {
      url: `${ORIGIN}/admin/api/cms/plugins/package`,
      method: 'POST',
      headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
      formData: async () => formData,
    } as unknown as Request
    return handleCmsRequest(req, h.db, { uploadsDir })
  }

  const resync = () => h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}/pack/install`, { method: 'POST', cookie: owner })
  const livePackPages = async () => (await listDataRows(h.db, MAIN_SCOPE, 'pages')).filter((row) => row.id === PAGE_ID)

  it('brings back a pack page the owner deleted, instead of failing', async () => {
    expect((await install()).status).toBe(201)
    expect(await livePackPages()).toHaveLength(1)

    await softDeleteDataRow(h.db, MAIN_SCOPE, PAGE_ID, null)
    expect(await livePackPages()).toHaveLength(0)

    const res = await resync()
    expect(res.status).toBe(200)
    expect(await livePackPages()).toHaveLength(1)
    expect(JSON.stringify((await getDataRow(h.db, MAIN_SCOPE, PAGE_ID))?.cells.body)).toContain('From the pack')
  })

  it('brings a page that was live before the delete back as a draft, not onto the site', async () => {
    expect((await install()).status).toBe(201)
    await h.db`update data_rows set status = 'published' where id = ${PAGE_ID}`
    await softDeleteDataRow(h.db, MAIN_SCOPE, PAGE_ID, null)
    expect((await resync()).status).toBe(200)
    expect((await getDataRow(h.db, MAIN_SCOPE, PAGE_ID))?.status).toBe('draft')
  })

  it('refuses a pack whose page id belongs to a row of another table, and leaves that row alone', async () => {
    // A post that happens to hold the id the pack wants for its page.
    await createDataRow(h.db, MAIN_SCOPE, { id: PAGE_ID, tableId: 'posts', cells: { title: 'A post', slug: 'a-post' }, slug: 'a-post' }, null)
    await install()
    const res = await resync()
    expect(res.status).toBe(400)
    const post = await getDataRow(h.db, MAIN_SCOPE, PAGE_ID)
    expect(post).toMatchObject({ tableId: 'posts' })
    expect(post?.cells.title).toBe('A post')
  })

  it('still replaces a pack page that is there, and can be run twice', async () => {
    expect((await install()).status).toBe(201)
    expect((await resync()).status).toBe(200)
    expect((await resync()).status).toBe(200)
    expect(await livePackPages()).toHaveLength(1)
  })
})
