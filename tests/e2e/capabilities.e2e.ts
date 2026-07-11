import { expect, test, type Browser, type Page } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import {
  ANONYMOUS_STATE,
  OWNER,
  completeStepUp,
  createPage,
  login,
  loginAs,
  openLayersPanel,
  openSitePanel,
  openSiteEditor,
  saveDraft,
  setPropValue,
  canvasFrame,
  insertNotchModule,
} from './helpers'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

interface PersonaAccount {
  roleName: string
  email: string
  password: string
}

test.describe.serial('capability boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  const suffix = Date.now().toString(36)
  const seededText = `Capability seed ${suffix}`
  const secondText = `Capability spare ${suffix}`
  const contentText = `Content persona copy ${suffix}`
  const styleClass = `cap-style-${suffix}`
  let pageName = ''
  const personas: Record<'content' | 'style' | 'structure', PersonaAccount> = {
    content: {
      roleName: `CAP Content ${suffix}`,
      email: `cap-content-${suffix}@example.com`,
      password: 'cap-content-pass-12345',
    },
    style: {
      roleName: `CAP Style ${suffix}`,
      email: `cap-style-${suffix}@example.com`,
      password: 'cap-style-pass-12345',
    },
    structure: {
      roleName: `CAP Structure ${suffix}`,
      email: `cap-structure-${suffix}@example.com`,
      password: 'cap-structure-pass-12345',
    },
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000)
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    try {
      await login(ownerPage)
      pageName = await seedCapabilityPage(ownerPage, suffix, seededText, secondText)

      await createRole(ownerPage, personas.content.roleName, [
        'View site',
        'Edit site content',
      ])
      await createRole(ownerPage, personas.style.roleName, [
        'View site',
        'Edit site styles',
      ])
      await createRole(ownerPage, personas.structure.roleName, [
        'View site',
        'Edit site structure',
        'Edit pages',
      ])

      for (const persona of Object.values(personas)) {
        await createUser(ownerPage, {
          email: persona.email,
          displayName: persona.roleName,
          password: persona.password,
          role: persona.roleName,
        })
      }
    } finally {
      await context.close()
    }
  })

  test('content editor can edit copy but not style or structure (CAP-002)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.content, async (personaPage) => {
      await openNamedPage(personaPage, pageName)
      await canvasFrame(personaPage).getByText(seededText, { exact: true }).click()
      await setPropValue(personaPage, 'text', contentText)
      await expectAbsentOrDisabled(personaPage.getByTestId('canvas-notch-text-btn'))
      await expect(
        personaPage.getByText('Styles are read-only for your role'),
      ).toBeVisible()

      await saveDraft(personaPage)
      await personaPage.reload()
      await openNamedPage(personaPage, pageName)
      await expect(
        canvasFrame(personaPage).getByText(contentText, { exact: true }),
      ).toBeVisible()
    })
  })

  test('style editor can edit CSS but not copy (CAP-002)', async ({ browser }) => {
    await withPersona(browser, personas.style, async (personaPage) => {
      await openNamedPage(personaPage, pageName)
      const editableText = canvasFrame(personaPage).getByText(contentText, { exact: true })
      await editableText.click()
      await expect(personaPage.getByTestId('property-control-text')).toHaveAttribute(
        'data-disabled',
        'true',
      )

      await personaPage.getByTestId('class-picker-input').fill(styleClass)
      await personaPage.getByTestId('class-picker-submit').click()
      await expect(personaPage.getByTestId(`class-chip-${styleClass}`)).toBeVisible()
      await personaPage.getByLabel('Search class style properties to add').fill('font size')
      const fontSizeInput = personaPage
        .getByTestId('css-property-row-fontSize')
        .getByLabel('Font size')
      await fontSizeInput.fill('23px')
      await fontSizeInput.blur()
      await expect(editableText).toHaveCSS('font-size', '23px')

      await saveDraft(personaPage)
      await personaPage.reload()
      await openNamedPage(personaPage, pageName)
      const reloadedText = canvasFrame(personaPage).getByText(contentText, { exact: true })
      await reloadedText.click()
      await expect(reloadedText).toHaveCSS('font-size', '23px')
    })
  })

  test('structure editor can insert layers but not edit copy (CAP-002)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.structure, async (personaPage) => {
      await openNamedPage(personaPage, pageName)
      await canvasFrame(personaPage).getByText(contentText, { exact: true }).click()
      await expect(personaPage.getByTestId('property-control-text')).toHaveAttribute(
        'data-disabled',
        'true',
      )

      await openLayersPanel(personaPage)
      const tree = personaPage.getByRole('tree', { name: 'Page element tree' })
      await expect(tree.getByRole('treeitem', { name: 'Text' })).toHaveCount(2)
      await insertNotchModule(personaPage, 'text')
      await expect(tree.getByRole('treeitem', { name: 'Text' })).toHaveCount(3)

      await saveDraft(personaPage)
      await personaPage.reload()
      await openNamedPage(personaPage, pageName)
      await openLayersPanel(personaPage)
      await expect(
        personaPage
          .getByRole('tree', { name: 'Page element tree' })
          .getByRole('treeitem', { name: 'Text' }),
      ).toHaveCount(3)
    })
  })
})

