import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login } from './helpers'
import { seedMemberSite } from './helpers/members'

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

  // Member features run on pages the owner builds. Until the site has an
  // invitation page there is nothing to invite anyone to.
  await expect(tab.getByRole('button', { name: 'Invite member' })).toBeDisabled()
  // The pages to choose from: the members demo site, published, and not yet named in the settings.
  const prefix = `a${suffix}-`
  const site = await seedMemberSite(page, prefix, { assignPages: false })
  await page.reload()
  await page.getByRole('tab', { name: 'Site members', exact: true }).click()

  await test.step('open sign-up, add a profile field and choose the member pages', async () => {
    await expect(tab.getByRole('button', { name: 'Invite member' })).toBeDisabled()
    await tab.getByRole('button', { name: 'Member settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Member settings' })
    await pickOption(page, dialog.getByLabel('Who can sign up'), 'Open: anyone can sign up')
    await dialog.getByRole('button', { name: 'Add a field' }).click()
    const field = dialog.getByRole('group', { name: 'Profile field 2' })
    await field.getByLabel('Label').fill('Company name')
    // The id follows the label; it is what forms and bindings use.
    await expect(field.getByLabel('Id')).toHaveValue('companyName')
    // Open sign-up does nothing without a page for the confirmation link, and the dialog says so.
    await expect(dialog.getByText('Sign-up stays off until a published "Confirm email" page is chosen below.')).toBeVisible()
    await expect(dialog.getByText('Not set: invitations are off.')).toBeVisible()
    // Each page is a picker of the site's pages. A page without the form its job needs is pointed out.
    await pickOption(page, dialog.getByLabel('Confirm email'), `Join (${site.path('join')})`)
    await expect(dialog.getByText('No "Confirm email address" form was found on "Join".')).toBeVisible()
    await pickOption(page, dialog.getByLabel('Confirm email'), `Confirm your address (${site.path('welcome')})`)
    await expect(dialog.getByText(`Opens ${site.path('welcome')}.`)).toBeVisible()
    await pickOption(page, dialog.getByLabel('Accept an invitation'), `Accept your invitation (${site.path('invitation')})`)
    await expect(dialog.getByText('Sign-up stays off until')).toHaveCount(0)
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
    const searchField = tab.getByLabel('Search name or email')
    const statusFilter = tab.getByRole('group', { name: 'Filter by status' })
    const tagFilter = tab.getByRole('combobox', { name: 'Filter by tag' }).locator('..')
    const searchBox = searchField.locator('..')
    const searchStyle = await searchBox.evaluate((box) => {
      const { borderRadius, height } = getComputedStyle(box)
      return { borderRadius, height }
    })
    expect(searchStyle.borderRadius).toBe(`${parseFloat(searchStyle.height) / 2}px`)
    await expect(statusFilter).toHaveCSS('border-radius', searchStyle.borderRadius)
    await expect(tagFilter).toHaveCSS('border-radius', searchStyle.borderRadius)
    await expect(statusFilter).toHaveCSS('height', searchStyle.height)
    await searchField.fill(`member-${suffix}`)
    await expect(searchBox).toHaveCSS('height', searchStyle.height)
    const rows = tab.getByRole('table', { name: 'Site members' })
    await expect(rows.getByRole('button')).toHaveCount(1)
    await expect(rows.getByRole('row', { name: `Member ${email}`, exact: true })).toHaveAttribute('aria-current', 'true')
    await expect(details.getByRole('heading', { name: email })).toBeVisible()
    await expect(details.getByText('Pending', { exact: true })).toBeVisible()
    // The tag typed as "Student" is stored the way members hold it.
    await expect(details.getByRole('region', { name: 'Tags' }).getByText('student', { exact: true })).toBeVisible()

    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    await details.getByRole('button', { name: 'Add tag', exact: true }).click()
    const tag = details.getByLabel('Add a tag')
    await tag.fill('trial')
    const until = details.getByLabel('Until (optional)')
    const add = details.getByRole('button', { name: 'Add', exact: true })
    await until.fill(tomorrow)
    const dateBounds = await until.boundingBox()
    const addBounds = await add.boundingBox()
    await expect(add).toHaveCSS('height', searchStyle.height)
    expect(addBounds!.height).toBe(dateBounds!.height)
    expect(addBounds!.height).toBe((await tag.boundingBox())!.height)
    expect(addBounds!.x).toBeGreaterThanOrEqual(dateBounds!.x + dateBounds!.width)
    expect(addBounds!.y + addBounds!.height).toBeCloseTo(dateBounds!.y + dateBounds!.height, 0)
    await add.click()
    await expect(details.getByRole('region', { name: 'Tags' }).getByText(/until/)).toBeVisible()
    await page.screenshot({ path: '.tmp/evidence/members-tab.png' })
  })

  await test.step('suspend and restore', async () => {
    await details.getByRole('button', { name: 'Suspend', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Suspend', exact: true }).click()
    await expect(details.getByText('Suspended: this member cannot sign in')).toBeVisible()
    await tab.getByLabel('Search name or email').fill('')
    const suspended = tab.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^Suspended 1/ })
    await suspended.click()
    await expect(suspended).toHaveAttribute('aria-pressed', 'true')
    await expect(tab.getByRole('table', { name: 'Site members' }).getByRole('button')).toHaveCount(1)
    await details.getByRole('button', { name: 'Restore access', exact: true }).click()
    await expect(tab.getByText('No member matches these filters')).toBeVisible()
    await tab.getByRole('button', { name: 'Clear filters' }).click()
  })

  await test.step('the invitation and the changes are on record', async () => {
    await page.getByRole('tab', { name: 'Audit', exact: true }).click()
    const audit = page.getByRole('table', { name: 'Audit events' })
    await expect(audit.getByText(`Member ${email} was invited`)).toBeVisible()
    await expect(audit.getByText(`Member ${email} was suspended`)).toBeVisible()
    // Other member specs change the settings too; one such row is enough here.
    await expect(audit.getByText('Member settings were changed').first()).toBeVisible()

    await page.goto('/admin/email')
    await page.getByTestId('email-nav-activity').click()
    await expect(page.getByRole('table', { name: 'Email activity' }).getByText(email).first()).toBeVisible()
  })

  await test.step('delete the member', async () => {
    await page.goto('/admin/users')
    await page.getByRole('tab', { name: 'Site members', exact: true }).click()
    await tab.getByLabel('Search name or email').fill(`member-${suffix}`)
    await tab.getByRole('table', { name: 'Site members' }).getByRole('button').filter({ hasText: email }).click()
    await details.getByRole('button', { name: 'Delete member', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete member' }).click()
    await completeStepUp(page)
    await expect(tab.getByText('No member matches these filters')).toBeVisible()
  })

  // The suite shares one site: take this run's pages and settings out again.
  await site.remove()
})

/** Pick an option of a Select primitive. */
async function pickOption(page: Page, control: ReturnType<Page['locator']>, optionName: string): Promise<void> {
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(control).toHaveValue(optionName)
}
