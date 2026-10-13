/**
 * `defineModule` — type-checked canvas module builder.
 *
 *   import { defineModule, control, html } from '@instatic/plugin-sdk'
 *
 *   export default defineModule({
 *     id: 'acme.ui-kit.callout',
 *     name: 'Callout',
 *     category: 'UI Kit',
 *     defaults: { title: 'Heads up', body: '...', tone: 'info' as const },
 *     schema: {
 *       title: control.text('Title'),
 *       body:  control.textarea('Body', { rows: 4 }),
 *       tone:  control.select('Tone', [
 *         { label: 'Info',    value: 'info'    },
 *         { label: 'Warning', value: 'warning' },
 *       ]),
 *     },
 *     render: ({ props }) => html`
 *       <aside class="callout callout--${props.tone}">
 *         <strong>${props.title}</strong>
 *         ${props.body}
 *       </aside>
 *     `,
 *   })
 *
 * Compile-time wins:
 *   • `props` inside `render` is typed from `defaults` — typo `proops.tone`
 *     is a TypeScript error.
 *   • `schema` keys must match `defaults` keys (extra/missing keys → error).
 *   • `id` must be a string with at least one `.` separator.
 *
 * Runtime: returns a `PluginModuleDefinition` ready to be re-exported from
 * a `modules/index.{ts,js}` plugin entrypoint.
 */
import type {
  PluginEditorRuntime,
  PluginModuleDefinition,
  PluginModuleDependencies,
  PluginPropertyControl,
  PluginRenderOutput,
} from '../modules'
import type { TSchema } from '@core/utils/typeboxHelpers'

interface DefineModuleConfig<TDefaults extends Record<string, unknown>> {
  id: string
  name: string
  description?: string
  category: string
  /** Default property values. The shape of `props` in `render` is inferred from this. */
  defaults: TDefaults
  /** Property controls — keys must match `defaults`. */
  schema: { [K in keyof TDefaults]: PluginPropertyControl }
  /** Declarative TypeBox props/defaulting and resolved publish requirements. */
  propsSchema?: TSchema
  publishSchema?: TSchema
  /** Whether the module can hold child modules. */
  canHaveChildren?: boolean
  /** Optional concrete root tag for layer/DOM tree display. */
  htmlTag?: string
  /** Optional semver-like version string. Defaults to `'1.0.0'`. */
  version?: string
  /**
   * Pure render function. Receives typed props (inferred from `defaults`)
   * and an array of pre-rendered children HTML strings. Must return clean
   * HTML — never use document/window/React.
   */
  render: (ctx: { props: TDefaults; children: string[] }) => PluginRenderOutput
  /**
   * Optional preview override for the editor canvas. Falls back to `render`
   * when omitted. Useful when the editor preview should differ from the
   * published markup (e.g. show a placeholder for slow API content).
   */
  preview?: (ctx: { props: TDefaults; children: string[] }) => PluginRenderOutput
  /**
   * Package dependencies required when this module is inserted into a page.
   * Auto-written into the site's `package.json` and surfaced in the
   * Dependencies Panel. Runtime deps use string shorthand
   * (`{ three: '^0.169.0' }`); dev deps use `{ version, dev: true }`.
   */
  dependencies?: PluginModuleDependencies
  /**
   * Optional iframe-backed live preview for the editor canvas. When set, the
   * editor mounts a sandboxed iframe whose import map is auto-built from
   * `dependencies` and runs the supplied `sandbox.source` ESM inside it.
   */
  editorRuntime?: PluginEditorRuntime
}

export function defineModule<const TDefaults extends Record<string, unknown>>(
  config: DefineModuleConfig<TDefaults>,
): PluginModuleDefinition {
  if (typeof config.id !== 'string' || !config.id.includes('.')) {
    throw new Error(`[plugin-sdk] Module id "${config.id}" must be namespaced as "<pluginId>.<name>".`)
  }
  // The host already validates `<pluginId>.` prefix at registration; we only
  // shape-check the basics here so the build phase fails fast.
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    category: config.category,
    version: config.version ?? '1.0.0',
    defaults: config.defaults as Record<string, unknown>,
    schema: config.schema as Record<string, PluginPropertyControl>,
    ...(config.propsSchema ? { propsSchema: config.propsSchema } : {}),
    ...(config.publishSchema ? { publishSchema: config.publishSchema } : {}),
    canHaveChildren: config.canHaveChildren,
    htmlTag: config.htmlTag,
    ...(config.dependencies ? { dependencies: config.dependencies } : {}),
    ...(config.editorRuntime ? { editorRuntime: config.editorRuntime } : {}),
    render: (props, children) =>
      config.render({ props: props as TDefaults, children }),
    ...(config.preview
      ? { preview: (props, children) => config.preview!({ props: props as TDefaults, children }) }
      : {}),
  }
}
