/**
 * PluginIdeSnapshot — payload the chat handler hands to plugin-scope tool
 * handlers via `ToolContext.snapshot` and the system-prompt builder.
 *
 * The browser builds this on every send from the live Plugin IDE state
 * (open plugin, CRDT file list, active buffer, runtime summary). Shape is
 * validated at the chat boundary with `PluginIdeSnapshotSchema` — a
 * malformed snapshot falls back to empty rather than crashing the stream.
 *
 * Over MCP the snapshot is null: file tools are browser-bridged to the open
 * IDE anyway, and the server tools (`plugin_validate`, `plugin_activate`,
 * `plugin_list_plugins`) take an explicit `localId` instead.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const PluginIdeSnapshotSchema = Type.Object({
  /** The plugin open in the IDE. */
  localId: Type.String(),
  /** Runtime id (`site.<localId>`). */
  pluginId: Type.String(),
  /** Paths RELATIVE to the plugin folder (`plugin.json`, `server/index.ts`). */
  files: Type.Array(
    Type.Object({
      id: Type.String(),
      path: Type.String(),
    }),
  ),
  /** The buffer currently visible in the editor, if any. */
  activeFile: Type.Union([
    Type.Object({ id: Type.String(), path: Type.String() }),
    Type.Null(),
  ]),
  /** `computeSitePluginState` vocabulary — 'active', 'draft-changed', …. */
  state: Type.String(),
  activeVersion: Type.Union([Type.String(), Type.Null()]),
  declaredPermissions: Type.Array(Type.String()),
  grantedPermissions: Type.Array(Type.String()),
  /** The diagnostics strip's latest result; null = not validated yet. */
  latestDiagnostics: Type.Union([Type.Array(Type.String()), Type.Null()]),
  currentUser: Type.Object({
    id: Type.String(),
    displayName: Type.String(),
    email: Type.String(),
  }),
})

export type PluginIdeSnapshot = Static<typeof PluginIdeSnapshotSchema>

export function emptyPluginIdeSnapshot(): PluginIdeSnapshot {
  return {
    localId: '',
    pluginId: '',
    files: [],
    activeFile: null,
    state: 'draft-changed',
    activeVersion: null,
    declaredPermissions: [],
    grantedPermissions: [],
    latestDiagnostics: null,
    currentUser: { id: '', displayName: '', email: '' },
  }
}
