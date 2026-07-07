import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectEditorReady } from './helpers'

const EDITOR_PREFS_KEY = 'instatic-editor-prefs'
const EDITOR_LAYOUT_STORAGE_KEY = 'instatic-editor-layout-v2'

/**
 * ADMIN-001 — move between the primary admin workspaces and confirm the active
 * workspace is unambiguous.
 *
 * The section nav lives in the toolbar banner. The active workspace renders as a
 * non-clickable `<span>` while the others stay links, so "active" is asserted by
 * the section's link disappearing from the toolbar (plus the URL). Account is
 * reached through the account menu rather than the section nav.
 *
 * Read-only navigation — runs as the owner via the shared auth state.
 */
test.describe('admin navigation', () => {
  test('moves between Site, Content, Plugins, Users, and Account', async ({
    page,
  }) => {
    await page.goto('/admin/site')
    await expectEditorReady(page)
    await expectActiveSection(page, 'Site')

    await navigateSection(page, 'Content', '/admin/content')
    await navigateSection(page, 'Plugins', '/admin/plugins')
    await navigateSection(page, 'Users', '/admin/users')

    await test.step('reach Account from the account menu', async () => {
      await page.getByTestId('account-menu-trigger').click()
      await page.getByTestId('account-menu-go-to-account').click()
      await expect(page).toHaveURL(/\/admin\/account$/)
      await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible()
    })
  })

  test('keeps global toolbar actions available and updates open-live targets (ADMIN-003)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

    await test.step('dashboard toolbar exposes global actions and opens the live site root', async () => {
      await expectToolbarTrailer(page, 'Open live site')
      const liveSite = await openToolbarLivePage(page)
      try {
        expect(new URL(liveSite.url()).pathname).toBe('/')
      } finally {
        await liveSite.close()
      }

      await page.getByTestId('account-menu-trigger').click()
      const accountMenu = page.getByRole('menu', { name: 'Account menu' })
      await expect(accountMenu.getByText('Account & security')).toBeVisible()
      await expect(accountMenu.getByText('Sign out', { exact: true })).toBeVisible()
      await expect(accountMenu.getByText('Sign out all devices')).toBeVisible()
      await page.getByTestId('account-menu-trigger').click()
      await expect(accountMenu).toBeHidden()
    })

    await test.step('content workspace publishes the selected entry public path to the global toolbar', async () => {
      const suffix = Date.now().toString(36)
      const title = `ADMIN-003 Toolbar ${suffix}`
      const slug = `admin-003-toolbar-${suffix}`

      await page.goto('/admin/content')
      await expect(page.getByTestId('content-explorer-panel')).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: 'New post', exact: true }).click()
      await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
      await page.getByRole('textbox', { name: 'Slug' }).fill(slug)
      await expectToolbarTrailer(page, 'Open live page')

      const liveEntry = await openToolbarLivePage(page)
      try {
        expect(new URL(liveEntry.url()).pathname).toBe(`/posts/${slug}`)
      } finally {
        await liveEntry.close()
      }
    })

    await test.step('leaving content clears the entry target back to the live site root', async () => {
      await page.getByTestId('toolbar').getByRole('link', { name: 'Dashboard' }).click()
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
      await expectToolbarTrailer(page, 'Open live site')

      const liveSite = await openToolbarLivePage(page)
      try {
        expect(new URL(liveSite.url()).pathname).toBe('/')
      } finally {
        await liveSite.close()
      }
    })

    await test.step('global toolbar trailer remains contained on phone width', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
      await expectToolbarTrailer(page, 'Open live site')
      await expectPageContained(page)
      await expectLocatorContained(
        page,
        page.getByTestId('toolbar-settings-btn'),
        'mobile toolbar settings button',
      )
      await expectLocatorContained(
        page,
        page.getByTestId('toolbar-open-live-page-btn'),
        'mobile toolbar open live button',
      )
      await expectLocatorContained(
        page,
        page.getByTestId('account-menu-trigger'),
        'mobile toolbar account menu trigger',
      )
    })
  })

  test('recovers workspace panels after resize, close, reload, and mobile viewport changes (ADMIN-005)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const title = `ADMIN-005 Panel ${suffix}`
    const slug = `admin-005-panel-${suffix}`
    let previousLayout: string | null = null

    try {
      await page.goto('/admin/content')
      previousLayout = await page.evaluate((key) => localStorage.getItem(key), EDITOR_LAYOUT_STORAGE_KEY)
      await page.evaluate((key) => localStorage.removeItem(key), EDITOR_LAYOUT_STORAGE_KEY)
      await page.reload()
      await expect(page.getByTestId('content-explorer-panel')).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: 'New post', exact: true }).click()
      await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
      await page.getByRole('textbox', { name: 'Slug' }).fill(slug)
      await expect(page.getByTestId('content-settings-panel')).toBeVisible()

      const leftSidebar = page.getByTestId('left-sidebar')
      const rightSidebar = page.getByTestId('right-sidebar')
      await expect(leftSidebar).toHaveAttribute('data-expanded', 'true')
      await expect(rightSidebar).toHaveAttribute('data-expanded', 'true')

      await test.step('keyboard resize updates both panel widths and persists them', async () => {
        const leftResize = page.getByRole('separator', { name: 'Resize content sidebar' })
        await leftResize.focus()
        await page.keyboard.press('End')
        await expect(leftResize).toHaveAttribute('aria-valuenow', '520')

        const rightResize = page.getByRole('separator', { name: 'Resize right sidebar' })
        await rightResize.focus()
        await page.keyboard.press('Home')
        await expect(rightResize).toHaveAttribute('aria-valuenow', '300')

        await expectStoredWorkspaceLayout(page, {
          leftWidth: 520,
          rightWidth: 300,
          rightOpen: true,
          activeLeftPanel: 'content',
        })
      })

      await test.step('closed panels expose stable reopen affordances', async () => {
        await page.getByTestId('panel-close-content-settings').click()
        await expect(rightSidebar).toHaveAttribute('data-expanded', 'false')
        const settingsNotch = page.getByTestId('content-settings-notch')
        await expect(settingsNotch).toBeVisible()
        await settingsNotch.getByRole('button', { name: 'Open settings panel' }).click()
        await expect(rightSidebar).toHaveAttribute('data-expanded', 'true')
        await expect(page.getByTestId('content-settings-panel')).toBeVisible()

        await page.getByTestId('panel-close-content-explorer').click()
        await expect(leftSidebar).toHaveAttribute('data-expanded', 'false')
        await page.getByTestId('panel-rail-content').click()
        await expect(leftSidebar).toHaveAttribute('data-expanded', 'true')
        await expect(page.getByTestId('content-explorer-panel')).toBeVisible()
      })

      await test.step('layout state survives reload without panel overlap', async () => {
        await page.reload()
        await expect(page.getByTestId('content-explorer-panel')).toBeVisible({ timeout: 20_000 })
        await expect(leftSidebar).toHaveAttribute('data-expanded', 'true')
        await expect(rightSidebar).toHaveAttribute('data-expanded', 'true')
        await expect(page.getByRole('separator', { name: 'Resize content sidebar' })).toHaveAttribute(
          'aria-valuenow',
          '520',
        )
        await expect(page.getByRole('separator', { name: 'Resize right sidebar' })).toHaveAttribute(
          'aria-valuenow',
          '300',
        )
        await expectPageContained(page, { width: 1280, height: 720 })
      })

      await test.step('mobile viewport stays contained with persisted oversized desktop widths', async () => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.reload()
        await expect(page.getByTestId('content-explorer-panel')).toBeVisible({ timeout: 20_000 })
        await expectPageContained(page, { width: 390, height: 844 })
        await expectLocatorContained(
          page,
          page.getByTestId('panel-rail-content'),
          'mobile content rail button',
        )
        await expectLocatorContained(
          page,
          page.getByTestId('panel-close-content-explorer'),
          'mobile content panel close button',
        )
        await expectLocatorContained(
          page,
          page.getByTestId('panel-close-content-settings'),
          'mobile content settings close button',
        )
        await page.getByTestId('panel-close-content-settings').click()
        await expect(rightSidebar).toHaveAttribute('data-expanded', 'false')
        await expectLocatorContained(
          page,
          page.getByTestId('panel-close-content-explorer'),
          'mobile content panel close button after closing settings',
        )
      })
    } finally {
      await page.evaluate(
        ({ key, value }) => {
          if (value === null) localStorage.removeItem(key)
          else localStorage.setItem(key, value)
        },
        { key: EDITOR_LAYOUT_STORAGE_KEY, value: previousLayout },
      ).catch(() => {})
    }
  })
})

