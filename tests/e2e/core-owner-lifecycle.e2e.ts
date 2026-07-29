import { expect, test } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  expectEditorReady,
  insertNotchModule,
  login,
  logout,
  openSiteEditor,
  publishDraft,
  selectTreeLayer,
  setPropValue,
  visitPublicPage,
} from './helpers'

const PUBLISHED_TEXT = 'Automated E2E public headline'
const DRAFT_ONLY_TEXT = 'Automated E2E draft only headline'

/**
 * Flagship owner journey. Covers SETUP-001 (via the `setup` project),
 * AUTH-001, EDIT-001, SAVE-001, PUB-001, PUB-002, PUB-003, and the publish
 * step-up (part of CAP-003).
 *
 * Runs in a fresh anonymous context (not the shared owner `storageState`) so its
 * sign-out step invalidates only its own session, leaving the setup session — and
 * every other spec — unaffected. It is the only spec that edits the homepage; all
 * other specs work on their own pages, keeping this journey deterministic.
 */
test.describe('core owner lifecycle', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('logs in, edits, publishes, and keeps later drafts private', async ({
    page,
    browser,
  }) => {
    await test.step('log in as the owner', async () => {
      await login(page)
      await openSiteEditor(page)
    })

    await test.step('log out and log back in (AUTH-001)', async () => {
      await logout(page)
      await login(page)
      await openSiteEditor(page)
    })

    await test.step('add editable homepage text (EDIT-001)', async () => {
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', PUBLISHED_TEXT)
      await expect(canvasFrame(page).getByText(PUBLISHED_TEXT)).toBeVisible()
    })

    await test.step('reload and confirm draft persistence (SAVE-001)', async () => {
      await page.reload()
      await expectEditorReady(page)
      await expect(canvasFrame(page).getByText(PUBLISHED_TEXT)).toBeVisible()
    })

    await test.step('publish and verify the visitor page (PUB-001, PUB-002)', async () => {
      await publishDraft(page)
      await visitPublicPage(browser, {
        visibleText: PUBLISHED_TEXT,
        hiddenText: DRAFT_ONLY_TEXT,
      })
    })

    await test.step('edit the draft without publishing (PUB-003)', async () => {
      await selectTreeLayer(page, 'Text')
      await setPropValue(page, 'text', DRAFT_ONLY_TEXT)
      await expect(canvasFrame(page).getByText(DRAFT_ONLY_TEXT)).toBeVisible()

      // The unpublished edit must not leak: the public page still shows the
      // last published headline, not the new draft-only text.
      await visitPublicPage(browser, {
        visibleText: PUBLISHED_TEXT,
        hiddenText: DRAFT_ONLY_TEXT,
      })
    })
  })
})
