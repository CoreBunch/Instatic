import { expect, test } from '@playwright/test'

/**
 * CONTENT-009 — the sidebar shows the stored title of a freshly created entry
 * even when the entries list load resolves after the create.
 *
 * `createUntitledEntry` stores "Untitled" on the server but hands the editor a
 * copy whose title is blank, so the title field shows its placeholder. The
 * workspace used to merge that editor copy back into the sidebar list whenever
 * an in-flight list load resolved after the create, rendering a nameless row.
 * Which request won was scheduling luck, so this test holds the list response
 * until the create has landed and pins the losing order down.
 */
test('keeps the stored title in the sidebar when the list load resolves after a create (CONTENT-009)', async ({ page }) => {
  let releaseListLoad: () => void = () => {}
  const listLoadHeld = new Promise<void>((resolve) => { releaseListLoad = resolve })
  let heldTheListLoad = false

  await page.route(/\/admin\/api\/cms\/data\/tables\/[^/]+\/rows(\?.*)?$/, async (route) => {
    if (!heldTheListLoad && route.request().method() === 'GET') {
      heldTheListLoad = true
      await listLoadHeld
    }
    await route.continue()
  })

  await page.goto('/admin/content')

  const newPost = page.getByRole('button', { name: 'New post', exact: true })
  await expect(newPost).toBeEnabled()

  const createResponse = page.waitForResponse((response) =>
    /\/admin\/api\/cms\/data\/tables\/[^/]+\/rows$/.test(new URL(response.url()).pathname) &&
    response.request().method() === 'POST',
  )
  await newPost.click()
  const response = await createResponse
  expect(
    response.ok(),
    `entry create returned ${response.status()}: ${await response.text().catch(() => '<no body>')}`,
  ).toBe(true)

  // The create has landed; now let the older list response arrive.
  releaseListLoad()

  // The editor keeps its blank title field; the sidebar must show the stored one.
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: /Untitled/ }).first()).toBeVisible({ timeout: 20_000 })
})
