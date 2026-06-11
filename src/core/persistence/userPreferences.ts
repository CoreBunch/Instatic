/**
 * User preferences — schemas + client persistence helpers.
 *
 * One canonical home for per-user, per-key settings. Anything that belongs
 * to a single admin (dashboard layout, theme, default breakpoint, sidebar
 * collapsed state, …) goes through this module rather than reaching for
 * localStorage directly. Result:
 *
 *   • An admin signs in from another device and finds their dashboard
 *     exactly as they left it.
 *   • The CMS knows which prefs exist (the TS whitelist below is the
 *     inventory — adding a new pref is one named export + one entry in
 *     `USER_PREFERENCE_SCHEMAS`).
 *   • Validation lives in ONE place and applies on both the server and
 *     client sides; nothing falls back to ad-hoc `as Foo` casts.
 *
 * Three tiers of CMS settings, kept distinct:
 *   • Site settings   — single source of truth, all admins share.
 *   • Plugin settings — per plugin, all admins share.
 *   • User preferences — per user, private to them. ← this file
 *
 * Wire format: `/admin/api/cms/me/preferences/:key`
 *   • GET    → `{ value: T }` or `{ value: null }` (not yet set — client
 *              falls back to its default)
 *   • PUT    → `{ value: T }` upserts
 *   • DELETE → resets to default
 *
 * Storage shape: `user_preferences (user_id, key, value_json, updated_at)`
 * — see `server/db/migrations-{pg,sqlite}.ts`. The schemas below are the
 * authoritative shape of `value_json` per key; the DB layer is opaque.
 */
import type { TSchema } from '@sinclair/typebox'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest, type FetchLike } from '@core/http'

// ---------------------------------------------------------------------------
// Per-key value schemas
// ---------------------------------------------------------------------------

/**
 * Dashboard layout — the grid items + onboarding panel state.
 *
 * Lives here (not next to the dashboard hook) so the server handler can
 * validate the wire-level payload against the SAME schema the client uses,
 * without the server having to import a React-flavoured admin module.
 *
 * `col`/`row`/`rows` are optional ON THE WIRE because earlier persistence
 * formats (v1 size-only, v2 size+rows) might still be lying around in the
 * client's localStorage during the migration window — the hook normalises
 * missing positions to sensible defaults. After a clean install the value
 * always carries all four fields.
 */
const DashboardItemSchema = Type.Object({
  id: Type.String(),
  size: Type.Number(),
  rows: Type.Optional(Type.Number()),
  col: Type.Optional(Type.Number()),
  row: Type.Optional(Type.Number()),
})

export const DashboardLayoutSchema = Type.Object({
  items: Type.Array(DashboardItemSchema),
  onboardingDismissed: Type.Boolean(),
  /**
   * Height (in pixels) of the bottom-docked Block library panel. Persisted
   * per-user so the panel sticks to the same height across reloads and
   * devices. Optional on the wire so existing saved layouts (without the
   * field) keep working — the hook falls back to the default height.
   */
  libraryHeight: Type.Optional(Type.Number()),
})

export type DashboardLayoutPreference = Static<typeof DashboardLayoutSchema>

const ModuleInserterItemKindSchema = Type.Union([
  Type.Literal('module'),
  Type.Literal('layout'),
  Type.Literal('savedLayout'),
  Type.Literal('component'),
])

export const ModuleInserterItemRefSchema = Type.Object({
  kind: ModuleInserterItemKindSchema,
  id: Type.String(),
})

export const ModuleInserterPreferenceSchema = Type.Object({
  favorites: Type.Array(ModuleInserterItemRefSchema, { maxItems: 12 }),
})

export type ModuleInserterItemRef = Static<typeof ModuleInserterItemRefSchema>
export type ModuleInserterPreference = Static<typeof ModuleInserterPreferenceSchema>

