import type { DataRow, DataTable } from '@core/data/schemas'
import type { CmsCurrentUser } from '@core/persistence'
import type { CoreCapability } from '@core/capabilities'
import type { AdminWorkspace } from './workspace'

// Any-of gate for saving the draft site: holding at least one lets the user
// save in some form; granular diff validation enforces which kinds of changes
// are actually allowed. Mirrors the server gate in handlers/cms/site.ts.
const SITE_WRITE_CAPABILITIES: CoreCapability[] = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
]

const CONTENT_ACCESS_CAPABILITIES: CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

const DATA_WORKSPACE_READ_CAPABILITIES: CoreCapability[] = [
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
  // Also accept any `content.*` cap so the loop / template pickers in
  // the site editor can still resolve data tables for someone whose
  // workspace gate is content rather than data.
  ...CONTENT_ACCESS_CAPABILITIES,
]

const PLUGIN_READ_CAPABILITIES: CoreCapability[] = [
  'plugins.read',
  'plugins.configure',
  'plugins.install',
  'plugins.lifecycle',
]

const RUNTIME_STORAGE_CAPABILITIES: CoreCapability[] = [
  'runtime.dependencies',
  'storage.elect',
  'storage.migrate',
]

export function hasCapability(user: CmsCurrentUser | null, capability: CoreCapability): boolean {
  return Boolean(user?.capabilities.includes(capability))
}

function hasAnyCapability(user: CmsCurrentUser | null, capabilities: readonly CoreCapability[]): boolean {
  return capabilities.some((capability) => hasCapability(user, capability))
}

function hasAllCapabilities(user: CmsCurrentUser | null, capabilities: readonly CoreCapability[]): boolean {
  return capabilities.every((capability) => hasCapability(user, capability))
}

// ---------------------------------------------------------------------------
// Site-editor capability helpers
//
// The editor surfaces three granular capabilities:
//   - site.structure.edit  — DnD, add/remove/move/rename nodes, manage pages
//   - site.content.edit    — modify content-typed props (text, image, href)
//   - site.style.edit      — class styles, breakpoints, framework tokens
//
// A user may hold any subset. The editor renders based on which they hold.
// ---------------------------------------------------------------------------

/** Caller can perform structural edits (DnD, add/remove/move nodes, pages). */
export function canEditStructure(user: CmsCurrentUser | null): boolean {
  // Anonymous in tests / SSR is treated as full-access — the gate is the
  // browser's authenticated session, not the absence of a user object.
  if (!user) return true
  return hasAllCapabilities(user, ['site.structure.edit', 'pages.edit'])
}

/** Caller can modify content-typed props on existing nodes. */
export function canEditContent(user: CmsCurrentUser | null): boolean {
  if (!user) return true
  return hasCapability(user, 'site.content.edit')
}

/** Caller can modify CSS classes, style overrides, breakpoints, tokens. */
export function canEditStyle(user: CmsCurrentUser | null): boolean {
  if (!user) return true
  return hasCapability(user, 'site.style.edit')
}

/** Caller can save the draft site in any form (structure + content + style). */
export function canSaveDraftSite(user: CmsCurrentUser | null): boolean {
  if (!user) return true
  return hasAnyCapability(user, SITE_WRITE_CAPABILITIES)
}

function ownsDataRow(user: CmsCurrentUser | null, row: DataRow | null): boolean {
  if (!user || !row) return false
  return row.authorUserId === user.id || (!row.authorUserId && row.createdByUserId === user.id)
}

function canAccessContent(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, CONTENT_ACCESS_CAPABILITIES)
}

export function canAccessDataRows(user: CmsCurrentUser | null): boolean {
  return canAccessContent(user)
}

export function canCreateContent(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'content.create')
}

export function canManageContentCollections(user: CmsCurrentUser | null): boolean {
  // Creating / editing custom tables (collections) lives on
  // `data.custom.tables.manage`. Keep `content.manage` accepted too — historical
  // installs and the content-row level granted them together.
  return hasAnyCapability(user, ['data.custom.tables.manage', 'content.manage'])
}

export function canEditAnyContent(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, ['content.edit.any', 'content.manage'])
}

export function canEditContentEntry(user: CmsCurrentUser | null, row: DataRow | null): boolean {
  return canEditAnyContent(user) || (ownsDataRow(user, row) && hasCapability(user, 'content.edit.own'))
}

export function canPublishContentEntry(user: CmsCurrentUser | null, row: DataRow | null): boolean {
  return hasCapability(user, 'content.publish.any') ||
    (ownsDataRow(user, row) && hasCapability(user, 'content.publish.own'))
}

// ---------------------------------------------------------------------------
// Data workspace helpers
// ---------------------------------------------------------------------------

/** Caller can browse the Data workspace (schema viewer) — any table family. */
export function canReadDataTables(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, [
    'data.custom.tables.read',
    'data.custom.tables.manage',
    'data.system.tables.read',
    'data.system.tables.manage',
  ])
}

/** Caller can create custom tables (the "+ New table" affordance). */
export function canManageDataTables(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'data.custom.tables.manage')
}

/**
 * Whether the caller may SEE a specific table, by family. System tables
 * (`posts`/`pages`/`components`/`layouts`) need a system read cap; custom
 * tables need a custom read cap.
 */
export function canReadTable(user: CmsCurrentUser | null, table: Pick<DataTable, 'system'>): boolean {
  return table.system
    ? hasAnyCapability(user, ['data.system.tables.read', 'data.system.tables.manage'])
    : hasAnyCapability(user, ['data.custom.tables.read', 'data.custom.tables.manage'])
}

