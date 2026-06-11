/**
 * Canvas module-pack VM runtime.
 *
 * Typed authoring surface for the module-pack bootstrap (formerly an inline
 * template literal in `modulePackVm.ts`). Bundled to a single IIFE string by
 * `scripts/sync-plugin-bootstrap.ts` (committed artifact:
 * `../generated/modulePackBootstrap.ts`) and evaluated inside every module-pack
 * QuickJS context after the pack's bundled source has attached its default
 * export to `globalThis.__module_pack`.
 *
 * It exposes `__initPack` (pull serialized metadata out + build the id-keyed
 * lookup), `__renderModule`, and `__previewModule`. Render output crosses the
 * host boundary as JSON via the shared `boundary` helpers.
 */

import { fromJson } from './boundary'

// Minimal console (silent). Module render() functions must not need logs;
// plugins that need diagnostics use api.plugin.log via the server entrypoint,
// not console inside a render. QuickJS ships no console, so we stub one to
// keep an accidental console.* call from throwing mid-render.
const noop = function () { /* silent */ }
globalThis.console = {
  log: noop, info: noop, warn: noop,
  error: noop, debug: noop, trace: noop,
} as Console

/** Normalize a render()/preview() return into the `{ html, css, js }` wire shape. */
function normalizeRenderOutput(out: unknown): { html: string; css?: string; js?: string } {
  const o = out as { html?: unknown; css?: unknown; js?: unknown } | null
  return {
    html: o && typeof o === 'object' && typeof o.html === 'string' ? o.html : '',
    css: o && typeof o === 'object' && typeof o.css === 'string' ? o.css : undefined,
    js: o && typeof o === 'object' && typeof o.js === 'string' ? o.js : undefined,
  }
}

/**
 * Resolve the pack's default export to a flat array of module definitions.
 * The pack can default-export either an array or a function that returns
 * one (the latter pattern lets the pack author parameterize by pluginId).
 */
globalThis.__initPack = function initPack(pluginId) {
  const entry = globalThis.__module_pack
  const value = typeof entry === 'function' ? entry({ pluginId: pluginId }) : entry
  if (!Array.isArray(value)) {
    throw new Error('Plugin "' + pluginId + '" module pack default export must be an array (or a function returning one)')
  }
  // Keyed by id so the host can call render(id, ...) without re-scanning.
  const byId: Record<string, ModulePackEntry> = {}
  for (const def of value) {
    if (!def || typeof def !== 'object' || typeof def.id !== 'string') {
      throw new Error('Plugin "' + pluginId + '" module pack contains a non-object entry')
    }
    byId[def.id] = def
  }
  globalThis.__modules = byId
  // Return a SERIALIZED snapshot — metadata only, no functions.
  return value.map(function (def) {
    // dependencies and editorRuntime are JSON-serializable shapes — copy
    // them through so the host can wire deps into the site package.json
    // and build the iframe sandbox's import map.
    const deps = def.dependencies && typeof def.dependencies === 'object'
      ? def.dependencies
      : undefined
    const editorRuntime = def.editorRuntime && typeof def.editorRuntime === 'object'
      ? def.editorRuntime
      : undefined
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      version: def.version,
      defaults: def.defaults || {},
      schema: def.schema || {},
      canHaveChildren: !!def.canHaveChildren,
      htmlTag: typeof def.htmlTag === 'string' ? def.htmlTag : undefined,
      hasPreview: typeof def.preview === 'function',
      dependencies: deps,
      editorRuntime: editorRuntime,
    }
  })
}

globalThis.__renderModule = function renderModule(moduleId, propsJson, childrenJson) {
  const def = globalThis.__modules && globalThis.__modules[moduleId]
  if (!def) throw new Error('Module not found: ' + moduleId)
  if (typeof def.render !== 'function') {
    throw new Error('Module "' + moduleId + '" has no render() function')
  }
  const props = fromJson(propsJson)
  const children = fromJson(childrenJson)
  const out = def.render(props, children)
  return JSON.stringify(normalizeRenderOutput(out))
}

globalThis.__previewModule = function previewModule(moduleId, propsJson, childrenJson) {
  const def = globalThis.__modules && globalThis.__modules[moduleId]
  if (!def) throw new Error('Module not found: ' + moduleId)
  // Fall back to render() when preview is not provided — matches the SDK contract.
  const fn = typeof def.preview === 'function' ? def.preview : def.render
  if (typeof fn !== 'function') {
    throw new Error('Module "' + moduleId + '" has no render() or preview() function')
  }
  const props = fromJson(propsJson)
  const children = fromJson(childrenJson)
  const out = fn(props, children)
  return JSON.stringify(normalizeRenderOutput(out))
}
