/**
 * Capability metadata + groupings shown in the role-edit dialog.
 *
 * Every entry in `CAPABILITY_GROUPS` maps to a `<section>` with its own
 * "Select all / Clear" header. `CAPABILITY_META` carries the human-readable
 * label + description rendered next to each checkbox so admins don't have to
 * decode raw permission strings like `site.structure.edit`.
 *
 * Adding a new capability: append it to `CORE_CAPABILITIES` (server +
 * `src/core/capabilities.ts`), then add it to one of the groups here and add
 * its meta entry. The dialog only renders capabilities listed here — the
 * `capability-picker-coverage.test.ts` gate enforces full coverage so a new
 * capability can't quietly disappear from the role-edit UI.
 */
import type { CoreCapability } from '@core/capabilities'
import type { CapabilityGroup } from '../types'

interface CapabilityMeta {
  /** Human-readable label rendered next to the checkbox. */
  label: string
  /** Short, plain-language description of what this capability grants. */
  description: string
}

export const CAPABILITY_META: Record<CoreCapability, CapabilityMeta> = {
  'dashboard.read': {
    label: 'View dashboard',
    description: 'Open the Dashboard workspace and see activity widgets.',
  },
  'site.read': {
    label: 'View site',
    description: 'Open the Site workspace; view pages, components, and classes.',
  },
  'site.structure.edit': {
    label: 'Edit site structure',
    description: 'Add, remove, move, and rename nodes; manage pages, components, and classes.',
  },
  'site.content.edit': {
    label: 'Edit site content',
    description: 'Change text, images, and links on existing nodes — no structure or style changes.',
  },
  'site.style.edit': {
    label: 'Edit site styles',
    description: 'Modify CSS classes, style overrides, breakpoints, and framework tokens.',
  },
  'pages.edit': {
    label: 'Edit pages',
    description: 'Edit page metadata such as title, slug, and SEO fields.',
  },
  'pages.publish': {
    label: 'Publish pages',
    description: 'Publish or unpublish pages to the live site.',
  },
  'content.create': {
    label: 'Create content',
    description: 'Create new draft posts and content rows.',
  },
  'content.edit.own': {
    label: 'Edit own content',
    description: 'Edit posts and rows that you authored.',
  },
  'content.edit.any': {
    label: 'Edit any content',
    description: 'Edit posts and rows authored by anyone.',
  },
  'content.publish.own': {
    label: 'Publish own content',
    description: 'Publish posts and rows that you authored.',
  },
  'content.publish.any': {
    label: 'Publish any content',
    description: 'Publish posts and rows authored by anyone.',
  },
  'content.manage': {
    label: 'Manage content',
    description: 'Full admin: manage every content row regardless of author.',
  },
  // ---------------------------------------------------------------------
  // Media — granular split (read/write/replace/delete)
  // ---------------------------------------------------------------------
  'media.read': {
    label: 'Browse media library',
    description: 'Open the Media workspace, browse assets and folders, see thumbnails in pickers.',
  },
  'media.write': {
    label: 'Upload and edit media',
    description: 'Upload assets, edit metadata (alt text, caption, tags), manage folders, restore from trash.',
  },
  'media.replace': {
    label: 'Replace media bytes',
    description: 'Overwrite the bytes of an existing asset (variants regenerate). Uniquely powerful — silently swaps the file every reference points at.',
  },
  'media.delete': {
    label: 'Delete media',
    description: 'Soft-delete assets to trash; hard-purge (also requires step-up) removes the bytes from disk.',
  },
  // ---------------------------------------------------------------------
  // Runtime + storage — split from the old monolithic `runtime.manage`
  // ---------------------------------------------------------------------
  'runtime.dependencies': {
    label: 'Manage runtime dependencies',
    description: 'Edit the site’s package.json dependencies and trigger resolve/install.',
  },
  'storage.elect': {
    label: 'Elect storage backends',
    description: 'Elect the media storage adapter per asset role (originals / variants / avatars / fonts) and the variant delegate.',
  },
  'storage.migrate': {
    label: 'Migrate storage bytes',
    description: 'Run the migration SSE that moves bytes between storage adapters after an election change.',
  },
  // ---------------------------------------------------------------------
  // Plugins — granular split (read/configure/install/lifecycle)
  // ---------------------------------------------------------------------
  'plugins.read': {
    label: 'Browse installed plugins',
    description: 'See the installed plugin list, masked settings, schedules, and event stream.',
  },
  'plugins.configure': {
    label: 'Configure plugins',
    description: 'Edit per-plugin settings and manage plugin-owned records.',
  },
  'plugins.install': {
    label: 'Install or uninstall plugins',
    description: 'Install, upgrade, and uninstall plugins. Runs third-party code on the host — RCE-class. Step-up gated.',
  },
  'plugins.lifecycle': {
    label: 'Plugin lifecycle control',
    description: 'Enable, disable, restart plugins. Pause/resume/run-now their schedules. Step-up gated.',
  },
  'users.manage': {
    label: 'Manage users',
    description: 'Create, edit, delete, and suspend users; assign roles.',
  },
  'roles.manage': {
    label: 'Manage roles',
    description: 'Create, edit, and delete custom roles; assign capabilities to roles.',
  },
  'audit.read': {
    label: 'Read audit log',
    description: 'View the audit log and the Dashboard activity widget.',
  },
  // ---------------------------------------------------------------------
  // Data workspace — split from `content.manage`
  // ---------------------------------------------------------------------
  'data.custom.tables.read': {
    label: 'Browse custom tables',
    description: 'Open the Data workspace; browse user-created (custom) tables and their field schemas. Does not reveal the internal system tables.',
  },
  'data.custom.tables.manage': {
    label: 'Manage custom tables',
    description: 'Create, rename, and delete custom tables; add/edit/remove their fields and route bases.',
  },
  'data.system.tables.read': {
    label: 'Browse system tables',
    description: 'See and open the four built-in system tables (Posts, Pages, Components, Layouts) in the Data workspace.',
  },
  'data.system.tables.manage': {
    label: 'Manage system-table custom fields',
    description: 'On system tables: add/edit/remove custom fields and choose the primary field. Built-in fields and the table identity (name, slug, route) stay locked.',
  },
  'data.rows.move': {
    label: 'Move rows between tables',
    description: 'Move a row from one table to another (changes public URL because route base differs per table).',
  },
  'data.export': {
    label: 'Export data bundles',
    description: 'Download a JSON bundle of tables + rows (plus optional media bytes). Includes the import preview dry-run.',
  },
  'data.import': {
    label: 'Import data bundles',
    description: 'Upload a JSON bundle to merge or replace local data. `replace` mode additionally requires Manage content and step-up.',
  },
  // ---------------------------------------------------------------------
  // AI runtime — split `ai.use` into chat vs write-tools
  // ---------------------------------------------------------------------
  'ai.chat': {
    label: 'Use AI chat',
    description: 'Open AI conversations and use read-only tools (snapshot, search). Cannot mutate state without `Allow AI write tools`.',
  },
  'ai.tools.write': {
    label: 'Allow AI write tools',
    description: 'Lets AI conversations mutate the editor store (insert nodes, edit props, etc.) via the canvas bridge. Without this, the model has no write tools registered.',
  },
  'ai.providers.manage': {
    label: 'Manage AI providers',
    description: 'Configure AI providers, credentials, and per-scope defaults.',
  },
  'ai.audit.read': {
    label: 'Read AI audit log',
    description: 'View site-wide AI usage, cost, and error events across all users.',
  },
  // ---------------------------------------------------------------------
  // SEO workspace
  // ---------------------------------------------------------------------
  'seo.read': {
    label: 'View SEO',
    description: 'Open the SEO workspace and read metadata, robots, and sitemap settings.',
  },
  'seo.manage': {
    label: 'Manage SEO',
    description: 'Edit page/post metadata, site SEO defaults, robots.txt, and sitemap settings.',
  },
}

