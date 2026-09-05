/**
 * #490 — what the HTML tools say about markup they could not keep.
 *
 * Two silent outcomes were reported: `site_replace_node_html` dropped a
 * `<script>` with no trace in the result, and a head-only payload (a bare
 * `<link rel="icon">`) came back as "no importable elements" without naming
 * the element. Both tools now report stripped and ignored constructs, as
 * `warnings` on success and inside the error when nothing was importable.
 */
import { describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { executeAgentTool } from '@site/agent'
import '@modules/base'

function freshRoot(): string {
  useEditorStore.setState({ site: null })
  const site = useEditorStore.getState().createSite('Test')
  return site.pages[0].rootNodeId
}

// The browser parser moves a bare top-level <link> into <head>; the test
// polyfill only does so for an explicit document, so spell the head out.
const HEAD_ONLY = '<html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg"></head><body></body></html>'

describe('HTML tool import notices', () => {
  it('insertHtml names the head-only element instead of a bare "no importable elements"', async () => {
    const result = await executeAgentTool('site_insert_html', { parentId: freshRoot(), html: HEAD_ONLY })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no importable elements')
    expect(result.error).toContain('<link>')
    expect(result.error).toContain('<head>')
  })

  it('replaceNodeHtml reports a stripped <script> as a warning while still inserting the rest', async () => {
    const rootId = freshRoot()
    const wrapper = await executeAgentTool('site_insert_html', { parentId: rootId, html: '<div></div>' })
    const wrapperId = (wrapper.data as { nodeIds: string[] }).nodeIds[0]

    const result = await executeAgentTool('site_replace_node_html', {
      nodeId: wrapperId,
      html: '<section><h1>Hi</h1><script>console.log(1)</script></section>',
    })
    expect(result.ok).toBe(true)
    const data = result.data as { nodeIds: string[]; warnings?: string[] }
    expect(data.nodeIds).toHaveLength(1)
    expect(data.warnings).toHaveLength(1)
    expect(data.warnings?.[0]).toContain('1 <script> element')
    expect(data.warnings?.[0]).toContain('site_write_code_asset')
  })

  it('insertHtml reports stripped inline handlers and ignored head elements alongside inserted nodes', async () => {
    const result = await executeAgentTool('site_insert_html', {
      parentId: freshRoot(),
      html: '<html><head><meta name="description" content="x"><title>T</title></head>'
        + '<body><button onclick="go()">Go</button></body></html>',
    })
    expect(result.ok).toBe(true)
    const data = result.data as { warnings?: string[] }
    expect(data.warnings).toHaveLength(2)
    expect(data.warnings?.[0]).toContain('1 inline event handler attribute')
    expect(data.warnings?.[1]).toContain('<meta>, <title>')
  })

  it('stays silent when nothing was dropped', async () => {
    const result = await executeAgentTool('site_insert_html', {
      parentId: freshRoot(),
      html: '<section><p>Plain</p></section>',
    })
    expect(result.ok).toBe(true)
    expect((result.data as { warnings?: string[] }).warnings).toBeUndefined()
  })
})
