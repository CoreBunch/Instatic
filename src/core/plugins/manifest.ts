import { Value } from '@core/utils/typeboxHelpers'
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
  PLUGIN_API_VERSION,
  permissionLabel as sdkPermissionLabel,
} from '@core/plugin-sdk'
import { collectEnabledAdminPages, pluginAdminPageRoute } from './manifestAdminPages'
import {
  MANIFEST_SLUG_PATTERN,
  RESOURCE_FIELD_ID_PATTERN,
  manifestSchema,
  type ManifestRaw,
} from './manifestSchemas'

// Schema shapes live in `./manifestSchemas.ts`; re-exported so
// `@core/plugins/manifest` stays the public surface.
export {
  MANIFEST_AUTHOR_FIELD_SCHEMAS,
  SITE_PLUGIN_ID_PREFIX,
  isReservedSitePluginId,
} from './manifestSchemas'

// Admin-page route helpers and resource-record helpers live in sibling
// modules (responsibility split); re-exported here so
// `@core/plugins/manifest` stays the public surface.
export { collectEnabledAdminPages, pluginAdminPageRoute }
export { findPluginResource, validatePluginRecordData } from './resourceRecords'


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
  const contentPermissions = new Set<PluginPermission>(Object.values(CONTENT_ACCESS_MODE_PERMISSIONS))
  const contentPerms = data.permissions.filter((p) => contentPermissions.has(p))
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

