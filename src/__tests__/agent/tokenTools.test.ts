/**
 * Browser-side executor tests for the design-system token write tools:
 * set_color_tokens, set_font_tokens, set_type_scale, set_spacing_scale.
 *
 * These give the agent a design-system-first workflow: establish tokens, then
 * reference them. Each tool is create-or-update (keyed by slug / variable /
 * group) so re-runs patch in place rather than duplicating. set_font_tokens can
 * install a Google web font via the server `/fonts/install` endpoint — exercised
 * here with a mocked `fetch`.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { executeAgentTool } from '@site/agent'
import type { AiToolOutput } from '@core/ai'
import type { FontEntry } from '@core/fonts'
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
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    hasUnsavedChanges: false,
  })
  useEditorStore.getState().createSite('Test')
  return useEditorStore.getState()
}

function expectData<T extends Record<string, unknown>>(result: AiToolOutput): T {
  expect(result.ok).toBe(true)
  expect(result.error).toBeUndefined()
  expect(result.data && typeof result.data === 'object').toBe(true)
  return result.data as T
}

function site() {
  return useEditorStore.getState().site!
}

// ---------------------------------------------------------------------------
// set_color_tokens
// ---------------------------------------------------------------------------

describe('executeAgentTool — set_color_tokens', () => {
  it('creates color tokens on an empty site (no framework yet)', async () => {
    freshStore()
    expect(site().settings.framework).toBeUndefined()

    const result = await executeAgentTool('site_set_color_tokens', {
      tokens: [
        { slug: 'primary', lightValue: '#3b82f6' },
        { slug: 'ink', lightValue: '#0a0a0a', category: 'Neutrals' },
      ],
    })

    const { tokens } = expectData<{ tokens: Array<{ slug: string; ref: string; action: string }> }>(result)
    expect(tokens.map((t) => t.action)).toEqual(['created', 'created'])
    expect(tokens.find((t) => t.slug === 'primary')!.ref).toBe('var(--primary)')

    const stored = site().settings.framework!.colors.tokens
    expect(stored.map((t) => t.slug).sort()).toEqual(['ink', 'primary'])
    expect(stored.find((t) => t.slug === 'primary')!.lightValue).toBe('#3b82f6')
  })

  it('updates an existing token by slug instead of duplicating it', async () => {
    freshStore()
    await executeAgentTool('site_set_color_tokens', { tokens: [{ slug: 'primary', lightValue: '#3b82f6' }] })

    const result = await executeAgentTool('site_set_color_tokens', {
      tokens: [{ slug: 'primary', lightValue: '#ef4444' }],
    })
    const { tokens } = expectData<{ tokens: Array<{ action: string }> }>(result)
    expect(tokens[0].action).toBe('updated')

    const stored = site().settings.framework!.colors.tokens
    expect(stored).toHaveLength(1)
    expect(stored[0].lightValue).toBe('#ef4444')
  })

  it('fails schema validation with an empty tokens array', async () => {
    freshStore()
    const result = await executeAgentTool('site_set_color_tokens', { tokens: [] })
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// set_type_scale
// ---------------------------------------------------------------------------

describe('executeAgentTool — set_type_scale', () => {
  it('creates a typography group on an empty site and reports generated vars', async () => {
    freshStore()
    const result = await executeAgentTool('site_set_type_scale', {
      namingConvention: 'text',
      steps: 's,m,l,xl',
      min: { fontSize: 16, scaleRatio: 1.2 },
      max: { fontSize: 18, scaleRatio: 1.333 },
    })

    const data = expectData<{ action: string; namingConvention: string; generatedVars: string[] }>(result)
    expect(data.action).toBe('created')
    expect(data.namingConvention).toBe('text')
    expect(data.generatedVars).toEqual(['--text-s', '--text-m', '--text-l', '--text-xl'])

    const groups = site().settings.framework!.typography!.groups
    expect(groups).toHaveLength(1)
    expect(groups[0].steps).toBe('s,m,l,xl')
    expect(groups[0].min.fontSize).toBe(16)
    expect(groups[0].max.scaleRatio).toBe(1.333)
  })

  it('updates the existing group on a second call (no new group)', async () => {
    freshStore()
    await executeAgentTool('site_set_type_scale', { steps: 's,m,l' })
    const result = await executeAgentTool('site_set_type_scale', { min: { fontSize: 20 } })

    const data = expectData<{ action: string }>(result)
    expect(data.action).toBe('updated')
    const groups = site().settings.framework!.typography!.groups
    expect(groups).toHaveLength(1)
    expect(groups[0].min.fontSize).toBe(20)
    // The earlier `steps` patch is preserved across the update.
    expect(groups[0].steps).toBe('s,m,l')
  })

  it('errors when groupId targets a non-existent group', async () => {
    freshStore()
    const result = await executeAgentTool('site_set_type_scale', { groupId: 'nope', steps: 's,m' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// set_spacing_scale
// ---------------------------------------------------------------------------

describe('executeAgentTool — set_spacing_scale', () => {
  it('creates a spacing group and reports --space-* vars', async () => {
    freshStore()
    const result = await executeAgentTool('site_set_spacing_scale', {
      namingConvention: 'space',
      steps: 'xs,s,m,l',
      min: { size: 4, scaleRatio: 1.25 },
      max: { size: 6, scaleRatio: 1.414 },
    })

    const data = expectData<{ action: string; generatedVars: string[] }>(result)
    expect(data.action).toBe('created')
    expect(data.generatedVars).toEqual(['--space-xs', '--space-s', '--space-m', '--space-l'])

    const groups = site().settings.framework!.spacing!.groups
    expect(groups).toHaveLength(1)
    expect(groups[0].min.size).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// set_font_tokens
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function mockInstallFetch(entry: FontEntry): void {
  // @ts-expect-error — test seam: replace the global fetch with a stub.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ font: entry }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
}

function mockFailingFetch(message: string): void {
  // @ts-expect-error — test seam.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
}

describe('executeAgentTool — set_font_tokens', () => {
  it('creates a fallback-only token with no install', async () => {
    freshStore()
    const result = await executeAgentTool('site_set_font_tokens', {
      tokens: [{ name: 'Body', variable: 'font-body', fallback: 'sans-serif' }],
    })

    const { tokens } = expectData<{ tokens: Array<{ variable: string; ref: string; action: string }> }>(result)
    expect(tokens[0].variable).toBe('font-body')
    expect(tokens[0].ref).toBe('var(--font-body)')
    expect(tokens[0].action).toBe('created')

    const stored = site().settings.fonts!.tokens!
    expect(stored).toHaveLength(1)
    expect(stored[0].familyId).toBeUndefined()
  })

  it('installs a Google web font and binds the token to it', async () => {
    freshStore()
    const entry: FontEntry = {
      id: 'font_inter',
      source: 'google',
      family: 'Inter',
      variants: ['400', '700'],
      subsets: ['latin'],
      files: [
        { variant: '400', subset: 'latin', path: 'https://fonts.example/inter-400.woff2', format: 'woff2' },
      ],
      createdAt: 1,
      updatedAt: 1,
    }
    mockInstallFetch(entry)

    const result = await executeAgentTool('site_set_font_tokens', {
      tokens: [{ name: 'Heading', variable: 'font-heading', googleFamily: 'Inter' }],
    })

    const { tokens } = expectData<{ tokens: Array<{ installed?: string; action: string }> }>(result)
    expect(tokens[0].installed).toBe('Inter')

    const fonts = site().settings.fonts!
    expect(fonts.items.find((f) => f.family === 'Inter')).toBeDefined()
    const token = fonts.tokens!.find((t) => t.variable === 'font-heading')!
    expect(token.familyId).toBe('font_inter')
  })

  it('rejects a token that sets both googleFamily and familyId', async () => {
    freshStore()
    const result = await executeAgentTool('site_set_font_tokens', {
      tokens: [{ name: 'X', googleFamily: 'Inter', familyId: 'font_x' }],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mutually exclusive')
  })

  it('surfaces an install failure as a recoverable tool error', async () => {
    freshStore()
    mockFailingFetch('Unknown font family')
    const result = await executeAgentTool('site_set_font_tokens', {
      tokens: [{ name: 'Heading', googleFamily: 'NotARealFont' }],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown font family')
    // No token created on failure.
    expect(site().settings.fonts?.tokens ?? []).toHaveLength(0)
  })
})
