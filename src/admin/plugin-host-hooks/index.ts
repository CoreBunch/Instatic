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
 * mount time through the host's import map.
 *
 * Permission-gated hooks resolve the calling plugin from `PluginContext`
 * (populated per-mount by `PluginEditorPanel`, `PluginPageRenderer`, and
 * `PluginCanvasOverlayLayer`) and throw when the operator did not grant
 * the required permission: `useEditorStore` requires `editor.store.read`.
 * There is NO write-capable store accessor in this package — editor-store
 * mutations go through `api.editor.store.transaction` in the plugin's
 * editor entrypoint, which enforces `editor.store.write`.
 */
import { use, useEffect, useState } from 'react'
import { useEditorStore as useHostEditorStore } from '@site/store/store'
import { findRenderedCanvasNodes, type RenderedCanvasNode } from '@site/canvas/canvasNodeLookup'
import { measureCanvasElementRect } from '@site/canvas/canvasOverlayGeometry'
import type { EditorStore } from '@site/store/types'
import type { PluginPermission } from '@core/plugin-sdk'
import { PluginContext, type PluginContextValue } from './pluginContext'

/** Marker attribute the host puts on the canvas overlay layer host element. */
export const CANVAS_OVERLAY_LAYER_ATTRIBUTE = 'data-canvas-overlay-layer'

/**
 * Throw a precise, plugin-attributed error when a permission-gated hook is
 * used without the matching grant (or outside any plugin surface).
 */
function assertHookPermission(
  ctx: PluginContextValue,
  permission: PluginPermission,
  hookName: string,
): void {
  if (!ctx.pluginId) {
    throw new Error(`${hookName} called outside a plugin surface`)
  }
  if (!ctx.grantedPermissions.includes(permission)) {
    throw new Error(
      `[plugin:${ctx.pluginId}] ${hookName} requires the "${permission}" permission, which is not granted.`,
    )
  }
}

/**
 * Subscribe to a slice of the editor store. Same selector signature as the
 * underlying Zustand hook — pass a function that picks the slice you want
 * to react to (or no selector for the full state). Returns `undefined`
 * slices outside an editor surface (admin pages don't have an editor
 * mounted, so the underlying store is empty there).
 *
 * Requires the `editor.store.read` permission — throws (caught by the
 * surface's ErrorBoundary) when the grant is missing. Unlike the host's
 * internal store hook, this wrapper deliberately does NOT expose
 * `getState` / `setState` / `subscribe`: reads go through the selector,
 * writes go through `api.editor.store.transaction` (gated by
 * `editor.store.write`).
 */
export function useEditorStore(): EditorStore
export function useEditorStore<T>(selector: (state: EditorStore) => T): T
export function useEditorStore<T>(selector?: (state: EditorStore) => T): T | EditorStore {
  const ctx = use(PluginContext)
  assertHookPermission(ctx, 'editor.store.read', 'useEditorStore')
  const select: (state: EditorStore) => T | EditorStore =
    selector ?? ((state: EditorStore) => state)
  return useHostEditorStore(select)
}

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

function findCanvasNode(nodeId: string): RenderedCanvasNode | null {
  if (typeof document === 'undefined') return null
  // Canvas nodes render exclusively inside the per-breakpoint canvas iframes —
  // the admin document's `data-node-id` carriers (layers-tree rows, overlay
  // rings, import previews) are chrome, not the node. The node typically
  // renders once per breakpoint frame; pick the first VISIBLE one, like the
  // host's selection overlay does.
  const candidates = findRenderedCanvasNodes(nodeId)
  for (const candidate of candidates) {
    const rect = candidate.element.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return candidate
  }
  return candidates[0] ?? null
}

/**
 * Live `CanvasNodeRect` for a rendered node. Re-measured every animation
 * frame while a node id is set (state only updates when the rect changes),
 * which uniformly covers layout changes, canvas pan/zoom, and breakpoint
 * frame remounts.
 *
 *   const rect = useCanvasNodeRect(useEditorStore((s) => s.selectedNodeId))
 *   if (!rect) return null
 *   return <div style={{ position: 'absolute', top: rect.top, left: rect.left }}>...</div>
 */
export function useCanvasNodeRect(nodeId: string | null): CanvasNodeRect | null {
  const [rect, setRect] = useState<CanvasNodeRect | null>(null)

  useEffect(() => {
    // External-system synchronization (DOM geometry → React state): the
    // setState calls inside `measure` are the whole point of this hook.
    function measure() {
      if (!nodeId) {
        setRect((prev) => (prev === null ? prev : null))
        return
      }
      const layer = findCanvasOverlayLayer()
      const node = findCanvasNode(nodeId)
      // The node lives inside a per-breakpoint canvas iframe; its rects are
      // in the IFRAME's coordinate space. `measureCanvasElementRect` recovers
      // the canvas zoom from the iframe element, translates into editor
      // coordinates, and makes the result relative to the overlay layer.
      const measured = node && layer
        ? measureCanvasElementRect(node.element, node.frame, layer)
        : null
      if (!measured) {
        setRect((prev) => (prev === null ? prev : null))
        return
      }
      const next: CanvasNodeRect = {
        top: measured.y,
        left: measured.x,
        width: measured.width,
        height: measured.height,
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

    // Re-measure every animation frame while mounted — the same pattern the
    // host's selection rings use. ResizeObserver can't track elements inside
    // the canvas iframes from this realm, and the transform layer mutates
    // pan/zoom styles without React re-renders; a cheap rect read per frame
    // (state only updates when the rect actually changes) covers layout,
    // content, pan, zoom, and iframe remounts uniformly.
    let frameHandle = 0
    const tick = () => {
      measure()
      frameHandle = requestAnimationFrame(tick)
    }
    frameHandle = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameHandle)
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
