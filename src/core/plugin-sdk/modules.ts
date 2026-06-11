/**
 * Plugin module pack SDK — `modules.register` permission.
 *
 * A plugin can ship new modules that show up in the canvas module library
 * by setting `entrypoints.modules` in its `plugin.json`. The entrypoint is a
 * package-relative ESM file that default-exports an array of
 * `PluginModuleDefinition` objects (or a function returning one).
 *
 * The shape is **JSON-friendly** on purpose: only `render` and `preview` may
 * be functions; everything else (defaults, schema, css path) is plain data.
 * The host wraps the definition into a full `ModuleDefinition` registered
 * with the canvas module registry.
 */

import type { TSchema } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Property control — a JSON-friendly subset of the host PropertySchema.
// We only expose the controls a plugin module can usefully render. The host
// translates this into the full PropertySchema at registration time.
// ---------------------------------------------------------------------------

export interface PluginPropertyControlBase {
  label: string
  description?: string
}

export type PluginPropertyControl = PluginPropertyControlBase &
  (
    | { type: 'text'; placeholder?: string }
    | { type: 'textarea'; rows?: number; placeholder?: string }
    | { type: 'number'; min?: number; max?: number; step?: number; unit?: string }
    | { type: 'color'; format?: 'hex' | 'rgba' }
    | { type: 'select'; options: Array<{ label: string; value: unknown }> }
    | { type: 'toggle' }
    | { type: 'image' }
    | { type: 'url' }
  )

export type PluginPropertySchema = Record<string, PluginPropertyControl>

// ---------------------------------------------------------------------------
// Render output — same shape as host ModuleDefinition.render
// ---------------------------------------------------------------------------

export interface PluginRenderOutput {
  html: string
  css?: string
  /**
   * Optional vanilla-JS runtime for this module TYPE — deduped per moduleId
   * and served as an external per-module asset on published pages
   * (`/_instatic/module-js/<moduleId>.js`). Requires the plugin's GRANTED
   * `frontend.assets` permission; without the grant the host drops it (one
   * console warning per module). Must be a self-contained IIFE binding via
   * document-level event delegation; never executed in the admin canvas.
   */
  js?: string
}

export type PluginRenderFn = (
  props: Record<string, unknown>,
  children: string[],
) => PluginRenderOutput

// ---------------------------------------------------------------------------
// Module dependencies — flow into the site's package.json automatically
// ---------------------------------------------------------------------------

export interface PluginModuleDependencySpec {
  /** Semver/range tracked for dependency-backed module runtimes. */
  version: string
  /** true writes to devDependencies; false/omitted writes to dependencies. */
  dev?: boolean
}

/**
 * Package dependencies declared by a plugin module. When a site author inserts
 * the module, the host writes these into the site's package.json so they appear
 * in the Dependencies Panel. Use string shorthand for runtime deps
 * (`{ three: '^0.169.0' }`) or the spec form for devDependencies
 * (`{ vite: { version: '^5.1.0', dev: true } }`). Same shape as the host's
 * `ModuleDependencies` (`@core/module-engine/types`).
 */
export type PluginModuleDependencies = Record<string, string | PluginModuleDependencySpec>

// ---------------------------------------------------------------------------
// Editor runtime — opt-in iframe sandbox with auto-built import map
// ---------------------------------------------------------------------------

export interface PluginSandboxRuntime {
  /**
   * ESM source executed inside an isolated editor iframe. The module should
   * export `mount(root, context)`. `mount()` may return a cleanup function or
   * `{ update, cleanup }`. Exporting `update(root, context)` is also supported.
   * The iframe's import map is auto-built from the module's `dependencies` so
   * `import * as THREE from 'three'` resolves to the locked CDN URL.
   */
  source: string
  /** Minimum editor-frame height before class/module CSS overrides apply. */
  minHeight?: number
}

export interface PluginEditorRuntime {
  sandbox?: PluginSandboxRuntime
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

export interface PluginModuleDefinition {
  /**
   * Module ID. MUST be `<pluginId>.<name>` — host enforces the namespace
   * lock so no plugin can overwrite or shadow another plugin or a base
   * module. Validation happens at registration time.
   */
  id: string
  name: string
  description?: string
  category: string
  version: string
  /** Default property values matching `schema` keys. */
  defaults: Record<string, unknown>
  /** Property controls that drive the editor Properties Panel. */
  schema: PluginPropertySchema
  /**
   * Optional TypeBox schema for publisher-boundary prop coercion. When set,
   * `validateNodeProps` coerces and default-fills props before calling
   * `render()`. Absence is tolerated — the publisher passes rawProps through
   * unchanged for modules with no schema.
   */
  propsSchema?: TSchema
  /** Whether the module can hold child modules. */
  canHaveChildren?: boolean
  /**
   * Pure render function used by the publisher and (by default) the
   * editor canvas preview. Receives escaped string props; must return
   * clean HTML. NEVER use document/window/React. NEVER call fetch.
   */
  render: PluginRenderFn
  /** Optional editor-canvas preview. Falls back to `render` when omitted. */
  preview?: PluginRenderFn
  /** Optional concrete root tag for layer/DOM tree display. */
  htmlTag?: string
  /**
   * Package dependencies required when this module is inserted into a page.
   * Auto-written into the site's `package.json` so the Dependencies Panel
   * lists them. Used by the editor iframe runtime to build an import map
   * that resolves `import * as THREE from 'three'` to the locked CDN URL.
   */
  dependencies?: PluginModuleDependencies
  /**
   * Optional iframe-backed live preview for the editor canvas. When set, the
   * editor mounts an iframe with an import map built from `dependencies` and
   * runs the `sandbox.source` ESM inside it. Without this, the editor falls
   * back to dangerouslySetInnerHTML of `render()`'s HTML — fine for static
   * markup but `<script>` tags will not execute.
   */
  editorRuntime?: PluginEditorRuntime
}

// ---------------------------------------------------------------------------
// Entrypoint module shape
// ---------------------------------------------------------------------------

export interface PluginModulePackApi {
  pluginId: string
}

export type PluginModulePackEntrypoint = PluginModuleDefinition[] |
  ((api: PluginModulePackApi) => PluginModuleDefinition[])

export interface PluginModulesEntrypointModule {
  default: PluginModulePackEntrypoint
}
