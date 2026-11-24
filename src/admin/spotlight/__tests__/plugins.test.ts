/**
 * Phase 4 unit tests — Plugin SDK ↔ Command Spotlight integration.
 *
 * Covers:
 *   - A basic PluginCommand auto-surfaces as a spotlight Command (plugins group)
 *   - A PluginPaletteCommand (extended PluginCommand) flows all fields through
 *   - A PluginPaletteProvider's results are wrapped as spotlight Commands
 *   - An error thrown by a provider's search is caught; group returns empty
 *   - editor.commands permission is required — missing it no-ops + warns
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { pluginRuntime, createEditorPluginApi } from '@core/plugins/runtime'
import { getPluginsCommands } from '../commands/plugins'
import { getPluginPaletteSpotlightProviders } from '../commandRegistry'
import type { PluginManifest } from '@core/plugin-sdk'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManifest(
  id: string,
  grantedPermissions: PluginManifest['grantedPermissions'] = [],
): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    permissions: [],
    grantedPermissions,
    resources: [],
    adminPages: [],
  }
}

const GRANTED = makeManifest('test.plugin', ['editor.commands'])
const DENIED  = makeManifest('test.plugin', [])

// A no-op fetch shim (palette.registerCommand / registerProvider don't use fetch)
const noopFetch = () => Promise.resolve(new Response('{}'))

// ─── Reset runtime between tests ──────────────────────────────────────────────

beforeEach(() => {
  pluginRuntime.reset()
})

// ─── Basic PluginCommand → spotlight Command ──────────────────────────────────

describe('Site dock commands', () => {
  it('exposes only opted-in direct Site actions and updates on deactivation', () => {
    const api = createEditorPluginApi(GRANTED, fetch)
    const direct = { id: 'test.plugin.open', label: 'Open library', run() {}, showInSiteDock: true }
    api.editor.palette.registerCommand(direct)
    api.editor.palette.registerCommand({ ...direct, id: 'test.plugin.delete', destructive: true })
    api.editor.palette.registerCommand({ ...direct, id: 'test.plugin.edit', args: [{ id: 'name', label: 'Name', type: 'text' }] })
    api.editor.palette.registerCommand({ ...direct, id: 'test.plugin.content', workspaces: ['content'] })
    api.editor.palette.registerCommand({ ...direct, id: 'test.plugin.hidden', showInSiteDock: false })
    const commands = pluginRuntime.getSiteDockCommands()
    expect(commands.map(command => command.id)).toEqual([direct.id])
    expect(pluginRuntime.getSiteDockCommands()).toBe(commands)
    pluginRuntime.deactivatePlugin(GRANTED.id)
    expect(pluginRuntime.getSiteDockCommands()).toEqual([])
  })
})

describe('basic PluginCommand auto-surfaces in the palette', () => {
  it('appears in getPluginsCommands() after registration', () => {
    pluginRuntime.registerCommand('test.plugin', {
      id: 'test.plugin.hello',
      label: 'Say Hello',
      run: () => {},
    })

    const cmds = getPluginsCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].id).toBe('plugin:test.plugin.test.plugin.hello')
    expect(cmds[0].title).toBe('Say Hello')
    expect(cmds[0].group).toBe('plugins')
    expect(cmds[0].iconName).toBe('plug') // default fallback
    expect(cmds[0].subtitle).toBe('test.plugin') // pluginId as default subtitle
  })

  it('returns empty when no commands are registered', () => {
    expect(getPluginsCommands()).toHaveLength(0)
  })

  it('getPluginsCommands() reflects the live runtime (called lazily on each open)', () => {
    expect(getPluginsCommands()).toHaveLength(0)

    pluginRuntime.registerCommand('test.plugin', {
      id: 'test.plugin.a',
      label: 'Command A',
      run: () => {},
    })

    expect(getPluginsCommands()).toHaveLength(1)
  })
})

// ─── PluginPaletteCommand (extended fields) ───────────────────────────────────

describe('PluginPaletteCommand extended fields flow through', () => {
  it('subtitle, iconName, keywords, destructive all map to spotlight Command', () => {
    pluginRuntime.registerCommand('test.plugin', {
      id: 'test.plugin.rich',
      label: 'Rich Command',
      subtitle: 'Does something dangerous',
      iconName: 'trash-solid',
      keywords: ['delete', 'remove'],
      destructive: true,
      run: () => {},
    })

    const [cmd] = getPluginsCommands()
    expect(cmd.subtitle).toBe('Does something dangerous')
    expect(cmd.iconName).toBe('trash-solid')
    expect(cmd.keywords).toEqual(['delete', 'remove'])
    expect(cmd.destructive).toBe(true)
  })

  it('workspaces map to spotlight Command workspaces', () => {
    pluginRuntime.registerCommand('test.plugin', {
      id: 'test.plugin.siteOnly',
      label: 'Site-only Command',
      workspaces: ['site', 'content'],
      run: () => {},
    })

    const [cmd] = getPluginsCommands()
    expect(cmd.workspaces).toEqual(['site', 'content'])
  })

  it('args map from PluginPaletteArg to CommandArg', () => {
    pluginRuntime.registerCommand('test.plugin', {
      id: 'test.plugin.withArgs',
      label: 'Command With Args',
      args: [
        { id: 'name', label: 'Name', type: 'text', placeholder: 'Enter a name' },
        {
          id: 'role',
          label: 'Role',
          type: 'select',
          options: [{ value: 'admin', label: 'Admin' }],
        },
      ],
      run: () => {},
    })

    const [cmd] = getPluginsCommands()
    expect(cmd.args).toHaveLength(2)
    expect(cmd.args![0]).toMatchObject({ id: 'name', type: 'text', placeholder: 'Enter a name' })
    expect(cmd.args![1]).toMatchObject({ id: 'role', type: 'select' })
    expect(cmd.args![1].options).toEqual([{ value: 'admin', label: 'Admin' }])
  })
})

// ─── PluginPaletteProvider ────────────────────────────────────────────────────

describe('PluginPaletteProvider wraps as SpotlightProvider', () => {
  it('wrapped provider id is prefixed with plugin namespace', () => {
    pluginRuntime.registerPaletteProvider('test.plugin', {
      id: 'test.plugin.search',
      label: 'Test Search',
      search: async () => [],
    })

    const providers = getPluginPaletteSpotlightProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('plugin:test.plugin:test.plugin.search')
    expect(providers[0].label).toBe('Test Search')
  })

  it('search results are mapped to spotlight Commands', async () => {
    pluginRuntime.registerPaletteProvider('test.plugin', {
      id: 'test.plugin.search',
      label: 'Test Results',
      search: async () => [
        {
          id: 'result-1',
          title: 'Result One',
          subtitle: 'A subtitle',
          iconName: 'star-solid',
          run: async () => {},
        },
      ],
    })

    const [provider] = getPluginPaletteSpotlightProviders()
    const signal = new AbortController().signal
    const results = await provider.search('test', {} as never, signal)

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('plugin:test.plugin:test.plugin.search:result-1')
    expect(results[0].title).toBe('Result One')
    expect(results[0].subtitle).toBe('A subtitle')
    expect(results[0].iconName).toBe('star-solid')
    expect(results[0].group).toBe('plugins')
  })

  it('results with no iconName fall back to "plug"', async () => {
    pluginRuntime.registerPaletteProvider('test.plugin', {
      id: 'test.plugin.bare',
      label: 'Bare',
      search: async () => [{ id: 'x', title: 'X', run: async () => {} }],
    })

    const [provider] = getPluginPaletteSpotlightProviders()
    const results = await provider.search('', {} as never, new AbortController().signal)
    expect(results[0].iconName).toBe('plug')
  })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('provider search error is caught — palette does not crash', () => {
  it('returns empty array when search throws', async () => {
    pluginRuntime.registerPaletteProvider('test.plugin', {
      id: 'test.plugin.broken',
      label: 'Broken Provider',
      search: async () => {
        throw new Error('network blew up')
      },
    })

    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})

    const [provider] = getPluginPaletteSpotlightProviders()
    const results = await provider.search('q', {} as never, new AbortController().signal)

    expect(results).toHaveLength(0)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[spotlight:plugin:test.plugin]'),
      expect.any(Error),
    )

    consoleErrorSpy.mockRestore()
  })

  it('returns empty array when signal is already aborted', async () => {
    pluginRuntime.registerPaletteProvider('test.plugin', {
      id: 'test.plugin.slow',
      label: 'Slow Provider',
      search: async () => [{ id: 'r', title: 'R', run: async () => {} }],
    })

    const ctrl = new AbortController()
    ctrl.abort()

    const [provider] = getPluginPaletteSpotlightProviders()
    const results = await provider.search('q', {} as never, ctrl.signal)

    expect(results).toHaveLength(0)
  })
})

// ─── Permission gating ────────────────────────────────────────────────────────

describe('editor.commands permission is required', () => {
  it('palette.registerCommand is a no-op without the permission + warns', () => {
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    const api = createEditorPluginApi(DENIED, noopFetch as never)
    api.editor.palette.registerCommand({
      id: 'test.plugin.noPermission',
      label: 'No Permission',
      run: () => {},
    })

    expect(getPluginsCommands()).toHaveLength(0)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('editor.commands'),
      // message should mention the permission
    )

    consoleWarnSpy.mockRestore()
  })

  it('palette.registerProvider is a no-op without the permission + warns', () => {
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    const api = createEditorPluginApi(DENIED, noopFetch as never)
    api.editor.palette.registerProvider({
      id: 'test.plugin.noPermProvider',
      label: 'No Perm Provider',
      search: async () => [],
    })

    expect(getPluginPaletteSpotlightProviders()).toHaveLength(0)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('editor.commands'),
    )

    consoleWarnSpy.mockRestore()
  })

  it('palette.registerCommand works when permission is granted', () => {
    const api = createEditorPluginApi(GRANTED, noopFetch as never)
    api.editor.palette.registerCommand({
      id: 'test.plugin.permitted',
      label: 'Permitted Command',
      run: () => {},
    })

    const cmds = getPluginsCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].title).toBe('Permitted Command')
  })

  it('palette.registerProvider works when permission is granted', () => {
    const api = createEditorPluginApi(GRANTED, noopFetch as never)
    api.editor.palette.registerProvider({
      id: 'test.plugin.permittedProvider',
      label: 'Permitted Provider',
      search: async () => [],
    })

    expect(getPluginPaletteSpotlightProviders()).toHaveLength(1)
  })
})

// ─── Provider id namespace validation ─────────────────────────────────────────

describe('palette provider id must be namespaced under plugin id', () => {
  it('logs an error and skips registration for unnamespaced id', () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})

    pluginRuntime.registerPaletteProvider('test.plugin', {
      id: 'wrong-namespace.search', // does not start with "test.plugin."
      label: 'Bad Provider',
      search: async () => [],
    })

    expect(getPluginPaletteSpotlightProviders()).toHaveLength(0)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[plugin:test.plugin]'),
      // contains the id that was rejected
    )

    consoleErrorSpy.mockRestore()
  })
})
