import { Type, type Static } from '@core/utils/typeboxHelpers'

const SAFE_ARTIFACT_RELATIVE_PATH = '^(?![\\/])(?!.*(?:^|[\\/])\\.\\.(?:[\\/]|$)).+$'

export const SiteArtifactRouteKindSchema = Type.Union([
  Type.Literal('page'),
  Type.Literal('content'),
  Type.Literal('notFound'),
])

export const SiteArtifactRequirementCodeSchema = Type.Union([
  Type.Literal('dynamic-holes'),
  Type.Literal('infinite-loops'),
  Type.Literal('cms-forms'),
  Type.Literal('proxied-media'),
  Type.Literal('plugin-frontend-assets'),
  Type.Literal('plugin-public-routes'),
])

export const SiteArtifactRouteSchema = Type.Object({
  path: Type.String({ pattern: '^/' }),
  file: Type.String({ pattern: SAFE_ARTIFACT_RELATIVE_PATH }),
  kind: SiteArtifactRouteKindSchema,
})

export const SiteArtifactRequirementSchema = Type.Object({
  code: SiteArtifactRequirementCodeSchema,
  message: Type.String({ minLength: 1 }),
})

export const SiteArtifactUploadedFileSchema = Type.Object({
  publicPath: Type.String({ pattern: '^/uploads/' }),
  storagePath: Type.String({ pattern: SAFE_ARTIFACT_RELATIVE_PATH }),
})

export const SiteArtifactManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  artifactId: Type.String({ minLength: 1 }),
  siteId: Type.String({ minLength: 1 }),
  publishedAt: Type.String({
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$',
  }),
  publishVersion: Type.Integer({ minimum: 1 }),
  routes: Type.Array(SiteArtifactRouteSchema),
  uploadedFiles: Type.Array(SiteArtifactUploadedFileSchema),
  runtimePackageCache: Type.Optional(Type.Object({
    hash: Type.String({ pattern: '^[a-f0-9]{24}$' }),
  })),
  deployment: Type.Object({
    mode: Type.Literal('static'),
    portable: Type.Boolean(),
    requirements: Type.Array(SiteArtifactRequirementSchema),
  }),
})

export type SiteArtifactManifest = Static<typeof SiteArtifactManifestSchema>
export type SiteArtifactUploadedFile = Static<typeof SiteArtifactUploadedFileSchema>
export type SiteArtifactRequirement = Static<typeof SiteArtifactRequirementSchema>
export type SiteArtifactRequirementCode = Static<typeof SiteArtifactRequirementCodeSchema>
export type SiteArtifactRoute = Static<typeof SiteArtifactRouteSchema>
export type SiteArtifactRouteKind = Static<typeof SiteArtifactRouteKindSchema>
