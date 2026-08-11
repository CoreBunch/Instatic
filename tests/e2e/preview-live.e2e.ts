import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  createPage,
  insertNotchModule,
  openLayersPanel,
  login,
  openSiteEditor,
  publishDraft,
  selectTreeLayer,
  setPropValue,
  visitPublicPage,
} from './helpers'

test.describe('preview overlay and live page opening', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('previews the saved draft while open-live shows the last published page (SITE-016)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const pageName = `Preview Live ${suffix}`
    const slug = `preview-live-${suffix}`
    const liveText = `SITE-016 live published ${suffix}`
    const draftText = `SITE-016 saved draft ${suffix}`
    const publicPath = `/${slug}`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, pageName, slug)

    await test.step('publish the first version of the page', async () => {
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', liveText)
      await expect(canvasFrame(page).getByText(liveText)).toBeVisible()
      await publishDraft(page)
      await visitPublicPage(browser, {
        path: publicPath,
        visibleText: liveText,
        hiddenText: draftText,
      })
    })

    await test.step('make a later draft edit without publishing it', async () => {
      await openLayersPanel(page)
      await selectTreeLayer(page, 'Text')
      await setPropValue(page, 'text', draftText)
      await expect(canvasFrame(page).getByText(draftText)).toBeVisible()
    })

    await test.step('preview shows the current draft', async () => {
      const preview = await openPreview(page)
      await expect(preview.getByText(draftText)).toBeVisible()
      await expect(preview.getByText(liveText)).toHaveCount(0)
      await page.getByRole('button', { name: 'Close preview' }).click()
      await expect(page.getByTestId('preview-overlay')).toHaveCount(0)
    })

    await test.step('open live page still shows the published version', async () => {
      const livePage = await openLivePage(page)
      try {
        await expect(livePage).toHaveURL(new RegExp(`${escapeRegExp(publicPath)}$`))
        await expect(livePage.getByText(liveText)).toBeVisible()
        await expect(livePage.getByText(draftText)).toHaveCount(0)
        await expect(livePage.locator('[data-testid="canvas-root"]')).toHaveCount(0)
      } finally {
        await livePage.close()
      }
    })

    await test.step('preview remains reachable on a narrow viewport', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      const preview = await openPreview(page)
      await expect(preview.getByText(draftText)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Close preview' })).toBeVisible()
      await expectNoDocumentOverflow(page)
      await page.getByRole('button', { name: 'Close preview' }).click()
      await expect(page.getByTestId('preview-overlay')).toHaveCount(0)
    })
  })
})

async function openPreview(page: Page): Promise<FrameLocator> {
  await page.getByTestId('toolbar-publish-actions-trigger').click()
  await page.getByTestId('toolbar-preview-action').click()
  await expect(page.getByTestId('preview-overlay')).toBeVisible({ timeout: 20_000 })
  return page.frameLocator('[data-testid="preview-iframe"]')
}

async function openLivePage(page: Page): Promise<Page> {
  const [livePage] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByTestId('toolbar-open-live-page-btn').click(),
  ])
  await livePage.waitForLoadState('domcontentloaded')
  return livePage
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(metrics.viewportWidth).toBe(390)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
