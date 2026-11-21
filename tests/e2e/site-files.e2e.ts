import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  createPage,
  createStylesheet,
  login,
  openSiteEditor,
  publishDraft,
} from './helpers'

test.describe('site files and code editor', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('creates a stylesheet in Code Editor and publishes user CSS (SITE-013)', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000)

    await login(page)
    const suffix = Date.now().toString(36)
    const pageName = `Code file ${suffix}`
    const slug = `code-file-${suffix}`
    const background = 'rgb(23, 45, 67)'

    await openSiteEditor(page)
    await createPage(page, pageName, slug)
    await createStylesheet(page, `site013-${suffix}`, `
html body {
  background-color: ${background};
}
`)

    await publishDraft(page)

    const context = await browser.newContext()
    const visitor = await context.newPage()
    try {
      const response = await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
      expect(response?.status()).toBe(200)
      await expect(visitor.locator('[data-testid="canvas-root"]')).toHaveCount(0)
      await expect(visitor.locator('body')).toHaveCSS('background-color', background)
      await expect(
        visitor.locator('link[rel="stylesheet"][href*="/_instatic/css/userStyles-"]'),
      ).toHaveCount(1)
    } finally {
      await context.close()
    }
  })
})
