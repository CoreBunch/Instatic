import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  PUBLIC_BASE_URL,
  canvasFrame,
  createPage,
  insertNotchModule,
  login,
  openExplorerTab,
  openSiteEditor,
  publishDraft,
  saveDraft,
} from './helpers'

/** A minimal but valid 1×1 PNG — enough for the server's magic-byte check. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const UNSAFE_SVG = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="window.__svgPwned = true">
  <script>window.__svgScriptRan = true</script>
  <style>@import url("javascript:alert(1)")</style>
  <foreignObject><body><script>window.__foreignObjectRan = true</script></body></foreignObject>
  <a href="javascript:alert(1)"><rect width="16" height="16" fill="red" onclick="alert(1)" /></a>
</svg>
`)

/**
 * MEDIA-001 / MEDIA-002 — upload an image and place it on a page, and confirm
 * that an unsupported upload is rejected with clear feedback.
 *
 * Fresh login per test: MEDIA-001 publishes, which rotates the session token, so
 * it must not run on the shared owner state.
 */
test.describe('media', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('uploads an image, places it on a page, and publishes it (MEDIA-001)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const slug = `media-${suffix}`
    const filename = `e2e-image-${suffix}.png`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, `Media ${suffix}`, slug)
    await page.getByRole('treeitem', { name: `Open page Media ${suffix}` }).click()

    await insertNotchModule(page, 'image')
    await expect(page.getByTestId('property-control-src')).toBeVisible()

    await test.step('upload and select an image in the picker', async () => {
      await page.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      await expect(picker).toBeVisible()

      // The file input is hidden by design; set files on it directly rather
      // than driving the OS file chooser.
      await picker
        .locator('input[type="file"]')
        .setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG_1X1 })

      // Uploads are not auto-selected: pick the new asset, then confirm.
      await picker.getByRole('button', { name: `Open ${filename}` }).click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(picker).toBeHidden()
    })

    // The editor canvas previews the chosen asset from /uploads.
    await expect(
      canvasFrame(page).locator('img[src*="/uploads/"]').first(),
    ).toBeVisible()

    await saveDraft(page)
    await publishDraft(page)

    // The visitor-facing page serves and decodes the same uploaded image.
    await visitPublishedMediaPage(browser, slug)
  })

  test('rejects an unsupported upload with clear feedback (MEDIA-002)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: `not-an-image-${Date.now().toString(36)}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('this is plainly not an image'),
    })

    // The server rejects unknown types by magic bytes; the queue surfaces the
    // specific reason, not a generic failure.
    await expect(page.getByRole('alert').filter({ hasText: /can be uploaded/ })).toBeVisible()
  })

  test('reuses a library asset on a second image without re-uploading (MEDIA-003)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const filename = `reuse-${suffix}.png`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, `Reuse ${suffix}`, `reuse-${suffix}`)
    await page.getByRole('treeitem', { name: `Open page Reuse ${suffix}` }).click()

    await test.step('upload the asset into the library on a first image', async () => {
      await insertNotchModule(page, 'image')
      await expect(page.getByTestId('property-control-src')).toBeVisible()
      await page.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      await picker
        .locator('input[type="file"]')
        .setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG_1X1 })
      await picker.getByRole('button', { name: `Open ${filename}` }).click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(picker).toBeHidden()
    })

    await test.step('place the same asset on a second image with no upload', async () => {
      await insertNotchModule(page, 'image')
      await page.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      // The asset is already in the library — selecting it proves reuse.
      const existing = picker.getByRole('button', { name: `Open ${filename}` })
      await expect(existing).toBeVisible()
      await existing.click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(picker).toBeHidden()
    })

    // Both image modules render the reused asset from /uploads.
    await expect(
      canvasFrame(page).locator('img[src*="/uploads/"]'),
    ).toHaveCount(2)
  })

  test('applies an uploaded asset from the docked Media Explorer to a selected image (SITE-015)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const slug = `site-media-${suffix}`
    const filename = `site-media-${suffix}.png`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, `Site media ${suffix}`, slug)
    await page.getByRole('treeitem', { name: `Open page Site media ${suffix}` }).click()

    await insertNotchModule(page, 'image')
    await expect(page.getByTestId('property-control-src')).toBeVisible()

    await openExplorerTab(page, 'Media')
    const mediaPanel = page.getByTestId('media-explorer-panel')
    await expect(mediaPanel).toBeVisible()

    await Promise.all([
      waitForMediaUpload(page),
      mediaPanel
        .locator('input[type="file"]')
        .first()
        .setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG_1X1 }),
    ])

    const asset = mediaPanel.getByRole('button', { name: `Open media ${filename}` })
    await expect(asset).toBeVisible()
    await openAssetMenu(asset, page)
    await page
      .getByRole('menu', { name: 'Media item options' })
      .getByRole('menuitem', { name: 'Use in selected image' })
      .click()

    await expect(canvasFrame(page).locator('img[src*="/uploads/"]').first()).toBeVisible()

    await saveDraft(page)
    await publishDraft(page)
    await visitPublishedMediaPage(browser, slug)
  })

  test('edits media metadata and persists it after reload (MEDIA-004)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const originalFilename = `metadata-${suffix}.png`
    const renamedFilename = `metadata-renamed-${suffix}.png`
    const title = `Metadata title ${suffix}`
    const altText = `Alt text ${suffix}`
    const caption = `Caption ${suffix}`
    const tag = `tag-${suffix}`

    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: originalFilename,
      mimeType: 'image/png',
      buffer: PNG_1X1,
    })

    await page.getByRole('button', { name: `Open ${originalFilename}` }).click()
    let viewer = page.getByRole('dialog', { name: `Viewer: ${originalFilename}` })
    await expect(viewer).toBeVisible()

    await fillMediaMetadataField(page, viewer, 'Title', title)
    await fillMediaMetadataField(page, viewer, 'Filename', renamedFilename)
    await expect(page.getByRole('button', { name: `Open ${renamedFilename}` })).toBeVisible()
    viewer = page.getByRole('dialog', { name: `Viewer: ${renamedFilename}` })
    await expect(viewer).toBeVisible()

    await fillMediaMetadataField(page, viewer, 'Alt text', altText)
    await fillMediaMetadataField(page, viewer, 'Caption', caption)

    await viewer.getByLabel('Add tag').fill(tag)
    await Promise.all([
      waitForMediaPatch(page),
      viewer.getByLabel('Add tag').press('Enter'),
    ])
    await expect(viewer.getByRole('list', { name: 'Selected tags' })).toContainText(tag)

    await page.reload()
    await expect(page.getByRole('button', { name: `Open ${renamedFilename}` })).toBeVisible()
    await page.getByRole('button', { name: `Open ${renamedFilename}` }).click()
    viewer = page.getByRole('dialog', { name: `Viewer: ${renamedFilename}` })
    await expect(viewer).toBeVisible()
    await expect(viewer.getByLabel('Title')).toHaveValue(title)
    await expect(viewer.getByLabel('Filename')).toHaveValue(renamedFilename)
    await expect(viewer.getByLabel('Alt text')).toHaveValue(altText)
    await expect(viewer.getByLabel('Caption')).toHaveValue(caption)
    await expect(viewer.getByRole('list', { name: 'Selected tags' })).toContainText(tag)
  })

  test('keeps the media metadata viewer usable at mobile width (MEDIA-004)', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const suffix = Date.now().toString(36)
    const filename = `mobile-metadata-${suffix}.png`
    const title = `Mobile metadata title ${suffix}`
    const altText = `Mobile alt ${suffix}`
    const tag = `mobile-${suffix}`

    await page.addInitScript(() => {
      localStorage.removeItem('instatic-editor-layout-v2')
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: filename,
      mimeType: 'image/png',
      buffer: PNG_1X1,
    })

    const assetButton = page.getByRole('button', { name: `Open ${filename}` })
    await expect(assetButton).toBeVisible()
    await closeUploadQueueIfOpen(page)
    await assetButton.click()

    const viewer = page.getByRole('dialog', { name: `Viewer: ${filename}` })
    await expect(viewer).toBeVisible()
    await expectMobileViewerContained(page, viewer)
    await expect(viewer.getByLabel('Title')).toBeVisible()
    await expect(viewer.getByLabel('Filename')).toBeVisible()
    await expect(viewer.getByLabel('Alt text')).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Replace file' })).toBeVisible()

    await fillMediaMetadataField(page, viewer, 'Title', title)
    await fillMediaMetadataField(page, viewer, 'Alt text', altText)
    await viewer.getByLabel('Add tag').fill(tag)
    await Promise.all([
      waitForMediaPatch(page),
      viewer.getByLabel('Add tag').press('Enter'),
    ])

    await expect(viewer.getByLabel('Title')).toHaveValue(title)
    await expect(viewer.getByLabel('Alt text')).toHaveValue(altText)
    await expect(viewer.getByRole('list', { name: 'Selected tags' })).toContainText(tag)
    await expectMobileViewerContained(page, viewer)
  })

  test('replaces, deletes, restores, and purges an asset (MEDIA-005)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const filename = `replace-delete-${suffix}.png`
    const replacementFilename = `replacement-${suffix}.png`

    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: filename,
      mimeType: 'image/png',
      buffer: PNG_1X1,
    })

    const assetButton = page.getByRole('button', { name: `Open ${filename}` })
    await expect(assetButton).toBeVisible()
    await closeUploadQueueIfOpen(page)
    await assetButton.click()

    const viewer = page.getByRole('dialog', { name: `Viewer: ${filename}` })
    await expect(viewer).toBeVisible()
    await viewer.getByRole('button', { name: 'Replace file' }).click()

    const replaceDialog = page.getByRole('dialog', { name: 'Replace file' })
    await expect(replaceDialog).toBeVisible()
    await replaceDialog
      .locator('input[type="file"]')
      .setInputFiles({ name: replacementFilename, mimeType: 'image/png', buffer: PNG_1X1 })
    await expect(replaceDialog.getByRole('status')).toContainText(replacementFilename)
    await Promise.all([
      waitForMediaReplace(page),
      replaceDialog.getByRole('button', { name: 'Replace file' }).click(),
    ])
    await expect(replaceDialog).toBeHidden()
    const replacedViewer = page.getByRole('dialog', { name: `Viewer: ${replacementFilename}` })
    await expect(replacedViewer).toContainText('Replaced')

    await replacedViewer.getByRole('button', { name: `Close ${replacementFilename} panel` }).click()
    await expect(replacedViewer).toBeHidden()

    await deleteVisibleAsset(page, replacementFilename)
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toHaveCount(0)

    await page.getByTestId('media-folder-row-trash').click()
    const trashedAsset = page.getByRole('button', { name: `Open ${replacementFilename}` })
    await expect(trashedAsset).toBeVisible()
    await openAssetMenu(trashedAsset, page)
    await Promise.all([
      waitForMediaRestore(page),
      page.getByRole('menu', { name: 'Media item options' }).getByRole('menuitem', { name: 'Restore' }).click(),
    ])
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toHaveCount(0)

    await page.getByTestId('media-folder-row-all-files').click()
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toBeVisible()
    await deleteVisibleAsset(page, replacementFilename)

    await page.getByTestId('media-folder-row-trash').click()
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toBeVisible()
    await openAssetMenu(page.getByRole('button', { name: `Open ${replacementFilename}` }), page)
    await Promise.all([
      waitForMediaDelete(page),
      page.getByRole('menu', { name: 'Media item options' }).getByRole('menuitem', { name: 'Delete' }).click(),
    ])
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toHaveCount(0)
    await expect(page.getByText('Trash is empty')).toBeVisible()
  })

  test('keeps replace and trash restore usable at mobile width (MEDIA-005)', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const suffix = Date.now().toString(36)
    const filename = `mobile-lifecycle-${suffix}.png`
    const replacementFilename = `mobile-replacement-${suffix}.png`

    await page.addInitScript(() => {
      localStorage.removeItem('instatic-editor-layout-v2')
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: filename,
      mimeType: 'image/png',
      buffer: PNG_1X1,
    })

    const assetButton = page.getByRole('button', { name: `Open ${filename}` })
    await expect(assetButton).toBeVisible()
    await closeUploadQueueIfOpen(page)
    await assetButton.click()

    const viewer = page.getByRole('dialog', { name: `Viewer: ${filename}` })
    await expect(viewer).toBeVisible()
    await expectMobileViewerContained(page, viewer)
    await viewer.getByRole('button', { name: 'Replace file' }).click()

    const replaceDialog = page.getByRole('dialog', { name: 'Replace file' })
    await expect(replaceDialog).toBeVisible()
    await expectMobileDialogContained(page, replaceDialog)
    await expect(replaceDialog.getByRole('button', { name: 'Choose replacement file' })).toBeVisible()
    await replaceDialog
      .locator('input[type="file"]')
      .setInputFiles({ name: replacementFilename, mimeType: 'image/png', buffer: PNG_1X1 })
    await expect(replaceDialog.getByRole('status')).toContainText(replacementFilename)
    await expectMobileDialogContained(page, replaceDialog)
    await Promise.all([
      waitForMediaReplace(page),
      replaceDialog.getByRole('button', { name: 'Replace file' }).click(),
    ])
    await expect(replaceDialog).toBeHidden()

    const replacedViewer = page.getByRole('dialog', { name: `Viewer: ${replacementFilename}` })
    await expect(replacedViewer).toBeVisible()
    await expect(replacedViewer).toContainText('Replaced')
    await expectMobileViewerContained(page, replacedViewer)
    await replacedViewer.getByRole('button', { name: `Close ${replacementFilename} panel` }).click()
    await expect(replacedViewer).toBeHidden()

    const replacedAsset = page.getByRole('button', { name: `Open ${replacementFilename}` })
    await expect(replacedAsset).toBeVisible()
    await openAssetKeyboardMenu(replacedAsset, page)
    await Promise.all([
      waitForMediaDelete(page),
      page.getByRole('menu', { name: 'Media item options' }).getByRole('menuitem', { name: 'Delete' }).click(),
    ])
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toHaveCount(0)

    await page.getByTestId('media-folder-row-trash').click()
    const trashedAsset = page.getByRole('button', { name: `Open ${replacementFilename}` })
    await expect(trashedAsset).toBeVisible()
    await openAssetKeyboardMenu(trashedAsset, page)
    await Promise.all([
      waitForMediaRestore(page),
      page.getByRole('menu', { name: 'Media item options' }).getByRole('menuitem', { name: 'Restore' }).click(),
    ])
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toHaveCount(0)

    await page.getByTestId('media-folder-row-all-files').click()
    await expect(page.getByRole('button', { name: `Open ${replacementFilename}` })).toBeVisible()
    await expectMobilePageContained(page)
  })

  test('shows built-in storage configuration on a clean install (MEDIA-006)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('instatic-editor-layout-v2')
    })
    await login(page)
    await page.goto('/admin/media')

    await Promise.all([
      waitForMediaStorageState(page),
      page.getByRole('button', { name: 'Open Storage panel' }).click(),
    ])

    const panel = page.getByTestId('media-storage-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Backend per role' })).toBeVisible()

    for (const roleLabel of ['Originals', 'Variants', 'Avatars', 'Fonts', 'Plugin assets']) {
      await expect(
        panel.getByRole('combobox', { name: `Storage adapter for ${roleLabel}` }),
      ).toHaveValue('Local disk (built-in)')
    }

    await expect(
      panel.getByRole('combobox', { name: 'Variant delegate' }),
    ).toHaveValue('Local sharp ladder (built-in)')
    await expect(panel.getByText('No variant delegate plugins installed yet.')).toBeVisible()
    await expect(panel.getByText(/No external storage adapters installed/)).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Test connection' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /Migrate/ })).toHaveCount(0)
  })

  test('keeps the built-in storage panel usable at mobile width (MEDIA-006)', async ({
    page,
  }) => {
    test.setTimeout(60_000)

    await page.addInitScript(() => {
      localStorage.removeItem('instatic-editor-layout-v2')
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await page.goto('/admin/media')

    await Promise.all([
      waitForMediaStorageState(page),
      page.getByRole('button', { name: 'Open Storage panel' }).click(),
    ])

    const panel = page.getByTestId('media-storage-panel')
    await expect(panel).toBeVisible()
    await expectMobileElementContained(page, panel, 'Media storage panel')
    await expect(panel.getByRole('heading', { name: 'Backend per role' })).toBeVisible()

    for (const roleLabel of ['Originals', 'Variants', 'Avatars', 'Fonts', 'Plugin assets']) {
      const roleSelect = panel.getByRole('combobox', { name: `Storage adapter for ${roleLabel}` })
      await expect(roleSelect).toBeVisible()
      await expect(roleSelect).toHaveValue('Local disk (built-in)')
    }

    const delegateSelect = panel.getByRole('combobox', { name: 'Variant delegate' })
    await delegateSelect.scrollIntoViewIfNeeded()
    await expect(delegateSelect).toBeVisible()
    await expect(delegateSelect).toHaveValue('Local sharp ladder (built-in)')
    await expect(panel.getByText('No variant delegate plugins installed yet.')).toBeVisible()

    const emptyAdapterState = panel.getByText(/No external storage adapters installed/)
    await emptyAdapterState.scrollIntoViewIfNeeded()
    await expect(emptyAdapterState).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Test connection' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /Migrate/ })).toHaveCount(0)
    await expectMobilePageContained(page)

    await page.getByTestId('panel-close-media-storage').click()
    await expect(page.getByRole('button', { name: 'Open Storage panel' })).toBeVisible()
    await expectMobilePageContained(page)
  })

  test('sanitizes SVG uploads before serving them publicly (MEDIA-007)', async ({
    page,
  }) => {
    const filename = `unsafe-svg-${Date.now().toString(36)}.svg`

    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: filename,
      mimeType: 'image/svg+xml',
      buffer: UNSAFE_SVG,
    })

    const assetButton = page.getByRole('button', { name: `Open ${filename}` })
    await expect(assetButton).toBeVisible()

    const previewSrc = await assetButton.locator('img').first().getAttribute('src')
    expect(previewSrc).toBeTruthy()

    const response = await page.request.get(new URL(previewSrc!, page.url()).href)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('image/svg+xml')
    const servedSvg = await response.text()

    expect(servedSvg).toContain('<rect')
    expect(servedSvg).not.toMatch(/<script\b/i)
    expect(servedSvg).not.toMatch(/<foreignObject\b/i)
    expect(servedSvg).not.toMatch(/\son[a-z0-9_-]+\s*=/i)
    expect(servedSvg).not.toMatch(/javascript:/i)
    expect(servedSvg).not.toMatch(/<style\b/i)
  })
})

