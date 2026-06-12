import { Type, type Static } from '@core/utils/typeboxHelpers'

const PropertyConditionSchema = Type.Recursive((Self) => Type.Union([
  Type.Object(
    { field: Type.String({ minLength: 1 }), eq: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { field: Type.String({ minLength: 1 }), notEq: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { field: Type.String({ minLength: 1 }), in: Type.Array(Type.Unknown()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { field: Type.String({ minLength: 1 }), notIn: Type.Array(Type.Unknown()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { and: Type.Array(Self) },
    { additionalProperties: false },
  ),
  Type.Object(
    { or: Type.Array(Self) },
    { additionalProperties: false },
  ),
]))

const PropertyControlLayoutSchema = Type.Union([
  Type.Literal('inline'),
  Type.Literal('stacked'),
])

const TextControlNormalizeSchema = Type.Literal('identifier')

/**
 * Edit-permission category for a property control.
 *
 * - `content` — text/copy/media that an end-client can change without altering
 *   visual design (text strings, image src/alt, link href). The "Client" role
 *   (`site.content.edit`) is allowed to modify these.
 * - `layout`  — tag selection, ordering, structural numbers (min/max items,
 *   columns). Treated as structural and gated behind `site.structure.edit`.
 *
 * When omitted, the category is inferred from the control `type`:
 *   text / textarea / richtext / url / image / media → 'content'
 *   everything else → 'layout'
 *
 * Module authors should override the default when the heuristic is wrong
 * (e.g. a `select` whose options are "Heading 1" / "Heading 2" — that is
 * content from a copy-editor's point of view and should be opted into
 * 'content' explicitly).
 */
const PropertyControlCategorySchema = Type.Union([
  Type.Literal('content'),
  Type.Literal('layout'),
])

const PropertyControlBaseSchema = {
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  condition: Type.Optional(PropertyConditionSchema),
  layout: Type.Optional(PropertyControlLayoutSchema),
  breakpointOverridable: Type.Optional(Type.Boolean()),
  /** Edit-permission category — see `PropertyControlCategorySchema`. */
  category: Type.Optional(PropertyControlCategorySchema),
  /**
   * Hidden controls carry a declared `type` for engine purposes (the publisher
   * dispatches escaping on it — see `escapeProps`) but render NO editor control.
   * Use for publisher-injected binding targets the author never hand-edits,
   * e.g. `base.outlet.html`, which the publisher fills with the current entry's
   * richtext body. Without the declared type the prop would fall to the
   * escapeHtml default and its sanitised richtext would be entity-encoded.
   */
  hidden: Type.Optional(Type.Boolean()),
}

const PropertyControlOptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
)

export const PropertyControlSchema = Type.Recursive((Self) => Type.Union([
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('text'),
      placeholder: Type.Optional(Type.String()),
      normalize: Type.Optional(TextControlNormalizeSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('textarea'),
      rows: Type.Optional(Type.Number()),
      placeholder: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('number'),
      min: Type.Optional(Type.Number()),
      max: Type.Optional(Type.Number()),
      step: Type.Optional(Type.Number()),
      unit: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('color'),
      format: Type.Optional(Type.Union([Type.Literal('hex'), Type.Literal('rgba')])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('select'),
      options: Type.Array(PropertyControlOptionSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...PropertyControlBaseSchema, type: Type.Literal('toggle') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...PropertyControlBaseSchema, type: Type.Literal('image') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('media'),
      mediaKind: Type.Union([Type.Literal('image'), Type.Literal('video')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...PropertyControlBaseSchema, type: Type.Literal('url') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('dataTable'),
      includeSystem: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...PropertyControlBaseSchema, type: Type.Literal('richtext') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...PropertyControlBaseSchema, type: Type.Literal('svg') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PropertyControlBaseSchema,
      type: Type.Literal('group'),
      collapsed: Type.Optional(Type.Boolean()),
      children: Type.Record(Type.String(), Self),
    },
    { additionalProperties: false },
  ),
]))

export type PropertyControl = Static<typeof PropertyControlSchema>

/**
 * Maps each flat prop key to a PropertyControl descriptor. Use
 * `type: 'group'` for visual grouping only; it does not nest the data shape.
 */
export const PropertySchemaSchema = Type.Unsafe<Record<string, PropertyControl>>(
  Type.Record(Type.String(), PropertyControlSchema),
)

export type PropertyCondition = Static<typeof PropertyConditionSchema>
export type PropertyControlLayout = Static<typeof PropertyControlLayoutSchema>
export type TextControlNormalize = Static<typeof TextControlNormalizeSchema>
type PropertyControlCategory = Static<typeof PropertyControlCategorySchema>
export type PropertySchema = Static<typeof PropertySchemaSchema>

// ---------------------------------------------------------------------------
// resolvePropertyControlCategory — single source of truth for the
// type-based default applied when a control does not declare `category`.
//
// Used by:
//   - the editor PropertyControlRenderer to compute the disabled overlay
//     when a content-only role hits a non-content control
//   - the server `siteDiff` validator to classify prop edits when the caller
//     is a content-only role
// ---------------------------------------------------------------------------

const CONTENT_CONTROL_TYPES: ReadonlySet<PropertyControl['type']> = new Set([
  'text',
  'textarea',
  'richtext',
  'svg',
  'url',
  'image',
  'media',
])

export function resolvePropertyControlCategory(control: PropertyControl): PropertyControlCategory {
  if (control.category) return control.category
  return CONTENT_CONTROL_TYPES.has(control.type) ? 'content' : 'layout'
}
