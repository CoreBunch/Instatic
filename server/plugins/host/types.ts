/**
 * Per-plugin host-side bookkeeping types. These are the runtime records the
 * main process maintains for each active plugin — distinct from the SDK types
 * (plugin manifests, SDK API shapes) which live in src/core/plugin-sdk/.
 */

import type { PluginRouteDocumentation } from '@core/plugins/routeDocumentation'
import type { CoreCapability } from '../../auth/capabilities'
import type { PluginRateLimitStore } from './pluginRateLimit'
import type { PluginManifest } from '@core/plugin-sdk'

/**
 * Access policy for a plugin-registered route. See
 * `server/plugins/protocol/schemas/routes.ts` for the underlying TypeBox
 * schema and the design notes on why this is a tagged union rather than
 * `capability: CoreCapability | null` (the old shape was ambiguous —
 * `null` could mean "any logged-in user" OR "fully public" depending on
 * the reader; nothing forced plugin authors to be explicit).
 */
export type HostRouteAccess =
  | { kind: 'capability'; capability: CoreCapability }
  | { kind: 'authenticated' }
  | { kind: 'public' }
  /**
   * A signed-in site member, optionally one holding `tag`. Public mount
   * only. `appScope` names the manifest app scope an app's sign-in must
   * carry to call the route with its token; null keeps it to browsers.
   */
  | { kind: 'member'; tag: string | null; appScope: string | null }

interface HostRouteEntry {
  documentation?: PluginRouteDocumentation
  pluginId: string
  method: string
  path: string
  access: HostRouteAccess
  routeKey: string
}

interface HostHookListenerEntry {
  pluginId: string
  listenerId: string
}

interface HostHookFilterEntry {
  pluginId: string
  filterId: string
}

interface HostLoopSourceEntry {
  pluginId: string
  sourceId: string
  /**
   * New on every registration, so on every load of the plugin: an editor
   * that holds sample items for the source can tell they came from an
   * earlier load (an upgrade, a restart) and ask again.
   */
  revision: string
}

interface HostMediaAdapterEntry {
  pluginId: string
  adapterId: string
}

interface HostMediaTransformerEntry {
  pluginId: string
  transformerId: string
}

export interface HostPluginRecord {
  manifest: PluginManifest
  /** Absolute, host-validated root for files shipped in this plugin package. */
  assetRootPath: string
  routes: Map<string, HostRouteEntry>
  hookListeners: HostHookListenerEntry[]
  hookFilters: HostHookFilterEntry[]
  /**
   * The VM-side id of the plugin's member export provider
   * (`api.cms.members.exportProvider`), or null when it has none.
   */
  memberExportFilterId: string | null
  loopSources: HostLoopSourceEntry[]
  /** Media storage adapter ids registered by this plugin. */
  mediaAdapters: HostMediaAdapterEntry[]
  /** Media URL transformer registrations — actually live as hookBus filters. */
  mediaUrlTransformers: HostMediaTransformerEntry[]
  /**
   * In-flight outbound fetches keyed by the plugin's `abortId`. Populated
   * by `performGatedFetch` (which registers a fresh AbortController before
   * issuing the upstream `fetch`) and dropped in its `finally` block.
   * `network.abort` dispatch looks up the controller here and aborts it,
   * tearing down the underlying socket / response stream instead of
   * waiting for natural completion.
   */
  inflightFetches: Map<string, AbortController>
  /** The plugin's own rate-limit counters (`cms.rateLimit.take`). Dropped with the record on unload. */
  rateLimits: PluginRateLimitStore
}

export interface PendingRequest {
  pluginId: string
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

/**
 * Outcome the runtime layer should take after a worker crash. Returned by
 * `recordCrashAndDecide` so the runtime can both persist the event and
 * branch on whether to respawn or park in error state.
 */
export type CrashRecoveryDecision =
  | { kind: 'respawn'; recentCrashCount: number }
  | { kind: 'give-up'; recentCrashCount: number }

/**
 * Callback the runtime registers so the worker host can ask it to re-load +
 * re-activate a plugin after an auto-respawn (or a manual restart). The
 * runtime owns the on-disk asset path resolution and lifecycle ordering;
 * the host just signals when to re-bind.
 */
export type CrashRecoveryHandler = (args: {
  pluginId: string
  reason: string
  decision: CrashRecoveryDecision
}) => Promise<void>
