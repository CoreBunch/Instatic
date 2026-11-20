import { expect, test } from '@playwright/test'
import { createPage, insertModuleViaPicker, openSiteEditor, openSitePanel } from './helpers'

/**
 * ADMIN-0xx — the Required switch on a form control toggles both ways.
 */
test('the Input Required switch turns on and off', async ({ page }) => {
  await openSiteEditor(page)
  const suffix = Date.now().toString(36)
  const name = `Required switch ${suffix}`
  await createPage(page, name, `required-${suffix}`)
  await openSitePanel(page)
  await page.getByRole('treeitem', { name: `Open page ${name}` }).click()

  await insertModuleViaPicker(page, 'base.form')
  await insertModuleViaPicker(page, 'base.input')

  const required = page.locator('#ctrl-required')
  await expect(required).toHaveAttribute('aria-checked', 'false')
  await required.click()
  await expect(required).toHaveAttribute('aria-checked', 'true')
  await required.click()
  await expect(required).toHaveAttribute('aria-checked', 'false')
})
