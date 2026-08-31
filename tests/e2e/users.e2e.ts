import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, completeStepUp, login, loginAs } from './helpers'

const execFileAsync = promisify(execFile)
const E2E_DB_PATH = '.tmp/e2e-agent.db'
const SESSION_COOKIE_NAME = 'instatic_admin_session'
const EXPIRED_STEP_UP_TIMESTAMP = '2000-01-01T00:00:00.000Z'

/**
 * ADMIN-004 / CAP-001 — owner creates a non-owner user, and a capability-limited
 * user only reaches the workspaces its role grants.
 *
 * Creating users and roles always triggers a step-up (rotating the session), so
 * these run on a fresh owner login rather than the shared state.
 */
test.describe('users and roles', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('owner creates a non-owner user (ADMIN-004)', async ({ page }) => {
    await login(page)
    const email = `member-${Date.now().toString(36)}@example.com`

    await page.goto('/admin/users')
    await createUser(page, {
      email,
      displayName: 'E2E Member',
      password: 'member-pass-12345',
      role: 'Member',
    })

    await expect(page.getByText(email)).toBeVisible()
  })

  test('owner edits, suspends, resets, activates, and deletes a non-owner user (USERS-001)', async ({
    page,
    browser,
  }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const email = `user-lifecycle-${suffix}@example.com`
    const editedEmail = `user-lifecycle-edited-${suffix}@example.com`
    const initialDisplayName = `User Lifecycle ${suffix}`
    const editedDisplayName = `User Lifecycle Edited ${suffix}`
    const initialPassword = 'user-lifecycle-pass-12345'
    const resetPassword = 'user-lifecycle-reset-12345'

    await page.goto('/admin/users')
    await createUser(page, {
      email,
      displayName: initialDisplayName,
      password: initialPassword,
      role: 'Admin',
    })

    let row = userRow(page, email)
    await expect(row).toBeVisible()
    await expect(row.getByText(initialDisplayName)).toBeVisible()
    await expect(row.getByText('Active')).toBeVisible()
    await expect(row.getByText('Admin')).toBeVisible()

    await test.step('edit identity fields', async () => {
      await openUserAction(page, initialDisplayName, 'Edit')
      const dialog = page.getByRole('dialog', { name: 'Edit User' })
      await expect(dialog).toBeVisible()
      await dialog.locator('input[name="edited-user-email-address"]').fill(editedEmail)
      await dialog.locator('input[name="edited-user-display-name"]').fill(editedDisplayName)
      await page.locator('button[form="users-page-user-form"]').click()
      await completeStepUp(page)
      await expect(dialog).toBeHidden({ timeout: 20_000 })

      row = userRow(page, editedEmail)
      await expect(row).toBeVisible()
      await expect(row.getByText(editedDisplayName)).toBeVisible()
      await expect(page.getByText(email)).toHaveCount(0)
    })

    await test.step('suspend blocks login', async () => {
      await openUserAction(page, editedDisplayName, 'Suspend')
      await completeStepUp(page)
      row = userRow(page, editedEmail)
      await expect(row.getByText('Suspended')).toBeVisible()

      const context = await browser.newContext()
      const suspendedLogin = await context.newPage()
      try {
        await expectLoginRejected(suspendedLogin, editedEmail, initialPassword)
      } finally {
        await context.close()
      }
    })

    await test.step('activate and reset password restores login', async () => {
      await openUserAction(page, editedDisplayName, 'Activate')
      await completeStepUp(page)
      row = userRow(page, editedEmail)
      await expect(row.getByText('Active')).toBeVisible()

      await openUserAction(page, editedDisplayName, 'Reset password')
      const dialog = page.getByRole('dialog', { name: 'Reset Password' })
      await expect(dialog).toBeVisible()
      await dialog.locator('input[name="edited-user-new-password"]').fill(resetPassword)
      await page.locator('button[form="users-page-user-form"]').click()
      await completeStepUp(page)
      await expect(dialog).toBeHidden({ timeout: 20_000 })
    })

    const activeContext = await browser.newContext()
    const activeAdmin = await activeContext.newPage()
    try {
      await loginAs(activeAdmin, editedEmail, resetPassword)

      await test.step('delete removes the user and invalidates fresh access', async () => {
        await openUserAction(page, editedDisplayName, 'Delete')
        await completeStepUp(page)
        await expect(userRow(page, editedEmail)).toHaveCount(0)

        await activeAdmin.goto('/admin/dashboard')
        await expect(activeAdmin.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
      })

      const deletedContext = await browser.newContext()
      const deletedLogin = await deletedContext.newPage()
      try {
        await expectLoginRejected(deletedLogin, editedEmail, resetPassword)
      } finally {
        await deletedContext.close()
      }
    } finally {
      await activeContext.close()
    }
  })

  test('user creation requires successful step-up before mutating (CAP-003)', async ({
    page,
  }) => {
    await login(page)
    const email = `stepup-${Date.now().toString(36)}@example.com`

    await page.goto('/admin/users')
    await fillCreateUserDialog(page, {
      email,
      displayName: 'Step-Up Guard',
      password: 'step-up-pass-12345',
      role: 'Member',
    })
    await page.locator('button[form="users-page-user-form"]').click()

    const stepUpDialog = page.getByTestId('step-up-dialog')
    await expect(stepUpDialog).toBeVisible()
    await stepUpDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(stepUpDialog).toBeHidden()
    await expect(page.getByText(email)).toHaveCount(0)

    const userDialog = page.getByRole('dialog', { name: 'Create User' })
    await expect(userDialog).toBeVisible()
    await page.locator('button[form="users-page-user-form"]').click()
    await expect(stepUpDialog).toBeVisible()
    await page.getByTestId('step-up-password').fill('wrong-password-12345')
    await page.getByTestId('step-up-confirm').click()
    await expect(stepUpDialog.getByRole('alert')).toBeVisible()
    await expect(page.getByText(email)).toHaveCount(0)

    await page.getByTestId('step-up-password').fill(OWNER.password)
    await page.getByTestId('step-up-confirm').click()
    await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
    await expect(page.getByText(email)).toBeVisible()
  })

  test('user creation step-up stays usable at mobile width (CAP-003)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    const email = `stepup-mobile-${Date.now().toString(36)}@example.com`

    await page.goto('/admin/users')
    await fillCreateUserDialog(page, {
      email,
      displayName: 'Mobile Step-Up Guard',
      password: 'step-up-mobile-pass-12345',
      role: 'Member',
    })
    await page.locator('button[form="users-page-user-form"]').click()

    const stepUpDialog = page.getByTestId('step-up-dialog')
    await expect(stepUpDialog).toBeVisible()
    await expect(stepUpDialog.getByTestId('step-up-password')).toBeVisible()
    await expect(stepUpDialog.getByTestId('step-up-cancel')).toBeVisible()
    await expect(stepUpDialog.getByTestId('step-up-confirm')).toBeVisible()
    await expectStepUpDialogMobileLayout(stepUpDialog)

    await page.getByTestId('step-up-password').fill('wrong-password-12345')
    await page.getByTestId('step-up-confirm').click()
    await expect(stepUpDialog.getByRole('alert')).toBeVisible()
    await expect(page.getByText(email)).toHaveCount(0)
    await expectStepUpDialogMobileLayout(stepUpDialog)

    await page.getByTestId('step-up-password').fill(OWNER.password)
    await page.getByTestId('step-up-confirm').click()
    await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
    await expect(page.getByText(email)).toBeVisible()
  })

  test('sensitive actions re-prompt after the step-up window expires (CAP-003)', async ({
    page,
  }) => {
    await login(page)
    const firstEmail = `stepup-fresh-${Date.now().toString(36)}@example.com`
    const staleEmail = `stepup-stale-${Date.now().toString(36)}@example.com`

    await page.goto('/admin/users')
    await createUser(page, {
      email: firstEmail,
      displayName: 'Fresh Step-Up Window',
      password: 'step-up-fresh-pass-12345',
      role: 'Member',
    })
    await expect(page.getByText(firstEmail)).toBeVisible()

    await expireCurrentStepUpWindow(page)

    await fillCreateUserDialog(page, {
      email: staleEmail,
      displayName: 'Expired Step-Up Window',
      password: 'step-up-stale-pass-12345',
      role: 'Member',
    })
    await page.locator('button[form="users-page-user-form"]').click()

    const stepUpDialog = page.getByTestId('step-up-dialog')
    await expect(stepUpDialog).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(staleEmail)).toHaveCount(0)

    await page.getByTestId('step-up-password').fill(OWNER.password)
    await page.getByTestId('step-up-confirm').click()
    await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
    await expect(page.getByText(staleEmail)).toBeVisible()
  })

  test('a limited user only reaches granted workspaces (CAP-001)', async ({
    page,
    browser,
  }) => {
    await login(page)
    const { email, password } = await createLimitedSiteMediaUser(page, 'limited')

    await test.step('the limited user sees only Site and Media, not Users/Content', async () => {
      const context = await browser.newContext()
      const limited = await context.newPage()
      try {
        await loginAs(limited, email, password)
        const toolbar = limited.getByTestId('toolbar')

        // Media is granted (a reachable link); Content and Users are not in the
        // nav at all (no link, no active label).
        await expect(toolbar.getByRole('link', { name: 'Media' })).toBeVisible()
        await expect(toolbar.getByText('Content', { exact: true })).toHaveCount(0)
        await expect(toolbar.getByText('Users', { exact: true })).toHaveCount(0)

        // A direct URL to a denied workspace must not render it — the guard
        // redirects away from /admin/users.
        await limited.goto('/admin/users')
        await expect(limited).not.toHaveURL(/\/admin\/users/)
        await expect(
          limited.getByRole('heading', { name: 'All Users' }),
        ).toHaveCount(0)
      } finally {
        await context.close()
      }
    })
  })

  test('limited workspace navigation stays contained at mobile width (CAP-001)', async ({
    page,
    browser,
  }) => {
    await login(page)
    const { email, password } = await createLimitedSiteMediaUser(page, 'limited-mobile')

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const limited = await context.newPage()
    try {
      await loginAs(limited, email, password)
      const toolbar = limited.getByTestId('toolbar')

      await expect(toolbar.getByText('Site', { exact: true })).toBeVisible()
      await expect(toolbar.getByRole('link', { name: 'Media' })).toBeVisible()
      await expect(toolbar.getByText('Content', { exact: true })).toHaveCount(0)
      await expect(toolbar.getByText('Users', { exact: true })).toHaveCount(0)
      await expectLimitedToolbarMobileLayout(limited)

      await toolbar.getByTestId('account-menu-trigger').click()
      await expect(limited.getByRole('menu', { name: 'Account menu' })).toBeVisible()
      await expect(limited.getByTestId('account-menu-go-to-account')).toBeVisible()
      await expectLimitedToolbarMobileLayout(limited)
    } finally {
      await context.close()
    }
  })

  test('owner creates, edits, and deletes a custom role (USERS-002)', async ({
    page,
  }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const roleName = `Role lifecycle ${suffix}`
    const editedRoleName = `Role lifecycle edited ${suffix}`

    await page.goto('/admin/users')
    await page.getByRole('tab', { name: 'Roles', exact: true }).click()

    await test.step('create a custom role with selected capabilities', async () => {
      await page.getByRole('button', { name: 'Create Role', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Create Role' })
      await dialog.getByLabel('Name', { exact: true }).fill(roleName)
      await dialog.getByLabel('Description').fill('Lifecycle role created by E2E')
      await dialog.getByText('View site', { exact: true }).click()
      await dialog.getByText('Browse media library', { exact: true }).click()
      await expect(dialog.getByText('2 of')).toBeVisible()

      await page.locator('button[form="users-page-role-form"]').click()
      await completeStepUp(page)
      const roleRow = page.getByRole('row', { name: new RegExp(roleName) })
      await expect(roleRow).toBeVisible()
      await expect(roleRow.getByText('2 capabilities')).toBeVisible()
    })

    await test.step('edit the custom role capabilities and identity', async () => {
      await openRoleAction(page, roleName, 'Edit')
      const dialog = page.getByRole('dialog', { name: 'Edit Role' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Name', { exact: true }).fill(editedRoleName)
      await dialog.getByLabel('Description').fill('Lifecycle role edited by E2E')
      await dialog.getByText('View site', { exact: true }).click()
      await dialog.getByText('Manage roles', { exact: true }).click()
      await expect(dialog.getByText('2 of')).toBeVisible()

      await page.locator('button[form="users-page-role-form"]').click()
      await completeStepUp(page)
      const roleRow = page.getByRole('row', { name: new RegExp(editedRoleName) })
      await expect(roleRow).toBeVisible()
      await expect(roleRow.getByText('2 capabilities')).toBeVisible()
      await expect(page.getByText(roleName)).toHaveCount(0)
    })

    await test.step('delete the custom role', async () => {
      await openRoleAction(page, editedRoleName, 'Delete')
      await completeStepUp(page)
      await expect(page.getByText(editedRoleName)).toHaveCount(0)
    })
  })

  test('role management stays usable at mobile width (USERS-002)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    const roleName = `Role mobile ${Date.now().toString(36)}`

    await page.goto('/admin/users')
    await page.getByRole('tab', { name: 'Roles', exact: true }).click()

    const rolesTable = page.getByRole('table', { name: 'Roles' })
    await expect(rolesTable).toBeVisible()
    await expectDataTableMobileScroller(rolesTable)

    await page.getByRole('button', { name: 'Create Role', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create Role' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Name', { exact: true }).fill(roleName)
    await dialog.getByLabel('Description').fill('Mobile role layout coverage')

    await expect(dialog.getByRole('heading', { name: 'Capabilities' })).toBeVisible()
    await dialog.getByText('View site', { exact: true }).click()
    await dialog.getByText('Browse media library', { exact: true }).click()
    await expect(dialog.getByText('2 of')).toBeVisible()
    await expectRoleDialogMobileLayout(dialog)
  })

  test('audit tab shows user-management events as readable activity (USERS-003)', async ({
    page,
  }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const email = `audit-${suffix}@example.com`
    const displayName = `Audit User ${suffix}`

    await page.goto('/admin/users')
    await createUser(page, {
      email,
      displayName,
      password: 'audit-pass-12345',
      role: 'Member',
    })
    await expect(page.getByText(email)).toBeVisible()

    // Reload so the read-only audit feed is fetched from the authoritative API.
    await page.goto('/admin/users')
    await page.getByRole('tab', { name: 'Audit', exact: true }).click()

    const auditTable = page.getByRole('table', { name: 'Audit events' })
    await expect(auditTable).toBeVisible()
    const createdRow = auditTable.getByRole('row', {
      name: new RegExp(`${displayName} was created`),
    })
    await expect(createdRow).toBeVisible()
    await expect(createdRow.getByText(`by ${OWNER.email}`)).toBeVisible()
    await expect(createdRow.getByText('Role: Member')).toBeVisible()
    await expect(auditTable.getByText('user.create')).toHaveCount(0)
  })

  test('audit tab keeps event history usable at mobile width (USERS-003)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    const suffix = Date.now().toString(36)
    const email = `audit-mobile-${suffix}@example.com`
    const displayName = `Audit Mobile ${suffix}`

    await page.goto('/admin/users')
    await createUser(page, {
      email,
      displayName,
      password: 'audit-mobile-pass-12345',
      role: 'Member',
    })
    await expect(page.getByText(email)).toBeVisible()

    await page.goto('/admin/users')
    await page.getByRole('tab', { name: 'Audit', exact: true }).click()

    const auditTable = page.getByRole('table', { name: 'Audit events' })
    await expect(auditTable).toBeVisible()
    await expect(
      auditTable.getByRole('row', { name: new RegExp(`${displayName} was created`) }),
    ).toBeVisible()
    await expectDataTableMobileScroller(auditTable)
  })
})

async function createUser(
  page: Page,
  user: { email: string; displayName: string; password: string; role: string },
): Promise<void> {
  await fillCreateUserDialog(page, user)
  await page.locator('button[form="users-page-user-form"]').click()
  await completeStepUp(page)
}

async function fillCreateUserDialog(
  page: Page,
  user: { email: string; displayName: string; password: string; role: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  await page.locator('input[name="new-user-email-address"]').fill(user.email)
  await page.locator('input[name="new-user-display-name"]').fill(user.displayName)
  await page.locator('input[name="new-user-initial-password"]').fill(user.password)
  await page.locator('select[name="new-user-role"]').selectOption({ label: user.role })
}

async function createLimitedSiteMediaUser(
  page: Page,
  prefix: string,
): Promise<{ email: string; password: string }> {
  const suffix = Date.now().toString(36)
  const roleName = `Limited ${prefix} ${suffix}`
  const email = `${prefix}-${suffix}@example.com`
  const password = 'limited-pass-12345'

  await createSiteAndMediaRole(page, roleName)
  // Reload so the freshly created role is selectable in the user dialog.
  await page.goto('/admin/users')
  await createUser(page, {
    email,
    displayName: 'Limited User',
    password,
    role: roleName,
  })

  return { email, password }
}

async function expireCurrentStepUpWindow(page: Page): Promise<void> {
  const sessionCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  )
  if (!sessionCookie) throw new Error('No admin session cookie available')

  const idHash = createHash('sha256').update(sessionCookie.value).digest('hex')
  const script = `
import { Database } from 'bun:sqlite'

const db = new Database(${JSON.stringify(E2E_DB_PATH)})
const result = db.run(
  'update sessions set step_up_expires_at = ? where id_hash = ? and revoked_at is null',
  ${JSON.stringify(EXPIRED_STEP_UP_TIMESTAMP)},
  ${JSON.stringify(idHash)},
)
db.close()

if (result.changes !== 1) {
  console.error(\`Expected to expire one live session row, changed \${result.changes}\`)
  process.exit(1)
}
`

  await execFileAsync('bun', ['-e', script])
}

/** Create a custom role granting only Site (read) and Media (read). */
async function createSiteAndMediaRole(page: Page, name: string): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('tab', { name: 'Roles', exact: true }).click()
  await page.getByRole('button', { name: 'Create Role', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Create Role' })
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  // Each capability is a labelled checkbox — clicking the label text toggles it.
  await dialog.getByText('View site', { exact: true }).click()
  await dialog.getByText('Browse media library', { exact: true }).click()

  await page.locator('button[form="users-page-role-form"]').click()
  await completeStepUp(page)
}

async function openRoleAction(page: Page, roleName: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${roleName}` }).click()
  await page
    .getByRole('menu', { name: `Role actions for ${roleName}` })
    .getByRole('menuitem', { name: action })
    .click()
}

function userRow(page: Page, email: string): Locator {
  return page.getByRole('row', { name: new RegExp(`User ${escapeRegExp(email)}`) })
}

async function openUserAction(page: Page, displayName: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${displayName}` }).click()
  await page
    .getByRole('menu', { name: `User actions for ${displayName}` })
    .getByRole('menuitem', { name: action })
    .click()
}

