import { strToU8, zipSync } from 'fflate'
import { expect, test, type Page } from '@playwright/test'
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
 * The owner installs a plugin that registers loop sources and builds a page
 * with a loop on it. The editor offers the sources by the plugin's name,
 * says why a loop has nothing to draw (preview failed, no sample items,
 * still loading), draws the plugin's sample items, offers the source's
 * fields for binding, and publishes the real items. Previews are asked for
 * sparingly: one request for a typed filter value, none from an idle editor.
 * A list of sources that arrives late must not be mistaken for a missing
 * source, and a plugin disabled elsewhere reaches an open editor when its
 * author comes back to the tab.
 */

// Installing a plugin and publishing ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

const PLUGIN_SOURCE = `
  export async function activate(api) {
    const base = {
      filterSchema: {},
      orderByOptions: [{ id: 'name', label: 'Name' }],
      fields: [{ id: 'title', label: 'Title' }, { id: 'price', label: 'Price' }],
      fetch: async () => ({
        items: [
          { id: 'pro', fields: { title: 'Pro', price: '19' } },
          { id: 'team', fields: { title: 'Team', price: '13' } },
        ],
        totalItems: 2,
      }),
    }
    await api.cms.loops.registerSource({
      ...base,
      id: api.plugin.id + '.offers',
      label: 'Offers',
      filterSchema: { currency: { type: 'text', label: 'Currency' } },
      preview: (ctx) => [
        { id: 's1', fields: { title: 'Sample Pro ' + (ctx.filters.currency || ''), price: '0' } },
        { id: 's2', fields: { title: 'Sample Team ' + (ctx.filters.currency || ''), price: '0' } },
      ],
    })
    await api.cms.loops.registerSource({
      ...base, id: api.plugin.id + '.broken', label: 'Broken',
      preview: () => { throw new Error('secret detail from the plugin') },
    })
    await api.cms.loops.registerSource({ ...base, id: api.plugin.id + '.bare', label: 'Bare' })
  }
`

/**
 * What the browser tells a page when its tab is shown again. A test cannot
 * hide and show a real tab, so it sends the page that event itself.
 */
async function returnToTab(target: Page): Promise<void> {
  await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}

