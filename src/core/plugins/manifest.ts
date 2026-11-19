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
  CONTENT_ACCESS_MODE_PERMISSIONS,
  isCompatiblePluginApiVersion,
  MIN_SUPPORTED_PLUGIN_API_VERSION,
  OWN_CREATED_TABLES_MARKER,
  PLUGIN_API_VERSION,
  PLUGIN_PERMISSION_VALUES,
  permissionLabel as sdkPermissionLabel,
} from '@core/plugin-sdk'
import { PLUGIN_APP_SCOPE_NAME_PATTERN, plainLine, readsAsBuiltInAppScope } from '@core/members'
import { collectEnabledAdminPages, pluginAdminPageRoute } from './manifestAdminPages'
import { settingDefinitionSchema } from './manifestSettings'
import { assertFrontendCoherent, frontendDeclarations, frontendSchema } from './manifestFrontend'
import { assertMailCoherent, mailDeclarations, mailSchema } from './manifestMail'
import { SAFE_ASSET_PATH_PATTERN } from './manifestPatterns'

// Admin-page route helpers and resource-record helpers live in sibling
// modules (responsibility split); re-exported here so
// `@core/plugins/manifest` stays the public surface.
export { collectEnabledAdminPages, pluginAdminPageRoute }
export {
  externalFrontendScriptHost,
  frontendOriginAllowsHost,
  isExternalFrontendScriptSrc,
} from './manifestFrontend'
export {
  deriveRecordUniqueKey,
  findPluginResource,
  pluginRecordUniqueKey,
  validatePluginRecordData,
} from './resourceRecords'

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
// `assetBasePath` is server-controlled. The only legitimate shape is
// `/uploads/plugins/{pluginId}/{version}` (optionally trailing `/`),
// produced by `writePluginPackageFiles` on zip install. Any other shape
// — including `..` traversal, empty segments, or non-uploads paths —
// is rejected at the schema boundary so it can't reach the filesystem
// sinks (`loadServerPluginModule`, `removePluginAssets`).
const ASSET_BASE_PATH_PATTERN =
  /^\/uploads\/plugins\/[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?\/?$/
// `adminPages[].content.assetPath` (app pages) — must look like an uploads
// path with no `.`/`..` segments. The post-check in `parsePluginManifest`
// further pins it to the declaring plugin's own asset subtree.
const ADMIN_APP_ASSET_PATH_PATTERN =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))\/uploads\/plugins\/[a-zA-Z0-9._/-]+$/
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
  /**
   * A `text` field whose value must be unique among the resource's records.
   * The host keeps it in an indexed column, which is what makes
   * `createIfAbsent` and `getByKey` atomic. See docs/features/plugin-system.md.
   */
  uniqueField: Type.Optional(Type.String({ pattern: RESOURCE_FIELD_ID_PATTERN.source })),
})

