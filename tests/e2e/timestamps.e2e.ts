import { expect, test, type Page } from '@playwright/test'
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

  test('an entry edited after a newer one was created moves to the top of the list (CONFIG-004)', async ({
    page,
  }) => {
    // `updated_at` is written two ways: the insert default (ISO `strftime`) and
    // every later save. When saves stamped with SQL `current_timestamp`, SQLite
    // stored `YYYY-MM-DD HH:MM:SS`, which sorts *before* the ISO form of a row
    // that was merely created later, so `order by updated_at desc` put the
    // untouched newer entry above the one edited a moment ago.
    const suffix = Date.now().toString(36)
    const title = `Clock check ${suffix}`
    await page.goto('/admin/content')
    const entries = page.getByRole('region', { name: 'Posts' })
    const rows = entries.getByRole('button', { name: /draft|published|scheduled/ })
    await expect(page.getByRole('button', { name: 'New post', exact: true })).toBeEnabled()
    const initialCount = await rows.count()

    const older = await createUntitledPost(page)
    await expect(rows).toHaveCount(initialCount + 1)
    await createUntitledPost(page)
    await expect(rows).toHaveCount(initialCount + 2)

    // Edit the older entry after the newer one exists.
    await page.goto(`/admin/content?row=${older}`)
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    const saved = page.waitForResponse(
      (response) =>
        /\/admin\/api\/cms\/data\/rows\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'PATCH',
    )
    await page.getByRole('button', { name: 'More publishing actions' }).click()
    await page.getByTestId('toolbar-content-save-draft-action').click()
    expect((await saved).ok()).toBe(true)

    await page.reload()
    await expect(rows.first()).toContainText(title)
  })
})

/** Click "New post" and return the new entry's id once the workspace has selected it. */
async function createUntitledPost(page: Page): Promise<string> {
  const previous = new URL(page.url()).searchParams.get('row')
  await page.getByRole('button', { name: 'New post', exact: true }).click()
  await page.waitForURL((url) => {
    const next = url.searchParams.get('row')
    return next !== null && next !== previous
  })
  return new URL(page.url()).searchParams.get('row')!
}