test.describe.serial('media capability boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  const suffix = Date.now().toString(36)
  const seededFilename = `cap-media-seed-${suffix}.png`
  const writerFilename = `cap-media-writer-${suffix}.png`
  const replaceOriginalFilename = `cap-media-replace-original-${suffix}.png`
  const replaceNextFilename = `cap-media-replace-next-${suffix}.png`
  const deleteFilename = `cap-media-delete-${suffix}.png`
  const personas: Record<'reader' | 'writer' | 'replacer' | 'deleter', PersonaAccount> = {
    reader: {
      roleName: `CAP Media Reader ${suffix}`,
      email: `cap-media-reader-${suffix}@example.com`,
      password: 'cap-media-reader-pass-12345',
    },
    writer: {
      roleName: `CAP Media Writer ${suffix}`,
      email: `cap-media-writer-${suffix}@example.com`,
      password: 'cap-media-writer-pass-12345',
    },
    replacer: {
      roleName: `CAP Media Replacer ${suffix}`,
      email: `cap-media-replacer-${suffix}@example.com`,
      password: 'cap-media-replacer-pass-12345',
    },
    deleter: {
      roleName: `CAP Media Deleter ${suffix}`,
      email: `cap-media-deleter-${suffix}@example.com`,
      password: 'cap-media-deleter-pass-12345',
    },
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000)
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    try {
      await login(ownerPage)
      await ownerPage.goto('/admin/media')
      await uploadMediaFile(ownerPage, seededFilename)
      await uploadMediaFile(ownerPage, replaceOriginalFilename)
      await uploadMediaFile(ownerPage, deleteFilename)

      await createRole(ownerPage, personas.reader.roleName, ['Browse media library'])
      await createRole(ownerPage, personas.writer.roleName, [
        'Browse media library',
        'Upload and edit media',
      ])
      await createRole(ownerPage, personas.replacer.roleName, [
        'Browse media library',
        'Replace media bytes',
      ])
      await createRole(ownerPage, personas.deleter.roleName, [
        'Browse media library',
        'Delete media',
      ])
      for (const persona of Object.values(personas)) {
        await createUser(ownerPage, {
          email: persona.email,
          displayName: persona.roleName,
          password: persona.password,
          role: persona.roleName,
        })
      }
    } finally {
      await context.close()
    }
  })

  test('media reader can browse without write/replace/delete controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.reader, async (personaPage) => {
      await openMediaWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload media' })).toHaveCount(0)

      const asset = personaPage.getByRole('button', { name: `Open ${seededFilename}` })
      await expect(asset).toBeVisible()
      await asset.click({ button: 'right' })
      const menu = personaPage.getByRole('menu', { name: 'Media item options' })
      await expect(menu.getByText('Copy URL')).toBeVisible()
      await expect(menu.getByText('Rename')).toHaveCount(0)
      await expect(menu.getByText('Delete')).toHaveCount(0)
      await personaPage.keyboard.press('Escape')

      await asset.click()
      const viewer = personaPage.getByTestId('media-viewer-window')
      await expect(viewer).toBeVisible()
      await expect(viewer.getByLabel('Title')).toBeDisabled()
      await expect(viewer.getByLabel('Filename')).toBeDisabled()
      await expect(viewer.getByRole('button', { name: 'Replace file' })).toHaveCount(0)
    })
  })

  test('media writer can upload and edit metadata without replace/delete controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.writer, async (personaPage) => {
      await openMediaWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload media' })).toBeVisible()
      await uploadMediaFile(personaPage, writerFilename)

      const asset = personaPage.getByRole('button', { name: `Open ${writerFilename}` })
      await expect(asset).toBeVisible()
      await asset.click({ button: 'right' })
      const menu = personaPage.getByRole('menu', { name: 'Media item options' })
      await expect(menu.getByText('Rename')).toBeVisible()
      await expect(menu.getByText('Delete')).toHaveCount(0)
      await personaPage.keyboard.press('Escape')

      await asset.click()
      const viewer = personaPage.getByTestId('media-viewer-window')
      await expect(viewer).toBeVisible()
      await expect(viewer.getByLabel('Title')).toBeEnabled()
      await expect(viewer.getByLabel('Filename')).toBeEnabled()
      await expect(viewer.getByRole('button', { name: 'Replace file' })).toHaveCount(0)
    })
  })

  test('media replacer can replace bytes without metadata or delete controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.replacer, async (personaPage) => {
      await openMediaWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload media' })).toHaveCount(0)

      const asset = personaPage.getByRole('button', { name: `Open ${replaceOriginalFilename}` })
      await expect(asset).toBeVisible()
      await asset.click({ button: 'right' })
      const menu = personaPage.getByRole('menu', { name: 'Media item options' })
      await expect(menu.getByText('Copy URL')).toBeVisible()
      await expect(menu.getByText('Rename')).toHaveCount(0)
      await expect(menu.getByText('Delete')).toHaveCount(0)
      await personaPage.keyboard.press('Escape')

      await asset.click()
      const viewer = personaPage.getByRole('dialog', { name: `Viewer: ${replaceOriginalFilename}` })
      await expect(viewer).toBeVisible()
      await expect(viewer.getByLabel('Title')).toBeDisabled()
      await expect(viewer.getByLabel('Filename')).toBeDisabled()
      await viewer.getByRole('button', { name: 'Replace file' }).click()

      const replaceDialog = personaPage.getByRole('dialog', { name: 'Replace file' })
      await expect(replaceDialog).toBeVisible()
      await replaceDialog
        .locator('input[type="file"]')
        .setInputFiles({ name: replaceNextFilename, mimeType: 'image/png', buffer: PNG_1X1 })
      await expect(replaceDialog.getByRole('status')).toContainText(replaceNextFilename)
      await Promise.all([
        waitForMediaReplace(personaPage),
        replaceDialog.getByRole('button', { name: 'Replace file' }).click(),
      ])
      await expect(replaceDialog).toBeHidden()

      const replacedViewer = personaPage.getByRole('dialog', { name: `Viewer: ${replaceNextFilename}` })
      await expect(replacedViewer).toBeVisible()
      await expect(replacedViewer).toContainText('Replaced')
      await expect(personaPage.getByRole('button', { name: `Open ${replaceNextFilename}` })).toBeVisible()
    })
  })

  test('media deleter can trash and purge without upload or replace controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.deleter, async (personaPage) => {
      await openMediaWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload media' })).toHaveCount(0)

      const asset = personaPage.getByRole('button', { name: `Open ${deleteFilename}` })
      await expect(asset).toBeVisible()
      await asset.click()
      const viewer = personaPage.getByRole('dialog', { name: `Viewer: ${deleteFilename}` })
      await expect(viewer).toBeVisible()
      await expect(viewer.getByLabel('Title')).toBeDisabled()
      await expect(viewer.getByLabel('Filename')).toBeDisabled()
      await expect(viewer.getByRole('button', { name: 'Replace file' })).toHaveCount(0)
      await viewer.getByRole('button', { name: `Close ${deleteFilename} panel` }).click()

      await asset.click({ button: 'right' })
      const activeMenu = personaPage.getByRole('menu', { name: 'Media item options' })
      await expect(activeMenu.getByText('Rename')).toHaveCount(0)
      await expect(activeMenu.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
      await Promise.all([
        waitForMediaDelete(personaPage),
        activeMenu.getByRole('menuitem', { name: 'Delete' }).click(),
      ])
      await expect(personaPage.getByRole('button', { name: `Open ${deleteFilename}` })).toHaveCount(0)

      await personaPage.getByTestId('media-folder-row-trash').click()
      const trashedAsset = personaPage.getByRole('button', { name: `Open ${deleteFilename}` })
      await expect(trashedAsset).toBeVisible()
      await trashedAsset.click({ button: 'right' })
      const trashMenu = personaPage.getByRole('menu', { name: 'Media item options' })
      await expect(trashMenu.getByText('Restore')).toHaveCount(0)
      await expect(trashMenu.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
      await Promise.all([
        waitForMediaDelete(personaPage),
        trashMenu.getByRole('menuitem', { name: 'Delete' }).click(),
      ])
      await expect(personaPage.getByRole('button', { name: `Open ${deleteFilename}` })).toHaveCount(0)
      await expect(personaPage.getByText('Trash is empty')).toBeVisible()
    })
  })
})

