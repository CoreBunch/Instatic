import { describe, expect, it } from 'bun:test'
import { mcpToolsForCapabilities } from '../registry'
import { defaultMcpReadCapabilities, MCP_CAPABILITY_GROUPS } from '../../../../src/admin/pages/ai/tabs/mcpCapabilities'

const DIRECTUS_TOOLS = [
  'directus_health',
  'directus_list_geography',
  'directus_get_geography_ancestry',
  'directus_list_workfields',
  'directus_get_workfield',
  'directus_get_workfield_faq',
  'directus_list_strengths',
] as const

describe('MCP Directus tools', () => {
  it('are listed for directus.read without ai.tools.write', () => {
    const names = mcpToolsForCapabilities(['directus.read']).map((tool) => tool.name)
    for (const name of DIRECTUS_TOOLS) {
      expect(names).toContain(name)
    }
    const tools = mcpToolsForCapabilities(['directus.read']).filter((tool) =>
      DIRECTUS_TOOLS.includes(tool.name as (typeof DIRECTUS_TOOLS)[number]),
    )
    expect(tools.every((tool) => tool.mutates !== true)).toBe(true)
    expect(tools.every((tool) => tool.execution === 'server')).toBe(true)
  })

  it('are absent without directus.read', () => {
    const names = mcpToolsForCapabilities(['site.read', 'ai.tools.write']).map((tool) => tool.name)
    for (const name of DIRECTUS_TOOLS) {
      expect(names).not.toContain(name)
    }
  })

  it('are in the default MCP Read grant', () => {
    const defaults = defaultMcpReadCapabilities(MCP_CAPABILITY_GROUPS)
    expect(defaults.has('directus.read')).toBe(true)
  })
})
