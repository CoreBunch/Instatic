import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true })

test('a phone editor can retry a row edit and return to filtered rows (DATA-003)', async ({ page }) => {
  await page.goto('/admin/data')
  const title = `Studio hours ${Date.now()}`
  const edited = `${title} updated`
  const response = await page.request.post('/admin/api/cms/data/tables/posts/rows', {
    headers: { origin: new URL(page.url()).origin },
    data: { cells: { title, slug: `studio-hours-${Date.now()}` } },
  })
  expect(response.ok(), await response.text()).toBe(true)
  const { row } = await response.json()
  const posts = page.getByRole('option', { name: 'Posts post-type' })
  await posts.tap()
  const grid = page.getByRole('region', { name: 'Posts data grid' })
  const search = grid.getByRole('searchbox')
  await search.fill(title)
  await grid.getByRole('gridcell').filter({ hasText: title }).tap()
  const inspector = page.getByTestId('data-inspector-panel')
  await expect.poll(async () => (await inspector.boundingBox())?.width).toBe(320)
  await expect(grid).toBeHidden()
  const field = inspector.getByRole('textbox', { name: 'Title', exact: true })
  const back = inspector.getByRole('button', { name: 'Back to rows' })
  const rowUrl = `**/admin/api/cms/data/rows/${row.id}`
  await page.route(rowUrl, route => route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }))
  await field.fill(edited)
  await back.tap()
  await expect(inspector.getByRole('status')).toHaveText('Could not save draft')
  await expect(field).toHaveValue(edited)
  await page.unroute(rowUrl)

  // Keep the retry in flight while the user edits once more. Back must wait
  // for both snapshots, and only the most recent title should survive reload.
  let releaseRetry!: () => void
  const retry = new Promise<void>(resolve => { releaseRetry = resolve })
  await page.route(rowUrl, async route => {
    await retry
    await route.continue()
  }, { times: 1 })
  const retryStarted = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith(row.id))
  await back.tap()
  await retryStarted
  const finalTitle = `${title} confirmed`
  try {
    await field.fill(finalTitle)
  } finally {
    releaseRetry()
  }
  await expect(inspector).toBeHidden()
  await expect(search).toHaveValue(title)
  await expect(grid.getByRole('gridcell').filter({ hasText: finalTitle })).toBeVisible()

  await page.reload()
  await posts.tap()
  await grid.getByRole('gridcell').filter({ hasText: finalTitle }).tap()
  await expect(field).toHaveValue(finalTitle)
})
