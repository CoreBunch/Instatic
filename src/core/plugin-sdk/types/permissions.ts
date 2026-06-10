// ---------------------------------------------------------------------------
// Permission constants
// ---------------------------------------------------------------------------

export const PLUGIN_PERMISSION_VALUES = [
  // Admin / nav
  'admin.navigation',
  // Storage
  'cms.storage',
  // Server runtime
  'cms.routes',
  // Anonymous-callable plugin routes (webhooks, public read endpoints).
  // Required on top of `cms.routes` to register a route via
  // `api.cms.routes.public.*`. Split out so the install consent dialog
  // can flag the plugin as exposing public endpoints to the operator
  // before they approve installation.
  'cms.routes.public',
  'cms.hooks',
  // CMS content — read/write/publish/delete the host's content tables
  // (`data_tables` + `data_rows`) through the `api.cms.content.*` surface.
  // Each mode is split so a typical plugin (SEO assistant, translator)
  // doesn't carry the dangerous bits. The manifest must additionally list
  // the targeted tables in `contentAccess[]`; the host fails closed without
  // both the permission and the allowlist entry. See
  // docs/features/plugin-system.md → "Content access".
  'cms.content.read',
  'cms.content.write',
  'cms.content.publish',
  'cms.content.delete',
  // Reserved for plugins that need to add user-managed tables (never
  // system tables). Listed separately as `dangerous` because adding a
  // table is a change a future plugin upgrade then has to clean up.
  'cms.content.tables.manage',
  // Unsandboxed admin-window code. REQUIRED for `entrypoints.editor` and for
  // `adminPages[].content` of kind `app` — both are plugin JavaScript that
  // the host dynamically imports into the main admin window, where it runs
  // with full admin-origin privileges (admin API with credentials,
  // localStorage, DOM). Everything below in the `editor.*` family gates a
  // specific host API surface; this one gates whether the plugin's own code
  // is loaded into the admin window at all.
  'editor.code',
  // Editor surfaces
  'editor.toolbar',
  'editor.commands',
  'editor.canvas',
  'editor.panels',
  'editor.store.read',
  'editor.store.write',
  // Builder extensions
  'modules.register',
  'loops.register',
  'visualComponents.register',
  'dashboard.widgets.register',
  // Media subsystem — three independent tiers; a plugin can hold any subset.
  //
  //   • 'media.storage.adapter' — register an exclusive backend that intercepts
  //     every media WRITE / DELETE for one or more roles ('original',
  //     'variant', 'avatar', 'font'). The adapter signs upload targets;
  //     the HOST streams bytes directly to them — bytes NEVER cross the
  //     QuickJS boundary (defense against the 64 MB heap ceiling).
  //
  //   • 'media.url.transform' — register a pure URL rewriter. Applied to every
  //     media path the renderer materializes (originals + variants) in the
  //     publisher AND the editor preview iframe AND the admin media library.
  //     Multiple plugins can register; handlers chain.
  //
  //   • 'media.variant.delegate' — replace the host's local variant ladder
  //     with a URL template. For image-transform CDNs (Cloudflare Images,
  //     Imgix, Bunny Optimizer). One winning plugin per host.
  'media.storage.adapter',
  'media.url.transform',
  'media.variant.delegate',
  // Frontend / published pages
  //
  // Single permission gating EVERY declarative frontend tag a plugin can inject
  // into a published page: scripts (external or inline), styles (external or
  // inline), <link>, and <meta>. The actual tags are declared in the manifest's
  // top-level `frontend.assets[]` array — see `FrontendAsset` below. The host
  // is purely the substrate: it splices tags at four placement anchors
  // (head / head-end / body-start / body-end), rewrites the CSP based on
  // what's actually in the plan, and runs the `publish.html` filter once at
  // the dispatcher. No host-shipped scripts, no built-in trackers, no
  // implicit `window.__instatic.*` — a plugin that wants `window.__instatic_analytics`
  // ships the IIFE that installs it as one of its own assets.
  'frontend.assets',
  // Network — outbound HTTP from the sandbox.
  // Requires the plugin manifest to also declare `networkAllowedHosts`;
  // calls to hosts outside the allowlist are rejected at the host bridge
  // even when the permission is granted.
  'network.outbound',
  // Scheduled jobs — register handlers fired on a cadence (`daily`,
  // `hourly`, `every: { minutes }`, …) by the host's scheduler tick.
  // The handler runs inside the same QuickJS sandbox as everything else.
  'cms.schedule',
  // Reserved
  'unstable.internals',
] as const

export type PluginPermission = typeof PLUGIN_PERMISSION_VALUES[number]