async function expectLoginRejected(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password')
  await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function expectDataTableMobileScroller(table: Locator): Promise<void> {
  const metrics = await table.evaluate((element) => {
    const wrapper = element.parentElement
    const documentElement = document.documentElement
    if (!wrapper) {
      return {
        hasWrapper: false,
        pageOverflow: 0,
        wrapperContained: false,
        canScrollTable: false,
        reachesTableEnd: false,
      }
    }

    const viewportWidth = documentElement.clientWidth
    const wrapperRect = wrapper.getBoundingClientRect()
    const pageOverflow = documentElement.scrollWidth - viewportWidth
    const maxScrollLeft = wrapper.scrollWidth - wrapper.clientWidth

    wrapper.scrollLeft = wrapper.scrollWidth

    return {
      hasWrapper: true,
      pageOverflow,
      wrapperContained: wrapperRect.left >= -1 && wrapperRect.right <= viewportWidth + 1,
      canScrollTable: wrapper.scrollWidth > wrapper.clientWidth,
      reachesTableEnd: wrapper.scrollLeft >= maxScrollLeft - 1,
    }
  })

  expect(metrics.hasWrapper).toBe(true)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.wrapperContained).toBe(true)
  expect(metrics.canScrollTable).toBe(true)
  expect(metrics.reachesTableEnd).toBe(true)
}

