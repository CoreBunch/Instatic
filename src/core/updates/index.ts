import { Type, type Static } from '@sinclair/typebox'

export const INSTATIC_RELEASES_URL = 'https://github.com/CoreBunch/Instatic/releases'
export const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000

export const BuildInfoSchema = Type.Object({
  version: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Union([Type.String(), Type.Null()]),
  source: Type.Union([Type.Literal('artifact'), Type.Literal('environment'), Type.Literal('package')]),
})

const ReleaseSchema = Type.Object({
  version: Type.String(),
  url: Type.String({ pattern: '^https://github\\.com/CoreBunch/Instatic/releases/tag/[^/?#]+$' }),
  publishedAt: Type.String(),
})

export const UpdateStatusSchema = Type.Object({
  build: BuildInfoSchema,
  latest: Type.Union([ReleaseSchema, Type.Null()]),
  comparison: Type.Union([
    Type.Literal('update-available'), Type.Literal('current'),
    Type.Literal('ahead'), Type.Literal('unknown'),
  ]),
  checkedAt: Type.Union([Type.Number(), Type.Null()]),
  stale: Type.Boolean(),
  error: Type.Union([Type.String(), Type.Null()]),
  nextCheckAt: Type.Number(),
})

export const UpdateDetailsSchema = Type.Object({
  ...UpdateStatusSchema.properties,
  releaseNotes: Type.Union([Type.String({ maxLength: 12000 }), Type.Null()]),
})

export type BuildInfo = Static<typeof BuildInfoSchema>
export type UpdateStatus = Static<typeof UpdateStatusSchema>
export type UpdateDetails = Static<typeof UpdateDetailsSchema>
