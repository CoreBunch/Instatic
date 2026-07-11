import { expect, test, type Locator, type Page } from '@playwright/test'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const DashboardLayoutSaveItemSchema = Type.Object({
  id: Type.String(),
  col: Type.Optional(Type.Number()),
  row: Type.Optional(Type.Number()),
  size: Type.Optional(Type.Number()),
  rows: Type.Optional(Type.Number()),
})

const DashboardLayoutSaveBodySchema = Type.Object({
  value: Type.Object({
    items: Type.Array(DashboardLayoutSaveItemSchema),
    onboardingDismissed: Type.Boolean(),
  }),
})

type DashboardLayoutSaveBody = Static<typeof DashboardLayoutSaveBodySchema>
type DashboardLayoutSaveItem = Static<typeof DashboardLayoutSaveItemSchema>

/**
 * DASH-001 - dashboard overview metrics.
 *
 * The dashboard is intentionally progressive: each widget owns a small API
 * fetch and renders once that domain resolves. This smoke proves the default
 * first-party layout appears from a clean owner session, the dynamic widgets
 * leave their loading state, the main range/customize controls respond, and
 * the same surface stays contained on a 390px mobile viewport.
 */
test.describe('dashboard', () => {
  test('renders first-party metric widgets and mobile layout (DASH-001)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')
    await expect(page).toHaveURL(/\/admin\/dashboard$/)

    await test.step('dashboard chrome and controls render', async () => {
      await expect(page.getByText('Admin').first()).toBeVisible()
      await expect(page.getByText('Dashboard', { exact: true }).first()).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
      await expect(page.getByText('09 blocks')).toBeVisible()

      const rangeTabs = page.getByRole('tablist', { name: 'Time range' })
      await expect(rangeTabs).toBeVisible()
      await expect(rangeTabs.getByRole('tab', { name: 'Today' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      await rangeTabs.getByRole('tab', { name: '7d' }).click()
      await expect(rangeTabs.getByRole('tab', { name: '7d' })).toHaveAttribute(
        'aria-selected',
        'true',
      )

      await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Add block' })).toBeVisible()
    })

    await test.step('default first-party widgets load their data', async () => {
      const storage = await expectWidget(page, 'storage', 'Storage')
      await expectLoaded(storage)
      await expect(storage).toContainText(/used.*SQLite.*self-hosted/)

      const pages = await expectWidget(page, 'pages', 'Pages')
      await expectLoaded(pages)
      await expect(pages).toContainText('Published')
      await expect(pages).toContainText(/draft/)
      await expect(pages).toContainText('scheduled')

      const posts = await expectWidget(page, 'posts', 'Posts')
      await expectLoaded(posts)
      await expect(posts).toContainText(/Total/)

      const media = await expectWidget(page, 'media', 'Media')
      await expectLoaded(media)
      await expect(media).toContainText(/files/)

      const status = await expectWidget(page, 'status', 'Status')
      await expect(status).toContainText('Site')
      await expect(status).toContainText('Live')

      const activity = await expectWidget(page, 'activity', 'Activity')
      await expectLoaded(activity)

      const publish = await expectWidget(page, 'publish', 'Publish lineup')
      await expectLoaded(publish)

      const plugins = await expectWidget(page, 'plugins', 'Plugins')
      await expectLoaded(plugins)

      const domain = await expectWidget(page, 'domain', 'Domain')
      await expect(domain).toContainText('instatic.com')
      await expect(domain).toContainText('HTTPS')
    })

    await test.step('mobile dashboard remains contained', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
      await expect(page.locator('[data-widget="storage"]')).toBeVisible()
      await expectPageContained(page)
      await expectControlContained(
        page,
        page.getByRole('tablist', { name: 'Time range' }),
        'time range tabs',
      )
      await expectControlContained(
        page,
        page.getByRole('button', { name: 'Customize' }),
        'customize button',
      )
      await expectControlContained(
        page,
        page.getByRole('button', { name: 'Add block' }),
        'add block button',
      )
    })
  })

  test('customizes the widget grid and persists changes (DASH-002)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')
    await expect(page).toHaveURL(/\/admin\/dashboard$/)
    await expect(page.getByText('09 blocks')).toBeVisible()
    await expect(gridWidget(page, 'ai-usage')).toHaveCount(0)

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Add block' }).first().click()
    const library = page.getByRole('dialog', { name: 'Block library' })
    await expect(library).toBeVisible()
    await expect(library.getByRole('button', { name: 'Add AI usage to dashboard' })).toBeVisible()

    const addBody = await waitForDashboardLayoutSave(page, async () => {
      await library.getByRole('button', { name: 'Add AI usage to dashboard' }).click()
    })
    const addedItem = requireSavedDashboardItem(addBody, 'ai-usage')
    expect(addedItem.size).toBe(3)
    expect(addedItem.rows).toBe(3)
    await expect(page.getByText('10 blocks')).toBeVisible()
    await expect(gridWidget(page, 'ai-usage')).toBeVisible()
    await expect(library).toContainText('Every block is on your dashboard.')

    await page.getByRole('button', { name: 'Close block library' }).click()
    await expect(library).toBeHidden()

    await page.reload()
    await expect(page.getByText('10 blocks')).toBeVisible()
    await expect(gridWidget(page, 'ai-usage')).toBeVisible()

    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' }).first()).toBeVisible()

    const aiCell = gridCell(page, 'ai-usage')
    await aiCell.scrollIntoViewIfNeeded()
    const moveBody = await waitForDashboardLayoutSave(page, async () => {
      await dragLocatorBy(page, aiCell, 320, 0)
    })
    const movedItem = requireSavedDashboardItem(moveBody, 'ai-usage')
    expect(movedItem.col).toBeGreaterThan(1)
    await expect(aiCell).toHaveAttribute('data-col', String(movedItem.col))

    const resizeBody = await waitForDashboardLayoutSave(page, async () => {
      await dragLocatorBy(page, page.getByLabel('Resize AI usage from right'), 220, 0)
    })
    const resizedItem = requireSavedDashboardItem(resizeBody, 'ai-usage')
    expect(resizedItem.size).toBeGreaterThan(3)
    await expect(gridWidget(page, 'ai-usage')).toHaveAttribute(
      'data-span',
      String(resizedItem.size),
    )

    const removeBody = await waitForDashboardLayoutSave(page, async () => {
      await dragWidgetToLibrary(page, aiCell)
    })
    expect(findSavedDashboardItem(removeBody, 'ai-usage')).toBeUndefined()
    await expect(page.getByText('09 blocks')).toBeVisible()
    await expect(gridWidget(page, 'ai-usage')).toHaveCount(0)

    await page.reload()
    await expect(page.getByText('09 blocks')).toBeVisible()
    await expect(gridWidget(page, 'ai-usage')).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByText('09 blocks')).toBeVisible()
    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(page.getByRole('button', { name: 'Done' }).first()).toBeVisible()
    await expectPageContained(page)
    await page.getByRole('button', { name: 'Add block' }).first().click()
    const mobileLibrary = page.getByRole('dialog', { name: 'Block library' })
    await expect(mobileLibrary).toBeVisible()
    await expectControlContained(page, mobileLibrary, 'mobile block library')
    await expect(mobileLibrary.getByLabel('Search blocks')).toBeVisible()
    await expect(
      mobileLibrary.getByRole('button', { name: 'Add AI usage to dashboard' }),
    ).toBeVisible()
  })

  test('shows onboarding tasks, routes actions, and persists dismiss (DASH-003)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')
    await expect(page).toHaveURL(/\/admin\/dashboard$/)

    const panel = onboardingPanel(page)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel).toContainText('1 of 5 steps complete.')

    await expectOnboardingStep(panel, 'Set site identity', 'Completed', 'Open settings')
    await expectOnboardingStep(panel, 'Choose Core Framework import', 'In progress', 'Import')
    await expectOnboardingStep(panel, 'Create your first page', 'Not started', 'New page')
    await expectOnboardingStep(panel, 'Install a plugin', 'Not started', 'Browse plugins')
    await expectOnboardingStep(panel, 'Invite your team', 'Not started', 'Add members')

    await test.step('step actions route to the expected workspaces', async () => {
      await panel.getByRole('button', { name: 'Open settings' }).click()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden()

      await panel.getByRole('button', { name: 'New page' }).click()
      await expect(page).toHaveURL(/\/admin\/site$/)
      await page.goto('/admin/dashboard')
      await expect(panel).toBeVisible({ timeout: 20_000 })

      await panel.getByRole('button', { name: 'Browse plugins' }).click()
      await expect(page).toHaveURL(/\/admin\/plugins$/)
      await page.goto('/admin/dashboard')
      await expect(panel).toBeVisible({ timeout: 20_000 })

      await panel.getByRole('button', { name: 'Add members' }).click()
      await expect(page).toHaveURL(/\/admin\/users$/)
      await page.goto('/admin/dashboard')
      await expect(panel).toBeVisible({ timeout: 20_000 })
    })

    await test.step('mobile task layout stays contained', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload()
      await expect(panel).toBeVisible({ timeout: 20_000 })
      await expectPageContained(page)
      await expectControlContained(page, panel, 'mobile onboarding panel')
      await expectControlContained(
        page,
        onboardingStep(panel, 'Invite your team').getByRole('button', { name: 'Add members' }),
        'mobile add members action',
      )
    })

    await test.step('dismiss persists through the dashboard layout preference', async () => {
      const dismissBody = await waitForDashboardLayoutSave(page, async () => {
        await panel.getByRole('button', { name: 'Dismiss' }).click()
      })
      expect(dismissBody.value.onboardingDismissed).toBe(true)
      await expect(panel).toHaveCount(0)

      await page.reload()
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
      await expect(
        page.getByRole('heading', { name: 'Finish setting up your site' }),
      ).toHaveCount(0)
    })
  })
})

