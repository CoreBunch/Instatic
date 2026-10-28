import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  canvasFrame,
  createPage,
  createStylesheet,
  insertNotchModule,
  login,
  openSiteEditor,
  publishDraft,
} from './helpers'

/**
 * The editor-chrome stylesheet in the canvas iframe is unlayered, and the site's
 * CSS lives in `@layer user-authored`. Any custom property the chrome declares
 * on `:root` therefore beats a site property of the same name. A site defining
 * `--radius` or `--text` used to render with the editor's values in the canvas
 * and its own values on the published page. Real Chromium is needed here: the
 * unit DOM does not implement cascade layers.
 */
const SITE_RADIUS = '12px'
const SITE_TEXT = 'rgb(200, 30, 40)'

test.describe('canvas editor chrome tokens', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('site custom properties named like admin tokens render the same in canvas and on the published page (SITE-027)', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000)

    await login(page)
    const suffix = Date.now().toString(36)
    const pageName = `Chrome tokens ${suffix}`
    const slug = `chrome-tokens-${suffix}`

    await openSiteEditor(page)
    await createPage(page, pageName, slug)
    await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()
    await createStylesheet(page, `chrome-tokens-${suffix}`, `
:root {
  --radius: ${SITE_RADIUS};
  --text: ${SITE_TEXT};
}
html body {
  border-top-left-radius: var(--radius);
  color: var(--text);
}
`)
    // An empty Container renders editor chrome (the module placeholder).
    await insertNotchModule(page, 'container')
    const frame = canvasFrame(page)
    await expect(frame.locator('[data-canvas-module-placeholder]').first()).toBeVisible()

    const editorRadius = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
    )
    expect(editorRadius).not.toBe(SITE_RADIUS)

    const canvas = await frame.locator('body').evaluate((body) => {
      const doc = body.ownerDocument
      const root = getComputedStyle(doc.documentElement)
      const placeholder = doc.querySelector('[data-canvas-module-placeholder]')!
      return {
        rootRadius: root.getPropertyValue('--radius').trim(),
        rootText: root.getPropertyValue('--text').trim(),
        bodyRadius: getComputedStyle(body).borderTopLeftRadius,
        bodyColor: getComputedStyle(body).color,
        placeholderRadius: getComputedStyle(placeholder).borderTopLeftRadius,
      }
    })

    // The site's own values win inside the canvas…
    expect(canvas.rootRadius).toBe(SITE_RADIUS)
    expect(canvas.rootText).toBe(SITE_TEXT)
    expect(canvas.bodyRadius).toBe(SITE_RADIUS)
    expect(canvas.bodyColor).toBe(SITE_TEXT)
    // …while editor chrome still renders with the admin token value.
    expect(canvas.placeholderRadius).toBe(editorRadius)

    await publishDraft(page)
    const context = await browser.newContext()
    const visitor = await context.newPage()
    try {
      const response = await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
      expect(response?.status()).toBe(200)
      const published = await visitor.locator('body').evaluate((body) => ({
        bodyRadius: getComputedStyle(body).borderTopLeftRadius,
        bodyColor: getComputedStyle(body).color,
      }))
      expect(published).toEqual({ bodyRadius: canvas.bodyRadius, bodyColor: canvas.bodyColor })
    } finally {
      await context.close()
    }
  })
})
