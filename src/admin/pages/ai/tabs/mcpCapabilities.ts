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
