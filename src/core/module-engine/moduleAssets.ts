import { Type, type Static } from '@core/utils/typeboxHelpers'

/** Payloads belong to the module type, never to an instance's render context. */
export const ModuleAssetsSchema = Type.Object({
  css: Type.Optional(Type.String()),
  js: Type.Optional(Type.String()),
}, { additionalProperties: false })

export type ModuleAssets = Static<typeof ModuleAssetsSchema>

/** A real render may disable an invariant payload for this instance. */
export const ModuleAssetUsageSchema = Type.Object({
  css: Type.Optional(Type.Boolean()),
  js: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })

export type ModuleAssetUsage = Static<typeof ModuleAssetUsageSchema>