/**
 * Returns the human-readable label for a capability — falls back to the raw
 * ID for any value not in the meta map (defensive, in case a stored role
 * references a capability that has since been removed from the codebase).
 */
export function capabilityLabel(capability: string): string {
  return (CAPABILITY_META as Record<string, CapabilityMeta>)[capability]?.label ?? capability
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  { title: 'Dashboard', capabilities: ['dashboard.read'] },
  {
    title: 'Site',
    capabilities: [
      'site.read',
      'site.structure.edit',
      'site.content.edit',
      'site.style.edit',
    ],
  },
  { title: 'Pages', capabilities: ['pages.edit', 'pages.publish'] },
  {
    title: 'Content',
    capabilities: [
      'content.create',
      'content.edit.own',
      'content.edit.any',
      'content.publish.own',
      'content.publish.any',
      'content.manage',
    ],
  },
  {
    title: 'Data',
    capabilities: [
      'data.custom.tables.read',
      'data.custom.tables.manage',
      'data.system.tables.read',
      'data.system.tables.manage',
      'data.rows.move',
      'data.export',
      'data.import',
    ],
  },
  {
    title: 'Media',
    capabilities: ['media.read', 'media.write', 'media.replace', 'media.delete'],
  },
  {
    title: 'Runtime & storage',
    capabilities: ['runtime.dependencies', 'storage.elect', 'storage.migrate'],
  },
  {
    title: 'Plugins',
    capabilities: ['plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle'],
  },
  {
    title: 'AI',
    capabilities: ['ai.chat', 'ai.tools.write', 'ai.providers.manage', 'ai.audit.read'],
  },
  { title: 'SEO', capabilities: ['seo.read', 'seo.manage'] },
  { title: 'Users & Roles', capabilities: ['users.manage', 'roles.manage'] },
  { title: 'Audit', capabilities: ['audit.read'] },
]

/**
 * Flat list of every capability rendered by the role-edit dialog, in the
 * order defined by `CAPABILITY_GROUPS`. Used for the dialog's "select all
 * across every group" master toggle.
 */
export const ALL_PICKER_CAPABILITIES: readonly CoreCapability[] = CAPABILITY_GROUPS.flatMap(
  (group) => group.capabilities,
)
