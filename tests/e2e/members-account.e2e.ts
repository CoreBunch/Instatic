import { execFileSync } from 'node:child_process'
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, PUBLIC_BASE_URL, login } from './helpers'

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

interface SeededSite {
  pages: Array<{ id: string; slug: string; cells: Record<string, unknown> }>
  settings: Record<string, unknown>
}

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
  const headers = { origin: new URL(page.url()).origin }
  const admin = page.request
  const stepUp = async () => {
    const res = await admin.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
    expect(res.ok(), await res.text()).toBe(true)
  }

  // The suite shares one site: put back whatever the member settings were.
  const settingsBefore = await (await admin.get('/admin/api/cms/members/settings')).json()
  const seenMail = new Set<string>()
  let seededPageIds: string[] = []

  /** The link in the newest captured email to `to` that this test has not used yet. */
  async function emailedLink(to: string): Promise<string> {
    let link: string | undefined
    await expect
      .poll(async () => {
        const res = await admin.get(`/admin/api/cms/mail/activity?period=24h&q=${encodeURIComponent(to)}`)
        const { entries } = (await res.json()) as { entries: Array<{ id: string; to: string; body: string | null }> }
        const entry = entries.find((candidate) => candidate.to === to && !seenMail.has(candidate.id))
        link = entry?.body?.match(/https?:\/\/\S*token=[\w-]+/)?.[0]
        if (entry && link) seenMail.add(entry.id)
        return link
      }, { message: `an email with a link reaches ${to}`, timeout: 20_000 })
      .toBeTruthy()
    return link!
  }

  try {
    await test.step('seed and publish the member pages', async () => {
      const seeded = JSON.parse(
        execFileSync('bun', ['scripts/e2e-members-seed.ts', prefix], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
      ) as SeededSite
      await stepUp()
      // Pages are editor documents, so they arrive the way a site transfer brings them: as an import.
      const { tables } = (await (await admin.get('/admin/api/cms/data/tables')).json()) as { tables: Array<{ id: string }> }
      const now = new Date().toISOString()
      const imported = await admin.post('/admin/api/cms/import?strategy=merge-add', {
        headers,
        data: {
          schemaVersion: 1,
          exportedAt: now,
          tables: tables.filter((table) => table.id === 'pages'),
          rows: seeded.pages.map((seededPage) => ({
            ...seededPage,
            tableId: 'pages',
            status: 'draft',
            authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
            author: null, createdBy: null, updatedBy: null, publishedBy: null,
            createdAt: now, updatedAt: now, publishedAt: null, scheduledPublishAt: null, deletedAt: null,
          })),
        },
      })
      expect(imported.ok(), await imported.text()).toBe(true)
      seededPageIds = seeded.pages.map((seededPage) => seededPage.id)
      const published = await admin.post('/admin/api/cms/publish', { headers })
      expect(published.ok(), await published.text()).toBe(true)
      const saved = await admin.put('/admin/api/cms/members/settings', { headers, data: seeded.settings })
      expect(saved.ok(), await saved.text()).toBe(true)
    })

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
        const refused = await visitor.goto(at('pro'))
        expect(refused?.status()).toBe(403)
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

        // No page is assigned for this link, so the site's plain page finishes it.
        await visitor.goto(await emailedLink(email))
        await visitor.locator('button[type="submit"]').click()
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
        await visitor.locator('button[type="submit"]').click()
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
    await stepUp()
    // The suite shares one site: take the seeded pages off it again.
    for (const pageId of seededPageIds) {
      const removed = await admin.delete(`/admin/api/cms/data/rows/${pageId}`, { headers })
      expect(removed.ok(), await removed.text()).toBe(true)
    }
    const restored = await admin.put('/admin/api/cms/members/settings', { headers, data: settingsBefore.settings })
    expect(restored.ok(), await restored.text()).toBe(true)
  }
})

/** The form that holds a button with this name. Pages carry several forms. */
function formWith(page: Page, buttonName: string): Locator {
  return page.locator('form').filter({ has: page.getByRole('button', { name: buttonName, exact: true }) })
}

/** Sign out with the header's button, which every page of the member site carries. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Join', exact: true })).toBeVisible()
}

async function expectSignedOut(context: BrowserContext): Promise<void> {
  const me = await context.request.get(`${PUBLIC_BASE_URL}/_instatic/members/me`)
  expect(((await me.json()) as { member: unknown }).member).toBeNull()
}
