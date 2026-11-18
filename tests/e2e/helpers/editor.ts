import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test'
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
  const explorer = await ensureExplorerOpen(page)
  if (!(await tree.isVisible())) {
    await explorer.getByRole('button', { name: 'Layers', exact: true }).click()
  }
  await expect(tree).toBeVisible()
}

/**
 * Make sure the Explorer panel is open, and return it.
 *
 * The editor remounts its panels whenever it reloads a document: right after a
 * branch is created or switched, the Explorer is gone for a moment and then
 * comes back open. A single "is it visible?" check taken in that moment would
 * conclude the panel is closed and wait for an "Open Explorer panel" button
 * that never appears. So this retries: each pass re-reads the state, and only
 * clicks the button while the panel really is closed.
 */
async function ensureExplorerOpen(page: Page): Promise<Locator> {
  const explorer = page.getByRole('complementary', { name: 'Explorer' })
  const openButton = page.getByRole('button', { name: 'Open Explorer panel' })
  await expect(async () => {
    if (!(await explorer.isVisible())) await openButton.click({ timeout: 1_000 })
    await expect(explorer).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  return explorer
}

type ExplorerTab = 'Site' | 'Code' | 'Media'

/** Open one of the consolidated Explorer tabs and wait for it to become active. */
export async function openExplorerTab(page: Page, tab: ExplorerTab): Promise<void> {
  const explorer = await ensureExplorerOpen(page)

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

/**
 * Create a site stylesheet from the Code Explorer and type `css` into it.
 * Returns once the Code Editor shows the text and the store has synced it.
 */
export async function createStylesheet(page: Page, name: string, css: string): Promise<void> {
  await openCodePanel(page)
  const newStylesheet = page.getByRole('button', { name: 'New stylesheet', exact: true })
  await newStylesheet.scrollIntoViewIfNeeded()
  await newStylesheet.click()

  const dialog = page.getByRole('dialog', { name: 'New stylesheet' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByRole('complementary', { name: 'Code Editor' })).toBeVisible()
  await expect(page.getByLabel('Stylesheet settings')).toBeVisible()

  const editor = page.locator('[data-codemirror-container] .cm-content')
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.click()
  const text = css.trim()
  await page.keyboard.insertText(text)

  // CodeMirror syncs into the editor store through a short debounce.
  await expect(editor).toContainText(text.split('\n')[0]!)
  await page.waitForTimeout(300)
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

/**
 * A template priority higher than any template created earlier in the suite.
 *
 * The whole suite shares one site, and a Posts entry route is rendered through
 * the highest-priority matching template. A spec that authors its own Posts
 * template must therefore outrank every template an earlier spec left behind,
 * or its post renders through someone else's template. Seconds since a fixed
 * epoch grow with creation order, whatever order the spec files run in.
 */
export function newestTemplatePriority(): number {
  return Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000)
}
