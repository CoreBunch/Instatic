import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  createPage,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  newestTemplatePriority,
  openSiteEditor,
  openExplorerTab,
  openSitePanel,
  publishDraft,
  setPropValue,
} from './helpers'

/**
 * PAGE-005 — a page's search, social and head settings, set in Page
 * settings, survive a reload and reach the published page's `<head>`, also
 * when an everywhere layout wraps the page (public renders compose the
 * template chain, and the layout must not swallow the page's settings).
 */
test.describe('page head settings', () => {
  // Publishing asks for step-up, which rotates the session token.
  test.use({ storageState: ANONYMOUS_STATE })

  async function globalSettings(page: Page) {
    await openSitePanel(page)
    await page.getByRole('button', { name: 'Global head settings' }).click()
    return page.getByRole('dialog', { name: 'Global head settings' })
  }

  let restore: { title: string; creator: string; layoutName: string } | undefined
  test.afterEach(async ({ browser, baseURL }) => {
    const saved = restore
    restore = undefined
    if (!saved) return
    // Teardown has its own time budget and login even if the editor test timed out.
    const page = await browser.newPage({ baseURL })
    try {
      await login(page)
      await openSiteEditor(page)
      const global = await globalSettings(page)
      await global.getByLabel('Title', { exact: true }).first().fill(saved.title)
      await global.getByLabel('Creator').fill(saved.creator)
      await global.getByRole('button', { name: 'Save' }).click()
      // The layout wraps every page of the shared E2E site: remove it and
      // publish again so later specs see the site as they expect.
      await openSitePanel(page)
      const layout = page.getByRole('treeitem', { name: `Open template ${saved.layoutName}` })
      if (await layout.count()) {
        await layout.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Delete' }).click()
        const confirm = page.getByRole('alertdialog')
        await confirm.getByRole('button', { name: /^Delete/ }).click()
        await expect(layout).toHaveCount(0)
        await publishDraft(page)
      }
    } finally {
      await page.close()
    }
  })

  test('Page settings head tags reach the published <head> (PAGE-005)', async ({ page, browser }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const name = `Head ${suffix}`
    const slug = `head-${suffix}`
    const filename = `seo-${suffix}.svg`
    let imagePath = ''
    const description = `A page described in its settings ${suffix}`

    const layoutName = `Head Layout ${suffix}`
    await openSiteEditor(page)
    await openExplorerTab(page, 'Code')
    await expect(page.getByRole('button', { name: 'Global head settings' })).toHaveCount(0)
    await openSitePanel(page)
    const pages = page.getByRole('button', { name: 'Pages', exact: true })
    await pages.click()
    await expect(page.getByRole('tree', { name: 'Pages' })).toBeHidden()
    await pages.click()
    await expect(page.getByRole('tree', { name: 'Pages' })).toBeVisible()
    const global = await globalSettings(page)
    const globalTitle = global.getByLabel('Title', { exact: true }).first()
    restore = { title: await globalTitle.inputValue(), creator: await global.getByLabel('Creator').inputValue(), layoutName }
    await globalTitle.fill('{page.title} | {site.name}')
    await global.getByLabel('Creator').fill('@global')
    await global.getByRole('button', { name: 'Save' }).click()
    await test.step('an everywhere layout with an outlet wraps every page', async () => {
      await openSitePanel(page)
      await page.getByRole('button', { name: 'New template', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Template settings' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Name').fill(layoutName)
      await dialog.getByLabel('Slug').fill(`head-layout-${suffix}`)
      await dialog.getByLabel('Priority').fill(String(newestTemplatePriority()))
      await dialog.getByRole('tab', { name: 'Search & social' }).click()
      await expect(dialog.getByLabel('Creator')).toHaveAttribute('placeholder', '@global')
      await expect(dialog.getByRole('textbox', { name: 'Title', exact: true }).first()).toHaveAttribute('placeholder', '{page.title} | {site.name}')
      await dialog.getByLabel('Site name').fill('Studio | {page.title}')
      await dialog.getByLabel('Description').first().fill('Template description')
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', `Layout nav ${suffix}`)
      await insertModuleViaPicker(page, 'base.outlet')
    })

    await createPage(page, name, slug)
    await openSitePanel(page)
    const row = page.getByRole('treeitem', { name: `Open page ${name}` })
    await row.click()
    await insertNotchModule(page, 'text')

    const openSettings = async () => {
      await openSitePanel(page)
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Page settings' }).click()
      const dialog = page.getByRole('dialog', { name: 'Page settings' })
      await expect(dialog).toBeVisible()
      return dialog
    }

    await test.step('fill search, social and head tags', async () => {
      const dialog = await openSettings()
      await dialog.getByRole('tab', { name: 'Search & social' }).click()
      const creator = dialog.getByLabel('Creator')
      await expect(creator).toHaveValue('')
      await expect(creator).toHaveAttribute('placeholder', '@global')
      await creator.fill('@override')
      await creator.fill('')
      await expect(creator).toHaveAttribute('placeholder', '@global')
      await expect(dialog.getByRole('textbox', { name: 'Title', exact: true }).first()).toHaveAttribute('placeholder', `${name} | Automated E2E Site`)
      await expect(dialog.getByLabel('Site name')).toHaveAttribute('placeholder', `Studio | ${name}`)
      await expect(dialog.getByLabel('Description').first()).toHaveAttribute('placeholder', 'Template description')
      await page.screenshot({ path: '.tmp/evidence/seo-inherited-page.png' })
      await dialog.getByLabel('Description').first().fill(description)
      await dialog.getByLabel('Canonical URL').fill(`https://example.com/${slug}`)
      await dialog.getByLabel('Robots').fill('noindex, follow')
      const image = dialog.getByRole('group', { name: 'Social card image', exact: true })
      await image.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      await expect(picker).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(picker).toBeHidden()
      // Reproduce a fast upload overtaking the picker's initial library listing.
      let markListingReady!: () => void
      const listingReady = new Promise<void>((resolve) => { markListingReady = resolve })
      let releaseListing!: () => void
      const listingReleased = new Promise<void>((resolve) => { releaseListing = resolve })
      await page.route('**/admin/api/cms/media', async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const response = await route.fetch()
        markListingReady()
        await listingReleased
        await route.fulfill({ response })
      }, { times: 1 })
      const uploadedImage = picker.getByRole('button', { name: `Open ${filename}` })
      try {
        await image.getByRole('button', { name: 'Browse image library' }).click()
        await listingReady
        await picker.locator('input[type=file]').setInputFiles({
          name: filename, mimeType: 'image/svg+xml', buffer: await readFile('public/favicon.svg'),
        })
        await expect(uploadedImage).toBeVisible()
      } finally {
        releaseListing()
      }
      await expect(picker.getByRole('region', { name: 'Media library' }).getByRole('status').filter({ hasText: /item/ })).toBeVisible()
      await uploadedImage.click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(image.getByText(filename)).toBeVisible()
      const twitter = dialog.getByRole('group', { name: 'X / Twitter image', exact: true })
      await twitter.getByRole('button', { name: 'Browse image library' }).click()
      await picker.getByRole('button', { name: `Open ${filename}` }).click()
      await picker.getByRole('button', { name: 'Use selected' }).click()

      await dialog.getByRole('tab', { name: 'Head tags' }).click()
      await dialog.getByRole('button', { name: 'Add theme color' }).click()
      await dialog.getByLabel('Theme color', { exact: true }).fill('#0a0a0b')
      await dialog.getByRole('button', { name: 'Add structured data' }).click()
      const block = dialog.getByLabel('Structured data block 1')
      await block.fill('{ not json')
      // Shown under the field and, as the reason Save is off, in the footer.
      await expect(dialog.getByText('Structured data: This is not valid JSON.')).toBeVisible()
      await expect(dialog.getByText('This is not valid JSON.', { exact: true })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
      await block.fill('{"@context":"https://schema.org","@type":"WebPage","name":"</script><b>x</b>"}')
      await page.screenshot({ path: '.tmp/evidence/page-seo-head-tags.png' })
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()
    })

    await test.step('the settings survive a reload', async () => {
      await page.reload()
      await openSiteEditor(page)
      const dialog = await openSettings()
      await dialog.getByRole('tab', { name: 'Search & social' }).click()
      await expect(dialog.getByLabel('Description').first()).toHaveValue(description)
      const image = dialog.getByRole('group', { name: 'Social card image', exact: true })
      await expect(image.getByText(filename)).toBeVisible()
      await image.scrollIntoViewIfNeeded()
      await page.screenshot({ path: '.tmp/evidence/page-seo-search-tab.png' })
      await image.getByText('URL', { exact: true }).click()
      imagePath = await image.getByRole('textbox').inputValue()
      expect(imagePath).toMatch(/^\/uploads\//)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })

    await test.step('the published page carries them in <head>', async () => {
      await publishDraft(page)
      const context = await browser.newContext()
      const visitor = await context.newPage()
      try {
        const response = await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
        const html = (await response?.text()) ?? ''
        const head = html.slice(0, html.indexOf('</head>'))
        expect(html, 'the layout wraps the page').toContain(`Layout nav ${suffix}`)
        expect(head).toContain(`<title>${name} | Automated E2E Site</title>`)
        expect(head).toContain('<meta name="twitter:creator" content="@global">')
        expect(head).toContain(`<meta property="og:site_name" content="Studio | ${name}">`)
        expect(head).toContain(`<meta name="description" content="${description}">`)
        expect(head).toContain(`<link rel="canonical" href="https://example.com/${slug}">`)
        expect(head).toContain('<meta name="robots" content="noindex, follow">')
        expect(head).toContain('<meta name="theme-color" content="#0a0a0b">')
        expect(head).toContain(`<meta property="og:image" content="${imagePath}">`)
        expect(head).toContain(`<meta name="twitter:image" content="${imagePath}">`)
        expect(head).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"\\u003c/script\\u003e\\u003cb\\u003ex\\u003c/b\\u003e"}</script>')
        expect(head).not.toContain('</script><b>')
      } finally {
        await context.close()
      }
    })
  })
})
