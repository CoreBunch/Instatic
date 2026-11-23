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
import { parsePluginManifest } from '@core/plugins/manifest'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { installPlugin } from '../../../server/repositories/plugins'
import { getDraftSite } from '../../../server/repositories/site'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { createDataRow, getDataRow, listDataRows, saveDataRowDraft, softDeleteDataRow } from '../../../server/repositories/data'
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

  async function install(pack: Record<string, unknown> = { pages: [packPage('From the pack')] }): Promise<Response> {
    const manifest = {
      id: PLUGIN_ID, name: 'Pages', version: '1.0.0', apiVersion: 1,
      permissions: ['visualComponents.register'], pack: { path: 'pack/site.json' },
    }
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest)),
      'pack/site.json': strToU8(JSON.stringify(pack)),
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

  it('refuses a pack whose page slug is already taken, before writing any of it', async () => {
    // The owner already has a page at the address the pack wants.
    await createDataRow(h.db, MAIN_SCOPE, {
      id: 'owner_welcome', tableId: 'pages', cells: { title: 'Owner welcome', slug: 'welcome-pack' }, slug: 'welcome-pack',
    }, null)
    const second = { ...packPage('Second page'), id: `${PLUGIN_ID}.second`, slug: 'second-pack' }
    // The clashing page comes LAST: everything before it must not be written either.
    await install({ pages: [second, packPage('From the pack')] })
    const res = await resync()
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: string }
    expect(error).toContain('slug "welcome-pack" is already used')
    expect(error).not.toContain('UNIQUE')
    expect(await getDataRow(h.db, MAIN_SCOPE, `${PLUGIN_ID}.second`)).toBeNull()
    expect(await getDataRow(h.db, MAIN_SCOPE, PAGE_ID)).toBeNull()
    expect((await getDataRow(h.db, MAIN_SCOPE, 'owner_welcome'))?.cells.title).toBe('Owner welcome')
  })

  describe('ids a pack may write', () => {
    const tree = (id: string) => ({
      rootNodeId: `${id}.root`,
      nodes: { [`${id}.root`]: { id: `${id}.root`, moduleId: 'base.container', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
    })

    it('never the id of a page the owner made: the draft and its access rule stay', async () => {
      const [home] = await listDataRows(h.db, MAIN_SCOPE, 'pages')
      const access = { level: 'members', onDeny: 'hide' }
      await saveDataRowDraft(h.db, MAIN_SCOPE, home!.id, {
        cells: { ...home!.cells, title: 'Owner wording', access },
        slug: home!.slug,
      })
      await install({ pages: [{ ...packPage('Pack wording'), id: home!.id, slug: home!.slug }] })
      const res = await resync()
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(`must be namespaced under the plugin id`)
      const after = await getDataRow(h.db, MAIN_SCOPE, home!.id)
      expect(after?.cells.title).toBe('Owner wording')
      expect(after?.cells.access).toEqual(access)
      expect(JSON.stringify(after?.cells)).not.toContain('Pack wording')
    })

    it('never the id of a component or a layout outside its namespace', async () => {
      await createDataRow(h.db, MAIN_SCOPE, {
        id: 'owner-card', tableId: 'components', cells: { name: 'Owner card', marker: 'owner made this' }, slug: 'owner-card',
      }, null)
      await createDataRow(h.db, MAIN_SCOPE, {
        id: 'owner-hero', tableId: 'layouts', cells: { name: 'Owner hero', marker: 'owner made this' }, slug: 'owner-hero',
      }, null)
      const component = { id: 'owner-card', name: 'Pack card', params: [], classIds: [], createdAt: 1, tree: tree('owner-card') }
      const layout = { id: 'owner-hero', name: 'Pack hero', classes: {}, createdAt: 1, ...tree('owner-hero') }

      for (const pack of [{ visualComponents: [component] }, { layouts: [layout] }]) {
        await install(pack)
        const res = await resync()
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toContain('must be namespaced under the plugin id')
      }
      expect((await getDataRow(h.db, MAIN_SCOPE, 'owner-card'))?.cells.marker).toBe('owner made this')
      expect((await getDataRow(h.db, MAIN_SCOPE, 'owner-hero'))?.cells.marker).toBe('owner made this')

      // Under its own namespace the same content installs.
      const own = { ...component, id: `${PLUGIN_ID}/card`, tree: tree(`${PLUGIN_ID}/card`) }
      await install({ visualComponents: [own] })
      expect((await resync()).status).toBe(200)
      expect(await getDataRow(h.db, MAIN_SCOPE, `${PLUGIN_ID}/card`)).not.toBeNull()
    })

    it('never an id inside another installed plugin\'s namespace, though it starts with its own id', async () => {
      expect((await install()).status).toBe(201)
      // A nested pair from before such pairs were refused at install.
      const nested = parsePluginManifest({ id: `${PLUGIN_ID}.pro`, name: 'Pro', version: '1.0.0', apiVersion: 1, permissions: [] })
      await installPlugin(h.db, nested, [])
      await install({ pages: [{ ...packPage('Pack wording'), id: `${PLUGIN_ID}.pro.home`, slug: 'pro-home' }] })
      const res = await resync()
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(`is in the namespace of plugin "${PLUGIN_ID}.pro"`)
      expect(await getDataRow(h.db, MAIN_SCOPE, `${PLUGIN_ID}.pro.home`)).toBeNull()
    })

    it('never a class id inside another installed plugin\'s namespace', async () => {
      expect((await install()).status).toBe(201)
      const nested = parsePluginManifest({ id: `${PLUGIN_ID}.pro`, name: 'Pro', version: '1.0.0', apiVersion: 1, permissions: [] })
      await installPlugin(h.db, nested, [])
      const cls = {
        id: `${PLUGIN_ID}.pro.cls`, name: 'acme-pro-cls', kind: 'class', selector: '.acme-pro-cls', order: 0,
        styles: { color: 'red' },
      }
      await install({ classes: [cls] })
      const res = await resync()
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(`is in the namespace of plugin "${PLUGIN_ID}.pro"`)
      expect(JSON.stringify(await getDraftSite(h.db, MAIN_SCOPE))).not.toContain(`${PLUGIN_ID}.pro.cls`)

      // Its own namespace, either separator, still installs.
      await install({ classes: [{ ...cls, id: `${PLUGIN_ID}/cls` }] })
      expect((await resync()).status).toBe(200)
      expect(JSON.stringify(await getDraftSite(h.db, MAIN_SCOPE))).toContain(`${PLUGIN_ID}/cls`)
    })

    it('never a slash-form id that names another plugin before the slash', async () => {
      expect((await install()).status).toBe(201)
      const nested = parsePluginManifest({ id: `${PLUGIN_ID}.pro`, name: 'Pro', version: '1.0.0', apiVersion: 1, permissions: [] })
      await installPlugin(h.db, nested, [])
      const cls = {
        id: `${PLUGIN_ID}.pro/cls`, name: 'acme-pro-cls', kind: 'class', selector: '.acme-pro-cls', order: 0,
        styles: { color: 'red' },
      }
      for (const pack of [
        { pages: [{ ...packPage('Pack wording'), id: `${PLUGIN_ID}.pro/home`, slug: 'pro-home' }] },
        { classes: [cls] },
      ]) {
        await install(pack)
        const res = await resync()
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toContain('must be namespaced under the plugin id')
      }
      expect(await getDataRow(h.db, MAIN_SCOPE, `${PLUGIN_ID}.pro/home`)).toBeNull()
      expect(JSON.stringify(await getDraftSite(h.db, MAIN_SCOPE))).not.toContain(`${PLUGIN_ID}.pro/cls`)
    })

    it('preserves the owner’s access rule and head settings when re-syncing a pack page', async () => {
      expect((await install()).status).toBe(201)
      const row = await getDataRow(h.db, MAIN_SCOPE, PAGE_ID)
      const access = { level: 'members', onDeny: 'hide' }
      const seo = { description: 'Set by the owner' }
      await saveDataRowDraft(h.db, MAIN_SCOPE, PAGE_ID, { cells: { ...row!.cells, access, seo }, slug: row!.slug })
      expect((await resync()).status).toBe(200)
      const after = await getDataRow(h.db, MAIN_SCOPE, PAGE_ID)
      expect(after?.cells.access).toEqual(access)
      expect(after?.cells.seo).toEqual(seo)
      expect(JSON.stringify(after?.cells.body)).toContain('From the pack')
    })
  })
})