const adminPageSchema = Type.Object({
  id: Type.String({ pattern: MANIFEST_SLUG_PATTERN.source }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  navLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  icon: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  route: Type.Optional(Type.String()),
  content: contentSchema,
})


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
  // Per-table allowlist for the `api.cms.content.*` surface; each mode must
  // match a granted permission (`assertContentAccessCoherent` below). `table`
  // is a slug or the `@own-created` marker (see OWN_CREATED_TABLES_MARKER) —
  // the slug pattern's leading-letter rule reserves the `@` namespace.
  contentAccess: Type.Optional(Type.Array(
    Type.Object({
      table: Type.Union([
        Type.Literal(OWN_CREATED_TABLES_MARKER),
        Type.String({ pattern: MANIFEST_SLUG_PATTERN.source, maxLength: 80 }),
      ]),
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
  // What an app a member signed in to may do through this plugin; see
  // `PluginManifest.appScopes`. Coherence (unique names, `members.read`) is
  // checked below.
  appScopes: Type.Optional(Type.Array(
    Type.Object({
      name: Type.String({ pattern: PLUGIN_APP_SCOPE_NAME_PATTERN }),
      description: Type.String({ minLength: 1, maxLength: 120 }),
    }, { additionalProperties: false }),
    { maxItems: 20 },
  )),
  entrypoints: Type.Optional(Type.Object({
    server: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    editor: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    admin: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    modules: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
  })),
  // Published-page tags and third-party origins: see `./manifestFrontend`.
  frontend: Type.Optional(frontendSchema),
  // Email templates the plugin can send: see `./manifestMail`.
  mail: Type.Optional(mailSchema),
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

  // App scopes hand an app the signed-in member through this plugin's member
  // routes, so they need what a member route needs, and each name once.
  if (data.appScopes && data.appScopes.length > 0) {
    if (!data.permissions.includes('members.read')) {
      throw new Error(
        `Invalid plugin manifest: \`appScopes\` requires the \`members.read\` permission. ` +
          `Add "members.read" to \`permissions\`.`,
      )
    }
    const names = data.appScopes.map((scope) => scope.name)
    const repeated = names.find((name, index) => names.indexOf(name) !== index)
    if (repeated) throw new Error(`Invalid plugin manifest: app scope "${repeated}" is declared twice`)
    // A member reads the description before allowing an app. Characters that
    // reorder or hide text have no place in it.
    const unreadable = data.appScopes.find((scope) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(scope.description))
    if (unreadable) {
      throw new Error(
        `Invalid plugin manifest: the description of app scope "${unreadable.name}" contains control or invisible characters`,
      )
    }
    // What is left after the cleaning the approval page applies has to say
    // something: a description of spaces would show the member nothing.
    const blank = data.appScopes.find((scope) => plainLine(scope.description) === '')
    if (blank) {
      throw new Error(`Invalid plugin manifest: the description of app scope "${blank.name}" is empty`)
    }
    // And it has to be the plugin's own: not the words core uses for the
    // built-in scopes, which would pass the plugin's access off as theirs.
    const imitating = data.appScopes.find((scope) => readsAsBuiltInAppScope(scope.description))
    if (imitating) {
      throw new Error(
        `Invalid plugin manifest: the description of app scope "${imitating.name}" repeats the text of a built-in scope`,
      )
    }
  }

  // Entrypoint ↔ permission coherence. Editor entrypoints are unsandboxed
  // plugin JavaScript dynamically imported into the admin window, so they
  // require the `editor.code` permission — without this check a
  // "zero-permission" manifest could ship admin-window code that installs
  // with no consent screen ever naming the capability. Module packs are
  // similarly gated: declaring `entrypoints.modules` without
  // `modules.register` would otherwise be silently skipped at load time.
  if (data.entrypoints?.editor && !data.permissions.includes('editor.code')) {
    throw new Error(
      `Invalid plugin manifest: \`entrypoints.editor\` runs unsandboxed JavaScript ` +
      `in the admin window and requires the \`editor.code\` permission. ` +
      `Add "editor.code" to \`permissions\`.`,
    )
  }
  if (data.entrypoints?.modules && !data.permissions.includes('modules.register')) {
    throw new Error(
      `Invalid plugin manifest: \`entrypoints.modules\` requires the ` +
      `\`modules.register\` permission. Add "modules.register" to \`permissions\`.`,
    )
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

    if (resource.uniqueField !== undefined) {
      const keyField = resource.fields.find((field) => field.id === resource.uniqueField)
      if (!keyField) {
        throw new Error(
          `Invalid plugin manifest: resource "${resource.id}" names "${resource.uniqueField}" as its uniqueField, ` +
            `but declares no field with that id.`,
        )
      }
      if (keyField.type !== 'text') {
        throw new Error(
          `Invalid plugin manifest: the uniqueField of resource "${resource.id}" must be a "text" field; ` +
            `"${keyField.id}" is "${keyField.type}".`,
        )
      }
    }

    return resource as PluginResource
  })

  // Admin pages mount in the CMS sidebar — that surface is gated by the
  // `admin.navigation` permission. A manifest declaring pages without the
  // permission used to be silently skipped at mount time; fail loudly at
  // parse time instead so the author sees the problem before upload.
  if (data.adminPages.length > 0 && !data.permissions.includes('admin.navigation')) {
    throw new Error(
      `Invalid plugin manifest: \`adminPages\` requires the \`admin.navigation\` ` +
      `permission. Add "admin.navigation" to \`permissions\`.`,
    )
  }

  const duplicatePages = new Set<string>()
  const adminPages: PluginAdminPage[] = data.adminPages.map((page) => {
    if (duplicatePages.has(page.id)) {
      throw new Error(`Invalid plugin manifest: duplicate admin page "${page.id}"`)
    }
    duplicatePages.add(page.id)
    if (page.content.kind === 'resource' && !duplicateResources.has(page.content.resource)) {
      throw new Error(`Invalid plugin manifest: resource page "${page.id}" references unknown resource "${page.content.resource}"`)
    }
    if (page.content.kind === 'app') {
      // App pages are unsandboxed plugin JavaScript in the admin window —
      // the same trust surface as `entrypoints.editor`, gated by the same
      // permission.
      if (!data.permissions.includes('editor.code')) {
        throw new Error(
          `Invalid plugin manifest: admin page "${page.id}" has kind "app", which runs ` +
          `unsandboxed JavaScript in the admin window and requires the \`editor.code\` ` +
          `permission. Add "editor.code" to \`permissions\`.`,
        )
      }
      // Pin `assetPath` to THIS plugin's own asset subtree. The schema
      // pattern already rejects dot segments; this check stops a manifest
      // from pointing the admin shell's dynamic import() at another
      // plugin's files (or any other uploads path).
      if (page.content.assetPath) {
        const expectedBase = `/uploads/plugins/${data.id}/${data.version}`
        const normalized = page.content.assetPath.replace(/\/+$/, '')
        if (normalized !== expectedBase && !normalized.startsWith(`${expectedBase}/`)) {
          throw new Error(
            `Invalid plugin manifest: admin page "${page.id}" assetPath must stay within ` +
            `"${expectedBase}"`,
          )
        }
      }
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
  if (data.frontend) assertFrontendCoherent(data.frontend, data.permissions)
  if (data.mail) assertMailCoherent(data.mail, data.permissions)

  // Content access coherence — required when any `cms.content.*` permission
  // is granted; each mode in `modes[]` requires the matching permission.
  // Fail-closed defense: a plugin that requests `cms.content.write` but
  // omits the allowlist would otherwise silently fail every write at the
  // host bridge with a cryptic per-call error.
  const contentPermissions = new Set<PluginPermission>(Object.values(CONTENT_ACCESS_MODE_PERMISSIONS))
  const contentPerms = data.permissions.filter((p) => contentPermissions.has(p))
  const contentAccess = data.contentAccess ?? []
  if (contentPerms.length > 0 && contentAccess.length === 0) {
    throw new Error(
      `Invalid plugin manifest: \`contentAccess\` is required when any \`cms.content.*\` ` +
      `permission is granted. List the tables the plugin can touch, or declare ` +
      `\`{ "table": "${OWN_CREATED_TABLES_MARKER}" }\` for tables the plugin creates at runtime.`,
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

        const requiredPermission = CONTENT_ACCESS_MODE_PERMISSIONS[mode]

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
    appScopes: data.appScopes ? data.appScopes.map((scope) => ({ name: scope.name, description: scope.description })) : undefined,
    contentAccess: data.contentAccess
      ? data.contentAccess.map((entry) => ({ table: entry.table, modes: [...entry.modes] }))
      : undefined,
    entrypoints: data.entrypoints,
    assetBasePath: data.assetBasePath,
    resources,
    adminPages,
    pack: data.pack,
    frontend: data.frontend ? frontendDeclarations(data.frontend) : undefined,
    mail: data.mail ? mailDeclarations(data.mail) : undefined,
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

