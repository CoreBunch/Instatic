import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { contextMcpTools } from '../../../server/ai/mcp/tools/contextTool'
import type { ToolContext } from '../../../server/ai/runtime/types'

function ctxFor(harness: CapabilityTestHarness): ToolContext {
  return {
    db: harness.db,
    userId: 'no-editor-user',
    capabilities: ['site.read'],
    scope: 'site',
    conversationId: 'test',
    snapshot: null,
    signal: new AbortController().signal,
  }
}

const getContext = contextMcpTools.find((t) => t.name === 'get_context')!

describe('get_context', () => {
  let harness: CapabilityTestHarness
  let originalError: typeof console.error
  beforeEach(async () => {
    originalError = console.error
    console.error = () => {}
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
  })
  afterEach(() => { console.error = originalError })

  it('reports editor disconnected when no bridge is open and lists templates', async () => {
    const out = (await getContext.handler!({}, ctxFor(harness))) as {
      editor: { connected: boolean }
      templates: unknown[]
      site: { name: string } | null
    }
    expect(out.editor.connected).toBe(false) // no editor bridge registered for this user
    expect(Array.isArray(out.templates)).toBe(true)
    expect(out.site).not.toBeNull()
  })

  it('surfaces an everywhere template as wrapping a page', async () => {
    const cells = JSON.stringify({
      title: 'Shell', slug: 'shell',
      body: { rootNodeId: 'r', nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] } } },
      templateEnabled: true,
      templateTarget: { kind: 'everywhere' },
      templatePriority: 10,
    })
    await harness.db`insert into data_rows (id, table_id, cells_json, slug, status)
                     values ('tpl1', 'pages', ${cells}, 'shell', 'draft')`
    const pageCells = JSON.stringify({ title: 'Home', slug: 'home', body: { rootNodeId: 'r', nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] } } } })
    await harness.db`insert into data_rows (id, table_id, cells_json, slug, status)
                     values ('home1', 'pages', ${pageCells}, 'home', 'draft')`

    const out = (await getContext.handler!({ entryId: 'home1' }, ctxFor(harness))) as {
      templates: Array<{ target: string; title: string }>
      page: { found: boolean; wrappedByTemplates: string[] }
    }
    expect(out.templates.some((t) => t.target === 'everywhere')).toBe(true)
    expect(out.page.found).toBe(true)
    expect(out.page.wrappedByTemplates).toContain('Shell')
  })
})