/**
 * Whether the caller may MANAGE a specific table's schema. For system tables
 * this only governs custom fields + primary field (identity and built-in fields
 * are immutable for everyone — enforced server-side).
 */
export function canManageTable(user: CmsCurrentUser | null, table: Pick<DataTable, 'system'>): boolean {
  return hasCapability(user, table.system ? 'data.system.tables.manage' : 'data.custom.tables.manage')
}

/** Caller can move a row from one table to another (`PATCH /rows/:id/table`). */
export function canMoveDataRow(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'data.rows.move')
}

/** Caller can export a SiteBundle and read the import preview. */
export function canExportData(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'data.export')
}

/** Caller can run an import (replace mode also needs content.manage + step-up server-side). */
export function canImportData(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'data.import')
}

// ---------------------------------------------------------------------------
// Media workspace helpers
// ---------------------------------------------------------------------------

/** Caller can open the Media workspace and the picker. */
export function canReadMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.read')
}

/** Caller can upload assets and edit metadata. */
export function canWriteMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.write')
}

/** Caller can overwrite the bytes of an existing asset. */
export function canReplaceMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.replace')
}

/** Caller can soft-delete / purge assets. */
export function canDeleteMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.delete')
}

// ---------------------------------------------------------------------------
// Plugin workspace helpers
// ---------------------------------------------------------------------------

/** Caller can open plugin settings and mutate plugin-owned records. */
export function canConfigurePlugins(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'plugins.configure')
}

/** Caller can install, upgrade, uninstall, and re-sync plugin packs. */
export function canInstallPlugins(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'plugins.install')
}

/** Caller can enable, disable, restart, and run/pause/resume schedules. */
export function canManagePluginLifecycle(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'plugins.lifecycle')
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

/** Caller can open AI conversations and use read-only AI tools. */
export function canUseAiChat(user: CmsCurrentUser | null): boolean {
  // Layout tests can render outside AdminSessionProvider; keep that preview
  // mode unrestricted. Real authenticated layouts always receive a user.
  if (!user) return true
  return hasCapability(user, 'ai.chat')
}

// ---------------------------------------------------------------------------
// Workspace gating
// ---------------------------------------------------------------------------

function canAccessUsersWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, ['users.manage', 'roles.manage', 'audit.read'])
}

function canAccessAiWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, ['ai.providers.manage', 'ai.audit.read'])
}

function canAccessDataWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, DATA_WORKSPACE_READ_CAPABILITIES)
}

function canAccessPluginsWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, PLUGIN_READ_CAPABILITIES)
}

export function canRunPluginBackgroundWork(user: CmsCurrentUser | null): boolean {
  // Layout tests can render outside AdminSessionProvider; keep that preview
  // mode unrestricted. Real authenticated layouts always receive a user.
  if (!user) return true
  return canAccessPluginsWorkspace(user)
}

export function canAccessWorkspace(user: CmsCurrentUser | null, workspace: AdminWorkspace): boolean {
  switch (workspace) {
    case 'dashboard':
      return hasCapability(user, 'dashboard.read')
    case 'site':
      // site.read covers the read-only canvas viewer. Editors of any flavour
      // (structure / content / style) also have site.read on a well-formed
      // role, so this single check is sufficient.
      return hasCapability(user, 'site.read')
    case 'content':
      return canAccessContent(user)
    case 'data':
      return canAccessDataWorkspace(user)
    case 'media':
      return canReadMedia(user)
    case 'plugins':
    case 'pluginPage':
      return canAccessPluginsWorkspace(user)
    case 'users':
      return canAccessUsersWorkspace(user)
    case 'ai':
      return canAccessAiWorkspace(user)
    case 'seo':
      return hasCapability(user, 'seo.read')
    case 'account':
      // Self-targeted page — every authenticated user can manage their own
      // profile + devices. Anonymous visitors fall through to false.
      return user !== null
  }
}

export function firstAccessibleWorkspace(user: CmsCurrentUser | null): AdminWorkspace | null {
  // Dashboard comes first — it's the canonical admin home. Falls through to
  // the next accessible workspace for users whose role doesn't grant
  // `dashboard.read` (rare; only happens with hand-edited custom roles).
  const order: AdminWorkspace[] = ['dashboard', 'site', 'content', 'data', 'media', 'plugins', 'users', 'ai', 'seo']
  return order.find((workspace) => canAccessWorkspace(user, workspace)) ?? null
}

export function workspacePath(workspace: AdminWorkspace): string {
  switch (workspace) {
    case 'dashboard':
      return '/admin/dashboard'
    case 'site':
      return '/admin/site'
    case 'content':
      return '/admin/content'
    case 'data':
      return '/admin/data'
    case 'media':
      return '/admin/media'
    case 'plugins':
      return '/admin/plugins'
    case 'users':
      return '/admin/users'
    case 'ai':
      return '/admin/ai'
    case 'seo':
      return '/admin/tools/seo'
    case 'pluginPage':
      return '/admin/plugins'
    case 'account':
      return '/admin/account'
  }
}

// Reference unused imports so the linter doesn't strip them when not consumed
// downstream yet (RUNTIME_STORAGE_CAPABILITIES is here for symmetry — the
// runtime workspace doesn't currently have its own canAccess gate because
// there is no dedicated runtime workspace; storage admin lives under media).
void RUNTIME_STORAGE_CAPABILITIES
