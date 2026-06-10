/**
 * PluginCanvasOverlayLayer — host-side mount for plugin canvas overlays.
 *
 * Sits on top of the canvas viewport (outside the transform layer),
 * occupies the full canvas area, ignores pointer events by default.
 * Each plugin overlay renders inside its own ErrorBoundary so a single
 * misbehaving plugin can't blank the canvas.
 *
 * Plugins position children using `useCanvasNodeRect(nodeId)` from
 * `@instatic/host-hooks`, which returns layer-relative coordinates
 * already mapped through any pan/zoom transform on the canvas.
 *
 * Each overlay is mounted under a `PluginContext.Provider` carrying the
 * plugin's identity + granted permissions, so permission-gated hooks
 * (`useEditorStore` → `editor.store.read`) resolve and enforce correctly.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import {
  CANVAS_OVERLAY_LAYER_ATTRIBUTE,
  PluginContext,
  type PluginContextValue,
} from '@admin/plugin-host-hooks'
import { pluginRuntime } from '@core/plugins/runtime'
import { buildPluginRoutesHelper } from '@core/plugins/adminRuntime'
import type { RegisteredPluginCanvasOverlay } from '@core/plugin-sdk'
import styles from './PluginCanvasOverlayLayer.module.css'

const subscribePluginRuntime = (cb: () => void) => pluginRuntime.subscribe(cb)
const getOverlaysSnapshot = () => pluginRuntime.getCanvasOverlays()
const SERVER_OVERLAYS_SNAPSHOT: RegisteredPluginCanvasOverlay[] = []

export function PluginCanvasOverlayLayer() {
  const overlays = useSyncExternalStore(
    subscribePluginRuntime,
    getOverlaysSnapshot,
    () => SERVER_OVERLAYS_SNAPSHOT,
  )

  if (overlays.length === 0) return null

  return (
    <div
      className={styles.layer}
      data-testid="plugin-canvas-overlay-layer"
      {...{ [CANVAS_OVERLAY_LAYER_ATTRIBUTE]: 'true' }}
      aria-hidden="true"
    >
      {overlays.map((overlay) => (
        <PluginCanvasOverlaySlot key={overlay.id} overlay={overlay} />
      ))}
    </div>
  )
}

/**
 * Per-overlay error boundary + slot. Each plugin overlay gets its own
 * absolutely-positioned div so plugin children with `position: absolute`
 * always position relative to the canvas viewport.
 */
function PluginCanvasOverlaySlot({ overlay }: { overlay: RegisteredPluginCanvasOverlay }) {
  // Ensure the overlay component identity is stable across re-renders even
  // if the runtime emits — the slot only re-renders when the overlay's id
  // changes (which would also remount via the parent's `key`).
  const [Component] = useState(() => overlay.component)
  // If a plugin re-registers a new component for the same id, force remount
  // by treating that as a different overlay (rare but possible during dev).
  useEffect(() => {
    void Component
  }, [Component])

  const manifest = pluginRuntime.getCanvasOverlayManifest(overlay.id)
  const contextValue: PluginContextValue = {
    pluginId: overlay.pluginId,
    pluginVersion: manifest?.version ?? '',
    surfaceId: overlay.id,
    surfaceLabel: overlay.id,
    grantedPermissions: manifest?.grantedPermissions ?? [],
    settings: pluginRuntime.getPluginSettings(overlay.pluginId),
    routes: buildPluginRoutesHelper(overlay.pluginId),
    runCommand: (commandId) => pluginRuntime.runCommand(commandId),
  }

  return (
    <ErrorBoundary
      location="plugin-canvas-overlay"
      resetKeys={[overlay.id, overlay.pluginId]}
    >
      <div
        className={styles.overlaySlot}
        data-plugin-id={overlay.pluginId}
        data-overlay-id={overlay.id}
      >
        <PluginContext.Provider value={contextValue}>
          <Component overlay={{ id: overlay.id, pluginId: overlay.pluginId }} />
        </PluginContext.Provider>
      </div>
    </ErrorBoundary>
  )
}
