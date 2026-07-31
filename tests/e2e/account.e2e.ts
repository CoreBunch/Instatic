import { createHmac } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ACCOUNT_PERSONA,
  ANONYMOUS_STATE,
  OWNER,
  completeStepUp as runStepUp,
  expectLoggedIn,
  login as loginOwner,
  loginAs,
  logout,
} from './helpers'

/**
 * Account self-management is deliberately exercised as the dedicated persona.
 * Security actions in this file revoke account-global sessions, so using the
 * owner would invalidate `OWNER_STATE_FILE` and log later specs out.
 */
async function login(page: Page): Promise<void> {
  await loginAs(page, ACCOUNT_PERSONA.email, ACCOUNT_PERSONA.password)
}

async function completeStepUp(
  page: Page,
  password: string = ACCOUNT_PERSONA.password,
): Promise<void> {
  await runStepUp(page, password)
}

/** A minimal but valid 1×1 PNG for the avatar upload. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const TEXT_AVATAR = Buffer.from('not an image', 'utf8')
const OVERSIZED_AVATAR = Buffer.alloc(5 * 1024 * 1024 + 1)

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL ?? 'http://127.0.0.1:5174'

function decodeBase32(secret: string): Buffer {
  let bits = ''
  for (const char of secret.replace(/=+$/g, '').toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value < 0) throw new Error(`Invalid base32 character ${char}`)
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

function totpCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000)
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const value = (
    ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  ) % 1_000_000
  return value.toString().padStart(6, '0')
}

async function completeStepUpWithMfa(page: Page, secret: string): Promise<void> {
  const dialog = page.getByTestId('step-up-dialog')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('step-up-password').fill(ACCOUNT_PERSONA.password)
  await page.getByTestId('step-up-mfa-code').fill(totpCode(secret))
  await page.getByTestId('step-up-confirm').click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

async function completeStepUpWithMfaIfOpened(page: Page, secret: string): Promise<void> {
  const dialog = page.getByTestId('step-up-dialog')
  const opened = await dialog
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true, () => false)
  if (!opened) return
  await page.getByTestId('step-up-password').fill(ACCOUNT_PERSONA.password)
  await page.getByTestId('step-up-mfa-code').fill(totpCode(secret))
  await page.getByTestId('step-up-confirm').click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

async function expectRecoveryCodesDialog(page: Page): Promise<string[]> {
  const dialog = page.getByRole('dialog', { name: 'Recovery codes' })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog.getByText('Save these recovery codes now')).toBeVisible()
  const codes = dialog.locator('code')
  await expect(codes).toHaveCount(10)
  const recoveryCodes = (await codes.allTextContents()).map((code) => code.trim())
  const firstCode = recoveryCodes[0]
  expect(firstCode).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}$/)
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  return recoveryCodes
}

async function enableMfaFromSecurityTab(
  page: Page,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  await page.getByTestId('security-mfa-enable').click()
  await completeStepUp(page)

  const setupDialog = page.getByRole('dialog', {
    name: 'Enable two-factor authentication',
  })
  await expect(setupDialog).toBeVisible({ timeout: 20_000 })
  const secret = (await setupDialog.getByTestId('security-mfa-secret').textContent())?.trim()
  if (!secret) throw new Error('MFA setup secret was not rendered')
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/)

  await setupDialog.getByTestId('security-mfa-code').fill(totpCode(secret))
  await setupDialog.getByTestId('security-mfa-submit').click()
  await expect(setupDialog).toBeHidden({ timeout: 20_000 })

  return {
    secret,
    recoveryCodes: await expectRecoveryCodesDialog(page),
  }
}

interface AccountActivityUser {
  email: string
  displayName: string
  password: string
  role: string
}

async function createAccountActivityUser(
  page: Page,
  user: AccountActivityUser,
): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  await page.locator('input[name="new-user-email-address"]').fill(user.email)
  await page.locator('input[name="new-user-display-name"]').fill(user.displayName)
  await page.locator('input[name="new-user-initial-password"]').fill(user.password)
  await page.locator('select[name="new-user-role"]').selectOption({ label: user.role })
  await page.locator('button[form="users-page-user-form"]').click()
  await completeStepUp(page, OWNER.password)
  await expect(page.getByText(user.email)).toBeVisible()
}

async function submitLoginAttempt(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
}

async function clearUploadedAvatarIfPresent(page: Page): Promise<void> {
  if (!(await page.getByTestId('profile-avatar-remove').isVisible())) return
  await page.getByTestId('profile-avatar-remove').click()
  await expect(page.getByTestId('profile-status')).toHaveText(/removed/i, {
    timeout: 20_000,
  })
}

/**
 * ADMIN-002 / ACCOUNT-001 / ACCOUNT-002 / ADMIN-003 — change account
 * profile basics and verify the MFA setup flow can be started and cancelled
 * without enabling MFA.
 */
