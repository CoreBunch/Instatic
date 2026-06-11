/**
 * Data module — TypeBox schemas and derived types.
 *
 * `data_tables` and `data_rows` are the unified store for everything that
 * looks like "a row in a table": blog posts, custom post types, product
 * catalogs, form submissions, arbitrary user-defined collections.
 *
 * Two kinds of tables share this store:
 *
 *   - `kind: 'postType'` — authored through the Content admin page. Has
 *     reserved built-in fields (`title`, `slug`, `body`, `featuredMedia`,
 *     `seoTitle`, `seoDescription`) and a draft / published / unpublished
 *     workflow with versions.
 *   - `kind: 'data'` — authored through the Data admin page (grid). No
 *     built-ins, no version workflow.
 *
 * All cell values live in `cells_json` keyed by field id. `slug` and
 * `status` are denormalized columns on the row for index / route lookup.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof T>`.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// DataRowStatus
// ---------------------------------------------------------------------------

export const DataRowStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('unpublished'),
  // 'scheduled' rows wait for the publish scheduler tick — see
  // `server/publish/publishScheduler.ts`. The row's
  // `scheduledPublishAt` carries the target ISO datetime; the tick
  // calls `publishDataRow(...)` once `now() >= scheduledPublishAt`
  // and flips the row to 'published' (or back to 'draft' on
  // publish failure).
  Type.Literal('scheduled'),
])

export type DataRowStatus = Static<typeof DataRowStatusSchema>

// ---------------------------------------------------------------------------
// DataTableKind
// ---------------------------------------------------------------------------

export const DataTableKindSchema = Type.Union([
  Type.Literal('postType'),
  Type.Literal('data'),
  Type.Literal('page'),
  Type.Literal('component'),
  Type.Literal('layout'),
])

export type DataTableKind = Static<typeof DataTableKindSchema>

// ---------------------------------------------------------------------------
// DataField — discriminated union over `type`.
//
// Each field has:
//   - `id`         machine name, unique within the table (e.g. `title`, `price`)
//   - `label`      human-readable display label
//   - `required?`  enforced at write time
//   - `description?` optional helper text rendered next to the input
//   - `builtIn?`   true for fields auto-managed by the table's `kind`
//                  (post-type built-ins). Built-ins cannot be renamed or
//                  deleted — only enabled / disabled.
//
// Cell value shapes (what `cells_json[fieldId]` holds):
//
//   text / longText / richText / url / email  → string | null
//   number                                    → number | null
//   boolean                                   → boolean | null
//   date / dateTime                           → ISO string | null
//   select                                    → option id (string) | null
//   multiSelect                               → option ids (string[])
//   media (single)                            → media id (string) | null
//   media (multi)                             → media ids (string[])
//   relation (single)                         → row id (string) | null
//   relation (multi)                          → row ids (string[])
// ---------------------------------------------------------------------------

const FieldCommonProps = {
  id: Type.String(),
  label: Type.String(),
  required: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  builtIn: Type.Optional(Type.Boolean()),
}

const TextFieldSchema = Type.Object({
  type: Type.Literal('text'),
  ...FieldCommonProps,
  defaultValue: Type.Optional(Type.String()),
  maxLength: Type.Optional(Type.Number()),
  placeholder: Type.Optional(Type.String()),
})

const LongTextFieldSchema = Type.Object({
  type: Type.Literal('longText'),
  ...FieldCommonProps,
  defaultValue: Type.Optional(Type.String()),
})

const RichTextFieldSchema = Type.Object({
  type: Type.Literal('richText'),
  ...FieldCommonProps,
  format: Type.Union([Type.Literal('markdown'), Type.Literal('html')]),
  defaultValue: Type.Optional(Type.String()),
})

const NumberFieldSchema = Type.Object({
  type: Type.Literal('number'),
  ...FieldCommonProps,
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  step: Type.Optional(Type.Number()),
  integer: Type.Optional(Type.Boolean()),
  format: Type.Optional(Type.Union([
    Type.Literal('number'),
    Type.Literal('currency'),
    Type.Literal('percent'),
  ])),
  /** ISO 4217 e.g. 'USD' — meaningful when `format: 'currency'`. */
  currency: Type.Optional(Type.String()),
  defaultValue: Type.Optional(Type.Number()),
})

