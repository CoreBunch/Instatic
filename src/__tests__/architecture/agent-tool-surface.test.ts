/**
 * Architecture gate — AI site write-tool surface.
 *
 * Asserts that the legacy node-construction tools (`insertNode`,
 * `insertTree`) and the retired class-patch tools (`createClass`,
 * `updateClassStyles`) are absent from the registered site write-tool list,
 * and that the HTML-native replacements (`insertHtml`, `getNodeHtml`,
 * `replaceNodeHtml`) plus the single CSS-authoring tool (`applyCss`) are
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
    expect(toolNames).toContain('insertHtml')
  })

  it('HTML-native getNodeHtml tool is present', () => {
    expect(toolNames).toContain('getNodeHtml')
  })

  it('document-aware browser read tools are present', () => {
    expect(toolNames).toContain('read_document')
    expect(toolNames).toContain('open_document')
  })

  it('HTML-native replaceNodeHtml tool is present', () => {
    expect(toolNames).toContain('replaceNodeHtml')
  })

  it('single CSS-authoring applyCss tool is present', () => {
    expect(toolNames).toContain('applyCss')
  })

  it('code asset tools are present', () => {
    expect(toolNames).toContain('list_code_assets')
    expect(toolNames).toContain('read_code_asset')
    expect(toolNames).toContain('write_code_asset')
    expect(toolNames).toContain('patch_code_asset')
    expect(toolNames).toContain('inspect_code_runtime')
  })

  it('code asset read tools are not stamped as mutating', () => {
    expect(stampedToolByName.get('list_code_assets')?.mutates).toBe(false)
    expect(stampedToolByName.get('read_code_asset')?.mutates).toBe(false)
    expect(stampedToolByName.get('inspect_code_runtime')?.mutates).toBe(false)
  })

  it('code asset write tools are stamped as mutating', () => {
    expect(stampedToolByName.get('write_code_asset')?.mutates).toBe(true)
    expect(stampedToolByName.get('patch_code_asset')?.mutates).toBe(true)
  })

  it('retired class-patch tools are absent', () => {
    expect(toolNames).not.toContain('createClass')
    expect(toolNames).not.toContain('updateClassStyles')
  })

  it('design-system token tools are present', () => {
    expect(toolNames).toContain('set_color_tokens')
    expect(toolNames).toContain('set_font_tokens')
    expect(toolNames).toContain('set_type_scale')
    expect(toolNames).toContain('set_spacing_scale')
  })

  it('template tools are present', () => {
    expect(toolNames).toContain('setPageTemplate')
    expect(toolNames).toContain('clearPageTemplate')
  })

  it('total tool count is 29 (document, HTML, node, CSS, code asset, page, template, token, and snapshot tools)', () => {
    expect(toolNames).toHaveLength(29)
  })
})
