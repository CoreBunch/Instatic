/**
 * Role-edit capability groupings.
 *
 * Every entry in `CAPABILITY_GROUPS` maps to a `<section>` in the role dialog's
 * `CapabilityPicker`. The human-readable label + description for each
 * capability live with the picker (`@admin/shared/CapabilityPicker` →
 * `CAPABILITY_META`).
 *
 * Adding a new capability: append it to `CORE_CAPABILITIES` (`@core/capabilities`),
 * add it to one of the groups here, and add its meta entry in
 * `CapabilityPicker/capabilityMeta.ts`. The `capability-picker-coverage.test.ts`
 * gate enforces full coverage so a new capability can't quietly disappear from
 * the role-edit UI.
 */
import type { CoreCapability } from '@core/capabilities'
import type { CapabilityGroup } from '../types'

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
