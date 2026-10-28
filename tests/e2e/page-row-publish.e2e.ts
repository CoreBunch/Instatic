import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE, PUBLIC_BASE_URL, login, openSiteEditor, createPage,
  insertNotchModule, setPropValue, publishDraft,
} from './helpers'

test.use({ storageState: ANONYMOUS_STATE })

test('an individual page publish reaches visitors (PUBLISH-005)', async ({ page, browser }) => {
  await login(page)
  await openSiteEditor(page)
  await createPage(page, 'Individual publish', 'individual-publish')
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', 'Page publication: version one')
  await publishDraft(page)

  const visitor = await browser.newPage()
  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/individual-publish`)
    await expect(visitor.getByText('Page publication: version one')).toBeVisible()

    await setPropValue(page, 'text', 'Page publication: version two')
    await expect(page.getByRole('status', { name: 'Draft synced' })).toBeVisible()
    const response = await page.request.get('/admin/api/cms/data/tables/pages/rows')
    expect(response.ok()).toBe(true)
    const { rows } = await response.json()
    const row = rows.find((candidate: { slug: string }) => candidate.slug === 'individual-publish')
    expect(row).toBeTruthy()
    const publish = await page.request.post(`/admin/api/cms/data/rows/${row.id}/publish`, {
      headers: { origin: new URL(page.url()).origin },
    })
    expect(publish.ok(), await publish.text()).toBe(true)

    await visitor.reload()
    await visitor.screenshot({ path: '.tmp/evidence/page-row-publish.png', fullPage: true })
    await expect(visitor.getByText('Page publication: version two')).toBeVisible()
  } finally {
    await visitor.close()
  }
})
