/**
 * Architecture gate — AI site write-tool surface.
 *
 * Asserts that the legacy node-construction tools (`insertNode`,
 * `insertTree`) and the retired class-patch tools (`createClass`,
 * `updateClassStyles`) are absent from the registered site write-tool list,
 * and that the HTML-native replacements (`site_insert_html`, `site_get_node_html`,
 * `site_replace_node_html`) plus the single CSS-authoring tool (`site_apply_css`) are
 * present.
 *
 * This gate catches accidental re-introduction of the old tools and
 * ensures the agent has exactly the HTML-native surface it was redesigned
 * around.
 */

import { describe, it, expect } from 'bun:test'
import { siteTools } from '../../../server/ai/tools/site'
import { siteWriteTools } from '../../../server/ai/tools/site/writeTools'

describe('agent-tool-surface gate', () => {
  const toolNames = siteWriteTools.map((t) => t.name)
  const stampedToolByName = new Map(siteTools.map((tool) => [tool.name, tool]))

  it('siteWriteTools array is non-empty', () => {
    expect(toolNames.length).toBeGreaterThan(0)
  })

  it('deprecated insertNode is absent', () => {
    expect(toolNames).not.toContain('insertNode')
  })

  it('deprecated insertTree is absent', () => {
    expect(toolNames).not.toContain('insertTree')
  })

  it('HTML-native insertHtml tool is present', () => {
    expect(toolNames).toContain('site_insert_html')
  })

  it('HTML-native getNodeHtml tool is present', () => {
    expect(toolNames).toContain('site_get_node_html')
  })

  it('document-aware browser read tools are present', () => {
    expect(toolNames).toContain('site_read_document')
    expect(toolNames).toContain('site_open_document')
  })

  it('HTML-native replaceNodeHtml tool is present', () => {
    expect(toolNames).toContain('site_replace_node_html')
  })

  it('single CSS-authoring applyCss tool is present', () => {
    expect(toolNames).toContain('site_apply_css')
  })

  it('code asset tools are present', () => {
    expect(toolNames).toContain('site_list_code_assets')
    expect(toolNames).toContain('site_read_code_asset')
    expect(toolNames).toContain('site_write_code_asset')
    expect(toolNames).toContain('site_patch_code_asset')
    expect(toolNames).toContain('site_inspect_code_runtime')
  })

  it('code asset read tools are not stamped as mutating', () => {
    expect(stampedToolByName.get('site_list_code_assets')?.mutates).toBe(false)
    expect(stampedToolByName.get('site_read_code_asset')?.mutates).toBe(false)
    expect(stampedToolByName.get('site_inspect_code_runtime')?.mutates).toBe(false)
  })

  it('code asset write tools are stamped as mutating', () => {
    expect(stampedToolByName.get('site_write_code_asset')?.mutates).toBe(true)
    expect(stampedToolByName.get('site_patch_code_asset')?.mutates).toBe(true)
  })

  it('retired class-patch tools are absent', () => {
    expect(toolNames).not.toContain('createClass')
    expect(toolNames).not.toContain('updateClassStyles')
  })

  it('design-system token tools are present', () => {
    expect(toolNames).toContain('site_set_color_tokens')
    expect(toolNames).toContain('site_set_font_tokens')
    expect(toolNames).toContain('site_set_type_scale')
    expect(toolNames).toContain('site_set_spacing_scale')
  })

  it('template tools are present', () => {
    expect(toolNames).toContain('site_set_page_template')
    expect(toolNames).toContain('site_clear_page_template')
  })

  it('total tool count is 29 (document, HTML, node, CSS, code asset, page, template, token, and snapshot tools)', () => {
    expect(toolNames).toHaveLength(29)
  })
})
