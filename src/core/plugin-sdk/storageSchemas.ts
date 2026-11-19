/**
 * TypeBox schemas for the plugin storage API.
 *
 * These schemas are the source of truth for the storage filtering/pagination
 * contract. All types are derived from them via `Static<>`.
 *
 * Used across:
 *   - `src/core/plugin-sdk/types.ts`        — SDK type signatures
 *   - `server/plugins/workerProtocol.ts`    — IPC schema validation
 *   - `server/repositories/plugins.ts`      — SQL query builder
 *   - `src/core/persistence/cmsPluginRecords.ts` — HTTP client
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// PluginRecord — source-of-truth TypeBox schema (replaces the plain interface)
// ---------------------------------------------------------------------------

export const PluginRecordSchema = Type.Object({
  id: Type.String(),
  pluginId: Type.String(),
  resourceId: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  /** The value of the resource's `uniqueField`, or null when it has none. */
  uniqueKey: Type.Union([Type.String(), Type.Null()]),
  /** Starts at 0 and goes up by one on every update. Pass it as `ifVersion`. */
  version: Type.Integer({ minimum: 0 }),
  /**
   * Set when the stored data is not a JSON object and could not be read:
   * `data` is then `{}`. Such a record can be deleted but not updated.
   */
  unreadable: Type.Optional(Type.Literal(true)),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type PluginRecord = Static<typeof PluginRecordSchema>

// ---------------------------------------------------------------------------
// Storage list options — filter / orderBy / limit / offset
// ---------------------------------------------------------------------------

/**
 * Operator object for a single field filter. Each key applies an independent
 * comparison against the field value. Multiple keys on the same operator
 * object produce an AND clause (e.g. `{ gt: 0, lt: 100 }` means
 * `field > 0 AND field < 100`).
 */
export const StorageFilterOperatorSchema = Type.Object(
  {
    eq: Type.Optional(Type.Unknown()),
    ne: Type.Optional(Type.Unknown()),
    gt: Type.Optional(Type.Unknown()),
    gte: Type.Optional(Type.Unknown()),
    lt: Type.Optional(Type.Unknown()),
    lte: Type.Optional(Type.Unknown()),
    in: Type.Optional(Type.Array(Type.Unknown())),
    like: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)

export type StorageFilterOperator = Static<typeof StorageFilterOperatorSchema>

/**
 * A filter value for a single field. Either a shorthand primitive (treated as
 * `{ eq: value }`) or a full operator object.
 */
export const StorageFilterValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  StorageFilterOperatorSchema,
])

export type StorageFilterValue = Static<typeof StorageFilterValueSchema>

/**
 * Options accepted by `collection(id).list(options)`.
 *
 * Field keys in `filter` and `orderBy` must be plain ASCII identifiers
 * (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`). The host validates this at the boundary
 * before building SQL to give a clear error instead of a cryptic DB error.
 */
export const StorageListOptionsSchema = Type.Object(
  {
    filter: Type.Optional(Type.Record(Type.String(), StorageFilterValueSchema)),
    orderBy: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
    ),
    /** Defaults to 100 when omitted; capped at 1000. */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    /** Defaults to 0 when omitted. */
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
)

export type StorageListOptions = Static<typeof StorageListOptionsSchema>

// ---------------------------------------------------------------------------
// Storage list result
// ---------------------------------------------------------------------------

export const StorageListResultSchema = Type.Object({
  records: Type.Array(PluginRecordSchema),
  totalCount: Type.Integer({ minimum: 0 }),
})

export type StorageListResult = Static<typeof StorageListResultSchema>

// ---------------------------------------------------------------------------
// Unique keys and conditional writes
// ---------------------------------------------------------------------------

/** Longest value a resource's `uniqueField` may hold. */
export const STORAGE_UNIQUE_KEY_MAX_LENGTH = 512

/** Options for `update` and `delete`: apply only while the version matches. */
export const StorageWriteOptionsSchema = Type.Object(
  { ifVersion: Type.Optional(Type.Integer({ minimum: 0 })) },
  { additionalProperties: false },
)

export type StorageWriteOptions = Static<typeof StorageWriteOptionsSchema>

export const StorageCreateIfAbsentResultSchema = Type.Object({
  record: PluginRecordSchema,
  created: Type.Boolean(),
})

export type StorageCreateIfAbsentResult = Static<typeof StorageCreateIfAbsentResultSchema>

/**
 * Error-message prefixes for storage refusals. The plugin RPC carries only a
 * message string, so a plugin tells these apart with `message.startsWith(...)`.
 */
export const STORAGE_DUPLICATE_PREFIX = 'storage_duplicate:'
export const STORAGE_CONFLICT_PREFIX = 'storage_conflict:'
