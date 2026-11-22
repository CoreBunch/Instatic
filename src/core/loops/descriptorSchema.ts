/**
 * The descriptor of a plugin's loop source: everything about the source that
 * is data, not code. One schema for both crossings: the plugin's
 * `cms.loops.registerSource` call into the host, and the admin endpoint that
 * hands registered sources to the editor (`RemoteLoopSourceSchema`).
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { PropertySchemaSchema } from '@core/module-engine'
import { LoopItemSchema } from './types'

const LoopSourceFieldSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    format: Type.Optional(Type.Union([
      Type.Literal('plain'),
      Type.Literal('html'),
      Type.Literal('url'),
      Type.Literal('media'),
    ])),
  },
  { additionalProperties: false },
)

const descriptorProperties = {
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  filterSchema: PropertySchemaSchema,
  orderByOptions: Type.Array(Type.Object(
    {
      id: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  )),
  fields: Type.Array(LoopSourceFieldSchema),
  // Direction a loop uses until its author picks one. Unset: `'asc'`.
  defaultDirection: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
  // Layer C dynamic-island flags. `requestDependent` marks the source's
  // output as request-time (becomes a cached hole); `perVisitor` marks it
  // uncacheable + cookie-aware. Optional — built-in sources leave both unset.
  requestDependent: Type.Optional(Type.Boolean()),
  perVisitor: Type.Optional(Type.Boolean()),
}

export const LoopSourceDescriptorSchema = Type.Object(descriptorProperties, {
  additionalProperties: false,
})

/** A registered plugin source as the editor receives it: descriptor plus owner. */
export const RemoteLoopSourceSchema = Type.Object(
  {
    ...descriptorProperties,
    provider: Type.Object(
      { pluginId: Type.String({ minLength: 1 }), pluginName: Type.String() },
      { additionalProperties: false },
    ),
    /**
     * Opaque, and new on every load of the plugin. Sample items an editor
     * holds for the source belong to the revision they were asked under.
     */
    revision: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)
export type RemoteLoopSource = Static<typeof RemoteLoopSourceSchema>

/**
 * Most sample items one preview may return. The canvas shows at most six
 * iterations; the rest of the room is for an offset.
 */
export const LOOP_PREVIEW_MAX_ITEMS = 12

/** The `code` of the 429 the server answers while a plugin's previews are busy. */
export const LOOP_PREVIEW_BUSY_CODE = 'preview_busy'

/** Largest preview answer the host passes on: bytes of its JSON in UTF-8. */
export const LOOP_PREVIEW_MAX_BYTES = 256 * 1024

/** What the editor asks a plugin source's preview for. */
export const LoopSourcePreviewRequestSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 200 }),
    filters: Type.Record(Type.String(), Type.Unknown()),
    limit: Type.Integer({ minimum: 1, maximum: LOOP_PREVIEW_MAX_ITEMS }),
  },
  { additionalProperties: false },
)
export type LoopSourcePreviewRequest = Static<typeof LoopSourcePreviewRequestSchema>

export const LoopSourcePreviewItemsSchema = Type.Array(LoopItemSchema, {
  maxItems: LOOP_PREVIEW_MAX_ITEMS,
})