test.describe.serial('data capability boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  const suffix = Date.now().toString(36)
  const tableName = `Capability Records ${suffix}`
  const personas: Record<'reader' | 'manager' | 'exporter' | 'importer', PersonaAccount> = {
    reader: {
      roleName: `CAP Data Reader ${suffix}`,
      email: `cap-data-reader-${suffix}@example.com`,
      password: 'cap-data-reader-pass-12345',
    },
    manager: {
      roleName: `CAP Data Manager ${suffix}`,
      email: `cap-data-manager-${suffix}@example.com`,
      password: 'cap-data-manager-pass-12345',
    },
    exporter: {
      roleName: `CAP Data Exporter ${suffix}`,
      email: `cap-data-exporter-${suffix}@example.com`,
      password: 'cap-data-exporter-pass-12345',
    },
    importer: {
      roleName: `CAP Data Importer ${suffix}`,
      email: `cap-data-importer-${suffix}@example.com`,
      password: 'cap-data-importer-pass-12345',
    },
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000)
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    try {
      await login(ownerPage)
      await createCustomDataTable(ownerPage, tableName)

      await createRole(ownerPage, personas.reader.roleName, ['Browse custom tables'])
      await createRole(ownerPage, personas.manager.roleName, ['Manage custom tables'])
      await createRole(ownerPage, personas.exporter.roleName, [
        'Browse custom tables',
        'Export data bundles',
      ])
      await createRole(ownerPage, personas.importer.roleName, [
        'Browse custom tables',
        'Import data bundles',
      ])
      for (const persona of Object.values(personas)) {
        await createUser(ownerPage, {
          email: persona.email,
          displayName: persona.roleName,
          password: persona.password,
          role: persona.roleName,
        })
      }
    } finally {
      await context.close()
    }
  })

  test('custom table reader can browse without manage or transfer controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.reader, async (personaPage) => {
      await openDataWorkspace(personaPage)
      await expectDataTableVisible(personaPage, tableName)
      await expect(personaPage.getByText('System', { exact: true })).toHaveCount(0)
      await expect(personaPage.getByRole('alert')).toHaveCount(0)
      await expect(personaPage.getByRole('button', { name: 'New table' })).toHaveCount(0)
      await expect(personaPage.getByRole('button', { name: 'Export site' })).toHaveCount(0)
      await expect(personaPage.getByRole('button', { name: 'Import site' })).toHaveCount(0)
    })
  })

  test('custom table manager can create tables without import/export controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.manager, async (personaPage) => {
      await openDataWorkspace(personaPage)
      await expectDataTableVisible(personaPage, tableName)
      await expect(personaPage.getByRole('button', { name: 'New table' })).toBeVisible()
      await expect(personaPage.getByRole('button', { name: 'Export site' })).toHaveCount(0)
      await expect(personaPage.getByRole('button', { name: 'Import site' })).toHaveCount(0)
    })
  })

  test('data exporter sees export but not import or schema creation controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.exporter, async (personaPage) => {
      await openDataWorkspace(personaPage)
      await expectDataTableVisible(personaPage, tableName)
      await expect(personaPage.getByRole('button', { name: 'New table' })).toHaveCount(0)
      await expect(personaPage.getByRole('button', { name: 'Import site' })).toHaveCount(0)

      await personaPage.getByRole('button', { name: 'Export site' }).click()
      await expect(personaPage.getByRole('dialog', { name: 'Export site' })).toBeVisible()
    })
  })

  test('data importer sees import but not export or schema creation controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.importer, async (personaPage) => {
      await openDataWorkspace(personaPage)
      await expectDataTableVisible(personaPage, tableName)
      await expect(personaPage.getByRole('button', { name: 'New table' })).toHaveCount(0)
      await expect(personaPage.getByRole('button', { name: 'Export site' })).toHaveCount(0)

      await personaPage.getByRole('button', { name: 'Import site' }).click()
      await expect(personaPage.getByRole('dialog', { name: 'Import site' })).toBeVisible()
    })
  })
})

