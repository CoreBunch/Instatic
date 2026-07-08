import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import sharp from 'sharp'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  canvasFrame,
  createPage,
  insertModuleViaPicker,
  login,
  openSiteEditor,
  openSitePanel,
  publishDraft,
  saveDraft,
  setPropValue,
} from './helpers'

test.describe('background image smoke', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('uses optimized media variants for authored background images in editor and public CSS', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const pageName = `Background smoke ${suffix}`
    const slug = `background-smoke-${suffix}`
    const className = `e2e-bg-${suffix}`
    const label = `Background image smoke ${suffix}`
    const filename = `background-smoke-${suffix}.png`
    const proofDir = `.tmp/e2e-background-image-smoke/${suffix}`
    await mkdir(proofDir, { recursive: true })

    await login(page)
    await openSiteEditor(page)
    await page.screenshot({ path: `${proofDir}/01-editor-start.png`, fullPage: true })

    await createPage(page, pageName, slug)
    await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()

    await insertModuleViaPicker(page, 'base.button')
    await setPropValue(page, 'label', label)
    const canvasButton = canvasFrame(page).getByRole('button', { name: label })
    await expect(canvasButton).toBeVisible()

    await page.getByTestId('class-picker-input').fill(className)
    await page.getByTestId('class-picker-submit').click()
    await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

    const styleSearch = page.getByLabel('Search class style properties to add')
    await styleSearch.fill('background image')
    await page.getByRole('button', { name: 'Background image from media library' }).click()
    await page.getByRole('button', { name: 'Browse image library' }).click()

    const picker = page.getByTestId('media-picker-modal')
    await expect(picker).toBeVisible()
    await picker
      .locator('input[type="file"]')
      .setInputFiles({
        name: filename,
        mimeType: 'image/png',
        buffer: await largePng(),
      })
    await picker.getByRole('button', { name: `Open ${filename}` }).click()
    await picker.getByRole('button', { name: 'Use selected' }).click()
    await expect(picker).toBeHidden()

    await setClassTextProperty(page, styleSearch, 'backgroundSize', 'background size', 'cover')
    await setClassTextProperty(page, styleSearch, 'backgroundPosition', 'background position', 'center')

    const editorCss = await expectOptimizedCanvasClassCss(page, className)
    expect(editorCss).not.toMatch(/background-image:\s*url\("[^"]+\.png"\)/)
    const editorBackground = await expectOptimizedBackground(canvasButton)
    expect(editorBackground).not.toContain('.png')
    await page.screenshot({ path: `${proofDir}/02-editor-background.png`, fullPage: true })

    await saveDraft(page)
    await page.reload()
    await openSiteEditor(page)
    await openSitePanel(page)
    const pageItem = page.getByRole('treeitem', { name: `Open page ${pageName}` })
    await pageItem.click()
    await expect(pageItem).toHaveAttribute('aria-selected', 'true')
    const reloadedButton = canvasFrame(page).getByRole('button', { name: label })
    await expect(reloadedButton).toBeVisible()
    const mediaSummary = await mediaVariantSummary(page)
    expect(mediaSummary).toContainEqual(
      expect.objectContaining({
        filename,
        publicPath: expect.stringMatching(/^\/uploads\/.*\.png$/),
        variantCount: expect.any(Number),
      }),
    )
    expect(mediaSummary.find((asset) => asset.filename === filename)?.variantCount).toBeGreaterThan(0)
    const reloadedCss = await observedOptimizedCanvasClassCss(page, className)
    expect.soft(
      reloadedCss,
      'persisted canvas class CSS should use image-set candidates after reload',
    ).toMatch(/background-image:\s*image-set\(.*\.webp/i)
    expect.soft(
      reloadedCss,
      'persisted canvas class CSS should not keep the original PNG declaration',
    ).not.toMatch(/background-image:\s*url\(["'][^"']+\.png["']\)/)
    const reloadedBackground = await observedOptimizedBackground(reloadedButton)
    expect.soft(
      reloadedBackground,
      'persisted canvas computed background should use optimized image-set candidates after reload',
    ).toMatch(/image-set\(.*\.webp/i)
    await page.screenshot({ path: `${proofDir}/03-editor-reload.png`, fullPage: true })

    await publishDraft(page)
    await page.screenshot({ path: `${proofDir}/04-publish-feedback.png`, fullPage: true })

    const context = await browser.newContext()
    const visitor = await context.newPage()
    const uploadResponses: string[] = []
    visitor.on('response', (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/uploads/')) uploadResponses.push(url.pathname)
    })

    try {
      await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)

      const publishedButton = visitor.getByRole('button', { name: label })
      await expect(publishedButton).toBeVisible()
      await expect(publishedButton).toHaveClass(new RegExp(`\\b${className}\\b`))
      await expectOptimizedBackground(publishedButton)
      await visitor.screenshot({ path: `${proofDir}/05-public-background.png`, fullPage: true })

      const css = await publicStylesheetText(visitor)
      expect(css).toContain(`.${className}`)
      expect(css).toContain('background-image: image-set(')
      expect(css).toContain('.webp')
      expect(css).not.toMatch(/background-image:\s*url\("[^"]+\.png"\)/)
      expect(uploadResponses.some((path) => path.endsWith('.webp'))).toBe(true)
      expect(uploadResponses.some((path) => path.endsWith('.png'))).toBe(false)
      await expect(visitor.locator('[data-testid="canvas-root"]')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})

async function largePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1800,
      height: 1000,
      channels: 3,
      background: { r: 36, g: 114, b: 184 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 720,
            height: 420,
            channels: 4,
            background: { r: 236, g: 196, b: 74, alpha: 0.92 },
          },
        }).png().toBuffer(),
        left: 120,
        top: 140,
      },
    ])
    .png()
    .toBuffer()
}

