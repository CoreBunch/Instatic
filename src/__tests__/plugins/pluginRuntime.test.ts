import { beforeEach, describe, expect, it } from 'bun:test'
import {
  activateEditorPlugin,
  pluginRuntime,
} from '@core/plugins/runtime'
import type { PluginManifest } from '@core/plugin-sdk'

const workflowManifest: PluginManifest = {
  id: 'acme.workflow',
  name: 'Workflow Tools',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Adds editor workflow controls.',
  permissions: ['editor.toolbar', 'editor.commands', 'editor.store.write', 'cms.storage'],
  grantedPermissions: ['editor.toolbar', 'editor.commands', 'editor.store.write', 'cms.storage'],
  entrypoints: {
    editor: 'editor/index.js',
  },
  resources: [],
  adminPages: [],
}

beforeEach(() => {
  pluginRuntime.reset()
})

describe('editor plugin runtime SDK', () => {
  it('lets trusted plugin code register toolbar buttons and commands through the public SDK', async () => {
    let approved = false
    await activateEditorPlugin(workflowManifest, {
      activate(api) {
        api.editor.commands.register({
          id: 'workflow.approve',
          label: 'Approve Page',
          run: () => { approved = true },
        })
        api.editor.toolbar.addButton({
          id: 'workflow.approve',
          label: 'Approve',
          command: 'workflow.approve',
        })
      },
    })

    expect(pluginRuntime.getToolbarButtons()).toEqual([{
      id: 'workflow.approve',
      label: 'Approve',
      command: 'workflow.approve',
      pluginId: 'acme.workflow',
    }])

    await pluginRuntime.runCommand('workflow.approve')
    expect(approved).toBe(true)
  })

  it('blocks SDK calls when the matching permission was not granted', async () => {
    const manifest = {
      ...workflowManifest,
      grantedPermissions: ['editor.commands'],
    } satisfies PluginManifest

    await expect(activateEditorPlugin(manifest, {
      activate(api) {
        api.editor.toolbar.addButton({
          id: 'workflow.approve',
          label: 'Approve',
          command: 'workflow.approve',
        })
      },
    })).rejects.toThrow('requires permission "editor.toolbar"')

    expect(pluginRuntime.getToolbarButtons()).toEqual([])
  })

  it('exposes plugin-scoped CMS storage helpers that call the backend API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    await activateEditorPlugin(workflowManifest, {
      activate(api) {
        void api.cms.storage.collection('approvals').create({
          pageId: 'page_home',
          status: 'approved',
        })
      },
    }, async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        record: {
          id: 'record_1',
          pluginId: 'acme.workflow',
          resourceId: 'approvals',
          data: { pageId: 'page_home', status: 'approved' },
          uniqueKey: null,
          version: 0,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
        },
      }), { status: 201 })
    })

    await Promise.resolve()

    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/plugins/acme.workflow/resources/approvals/records',
      init: {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify({
      data: { pageId: 'page_home', status: 'approved' },
    }))
  })
})