test.describe.serial('content row move capability boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  const suffix = Date.now().toString(36)
  const sourceCollectionName = `CAP Source ${suffix}`
  const targetCollectionName = `CAP Target ${suffix}`
  const entryTitle = `CAP movable entry ${suffix}`
  const personas: Record<'editor' | 'mover', PersonaAccount> = {
    editor: {
      roleName: `CAP Content Editor ${suffix}`,
      email: `cap-content-editor-${suffix}@example.com`,
      password: 'cap-content-editor-pass-12345',
    },
    mover: {
      roleName: `CAP Content Mover ${suffix}`,
      email: `cap-content-mover-${suffix}@example.com`,
      password: 'cap-content-mover-pass-12345',
    },
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000)
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    try {
      await login(ownerPage)
      await createContentCollection(ownerPage, sourceCollectionName, 'Source item')
      await createContentCollection(ownerPage, targetCollectionName, 'Target item')
      await createContentEntry(ownerPage, sourceCollectionName, 'Source item', entryTitle)

      await createRole(ownerPage, personas.editor.roleName, ['Edit any content'])
      await createRole(ownerPage, personas.mover.roleName, [
        'Edit any content',
        'Move rows between tables',
      ])
      for (const persona of Object.values(personas)) {
        await createUser(ownerPage, {
          email: persona.email,
          displayName: persona.roleName,
          password: persona.password,
          role: persona.roleName,
        })
      }
    } finally {
      await context.close()
    }
  })

  test('content editor without row-move capability cannot see move controls (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.editor, async (personaPage) => {
      await openContentWorkspace(personaPage)
      await selectContentCollection(personaPage, sourceCollectionName)
      const entry = contentEntryRow(personaPage, entryTitle)
      await expect(entry).toBeVisible()

      await entry.click({ button: 'right' })
      const menu = personaPage.getByRole('menu', { name: 'Content item options' })
      await expect(menu).toBeVisible()
      await expect(
        menu.getByRole('menuitem', { name: 'Move to collection' }),
      ).toHaveCount(0)
    })
  })

  test('content mover can move an entry between collections (CAP-004)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.mover, async (personaPage) => {
      await openContentWorkspace(personaPage)
      await selectContentCollection(personaPage, sourceCollectionName)
      const entry = contentEntryRow(personaPage, entryTitle)
      await expect(entry).toBeVisible()

      await entry.click({ button: 'right' })
      const menu = personaPage.getByRole('menu', { name: 'Content item options' })
      await menu.getByRole('menuitem', { name: 'Move to collection' }).hover()
      await personaPage.getByRole('menuitem', { name: targetCollectionName }).click()
      await expect(menu).toBeHidden()
      await expect(contentEntryRow(personaPage, entryTitle)).toHaveCount(0)

      await selectContentCollection(personaPage, targetCollectionName)
      await expect(contentEntryRow(personaPage, entryTitle)).toBeVisible({
        timeout: 20_000,
      })
    })
  })
})

test.describe.serial('site import step-up boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  test('destructive site import requires successful step-up before mutating (CAP-003)', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const bundledTableName = `CAP Imported Bundle ${suffix}`
    const localTableName = `CAP Local Table ${suffix}`
    let bundle: Buffer

    const setupContext = await browser.newContext()
    const setupPage = await setupContext.newPage()
    try {
      await login(setupPage)
      await createCustomDataTable(setupPage, bundledTableName)
      bundle = await exportCmsBundle(setupPage)
      await createCustomDataTable(setupPage, localTableName)
    } finally {
      await setupContext.close()
    }

    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await login(page)
      await openDataWorkspace(page)
      await expectDataTableVisible(page, bundledTableName)
      await expectDataTableVisible(page, localTableName)

      await openReplaceImportReview(page, bundle, `cap-replace-${suffix}.zip`)
      await page.getByRole('button', { name: 'Replace site' }).click()
      const stepUpDialog = page.getByTestId('step-up-dialog')
      await expect(stepUpDialog).toBeVisible()
      await stepUpDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(stepUpDialog).toBeHidden()
      await expectDataTablePresence(page, localTableName, true)

      await page.getByRole('button', { name: 'Replace site' }).click()
      await expect(stepUpDialog).toBeVisible()
      await page.getByTestId('step-up-password').fill('wrong-password-12345')
      await page.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog.getByRole('alert')).toBeVisible()
      await expectDataTablePresence(page, localTableName, true)

      await page.getByTestId('step-up-password').fill(OWNER.password)
      await page.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
      await expect(siteImportDialog(page, 'Review import')).toBeHidden()
      await expectDataTablePresence(page, bundledTableName, true)
      await expectDataTablePresence(page, localTableName, false)
    } finally {
      await context.close()
    }
  })
})

