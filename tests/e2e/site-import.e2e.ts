import { expect, test } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import { canvasFrame, openCodePanel } from './helpers'

// ADMIN-011: completing a static-site import from Data opens the imported page.
test('opens the imported page in the Site workspace from Data (ADMIN-011)', async ({ page }, testInfo) => {
  const title = `Imported page ${Date.now().toString(36)}`
  await page.goto('/admin/data')
  await page.getByRole('button', { name: 'Import site', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'imported-page.html',
    mimeType: 'text/html',
    buffer: Buffer.from(`<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`),
  })
  await expect(page.getByRole('dialog', { name: 'Review import' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue →', exact: true }).click()
  const openSite = page.getByRole('button', { name: 'Open site →', exact: true })
  await expect(openSite).toBeVisible({ timeout: 30_000 })
  await openSite.click()
  await expect(page).toHaveURL(/\/admin\/site(?:\?|$)/)
  await expect(canvasFrame(page).getByRole('heading', { name: title })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('after-open-site.png') })
})

// ADMIN-014: a stylesheet with no page imports as a site stylesheet.
test('imports a lone stylesheet as a site stylesheet in the Code panel (ADMIN-014)', async ({ page }) => {
  const name = `lone-sheet-${Date.now().toString(36)}.css`
  await page.goto('/admin/data')
  await page.getByRole('button', { name: 'Import site', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'text/css',
    buffer: Buffer.from('.members-card { padding: 24px; border-radius: 12px; }\n'),
  })
  const review = page.getByRole('dialog', { name: 'Review import' })
  await expect(review).toBeVisible()
  await expect(review.getByText(name)).toBeVisible()
  await expect(review.getByText('Added to the Code panel as a site stylesheet, applied to every page')).toBeVisible()
  await expect(review.getByText(/linked by any imported page/)).toHaveCount(0)
  await page.screenshot({ path: '.tmp/evidence/after-lone-css-review.png' })

  await page.getByRole('button', { name: 'Continue →', exact: true }).click()
  const openSite = page.getByRole('button', { name: 'Open site →', exact: true })
  await expect(openSite).toBeVisible({ timeout: 30_000 })
  await openSite.click()
  await expect(page).toHaveURL(/\/admin\/site(?:\?|$)/)
  await openCodePanel(page)
  await expect(page.getByRole('complementary', { name: 'Explorer' }).getByText(name).first()).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/after-lone-css-code-panel.png' })
})

// ADMIN-015: a plugin package is recognised at the Drop step, not imported.
test('recognises a plugin package and sends the owner to Plugins (ADMIN-015)', async ({ page }) => {
  const zip = zipSync({
    'plugin.json': strToU8(JSON.stringify({ id: 'acme.members-starter', name: 'Members Starter', version: '1.0.0' })),
    'pack/site.json': strToU8('{}'),
    'frontend/members-starter.css': strToU8('.members-card { padding: 24px; }\n'),
  })
  await page.goto('/admin/data')
  await page.getByRole('button', { name: 'Import site', exact: true }).click()
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'members-starter.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  })
  const dialog = page.getByRole('dialog', { name: 'Import site' })
  await expect(dialog.getByText('Members Starter is a plugin, not a site')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Review import' })).toHaveCount(0)
  await page.screenshot({ path: '.tmp/evidence/after-plugin-zip.png' })

  await dialog.getByRole('button', { name: 'Go to Plugins', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/plugins(?:\?|$)/)
  await expect(dialog).toHaveCount(0)
})

// ADMIN-017: importing the same bundle twice reuses its script and image.
test('reuses the script and image already in the site on a re-import (ADMIN-017)', async ({ page }) => {
  const id = `reimport-${Date.now().toString(36)}`
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const bundle = Buffer.from(zipSync({
    [`${id}.html`]: strToU8(
      `<html><head><title>${id}</title><script src="${id}.js"></script></head>`
      + `<body><h1>${id}</h1><img src="${id}.png" alt="Pixel"></body></html>`,
    ),
    [`${id}.js`]: strToU8('document.documentElement.dataset.reimport = "1"\n'),
    [`${id}.png`]: new Uint8Array(png),
  }))

  async function importBundle() {
    await page.goto('/admin/data')
    await page.getByRole('button', { name: 'Import site', exact: true }).click()
    await page.locator('input[type="file"]').first().setInputFiles({
      name: `${id}.zip`,
      mimeType: 'application/zip',
      buffer: bundle,
    })
    await expect(page.getByRole('dialog', { name: 'Review import' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue →', exact: true }).click()
  }

  await importBundle()
  await expect(page.getByRole('button', { name: 'Open site →', exact: true })).toBeVisible({ timeout: 30_000 })

  await importBundle()
  const conflicts = page.getByRole('dialog', { name: 'Resolve conflicts' })
  await expect(conflicts.getByText('Files already in this site (1)')).toBeVisible()
  await expect(conflicts.getByText('Media already in the library (1)')).toBeVisible()
  await page.screenshot({ path: '.tmp/evidence/after-reimport-conflicts.png' })
  await conflicts.getByRole('button', { name: 'Overwrite all page slug conflicts' }).click()
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open site →', exact: true })).toBeVisible({ timeout: 30_000 })

  const media = await page.request.get(`/admin/api/cms/media?query=${id}`)
  expect(media.ok()).toBe(true)
  const { assets } = await media.json() as { assets: { filename: string }[] }
  expect(assets.map((asset) => asset.filename)).toEqual([`${id}.png`])

  const site = await page.request.get('/admin/api/cms/site')
  const { site: shell } = await site.json() as { site: { files: { path: string }[] } }
  expect(shell.files.map((file) => file.path).filter((path) => path.startsWith(id))).toEqual([`${id}.js`])
})
