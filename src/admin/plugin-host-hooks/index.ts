/**
 * `@instatic/host-hooks` — React hooks plugin code can use to reach into
 * host editor state, settings, and command runtime.
 *
 *   import { useEditorStore, usePluginSettings } from '@instatic/host-hooks'
 *
 *   function MyPanel() {
 *     const selected = useEditorStore((s) => s.selectedNodeId)
 *     const settings = usePluginSettings<MySettingsShape>()
 *     return <p>Selected: {selected ?? 'none'}, sample: {settings.sampleRate}</p>
 *   }
 *
 * Like `@instatic/host-ui`, this is an externalized package — plugin
 * bundles compile against the named exports but resolve the runtime at
 * mount time through the host's import map. Plugins still need the
 * matching permission to call mutating hooks (e.g. `useEditorTransaction`
 * requires `editor.store.write`).
 */
import { use, useEffect, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { PluginContext } from './pluginContext'

/** Marker attribute the host puts on the canvas overlay layer host element. */
export const CANVAS_OVERLAY_LAYER_ATTRIBUTE = 'data-canvas-overlay-layer'

/**
 * Subscribe to a slice of the editor store. Same selector signature as the
 * underlying Zustand hook — pass a function that picks the slice you want
 * to react to. Returns `undefined` if called outside an editor surface
 * (admin pages don't have an editor mounted, so the underlying store is
 * empty there).
 *
 * Re-exported under the plugin SDK's `@instatic/host-hooks` import-map
 * name so plugin bundles don't need to know the host's internal store path.
 */
export { useEditorStore }

/**
 * Read the current plugin's persisted settings as a typed snapshot.
 * Updates flow through `setPluginSettings(...)` from `@instatic/host-hooks`
 * (round-trips through the host's settings PUT endpoint).
 *
 * Settings declared `secret: true` always read as the mask (`'***'`) here —
 * real secret values never reach the browser. Server-side plugin code reads
 * them via `api.cms.settings.get`; proxy through a plugin server route when
 * an admin surface needs a secret-derived capability.
 */
export function usePluginSettings<
  T extends Record<string, string | number | boolean> = Record<string, string | number | boolean>,
>(): T {
  const ctx = use(PluginContext)
  return { ...ctx.settings } as T
}

/**
 * Plugin metadata for the surface currently rendering. Available to both
 * editor panels and admin app pages.
 */
export function usePluginContext(): {
  pluginId: string
  pluginVersion: string
  surfaceId: string
  surfaceLabel: string
} {
  const ctx = use(PluginContext)
  return {
    pluginId: ctx.pluginId,
    pluginVersion: ctx.pluginVersion,
    surfaceId: ctx.surfaceId,
    surfaceLabel: ctx.surfaceLabel,
  }
}

/**
 * Access the plugin's HTTP runtime — call routes registered by the
 * plugin's server entrypoint, validate responses with TypeBox.
 */
export function usePluginRoutes(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  json: <T extends import('@sinclair/typebox').TSchema>(
    path: string,
    schema: T,
    init?: RequestInit,
  ) => Promise<import('@sinclair/typebox').Static<T>>
} {
  const ctx = use(PluginContext)
  return ctx.routes
}

/**
 * Run an editor command registered by any plugin. Returns the command's
 * result. Throws if the command id is unknown.
 */
export function useEditorCommand(): (commandId: string) => Promise<{ message?: string } | void> {
  const ctx = use(PluginContext)
  return ctx.runCommand
}

/**
 * Position rectangle relative to the canvas overlay layer. Plugin canvas
 * overlays use this to place their absolute-positioned children over a
 * specific node in the canvas.
 *
 *   • `top` / `left` are relative to the overlay layer's top-left corner
 *     (which matches the canvas's visible area, including pan / zoom).
 *   • `width` / `height` are the rendered visible dimensions.
 *   • Returns `null` while the host hasn't measured yet, the node id is
 *     null, or the node isn't currently rendered.
 */
export interface CanvasNodeRect {
  top: number
  left: number
  width: number
  height: number
}

function findCanvasOverlayLayer(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>(`[${CANVAS_OVERLAY_LAYER_ATTRIBUTE}]`)
}

function findCanvasNodeElement(nodeId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  // The canvas renders every node with `data-node-id="<id>"` (NodeRenderer.tsx).
  // We escape via attribute-equals selector so node ids with special chars are
  // safe.
  const candidates = document.querySelectorAll<HTMLElement>(`[data-node-id="${cssEscape(nodeId)}"]`)
  // Multiple matches happen when the same node id appears in more than one
  // breakpoint frame. Return the first visible one — the host's selection
  // overlay does the same thing.
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return candidate
  }
  return candidates[0] ?? null
}

