import { expect, test } from '@playwright/test'
import { completeStepUp } from './helpers'

// ADMIN-012: Settings outside Site must show a subsequently imported shell.
test('Settings refreshes after a CMS bundle import from Data (ADMIN-012)', async ({ page }, testInfo) => {
  await page.goto('/admin/data')
  await page.getByTestId('toolbar-settings-btn').click()
  await expect(page.getByLabel('Site Name', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  const response = await page.request.get('/admin/api/cms/site')
  expect(response.ok()).toBe(true)
  const { site } = await response.json()
  const name = `Imported settings ${Date.now().toString(36)}`
  const title = `${name} title`
  const bundle = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    site: { ...site, name, settings: { ...site.settings, metaTitle: title } },
    tables: [], rows: [],
  }
  await page.getByRole('button', { name: 'Import site', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)),
  })
  await page.getByRole('radio', { name: /Merge: overwrite/ }).check()
  await page.getByRole('button', { name: 'Overwrite rows', exact: true }).click()
  await completeStepUp(page)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByTestId('toolbar-settings-btn').click()
  await expect(page.getByLabel('Site Name', { exact: true })).toHaveValue(name)
  await expect(page.getByLabel('Meta Title', { exact: true })).toHaveValue(title)
  await page.screenshot({ path: testInfo.outputPath('after-settings-import.png') })
})
