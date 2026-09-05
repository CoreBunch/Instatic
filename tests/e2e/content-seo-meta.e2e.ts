import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  OWNER,
  PUBLIC_BASE_URL,
  deleteTemplate,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  openSiteEditor,
  openSitePanel,
  publishDraft,
  setPropValue,
} from './helpers'

/**
 * CONTENT-010 — the Content settings panel's "SEO title" and "SEO
 * description" fields must reach the published entry's `<head>`, and must not
 * leak into the entry's visible on-page title.
 */
test.describe('entry SEO meta', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('published post uses the SEO title and SEO description in <head> (CONTENT-010)', async ({
    page,
    browser,
  }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const title = `Plain Entry Title ${suffix}`
    const slug = `seo-meta-${suffix}`
    const seoTitle = `SEO Override Title ${suffix}`
    const seoDescription = `SEO override description ${suffix}`

    await test.step('author and publish a Posts entry template', async () => {
      await openSiteEditor(page)
      await openSitePanel(page)
      await page.getByRole('button', { name: 'New template', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Template settings' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Name').fill(`SEO Meta Template ${suffix}`)
      await dialog.getByLabel('Slug').fill(`seo-meta-template-${suffix}`)
      await dialog.getByLabel('Applies to').click()
      await page.getByRole('option', { name: 'Post types' }).click()
      await dialog.getByLabel('Posts').setChecked(true)
      await dialog.getByLabel('Priority').fill('300')
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', '{currentEntry.title}')
      await page.locator('#ctrl-tag').click()
      await page.getByRole('option', { name: 'Heading 1', exact: true }).click()
      await expect(page.locator('#ctrl-tag')).toHaveValue('Heading 1')
      await insertModuleViaPicker(page, 'base.outlet')
      await publishDraft(page)
    })

    await test.step('create a post with a distinct SEO title and description', async () => {
      await page.goto('/admin/content')
      const newPost = page.getByRole('button', { name: 'New post', exact: true })
      await expect(newPost).toBeEnabled()
      await newPost.click()
      await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('')

      await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
      await page.getByRole('textbox', { name: 'Slug' }).fill(slug)
      await page.getByTestId('content-body-editor').click()
      await page.keyboard.type('Body for the SEO meta test.')

      const settingsPanel = page.getByTestId('content-settings-panel')
      await settingsPanel.getByLabel('SEO title').fill(seoTitle)
      await settingsPanel.getByLabel('SEO description').fill(seoDescription)

      await page.getByRole('button', { name: 'More publishing actions' }).click()
      const saveResponse = page.waitForResponse((response) =>
        /\/admin\/api\/cms\/data\/rows\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'PATCH',
      )
      await page.getByTestId('toolbar-content-save-draft-action').click()
      expect((await saveResponse).ok()).toBe(true)
    })

    await test.step('publish the post', async () => {
      await page.getByRole('button', { name: 'Publish post' }).click()
      const stepUp = page.getByTestId('step-up-dialog')
      if (await stepUp.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
        await page.getByTestId('step-up-password').fill(OWNER.password)
        await page.getByTestId('step-up-confirm').click()
        await expect(stepUp).toBeHidden({ timeout: 20_000 })
      }
      await expect(
        page.getByRole('button', { name: 'Published', exact: true }),
      ).toBeDisabled({ timeout: 20_000 })
    })

    await test.step('the public entry page carries the SEO meta in <head>', async () => {
      const context = await browser.newContext()
      const visitor = await context.newPage()
      try {
        // Assert on the served bytes: `<head>` meta tags are not reachable
        // through the accessibility tree the other public specs use.
        const response = await visitor.goto(`${PUBLIC_BASE_URL}/posts/${slug}`)
        const html = (await response?.text()) ?? ''
        const titleTag = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '(no <title> tag)'
        const descTag =
          /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ??
          '(no meta description tag)'

        expect(titleTag, 'document <title> must use the authored SEO title').toBe(seoTitle)
        expect(descTag, 'meta description must use the authored SEO description').toBe(
          seoDescription,
        )
        // The SEO override belongs in `<head>` only — the entry's own title
        // still headlines the page.
        await expect(visitor.getByRole('heading', { name: title })).toBeVisible()
        expect(html, 'the SEO title must not leak into the page body').not.toContain(
          `<h1>${seoTitle}</h1>`,
        )
      } finally {
        await context.close()
      }
    })

    // Priority 300 outranks every other Posts template the suite publishes;
    // left behind, it would render every later spec's entry route.
    await test.step('remove the template so later specs resolve their own', async () => {
      await openSiteEditor(page)
      await deleteTemplate(page, `SEO Meta Template ${suffix}`)
    })
  })
})