async function expectWidget(page: Page, id: string, title: string): Promise<Locator> {
  const widget = page.locator(`[data-widget="${id}"]`)
  await expect(widget).toBeVisible({ timeout: 20_000 })
  await expect(widget).toContainText(title)
  return widget
}

function gridWidget(page: Page, id: string): Locator {
  return page.locator(`[data-col] [data-widget="${id}"]`)
}

function gridCell(page: Page, id: string): Locator {
  return gridWidget(page, id).locator('xpath=ancestor::*[@data-col][1]')
}

function onboardingPanel(page: Page): Locator {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Finish setting up your site' }),
  })
}

function onboardingStep(panel: Locator, title: string): Locator {
  return panel.locator('li').filter({ hasText: title })
}

async function expectOnboardingStep(
  panel: Locator,
  title: string,
  state: string,
  action: string,
): Promise<void> {
  const step = onboardingStep(panel, title)
  await expect(step).toBeVisible()
  await expect(step).toContainText(state)
  await expect(step.getByRole('button', { name: action })).toBeVisible()
}

async function waitForDashboardLayoutSave(
  page: Page,
  action: () => Promise<void>,
): Promise<DashboardLayoutSaveBody> {
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/admin/api/cms/me/preferences/dashboard-layout') &&
    response.request().method() === 'PUT' &&
    response.status() === 200,
  )
  await action()
  const response = await responsePromise
  return Value.Parse(DashboardLayoutSaveBodySchema, await response.json())
}

