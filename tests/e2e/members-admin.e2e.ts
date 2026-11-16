import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login } from './helpers'

// Saving member settings and deleting a member ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

/**
 * MEMBER-002 — manage site members from Users → Site members.
 *
 * An owner opens sign-up and adds a profile field in the member settings,
 * invites a member with a tag, finds them with search and the status filter,
 * gives them a tag that ends, suspends and restores them, and deletes them.
 * The E2E server captures mail, so the invitation is checked in Email →
 * Activity instead of in an inbox.
 */
test('owner manages site members from the Users page (MEMBER-002)', async ({ page }) => {
  await login(page)
  await page.goto('/admin/users')

  // Admin users and site members are separate tabs of the same page.
  await expect(page.getByRole('tab', { name: 'Admin users', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Site members', exact: true }).click()
  const tab = page.getByRole('region', { name: 'Site members' })

  const suffix = Date.now().toString(36)
  const email = `member-${suffix}@example.com`

  await test.step('open sign-up and add a profile field', async () => {
    await tab.getByRole('button', { name: 'Member settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Member settings' })
    await pickOption(page, dialog.getByLabel('Who can sign up'), 'Open: anyone can sign up')
    await dialog.getByRole('button', { name: 'Add a field' }).click()
    const field = dialog.getByRole('group', { name: 'Profile field 2' })
    await field.getByLabel('Label').fill('Company name')
    // The id follows the label; it is what forms and bindings use.
    await expect(field.getByLabel('Id')).toHaveValue('companyName')
    await dialog.getByLabel('Sign-in page').fill('sign-in')
    await expect(dialog.getByText('A page address starts with one slash')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save settings' })).toBeDisabled()
    // Left empty again: the suite shares one site, and other specs rely on the built-in sign-in page.
    await dialog.getByLabel('Sign-in page').fill('')
    await page.screenshot({ path: '.tmp/evidence/members-settings.png' })
    await dialog.getByRole('button', { name: 'Save settings' }).click()
    await completeStepUp(page)
    await expect(dialog).toBeHidden()
    await expect(tab.getByText('Sign-up is open')).toBeVisible()
  })

  await test.step('invite a member with a tag', async () => {
    await tab.getByRole('button', { name: 'Invite member' }).click()
    const dialog = page.getByRole('dialog', { name: 'Invite a member' })
    await expect(dialog.getByRole('button', { name: 'Send invitation' })).toBeDisabled()
    // The dialog puts the cursor in the address field a moment after it opens.
    await expect(dialog.getByLabel('Email address')).toBeFocused()
    await dialog.getByLabel('Email address').fill(email)
    await dialog.getByLabel('Member tags').fill('Student')
    await dialog.getByLabel('Member tags').press('Enter')
    await dialog.getByRole('button', { name: 'Send invitation' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Invitation sent', { exact: true })).toBeVisible()
  })

  const details = page.getByRole('article', { name: 'Member details' })

  await test.step('find them, and give them a tag that ends', async () => {
    await tab.getByLabel('Search name or email').fill(`member-${suffix}`)
    const rows = tab.getByRole('list', { name: 'Site members' })
    await expect(rows.getByRole('button')).toHaveCount(1)
    await expect(details.getByRole('heading', { name: email })).toBeVisible()
    await expect(details.getByText('Pending', { exact: true })).toBeVisible()
    // The tag typed as "Student" is stored the way members hold it.
    await expect(details.getByRole('region', { name: 'Tags' }).getByText('student', { exact: true })).toBeVisible()

    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    await details.getByLabel('Add a tag').fill('trial')
    await details.getByLabel('Until (optional)').fill(tomorrow)
    await details.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(details.getByRole('region', { name: 'Tags' }).getByText(/until/)).toBeVisible()
    await page.screenshot({ path: '.tmp/evidence/members-tab.png' })
  })

  await test.step('suspend and restore', async () => {
    await details.getByRole('button', { name: 'Suspend', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Suspend', exact: true }).click()
    await expect(details.getByText('Suspended: this member cannot sign in')).toBeVisible()
    await tab.getByLabel('Search name or email').fill('')
    await tab.getByRole('tablist', { name: 'Filter by status' }).getByRole('tab', { name: /^Suspended 1/ }).click()
    await expect(tab.getByRole('list', { name: 'Site members' }).getByRole('button')).toHaveCount(1)
    await details.getByRole('button', { name: 'Restore access' }).click()
    await expect(tab.getByText('No member matches these filters')).toBeVisible()
    await tab.getByRole('button', { name: 'Clear filters' }).click()
  })

  await test.step('the invitation and the changes are on record', async () => {
    await page.getByRole('tab', { name: 'Audit', exact: true }).click()
    const audit = page.getByRole('table', { name: 'Audit events' })
    await expect(audit.getByText(`Member ${email} was invited`)).toBeVisible()
    await expect(audit.getByText(`Member ${email} was suspended`)).toBeVisible()
    await expect(audit.getByText('Member settings were changed')).toBeVisible()

    await page.goto('/admin/email')
    await page.getByTestId('email-nav-activity').click()
    await expect(page.getByRole('list', { name: 'Email activity' }).getByText(email).first()).toBeVisible()
  })

  await test.step('delete the member', async () => {
    await page.goto('/admin/users')
    await page.getByRole('tab', { name: 'Site members', exact: true }).click()
    await tab.getByLabel('Search name or email').fill(`member-${suffix}`)
    await details.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete member' }).click()
    await completeStepUp(page)
    await expect(tab.getByText('No member matches these filters')).toBeVisible()
  })
})

/** Pick an option of a Select primitive. */
async function pickOption(page: Page, control: ReturnType<Page['locator']>, optionName: string): Promise<void> {
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(control).toHaveValue(optionName)
}
