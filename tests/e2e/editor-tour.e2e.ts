import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  clearEditorTourPreference,
  expectEditorReady,
  getEditorTourPreferenceStatus,
  seedEditorTourPreference,
  type EditorTourOutcome,
} from './helpers'

/**
 * TOUR-001 through TOUR-004 — the Site editor's first-run guided tour.
 *
 * A fresh user (no `editor-tour` preference set) auto-starts the tour on
 * opening `/admin/site`; stepping through all seven steps or skipping early
 * both persist an outcome via `PUT /admin/api/cms/me/preferences/editor-tour`
 * so the tour never reappears on reload; and it can be replayed anytime from
 * the command palette regardless of that persisted outcome.
 *
 * Every test starts by explicitly seeding or clearing the shared owner's
 * `editor-tour` preference (rather than relying on ambient state) because the
 * suite otherwise keeps this identity permanently past the tour — see
 * `helpers/preferences.ts` and `account-persona.setup.ts`.
 */
const OPEN_PALETTE_KEY = process.platform === 'darwin' ? 'Meta+k' : 'Control+k'

test.describe('editor tour', () => {
  test('auto-starts for a first-run user and completes after all seven steps (TOUR-001)', async ({
    page,
  }) => {
    await clearEditorTourPreference(page)

    await test.step('opening the Site editor auto-starts the tour at step 1', async () => {
      await page.goto('/admin/site')
      await expect(tourDialog(page)).toBeVisible({ timeout: 20_000 })
      await expect(tourDialog(page)).toContainText('Welcome to the site editor')
      await expect(tourDialog(page)).toContainText('Step 1 of 7')
      await expect(tourDialog(page).getByRole('button', { name: 'Skip tour' })).toBeVisible()
      await expect(tourDialog(page).getByRole('button', { name: 'Next' })).toBeVisible()
      await expect(tourDialog(page).getByRole('button', { name: 'Back' })).toHaveCount(0)
    })

    await test.step('stepping through all seven steps finishes and persists "completed"', async () => {
      for (let step = 1; step <= 7; step++) {
        await expect(tourDialog(page)).toContainText(`Step ${step} of 7`)
        const isLastStep = step === 7
        const button = tourDialog(page).getByRole('button', {
          name: isLastStep ? 'Finish' : 'Next',
        })
        if (isLastStep) {
          const saved = waitForTourPreferenceSave(page, 'completed')
          await button.click()
          await saved
        } else {
          await button.click()
        }
      }
      await expect(tourDialog(page)).toBeHidden()
    })

    await test.step('reloading shows the canvas with no tour', async () => {
      await page.reload()
      await expectEditorReady(page)
      await expect(tourDialog(page)).toHaveCount(0)
    })
  })

  test('skipping persists "dismissed" and does not auto-start again (TOUR-002)', async ({
    page,
  }) => {
    await clearEditorTourPreference(page)

    await page.goto('/admin/site')
    await expect(tourDialog(page)).toBeVisible({ timeout: 20_000 })

    const saved = waitForTourPreferenceSave(page, 'dismissed')
    await tourDialog(page).getByRole('button', { name: 'Skip tour' }).click()
    await saved
    await expect(tourDialog(page)).toBeHidden()
    expect(await getEditorTourPreferenceStatus(page)).toBe('dismissed')

    await page.reload()
    await expectEditorReady(page)
    await expect(tourDialog(page)).toHaveCount(0)
  })

  test('replays from the command palette regardless of a persisted outcome (TOUR-003)', async ({
    page,
  }) => {
    // A completed (non-null) preference proves the palette command starts
    // the tour on its own — it isn't just observing an auto-start.
    await seedEditorTourPreference(page, 'completed')

    await page.goto('/admin/dashboard')
    await openCommandPalette(page)
    await commandPaletteInput(page).fill('tour')
    await page.getByRole('option', { name: 'Take the editor tour' }).click()

    // The palette queues a pending action and navigates cross-workspace —
    // SitePage starts the tour once the editor store hydrates.
    await expect(page).toHaveURL(/\/admin\/site$/)
    await expect(tourDialog(page)).toBeVisible({ timeout: 20_000 })
    await expect(tourDialog(page)).toContainText('Step 1 of 7')

    // Leave the session tour-free again for whichever spec runs next.
    const saved = waitForTourPreferenceSave(page, 'dismissed')
    await tourDialog(page).getByRole('button', { name: 'Skip tour' }).click()
    await saved
  })
})

/** The tour's coach-mark bubble — a `role="dialog"` carrying "Step N of 7". */
function tourDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: /Step \d+ of 7/ })
}

function commandPalette(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Command palette' })
}

function commandPaletteInput(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Search commands' })
}

async function openCommandPalette(page: Page): Promise<void> {
  await expect(page.getByTestId('account-menu-trigger')).toBeVisible()
  const dialog = commandPalette(page)
  await expect(async () => {
    await page.keyboard.press(OPEN_PALETTE_KEY)
    await expect(dialog).toBeVisible({ timeout: 1_000 })
  }).toPass()
}

/**
 * Waits for the `editor-tour` preference PUT that fires when the tour ends
 * (`persistOutcome` in `useEditorTour.ts`), and asserts it saved the expected
 * outcome. Started before the UI action that triggers it.
 */
function waitForTourPreferenceSave(page: Page, outcome: EditorTourOutcome): Promise<void> {
  return page
    .waitForResponse(
      (response) =>
        response.url().includes('/admin/api/cms/me/preferences/editor-tour') &&
        response.request().method() === 'PUT' &&
        response.status() === 200,
    )
    .then(async (response) => {
      const body = (await response.json()) as { value: { status: EditorTourOutcome } }
      expect(body.value.status).toBe(outcome)
    })
}
