import { describe, expect, it } from 'bun:test'
import { classKindSelector, type Page, type StyleRule, type SiteShell } from '@core/page-tree'
import { pageFromRow } from '@core/data/pageFromRow'
import type { DataRow } from '@core/data/schemas'
import { selectToolsForScope } from '../../../server/ai/tools'
import {
  createCapabilityTestHarness,
  expectForbidden,
  expectPastAuth,
  expectStepUpRequired,
  readJson,
} from '../helpers/capabilityHarness'

async function loadSiteShell(
  harness: Awaited<ReturnType<typeof createCapabilityTestHarness>>,
  cookie: string,
): Promise<SiteShell> {
  const res = await harness.cms('/admin/api/cms/site', { method: 'GET', cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ site: SiteShell }>(res)
  return body.site
}

async function loadPages(
  harness: Awaited<ReturnType<typeof createCapabilityTestHarness>>,
  cookie: string,
): Promise<Page[]> {
  const res = await harness.cms('/admin/api/cms/pages', { method: 'GET', cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ rows: DataRow[] }>(res)
  return body.rows.map(pageFromRow)
}

function userClass(id: string): StyleRule {
  return {
    id,
    name: id,
    kind: 'class',
    selector: classKindSelector(id),
    order: 0,
    styles: { color: 'var(--text)' },
    contextStyles: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function emptyForm(): FormData {
  return new FormData()
}

describe('capability route matrix', () => {
  it('enforces content/style/structure site-shell diffs independently', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()
      const contentUser = await harness.createRoleUser({
        name: 'Content Editor',
        slug: 'content-editor',
        capabilities: ['site.read', 'site.content.edit'],
      })
      const styleUser = await harness.createRoleUser({
        name: 'Style Editor',
        slug: 'style-editor',
        capabilities: ['site.read', 'site.style.edit'],
      })
      const structureUser = await harness.createRoleUser({
        name: 'Structure Editor',
        slug: 'structure-editor',
        capabilities: ['site.read', 'site.structure.edit'],
      })

      const baseShell = await loadSiteShell(harness, ownerCookie)
      const contentEdit: SiteShell = {
        ...baseShell,
        settings: { ...baseShell.settings, seo: { titlePattern: 'Client-owned title' } },
      }
      const contentAllowed = await harness.cms('/admin/api/cms/site', {
        method: 'PUT',
        cookie: contentUser.cookie,
        json: { site: contentEdit },
      })
      expect(contentAllowed.status).toBe(200)

      const afterContent = await loadSiteShell(harness, ownerCookie)
      const contentStyleAttempt = await harness.cms('/admin/api/cms/site', {
        method: 'PUT',
        cookie: contentUser.cookie,
        json: {
          site: {
            ...afterContent,
            styleRules: {
              ...afterContent.styleRules,
              contentCannotStyle: userClass('contentCannotStyle'),
            },
          },
        },
      })
      expect(contentStyleAttempt.status).toBe(403)
      expect(await readJson<{ kind?: string }>(contentStyleAttempt)).toMatchObject({ kind: 'style' })

      const styleEdit: SiteShell = {
        ...afterContent,
        styleRules: {
          ...afterContent.styleRules,
          styleCanStyle: userClass('styleCanStyle'),
        },
      }
      const styleAllowed = await harness.cms('/admin/api/cms/site', {
        method: 'PUT',
        cookie: styleUser.cookie,
        json: { site: styleEdit },
      })
      expect(styleAllowed.status).toBe(200)

      const afterStyle = await loadSiteShell(harness, ownerCookie)
      const styleContentAttempt = await harness.cms('/admin/api/cms/site', {
        method: 'PUT',
        cookie: styleUser.cookie,
        json: {
          site: {
            ...afterStyle,
            settings: { ...afterStyle.settings, seo: { titlePattern: 'Style cannot edit copy' } },
          },
        },
      })
      expect(styleContentAttempt.status).toBe(403)
      expect(await readJson<{ kind?: string }>(styleContentAttempt)).toMatchObject({ kind: 'content' })

      const structureAllowed = await harness.cms('/admin/api/cms/site', {
        method: 'PUT',
        cookie: structureUser.cookie,
        json: { site: { ...afterStyle, name: 'Capability Matrix Renamed' } },
      })
      expect(structureAllowed.status).toBe(200)

      const afterStructure = await loadSiteShell(harness, ownerCookie)
      const structureContentAttempt = await harness.cms('/admin/api/cms/site', {
        method: 'PUT',
        cookie: structureUser.cookie,
        json: {
          site: {
            ...afterStructure,
            settings: { ...afterStructure.settings, seo: { description: 'Structure cannot edit copy' } },
          },
        },
      })
      expect(structureContentAttempt.status).toBe(403)
      expect(await readJson<{ kind?: string }>(structureContentAttempt)).toMatchObject({ kind: 'content' })
    } finally {
      await harness.cleanup()
    }
  })

  it('keeps page reconciliation and publish behind structural/publish capabilities', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const reader = await harness.createRoleUser({
        name: 'Site Reader',
        slug: 'site-reader',
        capabilities: ['site.read'],
      })
      const contentEditor = await harness.createRoleUser({
        name: 'Page Content Editor',
        slug: 'page-content-editor',
        capabilities: ['site.read', 'site.content.edit'],
      })
      const structureEditor = await harness.createRoleUser({
        name: 'Page Structure Editor',
        slug: 'page-structure-editor',
        capabilities: ['site.read', 'site.structure.edit'],
      })
      const publisher = await harness.createRoleUser({
        name: 'Publisher',
        slug: 'publisher',
        capabilities: ['pages.publish'],
      })

      const pagesRead = await harness.cms('/admin/api/cms/pages', {
        method: 'GET',
        cookie: reader.cookie,
      })
      expect(pagesRead.status).toBe(200)
      const existingPages = await loadPages(harness, reader.cookie)
      const existingPageIds = existingPages.map((page) => page.id)

      const contentCannotReconcile = await harness.cms('/admin/api/cms/pages', {
        method: 'PUT',
        cookie: contentEditor.cookie,
        json: {
          changedPages: [],
          pageIds: [],
          baselinePageIds: existingPageIds,
        },
      })
      expect(contentCannotReconcile.status).toBe(403)
      expect(await readJson<{ kind?: string }>(contentCannotReconcile)).toMatchObject({ kind: 'structure' })

      const contentNoopComponents = await harness.cms('/admin/api/cms/components', {
        method: 'PUT',
        cookie: contentEditor.cookie,
        json: { changedComponents: [], componentIds: [] },
      })
      expect(contentNoopComponents.status).toBe(200)

      const contentNoopLayouts = await harness.cms('/admin/api/cms/layouts', {
        method: 'PUT',
        cookie: contentEditor.cookie,
        json: { changedLayouts: [], layoutIds: [] },
      })
      expect(contentNoopLayouts.status).toBe(200)

      const structureCanReachReconcile = await harness.cms('/admin/api/cms/pages', {
        method: 'PUT',
        cookie: structureEditor.cookie,
        json: { pages: [] },
      })
      expectPastAuth(structureCanReachReconcile)

      const readerPublish = await harness.cms('/admin/api/cms/publish', {
        method: 'POST',
        cookie: reader.cookie,
      })
      await expectForbidden(readerPublish)

      const publisherNeedsStepUp = await harness.cms('/admin/api/cms/publish', {
        method: 'POST',
        cookie: publisher.cookie,
      })
      await expectStepUpRequired(publisherNeedsStepUp)

      const steppedPublisher = await harness.stepUp(publisher.cookie)
      const publisherCanReachPublish = await harness.cms('/admin/api/cms/publish', {
        method: 'POST',
        cookie: steppedPublisher,
      })
      expectPastAuth(publisherCanReachPublish)
    } finally {
      await harness.cleanup()
    }
  })

  it('lets content editors save content-only changes to existing page nodes', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()
      const contentEditor = await harness.createRoleUser({
        name: 'Existing Page Content Editor',
        slug: 'existing-page-content-editor',
        capabilities: ['site.read', 'site.content.edit'],
      })

      const pages = await loadPages(harness, ownerCookie)
      const pageIds = pages.map((page) => page.id)
      const seededPage = structuredClone(pages[0])
      const textNodeId = 'content-edit-target'
      seededPage.nodes[seededPage.rootNodeId].children.push(textNodeId)
      seededPage.nodes[textNodeId] = {
        id: textNodeId,
        moduleId: 'base.text',
        props: { text: 'Owner seed', tag: 'p' },
        children: [],
        breakpointOverrides: {},
        classIds: [],
      }

      const seedRes = await harness.cms('/admin/api/cms/pages', {
        method: 'PUT',
        cookie: ownerCookie,
        json: {
          changedPages: [seededPage],
          pageIds,
          baselinePageIds: pageIds,
        },
      })
      expect(seedRes.status).toBe(200)

      const editorPages = await loadPages(harness, contentEditor.cookie)
      const editedPage = structuredClone(editorPages.find((page) => page.id === seededPage.id)!)
      editedPage.nodes[textNodeId].props.text = 'Content editor update'

      const editRes = await harness.cms('/admin/api/cms/pages', {
        method: 'PUT',
        cookie: contentEditor.cookie,
        json: {
          changedPages: [editedPage],
          pageIds: editorPages.map((page) => page.id),
          baselinePageIds: editorPages.map((page) => page.id),
        },
      })
      expect(editRes.status).toBe(200)

      const saved = await loadPages(harness, ownerCookie)
      const savedPage = saved.find((page) => page.id === seededPage.id)!
      expect(savedPage.nodes[textNodeId].props.text).toBe('Content editor update')
    } finally {
      await harness.cleanup()
    }
  })

  it('does not let media, runtime, and storage capabilities substitute for each other', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const mediaReader = await harness.createRoleUser({
        name: 'Media Reader',
        slug: 'media-reader',
        capabilities: ['media.read'],
      })
      const mediaWriter = await harness.createRoleUser({
        name: 'Media Writer',
        slug: 'media-writer',
        capabilities: ['media.write'],
      })
      const mediaReplacer = await harness.createRoleUser({
        name: 'Media Replacer',
        slug: 'media-replacer',
        capabilities: ['media.replace'],
      })
      const mediaDeleter = await harness.createRoleUser({
        name: 'Media Deleter',
        slug: 'media-deleter',
        capabilities: ['media.delete'],
      })
      const runtimeManager = await harness.createRoleUser({
        name: 'Runtime Manager',
        slug: 'runtime-manager',
        capabilities: ['runtime.dependencies'],
      })
      const storageElector = await harness.createRoleUser({
        name: 'Storage Elector',
        slug: 'storage-elector',
        capabilities: ['storage.elect'],
      })
      const storageMigrator = await harness.createRoleUser({
        name: 'Storage Migrator',
        slug: 'storage-migrator',
        capabilities: ['storage.migrate'],
      })

      expect((await harness.cms('/admin/api/cms/media', {
        method: 'GET',
        cookie: mediaReader.cookie,
      })).status).toBe(200)
      await expectForbidden(await harness.cms('/admin/api/cms/media', {
        method: 'POST',
        cookie: mediaReader.cookie,
        body: emptyForm(),
      }))

      await expectForbidden(await harness.cms('/admin/api/cms/media', {
        method: 'GET',
        cookie: mediaWriter.cookie,
      }))
      const writerUpload = await harness.cms('/admin/api/cms/media', {
        method: 'POST',
        cookie: mediaWriter.cookie,
        body: emptyForm(),
      })
      expectPastAuth(writerUpload)

      await expectForbidden(await harness.cms('/admin/api/cms/media/missing/replace', {
        method: 'POST',
        cookie: mediaWriter.cookie,
        body: emptyForm(),
      }))
      const replacerReplace = await harness.cms('/admin/api/cms/media/missing/replace', {
        method: 'POST',
        cookie: mediaReplacer.cookie,
        body: emptyForm(),
      })
      expectPastAuth(replacerReplace)

      await expectForbidden(await harness.cms('/admin/api/cms/media/missing', {
        method: 'DELETE',
        cookie: mediaReader.cookie,
      }))
      const deleterDelete = await harness.cms('/admin/api/cms/media/missing', {
        method: 'DELETE',
        cookie: mediaDeleter.cookie,
      })
      expectPastAuth(deleterDelete)

      await expectForbidden(await harness.cms('/admin/api/cms/runtime/dependencies/resolve', {
        method: 'POST',
        cookie: storageElector.cookie,
        json: { packageJson: { dependencies: {} } },
      }))
      expect((await harness.cms('/admin/api/cms/runtime/dependencies/resolve', {
        method: 'POST',
        cookie: runtimeManager.cookie,
        json: { packageJson: { dependencies: {} } },
      })).status).toBe(200)

      await expectForbidden(await harness.cms('/admin/api/cms/media/storage', {
        method: 'GET',
        cookie: runtimeManager.cookie,
      }))
      expect((await harness.cms('/admin/api/cms/media/storage', {
        method: 'GET',
        cookie: storageElector.cookie,
      })).status).toBe(200)

      await expectForbidden(await harness.cms('/admin/api/cms/media/storage/migrate', {
        method: 'POST',
        cookie: storageElector.cookie,
        json: { role: 'original', toAdapterId: '' },
      }))
      const migratorCanReachMigration = await harness.cms('/admin/api/cms/media/storage/migrate', {
        method: 'POST',
        cookie: storageMigrator.cookie,
        json: { role: 'original', toAdapterId: '' },
      })
      expectPastAuth(migratorCanReachMigration)
    } finally {
      await harness.cleanup()
    }
  })

  it('splits plugin read, configure, install, and lifecycle admin routes', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const pluginReader = await harness.createRoleUser({
        name: 'Plugin Reader',
        slug: 'plugin-reader',
        capabilities: ['plugins.read'],
      })
      const pluginConfigurator = await harness.createRoleUser({
        name: 'Plugin Configurator',
        slug: 'plugin-configurator',
        capabilities: ['plugins.configure'],
      })
      const pluginInstaller = await harness.createRoleUser({
        name: 'Plugin Installer',
        slug: 'plugin-installer',
        capabilities: ['plugins.install'],
      })
      const pluginLifecycle = await harness.createRoleUser({
        name: 'Plugin Lifecycle',
        slug: 'plugin-lifecycle',
        capabilities: ['plugins.lifecycle'],
      })

      expect((await harness.cms('/admin/api/cms/plugins', {
        method: 'GET',
        cookie: pluginReader.cookie,
      })).status).toBe(200)
      await expectForbidden(await harness.cms('/admin/api/cms/plugins/missing', {
        method: 'PATCH',
        cookie: pluginReader.cookie,
        json: { enabled: false },
      }))
      await expectForbidden(await harness.cms('/admin/api/cms/plugins/missing/settings', {
        method: 'GET',
        cookie: pluginReader.cookie,
      }))

      const settingsRead = await harness.cms('/admin/api/cms/plugins/missing/settings', {
        method: 'GET',
        cookie: pluginConfigurator.cookie,
      })
      expectPastAuth(settingsRead)
      await expectStepUpRequired(await harness.cms('/admin/api/cms/plugins/missing/settings', {
        method: 'PUT',
        cookie: pluginConfigurator.cookie,
        json: { settings: {} },
      }))
      const steppedConfigurator = await harness.stepUp(pluginConfigurator.cookie)
      expectPastAuth(await harness.cms('/admin/api/cms/plugins/missing/settings', {
        method: 'PUT',
        cookie: steppedConfigurator,
        json: { settings: {} },
      }))

      const inspectPackage = await harness.cms('/admin/api/cms/plugins/inspect-package', {
        method: 'POST',
        cookie: pluginInstaller.cookie,
        body: emptyForm(),
      })
      expectPastAuth(inspectPackage)
      await expectStepUpRequired(await harness.cms('/admin/api/cms/plugins', {
        method: 'POST',
        cookie: pluginInstaller.cookie,
        json: { manifest: {} },
      }))
      await expectStepUpRequired(await harness.cms('/admin/api/cms/plugins/missing', {
        method: 'DELETE',
        cookie: pluginInstaller.cookie,
      }))

      await expectStepUpRequired(await harness.cms('/admin/api/cms/plugins/missing', {
        method: 'PATCH',
        cookie: pluginLifecycle.cookie,
        json: { enabled: false },
      }))
      const steppedLifecycle = await harness.stepUp(pluginLifecycle.cookie)
      expectPastAuth(await harness.cms('/admin/api/cms/plugins/missing', {
        method: 'PATCH',
        cookie: steppedLifecycle,
        json: { enabled: false },
      }))
    } finally {
      await harness.cleanup()
    }
  })

  it('keeps transfer export/preview/import behind separate data capabilities', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const tableReader = await harness.createRoleUser({
        name: 'Table Reader',
        slug: 'table-reader',
        capabilities: ['data.custom.tables.read'],
      })
      const exporter = await harness.createRoleUser({
        name: 'Data Exporter',
        slug: 'data-exporter',
        capabilities: ['data.export'],
      })
      const importer = await harness.createRoleUser({
        name: 'Data Importer',
        slug: 'data-importer',
        capabilities: ['data.import'],
      })
      const destructiveImporter = await harness.createRoleUser({
        name: 'Destructive Importer',
        slug: 'destructive-importer',
        capabilities: ['data.import', 'content.manage'],
      })

      await expectForbidden(await harness.cms('/admin/api/cms/export', {
        method: 'GET',
        cookie: tableReader.cookie,
      }))
      expect((await harness.cms('/admin/api/cms/export', {
        method: 'GET',
        cookie: exporter.cookie,
      })).status).toBe(200)

      await expectForbidden(await harness.cms('/admin/api/cms/import/preview', {
        method: 'POST',
        cookie: tableReader.cookie,
        json: {},
      }))
      const previewInvalidBundle = await harness.cms('/admin/api/cms/import/preview', {
        method: 'POST',
        cookie: exporter.cookie,
        json: {},
      })
      expectPastAuth(previewInvalidBundle)

      await expectForbidden(await harness.cms('/admin/api/cms/import?strategy=merge-add', {
        method: 'POST',
        cookie: exporter.cookie,
        json: {},
      }))
      const importerInvalidBundle = await harness.cms('/admin/api/cms/import?strategy=merge-add', {
        method: 'POST',
        cookie: importer.cookie,
        json: {},
      })
      expectPastAuth(importerInvalidBundle)

      await expectForbidden(await harness.cms('/admin/api/cms/import', {
        method: 'POST',
        cookie: importer.cookie,
        json: {},
      }))
      await expectStepUpRequired(await harness.cms('/admin/api/cms/import', {
        method: 'POST',
        cookie: destructiveImporter.cookie,
        json: {},
      }))
    } finally {
      await harness.cleanup()
    }
  })

  it('gates AI provider/audit/chat routes and filters mutating tools', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const dashboardOnly = await harness.createRoleUser({
        name: 'Dashboard Only',
        slug: 'dashboard-only',
        capabilities: ['dashboard.read'],
      })
      const providerManager = await harness.createRoleUser({
        name: 'AI Provider Manager',
        slug: 'ai-provider-manager',
        capabilities: ['ai.providers.manage'],
      })
      const auditReader = await harness.createRoleUser({
        name: 'AI Audit Reader',
        slug: 'ai-audit-reader',
        capabilities: ['ai.audit.read'],
      })
      const chatUser = await harness.createRoleUser({
        name: 'AI Chat User',
        slug: 'ai-chat-user',
        capabilities: ['ai.chat'],
      })

      await expectForbidden(await harness.ai('/admin/api/ai/credentials', {
        method: 'GET',
        cookie: dashboardOnly.cookie,
      }))
      expect((await harness.ai('/admin/api/ai/credentials', {
        method: 'GET',
        cookie: providerManager.cookie,
      })).status).toBe(200)
      const invalidCredentialCreate = await harness.ai('/admin/api/ai/credentials', {
        method: 'POST',
        cookie: providerManager.cookie,
        json: {},
      })
      expectPastAuth(invalidCredentialCreate)

      await expectForbidden(await harness.ai('/admin/api/ai/audit', {
        method: 'GET',
        cookie: providerManager.cookie,
      }))
      expect((await harness.ai('/admin/api/ai/audit', {
        method: 'GET',
        cookie: auditReader.cookie,
      })).status).toBe(200)

      await expectForbidden(await harness.ai('/admin/api/ai/conversations?scope=site', {
        method: 'GET',
        cookie: dashboardOnly.cookie,
      }))
      expect((await harness.ai('/admin/api/ai/conversations?scope=site', {
        method: 'GET',
        cookie: chatUser.cookie,
      })).status).toBe(200)
      const invalidChat = await harness.ai('/admin/api/ai/chat/site', {
        method: 'POST',
        cookie: chatUser.cookie,
        json: {},
      })
      expectPastAuth(invalidChat)

      const readOnlyTools = selectToolsForScope('site', ['ai.chat', 'site.read'])
      const writeTools = selectToolsForScope('site', [
        'ai.chat',
        'ai.tools.write',
        'site.structure.edit',
      ])
      const readOnlyToolNames = readOnlyTools.map((tool) => tool.name)
      expect(readOnlyTools.length).toBeGreaterThan(0)
      expect(readOnlyTools.every((tool) => !tool.mutates)).toBe(true)
      expect(readOnlyToolNames).toContain('list_documents')
      expect(readOnlyToolNames).toContain('read_document')
      expect(readOnlyToolNames).toContain('open_document')
      expect(readOnlyToolNames).not.toContain('insertHtml')
      expect(writeTools.some((tool) => tool.mutates)).toBe(true)
      expect(writeTools.length).toBeGreaterThan(readOnlyTools.length)
    } finally {
      await harness.cleanup()
    }
  })
})
