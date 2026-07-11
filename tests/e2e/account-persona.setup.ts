import { expect, test as setup } from '@playwright/test'
import { ACCOUNT_PERSONA } from './helpers/constants'
import { completeStepUp, expectLoggedIn, login, loginAs, logout } from './helpers'

/**
 * Create the identity used by destructive account self-management tests.
 *
 * Those tests rotate credentials, toggle MFA, and revoke other sessions. Keeping
 * them on a separate Admin prevents them from invalidating the owner session
 * serialized by `auth.setup.ts` and consumed by the rest of the suite.
 */
setup('create the account-management persona', async ({ page }) => {
  await login(page)
  await page.goto('/admin/users')
  await expect(page.getByRole('table', { name: 'Users' })).toBeVisible()

  const alreadyExists = await page.getByText(ACCOUNT_PERSONA.email).isVisible()

  if (!alreadyExists) {
    await page.getByRole('button', { name: 'Create User', exact: true }).click()
    await page.locator('input[name="new-user-email-address"]').fill(ACCOUNT_PERSONA.email)
    await page.locator('input[name="new-user-display-name"]').fill(ACCOUNT_PERSONA.displayName)
    await page.locator('input[name="new-user-initial-password"]').fill(ACCOUNT_PERSONA.password)
    await page.locator('select[name="new-user-role"]').selectOption({ label: ACCOUNT_PERSONA.role })
    await page.locator('button[form="users-page-user-form"]').click()
    await completeStepUp(page)
    await expect(page.getByText(ACCOUNT_PERSONA.email)).toBeVisible()
  }

  // Fresh and reused runs both prove the declared baseline credentials work.
  // Reuse is safe only when a prior run also restored the persona's MFA state;
  // otherwise this login stops at the MFA challenge and fails setup explicitly.
  await logout(page)
  await loginAs(page, ACCOUNT_PERSONA.email, ACCOUNT_PERSONA.password)
  await expectLoggedIn(page)
})
