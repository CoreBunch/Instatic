import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { contextMcpTools } from '../../../server/ai/mcp/tools/contextTool'
import { createEditorBridgeStream } from '../../../server/ai/mcp/editorBridge'
import { resolveBridgeToolResult } from '../../../server/ai/runtime'
import type { ToolContext } from '../../../server/ai/runtime/types'
import { MCP_BRIDGE_PING_TOOL } from '@core/ai'

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
      editor: { siteConnected: boolean; contentConnected: boolean }
      templates: unknown[]
      site: { name: string } | null
    }
    expect(out.editor.siteConnected).toBe(false)
    expect(out.editor.contentConnected).toBe(false)
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

  it('reports Site and Content workspace connections independently, from a live probe', async () => {
    const siteCtrl = new AbortController()
    const contentCtrl = new AbortController()
    const stopSite = answerPings(createEditorBridgeStream('no-editor-user', 'site', siteCtrl.signal))

    try {
      const siteOnly = (await getContext.handler!({}, ctxFor(harness))) as {
        editor: { siteConnected: boolean; contentConnected: boolean; unresponsive: string[] }
      }
      expect(siteOnly.editor).toEqual({
        siteConnected: true,
        contentConnected: false,
        unresponsive: [],
      })

      const stopContent = answerPings(createEditorBridgeStream('no-editor-user', 'content', contentCtrl.signal))
      try {
        const both = (await getContext.handler!({}, ctxFor(harness))) as {
          editor: { siteConnected: boolean; contentConnected: boolean; unresponsive: string[] }
        }
        expect(both.editor).toEqual({
          siteConnected: true,
          contentConnected: true,
          unresponsive: [],
        })
      } finally {
        stopContent()
      }
    } finally {
      stopSite()
      siteCtrl.abort()
      contentCtrl.abort()
    }
  })

  // #490: a registered stream whose tab no longer answers used to read as
  // connected for as long as the idle lease kept its entry, while every
  // relayed tool timed out. It must read as unresponsive instead.
  it('reports a registered workspace that does not answer as unresponsive, not connected', async () => {
    const siteCtrl = new AbortController()
    // Nothing reads or answers this stream — the tab is stuck.
    createEditorBridgeStream('no-editor-user', 'site', siteCtrl.signal)
    try {
      const out = (await getContext.handler!({}, ctxFor(harness))) as {
        editor: { siteConnected: boolean; contentConnected: boolean; unresponsive: string[] }
      }
      expect(out.editor).toEqual({
        siteConnected: false,
        contentConnected: false,
        unresponsive: ['site'],
      })
    } finally {
      siteCtrl.abort()
    }
  }, 10_000)
})

/**
 * Consume a bridge stream the way an open workspace does and answer liveness
 * probes, so the probe round-trip is real. Returns a stop function.
 */
function answerPings(stream: ReadableStream<Uint8Array>): () => void {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bridgeId = ''
  let stopped = false
  void (async () => {
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || stopped) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const event = JSON.parse(trimmed) as { type: string; bridgeId?: string; requestId?: string; toolName?: string }
          if (event.type === 'bridgeReady') bridgeId = event.bridgeId ?? ''
          if (event.type === 'toolRequest' && event.toolName === MCP_BRIDGE_PING_TOOL) {
            resolveBridgeToolResult(bridgeId, event.requestId ?? '', { ok: true, data: { alive: true } })
          }
        }
      }
    } catch {
      /* torn down by the test */
    }
  })()
  return () => {
    stopped = true
    reader.cancel().catch(() => {})
  }
}
