import { expect, test } from '@playwright/test'
import { canvasFrame } from './helpers'

// ADMIN-011: completing a static-site import from Data opens the imported page.
test('opens the imported page in the Site workspace from Data (ADMIN-011)', async ({ page }, testInfo) => {
  const title = `Imported page ${Date.now().toString(36)}`
  await page.goto('/admin/data')
  await page.getByRole('button', { name: 'Import site', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'imported-page.html',
    mimeType: 'text/html',
    buffer: Buffer.from(`<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`),
  })
  await expect(page.getByRole('dialog', { name: 'Review import' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue →', exact: true }).click()
  const openSite = page.getByRole('button', { name: 'Open site →', exact: true })
  await expect(openSite).toBeVisible({ timeout: 30_000 })
  await openSite.click()
  await expect(page).toHaveURL(/\/admin\/site(?:\?|$)/)
  await expect(canvasFrame(page).getByRole('heading', { name: title })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('after-open-site.png') })
})