test.describe('account', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test.describe('profile basics', () => {
    test('updates a display name that persists (ADMIN-002 / ACCOUNT-001)', async ({ page }) => {
      const displayName = `Account Persona ${Date.now().toString(36)}`

      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-profile').click()

      await page.getByTestId('profile-display-name').fill(displayName)
      await page.getByTestId('profile-save').click()
      await completeStepUp(page)
      await expect(page.getByTestId('profile-status')).toHaveText(/profile saved/i, {
        timeout: 20_000,
      })

      await page.reload()
      await page.getByTestId('account-tab-profile').click()
      await expect(page.getByTestId('profile-display-name')).toHaveValue(displayName)
    })

    test('keeps profile form usable at mobile width and cancels step-up without saving (ADMIN-002 / ACCOUNT-001)', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-profile').click()

      const originalDisplayName = await page.getByTestId('profile-display-name').inputValue()
      const originalEmail = await page.getByTestId('profile-email').inputValue()
      const draftDisplayName = `Account Persona mobile ${Date.now().toString(36)}`

      await page.getByTestId('profile-display-name').fill(draftDisplayName)
      await expect(page.getByTestId('profile-save')).toBeEnabled()
      await expectProfileMobileLayout(page)

      await page.getByTestId('profile-save').click()
      const stepUpDialog = page.getByTestId('step-up-dialog')
      await expect(stepUpDialog).toBeVisible({ timeout: 20_000 })

      await stepUpDialog.getByTestId('step-up-cancel').click()
      await expect(stepUpDialog).toBeHidden()
      await expect(page.getByTestId('profile-status')).toHaveCount(0)
      await expect(page.getByTestId('profile-display-name')).toHaveValue(draftDisplayName)
      await expectProfileMobileLayout(page)

      await page.reload()
      await page.getByTestId('account-tab-profile').click()
      await expect(page.getByTestId('profile-display-name')).toHaveValue(originalDisplayName)
      await expect(page.getByTestId('profile-email')).toHaveValue(originalEmail)
      await expectProfileMobileLayout(page)
    })
  })

  test('uploads a profile picture that persists (ADMIN-002 / ACCOUNT-002)', async ({ page }) => {
    await login(page)
    await page.goto('/admin/account')
    await page.getByTestId('account-tab-profile').click()

    // The file input is hidden behind the upload button; set files on it directly.
    await page
      .getByTestId('profile-avatar-file')
      .setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: PNG_1X1 })
    await expect(page.getByTestId('profile-status')).toHaveText(/updated/i, {
      timeout: 20_000,
    })

    // After reload the avatar is still set — the Remove action is available.
    await page.reload()
    await page.getByTestId('account-tab-profile').click()
    await expect(page.getByTestId('profile-avatar-remove')).toBeVisible()
  })

  test('removes a profile picture that stays removed after reload (ACCOUNT-002)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/account')
    await page.getByTestId('account-tab-profile').click()

    await page
      .getByTestId('profile-avatar-file')
      .setInputFiles({ name: 'avatar-remove.png', mimeType: 'image/png', buffer: PNG_1X1 })
    await expect(page.getByTestId('profile-status')).toHaveText(/updated/i, {
      timeout: 20_000,
    })
    await expect(page.getByTestId('profile-avatar-remove')).toBeVisible()

    await page.getByTestId('profile-avatar-remove').click()
    await expect(page.getByTestId('profile-status')).toHaveText(/removed/i, {
      timeout: 20_000,
    })
    await expect(page.getByTestId('profile-avatar-remove')).toHaveCount(0)
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/upload picture/i)

    await page.reload()
    await page.getByTestId('account-tab-profile').click()
    await expect(page.getByTestId('profile-avatar-remove')).toHaveCount(0)
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/upload picture/i)
  })

  test('rejects an unsupported profile picture with inline feedback (ACCOUNT-002)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/account')
    await page.getByTestId('account-tab-profile').click()

    await clearUploadedAvatarIfPresent(page)

    await page
      .getByTestId('profile-avatar-file')
      .setInputFiles({ name: 'avatar.txt', mimeType: 'text/plain', buffer: TEXT_AVATAR })
    await expect(page.getByRole('alert')).toHaveText(
      /avatars must be a jpeg, png, gif, or webp image/i,
      { timeout: 20_000 },
    )
    await expect(page.getByTestId('profile-avatar-remove')).toHaveCount(0)
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/upload picture/i)
  })

  test('rejects an oversized profile picture with inline feedback (ACCOUNT-002)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/account')
    await page.getByTestId('account-tab-profile').click()

    await clearUploadedAvatarIfPresent(page)

    await page
      .getByTestId('profile-avatar-file')
      .setInputFiles({ name: 'avatar-large.png', mimeType: 'image/png', buffer: OVERSIZED_AVATAR })
    await expect(page.getByRole('alert')).toHaveText(/avatar must be smaller than 5 mb/i, {
      timeout: 20_000,
    })
    await expect(page.getByTestId('profile-avatar-remove')).toHaveCount(0)
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/upload picture/i)
  })

  test('keeps profile picture controls usable at mobile width (ACCOUNT-002)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await page.goto('/admin/account')
    await page.getByTestId('account-tab-profile').click()

    await clearUploadedAvatarIfPresent(page)
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/upload picture/i)
    await expect(page.getByText('JPEG, PNG, GIF, or WebP, 5 MB maximum.')).toBeVisible()
    await expectProfileMobileLayout(page)

    await page
      .getByTestId('profile-avatar-file')
      .setInputFiles({ name: 'avatar-mobile.png', mimeType: 'image/png', buffer: PNG_1X1 })
    await expect(page.getByTestId('profile-status')).toHaveText(/updated/i, {
      timeout: 20_000,
    })
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/change picture/i)
    await expect(page.getByTestId('profile-avatar-remove')).toBeVisible()
    await expectProfileMobileLayout(page)

    await page.getByTestId('profile-avatar-remove').click()
    await expect(page.getByTestId('profile-status')).toHaveText(/removed/i, {
      timeout: 20_000,
    })
    await expect(page.getByTestId('profile-avatar-remove')).toHaveCount(0)
    await expect(page.getByTestId('profile-avatar-upload')).toHaveText(/upload picture/i)
    await expectProfileMobileLayout(page)
  })

  test.describe('security', () => {
    test('starts and cancels MFA setup without enabling MFA (ADMIN-003)', async ({
      page,
    }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      const mfaCard = page.getByTestId('security-mfa-card')
      await expect(mfaCard).toContainText('Off')

      await page.getByTestId('security-mfa-enable').click()
      await completeStepUp(page)

      const setupDialog = page.getByRole('dialog', {
        name: 'Enable two-factor authentication',
      })
      await expect(setupDialog).toBeVisible({ timeout: 20_000 })
      await expect(
        setupDialog.getByAltText('Scan this QR code with your authenticator app'),
      ).toBeVisible({ timeout: 20_000 })
      await expect(setupDialog.getByTestId('security-mfa-secret')).toBeVisible()
      await expect(setupDialog.getByLabel('Authentication code')).toBeVisible()
      await expect(setupDialog.getByTestId('security-mfa-submit')).toBeDisabled()

      await setupDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(setupDialog).toBeHidden()
      await expect(mfaCard).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()

      await page.reload()
      await page.getByTestId('account-tab-security').click()
      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })

    test('updates and persists the step-up policy window (ACCOUNT-005)', async ({
      page,
    }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      const stepUpCard = page.getByTestId('security-step-up-card')
      await expect(stepUpCard).toContainText('On - sensitive actions ask again after 15 minutes.')
      await expect(page.getByTestId('security-step-up-toggle')).toBeChecked()

      await page.getByTestId('security-step-up-window').click()
      await page.getByRole('option', { name: '30 minutes' }).click()
      await completeStepUp(page)
      await expect(page.getByText('Step-up authentication updated to 30 minutes.')).toBeVisible()
      await expect(stepUpCard).toContainText('On - sensitive actions ask again after 30 minutes.')
      await expect(page.getByTestId('security-step-up-window')).toHaveValue('30 minutes')

      await page.reload()
      await page.getByTestId('account-tab-security').click()
      await expect(page.getByTestId('security-step-up-card')).toContainText(
        'On - sensitive actions ask again after 30 minutes.',
      )
      await expect(page.getByTestId('security-step-up-window')).toHaveValue('30 minutes')

      await page.getByTestId('security-step-up-window').click()
      await page.getByRole('option', { name: '15 minutes' }).click()
      await completeStepUp(page)
      await expect(page.getByText('Step-up authentication updated to 15 minutes.')).toBeVisible()
      await expect(page.getByTestId('security-step-up-window')).toHaveValue('15 minutes')
    })

    test('keeps step-up policy controls usable at mobile width (ACCOUNT-005)', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      const stepUpCard = page.getByTestId('security-step-up-card')
      await expect(stepUpCard).toContainText('On - sensitive actions ask again after 15 minutes.')
      await expect(page.getByTestId('security-step-up-toggle')).toBeChecked()
      await expect(page.getByTestId('security-step-up-window')).toHaveValue('15 minutes')
      await expectStepUpPolicyMobileLayout(stepUpCard)

      await page.getByTestId('security-step-up-window').click()
      const menu = page.getByRole('listbox', { name: 'Step-up window' })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('option', { name: '5 minutes', exact: true })).toBeVisible()
      await expect(menu.getByRole('option', { name: '60 minutes', exact: true })).toBeVisible()
      await expectStepUpPolicyMobileLayout(stepUpCard, menu)

      await menu.getByRole('option', { name: '15 minutes', exact: true }).click()
      await expect(menu).toBeHidden()
      await expect(page.getByTestId('step-up-dialog')).toBeHidden()
      await expect(page.getByTestId('security-step-up-window')).toHaveValue('15 minutes')
    })
  })

  test.describe('activity', () => {
    test('shows failed and successful login attempts in sign-in history (AUTH-006)', async ({
      page,
    }) => {
      await page.goto('/admin')
      await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()

      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(`${ACCOUNT_PERSONA.password}-wrong`)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expect(page.getByRole('alert')).toHaveText(/invalid email or password/i)

      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expectLoggedIn(page)

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-activity').click()

      await expect(page.getByRole('heading', { name: 'Sign-in history' })).toBeVisible()
      await expect(page.getByTestId('account-activity-failed-count')).toHaveText(
        /[1-9]\d* failed in last 24h/,
      )

      const activityTable = page.getByRole('table', { name: 'Login activity' })
      await expect(
        activityTable.getByRole('row', { name: 'Activity success' }).first(),
      ).toBeVisible()
      await expect(
        activityTable.getByRole('row', { name: 'Activity bad_password' }).first(),
      ).toBeVisible()
      await expect(activityTable).toContainText('Success')
      await expect(activityTable).toContainText('Wrong password')
    })

    test('shows lockout and rate-limit attempts as suspicious sign-in activity (AUTH-006)', async ({
      page,
      browser,
    }) => {
      await loginOwner(page)
      const suffix = Date.now().toString(36)
      const accountUser = {
        email: `activity-lockout-${suffix}@example.com`,
        displayName: 'Activity Admin',
        password: 'activity-lockout-pass-12345',
        role: 'Admin',
      }

      await createAccountActivityUser(page, accountUser)

      const accountContext = await browser.newContext({ baseURL: ADMIN_BASE_URL })
      const attackerContext = await browser.newContext({ baseURL: ADMIN_BASE_URL })
      try {
        const accountPage = await accountContext.newPage()
        await loginAs(accountPage, accountUser.email, accountUser.password)

        const attackerPage = await attackerContext.newPage()
        await attackerPage.goto('/admin')
        await expect(attackerPage.getByRole('heading', { name: 'Admin Login' })).toBeVisible()

        for (let attempt = 1; attempt <= 4; attempt += 1) {
          await submitLoginAttempt(
            attackerPage,
            accountUser.email,
            `${accountUser.password}-wrong-${attempt}`,
          )
          await expect(attackerPage.getByRole('alert')).toHaveText(/invalid email or password/i)
        }

        await submitLoginAttempt(attackerPage, accountUser.email, `${accountUser.password}-wrong-5`)
        await expect(attackerPage.getByRole('alert')).toHaveText(/account locked/i)

        await submitLoginAttempt(attackerPage, accountUser.email, `${accountUser.password}-wrong-6`)
        await expect(attackerPage.getByRole('alert')).toHaveText(/too many login attempts/i)

        await accountPage.goto('/admin/account')
        await accountPage.getByTestId('account-tab-activity').click()

        await expect(accountPage.getByRole('heading', { name: 'Sign-in history' })).toBeVisible()
        await expect(accountPage.getByTestId('account-activity-suspicious')).toBeVisible()
        await expect(accountPage.getByTestId('account-activity-failed-count')).toHaveText(
          /[6-9]\d* failed in last 24h/,
        )

        const activityTable = accountPage.getByRole('table', { name: 'Login activity' })
        await expect(
          activityTable.getByRole('row', { name: 'Activity success' }).first(),
        ).toBeVisible()
        await expect(
          activityTable.getByRole('row', { name: 'Activity bad_password' }).first(),
        ).toBeVisible()
        await expect(
          activityTable.getByRole('row', { name: 'Activity rate_limited' }).first(),
        ).toBeVisible()
        await expect(activityTable).toContainText('Success')
        await expect(activityTable).toContainText('Wrong password')
        await expect(activityTable).toContainText('Rate-limited')
      } finally {
        await attackerContext.close()
        await accountContext.close()
      }
    })
  })

  test.describe('sessions', () => {
    test('lists active devices and signs out everywhere else (AUTH-004)', async ({
      page,
      browser,
    }) => {
      await login(page)

      const otherContext = await browser.newContext({ baseURL: ADMIN_BASE_URL })
      try {
        const otherPage = await otherContext.newPage()
        await login(otherPage)

        await page.goto('/admin/account')
        await page.getByTestId('account-tab-sessions').click()

        await expect(page.getByRole('heading', { name: 'Active devices' })).toBeVisible()
        const sessionsTable = page.getByRole('table', { name: 'Active sessions' })
        await expect(sessionsTable).toContainText('Current')
        await expect(
          sessionsTable.getByRole('button', { name: 'Sign out' }).first(),
        ).toBeVisible()

        const signOutOthers = page.getByTestId('account-sessions-sign-out-others')
        await expect(signOutOthers).toBeEnabled()
        await signOutOthers.click()
        await completeStepUp(page)

        await expect(page.getByText(/Signed out \d+ other devices?\./)).toBeVisible()
        await expect(signOutOthers).toBeDisabled()
        await expectLoggedIn(page)

        await otherPage.goto('/admin/account')
        await expect(otherPage.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
      } finally {
        await otherContext.close()
      }
    })

    test('keeps active devices usable at mobile width (AUTH-004)', async ({
      page,
      browser,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await login(page)

      const otherContext = await browser.newContext({ baseURL: ADMIN_BASE_URL })
      try {
        const otherPage = await otherContext.newPage()
        await login(otherPage)

        await page.goto('/admin/account')
        await page.getByTestId('account-tab-sessions').click()

        await expect(page.getByRole('heading', { name: 'Active devices' })).toBeVisible()
        const sessionsTable = page.getByRole('table', { name: 'Active sessions' })
        await expect(sessionsTable).toBeVisible()
        await expect(sessionsTable).toContainText('Current')
        await expect(
          sessionsTable.getByRole('button', { name: 'Sign out' }).first(),
        ).toBeVisible()
        await expectContainedHorizontalScroller(sessionsTable)
      } finally {
        await otherContext.close()
      }
    })
  })

  test.describe('mfa lifecycle', () => {
    test('keeps MFA setup dialog usable at mobile width (ACCOUNT-004)', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      const mfaCard = page.getByTestId('security-mfa-card')
      await expect(mfaCard).toContainText('Off')

      await page.getByTestId('security-mfa-enable').click()
      await completeStepUp(page)

      const setupDialog = page.getByRole('dialog', {
        name: 'Enable two-factor authentication',
      })
      await expect(setupDialog).toBeVisible({ timeout: 20_000 })
      await expect(
        setupDialog.getByAltText('Scan this QR code with your authenticator app'),
      ).toBeVisible({ timeout: 20_000 })
      await expect(setupDialog.getByTestId('security-mfa-secret')).toBeVisible()
      await expect(setupDialog.getByTestId('security-mfa-copy-secret')).toBeVisible()
      await expect(setupDialog.getByRole('link', { name: 'Open authenticator app' })).toBeVisible()
      await expect(setupDialog.getByLabel('Authentication code')).toBeVisible()
      await expect(setupDialog.getByTestId('security-mfa-submit')).toBeDisabled()
      await expectMfaSetupDialogMobileLayout(setupDialog)

      await setupDialog.getByTestId('security-mfa-code').fill('123456')
      await expect(setupDialog.getByTestId('security-mfa-submit')).toBeEnabled()
      await expectMfaSetupDialogMobileLayout(setupDialog)

      await setupDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(setupDialog).toBeHidden()
      await expect(mfaCard).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })

    test('shows invalid MFA setup code feedback without enabling MFA (ACCOUNT-004)', async ({
      page,
    }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      const mfaCard = page.getByTestId('security-mfa-card')
      await expect(mfaCard).toContainText('Off')

      await page.getByTestId('security-mfa-enable').click()
      await completeStepUp(page)

      const setupDialog = page.getByRole('dialog', {
        name: 'Enable two-factor authentication',
      })
      await expect(setupDialog).toBeVisible({ timeout: 20_000 })
      const secret = (await setupDialog.getByTestId('security-mfa-secret').textContent())?.trim()
      if (!secret) throw new Error('MFA setup secret was not rendered')

      const wrongCode = totpCode(secret) === '000000' ? '000001' : '000000'
      await setupDialog.getByTestId('security-mfa-code').fill(wrongCode)
      await setupDialog.getByTestId('security-mfa-submit').click()

      await expect(setupDialog.getByRole('alert')).toHaveText('Invalid authentication code', {
        timeout: 20_000,
      })
      await expect(setupDialog).toBeVisible()
      await expect(setupDialog.getByTestId('security-mfa-submit')).toBeEnabled()
      await expect(mfaCard).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()

      await setupDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(setupDialog).toBeHidden()

      await page.reload()
      await page.getByTestId('account-tab-security').click()
      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })

    test('enables MFA, uses it on login, regenerates codes, and disables it (ACCOUNT-004)', async ({
      page,
    }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()

      const { secret } = await enableMfaFromSecurityTab(page)
      await expect(page.getByTestId('security-mfa-card')).toContainText('On')
      await expect(page.getByTestId('security-recovery-card')).toContainText(
        '10 recovery codes remaining',
      )
      await expect(page.getByTestId('security-recovery-regenerate')).toBeEnabled()

      await logout(page)
      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()
      const loginCodeInput = page.getByTestId('admin-mfa-code')
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(loginCodeInput).toBeFocused()
      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()
      const emptyCodeValidity = await loginCodeInput.evaluate((element) => {
        const input = element as HTMLInputElement
        return {
          valueMissing: input.validity.valueMissing,
          validationMessageVisible: input.validationMessage.length > 0,
        }
      })
      expect(emptyCodeValidity).toEqual({
        valueMissing: true,
        validationMessageVisible: true,
      })

      const wrongLoginCode = totpCode(secret) === '000000' ? '000001' : '000000'
      await loginCodeInput.fill(wrongLoginCode)
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toHaveText('Invalid authentication code')
      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()

      await loginCodeInput.fill(totpCode(secret))
      await page.getByRole('button', { name: 'Verify' }).click()
      await expectLoggedIn(page)

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await expect(page.getByTestId('security-mfa-card')).toContainText('On')

      await page.getByTestId('security-recovery-regenerate').click()
      await completeStepUpWithMfa(page, secret)
      await expectRecoveryCodesDialog(page)

      await page.getByTestId('security-mfa-disable').click()
      await completeStepUpWithMfaIfOpened(page, secret)
      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })

    test('requires MFA code for sensitive-action step-up after MFA login (CAP-003)', async ({
      page,
    }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      const { secret } = await enableMfaFromSecurityTab(page)
      await expect(page.getByTestId('security-mfa-card')).toContainText('On')

      await logout(page)
      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()
      await page.getByTestId('admin-mfa-code').fill(totpCode(secret))
      await page.getByRole('button', { name: 'Verify' }).click()
      await expectLoggedIn(page)

      const email = `mfa-stepup-${Date.now().toString(36)}@example.com`
      await page.goto('/admin/users')
      await page.getByRole('button', { name: 'Create User', exact: true }).click()
      await page.locator('input[name="new-user-email-address"]').fill(email)
      await page.locator('input[name="new-user-display-name"]').fill('MFA Step-Up Guard')
      await page.locator('input[name="new-user-initial-password"]').fill('mfa-step-pass-12345')
      await page.locator('select[name="new-user-role"]').selectOption({ label: 'Member' })
      await page.locator('button[form="users-page-user-form"]').click()

      const stepUpDialog = page.getByTestId('step-up-dialog')
      await expect(stepUpDialog).toBeVisible({ timeout: 20_000 })
      await expect(stepUpDialog.getByTestId('step-up-password')).toBeVisible()
      await expect(stepUpDialog.getByTestId('step-up-mfa-code')).toBeVisible()
      await expect(stepUpDialog.getByTestId('step-up-confirm')).toBeDisabled()

      const wrongStepUpCode = totpCode(secret) === '000000' ? '000001' : '000000'
      await page.getByTestId('step-up-password').fill(ACCOUNT_PERSONA.password)
      await page.getByTestId('step-up-mfa-code').fill(wrongStepUpCode)
      await page.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog.getByRole('alert')).toHaveText('Invalid authentication code')
      await expect(page.getByText(email)).toHaveCount(0)

      await page.getByTestId('step-up-mfa-code').fill(totpCode(secret))
      await page.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
      await expect(page.getByText(email)).toBeVisible()

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await page.getByTestId('security-mfa-disable').click()
      await completeStepUpWithMfaIfOpened(page, secret)
      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })

    test('keeps MFA login challenge usable at mobile width (AUTH-002)', async ({ page }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      const { secret } = await enableMfaFromSecurityTab(page)
      await expect(page.getByTestId('security-mfa-card')).toContainText('On')

      await logout(page)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()

      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()
      await expect(page.getByTestId('admin-mfa-code')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible()
      await expectMfaLoginMobileLayout(page)

      const wrongLoginCode = totpCode(secret) === '000000' ? '000001' : '000000'
      await page.getByTestId('admin-mfa-code').fill(wrongLoginCode)
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toHaveText('Invalid authentication code')
      await expectMfaLoginMobileLayout(page)

      await page.getByTestId('admin-mfa-code').fill(totpCode(secret))
      await page.getByRole('button', { name: 'Verify' }).click()
      await expectLoggedIn(page)

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await page.getByTestId('security-mfa-disable').click()
      await completeStepUpWithMfaIfOpened(page, secret)
      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })

    test('uses a recovery code once and rejects reuse on MFA login (AUTH-002)', async ({ page }) => {
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')

      const { secret, recoveryCodes } = await enableMfaFromSecurityTab(page)
      const recoveryCode = recoveryCodes[0]
      if (!recoveryCode) throw new Error('MFA setup did not render a recovery code')

      await logout(page)
      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()
      await page.getByTestId('admin-mfa-code').fill(recoveryCode)
      await page.getByRole('button', { name: 'Verify' }).click()
      await expectLoggedIn(page)

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await expect(page.getByTestId('security-mfa-card')).toContainText('On')
      await expect(page.getByTestId('security-recovery-card')).toContainText(
        '9 recovery codes remaining',
      )

      await logout(page)
      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expect(
        page.getByRole('heading', { name: 'Two-Factor Authentication' }),
      ).toBeVisible()
      await page.getByTestId('admin-mfa-code').fill(recoveryCode)
      await page.getByRole('button', { name: 'Verify' }).click()
      await expect(page.getByRole('alert')).toHaveText('Invalid authentication code')

      await page.getByTestId('admin-mfa-code').fill(totpCode(secret))
      await page.getByRole('button', { name: 'Verify' }).click()
      await expectLoggedIn(page)

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await page.getByTestId('security-mfa-disable').click()
      await completeStepUpWithMfaIfOpened(page, secret)
      await expect(page.getByTestId('security-mfa-card')).toContainText('Off')
      await expect(page.getByTestId('security-recovery-regenerate')).toBeDisabled()
    })
  })

  test.describe('password', () => {
    test('keeps password change usable at mobile width (ACCOUNT-003)', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      const passwordCard = page.getByTestId('security-password-card')
      await expect(passwordCard).toBeVisible()
      await expectPasswordCardMobileLayout(passwordCard)

      await page.getByTestId('security-change-password').click()
      const dialog = page.getByRole('dialog', { name: 'Change password' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByTestId('security-password-new')).toBeVisible()
      await expect(dialog.getByTestId('security-password-confirm')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Save password' })).toBeVisible()

      await dialog.getByTestId('security-password-new').fill('short')
      await dialog.getByTestId('security-password-confirm').fill('short')
      await dialog.getByTestId('security-password-submit').click()
      await expect(dialog.getByRole('alert')).toHaveText(/at least 12 characters/i)

      await dialog.getByTestId('security-password-new').fill('abcdefghijkl')
      await dialog.getByTestId('security-password-confirm').fill('abcdefghijkm')
      await dialog.getByTestId('security-password-submit').click()
      await expect(dialog.getByRole('alert')).toHaveText(/passwords do not match/i)
      await expectPasswordDialogMobileLayout(dialog)

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
    })

    test('changes password, rejects invalid form input, and restores the persona credential (ACCOUNT-003)', async ({
      page,
    }) => {
      const temporaryPassword = `changed-pass-${Date.now().toString(36)}`

      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()

      await page.getByTestId('security-change-password').click()
      const dialog = page.getByRole('dialog', { name: 'Change password' })
      await expect(dialog).toBeVisible()

      await page.getByTestId('security-password-new').fill('short')
      await page.getByTestId('security-password-confirm').fill('short')
      await page.getByTestId('security-password-submit').click()
      await expect(dialog.getByRole('alert')).toHaveText(/at least 12 characters/i)

      await page.getByTestId('security-password-new').fill(temporaryPassword)
      await page.getByTestId('security-password-confirm').fill(`${temporaryPassword}-mismatch`)
      await page.getByTestId('security-password-submit').click()
      await expect(dialog.getByRole('alert')).toHaveText(/passwords do not match/i)

      await page.getByTestId('security-password-confirm').fill(temporaryPassword)
      await page.getByTestId('security-password-submit').click()
      await completeStepUp(page)
      await expect(dialog).toBeHidden({ timeout: 20_000 })
      await expect(page.getByText('Password updated. Other devices were signed out.')).toBeVisible()

      await logout(page)
      await page.getByLabel('Email').fill(ACCOUNT_PERSONA.email)
      await page.getByLabel('Password').fill(ACCOUNT_PERSONA.password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expect(page.getByRole('alert')).toHaveText(/invalid email or password/i)

      await page.getByLabel('Password').fill(temporaryPassword)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await expectLoggedIn(page)

      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await page.getByTestId('security-change-password').click()
      await expect(dialog).toBeVisible()
      await page.getByTestId('security-password-new').fill(ACCOUNT_PERSONA.password)
      await page.getByTestId('security-password-confirm').fill(ACCOUNT_PERSONA.password)
      await page.getByTestId('security-password-submit').click()
      await completeStepUp(page, temporaryPassword)
      await expect(dialog).toBeHidden({ timeout: 20_000 })

      await logout(page)
      await login(page)
      await page.goto('/admin/account')
      await page.getByTestId('account-tab-security').click()
      await expect(page.getByTestId('security-password-card')).toContainText('Last changed:')
    })
  })
})

async function expectContainedHorizontalScroller(table: Locator): Promise<void> {
  const metrics = await table.evaluate((element) => {
    const wrapper = element.parentElement
    const documentElement = document.documentElement
    if (!wrapper) {
      return {
        hasWrapper: false,
        pageOverflow: documentElement.scrollWidth - documentElement.clientWidth,
        wrapperContained: false,
        canScrollTable: false,
        reachesTableEnd: false,
      }
    }

    const initialScrollLeft = wrapper.scrollLeft
    wrapper.scrollLeft = wrapper.scrollWidth
    const maxScrollLeft = wrapper.scrollWidth - wrapper.clientWidth
    const wrapperRect = wrapper.getBoundingClientRect()
    const pageOverflow = documentElement.scrollWidth - documentElement.clientWidth
    const tableRect = element.getBoundingClientRect()
    const reachesTableEnd = Math.ceil(wrapper.scrollLeft + wrapper.clientWidth)
      >= Math.floor(element.scrollWidth)

    wrapper.scrollLeft = initialScrollLeft

    return {
      hasWrapper: true,
      pageOverflow,
      wrapperContained:
        wrapperRect.left >= -1 && wrapperRect.right <= documentElement.clientWidth + 1,
      canScrollTable: maxScrollLeft > 0,
      reachesTableEnd: reachesTableEnd || tableRect.width <= wrapper.clientWidth,
    }
  })

  expect(metrics.hasWrapper).toBe(true)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.wrapperContained).toBe(true)
  expect(metrics.canScrollTable).toBe(true)
  expect(metrics.reachesTableEnd).toBe(true)
}

