/**
 * `definePlugin` — type-checked plugin configuration.
 *
 *   import { definePlugin, permissions } from '@instatic/plugin-sdk'
 *   import callout from './modules/callout'
 *   import pack from './pack'
 *
 *   export default definePlugin({
 *     id: 'acme.ui-kit',
 *     name: 'Modern UI Kit',
 *     version: '1.0.0',
 *     description: 'Cards, tiers, testimonials, and a class pack.',
 *     permissions: [permissions.modulesRegister, permissions.visualComponentsRegister],
 *     modules: [callout],
 *     pack,
 *   })
 *
 * The return value is the host's runtime `PluginManifest` plus the bundled
 * builder objects. The build CLI (`cli/build.ts`) uses those builder
 * objects to emit the final zip. Entrypoints are NOT declared here —
 * `instatic-plugin build` auto-wires them into the emitted `plugin.json`
 * from the source layout (`server/index.ts`, `editor/index.ts`, top-level
 * `frontend/*.ts`, admin app entries).
 */

import { PLUGIN_API_VERSION } from '../types'
import type {
  PluginAdminPage,
  PluginAppScope,
  PluginFrontendDeclarations,
  PluginMailDeclarations,
  PluginManifest,
  PluginPermission,
  PluginResource,
} from '../types'
import type { ContentAccessEntry } from '../contentSchemas'
import type { PluginModuleDefinition } from '../modules'
import type { PluginPackContents } from './definePack'
import {
  validatePluginSettingsDefinitions,
  type PluginSettingDefinition,
} from './settings'

export interface DefinePluginConfig {
  id: string
  name: string
  version: string
  description?: string
  /** Free-form author metadata surfaced on the plugin card / marketplace. */
  author?: { name: string; email?: string; url?: string }
  /** SPDX license identifier. */
  license?: string
  /** Marketing / repo URLs. */
  homepage?: string
  repository?: string
  /** Discovery keywords. */
  keywords?: string[]
  /**
   * Path inside the plugin source folder to a small visual icon
   * (`icon.png`, `icon.svg`, `icon.webp`, `icon.jpg`). Copied through to
   * the dist zip on build and surfaced on the Plugins admin card.
   */
  icon?: string
  /**
   * API version the plugin targets. Defaults to the current host
   * `PLUGIN_API_VERSION` at build time. Plugins targeting an older API
   * version are still accepted as long as the host's
   * `MIN_SUPPORTED_PLUGIN_API_VERSION` doesn't exceed it.
   */
  apiVersion?: number
  permissions: PluginPermission[]

  /**
   * Allowed outbound HTTP hosts. Required when `permissions` includes
   * `network.outbound`; ignored otherwise. Plain hostnames match exactly,
   * the leading `*.` wildcard matches one subdomain segment. See
   * `docs/features/plugin-system.md` for full semantics.
   */
  networkAllowedHosts?: string[]

  /**
   * Resources declared by the plugin (used by `cms.storage`). The host
   * persists records under each resource's id.
   */
  resources?: PluginResource[]

  /**
   * Per-table allowlist for the `cms.content.*` surface. Required by the
   * manifest parser whenever any `cms.content.*` permission is declared;
   * the host fails closed at runtime for tables/modes not listed here.
   */
  contentAccess?: ContentAccessEntry[]

  /**
   * What an app a site member signed in to may be allowed to do through
   * this plugin. Each entry becomes the app scope `plugin:<id>:<name>`; the
   * member reads `description` before allowing the app. A member route lets
   * apps in by naming one: `routes.member.get(path, { app: { scope } }, handler)`.
   * Requires the `members.read` permission.
   */
  appScopes?: PluginAppScope[]

  /**
   * The plugin adds a section to a member's data export with
   * `api.cms.members.exportProvider`. Requires `members.read`.
   */
  memberDataExport?: boolean

  /**
   * Admin pages registered by the plugin (markdown / map / resource / app).
   * Auto-deduped against the page id.
   */
  adminPages?: PluginAdminPage[]

  /** Canvas modules registered via `defineModule()`. */
  modules?: PluginModuleDefinition[]

  /** Visual Component / page / class pack from `definePack()`. */
  pack?: PluginPackContents

  /**
   * Declarative plugin settings — the host renders a form using its
   * design-system primitives. Plugin reads values via
   * `api.cms.settings.get(key)` (server / admin app). Frontend bundles
   * read settings via the plugin's own public route — the host does
   * not expose plugin settings to the published page directly.
   */
  settings?: PluginSettingDefinition[]

  /**
   * Declarative frontend tag list — external/inline scripts, external/inline
   * styles, `<link>`, and `<meta>` tags that the host injects into every
   * published page on behalf of this plugin.
   * Requires the `frontend.assets` permission. See `FrontendAsset` for
   * the per-tag shape and the four placement anchors, and
   * `PluginFrontendOrigins` for third-party script and frame origins.
   */
  frontend?: PluginFrontendDeclarations

