/**
 * Plugin module adapter — pure translation from `PluginModuleDefinition`
 * (JSON-friendly, plugin-author-facing) to the host's `ModuleDefinition`.
 *
 * The `component` field on a host `ModuleDefinition` is required and is
 * React-typed — but `src/core/` is forbidden from importing runtime React
 * (Constraint #179 / Phase 0 gate 1). To keep the translation pure here,
 * the caller must inject a `componentFactory` that produces a React
 * component for the editor canvas. The publisher (server) calls only
 * `render()`, never `component`, so it can pass a minimal stub.
 *
 * The module ID namespace lock is enforced here: a plugin module's id must
 * begin with `<pluginId>.`. This keeps a malicious or buggy plugin from
 * overriding `base.text` or shadowing another plugin's modules.
 */
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import type {
  IconComponent,
} from 'pixel-art-icons/types'
import type {
  ModuleComponentProps,
  ModuleDefinition,
  PropertyControl,
  PropertySchema,
} from '@core/module-engine'
import type {
  PluginEditorRuntime,
  PluginModuleDefinition,
  PluginModuleDependencies,
  PluginPropertyControl,
  PluginPropertySchema,
} from '@core/plugin-sdk'
import type { ComponentType } from 'react'

const SAFE_MODULE_NAME = /^[a-z][a-z0-9-]*$/

export class PluginModuleValidationError extends Error {
  public readonly path: string
  constructor(message: string, path: string) {
    super(message)
    this.name = 'PluginModuleValidationError'
    this.path = path
  }
}

export function validatePluginModuleId(pluginId: string, moduleId: string): void {
  if (typeof moduleId !== 'string' || !moduleId.includes('.')) {
    throw new PluginModuleValidationError(
      `Module id "${moduleId}" must be namespaced as "<pluginId>.<name>".`,
      `${pluginId}:${moduleId}`,
    )
  }
  const requiredPrefix = `${pluginId}.`
  if (!moduleId.startsWith(requiredPrefix)) {
    throw new PluginModuleValidationError(
      `Module id "${moduleId}" must start with the plugin id "${pluginId}.".`,
      `${pluginId}:${moduleId}`,
    )
  }
  const tail = moduleId.slice(requiredPrefix.length)
  if (!SAFE_MODULE_NAME.test(tail)) {
    throw new PluginModuleValidationError(
      `Module id "${moduleId}" has an invalid name segment "${tail}". Use lowercase alphanumerics and dashes.`,
      `${pluginId}:${moduleId}`,
    )
  }
}

function translatePropertyControl(control: PluginPropertyControl): PropertyControl {
  // The host PropertyControl is a strict superset of PluginPropertyControl.
  return control as PropertyControl
}

function translatePropertySchema(schema: PluginPropertySchema): PropertySchema {
  const out: PropertySchema = {}
  for (const [key, control] of Object.entries(schema)) {
    out[key] = translatePropertyControl(control)
  }
  return out
}

function translateModuleDependencies(
  dependencies: PluginModuleDependencies,
): ModuleDefinition['dependencies'] {
  // Plugin SDK shape is structurally identical to host `ModuleDependencies`
  // (string shorthand or `{ version, dev? }` spec). Copy through verbatim —
  // the host's `normalizeModuleDependencies` validates package names and
  // versions at the registry boundary.
  return { ...dependencies }
}

function maybeEditorRuntime(
  runtime: PluginEditorRuntime | undefined,
): Pick<ModuleDefinition, 'editorRuntime'> | Record<string, never> {
  if (!runtime?.sandbox) return {}
  return {
    editorRuntime: {
      sandbox: {
        source: runtime.sandbox.source,
        ...(typeof runtime.sandbox.minHeight === 'number'
          ? { minHeight: runtime.sandbox.minHeight }
          : {}),
      },
    },
  }
}

const DEFAULT_PLUGIN_MODULE_ICON: IconComponent = BoxStackSolidIcon

