import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  canvasFrame,
  createPage,
  insertNotchModule,
  openSiteEditor,
  openSitePanel,
  setPropValue,
} from './helpers'

/**
 * PAGE-001 / PAGE-002 / PAGE-003 / PAGE-004 — create, rename, delete, and
 * switch pages after an unsaved edit without losing draft state.
 *
 * Each test creates its own uniquely-named pages in the Site Explorer, so it
 * never collides with the homepage (owned by the core lifecycle spec) or with a
 * reused database from a previous run.
 */
test.describe('page management', () => {
  test('creates a new page and opens it in the canvas (PAGE-001)', async ({
    page,
  }) => {
    const name = uniqueName('About')
    const slug = uniqueSlug('about')

    await openSiteEditor(page)
    await createPage(page, name, slug)

    // The new page is in the tree and opens in the canvas when selected.
    await openPage(page.getByRole('treeitem', { name: `Open page ${name}` }))
  })

  test('deletes a page from the explorer (PAGE-003)', async ({ page }) => {
    const name = uniqueName('Disposable')

    await openSiteEditor(page)
    await createPage(page, name, uniqueSlug('disposable'))
    const item = page.getByRole('treeitem', { name: `Open page ${name}` })

    await item.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete page?' })
    await expect(dialog).toBeVisible()
    await expect(item).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete page' }).click()

    await expect(item).toHaveCount(0)
  })

  test('renames a page and opens it under the new name (PAGE-002)', async ({
    page,
  }) => {
    const original = uniqueName('Pricing')
    const renamed = uniqueName('Plans')
    const slug = uniqueSlug('pricing')

    await openSiteEditor(page)
    await createPage(page, original, slug)

    await test.step('rename via the context menu', async () => {
      await page
        .getByRole('treeitem', { name: `Open page ${original}` })
        .click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename' }).click()

      const renameInput = page.getByRole('textbox', {
        name: `Rename ${original}`,
      })
      await renameInput.fill(renamed)
      await renameInput.press('Enter')
    })

    await test.step('the renamed page is openable and the old name is gone', async () => {
      const renamedItem = page.getByRole('treeitem', {
        name: `Open page ${renamed}`,
      })
      await expect(renamedItem).toBeVisible()
      await expect(
        page.getByRole('treeitem', { name: `Open page ${original}` }),
      ).toHaveCount(0)

      await openPage(renamedItem)
    })
  })

  test('keeps edits when switching pages and persists across a reload (PAGE-004)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const firstName = `Draft Source ${suffix}`
    const secondName = `Draft Target ${suffix}`
    const draftText = `Page switch draft ${suffix}`

    await openSiteEditor(page)
    await createPage(page, firstName, `draft-source-${suffix}`)
    await createPage(page, secondName, `draft-target-${suffix}`)

    const firstPage = page.getByRole('treeitem', { name: `Open page ${firstName}` })
    const secondPage = page.getByRole('treeitem', { name: `Open page ${secondName}` })

    // There is no save step and no dirty state: edits stream to the collab
    // relay as they land, so the toolbar reports a live sync, not "Unsaved".
    await test.step('edit the first page and observe the synced state', async () => {
      await openPage(firstPage)
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', draftText)
      await expect(page.getByRole('status', { name: 'Draft synced' })).toBeVisible()
      await expect(canvasFrame(page).getByText(draftText)).toBeVisible()
    })

    await test.step('switch away and back without losing the edit', async () => {
      await openSitePanel(page)
      await openPage(secondPage)
      await expect(canvasFrame(page).getByText(draftText)).toHaveCount(0)

      await openPage(firstPage)
      await expect(canvasFrame(page).getByText(draftText)).toBeVisible()
      await expect(page.getByRole('status', { name: 'Draft synced' })).toBeVisible()
    })

    await test.step('reload and verify the edit persists', async () => {
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      await openPage(firstPage)
      await expect(canvasFrame(page).getByText(draftText)).toBeVisible()
    })
  })

  test('reloads a synced draft at mobile width (SAVE-001)', async ({ page }) => {
    const suffix = Date.now().toString(36)
    const name = `Mobile Draft ${suffix}`
    const draftText = `Mobile reload persistence ${suffix}`

    await openSiteEditor(page)
    await createPage(page, name, `mobile-draft-${suffix}`)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', draftText)
    await expect(canvasFrame(page).getByText(draftText)).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await openSiteEditor(page)
    await openSitePanel(page)
    await openPage(page.getByRole('treeitem', { name: `Open page ${name}` }))

    await expect(canvasFrame(page).getByText(draftText)).toBeVisible()
    await expectMobileEditorPageContained(page)
    await expectMobileControlContained(
      page,
      page.getByTestId('toolbar-publish-actions-trigger'),
      'publish actions trigger',
    )
  })

  test('schedules the active page and surfaces it in the dashboard lineup (PUBLISH-002)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const name = `Scheduled Page ${suffix}`
    const slug = `scheduled-page-${suffix}`
    const draftText = `Scheduled page content ${suffix}`

    await openSiteEditor(page)
    await createPage(page, name, slug)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', draftText)

    await test.step('schedule the active page from the Site toolbar', async () => {
      await page.getByTestId('toolbar-publish-actions-trigger').click()
      await page.getByTestId('toolbar-schedule-publish-action').click()

      const dialog = page.getByRole('dialog', { name: 'Schedule this page' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Confirm' }).click()
      await expect(dialog).toBeHidden({ timeout: 20_000 })
    })

    await test.step('the dashboard reports the scheduled page row', async () => {
      await page.goto('/admin/dashboard')
      await expect(page).toHaveURL(/\/admin\/dashboard$/)

      const pagesWidget = page.locator('[data-widget="pages"]')
      await expect(pagesWidget).toContainText('Pages')
      await expect(pagesWidget).toContainText(/1 scheduled/, { timeout: 20_000 })

      const publishLineup = page.locator('[data-widget="publish"]')
      await expect(publishLineup).toContainText('Publish lineup')
      await expect(publishLineup).toContainText(`/${slug}`)
      await expect(publishLineup).toContainText('scheduled')
    })
  })
})

async function openPage(item: Locator): Promise<void> {
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
}

function uniqueName(base: string): string {
  return `${base} ${Date.now().toString(36)}`
}

function uniqueSlug(base: string): string {
  return `${base}-${Date.now().toString(36)}`
}

async function expectMobileEditorPageContained(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      viewportWidth: doc.clientWidth,
      viewportHeight: window.innerHeight,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    }
  })
  expect(metrics.viewportWidth).toBe(390)
  expect(metrics.viewportHeight).toBe(844)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
}

async function expectMobileControlContained(
  page: Page,
  locator: Locator,
  description: string,
): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${description} was visible but had no bounding box`)
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth)
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1)
}
