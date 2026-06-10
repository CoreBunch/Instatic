/**
 * Typed permission constants — gives plugin authors autocomplete instead of
 * having to remember the exact string literal.
 *
 *   import { permissions } from '@instatic/plugin-sdk'
 *   permissions: [permissions.modulesRegister, permissions.cmsHooks]
 *
 * Keys are camelCased; values are the canonical permission identifiers used
 * throughout the host runtime. Adding a new permission here means it's
 * autocomplete-discoverable in IDEs.
 */
import type { PluginPermission } from '../types'

export const permissions = {
  adminNavigation: 'admin.navigation',
  cmsStorage: 'cms.storage',
  cmsRoutes: 'cms.routes',
  // Anonymous-callable routes (webhooks, public read APIs, frontend
  // tracker ingest). Required ON TOP of `cmsRoutes` to register a route
  // via `api.cms.routes.public.*`. Surfaced separately so the install
  // dialog can flag the plugin as exposing public endpoints.
  cmsRoutesPublic: 'cms.routes.public',
  cmsHooks: 'cms.hooks',
  // Unsandboxed admin-window code — required for `entrypoints.editor` and
  // app-kind admin pages. See `capabilities.ts` for the trust implications.
  editorCode: 'editor.code',
  editorToolbar: 'editor.toolbar',
  editorCommands: 'editor.commands',
  editorStoreRead: 'editor.store.read',
  editorStoreWrite: 'editor.store.write',
  editorCanvas: 'editor.canvas',
  editorPanels: 'editor.panels',
  dashboardWidgetsRegister: 'dashboard.widgets.register',
  modulesRegister: 'modules.register',
  loopsRegister: 'loops.register',
  visualComponentsRegister: 'visualComponents.register',
  frontendAssets: 'frontend.assets',
  networkOutbound: 'network.outbound',
  cmsSchedule: 'cms.schedule',
  cmsContentRead: 'cms.content.read',
  cmsContentWrite: 'cms.content.write',
  cmsContentPublish: 'cms.content.publish',
  cmsContentDelete: 'cms.content.delete',
  cmsContentTablesManage: 'cms.content.tables.manage',
  mediaStorageAdapter: 'media.storage.adapter',
  mediaUrlTransform: 'media.url.transform',
  mediaVariantDelegate: 'media.variant.delegate',
  unstableInternals: 'unstable.internals',
} as const satisfies Record<string, PluginPermission>

export type PermissionAlias = keyof typeof permissions
