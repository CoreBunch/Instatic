import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE, PUBLIC_BASE_URL, login, openSiteEditor, createPage,
  insertNotchModule, setPropValue, publishDraft, completeStepUp,
} from './helpers'

test.use({ storageState: ANONYMOUS_STATE })

test('restore keeps the backed-up public page and its newer draft (PUBLISH-006)', async ({ page, browser }) => {
  await login(page)
  await openSiteEditor(page)
  await createPage(page, 'Backup restore', 'backup-restore')
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', 'Published when backed up')
  await publishDraft(page)
  await setPropValue(page, 'text', 'Unfinished draft at backup')
  await expect(page.getByRole('status', { name: 'Draft synced' })).toBeVisible()
  const exported = await page.request.get('/admin/api/cms/export')
  expect(exported.ok()).toBe(true)
  const backup = await exported.body()

  // Make the destination visibly different, including its baked HTML/cache.
  await setPropValue(page, 'text', 'Later content to replace')
  await publishDraft(page)
  const visitor = await browser.newPage()
  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/backup-restore`)
    await expect(visitor.getByText('Later content to replace')).toBeVisible()
    await page.goto('/admin/data')
    await page.getByRole('button', { name: 'Import site', exact: true }).click()
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: backup })
    await expect(page.getByRole('dialog', { name: 'Review import' })).toBeVisible()
    await page.getByRole('radio', { name: /Replace everything/ }).check()
    await page.getByRole('button', { name: /^Replace/ }).click()
    await completeStepUp(page)
    await expect(page.getByRole('dialog', { name: 'Import complete', exact: true })).toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: '.tmp/evidence/backup-import.png', fullPage: true })
    await visitor.reload()
    await visitor.screenshot({ path: '.tmp/evidence/backup-public.png', fullPage: true })
    await expect(visitor.getByText('Published when backed up')).toBeVisible()
    await expect(visitor.getByText('Unfinished draft at backup')).toHaveCount(0)
    const rowsResponse = await page.request.get('/admin/api/cms/data/tables/pages/rows')
    const { rows } = await rowsResponse.json()
    const restored = rows.find((row: { slug: string }) => row.slug === 'backup-restore')
    expect(JSON.stringify(restored.cells)).toContain('Unfinished draft at backup')
  } finally { await visitor.close() }
})
