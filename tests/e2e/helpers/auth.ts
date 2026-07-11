import { expect, type Page } from '@playwright/test'
import { OWNER } from './constants'

/**
 * Authentication + first-run setup helpers, written to mirror what a real owner
 * does in the browser: fill the visible form, submit, wait for the landing UI.
 */

/**
 * Complete first-run CMS setup, creating the owner account. Safe to call against
 * a server whose database may already be set up (local `E2E_REUSE_SERVER=1`
 * iteration): if the setup screen is absent it logs in instead. After either
 * path the owner is authenticated and the admin shell is reachable.
 */
export async function completeSetupOrLogin(page: Page): Promise<void> {
  await page.goto('/admin')
  const setupHeading = page.getByRole('heading', { name: 'Set Up CMS' })
  const onSetup = await setupHeading
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true, () => false)

  if (onSetup) {
    await page.getByLabel('Site name').fill(OWNER.siteName)
    await page.getByLabel('Email').fill(OWNER.email)
    await page.getByLabel('Password').fill(OWNER.password)
    await page.getByRole('button', { name: 'Create Admin' }).click()
  } else {
    await login(page)
  }
  await expectLoggedIn(page)
}

/** Log in as the owner through the admin login form. Unauthenticated context. */
export async function login(page: Page): Promise<void> {
  await loginAs(page, OWNER.email, OWNER.password)
}

/** Log in as a specific account through the admin login form. */
export async function loginAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expectLoggedIn(page)
}

/**
 * Satisfy a step-up (fresh-password) prompt if it appears. Sensitive actions —
 * publish, create user/role, install — open this; the prompt rotates the session
 * token, which is why callers run on a fresh login.
 */
export async function completeStepUp(
  page: Page,
  password: string = OWNER.password,
): Promise<void> {
  const dialog = page.getByTestId('step-up-dialog')
  const opened = await dialog
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true, () => false)
  if (!opened) return
  await page.getByTestId('step-up-password').fill(password)
  await page.getByTestId('step-up-confirm').click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

/** Sign out through the account menu and confirm the login screen returns. */
export async function logout(page: Page): Promise<void> {
  await page.getByTestId('account-menu-trigger').click()
  await page.getByTestId('account-menu-sign-out').click()
  await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
}

/** The owner is authenticated once the account menu trigger is on screen. */
export async function expectLoggedIn(page: Page): Promise<void> {
  await expect(page.getByTestId('account-menu-trigger')).toBeVisible({
    timeout: 20_000,
  })
}
