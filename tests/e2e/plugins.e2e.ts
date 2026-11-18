import { expect, test, type Page } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  completeStepUp,
  login,
  openSiteEditor,
  openSitePanel,
} from './helpers'

/**
 * PLUGIN-008 — invalid plugin uploads should fail in-place with a specific,
 * recoverable error before any permission review or install mutation occurs.
 */
test.describe('plugin uploads', () => {
  test('rejects an invalid plugin manifest and recovers on the next upload (PLUGIN-008)', async ({
    page,
  }) => {
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const invalidName = 'Broken Invalid Plugin'
    await uploadPluginFile(page, 'broken-invalid.plugin.json', {
      id: 'broken invalid plugin',
      name: invalidName,
      version: '1.0.0',
      apiVersion: 1,
      permissions: [],
    })

    const uploadAlert = page.getByRole('alert')
    await expect(uploadAlert).toContainText('Invalid plugin manifest')
    await expect(page.getByRole('heading', { name: `Review ${invalidName}` })).toHaveCount(0)

    const suffix = Date.now().toString(36)
    const validName = `Recoverable Upload Plugin ${suffix}`
    await uploadPluginFile(page, `recoverable-${suffix}.plugin.json`, {
      id: `recoverable.upload-${suffix}`,
      name: validName,
      version: '1.0.0',
      apiVersion: 1,
      permissions: [],
    })

    await expect(uploadAlert).toHaveCount(0)
    await expect(page.getByRole('heading', { name: `Review ${validName}` })).toBeVisible()
    await expect(page.getByTestId('permission-review-empty')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('heading', { name: `Review ${validName}` })).toHaveCount(0)
  })
})

/**
 * PLUGIN-003 — plugin settings should persist through the real settings
 * dialog while secret values are masked on every browser-bound read.
 */
test.describe.serial('plugin settings', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(120_000)

  test('saves normal settings and reopens secrets masked (PLUGIN-003)', async ({ page }) => {
    await login(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const suffix = Date.now().toString(36)
    const pluginId = `e2e.settings-${suffix}`
    const pluginName = `E2E Settings ${suffix}`
    const savedMode = `live-${suffix}`
    const secretValue = `secret-${suffix}`

    await uploadPluginPackage(page, pluginId, pluginSettingsPackageFiles(pluginId, pluginName))

    await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
    await expect(page.getByTestId('permission-review-empty')).toBeVisible()
    await page.getByRole('button', { name: 'Approve and Install' }).click()
    await completeStepUp(page)

    const pluginCard = page.locator('article').filter({
      has: page.getByRole('heading', { name: pluginName }),
    })
    await expect(pluginCard).toBeVisible()

    await pluginCard.getByRole('button', { name: `Edit settings for ${pluginName}` }).click()
    const dialog = page.getByRole('dialog', { name: pluginName })
    await expect(dialog).toBeVisible()

    await expect(dialog.getByLabel('Mode')).toHaveValue('draft')
    await expect(dialog.getByLabel('API token')).toHaveValue('')

    await dialog.getByLabel('Mode').fill(savedMode)
    await dialog.getByLabel('API token').fill(secretValue)
    await dialog.getByRole('button', { name: 'Save settings' }).click()
    await completeStepUp(page)
    await expect(dialog).toHaveCount(0)

    await pluginCard.getByRole('button', { name: `Edit settings for ${pluginName}` }).click()
    const reopenedDialog = page.getByRole('dialog', { name: pluginName })
    await expect(reopenedDialog).toBeVisible()
    await expect(reopenedDialog.getByLabel('Mode')).toHaveValue(savedMode)
    await expect(reopenedDialog.getByLabel('API token')).toHaveValue('***')

    const settingsResponse = await page.evaluate(async (id) => {
      const response = await fetch(`/admin/api/cms/plugins/${id}/settings`, {
        credentials: 'include',
      })
      return {
        status: response.status,
        body: await response.json(),
      }
    }, pluginId)
    expect(settingsResponse).toMatchObject({
      status: 200,
      body: {
        settings: {
          mode: savedMode,
          apiToken: '***',
        },
        secretsNeedingReentry: [],
      },
    })
    expect(JSON.stringify(settingsResponse.body)).not.toContain(secretValue)

    await reopenedDialog.getByRole('button', { name: 'Cancel' }).click()
  })
})