async function expectRoleDialogMobileLayout(dialog: Locator): Promise<void> {
  const metrics = await dialog.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const dialogRect = element.getBoundingClientRect()
    const capabilitySection = element.querySelector('section[aria-label="Capabilities"]')
    const firstList = capabilitySection?.querySelector('ul')
    const firstItems = Array.from(firstList?.children ?? []).slice(0, 2)
    const itemRects = firstItems.map((item) => item.getBoundingClientRect())
    const capabilityRowRects = Array.from(
      capabilitySection?.querySelectorAll('label') ?? [],
    ).map((label) => label.getBoundingClientRect())

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      dialogContained: dialogRect.left >= -1 && dialogRect.right <= viewportWidth + 1,
      capabilitySectionVisible: Boolean(capabilitySection),
      firstListStacksRows: itemRects.length < 2
        || (
          Math.abs(itemRects[0]!.left - itemRects[1]!.left) <= 1
          && itemRects[1]!.top > itemRects[0]!.top
        ),
      capabilityRowsContained: capabilityRowRects.every(
        (rect) => rect.left >= dialogRect.left - 1 && rect.right <= dialogRect.right + 1,
      ),
    }
  })

  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.dialogContained).toBe(true)
  expect(metrics.capabilitySectionVisible).toBe(true)
  expect(metrics.firstListStacksRows).toBe(true)
  expect(metrics.capabilityRowsContained).toBe(true)
}

