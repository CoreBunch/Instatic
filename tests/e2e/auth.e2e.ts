import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, expectLoggedIn, login, logout } from './helpers'

async function expectMobileAccountMenuContained(page: Page): Promise<void> {
  const metrics = await page.getByRole('menu', { name: 'Account menu' }).evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const menuRect = element.getBoundingClientRect()
    const signOut = element.querySelector('[data-testid="account-menu-sign-out"]')
    const signOutRect = signOut?.getBoundingClientRect()

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      menuContained: menuRect.left >= -1 && menuRect.right <= viewportWidth + 1,
      signOutVisible: Boolean(signOutRect && signOutRect.width > 0 && signOutRect.height > 0),
      signOutContained: signOutRect
        ? signOutRect.left >= menuRect.left - 1 && signOutRect.right <= menuRect.right + 1
        : false,
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.menuContained).toBe(true)
  expect(metrics.signOutVisible).toBe(true)
  expect(metrics.signOutContained).toBe(true)
}

/**
 * AUTH-003 — signing out revokes the server session, so another tab carrying
 * the same old cookie cannot keep browsing authenticated admin routes.
 */
test.describe('auth session lifecycle', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('revokes the signed-out session across tabs (AUTH-003)', async ({
    page,
    browser,
  }) => {
    await login(page)
    await expectLoggedIn(page)

    const staleContext = await browser.newContext({
      storageState: await page.context().storageState(),
    })

    try {
      const stalePage = await staleContext.newPage()
      const staleConsoleErrors: string[] = []
      stalePage.on('console', (message) => {
        if (message.type() === 'error') staleConsoleErrors.push(message.text())
      })
      await stalePage.goto('/admin/site')
      await expectLoggedIn(stalePage)

      await logout(page)

      await stalePage.goto('/admin/site')
      await expect(stalePage.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
      await expect(stalePage.getByTestId('account-menu-trigger')).toHaveCount(0)
      expect(staleConsoleErrors).not.toContainEqual(
        expect.stringContaining('[module-inserter] failed to load user preference'),
      )
    } finally {
      await staleContext.close()
    }
  })

  test('keeps account-menu sign out reachable at mobile width (AUTH-003)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await expectLoggedIn(page)

    await page.getByRole('button', { name: /Switch workspace/ }).click()
    await page.getByRole('dialog', { name: 'Workspaces' }).getByTestId('account-menu-trigger').click()
    await expect(page.getByRole('menu', { name: 'Account menu' })).toBeVisible()
    await expectMobileAccountMenuContained(page)

    await page.getByTestId('account-menu-sign-out').click()
    await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
    await expect(page.getByTestId('account-menu-trigger')).toHaveCount(0)
  })
})