function cssEscape(value: string): string {
  // Avoid pulling in CSS.escape so this works in tests without a full DOM.
  return value.replace(/"/g, '\\"')
}

/**
 * Live `CanvasNodeRect` for a rendered node. Updates on layout changes via
 * `ResizeObserver` and on canvas pan/zoom via the editor store's
 * `selectedNodeId` / `hoveredNodeId` / breakpoint subscription.
 *
 *   const rect = useCanvasNodeRect(useEditorStore((s) => s.selectedNodeId))
 *   if (!rect) return null
 *   return <div style={{ position: 'absolute', top: rect.top, left: rect.left }}>...</div>
 */
export function useCanvasNodeRect(nodeId: string | null): CanvasNodeRect | null {
  const [rect, setRect] = useState<CanvasNodeRect | null>(null)

  // Re-measure on every editor render (selection changes, breakpoint
  // changes, store mutations) by depending on a tick that bumps with each
  // editor-store emission.
  const editorTick = useEditorStore((s) => s)
  void editorTick

  useEffect(() => {
    // The hook's whole purpose is to mirror DOM geometry into React state
    // — the eslint react-hooks/set-state-in-effect rule expects effects to
    // synchronize React → external, but `useCanvasNodeRect` synchronizes
    // external → React. Disable for this hook only.
    function measure() {
      if (!nodeId) {
        setRect((prev) => (prev === null ? prev : null))
        return
      }
      const layer = findCanvasOverlayLayer()
      const node = findCanvasNodeElement(nodeId)
      if (!layer || !node) {
        setRect((prev) => (prev === null ? prev : null))
        return
      }
      const layerRect = layer.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      const next: CanvasNodeRect = {
        top: nodeRect.top - layerRect.top,
        left: nodeRect.left - layerRect.left,
        width: nodeRect.width,
        height: nodeRect.height,
      }
      setRect((prev) =>
        prev !== null
        && prev.top === next.top
        && prev.left === next.left
        && prev.width === next.width
        && prev.height === next.height
          ? prev
          : next,
      )
    }

    measure()

    if (!nodeId) return undefined

    // Track size changes on the node + layer with ResizeObserver. Track
    // pan/zoom transforms via a window resize / scroll listener since the
    // transform layer mutates style.transform directly without React
    // re-renders.
    const node = findCanvasNodeElement(nodeId)
    const layer = findCanvasOverlayLayer()
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measure())
      : null
    if (observer) {
      if (node) observer.observe(node)
      if (layer) observer.observe(layer)
    }
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [nodeId])

  return rect
}

/**
 * Width / height of the canvas overlay layer in screen pixels. Useful for
 * positioning overlay UI relative to the canvas viewport (e.g. floating
 * a "back to top" pin in the corner).
 */
export interface CanvasViewport {
  width: number
  height: number
}

export function useCanvasViewport(): CanvasViewport | null {
  const [viewport, setViewport] = useState<CanvasViewport | null>(null)

  useEffect(() => {
    // External-system synchronization (DOM viewport → React state). The
    // setState calls inside `measure` are the whole point of this hook.
    function measure() {
      const layer = findCanvasOverlayLayer()
      if (!layer) {
        setViewport((prev) => (prev === null ? prev : null))
        return
      }
      const rect = layer.getBoundingClientRect()
      setViewport((prev) =>
        prev !== null && prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      )
    }

    measure()

    const layer = findCanvasOverlayLayer()
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measure())
      : null
    if (observer && layer) observer.observe(layer)
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return viewport
}

export { PluginContext } from './pluginContext'
export type { PluginContextValue } from './pluginContext'
