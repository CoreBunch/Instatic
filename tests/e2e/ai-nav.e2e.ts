import { expect, test } from '@playwright/test'

/**
 * ADMIN-010 — the AI workspace is reachable from the admin section navigation.
 *
 * `/admin/ai` has always routed to `AiPage` and `access.ts` even returns it as a
 * landing route, but the section nav rendered no entry for it, so the workspace
 * was reachable only by typing the URL. Owners hold `ai.providers.manage`, so
 * the gated item must render for them and route on click.
 */
test('AI section nav entry routes to the AI workspace (ADMIN-010)', async ({ page }) => {
  await page.goto('/admin/dashboard')

  const aiLink = page.getByRole('link', { name: 'AI', exact: true })
  await expect(aiLink).toBeVisible({ timeout: 20_000 })
  await expect(aiLink).toHaveAttribute('href', '/admin/ai')

  await aiLink.click()
  await page.waitForURL(/\/admin\/ai/)
  await expect(page).toHaveURL(/\/admin\/ai/)
})
