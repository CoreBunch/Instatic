import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  completeStepUp,
  createPage,
  insertModuleViaPicker,
  login,
  openSiteEditor,
  openSitePanel,
  publishDraft,
  saveDraft,
  setPropValue,
} from './helpers'

/**
 * FORM-001 / FORM-002 — author a CMS-native form, publish it, submit it as a
 * visitor, and verify the resulting data row from the admin Data workspace.
 */
test.describe('forms', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('publishes a CMS-native form and stores a visitor submission (FORM-001, FORM-002)', async ({
    page,
    browser,
  }) => {
    await login(page)

    const suffix = Date.now().toString(36)
    const tableName = `E2E Form Submissions ${suffix}`
    const formId = `lead-${suffix}`
    const visitorName = `Visitor ${suffix}`
    const successMessage = `Submission received ${suffix}`

    await test.step('create the target data table', async () => {
      await createCustomDataTable(page, tableName)
    })

    const { slug } = await test.step('author and publish the form page', async () => {
      const created = await openBlankPage(page, 'Form submit')

      await insertModuleViaPicker(page, 'base.form')
      await page.getByLabel('Form ID').fill(formId)
      await selectLabeledOption(page, 'Target table', tableName)
      await setPropValue(page, 'successMessage', successMessage)
      await setPropValue(page, 'minSubmitSeconds', '0')

      await insertModuleViaPicker(page, 'base.input')
      await setPropValue(page, 'fieldId', 'name')
      await setPropValue(page, 'name', 'name')
      await setPropValue(page, 'placeholder', 'Your name')

      await insertModuleViaPicker(page, 'base.submit')
      await setPropValue(page, 'label', 'Send lead')

      await insertModuleViaPicker(page, 'base.form-message')
      await selectPropertyOption(page, 'kind', 'Success')

      await saveDraft(page)
      await publishDraft(page)
      return created
    })

    await test.step('submit the published form as a visitor', async () => {
      await submitPublicForm(browser, slug, visitorName, successMessage)
    })

    await test.step('verify the submission appears in the Data workspace', async () => {
      await page.goto('/admin/data')
      await openCustomTable(page, tableName)
      await expect(
        page.getByRole('row').filter({ hasText: visitorName }),
      ).toBeVisible({ timeout: 20_000 })
    })
  })

  test('shows mobile error feedback for too-fast public submissions and accepts retry after the fill timer (FORM-002)', async ({
    page,
    browser,
  }) => {
    await login(page)

    const suffix = Date.now().toString(36)
    const tableName = `E2E Timed Form Submissions ${suffix}`
    const formId = `timed-${suffix}`
    const visitorName = `Fast Visitor ${suffix}`
    const successMessage = `Timed submission received ${suffix}`

    await test.step('create the target data table', async () => {
      await createCustomDataTable(page, tableName)
    })

    const { slug } = await test.step('author and publish a timed form page', async () => {
      const created = await openBlankPage(page, 'Timed form submit')

      await insertModuleViaPicker(page, 'base.form')
      await page.getByLabel('Form ID').fill(formId)
      await selectLabeledOption(page, 'Target table', tableName)
      await setPropValue(page, 'successMessage', successMessage)
      await setPropValue(page, 'minSubmitSeconds', '1')

      await insertModuleViaPicker(page, 'base.input')
      await setPropValue(page, 'fieldId', 'name')
      await setPropValue(page, 'name', 'name')
      await setPropValue(page, 'placeholder', 'Your name')

      await insertModuleViaPicker(page, 'base.submit')
      await setPropValue(page, 'label', 'Send lead')

      await insertModuleViaPicker(page, 'base.form-message')
      await setPropValue(page, 'formId', formId)
      await selectPropertyOption(page, 'kind', 'Success')

      await insertModuleViaPicker(page, 'base.form-message')
      await setPropValue(page, 'formId', formId)
      await selectPropertyOption(page, 'kind', 'Error')

      await saveDraft(page)
      await publishDraft(page)
      return created
    })

    await test.step('submit too quickly on mobile and retry after the timer', async () => {
      await submitTimedPublicFormOnMobile(browser, slug, visitorName, successMessage)
    })

    await test.step('verify only the accepted retry appears in the Data workspace', async () => {
      await page.goto('/admin/data')
      await openCustomTable(page, tableName)
      await expect(
        page.getByRole('row').filter({ hasText: visitorName }),
      ).toBeVisible({ timeout: 20_000 })
    })
  })
})

