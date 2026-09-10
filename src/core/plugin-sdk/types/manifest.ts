import type { PluginAdminPage } from './adminPages'
import type { PluginFrontendDeclarations } from './frontend'
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
   * Declarative frontend tag list — scripts, styles, meta, link, and shared
   * host-runtime references that the host injects into every published page
   * on behalf of this plugin. Requires the `frontend.assets` permission. See
   * `FrontendAsset` for the per-tag shape and `PluginFrontendDeclarations`
   * for placement semantics.
   */
  frontend?: PluginFrontendDeclarations
  /** Author / publisher metadata — surfaced on the Plugins admin card. */
  author?: PluginAuthorMetadata
  /** SPDX license identifier (e.g. `MIT`, `Apache-2.0`). */
  license?: string
  /** Marketing / docs URL. */
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
   * ANY of the `cms.content.*` permissions are granted. The install/upgrade
   * consent screen renders every entry with its modes in a "Content tables"
   * section (the `@own-created` marker as "Tables this plugin creates") and,
   * on upgrade, diffs new / already-approved / no-longer-requested entries —
   * a mode added to an already-approved table is flagged as new access — so
   * the operator approves the exact set of tables the plugin can touch
   * before granting the permission.
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
