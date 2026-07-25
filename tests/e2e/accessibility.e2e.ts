import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  OWNER,
  canvasFrame,
  createPage,
  expectEditorReady,
  expectLoggedIn,
  insertNotchModule,
  login,
  openSiteEditor,
  publishDraft,
  setPropValue,
  visitPublicPage,
} from './helpers'

/**
 * A11Y-001, A11Y-002, RESP-001, and RESP-002 — keyboard-only login, keyboard
 * shell navigation, the admin editor at tablet width, and a published public
 * page at mobile visitor width. Lightweight smokes for focus order, keyboard
 * activation, and responsive layout; deeper accessibility and responsive
 * review stays agent-run.
 */
test.describe('keyboard access', () => {
  // Logs in fresh, so it must not run on the shared owner state.
  test.use({ storageState: ANONYMOUS_STATE })

  test('logs in with the keyboard only (A11Y-001)', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()

    const email = page.getByLabel('Email')
    await email.focus()
    await expect(email).toBeFocused()
    await page.keyboard.type(OWNER.email)

    // Tab advances to the password field (focus order), then Enter submits.
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Password')).toBeFocused()
    await page.keyboard.type(OWNER.password)
    await page.keyboard.press('Enter')

    await expectLoggedIn(page)
  })
})

test.describe('keyboard shell navigation', () => {
  test('navigates the admin shell with keyboard controls (A11Y-002)', async ({
    page,
  }) => {
    await page.goto('/admin/site')
    await expectEditorReady(page)

    await activateToolbarLink(page, 'Content', /\/admin\/content$/)
    await activateToolbarLink(page, 'Plugins', /\/admin\/plugins$/)
    await activateToolbarLink(page, 'Users', /\/admin\/users$/)

    const accountTrigger = page.getByTestId('account-menu-trigger')
    await accountTrigger.focus()
    await expect(accountTrigger).toBeFocused()
    await page.keyboard.press('Enter')

    const accountItem = page.getByTestId('account-menu-go-to-account')
    await expect(accountItem).toBeVisible()
    await accountItem.focus()
    await expect(accountItem).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/admin\/account$/)
    await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible()

    await activateToolbarLink(page, 'Site', /\/admin\/site$/)
    await expectEditorReady(page)
  })
})

test.describe('responsive', () => {
  test('admin editor is usable at tablet width (RESP-001)', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/admin/site')

    // Core editor chrome renders without the canvas collapsing at tablet width.
    await expect(page.getByTestId('toolbar')).toBeVisible()
    await expect(page.getByTestId('canvas-root')).toBeVisible()
    await expect(page.getByTestId('account-menu-trigger')).toBeVisible()
  })
})

test.describe('public responsive', () => {
  // Publishing triggers step-up and rotates the session token, so this must not
  // use the shared owner storage state that later read-only specs rely on.
  test.use({ storageState: ANONYMOUS_STATE })

  test('published page is readable at mobile visitor width (RESP-002)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const title = `Responsive Mobile ${suffix}`
    const slug = `responsive-mobile-${suffix}`
    const text = `Mobile public page ${suffix}`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, title, slug)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', text)
    await expect(canvasFrame(page).getByText(text)).toBeVisible()
    await publishDraft(page)

    await visitPublicPage(browser, {
      path: `/${slug}`,
      viewport: { width: 390, height: 844 },
      visibleText: text,
      assert: async (visitor) => {
        const metrics = await visitor.evaluate(() => {
          const doc = document.documentElement
          const body = document.body
          return {
            bodyHeight: Math.ceil(body.getBoundingClientRect().height),
            bodyWidth: Math.ceil(body.getBoundingClientRect().width),
            clientWidth: doc.clientWidth,
            scrollWidth: doc.scrollWidth,
            styleSheetCount: document.styleSheets.length,
          }
        })

        expect(metrics.clientWidth).toBe(390)
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
        expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
        expect(metrics.bodyHeight).toBeGreaterThan(0)
        expect(metrics.styleSheetCount).toBeGreaterThan(0)
      },
    })
  })
})

async function activateToolbarLink(
  page: Page,
  name: string,
  url: RegExp,
): Promise<void> {
  const link = page.getByTestId('toolbar').getByRole('link', { name })
  await expect(link).toBeVisible()
  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(url)
}
