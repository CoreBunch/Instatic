import type { PluginPermission } from './types'

export type PluginCapabilitySurface = 'manifest' | 'admin' | 'editor' | 'server' | 'cms' | 'frontend'
export type PluginCapabilityRisk = 'low' | 'medium' | 'high' | 'dangerous'

export interface PluginCapability {
  permission: PluginPermission
  label: string
  description: string
  risk: PluginCapabilityRisk
  surfaces: PluginCapabilitySurface[]
}

export const PLUGIN_CAPABILITIES: PluginCapability[] = [
  {
    permission: 'admin.navigation',
    label: 'Add pages to the admin navigation',
    description: 'Allows the plugin to add pages to the CMS admin sidebar and plugin page router. Declarative page kinds (markdown, map, resource) render host-owned UI; app-kind pages additionally require `editor.code` because they run plugin JavaScript in the admin window.',
    risk: 'medium',
    surfaces: ['manifest', 'admin'],
  },
  {
    permission: 'editor.code',
    label: 'Run plugin JavaScript in the admin window (unsandboxed)',
    description: 'Allows the host to load the plugin\'s editor entrypoint and app-kind admin pages directly into the admin window. This code is NOT sandboxed — it runs with the same privileges as the CMS admin UI itself (admin API calls with your session, browser storage, the full page). Only grant this to plugins whose code you trust.',
    risk: 'dangerous',
    surfaces: ['manifest', 'admin', 'editor'],
  },
  {
    permission: 'cms.storage',
    label: 'Read and write plugin backend storage',
    description: 'Allows the plugin to read and write records in resources declared by its manifest.',
    risk: 'medium',
    surfaces: ['admin', 'editor', 'server', 'cms'],
  },
  {
    permission: 'cms.routes',
    label: 'Register backend CMS routes',
    description: 'Allows the plugin server entrypoint to register authenticated backend routes. Routes are gated by either a core capability or a "any authenticated user" check; in both cases the host enforces the session cookie. For anonymous-callable endpoints (webhooks), the plugin must ALSO request `cms.routes.public`.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.routes.public',
    label: 'Register anonymously-callable routes',
    description: 'Allows the plugin to register backend routes that bypass authentication entirely (webhook receivers, public read endpoints). Required on TOP of `cms.routes`. Split out as its own permission so the install dialog surfaces "this plugin will expose public endpoints" before the operator approves the install.',
    risk: 'dangerous',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.hooks',
    label: 'Subscribe to CMS lifecycle events and filters',
    description: 'Allows the plugin server entrypoint to listen to CMS events (publish, content changes, page updates) and to register filters that transform values before they leave the CMS.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'editor.toolbar',
    label: 'Add controls to the editor toolbar',
    description: 'Allows the plugin editor entrypoint to add toolbar buttons.',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.commands',
    label: 'Register editor commands',
    description: 'Allows the plugin editor entrypoint to register commands that can be invoked by editor UI. Also grants registration of Command Spotlight palette commands (api.editor.palette.registerCommand) and live-search providers (api.editor.palette.registerProvider).',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.store.read',
    label: 'Read editor state',
    description: 'Allows the plugin to inspect the current editor store state.',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.store.write',
    label: 'Modify editor state',
    description: 'Allows the plugin to mutate editor store state through a host transaction.',
    risk: 'high',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.canvas',
    label: 'Add canvas overlays',
    description: 'Allows the plugin to register canvas overlay React components — annotation pins, custom selection adornments, measurement tools — that mount on top of the rendered canvas via `editor.canvas.registerOverlay`.',
    risk: 'high',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.panels',
    label: 'Add editor panels',
    description: 'Allows the plugin to register panels that mount in the editor\'s left sidebar (custom inspectors, plugin dashboards, review queues).',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'modules.register',
    label: 'Register visual editor modules',
    description: 'Allows the plugin to ship new modules that show up in the canvas module library.',
    risk: 'high',
    surfaces: ['editor', 'manifest'],
  },
  {
    permission: 'loops.register',
    label: 'Register loop entity sources',
    description: 'Allows the plugin to register data sources for the base.loop module (e.g. external collections, custom queries).',
    risk: 'medium',
    surfaces: ['editor', 'server', 'manifest'],
  },
  {
    permission: 'visualComponents.register',
    label: 'Install Visual Components / templates into the site',
    description: 'Allows the plugin to ship Visual Components, page templates, and class packs that are imported into the user\'s site on activation.',
    risk: 'medium',
    surfaces: ['admin', 'manifest'],
  },
  {
    permission: 'dashboard.widgets.register',
    label: 'Register dashboard widgets',
    description: 'Allows the plugin to add cards to the admin dashboard grid (e.g. analytics charts, queue counters, plugin-specific stats). Each widget runs as a regular React component inside the host\'s admin shell.',
    risk: 'medium',
    surfaces: ['admin'],
  },
  {
    permission: 'frontend.assets',
    label: 'Inject tags into published pages',
    description:
      'Allows the plugin to declare scripts, styles, meta/link tags, and shared host-runtime references in its manifest. The host injects them into every published page at well-defined placements (head / head-end / body-start / body-end). One permission covers external bundles, inline content, and built-in runtimes like the page tracker.',
    risk: 'high',
    surfaces: ['frontend', 'manifest'],
  },
  {
    permission: 'cms.schedule',
    label: 'Register scheduled jobs',
    description: 'Allows the plugin to register handlers that fire on a cadence (hourly / daily / weekly / monthly / every-N-minutes). Each handler runs inside the QuickJS sandbox with a per-fire wall-clock budget; the host scheduler tick drives dispatch and records run history.',
    risk: 'high',
    surfaces: ['server'],
  },
  {
    permission: 'cms.content.read',
    label: 'Read CMS content',
    description: 'Allows the plugin to list / read entries (pages, posts, custom tables) in the tables declared in its manifest\'s `contentAccess[]`. Includes reading tree-shaped fields and published snapshots.',
    risk: 'low',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.content.write',
    label: 'Write CMS content',
    description: 'Allows the plugin to create entries, update entry cells, mutate tree-shaped fields via the canonical mutation engine, and move entries between tables — for the tables declared in its manifest\'s `contentAccess[]`.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.content.publish',
    label: 'Publish CMS content',
    description: 'Allows the plugin to publish or schedule-publish individual entries and to republish every published page. The full publish pipeline runs (publish.before → publish.html → publish.after), so hook listeners from other plugins fire as part of the chain.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.content.delete',
    label: 'Delete CMS content',
    description: 'Allows the plugin to soft-delete entries in the tables declared in its manifest\'s `contentAccess[]`. Split out as its own permission so the common SEO / translator / AI cases don\'t carry delete capability.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.content.tables.manage',
    label: 'Create CMS tables',
    description: 'Allows the plugin to create user-managed content tables (never system tables — `pages`, `posts`, `components` are protected at the repository layer). Tables created by a plugin survive uninstall — listed as `dangerous` so the operator sees the warning.',
    risk: 'dangerous',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'network.outbound',
    label: 'Outbound network access',
    description: 'Allows the plugin to make outbound HTTP requests from the QuickJS sandbox via the gated fetch() polyfill. Requires a networkAllowedHosts allowlist in the manifest; calls to hosts outside the list are rejected at the host bridge even when the permission is granted. See sandbox.md#network-access.',
    risk: 'high',
    surfaces: ['server'],
  },
  {
    permission: 'media.storage.adapter',
    label: 'Provide a media storage backend',
    description: 'Allows the plugin to register an exclusive storage adapter that the host elects per asset role (original / variant / avatar / font). The adapter issues signed upload targets; the host streams bytes directly. Required for S3, R2, GCS, Azure, and similar backends.',
    risk: 'dangerous',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'media.url.transform',
    label: 'Rewrite media URLs at render time',
    description: 'Allows the plugin to register a pure URL transformer applied to every media path (originals + responsive variants) in the publisher, editor preview, and admin media library. Typical use: passive CDN URL prefixing.',
    risk: 'medium',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'media.variant.delegate',
    label: 'Delegate responsive variant generation to an external service',
    description: "Allows the plugin to replace the host's local image-variant ladder with a URL template (image-transform CDNs — Cloudflare Images, Imgix, Bunny Optimizer). Only one such plugin can win per host.",
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'unstable.internals',
    label: 'Use unstable internal APIs',
    description: 'Reserved for trusted first-party plugins that need unstable host internals.',
    risk: 'dangerous',
    surfaces: ['admin', 'editor', 'server', 'cms'],
  },
]

const capabilityByPermission = new Map(
  PLUGIN_CAPABILITIES.map((capability) => [capability.permission, capability]),
)

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && capabilityByPermission.has(value as PluginPermission)
}

export function permissionLabel(permission: PluginPermission): string {
  return capabilityByPermission.get(permission)?.label ?? permission
}

export function permissionDescription(permission: PluginPermission): string {
  return capabilityByPermission.get(permission)?.description ?? ''
}

export function permissionsForSurface(surface: PluginCapabilitySurface): PluginPermission[] {
  return PLUGIN_CAPABILITIES
    .filter((capability) => capability.surfaces.includes(surface))
    .map((capability) => capability.permission)
}
