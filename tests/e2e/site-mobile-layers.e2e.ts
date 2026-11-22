import { expect, test } from '@playwright/test'
import { canvasFrameForBreakpoint, createPage, insertNotchModule, openLayersPanel, openSiteEditor, setPropValue } from './helpers'

test.use({ hasTouch: true })

test('reorders distant sibling layers by touch and undoes the move on the canvas (BUILDER-003)', async ({ page }) => {
  const slug = `phone-layers-${Date.now()}`
  const heading = 'Open studio'
  const hours = 'Saturday, 11 am to 3 pm.'
  const original = [heading, ...Array.from({ length: 8 }, (_, i) => `Studio note ${i + 1}`), hours]
  await openSiteEditor(page)
  await createPage(page, slug, slug)
  for (const text of original) {
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', text)
  }

  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(`/admin/site?page=${slug}`)
  await openLayersPanel(page)
  const layers = page.getByTestId('dom-panel-ready')
  const search = layers.getByRole('searchbox', { name: 'Search layers' })
  await search.fill('saturday')
  await layers.getByRole('treeitem').filter({ hasText: hours }).tap()
  const selected = layers.getByRole('treeitem', { selected: true })
  await expect(selected).toContainText(hours)
  await expect(selected).toBeInViewport()
  await expect(layers.getByRole('treeitem').filter({ hasText: heading })).not.toBeInViewport()

  const move = layers.getByRole('button', { name: 'Move', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Move layer' })
  await move.tap()
  await dialog.getByRole('button', { name: 'Place after' }).tap()
  await expect(dialog.getByRole('button', { name: 'Move after Studio note 8' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Close dialog' }).tap()
  await expect(selected).toContainText(hours)
  await move.tap()
  await dialog.getByRole('searchbox').fill(heading)
  await dialog.getByRole('button', { name: `Move before ${heading}` }).tap()

  const frame = canvasFrameForBreakpoint(page, 'mobile')
  const paragraphs = frame.locator('p').filter({ hasText: /Open studio|Studio note|Saturday/ })
  const reordered = [hours, ...original.slice(0, -1)]
  await expect(paragraphs).toHaveText(reordered)
  await expect(frame.getByText(hours)).toBeInViewport()
  await expect(layers).toBeHidden()
  await expect(page.getByTestId('canvas-root')).toBeFocused()
  await expect(page.getByRole('button', { name: 'Edit text' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).tap()
  await expect(paragraphs).toHaveText(original)
  await page.getByRole('button', { name: 'Redo', exact: true }).tap()
  await expect(paragraphs).toHaveText(reordered)
  await page.reload()
  await expect(paragraphs).toHaveText(reordered)
})
