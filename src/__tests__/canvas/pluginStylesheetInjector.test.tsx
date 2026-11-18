/**
 * PluginStylesheetInjector — plugin stylesheets reach the canvas document in
 * the author-CSS cascade layer, ordered around the site's own style tags, and
 * follow plugin changes without a reload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { PluginStylesheetInjector } from '@admin/pages/site/canvas/PluginStylesheetInjector'
import { notifyCmsPluginsChanged } from '@admin/pages/plugins/utils/pluginEvents'
import type { CanvasPluginStylesheet } from '@core/plugins/canvasStylesheets'

const originalFetch = globalThis.fetch
let served: CanvasPluginStylesheet[] = []
let requests: string[] = []

function pluginStyles(): HTMLStyleElement[] {
  return [...document.head.querySelectorAll<HTMLStyleElement>('style[data-source="PluginStylesheetInjector"]')]
}

beforeEach(() => {
  served = []
  requests = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input instanceof Request ? input.url : input))
    return new Response(JSON.stringify({ stylesheets: served }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  document.head.innerHTML = ''
})

describe('PluginStylesheetInjector', () => {
  it('injects plugin CSS in the author layer, ordered around the site styles', async () => {
    const siteStyles = document.createElement('style')
    siteStyles.id = 'mc-user-styles'
    document.head.appendChild(siteStyles)
    served = [
      { pluginId: 'acme.first', position: 'before-site', css: '.reset { margin: 0; }' },
      { pluginId: 'acme.theme', position: 'after-site', css: '.hero { min-height: 100vh; }', media: 'screen' },
    ]

    render(<PluginStylesheetInjector targetDocument={document} viewport={{ width: 1440, height: 900 }} />)

    await waitFor(() => expect(pluginStyles()).toHaveLength(2))
    expect(requests).toEqual(['/admin/api/cms/runtime/canvas-stylesheets'])
    // Other suites can leave their own tags in the shared test document's head;
    // only the site style tag and the plugin tags matter for ordering.
    const ordered = [...document.head.querySelectorAll('#mc-user-styles, style[data-plugin-id]')]
    expect(ordered.map((el) => el.getAttribute('data-plugin-id') ?? el.id)).toEqual([
      'acme.first',
      'mc-user-styles',
      'acme.theme',
    ])
    const [before, after] = pluginStyles()
    expect(before?.textContent).toBe('@layer user-authored {\n.reset { margin: 0; }\n}')
    // Viewport units are pinned to the frame viewport, like the site's own CSS.
    expect(after?.textContent).toBe('@layer user-authored {\n.hero { min-height: 900px; }\n}')
    expect(after?.media).toBe('screen')
    // Styles only: the injector never creates a script or link element.
    expect(document.head.querySelector('script, link')).toBeNull()
  })

  it('keeps its tags when re-rendered with an equal but new viewport object', async () => {
    served = [{ pluginId: 'acme.theme', position: 'after-site', css: '.hero { min-height: 100vh; }' }]
    const view = render(<PluginStylesheetInjector targetDocument={document} viewport={{ width: 1440, height: 900 }} />)
    await waitFor(() => expect(pluginStyles()).toHaveLength(1))
    const [mounted] = pluginStyles()

    view.rerender(<PluginStylesheetInjector targetDocument={document} viewport={{ width: 1440, height: 900 }} />)
    expect(pluginStyles()).toHaveLength(1)
    expect(pluginStyles()[0]).toBe(mounted!)

    // A real viewport change still re-resolves the units.
    view.rerender(<PluginStylesheetInjector targetDocument={document} viewport={{ width: 1440, height: 600 }} />)
    expect(pluginStyles()[0]?.textContent).toBe('@layer user-authored {\n.hero { min-height: 600px; }\n}')
  })

  it('reloads when plugins change and removes its tags on unmount', async () => {
    served = [{ pluginId: 'acme.theme', position: 'after-site', css: 'p { color: red; }' }]
    const view = render(<PluginStylesheetInjector targetDocument={document} />)
    await waitFor(() => expect(pluginStyles()).toHaveLength(1))

    // Plugin disabled: the next plan is empty and the canvas drops the style.
    served = []
    act(() => notifyCmsPluginsChanged())
    await waitFor(() => expect(pluginStyles()).toHaveLength(0))

    served = [{ pluginId: 'acme.theme', position: 'after-site', css: 'p { color: blue; }' }]
    act(() => notifyCmsPluginsChanged())
    await waitFor(() => expect(pluginStyles()[0]?.textContent).toContain('color: blue'))

    view.unmount()
    expect(pluginStyles()).toHaveLength(0)
  })
})
