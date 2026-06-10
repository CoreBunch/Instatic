import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import { compiled } from '@core/utils/typeboxCompiler'
import type {
  PluginAdminPage,
  PluginManifest,
  PluginPermission,
  PluginPageContent,
  PluginResource,
} from '@core/plugin-sdk'
import {
  isCompatiblePluginApiVersion,
  MIN_SUPPORTED_PLUGIN_API_VERSION,
  PLUGIN_API_VERSION,
  PLUGIN_PERMISSION_VALUES,
  permissionLabel as sdkPermissionLabel,
} from '@core/plugin-sdk'
import { collectEnabledAdminPages, pluginAdminPageRoute } from './manifestAdminPages'

// Admin-page route helpers live in a sibling module (responsibility split);
// re-exported here so `@core/plugins/manifest` stays the public surface.
export { collectEnabledAdminPages, pluginAdminPageRoute }

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
/**
 * Used for resource IDs and admin page IDs — these become URL path segments,
 * so they are restricted to lowercase kebab-case.
 * Examples: `subscribers`, `seo-entries`, `my-posts`
 */
const MANIFEST_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/
/**
 * Used for resource field IDs — these are JSON object keys only, not URL
 * segments. Allows camelCase, snake_case, and kebab-case.
 * Examples: `email`, `subscribedAt`, `page_id`, `first-name`
 */
