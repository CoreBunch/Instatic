/**
 * Site plugin source model — schemas and constants.
 *
 * Site plugins are authored in the site draft under `plugins/<local-id>/`
 * as `SiteFile` entries with `type: 'plugin'`, and compiled server-side
 * into packages byte-compatible with installed plugins (runtime id
 * `site.<local-id>`). Design: docs/features/site-plugins.md.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { MANIFEST_AUTHOR_FIELD_SCHEMAS, SITE_PLUGIN_ID_PREFIX } from '@core/plugins/manifest'

export const SITE_PLUGIN_SOURCE_ROOT = 'plugins/'

/**
 * `<local-id>` is a single lowercase kebab-case segment (no dots), so the
 * runtime id `site.<local-id>` is always well-formed and unambiguous.
 */
export const SITE_PLUGIN_LOCAL_ID_PATTERN = /^[a-z][a-z0-9-]*$/

export function sitePluginIdFromLocalId(localId: string): string {
  return `${SITE_PLUGIN_ID_PREFIX}${localId}`
}

/** Strip the `site.` prefix; null when the id is not a site plugin id. */
export function localIdFromSitePluginId(pluginId: string): string | null {
  if (!pluginId.startsWith(SITE_PLUGIN_ID_PREFIX)) return null
  const localId = pluginId.slice(SITE_PLUGIN_ID_PREFIX.length)
  return SITE_PLUGIN_LOCAL_ID_PATTERN.test(localId) ? localId : null
}

export function sitePluginFolder(localId: string): string {
  return `${SITE_PLUGIN_SOURCE_ROOT}${localId}/`
}

/**
 * Author-owned subset of the plugin manifest (design: "plugin.json —
 * author-owned fields only"). Everything else — `id`, `version`,
 * `apiVersion`, `entrypoints`, `assetBasePath`, `pack` — is derived by the
 * build from the folder convention and REJECTED here if hand-set
 * (`additionalProperties: false`), so a manifest copy-pasted from an
 * installed plugin fails loudly instead of drifting.
 *
 * Field shapes reuse the runtime manifest's own sub-schemas
 * (`MANIFEST_AUTHOR_FIELD_SCHEMAS` in `@core/plugins/manifest`) — one
 * source of truth, no duplicated shapes.
 */
export const SitePluginDraftManifestSchema = Type.Object(
  {
    ...MANIFEST_AUTHOR_FIELD_SCHEMAS,
    // The runtime schema gives these `default` values and relies on the
    // Value.Parse pipeline to apply them; the draft is validated with the
    // compiled Check (no Default pass), so they must be genuinely optional
    // here — `parsePluginManifest` applies the defaults downstream.
    permissions: Type.Optional(MANIFEST_AUTHOR_FIELD_SCHEMAS.permissions),
    resources: Type.Optional(MANIFEST_AUTHOR_FIELD_SCHEMAS.resources),
    adminPages: Type.Optional(MANIFEST_AUTHOR_FIELD_SCHEMAS.adminPages),
  },
  { additionalProperties: false },
)
export type SitePluginDraftManifest = Static<typeof SitePluginDraftManifestSchema>

/** The manifest fields the build derives — named for error messages. */
export const SITE_PLUGIN_DERIVED_FIELDS = [
  'id',
  'version',
  'apiVersion',
  'entrypoints',
  'assetBasePath',
  'pack',
  'grantedPermissions',
  'icon',
] as const
