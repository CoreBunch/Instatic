import type { DashboardWidgetDefinition } from '@core/dashboard'
import { pluginRuntime } from '@core/plugins/runtime'
import { PluginContextProvider } from '@admin/plugin-host-hooks'

interface DashboardWidgetMountProps {
  definition: DashboardWidgetDefinition
  span: number
  editing: boolean
}

/** Mount a dashboard renderer with plugin context when its owner is a plugin. */
export function DashboardWidgetMount({
  definition,
  span,
  editing,
}: DashboardWidgetMountProps) {
  const Render = definition.render

  if (definition.ownerId === 'core') {
    return <Render span={span} editing={editing} />
  }

  const context = definition.pluginContext
  if (!context) {
    throw new Error(
      `[dashboard] plugin widget "${definition.id}" is missing its host context metadata.`,
    )
  }

  return (
    <PluginContextProvider
      pluginId={definition.ownerId}
      pluginVersion={context.version}
      surfaceId={definition.id}
      surfaceLabel={definition.name}
      grantedPermissions={context.grantedPermissions}
      settings={pluginRuntime.getPluginSettings(definition.ownerId)}
    >
      <Render span={span} editing={editing} />
    </PluginContextProvider>
  )
}
