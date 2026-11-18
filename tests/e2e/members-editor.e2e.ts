import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  canvasFrame,
  completeStepUp,
  createPage,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  openLayersPanel,
  openSiteEditor,
  openSitePanel,
  publishDraft,
} from './helpers'

/**
 * MEMBER-001 — build member pages in the editor and use them as a visitor.
 *
 * An owner protects a page from Page settings, builds a sign-up form and a
 * confirmation page from the form module's Members mode (the setup panel
 * adds the fields), limits the sign-up form to signed-out visitors,
 * publishes, opens sign-up and names the confirmation page in the member
 * settings. There are no built-in member pages: while the site has no
 * sign-in page the protected page is simply not there for a visitor, and
 * once one is named the visitor is sent to it. The visitor then signs up
 * through the published form, confirms on the site's own page from the
 * emailed link, and opens the protected page as a member.
 */
test.describe('member pages in the editor', () => {
  // Publishing asks for step-up, which rotates the session token.
  test.use({ storageState: ANONYMOUS_STATE })

  test('owner protects a page and publishes a working sign-up form (MEMBER-001)', async ({ page, browser }) => {
    await login(page)
    await openSiteEditor(page)

    const suffix = Date.now().toString(36)
    const club = { name: `Club ${suffix}`, slug: `club-${suffix}` }
    const join = { name: `Join ${suffix}`, slug: `join-${suffix}` }
    const welcome = { name: `Welcome ${suffix}`, slug: `welcome-${suffix}` }

    await test.step('protect a page from Page settings', async () => {
      await openPage(page, club)
      await insertNotchModule(page, 'text')

      await openSitePanel(page)
      const row = page.getByRole('treeitem', { name: `Open page ${club.name}` })
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Page settings' }).click()
      const dialog = page.getByRole('dialog', { name: 'Page settings' })
      await expect(dialog.getByText('Anyone with the address can open this page.')).toBeVisible()
      await pickOption(page, dialog.getByLabel('Who can open this page'), 'Signed-in members')
      await expect(dialog.getByText('Takes effect when you publish.')).toBeVisible()
      await page.screenshot({ path: '.tmp/evidence/members-page-access.png' })
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()

      // The explorer marks the page, so a protected page is visible at a glance.
      await expect(row.getByRole('img', { name: 'Signed-in members only' })).toBeVisible()
    })

    await test.step('build a sign-up form from the Members mode', async () => {
      await openPage(page, join)
      await insertModuleViaPicker(page, 'base.form')
      await page.getByTestId('form-mode').getByRole('button', { name: 'Members' }).click()
      await pickOption(page, page.getByTestId('member-form-action'), 'Sign up')

      // One click adds everything the action needs.
      await page.getByRole('button', { name: /^Add name, email, password/ }).click()
      const canvas = canvasFrame(page)
      await expect(canvas.locator('form input')).toHaveCount(3)
      await expect(canvas.locator('form button')).toHaveCount(1)
      await expect(page.getByRole('button', { name: /^Add name/ })).toHaveCount(0)
      await page.screenshot({ path: '.tmp/evidence/members-form-setup.png' })

      // Only signed-out visitors need a sign-up form.
      await openLayersPanel(page)
      await page
        .getByRole('tree', { name: 'Page element tree' })
        .getByRole('treeitem', { name: 'Form', exact: true })
        .click()
      await page.getByRole('button', { name: 'Visibility', exact: true }).click()
      const showTo = page.getByTestId('show-when-control')
      await pickOption(page, showTo.getByLabel('Show to'), 'Signed-out visitors')
      await expect(showTo.getByText('Left out of the page for signed-in members.')).toBeVisible()
      await page.screenshot({ path: '.tmp/evidence/members-show-to.png' })
    })

    await test.step('build the page the confirmation link opens', async () => {
      await openPage(page, welcome)
      await insertModuleViaPicker(page, 'base.form')
      await page.getByTestId('form-mode').getByRole('button', { name: 'Members' }).click()
      await pickOption(page, page.getByTestId('member-form-action'), 'Confirm email address')
      await page.getByRole('button', { name: /^Add messages/ }).click()
      await expect(canvasFrame(page).locator('form button')).toHaveCount(1)

      await publishDraft(page)
    })

    /** Change the member settings through the dialog. */
    async function changeMemberSettings(change: (dialog: ReturnType<Page['getByRole']>) => Promise<void>): Promise<void> {
      await page.goto('/admin/users')
      await page.getByRole('tab', { name: 'Site members', exact: true }).click()
      await page.getByRole('button', { name: 'Member settings' }).click()
      const dialog = page.getByRole('dialog', { name: 'Member settings' })
      await change(dialog)
      await dialog.getByRole('button', { name: 'Save settings' }).click()
      await completeStepUp(page)
      await expect(dialog).toBeHidden()
    }

    await test.step('open sign-up and choose the confirmation page', async () => {
      await changeMemberSettings(async (dialog) => {
        await pickOption(page, dialog.getByLabel('Who can sign up'), 'Open: anyone can sign up')
        await pickOption(page, dialog.getByLabel('Sign-in page'), 'Not set')
        await pickOption(page, dialog.getByLabel('Confirm email'), `${welcome.name} (/${welcome.slug})`)
      })
    })

    await test.step('with no sign-in page, the protected page is not there for a visitor', async () => {
      const context = await browser.newContext()
      const visitor = await context.newPage()
      try {
        const res = await visitor.goto(`${PUBLIC_BASE_URL}/${club.slug}`)
        expect(res?.status()).toBe(404)
        await expect(visitor.getByText('Add your text here.')).toHaveCount(0)
      } finally {
        await context.close()
      }
    })

    await test.step('choose the sign-in page', async () => {
      await changeMemberSettings(async (dialog) => {
        await pickOption(page, dialog.getByLabel('Sign-in page'), `${join.name} (/${join.slug})`)
      })
    })

    await test.step('a visitor is turned away from the protected page and signs up', async () => {
      const context = await browser.newContext()
      const visitor = await context.newPage()
      try {
        await visitor.goto(`${PUBLIC_BASE_URL}/${club.slug}`)
        // Signed out, the visitor is sent to the page the owner named, remembering where they were going.
        await expect(visitor).toHaveURL(new RegExp(`/${join.slug}\\?next=%2F${club.slug}`))

        await visitor.goto(`${PUBLIC_BASE_URL}/${join.slug}`)
        const email = `visitor-${suffix}@example.com`
        await visitor.getByLabel('Name').fill('Visitor')
        await visitor.getByLabel('Email').fill(email)

        // Before anything is submitted the success message is not on screen.
        await expect(visitor.getByText('Check your email to confirm your address.')).toBeHidden()

        // A weak password comes back as an error, and the field is marked.
        await visitor.getByLabel('Password').fill('short')
        await visitor.getByRole('button', { name: 'Create account' }).click()
        await expect(visitor.getByRole('alert')).toContainText(/password/i)
        await expect(visitor.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true')

        await visitor.getByLabel('Password').fill('a-long-enough-password')
        await visitor.getByRole('button', { name: 'Create account' }).click()
        await expect(
          visitor.getByRole('status').filter({ hasText: 'Check your email to confirm your address.' }),
        ).toBeVisible({ timeout: 20_000 })
        await expect(visitor).toHaveURL(new RegExp(`/${join.slug}$`))
        await visitor.screenshot({ path: '.tmp/evidence/members-signup-published.png' })

        // The confirmation email was produced (captured on this development server).
        await page.goto('/admin/email')
        await page.getByTestId('email-nav-activity').click()
        const activity = page.getByRole('list', { name: 'Email activity' })
        await expect(activity.getByText(email).first()).toBeVisible()

        // The link in that email finishes the sign-up, in the browser that started it.
        await activity.getByRole('button').filter({ hasText: email }).first().click()
        const message = await page.getByRole('article', { name: 'Email details' }).locator('pre').innerText()
        const link = message.match(/https?:\/\/\S*token=[\w-]+/)?.[0]
        expect(link, 'the confirmation email carries a link').toBeTruthy()
        // The link opens the page the owner built for it.
        await visitor.goto(link!)
        await expect(visitor).toHaveURL(new RegExp(`/${welcome.slug}\\?token=`))
        await visitor.getByRole('button', { name: 'Confirm my address' }).click()
        // Confirming signs the visitor in, and the page reloads without the used link.
        await expect(visitor).toHaveURL(new RegExp(`/${welcome.slug}$`), { timeout: 20_000 })

        // Signed in now: the protected page opens, and the sign-up form is no longer part of its page.
        await visitor.goto(`${PUBLIC_BASE_URL}/${club.slug}`)
        await expect(visitor).toHaveURL(new RegExp(`/${club.slug}$`))
        await expect(visitor.getByText('Add your text here.')).toBeVisible()
        await visitor.goto(`${PUBLIC_BASE_URL}/${join.slug}`)
        await visitor.waitForLoadState('networkidle')
        await expect(visitor.locator('form')).toHaveCount(0)
      } finally {
        await context.close()
      }
    })

    // The suite shares one site: do not leave it pointing at this run's pages.
    await test.step('take the pages out of the member settings again', async () => {
      await changeMemberSettings(async (dialog) => {
        await pickOption(page, dialog.getByLabel('Sign-in page'), 'Not set')
        await pickOption(page, dialog.getByLabel('Confirm email'), 'Not set')
      })
    })
  })
})

async function openPage(page: Page, target: { name: string; slug: string }): Promise<void> {
  await createPage(page, target.name, target.slug)
  await openSitePanel(page)
  const item = page.getByRole('treeitem', { name: `Open page ${target.name}` })
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
}

/** Pick an option of a Select primitive. */
async function pickOption(page: Page, control: ReturnType<Page['locator']>, optionName: string): Promise<void> {
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(control).toHaveValue(optionName)
}
