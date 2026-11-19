import { strToU8, zipSync } from 'fflate'
import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  OWNER,
  PUBLIC_BASE_URL,
  canvasFrame,
  createPage,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  openSiteEditor,
  publishDraft,
  setPropValue,
} from './helpers'

/**
 * SITE-028 — a plugin's loop source in the editor.
 *
 * The owner installs a plugin that registers a loop source, builds a page
 * with a loop on it, and the editor offers the source by the plugin's name,
 * shows its filter, draws the plugin's sample items on the canvas, and
 * publishes the real ones. With the plugin disabled, the loop says its
 * source is gone instead of drawing nothing.
 */

// Installing a plugin and publishing ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

const PLUGIN_SOURCE = `
  export async function activate(api) {
    await api.cms.loops.registerSource({
      id: api.plugin.id + '.offers',
      label: 'Offers',
      filterSchema: { currency: { type: 'text', label: 'Currency' } },
      orderByOptions: [{ id: 'name', label: 'Name' }],
      fields: [{ id: 'title', label: 'Title' }],
      fetch: async () => ({
        items: [
          { id: 'pro', fields: { title: 'Pro' } },
          { id: 'team', fields: { title: 'Team' } },
        ],
        totalItems: 2,
      }),
      preview: (ctx) => [
        { id: 's1', fields: { title: 'Sample Pro ' + (ctx.filters.currency || '') } },
        { id: 's2', fields: { title: 'Sample Team ' + (ctx.filters.currency || '') } },
      ],
    })
  }
`

test('a plugin loop source is picked, previewed and published from the editor (SITE-028)', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const pluginId = `e2e.shop-${suffix}`
  const sourceId = `${pluginId}.offers`
  const pageName = `Offers ${suffix}`
  const slug = `offers-${suffix}`
  const permissions = ['loops.register']

  await login(page)
  const admin = page.request
  const headers = { origin: new URL(page.url()).origin }
  const stepUp = async () => {
    const res = await admin.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
    expect(res.ok(), await res.text()).toBe(true)
  }

  try {
    await test.step('install the plugin', async () => {
      await stepUp()
      const manifest = {
        id: pluginId,
        name: 'E2E Shop',
        version: '1.0.0',
        apiVersion: 1,
        permissions,
        entrypoints: { server: 'server/index.js' },
        resources: [],
        adminPages: [],
      }
      const installed = await admin.post('/admin/api/cms/plugins/package', {
        headers,
        multipart: {
          file: {
            name: `${pluginId}.zip`,
            mimeType: 'application/zip',
            buffer: Buffer.from(zipSync({
              'plugin.json': strToU8(JSON.stringify(manifest)),
              'server/index.js': strToU8(PLUGIN_SOURCE),
            })),
          },
          grantedPermissions: JSON.stringify(permissions),
        },
      })
      expect(installed.ok(), await installed.text()).toBe(true)
    })

    await test.step('pick the plugin source for a loop', async () => {
      await openSiteEditor(page)
      await createPage(page, pageName, slug)
      await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
      await insertModuleViaPicker(page, 'base.loop')

      await expect(page.getByTestId('property-control-sourceId')).toBeVisible()
      await page.locator('#ctrl-sourceId').click()
      await expect(page.getByRole('option', { name: 'E2E Shop: Offers', exact: true })).toBeVisible()
      await page.getByRole('option', { name: 'E2E Shop: Offers', exact: true }).click()
      // The source's own filter and sort key appear once it is picked.
      await expect(page.getByTestId('property-control-currency')).toBeVisible()
      await setPropValue(page, 'currency', 'eur')
    })

    await test.step('the canvas draws the plugin\'s sample items', async () => {
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', 'Offer {currentEntry.title}')
      await expect(canvasFrame(page).getByText('Offer Sample Pro eur')).toBeVisible({ timeout: 15_000 })
      await expect(canvasFrame(page).getByText('Offer Sample Team eur')).toBeVisible()
    })

    await test.step('the published page lists the real items', async () => {
      await publishDraft(page)
      const context = await browser.newContext()
      const visitor = await context.newPage()
      try {
        await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
        await expect(visitor.getByText('Offer Pro', { exact: true })).toBeVisible()
        await expect(visitor.getByText('Offer Team', { exact: true })).toBeVisible()
        await expect(visitor.getByText(/Sample/)).toHaveCount(0)
      } finally {
        await context.close()
      }
    })

    await test.step('with the plugin disabled the loop says its source is gone', async () => {
      const disabled = await admin.patch(`/admin/api/cms/plugins/${pluginId}`, { headers, data: { enabled: false } })
      expect(disabled.ok(), await disabled.text()).toBe(true)
      await page.reload()
      await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
      await expect(
        canvasFrame(page).getByText(`The loop source “${sourceId}” is not available.`, { exact: false }),
      ).toBeVisible({ timeout: 15_000 })
      await canvasFrame(page).locator('[data-module-id="base.loop"]').first().click()
      await expect(page.getByRole('status').filter({ hasText: 'this loop publishes nothing' })).toBeVisible()
      await expect(page.locator('#ctrl-sourceId')).toHaveValue(`${sourceId} (unavailable)`)
      await expect(page.locator('#ctrl-sourceId')).toBeInViewport({ ratio: 1 })
    })
  } finally {
    // The suite shares one site: leave neither the plugin nor the page behind.
    await stepUp()
    await admin.delete(`/admin/api/cms/plugins/${pluginId}?force=true`, { headers })
    const { rows } = (await (await admin.get('/admin/api/cms/pages')).json().catch(() => ({ rows: [] }))) as {
      rows?: Array<{ id: string; slug: string }>
    }
    const created = rows?.find((row) => row.slug === slug)
    if (created) await admin.delete(`/admin/api/cms/data/rows/${created.id}`, { headers })
  }
})
