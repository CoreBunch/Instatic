/**
 * Narrowed projection of `DataField` for the plugin boundary.
 *
 * The host's full `DataField` union has 16 types (`src/core/data/schemas.ts`).
 * One is omitted and two are narrowed for the JSON RPC boundary:
 *
 *   - `fieldSchema` — recursive (a field whose value is `DataField[]`).
 *   - `relation`    — exposed as `{ id, targetTableSlug }` only; plugins
 *                     resolve the related row via a second `table(...).get()`.
 *   - `pageTree`    — exposed as a type marker only; mutations go through
 *                     `api.cms.content.tree(...)`.
 *
 * Plugins receive a `PluginContentField[]` from `api.cms.content.tables.get`,
 * which is faithful to the host's catalog for the 15 projected types and
 * intentionally omits `fieldSchema`. Adding new field kinds to the host's
 * union is its own follow-up plan (Gap A.4) — it requires extending this
 * projection in lock-step.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

const PluginRepeaterItemCommon = {
  id: Type.String(),
  label: Type.String(),
  required: Type.Optional(Type.Boolean()),
}

const PluginRepeaterItemFieldSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('longText'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('richText'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('number'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('boolean'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('date'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('dateTime'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('url'), ...PluginRepeaterItemCommon }),
  Type.Object({ type: Type.Literal('email'), ...PluginRepeaterItemCommon }),
  Type.Object({
    type: Type.Literal('select'),
    ...PluginRepeaterItemCommon,
    options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
  }),
  Type.Object({
    type: Type.Literal('multiSelect'),
    ...PluginRepeaterItemCommon,
    options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
  }),
  Type.Object({
    type: Type.Literal('media'),
    ...PluginRepeaterItemCommon,
    mediaKind: Type.Optional(Type.Union([
      Type.Literal('image'),
      Type.Literal('video'),
      Type.Literal('any'),
    ])),
    allowMultiple: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal('relation'),
    ...PluginRepeaterItemCommon,
    targetTableSlug: Type.String(),
    allowMultiple: Type.Optional(Type.Boolean()),
  }),
])

export type PluginRepeaterItemField = Static<typeof PluginRepeaterItemFieldSchema>

export const PluginContentFieldSchema = Type.Union([
  Type.Object({
    type: Type.Literal('text'),
    id: Type.String(),
    label: Type.String(),
    required: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal('longText'),
    id: Type.String(),
    label: Type.String(),
    required: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal('richText'),
    id: Type.String(),
    label: Type.String(),
    required: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal('number'),
    id: Type.String(),
    label: Type.String(),
    required: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal('boolean'),
    id: Type.String(),
    label: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('date'),
    id: Type.String(),
    label: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('dateTime'),
    id: Type.String(),
    label: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('select'),
    id: Type.String(),
    label: Type.String(),
    options: Type.Array(
      Type.Object({ value: Type.String(), label: Type.String() }),
    ),
  }),
  Type.Object({
    type: Type.Literal('multiSelect'),
    id: Type.String(),
    label: Type.String(),
    options: Type.Array(
      Type.Object({ value: Type.String(), label: Type.String() }),
    ),
  }),
  Type.Object({
    type: Type.Literal('url'),
    id: Type.String(),
    label: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('email'),
    id: Type.String(),
    label: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('media'),
    id: Type.String(),
    label: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('relation'),
    id: Type.String(),
    label: Type.String(),
    targetTableSlug: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('repeater'),
    id: Type.String(),
    label: Type.String(),
    required: Type.Optional(Type.Boolean()),
    fields: Type.Array(PluginRepeaterItemFieldSchema),
    itemLabelFieldId: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('pageTree'),
    id: Type.String(),
    label: Type.String(),
  }),
])

export type PluginContentField = Static<typeof PluginContentFieldSchema>
