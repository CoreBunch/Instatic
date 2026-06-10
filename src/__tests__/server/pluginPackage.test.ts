import { describe, expect, it } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { readPluginPackage } from '../../../server/plugins/package'

function pluginZip(files: Record<string, string>): File {
  const zipped = zipSync(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
  ))
  return new File([zipped], 'workflow-tools.zip', { type: 'application/zip' })
}

describe('plugin package reader', () => {
  it('extracts manifest and declared JavaScript entrypoints from a zip package', async () => {
    const manifest = {
      id: 'acme.workflow',
      name: 'Workflow Tools',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['editor.code', 'editor.toolbar', 'editor.commands'],
      entrypoints: {
        editor: 'editor/index.js',
      },
      adminPages: [],
    }

    const pkg = await readPluginPackage(pluginZip({
      'plugin.json': JSON.stringify(manifest),
      'editor/index.js': 'export function activate(api) { api.editor.toolbar.addButton({ id: "x", label: "X", command: "x" }) }',
    }))

    expect(pkg.manifest).toMatchObject({
      id: 'acme.workflow',
      permissions: ['editor.code', 'editor.toolbar', 'editor.commands'],
      entrypoints: { editor: 'editor/index.js' },
    })
    expect(pkg.files['editor/index.js']).toContain('activate')
  })

  it('rejects packages with missing declared entrypoint files', async () => {
    const manifest = {
      id: 'acme.workflow',
      name: 'Workflow Tools',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['editor.code', 'editor.toolbar'],
      entrypoints: {
        editor: 'editor/index.js',
      },
      adminPages: [],
    }

    await expect(readPluginPackage(pluginZip({
      'plugin.json': JSON.stringify(manifest),
    }))).rejects.toThrow('Missing plugin entrypoint "editor/index.js"')
  })

  it('rejects packages with missing JavaScript admin app files', async () => {
    const manifest = {
      id: 'acme.workflow',
      name: 'Workflow Tools',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['admin.navigation', 'editor.code'],
      adminPages: [{
        id: 'dashboard',
        title: 'Dashboard',
        content: {
          kind: 'app',
          heading: 'Workflow Dashboard',
          entry: 'admin/dashboard.js',
        },
      }],
    }

    await expect(readPluginPackage(pluginZip({
      'plugin.json': JSON.stringify(manifest),
    }))).rejects.toThrow('Missing plugin entrypoint "admin/dashboard.js"')
  })
})
