import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login } from './helpers'

/**
 * SITEPLUGIN-001 — the Plugin IDE end to end: scaffold a site plugin from the
 * plugins workspace, edit its source in the co-edited buffer, build and
 * activate it through the permission review, and see the activated plugin in
 * the merged list. Then edit again and watch the state fall back to
 * "Draft changed" until the rebuild.
 *
 * Site plugins are authored in the site draft and activated through the same
 * lifecycle as uploaded packages, so this is also the regression guard on the
 * draft → build → activate coupling (docs/features/site-plugins.md).
 */

const PLUGIN_NAME = 'E2E Banner'
const PLUGIN_ID = 'e2e-banner'

test.describe.configure({ mode: 'serial' })

// Activation is step-up gated, and a step-up rotates the shared owner session,
// so every test signs in for itself from an anonymous context (the pattern the
// branch specs use for their step-up flows).
test.use({ storageState: ANONYMOUS_STATE })

test('scaffolds a site plugin and opens it in the IDE (SITEPLUGIN-001)', async ({ page }) => {
  await login(page)
  await page.goto('/admin/plugins')
  await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('new-site-plugin').click()
  await page.locator('#site-plugin-name').fill(PLUGIN_NAME)
  // The id derives from the name; the routes template scaffolds server code
  // that builds without a canvas, which keeps this spec headless-friendly.
  await expect(page.locator('#site-plugin-id')).toHaveValue(PLUGIN_ID)
  await page.getByRole('radio', { name: 'Backend routes' }).click()
  await page.getByTestId('create-site-plugin').click()

  // Creating lands in the full-screen IDE for the new plugin.
  await expect(page).toHaveURL(new RegExp(`/admin/plugins/develop/${PLUGIN_ID}`), { timeout: 20_000 })
  await expect(page.getByTestId('ide-file-tree')).toBeVisible({ timeout: 20_000 })

  // The scaffold is real source, not an empty shell: plugin.json plus the
  // template's server entry, and the buffer opens on the manifest.
  const rows = page.getByTestId('ide-file-row')
  await expect(rows.filter({ hasText: 'plugin.json' })).toHaveCount(1)
  await expect(rows).not.toHaveCount(0)
  await expect(page.getByTestId('ide-code-editor')).toBeVisible()
  await expect(page.getByTestId('ide-code-editor')).toContainText(PLUGIN_NAME)

  // A fresh scaffold has no built artefact yet, so it reads as draft.
  await expect(page.getByTestId('ide-state-chip')).toContainText('Draft changed')
})

test('builds and activates through the permission review (SITEPLUGIN-001)', async ({ page }) => {
  await login(page)
  await page.goto(`/admin/plugins/develop/${PLUGIN_ID}`)
  await expect(page.getByTestId('ide-file-tree')).toBeVisible({ timeout: 20_000 })
  // The draft has to sync before the IDE will write or build.
  await expect(page.getByTestId('ide-primary-action')).toBeEnabled({ timeout: 20_000 })

  await page.getByTestId('ide-primary-action').click()

  // Activation states the permissions the manifest declares; granting them is
  // the explicit consent step, and it is step-up gated.
  const review = page.getByRole('dialog', { name: new RegExp(`Activate ${PLUGIN_NAME}`) })
  await expect(review).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('confirm-site-plugin-grants').click()
  await completeStepUp(page)

  await expect(page.getByTestId('ide-state-chip')).toContainText('Active', { timeout: 40_000 })
  // A clean build reports no diagnostics.
  await expect(page.getByTestId('ide-diagnostics')).not.toContainText(/error/i)

  // The activated site plugin joins the one merged plugin list.
  await page.goto('/admin/plugins')
  await expect(page.getByTestId('plugins-admin-canvas')).toContainText(PLUGIN_NAME, { timeout: 20_000 })
})

test('an edit marks the draft changed until the next build (SITEPLUGIN-001)', async ({ page }) => {
  await login(page)
  await page.goto(`/admin/plugins/develop/${PLUGIN_ID}`)
  await expect(page.getByTestId('ide-file-tree')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('ide-state-chip')).toContainText('Active', { timeout: 20_000 })

  // Edit the server entry, not the manifest: a comment is valid there, so the
  // state moves for the right reason (a changed draft, not a broken build).
  await page.getByTestId('ide-file-row').filter({ hasText: 'index.ts' }).first().click()
  const editor = page.getByTestId('ide-code-editor').locator('.cm-content')
  await expect(editor).toContainText('Server entrypoint', { timeout: 20_000 })
  // Type into the co-edited buffer; the relay persists it with no save action.
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n// edited by the e2e run\n')

  // The built artefact no longer matches the draft, and the IDE says so
  // rather than silently serving stale code.
  await expect(page.getByTestId('ide-state-chip')).toContainText('Draft changed', { timeout: 30_000 })
})
