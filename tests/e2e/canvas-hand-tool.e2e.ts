import { expect, test, type Locator, type Page } from '@playwright/test'
import { canvasFrame, createPage, insertNotchModule, openSiteEditor } from './helpers'

/**
 * The Hand tool lets a plain left-drag pan the design canvas. It exists for
 * pen tablets that report as a mouse, so it can't hold Space or a stylus button.
 * Real Chromium is required: the pan starts inside a breakpoint iframe and is
 * relayed to the parent canvas, which the unit DOM can't reproduce.
 */

async function canvasTranslate(page: Page): Promise<string> {
  return page.getByTestId('canvas-transform-layer').evaluate((el) => (el as HTMLElement).style.transform)
}

async function dragFromCenter(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('drag target has no bounding box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

/** Click the frame's empty page area, near its bottom edge. */
async function tapBelowContent(frameBody: Locator): Promise<void> {
  const box = await frameBody.boundingBox()
  if (!box) throw new Error('frame body has no bounding box')
  await frameBody.click({ position: { x: box.width / 2, y: box.height - 40 } })
}

test.describe('canvas Hand tool', () => {
  test('a left-drag over a page frame pans the canvas without selecting (SITE-029)', async ({ page }) => {
    test.setTimeout(90_000)

    const suffix = Date.now().toString(36)
    const pageName = `Hand tool ${suffix}`
    await openSiteEditor(page)
    await createPage(page, pageName, `hand-tool-${suffix}`)
    await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
    await insertNotchModule(page, 'container')

    const frame = canvasFrame(page)
    const placeholder = frame.locator('[data-canvas-module-placeholder]').first()
    await expect(placeholder).toBeVisible()
    const selected = frame.locator('[data-canvas-selected]')
    const frameBody = frame.locator('body')
    const handTool = page.getByTestId('canvas-hand-tool-toggle')

    // Select tool: a plain drag over the frame does not pan.
    const before = await canvasTranslate(page)
    await dragFromCenter(page, frameBody, 120, 80)
    expect(await canvasTranslate(page)).toBe(before)

    // Select tool: a tap on the empty page area below the container moves the
    // selection off it. The Hand tool must not.
    await placeholder.click()
    await expect(selected).toHaveCount(1)
    const containerId = await selected.getAttribute('data-node-id')
    await tapBelowContent(frameBody)
    await expect(selected).not.toHaveAttribute('data-node-id', containerId ?? '')
    await placeholder.click()
    await expect(selected).toHaveAttribute('data-node-id', containerId ?? '')

    // Hand tool on: the same drag pans the canvas.
    await handTool.click()
    await expect(handTool).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('canvas-root')).toHaveAttribute('data-canvas-tool', 'pan')
    await expect(frame.locator('html')).toHaveAttribute('data-instatic-canvas-tool', 'pan')

    const beforePan = await canvasTranslate(page)
    await dragFromCenter(page, frameBody, 120, 80)
    await expect.poll(() => canvasTranslate(page)).not.toBe(beforePan)

    // Taps select nothing: the container stays selected.
    await tapBelowContent(frameBody)
    await expect(selected).toHaveAttribute('data-node-id', containerId ?? '')

    // H toggles the tool back off from the keyboard.
    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('h')
    await expect(handTool).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('canvas-root')).not.toHaveAttribute('data-canvas-tool', 'pan')
    await expect(frame.locator('html')).not.toHaveAttribute('data-instatic-canvas-tool', 'pan')
  })
})
