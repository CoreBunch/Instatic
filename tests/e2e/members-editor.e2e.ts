import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  canvasFrame,
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
 * An owner protects a page from Page settings, builds a sign-up form from the
 * form module's Members mode (the setup panel adds the fields), limits it to
 * signed-out visitors, and publishes. A visitor is then turned away from the
 * protected page, and the published form talks to the member endpoint.
 *
 * Sign-up is closed on a new site and the switch for it arrives with the
 * member settings, so this spec stops at the endpoint's answer; a completed
 * sign-up is covered by `members.test.ts`.
 */
test.describe('member pages in the editor', () => {
  // Publishing asks for step-up, which rotates the session token.
  test.use({ storageState: ANONYMOUS_STATE })

  test('owner protects a page and publishes a member form (MEMBER-001)', async ({ page, browser }) => {
    await login(page)
    await openSiteEditor(page)

    const suffix = Date.now().toString(36)
    const club = { name: `Club ${suffix}`, slug: `club-${suffix}` }
    const join = { name: `Join ${suffix}`, slug: `join-${suffix}` }

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
      await expect(page.getByRole('img', { name: 'Signed-in members only' })).toBeVisible()
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
      await page.getByRole('button', { name: 'Attributes', exact: true }).click()
      const showTo = page.getByTestId('show-when-control')
      await pickOption(page, showTo.getByLabel('Show to'), 'Signed-out visitors')
      await expect(showTo.getByText('Left out of the page for signed-in members.')).toBeVisible()
      await page.screenshot({ path: '.tmp/evidence/members-show-to.png' })

      await publishDraft(page)
    })

    await test.step('a visitor is turned away from the protected page and reaches the member endpoint', async () => {
      const context = await browser.newContext()
      const visitor = await context.newPage()
      try {
        await visitor.goto(`${PUBLIC_BASE_URL}/${club.slug}`)
        await expect(visitor).toHaveURL(new RegExp(`/_instatic/members/sign-in\\?next=%2F${club.slug}`))

        await visitor.goto(`${PUBLIC_BASE_URL}/${join.slug}`)
        await visitor.getByLabel('Name').fill('Visitor')
        await visitor.getByLabel('Email').fill(`visitor-${suffix}@example.com`)

        // Before anything is submitted the success message is not on screen.
        await expect(visitor.getByText('Check your email to confirm your address.')).toBeHidden()

        // A new site keeps sign-up closed until the owner opens it, so the
        // published form reaches the member endpoint and shows its answer in
        // the form's own error message, without leaving the page.
        await visitor.getByLabel('Password').fill('a-long-enough-password')
        await visitor.getByRole('button', { name: 'Create account' }).click()
        await expect(visitor.getByRole('alert')).toHaveText('Sign-up is closed.')
        await expect(visitor).toHaveURL(new RegExp(`/${join.slug}$`))
        await visitor.screenshot({ path: '.tmp/evidence/members-signup-published.png' })
      } finally {
        await context.close()
      }
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
