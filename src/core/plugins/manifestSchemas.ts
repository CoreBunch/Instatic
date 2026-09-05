/**
 * Plugin manifest schemas — patterns, sub-schemas, the runtime manifest
 * schema, and the author-owned field record shared with the site plugin
 * draft manifest. The PARSER (validation + coherence checks) lives in
 * `./manifest.ts`; this module owns only shapes so both stay under the
 * module-size ceiling with one clear responsibility each.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { PLUGIN_PERMISSION_VALUES } from '@core/plugin-sdk'

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/

/**
 * The `site.` id namespace is reserved for site plugins generated from the
 * site draft (docs/features/site-plugins.md). Uploaded zip packages must
 * never claim it — enforced at the zip boundary (`readPluginPackage`), NOT
 * here in the parser, because generated site-plugin packages parse through
 * `parsePluginManifest` with `site.*` ids.
 */
export const SITE_PLUGIN_ID_PREFIX = 'site.'

export function isReservedSitePluginId(id: string): boolean {
  return id.startsWith(SITE_PLUGIN_ID_PREFIX)
}
/**
 * Used for resource IDs and admin page IDs — these become URL path segments,
 * so they are restricted to lowercase kebab-case.
 * Examples: `subscribers`, `seo-entries`, `my-posts`
 */
export const MANIFEST_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/
/**
 * Used for resource field IDs — these are JSON object keys only, not URL
 * segments. Allows camelCase, snake_case, and kebab-case.
 * Examples: `email`, `subscribedAt`, `page_id`, `first-name`
 */
export const RESOURCE_FIELD_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
export const SEMVERISH_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?$/
export const SAFE_ASSET_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/
// `assetBasePath` is server-controlled. The only legitimate shape is
// `/uploads/plugins/{pluginId}/{version}` (optionally trailing `/`),
// produced by `writePluginPackageFiles` on zip install. Any other shape
// — including `..` traversal, empty segments, or non-uploads paths —
// is rejected at the schema boundary so it can't reach the filesystem
// sinks (`loadServerPluginModule`, `removePluginAssets`).
export const ASSET_BASE_PATH_PATTERN =
  /^\/uploads\/plugins\/[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?\/?$/
// `adminPages[].content.assetPath` (app pages) — must look like an uploads
// path with no `.`/`..` segments. The post-check in `parsePluginManifest`
// further pins it to the declaring plugin's own asset subtree.
export const ADMIN_APP_ASSET_PATH_PATTERN =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))\/uploads\/plugins\/[a-zA-Z0-9._/-]+$/
// Outbound network allowlist: lowercase hostname, optional leading `*.`
// wildcard. No paths, ports, query strings — just the host. This is the
// allowlist the host's `network.fetch` bridge checks against.
export const NETWORK_HOST_PATTERN = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

const permissionSchema = Type.Union(
  PLUGIN_PERMISSION_VALUES.map((v) => Type.Literal(v)),
)

const pinSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  detail: Type.Optional(Type.String({ maxLength: 160 })),
  x: Type.Number({ minimum: 0, maximum: 100 }),
  y: Type.Number({ minimum: 0, maximum: 100 }),
})

// `pins` is optional in the schema so the union default can be handled
// explicitly in parsePluginManifest post-processing (TypeBox union defaults
// are not reliably applied within discriminated-union variants).
const contentSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('markdown'),
    heading: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    body: Type.String({ maxLength: 20_000 }),
  }),
  Type.Object({
    kind: Type.Literal('map'),
    heading: Type.String({ minLength: 1, maxLength: 120 }),
    body: Type.Optional(Type.String({ maxLength: 500 })),
    centerLabel: Type.Optional(Type.String({ maxLength: 80 })),
    pins: Type.Optional(Type.Array(pinSchema, { maxItems: 40 })),
  }),
  Type.Object({
    kind: Type.Literal('resource'),
    heading: Type.String({ minLength: 1, maxLength: 120 }),
    resource: Type.String({ pattern: MANIFEST_SLUG_PATTERN.source }),
  }),
  Type.Object({
    kind: Type.Literal('app'),
    heading: Type.String({ minLength: 1, maxLength: 120 }),
    entry: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
    // Optional override for where the host resolves `entry` from; defaults
    // to the plugin's `assetBasePath`. The schema pattern rejects dot
    // segments and foreign URL shapes; parsePluginManifest additionally
    // pins the path to THIS plugin's own `/uploads/plugins/{id}/{version}`
    // subtree so a manifest can't point the admin shell's dynamic import()
    // at an arbitrary location.
    assetPath: Type.Optional(Type.String({
      pattern: ADMIN_APP_ASSET_PATH_PATTERN.source,
      maxLength: 500,
    })),
  }),
])

