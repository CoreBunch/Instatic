import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, PUBLIC_BASE_URL, completeStepUp, login } from './helpers'

// Adding a connector and saving the defaults ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

/**
 * ADMIN-013 — the Email workspace: connectors, defaults, templates, activity.
 *
 * The E2E server has no connector and is not a production server, so mail is
 * captured into Activity instead of leaving the machine. That lets the spec
 * walk the whole loop an owner does without a real mail server: send a
 * template test and read it back in the activity log, add a connector behind step-up (its secret
 * is never handed back), set the sender, edit a template in the post editor
 * while the preview follows, and remove the connector again.
 */
test('owner sets up outgoing email and edits a template (ADMIN-013)', async ({ page }) => {
  await login(page)
  await page.goto('/admin/email')
  await expect(page.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible()

  // ── Templates: a test send is captured, with nothing set up ──────────────
  await page.getByTestId('email-nav-templates').click()
  const template = page.getByRole('article')
  await expect(template.getByRole('heading', { name: 'Test email', exact: true })).toBeVisible()
  await template.getByRole('button', { name: 'Send test' }).click()
  const testDialog = page.getByRole('dialog', { name: 'Send a test email' })
  // The dialog shows the email as it will be sent.
  await expect(testDialog.frameLocator('iframe[title="Email preview"]').getByText('outgoing email works')).toBeVisible()
  await testDialog.getByLabel('Send to').fill('reader@example.com')
  await testDialog.getByRole('button', { name: 'Send test' }).click()
  await expect(page.getByText('Test email captured')).toBeVisible()
  await expect(testDialog).toBeHidden()

  await page.getByTestId('email-nav-activity').click()
  const activity = page.getByRole('list', { name: 'Email activity' })
  await expect(activity.getByText('reader@example.com')).toBeVisible()
  // The newest email is selected; its details show how it left and, on a development server, the message.
  const details = page.getByRole('article', { name: 'Email details' })
  await expect(details.getByText('Captured, not sent')).toBeVisible()
  await expect(details.getByText('outgoing email works')).toBeVisible()
  // A search with no match says so and offers the way back.
  await page.getByLabel('Search recipient or subject').fill('nobody-by-this-name')
  await expect(page.getByText('No email matches these filters')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(activity.getByText('reader@example.com')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/email-activity.png' })

  // ── Connectors: add one; its password never comes back ───────────────────
  await page.getByTestId('email-nav-connectors').click()
  // The shortest setup comes first: a provider that needs one API key and a name that is already filled in.
  await expect(page.getByRole('heading', { name: 'Connect Resend' })).toBeVisible()
  await expect(page.getByLabel('Display label')).toHaveValue('Resend')
  await expect(page.getByLabel('API key')).toBeVisible()
  await expect(page.getByLabel('Host')).toHaveCount(0)

  // SMTP starts from a picker of well-known services that fills in the server.
  await page.getByRole('button', { name: /^SMTP/ }).click()
  await expect(page.getByRole('heading', { name: 'Connect SMTP' })).toBeVisible()
  const services = page.getByRole('group', { name: 'Mail service' })
  await services.getByRole('button', { name: 'Google' }).click()
  await expect(page.getByLabel('Host')).toHaveValue('smtp.gmail.com')
  await expect(page.getByLabel('Port')).toHaveValue('587')
  await expect(page.getByText('An app password, not your Google password.')).toBeVisible()
  await services.getByRole('button', { name: 'Other server' }).click()
  await expect(page.getByLabel('Host')).toHaveValue('')
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
  // No sender address yet, so the header offers to set one instead of a test that cannot work.
  await expect(connector.getByRole('button', { name: 'Send test' })).toHaveCount(0)
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

  // ── Templates: edit in place in Live mode, like a post ───────────────────
  await page.getByTestId('email-nav-templates').click()
  const editor = page.getByRole('article')
  await expect(editor.getByTestId('content-mode-toggle-live')).toHaveAttribute('aria-selected', 'true')
  await editor.getByLabel('Subject').fill('Checking {site.name}')
  const body = editor.getByLabel('Email body')
  await body.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Hello from the editor. ')
  await editor.getByRole('button', { name: 'Insert variable' }).click()
  await page.getByRole('menuitem', { name: /Site address/ }).click()
  await expect(body).toContainText('Hello from the editor. {site.url}')
  await page.screenshot({ path: '.tmp/evidence/email-template-live.png' })

  // Write mode is the bare surface; nothing typed in Live is lost.
  await editor.getByTestId('content-mode-toggle-write').click()
  await expect(editor.getByLabel('Email body')).toContainText('Hello from the editor. {site.url}')
  await expect(editor.getByLabel('Subject')).toHaveValue('Checking {site.name}')
  await page.screenshot({ path: '.tmp/evidence/email-template-write.png' })
  await editor.getByTestId('content-mode-toggle-live').click()
  await expect(editor.getByLabel('Email body')).toContainText('Hello from the editor. {site.url}')

  // The test dialog previews the unsaved edit with the site's real name and address, and asks to save first.
  await editor.getByRole('button', { name: 'Send test' }).click()
  const previewDialog = page.getByRole('dialog', { name: 'Send a test email' })
  await expect(previewDialog.getByText(`Checking ${OWNER.siteName}`)).toBeVisible()
  await expect(
    previewDialog.frameLocator('iframe[title="Email preview"]').getByText(`Hello from the editor. ${PUBLIC_BASE_URL}`),
  ).toBeVisible()
  await expect(previewDialog.getByText('Save the template first')).toBeVisible()
  await expect(previewDialog.getByRole('button', { name: 'Send test' })).toBeDisabled()
  await page.screenshot({ path: '.tmp/evidence/email-template-test.png' })
  await previewDialog.getByRole('button', { name: 'Cancel' }).click()

  await editor.getByRole('button', { name: 'Save template' }).click()
  await completeStepUp(page)
  await expect(editor.getByRole('button', { name: 'Reset to built-in' })).toBeVisible()
  await page.reload()
  await page.getByTestId('email-nav-templates').click()
  await expect(page.getByRole('article').getByLabel('Subject')).toHaveValue('Checking {site.name}')

  await page.getByRole('article').getByRole('button', { name: 'Reset to built-in' }).click()
  await completeStepUp(page)
  await expect(page.getByRole('article').getByLabel('Subject')).toHaveValue('Test email from {site.name}')
  await expect(page.getByRole('article').getByRole('button', { name: 'Reset to built-in' })).toHaveCount(0)

  // ── Remove the connector: the site goes back to capturing ────────────────
  // The suite shares one site. Leaving a made-up mail server configured would
  // make every later spec's emails fail to send instead of being captured.
  await page.getByTestId('email-nav-connectors').click()
  await page.getByRole('article').getByRole('button', { name: 'Remove connector' }).click()
  await page.getByRole('dialog', { name: 'Remove connector?' }).getByRole('button', { name: 'Remove connector' }).click()
  await completeStepUp(page)
  // With no connector left, the setup panel is back.
  await expect(page.getByRole('heading', { name: 'Connect Resend' })).toBeVisible()
  await page.getByTestId('email-nav-defaults').click()
  await expect(page.getByText('Development mode: emails are captured, not sent')).toBeVisible()
})