test.describe.serial('plugin capability boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  const suffix = Date.now().toString(36)
  const actionPluginName = `CAP Plugin Actions ${suffix}`
  const automationPluginId = `cap.automation-${suffix}`
  const automationPluginName = `CAP Plugin Automation ${suffix}`
  const automationScheduleId = `${automationPluginId}.heartbeat`
  const actionPluginManifest = {
    id: `cap.actions-${suffix}`,
    name: actionPluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Capability fixture for plugin action visibility.',
    permissions: [],
    settings: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'text',
        default: 'draft',
      },
    ],
  }
  const personas: Record<'reader' | 'installer' | 'configurator' | 'lifecycle', PersonaAccount> = {
    reader: {
      roleName: `CAP Plugin Reader ${suffix}`,
      email: `cap-plugin-reader-${suffix}@example.com`,
      password: 'cap-plugin-reader-pass-12345',
    },
    installer: {
      roleName: `CAP Plugin Installer ${suffix}`,
      email: `cap-plugin-installer-${suffix}@example.com`,
      password: 'cap-plugin-installer-pass-12345',
    },
    configurator: {
      roleName: `CAP Plugin Configurator ${suffix}`,
      email: `cap-plugin-configurator-${suffix}@example.com`,
      password: 'cap-plugin-configurator-pass-12345',
    },
    lifecycle: {
      roleName: `CAP Plugin Lifecycle ${suffix}`,
      email: `cap-plugin-lifecycle-${suffix}@example.com`,
      password: 'cap-plugin-lifecycle-pass-12345',
    },
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000)
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    try {
      await login(ownerPage)
      await openPluginsWorkspace(ownerPage)
      await installReviewedPlugin(ownerPage, actionPluginManifest, OWNER.password)
      await installReviewedPluginPackage(
        ownerPage,
        automationPluginId,
        automationPluginName,
        pluginAutomationPackageFiles(automationPluginId, automationPluginName),
        OWNER.password,
      )
      await createRole(ownerPage, personas.reader.roleName, ['Browse installed plugins'])
      await createRole(ownerPage, personas.installer.roleName, [
        'Browse installed plugins',
        'Install or uninstall plugins',
      ])
      await createRole(ownerPage, personas.configurator.roleName, [
        'Browse installed plugins',
        'Configure plugins',
      ])
      await createRole(ownerPage, personas.lifecycle.roleName, [
        'Browse installed plugins',
        'Plugin lifecycle control',
      ])
      for (const persona of Object.values(personas)) {
        await createUser(ownerPage, {
          email: persona.email,
          displayName: persona.roleName,
          password: persona.password,
          role: persona.roleName,
        })
      }
    } finally {
      await context.close()
    }
  })

  test('plugin reader can browse without install controls (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.reader, async (personaPage) => {
      await openPluginsWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload Plugin' })).toHaveCount(0)
      const pluginCard = installedPluginCard(personaPage, actionPluginName)
      await expect(pluginCard).toBeVisible()
      await expect(
        pluginCard.getByRole('button', { name: `Edit settings for ${actionPluginName}` }),
      ).toHaveCount(0)
      await expect(
        pluginCard.getByRole('button', { name: `Disable ${actionPluginName}` }),
      ).toHaveCount(0)
      await expect(
        pluginCard.getByRole('button', { name: `Remove ${actionPluginName}` }),
      ).toHaveCount(0)

      const automationCard = installedPluginCard(personaPage, automationPluginName)
      await expect(automationCard).toBeVisible()
      await expectPackResyncButton(automationCard, automationPluginName, false)
      await expectScheduleControls(
        personaPage,
        automationCard,
        automationPluginName,
        automationScheduleId,
        false,
      )
    })
  })

  test('plugin installer can access upload controls (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.installer, async (personaPage) => {
      await openPluginsWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload Plugin' })).toBeVisible()
      const pluginCard = installedPluginCard(personaPage, actionPluginName)
      await expect(
        pluginCard.getByRole('button', { name: `Remove ${actionPluginName}` }),
      ).toBeVisible()
      await expect(
        pluginCard.getByRole('button', { name: `Edit settings for ${actionPluginName}` }),
      ).toHaveCount(0)
      await expect(
        pluginCard.getByRole('button', { name: `Disable ${actionPluginName}` }),
      ).toHaveCount(0)

      const automationCard = installedPluginCard(personaPage, automationPluginName)
      await expect(automationCard).toBeVisible()
      await expectPackResyncButton(automationCard, automationPluginName, true)
      await expect(
        automationCard.getByRole('button', { name: `View schedules for ${automationPluginName}` }),
      ).toBeVisible()
    })
  })

  test('plugin configurator can open settings without install or lifecycle controls (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.configurator, async (personaPage) => {
      await openPluginsWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload Plugin' })).toHaveCount(0)
      const pluginCard = installedPluginCard(personaPage, actionPluginName)
      await expect(
        pluginCard.getByRole('button', { name: `Edit settings for ${actionPluginName}` }),
      ).toBeVisible()
      await expect(
        pluginCard.getByRole('button', { name: `Disable ${actionPluginName}` }),
      ).toHaveCount(0)
      await expect(
        pluginCard.getByRole('button', { name: `Remove ${actionPluginName}` }),
      ).toHaveCount(0)

      await pluginCard
        .getByRole('button', { name: `Edit settings for ${actionPluginName}` })
        .click()
      const dialog = personaPage.getByRole('dialog', { name: actionPluginName })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Mode')).toHaveValue('draft')
      await dialog.getByRole('button', { name: 'Cancel' }).click()

      const automationCard = installedPluginCard(personaPage, automationPluginName)
      await expect(automationCard).toBeVisible()
      await expectPackResyncButton(automationCard, automationPluginName, false)
      await expect(
        automationCard.getByRole('button', { name: `View schedules for ${automationPluginName}` }),
      ).toBeVisible()
    })
  })

  test('plugin lifecycle operator can toggle without install or settings controls (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.lifecycle, async (personaPage) => {
      await openPluginsWorkspace(personaPage)
      await expect(personaPage.getByRole('button', { name: 'Upload Plugin' })).toHaveCount(0)
      const pluginCard = installedPluginCard(personaPage, actionPluginName)
      await expect(
        pluginCard.getByRole('button', { name: `Disable ${actionPluginName}` }),
      ).toBeVisible()
      await expect(
        pluginCard.getByRole('button', { name: `Edit settings for ${actionPluginName}` }),
      ).toHaveCount(0)
      await expect(
        pluginCard.getByRole('button', { name: `Remove ${actionPluginName}` }),
      ).toHaveCount(0)

      const automationCard = installedPluginCard(personaPage, automationPluginName)
      await expect(automationCard).toBeVisible()
      await expectPackResyncButton(automationCard, automationPluginName, false)
      await expectScheduleControls(
        personaPage,
        automationCard,
        automationPluginName,
        automationScheduleId,
        true,
      )
    })
  })

  test('plugin install requires successful step-up before mutating (CAP-003)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.installer, async (personaPage) => {
      await openPluginsWorkspace(personaPage)

      const pluginName = `CAP Step-Up Plugin ${suffix}`
      await uploadPluginManifest(personaPage, {
        id: `cap.stepup-${suffix}`,
        name: pluginName,
        version: '1.0.0',
        apiVersion: 1,
        permissions: [],
      })

      await expect(
        personaPage.getByRole('heading', { name: `Review ${pluginName}` }),
      ).toBeVisible()
      await expect(installedPluginHeading(personaPage, pluginName)).toHaveCount(0)

      await personaPage.getByRole('button', { name: 'Approve and Install' }).click()
      const stepUpDialog = personaPage.getByTestId('step-up-dialog')
      await expect(stepUpDialog).toBeVisible()
      await stepUpDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(stepUpDialog).toBeHidden()
      await expect(installedPluginHeading(personaPage, pluginName)).toHaveCount(0)

      await personaPage.getByRole('button', { name: 'Approve and Install' }).click()
      await expect(stepUpDialog).toBeVisible()
      await personaPage.getByTestId('step-up-password').fill('wrong-password-12345')
      await personaPage.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog.getByRole('alert')).toBeVisible()
      await expect(installedPluginHeading(personaPage, pluginName)).toHaveCount(0)

      await personaPage.getByTestId('step-up-password').fill(personas.installer.password)
      await personaPage.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
      await expect(
        personaPage.getByRole('heading', { name: `Review ${pluginName}` }),
      ).toHaveCount(0)
      await expect(installedPluginHeading(personaPage, pluginName)).toBeVisible()
    })
  })

  test('plugin uninstall requires successful step-up before mutating (CAP-003)', async ({
    browser,
  }) => {
    const pluginName = `CAP Remove Plugin ${suffix}`
    const manifest = {
      id: `cap.remove-${suffix}`,
      name: pluginName,
      version: '1.0.0',
      apiVersion: 1,
      permissions: [],
    }

    await withPersona(browser, personas.installer, async (personaPage) => {
      await openPluginsWorkspace(personaPage)
      await installReviewedPlugin(personaPage, manifest, personas.installer.password)
      await expect(installedPluginHeading(personaPage, pluginName)).toBeVisible()
    })

    await withPersona(browser, personas.installer, async (personaPage) => {
      await openPluginsWorkspace(personaPage)
      await expect(installedPluginHeading(personaPage, pluginName)).toBeVisible()

      await openRemovePluginDialog(personaPage, pluginName)
      const stepUpDialog = personaPage.getByTestId('step-up-dialog')
      await expect(stepUpDialog).toBeVisible()
      await stepUpDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(stepUpDialog).toBeHidden()
      await expect(installedPluginHeading(personaPage, pluginName)).toBeVisible()

      await openRemovePluginDialog(personaPage, pluginName)
      await expect(stepUpDialog).toBeVisible()
      await personaPage.getByTestId('step-up-password').fill('wrong-password-12345')
      await personaPage.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog.getByRole('alert')).toBeVisible()
      await expect(installedPluginHeading(personaPage, pluginName)).toBeVisible()

      await personaPage.getByTestId('step-up-password').fill(personas.installer.password)
      await personaPage.getByTestId('step-up-confirm').click()
      await expect(stepUpDialog).toBeHidden({ timeout: 20_000 })
      await expect(installedPluginHeading(personaPage, pluginName)).toHaveCount(0)
    })
  })
})

