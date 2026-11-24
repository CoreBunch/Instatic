import { Type, type Static } from '../utils/typeboxHelpers'

/** Author-supplied contract for a route whose handler runs inside the plugin VM. */
export const PluginRouteDocumentationSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  input: Type.String({ minLength: 1, maxLength: 2048 }),
}, { additionalProperties: false })
export type PluginRouteDocumentation = Static<typeof PluginRouteDocumentationSchema>
