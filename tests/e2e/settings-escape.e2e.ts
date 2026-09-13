import { expect, test } from '@playwright/test'

/**
 * ADMIN-009 — Escape closes the Settings modal after focus leaves the dialog.
 *
 * Escape used to be a React `onKeyDown` on the dialog element, so it only fired
 * while focus sat inside the dialog subtree. Clicking any non-focusable panel
 * chrome (a heading, a label, empty space) blurs to `<body>`, outside that
 * subtree, and Escape went dead for the rest of the session while the backdrop
 * click kept working. Only a browser reproduces that: the unit suite drives
 * `fireEvent.keyDown` at a chosen element rather than a real focus state.
 */
test('Escape closes Settings after a click on non-focusable chrome (ADMIN-009)', async ({ page }) => {
  await page.goto('/admin/site')

  await page.getByTestId('toolbar-settings-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible({ timeout: 20_000 })

  // Click dead space in the panel, the way a user does when reading it.
  await dialog.getByRole('heading').first().click();

  // Escape must still reach the modal even though focus is no longer on a
  // control inside it.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden({ timeout: 10_000 })
})
