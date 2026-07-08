import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  OWNER,
  canvasFrame,
  completeStepUp,
  insertNotchModule,
  login,
  openSiteEditor,
  openSitePanel,
  publishDraft,
  saveDraft,
  setPropValue,
  visitPublicPage,
} from './helpers'

/**
 * CONTENT-001 / CONTENT-002 / CONTENT-003 / CONTENT-005 / CONTENT-006 /
 * CONTENT-007 / CONTENT-008 —
 * create content entries, publish them, edit rich bodies, preview drafts inside
 * templates, manage collection-level field settings, and surface content AI
 * setup guidance.
 */
test.describe('content', () => {
  test('creates a post that saves and persists (CONTENT-001)', async ({
    page,
  }) => {
    // Saving a draft does not step-up, so this runs on the shared owner state.
    const title = `E2E Post ${Date.now().toString(36)}`
    await createPostDraft(page, title, 'Body written by the automated content test.')

    await test.step('the post persists in the entry list after reload', async () => {
      await page.reload()
      await expect(entryRow(page, title)).toBeVisible()
    })
  })

  test('inserts slash-menu blocks and data tokens into the rich body (CONTENT-003)', async ({
    page,
  }) => {
    const title = `E2E Rich Body ${Date.now().toString(36)}`
    await page.goto('/admin/content')

    await test.step('create a draft and open the rich body editor', async () => {
      const newPost = page.getByRole('button', { name: 'New post', exact: true })
      await expect(newPost).toBeEnabled()
      await newPost.click()
      await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
      await expect(page.getByTestId('content-body-editor')).toBeVisible()
    })

    await test.step('use slash commands for a heading and data token', async () => {
      const bodyEditor = page.getByTestId('content-body-editor')
      await bodyEditor.click()
      await page.keyboard.type('/h2')
      await page.getByTestId('content-slash-menu').getByRole('option', {
        name: /Heading 2/,
      }).click()
      await page.keyboard.type('Release notes')
      await expect(bodyEditor.locator('h2')).toHaveText('Release notes')

      await page.keyboard.press('Enter')
      await page.keyboard.type('/data')
      await page.getByTestId('content-slash-menu').getByRole('option', {
        name: /Data token/,
      }).click()
      await expect(bodyEditor).toContainText('{currentEntry.title}')
    })

    await test.step('save and reload the rich body content', async () => {
      await page.getByRole('button', { name: 'More publishing actions' }).click()
      await page.getByTestId('toolbar-content-save-draft-action').click()
      await expect(entryRow(page, title)).toBeVisible({ timeout: 20_000 })

      await page.reload()
      await expect(entryRow(page, title)).toBeVisible()
      await entryRow(page, title).click()
      const bodyEditor = page.getByTestId('content-body-editor')
      await expect(bodyEditor.locator('h2')).toHaveText('Release notes')
      await expect(bodyEditor).toContainText('{currentEntry.title}')
    })
  })

  test('opens the content AI assistant with no-provider guidance (CONTENT-007)', async ({
    page,
  }) => {
    await page.goto('/admin/content')
    await page.getByTestId('panel-rail-agent').click()

    const assistantPanel = page.getByRole('complementary', { name: 'AI Assistant' })
    await expect(assistantPanel).toBeVisible()
    const setupAlert = assistantPanel.getByRole('alert')
    await expect(setupAlert.getByText('Connect an AI provider')).toBeVisible()
    await expect(
      setupAlert.getByText('Add a provider credential, then choose a default model before starting a chat.'),
    ).toBeVisible()
    await expect(
      assistantPanel.getByRole('button', { name: 'Open AI settings' }),
    ).toBeVisible()
    await expect(
      assistantPanel.getByLabel('Message to AI assistant'),
    ).toBeDisabled()
    await expect(assistantPanel.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  // Live preview needs a published site snapshot, and publishing rotates the
  // session through step-up, so this runs fresh.
  test.describe('live preview', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('renders unsaved draft edits inside the entry template (CONTENT-005)', async ({
      page,
    }) => {
      await login(page)

      await test.step('publish the site snapshot live preview renders through', async () => {
        await openSiteEditor(page)
        await publishDraft(page)
      })

      const suffix = Date.now().toString(36)
      const savedTitle = `E2E Live Preview ${suffix}`
      const draftTitle = `${savedTitle} Draft`
      const savedBody = 'Saved body before the live preview draft edit.'
      const draftOnlyBody = `Draft-only live preview body ${suffix}`

      await createPostDraft(page, savedTitle, savedBody)

      await test.step('make draft-only edits before switching modes', async () => {
        await page.getByRole('textbox', { name: 'Title', exact: true }).fill(draftTitle)
        await page.getByTestId('content-body-editor').click()
        await page.keyboard.type(` ${draftOnlyBody}`)
        await expect(page.getByRole('status', { name: 'Unsaved draft' })).toBeVisible()
      })

      await test.step('live mode renders the draft through the template iframe', async () => {
        await page.getByTestId('content-mode-toggle-live').click()
        const liveCanvas = page.getByTestId('content-live-canvas')
        await expect(liveCanvas).toBeVisible()

        const liveFrame = liveCanvas.frameLocator('iframe[title="Live preview"]')
        await expect(
          liveFrame.getByRole('heading', { name: draftTitle }),
        ).toBeVisible({ timeout: 20_000 })
        await expect(liveFrame.getByText(draftOnlyBody)).toBeVisible()
        await expect(
          liveFrame.getByLabel('Post body (live preview)'),
        ).toBeVisible()
      })
    })
  })

  // Publishing triggers a step-up (rotates the session), so it runs fresh.
  test.describe('publishing', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('publishes a post and shows the published state (CONTENT-002)', async ({
      page,
    }) => {
      await login(page)
      const title = `E2E Publish ${Date.now().toString(36)}`
      await createPostDraft(page, title, 'Body for the publish test.')

      await test.step('publish through the step-up prompt', async () => {
        await page.getByRole('button', { name: 'Publish post' }).click()

        const stepUp = page.getByTestId('step-up-dialog')
        if (await stepUp.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
          await page.getByTestId('step-up-password').fill(OWNER.password)
          await page.getByTestId('step-up-confirm').click()
          await expect(stepUp).toBeHidden({ timeout: 20_000 })
        }
      })

      // The publish action settles into a disabled "Published" button and the
      // entry's row reports the published status in the list.
      await expect(
        page.getByRole('button', { name: 'Published', exact: true }),
      ).toBeDisabled({ timeout: 20_000 })
      await expect(entryRow(page, title)).toContainText('published')
    })

    test('schedules a post and shows the scheduled state immediately (DATA-004)', async ({
      page,
    }) => {
      await login(page)
      const title = `E2E Schedule ${Date.now().toString(36)}`
      await createPostDraft(page, title, 'Body for the schedule test.')

      await test.step('schedule the selected post', async () => {
        await page.getByRole('button', { name: 'More publishing actions' }).click()
        await page.getByTestId('toolbar-content-schedule-publish-action').click()

        const dialog = page.getByRole('dialog', { name: 'Schedule this post' })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Confirm' }).click()
        await expect(dialog).toBeHidden({ timeout: 20_000 })
      })

      await test.step('the content row reflects the scheduled status without reload', async () => {
        await expect(entryRow(page, title)).toContainText('scheduled', { timeout: 10_000 })
        await expect(page.getByRole('status', { name: 'Scheduled' })).toBeVisible()
        await expect(
          page.getByTestId('content-settings-panel').getByRole('combobox', { name: 'Status' }),
        ).toHaveValue('Scheduled')
      })

      await test.step('the scheduled status persists after reload', async () => {
        await page.reload()
        await expect(entryRow(page, title)).toContainText('scheduled')
      })
    })

    test('persists and publishes formatted rich body content (BUILDER-008)', async ({
      page,
      browser,
    }) => {
      await login(page)

      await test.step('publish the site snapshot that provides the entry template', async () => {
        await ensureSiteSnapshotPublished(page)
      })

      const suffix = Date.now().toString(36)
      const title = `E2E Formatted ${suffix}`
      const slug = `e2e-formatted-${suffix}`
      const boldText = `bold ${suffix}`
      const italicText = `italic ${suffix}`
      const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

      await test.step('create formatted body content and save it', async () => {
        await page.goto('/admin/content')
        const newPost = page.getByRole('button', { name: 'New post', exact: true })
        await expect(newPost).toBeEnabled()
        await newPost.click()
        await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
        await page.getByRole('textbox', { name: 'Slug' }).fill(slug)

        const bodyEditor = page.getByTestId('content-body-editor')
        await bodyEditor.click()
        await page.keyboard.type('Intro ')
        await page.keyboard.press(`${shortcutModifier}+B`)
        await page.keyboard.type(boldText)
        await page.keyboard.press(`${shortcutModifier}+B`)
        await page.keyboard.type(' and ')
        await page.keyboard.press(`${shortcutModifier}+I`)
        await page.keyboard.type(italicText)
        await page.keyboard.press(`${shortcutModifier}+I`)
        await expect(bodyEditor.locator('strong')).toHaveText(boldText)
        await expect(bodyEditor.locator('em')).toHaveText(italicText)

        await saveSelectedDraft(page, title)
      })

      await test.step('reload and verify the rich body formatting persisted', async () => {
        await page.reload()
        await expect(entryRow(page, title)).toBeVisible()
        await entryRow(page, title).click()
        const bodyEditor = page.getByTestId('content-body-editor')
        await expect(bodyEditor.locator('strong')).toHaveText(boldText)
        await expect(bodyEditor.locator('em')).toHaveText(italicText)
      })

      await test.step('publish and verify public semantic HTML', async () => {
        await page.getByRole('button', { name: 'Publish post' }).click()

        const stepUp = page.getByTestId('step-up-dialog')
        if (await stepUp.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
          await page.getByTestId('step-up-password').fill(OWNER.password)
          await page.getByTestId('step-up-confirm').click()
          await expect(stepUp).toBeHidden({ timeout: 20_000 })
        }

        await expect(
          page.getByRole('button', { name: 'Published', exact: true }),
        ).toBeDisabled({ timeout: 20_000 })

        await visitPublicPage(browser, {
          path: `/posts/${slug}`,
          visibleText: [title, boldText, italicText],
          assert: async (visitor) => {
            await expect(
              visitor.getByRole('heading', { name: title }),
            ).toBeVisible()
            await expect(
              visitor.locator('strong').filter({ hasText: boldText }),
            ).toBeVisible()
            await expect(
              visitor.locator('em').filter({ hasText: italicText }),
            ).toBeVisible()
          },
        })
      })
    })
  })

  // Collection create/settings writes are step-up gated, so this runs fresh.
  test.describe('collections', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('creates a custom collection and updates its field settings (CONTENT-006)', async ({
      page,
    }) => {
      await login(page)
      await page.goto('/admin/content')

      const suffix = Date.now().toString(36)
      const collectionName = `Catalog ${suffix}`
      const pluralLabel = `Catalog ${suffix}`

      await test.step('create a collection with only title, slug, and body fields', async () => {
        await page.getByRole('button', { name: 'New collection' }).click()
        const dialog = page.getByRole('dialog', { name: 'New collection' })
        await expect(dialog).toBeVisible()

        await dialog.getByLabel('Name').fill(collectionName)
        await dialog.getByLabel('Singular label').fill('Product')
        await dialog.getByLabel('Plural label').fill(pluralLabel)
        await dialog.getByLabel('Featured media').setChecked(false)
        await dialog.getByLabel('SEO fields').setChecked(false)
        await dialog.getByRole('button', { name: 'Create' }).click()
        await completeStepUp(page)

        await expect(dialog).toBeHidden({ timeout: 20_000 })
        await expect(
          page.getByRole('region', { name: 'Collections' }).getByRole('button', {
            name: new RegExp(collectionName),
          }),
        ).toBeVisible()
      })

      await test.step('new entries reflect the collection field choices', async () => {
        await page
          .getByTestId('content-explorer-panel')
          .getByRole('button', { name: 'New product' })
          .click()
        await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible()
        await expect(page.getByTestId('content-body-editor')).toBeVisible()
        const settingsPanel = page.getByTestId('content-settings-panel')
        await expect(settingsPanel.getByLabel('SEO title')).toHaveCount(0)
        await expect(settingsPanel.getByText('Featured media', { exact: true })).toHaveCount(0)
      })

      await test.step('collection settings can re-enable featured media', async () => {
        const collectionRow = page
          .getByRole('region', { name: 'Collections' })
          .getByRole('button', { name: new RegExp(collectionName) })
        await collectionRow.click({ button: 'right' })
        const menu = page.getByRole('menu', { name: 'Content item options' })
        await menu.getByRole('menuitem', { name: 'Collection settings' }).click()

        const dialog = page.getByRole('dialog', { name: 'Collection settings' })
        await expect(dialog).toBeVisible()
        await dialog.getByLabel('Featured media').setChecked(true)
        await dialog.getByRole('button', { name: 'Save' }).click()
        await completeStepUp(page)

        await expect(dialog).toBeHidden({ timeout: 20_000 })
        const settingsPanel = page.getByTestId('content-settings-panel')
        await expect(settingsPanel.getByText('Featured media', { exact: true })).toBeVisible()
        await expect(settingsPanel.getByLabel('SEO title')).toHaveCount(0)
      })
    })

    test('edits a custom Posts field and renders it through a Site template binding (CONTENT-008)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const suffix = Date.now().toString(36)
      const fieldId = `e2e_subtitle_${suffix}`
      const fieldLabel = `E2E subtitle ${suffix}`
      const postTitle = `E2E Custom Field ${suffix}`
      const postSlug = `e2e-custom-field-${suffix}`
      const bodyText = `Body for custom field token ${suffix}`
      const customValue = `Custom field value ${suffix}`
      const templateName = `Custom Field Template ${suffix}`
      const templateSlug = `custom-field-template-${suffix}`
      const tokenText = `Custom subtitle: {currentEntry.${fieldId}}`
      const renderedText = `Custom subtitle: ${customValue}`

      await test.step('add a custom text field to the system Posts table', async () => {
        await addPostsTextField(page, fieldId, fieldLabel)
      })

      await test.step('save the custom field value from the Content settings panel', async () => {
        await createPostDraftWithSlug(page, postTitle, postSlug, bodyText)

        const settingsPanel = page.getByTestId('content-settings-panel')
        await expect(settingsPanel.getByTestId(`content-custom-field-${fieldId}`)).toBeVisible()
        await settingsPanel.getByLabel(fieldLabel).fill(customValue)
        await saveSelectedDraft(page, postTitle)
      })

      await test.step('reload Content and verify the custom field value persists', async () => {
        await page.reload()
        await expect(entryRow(page, postTitle)).toBeVisible()
        await entryRow(page, postTitle).click()

        const settingsPanel = page.getByTestId('content-settings-panel')
        await expect(settingsPanel.getByLabel(fieldLabel)).toHaveValue(customValue)
      })

      await test.step('publish the post so template preview and public routes use saved row data', async () => {
        await page.getByRole('button', { name: 'Publish post' }).click()
        await completeStepUp(page)
        await expect(
          page.getByRole('button', { name: 'Published', exact: true }),
        ).toBeDisabled({ timeout: 20_000 })
      })

      await test.step('insert the custom field from the Site builder binding picker', async () => {
        await createPostsTemplate(page, templateName, templateSlug)
        await insertNotchModule(page, 'text')
        await setPropValue(page, 'text', 'Custom subtitle:')
        await page.getByRole('button', { name: 'Insert binding for Text' }).click()

        const bindingMenu = page.getByRole('menu', { name: 'Insert binding for Text' })
        await expect(bindingMenu.getByLabel('Scoped to Posts')).toContainText(/Current row\s+.\s+Posts/)
        const customFieldOption = bindingMenu.getByRole('button').filter({ hasText: fieldLabel }).first()
        await expect(customFieldOption).toBeVisible()
        await customFieldOption.click()
        await page.keyboard.press('Escape')

        await expect(page.locator('#ctrl-text')).toHaveValue(tokenText)
        await expect(canvasFrame(page).getByText(renderedText, { exact: true })).toBeVisible({
          timeout: 20_000,
        })
      })

      await test.step('publish the template and verify the anonymous public post route resolves the custom token', async () => {
        await saveDraft(page)
        await publishDraft(page)
        await visitPublicPage(browser, {
          path: `/posts/${postSlug}`,
          visibleText: [renderedText],
          hiddenText: [tokenText, `{currentEntry.${fieldId}}`, templateName],
        })
      })
    })
  })
})