async function uploadFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await expect(page.getByRole('button', { name: 'Upload media' })).toBeVisible()
  await page.locator('input[type="file"]').first().setInputFiles(file)
}

type PublicAssetResponse = {
  path: string
  status: number
  contentType: string
}

async function visitPublishedMediaPage(browser: Browser, slug: string): Promise<void> {
  const context = await browser.newContext()
  const visitor = await context.newPage()
  const assetResponses: PublicAssetResponse[] = []
  visitor.on('response', (response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/uploads/')) return
    assetResponses.push({
      path: url.pathname,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    })
  })

  try {
    await visitor.goto(`${PUBLIC_BASE_URL}/${slug}`)
    const publicImage = visitor.locator('img[src*="/uploads/"]').first()
    await expect(publicImage).toBeVisible()
    await expect(publicImage).toHaveJSProperty('complete', true)
    await expect.poll(async () =>
      publicImage.evaluate((image) => image instanceof HTMLImageElement ? image.naturalWidth : 0),
    ).toBeGreaterThan(0)
    await expect.poll(() =>
      assetResponses.some((response) =>
        response.path.startsWith('/uploads/') &&
        response.status === 200 &&
        response.contentType.includes('image/png'),
      ),
    ).toBe(true)
  } finally {
    await context.close()
  }
}