const BooleanFieldSchema = Type.Object({
  type: Type.Literal('boolean'),
  ...FieldCommonProps,
  defaultValue: Type.Optional(Type.Boolean()),
})

const DateFieldSchema = Type.Object({
  type: Type.Literal('date'),
  ...FieldCommonProps,
})

const DateTimeFieldSchema = Type.Object({
  type: Type.Literal('dateTime'),
  ...FieldCommonProps,
})

const SelectOptionSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  value: Type.String(),
  color: Type.Optional(Type.String()),
})

export type DataSelectOption = Static<typeof SelectOptionSchema>

const SelectFieldSchema = Type.Object({
  type: Type.Literal('select'),
  ...FieldCommonProps,
  options: Type.Array(SelectOptionSchema),
  defaultValue: Type.Optional(Type.String()),
})

const MultiSelectFieldSchema = Type.Object({
  type: Type.Literal('multiSelect'),
  ...FieldCommonProps,
  options: Type.Array(SelectOptionSchema),
})

const UrlFieldSchema = Type.Object({
  type: Type.Literal('url'),
  ...FieldCommonProps,
})

const EmailFieldSchema = Type.Object({
  type: Type.Literal('email'),
  ...FieldCommonProps,
})

const MediaFieldSchema = Type.Object({
  type: Type.Literal('media'),
  ...FieldCommonProps,
  /**
   * Restricts the media picker to a specific asset kind. Defaults to `'any'`
   * (image, video, file). Post-type `featuredMedia` is `'image'`.
   */
  mediaKind: Type.Optional(Type.Union([
    Type.Literal('image'),
    Type.Literal('video'),
    Type.Literal('any'),
  ])),
  allowMultiple: Type.Optional(Type.Boolean()),
})

const RelationFieldSchema = Type.Object({
  type: Type.Literal('relation'),
  ...FieldCommonProps,
  /** `data_tables.id` the relation points at. */
  targetTableId: Type.String(),
  allowMultiple: Type.Optional(Type.Boolean()),
})

/**
 * PageTree field — stores a full page-node tree (`NodeTree<PageNode>`) in the
 * cell. Used as the `body` field on `page` and `component` table rows.
 *
 * UI: cell renders an "Open editor →" button that navigates to the visual
 * editor for that row.
 */
const PageTreeFieldSchema = Type.Object({
  type: Type.Literal('pageTree'),
  ...FieldCommonProps,
})

/**
 * FieldSchema field — stores a `DataField[]` array in the cell. Used as the
 * `params` field on `component` rows to define the component's parameter set.
 *
 * UI: cell renders an "Edit params (N)" button that opens the field-picker
 * dialog (same UI as adding columns to a data table).
 */
const FieldSchemaFieldSchema = Type.Object({
  type: Type.Literal('fieldSchema'),
  ...FieldCommonProps,
})

export const DataFieldSchema = Type.Union([
  TextFieldSchema,
  LongTextFieldSchema,
  RichTextFieldSchema,
  NumberFieldSchema,
  BooleanFieldSchema,
  DateFieldSchema,
  DateTimeFieldSchema,
  SelectFieldSchema,
  MultiSelectFieldSchema,
  UrlFieldSchema,
  EmailFieldSchema,
  MediaFieldSchema,
  RelationFieldSchema,
  PageTreeFieldSchema,
  FieldSchemaFieldSchema,
])

export type DataField = Static<typeof DataFieldSchema>

/**
 * Ordered tuple of every field type literal. Exported as a const array so
 * runtime code (architecture tests, pickers, compat maps) can iterate over
 * all types without relying on TypeScript reflection.
 *
 * Keep in sync with the `DataFieldSchema` union above — the architecture
 * test `binding-compatibility-coverage.test.ts` will catch any drift.
 */
export const DATA_FIELD_TYPES = [
  'text',
  'longText',
  'richText',
  'number',
  'boolean',
  'date',
  'dateTime',
  'select',
  'multiSelect',
  'url',
  'email',
  'media',
  'relation',
  'pageTree',
  'fieldSchema',
] as const

