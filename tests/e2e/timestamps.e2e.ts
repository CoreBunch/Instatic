import { expect, test } from '@playwright/test'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { ANONYMOUS_STATE, OWNER, loginAs, logout } from './helpers'

/**
 * CONFIG-004 - timestamps stay correct when the CMS runs outside UTC.
 *
 * `scripts/e2e-dev.ts` pins the CMS to `Europe/Prague`. SQLite's
 * `current_timestamp` writes `YYYY-MM-DD HH:MM:SS` with no zone marker, which
 * V8 parses as *local* time, so before the SQLite adapter normalised that
 * shape every SQL-stamped row on such a server read one to two hours in the
 * past: a device that signed in a second ago showed "2 hours ago" under
 * Account → Active devices. Most tables default `created_at` to an ISO
 * `strftime`, so the surfaces that carried the bug are the ones stamped by
 * an explicit `current_timestamp` write, such as `sessions.last_seen_at`.
 *
 * The browser runs in a third zone so a raw string leaking to the client
 * would drift by a different offset and still fail.
 */
const BROWSER_ZONE = 'America/New_York'
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const FRESH_MS = 60_000

const SessionsEnvelope = Type.Object({
  sessions: Type.Array(
    Type.Object({
      isCurrent: Type.Boolean(),
      createdAt: Type.String(),
      lastSeenAt: Type.String(),
    }),
  ),
})

test.use({ timezoneId: BROWSER_ZONE })

test.describe('timestamps on a non-UTC server', () => {
  test('a device that just signed in reads "Just now" and the sessions API is fresh ISO 8601 UTC (CONFIG-004)', async ({
    page,
    browser,
  }) => {
    const second = await browser.newContext({
      storageState: ANONYMOUS_STATE,
      timezoneId: BROWSER_ZONE,
    })
    const secondPage = await second.newPage()
    try {
      await loginAs(secondPage, OWNER.email, OWNER.password)

      await test.step('sessions API returns ISO 8601 UTC stamps from the last minute', async () => {
        const response = await page.request.get('/admin/api/cms/auth/sessions')
        expect(response.ok()).toBe(true)
        const { sessions } = Value.Parse(SessionsEnvelope, await response.json())
        expect(sessions.length).toBeGreaterThanOrEqual(2)
        for (const session of sessions) {
          expect(session.lastSeenAt).toMatch(ISO_UTC)
          expect(session.createdAt).toMatch(ISO_UTC)
        }
        const newest = sessions.reduce((a, b) =>
          Date.parse(a.createdAt) >= Date.parse(b.createdAt) ? a : b,
        )
        expect(newest.isCurrent).toBe(false)
        expect(Math.abs(Date.now() - Date.parse(newest.createdAt))).toBeLessThan(FRESH_MS)
        expect(Math.abs(Date.now() - Date.parse(newest.lastSeenAt))).toBeLessThan(FRESH_MS)
      })

      await test.step('Account → Active devices shows the newest other device as "Just now"', async () => {
        await page.goto('/admin/account')
        await page.getByTestId('account-tab-sessions').click()
        const table = page.getByRole('table', { name: 'Active sessions' })
        await expect(table).toBeVisible()
        // Rows sort by last activity, so the first revocable row is the device
        // that signed in a moment ago. The current device prints "This device".
        const otherDevice = table
          .getByRole('row')
          .filter({ has: page.getByRole('button', { name: 'Sign out' }) })
          .first()
        await expect(otherDevice).toBeVisible()
        await expect(otherDevice.getByRole('cell').nth(2)).toHaveText('Just now')
      })
    } finally {
      // Cleanup must not mask the assertion that failed above.
      await logout(secondPage).catch(() => undefined)
      await second.close()
    }
  })
})
