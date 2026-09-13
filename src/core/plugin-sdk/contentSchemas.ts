/**
 * TypeBox schemas for the `api.cms.content.*` plugin surface.
 *
 * The surface mirrors the structure plugins already understand from
 * `api.cms.storage.*` (one CRUD per resource, operator-object filters,
 * orderBy/limit/offset) but talks to the host's CMS content tables
 * (`data_tables` + `data_rows`) rather than the plugin-private storage.
 *
 * Source of truth for every shape on the wire:
 *
 *   - `ContentTableSummarySchema`        — `tables.list()` element
 *   - `ContentTableSchemaSchema`         — `tables.get(slug)` result
 *   - `CreateContentTableInputSchema`    — `tables.create(input)` argument
 *   - `ContentEntrySchema`               — every per-entry returned shape
 *   - `ContentListOptionsSchema`         — `table(slug).list(options)` arg
 *   - `ContentListResultSchema`          — `table(slug).list()` result
 *   - `CreateContentEntryInputSchema`    — `table(slug).create(...)` arg
 *   - `UpdateContentEntryInputSchema`    — `table(slug).update(...)` arg
 *   - `TreeOperationSchema`              — `tree(...).mutate(...)` element
 *   - `ContentSearchResultSchema`        — `search(...)` element
 *   - `PublishedSnapshotSchema`          — `getPublishedSnapshot(...)` result
 *
 * `cells` is a free-form `Record<string, unknown>` — typed projection is the
 * job of `PluginContentField` (see `types/content.ts`) which a plugin reads
 * from `tables.get(slug).fields` to interpret cell values.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { DataTableKindSchema, DataRowStatusSchema } from '@core/data/schemas'
import {
  TreeMutateResultSchema,
  TreeOperationSchema,
  type TreeMutateResult,
  type TreeOperation,
} from '@core/page-tree'
import { StorageFilterValueSchema } from './storageSchemas'
import { PluginContentFieldSchema } from './types/content'
import type { PluginPermission } from './types/permissions'

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const ContentTableSummarySchema = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  kind: DataTableKindSchema,
  routeBase: Type.String(),
  system: Type.Boolean(),
  primaryFieldId: Type.String(),
  fieldCount: Type.Integer(),
  rowCount: Type.Integer(),
})
export type ContentTableSummary = Static<typeof ContentTableSummarySchema>

export const ContentTableSchemaSchema = Type.Composite([
  ContentTableSummarySchema,
  Type.Object({
    singularLabel: Type.String(),
    pluralLabel: Type.String(),
    fields: Type.Array(PluginContentFieldSchema),
  }),
])
export type ContentTableSchema = Static<typeof ContentTableSchemaSchema>

export const CreateContentTableInputSchema = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  kind: Type.Optional(DataTableKindSchema),
  routeBase: Type.Optional(Type.String()),
  singularLabel: Type.String(),
  pluralLabel: Type.String(),
  primaryFieldId: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Array(PluginContentFieldSchema)),
}, { additionalProperties: false })
export type CreateContentTableInput = Static<typeof CreateContentTableInputSchema>

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export const ContentEntrySchema = Type.Object({
  id: Type.String(),
  tableSlug: Type.String(),
  slug: Type.String(),
  status: DataRowStatusSchema,
  cells: Type.Record(Type.String(), Type.Unknown()),
  authorUserId: Type.Union([Type.String(), Type.Null()]),
  pluginActorId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  scheduledPublishAt: Type.Union([Type.String(), Type.Null()]),
})
export type ContentEntry = Static<typeof ContentEntrySchema>

export const CreateContentEntryInputSchema = Type.Object({
  slug: Type.Optional(Type.String()),
  cells: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false })
export type CreateContentEntryInput = Static<typeof CreateContentEntryInputSchema>

export const UpdateContentEntryInputSchema = Type.Object({
  slug: Type.Optional(Type.String()),
  cells: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false })
export type UpdateContentEntryInput = Static<typeof UpdateContentEntryInputSchema>

// ---------------------------------------------------------------------------
// List options / result
// ---------------------------------------------------------------------------

export const ContentListOptionsSchema = Type.Object({
  filter: Type.Optional(Type.Record(Type.String(), StorageFilterValueSchema)),
  orderBy: Type.Optional(Type.Record(
    Type.String(),
    Type.Union([Type.Literal('asc'), Type.Literal('desc')]),
  )),
  status: Type.Optional(Type.Union([
    Type.Literal('any'),
    Type.Literal('draft'),
    Type.Literal('published'),
    Type.Literal('scheduled'),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false })
export type ContentListOptions = Static<typeof ContentListOptionsSchema>

export const ContentListResultSchema = Type.Object({
  entries: Type.Array(ContentEntrySchema),
  totalCount: Type.Integer({ minimum: 0 }),
})
export type ContentListResult = Static<typeof ContentListResultSchema>

// ---------------------------------------------------------------------------
// Tree operations — the 11 named tree-mutation store actions
// ---------------------------------------------------------------------------
//
// The canonical runtime schemas live with the mutation engine in
// `@core/page-tree` so the TypeScript union and TypeBox validation cannot drift.
export { TreeOperationSchema, TreeMutateResultSchema }
export type ContentTreeOperation = TreeOperation
export type { TreeMutateResult }

// ---------------------------------------------------------------------------
// Search / published snapshot
// ---------------------------------------------------------------------------

export const ContentSearchResultSchema = Type.Object({
  id: Type.String(),
  tableSlug: Type.String(),
  tableName: Type.String(),
  slug: Type.String(),
  status: DataRowStatusSchema,
  updatedAt: Type.String(),
})
export type ContentSearchResult = Static<typeof ContentSearchResultSchema>

export const PublishedSnapshotSchema = Type.Object({
  entryId: Type.String(),
  tableSlug: Type.String(),
  versionNumber: Type.Integer(),
  slug: Type.String(),
  cells: Type.Record(Type.String(), Type.Unknown()),
  publishedAt: Type.String(),
})
export type PublishedSnapshot = Static<typeof PublishedSnapshotSchema>

// ---------------------------------------------------------------------------
// Content access manifest entries
// ---------------------------------------------------------------------------

export const ContentAccessModeSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('write'),
  Type.Literal('publish'),
  Type.Literal('delete'),
])
export type ContentAccessMode = Static<typeof ContentAccessModeSchema>

/**
 * The permission each `contentAccess` mode consumes. `parsePluginManifest`
 * requires the permission for every declared mode and `instatic-plugin lint`
 * warns about a permission no entry's mode consumes — both read this one
 * table, so the two checks cannot drift apart.
 */
export const CONTENT_ACCESS_MODE_PERMISSIONS: Readonly<Record<ContentAccessMode, PluginPermission>> = {
  read: 'cms.content.read',
  write: 'cms.content.write',
  publish: 'cms.content.publish',
  delete: 'cms.content.delete',
}

export const ContentAccessEntrySchema = Type.Object({
  table: Type.String(),
  modes: Type.Array(ContentAccessModeSchema, { minItems: 1 }),
}, { additionalProperties: false })
export type ContentAccessEntry = Static<typeof ContentAccessEntrySchema>
