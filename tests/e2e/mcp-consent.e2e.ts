import { expect, test } from '@playwright/test'

test('keeps MCP consent controls visible while permissions scroll (AI-012)', async ({ page, request, baseURL }) => {
  const callback = 'http://127.0.0.1/callback'
  const registration = await request.post('/_instatic/oauth/register', {
    data: { client_name: 'Local test client', redirect_uris: [callback] },
  })
  expect(registration.status()).toBe(201)
  const { client_id } = await registration.json()
  const query = new URLSearchParams({
    client_id,
    response_type: 'code',
    redirect_uri: callback,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'mcp',
    resource: new URL('/_instatic/mcp', baseURL).href,
  })
  for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/admin/ai/oauth/authorize?' + query)
    const footer = page.getByRole('contentinfo', { name: 'Connection authorization' })
    const authorize = footer.getByRole('button', { name: 'Authorize connection' })
    await expect(authorize).toBeInViewport({ ratio: 1 })
    const bottom = () => footer.evaluate(el => el.getBoundingClientRect().bottom)
    expect(await bottom()).toBe(viewport.height)

    await footer.getByRole('button', { name: 'Select all capabilities' }).click()
    await footer.getByRole('button', { name: 'Clear all capabilities' }).click()
    await expect(authorize).toBeDisabled()

    const last = page.getByRole('checkbox').last()
    await last.scrollIntoViewIfNeeded()
    await expect(page.getByRole('heading', { level: 1 })).not.toBeInViewport()
    expect(await bottom()).toBe(viewport.height)
    const box = await last.boundingBox()
    const bar = await footer.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y)
    await last.check()
    await expect(footer).toContainText(/1 of \d+ selected/)
    await expect(authorize).toBeEnabled()
    await expect(footer.getByRole('button', { name: 'Deny' })).toBeInViewport({ ratio: 1 })
  }
})