async function fillMediaMetadataField(
  page: Page,
  scope: Locator,
  label: 'Title' | 'Filename' | 'Alt text' | 'Caption',
  value: string,
): Promise<void> {
  const field = scope.getByLabel(label)
  await field.fill(value)
  await Promise.all([
    waitForMediaPatch(page),
    field.blur(),
  ])
}

async function expectMobileViewerContained(page: Page, viewer: Locator): Promise<void> {
  await expectMobilePageContained(page)

  const viewerBox = await viewer.boundingBox()
  if (!viewerBox) throw new Error('Media viewer was visible but had no bounding box')
  expect(viewerBox.x).toBeGreaterThanOrEqual(-1)
  expect(viewerBox.x + viewerBox.width).toBeLessThanOrEqual(391)
  expect(viewerBox.y).toBeGreaterThanOrEqual(-1)
  expect(viewerBox.y + viewerBox.height).toBeLessThanOrEqual(845)
}

async function expectMobileDialogContained(page: Page, dialog: Locator): Promise<void> {
  await expectMobilePageContained(page)

  const dialogBox = await dialog.boundingBox()
  if (!dialogBox) throw new Error('Dialog was visible but had no bounding box')
  expect(dialogBox.x).toBeGreaterThanOrEqual(-1)
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(391)
  expect(dialogBox.y).toBeGreaterThanOrEqual(-1)
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(845)
}

