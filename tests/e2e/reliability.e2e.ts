import { expect, test } from '@playwright/test'
import {
  canvasFrame,
  createPage,
  expectEditorReady,
  insertNotchModule,
  openSiteEditor,
  openSitePanel,
  setPropValue,
} from './helpers'

/**
 * REL-001 — refresh during normal editing. This is a recovery smoke, not a
 * replacement for deeper crash/error-boundary audits.
 */
test.describe('reliability', () => {
  test('reloads during normal editing and recovers the canvas (REL-001)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const pageName = `Reload Recovery ${suffix}`
    const slug = `reload-recovery-${suffix}`
    const text = `Reload recovery text ${suffix}`

    await openSiteEditor(page)
    await createPage(page, pageName, slug)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', text)
    await expect(canvasFrame(page).getByText(text, { exact: true })).toBeVisible()

    await page.reload()
    await expectEditorReady(page)
    await openSitePanel(page)

    const createdPage = page.getByRole('treeitem', { name: `Open page ${pageName}` })
    await expect(createdPage).toBeVisible()
    await createdPage.click()
    await expect(createdPage).toHaveAttribute('aria-selected', 'true')

    const reloadedText = canvasFrame(page).getByText(text, { exact: true })
    await expect(reloadedText).toBeVisible()
    await reloadedText.click()
    await expect(page.getByTestId('property-control-text')).toBeVisible()
  })
})
