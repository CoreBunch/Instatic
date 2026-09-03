import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, createPage, login, openSiteEditor, publishDraft } from './helpers'

/**
 * Version history — published versions of the active page listed from the
 * publish menu, and one restored into the draft (VERSION-001).
 *
 * Publishing steps up, which rotates the session token, so this spec runs
 * on its own fresh login instead of the shared owner state. It publishes a
 * page of its own, so the history it asserts on does not depend on what
 * earlier specs published.
 */

test.use({ storageState: ANONYMOUS_STATE })

test('lists published versions of the active page and restores one (VERSION-001)', async ({ page }) => {
  await login(page)
  await openSiteEditor(page)
  await createPage(page, 'Version History Page', `version-history-${Date.now()}`)
  await page.getByRole('treeitem', { name: 'Open page Version History Page' }).click()
  await publishDraft(page)

  await page.getByTestId('toolbar-publish-actions-trigger').click()
  await page.getByTestId('toolbar-version-history-action').click()
  const dialog = page.getByRole('dialog', { name: 'Version history' })
  await expect(dialog).toBeVisible()
  const latest = page.getByTestId('version-row-1')
  await expect(latest).toBeVisible()
  await expect(latest).toContainText('Latest')

  await page.getByTestId('version-restore-1').click()
  await expect(latest).toContainText('Replace the current draft')
  await page.getByTestId('version-restore-confirm-1').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Restored version 1' })).toBeVisible()
})
