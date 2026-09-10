import type { ReactNode } from 'react'
import type { PluginPermission } from '@core/plugin-sdk'
import { buildPluginRoutesHelper } from '@core/plugins/adminRuntime'
import { pluginRuntime } from '@core/plugins/runtime'
import { PluginContext, type PluginContextValue } from './pluginContext'

interface PluginContextProviderProps {
  pluginId: string
  pluginVersion: string
  surfaceId: string
  surfaceLabel: string
  grantedPermissions: readonly PluginPermission[]
  settings: Record<string, string | number | boolean>
  children: ReactNode
}

/**
 * Host-owned mount boundary shared by every plugin React surface.
 * Centralizing the value construction keeps identity, permission, settings,
 * route, and command behavior consistent wherever plugin code renders.
 */
export function PluginContextProvider({
  pluginId,
  pluginVersion,
  surfaceId,
  surfaceLabel,
  grantedPermissions,
  settings,
  children,
}: PluginContextProviderProps) {
  const contextValue: PluginContextValue = {
    pluginId,
    pluginVersion,
    surfaceId,
    surfaceLabel,
    grantedPermissions,
    settings,
    routes: buildPluginRoutesHelper(pluginId),
    runCommand: (commandId) => pluginRuntime.runCommand(commandId),
  }

  return (
    <PluginContext.Provider value={contextValue}>
      {children}
    </PluginContext.Provider>
  )
}