test.describe.serial('AI capability boundaries', () => {
  test.use({ storageState: ANONYMOUS_STATE })
  test.setTimeout(180_000)

  const suffix = Date.now().toString(36)
  const personas: Record<'siteReader' | 'chatReader' | 'providerManager' | 'auditor', PersonaAccount> = {
    siteReader: {
      roleName: `CAP AI Site Reader ${suffix}`,
      email: `cap-ai-site-reader-${suffix}@example.com`,
      password: 'cap-ai-site-reader-pass-12345',
    },
    chatReader: {
      roleName: `CAP AI Chat Reader ${suffix}`,
      email: `cap-ai-chat-reader-${suffix}@example.com`,
      password: 'cap-ai-chat-reader-pass-12345',
    },
    providerManager: {
      roleName: `CAP AI Provider Manager ${suffix}`,
      email: `cap-ai-provider-manager-${suffix}@example.com`,
      password: 'cap-ai-provider-manager-pass-12345',
    },
    auditor: {
      roleName: `CAP AI Auditor ${suffix}`,
      email: `cap-ai-auditor-${suffix}@example.com`,
      password: 'cap-ai-auditor-pass-12345',
    },
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000)
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    try {
      await login(ownerPage)
      await createRole(ownerPage, personas.siteReader.roleName, ['View site'])
      await createRole(ownerPage, personas.chatReader.roleName, [
        'View site',
        'Use AI chat',
      ])
      await createRole(ownerPage, personas.providerManager.roleName, [
        'Manage AI providers',
      ])
      await createRole(ownerPage, personas.auditor.roleName, [
        'Read AI audit log',
      ])
      for (const persona of Object.values(personas)) {
        await createUser(ownerPage, {
          email: persona.email,
          displayName: persona.roleName,
          password: persona.password,
          role: persona.roleName,
        })
      }
    } finally {
      await context.close()
    }
  })

  test('site reader without ai.chat does not see assistant controls (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.siteReader, async (personaPage) => {
      await openReadableSiteEditor(personaPage)
      await expect(personaPage.getByTestId('panel-rail-agent')).toHaveCount(0)
    })
  })

  test('site reader with ai.chat can open the assistant panel (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.chatReader, async (personaPage) => {
      await openReadableSiteEditor(personaPage)
      await personaPage.getByTestId('panel-rail-agent').click()
      await expect(
        personaPage.getByRole('complementary', { name: 'AI Assistant' }),
      ).toBeVisible()
    })
  })

  test('AI provider manager can access provider/default tabs without audit (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.providerManager, async (personaPage) => {
      await openAiWorkspace(personaPage)
      await expect(personaPage.getByRole('tab', { name: 'Providers' })).toBeVisible()
      await expect(personaPage.getByRole('tab', { name: 'Defaults' })).toBeVisible()
      await expect(personaPage.getByRole('tab', { name: 'Audit' })).toHaveCount(0)
      await expect(personaPage.getByRole('heading', { name: 'Credentials' })).toBeVisible()
      await expect(personaPage.getByRole('button', { name: 'Add credential' })).toBeVisible()

      await personaPage.getByRole('tab', { name: 'Defaults' }).click()
      await expect(personaPage.getByRole('heading', { name: 'Per-scope defaults' })).toBeVisible()
      await expect(personaPage.getByRole('heading', { name: 'Usage audit' })).toHaveCount(0)
    })
  })

  test('AI auditor can access audit without provider/default controls (CAP-005)', async ({
    browser,
  }) => {
    await withPersona(browser, personas.auditor, async (personaPage) => {
      await openAiWorkspace(personaPage)
      await expect(personaPage.getByRole('tab', { name: 'Audit' })).toBeVisible()
      await expect(personaPage.getByRole('tab', { name: 'Providers' })).toHaveCount(0)
      await expect(personaPage.getByRole('tab', { name: 'Defaults' })).toHaveCount(0)
      await expect(personaPage.getByRole('heading', { name: 'Usage audit' })).toBeVisible()
      await expect(personaPage.getByLabel('Audit range')).toBeVisible()
      await expect(personaPage.getByRole('button', { name: 'Add credential' })).toHaveCount(0)
      await expect(personaPage.getByRole('heading', { name: 'Per-scope defaults' })).toHaveCount(0)
    })
  })
})

async function seedCapabilityPage(
  page: Page,
  suffix: string,
  seededText: string,
  secondText: string,
): Promise<string> {
  await openSiteEditor(page)
  const pageName = `Capability boundaries ${suffix}`
  await createPage(page, pageName, `capability-boundaries-${suffix}`)
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', seededText)
  await insertNotchModule(page, 'text')
  await setPropValue(page, 'text', secondText)
  await saveDraft(page)
  return pageName
}