async function expectStepUpDialogMobileLayout(dialog: Locator): Promise<void> {
  const metrics = await dialog.evaluate((element) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const dialogRect = element.getBoundingClientRect()
    const passwordInput = element.querySelector('[data-testid="step-up-password"]')
    const cancelButton = element.querySelector('[data-testid="step-up-cancel"]')
    const confirmButton = element.querySelector('[data-testid="step-up-confirm"]')
    const alert = element.querySelector('[role="alert"]')
    const controls = [passwordInput, cancelButton, confirmButton].filter(
      (control): control is Element => control !== null,
    )
    const controlRects = controls.map((control) => control.getBoundingClientRect())
    const alertRect = alert?.getBoundingClientRect()

    return {
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      dialogContainedHorizontally:
        dialogRect.left >= -1 && dialogRect.right <= viewportWidth + 1,
      dialogContainedVertically:
        dialogRect.top >= -1 && dialogRect.bottom <= viewportHeight + 1,
      requiredControlsPresent: controls.length === 3,
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
  expect(metrics.requiredControlsPresent).toBe(true)
  expect(metrics.controlsContained).toBe(true)
  expect(metrics.alertContained).toBe(true)
}

async function expectLimitedToolbarMobileLayout(page: Page): Promise<void> {
  const metrics = await page.getByTestId('toolbar').evaluate((toolbar) => {
    const documentElement = document.documentElement
    const viewportWidth = documentElement.clientWidth
    const viewportHeight = window.innerHeight
    const toolbarRect = toolbar.getBoundingClientRect()
    const mediaLink = toolbar.querySelector('a[href="/admin/media"]')
    const accountTrigger = toolbar.querySelector('[data-testid="account-menu-trigger"]')
    const controls = [mediaLink, accountTrigger].filter(
      (control): control is Element => control !== null,
    )

    return {
      viewportWidth,
      viewportHeight,
      pageOverflow: documentElement.scrollWidth - viewportWidth,
      toolbarContained: toolbarRect.left >= -1 && toolbarRect.right <= viewportWidth + 1,
      requiredControlsPresent: controls.length === 2,
      controlsContained: controls.every((control) => {
        const rect = control.getBoundingClientRect()
        return rect.left >= -1 && rect.right <= viewportWidth + 1
      }),
    }
  })

  expect(metrics.viewportWidth).toBe(390)
  expect(metrics.viewportHeight).toBe(844)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
  expect(metrics.toolbarContained).toBe(true)
  expect(metrics.requiredControlsPresent).toBe(true)
  expect(metrics.controlsContained).toBe(true)
}