async function createCustomDataTable(page: Page, tableName: string): Promise<void> {
  await page.goto('/admin/data')
  await page.getByRole('button', { name: 'New table' }).click()
  const dialog = page.getByRole('dialog', { name: 'New table' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name', { exact: true }).fill(tableName)
  await dialog.getByLabel('Plural label').fill(tableName)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await completeStepUp(page)
  await expect(dialog).toBeHidden({ timeout: 20_000 })
  await openCustomTable(page, tableName)
}

async function openBlankPage(
  page: Page,
  label: string,
): Promise<{ name: string; slug: string }> {
  await openSiteEditor(page)
  const suffix = Date.now().toString(36)
  const name = `${label} ${suffix}`
  const slug = `form-${suffix}`
  await createPage(page, name, slug)
  await openSitePanel(page)
  const item = page.getByRole('treeitem', { name: `Open page ${name}` })
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
  return { name, slug }
}

async function selectPropertyOption(
  page: Page,
  propKey: string,
  optionName: string,
): Promise<void> {
  const control = page.locator(`#ctrl-${propKey}`)
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(control).toHaveValue(optionName)
}

async function selectLabeledOption(
  page: Page,
  label: string,
  optionName: string,
): Promise<void> {
  const control = page.getByLabel(label)
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(control).toHaveValue(optionName)
}

async function submitPublicForm(
  browser: Browser,
  slug: string,
  visitorName: string,
  successMessage: string,
): Promise<void> {
  const context = await browser.newContext()
  const visitor = await context.newPage()
  const assetResponses = recordPublicInstaticAssetResponses(visitor)
  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
    await expectPublishedFormAssets(visitor, assetResponses)
    await visitor.getByPlaceholder('Your name').fill(visitorName)
    await visitor.getByRole('button', { name: 'Send lead' }).click()
    await expect(
      visitor.getByRole('status').filter({ hasText: successMessage }),
    ).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
}

async function submitTimedPublicFormOnMobile(
  browser: Browser,
  slug: string,
  visitorName: string,
  successMessage: string,
): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const visitor = await context.newPage()
  const assetResponses = recordPublicInstaticAssetResponses(visitor)
  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
    await expectPublishedFormAssets(visitor, assetResponses)
    await expectNoPageHorizontalOverflow(visitor)
    await visitor.getByPlaceholder('Your name').fill(visitorName)
    await visitor.getByRole('button', { name: 'Send lead' }).click()
    await expect(
      visitor.getByRole('alert').filter({ hasText: 'Form submitted too quickly' }),
    ).toBeVisible({ timeout: 20_000 })
    await expectNoPageHorizontalOverflow(visitor)

    await visitor.waitForTimeout(1_200)
    await visitor.getByRole('button', { name: 'Send lead' }).click()
    await expect(
      visitor.getByRole('status').filter({ hasText: successMessage }),
    ).toBeVisible({ timeout: 20_000 })
    await expectNoPageHorizontalOverflow(visitor)
  } finally {
    await context.close()
  }
}

type PublicAssetResponse = {
  path: string
  status: number
  contentType: string
}

function recordPublicInstaticAssetResponses(page: Page): PublicAssetResponse[] {
  const responses: PublicAssetResponse[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/_instatic/')) return
    responses.push({
      path: url.pathname,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    })
  })
  return responses
}

async function expectPublishedFormAssets(
  page: Page,
  responses: PublicAssetResponse[],
): Promise<void> {
  await expect(
    page.locator('link[rel="stylesheet"][href*="/_instatic/css/reset-"]'),
  ).toHaveCount(1)
  await expect(page.locator('script[src*="/_instatic/module-js/base.form.js"]')).toHaveCount(1)
  await expectPublicAssetResponse(responses, /^\/_instatic\/css\/.+\.css$/, 'text/css')
  await expectPublicAssetResponse(
    responses,
    /^\/_instatic\/module-js\/base\.form\.js$/,
    'javascript',
  )
}

async function expectPublicAssetResponse(
  responses: PublicAssetResponse[],
  pathPattern: RegExp,
  contentTypePart: string,
): Promise<void> {
  await expect.poll(() =>
    responses.some((response) =>
      pathPattern.test(response.path) &&
      response.status === 200 &&
      response.contentType.includes(contentTypePart),
    ),
  ).toBe(true)
}

async function expectNoPageHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    )
    .toBe(true)
}

async function openCustomTable(page: Page, tableName: string): Promise<void> {
  const tableOption = page.getByRole('option', {
    name: new RegExp(`^${escapeRegExp(tableName)}\\b`),
  })
  await expect(tableOption).toBeVisible({ timeout: 20_000 })
  await tableOption.click()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
