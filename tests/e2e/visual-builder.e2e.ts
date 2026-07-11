import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  canvasFrameForBreakpoint,
  completeStepUp,
  createPage,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  openLayersPanel,
  openSitePanel,
  openSiteEditor,
  publishDraft,
  saveDraft,
  selectTreeLayer,
  setPropValue,
  visitPublicPage,
} from './helpers'

/**
 * BUILDER-001 / BUILDER-002 / BUILDER-007 / EDIT-002 — insert modules,
 * select a node, edit properties, and verify breakpoint-scoped variants.
 *
 * Every test works on its own freshly-created page so module inserts never touch
 * the homepage or interfere with one another on the shared database.
 */
test.describe('visual builder', () => {
  test('inserts container, text, and image modules (BUILDER-001)', async ({
    page,
  }) => {
    await openBlankPage(page, 'Builder insert')

    await insertNotchModule(page, 'container')
    await insertNotchModule(page, 'text')
    await insertNotchModule(page, 'image')

    await openLayersPanel(page)
    const tree = page.getByRole('tree', { name: 'Page element tree' })
    await expect(tree.getByRole('treeitem', { name: 'Container' })).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'Text' })).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'Image' })).toBeVisible()
  })

  test('searches the module picker, inserts by keyboard, and remembers recents/view (SITE-005)', async ({
    page,
  }) => {
    await openBlankPage(page, 'Module picker')

    await page.getByTestId('canvas-notch-add-btn').click()
    let dialog = page.getByRole('dialog', { name: 'Add to canvas' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await dialog.getByRole('searchbox', { name: 'Search modules' }).fill('button')
    await expect(dialog.locator('[data-module-id="base.button"]')).toBeVisible()
    await expect(dialog.locator('[data-module-id="base.text"]')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()

    await openLayersPanel(page)
    await expect(
      page.getByRole('tree', { name: 'Page element tree' }).getByRole('treeitem', {
        name: 'Button',
      }),
    ).toBeVisible()

    await page.getByTestId('canvas-notch-add-btn').click()
    dialog = page.getByRole('dialog', { name: 'Add to canvas' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Recent' }).click()
    await expect(dialog.locator('[data-module-id="base.button"]')).toBeVisible()

    await dialog.getByRole('button', { name: 'List view' }).click()
    await expect(dialog.getByRole('button', { name: 'List view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Moving off the view toggle dismisses its tooltip so Escape reaches the
    // picker dialog instead of being capture-consumed by the tooltip.
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await page.getByTestId('canvas-notch-add-btn').click()
    dialog = page.getByRole('dialog', { name: 'Add to canvas' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'List view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('drags a module picker item into a canvas container (SITE-005 drag)', async ({
    page,
  }) => {
    const nestedText = `Dropped into container ${Date.now().toString(36)}`

    await openBlankPage(page, 'Module picker drag')
    await insertNotchModule(page, 'container')
    await openLayersPanel(page)

    const containerRow = page
      .getByRole('tree', { name: 'Page element tree' })
      .getByRole('treeitem', { name: 'Container' })
    const containerNodeId = await containerRow.getAttribute('data-instatic-node-id')
    expect(containerNodeId, 'Container row should expose a canvas node id').toBeTruthy()

    const containerCanvas = canvasFrame(page).locator(
      `[data-node-id="${containerNodeId}"]`,
    )
    await expect(containerCanvas.getByText('Empty container', { exact: true })).toBeVisible()
    const containerBox = await containerCanvas.boundingBox()
    expect(containerBox, 'Canvas Container needs a measurable drop target').not.toBeNull()

    await page.getByTestId('canvas-notch-add-btn').click()
    const dialog = page.getByRole('dialog', { name: 'Add to canvas' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('searchbox', { name: 'Search modules' }).fill('text')

    const textItem = dialog.locator('[data-module-id="base.text"]')
    await expect(textItem).toBeVisible()
    const start = await centerOf(textItem)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 10, start.y + 10, { steps: 4 })
    await page.mouse.move(
      containerBox!.x + containerBox!.width / 2,
      containerBox!.y + containerBox!.height / 2,
      { steps: 12 },
    )
    await expect(page.locator('[data-position="inside"]')).toBeVisible()
    await page.mouse.up()
    await expect(dialog).toBeHidden()

    await setPropValue(page, 'text', nestedText)
    await expect(containerCanvas.getByText(nestedText, { exact: true })).toBeVisible()
  })

  test('selects a node in the tree and edits its text (BUILDER-002)', async ({
    page,
  }) => {
    const headline = 'Selectable headline'
    const edited = 'Edited headline'

    await openBlankPage(page, 'Builder select')

    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', headline)
    await expect(canvasFrame(page).getByText(headline)).toBeVisible()

    // Insert a second module so selection moves away from the text node.
    await insertNotchModule(page, 'image')
    await expect(page.getByTestId('property-control-src')).toBeVisible()

    // Re-select the text node from the layers tree, then edit it again.
    await openLayersPanel(page)
    await selectTreeLayer(page, 'Text')
    await setPropValue(page, 'text', edited)
    await expect(canvasFrame(page).getByText(edited)).toBeVisible()
    await expect(canvasFrame(page).getByText(headline)).toHaveCount(0)
  })

  test('undoes and redoes edits with buttons and shortcuts (BUILDER-005 / SITE-009)', async ({
    page,
  }) => {
    const { name } = await openBlankPage(page, 'Builder history')
    await saveDraft(page)
    await page.reload()
    await openSiteEditor(page)
    await openSitePanel(page)
    const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
    await pageItem.click()
    await expect(pageItem).toHaveAttribute('aria-selected', 'true')

    await openLayersPanel(page)
    const tree = page.getByRole('tree', { name: 'Page element tree' })
    const textNode = tree.getByRole('treeitem', { name: 'Text' })
    const containerNode = tree.getByRole('treeitem', { name: 'Container' })
    const undoButton = page.getByTestId('canvas-notch-undo-btn')
    const redoButton = page.getByTestId('canvas-notch-redo-btn')
    const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

    await expect(undoButton).toHaveAttribute('aria-disabled', 'true')
    await expect(redoButton).toHaveAttribute('aria-disabled', 'true')
    await insertNotchModule(page, 'text')
    await expect(textNode).toBeVisible()
    await expect(undoButton).not.toHaveAttribute('aria-disabled', 'true')
    await expect(redoButton).toHaveAttribute('aria-disabled', 'true')

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press(`${shortcutModifier}+Z`)
    await expect(textNode).toHaveCount(0)
    await expect(undoButton).toHaveAttribute('aria-disabled', 'true')
    await expect(redoButton).not.toHaveAttribute('aria-disabled', 'true')

    await page.keyboard.press(`${shortcutModifier}+Shift+Z`)
    await expect(textNode).toBeVisible()
    await expect(undoButton).not.toHaveAttribute('aria-disabled', 'true')
    await expect(redoButton).toHaveAttribute('aria-disabled', 'true')

    await undoButton.click()
    await expect(textNode).toHaveCount(0)
    await expect(redoButton).not.toHaveAttribute('aria-disabled', 'true')

    await insertNotchModule(page, 'container')
    await expect(containerNode).toBeVisible()
    await expect(textNode).toHaveCount(0)
    await expect(redoButton).toHaveAttribute('aria-disabled', 'true')

    await saveDraft(page)
    await page.reload()
    await openSiteEditor(page)
    await openSitePanel(page)
    await page.getByRole('treeitem', { name: `Open page ${name}` }).click()
    await openLayersPanel(page)
    await expect(containerNode).toBeVisible()
    await expect(textNode).toHaveCount(0)
    await expect(undoButton).toHaveAttribute('aria-disabled', 'true')
    await expect(redoButton).toHaveAttribute('aria-disabled', 'true')
  })

  test('runs direct panel and canvas clipboard shortcuts (BUILDER-005)', async ({
    page,
  }) => {
    await openBlankPage(page, 'Builder shortcuts')

    const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press(`${shortcutModifier}+I`)
    const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
    await expect(assistantPanel).toBeVisible()

    await page.getByTestId('panel-close-agent').click()
    await expect(assistantPanel).toBeHidden()

    const canvasShortcutText = `Canvas shortcut text ${Date.now().toString(36)}`
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', canvasShortcutText)
    await openLayersPanel(page)

    const tree = page.getByRole('tree', { name: 'Page element tree' })
    const textNodes = tree.getByRole('treeitem', { name: 'Text' })
    await expect(textNodes).toHaveCount(1)
    await textNodes.first().click()

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press(`${shortcutModifier}+C`)
    await page.keyboard.press(`${shortcutModifier}+V`)

    await expect(textNodes).toHaveCount(2)

    await textNodes.first().click()
    await expect(textNodes.first()).toBeFocused()
    await page.keyboard.press(`${shortcutModifier}+C`)
    await page.keyboard.press(`${shortcutModifier}+V`)
    await expect(textNodes).toHaveCount(3)

    await textNodes.first().click()
    await expect(textNodes.first()).toBeFocused()
    await page.keyboard.press(`${shortcutModifier}+Backspace`)
    await confirmDeleteIfShown(page, 'Delete layer?')
    await expect(textNodes).toHaveCount(2)

    const canvasText = canvasFrame(page).getByText(canvasShortcutText, { exact: true }).first()
    await canvasText.click()
    await page.keyboard.press(`${shortcutModifier}+C`)
    await page.keyboard.press(`${shortcutModifier}+V`)
    await expect(textNodes).toHaveCount(3)

    await canvasText.click()
    await page.keyboard.press(`${shortcutModifier}+D`)
    await expect(textNodes).toHaveCount(4)

    await canvasText.click()
    await page.keyboard.press(`${shortcutModifier}+Backspace`)
    await confirmDeleteIfShown(page, 'Delete layer?')
    await expect(textNodes).toHaveCount(3)
  })

  test('keeps generated slot layers locked while allowing slot content insertion (BUILDER-003 locked slots)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const componentName = `Slot Guard ${suffix}`
    const slotText = `Slot fill ${suffix}`

    await openBlankPage(page, 'Builder slot guard')
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', 'Reusable component copy')

    await page.getByRole('button', { name: 'Componentize' }).click()
    await page.getByLabel('Component name').fill(componentName)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('vc-mode-control')).toBeVisible()

    await insertModuleViaPicker(page, 'base.slot-outlet')
    await expect(page.getByTestId('property-control-slotName')).toBeVisible()

    await page.getByTestId('vc-mode-control-back').click()
    await expect(page.getByTestId('vc-mode-control')).toHaveCount(0)
    await openLayersPanel(page)

    const tree = page.getByRole('tree', { name: 'Page element tree' })
    const componentRow = tree.locator(`[role="treeitem"][aria-label="${componentName}"]`)
    await expect(componentRow).toBeVisible()
    if ((await componentRow.getAttribute('aria-expanded')) !== 'true') {
      await componentRow.click()
    }

    const slotRow = tree.getByRole('treeitem', { name: 'Slot: children, locked' })
    await expect(slotRow).toBeVisible()
    await slotRow.click({ button: 'right' })

    const menu = page.getByRole('menu', { name: 'Node options' })
    await expect(menu.getByRole('menuitem', { name: 'Insert module here' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^Rename$/ })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /^Duplicate$/ })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /^Cut$/ })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /^Delete$/ })).toHaveCount(0)

    await menu.getByRole('menuitem', { name: 'Insert module here' }).hover()
    const insertMenu = page.getByRole('menu', { name: 'Insert module here' })
    await expect(insertMenu).toBeVisible()
    await insertMenu.locator('[data-module-id="base.text"]').first().click()

    await setPropValue(page, 'text', slotText)
    await expect(canvasFrame(page).getByText(slotText, { exact: true })).toBeVisible()
  })

  test('reorders layers from the DOM panel (BUILDER-003)', async ({ page }) => {
    const suffix = Date.now().toString(36)
    const alpha = `Layer Alpha ${suffix}`
    const beta = `Layer Beta ${suffix}`
    const gamma = `Layer Gamma ${suffix}`

    const { name } = await openBlankPage(page, 'Builder layer reorder')
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', alpha)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', beta)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', gamma)

    await openLayersPanel(page)
    const tree = page.getByRole('tree', { name: 'Page element tree' })
    const textRows = tree.getByRole('treeitem', { name: 'Text' })
    await expect(textRows).toHaveCount(3)
    await expectCanvasTextOrder(page, [alpha, beta, gamma])

    await dragTreeRowBefore(page, textRows.nth(2), textRows.nth(0))
    await expectCanvasTextOrder(page, [gamma, alpha, beta])

    await saveDraft(page)
    await page.reload()
    await openSiteEditor(page)
    await openSitePanel(page)
    const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
    await pageItem.click()
    await expect(pageItem).toHaveAttribute('aria-selected', 'true')
    await expectCanvasTextOrder(page, [gamma, alpha, beta])
  })

  test('reorders selected layers from the canvas drag handle (BUILDER-004)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const alpha = `Canvas Alpha ${suffix}`
    const beta = `Canvas Beta ${suffix}`
    const gamma = `Canvas Gamma ${suffix}`

    await openBlankPage(page, 'Builder canvas drag')
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', alpha)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', beta)
    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', gamma)

    await expectCanvasTextOrder(page, [alpha, beta, gamma])

    const frame = canvasFrame(page)
    await frame.getByText(beta, { exact: true }).click()
    const handle = page.getByRole('button', { name: 'Drag selected layers' })
    await expect(handle).toBeVisible()

    const start = await centerOf(handle)
    const gammaBox = await frame.getByText(gamma, { exact: true }).boundingBox()
    expect(gammaBox, 'Canvas Gamma needs a measurable drop target').not.toBeNull()

    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(
      gammaBox!.x + gammaBox!.width / 2,
      gammaBox!.y + gammaBox!.height - 2,
      { steps: 8 },
    )
    await expect(page.locator('[data-position="after"]')).toBeVisible()
    await page.mouse.up()

    await expectCanvasTextOrder(page, [alpha, gamma, beta])
  })

  // EDIT-002 publishes (step-up rotates the session), so it runs on a fresh login.
  test.describe('publishing', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('adds a button with a label and link that publishes as an anchor (EDIT-002)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const { slug } = await openBlankPage(page, 'Builder button')

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', 'Visit Example')
      await setPropValue(page, 'href', 'https://example.com')

      await saveDraft(page)
      await publishDraft(page)

      // The published button renders as a semantic anchor with the intended
      // label and href — verified on the visitor-facing page, the authoritative
      // output (the design canvas is a live preview, not the published HTML).
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const link = visitor.getByRole('link', { name: 'Visit Example' })
          await expect(link).toBeVisible()
          await expect(link).toHaveAttribute('href', /example\.com/)
        },
      })
    })

    test('publishes a visual component with filled slot content (SITE-017)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const componentName = `Published VC ${suffix}`
      const componentText = `Reusable component copy ${suffix}`
      const slotText = `Published slot fill ${suffix}`
      const { slug } = await openBlankPage(page, 'Builder visual component')

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', componentText)
      await expect(canvasFrame(page).getByText(componentText, { exact: true })).toBeVisible()

      await page.getByRole('button', { name: 'Componentize' }).click()
      await page.getByLabel('Component name').fill(componentName)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(page.getByTestId('vc-mode-control')).toBeVisible()

      await insertModuleViaPicker(page, 'base.slot-outlet')
      await expect(page.getByTestId('property-control-slotName')).toBeVisible()
      await page.getByTestId('vc-mode-control-back').click()
      await expect(page.getByTestId('vc-mode-control')).toHaveCount(0)

      await openLayersPanel(page)
      const tree = page.getByRole('tree', { name: 'Page element tree' })
      const componentRow = tree.locator(`[role="treeitem"][aria-label="${componentName}"]`)
      await expect(componentRow).toBeVisible()
      if ((await componentRow.getAttribute('aria-expanded')) !== 'true') {
        await componentRow.click()
      }

      const slotRow = tree.getByRole('treeitem', { name: 'Slot: children, locked' })
      await expect(slotRow).toBeVisible()
      await slotRow.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: 'Node options' })
      await menu.getByRole('menuitem', { name: 'Insert module here' }).hover()
      const insertMenu = page.getByRole('menu', { name: 'Insert module here' })
      await expect(insertMenu).toBeVisible()
      await insertMenu.locator('[data-module-id="base.text"]').first().click()

      await setPropValue(page, 'text', slotText)
      await expect(canvasFrame(page).getByText(componentText, { exact: true })).toBeVisible()
      await expect(canvasFrame(page).getByText(slotText, { exact: true })).toBeVisible()

      await saveDraft(page)
      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        visibleText: [componentText, slotText],
        hiddenText: [`Slot: children`, componentName],
      })
    })

    test('authors a posts template with dynamic bindings and publishes an entry route (SITE-018)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const templateName = `SITE 018 Template ${suffix}`
      const templateSlug = `site-018-template-${suffix}`
      const postTitle = `Bound template post ${suffix}`
      const postSlug = `bound-template-post-${suffix}`
      const bodyText = `Body rendered through SITE-018 ${suffix}`

      await test.step('publish the post used as the explicit template preview source', async () => {
        await createPostDraft(page, postTitle, postSlug, bodyText)
        await page.getByRole('button', { name: 'Publish post' }).click()
        await completeStepUp(page)
        await expect(
          page.getByRole('button', { name: 'Published', exact: true }),
        ).toBeDisabled({ timeout: 20_000 })
      })

      await test.step('create a high-priority Posts template from the Site panel', async () => {
        await openSiteEditor(page)
        await openSitePanel(page)
        await page.getByRole('button', { name: 'New template', exact: true }).click()

        const dialog = page.getByRole('dialog', { name: 'Template settings' })
        await expect(dialog).toBeVisible()
        await dialog.getByLabel('Name').fill(templateName)
        await dialog.getByLabel('Slug').fill(templateSlug)
        await dialog.getByLabel('Applies to').click()
        await page.getByRole('option', { name: 'Post types' }).click()
        await dialog.getByLabel('Posts').setChecked(true)
        await dialog.getByLabel('Priority').fill('300')
        await dialog.getByRole('button', { name: 'Save' }).click()

        await expect(dialog).toBeHidden()
        await expect(page.getByTestId('document-switcher')).toHaveAttribute('placeholder', templateName)
      })

      await test.step('insert title and body bindings into the template canvas', async () => {
        const previewSource = page.getByLabel('Preview source')
        await expect(previewSource).toBeVisible({ timeout: 20_000 })
        await previewSource.click()
        await page.getByRole('option', { name: postTitle, exact: true }).click()
        await expect(previewSource).toHaveValue(postTitle)

        await insertNotchModule(page, 'text')
        await setPropValue(page, 'text', 'Template headline:')
        await page.getByRole('button', { name: 'Insert binding for Text' }).click()

        const bindingMenu = page.getByRole('menu', { name: 'Insert binding for Text' })
        await expect(bindingMenu.getByLabel('Scoped to Posts')).toContainText('Current row — Posts')
        await bindingMenu.getByRole('button').filter({ hasText: 'Title' }).first().click()
        await page.keyboard.press('Escape')

        await expect(page.locator('#ctrl-text')).toHaveValue('Template headline: {currentEntry.title}')
        await expect(
          canvasFrame(page).getByText(`Template headline: ${postTitle}`, { exact: true }),
        ).toBeVisible()

        await insertModuleViaPicker(page, 'base.outlet')
        await expect(canvasFrame(page).getByText(bodyText, { exact: true })).toBeVisible()
      })

      await test.step('save and publish the template snapshot', async () => {
        await saveDraft(page)
        await publishDraft(page)
      })

      await visitPublicPage(browser, {
        path: `/posts/${postSlug}`,
        visibleText: ['Template headline:', postTitle, bodyText],
        hiddenText: ['Example Post Title', '{currentEntry.title}', templateName],
      })
    })

    test('saves, inserts, renames, deletes, and publishes a layout (SITE-019)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const layoutName = `Saved layout ${suffix}`
      const renamedLayoutName = `Renamed layout ${suffix}`
      const layoutText = `Reusable layout text ${suffix}`
      const className = `e2e-layout-${suffix}`
      const expectedBackground = 'rgb(0, 170, 85)'
      const target = await openBlankPage(page, 'Builder layout source')

      await test.step('capture a styled container subtree as a saved layout', async () => {
        await insertNotchModule(page, 'container')
        await page.getByTestId('class-picker-input').fill(className)
        await page.getByTestId('class-picker-submit').click()
        await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

        await page.getByRole('button', { name: 'Open Selectors panel' }).click()
        const selectorRow = page.getByRole('button', { name: `Edit selector .${className}` })
        await expect(selectorRow).toBeVisible()
        await selectorRow.click()
        await page.getByLabel('Search class style properties to add').fill('background color')
        const backgroundInput = page
          .getByTestId('css-property-row-backgroundColor')
          .getByRole('textbox', { name: 'Background color', exact: true })
        await backgroundInput.fill('#00aa55')
        await backgroundInput.blur()

        await openLayersPanel(page)
        const containerRow = page
          .getByRole('tree', { name: 'Page element tree' })
          .getByRole('treeitem', { name: 'Container' })
        await containerRow.click()
        await insertNotchModule(page, 'text')
        await setPropValue(page, 'text', layoutText)
        await expect(canvasFrame(page).getByText(layoutText, { exact: true })).toBeVisible()

        await openLayersPanel(page)
        await containerRow.click({ button: 'right' })
        const menu = page.getByRole('menu', { name: 'Node options' })
        await menu.getByRole('menuitem', { name: /Save as layout/ }).click()

        const dialog = page.getByRole('dialog', { name: 'Save as layout' })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Save layout' }).click()
        await expect(dialog.getByRole('alert')).toHaveText('Layout name is required.')
        await dialog.getByLabel('Layout name').fill(layoutName)
        await dialog.getByRole('button', { name: 'Save layout' }).click()
        await expect(dialog).toBeHidden()
        await expect(page.getByText(`Saved layout "${layoutName}"`)).toBeVisible()

        await containerRow.click({ button: 'right' })
        await page
          .getByRole('menu', { name: 'Node options' })
          .getByRole('menuitem', { name: /Save as layout/ })
          .click()
        const duplicateDialog = page.getByRole('dialog', { name: 'Save as layout' })
        await duplicateDialog.getByLabel('Layout name').fill(layoutName)
        await duplicateDialog.getByRole('button', { name: 'Save layout' }).click()
        await expect(duplicateDialog.getByRole('alert')).toHaveText(
          `Another layout is already named "${layoutName}".`,
        )
        await duplicateDialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(duplicateDialog).toBeHidden()
      })

      await test.step('insert the layout from the module inserter on another page', async () => {
        await saveDraft(page)
        const nextPage = await openBlankPage(page, 'Builder layout target')
        target.name = nextPage.name
        target.slug = nextPage.slug

        await page.setViewportSize({ width: 390, height: 800 })
        await openSavedLayoutSection(page)
        await expect(expectSavedLayoutItem(page, layoutName)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Add to canvas' })).toBeHidden()
        await page.setViewportSize({ width: 1280, height: 900 })

        await insertSavedLayoutViaPicker(page, layoutName)
        await expect(canvasFrame(page).getByText(layoutText, { exact: true })).toBeVisible()
        await expect(canvasFrame(page).locator(`.${className}`).first()).toHaveCSS(
          'background-color',
          expectedBackground,
        )
      })

      await test.step('rename and delete the saved layout without affecting inserted content', async () => {
        await openSavedLayoutContextMenu(page, layoutName)
        await page.getByRole('menu', { name: `${layoutName} options` })
          .getByRole('menuitem', { name: /^Rename/ })
          .click()

        const renameDialog = page.getByRole('dialog', { name: 'Rename layout' })
        await expect(renameDialog).toBeVisible()
        await renameDialog.getByLabel('Layout name').fill(renamedLayoutName)
        await renameDialog.getByRole('button', { name: 'Rename' }).click()
        await expect(renameDialog).toBeHidden()

        await openSavedLayoutSection(page)
        await expect(expectSavedLayoutItem(page, renamedLayoutName)).toBeVisible()
        await expect(expectSavedLayoutItem(page, layoutName)).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Add to canvas' })).toBeHidden()

        await openSavedLayoutContextMenu(page, renamedLayoutName)
        const inserterDialog = page.getByRole('dialog', { name: 'Add to canvas' })
        await page
          .getByRole('menu', { name: `${renamedLayoutName} options` })
          .getByRole('menuitem', { name: 'Delete' })
          .click()
        await expect(page.getByText(`Deleted layout "${renamedLayoutName}"`)).toBeVisible()
        await expect(expectSavedLayoutItem(page, renamedLayoutName)).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(inserterDialog).toBeHidden()

        await expect(canvasFrame(page).getByText(layoutText, { exact: true })).toBeVisible()
        await saveDraft(page)
        await page.reload()
        await openSiteEditor(page)
        await openSitePanel(page)
        const pageItem = page.getByRole('treeitem', { name: `Open page ${target.name}` })
        await pageItem.click()
        await expect(pageItem).toHaveAttribute('aria-selected', 'true')
        await expect(canvasFrame(page).getByText(layoutText, { exact: true })).toBeVisible()
      })

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${target.slug}`,
        assert: async (visitor) => {
          const publishedLayout = visitor.locator(`.${className}`).filter({ hasText: layoutText })
          await expect(publishedLayout).toBeVisible()
          await expect(publishedLayout).toHaveCSS('background-color', expectedBackground)
          await expect(visitor.getByText(layoutText, { exact: true })).toBeVisible()
          await expect(visitor.getByText(layoutName)).toHaveCount(0)
          await expect(visitor.getByText(renamedLayoutName)).toHaveCount(0)
        },
      })
    })

    test('creates a reusable class selector and publishes its CSS (SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const className = `e2e-accent-${suffix}`
      const headline = `Class styled headline ${suffix}`
      const { name, slug } = await openBlankPage(page, 'Builder class style')

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', headline)
      const frame = canvasFrame(page)
      const canvasHeadline = frame.getByText(headline, { exact: true })
      await expect(canvasHeadline).toBeVisible()

      await page.getByTestId('class-picker-input').fill(className)
      await page.getByTestId('class-picker-submit').click()
      await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

      await page.getByRole('button', { name: 'Open Selectors panel' }).click()
      const selectorRow = page.getByRole('button', { name: `Edit selector .${className}` })
      await expect(selectorRow).toBeVisible()
      await selectorRow.click()

      await page.getByLabel('Search class style properties to add').fill('font size')
      const fontSizeInput = page
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('28px')
      await fontSizeInput.blur()
      await expect(canvasHeadline).toHaveCSS('font-size', '28px')

      await saveDraft(page)
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
      await pageItem.click()
      await expect(pageItem).toHaveAttribute('aria-selected', 'true')

      const reloadedHeadline = canvasFrame(page).getByText(headline, { exact: true })
      await expect(reloadedHeadline).toHaveCSS('font-size', '28px')
      await reloadedHeadline.click()
      await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedHeadline = visitor.getByText(headline, { exact: true })
          await expect(publishedHeadline).toBeVisible()
          await expect(publishedHeadline).toHaveClass(new RegExp(`\\b${className}\\b`))
          await expect(publishedHeadline).toHaveCSS('font-size', '28px')
        },
      })
    })

    test('creates an ambient selector that styles matching published markup (SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const headline = `Ambient styled headline ${suffix}`
      const ambientSelector = 'p:not(.nope)'
      const { name, slug } = await openBlankPage(page, 'Builder ambient style')

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', headline)
      const frame = canvasFrame(page)
      const canvasHeadline = frame.getByText(headline, { exact: true })
      await expect(canvasHeadline).toBeVisible()

      await page.getByTestId('class-picker-input').fill(ambientSelector)
      await page.getByTestId('class-picker-submit').click()
      await expect(
        page.getByRole('button', { name: `Deselect selector ${ambientSelector}` }),
      ).toBeVisible()

      await page.getByRole('button', { name: 'Open Selectors panel' }).click()
      const selectorRow = page.getByRole('button', { name: `Edit selector ${ambientSelector}` })
      await expect(selectorRow).toBeVisible()
      await selectorRow.click()

      await page.getByLabel('Search class style properties to add').fill('font size')
      const fontSizeInput = page
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('30px')
      await fontSizeInput.blur()
      await expect(canvasHeadline).toHaveCSS('font-size', '30px')

      await saveDraft(page)
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
      await pageItem.click()
      await expect(pageItem).toHaveAttribute('aria-selected', 'true')

      const reloadedHeadline = canvasFrame(page).getByText(headline, { exact: true })
      await expect(reloadedHeadline).toHaveCSS('font-size', '30px')
      await reloadedHeadline.click()
      await expect(
        page.getByRole('button', { name: `Deselect selector ${ambientSelector}` }),
      ).toBeVisible()

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedHeadline = visitor.getByText(headline, { exact: true })
          await expect(publishedHeadline).toBeVisible()
          await expect(publishedHeadline).not.toHaveAttribute('class', /.+/)
          await expect(publishedHeadline).toHaveCSS('font-size', '30px')
        },
      })
    })

    test('validates and publishes authored HTML attributes (SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const headline = `Attribute headline ${suffix}`
      const trackValue = `headline-${suffix}`
      const { name, slug } = await openBlankPage(page, 'Builder attributes')

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', headline)
      const frame = canvasFrame(page)
      const canvasHeadline = frame.getByText(headline, { exact: true })
      await expect(canvasHeadline).toBeVisible()

      const propertiesPanel = page.getByTestId('properties-panel')
      await propertiesPanel.getByRole('button', { name: 'Attributes' }).click()
      await propertiesPanel.getByRole('button', { name: 'Add attribute' }).click()
      await propertiesPanel
        .getByRole('textbox', { name: 'Attribute name' })
        .first()
        .fill('data-track')
      await propertiesPanel.getByRole('textbox', { name: 'data-track value' }).fill(trackValue)
      await expect(canvasHeadline).toHaveAttribute('data-track', trackValue)

      await propertiesPanel.getByRole('button', { name: 'Add attribute' }).click()
      await propertiesPanel
        .getByRole('textbox', { name: 'Attribute name' })
        .first()
        .fill('onclick')
      await propertiesPanel.getByRole('textbox', { name: 'onclick value' }).fill('alert(1)')
      await expect(propertiesPanel.getByRole('alert')).toContainText(
        'Event handler attributes are not allowed.',
      )

      await saveDraft(page)
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
      await pageItem.click()
      await expect(pageItem).toHaveAttribute('aria-selected', 'true')

      const reloadedHeadline = canvasFrame(page).getByText(headline, { exact: true })
      await expect(reloadedHeadline).toHaveAttribute('data-track', trackValue)
      await expect(reloadedHeadline).not.toHaveAttribute('onclick', /.+/)

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedHeadline = visitor.getByText(headline, { exact: true })
          await expect(publishedHeadline).toBeVisible()
          await expect(publishedHeadline).toHaveAttribute('data-track', trackValue)
          await expect(publishedHeadline).not.toHaveAttribute('onclick', /.+/)
        },
      })
    })

    test('publishes state pseudo selector styles (SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const label = `Hover link ${suffix}`
      const pseudoSelector = 'a:hover'
      const { slug } = await openBlankPage(page, 'Builder pseudo style')

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', label)
      await setPropValue(page, 'href', 'https://example.com/hover')
      await expect(canvasFrame(page).getByRole('link', { name: label })).toBeVisible()

      await page.getByTestId('class-picker-input').fill(pseudoSelector)
      await page.getByTestId('class-picker-submit').click()
      await expect(
        page.getByRole('button', { name: `Deselect selector ${pseudoSelector}` }),
      ).toBeVisible()

      await page.getByRole('button', { name: 'Open Selectors panel' }).click()
      const selectorRow = page.getByRole('button', { name: `Edit selector ${pseudoSelector}` })
      await expect(selectorRow).toBeVisible()
      await selectorRow.click()

      await page.getByLabel('Search class style properties to add').fill('font size')
      const fontSizeInput = page
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('31px')
      await fontSizeInput.blur()

      await saveDraft(page)
      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedLink = visitor.getByRole('link', { name: label })
          await expect(publishedLink).toBeVisible()
          await expect(publishedLink).not.toHaveCSS('font-size', '31px')
          await publishedLink.hover()
          await expect(publishedLink).toHaveCSS('font-size', '31px')
        },
      })
    })

    test('publishes breakpoint-specific selector styles (BUILDER-007, SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const className = `e2e-responsive-${suffix}`
      const label = `Responsive class button ${suffix}`
      const { slug } = await openBlankPage(page, 'Builder responsive style')

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', label)
      const desktopButton = canvasFrameForBreakpoint(page, 'desktop').getByRole('button', {
        name: label,
      })
      await expect(desktopButton).toBeVisible()

      await page.getByTestId('class-picker-input').fill(className)
      await page.getByTestId('class-picker-submit').click()
      await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

      await switchEditingContext(page, 'Desktop')
      await page.getByLabel('Search class style properties to add').fill('font size')
      let fontSizeInput = page
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('20px')
      await fontSizeInput.blur()
      await expect(desktopButton).toHaveCSS('font-size', '20px')

      await switchEditingContext(page, 'Mobile')
      fontSizeInput = page
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('33px')
      await fontSizeInput.blur()

      const mobileButton = canvasFrameForBreakpoint(page, 'mobile').getByRole('button', {
        name: label,
      })
      await expect(mobileButton).toHaveCSS('font-size', '33px')
      await expect(desktopButton).toHaveCSS('font-size', '20px')

      await saveDraft(page)
      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedButton = visitor.getByRole('button', { name: label })
          await expect(publishedButton).toBeVisible()
          await expect(publishedButton).toHaveClass(new RegExp(`\\b${className}\\b`))
          await expect(publishedButton).toHaveCSS('font-size', '20px')

          await visitor.setViewportSize({ width: 360, height: 800 })
          await visitor.reload()
          const mobilePublishedButton = visitor.getByRole('button', { name: label })
          await expect(mobilePublishedButton).toHaveCSS('font-size', '33px')
        },
      })
    })

    test('bulk-applies, duplicates, and deletes selected selectors (SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const sourceText = `Bulk selector source ${suffix}`
      const label = `Bulk selector button ${suffix}`
      const classA = `e2e-bulk-a-${suffix}`
      const classB = `e2e-bulk-b-${suffix}`
      const classACopy = `${classA}-copy`
      const classBCopy = `${classB}-copy`
      const { name, slug } = await openBlankPage(page, 'Builder bulk selectors')

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', sourceText)
      for (const className of [classA, classB]) {
        await page.getByTestId('class-picker-input').fill(className)
        await page.getByTestId('class-picker-submit').click()
        await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()
      }

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', label)
      const desktopButton = canvasFrame(page).getByRole('button', { name: label })
      await expect(desktopButton).toBeVisible()

      await page.getByRole('button', { name: 'Open Selectors panel' }).click()
      const selectorsPanel = page.getByTestId('selectors-panel')
      await expect(selectorsPanel).toBeVisible()
      await selectSelectorForBulk(selectorsPanel, classA)
      await selectSelectorForBulk(selectorsPanel, classB)

      const propertiesPanel = page.getByTestId('properties-panel')
      await expect(propertiesPanel.getByText('2 selectors selected')).toBeVisible()
      await propertiesPanel.getByRole('button', { name: /^Apply$/ }).click()
      await expect(desktopButton).toHaveClass(new RegExp(`\\b${classA}\\b`))
      await expect(desktopButton).toHaveClass(new RegExp(`\\b${classB}\\b`))

      await propertiesPanel.getByRole('button', { name: /^Duplicate$/ }).click()
      await expect(
        selectorsPanel.getByRole('button', { name: `Edit selector .${classACopy}` }),
      ).toBeVisible()
      await expect(
        selectorsPanel.getByRole('button', { name: `Edit selector .${classBCopy}` }),
      ).toBeVisible()

      await propertiesPanel.getByRole('button', { name: /^Delete$/ }).click()
      await confirmDeleteIfShown(page, 'Delete selectors?')
      await expect(
        selectorsPanel.getByRole('button', { name: `Edit selector .${classACopy}` }),
      ).toHaveCount(0)
      await expect(
        selectorsPanel.getByRole('button', { name: `Edit selector .${classBCopy}` }),
      ).toHaveCount(0)
      await expect(
        selectorsPanel.getByRole('button', { name: `Edit selector .${classA}` }),
      ).toBeVisible()
      await expect(
        selectorsPanel.getByRole('button', { name: `Edit selector .${classB}` }),
      ).toBeVisible()
      await expect(desktopButton).toHaveClass(new RegExp(`\\b${classA}\\b`))
      await expect(desktopButton).toHaveClass(new RegExp(`\\b${classB}\\b`))

      await saveDraft(page)
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
      await pageItem.click()
      await expect(pageItem).toHaveAttribute('aria-selected', 'true')

      const reloadedButton = canvasFrame(page).getByRole('button', { name: label })
      await expect(reloadedButton).toHaveClass(new RegExp(`\\b${classA}\\b`))
      await expect(reloadedButton).toHaveClass(new RegExp(`\\b${classB}\\b`))

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedButton = visitor.getByRole('button', { name: label })
          await expect(publishedButton).toBeVisible()
          await expect(publishedButton).toHaveClass(new RegExp(`\\b${classA}\\b`))
          await expect(publishedButton).toHaveClass(new RegExp(`\\b${classB}\\b`))
          await expect(publishedButton).not.toHaveClass(new RegExp(`\\b${classACopy}\\b`))
          await expect(publishedButton).not.toHaveClass(new RegExp(`\\b${classBCopy}\\b`))
        },
      })
    })

    test('authors custom CSS properties and publishes them (SITE-011)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const className = `e2e-custom-prop-${suffix}`
      const customProperty = `--e2e-accent-${suffix}`
      const customValue = 'rgb(255, 0, 0)'
      const label = `Custom property button ${suffix}`
      const { name, slug } = await openBlankPage(page, 'Builder custom property')

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', label)
      const desktopButton = canvasFrame(page).getByRole('button', { name: label })
      await expect(desktopButton).toBeVisible()

      await page.getByTestId('class-picker-input').fill(className)
      await page.getByTestId('class-picker-submit').click()
      await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

      const propertiesPanel = page.getByTestId('properties-panel')
      await openCustomPropertiesSection(page)
      await propertiesPanel.getByRole('button', { name: 'Add property' }).click()
      await propertiesPanel.getByLabel('New property name').fill('123bad')
      await propertiesPanel.getByLabel('New property value').fill(customValue)
      await propertiesPanel.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(propertiesPanel.getByRole('alert')).toHaveText(
        'Not a valid CSS property name.',
      )
      await propertiesPanel.getByLabel('New property name').fill(customProperty)
      await propertiesPanel.getByLabel('New property value').fill(customValue)
      await propertiesPanel.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(
        propertiesPanel.getByTestId(`custom-property-row-${customProperty}`),
      ).toBeVisible()
      await expectComputedCustomProperty(desktopButton, customProperty, customValue)

      await saveDraft(page)
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
      await pageItem.click()
      await expect(pageItem).toHaveAttribute('aria-selected', 'true')

      const reloadedButton = canvasFrame(page).getByRole('button', { name: label })
      await expect(reloadedButton).toHaveClass(new RegExp(`\\b${className}\\b`))
      await expectComputedCustomProperty(reloadedButton, customProperty, customValue)

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedButton = visitor.getByRole('button', { name: label })
          await expect(publishedButton).toBeVisible()
          await expect(publishedButton).toHaveClass(new RegExp(`\\b${className}\\b`))
          await expectComputedCustomProperty(publishedButton, customProperty, customValue)
        },
      })
    })

    test('applies spacing, color, and typography controls (BUILDER-006)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const className = `e2e-style-controls-${suffix}`
      const label = `Styled controls button ${suffix}`
      const background = '#00aa55'
      const expectedBackground = 'rgb(0, 170, 85)'
      const { name, slug } = await openBlankPage(page, 'Builder style controls')

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', label)
      const desktopButton = canvasFrame(page).getByRole('button', { name: label })
      await expect(desktopButton).toBeVisible()

      await page.getByTestId('class-picker-input').fill(className)
      await page.getByTestId('class-picker-submit').click()
      await expect(page.getByTestId(`class-chip-${className}`)).toBeVisible()

      const styleSearch = page.getByLabel('Search class style properties to add')
      await styleSearch.fill('font size')
      const fontSizeInput = page
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('24px')
      await fontSizeInput.blur()
      await expect(desktopButton).toHaveCSS('font-size', '24px')

      await styleSearch.fill('background color')
      const backgroundInput = page
        .getByTestId('css-property-row-backgroundColor')
        .getByRole('textbox', { name: 'Background color', exact: true })
      await backgroundInput.fill(background)
      await backgroundInput.blur()
      await expect(desktopButton).toHaveCSS('background-color', expectedBackground)

      await styleSearch.fill('padding')
      const paddingTopInput = page.getByLabel('padding top')
      await paddingTopInput.fill('12px')
      await paddingTopInput.blur()
      await expect(desktopButton).toHaveCSS('padding-top', '12px')

      await saveDraft(page)
      await page.reload()
      await openSiteEditor(page)
      await openSitePanel(page)
      const pageItem = page.getByRole('treeitem', { name: `Open page ${name}` })
      await pageItem.click()
      await expect(pageItem).toHaveAttribute('aria-selected', 'true')

      const reloadedButton = canvasFrame(page).getByRole('button', { name: label })
      await expect(reloadedButton).toHaveCSS('font-size', '24px')
      await expect(reloadedButton).toHaveCSS('background-color', expectedBackground)
      await expect(reloadedButton).toHaveCSS('padding-top', '12px')

      await publishDraft(page)
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const publishedButton = visitor.getByRole('button', { name: label })
          await expect(publishedButton).toBeVisible()
          await expect(publishedButton).toHaveClass(new RegExp(`\\b${className}\\b`))
          await expect(publishedButton).toHaveCSS('font-size', '24px')
          await expect(publishedButton).toHaveCSS('background-color', expectedBackground)
          await expect(publishedButton).toHaveCSS('padding-top', '12px')
        },
      })
    })
  })

  test.describe('responsive', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('keeps the full module picker usable at phone width (SITE-005 mobile)', async ({
      page,
    }) => {
      await login(page)
      await openBlankPage(page, 'Module picker mobile')
      await page.setViewportSize({ width: 390, height: 844 })

      await page.getByTestId('canvas-notch-add-btn').click()
      const dialog = page.getByRole('dialog', { name: 'Add to canvas' })
      await expect(dialog).toBeVisible()
      await expectMobileDialogContained(page, dialog)
      await expect(dialog.getByRole('button', { name: 'Modules' })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Recent' })).toBeVisible()
      await expectMobileLocatorContained(
        page,
        dialog.getByRole('searchbox', { name: 'Search modules' }),
        'Search modules',
      )

      await dialog.getByRole('searchbox', { name: 'Search modules' }).fill('button')
      const buttonItem = dialog.locator('[data-module-id="base.button"]')
      await expect(buttonItem).toBeVisible()
      await expectMobileLocatorContained(page, buttonItem, 'Button picker item')
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()

      await page.setViewportSize({ width: 1280, height: 900 })
      await openLayersPanel(page)
      await expect(
        page.getByRole('tree', { name: 'Page element tree' }).getByRole('treeitem', {
          name: 'Button',
        }),
      ).toBeVisible()
    })

    test('inserts from the canvas notch at tablet width after fresh login (BUILDER-003 responsive)', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 768, height: 900 })
      await login(page)
      await openBlankPage(page, 'Builder tablet insert')

      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', 'Tablet-width insert')
      await insertNotchModule(page, 'text')
      await setPropValue(page, 'text', 'Second tablet-width insert')

      await openLayersPanel(page)
      const tree = page.getByRole('tree', { name: 'Page element tree' })
      await expect(tree.getByRole('treeitem', { name: 'Text' })).toHaveCount(2)
      await expect(canvasFrame(page).getByText('Tablet-width insert', { exact: true })).toBeVisible()
      await expect(canvasFrame(page).getByText('Second tablet-width insert', { exact: true })).toBeVisible()
    })
  })
})

/** Create a fresh page and open it in the canvas, ready for inserting modules. */
async function openBlankPage(
  page: Page,
  label: string,
): Promise<{ name: string; slug: string }> {
  await openSiteEditor(page)
  const suffix = Date.now().toString(36)
  const name = `${label} ${suffix}`
  const slug = `builder-${suffix}`
  await createPage(page, name, slug)
  const item = page.getByRole('treeitem', { name: `Open page ${name}` })
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
  return { name, slug }
}

async function createPostDraft(
  page: Page,
  title: string,
  slug: string,
  body: string,
): Promise<void> {
  await page.goto('/admin/content')

  const previousRow = new URL(page.url()).searchParams.get('row')
  const newPost = page.getByRole('button', { name: 'New post', exact: true })
  await expect(newPost).toBeEnabled()
  await newPost.click()
  await page.waitForURL((url) => {
    const nextRow = url.searchParams.get('row')
    return nextRow !== null && nextRow !== previousRow
  })
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('')

  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
  await page.getByRole('textbox', { name: 'Slug' }).fill(slug)
  await page.getByTestId('content-body-editor').click()
  await page.keyboard.type(body)

  await page.getByRole('button', { name: 'More publishing actions' }).click()
  const saveResponse = page.waitForResponse((response) =>
    /\/admin\/api\/cms\/data\/rows\/[^/]+$/.test(new URL(response.url()).pathname) &&
    response.request().method() === 'PATCH',
  )
  await page.getByTestId('toolbar-content-save-draft-action').click()
  expect((await saveResponse).ok()).toBe(true)
  await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible({
    timeout: 20_000,
  })
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  expect(box, 'Element needs a measurable bounding box').not.toBeNull()
  return {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  }
}

async function expectCanvasTextOrder(
  page: Page,
  orderedText: readonly string[],
): Promise<void> {
  await expect.poll(async () => {
    const bodyText = (await canvasFrame(page).locator('body').textContent()) ?? ''
    let cursor = -1
    for (const text of orderedText) {
      const next = bodyText.indexOf(text, cursor + 1)
      if (next === -1) return false
      cursor = next
    }
    return true
  }).toBe(true)
}

async function switchEditingContext(page: Page, label: 'Desktop' | 'Mobile'): Promise<void> {
  await page
    .getByTestId('canvas-context-selector')
    .getByRole('button', { name: /Editing context:/ })
    .click()
  await page.getByRole('menuitem', { name: new RegExp(label) }).click()
  await expect(
    page.getByRole('button', { name: new RegExp(`Switch to ${label} breakpoint`), pressed: true }),
  ).toBeVisible()
}

async function selectSelectorForBulk(selectorsPanel: Locator, className: string): Promise<void> {
  const editRow = selectorsPanel.getByRole('button', { name: `Edit selector .${className}` })
  await editRow.hover()
  await selectorsPanel
    .getByRole('checkbox', { name: `Select selector .${className}` })
    .click()
}

async function confirmDeleteIfShown(page: Page, title: string): Promise<void> {
  const dialog = page.getByRole('alertdialog', { name: title })
  const visible = await dialog.isVisible({ timeout: 1_000 }).catch(() => false)
  if (!visible) return
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog).toBeHidden()
}

async function dragTreeRowBefore(
  page: Page,
  sourceRow: Locator,
  targetRow: Locator,
): Promise<void> {
  const start = await centerOf(sourceRow)
  const targetBox = await targetRow.boundingBox()
  expect(targetBox, 'Target layer row needs a measurable drop target').not.toBeNull()

  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + 2, {
    steps: 10,
  })
  await page.mouse.up()
}

async function openCustomPropertiesSection(page: Page): Promise<void> {
  const propertiesPanel = page.getByTestId('properties-panel')
  const sectionToggle = propertiesPanel.getByRole('button', { name: /Custom properties/ })
  await sectionToggle.scrollIntoViewIfNeeded()
  if ((await sectionToggle.getAttribute('aria-expanded')) !== 'true') {
    await sectionToggle.click()
  }
}

async function expectComputedCustomProperty(
  locator: Locator,
  property: string,
  expectedValue: string,
): Promise<void> {
  await expect
    .poll(async () =>
      locator.evaluate((element, propertyName) =>
        getComputedStyle(element).getPropertyValue(propertyName).trim(),
      property),
    )
    .toBe(expectedValue)
}

async function expectMobileDialogContained(page: Page, dialog: Locator): Promise<void> {
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

  const box = await dialog.boundingBox()
  if (!box) throw new Error('Add to canvas dialog was visible but had no bounding box')
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(metrics.viewportHeight + 1)
}

async function expectMobileLocatorContained(
  page: Page,
  locator: Locator,
  description: string,
): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      viewportWidth: doc.clientWidth,
      viewportHeight: window.innerHeight,
    }
  })
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${description} was visible but had no bounding box`)
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.y + box.height).toBeLessThanOrEqual(metrics.viewportHeight + 1)
}

async function openSavedLayoutSection(page: Page): Promise<void> {
  await page.getByTestId('canvas-notch-add-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Add to canvas' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^Layouts/ }).click()
}

function expectSavedLayoutItem(page: Page, layoutName: string): Locator {
  return page
    .getByRole('dialog', { name: 'Add to canvas' })
    .locator('[data-saved-layout-id]')
    .filter({ hasText: layoutName })
    .first()
}

async function insertSavedLayoutViaPicker(page: Page, layoutName: string): Promise<void> {
  await openSavedLayoutSection(page)
  const dialog = page.getByRole('dialog', { name: 'Add to canvas' })
  await expectSavedLayoutItem(page, layoutName).click()
  await expect(dialog).toBeHidden()
}

async function openSavedLayoutContextMenu(page: Page, layoutName: string): Promise<void> {
  await openSavedLayoutSection(page)
  await expectSavedLayoutItem(page, layoutName).click({ button: 'right' })
}
