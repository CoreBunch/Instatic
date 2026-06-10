/**
 * Admin-page route construction for installed plugins.
 *
 * Split out of `manifest.ts` (which owns manifest parsing + validation) because
 * resolving which enabled plugins contribute CMS sidebar pages — and the route
 * each page mounts at — is a distinct responsibility consumed by the admin
 * shell and the plugins handler.
 */

import type {
  InstalledPlugin,
  PluginAdminPageRoute,
  PluginPageContent,
} from '@core/plugin-sdk'

export function pluginAdminPageRoute(pluginId: string, pageId: string): string {
  return `/admin/plugins/${pluginId}/${pageId}`
}

export function collectEnabledAdminPages(
  plugins: Array<
    Pick<InstalledPlugin, 'enabled' | 'manifest' | 'grantedPermissions'>
    & Partial<Pick<InstalledPlugin, 'lifecycleStatus' | 'settings' | 'updatedAt'>>
  >,
): PluginAdminPageRoute[] {
  return plugins
    .filter((plugin) => plugin.enabled && plugin.lifecycleStatus !== 'error')
    // `admin.navigation` is the gate for adding pages to the CMS sidebar — a
    // plugin that didn't request the grant has no business mounting nav
    // entries even if its manifest declared `adminPages` items.
    .filter((plugin) => plugin.grantedPermissions?.includes('admin.navigation'))
    .flatMap((plugin) =>
      plugin.manifest.adminPages.map((page) => {
        const content: PluginPageContent = page.content.kind === 'app'
          ? {
              ...page.content,
              assetPath: page.content.assetPath ?? plugin.manifest.assetBasePath,
            }
          : page.content

        return {
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          pluginVersion: plugin.manifest.version,
          pluginUpdatedAt: plugin.updatedAt ?? '',
          ...page,
          content,
          // The host parser always populates `route` via `pluginAdminPageRoute`;
          // we re-narrow to a guaranteed string here for the runtime route type.
          route: page.route ?? pluginAdminPageRoute(plugin.manifest.id, page.id),
          pluginSettings: plugin.settings ?? {},
          pluginSettingsSchema: plugin.manifest.settings,
          pluginGrantedPermissions: plugin.grantedPermissions ?? [],
        }
      }),
    )
}
