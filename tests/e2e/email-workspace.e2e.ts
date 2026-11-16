import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login } from './helpers'

// Adding a connector and saving the defaults ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

/**
 * ADMIN-013 — the Email workspace: connectors, defaults, templates, activity.
 *
 * The E2E server has no connector and is not a production server, so mail is
 * captured into Activity instead of leaving the machine. That lets the spec
 * walk the whole loop an owner does without a real mail server: send a
 * template test and read it back, add a connector behind step-up (its secret
 * is never handed back), set the sender, and edit a template in the post
 * editor while the preview follows.
 */
test('owner sets up outgoing email and edits a template (ADMIN-013)', async ({ page }) => {
  await login(page)
  await page.goto('/admin/email')
  await expect(page.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible()

  // ── Templates: a test send is captured, with nothing set up ──────────────
  await page.getByTestId('email-nav-templates').click()
  const template = page.getByRole('article')
  await expect(template.getByRole('heading', { name: 'Test email', exact: true })).toBeVisible()
  await expect(template.getByText('Built-in wording')).toBeVisible()
  await template.getByLabel('Send to').fill('reader@example.com')
  await template.getByRole('button', { name: 'Send test email' }).click()
  await expect(page.getByText('Test email captured')).toBeVisible()

  await page.getByTestId('email-nav-activity').click()
  const activity = page.getByRole('table', { name: 'Email activity' })
  await expect(activity.getByText('Captured')).toBeVisible()
  await expect(activity.getByText('reader@example.com')).toBeVisible()
  await activity.getByText('Read the message').click()
  await expect(activity.getByText('outgoing email works')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/email-activity.png' })

  // ── Connectors: add one; its password never comes back ───────────────────
  await page.getByTestId('email-nav-connectors').click()
  await expect(page.getByRole('heading', { name: 'Connect SMTP' })).toBeVisible()
  await page.getByLabel('Display label').fill('Main relay')
  await page.getByLabel('Host').fill('smtp.example.com')
  await page.getByLabel('Username').fill('mailer')
  await page.getByLabel('Password').fill('smtp-e2e-secret')
  await page.screenshot({ path: '.tmp/evidence/email-connector-setup.png' })
  await page.getByRole('button', { name: 'Connect SMTP' }).click()
  // Step-up opens above the page, and Escape only dismisses it.
  await expect(page.getByTestId('step-up-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('step-up-dialog')).toBeHidden()
  await expect(page.getByLabel('Host')).toHaveValue('smtp.example.com')
  await page.getByRole('button', { name: 'Connect SMTP' }).click()
  await completeStepUp(page)

  const connector = page.getByRole('article')
  await expect(connector.getByRole('heading', { name: 'Main relay' })).toBeVisible()
  // The first connector becomes the one the site sends through.
  await expect(connector.getByText('Sending through this')).toBeVisible()
  await expect(connector.getByText('Stored encrypted')).toBeVisible()
  // No sender address yet, so a test is not offered as if it could work.
  await expect(connector.getByRole('button', { name: 'Send test email' })).toBeDisabled()
  await expect(connector.getByText('A test needs a sender address.')).toBeVisible()
  const overview = await page.request.get('/admin/api/cms/mail')
  expect(await overview.text()).not.toContain('smtp-e2e-secret')
  await page.screenshot({ path: '.tmp/evidence/email-connector.png' })

  // ── Defaults: set the sender; the status follows ─────────────────────────
  await connector.getByRole('button', { name: 'Set a sender address' }).click()
  await expect(page.getByText('Development mode: emails are captured, not sent')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save defaults' })).toBeDisabled()
  await page.getByLabel('Sender name').fill('E2E Site')
  await page.getByLabel('Sender address').fill('hello@example.com')
  await page.getByRole('button', { name: 'Save defaults' }).click()
  await completeStepUp(page)
  await expect(page.getByText('Email is being sent')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/email-defaults.png' })

  // ── Templates: edit in the post editor; the preview follows ──────────────
  await page.getByTestId('email-nav-templates').click()
  const editor = page.getByRole('article')
  await editor.getByLabel('Subject').fill('Checking {site.name}')
  await expect(editor.getByText('Checking Acme Studio')).toBeVisible()
  const body = editor.getByLabel('Email body')
  await body.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Hello from the editor. ')
  await editor.getByRole('button', { name: '{site.url}' }).click()
  const preview = page.frameLocator('iframe[title="Email preview"]')
  await expect(preview.getByText('Hello from the editor. https://example.com')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/email-template.png' })

  await editor.getByRole('button', { name: 'Save template' }).click()
  await completeStepUp(page)
  await expect(editor.getByText('Edited', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByTestId('email-nav-templates').click()
  await expect(page.getByRole('article').getByLabel('Subject')).toHaveValue('Checking {site.name}')

  await page.getByRole('article').getByRole('button', { name: 'Reset to built-in' }).click()
  await completeStepUp(page)
  await expect(page.getByRole('article').getByLabel('Subject')).toHaveValue('Test email from {site.name}')
  await expect(page.getByRole('article').getByText('Built-in wording')).toBeVisible()
})
