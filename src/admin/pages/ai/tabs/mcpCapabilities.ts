import type { CmsCurrentUser } from '@core/persistence'
import type { CoreCapability } from '@core/capabilities'
import { hasCapability } from '@admin/access'
import type { CapabilityPickerGroup } from '@admin/shared/CapabilityPicker'

export const MCP_CAPABILITY_GROUPS: readonly CapabilityPickerGroup[] = [
  {
    title: 'Read',
    capabilities: ['site.read', 'content.manage', 'data.custom.tables.read', 'data.system.tables.read', 'media.read'],
  },
  {
    title: 'Allow writes',
    capabilities: ['ai.tools.write'],
  },
  {
    title: 'Site editing',
    capabilities: ['site.structure.edit', 'site.content.edit', 'site.style.edit'],
  },
  {
    title: 'Pages',
    capabilities: ['pages.edit', 'pages.publish'],
  },
  {
    title: 'Content',
    capabilities: ['content.create', 'content.edit.own', 'content.edit.any', 'content.publish.own', 'content.publish.any'],
  },
  // Schema, not rows: `data_create_table` / `data_update_table` / `data_add_fields`
  // are gated on this and on nothing else, so without it here those tools can
  // never be granted — the consent screen is the only place a connector's
  // capability set is chosen. Its own group because creating a table is a
  // different kind of authority than editing the rows in one.
  //
  // `data.system.tables.manage` is deliberately NOT offered: the four built-in
  // tables refuse identity and built-in-field changes anyway
  // (`assertSystemTableUpdateAllowed`), so granting it to a connector buys
  // custom fields on system tables at the cost of a much wider-sounding grant.
  {
    title: 'Data tables',
    capabilities: ['data.custom.tables.manage'],
  },
  {
    title: 'Media',
    capabilities: ['media.write', 'media.replace', 'media.delete'],
  },
]

const READ_CAPABILITIES = new Set<CoreCapability>(MCP_CAPABILITY_GROUPS[0].capabilities)

export function availableMcpCapabilityGroups(
  currentUser: CmsCurrentUser | null,
): CapabilityPickerGroup[] {
  return MCP_CAPABILITY_GROUPS
    .map((group) => ({
      title: group.title,
      capabilities: group.capabilities.filter(
        (capability) => !currentUser || hasCapability(currentUser, capability),
      ),
    }))
    .filter((group) => group.capabilities.length > 0)
}

export function defaultMcpReadCapabilities(
  groups: readonly CapabilityPickerGroup[],
): Set<CoreCapability> {
  return new Set(
    groups.flatMap((group) => group.capabilities).filter((capability) => READ_CAPABILITIES.has(capability)),
  )
}
