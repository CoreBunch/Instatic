import { describe, expect, it } from 'bun:test'
import { mcpToolsForCapabilities } from './registry'

const FULL: Parameters<typeof mcpToolsForCapabilities>[0] = [
  'ai.chat',
  'ai.tools.write',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'content.manage',
  'content.create',
  'content.edit.any',
  'data.custom.tables.read',
  'data.system.tables.read',
  'media.read',
  'media.write',
]

describe('mcp registry', () => {
  it('exposes the full catalog: headless reads + browser editing tools', () => {
    const tools = mcpToolsForCapabilities(FULL)
    const names = tools.map((t) => t.name)
    // headless (server-resolved) reads
    expect(names).toContain('site_read_styles') // headless design-system read
    expect(names).toContain('content_list_collections')
    // browser-execution editing (relayed via the editor bridge)
    expect(names).toContain('site_insert_html')
    expect(names).toContain('site_delete_node')
    expect(names).toContain('site_apply_css')
    expect(names).toContain('site_set_color_tokens')
    expect(tools.some((t) => t.execution === 'browser')).toBe(true)
  })

  it('does not expose the removed headless page-tree tools', () => {
    const names = mcpToolsForCapabilities(FULL).map((t) => t.name)
    // Deleted: they were a second DB surface that desynced from the open editor.
    expect(names).not.toContain('read_page_tree')
    expect(names).not.toContain('mutate_page_tree')
  })

  it('excludes the snapshot-dependent list_tokens but exposes a headless list_breakpoints', () => {
    const tools = mcpToolsForCapabilities(FULL)
    const names = tools.map((t) => t.name)
    // list_tokens reads ctx.snapshot (null over MCP) → excluded; read_styles replaces it.
    expect(names).not.toContain('site_list_tokens')
    // list_breakpoints is exposed, but as the HEADLESS (server-resolved) version.
    const bp = tools.find((t) => t.name === 'site_list_breakpoints')
    expect(bp).toBeTruthy()
    expect(bp!.execution).toBe('server')
  })

  it('prefixes resolve the old site/content list_documents collision into distinct names', () => {
    const names = mcpToolsForCapabilities(FULL).map((t) => t.name)
    expect(names).toContain('site_list_documents')
    expect(names).toContain('content_list_documents')
    // No tool name appears twice.
    expect(new Set(names).size).toBe(names.length)
  })

  it('filters out mutating tools when ai.tools.write is absent', () => {
    const readOnly = FULL.filter((c) => c !== 'ai.tools.write')
    const tools = mcpToolsForCapabilities(readOnly)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some((t) => t.mutates)).toBe(false)
    expect(tools.some((t) => t.name === 'mutate_page_tree')).toBe(false)
    expect(tools.some((t) => t.name === 'site_insert_html')).toBe(false)
  })
})
