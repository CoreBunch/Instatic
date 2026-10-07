import { describe, expect, it } from 'bun:test'
import { mcpToolsForCapabilities } from './registry'

const FULL: Parameters<typeof mcpToolsForCapabilities>[0] = [
  'ai.chat',
  'ai.tools.write',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.publish',
  'content.manage',
  'content.create',
  'content.edit.any',
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'content.publish.any',
  'media.read',
  'media.write',
]

describe('mcp registry', () => {
  it('exposes the full catalog: headless reads + browser editing tools', () => {
    const tools = mcpToolsForCapabilities(FULL)
    const names = tools.map((t) => t.name)
    // headless (server-resolved) reads
    expect(names).toContain('site_read_styles') // headless design-system read
    expect(names).toContain('site_publish') // explicit full-site deployment
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

  it('exposes media_upload only with both write and media.write capabilities', () => {
    const upload = mcpToolsForCapabilities(FULL).find((t) => t.name === 'media_upload')
    expect(upload).toBeTruthy()
    expect(upload!.execution).toBe('server') // in-process, no editor needed
    expect(upload!.mutates).toBe(true)
    // Gated by media.write…
    expect(mcpToolsForCapabilities(FULL.filter((c) => c !== 'media.write')).map((t) => t.name))
      .not.toContain('media_upload')
    // …and by ai.tools.write (it mutates).
    expect(mcpToolsForCapabilities(FULL.filter((c) => c !== 'ai.tools.write')).map((t) => t.name))
      .not.toContain('media_upload')
  })

  it('only exposes full-site publish when both write and publish capabilities are granted', () => {
    expect(mcpToolsForCapabilities(FULL).map((t) => t.name)).toContain('site_publish')
    expect(mcpToolsForCapabilities(FULL.filter((c) => c !== 'pages.publish')).map((t) => t.name))
      .not.toContain('site_publish')
    expect(mcpToolsForCapabilities(FULL.filter((c) => c !== 'ai.tools.write')).map((t) => t.name))
      .not.toContain('site_publish')
  })
  it('exposes the headless data toolset that reusable data tables need', () => {
    const tools = mcpToolsForCapabilities(FULL)
    const byName = new Map(tools.map((t) => [t.name, t]))

    // Issue #463 / #433: without these, a `kind: 'data'` table could not be
    // listed, created, or written over MCP at all.
    for (const name of [
      'data_list_tables',
      'data_create_table',
      'data_update_table',
      'data_add_fields',
      'data_create_rows',
      'data_update_row',
      'data_set_rows_status',
      'data_delete_rows',
    ]) {
      expect(byName.get(name)).toBeTruthy()
      // A data row is a grid of cells, not a Tiptap document — there is no
      // editor surface to relay these through, and requiring one would make
      // the whole toolset unusable from a headless agent.
      expect(byName.get(name)!.execution).toBe('server')
    }
  })

  it('drops every data write when ai.tools.write is absent, keeping the read', () => {
    const readOnly = mcpToolsForCapabilities(FULL.filter((c) => c !== 'ai.tools.write'))
      .map((t) => t.name)
    expect(readOnly).toContain('data_list_tables')
    expect(readOnly).not.toContain('data_create_table')
    expect(readOnly).not.toContain('data_create_rows')
    expect(readOnly).not.toContain('data_delete_rows')
  })

  it('gates schema writes on a table-manage capability, separately from row writes', () => {
    const noTableManage = mcpToolsForCapabilities(
      FULL.filter((c) => c !== 'data.custom.tables.manage'),
    ).map((t) => t.name)
    expect(noTableManage).not.toContain('data_create_table')
    expect(noTableManage).not.toContain('data_add_fields')
    // Row writes ride content.* capabilities, so they survive.
    expect(noTableManage).toContain('data_create_rows')
  })

  it('advertises an outputSchema for every tool in the catalog', () => {
    // The MCP surface promises structured output. A tool added without an
    // `outputSchema` would silently ship `structuredContent` no client can
    // interpret, so the catalog is the gate rather than each tool file.
    const missing = mcpToolsForCapabilities(FULL)
      .filter((t) => t.outputSchema === undefined)
      .map((t) => t.name)
    expect(missing).toEqual([])
  })
})