const RESOURCE_FIELD_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
const SEMVERISH_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?$/
const SAFE_ASSET_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/
// `assetBasePath` is server-controlled. The only legitimate shape is
// `/uploads/plugins/{pluginId}/{version}` (optionally trailing `/`),
// produced by `writePluginPackageFiles` on zip install. Any other shape
// — including `..` traversal, empty segments, or non-uploads paths —
// is rejected at the schema boundary so it can't reach the filesystem
// sinks (`loadServerPluginModule`, `removePluginAssets`).
const ASSET_BASE_PATH_PATTERN =
  /^\/uploads\/plugins\/[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?\/?$/
// Outbound network allowlist: lowercase hostname, optional leading `*.`
// wildcard. No paths, ports, query strings — just the host. This is the
// allowlist the host's `network.fetch` bridge checks against.
const NETWORK_HOST_PATTERN = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

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
    assetPath: Type.Optional(Type.String()),
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

const manifestSchema = Type.Object({
  id: Type.String({ pattern: PLUGIN_ID_PATTERN.source }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  version: Type.String({ pattern: SEMVERISH_PATTERN.source }),
  // Schema accepts any positive integer; the parser narrows to the
  // host-supported range via `isCompatiblePluginApiVersion`. Rejecting at
  // a literal would force every old plugin offline the day a host bumps
  // PLUGIN_API_VERSION, even when the host explicitly wants to keep
  // serving older plugins via MIN_SUPPORTED_PLUGIN_API_VERSION.
  apiVersion: Type.Integer({ minimum: 1 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  author: Type.Optional(authorSchema),
  license: Type.Optional(Type.String({ pattern: SPDX_PATTERN.source })),
  homepage: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
  repository: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
  keywords: Type.Optional(Type.Array(Type.String({ pattern: KEYWORD_PATTERN.source }), { maxItems: 20 })),
  icon: Type.Optional(Type.String({ pattern: ICON_PATH_PATTERN.source, maxLength: 80 })),
  permissions: Type.Array(permissionSchema, { default: [] }),
  grantedPermissions: Type.Optional(Type.Array(permissionSchema)),
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
  entrypoints: Type.Optional(Type.Object({
    server: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    editor: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    admin: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    modules: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
  })),
  /**
   * Declarative frontend tag list — scripts, styles, meta, link, and shared
   * host-runtime references the host injects into every published page on
   * behalf of this plugin. Validated structurally here; the host's frontend
   * injection pipeline reads the array at publish time and emits the actual
   * tags. Requires the `frontend.assets` permission (coherence checked
   * downstream in `assertFrontendAssetsCoherent`).
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
  assetBasePath: Type.Optional(Type.String({ pattern: ASSET_BASE_PATH_PATTERN.source })),
  resources: Type.Array(resourceSchema, { maxItems: 20, default: [] }),
  adminPages: Type.Array(adminPageSchema, { maxItems: 20, default: [] }),
  pack: Type.Optional(Type.Object({
    path: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
  })),
  settings: Type.Optional(Type.Array(settingDefinitionSchema, { maxItems: 50 })),
})

type ManifestRaw = Static<typeof manifestSchema>

/**
 * Convert a raw TypeBox pattern-validation error into a human-readable
 * message. TypeBox's default is "Expected string to match '<pattern>'", which
 * is correct but unhelpful. We detect the two manifest patterns and substitute
 * a friendlier explanation.
 */
function friendlyManifestError(message: string, path: string): string {
  if (message.includes(MANIFEST_SLUG_PATTERN.source)) {
    const field = path.split('/').pop() ?? 'field'
    return `"${field}" must be lowercase kebab-case (a-z, 0-9, hyphens; must start with a letter). ` +
      `Examples: "subscribers", "seo-entries". Got: ${message}`
  }
  if (message.includes(RESOURCE_FIELD_ID_PATTERN.source)) {
    const field = path.split('/').pop() ?? 'field'
    return `"${field}" must be a valid identifier (letters, digits, underscores, hyphens; must start with a letter or underscore). ` +
      `Examples: "email", "subscribedAt", "page_id". Got: ${message}`
  }
  return message
}

export function parsePluginManifest(input: unknown): PluginManifest {
  let data: ManifestRaw
  try {
    data = Value.Parse(manifestSchema, input) as ManifestRaw
  } catch {
    const errors = [...compiled(manifestSchema).Errors(input)]
    const first = errors[0]
    const rawMessage = first?.message ?? 'manifest is malformed'
    const message = first ? friendlyManifestError(rawMessage, first.path ?? '') : rawMessage
    throw new Error(`Invalid plugin manifest: ${message}`)
  }

  // SDK compatibility — reject manifests targeting a host API version this
  // build can't honour. Done after schema validation so the error message
  // can reference the parsed value rather than `unknown`.
  if (!isCompatiblePluginApiVersion(data.apiVersion)) {
    throw new Error(
      `Plugin "${data.id}" targets apiVersion ${data.apiVersion}, but this host ` +
        `supports apiVersion ${MIN_SUPPORTED_PLUGIN_API_VERSION}–${PLUGIN_API_VERSION}. ` +
        `Update the plugin (or the host) to a compatible version.`,
    )
  }

  // The schema permits any `/uploads/plugins/{id}/{version}` shape, but the
  // path must reference *this* plugin's own id+version — anything else would
  // let one plugin manifest target another plugin's files at the filesystem
  // sinks (`loadServerPluginModule`, `removePluginAssets`).
  if (data.assetBasePath) {
    const expected = `/uploads/plugins/${data.id}/${data.version}`
    const normalized = data.assetBasePath.replace(/\/+$/, '')
    if (normalized !== expected) {
      throw new Error(
        `Invalid plugin manifest: assetBasePath must equal "${expected}"`,
      )
    }
  }

  const duplicateResources = new Set<string>()
  const resources: PluginResource[] = data.resources.map((resource) => {
    if (duplicateResources.has(resource.id)) {
      throw new Error(`Invalid plugin manifest: duplicate resource "${resource.id}"`)
    }
    duplicateResources.add(resource.id)

    const duplicateFields = new Set<string>()
    for (const field of resource.fields) {
      if (duplicateFields.has(field.id)) {
        throw new Error(`Invalid plugin manifest: duplicate field "${field.id}"`)
      }
      duplicateFields.add(field.id)
    }

    return resource as PluginResource
  })

  const duplicatePages = new Set<string>()
  const adminPages: PluginAdminPage[] = data.adminPages.map((page) => {
    if (duplicatePages.has(page.id)) {
      throw new Error(`Invalid plugin manifest: duplicate admin page "${page.id}"`)
    }
    duplicatePages.add(page.id)
    if (page.content.kind === 'resource' && !duplicateResources.has(page.content.resource)) {
      throw new Error(`Invalid plugin manifest: resource page "${page.id}" references unknown resource "${page.content.resource}"`)
    }

    // Normalise the content: apply the pins default for map pages explicitly,
    // since TypeBox union defaults are not reliably applied within union variants.
    const content: PluginPageContent = page.content.kind === 'map'
      ? { ...page.content, pins: page.content.pins ?? [] }
      : page.content as PluginPageContent

    return {
      id: page.id,
      title: page.title,
      navLabel: page.navLabel,
      icon: page.icon,
      route: pluginAdminPageRoute(data.id, page.id),
      content,
    }
  })

  // Frontend asset coherence — `frontend.assets[]` requires the
  // `frontend.assets` permission. Allowing the array without the permission
  // would silently inject tags onto every published page with no consent
  // screen ever showing the grant.
  if (data.frontend && data.frontend.assets.length > 0) {
    if (!data.permissions.includes('frontend.assets')) {
      throw new Error(
        `Invalid plugin manifest: \`frontend.assets\` is non-empty but the ` +
        `\`frontend.assets\` permission is not requested.`,
      )
    }
    for (const asset of data.frontend.assets) {
      // `attrs` is allowed to be missing (TypeBox enforces the shape we
      // accept), but `script-inline` / `style-inline` must declare *some*
      // content — schema covers that too.
      if (asset.kind === 'link' && !asset.attrs.rel && !asset.attrs.href) {
        throw new Error(
          `Invalid plugin manifest: \`frontend.assets\` <link> declaration ` +
          `must include at least \`rel\` or \`href\`.`,
        )
      }
      if (asset.kind === 'meta' && !asset.attrs.name && !asset.attrs.property
          && !asset.attrs.charset && !asset.attrs['http-equiv']) {
        throw new Error(
          `Invalid plugin manifest: \`frontend.assets\` <meta> declaration ` +
          `must include \`name\`, \`property\`, \`charset\`, or \`http-equiv\`.`,
        )
      }
    }
  }

  // Content access coherence — required when any `cms.content.*` permission
  // is granted; each mode in `modes[]` requires the matching permission.
  // Fail-closed defense: a plugin that requests `cms.content.write` but
  // omits the allowlist would otherwise silently fail every write at the
  // host bridge with a cryptic per-call error.
  const contentPerms = data.permissions.filter((p) =>
    p === 'cms.content.read' ||
    p === 'cms.content.write' ||
    p === 'cms.content.publish' ||
    p === 'cms.content.delete',
  )
  const contentAccess = data.contentAccess ?? []
  if (contentPerms.length > 0 && contentAccess.length === 0) {
    throw new Error(
      `Invalid plugin manifest: \`contentAccess\` is required when any \`cms.content.*\` ` +
      `permission is granted. List the tables the plugin can touch.`,
    )
  }
  if (contentAccess.length > 0) {
    const seenTables = new Set<string>()
    for (const entry of contentAccess) {
      if (seenTables.has(entry.table)) {
        throw new Error(`Invalid plugin manifest: duplicate \`contentAccess\` entry for table "${entry.table}"`)
      }
      seenTables.add(entry.table)

      const seenModes = new Set<string>()
      for (const mode of entry.modes) {
        if (seenModes.has(mode)) {
          throw new Error(`Invalid plugin manifest: duplicate mode "${mode}" in \`contentAccess\` for table "${entry.table}"`)
        }
        seenModes.add(mode)

        const requiredPermission: PluginPermission =
          mode === 'read' ? 'cms.content.read' :
          mode === 'write' ? 'cms.content.write' :
          mode === 'publish' ? 'cms.content.publish' :
          'cms.content.delete'

        if (!data.permissions.includes(requiredPermission)) {
          throw new Error(
            `Invalid plugin manifest: \`contentAccess\` for table "${entry.table}" declares mode "${mode}" ` +
            `but the matching permission "${requiredPermission}" is not in \`permissions\`.`,
          )
        }
      }
    }
  }

  // networkAllowedHosts — reject raw internal targets. The load-bearing SSRF
  // block lives in performGatedFetch (which also blocks any host that *resolves*
  // to a private/loopback/link-local address); this is defense-in-depth so an
  // allowlist never names a literal internal host and the operator sees the
  // problem at install time. Only IPv4 dotted-quads and `localhost` can pass the
  // host pattern — IPv6 literals and ports are already rejected by it.
  if (data.networkAllowedHosts) {
    for (const host of data.networkAllowedHosts) {
      const bare = host.startsWith('*.') ? host.slice(2) : host
      if (bare === 'localhost' || bare.endsWith('.localhost')) {
        throw new Error(
          `Invalid plugin manifest: \`networkAllowedHosts\` entry "${host}" — localhost is not a valid outbound host.`,
        )
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
        throw new Error(
          `Invalid plugin manifest: \`networkAllowedHosts\` entry "${host}" is an IP literal; use a hostname instead.`,
        )
      }
    }
  }

  // Settings — duplicate id check.
  if (data.settings && data.settings.length > 0) {
    const seen = new Set<string>()
    for (const s of data.settings) {
      if (seen.has(s.id)) {
        throw new Error(`Invalid plugin manifest: duplicate setting "${s.id}"`)
      }
      seen.add(s.id)
      if (s.type === 'select' && (!s.options || s.options.length === 0)) {
        throw new Error(`Invalid plugin manifest: setting "${s.id}" of type "select" must declare options`)
      }
      // Secret values are encrypted at rest as strings; toggles and numbers
      // cannot ride that path. Mirrors validatePluginSettingsDefinitions.
      if (s.secret && (s.type === 'toggle' || s.type === 'number')) {
        throw new Error(
          `Invalid plugin manifest: setting "${s.id}" of type "${s.type}" cannot be secret — only string-typed settings may be encrypted`,
        )
      }
    }
  }

  return {
    id: data.id,
    name: data.name,
    version: data.version,
    apiVersion: data.apiVersion,
    description: data.description,
    permissions: data.permissions as PluginPermission[],
    grantedPermissions: data.grantedPermissions as PluginPermission[] | undefined,
    // Per-host outbound-fetch allowlist — required for the `network.outbound`
    // permission to work. Dropping this field would silently turn every gated
    // fetch into a "host not in allowlist" 403 even with the permission granted.
    networkAllowedHosts: data.networkAllowedHosts ? [...data.networkAllowedHosts] : undefined,
    // Per-table allowlist for the `api.cms.content.*` surface — required
    // when any `cms.content.*` permission is granted (coherence checked above).
    contentAccess: data.contentAccess
      ? data.contentAccess.map((entry) => ({ table: entry.table, modes: [...entry.modes] }))
      : undefined,
    entrypoints: data.entrypoints,
    assetBasePath: data.assetBasePath,
    resources,
    adminPages,
    pack: data.pack,
    frontend: data.frontend
      ? { assets: data.frontend.assets.map((asset) => ({ ...asset })) } as PluginManifest['frontend']
      : undefined,
    settings: data.settings,
    author: data.author,
    license: data.license,
    homepage: data.homepage,
    repository: data.repository,
    keywords: data.keywords ? [...data.keywords] : undefined,
    icon: data.icon,
  }
}

export function missingPluginPermissionGrants(
  manifest: Pick<PluginManifest, 'permissions'>,
  grantedPermissions: PluginPermission[],
): PluginPermission[] {
  const granted = new Set(grantedPermissions)
  return manifest.permissions.filter((permission) => !granted.has(permission))
}

export function permissionLabel(permission: PluginPermission): string {
  return sdkPermissionLabel(permission)
}

export function findPluginResource(
  manifest: Pick<PluginManifest, 'resources'>,
  resourceId: string,
): PluginResource | null {
  return manifest.resources.find((resource) => resource.id === resourceId) ?? null
}

export function validatePluginRecordData(
  resource: PluginResource,
  input: unknown,
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Plugin record data must be an object')
  }

  const raw = input as Record<string, unknown>
  const data: Record<string, unknown> = {}

  for (const field of resource.fields) {
    const value = raw[field.id]
    const missing = value === undefined || value === null || value === ''

    if (missing) {
      if (field.required && !options.partial) {
        throw new Error(`Missing required field "${field.label}"`)
      }
      continue
    }

    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Field "${field.label}" must be a number`)
      }
      data[field.id] = value
      continue
    }

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`Field "${field.label}" must be a boolean`)
      }
      data[field.id] = value
      continue
    }

    if (typeof value !== 'string') {
      throw new Error(`Field "${field.label}" must be text`)
    }
    data[field.id] = value.trim()
  }

  return data
}
