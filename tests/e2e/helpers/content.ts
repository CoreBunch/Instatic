import { expect, type Page } from '@playwright/test'

/**
 * Content workspace helpers shared by the content specs and by the branch
 * specs that write an entry on a branch.
 */

/** The sidebar row of the entry with this title. */
export function entryRow(page: Page, title: string) {
  return page.getByRole('button').filter({ hasText: title })
}

/** Click "New post" and wait for the editor to select the new row. */
export async function startNewPost(page: Page): Promise<void> {
  const previousRow = new URL(page.url()).searchParams.get('row')
  const newPost = page.getByRole('button', { name: 'New post', exact: true })
  await expect(newPost).toBeEnabled()
  await newPost.click()
  await page.waitForURL((url) => {
    const nextRow = url.searchParams.get('row')
    return nextRow !== null && nextRow !== previousRow
  })
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('')
}

/** Save the selected draft from the publishing menu and wait for its row to show the title. */
export async function saveSelectedDraft(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'More publishing actions' }).click()
  const saveResponse = page.waitForResponse((response) =>
    /\/admin\/api\/cms\/data\/rows\/[^/]+$/.test(new URL(response.url()).pathname) &&
    response.request().method() === 'PATCH',
  )
  await page.getByTestId('toolbar-content-save-draft-action').click()
  expect((await saveResponse).ok()).toBe(true)
  // The new title replaces the "Untitled draft" placeholder once saved.
  await expect(entryRow(page, title)).toBeVisible({ timeout: 20_000 })
}