export const DEFAULT_MODULE_INSERTER_PREFERENCE: ModuleInserterPreference = {
  favorites: [
    { kind: 'module', id: 'base.container' },
    { kind: 'module', id: 'base.text' },
    { kind: 'module', id: 'base.image' },
  ],
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

/**
 * The canonical list of preference keys. Adding a new pref requires:
 *
 *   1. Add the key here AND its schema below in `USER_PREFERENCE_SCHEMAS`.
 *   2. Ship a hook (or other consumer) that reads/writes it.
 *
 * The server handler validates every wire-level `:key` against this list —
 * any unknown key is rejected with 400. This is the audit boundary that
 * prevents plugins or third-party code from squatting arbitrary keys
 * into the user record (plugins have their own storage surface via
 * `cms.storage`).
 */
export const USER_PREFERENCE_KEYS = [
  'dashboard-layout',
  'module-inserter',
] as const

export type UserPreferenceKey = (typeof USER_PREFERENCE_KEYS)[number]

/**
 * Per-key value schemas, keyed by `UserPreferenceKey`. The mapped type
 * below derives the value type for each key from this object, so a TS
 * call site like `getUserPreference('dashboard-layout')` returns a
 * `DashboardLayoutPreference | null` — no casts needed.
 */
export const USER_PREFERENCE_SCHEMAS = {
  'dashboard-layout': DashboardLayoutSchema,
  'module-inserter': ModuleInserterPreferenceSchema,
} as const satisfies Record<UserPreferenceKey, TSchema>

export type UserPreferenceValue<K extends UserPreferenceKey> = Static<
  (typeof USER_PREFERENCE_SCHEMAS)[K]
>

export function isUserPreferenceKey(value: unknown): value is UserPreferenceKey {
  return typeof value === 'string' && (USER_PREFERENCE_KEYS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// HTTP envelopes
// ---------------------------------------------------------------------------

/**
 * Wire-level envelope shape. The handler always responds with
 * `{ value: T }`, validated outer-shape-only by this schema. The `value`
 * itself is then re-validated against the per-key schema by the caller —
 * splitting the validation in two avoids a generic-inference soup that
 * TS can't unwrap when the schema is selected by a generic key type.
 */
const PreferenceEnvelopeSchema = Type.Object({ value: Type.Unknown() })

import { parseValue } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

const BASE_PATH = '/admin/api/cms/me/preferences'

/**
 * Fetch a single user preference. Returns `null` when the user hasn't set
 * the preference yet (`{ value: null }` from the server) — callers fall
 * back to their own default in that case. Network / parse failures surface
 * as thrown errors so consumers can show a real error state rather than
 * silently applying an invalid default.
 */
export async function getUserPreference<K extends UserPreferenceKey>(
  key: K,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<UserPreferenceValue<K> | null> {
  const envelope = await apiRequest(`${BASE_PATH}/${encodeURIComponent(key)}`, {
    schema: PreferenceEnvelopeSchema,
    fetchImpl,
    fallbackMessage: `Failed to load user preference "${key}"`,
  })
  // `value: null` is the server's "never set" signal — every pref value
  // schema is an object, never null, so this is unambiguous.
  if (envelope.value === null) return null
  return parseValue(USER_PREFERENCE_SCHEMAS[key], envelope.value) as UserPreferenceValue<K>
}

/**
 * Upsert a single user preference. The body is `{ value }`; the response
 * echoes the saved value (after server-side schema validation has run, so
 * the caller can re-sync to whatever the server actually stored — useful
 * when server-side defaults fill in optional fields).
 */
export async function setUserPreference<K extends UserPreferenceKey>(
  key: K,
  value: UserPreferenceValue<K>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<UserPreferenceValue<K>> {
  const envelope = await apiRequest(`${BASE_PATH}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value },
    schema: PreferenceEnvelopeSchema,
    fetchImpl,
    fallbackMessage: `Failed to save user preference "${key}"`,
  })
  return parseValue(USER_PREFERENCE_SCHEMAS[key], envelope.value) as UserPreferenceValue<K>
}

/**
 * Delete a single user preference, resetting it to default on the next
 * read. No envelope on success — the server returns 204 No Content.
 */
export async function deleteUserPreference<K extends UserPreferenceKey>(
  key: K,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<void> {
  await apiRequest(`${BASE_PATH}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: `Failed to reset user preference "${key}"`,
  })
}