/**
 * ADMIN-004 — global Settings modal and local editor preferences.
 *
 * Settings is mounted by every top-level admin layout. This regression opens it
 * from the lightweight Dashboard route, verifies each section renders, mutates
 * representative local preferences through the real controls, confirms reload
 * persistence, confirms corrupted local preference storage falls back cleanly,
 * and checks the modal remains usable at 390px.
 */
test.describe('admin settings', () => {
  test('opens global settings, persists preferences, and stays contained at mobile width (ADMIN-004)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

    const previousPrefs = await page.evaluate((key) => localStorage.getItem(key), EDITOR_PREFS_KEY)

    try {
      await page.evaluate((key) => localStorage.removeItem(key), EDITOR_PREFS_KEY)
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

      await test.step('all Settings sections render from a non-editor route', async () => {
        const dialog = await openSettings(page)

        const general = dialog.getByRole('region', { name: 'General' })
        await expect(general.getByLabel('Site Name')).toBeVisible({ timeout: 20_000 })
        await expect(general.getByLabel('Meta Title')).toBeVisible()
        await expect(general.getByLabel('Language')).toBeVisible()

        await switchSettingsSection(dialog, 'Shortcuts')
        const shortcuts = dialog.getByRole('region', { name: 'Shortcuts' })
        await expect(shortcuts.getByText('Global', { exact: true })).toBeVisible()
        await expect(shortcuts.getByText('Editor', { exact: true })).toBeVisible()

        await switchSettingsSection(dialog, 'Publishing')
        const publishing = dialog.getByRole('region', { name: 'Publishing' })
        await expect(publishing.getByText('Runtime', { exact: true })).toBeVisible()
        await expect(publishing.getByText('/admin', { exact: true })).toBeVisible()
        await expect(
          publishing.getByRole('switch', {
            name: 'Tree-shake generated framework utilities',
          }),
        ).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      })

      await test.step('preference controls write and reload from local storage', async () => {
        const dialog = await openSettings(page, 'Preferences')
        const autoSave = dialog.getByRole('switch', { name: 'Auto-save' })
        const delay = dialog.getByRole('combobox', { name: 'Auto-save delay' })
        const theme = dialog.getByRole('combobox', { name: 'Theme' })
        const density = dialog.getByRole('combobox', { name: 'UI density' })
        const textSize = dialog.getByRole('combobox', { name: 'UI text size' })

        await expect(autoSave).toHaveAttribute('aria-checked', 'true')
        await expect(delay).toHaveValue('30 seconds')
        await expect(theme).toHaveValue('Dark')
        await expect(density).toHaveValue('Compact')
        await expect(textSize).toHaveValue('Default')

        await autoSave.click()
        await expect(autoSave).toHaveAttribute('aria-checked', 'false')
        await chooseComboboxOption(page, delay, '15 seconds')
        await chooseComboboxOption(page, theme, 'Light')
        await chooseComboboxOption(page, density, 'Comfortable')
        await chooseComboboxOption(page, textSize, 'Large')

        const savedPrefs = await page.evaluate((key) => {
          const raw = localStorage.getItem(key)
          return raw ? JSON.parse(raw) as Record<string, unknown> : {}
        }, EDITOR_PREFS_KEY)
        expect(savedPrefs.autoSave).toBe(false)
        expect(savedPrefs.autoSaveDelay).toBe('15')
        expect(savedPrefs.theme).toBe('light')
        expect(savedPrefs.density).toBe('comfortable')
        expect(savedPrefs.textScale).toBe('large')

        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()

        await page.reload()
        await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
        const reloadedDialog = await openSettings(page, 'Preferences')
        await expect(reloadedDialog.getByRole('switch', { name: 'Auto-save' })).toHaveAttribute(
          'aria-checked',
          'false',
        )
        await expect(
          reloadedDialog.getByRole('combobox', { name: 'Auto-save delay' }),
        ).toHaveValue('15 seconds')
        await expect(reloadedDialog.getByRole('combobox', { name: 'Theme' })).toHaveValue(
          'Light',
        )
        await expect(reloadedDialog.getByRole('combobox', { name: 'UI density' })).toHaveValue(
          'Comfortable',
        )
        await expect(reloadedDialog.getByRole('combobox', { name: 'UI text size' })).toHaveValue(
          'Large',
        )
        await page.keyboard.press('Escape')
        await expect(reloadedDialog).toBeHidden()
      })

      await test.step('corrupted local preference storage falls back to defaults', async () => {
        await page.evaluate((key) => localStorage.setItem(key, '{bad json'), EDITOR_PREFS_KEY)
        await page.reload()
        await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

        const dialog = await openSettings(page, 'Preferences')
        await expect(dialog.getByRole('switch', { name: 'Auto-save' })).toHaveAttribute(
          'aria-checked',
          'true',
        )
        await expect(dialog.getByRole('combobox', { name: 'Auto-save delay' })).toHaveValue(
          '30 seconds',
        )
        await expect(dialog.getByRole('combobox', { name: 'Theme' })).toHaveValue('Dark')
        await expect(dialog.getByRole('combobox', { name: 'UI density' })).toHaveValue('Compact')
        await expect(dialog.getByRole('combobox', { name: 'UI text size' })).toHaveValue('Default')
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      })

      await test.step('settings modal remains usable at phone width', async () => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.reload()
        await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

        const dialog = await openSettings(page, 'Preferences')
        const preferences = dialog.getByRole('region', { name: 'Preferences' })
        await expect(preferences.getByRole('switch', { name: 'Auto-save' })).toBeVisible()
        await expect(preferences.getByRole('combobox', { name: 'Theme' })).toBeVisible()
        await expect(preferences.getByRole('combobox', { name: 'UI density' })).toBeVisible()
        await expect(preferences.getByRole('combobox', { name: 'UI text size' })).toBeVisible()
        await expectPageContained(page)
        await expectLocatorContained(
          page,
          dialog.getByRole('button', { name: 'Preferences' }),
          'mobile settings Preferences tab',
        )
        await expectLocatorContained(
          page,
          preferences.getByRole('switch', { name: 'Auto-save' }),
          'mobile settings Auto-save switch',
        )
        await expectLocatorContained(
          page,
          preferences.getByRole('combobox', { name: 'Theme' }),
          'mobile settings theme combobox',
        )
        await expectLocatorContained(
          page,
          preferences.getByRole('combobox', { name: 'UI density' }),
          'mobile settings density combobox',
        )
        await expectLocatorContained(
          page,
          preferences.getByRole('combobox', { name: 'UI text size' }),
          'mobile settings text-size combobox',
        )
      })
    } finally {
      await page.evaluate(
        ({ key, value }) => {
          if (value === null) localStorage.removeItem(key)
          else localStorage.setItem(key, value)
        },
        { key: EDITOR_PREFS_KEY, value: previousPrefs },
      ).catch(() => {})
    }
  })
})