/**
 * PLUGIN-002 — enable/disable/remove should update the installed-plugin card
 * and the runtime route registry through the real lifecycle controls.
 */
test.describe.serial('plugin lifecycle', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(120_000)

  test('disables, enables, and removes a packaged plugin (PLUGIN-002)', async ({ page }) => {
    await login(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const suffix = Date.now().toString(36)
    const pluginId = `e2e.lifecycle-${suffix}`
    const pluginName = `E2E Lifecycle ${suffix}`

    await uploadPluginPackage(page, pluginId, pluginLifecyclePackageFiles(pluginId, pluginName))

    await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
    await expect(page.locator('[data-permission="cms.routes"]')).toBeVisible()
    await page.getByRole('button', { name: 'Approve and Install' }).click()
    await completeStepUp(page)

    const pluginCard = page.locator('article').filter({
      has: page.getByRole('heading', { name: pluginName }),
    })
    await expect(pluginCard).toBeVisible()
    await expect(pluginCard.getByText('Active', { exact: true })).toBeVisible()
    await expect(await pluginRuntimeStatus(page, pluginId)).toMatchObject({
      status: 200,
      body: { ok: true, pluginId },
    })

    await pluginCard.getByRole('button', { name: `Disable ${pluginName}` }).click()
    await completeStepUp(page)
    await expect(pluginCard.getByText('Disabled', { exact: true })).toBeVisible()
    await expect(pluginCard.getByRole('button', { name: `Enable ${pluginName}` })).toBeVisible()
    await expect(await pluginRuntimeStatus(page, pluginId)).toMatchObject({
      status: 404,
      body: { error: 'Plugin route not found' },
    })

    await pluginCard.getByRole('button', { name: `Enable ${pluginName}` }).click()
    await completeStepUp(page)
    await expect(pluginCard.getByText('Active', { exact: true })).toBeVisible()
    await expect(pluginCard.getByRole('button', { name: `Disable ${pluginName}` })).toBeVisible()
    await expect(await pluginRuntimeStatus(page, pluginId)).toMatchObject({
      status: 200,
      body: { ok: true, pluginId },
    })

    await pluginCard.getByRole('button', { name: `Remove ${pluginName}` }).click()
    const removeDialog = page.getByRole('alertdialog', { name: pluginName })
    await expect(removeDialog).toBeVisible()
    await expect(removeDialog.getByText('Removing this plugin will:')).toBeVisible()
    await removeDialog.getByRole('button', { name: 'Remove plugin' }).click()
    await completeStepUp(page)

    await expect(pluginCard).toHaveCount(0)
    await expect(await pluginRuntimeStatus(page, pluginId)).toMatchObject({
      status: 404,
      body: { error: 'Plugin route not found' },
    })
  })
})

/**
 * PLUGIN-005 — plugin schedules should be inspectable and controllable
 * through the real schedule dialog and lifecycle-gated mutations.
 */
