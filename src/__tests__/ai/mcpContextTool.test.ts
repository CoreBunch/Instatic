import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { contextMcpTools } from '../../../server/ai/mcp/tools/contextTool'
import { createEditorBridgeStream } from '../../../server/ai/mcp/editorBridge'
import { createDataRow } from '../../../server/repositories/data'
import { getDefaultLocale, createLocale } from '../../../server/repositories/localization'
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
  afterEach(async () => {
    console.error = originalError
    await harness.cleanup()
  })

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
    const cells = {
      title: 'Shell', slug: 'shell',
      body: { rootNodeId: 'r', nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] } } },
      templateEnabled: true,
      templateTarget: { kind: 'everywhere' },
      templatePriority: 10,
    }
    await createDataRow(harness.db, { id: 'tpl1', tableId: 'pages', slug: 'shell', cells })
    const pageCells = { title: 'Home', slug: 'home', body: { rootNodeId: 'r', nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] } } } }
    await createDataRow(harness.db, { id: 'home1', tableId: 'pages', slug: 'home', cells: pageCells })

    const out = (await getContext.handler!({ entryId: 'home1' }, ctxFor(harness))) as {
      templates: Array<{ target: string; title: string }>
      page: { found: boolean; wrappedByTemplates: string[] }
    }
    expect(out.templates.some((t) => t.target === 'everywhere')).toBe(true)
    expect(out.page.found).toBe(true)
    expect(out.page.wrappedByTemplates).toContain('Shell')
  })

  it('reports Site and Content workspace connections independently', async () => {
    const siteCtrl = new AbortController()
    const contentCtrl = new AbortController()
    const source = await getDefaultLocale(harness.db)
    const german = await createLocale(harness.db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', direction: 'ltr', enabled: true })
    createEditorBridgeStream('no-editor-user', 'site', siteCtrl.signal, undefined, source.id)

    try {
      const siteOnly = (await getContext.handler!({}, ctxFor(harness))) as {
        editor: { siteConnected: boolean; contentConnected: boolean }
      }
      expect(siteOnly.editor).toEqual({
        siteConnected: true,
        contentConnected: false,
        siteLocaleId: source.id,
        contentLocaleId: null,
      })

      createEditorBridgeStream('no-editor-user', 'content', contentCtrl.signal, undefined, german.id)
      const both = (await getContext.handler!({}, ctxFor(harness))) as {
        editor: { siteConnected: boolean; contentConnected: boolean }
      }
      expect(both.editor).toEqual({
        siteConnected: true,
        contentConnected: true,
        siteLocaleId: source.id,
        contentLocaleId: german.id,
      })
    } finally {
      siteCtrl.abort()
      contentCtrl.abort()
    }
  })
})
