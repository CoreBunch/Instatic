import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, PUBLIC_BASE_URL, login, seedMemberSite } from './helpers'

/**
 * MEMBER-003 — a member's whole account life on published pages.
 *
 * The pages are the members demo site (sign-up, sign-in, account, a members
 * page and a tag-limited page, all built from editor pieces), seeded under an
 * address prefix of this run. One visitor then signs up and confirms by
 * email, edits their profile, is let into the tag-limited page once the owner
 * grants the tag, downloads their data, changes their password, signs in
 * with it, signs in from an emailed link, resets a forgotten password, moves
 * to a new email address and deletes the account.
 *
 * The E2E server captures mail, so every emailed link is read from the mail
 * activity log.
 */

// Saving member settings asks for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

const FIRST_PASSWORD = 'first-long-password'
const SECOND_PASSWORD = 'second-long-password'
const THIRD_PASSWORD = 'third-long-password'

test('a member signs up, manages the account and leaves (MEMBER-003)', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const prefix = `m${suffix}-`
  const at = (slug: string) => `${PUBLIC_BASE_URL}/${prefix}${slug}`
  const email = `ada-${suffix}@example.com`
  const newEmail = `ada-new-${suffix}@example.com`

  await login(page)
  const admin = page.request
  const site = await seedMemberSite(page, prefix)
  const { headers, emailedLink } = site

  try {
    const context = await browser.newContext()
    const visitor = await context.newPage()
    try {
      await test.step('sign up and confirm by email', async () => {
        // Signed out, the account page sends the visitor to the site's own sign-in page.
        await visitor.goto(at('account'))
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}sign-in\\?next=`))

        await visitor.goto(at('join'))
        const form = formWith(visitor, 'Create account')
        await form.getByLabel('Name').fill('Ada')
        await form.getByLabel('Email').fill(email)
        await form.getByLabel('Password').fill(FIRST_PASSWORD)
        await form.getByLabel('Company (optional)').fill('Analytical Engines')
        await form.getByRole('button', { name: 'Create account' }).click()
        await expect(visitor.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible({ timeout: 20_000 })

        // The link opens the page the owner assigned, which finishes the sign-up.
        await visitor.goto(await emailedLink(email))
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}welcome\\?`))
        await visitor.getByRole('button', { name: 'Confirm my address' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
        await expect(visitor.getByText(`Signed in as ${email}.`)).toBeVisible()
      })

      await test.step('edit the profile', async () => {
        const form = formWith(visitor, 'Save')
        // The form opens with what the member entered at sign-up.
        await expect(form.getByLabel('Name')).toHaveValue('Ada')
        await expect(form.getByLabel('Company')).toHaveValue('Analytical Engines')
        await form.getByLabel('Name').fill('Ada Lovelace')
        await form.getByRole('button', { name: 'Save' }).click()
        await expect(form.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
        await visitor.goto(at('members'))
        await expect(visitor.getByText('Welcome, Ada Lovelace.')).toBeVisible()
        await visitor.screenshot({ path: '.tmp/evidence/members-area.png' })
      })

      await test.step('open a tag-limited page only once the tag is granted', async () => {
        // Without the tag the page is not there for this member.
        const refused = await visitor.goto(at('pro'))
        expect(refused?.status()).toBe(404)
        await expect(visitor.getByText('Pro lounge')).toHaveCount(0)

        const found = await admin.get(`/admin/api/cms/members?q=${encodeURIComponent(email)}`)
        const { members } = (await found.json()) as { members: Array<{ id: string }> }
        expect(members).toHaveLength(1)
        const granted = await admin.post(`/admin/api/cms/members/${members[0]!.id}/tags`, { headers, data: { tag: 'pro' } })
        expect(granted.ok(), await granted.text()).toBe(true)

        const opened = await visitor.goto(at('pro'))
        expect(opened?.status()).toBe(200)
        expect(opened?.headers()['cache-control']).toBe('private, no-store')
        await expect(visitor.getByText('You hold the tag "pro", Ada Lovelace.')).toBeVisible()
        // The home page is public and static; the tag line arrives for this member alone.
        await visitor.goto(at('home'))
        await expect(visitor.getByText('This line is only for members with the tag "pro".')).toBeVisible()
      })

      await test.step('download the account data', async () => {
        const res = await context.request.get(`${PUBLIC_BASE_URL}/_instatic/members/export`)
        expect(res.ok()).toBe(true)
        expect(res.headers()['content-disposition']).toContain('attachment')
        const exported = JSON.stringify(await res.json())
        expect(exported).toContain(email)
        expect(exported).toContain('Ada Lovelace')
        expect(exported).not.toContain(FIRST_PASSWORD)
      })

      await test.step('change the password and sign in with the new one', async () => {
        await visitor.goto(at('account'))
        const form = formWith(visitor, 'Change password')
        // The current password is asked for, and a wrong one changes nothing.
        await form.getByLabel('Current password').fill('not-the-password')
        await form.getByLabel('New password').fill(SECOND_PASSWORD)
        await form.getByRole('button', { name: 'Change password' }).click()
        await expect(form.getByRole('alert')).toBeVisible()
        await form.getByLabel('Current password').fill(FIRST_PASSWORD)
        await form.getByRole('button', { name: 'Change password' }).click()
        await expect(form.getByRole('status').filter({ hasText: 'Your password is changed.' })).toBeVisible()

        await signOut(visitor)
        await visitor.goto(at('account'))
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}sign-in\\?next=`))

        const signIn = formWith(visitor, 'Sign in')
        await signIn.getByLabel('Email').fill(email)
        await signIn.getByLabel('Password').fill(FIRST_PASSWORD)
        await signIn.getByRole('button', { name: 'Sign in' }).click()
        await expect(signIn.getByRole('alert')).toBeVisible()
        await signIn.getByLabel('Password').fill(SECOND_PASSWORD)
        await signIn.getByRole('button', { name: 'Sign in' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
      })

      await test.step('sign in from an emailed link', async () => {
        await signOut(visitor)
        await visitor.goto(at('sign-in'))
        const form = formWith(visitor, 'Email me a link')
        await form.getByLabel('Email').fill(email)
        await form.getByRole('button', { name: 'Email me a link' }).click()
        await expect(form.getByRole('status').filter({ hasText: 'a sign-in link is on its way' })).toBeVisible()

        // The link opens the site's own page for it, which finishes the sign-in.
        await visitor.goto(await emailedLink(email))
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}sign-in-link\\?`))
        await formWith(visitor, 'Sign in').getByRole('button', { name: 'Sign in' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
        await expect(visitor.getByText(`Signed in as ${email}.`)).toBeVisible()
      })

      await test.step('reset a forgotten password', async () => {
        await signOut(visitor)
        await visitor.goto(at('forgot-password'))
        const form = formWith(visitor, 'Email me a reset link')
        await form.getByLabel('Email').fill(email)
        await form.getByRole('button', { name: 'Email me a reset link' }).click()
        await expect(form.getByRole('status').filter({ hasText: 'a reset link is on its way' })).toBeVisible()

        await visitor.goto(await emailedLink(email))
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}reset-password\\?`))
        const reset = formWith(visitor, 'Save password')
        await reset.getByLabel('New password').fill(THIRD_PASSWORD)
        await reset.getByRole('button', { name: 'Save password' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))

        // The password before the reset no longer works.
        await signOut(visitor)
        await visitor.goto(at('sign-in'))
        const signIn = formWith(visitor, 'Sign in')
        await signIn.getByLabel('Email').fill(email)
        await signIn.getByLabel('Password').fill(SECOND_PASSWORD)
        await signIn.getByRole('button', { name: 'Sign in' }).click()
        await expect(signIn.getByRole('alert')).toBeVisible()
        await signIn.getByLabel('Password').fill(THIRD_PASSWORD)
        await signIn.getByRole('button', { name: 'Sign in' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
      })

      await test.step('move the account to a new email address', async () => {
        const form = formWith(visitor, 'Change email')
        await form.getByLabel('New email').fill(newEmail)
        await form.getByLabel('Current password').fill(THIRD_PASSWORD)
        await form.getByRole('button', { name: 'Change email' }).click()
        await expect(form.getByRole('status').filter({ hasText: 'Check your new address' })).toBeVisible()
        // Nothing changes until the new address confirms.
        await visitor.reload()
        await expect(visitor.getByText(`Signed in as ${email}.`)).toBeVisible()

        await visitor.goto(await emailedLink(newEmail))
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}confirm-email\\?`))
        await visitor.getByRole('button', { name: 'Confirm my new address' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
        await visitor.goto(at('account'))
        await expect(visitor.getByText(`Signed in as ${newEmail}.`)).toBeVisible()
      })

      await test.step('delete the account', async () => {
        const form = formWith(visitor, 'Delete my account')
        await form.getByLabel('Current password').fill(THIRD_PASSWORD)
        await form.getByRole('button', { name: 'Delete my account' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}home$`))

        // Signed out, and the account is gone.
        await expectSignedOut(context)
        await visitor.goto(at('sign-in'))
        const signIn = formWith(visitor, 'Sign in')
        await signIn.getByLabel('Email').fill(newEmail)
        await signIn.getByLabel('Password').fill(THIRD_PASSWORD)
        await signIn.getByRole('button', { name: 'Sign in' }).click()
        await expect(signIn.getByRole('alert')).toBeVisible()
        const left = await admin.get(`/admin/api/cms/members?q=${encodeURIComponent(newEmail)}`)
        expect(((await left.json()) as { members: unknown[] }).members).toHaveLength(0)
      })
    } finally {
      await context.close()
    }
  } finally {
    await site.remove()
  }
})

/** The form that holds a button with this name. Pages carry several forms. */
function formWith(page: Page, buttonName: string): Locator {
  return page.locator('form').filter({ has: page.getByRole('button', { name: buttonName, exact: true }) })
}

/** Sign out with the header's form, which every page of the member site carries. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Join', exact: true })).toBeVisible()
}

async function expectSignedOut(context: BrowserContext): Promise<void> {
  const me = await context.request.get(`${PUBLIC_BASE_URL}/_instatic/members/me`)
  expect(((await me.json()) as { member: unknown }).member).toBeNull()
}