async function pickSource(page: Page, label: string): Promise<void> {
  await page.locator('#ctrl-sourceId').click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

test('a plugin loop source is picked, previewed and published from the editor (SITE-028)', async ({ page, context, browser }) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const pluginId = `e2e.shop-${suffix}`
  const sourceId = `${pluginId}.offers`
  const pageName = `Offers ${suffix}`
  const slug = `offers-${suffix}`
  const permissions = ['loops.register']
  const notice = (target: Page) => canvasFrame(target).locator('[data-loop-preview-notice]')
  const unavailable = `The loop source “${sourceId}” is not available.`

  // No preview of the whole run may be turned away as busy.
  const refusedPreviews: number[] = []
  page.on('response', (response) => {
    if (response.url().endsWith('/loop-sources/preview') && response.status() === 429) refusedPreviews.push(response.status())
  })

  await login(page)
  const admin = page.request
  const headers = { origin: new URL(page.url()).origin }
  const stepUp = async () => {
    const res = await admin.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  const setEnabled = async (enabled: boolean) => {
    const res = await admin.patch(`/admin/api/cms/plugins/${pluginId}`, { headers, data: { enabled } })
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

    await test.step('an empty loop says why it has nothing to draw', async () => {
      await openSiteEditor(page)
      await createPage(page, pageName, slug)
      await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
      await insertModuleViaPicker(page, 'base.loop')
      await expect(page.getByTestId('property-control-sourceId')).toBeVisible()

      // The picker lists the plugin's sources after the built-in ones.
      await page.locator('#ctrl-sourceId').click()
      const options = await page.getByRole('option').allTextContents()
      expect(options.indexOf('E2E Shop: Offers')).toBeGreaterThan(options.indexOf('Data rows'))
      await page.getByRole('option', { name: 'E2E Shop: Broken', exact: true }).click()

      // A preview that throws: the loop says so, without the plugin's own words,
      // and once the editor has stopped retrying it offers to try again.
      await expect(notice(page)).toContainText('E2E Shop could not preview this list', { timeout: 15_000 })
      await expect(notice(page)).not.toContainText('secret detail')
      const tryAgain = canvasFrame(page).getByRole('button', { name: 'Try again' })
      await expect(tryAgain).toBeVisible({ timeout: 30_000 })
      const retried = page.waitForRequest((request) => request.url().endsWith('/loop-sources/preview'))
      await tryAgain.click()
      await retried

      // A source with no preview().
      await pickSource(page, 'E2E Shop: Bare')
      await expect(notice(page)).toContainText('E2E Shop has no sample items for this list')

      // A preview still on its way.
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/admin/api/cms/loop-sources/preview', async (route) => {
        await held
        await route.continue()
      })
      await pickSource(page, 'E2E Shop: Offers')
      await expect(notice(page)).toContainText('Loading a preview from E2E Shop')
      release()
      await expect(notice(page)).toHaveCount(0, { timeout: 15_000 })
      await page.unroute('**/admin/api/cms/loop-sources/preview')
    })

    await test.step('the canvas draws the sample items and the binding picker offers the fields', async () => {
      const previews: string[] = []
      page.on('request', (request) => {
        if (request.url().endsWith('/loop-sources/preview')) previews.push(request.postData() ?? '')
      })

      // The source's own filter appears once it is picked. Typed a key at a
      // time, the value is asked about once, when the typing has stopped.
      await expect(page.getByTestId('property-control-currency')).toBeVisible()
      await page.locator('#ctrl-currency').pressSequentially('eur', { delay: 250 })
      await expect.poll(() => previews.length, { timeout: 10_000 }).toBe(1)
      expect(JSON.parse(previews[0]!)).toMatchObject({ filters: { currency: 'eur' } })

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', 'Offer')
      await page.getByRole('button', { name: 'Insert binding for Text' }).click()
      const bindingMenu = page.getByRole('menu', { name: 'Insert binding for Text' })
      await expect(bindingMenu.getByRole('button').filter({ hasText: 'Price' })).toBeVisible()
      await bindingMenu.getByRole('button').filter({ hasText: 'Title' }).first().click()
      await page.keyboard.press('Escape')
      await expect(page.locator('#ctrl-text')).toHaveValue('Offer {currentEntry.title}')

      await expect(canvasFrame(page).getByText('Offer Sample Pro eur')).toBeVisible({ timeout: 15_000 })
      await expect(canvasFrame(page).getByText('Offer Sample Team eur')).toBeVisible()

      // Adding the child asked nothing new, and an editor left alone asks nothing at all.
      await page.waitForTimeout(6_000)
      expect(previews).toHaveLength(1)
    })

    await test.step('the published page lists the real items', async () => {
      await publishDraft(page)
      const visitorContext = await browser.newContext()
      const visitor = await visitorContext.newPage()
      try {
        await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
        await expect(visitor.getByText('Offer Pro', { exact: true })).toBeVisible()
        await expect(visitor.getByText('Offer Team', { exact: true })).toBeVisible()
        await expect(visitor.getByText(/Sample/)).toHaveCount(0)
      } finally {
        await visitorContext.close()
      }
    })

    await test.step('a list of sources that arrives late is not a missing source', async () => {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/admin/api/cms/loop-sources', async (route) => {
        await held
        await route.continue()
      })
      await page.reload()
      await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
      await expect(canvasFrame(page).locator('[data-instatic-loop]')).toBeAttached({ timeout: 15_000 })
      // The loop is on screen and its source is not known yet: it waits, it does not complain.
      await page.waitForTimeout(1_500)
      await expect(canvasFrame(page).getByText(unavailable, { exact: false })).toHaveCount(0)
      release()
      // The same mounted loop picks the source up when the list lands.
      await expect(canvasFrame(page).getByText('Offer Sample Pro eur')).toBeVisible({ timeout: 15_000 })
      await page.unroute('**/admin/api/cms/loop-sources')
    })

    await test.step('a plugin disabled elsewhere reaches an open editor when its tab is shown again', async () => {
      const second = await context.newPage()
      try {
        await second.goto(page.url())
        await second.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
        await expect(canvasFrame(second).getByText('Offer Sample Pro eur')).toBeVisible({ timeout: 20_000 })

        await setEnabled(false)
        // Nothing is pushed to an open editor: until its author comes back, it shows what it had.
        await page.waitForTimeout(2_000)
        await expect(canvasFrame(second).getByText('Offer Sample Pro eur')).toBeVisible()

        for (const tab of [page, second]) {
          await returnToTab(tab)
          await expect(canvasFrame(tab).getByText(unavailable, { exact: false })).toBeVisible({ timeout: 15_000 })
          await expect(canvasFrame(tab).getByText('Offer Sample Pro eur')).toHaveCount(0)
        }
        // The picker follows too, on the loop that was selected all along.
        await canvasFrame(page).locator('[data-module-id="base.loop"]').first().click()
        await expect(page.getByRole('status').filter({ hasText: 'this loop publishes nothing' })).toBeVisible()
        await expect(page.locator('#ctrl-sourceId')).toHaveValue(`${sourceId} (unavailable)`)

        await setEnabled(true)
        for (const tab of [page, second]) {
          await returnToTab(tab)
          await expect(canvasFrame(tab).getByText('Offer Sample Pro eur')).toBeVisible({ timeout: 15_000 })
        }
        await expect(page.locator('#ctrl-sourceId')).toHaveValue('E2E Shop: Offers')
        await expect(page.getByRole('status').filter({ hasText: 'this loop publishes nothing' })).toHaveCount(0)
      } finally {
        await second.close()
      }
    })
    await test.step('publishing from an editor that has not heard says the list went out empty', async () => {
      await setEnabled(false)
      // This editor has not been told: it still shows the plugin's sample items.
      await expect(canvasFrame(page).getByText('Offer Sample Pro eur')).toBeVisible()
      await canvasFrame(page).getByText('Offer Sample Pro eur').click()
      await setPropValue(page, 'text', 'Plan {currentEntry.title}')

      // The toast is watched for while the publish runs: it is gone again by
      // the time `publishDraft` has finished waiting for a step-up prompt.
      const warned = (async () => {
        await expect(page.getByText('Published, but a loop source is not available')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByText(`“${sourceId}” (on ${pageName})`, { exact: false })).toBeVisible()
      })()
      await Promise.all([warned, publishDraft(page)])
      // The canvas has caught up too.
      await expect(canvasFrame(page).getByText(unavailable, { exact: false })).toBeVisible({ timeout: 15_000 })

      const visitorContext = await browser.newContext()
      const visitor = await visitorContext.newPage()
      try {
        await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
        await expect(visitor.getByText(/Plan|Offer/)).toHaveCount(0)
      } finally {
        await visitorContext.close()
      }
    })
    expect(refusedPreviews).toEqual([])
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
