import { describe, expect, it } from 'bun:test'
import type { CmsCurrentUser } from '@core/persistence'
import type { CoreCapability } from '@core/capabilities'
import { MCP_CAPABILITY_GROUPS, availableMcpCapabilityGroups, defaultMcpReadCapabilities } from './mcpCapabilities'

function user(capabilities: CoreCapability[]): CmsCurrentUser {
  return { id: 'u1', email: 'u@example.test', name: 'U', role: 'admin', capabilities } as CmsCurrentUser
}

function offered(groups: readonly { capabilities: readonly CoreCapability[] }[]): CoreCapability[] {
  return groups.flatMap((group) => [...group.capabilities])
}

describe('MCP capability picker', () => {
  // Regression: the headless `data_*` schema tools gate on
  // `data.custom.tables.manage` and the consent screen is the only place a
  // connector's capabilities are chosen. Leaving it out of the picker makes
  // `data_create_table` ungrantable no matter how often the client reconnects.
  it('offers custom-table management so the data schema tools can be granted', () => {
    expect(offered(MCP_CAPABILITY_GROUPS)).toContain('data.custom.tables.manage')
  })

  it('hides it from an approver who does not hold it', () => {
    const groups = availableMcpCapabilityGroups(user(['site.read', 'data.custom.tables.read']))

    expect(offered(groups)).not.toContain('data.custom.tables.manage')
    expect(offered(groups)).toContain('data.custom.tables.read')
  })

  it('keeps schema management off the read-only default selection', () => {
    const defaults = defaultMcpReadCapabilities(MCP_CAPABILITY_GROUPS)

    expect(defaults.has('data.custom.tables.read')).toBe(true)
    expect(defaults.has('data.custom.tables.manage')).toBe(false)
  })
})
