import type { PluginAdminPage } from './adminPages'
import type { PluginFrontendDeclarations } from './frontend'
import type { PluginMailDeclarations } from './mail'
import type { PluginApiVersion } from './apiVersion'
import type { PluginPermission } from './permissions'
import type { PluginResource } from './resources'
import type { ContentAccessEntry } from '../contentSchemas'
import type { PluginSettingDefinition } from '../builders/settings'

// ---------------------------------------------------------------------------
// Manifest building blocks
// ---------------------------------------------------------------------------

export interface PluginEntrypoints {
  server?: string
  editor?: string
  admin?: string
  /** Module pack — default-exports an array of PluginModuleDefinition. */
  modules?: string
}

export interface PluginPackManifest {
  /**
   * Path inside the package zip (relative to plugin.json) of a JSON file
   * with the shape `{ visualComponents?: VisualComponent[]; pages?: Page[];
   * classes?: StyleRule[]; }`. The host imports these into the active site
   * on plugin activation.
   */
  path: string
}

export interface PluginAuthorMetadata {
  name: string
  email?: string
  url?: string
}

// ---------------------------------------------------------------------------
// Plugin manifest — the contract written by the plugin author and validated
// by the host at install time
// ---------------------------------------------------------------------------

/** One thing an app may be allowed to do through a plugin. See `PluginManifest.appScopes`. */
export interface PluginAppScope {
  /** Lowercase kebab-case, unique within the plugin: `read`, `manage-licenses`. */
  name: string
  /** What it lets the app do, as a member reads it: "See your purchases and plan". */
  description: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  /**
   * SDK version the plugin was authored against. Must fall in
   * `[MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION]`. Validated by
   * the manifest parser; the host rejects incompatible plugins at install
   * time with a descriptive error.
   */
  apiVersion: PluginApiVersion
  description?: string
  permissions: PluginPermission[]
  grantedPermissions?: PluginPermission[]
  entrypoints?: PluginEntrypoints
  assetBasePath?: string
  resources: PluginResource[]
  adminPages: PluginAdminPage[]
  /** Optional Visual Component / template / class pack. */
  pack?: PluginPackManifest
  /**
   * What an app a site member signed in to may be allowed to do through
   * this plugin. Each entry becomes the app scope `plugin:<id>:<name>`,
   * which the site owner can give an app and the member sees, in
   * `description`'s words, before allowing it. A member route accepts an app
   * token only when it names one of these (`routes.member.get(path,
   * { app: { scope } }, handler)`). Requires the `members.read` permission.
   */
  appScopes?: PluginAppScope[]
  /**
   * The plugin adds a section to a member's data export
   * (`api.cms.members.exportProvider`). Declared so the export can name the
   * plugin even while it is not running. Requires `members.read`.
   */
  memberDataExport?: boolean
  /**
   * Declarative frontend tag list — scripts, styles, meta, link, and shared
   * host-runtime references that the host injects into every published page
   * on behalf of this plugin. Requires the `frontend.assets` permission. See
   * `FrontendAsset` for the per-tag shape and `PluginFrontendDeclarations`
   * for placement semantics.
   */
  frontend?: PluginFrontendDeclarations
  /**
   * The email templates the plugin can send with `api.cms.mail.send`. They
   * are listed in Email → Templates, where the owner can reword them.
   * Requires `mail.send` or `mail.send.external`. See
   * `docs/features/plugin-system.md` → "Email".
   */
  mail?: PluginMailDeclarations
  /** Author / publisher metadata — surfaced on the Plugins admin card. */
  author?: PluginAuthorMetadata
  /** SPDX license identifier (e.g. `MIT`, `Apache-2.0`). */
  license?: string
  /** Marketing / docs URL. */
  /** Raw Ed25519 public key for signed package updates, encoded as base64. */
  updatePublicKey?: string
  homepage?: string
  /** Source repository URL. */
  repository?: string
  /** Discovery keywords. */
  keywords?: string[]
  /**
   * Allowed outbound HTTP hosts when the `network.outbound` permission is
   * granted. Plain hostnames (`api.example.com`) match exactly; the leading
   * `*.` wildcard matches one subdomain segment (`*.shopify.com` matches
   * `shop.shopify.com` but not `shopify.com` and not `a.b.shopify.com`).
   * If empty or omitted, all outbound calls are denied even when the
   * permission is granted — fail-closed defense.
   */
  networkAllowedHosts?: string[]
  /**
   * Per-table allowlist for the `api.cms.content.*` surface. Required when
   * ANY of the `cms.content.*` permissions are granted. Ships in the
   * manifest so the operator can review the exact set of tables the plugin
   * can touch before installing.
   *
   * `table` is a concrete slug, or the `@own-created` marker
   * (`OWN_CREATED_TABLES_MARKER`) covering every table the plugin itself
   * creates at runtime via `cms.content.tables.create` — the shape
   * importer/migration plugins need when the operator picks table names.
   *
   * Modes are checked AGAINST the granted permissions at install time: a
   * `mode: "publish"` entry requires `cms.content.publish`, etc. — and the
   * host fails closed at runtime if a table or mode is not declared.
   */
  contentAccess?: ContentAccessEntry[]
  /**
   * Path inside the plugin zip to a small visual icon (.png / .svg /
   * .webp / .jpg). Resolved at runtime against `assetBasePath` for
   * display on the Plugins admin card.
   */
  icon?: string
  /**
   * Declarative settings — the host renders a form for them and persists
   * the user's values in `installed_plugins.settings_json`. Plugin reads
   * values via `api.cms.settings.*`. Each element is a `PluginSettingDefinition`
   * from `src/core/plugin-sdk/builders/settings.ts` — a discriminated union
   * over the eight supported field types.
   */
  settings?: ReadonlyArray<PluginSettingDefinition>
}
