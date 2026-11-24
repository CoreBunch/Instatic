import { Type } from '@core/utils/typeboxHelpers'
import { StorageListOptionsSchema } from '@core/plugin-sdk/storageSchemas'
import { PluginRecordBodySchema } from '../../handlers/cms/plugins/records'
import { PluginSettingsBodySchema } from '../../handlers/cms/plugins/settings'
import { PluginManifestSchema } from '@core/plugins/manifest'
import { hostPlugins } from '../../plugins/host/registry'
import { resolvePluginRoutePolicy } from '../../handlers/cms/plugins'
import { PluginEnabledBodySchema } from '../../handlers/cms/plugins/state'
import { operation as op, type Operation, type OperationInputs } from './operation'

function pluginOperation(method: string, path: string, summary: string, inputs?: OperationInputs) {
  const policy = resolvePluginRoutePolicy(method, '/admin/api/cms/' + path)
  return op(method, path, policy.capability, summary, inputs)
}

const records = 'plugins/:id/resources/:resourceId/records'
const item = 'plugins/:id'
const schedule = item + '/schedules/:scheduleId'
const recordBody = Type.Object({ ...PluginRecordBodySchema.properties, data: Type.Record(Type.String(), Type.Unknown()) })
export const pluginOperations = [
  pluginOperation('GET', 'plugins', 'List installed plugins'),
  pluginOperation('POST', 'plugins', 'Install a JSON manifest. Include all approved permission names; manifest fields with defaults can be omitted.', {
    bodySchema: Type.Object({ manifest: Type.Object({ ...PluginManifestSchema.properties,
      permissions: Type.Optional(PluginManifestSchema.properties.permissions), resources: Type.Optional(PluginManifestSchema.properties.resources),
      adminPages: Type.Optional(PluginManifestSchema.properties.adminPages),
    }), grantedPermissions: Type.Array(Type.String()) }),
    example: { manifest: { id: 'example.demo', name: 'Demo', apiVersion: 1, version: '1.0.0', permissions: [] }, grantedPermissions: [] },
  }),
  pluginOperation('POST', 'plugins/inspect-package', 'Inspect a plugin ZIP and review its manifest', { multipart: { file: 'Required plugin ZIP' } }),
  pluginOperation('POST', 'plugins/package', 'Install or upgrade a reviewed ZIP with explicit grantedPermissions', { multipart: { file: 'Required plugin ZIP', grantedPermissions: 'JSON array of approved permission names matching the manifest' } }),
  pluginOperation('DELETE', item, 'Uninstall a plugin. force skips lifecycle hooks.', { querySchema: Type.Object({ force: Type.Optional(Type.Literal('true')) }) }),
  pluginOperation('PATCH', item, 'Enable or disable the plugin', { bodySchema: PluginEnabledBodySchema }),
  pluginOperation('POST', item + '/restart', 'Restart a plugin'),
  pluginOperation('POST', item + '/pack/install', 'Install the plugin’s bundled pack in the draft'),
  pluginOperation('GET', item + '/settings', 'Read masked settings and the plugin’s setting definitions'),
  pluginOperation('PUT', item + '/settings', 'Use the field names and types from GET plugins/:id/settings', { bodySchema: Type.Object({ ...PluginSettingsBodySchema.properties, settings: Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.Number(), Type.String()])) }) }),
  pluginOperation('GET', 'plugins/events', 'Subscribe to plugin lifecycle events'),
  pluginOperation('GET', item + '/schedules', 'List the plugin’s schedules'),
  ...['pause', 'resume', 'run-now'].map(action => pluginOperation('POST', schedule + '/' + action, 'Apply ' + action + ' to the schedule')),
  pluginOperation('GET', records, 'Read the resource definition and records. URL-encode filter and orderBy as JSON.', { querySchema: StorageListOptionsSchema }),
  pluginOperation('POST', records, 'Create a record. Use field definitions returned by GET on the same collection.', { bodySchema: recordBody }),
  pluginOperation('PATCH', records + '/:recordId', 'Update a record using fields from its resource definition', { bodySchema: recordBody }),
  pluginOperation('DELETE', records + '/:recordId', 'Delete a plugin record'),
]

export function registeredPluginOperations(): Operation[] {
  const operations: Operation[] = []
  for (const plugin of hostPlugins.values()) {
    for (const route of plugin.routes.values()) {
      if (route.access.kind === 'member') continue
      const path = 'plugins/' + encodeURIComponent(route.pluginId) + '/runtime' + route.path.split('/').map(encodeURIComponent).join('/')
      operations.push(op(route.method, path, route.access.kind === 'capability' ? route.access.capability : [],
        route.documentation?.summary ?? 'Registered route from ' + route.pluginId, {
          pluginInput: route.documentation?.input ?? 'This plugin did not declare its request format.',
        }))
    }
  }
  return operations
}
