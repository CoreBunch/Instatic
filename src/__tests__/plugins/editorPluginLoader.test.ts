import { beforeEach, describe, expect, it } from 'bun:test'
import { activateInstalledEditorPlugins } from '@core/plugins/editorPluginLoader'
import { pluginRuntime } from '@core/plugins/runtime'
import type { CmsPluginsPayload, PluginManifest } from '@core/plugin-sdk'

const workflowManifest: PluginManifest = {
  id: 'acme.workflow',
  name: 'Workflow Tools',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['editor.code', 'editor.commands', 'editor.toolbar'],
  grantedPermissions: ['editor.code', 'editor.commands', 'editor.toolbar'],
  entrypoints: {
    editor: 'editor/index.js',
  },
  assetBasePath: '/uploads/plugins/acme.workflow/1.0.0',
  resources: [],
  adminPages: [],
}

beforeEach(() => {
  pluginRuntime.reset()
})

describe('installed editor plugin loader', () => {
  it('loads enabled packaged editor plugins and activates them with granted permissions', async () => {
    const payload: CmsPluginsPayload = {
      adminPages: [],
      plugins: [{
        id: workflowManifest.id,
        name: workflowManifest.name,
        version: workflowManifest.version,
        enabled: true,
        lifecycleStatus: 'active',
        lastError: null,
        grantedPermissions: ['editor.code', 'editor.commands', 'editor.toolbar'],
        manifest: workflowManifest,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }
    const imported: string[] = []

    const result = await activateInstalledEditorPlugins({
      fetchImpl: async () => Response.json(payload),
      importEditorModule: async (url) => {
        imported.push(url)
        return {
          activate(api) {
            api.editor.commands.register({
              id: 'workflow.approve',
              label: 'Approve Page',
              run: () => {},
            })
            api.editor.toolbar.addButton({
              id: 'workflow.approve',
              label: 'Approve',
              command: 'workflow.approve',
            })
          },
        }
      },
    })

    expect(imported).toEqual(['/uploads/plugins/acme.workflow/1.0.0/editor/index.js'])
    expect(result).toEqual({
      activated: ['acme.workflow'],
      failed: [],
      modulePacksLoaded: [],
    })
    expect(pluginRuntime.getToolbarButtons()).toEqual([{
      id: 'workflow.approve',
      label: 'Approve',
      command: 'workflow.approve',
      pluginId: 'acme.workflow',
    }])
  })

  it('resets stale registrations and skips disabled plugins', async () => {
    pluginRuntime.registerToolbarButton('stale.plugin', {
      id: 'stale.action',
      label: 'Stale',
      command: 'stale.action',
    })

    const result = await activateInstalledEditorPlugins({
      fetchImpl: async () => Response.json({
        adminPages: [],
        plugins: [{
          id: workflowManifest.id,
          name: workflowManifest.name,
          version: workflowManifest.version,
          enabled: false,
          lifecycleStatus: 'disabled',
          lastError: null,
          grantedPermissions: ['editor.code', 'editor.commands', 'editor.toolbar'],
          manifest: workflowManifest,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      } satisfies CmsPluginsPayload),
      importEditorModule: async () => {
        throw new Error('Disabled plugins should not be imported')
      },
    })

    expect(result).toEqual({
      activated: [],
      failed: [],
      modulePacksLoaded: [],
    })
    expect(pluginRuntime.getToolbarButtons()).toEqual([])
  })

  it('skips enabled editor plugins with lifecycle errors', async () => {
    const imported: string[] = []

    const result = await activateInstalledEditorPlugins({
      fetchImpl: async () => Response.json({
        adminPages: [],
        plugins: [{
          id: workflowManifest.id,
          name: workflowManifest.name,
          version: workflowManifest.version,
          enabled: true,
          lifecycleStatus: 'error',
          lastError: 'activate exploded',
          grantedPermissions: ['editor.code', 'editor.commands', 'editor.toolbar'],
          manifest: workflowManifest,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      } satisfies CmsPluginsPayload),
      importEditorModule: async (url) => {
        imported.push(url)
        return {
          activate() {},
        }
      },
    })

    expect(imported).toEqual([])
    expect(result).toEqual({
      activated: [],
      failed: [],
      modulePacksLoaded: [],
    })
  })

  it('refuses to import an editor entrypoint without the editor.code grant and records a visible failure', async () => {
    const imported: string[] = []

    const result = await activateInstalledEditorPlugins({
      fetchImpl: async () => Response.json({
        adminPages: [],
        plugins: [{
          id: workflowManifest.id,
          name: workflowManifest.name,
          version: workflowManifest.version,
          enabled: true,
          lifecycleStatus: 'active',
          lastError: null,
          // Tampered / legacy row: entrypoint declared, grant absent.
          grantedPermissions: ['editor.commands', 'editor.toolbar'],
          manifest: workflowManifest,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      } satisfies CmsPluginsPayload),
      importEditorModule: async (url) => {
        imported.push(url)
        return { activate() {} }
      },
    })

    // The bundle must never be imported — the gate sits BEFORE the dynamic
    // import, not just before activate().
    expect(imported).toEqual([])
    expect(result.activated).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].pluginId).toBe('acme.workflow')
    expect(String((result.failed[0].error as Error).message)).toContain('editor.code')
  })

  it('records a visible failure for a modules entrypoint without the modules.register grant', async () => {
    const modulesManifest: PluginManifest = {
      id: 'acme.blocks',
      name: 'Blocks',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['modules.register'],
      grantedPermissions: [],
      entrypoints: { modules: 'modules/index.js' },
      assetBasePath: '/uploads/plugins/acme.blocks/1.0.0',
      resources: [],
      adminPages: [],
    }
    const imported: string[] = []

    const result = await activateInstalledEditorPlugins({
      fetchImpl: async () => Response.json({
        adminPages: [],
        plugins: [{
          id: modulesManifest.id,
          name: modulesManifest.name,
          version: modulesManifest.version,
          enabled: true,
          lifecycleStatus: 'active',
          lastError: null,
          grantedPermissions: [],
          manifest: modulesManifest,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      } satisfies CmsPluginsPayload),
      importModulePack: async (url) => {
        imported.push(url)
        return { modules: [] }
      },
    })

    expect(imported).toEqual([])
    expect(result.modulePacksLoaded).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].pluginId).toBe('acme.blocks')
    expect(String((result.failed[0].error as Error).message)).toContain('modules.register')
  })
})