export type DataFieldType = (typeof DATA_FIELD_TYPES)[number]

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

export const DataTableSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  kind: DataTableKindSchema,
  singularLabel: Type.String(),
  pluralLabel: Type.String(),
  /** Empty string = not publicly routable. Post-types default to `/<slug>`. */
  routeBase: Type.String(),
  /** Field id used as the row's display name in grid / picker UIs. */
  primaryFieldId: Type.String(),
  fields: Type.Array(DataFieldSchema),
  /**
   * True for tables seeded at boot (`posts`, `pages`, `components`).
   * System tables are protected from rename and delete; users can still add
   * custom fields to them. Column added to `data_tables` in the Step 2
   * migration; repositories default to `false` until then.
   */
  system: Type.Boolean(),
  createdByUserId: Type.Union([Type.String(), Type.Null()]),
  updatedByUserId: Type.Union([Type.String(), Type.Null()]),
  /** ISO datetime string from DB */
  createdAt: Type.String(),
  /** ISO datetime string from DB */
  updatedAt: Type.String(),
})

export type DataTable = Static<typeof DataTableSchema>

/**
 * DataTableListItem — `DataTable` enriched with a live row count.
 *
 * Returned by the `GET /admin/api/cms/data/tables` list endpoint.
 * `rowCount` is computed server-side (subselect on `data_rows`) and is NOT
 * persisted — do not add `rowCount` to `DataTableSchema` or the bundle schema.
 */
export const DataTableListItemSchema = Type.Composite([
  DataTableSchema,
  Type.Object({ rowCount: Type.Number() }),
])

export type DataTableListItem = Static<typeof DataTableListItemSchema>

// ---------------------------------------------------------------------------
// DataRowCells
// ---------------------------------------------------------------------------

export const DataRowCellsSchema = Type.Record(Type.String(), Type.Unknown())

export type DataRowCells = Static<typeof DataRowCellsSchema>

// ---------------------------------------------------------------------------
// DataUserReference (was: ContentUserReference)
// ---------------------------------------------------------------------------

export const DataUserReferenceSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  roleSlug: Type.Union([Type.String(), Type.Null()]),
  roleName: Type.Union([Type.String(), Type.Null()]),
})

export type DataUserReference = Static<typeof DataUserReferenceSchema>

const NullableDataUserReferenceSchema = Type.Union([DataUserReferenceSchema, Type.Null()])
const NullableUserIdSchema = Type.Union([Type.String(), Type.Null()])

// ---------------------------------------------------------------------------
// DataRow — the live, mutable row state.
// ---------------------------------------------------------------------------

export const DataRowSchema = Type.Object({
  id: Type.String(),
  tableId: Type.String(),
  cells: DataRowCellsSchema,
  /** Denormalized from `cells.slug` for fast unique / route lookup. */
  slug: Type.String(),
  status: DataRowStatusSchema,
  authorUserId: NullableUserIdSchema,
  createdByUserId: NullableUserIdSchema,
  updatedByUserId: NullableUserIdSchema,
  publishedByUserId: NullableUserIdSchema,
  author: NullableDataUserReferenceSchema,
  createdBy: NullableDataUserReferenceSchema,
  updatedBy: NullableDataUserReferenceSchema,
  publishedBy: NullableDataUserReferenceSchema,
  /** ISO datetime string from DB */
  createdAt: Type.String(),
  /** ISO datetime string from DB */
  updatedAt: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  /**
   * Wall-clock ISO datetime at which the publish scheduler should fire
   * `publishDataRow(...)` for this row. Set whenever
   * `status === 'scheduled'`; null otherwise. Server-side tick:
   * `server/publish/publishScheduler.ts`. UI entry point: the
   * "Schedule publish…" action in the page/post toolbar.
   */
  scheduledPublishAt: Type.Union([Type.String(), Type.Null()]),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
})

export type DataRow = Static<typeof DataRowSchema>

