/**
 * Editor-side factory that produces the React canvas-preview component for
 * a `PluginModuleDefinition`. Lives under `src/admin/pages/site/canvas/`
 * because the factory wires plugin modules into canvas rendering, and
 * `src/core/` is banned from importing runtime React.
 *
 * The component renders the plugin's `preview()` (falling back to `render()`)
 * HTML inside a wrapper div via `dangerouslySetInnerHTML`. Children (already
 * rendered React subtrees) are rendered as a sibling node, so plugins that
 * opt into `canHaveChildren` still see the host-rendered nested modules.
 *
 * Module CSS — the `.css` string a plugin returns from `render()` — is
 * injected into the document head as a single `<style data-plugin-module="..."
 * data-css-hash="...">` element per module type + CSS content. The publisher
 * does the equivalent via `buildSiteCssBundle` for the published page, so
 * keeping the canvas in sync means the editor preview matches what visitors
 * will see — no more "styled on the frontend, unstyled in canvas" surprises.
 *
 * This file deliberately exports only the factory function (a regular
 * function, not a React component) so React Fast Refresh stays happy. Each
 * call returns a fresh anonymous component class — those don't enter
 * Fast Refresh boundaries because they're not module-level exports.
 */
import type {
  ModuleComponentProps,
} from '@core/module-engine'
import type {
  PluginModuleDefinition,
} from '@core/plugin-sdk'
import type { PluginModuleComponentFactory } from '@core/plugins/moduleAdapter'

/**
 * Track which (moduleId, css-content-hash) pairs we've already injected,
 * so re-rendering an instance doesn't keep appending `<style>` elements.
 * Keyed by the data-css-hash attribute the `<style>` element carries.
 */
const injectedCssHashes = new Set<string>()

/**
 * Tiny non-crypto hash — DJB2. Used purely to key the injected `<style>`
 * elements so we can dedupe by CSS content. Collision risk for distinct
 * CSS strings is irrelevant for the dedup use case (worst case: we skip
 * an injection that was a different module's CSS with the same hash —
 * but each style tag also carries `data-plugin-module` for traceability).
 */
function hashCss(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

function injectModuleCss(moduleId: string, css: string): void {
  if (typeof document === 'undefined') return
  const trimmed = css.trim()
  if (!trimmed) return
  const hash = hashCss(trimmed)
  const key = `${moduleId}:${hash}`
  if (injectedCssHashes.has(key)) return
  // Defensive — another instance may have injected the same hash before
  // this one ran (e.g. during concurrent first renders of two instances
  // of the same module).
  if (document.querySelector(
    `style[data-plugin-module="${CSS.escape(moduleId)}"][data-css-hash="${CSS.escape(hash)}"]`,
  )) {
    injectedCssHashes.add(key)
    return
  }
  const style = document.createElement('style')
  style.setAttribute('data-plugin-module', moduleId)
  style.setAttribute('data-css-hash', hash)
  style.textContent = trimmed
  document.head.appendChild(style)
  injectedCssHashes.add(key)
}

export const editorPluginModuleComponentFactory: PluginModuleComponentFactory = (definition: PluginModuleDefinition) => {
  const renderForEditor = definition.preview ?? definition.render
  const canHaveChildren = Boolean(definition.canHaveChildren)
  if (!renderForEditor) {
    throw new Error(`Plugin module "${definition.id}" has no render() or preview()`)
  }
  return function PluginCanvasModule(props: ModuleComponentProps) {
    const childList: string[] = []
    // Defensive wrap — a throwing plugin preview()/render() is caught by the
    // per-node ErrorBoundary above us, but that boundary swaps the entire
    // module subtree for an alert section, which can shift layout and noise
    // up adjacent siblings. Catching here lets us keep the wrapper div in
    // place and emit an inline placeholder, so a single bad module remains
    // visually contained to its own slot.
    let html: string
    let css: string | undefined
    try {
      const out = renderForEditor(props.props, childList)
      html = out.html
      css = out.css
    } catch (err) {
      console.error(`[plugin-module:${definition.id}] preview/render() threw:`, err)
      html = `<!-- instatic: plugin module "${definition.id}" render failed -->`
    }
    if (css) injectModuleCss(definition.id, css)
    if (canHaveChildren) {
      // dangerouslySetInnerHTML and children are mutually exclusive in React.
      // Plugins with `canHaveChildren: true` need both: rendered HTML + a
      // slot for nested React subtrees. Render the static HTML in one
      // sibling div, mount children in another, outside the dangerous boundary.
      return (
        <div className={props.mcClassName} data-plugin-canvas-module="true">
          <div dangerouslySetInnerHTML={{ __html: html }} />
          <div data-plugin-children="true">{props.children}</div>
        </div>
      )
    }
    return (
      <div
        className={props.mcClassName}
        data-plugin-canvas-module="true"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
}