async function expectMobileElementContained(
  page: Page,
  locator: Locator,
  description: string,
): Promise<void> {
  await expectMobilePageContained(page)

  const box = await locator.boundingBox()
  if (!box) throw new Error(`${description} was visible but had no bounding box`)
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(391)
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.y + box.height).toBeLessThanOrEqual(845)
}

async function expectMobilePageContained(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      viewportWidth: doc.clientWidth,
      viewportHeight: window.innerHeight,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    }
  })
  expect(metrics.viewportWidth).toBe(390)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.viewportHeight).toBe(844)
}

async function waitForMediaPatch(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'PATCH' &&
    response.url().includes('/admin/api/cms/media/') &&
    response.ok(),
  )
}

async function waitForMediaUpload(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith('/admin/api/cms/media') &&
    response.ok(),
  )
}

async function deleteVisibleAsset(page: Page, filename: string): Promise<void> {
  await openAssetMenu(page.getByRole('button', { name: `Open ${filename}` }), page)
  await Promise.all([
    waitForMediaDelete(page),
    page.getByRole('menu', { name: 'Media item options' }).getByRole('menuitem', { name: 'Delete' }).click(),
  ])
}

async function openAssetMenu(asset: Locator, page: Page): Promise<void> {
  await asset.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Media item options' })).toBeVisible()
}

async function openAssetKeyboardMenu(asset: Locator, page: Page): Promise<void> {
  await asset.focus()
  await asset.press('Shift+F10')
  await expect(page.getByRole('menu', { name: 'Media item options' })).toBeVisible()
}

async function closeUploadQueueIfOpen(page: Page): Promise<void> {
  const closeUploadQueue = page.getByRole('button', { name: /Close Uploads .* panel/ })
  if (await closeUploadQueue.isVisible()) {
    await closeUploadQueue.click()
  }
}

async function waitForMediaReplace(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().includes('/admin/api/cms/media/') &&
    response.url().endsWith('/replace') &&
    response.ok(),
  )
}

async function waitForMediaRestore(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().includes('/admin/api/cms/media/') &&
    response.url().endsWith('/restore') &&
    response.ok(),
  )
}

async function waitForMediaDelete(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'DELETE' &&
    response.url().includes('/admin/api/cms/media/') &&
    response.ok(),
  )
}

async function waitForMediaStorageState(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'GET' &&
    response.url().endsWith('/admin/api/cms/media/storage') &&
    response.ok(),
  )
}
