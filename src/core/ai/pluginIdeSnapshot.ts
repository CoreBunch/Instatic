/**
 * PluginIdeSnapshot — what the Plugin IDE sends with every chat message and
 * what the server's plugin-scope tools and system prompt read back.
 *
 * The browser builds it from the live IDE state (open plugin, CRDT file
 * list, active buffer, runtime summary); the server validates it at the
 * chat boundary and falls back to `emptyPluginIdeSnapshot()` on a malformed
 * payload. Over MCP the snapshot is null: file tools are browser-bridged to
 * the open IDE anyway, and the server tools take an explicit `localId`.
 *
 * One schema for both sides so the two can never drift.
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