// ---------------------------------------------------------------------------
// DeletedRowSummary — the narrow shape returned by a soft-delete.
//
// A soft-deleted row is filtered out by the hydrated read (`deleted_at is null`),
// so the delete mutation maps straight from `RETURNING` with NO user-ref joins.
// The result therefore cannot carry `author` / `createdBy` / … — this type says
// so honestly instead of pretending to be a fully-hydrated `DataRow`.
// ---------------------------------------------------------------------------

export const DeletedRowSummarySchema = Type.Object({
  id: Type.String(),
  tableId: Type.String(),
  slug: Type.String(),
  status: DataRowStatusSchema,
  deletedAt: Type.Union([Type.String(), Type.Null()]),
})

export type DeletedRowSummary = Static<typeof DeletedRowSummarySchema>

// ---------------------------------------------------------------------------
// DataRowVersion — one row in data_row_versions.
// ---------------------------------------------------------------------------

export const DataRowVersionSchema = Type.Object({
  id: Type.String(),
  rowId: Type.String(),
  versionNumber: Type.Number(),
  cells: DataRowCellsSchema,
  slug: Type.String(),
  publishedByUserId: Type.Union([Type.String(), Type.Null()]),
  /** ISO datetime string from DB */
  publishedAt: Type.String(),
  /** ISO datetime string from DB */
  createdAt: Type.String(),
})

export type DataRowVersion = Static<typeof DataRowVersionSchema>

// ---------------------------------------------------------------------------
// PublishedDataRow — the active version joined with its table, resolved for
// public-route rendering. `cells` snapshots the version's payload at publish
// time; `featuredMediaPath` is resolved by the publisher when the row carries
// a media cell value (see `resolvePublishedRowMediaPath`).
// ---------------------------------------------------------------------------

export const PublishedDataRowSchema = Type.Object({
  id: Type.String(),
  rowId: Type.String(),
  tableId: Type.String(),
  tableSlug: Type.String(),
  tableKind: DataTableKindSchema,
  tableRouteBase: Type.String(),
  versionNumber: Type.Number(),
  cells: DataRowCellsSchema,
  slug: Type.String(),
  featuredMediaId: Type.Union([Type.String(), Type.Null()]),
  featuredMediaPath: Type.Union([Type.String(), Type.Null()]),
  authorUserId: Type.Union([Type.String(), Type.Null()]),
  authorName: Type.Union([Type.String(), Type.Null()]),
  authorRoleSlug: Type.Union([Type.String(), Type.Null()]),
  authorRoleName: Type.Union([Type.String(), Type.Null()]),
  publishedByUserId: Type.Union([Type.String(), Type.Null()]),
  publishedByName: Type.Union([Type.String(), Type.Null()]),
  publishedByRoleSlug: Type.Union([Type.String(), Type.Null()]),
  publishedByRoleName: Type.Union([Type.String(), Type.Null()]),
  /** ISO datetime string from DB */
  publishedAt: Type.String(),
  /** ISO datetime string from DB */
  createdAt: Type.String(),
})

export type PublishedDataRow = Static<typeof PublishedDataRowSchema>

// ---------------------------------------------------------------------------
// DataRowRedirect — resolved redirect from an old public path.
// ---------------------------------------------------------------------------

export const DataRowRedirectSchema = Type.Object({
  id: Type.String(),
  fromPath: Type.String(),
  targetPath: Type.String(),
})

export type DataRowRedirect = Static<typeof DataRowRedirectSchema>

// ---------------------------------------------------------------------------
// Post-type built-in field ids (reserved).
//
// Tables with `kind: 'postType'` always start with these field ids. The
// Content authoring UI reads/writes these specific keys in `cells_json`.
// Users CAN remove most of them per-table (e.g. a Quotes post type can
// drop `body`, `featuredMedia`, `seoTitle`, `seoDescription`) — but
// `title` and `slug` are mandatory for any post-type table.
// ---------------------------------------------------------------------------

export const POST_TYPE_FIELD_TITLE = 'title'
export const POST_TYPE_FIELD_SLUG = 'slug'
export const POST_TYPE_FIELD_BODY = 'body'
export const POST_TYPE_FIELD_FEATURED_MEDIA = 'featuredMedia'
export const POST_TYPE_FIELD_SEO_TITLE = 'seoTitle'
export const POST_TYPE_FIELD_SEO_DESCRIPTION = 'seoDescription'