/**
 * `componentFactory` produces the React component used by the editor canvas
 * to preview a plugin module. The publisher (server) never invokes the
 * component, so a stub factory is fine when registering server-side.
 */
export type PluginModuleComponentFactory = (
  definition: PluginModuleDefinition,
) => ComponentType<ModuleComponentProps>

export function pluginModuleToHostModule(
  pluginId: string,
  definition: PluginModuleDefinition,
  componentFactory: PluginModuleComponentFactory,
  /**
   * The plugin's GRANTED permissions (never the declared `permissions`
   * array) — authority for the `frontend.assets` gate on module JS.
   */
  grantedPermissions: readonly string[],
): ModuleDefinition<Record<string, unknown>> {
  validatePluginModuleId(pluginId, definition.id)

  if (typeof definition.render !== 'function') {
    throw new PluginModuleValidationError(
      `Plugin module "${definition.id}" must export a render(props, children) function.`,
      `${pluginId}:${definition.id}`,
    )
  }

  // `frontend.assets` is the existing permission meaning "may put script tags
  // on published pages" (enforced against grantedPermissions the same way in
  // server/publish/frontendInjections.ts). Module render() `js` rides the
  // same authority; without the grant it is dropped with ONE warning per
  // module so a publish over hundreds of nodes doesn't spam the log.
  const allowModuleJs = grantedPermissions.includes('frontend.assets')
  let warnedDroppedJs = false

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    version: definition.version,
    icon: DEFAULT_PLUGIN_MODULE_ICON,
    // Plugin-provided modules are NOT trusted: their render() runs in the
    // publisher boundary just like base modules, but their editor component
    // is a host-controlled wrapper that mounts the same render() output.
    // Marking them `trusted: false` reserves the right to migrate the editor
    // preview into an iframe once the bridge host is ready (see
    // `editorRuntime.sandbox` in `module-engine/types.ts`).
    trusted: false,
    canHaveChildren: Boolean(definition.canHaveChildren),
    schema: translatePropertySchema(definition.schema),
    defaults: definition.defaults,
    // Pass propsSchema through verbatim — validateNodeProps handles absence
    // as a no-op, so plugins without a schema are unaffected.
    ...(definition.propsSchema ? { propsSchema: definition.propsSchema } : {}),
    component: componentFactory(definition),
    htmlTag: typeof definition.htmlTag === 'string' ? definition.htmlTag : undefined,
    // Dependencies declared by the plugin module flow into the site's
    // package.json on insert. The host's existing
    // `getMissingModuleDependencies`/`getSiteModuleDependencyUsage` paths
    // then surface them in the Dependencies Panel automatically.
    ...(definition.dependencies
      ? { dependencies: translateModuleDependencies(definition.dependencies) }
      : {}),
    // Optional iframe-backed editor preview. When provided, the editor's
    // `NodeRenderer` mounts a `ModuleSandboxFrame` with an import map built
    // from `dependencies`, so `import * as THREE from 'three'` inside the
    // sandbox source resolves to the locked CDN URL.
    ...maybeEditorRuntime(definition.editorRuntime),
    // Defensive wrap — a throwing plugin render() must not crash the
    // publisher (one bad module would otherwise abort the entire publish
    // job). The editor canvas separately wraps the React preview in an
    // ErrorBoundary; this wrap protects the server-side publisher path.
    render: (props, children) => {
      try {
        const out = definition.render(props, children)
        if (out.js !== undefined && !allowModuleJs) {
          if (!warnedDroppedJs) {
            warnedDroppedJs = true
            console.warn(
              `[plugin-module:${definition.id}] render() emitted js but plugin "${pluginId}" was not granted "frontend.assets" — module JS dropped.`,
            )
          }
          return { html: out.html, css: out.css }
        }
        return { html: out.html, css: out.css, js: out.js }
      } catch (err) {
        console.error(`[plugin-module:${definition.id}] render() threw:`, err)
        return { html: `<!-- instatic: plugin module "${definition.id}" render failed -->` }
      }
    },
  }
}