  /**
   * The email templates the plugin can send with `api.cms.mail.send`.
   * Requires `mail.send` or `mail.send.external`.
   */
  mail?: PluginMailDeclarations
}

/**
 * What `definePlugin` returns. Carries the runtime manifest the host
 * expects, plus the bundled builder outputs (modules, pack) that the build
 * script needs to emit JS / JSON files into the zip.
 */
export interface PluginDefinition {
  manifest: PluginManifest
  modules: PluginModuleDefinition[]
  pack: PluginPackContents | null
}

export function definePlugin(config: DefinePluginConfig): PluginDefinition {
  if (!config.id.includes('.')) {
    throw new Error(`[plugin-sdk] Plugin id "${config.id}" must be namespaced as "<vendor>.<name>".`)
  }
  for (const mod of config.modules ?? []) {
    if (!mod.id.startsWith(`${config.id}.`)) {
      throw new Error(
        `[plugin-sdk] Module id "${mod.id}" must start with the plugin id "${config.id}.".`,
      )
    }
  }
  for (const cls of config.pack?.classes ?? []) {
    if (!cls.id.startsWith(`${config.id}/`) && !cls.id.startsWith(`${config.id}.`)) {
      throw new Error(
        `[plugin-sdk] Pack class id "${cls.id}" must be namespaced under the plugin id "${config.id}".`,
      )
    }
  }
  for (const page of config.pack?.pages ?? []) {
    if (!page.id.startsWith(`${config.id}/`) && !page.id.startsWith(`${config.id}.`)) {
      throw new Error(
        `[plugin-sdk] Pack page id "${page.id}" must be namespaced under the plugin id "${config.id}".`,
      )
    }
  }
  for (const vc of config.pack?.visualComponents ?? []) {
    if (!vc.id.startsWith(`${config.id}/`)) {
      throw new Error(
        `[plugin-sdk] Visual Component id "${vc.id}" must start with "${config.id}/".`,
      )
    }
  }

  if (config.settings && config.settings.length > 0) {
    validatePluginSettingsDefinitions(config.id, config.settings)
  }

  // The manifest is round-tripped through `plugin.json` at build time, so
  // we omit optional fields entirely when undefined rather than setting
  // `key: undefined`. Two reasons:
  //
  //   1. In-memory shape == disk shape. Tests / tooling that hand the
  //      manifest straight into `parsePluginManifest` get the same result
  //      as the host install path that reads the zipped JSON.
  //   2. TypeBox's `Value.Convert` (run by `parsePluginManifest`) coerces
  //      `key: undefined` for array-typed optional fields into `[null]`
  //      before assertion, which then fails with a confusing
  //      "Expected string" error far from the actual cause.
  const manifest: PluginManifest = {
    id: config.id,
    name: config.name,
    version: config.version,
    apiVersion: config.apiVersion ?? PLUGIN_API_VERSION,
    permissions: [...config.permissions],
    resources: config.resources ?? [],
    adminPages: config.adminPages ?? [],
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.networkAllowedHosts
      ? { networkAllowedHosts: [...config.networkAllowedHosts] }
      : {}),
    ...(config.contentAccess
      ? { contentAccess: config.contentAccess.map((entry) => ({ ...entry, modes: [...entry.modes] })) }
      : {}),
    ...(config.appScopes
      ? { appScopes: config.appScopes.map((scope) => ({ name: scope.name, description: scope.description })) }
      : {}),
    ...(config.memberDataExport ? { memberDataExport: true } : {}),
    ...(config.settings !== undefined ? { settings: config.settings } : {}),
    ...(config.author !== undefined ? { author: config.author } : {}),
    ...(config.license !== undefined ? { license: config.license } : {}),
    ...(config.homepage !== undefined ? { homepage: config.homepage } : {}),
    ...(config.repository !== undefined ? { repository: config.repository } : {}),
    ...(config.keywords ? { keywords: [...config.keywords] } : {}),
    ...(config.icon !== undefined ? { icon: config.icon } : {}),
    ...(config.frontend !== undefined
      ? {
          frontend: {
            assets: config.frontend.assets.map((asset) => ({ ...asset })),
            ...(config.frontend.origins
              ? {
                  origins: {
                    ...(config.frontend.origins.scripts ? { scripts: [...config.frontend.origins.scripts] } : {}),
                    ...(config.frontend.origins.frames ? { frames: [...config.frontend.origins.frames] } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(config.mail !== undefined
      ? {
          mail: {
            templates: config.mail.templates.map((template) => ({
              ...template,
              variables: template.variables.map((variable) => ({ ...variable })),
            })),
          },
        }
      : {}),
  }
  return {
    manifest,
    modules: config.modules ?? [],
    pack: config.pack ?? null,
  }
}