export const POST_TYPE_MANDATORY_FIELD_IDS = [
  POST_TYPE_FIELD_TITLE,
  POST_TYPE_FIELD_SLUG,
] as const

export const POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS = [
  POST_TYPE_FIELD_BODY,
  POST_TYPE_FIELD_FEATURED_MEDIA,
  POST_TYPE_FIELD_SEO_TITLE,
  POST_TYPE_FIELD_SEO_DESCRIPTION,
] as const

// ---------------------------------------------------------------------------
// Inputs — for handlers / repositories.
// ---------------------------------------------------------------------------

const CreateDataTableInputSchema = Type.Object({
  name: Type.String(),
  slug: Type.Optional(Type.String()),
  kind: Type.Optional(DataTableKindSchema),
  routeBase: Type.Optional(Type.String()),
  singularLabel: Type.Optional(Type.String()),
  pluralLabel: Type.Optional(Type.String()),
  primaryFieldId: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Array(DataFieldSchema)),
})

export type CreateDataTableInput = Static<typeof CreateDataTableInputSchema>

const UpdateDataTableInputSchema = Type.Object({
  name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  routeBase: Type.Optional(Type.String()),
  singularLabel: Type.Optional(Type.String()),
  pluralLabel: Type.Optional(Type.String()),
  primaryFieldId: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Array(DataFieldSchema)),
})

export type UpdateDataTableInput = Static<typeof UpdateDataTableInputSchema>

const CreateDataRowInputSchema = Type.Object({
  cells: Type.Optional(DataRowCellsSchema),
})

export type CreateDataRowInput = Static<typeof CreateDataRowInputSchema>

const SaveDataRowDraftInputSchema = Type.Object({
  cells: DataRowCellsSchema,
})

export type SaveDataRowDraftInput = Static<typeof SaveDataRowDraftInputSchema>

// ---------------------------------------------------------------------------
// DataMeta — lean binding catalog returned by GET /admin/api/cms/data/_meta.
//
// A stripped-down view of the data tables + fields, designed for use by
// the instatic binding picker. Contains only what the picker needs to
// build its UI: identifiers, labels, types, and a small set of per-type
// extras (mediaKind, allowMultiple, targetTableSlug). Deep field settings
// (options, validation rules, currency, format, …) are intentionally
// omitted — keep the payload lean.
// ---------------------------------------------------------------------------

const DataMetaFieldSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  // NOTE: pageTree and fieldSchema are intentionally excluded — they are
  // structural types not surfaced in the instatic binding catalog.
  type: Type.Union([
    Type.Literal('text'), Type.Literal('longText'), Type.Literal('richText'),
    Type.Literal('number'), Type.Literal('boolean'),
    Type.Literal('date'), Type.Literal('dateTime'),
    Type.Literal('select'), Type.Literal('multiSelect'),
    Type.Literal('url'), Type.Literal('email'),
    Type.Literal('media'), Type.Literal('relation'),
  ]),
  mediaKind: Type.Optional(Type.Union([
    Type.Literal('image'), Type.Literal('video'), Type.Literal('any'),
  ])),
  allowMultiple: Type.Optional(Type.Boolean()),
  /** Resolved slug of the target table. Relation fields only. */
  targetTableSlug: Type.Optional(Type.String()),
})

const DataMetaTableSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  kind: DataTableKindSchema,
  singularLabel: Type.String(),
  pluralLabel: Type.String(),
  primaryFieldId: Type.String(),
  routable: Type.Boolean(),
  versioned: Type.Boolean(),
  fields: Type.Array(DataMetaFieldSchema),
})

export const DataMetaSchema = Type.Object({
  tables: Type.Array(DataMetaTableSchema),
})

export type DataMetaField = Static<typeof DataMetaFieldSchema>
export type DataMetaTable = Static<typeof DataMetaTableSchema>
export type DataMeta = Static<typeof DataMetaSchema>
