/**
 * Site plugin runtime-state machine — ONE vocabulary shared by the server
 * list endpoint (which computes states) and the admin UI (which renders the
 * state chip + smart primary action). Design: docs/features/site-plugins.md
 * → "Runtime states" / "One smart primary action".
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const SITE_PLUGIN_RUNTIME_STATES = [
  'active',
  'draft-changed',
  'build-failed',
  'permission-review',
  'runtime-error',
  'disabled',
  'source-missing',
] as const

export type SitePluginRuntimeState = (typeof SITE_PLUGIN_RUNTIME_STATES)[number]

export const SitePluginRuntimeStateSchema = Type.Union(
  SITE_PLUGIN_RUNTIME_STATES.map((state) => Type.Literal(state)),
)

/** One retained build — a rollback target. */
export const SitePluginRevisionSchema = Type.Object({
  /** Generated version (`1.0.<n>+<hash>`). */
  version: Type.String(),
  /** Build time, epoch ms. */
  builtAt: Type.Number(),
})
export type SitePluginRevision = Static<typeof SitePluginRevisionSchema>

/** Wire shape of one site plugin in the list payload. */
export const SitePluginSummarySchema = Type.Object({
  localId: Type.String(),
  /** Runtime plugin id (site.<localId>). */
  pluginId: Type.String(),
  name: Type.String(),
  state: SitePluginRuntimeStateSchema,
  /** Active generated version (1.0.<n>+<hash>), or null before first build. */
  activeVersion: Type.Union([Type.String(), Type.Null()]),
  /** Retained builds, newest first — every entry is a rollback target. Empty until the first build. */
  revisions: Type.Array(SitePluginRevisionSchema),
  /** False when the runtime row survives a deleted plugins/<id>/ folder. */
  hasDraftSource: Type.Boolean(),
  /** Draft declares a module pack — enables `Preview in canvas`. */
  hasModules: Type.Boolean(),
  declaredPermissions: Type.Array(Type.String()),
  grantedPermissions: Type.Array(Type.String()),
  /** Grant diff — non-empty means activation shows the permission review. */
  newPermissions: Type.Array(Type.String()),
  removedPermissions: Type.Array(Type.String()),
  /** Draft plugin.json derivation error, or null when it parses. */
  manifestError: Type.Union([Type.String(), Type.Null()]),
  /** Runtime lifecycle error from the active revision, or null. */
  lastError: Type.Union([Type.String(), Type.Null()]),
})
export type SitePluginSummary = Static<typeof SitePluginSummarySchema>

export const SitePluginsPayloadSchema = Type.Object({
  sitePlugins: Type.Array(SitePluginSummarySchema),
})
export type SitePluginsPayload = Static<typeof SitePluginsPayloadSchema>

export interface SitePluginStateInput {
  hasDraftSource: boolean
  /** Null when no installed_plugins row exists yet. */
  row: {
    version: string
    lifecycleStatus: 'installed' | 'active' | 'disabled' | 'error'
    enabled: boolean
  } | null
  /** Draft plugin.json failed derivation (cheap manifest-only check). */
  manifestError: string | null
  /** Content hash of the current draft source. */
  draftContentHash: string | null
  /** Hash carried by the active row's version (`+<hash>`), or null. */
  activeContentHash: string | null
  /** Grant diff between the derived draft manifest and the row. */
  grantsChanged: boolean
}

/**
 * Compute the runtime state — the exact precedence the design's states
 * table implies: missing source beats everything (an invisible-but-running
 * backend must surface), then runtime errors, then disabled, then draft
 * problems, then the hash comparison.
 */
export function computeSitePluginState(input: SitePluginStateInput): SitePluginRuntimeState {
  if (!input.hasDraftSource) return 'source-missing'
  if (input.row?.lifecycleStatus === 'error') return 'runtime-error'
  if (input.row && (!input.row.enabled || input.row.lifecycleStatus === 'disabled')) {
    return 'disabled'
  }
  if (input.manifestError) return 'build-failed'
  if (input.grantsChanged) return 'permission-review'
  if (!input.row) return 'draft-changed' // never built — the first Build & activate
  if (input.draftContentHash !== input.activeContentHash) return 'draft-changed'
  return 'active'
}

export type SitePluginPrimaryActionKind =
  | 'activate'
  | 'review'
  | 'diagnostics'
  | 'open-plugins-page'
  | 'delete'
  | 'enable'
  | null

export interface SitePluginPrimaryAction {
  label: string
  action: SitePluginPrimaryActionKind
}

/** One state-appropriate primary action — shared by the Plugins-page card
 *  and the IDE header so the two surfaces can never drift. */
export function sitePluginPrimaryAction(state: SitePluginRuntimeState): SitePluginPrimaryAction {
  switch (state) {
    case 'draft-changed':
      return { label: 'Build & activate', action: 'activate' }
    case 'permission-review':
      return { label: 'Review permissions', action: 'review' }
    case 'build-failed':
      return { label: 'View diagnostics', action: 'diagnostics' }
    case 'runtime-error':
      // The IDE shows the runtime error inline; logs and restart live on the
      // Plugins page, and the label says exactly where the click goes.
      return { label: 'Open on Plugins page', action: 'open-plugins-page' }
    case 'source-missing':
      return { label: 'Delete site plugin', action: 'delete' }
    case 'disabled':
      return { label: 'Activate', action: 'enable' }
    case 'active':
      return { label: '', action: null }
  }
}

/** Human label for the state chip. */
export function sitePluginStateLabel(state: SitePluginRuntimeState): string {
  switch (state) {
    case 'active':
      return 'Active'
    case 'draft-changed':
      return 'Draft changed'
    case 'build-failed':
      return 'Build failed'
    case 'permission-review':
      return 'Permission review needed'
    case 'runtime-error':
      return 'Runtime error'
    case 'disabled':
      return 'Disabled'
    case 'source-missing':
      return 'Source missing'
  }
}