test.describe.serial('plugin schedules', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(120_000)

  test('lists, runs, pauses, and resumes a packaged schedule (PLUGIN-005)', async ({ page }) => {
    await login(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const suffix = Date.now().toString(36)
    const pluginId = `e2e.schedule-${suffix}`
    const pluginName = `E2E Schedule ${suffix}`
    const scheduleId = `${pluginId}.heartbeat`

    await uploadPluginPackage(page, pluginId, pluginSchedulePackageFiles(pluginId, pluginName))

    await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
    await expect(page.locator('[data-permission="cms.schedule"]')).toBeVisible()
    await page.getByRole('button', { name: 'Approve and Install' }).click()
    await completeStepUp(page)

    const pluginCard = page.locator('article').filter({
      has: page.getByRole('heading', { name: pluginName }),
    })
    await expect(pluginCard).toBeVisible()
    await expect(pluginCard.getByText('Active', { exact: true })).toBeVisible()

    await pluginCard.getByRole('button', { name: `View schedules for ${pluginName}` }).click()
    const dialog = page.getByRole('dialog', { name: pluginName })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: scheduleId })).toBeVisible()
    await expect(dialog.getByText('Every 15 minutes')).toBeVisible()
    await expect(dialog.getByText('Pending', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Run now' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()

    await dialog.getByRole('button', { name: 'Run now' }).click()
    await completeStepUp(page)
    await expect(dialog.getByText('Recent runs')).toBeVisible()
    await expect(dialog.getByText('Completed')).toBeVisible()
    await expect(dialog.getByText('Healthy', { exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Pause' }).click()
    await completeStepUp(page)
    await expect(dialog.getByText('Paused', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Resume' })).toBeVisible()

    await dialog.getByRole('button', { name: 'Resume' }).click()
    await completeStepUp(page)
    await expect(dialog.getByText('Healthy', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()

    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(dialog).toHaveCount(0)
  })
})

/**
 * PLUGIN-006 — plugin packs should seed draft-site content and give honest
 * feedback when the operator re-syncs an already-installed pack.
 */
test.describe.serial('plugin packs', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(120_000)

  test('installs and re-syncs a packaged site pack (PLUGIN-006)', async ({ page }) => {
    await login(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const suffix = Date.now().toString(36)
    const pluginId = `e2e.pack-${suffix}`
    const pluginName = `E2E Pack ${suffix}`
    const packPageTitle = `Pack Page ${suffix}`
    const packPageSlug = `pack-page-${suffix}`
    const packText = `Pack content ${suffix}`

    await uploadPluginPackage(
      page,
      pluginId,
      pluginPackPackageFiles(pluginId, pluginName, packPageTitle, packPageSlug, packText),
    )

    await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
    await expect(page.locator('[data-permission="visualComponents.register"]')).toBeVisible()
    await page.getByRole('button', { name: 'Approve and Install' }).click()
    await completeStepUp(page)

    await page.goto('/admin/site')
    await openSiteEditor(page)
    await openSitePanel(page)
    const packPage = page.getByRole('treeitem', { name: `Open page ${packPageTitle}` })
    await expect(packPage).toBeVisible()
    await packPage.click()
    await expect(canvasFrame(page).getByText(packText)).toBeVisible()

    await page.goto('/admin/plugins')
    const pluginCard = page.locator('article').filter({
      has: page.getByRole('heading', { name: pluginName }),
    })
    await expect(pluginCard).toBeVisible()
    await expect(pluginCard.getByText('Active', { exact: true })).toBeVisible()
    await pluginCard
      .getByRole('button', {
        name: `Re-sync ${pluginName} pack from the plugin's latest version`,
      })
      .click()

    const packToast = page.locator('[data-toast-location="plugins:install-pack"]').filter({
      hasText: `Installed pack from ${pluginName}`,
    })
    await expect(packToast).toBeVisible()
    await expect(packToast).toContainText('1 item(s) installed, 1 replaced.')
  })
})

/**
 * PLUGIN-009: stylesheets a plugin adds to published pages (`frontend.assets`
 * of kind `style` / `style-inline`) must also style the editing canvas, while
 * the plugin's frontend scripts stay out of it.
 */
test.describe.serial('plugin frontend stylesheets', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(120_000)

  test('styles the canvas with plugin stylesheets and keeps scripts out (PLUGIN-009)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const suffix = Date.now().toString(36)
    const pluginId = `e2e.styles-${suffix}`
    const pluginName = `E2E Styles ${suffix}`
    const packPageTitle = `Styled Page ${suffix}`
    const packText = `Styled content ${suffix}`

    const files = pluginPackPackageFiles(
      pluginId,
      pluginName,
      packPageTitle,
      `styled-page-${suffix}`,
      packText,
    )
    const manifest = JSON.parse(files['plugin.json']) as Record<string, unknown>
    files['plugin.json'] = JSON.stringify({
      ...manifest,
      description: 'Browser-installed fixture for PLUGIN-009 frontend stylesheets.',
      permissions: ['visualComponents.register', 'frontend.assets'],
      frontend: {
        assets: [
          { kind: 'style', href: 'frontend/styled.css', placement: 'head-end' },
          { kind: 'style-inline', content: 'body p { letter-spacing: 7px; }' },
          {
            kind: 'script-inline',
            content: 'document.documentElement.setAttribute("data-e2e-plugin-script", "ran")',
          },
        ],
      },
    })
    files['frontend/styled.css'] = 'body p { color: rgb(1, 2, 3); }'

    await uploadPluginPackage(page, pluginId, files)
    await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
    await expect(page.locator('[data-permission="frontend.assets"]')).toBeVisible()
    await page.getByRole('button', { name: 'Approve and Install' }).click()
    await completeStepUp(page)

    await page.goto('/admin/site')
    await openSiteEditor(page)
    await openSitePanel(page)
    await page.getByRole('treeitem', { name: `Open page ${packPageTitle}` }).click()
    const styledText = canvasFrame(page).getByText(packText)
    await expect(styledText).toBeVisible()

    // External stylesheet and inline style both reach the canvas document.
    await expect(styledText).toHaveCSS('color', 'rgb(1, 2, 3)')
    await expect(styledText).toHaveCSS('letter-spacing', '7px')
    // The plugin's frontend script must never run inside the canvas.
    await expect(canvasFrame(page).locator('html')).not.toHaveAttribute(
      'data-e2e-plugin-script',
      'ran',
    )

    // Disabling the plugin drops its stylesheets from the canvas.
    await page.goto('/admin/plugins')
    const pluginCard = page.locator('article').filter({
      has: page.getByRole('heading', { name: pluginName }),
    })
    await pluginCard.getByRole('button', { name: `Disable ${pluginName}` }).click()
    await completeStepUp(page)
    await expect(pluginCard.getByText('Disabled', { exact: true })).toBeVisible()

    await page.goto('/admin/site')
    await openSiteEditor(page)
    await openSitePanel(page)
    await page.getByRole('treeitem', { name: `Open page ${packPageTitle}` }).click()
    const plainText = canvasFrame(page).getByText(packText)
    await expect(plainText).toBeVisible()
    await expect(plainText).not.toHaveCSS('color', 'rgb(1, 2, 3)')
    await expect(plainText).not.toHaveCSS('letter-spacing', '7px')
  })
})

/**
 * PLUGIN-004 — packaged plugin admin pages, resource records, admin-app
 * assets, and sandboxed runtime routes should work together from the real
 * browser install path.
 */
test.describe.serial('packaged plugin surfaces', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(120_000)

  test('opens plugin pages, manages records, and calls runtime routes (PLUGIN-004)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/plugins')
    await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({
      timeout: 20_000,
    })

    const suffix = Date.now().toString(36)
    const pluginId = `e2e.plugin-${suffix}`
    const pluginName = `E2E Plugin ${suffix}`
    const recordTitle = `Approval ${suffix}`

    await uploadPluginPackage(page, pluginId, pluginPackageFiles(pluginId, pluginName, suffix))

    await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
    await expect(page.getByTestId('unsandboxed-code-alert')).toBeVisible()
    await expect(page.locator('[data-permission="admin.navigation"]')).toBeVisible()
    await expect(page.locator('[data-permission="cms.routes"]')).toBeVisible()
    await expect(page.locator('[data-permission="editor.code"]')).toBeVisible()

    await page.getByRole('button', { name: 'Approve and Install' }).click()
    await completeStepUp(page)

    const pluginCard = page.locator('article').filter({
      has: page.getByRole('heading', { name: pluginName }),
    })
    await expect(pluginCard).toBeVisible()
    await expect(pluginCard.getByText('Active', { exact: true })).toBeVisible()

    await pluginCard.getByRole('link', { name: 'Guide' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/plugins/${escapeRegExp(pluginId)}/guide$`))
    await expect(page.getByRole('heading', { name: 'E2E Guide' })).toBeVisible()
    await expect(page.getByText(`Guide body ${suffix}`)).toBeVisible()

    await page.goto(`/admin/plugins/${pluginId}/map`)
    await expect(page.getByRole('heading', { name: 'E2E Map' })).toBeVisible()
    await expect(page.getByText('North dock')).toBeVisible()

    await page.goto(`/admin/plugins/${pluginId}/dashboard`)
    await expect(page.getByTestId('plugin-e2e-dashboard')).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByTestId('plugin-e2e-dashboard')).toContainText(pluginName)

    const runtime = await page.evaluate(async (id) => {
      const response = await fetch(`/admin/api/cms/plugins/${id}/runtime/status`, {
        credentials: 'include',
      })
      return {
        status: response.status,
        body: await response.json(),
      }
    }, pluginId)
    expect(runtime).toMatchObject({
      status: 200,
      body: {
        ok: true,
        pluginId,
        email: 'owner.e2e@example.com',
        hasPluginRead: true,
      },
    })

    await page.goto(`/admin/plugins/${pluginId}/approvals`)
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
    await expect(page.getByText('No records yet.')).toBeVisible()

    const titleField = page.getByLabel('Title')
    await page.getByRole('button', { name: 'Create Approval' }).click()
    await expect.poll(async () =>
      titleField.evaluate((input) => (input as HTMLInputElement).validity.valueMissing)
    ).toBe(true)

    await titleField.fill(recordTitle)
    await page.getByLabel('Score').fill('7')
    await page.getByLabel('Due Date').fill('2026-07-01')
    await page.getByLabel('Approved').check()
    await page.getByLabel('Notes').fill('Created from the PLUGIN-004 browser smoke.')
    await page.getByRole('button', { name: 'Create Approval' }).click()

    const recordsRegion = page.getByLabel('Approvals records')
    await expect(recordsRegion.getByText(recordTitle)).toBeVisible()
    await expect(recordsRegion.getByText('7', { exact: true })).toBeVisible()
    await expect(recordsRegion.getByText('2026-07-01', { exact: true })).toBeVisible()
    await expect(recordsRegion.getByText('Yes', { exact: true })).toBeVisible()
    await expect(recordsRegion.getByText('Created from the PLUGIN-004 browser smoke.')).toBeVisible()

    await recordsRegion.getByRole('button', { name: `Delete ${recordTitle}` }).click()
    await expect(recordsRegion.getByText(recordTitle)).toHaveCount(0)
    await expect(page.getByText('No records yet.')).toBeVisible()

    await test.step('nav entries that do not fit the toolbar move into a More menu', async () => {
      await openSiteEditor(page)
      const toolbar = page.getByTestId('toolbar')
      const more = toolbar.getByTestId('admin-nav-more')
      await expect(more).toBeVisible()
      // The toolbar stays inside the window, with its trailing controls on screen.
      await expect
        .poll(() => toolbar.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBe(0)
      await expect(page.getByTestId('account-menu-trigger')).toBeInViewport({ ratio: 1 })

      // The entry with no room in the row is reachable from the menu.
      await expect(toolbar.getByRole('link', { name: 'Approvals' })).toBeHidden()
      await more.click()
      const menu = page.getByRole('menu', { name: 'More admin sections' })
      await menu.getByRole('menuitem', { name: 'Approvals' }).click()
      await expect(page).toHaveURL(new RegExp(`/admin/plugins/${escapeRegExp(pluginId)}/approvals$`))
    })
  })
})

async function uploadPluginFile(
  page: Page,
  filename: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await page.getByLabel('Plugin file').setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  })
}

async function uploadPluginPackage(
  page: Page,
  pluginId: string,
  files: Record<string, string>,
): Promise<void> {
  await page.getByLabel('Plugin file').setInputFiles({
    name: `${pluginId}.zip`,
    mimeType: 'application/zip',
    buffer: pluginPackageBuffer(files),
  })
}

function pluginPackageBuffer(files: Record<string, string>): Buffer {
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, source]) => [path, strToU8(source)]),
  )
  return Buffer.from(zipSync(entries))
}

function pluginPackageFiles(
  pluginId: string,
  pluginName: string,
  suffix: string,
): Record<string, string> {
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Browser-installed fixture for PLUGIN-004.',
    permissions: ['admin.navigation', 'cms.routes', 'editor.code'],
    entrypoints: { server: 'server/index.js' },
    resources: [
      {
        id: 'approvals',
        title: 'Approvals',
        singularLabel: 'Approval',
        fields: [
          { id: 'title', label: 'Title', type: 'text', required: true },
          { id: 'score', label: 'Score', type: 'number' },
          { id: 'dueDate', label: 'Due Date', type: 'date' },
          { id: 'approved', label: 'Approved', type: 'boolean' },
          { id: 'notes', label: 'Notes', type: 'longtext' },
        ],
      },
    ],
    adminPages: [
      {
        id: 'guide',
        title: 'Guide',
        navLabel: 'Guide',
        content: {
          kind: 'markdown',
          heading: 'E2E Guide',
          body: `Guide body ${suffix}\n\nInstalled from a ZIP package.`,
        },
      },
      {
        id: 'map',
        title: 'Map',
        navLabel: 'Map',
        content: {
          kind: 'map',
          heading: 'E2E Map',
          body: 'Operational map fixture.',
          centerLabel: 'HQ',
          pins: [
            { label: 'North dock', detail: 'Receiving', x: 30, y: 40 },
            { label: 'South gate', detail: 'Dispatch', x: 70, y: 60 },
          ],
        },
      },
      {
        id: 'dashboard',
        title: 'Dashboard',
        navLabel: 'Dashboard',
        content: {
          kind: 'app',
          heading: 'Dashboard',
          entry: 'admin/dashboard.js',
        },
      },
      {
        id: 'approvals',
        title: 'Approvals',
        navLabel: 'Approvals',
        content: {
          kind: 'resource',
          heading: 'Approvals',
          resource: 'approvals',
        },
      },
    ],
  }

  return {
    'plugin.json': JSON.stringify(manifest),
    'server/index.js': `
      export function activate(api) {
        api.cms.routes.get('/status', 'plugins.read', (ctx) => ({
          ok: true,
          pluginId: api.plugin.id,
          email: ctx.user ? ctx.user.email : null,
          hasPluginRead: ctx.user ? ctx.user.capabilities.includes('plugins.read') : false,
        }))
      }
    `,
    'admin/dashboard.js': `
      import { createElement } from 'react'
      import { definePluginAdminApp } from '@instatic/plugin-sdk'

      export default definePluginAdminApp(function Dashboard({ page }) {
        return createElement(
          'section',
          { 'data-testid': 'plugin-e2e-dashboard' },
          createElement('h2', null, 'Packaged dashboard'),
          createElement('p', null, page.pluginName + ' loaded from packaged admin app assets.'),
        )
      })
    `,
  }
}

function pluginSettingsPackageFiles(pluginId: string, pluginName: string): Record<string, string> {
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Browser-installed fixture for PLUGIN-003 settings.',
    permissions: [],
    settings: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'text',
        default: 'draft',
      },
      {
        id: 'apiToken',
        label: 'API token',
        type: 'password',
        secret: true,
        placeholder: 'Paste token',
      },
    ],
  }

  return {
    'plugin.json': JSON.stringify(manifest),
  }
}

function pluginLifecyclePackageFiles(pluginId: string, pluginName: string): Record<string, string> {
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Browser-installed fixture for PLUGIN-002 lifecycle.',
    permissions: ['cms.routes'],
    entrypoints: { server: 'server/index.js' },
  }

  return {
    'plugin.json': JSON.stringify(manifest),
    'server/index.js': `
      export function activate(api) {
        api.cms.routes.get('/status', 'plugins.read', () => ({
          ok: true,
          pluginId: api.plugin.id,
        }))
      }
    `,
  }
}

function pluginSchedulePackageFiles(pluginId: string, pluginName: string): Record<string, string> {
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Browser-installed fixture for PLUGIN-005 schedules.',
    permissions: ['cms.schedule'],
    entrypoints: { server: 'server/index.js' },
  }

  return {
    'plugin.json': JSON.stringify(manifest),
    'server/index.js': `
      export async function activate(api) {
        await api.cms.schedule.every(15, 'heartbeat', async () => {})
      }
    `,
  }
}

function pluginPackPackageFiles(
  pluginId: string,
  pluginName: string,
  packPageTitle: string,
  packPageSlug: string,
  packText: string,
): Record<string, string> {
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Browser-installed fixture for PLUGIN-006 packs.',
    permissions: ['visualComponents.register'],
    pack: { path: 'pack/site.json' },
  }
  const rootId = `${pluginId}.pack-root`
  const textId = `${pluginId}.pack-text`
  const pack = {
    pages: [
      {
        id: `${pluginId}.pack-page`,
        title: packPageTitle,
        slug: packPageSlug,
        rootNodeId: rootId,
        nodes: {
          [rootId]: {
            id: rootId,
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: [textId],
            classIds: [],
          },
          [textId]: {
            id: textId,
            moduleId: 'base.text',
            props: {
              text: packText,
              tag: 'p',
            },
            breakpointOverrides: {},
            children: [],
            classIds: [],
          },
        },
      },
    ],
  }

  return {
    'plugin.json': JSON.stringify(manifest),
    'pack/site.json': JSON.stringify(pack),
  }
}

async function pluginRuntimeStatus(
  page: Page,
  pluginId: string,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/admin/api/cms/plugins/${id}/runtime/status`, {
      credentials: 'include',
    })
    return {
      status: response.status,
      body: await response.json(),
    }
  }, pluginId)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