async function setClassTextProperty(
  page: Page,
  styleSearch: Locator,
  prop: string,
  query: string,
  value: string,
): Promise<void> {
  await styleSearch.fill(query)
  const row = page.getByTestId(`css-property-row-${prop}`)
  await expect(row).toBeVisible()
  const input = row.locator(`#ctrl-${prop}`)
  await input.fill(value)
  await input.blur()
}

async function expectOptimizedBackground(locator: Locator): Promise<string> {
  await expect
    .poll(
      async () => locator.evaluate((el) => getComputedStyle(el).backgroundImage),
      { timeout: 20_000 },
    )
    .toMatch(/image-set\(.*\.webp/i)
  return locator.evaluate((el) => getComputedStyle(el).backgroundImage)
}

async function expectOptimizedCanvasClassCss(page: Page, className: string): Promise<string> {
  await expect
    .poll(
      async () => classCssSnippet(await canvasClassCss(page), className),
      { timeout: 20_000 },
    )
    .toMatch(/background-image:\s*image-set\(.*\.webp/i)
  return classCssSnippet(await canvasClassCss(page), className)
}

async function observedOptimizedCanvasClassCss(page: Page, className: string): Promise<string> {
  try {
    return await expectOptimizedCanvasClassCss(page, className)
  } catch {
    return classCssSnippet(await canvasClassCss(page), className)
  }
}

async function observedOptimizedBackground(locator: Locator): Promise<string> {
  try {
    return await expectOptimizedBackground(locator)
  } catch {
    return locator.evaluate((el) => getComputedStyle(el).backgroundImage)
  }
}

async function canvasClassCss(page: Page): Promise<string> {
  return await canvasFrame(page).locator('style#mc-classes').textContent() ?? ''
}

function classCssSnippet(css: string, className: string): string {
  const index = css.indexOf(`.${className}`)
  if (index === -1) return css.slice(0, 2_000)
  return css.slice(index, index + 2_000)
}

async function mediaVariantSummary(page: Page): Promise<Array<{
  filename: string
  publicPath: string
  variantCount: number
}>> {
  return page.evaluate(async () => {
    const response = await fetch('/admin/api/cms/media', { credentials: 'include' })
    if (!response.ok) throw new Error(`Media list failed: ${response.status}`)
    const json: unknown = await response.json()
    const assets = getField(json, 'assets')
    if (!Array.isArray(assets)) return []
    return assets.map((asset) => {
      const variants = getField(asset, 'variants')
      return {
        filename: stringField(asset, 'filename'),
        publicPath: stringField(asset, 'publicPath'),
        variantCount: Array.isArray(variants) ? variants.length : 0,
      }
    })

    function getField(value: unknown, key: string): unknown {
      if (typeof value !== 'object' || value === null) return undefined
      return Object.getOwnPropertyDescriptor(value, key)?.value
    }

    function stringField(value: unknown, key: string): string {
      const field = getField(value, key)
      return typeof field === 'string' ? field : ''
    }
  })
}

async function publicStylesheetText(page: Page): Promise<string> {
  const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll((nodes) =>
    nodes
      .map((node) => node instanceof HTMLLinkElement ? node.href : '')
      .filter((href) => href.includes('/_instatic/css/')),
  )
  const bodies = await page.evaluate(async (urls) => {
    return Promise.all(urls.map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`CSS fetch failed: ${response.status} ${url}`)
      return response.text()
    }))
  }, hrefs)
  return bodies.join('\n')
}
