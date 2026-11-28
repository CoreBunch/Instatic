import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, ADMIN_BASE_URL, OWNER, login } from './helpers'

async function geometry(page: Page) {
  const selectors = ['header', '.work-title', '.entry-content', '.studio', '.gallery img', 'footer']
  return Promise.all(selectors.map(async selector => {
    const box = await page.locator(selector).first().boundingBox()
    if (!box) throw new Error('Missing visible source element ' + selector)
    return Object.values(box).map(Math.round)
  }))
}

const bundle = process.env.WORDPRESS_PILOT_BUNDLE
test.use({ storageState: ANONYMOUS_STATE })

// This test restores the whole disposable site. Run it alone with the documented fixture.
test('WordPress portfolio stays editable and works offline (CONTENT-012)', async ({ page, browser }, info) => {
  test.skip(!bundle, 'Requires the real WordPress fixture export')
  test.setTimeout(100_000)
  await login(page)
  const headers = { origin: ADMIN_BASE_URL }
  const admin = page.request
  const step = await admin.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
  expect(step.ok(), await step.text()).toBe(true)
  await page.goto('/admin/data')
  await page.getByRole('button', { name: 'Import site', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles(bundle!)
  await page.getByText('Replace everything', { exact: true }).click()
  const applied = page.waitForResponse(r => r.url().includes('/cms/import/archive') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Replace site', exact: true }).click()
  const imported = await applied
  expect(imported.status()).toBe(200)
  const publish = await admin.post('/admin/api/cms/publish', { headers })
  expect(publish.ok(), await publish.text()).toBe(true)
  const { tables } = await (await admin.get('/admin/api/cms/data/tables')).json()
  const findTable = (slug: string) => tables.find((t: {slug: string}) => t.slug === slug)
  const projects = findTable('project')
  expect(findTable('vacancy')).toBeTruthy()
  const getRows = async (id: string) => (await (await admin.get('/admin/api/cms/data/tables/' + id + '/rows')).json()).rows
  const entries = await getRows(projects.id)
  expect(entries).toHaveLength(3)
  const draft = entries.find((r: {cells: {title: string}}) => r.cells.title === 'Unreleased sketch')
  expect(draft.status).toBe('draft')
  expect(entries.some((r: {cells: {title: string}}) => r.cells.title === 'Private commission')).toBe(false)
  const atlas = entries.find((r: {slug: string}) => r.slug === 'atlas')
  const clients = await getRows(findTable('client').id)
  expect(atlas.cells.acf_client).toBe(clients[0].id)
  expect(atlas.cells.acf_gallery).toHaveLength(2)
  const terms = await getRows(findTable('wp-tax-discipline').id)
  const identity = terms.find((r: {slug: string}) => r.slug === 'identity')
  expect(identity.cells.parent).toBe(terms.find((r: {slug: string}) => r.slug === 'design').id)
  expect(atlas.cells.tax_discipline).toEqual([identity.id])
  const publishRow = async (id: string) => {
    const res = await admin.post('/admin/api/cms/data/rows/' + id + '/publish', { headers })
    expect(res.ok(), await res.text()).toBe(true)
  }
  for (const entry of entries) if (entry.id !== draft.id) await publishRow(entry.id)

  const visitor = await browser.newContext({ baseURL: ADMIN_BASE_URL })
  const external = new Set<string>()
  await visitor.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === ADMIN_BASE_URL) return route.continue()
    external.add(url.href)
    await route.abort()
  })
  try {
    const tab = await visitor.newPage()
    await tab.goto('/work/atlas')
    await expect(tab.getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible()
    await expect(tab.getByText('Atlas editorial body.')).toBeVisible()
    await expect(tab.getByText('Aster studio')).toBeVisible()
    await expect(tab.locator('.gallery img')).toHaveCount(2)
    await expect.poll(() => tab.locator('.gallery img').evaluateAll(images => images.every(i => (i as HTMLImageElement).naturalWidth === 12))).toBe(true)
    await expect(tab.locator('header')).toHaveCount(1)
    await expect(tab.locator('footer')).toHaveCount(1)
    await expect(tab.locator('.work-title')).toHaveCSS('font-size', '64px')
    await tab.screenshot({ path: info.outputPath('atlas-desktop.png') })
    await tab.setViewportSize({ width: 390, height: 844 })
    await expect(tab.locator('.work-title')).toHaveCSS('font-size', '32px')
    await tab.screenshot({ path: info.outputPath('atlas-mobile.png') })
    const sourceOrigin = process.env.WORDPRESS_PILOT_ORIGIN
    if (sourceOrigin) {
      const reference = await browser.newPage()
      try {
        for (const width of [390, 1280]) {
          const size = { width, height: 844 }
          await tab.setViewportSize(size)
          await reference.setViewportSize(size)
          await reference.goto(new URL('/work/atlas/', sourceOrigin).href)
          expect(await geometry(tab)).toEqual(await geometry(reference))
          const sourceImage = await reference.screenshot({ path: info.outputPath('wordpress-' + width + '.png') })
          const migratedImage = await tab.screenshot({ path: info.outputPath('instatic-' + width + '.png') })
          expect(migratedImage.equals(sourceImage), 'WordPress and Instatic screenshot at ' + width + 'px').toBe(true)
        }
      } finally { await reference.close() }
    }
    const client = clients[0]
    const editClient = await admin.patch('/admin/api/cms/data/rows/' + client.id, {
      headers, data: { cells: { ...client.cells, title: 'Cedar & Co' } },
    })
    expect(editClient.ok(), await editClient.text()).toBe(true)
    await publishRow(client.id)
    await tab.goto('/client/cedar')
    await expect(tab.getByRole('heading', { name: 'Cedar & Co' })).toBeVisible()
    await tab.goto('/work/atlas')
    const patched = await admin.patch('/admin/api/cms/data/rows/' + atlas.id, { headers, data: { cells: { ...atlas.cells, acf_studio: 'Updated studio' } } })
    expect(patched.ok(), await patched.text()).toBe(true)
    await publishRow(atlas.id)
    await tab.reload()
    await expect(tab.getByText('Updated studio')).toBeVisible()
    const created = await admin.post('/admin/api/cms/data/tables/' + projects.id + '/rows', { headers, data: { cells: {
      title: 'Third project', slug: 'third-project', body: 'New editorial body', acf_studio: 'New studio',
    } } })
    expect(created.ok(), await created.text()).toBe(true)
    await publishRow((await created.json()).row.id)
    await tab.goto('/work')
    await expect(tab.getByRole('link', { name: 'Unreleased sketch' })).toHaveCount(0)
    expect((await visitor.request.get('/work/' + draft.slug)).status()).toBe(404)
    expect((await visitor.request.get('/work/private-commission')).status()).toBe(404)
    await tab.getByRole('link', { name: 'Third project' }).click()
    await expect(tab).toHaveURL(/\/work\/third-project\/?$/)
    await expect(tab.getByText('New editorial body')).toBeVisible()
    await expect(tab.getByText('New studio')).toBeVisible()
    await tab.goto('/')
    await tab.locator('input[name=email]').fill('pilot@example.test')
    // The native runtime intentionally rejects form submissions made by a bot immediately after page load.
    await expect.poll(async () => tab.locator('form').count()).toBe(1)
    await tab.waitForTimeout(2200)
    await tab.getByRole('button', { name: 'Contact us' }).click()
    await expect.poll(async () => (await getRows(findTable('wp-form-enquiries').id)).some((r: {cells: {email: string}}) => r.cells.email === 'pilot@example.test')).toBe(true)
    expect([...external]).toEqual([])
  } finally {
    await visitor.close()
  }
})