/**
 * Create a post draft with a title and body and save it, leaving it selected
 * and visible in the entry list. Assumes the user is logged in.
 */
async function createPostDraft(
  page: Page,
  title: string,
  body: string,
): Promise<void> {
  await page.goto('/admin/content')

  await test.step('create a new post', async () => {
    // The posts collection is selected by default; the New action enables once
    // it has loaded. `exact` avoids matching the canvas "New Post" CTA.
    const newPost = page.getByRole('button', { name: 'New post', exact: true })
    await expect(newPost).toBeEnabled()
    await newPost.click()

    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    await page.getByTestId('content-body-editor').click()
    await page.keyboard.type(body)
  })

  await test.step('save the draft', async () => {
    await saveSelectedDraft(page, title)
  })
}

async function createPostDraftWithSlug(
  page: Page,
  title: string,
  slug: string,
  body: string,
): Promise<void> {
  await page.goto('/admin/content')

  await test.step('create a new post with a stable public slug', async () => {
    const newPost = page.getByRole('button', { name: 'New post', exact: true })
    await expect(newPost).toBeEnabled()
    await newPost.click()

    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    await page.getByRole('textbox', { name: 'Slug' }).fill(slug)
    await page.getByTestId('content-body-editor').click()
    await page.keyboard.type(body)
  })
}

