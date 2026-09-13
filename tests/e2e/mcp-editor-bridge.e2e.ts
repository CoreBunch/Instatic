import { expect, test } from '@playwright/test'

/**
 * AI-010 — the workspace MCP bridge stream stays readable in a real browser.
 *
 * The bridge body is newline-delimited JSON but the response is advertised as
 * `text/event-stream` so reverse proxies flush it incrementally. Unit coverage
 * stubs `fetch`, so only a browser can show that the real client still reads
 * the stream under that media type instead of an intermediary reframing it.
 */
test('opens the workspace bridge stream and keeps it readable (AI-010)', async ({ page }) => {
  const bridgeErrors: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('mcp-workspace-bridge') && msg.type() === 'error') bridgeErrors.push(text)
  })

  const bridgeResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/admin/api/ai/editor-bridge',
  )

  await page.goto('/admin/site')

  const response = await bridgeResponse
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('text/event-stream')
  expect(response.headers()['cache-control']).toBe('no-cache, no-transform')
  expect(response.headers()['x-accel-buffering']).toBe('no')

  // The client must still be holding the stream open, not tearing it down as
  // unreadable. A reframed or buffered body surfaces as a parse/stream error.
  await page.waitForTimeout(3000)
  expect(bridgeErrors).toEqual([])
})