async function expectProfileMobileLayout(page: Page): Promise<void> {
  const metrics = await page.getByRole('main').evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const profileSection = Array.from(element.querySelectorAll('section')).find((section) =>
      section.querySelector('#account-profile-title')
    )
    const sectionRect = profileSection?.getBoundingClientRect()
    const uploadButton = profileSection?.querySelector('[data-testid="profile-avatar-upload"]')
    const removeButton = profileSection?.querySelector('[data-testid="profile-avatar-remove"]')
    const hint = Array.from(profileSection?.querySelectorAll('p') ?? []).find((paragraph) =>
      paragraph.textContent?.includes('5 MB')
    )
    const displayName = profileSection?.querySelector('[data-testid="profile-display-name"]')
    const email = profileSection?.querySelector('[data-testid="profile-email"]')
    const saveButton = profileSection?.querySelector('[data-testid="profile-save"]')
    const status = profileSection?.querySelector('[data-testid="profile-status"]')
    const requiredControls = [
      uploadButton,
      hint,
      displayName,
      email,
      saveButton,
    ]
    const visibleControls = [
      ...requiredControls,
      removeButton,
      status,
    ].filter((item): item is Element => item !== null && item !== undefined)

    const controlRects = visibleControls.map((item) => item.getBoundingClientRect())

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      sectionPresent: Boolean(sectionRect),
      sectionContained: sectionRect
        ? sectionRect.left >= -1 && sectionRect.right <= viewportWidth + 1
        : false,
      requiredControlsPresent: requiredControls.every(Boolean),
      controlsContained: Boolean(
        sectionRect
        && controlRects.every(
          (rect) => rect.left >= sectionRect.left - 1 && rect.right <= sectionRect.right + 1,
        ),
      ),
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.sectionPresent).toBe(true)
  expect(metrics.sectionContained).toBe(true)
  expect(metrics.requiredControlsPresent).toBe(true)
  expect(metrics.controlsContained).toBe(true)
}

