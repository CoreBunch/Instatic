import { expect, test } from '@playwright/test'
import { canvasFrameForBreakpoint, createPage, insertNotchModule, openSiteEditor } from './helpers'

test.use({ hasTouch: true })

test('replaces a selected image from the phone canvas (MEDIA-003)', async ({ page }) => {
  const slug = `phone-image-${Date.now()}`
  const files = ['coast', 'road'].map((name, index) => ({
    name: `${slug}-${name}.svg`,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="90"><rect width="200" height="90" fill="${index ? 'green' : 'blue'}"/></svg>`),
  }))
  await openSiteEditor(page)
  await createPage(page, 'Coast notes', slug)
  await insertNotchModule(page, 'image')
  await page.getByRole('button', { name: 'Browse image library' }).click()
  const picker = page.getByRole('dialog', { name: 'Select an image' })
  await picker.locator('input[type="file"]').setInputFiles(files)
  const coast = picker.getByRole('button', { name: `Open ${files[0].name}` })
  const road = picker.getByRole('button', { name: `Open ${files[1].name}` })
  const confirm = picker.getByRole('button', { name: 'Use selected' })
  await coast.click()
  await confirm.click()
  await expect(picker).toBeHidden()

  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(`/admin/site?page=${slug}`)
  const image = canvasFrameForBreakpoint(page, 'mobile').locator('img[data-module-id="base.image"]')
  await expect(image).toHaveAttribute('src', /coast/)
  await image.tap()
  const replace = page.getByRole('button', { name: 'Replace image' })
  await expect(replace).toBeInViewport()
  await replace.tap()
  await expect(coast).toHaveAttribute('aria-pressed', 'true')
  await expect(picker.getByRole('button', { name: 'Close picker' })).toBeFocused()
  await expect(picker.getByRole('button', { name: 'Videos' })).toHaveCount(0)
  await expect(picker.getByRole('button', { name: 'Open Folders panel' })).toBeVisible()
  await road.tap()
  await picker.getByRole('button', { name: 'Cancel' }).tap()
  await expect(image).toHaveAttribute('src', /coast/)

  await replace.tap()
  await picker.getByRole('searchbox', { name: 'Search media' }).press('Escape')
  await expect(replace).toBeVisible()
  await expect(picker).toBeHidden()

  await replace.tap()
  await picker.getByRole('searchbox', { name: 'Search media' }).fill(files[1].name)
  await road.tap()
  await expect(confirm).toBeInViewport({ ratio: 1 })
  await confirm.tap()
  await expect(picker).toBeHidden()
  await expect(image).toHaveAttribute('src', /road/)
  await expect(replace).toBeVisible()
  await expect(page.getByTestId('canvas-root')).toBeFocused()
  await page.getByRole('button', { name: 'Undo', exact: true }).tap()
  await expect(image).toHaveAttribute('src', /coast/)
  await page.getByRole('button', { name: 'Redo', exact: true }).tap()
  await expect(image).toHaveAttribute('src', /road/)
  await page.reload()
  await expect(image).toHaveAttribute('src', /road/)
})
