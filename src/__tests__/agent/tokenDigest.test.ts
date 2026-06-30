/**
 * The token digest is inlined into the dynamic suffix of the site-scope system
 * prompt every turn, so the agent sees the live design system (and the
 * "establish one first" nudge when there is none) without a list_tokens call.
 *
 * Exercised end-to-end: real tokens are created through the executor, the
 * browser builds the snapshot, and the server builds the prompt from it.
 */

import { describe, it, expect } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { buildCurrentPageContext, executeAgentTool } from '@site/agent'
import { buildSiteSystemPrompt } from '../../../server/ai/tools/site/systemPrompt'
import '@modules/base'

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    hasUnsavedChanges: false,
  })
  const s = useEditorStore.getState()
  const site = s.createSite('Test')
  useEditorStore.setState({ activePageId: site.pages[0].id })
}

function currentSuffix(): string {
  const snap = buildCurrentPageContext(() => useEditorStore.getState())!
  const prompt = buildSiteSystemPrompt(snap)
  return prompt[prompt.length - 1]
}

describe('token digest in the dynamic suffix', () => {
  it('emits the empty-state sentinel when no design system exists', () => {
    freshStore()
    const suffix = currentSuffix()
    expect(suffix).toContain('Tokens: (none')
    expect(suffix).toContain('site_set_color_tokens')
  })

  it('summarizes colors, type, spacing and fonts once established', async () => {
    freshStore()
    await executeAgentTool('site_set_color_tokens', { tokens: [{ slug: 'primary', lightValue: '#3b82f6' }] })
    await executeAgentTool('site_set_type_scale', { namingConvention: 'text', steps: 's,m,l' })
    await executeAgentTool('site_set_spacing_scale', { namingConvention: 'space', steps: 'xs,s,m' })
    await executeAgentTool('site_set_font_tokens', {
      tokens: [{ name: 'Body', variable: 'font-body', fallback: 'sans-serif' }],
    })

    const suffix = currentSuffix()
    expect(suffix).toContain('Tokens —')
    // The color value is resolved/normalized by describeFrameworkTokens.
    expect(suffix).toMatch(/colors: \[primary=/)
    expect(suffix).toContain('--text-*')
    expect(suffix).toContain('--space-*')
    expect(suffix).toContain('--font-body')
    expect(suffix).not.toContain('(none')
  })
})
