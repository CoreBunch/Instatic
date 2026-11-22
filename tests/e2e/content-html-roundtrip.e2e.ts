import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE, PUBLIC_BASE_URL, login, openSiteEditor, openSitePanel,
  insertNotchModule, insertModuleViaPicker, setPropValue, publishDraft,
  entryRow, completeStepUp,
} from './helpers'

test.use({ storageState: ANONYMOUS_STATE })

test('editing imported HTML keeps published image URLs intact (CONTENT-011)', async ({ page, browser }) => {
  await login(page)
  await openSiteEditor(page)
  await openSitePanel(page)
  await page.getByRole('button', { name: 'New template', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Template settings' })
  await dialog.getByLabel('Name').fill('HTML round-trip posts')
  await dialog.getByLabel('Slug').fill('html-roundtrip-template')
  await dialog.getByLabel('Applies to').click()
  await page.getByRole('option', { name: 'Post types' }).click()
  await dialog.getByLabel('Posts').setChecked(true)
  await dialog.getByLabel('Priority').fill('300')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', '{currentEntry.title}')
  await insertModuleViaPicker(page, 'base.outlet')
  await publishDraft(page)

  // Seed the imported HTML through the authenticated API; editing/saving stays in the UI.
  const headers = { origin: new URL(page.url()).origin }
  const uploaded = await page.request.post('/admin/api/cms/media', {
    headers,
    multipart: { file: { name: 'hero_image.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><rect width="480" height="180" fill="#dce7e4"/><text x="35" y="100" font-size="28">Original uploaded image</text></svg>') } },
  })
  expect(uploaded.ok(), await uploaded.text()).toBe(true)
  const { asset } = await uploaded.json()
  expect(asset.publicPath).toContain('_')
  const originalHtml = `<figure class="imported_hero"><img src="${asset.publicPath}" alt="Original uploaded image" width="480" height="180"></figure>`
  const created = await page.request.post('/admin/api/cms/data/tables/posts/rows', {
    headers, data: { cells: { slug: 'html-roundtrip', title: 'Imported HTML post', body: originalHtml } },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { row } = await created.json()
  const published = await page.request.post(`/admin/api/cms/data/rows/${row.id}/publish`, { headers })
  expect(published.ok(), await published.text()).toBe(true)
  const visitor = await browser.newPage()
  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/posts/html-roundtrip`)
    const hero = visitor.getByRole('img', { name: 'Original uploaded image' })
    await expect(hero).toBeVisible()
    await expect.poll(() => hero.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(480)

    await page.goto('/admin/content')
    await entryRow(page, 'Imported HTML post').click()
    const editor = page.getByTestId('content-body-editor')
    await expect(editor).toContainText(originalHtml)
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Edited below the imported HTML.')
    await page.getByRole('button', { name: 'Publish post', exact: true }).click()
    await completeStepUp(page)
    await expect(page.getByRole('button', { name: 'Published', exact: true })).toBeDisabled()

    await visitor.reload()
    await expect(visitor.getByText('Edited below the imported HTML.')).toBeVisible()
    await visitor.screenshot({ path: '.tmp/evidence/content-html-roundtrip.png', fullPage: true })
    await expect(hero).toHaveAttribute('src', asset.publicPath)
    await expect.poll(() => hero.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(480)
    const saved = await page.request.get(`/admin/api/cms/data/rows/${row.id}`)
    expect(saved.ok()).toBe(true)
    expect((await saved.json()).row.cells.body).toContain(originalHtml)
  } finally { await visitor.close() }
})