/** Click a section link in the toolbar and confirm the workspace took over. */
async function navigateSection(
  page: Page,
  name: string,
  path: string,
): Promise<void> {
  await test.step(`navigate to ${name}`, async () => {
    await page.getByTestId('toolbar').getByRole('link', { name }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expectActiveSection(page, name)
  })
}

/** The active section is the only nav item rendered as text instead of a link. */
async function expectActiveSection(page: Page, name: string): Promise<void> {
  const toolbar = page.getByTestId('toolbar')
  await expect(toolbar.getByRole('link', { name })).toHaveCount(0)
  await expect(toolbar.getByText(name, { exact: true })).toBeVisible()
}

async function openSettings(page: Page, section?: string): Promise<Locator> {
  await page.getByTestId('toolbar-settings-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  if (section) {
    await switchSettingsSection(dialog, section)
  }
  return dialog
}

async function switchSettingsSection(dialog: Locator, section: string): Promise<void> {
  await dialog.getByRole('button', { name: section }).click()
  await expect(dialog.getByRole('region', { name: section })).toBeVisible()
}

async function expectToolbarTrailer(page: Page, openLiveLabel: string): Promise<void> {
  const toolbar = page.getByTestId('toolbar')
  await expect(toolbar.getByTestId('toolbar-settings-btn')).toBeVisible()
  await expect(toolbar.getByTestId('toolbar-settings-btn')).toHaveAttribute(
    'aria-label',
    'Open settings',
  )
  await expect(toolbar.getByTestId('toolbar-open-live-page-btn')).toBeVisible()
  await expect(toolbar.getByTestId('toolbar-open-live-page-btn')).toHaveAttribute(
    'aria-label',
    openLiveLabel,
  )
  await expect(toolbar.getByTestId('account-menu-trigger')).toBeVisible()
}

async function openToolbarLivePage(page: Page): Promise<Page> {
  const [livePage] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByTestId('toolbar-open-live-page-btn').click(),
  ])
  await livePage.waitForLoadState('domcontentloaded')
  return livePage
}

