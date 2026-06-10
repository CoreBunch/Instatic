/**
 * `PluginContext` — shared React context populated by the host's mount
 * components (`PluginEditorPanel`, `PluginPageRenderer`,
 * `PluginCanvasOverlayLayer`) so plugin code can resolve plugin-scoped
 * APIs through hooks.
 *
 * The context value is built per-mount and includes:
 *   • Plugin identity (id, version, surface name)
 *   • The operator-granted permission set — permission-gated hooks
 *     (`useEditorStore` requires `editor.store.read`) check against it
 *   • A live settings snapshot
 *   • A scoped HTTP routes helper (already namespaced to the plugin's URL)
 *   • A command-runner that delegates to the shared editor command bus
 *
 * This file is intentionally tiny so the runtime shim that re-exports it
 * (`public/runtime/host-hooks.js`) doesn't need to track host internals.
 */
import { createContext } from 'react'
import type { TSchema, Static } from '@sinclair/typebox'
import type { PluginPermission } from '@core/plugin-sdk'

export interface PluginContextValue {
  pluginId: string
  pluginVersion: string
  surfaceId: string
  surfaceLabel: string
  /** Permissions the operator granted at install time. */
  grantedPermissions: readonly PluginPermission[]
  settings: Record<string, string | number | boolean>
  routes: {
    fetch: (path: string, init?: RequestInit) => Promise<Response>
    json: <T extends TSchema>(path: string, schema: T, init?: RequestInit) => Promise<Static<T>>
  }
  runCommand: (commandId: string) => Promise<{ message?: string } | void>
}

const defaultRoutes: PluginContextValue['routes'] = {
  fetch: async () => {
    throw new Error('usePluginRoutes called outside a plugin surface')
  },
  json: async () => {
    throw new Error('usePluginRoutes called outside a plugin surface')
  },
}

const defaultRunCommand: PluginContextValue['runCommand'] = async () => {
  throw new Error('useEditorCommand called outside a plugin surface')
}

export const PluginContext = createContext<PluginContextValue>({
  pluginId: '',
  pluginVersion: '',
  surfaceId: '',
  surfaceLabel: '',
  grantedPermissions: [],
  settings: {},
  routes: defaultRoutes,
  runCommand: defaultRunCommand,
})