async function expectPasswordCardMobileLayout(card: Locator): Promise<void> {
  const metrics = await card.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const cardRect = element.getBoundingClientRect()
    const actionButton = element.querySelector('button')
    const actionRect = actionButton?.getBoundingClientRect()

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      cardContained: cardRect.left >= -1 && cardRect.right <= viewportWidth + 1,
      actionContained: actionRect
        ? actionRect.left >= cardRect.left - 1 && actionRect.right <= cardRect.right + 1
        : false,
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.cardContained).toBe(true)
  expect(metrics.actionContained).toBe(true)
}

async function expectStepUpPolicyMobileLayout(card: Locator, menu?: Locator): Promise<void> {
  const metrics = await card.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const cardRect = element.getBoundingClientRect()
    const toggle = element.querySelector('[data-testid="security-step-up-toggle"]')
    const select = element.querySelector('[data-testid="security-step-up-window"]')
    const toggleRect = toggle?.getBoundingClientRect()
    const selectRect = select?.getBoundingClientRect()

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      cardContained: cardRect.left >= -1 && cardRect.right <= viewportWidth + 1,
      controlsPresent: Boolean(toggleRect && selectRect),
      controlsContained: Boolean(
        toggleRect
        && selectRect
        && toggleRect.left >= cardRect.left - 1
        && toggleRect.right <= cardRect.right + 1
        && selectRect.left >= cardRect.left - 1
        && selectRect.right <= cardRect.right + 1,
      ),
      controlsStacked: Boolean(
        toggleRect
        && selectRect
        && selectRect.top > toggleRect.bottom
      ),
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.cardContained).toBe(true)
  expect(metrics.controlsPresent).toBe(true)
  expect(metrics.controlsContained).toBe(true)
  expect(metrics.controlsStacked).toBe(true)

  if (!menu) return

  const menuMetrics = await menu.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const menuRect = element.getBoundingClientRect()
    const optionRects = Array.from(element.querySelectorAll('[role="option"]')).map((option) =>
      option.getBoundingClientRect()
    )

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      menuContained:
        menuRect.left >= -1
        && menuRect.right <= viewportWidth + 1
        && menuRect.top >= -1
        && menuRect.bottom <= viewportHeight + 1,
      optionsReachable: optionRects.length === 4 && optionRects.every(
        (rect) => rect.left >= menuRect.left - 1 && rect.right <= menuRect.right + 1,
      ),
    }
  })

  expect(menuMetrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(menuMetrics.menuContained).toBe(true)
  expect(menuMetrics.optionsReachable).toBe(true)
}

