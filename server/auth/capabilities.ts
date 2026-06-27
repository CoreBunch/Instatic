/**
 * Server-side capabilities + role module.
 *
 * The capability surface itself (the `CORE_CAPABILITIES` list and the derived
 * `CoreCapability` type) is owned by `@core/capabilities` — the single source
 * of truth shared by client and server. This file imports that list and adds
 * the server-only concerns: the built-in system roles, the boot-time force-sync
 * set, and the runtime capability guards. Both are re-exported so server code
 * has one import site for "everything capabilities".
 *
 * See docs/reference/capabilities.md for the full per-capability reference.
 */
import { CORE_CAPABILITIES, type CoreCapability } from '@core/capabilities'


export type { CoreCapability }

interface SystemRoleDefinition {
  id: string
  slug: string
  name: string
  description: string
  capabilities: CoreCapability[]
}

/**
 * The four built-in system roles.
 *
 * - **Owner** is force-resynced from `CORE_CAPABILITIES` on every boot via
 *   `syncSystemRoles(db)` so adding a new capability never strands an
 *   existing Owner on a stale grant list.
 *
 * - **Admin** is *also* force-resynced from its explicit literal list on
 *   every boot. The list is intentionally written out (not derived by
 *   filtering CORE_CAPABILITIES) so every new capability requires a
 *   conscious decision per PR about whether Admin gets it. This stops
 *   the previous silent-drift bug where new caps silently appeared on
 *   Admin or never appeared at all.
 *
 * - **Client** and **Member** are seeded once and freely editable.
 */
const adminCapabilities: CoreCapability[] = [
  'dashboard.read',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
  'pages.publish',
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
  'media.read',
  'media.write',
  'media.replace',
  'media.delete',
  'runtime.dependencies',
  'storage.elect',
  'storage.migrate',
  'plugins.read',
  'plugins.configure',
  'plugins.install',
  'plugins.lifecycle',
  'users.manage',
  // `roles.manage` is owner-only by design — admin cannot grant capabilities.
  'audit.read',
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
  'data.rows.move',
  'data.export',
  'data.import',
  'ai.chat',
  'ai.tools.write',
  'ai.providers.manage',
  'ai.audit.read',
  'seo.read',
  'seo.manage',
]

const clientCapabilities: CoreCapability[] = [
  'dashboard.read',
  'site.read',
  'site.content.edit',
  // Client needs to browse the media library to swap images on existing
  // nodes (`site.content.edit` already lets them change image src; this
  // makes the picker actually usable).
  'media.read',
  // Data workspace = read-only browsing of CUSTOM tables only. The client
  // never sees the internal system tables (posts/pages/components/layouts).
  'data.custom.tables.read',
]

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    id: 'owner',
    slug: 'owner',
    name: 'Owner',
    description: 'Permanent installation owner with full system access.',
    capabilities: [...CORE_CAPABILITIES],
  },
  {
    id: 'admin',
    slug: 'admin',
    name: 'Admin',
    description: 'Full admin access (cannot manage roles).',
    capabilities: adminCapabilities,
  },
  {
    id: 'client',
    slug: 'client',
    name: 'Client',
    description: 'Can edit page copy (text, images, links) but not structure or styles.',
    capabilities: clientCapabilities,
  },
  {
    id: 'member',
    slug: 'member',
    name: 'Member',
    description: 'Public-facing member account — no admin access by default.',
    capabilities: [],
  },
]

/**
 * The Owner role id is the well-known constant the boot-time sync targets.
 */
export const OWNER_ROLE_ID = 'owner'

/**
 * The Admin role id — also boot-resynced (see `SYSTEM_ROLES` comment).
 * Internal-only: consumed by `FORCE_SYNC_ROLE_IDS` below.
 */
const ADMIN_ROLE_ID = 'admin'

/**
 * Role ids that get their capability list force-synced from code on every
 * boot. Owner and Admin are managed by the system; Client and Member are
 * seeded once and freely editable.
 */
export const FORCE_SYNC_ROLE_IDS: readonly string[] = [OWNER_ROLE_ID, ADMIN_ROLE_ID]

export function isCoreCapability(value: unknown): value is CoreCapability {
  return typeof value === 'string' && CORE_CAPABILITIES.includes(value as CoreCapability)
}

export function normalizeCapabilities(value: unknown): CoreCapability[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<CoreCapability>()
  for (const item of value) {
    if (isCoreCapability(item)) seen.add(item)
  }
  return [...seen].sort((a, b) => CORE_CAPABILITIES.indexOf(a) - CORE_CAPABILITIES.indexOf(b))
}

export function roleHasCapability(capabilities: readonly CoreCapability[], capability: CoreCapability): boolean {
  return capabilities.includes(capability)
}