async function chooseComboboxOption(
  page: Page,
  combobox: Locator,
  optionName: string,
): Promise<void> {
  await combobox.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(combobox).toHaveValue(optionName)
  await expect(combobox).toBeFocused()
}

async function expectPageContained(
  page: Page,
  viewport: { width: number, height: number } = { width: 390, height: 844 },
): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      viewportWidth: doc.clientWidth,
      viewportHeight: window.innerHeight,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    }
  })
  expect(metrics.viewportWidth).toBe(viewport.width)
  expect(metrics.viewportHeight).toBe(viewport.height)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
}

async function expectLocatorContained(
  page: Page,
  locator: Locator,
  description: string,
): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${description} was visible but had no bounding box`)
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth)
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1)
}

async function expectStoredWorkspaceLayout(
  page: Page,
  expected: {
    leftWidth: number
    rightWidth: number
    rightOpen: boolean
    activeLeftPanel: string
  },
): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const parsed = JSON.parse(raw) as {
        workspaces?: {
          content?: {
            leftWidth?: number
            rightWidth?: number
            rightOpen?: boolean
            activeLeftPanel?: string | null
          }
        }
      }
      return parsed.workspaces?.content ?? null
    }, EDITOR_LAYOUT_STORAGE_KEY)
  }).toMatchObject(expected)
}