async function addPostsTextField(
  page: Page,
  fieldId: string,
  fieldLabel: string,
): Promise<void> {
  await page.goto('/admin/data')
  await expect(page.getByTestId('data-left-sidebar')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('option', { name: /^Posts\b/ }).click()
  const inspector = page.getByTestId('data-inspector-panel')
  await expect(inspector).toBeVisible()

  const fieldsToggle = inspector.getByRole('button', { name: 'Fields' })
  if ((await fieldsToggle.getAttribute('aria-expanded')) !== 'true') {
    await fieldsToggle.click()
  }
  await inspector.getByRole('button', { name: 'Add field' }).click()

  const dialog = page.getByRole('dialog', { name: 'New field' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('ID').fill(fieldId)
  await dialog.getByLabel('Label').fill(fieldLabel)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await completeStepUp(page)

  await expect(dialog).toBeHidden({ timeout: 20_000 })
  await expect(inspector.getByRole('button', { name: `Edit ${fieldLabel}` })).toBeVisible({
    timeout: 20_000,
  })
}

async function createPostsTemplate(
  page: Page,
  templateName: string,
  templateSlug: string,
): Promise<void> {
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
  await dialog.getByLabel('Priority').fill('260')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('document-switcher')).toHaveAttribute('placeholder', templateName)
}

async function saveSelectedDraft(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'More publishing actions' }).click()
  await page.getByTestId('toolbar-content-save-draft-action').click()
  // The new title replaces the "Untitled draft" placeholder once saved.
  await expect(entryRow(page, title)).toBeVisible({ timeout: 20_000 })
}

async function ensureSiteSnapshotPublished(page: Page): Promise<void> {
  await openSiteEditor(page)
  const publishButton = page.getByTestId('toolbar-publish-btn')
  await expect(publishButton).toBeVisible()
  if (await publishButton.isEnabled()) {
    await publishDraft(page)
    return
  }
  await expect(
    page.getByRole('button', { name: 'Published', exact: true }),
  ).toBeDisabled()
}

/** The entry's row button in the content explorer list. */
function entryRow(page: Page, title: string) {
  return page.getByRole('button').filter({ hasText: title })
}
