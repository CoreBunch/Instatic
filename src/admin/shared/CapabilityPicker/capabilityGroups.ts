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
import type { CapabilityPickerGroup } from './CapabilityPicker'

export const CAPABILITY_GROUPS: readonly CapabilityPickerGroup[] = [
  { title: 'Dashboard', capabilities: ['dashboard.read'] },
  {
    title: 'Site',
    capabilities: [
      'site.read',
      'site.structure.edit',
      'site.content.edit',
      'site.style.edit',
      'site.branches.create',
      'site.branches.manage',
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
  { title: 'Email', capabilities: ['mail.manage'] },
  { title: 'Members', capabilities: ['members.read', 'members.manage'] },
]