const resourceFieldSchema = Type.Object({
  id: Type.String({ pattern: RESOURCE_FIELD_ID_PATTERN.source }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  type: Type.Union([
    Type.Literal('text'),
    Type.Literal('longtext'),
    Type.Literal('number'),
    Type.Literal('date'),
    Type.Literal('boolean'),
  ]),
  required: Type.Optional(Type.Boolean()),
})

const resourceSchema = Type.Object({
  id: Type.String({ pattern: MANIFEST_SLUG_PATTERN.source }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  singularLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  pluralLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  fields: Type.Array(resourceFieldSchema, { minItems: 1, maxItems: 50 }),
})

const adminPageSchema = Type.Object({
  id: Type.String({ pattern: MANIFEST_SLUG_PATTERN.source }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  navLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  icon: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  route: Type.Optional(Type.String()),
  content: contentSchema,
})

// `settings` schema — a discriminated union over the supported types, mirroring
// `PluginSettingDefinition` in `src/core/plugin-sdk/builders/settings.ts`.
// The Static type of each variant is assignment-compatible with the
// corresponding `PluginSettingDefinition` branch (Array<T> extends
// ReadonlyArray<T>), so parsePluginManifest needs no cast for `settings`.
const SETTING_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

// Base properties shared by every setting variant.
const settingBaseProps = {
  id: Type.String({ pattern: SETTING_ID_PATTERN.source }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  required: Type.Optional(Type.Boolean()),
  secret: Type.Optional(Type.Boolean()),
}

const settingOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  value: Type.String({ minLength: 1, maxLength: 80 }),
})

const settingDefinitionSchema = Type.Union([
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('text'),
    placeholder: Type.Optional(Type.String({ maxLength: 120 })),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('textarea'),
    placeholder: Type.Optional(Type.String({ maxLength: 120 })),
    rows: Type.Optional(Type.Number({ minimum: 1 })),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('number'),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    step: Type.Optional(Type.Number()),
    unit: Type.Optional(Type.String({ maxLength: 16 })),
    default: Type.Optional(Type.Number()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('toggle'),
    default: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('select'),
    // Required field — a select setting must declare its options.
    options: Type.Array(settingOptionSchema, { minItems: 1 }),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('color'),
    format: Type.Optional(Type.Union([Type.Literal('hex'), Type.Literal('rgba')])),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('url'),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('password'),
    placeholder: Type.Optional(Type.String({ maxLength: 120 })),
    default: Type.Optional(Type.String()),
  }),
])

// Marketplace metadata — author, license, URLs, keywords, visual icon.
// Validated at the manifest boundary so a malicious zip can't inject
// arbitrary HTML or filesystem-traversing icon paths.
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+$/
const EMAIL_PATTERN = /^[^\s<>"'`@]+@[^\s<>"'`@]+\.[^\s<>"'`@]+$/
const SPDX_PATTERN = /^[A-Za-z0-9.+-]{1,40}$/
const KEYWORD_PATTERN = /^[A-Za-z0-9_-]{1,30}$/
const ICON_PATH_PATTERN = /^[a-zA-Z0-9._-]+\.(png|svg|webp|jpg|jpeg)$/

const authorSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  email: Type.Optional(Type.String({ pattern: EMAIL_PATTERN.source, maxLength: 240 })),
  url: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
})

// ---------------------------------------------------------------------------
// Frontend assets — shared schemas referenced by the manifest below.
// ---------------------------------------------------------------------------

const FrontendAssetPlacementSchema = Type.Union([
  Type.Literal('head'),
  Type.Literal('head-end'),
  Type.Literal('body-start'),
  Type.Literal('body-end'),
])

// HTML attribute name: lowercase letters / digits / dashes / colon / underscore.
// Restricts what plugins can spell so a malformed declaration can't smuggle
// in arbitrary HTML by setting an attribute named `>`. Values are
// HTML-escaped at render time.
const FRONTEND_ATTR_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_:-]*$/

const FrontendAssetAttrsSchema = Type.Record(
  Type.String({ pattern: FRONTEND_ATTR_NAME_PATTERN.source, maxLength: 64 }),
  Type.String({ maxLength: 4096 }),
)

/**
 * Manifest fields a plugin AUTHOR owns — shared verbatim with the site
 * plugin draft-manifest schema (`@core/site-plugins`), which is exactly
 * "author fields, nothing derived". Deliberately excludes `id`, `version`,
 * `apiVersion`, `entrypoints`, `assetBasePath`, `grantedPermissions`
 * (derived / host-owned) and `icon` (needs a build-side asset copy that
 * site plugins don't support yet).
 */
export const MANIFEST_AUTHOR_FIELD_SCHEMAS = {
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  author: Type.Optional(authorSchema),
  license: Type.Optional(Type.String({ pattern: SPDX_PATTERN.source })),
  homepage: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
  repository: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
  keywords: Type.Optional(Type.Array(Type.String({ pattern: KEYWORD_PATTERN.source }), { maxItems: 20 })),
  permissions: Type.Array(permissionSchema, { default: [] }),
  // Per-host allowlist for outbound HTTP. Plain hostnames (`api.example.com`)
  // match exactly; the leading `*.` wildcard matches one subdomain segment.
  // Hostnames are normalized (lowercased, trimmed) at manifest parse time.
  networkAllowedHosts: Type.Optional(Type.Array(
    Type.String({ pattern: NETWORK_HOST_PATTERN.source, maxLength: 253 }),
    { maxItems: 50 },
  )),
  // Per-table allowlist for the `api.cms.content.*` surface. The host
  // additionally enforces that each `mode` matches a granted permission
  // at install time (`assertContentAccessCoherent` below).
  contentAccess: Type.Optional(Type.Array(
    Type.Object({
      table: Type.String({ pattern: MANIFEST_SLUG_PATTERN.source, maxLength: 80 }),
      modes: Type.Array(
        Type.Union([
          Type.Literal('read'),
          Type.Literal('write'),
          Type.Literal('publish'),
          Type.Literal('delete'),
        ]),
        { minItems: 1 },
      ),
    }, { additionalProperties: false }),
    { maxItems: 50 },
  )),
  resources: Type.Array(resourceSchema, { maxItems: 20, default: [] }),
  adminPages: Type.Array(adminPageSchema, { maxItems: 20, default: [] }),
  settings: Type.Optional(Type.Array(settingDefinitionSchema, { maxItems: 50 })),
  /**
   * Declarative frontend tag list — scripts, styles, meta, link, and shared
   * host-runtime references the host injects into every published page on
   * behalf of this plugin. Validated structurally here; the host's frontend
   * injection pipeline reads the array at publish time and emits the actual
   * tags. Requires the `frontend.assets` permission (coherence checked
   * downstream in `parsePluginManifest`).
   */
  frontend: Type.Optional(Type.Object({
    assets: Type.Array(
      Type.Union([
        Type.Object({
          kind: Type.Literal('script'),
          src: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
          placement: Type.Optional(FrontendAssetPlacementSchema),
          strategy: Type.Optional(Type.Union([
            Type.Literal('defer'),
            Type.Literal('async'),
            Type.Literal('module'),
            Type.Literal('sync'),
          ])),
          attrs: Type.Optional(FrontendAssetAttrsSchema),
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('script-inline'),
          content: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
          placement: Type.Optional(FrontendAssetPlacementSchema),
          attrs: Type.Optional(FrontendAssetAttrsSchema),
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('style'),
          href: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
          placement: Type.Optional(FrontendAssetPlacementSchema),
          attrs: Type.Optional(FrontendAssetAttrsSchema),
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('style-inline'),
          content: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
          placement: Type.Optional(FrontendAssetPlacementSchema),
          attrs: Type.Optional(FrontendAssetAttrsSchema),
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('link'),
          attrs: FrontendAssetAttrsSchema,
          placement: Type.Optional(FrontendAssetPlacementSchema),
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('meta'),
          attrs: FrontendAssetAttrsSchema,
          placement: Type.Optional(FrontendAssetPlacementSchema),
        }, { additionalProperties: false }),
      ]),
      { maxItems: 50 },
    ),
  })),
} as const

export const manifestSchema = Type.Object({
  id: Type.String({ pattern: PLUGIN_ID_PATTERN.source }),
  name: MANIFEST_AUTHOR_FIELD_SCHEMAS.name,
  version: Type.String({ pattern: SEMVERISH_PATTERN.source }),
  // Schema accepts any positive integer; the parser narrows to the
  // host-supported range via `isCompatiblePluginApiVersion`. Rejecting at
  // a literal would force every old plugin offline the day a host bumps
  // PLUGIN_API_VERSION, even when the host explicitly wants to keep
  // serving older plugins via MIN_SUPPORTED_PLUGIN_API_VERSION.
  apiVersion: Type.Integer({ minimum: 1 }),
  description: MANIFEST_AUTHOR_FIELD_SCHEMAS.description,
  author: MANIFEST_AUTHOR_FIELD_SCHEMAS.author,
  license: MANIFEST_AUTHOR_FIELD_SCHEMAS.license,
  homepage: MANIFEST_AUTHOR_FIELD_SCHEMAS.homepage,
  repository: MANIFEST_AUTHOR_FIELD_SCHEMAS.repository,
  keywords: MANIFEST_AUTHOR_FIELD_SCHEMAS.keywords,
  icon: Type.Optional(Type.String({ pattern: ICON_PATH_PATTERN.source, maxLength: 80 })),
  permissions: MANIFEST_AUTHOR_FIELD_SCHEMAS.permissions,
  grantedPermissions: Type.Optional(Type.Array(permissionSchema)),
  networkAllowedHosts: MANIFEST_AUTHOR_FIELD_SCHEMAS.networkAllowedHosts,
  contentAccess: MANIFEST_AUTHOR_FIELD_SCHEMAS.contentAccess,
  entrypoints: Type.Optional(Type.Object({
    server: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    editor: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    admin: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    modules: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
  })),
  frontend: MANIFEST_AUTHOR_FIELD_SCHEMAS.frontend,
  assetBasePath: Type.Optional(Type.String({ pattern: ASSET_BASE_PATH_PATTERN.source })),
  resources: MANIFEST_AUTHOR_FIELD_SCHEMAS.resources,
  adminPages: MANIFEST_AUTHOR_FIELD_SCHEMAS.adminPages,
  pack: Type.Optional(Type.Object({
    path: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
  })),
  settings: MANIFEST_AUTHOR_FIELD_SCHEMAS.settings,
})


export type ManifestRaw = Static<typeof manifestSchema>