async function expectMfaSetupDialogMobileLayout(dialog: Locator): Promise<void> {
  const metrics = await dialog.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const dialogRect = element.getBoundingClientRect()
    const body = Array.from(element.children).find((child) => child.querySelector('form'))
    const bodyRect = body?.getBoundingClientRect()
    const qrCode = element.querySelector('[data-testid="security-mfa-qr-code"]')
    const secret = element.querySelector('[data-testid="security-mfa-secret"]')
    const copyButton = element.querySelector('[data-testid="security-mfa-copy-secret"]')
    const codeInput = element.querySelector('[data-testid="security-mfa-code"]')
    const submitButton = element.querySelector('[data-testid="security-mfa-submit"]')
    const cancelButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Cancel'
    )
    const link = element.querySelector('a[href^="otpauth://"]')

    const requiredElements = [
      qrCode,
      secret,
      copyButton,
      codeInput,
      submitButton,
      cancelButton,
      link,
    ]
    const horizontalRects = requiredElements
      .filter((item): item is Element => item !== null)
      .map((item) => item.getBoundingClientRect())

    const originalScrollTop = body?.scrollTop ?? 0
    codeInput?.scrollIntoView({ block: 'nearest' })
    const bodyAfterScrollRect = body?.getBoundingClientRect()
    const inputAfterScrollRect = codeInput?.getBoundingClientRect()
    const codeInputReachable = Boolean(
      bodyAfterScrollRect
      && inputAfterScrollRect
      && inputAfterScrollRect.top >= bodyAfterScrollRect.top - 1
      && inputAfterScrollRect.bottom <= bodyAfterScrollRect.bottom + 1,
    )
    if (body) body.scrollTop = originalScrollTop

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      dialogContainedHorizontally:
        dialogRect.left >= -1 && dialogRect.right <= viewportWidth + 1,
      dialogContainedVertically:
        dialogRect.top >= -1 && dialogRect.bottom <= viewportHeight + 1,
      bodyContainedHorizontally: bodyRect
        ? bodyRect.left >= dialogRect.left - 1 && bodyRect.right <= dialogRect.right + 1
        : false,
      allRequiredElementsPresent: requiredElements.every(Boolean),
      requiredElementsContainedHorizontally: Boolean(
        bodyRect
        && horizontalRects.every(
          (rect) => rect.left >= bodyRect.left - 1 && rect.right <= bodyRect.right + 1,
        ),
      ),
      codeInputReachable,
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.dialogContainedHorizontally).toBe(true)
  expect(metrics.dialogContainedVertically).toBe(true)
  expect(metrics.bodyContainedHorizontally).toBe(true)
  expect(metrics.allRequiredElementsPresent).toBe(true)
  expect(metrics.requiredElementsContainedHorizontally).toBe(true)
  expect(metrics.codeInputReachable).toBe(true)
}

