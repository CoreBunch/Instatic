import { expect, test, type Browser, type Locator, type Page, type Response } from '@playwright/test'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  createPage,
  login,
  openCodePanel,
  openSiteEditor,
  publishDraft,
  saveDraft,
} from './helpers'

const ImportmapSchema = Type.Object({
  imports: Type.Optional(Type.Record(Type.String(), Type.String())),
})

/**
 * SITE-014 browser authoring path for runtime dependencies.
 *
 * The lower-level suite covers resolver/cache edge cases. This spec exercises
 * the user path: author a module script that imports an npm package, add the
 * missing dependency from the Dependencies panel, publish, then prove the
 * public page emits an importmap and the browser can load the package from the
 * self-hosted runtime cache namespace.
 */
test.describe('runtime dependencies', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('authors, resolves, publishes, and serves a runtime package import (SITE-014)', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000)

    await login(page)
    const suffix = Date.now().toString(36)
    const pageName = `Runtime deps ${suffix}`
    const slug = `runtime-deps-${suffix}`
    const marker = `Runtime dependency loaded: function ${suffix}`

    await openSiteEditor(page)
    await createPage(page, pageName, slug)
    await createRuntimeScript(page, `site014-${suffix}`, `
import confetti from 'canvas-confetti'

const marker = document.createElement('p')
marker.textContent = '${marker}'
marker.setAttribute('data-site014-runtime', 'loaded')
marker.dataset.confettiType = typeof confetti
document.body.append(marker)
`)

    await expect(page.getByLabel('Script imports').getByText('canvas-confetti').first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId('panel-close-code-editor').click()
    await expect(page.getByRole('complementary', { name: 'Code Editor' })).toBeHidden()

    await page.getByRole('button', { name: 'Open Dependencies panel' }).click()
    const dependenciesPanel = page.getByTestId('dependencies-panel')
    await expect(dependenciesPanel).toBeVisible()

    const issuePanel = dependenciesPanel.getByLabel('Runtime dependency issues')
    await expect(issuePanel.getByText('canvas-confetti')).toBeVisible()
    await issuePanel.getByRole('button', { name: 'Add' }).click()

    await expect(dependenciesPanel.getByTestId('dep-row-canvas-confetti')).toBeVisible()
    await expect(dependenciesPanel.getByText('1 locked')).toBeVisible({ timeout: 75_000 })

    await saveDraft(page)
    await publishDraft(page)

    await verifyPublishedRuntimeDependency({
      browser,
      slug,
      marker,
    })
  })

  test('keeps missing dependency controls reachable at mobile width (SITE-014)', async ({ page }) => {
    test.setTimeout(60_000)

    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    const suffix = Date.now().toString(36)

    await openSiteEditor(page)
    await createPage(page, `Mobile runtime deps ${suffix}`, `mobile-runtime-deps-${suffix}`)
    const mobilePackage = 'left-pad'
    await createRuntimeScript(page, `site014-mobile-${suffix}`, `
import leftPad from 'left-pad'
document.body.dataset.site014MobileDependencyType = typeof leftPad
`, mobilePackage)

    await expect(page.getByLabel('Script imports').getByText(mobilePackage).first()).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId('panel-close-code-editor').click()
    await expect(page.getByRole('complementary', { name: 'Code Editor' })).toBeHidden()

    await page.getByRole('button', { name: 'Open Dependencies panel' }).click()
    const dependenciesPanel = page.getByTestId('dependencies-panel')
    await expect(dependenciesPanel).toBeVisible()

    const issuePanel = dependenciesPanel.getByLabel('Runtime dependency issues')
    await expect(issuePanel.getByText(mobilePackage)).toBeVisible()
    const addButton = issuePanel.getByRole('button', { name: 'Add' })
    await expect(addButton).toBeVisible()
    await expectMobileDependencyPanelContained(page, dependenciesPanel, addButton)

    await addButton.click({ trial: true })
  })
})

async function createRuntimeScript(
  page: Page,
  name: string,
  source: string,
  expectedImport = 'canvas-confetti',
): Promise<void> {
  await openCodePanel(page)
  const newScript = page.getByRole('button', { name: 'New script', exact: true })
  await newScript.scrollIntoViewIfNeeded()
  await newScript.click()

  const dialog = page.getByRole('dialog', { name: 'New script' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByRole('complementary', { name: 'Code Editor' })).toBeVisible()
  const editor = page.locator('[data-codemirror-container] .cm-content')
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.click()
  await page.keyboard.insertText(source.trim())

  // CodeMirror syncs into the editor store through a short debounce.
  await expect(editor).toContainText(expectedImport)
}

async function verifyPublishedRuntimeDependency({
  browser,
  slug,
  marker,
}: {
  browser: Browser
  slug: string
  marker: string
}): Promise<void> {
  const context = await browser.newContext()
  const visitor = await context.newPage()
  const runtimeCacheResponses: Response[] = []
  visitor.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/_instatic/runtime/cache/')) {
      runtimeCacheResponses.push(response)
    }
  })

  try {
    const navigation = await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
    expect(navigation?.status()).toBe(200)
    await expect(visitor.getByText(marker)).toBeVisible()
    await expect(visitor.locator('[data-testid="canvas-root"]')).toHaveCount(0)

    const importmapText = await visitor.locator('script[type="importmap"]').textContent()
    expect(importmapText).toBeTruthy()
    const importmapJson: unknown = JSON.parse(importmapText ?? '{}')
    const importmap = Value.Parse(ImportmapSchema, importmapJson)
    const packageUrl = importmap.imports?.['canvas-confetti']
    expect(packageUrl).toBeTruthy()
    if (!packageUrl) throw new Error('Published importmap did not include canvas-confetti')
    expect(packageUrl).toMatch(/^\/_instatic\/runtime\/cache\/[0-9a-f]{24}\/canvas-confetti\//)

    await visitor.evaluate((src) => new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.type = 'module'
      script.src = src
      script.onload = () => resolve()
      script.onerror = () => reject(new Error(`Failed to load ${src}`))
      document.head.append(script)
    }), packageUrl)

    const cacheResponse = runtimeCacheResponses.find((response) =>
      new URL(response.url()).pathname === packageUrl,
    )
    expect(cacheResponse, `expected browser response for ${packageUrl}`).toBeTruthy()
    expect(cacheResponse?.status()).toBe(200)
    expect(cacheResponse?.headers()['content-type']).toContain('javascript')
    expect(cacheResponse?.headers()['cache-control']).toContain('immutable')
  } finally {
    await context.close()
  }
}

async function expectMobileDependencyPanelContained(
  page: Page,
  panel: Locator,
  primaryAction: Locator,
): Promise<void> {
  const pageMetrics = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      viewportWidth: doc.clientWidth,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    }
  })
  expect(pageMetrics.viewportWidth).toBe(390)
  expect(pageMetrics.pageOverflow).toBeLessThanOrEqual(1)

  const panelBox = await panel.boundingBox()
  const actionBox = await primaryAction.boundingBox()
  if (!panelBox) throw new Error('Dependencies panel was visible but had no bounding box')
  if (!actionBox) throw new Error('Dependency Add action was visible but had no bounding box')

  for (const box of [panelBox, actionBox]) {
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(pageMetrics.viewportWidth + 1)
  }
}
