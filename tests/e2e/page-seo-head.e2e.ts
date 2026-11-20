import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  createPage,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  newestTemplatePriority,
  openSiteEditor,
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

  test('Page settings head tags reach the published <head> (PAGE-005)', async ({ page, browser }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const name = `Head ${suffix}`
    const slug = `head-${suffix}`
    const description = `A page described in its settings ${suffix}`

    await openSiteEditor(page)

    await test.step('an everywhere layout with an outlet wraps every page', async () => {
      await openSitePanel(page)
      await page.getByRole('button', { name: 'New template', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Template settings' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Name').fill(`Head Layout ${suffix}`)
      await dialog.getByLabel('Slug').fill(`head-layout-${suffix}`)
      await dialog.getByLabel('Priority').fill(String(newestTemplatePriority()))
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
      await dialog.getByLabel('Description').first().fill(description)
      await dialog.getByLabel('Canonical URL').fill(`https://example.com/${slug}`)
      await dialog.getByLabel('Robots').fill('noindex, follow')
      await dialog.getByLabel('Image URL').first().fill('https://example.com/card.png')

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
      await page.screenshot({ path: '.tmp/evidence/page-seo-search-tab.png' })
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
        expect(head).toContain(`<meta name="description" content="${description}">`)
        expect(head).toContain(`<link rel="canonical" href="https://example.com/${slug}">`)
        expect(head).toContain('<meta name="robots" content="noindex, follow">')
        expect(head).toContain('<meta name="theme-color" content="#0a0a0b">')
        expect(head).toContain('<meta property="og:image" content="https://example.com/card.png">')
        expect(head).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"\\u003c/script\\u003e\\u003cb\\u003ex\\u003c/b\\u003e"}</script>')
        expect(head).not.toContain('</script><b>')
      } finally {
        await context.close()
      }
    })
  })
})
