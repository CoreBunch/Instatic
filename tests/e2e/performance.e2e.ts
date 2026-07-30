import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  createPage,
  expectEditorReady,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  openSiteEditor,
  publishDraft,
  setPropValue,
  visitPublicPage,
} from './helpers'

const STARTUP_USABILITY_BUDGET_MS = 20_000
const PUBLISH_COMPLETION_BUDGET_MS = 30_000

/** A minimal but valid 1x1 PNG — enough for the server's magic-byte check. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * PERF-001 / PERF-002 — smoke thresholds for editor startup and publish
 * completion. These are user-observable regression checks, not detailed
 * profiling benchmarks.
 */
test.describe('performance and reliability', () => {
  test('opens the site editor from a cold admin route without a blank/dead-end screen (PERF-001)', async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    const startedAt = Date.now()
    await page.goto('/admin/site')
    await expect(page).toHaveURL(/\/admin\/site$/)
    await expectEditorReady(page)
    await expect(page.getByTestId('toolbar')).toBeVisible()
    await expect(page.getByTestId('account-menu-trigger')).toBeVisible()
    await expect(page.getByRole('status', { name: 'Loading Instatic' })).toHaveCount(0)

    const usableMs = Date.now() - startedAt
    test.info().annotations.push({
      type: 'perf',
      description: `Site editor usable in ${usableMs}ms`,
    })
    expect(usableMs).toBeLessThan(STARTUP_USABILITY_BUDGET_MS)
    expect(consoleErrors).toEqual([])
  })

  // Publishing rotates the session through step-up, so this runs fresh.
  test.describe('publishing', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('publishes a moderately complex page with clear completion feedback (PERF-002)', async ({
      page,
      browser,
    }) => {
      await login(page)
      await openSiteEditor(page)

      const suffix = Date.now().toString(36)
      const slug = `perf-publish-${suffix}`
      const headline = `Performance publish headline ${suffix}`
      const ctaLabel = `Performance CTA ${suffix}`
      const filename = `perf-publish-${suffix}.png`

      await createPage(page, `Performance Publish ${suffix}`, slug)
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', headline)
      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', ctaLabel)
      await setPropValue(page, 'href', 'https://example.com/performance')
      await insertNotchModule(page, 'image')
      await uploadAndSelectImage(page, filename)

      const frame = canvasFrame(page)
      await expect(frame.getByText(headline, { exact: true })).toBeVisible()
      await expect(frame.getByRole('link', { name: ctaLabel })).toBeVisible()
      await expect(frame.locator('img[src*="/uploads/"]').first()).toBeVisible()

      const publishStartedAt = Date.now()
      await publishDraft(page)
      const publishMs = Date.now() - publishStartedAt
      test.info().annotations.push({
        type: 'perf',
        description: `Moderately complex page published in ${publishMs}ms`,
      })
      expect(publishMs).toBeLessThan(PUBLISH_COMPLETION_BUDGET_MS)

      await visitPublicPage(browser, {
        path: `/${slug}`,
        visibleText: headline,
        assert: async (visitor) => {
          const link = visitor.getByRole('link', { name: ctaLabel })
          await expect(link).toBeVisible()
          await expect(link).toHaveAttribute('href', /example\.com\/performance/)
          await expect(visitor.locator('img[src*="/uploads/"]').first()).toBeVisible()
        },
      })
    })
  })
})

async function uploadAndSelectImage(page: import('@playwright/test').Page, filename: string) {
  await page.getByRole('button', { name: 'Browse image library' }).click()
  const picker = page.getByTestId('media-picker-modal')
  await expect(picker).toBeVisible()
  await picker
    .locator('input[type="file"]')
    .setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG_1X1 })
  await picker.getByRole('button', { name: `Open ${filename}` }).click()
  await picker.getByRole('button', { name: 'Use selected' }).click()
  await expect(picker).toBeHidden()
}