async function createRole(
  page: Page,
  name: string,
  capabilityLabels: readonly string[],
): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Roles', exact: true }).click()
  await page.getByRole('button', { name: 'Create Role', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Create Role' })
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  for (const label of capabilityLabels) {
    await dialog.getByText(label, { exact: true }).click()
  }

  await page.locator('button[form="users-page-role-form"]').click()
  await completeStepUp(page)
  await expect(dialog).toBeHidden()
}

async function createUser(
  page: Page,
  user: { email: string; displayName: string; password: string; role: string },
): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  await page.locator('input[name="new-user-email-address"]').fill(user.email)
  await page.locator('input[name="new-user-display-name"]').fill(user.displayName)
  await page.locator('input[name="new-user-initial-password"]').fill(user.password)
  await page.locator('select[name="new-user-role"]').selectOption({ label: user.role })
  await page.locator('button[form="users-page-user-form"]').click()
  await completeStepUp(page)
}

async function withPersona(
  browser: Browser,
  persona: { email: string; password: string },
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext()
  const personaPage = await context.newPage()
  try {
    await loginAs(personaPage, persona.email, persona.password)
    await run(personaPage)
  } finally {
    await context.close()
  }
}

async function openNamedPage(page: Page, name: string): Promise<void> {
  await openReadableSiteEditor(page)
  await openSitePanel(page)
  const item = page.getByRole('treeitem', { name: `Open page ${name}` })
  await expect(item).toBeVisible()
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
}

async function openReadableSiteEditor(page: Page): Promise<void> {
  if (!(await page.getByTestId('canvas-root').isVisible({ timeout: 1_000 }).catch(() => false))) {
    await page.goto('/admin/site')
  }
  await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
}

async function expectAbsentOrDisabled(locator: ReturnType<Page['getByTestId']>): Promise<void> {
  if ((await locator.count()) === 0) return
  await expect(locator).toBeDisabled()
}

async function openContentWorkspace(page: Page): Promise<void> {
  await page.goto('/admin/content')
  await expect(page.getByTestId('content-explorer-panel')).toBeVisible({
    timeout: 20_000,
  })
}

async function createContentCollection(
  page: Page,
  collectionName: string,
  singularLabel: string,
): Promise<void> {
  await openContentWorkspace(page)
  await page.getByRole('button', { name: 'New collection' }).click()
  const dialog = page.getByRole('dialog', { name: 'New collection' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name').fill(collectionName)
  await dialog.getByLabel('Singular label').fill(singularLabel)
  await dialog.getByLabel('Plural label').fill(collectionName)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await completeStepUp(page)
  await expect(dialog).toBeHidden({ timeout: 20_000 })
  await selectContentCollection(page, collectionName)
}

async function createContentEntry(
  page: Page,
  collectionName: string,
  singularLabel: string,
  title: string,
): Promise<void> {
  await openContentWorkspace(page)
  await selectContentCollection(page, collectionName)
  await page
    .getByTestId('content-explorer-panel')
    .getByRole('button', { name: `New ${singularLabel.toLowerCase()}` })
    .click()
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
  await page.getByRole('button', { name: 'More publishing actions' }).click()
  await page.getByTestId('toolbar-content-save-draft-action').click()
  await expect(contentEntryRow(page, title)).toBeVisible({ timeout: 20_000 })
}

async function selectContentCollection(page: Page, collectionName: string): Promise<void> {
  const collection = page
    .getByRole('region', { name: 'Collections' })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(collectionName)}\\b`) })
  await expect(collection).toBeVisible({ timeout: 20_000 })
  await collection.click()
}

function contentEntryRow(page: Page, title: string) {
  return page.getByTestId('content-explorer-panel').getByRole('button').filter({
    hasText: title,
  })
}

async function openMediaWorkspace(page: Page): Promise<void> {
  await page.goto('/admin/media')
  await expect(page.getByTestId('media-canvas')).toBeVisible({ timeout: 20_000 })
}

async function openDataWorkspace(page: Page): Promise<void> {
  await page.goto('/admin/data')
  await expect(page.getByTestId('data-left-sidebar')).toBeVisible({ timeout: 20_000 })
}

async function openPluginsWorkspace(page: Page): Promise<void> {
  await page.goto('/admin/plugins')
  await expect(page.getByTestId('plugins-admin-canvas')).toBeVisible({ timeout: 20_000 })
}

async function openAiWorkspace(page: Page): Promise<void> {
  await page.goto('/admin/ai')
  await expect(page.getByRole('heading', { name: 'AI', exact: true })).toBeVisible({
    timeout: 20_000,
  })
}

async function expectDataTableVisible(page: Page, tableName: string): Promise<void> {
  await expect(
    page.getByRole('option', { name: new RegExp(`^${escapeRegExp(tableName)}\\b`) }),
  ).toBeVisible({ timeout: 20_000 })
}

async function createCustomDataTable(page: Page, tableName: string): Promise<void> {
  await openDataWorkspace(page)
  await page.getByRole('button', { name: 'New table' }).click()
  const dialog = page.getByRole('dialog', { name: 'New table' })
  await dialog.getByLabel('Name', { exact: true }).fill(tableName)
  await dialog.getByLabel('Plural label').fill(tableName)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await completeStepUp(page)
  await expect(dialog).toBeHidden()
  await expectDataTableVisible(page, tableName)
}

async function exportCmsBundle(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const response = await fetch('/admin/api/cms/export', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        includeSite: false,
        includeMedia: false,
        includeMediaFolders: false,
        includeRedirects: false,
      }),
    })
    if (!response.ok) {
      throw new Error(`Export failed with HTTP ${response.status}: ${await response.text()}`)
    }
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  })
  return Buffer.from(bytes)
}

async function openReplaceImportReview(
  page: Page,
  bundle: Buffer,
  filename: string,
): Promise<void> {
  await openDataWorkspace(page)
  await page.getByRole('button', { name: 'Import site' }).click()
  await expect(siteImportDialog(page, 'Import site')).toBeVisible()
  await page.locator('input[type="file"]').first().setInputFiles({
    name: filename,
    mimeType: 'application/zip',
    buffer: bundle,
  })

  const review = siteImportDialog(page, 'Review import')
  await expect(review).toBeVisible({ timeout: 20_000 })
  await expect(review).toContainText(filename)
  await review.getByRole('radio', { name: 'Replace everything' }).click()
  await expect(page.getByRole('button', { name: 'Replace site' })).toBeEnabled()
}

function siteImportDialog(page: Page, name: 'Import site' | 'Review import') {
  return page
    .getByRole('dialog', { name })
    .or(page.getByRole('alertdialog', { name }))
}

async function expectDataTablePresence(
  page: Page,
  tableName: string,
  shouldExist: boolean,
): Promise<void> {
  await expect.poll(async () => dataTableExists(page, tableName), {
    timeout: 20_000,
  }).toBe(shouldExist)
}

async function dataTableExists(page: Page, tableName: string): Promise<boolean> {
  const names = await page.evaluate(async () => {
    function isPlainRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null
    }

    const response = await fetch('/admin/api/cms/data/tables', { credentials: 'include' })
    if (!response.ok) {
      throw new Error(`Table list failed with HTTP ${response.status}: ${await response.text()}`)
    }
    const body: unknown = await response.json()
    if (!isPlainRecord(body) || !Array.isArray(body.tables)) return []

    return body.tables.flatMap((table) => {
      if (!isPlainRecord(table)) return []
      const values = [table.name, table.pluralLabel]
      return values.filter((value): value is string => typeof value === 'string')
    })
  })
  return names.includes(tableName)
}

async function uploadMediaFile(page: Page, filename: string): Promise<void> {
  await expect(page.getByRole('button', { name: 'Upload media' })).toBeVisible()
  await page.locator('input[type="file"]').first().setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })
  await expect(page.getByRole('button', { name: `Open ${filename}` })).toBeVisible({
    timeout: 20_000,
  })
}

async function waitForMediaReplace(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().includes('/admin/api/cms/media/') &&
    response.url().endsWith('/replace') &&
    response.ok(),
  )
}

async function waitForMediaDelete(page: Page): Promise<void> {
  await page.waitForResponse((response) =>
    response.request().method() === 'DELETE' &&
    response.url().includes('/admin/api/cms/media/') &&
    response.ok(),
  )
}

async function uploadPluginManifest(
  page: Page,
  manifest: Record<string, unknown>,
): Promise<void> {
  await page.getByLabel('Plugin file').setInputFiles({
    name: `${String(manifest.id)}.plugin.json`,
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

async function installReviewedPlugin(
  page: Page,
  manifest: Record<string, unknown>,
  stepUpPassword: string,
): Promise<void> {
  const pluginName = String(manifest.name)
  await uploadPluginManifest(page, manifest)
  await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
  await page.getByRole('button', { name: 'Approve and Install' }).click()
  await completeStepUp(page, stepUpPassword)
  await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toHaveCount(0)
  await expect(installedPluginHeading(page, pluginName)).toBeVisible()
}

async function installReviewedPluginPackage(
  page: Page,
  pluginId: string,
  pluginName: string,
  files: Record<string, string>,
  stepUpPassword: string,
): Promise<void> {
  await uploadPluginPackage(page, pluginId, files)
  await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toBeVisible()
  await page.getByRole('button', { name: 'Approve and Install' }).click()
  await completeStepUp(page, stepUpPassword)
  await expect(page.getByRole('heading', { name: `Review ${pluginName}` })).toHaveCount(0)
  await expect(installedPluginHeading(page, pluginName)).toBeVisible()
}

function installedPluginHeading(page: Page, pluginName: string) {
  return page
    .locator('[aria-label="Installed plugins"]')
    .getByRole('heading', { name: pluginName })
}

function installedPluginCard(page: Page, pluginName: string) {
  return page.locator('article').filter({
    has: page.getByRole('heading', { name: pluginName }),
  })
}

async function expectPackResyncButton(
  pluginCard: ReturnType<typeof installedPluginCard>,
  pluginName: string,
  visible: boolean,
): Promise<void> {
  const button = pluginCard.getByRole('button', {
    name: `Re-sync ${pluginName} pack from the plugin's latest version`,
  })
  if (visible) {
    await expect(button).toBeVisible()
  } else {
    await expect(button).toHaveCount(0)
  }
}