function findSavedDashboardItem(
  body: DashboardLayoutSaveBody,
  id: string,
): DashboardLayoutSaveItem | undefined {
  return body.value?.items?.find((item) => item.id === id)
}

function requireSavedDashboardItem(
  body: DashboardLayoutSaveBody,
  id: string,
): DashboardLayoutSaveItem {
  const item = findSavedDashboardItem(body, id)
  if (!item) throw new Error(`Expected saved dashboard layout to include ${id}`)
  return item
}

async function dragLocatorBy(
  page: Page,
  locator: Locator,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Cannot drag locator without a bounding box')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 12 })
  await page.mouse.up()
}

async function dragWidgetToLibrary(page: Page, widgetCell: Locator): Promise<void> {
  const box = await widgetCell.boundingBox()
  if (!box) throw new Error('Cannot remove widget without a bounding box')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, Math.min(startY + 40, 760), { steps: 4 })

  const pill = page.getByRole('dialog', { name: /Block library/ })
  await expect(pill).toBeVisible()
  const pillBox = await pill.boundingBox()
  if (!pillBox) throw new Error('Block library drop zone had no bounding box')
  await page.mouse.move(pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height / 2, {
    steps: 12,
  })
  await page.mouse.up()
}

async function expectLoaded(widget: Locator): Promise<void> {
  await expect(widget).not.toHaveAttribute('aria-busy', 'true', {
    timeout: 20_000,
  })
}

async function expectPageContained(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      viewportWidth: doc.clientWidth,
      viewportHeight: window.innerHeight,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    }
  })
  expect(metrics.viewportWidth).toBe(390)
  expect(metrics.viewportHeight).toBe(844)
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1)
}

async function expectControlContained(
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
