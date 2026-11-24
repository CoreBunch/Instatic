// ---------------------------------------------------------------------------
// Canvas overlays — React components mounted on top of the editor canvas
// ---------------------------------------------------------------------------

/**
 * Canvas overlay registered by a plugin via `editor.canvas.registerOverlay`.
 * Mounts inside the editor's canvas overlay layer — a positioned div that
 * sits on top of the rendered canvas and receives no pointer events by
 * default (children can opt in via `pointer-events: auto`).
 *
 * Plugins use the host's `useCanvasNodeRect(nodeId)` hook to position
 * children relative to specific nodes. Common use cases:
 *   • Comment / annotation pins (Figma-style design review)
 *   • Custom selection adornments (a11y outlines, contrast warnings)
 *   • Measurement / ruler tools
 *   • Live data badges over rendered nodes
 *
 * The component receives an `overlay` prop with the registration metadata
 * so plugins that ship multiple overlays can branch on `overlay.id`.
 */
export interface PluginCanvasOverlay {
  showInLiveMode?: boolean
  id: string
  component: import('react').ComponentType<{
    overlay: { id: string; pluginId: string }
  }>
}

export interface RegisteredPluginCanvasOverlay extends PluginCanvasOverlay {
  pluginId: string
}
