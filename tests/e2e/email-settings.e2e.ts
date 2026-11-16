import { expect, test, type Locator, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login, openSiteEditor } from './helpers'

// Saving the account asks for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

/**
 * ADMIN-013 — Settings → Email: the SMTP account, a test send, the delivery log.
 *
 * The E2E server has no SMTP account and is not a production server, so mail
 * is captured into the delivery log instead of leaving the machine. That lets
 * the spec prove the whole loop a real owner walks: read the status, send a
 * test and read it back, save an account behind step-up, see the password is
 * never handed back, and remove the account again.
 */
test('owner sets up outgoing email and reads a captured test message (ADMIN-013)', async ({ page }) => {
  await login(page)
  await openSiteEditor(page)
  const dialog = await openEmailSettings(page)
  const email = dialog.getByRole('region', { name: 'Email' })

  // No account yet on a development server: captured, and the test is allowed.
  await expect(email.getByText('Development mode: emails are captured, not sent')).toBeVisible()
  await expect(email.getByText('No email has been sent yet.')).toBeVisible()
  await expect(email.getByRole('button', { name: 'Save account' })).toBeDisabled()
  await expect(email.getByText('Enter the SMTP host.')).toBeVisible()

  await email.getByLabel('Send the test email to').fill('reader@example.com')
  await email.getByRole('button', { name: 'Send test email' }).click()
  const log = email.getByRole('list')
  await expect(log.getByText('Captured')).toBeVisible()
  await expect(log.getByText('reader@example.com')).toBeVisible()
  await log.getByText('Read the message').click()
  await expect(log.getByText('outgoing email works')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/email-settings-captured.png' })

  // Save an account. The password is typed once and never comes back.
  await email.getByLabel('Host').fill('smtp.example.com')
  await email.getByLabel('Username').fill('mailer')
  await email.getByLabel('Password').fill('smtp-e2e-secret')
  await email.getByLabel('Sender name').fill('E2E Site')
  await email.getByLabel('Sender address').fill('hello@example.com')
  await expect(email.getByRole('button', { name: 'Send test email' })).toBeDisabled()
  await expect(email.getByText('Save your changes first.')).toBeVisible()
  // Step-up opens above Settings, and Escape dismisses only the step-up.
  await email.getByRole('button', { name: 'Save account' }).click()
  await expect(page.getByTestId('step-up-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('step-up-dialog')).toBeHidden()
  await expect(dialog).toBeVisible()
  await expect(email.getByLabel('Host')).toHaveValue('smtp.example.com')

  await email.getByRole('button', { name: 'Save account' }).click()
  await completeStepUp(page)

  await expect(email.getByText('Sending through smtp.example.com')).toBeVisible()
  await expect(email.getByLabel('Password')).toHaveValue('')
  await expect(email.getByLabel('Password')).toHaveAttribute('placeholder', 'Saved. Type to replace it')
  await expect(email.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await expect(email.getByRole('button', { name: 'Send test email' })).toBeEnabled()
  await page.screenshot({ path: '.tmp/evidence/email-settings-account.png' })

  // The saved account survives a reload, still without its password.
  await page.reload()
  const reloaded = (await openEmailSettings(page)).getByRole('region', { name: 'Email' })
  await expect(reloaded.getByLabel('Host')).toHaveValue('smtp.example.com')
  await expect(reloaded.getByLabel('Password')).toHaveValue('')
  const settings = await page.request.get('/admin/api/cms/mail/settings')
  expect(await settings.text()).not.toContain('smtp-e2e-secret')

  await reloaded.getByRole('button', { name: 'Remove account' }).click()
  await completeStepUp(page)
  await expect(reloaded.getByText('Development mode: emails are captured, not sent')).toBeVisible()
  await expect(reloaded.getByLabel('Host')).toHaveValue('')
})

async function openEmailSettings(page: Page): Promise<Locator> {
  await page.getByTestId('toolbar-settings-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Email' }).click()
  await expect(dialog.getByRole('region', { name: 'Email' })).toBeVisible()
  return dialog
}