async function expectMfaLoginMobileLayout(page: Page): Promise<void> {
  const metrics = await page.getByRole('main').evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const panel = element.querySelector('section')
    const heading = element.querySelector('h1')
    const form = element.querySelector('form')
    const codeInput = element.querySelector('[data-testid="admin-mfa-code"]')
    const verifyButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.trim().includes('Verify')
    )
    const alert = element.querySelector('[role="alert"]')

    const panelRect = panel?.getBoundingClientRect()
    const headingRect = heading?.getBoundingClientRect()
    const formRect = form?.getBoundingClientRect()
    const codeInputRect = codeInput?.getBoundingClientRect()
    const verifyButtonRect = verifyButton?.getBoundingClientRect()
    const alertRect = alert?.getBoundingClientRect()
    const containedRects = [
      headingRect,
      formRect,
      codeInputRect,
      verifyButtonRect,
      alertRect,
    ].filter((rect): rect is DOMRect => rect !== undefined)

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      panelPresent: Boolean(panelRect),
      panelContainedHorizontally: panelRect
        ? panelRect.left >= -1 && panelRect.right <= viewportWidth + 1
        : false,
      panelContainedVertically: panelRect
        ? panelRect.top >= -1 && panelRect.bottom <= viewportHeight + 1
        : false,
      requiredElementsPresent: Boolean(headingRect && formRect && codeInputRect && verifyButtonRect),
      requiredElementsContained: Boolean(
        panelRect
        && containedRects.every(
          (rect) => rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1,
        ),
      ),
      challengeControlsStacked: Boolean(
        codeInputRect
        && verifyButtonRect
        && verifyButtonRect.top > codeInputRect.bottom,
      ),
      verifyButtonReachable: verifyButtonRect
        ? verifyButtonRect.bottom <= viewportHeight + 1
        : false,
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.panelPresent).toBe(true)
  expect(metrics.panelContainedHorizontally).toBe(true)
  expect(metrics.panelContainedVertically).toBe(true)
  expect(metrics.requiredElementsPresent).toBe(true)
  expect(metrics.requiredElementsContained).toBe(true)
  expect(metrics.challengeControlsStacked).toBe(true)
  expect(metrics.verifyButtonReachable).toBe(true)
}

async function expectPasswordDialogMobileLayout(dialog: Locator): Promise<void> {
  const metrics = await dialog.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const dialogRect = element.getBoundingClientRect()
    const controls = Array.from(element.querySelectorAll('input, button'))
    const controlRects = controls.map((control) => control.getBoundingClientRect())
    const alertRect = element.querySelector('[role="alert"]')?.getBoundingClientRect()

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      dialogContainedHorizontally:
        dialogRect.left >= -1 && dialogRect.right <= viewportWidth + 1,
      dialogContainedVertically:
        dialogRect.top >= -1 && dialogRect.bottom <= viewportHeight + 1,
      controlsContained: controlRects.every(
        (rect) => rect.left >= dialogRect.left - 1 && rect.right <= dialogRect.right + 1,
      ),
      alertContained: alertRect
        ? alertRect.left >= dialogRect.left - 1 && alertRect.right <= dialogRect.right + 1
        : true,
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.dialogContainedHorizontally).toBe(true)
  expect(metrics.dialogContainedVertically).toBe(true)
  expect(metrics.controlsContained).toBe(true)
  expect(metrics.alertContained).toBe(true)
}
