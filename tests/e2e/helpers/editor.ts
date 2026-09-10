import { expect, type FrameLocator, type Page } from '@playwright/test'
import { OWNER } from './constants'

/**
 * Site editor / visual builder helpers. Each one is a small wrapper around the
 * durable controls a user actually clicks: the toolbar, the canvas notch, the
 * layers tree, and the properties panel.
 *
 * Editor/canvas controls are addressed by `data-testid` where an accessible
 * name is not practical (canvas notch buttons, toolbar publish actions, the
 * step-up dialog). User-facing surfaces (login, dialogs, the layers tree) are
 * addressed by role/label.
 */

/** The editor is ready once the canvas surface and its insert notch are shown. */
export async function expectEditorReady(page: Page): Promise<void> {
  await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('canvas-notch')).toBeVisible()
}

/** Open the Site workspace (visual editor) and wait for it to be ready. */
export async function openSiteEditor(page: Page): Promise<void> {
  const alreadyOpen = await page
    .getByTestId('canvas-root')
    .isVisible({ timeout: 1_000 })
    .catch(() => false)
  if (!alreadyOpen) {
    await page.goto('/admin/site')
  }
  await expectEditorReady(page)
}

/** The default Desktop design-mode canvas iframe. */
export function canvasFrame(page: Page): FrameLocator {
  return canvasFrameForBreakpoint(page, 'desktop')
}

/** A design-mode canvas iframe for a specific breakpoint. */
export function canvasFrameForBreakpoint(
  page: Page,
  breakpointId: string,
): FrameLocator {
  return page
    .getByTestId(`canvas-frame-${breakpointId}`)
    .frameLocator('iframe[title^="Canvas frame"]')
}

/**
 * Insert one of the favourite modules exposed directly on the canvas notch
 * (container, text, image). Returns once the module is on the canvas and
 * selected (its property controls are visible).
 */
export async function insertNotchModule(
  page: Page,
  module: 'container' | 'text' | 'image',
): Promise<void> {
  await page.getByTestId(`canvas-notch-${module}-btn`).click()
}

/**
 * Insert any registered module through the full module picker dialog. Modules
 * that are not notch favourites (button, link, …) go through here. The dialog
 * items carry a stable `data-module-id`, so we pick by module id rather than by
 * the localized item label.
 */
export async function insertModuleViaPicker(
  page: Page,
  moduleId: string,
): Promise<void> {
  await page.getByTestId('canvas-notch-add-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Add to canvas' })
  await expect(dialog).toBeVisible()
  await dialog.locator(`[data-module-id="${moduleId}"]`).first().click()
  await expect(dialog).toBeHidden()
}

/**
 * Open the Layers panel (the page element tree) from the left panel dock. The
 * editor opens to it by default, but opening the Site panel hides it.
 */
export async function openLayersPanel(page: Page): Promise<void> {
  const tree = page.getByRole('tree', { name: 'Page element tree' })
  if (!(await tree.isVisible().catch(() => false))) {
    const explorer = page.getByRole('complementary', { name: 'Explorer' })
    if (!(await explorer.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Open Explorer panel' }).click()
    }
    await explorer.getByRole('button', { name: 'Layers', exact: true }).click()
  }
  await expect(tree).toBeVisible()
}

type ExplorerTab = 'Site' | 'Code' | 'Media'

/** Open one of the consolidated Explorer tabs and wait for it to become active. */
export async function openExplorerTab(page: Page, tab: ExplorerTab): Promise<void> {
  const explorer = page.getByRole('complementary', { name: 'Explorer' })
  if (!(await explorer.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Open Explorer panel' }).click()
  }

  const tabButton = explorer.getByRole('button', { name: tab, exact: true })
  if ((await tabButton.getAttribute('aria-pressed')) !== 'true') {
    await tabButton.click()
  }
  await expect(tabButton).toHaveAttribute('aria-pressed', 'true')
}

/** Open the Code Explorer tab (stylesheets + scripts). */
export async function openCodePanel(page: Page): Promise<void> {
  await openExplorerTab(page, 'Code')
  await expect(
    page.getByRole('button', { name: 'New stylesheet', exact: true }),
  ).toBeVisible()
}

/** Select a layer in the DOM/layers tree by its display name. */
export async function selectTreeLayer(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name }).first().click()
}

/**
 * Edit a property control. Controls render `id="ctrl-<prop>"` inputs inside a
 * `data-testid="property-control-<prop>"` wrapper. Waits for the wrapper so the
 * correct node is selected before typing.
 */
export async function setPropValue(
  page: Page,
  prop: string,
  value: string,
): Promise<void> {
  await expect(page.getByTestId(`property-control-${prop}`)).toBeVisible()
  await page.locator(`#ctrl-${prop}`).fill(value)
}

/**
 * Open the Site Explorer panel (pages + structure) from the left panel dock.
 * The editor opens to the Layers panel by default, so page management starts
 * here.
 */
export async function openSitePanel(page: Page): Promise<void> {
  const newPageButton = page.getByRole('button', { name: 'New page', exact: true })
  await openExplorerTab(page, 'Site')
  await expect(newPageButton).toBeVisible()
}

/**
 * Create a new page from the Site Explorer and open it in the canvas. Returns
 * once the new page's tree item is selected. Assumes the Site editor is open.
 */
export async function createPage(
  page: Page,
  name: string,
  slug: string,
): Promise<void> {
  await openSitePanel(page)
  await page.getByRole('button', { name: 'New page', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New page' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Slug').fill(slug)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('treeitem', { name: `Open page ${name}` }),
  ).toBeVisible()
}

/**
 * Delete a template from the Site Explorer by its title, confirming the
 * prompt. Assumes the Site editor is open.
 *
 * Every spec that publishes a Posts template MUST call this before it ends.
 * The suite shares one database, and the template chain keeps at most one
 * template per breadth level (highest priority, then document order), so a
 * template left behind decides which template every later spec's entry route
 * renders through. One leaked priority-300 template is enough to make an
 * unrelated spec's public-route assertion fail depending on run order.
 */
export async function deleteTemplate(page: Page, name: string): Promise<void> {
  await openSitePanel(page)
  const item = page.getByRole('treeitem', { name: `Open template ${name}` })
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  // Templates are pages, so the explorer's page prompt is the one that opens.
  const dialog = page.getByRole('alertdialog', { name: 'Delete page?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete page' }).click()
  await expect(item).toHaveCount(0)
}

/**
 * Publish the current draft. Publishing is a sensitive action that may require
 * a fresh-password step-up; this satisfies the prompt with the owner password
 * when it appears, then waits for the button to report "Published".
 */
export async function publishDraft(page: Page): Promise<void> {
  const publishButton = page.getByTestId('toolbar-publish-btn')
  await publishButton.click()

  const stepUpDialog = page.getByTestId('step-up-dialog')
  const stepUpOpened = await stepUpDialog
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true, () => false)
  if (stepUpOpened) {
    await page.getByTestId('step-up-password').fill(OWNER.password)
    await page.getByTestId('step-up-confirm').click()
    await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
  }

  await expect(publishButton).toHaveText(/Published/, { timeout: 30_000 })
}
