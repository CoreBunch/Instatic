import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, createPage, login, openSiteEditor, openSitePanel } from './helpers'

/**
 * Site branches — the toolbar switcher, the context strip, publish gating,
 * the manage dialog, and the palette commands (BRANCH-001 … BRANCH-004).
 *
 * Every step also captures evidence under `.tmp/evidence/branches-*.png` so
 * the switcher can be reviewed visually after a run.
 */

const EVIDENCE_DIR = '.tmp/evidence'
const VIEWPORT = { width: 1440, height: 900 }
const TOP_CLIP = { x: 0, y: 0, width: 1440, height: 96 }

async function shot(page: Page, name: string, clip: 'top' | 'full' = 'top'): Promise<void> {
  await page.screenshot({
    path: `${EVIDENCE_DIR}/branches-${name}.png`,
    clip: clip === 'top' ? TOP_CLIP : undefined,
    fullPage: false,
  })
}

test.use({ viewport: VIEWPORT })

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true })
})

test('create a branch from the toolbar, edit on it, and return to main (BRANCH-001)', async ({ page }) => {
  await openSiteEditor(page)
  const chip = page.getByTestId('branch-chip')
  await expect(chip).toBeVisible()
  await expect(page.getByTestId('branch-strip')).toHaveCount(0)
  // Not gated by a branch (main may already be published by an earlier spec).
  await expect(page.getByTestId('toolbar-publish-btn')).not.toHaveAccessibleName(/Cannot publish/)
  await shot(page, '1-main')

  await chip.click()
  const menu = page.getByRole('menu', { name: 'Branches' })
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('branch-row-main')).toBeVisible()
  // The platform pill renders its whole word, tinted, not a clipped dot.
  const livePill = page.getByTestId('branch-row-main').locator('span[data-size]', { hasText: 'Live' })
  await expect(livePill).toHaveText('Live')
  expect((await livePill.boundingBox())?.width ?? 0).toBeGreaterThan(30)
  await shot(page, '2-palette', 'full')

  await page.getByTestId('branch-create-action').click()
  await expect(page.getByTestId('branch-create-form')).toBeVisible()
  await page.getByTestId('branch-create-name').fill('Spring Redesign')
  await expect(page.getByText('Will be created as spring-redesign')).toBeVisible()
  await shot(page, '3-creator', 'full')

  await page.getByTestId('branch-create-submit').click()
  const strip = page.getByTestId('branch-strip')
  await expect(strip).toBeVisible()
  await expect(strip).toContainText('Spring Redesign')
  // The chip stays icon-only: the strip right above it already names the branch.
  await expect(chip).not.toContainText('Spring Redesign')
  await expect(strip).toContainText('from main')
  // Publishing only exists on main — disabled with the reason inline.
  await expect(page.getByTestId('toolbar-publish-btn')).toBeDisabled()
  // No neutral "On <branch>" status: the strip already names the branch.
  await expect(page.getByText('On Spring Redesign')).toHaveCount(0)
  await expect(page.getByText('A change was reverted')).toHaveCount(0)
  await page.waitForTimeout(600)
  await shot(page, '4-on-branch')

  // The branch survives a reload of this tab.
  await page.reload()
  await openSiteEditor(page)
  await expect(page.getByTestId('branch-strip')).toContainText('Spring Redesign')

  // Back to main from the strip.
  await page.getByTestId('branch-strip-more').click()
  await page.getByTestId('branch-strip-switch-main').click()
  await expect(page.getByTestId('branch-strip')).toHaveCount(0)
  // Not gated by a branch (main may already be published by an earlier spec).
  await expect(page.getByTestId('toolbar-publish-btn')).not.toHaveAccessibleName(/Cannot publish/)
})

test('search switches, the palette command opens the switcher, and main is offered back (BRANCH-002)', async ({ page }) => {
  await openSiteEditor(page)
  await page.getByTestId('branch-chip').click()
  await page.getByRole('combobox').fill('spring')
  await expect(page.getByTestId('branch-row-spring-redesign')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('branch-strip')).toContainText('Spring Redesign')

  await page.keyboard.press('Meta+k')
  const spotlight = page.getByRole('dialog', { name: /command/i }).or(page.getByTestId('spotlight'))
  await expect(spotlight.first()).toBeVisible()
  await page.keyboard.type('switch to main')
  await page.getByRole('option', { name: 'Switch to main', exact: true }).click()
  await expect(page.getByTestId('branch-strip')).toHaveCount(0)
})

