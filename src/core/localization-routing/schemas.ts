import { Type, type Static } from '@core/utils/typeboxHelpers'
import { LocaleSchema } from '@core/localization-schema'

const PublishedContentIdentity = {
  contentId: Type.String({ minLength: 1 }),
  localeId: Type.String({ minLength: 1 }),
  publishedVersionId: Type.String({ minLength: 1 }),
  siteSnapshotId: Type.Optional(Type.String({ minLength: 1 })),
  tableId: Type.String({ minLength: 1 }),
  tableSlug: Type.String({ minLength: 1 }),
  publishedAt: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  languageCode: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
}

export const PublishedRouteSchema = Type.Object({
  ...PublishedContentIdentity,
  kind: Type.Union([Type.Literal('page'), Type.Literal('row')]),
  path: Type.String({ minLength: 1 }),
})

export const PublishedDependencySchema = Type.Object({
  ...PublishedContentIdentity,
  kind: Type.Literal('template'),
})

/** Serializable live routing state. Templates are dependencies, never URLs. */
export const PublishedRouteManifestSchema = Type.Object({
  locales: Type.Array(LocaleSchema),
  routes: Type.Array(PublishedRouteSchema),
  dependencies: Type.Array(PublishedDependencySchema),
})

export type PublishedRoute = Static<typeof PublishedRouteSchema>
export type PublishedDependency = Static<typeof PublishedDependencySchema>
export type PublishedRouteManifest = Static<typeof PublishedRouteManifestSchema>

export const PublishedRouteCandidateSchema = Type.Object({
  ...PublishedContentIdentity,
  publishedVersionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  kind: Type.Union([Type.Literal('page'), Type.Literal('row'), Type.Literal('template')]),
  path: Type.Optional(Type.String()),
  availability: Type.Union([Type.Literal('online'), Type.Literal('offline')]),
})

export type PublishedRouteCandidate = Static<typeof PublishedRouteCandidateSchema>

export const LanguageAlternativeSchema = Type.Object({
  localeId: Type.String(),
  code: Type.String(),
  name: Type.String(),
  path: Type.String(),
  current: Type.Boolean(),
})
export type LanguageAlternative = Static<typeof LanguageAlternativeSchema>
