import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  canvasFrame,
  createPage,
  insertNotchModule,
  login,
  openSiteEditor,
  publishDraft,
  setPropValue,
} from './helpers'

interface PublicResponseRecord {
  url: string
  status: number
  contentType: string
}

/**
 * PUBLIC-004 — route-query dynamic text should publish as a static shell and
 * hydrate through the real browser hole runtime.
 */
test.describe('public dynamic fragments', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('hydrates route-query text holes on desktop and mobile visitor pages (PUBLIC-004)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const pageName = `Dynamic Fragment ${suffix}`
    const slug = `dynamic-fragment-${suffix}`
    const authoredText = 'Dynamic result: {route.query.term}'

    await login(page)
    await openSiteEditor(page)
    await createPage(page, pageName, slug)
    await page.getByRole('treeitem', { name: `Open page ${pageName}` }).click()

    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', authoredText)
    await expect(canvasFrame(page).getByText(/Dynamic result:/)).toBeVisible()

    await publishDraft(page)

    await expectDynamicFragmentVisitor(browser, {
      path: `/${slug}?term=desktop-${suffix}`,
      expectedText: `Dynamic result: desktop-${suffix}`,
    })
    await expectDynamicFragmentVisitor(browser, {
      path: `/${slug}?term=mobile-${suffix}`,
      expectedText: `Dynamic result: mobile-${suffix}`,
      viewport: { width: 390, height: 844 },
    })
  })
})

async function expectDynamicFragmentVisitor(
  browser: Browser,
  options: {
    path: string
    expectedText: string
    viewport?: { width: number; height: number }
  },
): Promise<void> {
  const context = await browser.newContext(
    options.viewport ? { viewport: options.viewport } : {},
  )
  const visitor = await context.newPage()
  const holeResponses: PublicResponseRecord[] = []
  const runtimeResponses: PublicResponseRecord[] = []

  visitor.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/_instatic/hole/')) {
      holeResponses.push(responseRecord(response.url(), response.status(), response.headers()))
    }
    if (url.pathname === '/_instatic/hole-runtime.js') {
      runtimeResponses.push(responseRecord(response.url(), response.status(), response.headers()))
    }
  })

  try {
    const response = await visitor.goto(`${PUBLIC_BASE_URL}${options.path}`)
    expect(response, 'public page response').not.toBeNull()
    expect(response!.status(), 'public page status').toBe(200)
    const shellHtml = await response!.text()
    expect(shellHtml).toContain('<instatic-hole')
    expect(shellHtml).toContain('/_instatic/hole-runtime.js')
    expect(shellHtml).not.toContain(options.expectedText)

    await expect(visitor.getByText(options.expectedText, { exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await expect(visitor.locator('instatic-hole')).toHaveCount(0)
    await expect(visitor.locator('[data-testid="canvas-root"]')).toHaveCount(0)
    await expectNoHorizontalOverflow(visitor)

    await expect.poll(() => runtimeResponses.length, {
      message: 'hole runtime asset response observed',
    }).toBeGreaterThan(0)
    await expect.poll(() => holeResponses.length, {
      message: 'hole fragment response observed',
    }).toBeGreaterThan(0)

    const runtime = runtimeResponses[0]!
    expect(runtime.status).toBe(200)
    expect(runtime.contentType).toContain('javascript')

    const hole = holeResponses[0]!
    expect(hole.status).toBe(200)
    expect(hole.contentType).toContain('text/html')
    const holeUrl = new URL(hole.url)
    expect(holeUrl.searchParams.get('u')).toBe(options.path)
  } finally {
    await context.close()
  }
}

function responseRecord(
  url: string,
  status: number,
  headers: Record<string, string>,
): PublicResponseRecord {
  return {
    url,
    status,
    contentType: headers['content-type'] ?? '',
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    ))
  }).toBe(true)
}
