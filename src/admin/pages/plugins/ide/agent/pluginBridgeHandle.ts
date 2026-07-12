/**
 * Plugin IDE bridge handle registry.
 *
 * The chat panel and the MCP relay run outside the IDE page's React tree —
 * the bridge dispatcher needs an imperative entry point onto the live IDE
 * state (the collab session, the file list, the runtime summary, the
 * visible buffer). SitePluginIdePage registers a handle here on mount; the
 * dispatcher reads it and calls methods on it. Same module-level-handle
 * pattern as the content workspace's `contentBridgeHandle.ts`.
 *
 * The snapshot shape structurally mirrors
 * `server/ai/tools/plugin/snapshot.ts → PluginIdeSnapshot` — defined here
 * (not imported) so the frontend doesn't reach into `server/`. Keep the two
 * in sync.
 */
import type { SitePluginSummary } from '@core/site-plugins'
import type { IdeCollabSession, IdeFileMeta } from '../ideCollab'

export interface PluginIdeAgentCurrentUser {
  id: string
  displayName: string
  email: string
}

/** Mirrors `PluginIdeSnapshot` (server) — see module doc. */
export interface PluginIdeAgentSnapshot {
  localId: string
  pluginId: string
  files: Array<{ id: string; path: string }>
  activeFile: { id: string; path: string } | null
  state: string
  activeVersion: string | null
  declaredPermissions: string[]
  grantedPermissions: string[]
  latestDiagnostics: string[] | null
  currentUser: PluginIdeAgentCurrentUser
}

/**
 * Imperative surface the IDE page exposes to the agent bridge. Accessors
 * (not fields) so every call reads the LIVE page state — the handle is
 * registered once per mount and never goes stale.
 */
export interface PluginIdeBridgeHandle {
  /** The plugin this IDE mount edits. */
  readonly localId: string
  /** Per-request snapshot for the system prompt + server tools. */
  buildSnapshot(): PluginIdeAgentSnapshot
  /** The live collab session; null for at most the mount render. */
  session(): IdeCollabSession | null
  /** Live file metas (full `plugins/<localId>/…` paths), path-sorted. */
  files(): IdeFileMeta[]
  /** Switch the visible buffer (plugin_open_file). */
  selectFile(fileId: string): void
  /** Whether the current user may author plugin source (plugins.edit). */
  canEdit(): boolean
}

let handle: PluginIdeBridgeHandle | null = null

export function setPluginIdeBridgeHandle(next: PluginIdeBridgeHandle | null): void {
  handle = next
}

export function getPluginIdeBridgeHandle(): PluginIdeBridgeHandle | null {
  return handle
}

export function emptyPluginIdeAgentSnapshot(): PluginIdeAgentSnapshot {
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

/** Narrow a SitePluginSummary into the snapshot's runtime fields. */
export function summarySnapshotFields(
  summary: SitePluginSummary | null,
): Pick<
  PluginIdeAgentSnapshot,
  'state' | 'activeVersion' | 'declaredPermissions' | 'grantedPermissions'
> {
  return {
    state: summary?.state ?? 'draft-changed',
    activeVersion: summary?.activeVersion ?? null,
    declaredPermissions: [...(summary?.declaredPermissions ?? [])],
    grantedPermissions: [...(summary?.grantedPermissions ?? [])],
  }
}
