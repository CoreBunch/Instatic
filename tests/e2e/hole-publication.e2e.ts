import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE, PUBLIC_BASE_URL, login, openSiteEditor, createPage,
  insertNotchModule, setPropValue, publishDraft,
} from './helpers'

test.use({ storageState: ANONYMOUS_STATE })

test('an unrelated post publish preserves dynamic page content (PUBLISH-004)', async ({ page, browser }) => {
  await login(page)
  await openSiteEditor(page)
  await createPage(page, 'Dynamic content check', 'hole-check')
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', 'Dynamic content check')
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', 'Hello {route.query.q}')
  await publishDraft(page)
  const visitor = await browser.newPage()
  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/hole-check?q=world`)
    await expect(visitor.getByText('Hello world')).toBeVisible()
    const headers = { origin: new URL(page.url()).origin }
    const created = await page.request.post('/admin/api/cms/data/tables/posts/rows', {
      headers, data: { slug: 'unrelated-post', cells: { title: 'Unrelated post', body: 'Content' } },
    })
    expect(created.ok(), await created.text()).toBe(true)
    const { row } = await created.json()
    const published = await page.request.post(`/admin/api/cms/data/rows/${row.id}/publish`, { headers })
    expect(published.ok(), await published.text()).toBe(true)
    const hydrated = visitor.waitForResponse((response) => response.url().includes('/_instatic/hole/'))
    await visitor.reload()
    await hydrated
    await expect(visitor.locator('instatic-hole')).toHaveCount(0)
    await visitor.screenshot({ path: '.tmp/evidence/hole-publication.png', fullPage: true })
    await expect(visitor.getByText('Hello world')).toBeVisible()
  } finally {
    await visitor.close()
  }
})
