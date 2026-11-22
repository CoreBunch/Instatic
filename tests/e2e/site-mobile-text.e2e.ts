import { expect, test, type Locator } from '@playwright/test'
import { canvasFrame, canvasFrameForBreakpoint, createPage, insertNotchModule, openSiteEditor, setPropValue } from './helpers'

test.use({ hasTouch: true })

test('edits text on the phone canvas and returns to the page (EDIT-001)', async ({ page }) => {
  const slug = `studio-hours-${Date.now()}`
  const hours = 'Saturday, 10 am to 2 pm.'
  const revised = 'Saturday, 11 am to 3 pm.'
  await openSiteEditor(page)
  await createPage(page, 'Studio hours', slug)
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', hours)
  await expect(canvasFrame(page).getByText(hours)).toBeVisible()

  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(`/admin/site?page=${slug}`)
  const frame = canvasFrameForBreakpoint(page, 'mobile')
  const block = frame.getByText(hours, { exact: true })
  await expect(block).toBeInViewport()
  await block.tap()
  const actions = page.getByRole('group', { name: 'Text editing' })
  await actions.getByRole('button', { name: 'Properties' }).tap()
  await expect(page.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue(hours)
  await page.getByTestId('panel-close-properties').tap()
  await actions.getByRole('button', { name: 'Layer actions' }).tap()
  await expect(page.getByRole('button', { name: 'Drag selected layers' })).toBeVisible()
  const edit = actions.getByRole('button', { name: 'Edit text' })
  await expectConcentricCorners(actions, edit)
  await edit.tap()
  const surface = frame.locator('[contenteditable="plaintext-only"]')
  await expect(surface).toBeFocused()
  await surface.fill(revised)
  const done = actions.getByRole('button', { name: 'Done' })
  await expectConcentricCorners(actions, done)
  await done.tap()
  await expect(surface).toHaveCount(0)
  await expect(actions).toBeHidden()
  await expect(frame.getByText(revised)).toBeInViewport()
  await page.reload()
  await expect(frame.getByText(revised)).toBeInViewport()
})

async function expectConcentricCorners(group: Locator, button: Locator) {
  const cornerCenter = (locator: Locator) => locator.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius)
    return { x: rect.left + radius, y: rect.top + radius }
  })
  const outer = await cornerCenter(group)
  const inner = await cornerCenter(button)
  expect(inner.x).toBeCloseTo(outer.x, 1)
  expect(inner.y).toBeCloseTo(outer.y, 1)
}
