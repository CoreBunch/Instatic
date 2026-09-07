import { Type, type Static } from '@core/utils/typeboxHelpers'
import { LocaleSchema, FieldLocalizationSchema } from '@core/localization-schema'
import { DataRowStatusSchema } from '@core/data/schemas'

const CurrentUserSchema = Type.Object({ id: Type.String(), displayName: Type.String(), email: Type.String() })
const FieldInfoSchema = Type.Object({
  id: Type.String(), label: Type.String(), type: Type.String(), required: Type.Boolean(), builtIn: Type.Boolean(),
  localization: Type.Optional(FieldLocalizationSchema),
  options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: Type.String() }))),
  targetTableSlug: Type.Optional(Type.String()), mediaKind: Type.Optional(Type.String()), allowMultiple: Type.Optional(Type.Boolean()),
})
const ActiveDocumentSchema = Type.Object({
  id: Type.String(), tableId: Type.String(), localeId: Type.Optional(Type.String()), title: Type.String(), slug: Type.String(),
  status: DataRowStatusSchema, fields: Type.Record(Type.String(), Type.Unknown()), schema: Type.Array(FieldInfoSchema),
  authorUserId: Type.Union([Type.String(), Type.Null()]), updatedAt: Type.String(),
})
export const ContentAgentSnapshotSchema = Type.Object({
  localeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  locales: Type.Optional(Type.Array(LocaleSchema)),
  collections: Type.Array(Type.Object({ id: Type.String(), slug: Type.String(), label: Type.String(), kind: Type.String(), docCount: Type.Number() })),
  activeTableId: Type.Union([Type.String(), Type.Null()]),
  activeDocument: Type.Union([ActiveDocumentSchema, Type.Null()]),
  currentUser: CurrentUserSchema,
})
export type ContentAgentCurrentUser = Static<typeof CurrentUserSchema>
export type ContentAgentFieldInfo = Static<typeof FieldInfoSchema>
export type ContentAgentActiveDocument = Static<typeof ActiveDocumentSchema>
export type ContentAgentSnapshot = Static<typeof ContentAgentSnapshotSchema>
