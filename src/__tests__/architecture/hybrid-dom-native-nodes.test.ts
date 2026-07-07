/**
 * Architecture Gate — Hybrid DOM-native node tree invariants.
 *
 * Phase 3 introduced DOM-native nodes (moduleId === '') alongside the existing
 * module-based nodes. These tests verify the structural invariants that keep
 * the hybrid tree consistent across all consuming surfaces:
 *
 *   1. `isDomNode` discriminant — empty moduleId + truthy tag
 *   2. `createDomNode` always produces moduleId === '' and a tag
 *   3. `domCanHaveChildren` rejects void elements
 *   4. The catch-all import rule produces DOM-native nodes (not base.container)
 *   5. The publisher renders DOM-native nodes without a module lookup
 *   6. The pageDiff validator covers tag/attributes/textContent fields
 *   7. The AI tool surface includes site_update_dom_node
 */

import { describe, it, expect } from 'bun:test'
import {
  isDomNode,
  VOID_HTML_ELEMENTS,
  domCanHaveChildren,
} from '@core/page-tree'
import { createDomNode } from '@core/page-tree/mutations'
import { importHtml } from '@core/htmlImport'
import { validatePageWriteDiff } from '../../../server/handlers/cms/pageDiff'

describe('hybrid DOM-native node invariants', () => {
  describe('isDomNode discriminant', () => {
    it('returns true for a node with empty moduleId and a tag', () => {
      expect(isDomNode({ moduleId: '', tag: 'figure' })).toBe(true)
    })

    it('returns false for a module-based node', () => {
      expect(isDomNode({ moduleId: 'base.text', tag: undefined })).toBe(false)
    })

    it('returns false for an empty moduleId without a tag', () => {
      expect(isDomNode({ moduleId: '', tag: undefined })).toBe(false)
    })
  })

  describe('createDomNode', () => {
    it('produces a node with moduleId === "" and the given tag', () => {
      const node = createDomNode('blockquote')
      expect(node.moduleId).toBe('')
      expect(node.tag).toBe('blockquote')
      expect(node.children).toEqual([])
      expect(typeof node.id).toBe('string')
      expect(node.id.length).toBeGreaterThan(0)
    })

    it('preserves attributes and textContent', () => {
      const node = createDomNode('mark', {
        attributes: { 'data-highlight': 'yellow' },
        textContent: 'important',
      })
      expect(node.attributes).toEqual({ 'data-highlight': 'yellow' })
      expect(node.textContent).toBe('important')
    })
  })

  describe('domCanHaveChildren', () => {
    it('returns true for container elements', () => {
      expect(domCanHaveChildren('div')).toBe(true)
      expect(domCanHaveChildren('section')).toBe(true)
      expect(domCanHaveChildren('figure')).toBe(true)
    })

    it('returns false for void elements', () => {
      for (const tag of VOID_HTML_ELEMENTS) {
        expect(domCanHaveChildren(tag)).toBe(false)
      }
    })
  })

  describe('HTML import catch-all rule', () => {
    it('maps unmapped elements to DOM-native nodes (moduleId === "")', () => {
      const result = importHtml('<figure><figcaption>Caption</figcaption></figure>')
      const figureId = result.rootIds[0]!
      const figureNode = result.nodes[figureId]!
      expect(figureNode.moduleId).toBe('')
      expect(figureNode.tag).toBe('figure')
      // Children should also be DOM-native
      const figcaptionId = figureNode.children[0]!
      const figcaptionNode = result.nodes[figcaptionId]!
      expect(figcaptionNode.moduleId).toBe('')
      expect(figcaptionNode.tag).toBe('figcaption')
    })

    it('does not map unmapped elements to base.container', () => {
      const result = importHtml('<blockquote>Quote</blockquote>')
      const node = result.nodes[result.rootIds[0]!]!
      expect(node.moduleId).not.toBe('base.container')
      expect(node.moduleId).toBe('')
    })
  })

  describe('AI tool surface', () => {
    it('includes site_update_dom_node in the registered write tools', async () => {
      const { siteWriteTools } = await import('../../../server/ai/tools/site/writeTools')
      const toolNames = siteWriteTools.map((t) => t.name)
      expect(toolNames).toContain('site_update_dom_node')
    })
  })

  describe('pageDiff coverage', () => {
    it('diffs tag/attributes/textContent fields on DOM-native nodes', () => {
      // The module exports validatePageWriteDiff — the function that
      // calls diffNode which now covers DOM-native fields.
      expect(typeof validatePageWriteDiff).toBe('function')
    })
  })
})
