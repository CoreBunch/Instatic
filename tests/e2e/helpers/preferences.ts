import { expect, type Page } from '@playwright/test'

/**
 * `editor-tour` user-preference helpers.
 *
 * The Site editor auto-starts its first-run guided tour for any user whose
 * `editor-tour` preference has never been set (`useEditorTour` in
 * `src/admin/pages/site/tour/useEditorTour.ts`). Every shared test identity
 * (the owner, the account-management persona) is used across dozens of specs
 * that open the Site editor expecting a clean canvas — an auto-started tour
 * bubble would block those. The setup projects seed the preference as
 * `'completed'` for those identities (see `account-persona.setup.ts`) so the
 * rest of the suite stays tour-free; `editor-tour.e2e.ts` uses
 * `clearEditorTourPreference` to put the shared owner session back into a
 * genuinely first-run state for its own assertions.
 */

const EDITOR_TOUR_PREFERENCE_PATH = '/admin/api/cms/me/preferences/editor-tour'

export type EditorTourOutcome = 'completed' | 'dismissed'

/** Seed the current session's `editor-tour` preference, bypassing the UI. */
export async function seedEditorTourPreference(
  page: Page,
  status: EditorTourOutcome,
): Promise<void> {
  const response = await page.request.put(EDITOR_TOUR_PREFERENCE_PATH, {
    data: { value: { status } },
  })
  expect(response.ok(), `seed editor-tour preference: ${response.status()}`).toBe(true)
}

/**
 * Reset the current session's `editor-tour` preference to "never set" — the
 * state a genuinely first-run user is in. The Site editor auto-starts the
 * tour only when this preference has never been written.
 */
export async function clearEditorTourPreference(page: Page): Promise<void> {
  const response = await page.request.delete(EDITOR_TOUR_PREFERENCE_PATH)
  expect(response.ok(), `clear editor-tour preference: ${response.status()}`).toBe(true)
}

/** Read the current session's persisted `editor-tour` status, or `null` if never set. */
export async function getEditorTourPreferenceStatus(
  page: Page,
): Promise<EditorTourOutcome | null> {
  const response = await page.request.get(EDITOR_TOUR_PREFERENCE_PATH)
  expect(response.ok(), `get editor-tour preference: ${response.status()}`).toBe(true)
  const body = (await response.json()) as { value: { status: EditorTourOutcome } | null }
  return body.value?.status ?? null
}
