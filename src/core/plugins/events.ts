/**
 * Plugin lifecycle event schema — the single source of truth for the
 * payloads broadcast over the SSE channel
 * (`/admin/api/cms/plugins/events`).
 *
 * The server's `eventBroadcaster` emits these; the admin client validates
 * each frame against `PluginEventSchema` before dispatching to listeners.
 * Both sides derive their `PluginEvent` type from this schema — there is no
 * parallel hand-written union.
 *
 * Event shape is small + JSON-serializable. The `kind` field is the
 * discriminant the client uses to decide what to do (toast / badge /
 * live-list refresh).
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

export const PluginEventSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('crash'),
    pluginId: Type.String(),
    reason: Type.String(),
    recentCrashCount: Type.Number(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('recovered'),
    pluginId: Type.String(),
    afterCrashCount: Type.Number(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('parked'),
    pluginId: Type.String(),
    reason: Type.String(),
    recentCrashCount: Type.Number(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('restarted'),
    pluginId: Type.String(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('installed'),
    pluginId: Type.String(),
    version: Type.String(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('updated'),
    pluginId: Type.String(),
    fromVersion: Type.String(),
    toVersion: Type.String(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('uninstalled'),
    pluginId: Type.String(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('enabled'),
    pluginId: Type.String(),
    occurredAt: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('disabled'),
    pluginId: Type.String(),
    occurredAt: Type.String(),
  }),
])

export type PluginEvent = Static<typeof PluginEventSchema>

type PluginEventKind = PluginEvent['kind']

/**
 * Every event kind, derived from the schema variants. The SSE client
 * registers one `addEventListener` per kind (the server sends named SSE
 * events keyed by `kind`).
 */
export const PLUGIN_EVENT_KINDS: PluginEventKind[] = PluginEventSchema.anyOf.map(
  (variant) => variant.properties.kind.const as PluginEventKind,
)