async function expectScheduleControls(
  page: Page,
  pluginCard: ReturnType<typeof installedPluginCard>,
  pluginName: string,
  scheduleId: string,
  canManageLifecycle: boolean,
): Promise<void> {
  await pluginCard.getByRole('button', { name: `View schedules for ${pluginName}` }).click()
  const dialog = page.getByRole('dialog', { name: pluginName })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: scheduleId })).toBeVisible()
  await expect(dialog.getByText('Every 15 minutes')).toBeVisible()

  if (canManageLifecycle) {
    await expect(dialog.getByRole('button', { name: 'Run now' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()
  } else {
    await expect(dialog.getByRole('button', { name: 'Run now' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Pause' })).toHaveCount(0)
  }

  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(dialog).toHaveCount(0)
}

async function openRemovePluginDialog(page: Page, pluginName: string): Promise<void> {
  await page.getByRole('button', { name: `Remove ${pluginName}` }).click()
  const dialog = page.getByRole('alertdialog', { name: pluginName })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove plugin' }).click()
}

function pluginPackageBuffer(files: Record<string, string>): Buffer {
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, source]) => [path, strToU8(source)]),
  )
  return Buffer.from(zipSync(entries))
}

function pluginAutomationPackageFiles(
  pluginId: string,
  pluginName: string,
): Record<string, string> {
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 1,
    description: 'Capability fixture for schedule and pack action visibility.',
    permissions: ['cms.schedule', 'visualComponents.register'],
    entrypoints: { server: 'server/index.js' },
    pack: { path: 'pack/site.json' },
  }
  const rootId = `${pluginId}.pack-root`
  const textId = `${pluginId}.pack-text`
  const pack = {
    pages: [
      {
        id: `${pluginId}.pack-page`,
        title: `${pluginName} Pack Page`,
        slug: `${pluginId.replaceAll('.', '-')}-pack`,
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
              text: `${pluginName} pack content`,
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
    'server/index.js': `
      export async function activate(api) {
        await api.cms.schedule.every(15, 'heartbeat', async () => {})
      }
    `,
    'pack/site.json': JSON.stringify(pack),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