// Deleting a branch steps up, and step-up rotates the session token — so
// these two run on their own fresh login instead of the shared owner state.
test.describe('step-up flows', () => {
  test.use({ storageState: ANONYMOUS_STATE })

test('rename and delete through the manage dialog (BRANCH-003)', async ({ page }) => {
  await login(page)
  await openSiteEditor(page)
  await page.getByTestId('branch-chip').click()
  await page.getByTestId('branch-manage-action').click()
  const dialog = page.getByRole('dialog', { name: 'Branches' })
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('branch-manage-row-spring-redesign')).toBeVisible()
  await shot(page, '5-manage', 'full')

  // Search narrows the list; clearing it brings every branch back.
  await page.getByTestId('branch-manage-search').fill('spring')
  await expect(page.getByTestId('branch-manage-row-main')).toHaveCount(0)
  await expect(page.getByTestId('branch-manage-row-spring-redesign')).toBeVisible()
  await page.getByTestId('branch-manage-search').fill('')
  await expect(page.getByTestId('branch-manage-row-main')).toBeVisible()

  await page.getByTestId('branch-manage-rename-spring-redesign').click()
  await page.getByTestId('branch-manage-rename-input').fill('Spring 2027')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('branch-manage-row-spring-redesign')).toContainText('Spring 2027')

  await page.getByTestId('branch-manage-delete-spring-redesign').click()
  await page.getByTestId('branch-delete-confirm').click()
  await completeStepUp(page)
  await expect(page.getByTestId('branch-manage-row-spring-redesign')).toHaveCount(0)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('branch-strip')).toHaveCount(0)
})

test('share a preview link and open it as a visitor (BRANCH-004)', async ({ page, context }) => {
  await login(page)
  await openSiteEditor(page)
  await page.getByTestId('branch-chip').click()
  await page.getByTestId('branch-create-action').click()
  await page.getByTestId('branch-create-name').fill('Preview Link')
  await page.getByTestId('branch-create-submit').click()
  await expect(page.getByTestId('branch-strip')).toBeVisible()

  const issued = page.waitForResponse((res) => res.url().includes('/preview') && res.request().method() === 'POST')
  await page.getByTestId('branch-strip-share').click()
  const { url } = (await (await issued).json()) as { url: string }
  expect(url).toContain('/_instatic/preview/')
  await expect(page.getByTestId('branch-strip-preview-active')).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '6-preview-shared')

  // A visitor with the link, no admin session.
  const visitor = await context.browser()!.newContext({ viewport: VIEWPORT })
  const visitorPage = await visitor.newPage()
  await visitorPage.goto(url)
  await expect(visitorPage.getByRole('status')).toContainText('Previewing branch Preview Link')
  await visitorPage.screenshot({ path: `${EVIDENCE_DIR}/branches-7-visitor-preview.png`, fullPage: false })
  await visitorPage.getByRole('link', { name: 'Exit preview' }).click()
  await expect(visitorPage.getByRole('status')).toHaveCount(0)
  await visitor.close()

  // Revoke from the strip; the link is dead afterwards.
  await page.getByTestId('branch-strip-more').click()
  await page.getByTestId('branch-strip-revoke').click()
  await expect(page.getByTestId('branch-strip-preview-active')).toHaveCount(0)
  const visitorAfter = await context.browser()!.newContext({ viewport: VIEWPORT })
  const deadPage = await visitorAfter.newPage()
  await deadPage.goto(url)
  await expect(deadPage.getByRole('status')).toHaveCount(0)
  await visitorAfter.close()

  // Clean up so the manage test's expectations hold on reruns.
  await page.getByTestId('branch-strip-more').click()
  await page.getByTestId('branch-strip-delete').click()
  await page.getByTestId('branch-delete-confirm').click()
  await completeStepUp(page)
  await expect(page.getByTestId('branch-strip')).toHaveCount(0)
})

test('merge a branch into main from the review page (BRANCH-005)', async ({ page }) => {
  await login(page)
  await openSiteEditor(page)
  await page.getByTestId('branch-chip').click()
  await page.getByTestId('branch-create-action').click()
  await page.getByTestId('branch-create-name').fill('Merge Me')
  await page.getByTestId('branch-create-submit').click()
  await expect(page.getByTestId('branch-strip')).toBeVisible()

  // A page that exists only on the branch.
  await createPage(page, 'Branch Page', 'branch-page')
  // Creating a page inside the bind round trip must not be reset as stale.
  await expect(page.getByText('A change was reverted')).toHaveCount(0)

  await page.getByTestId('branch-strip-merge').click()
  // The review page: one node per change, the decision in the footer.
  await expect(page.getByTestId('branch-review-title')).toHaveText('Merge Merge Me into main')
  await expect(page.getByTestId('branch-review')).toContainText('1 change')
  // A page that exists only on the branch cannot conflict with main.
  await expect(page.getByText(/Both sides changed|Deleted on one side/)).toHaveCount(0)
  await expect(page.getByTestId('branch-review')).toContainText('Branch Page')
  await page.waitForTimeout(400)
  await shot(page, '8-merge-review', 'full')

  // Deleting after the merge is opt-in (a merge that keeps the branch can be undone).
  await page.getByTestId('review-delete-toggle').click()
  await page.getByTestId('review-merge').click()
  // Merging asks first, then steps up.
  await page.getByRole('button', { name: 'Merge into main' }).click()
  await completeStepUp(page)
  await expect(page).toHaveURL(/\/admin\/site/)
  // The branch was deleted after merging, so the tab is back on main …
  await expect(page.getByTestId('branch-strip')).toHaveCount(0)
  // … where the page now exists.
  await openSitePanel(page)
  await expect(page.getByRole('treeitem', { name: 'Open page Branch Page' })).toBeVisible()
})
})
