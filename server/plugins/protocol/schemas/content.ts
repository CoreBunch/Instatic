/**
 * TypeBox schemas for `cms.content.*` api-call arguments.
 *
 * The host validates every cross-VM payload through these schemas before the
 * dispatcher sees it. The schema validation layer is `assertValidApiCall` in
 * `server/plugins/protocol/parser.ts`; per-call shapes are composed via
 * `apiCallSchema` in `server/plugins/protocol/apiCallSchema.ts`.
 *
 * Shapes are intentionally loose only for entry `cells`; page-tree operations
 * and replacements use the canonical `@core/page-tree` TypeBox schemas so
 * malformed cross-VM tree payloads fail before host dispatch.
 */

import { Type } from '@sinclair/typebox'
import { NodeTreeSchema } from '@core/page-tree'
import {
  ContentListOptionsSchema,
  ContentLocaleOptionsSchema,
  ContentSearchOptionsSchema,
  CreateContentEntryInputSchema,
  CreateContentTableInputSchema,
  TreeOperationSchema,
  UpdateContentEntryInputSchema,
} from '@core/plugin-sdk/contentSchemas'

const SlugSchema = Type.String({ minLength: 1 })
const EntryIdSchema = Type.String({ minLength: 1 })
const FieldIdSchema = Type.String({ minLength: 1 })
const QueryStringSchema = Type.String({ minLength: 1, maxLength: 200 })

// ── Tables ──────────────────────────────────────────────────────────────────

export const ContentLocalesListArgsSchema = Type.Tuple([])
export const ContentEntriesUnpublishArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema, ContentLocaleOptionsSchema])
export const ContentTablesListArgsSchema = Type.Tuple([])
export const ContentTablesGetArgsSchema = Type.Tuple([SlugSchema])
export const ContentTablesCreateArgsSchema = Type.Tuple([CreateContentTableInputSchema])

// ── Entries ─────────────────────────────────────────────────────────────────

export const ContentEntriesListArgsSchema = Type.Tuple([SlugSchema, ContentListOptionsSchema])
export const ContentEntriesGetArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema, ContentLocaleOptionsSchema])
export const ContentEntriesGetBySlugArgsSchema = Type.Tuple([SlugSchema, SlugSchema, ContentLocaleOptionsSchema])
export const ContentEntriesCreateArgsSchema = Type.Tuple([SlugSchema, CreateContentEntryInputSchema])
export const ContentEntriesUpdateArgsSchema = Type.Tuple([
  SlugSchema,
  EntryIdSchema,
  UpdateContentEntryInputSchema,
])
export const ContentEntriesDeleteArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema])
export const ContentEntriesPublishArgsSchema = Type.Tuple([
  SlugSchema,
  EntryIdSchema,
  Type.Object({
    localeId: Type.Optional(Type.String({ minLength: 1 })),
    scheduledFor: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  }, { additionalProperties: false }),
])
export const ContentEntriesMoveTableArgsSchema = Type.Tuple([SlugSchema, EntryIdSchema, SlugSchema, ContentLocaleOptionsSchema])

export const ContentEntriesCreateManyArgsSchema = Type.Tuple([
  SlugSchema,
  Type.Array(CreateContentEntryInputSchema, { maxItems: 500 }),
])
export const ContentEntriesUpdateManyArgsSchema = Type.Tuple([
  SlugSchema,
  Type.Array(
    Type.Object({
      id: EntryIdSchema,
      patch: UpdateContentEntryInputSchema,
    }, { additionalProperties: false }),
    { maxItems: 500 },
  ),
])
export const ContentEntriesDeleteManyArgsSchema = Type.Tuple([
  SlugSchema,
  Type.Array(EntryIdSchema, { maxItems: 500 }),
])

// ── Tree ───────────────────────────────────────────────────────────────────

export const ContentTreeReadArgsSchema = Type.Tuple([EntryIdSchema, FieldIdSchema, ContentLocaleOptionsSchema])
export const ContentTreeMutateArgsSchema = Type.Tuple([
  EntryIdSchema,
  FieldIdSchema,
  Type.Array(TreeOperationSchema, { maxItems: 500 }),
  ContentLocaleOptionsSchema,
])
export const ContentTreeReplaceArgsSchema = Type.Tuple([
  EntryIdSchema,
  FieldIdSchema,
  NodeTreeSchema,
  ContentLocaleOptionsSchema,
])

// ── Cross-table ────────────────────────────────────────────────────────────

export const ContentSearchArgsSchema = Type.Tuple([QueryStringSchema, ContentSearchOptionsSchema])
export const ContentSnapshotArgsSchema = Type.Tuple([EntryIdSchema, ContentLocaleOptionsSchema])
export const ContentRepublishAllArgsSchema = Type.Tuple([])
