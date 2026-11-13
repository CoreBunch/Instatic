import { readFile } from 'node:fs/promises'
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
  openLayersPanel,
  publishDraft,
  setPropValue,
} from './helpers'

/**
 * FORM-001 / FORM-002 — author a CMS-native form, publish it, submit it as a
 * visitor, and verify the resulting data row from the admin Data workspace.
 */
test.describe('forms', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('stores private file bytes and downloads them from the submission (FORM-003)', async ({ page, browser }) => {
    await login(page)
    const tableName = 'File submission evidence'
    await createCustomDataTable(page, tableName)
    const { slug } = await openBlankPage(page, 'File submission')
    await insertModuleViaPicker(page, 'base.form')
    await page.getByLabel('Form ID').fill('file-submission')
    await selectLabeledOption(page, 'Target table', tableName)
    await setPropValue(page, 'minSubmitSeconds', '0')
    await insertModuleViaPicker(page, 'base.input')
    await setPropValue(page, 'fieldId', 'name')
    await setPropValue(page, 'name', 'name')
    await insertModuleViaPicker(page, 'base.input')
    await setPropValue(page, 'name', 'attachment')
    await selectPropertyOption(page, 'inputType', 'file')
    await expect(page.getByText('Files become private submission attachments.', { exact: false })).toBeVisible()
    await insertModuleViaPicker(page, 'base.submit')
    await setPropValue(page, 'label', 'Send file')
    await openLayersPanel(page)
    await page.getByRole('tree', { name: 'Page element tree' }).getByRole('treeitem', { name: 'Form', exact: true }).click()
    await insertModuleViaPicker(page, 'base.form-message')
    await publishDraft(page)

    const visitor = await browser.newPage()
    try {
      await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
      await visitor.locator('input[name="name"]').fill('Private file visitor')
      const picker = visitor.locator('input[type="file"]')
      await picker.setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<script>not a PDF</script>') })
      await visitor.getByRole('button', { name: 'Send file' }).click()
      const form = visitor.locator('form[data-instatic-form-id="file-submission"]')
      await expect(form).toHaveAttribute('data-instatic-form-state', 'error')
      await expect(picker).toHaveJSProperty('value', 'C:\\fakepath\\fake.pdf')
      const bytes = Buffer.from('%PDF-1.4\nActual invoice bytes\n%%EOF')
      await picker.setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: bytes })
      await visitor.getByRole('button', { name: 'Send file' }).click()
      await expect(form).toHaveAttribute('data-instatic-form-state', 'success')
      await visitor.screenshot({ path: '.tmp/evidence/after-private-upload.png', fullPage: true })
      await page.goto('/admin/data')
      await openCustomTable(page, tableName)
      await page.getByRole('row').filter({ hasText: 'Private file visitor' }).getByRole('button', { name: 'Open', exact: true }).click()
      const button = page.getByRole('button', { name: 'Download invoice.pdf' })
      await expect(button).toBeVisible()
      const responsePromise = page.waitForResponse((response) => /\/attachments\/[^/]+$/.test(new URL(response.url()).pathname))
      const downloadPromise = page.waitForEvent('download')
      await button.click()
      const download = await downloadPromise
      await download.saveAs('.tmp/evidence/downloaded-invoice.pdf')
      expect(await readFile('.tmp/evidence/downloaded-invoice.pdf')).toEqual(bytes)
      const response = await responsePromise
      const unauthorized = await visitor.request.get(response.url())
      expect(unauthorized.status()).toBe(401)
      await page.screenshot({ path: '.tmp/evidence/after-private-attachment.png', fullPage: true })
    } finally {
      await visitor.close()
    }
  })

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
