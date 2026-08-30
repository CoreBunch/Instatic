import { Type, type Static } from '@core/utils/typeboxHelpers'
import { ImportResultSchema, SiteBundleSchema } from '@core/data/bundleSchema'

export const StagingSyncStatusSchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('failed'),
])

export type StagingSyncStatus = Static<typeof StagingSyncStatusSchema>

export const StagingEnvironmentSchema = Type.Object({
  configured: Type.Boolean(),
  origin: Type.Union([Type.String(), Type.Null()]),
  hasToken: Type.Boolean(),
  keyFingerprintCurrent: Type.Boolean(),
  tableIds: Type.Array(Type.String()),
  includeSite: Type.Boolean(),
  lastSyncAt: Type.Union([Type.String(), Type.Null()]),
  lastSyncStatus: Type.Union([StagingSyncStatusSchema, Type.Null()]),
  lastSyncError: Type.Union([Type.String(), Type.Null()]),
})

export type StagingEnvironment = Static<typeof StagingEnvironmentSchema>

export const SaveStagingEnvironmentSchema = Type.Object({
  origin: Type.String({ minLength: 1, maxLength: 2048 }),
  token: Type.Optional(Type.String({ minLength: 16, maxLength: 4096 })),
  tableIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  includeSite: Type.Boolean(),
})

export type SaveStagingEnvironment = Static<typeof SaveStagingEnvironmentSchema>

export const StagingConnectionResultSchema = Type.Object({
  ok: Type.Literal(true),
  origin: Type.String(),
})

export const StagingReceiverStatusSchema = Type.Object({
  ok: Type.Literal(true),
  environment: Type.Literal('staging'),
})

export const StagingSyncPayloadSchema = Type.Object({
  mode: Type.Union([Type.Literal('full'), Type.Literal('selected')]),
  bundle: SiteBundleSchema,
})

export type StagingSyncPayload = Static<typeof StagingSyncPayloadSchema>

export const StagingRefreshResultSchema = Type.Object({
  ok: Type.Literal(true),
  origin: Type.String(),
  publishedPages: Type.Number(),
  import: ImportResultSchema,
})

export type StagingRefreshResult = Static<typeof StagingRefreshResultSchema>
