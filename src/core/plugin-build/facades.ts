/**
 * Facade-source generation for sandboxed plugin bundles. Shared by the CLI
 * build (`instatic-plugin build`) and the server-side site plugin build —
 * the facade is what lets the QuickJS runner find the plugin's exports on a
 * `globalThis` slot without touching the author's own source.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Generate the IIFE facade source that re-exports the user's entrypoint to
 * a `globalThis.<slot>` so the QuickJS sandbox can find it. The user's
 * source is left untouched; this facade is bundled WITH it.
 *
 * For 'server' sandboxes the runner expects `__plugin_exports.activate`
 * etc. as direct properties — but plugin authors reasonably write either:
 *
 *   // shape A: named exports
 *   export function activate(api) { … }
 *   export function deactivate(api) { … }
 *
 *   // shape B: single default export — much more common in TS+ESM code
 *   const mod = { install, activate, deactivate, uninstall }
 *   export default mod
 *
 * Shape A maps cleanly to `import * as __plugin` (every named export shows
 * up as a property). Shape B does NOT — `__plugin.default` holds the
 * module object, and `__plugin.activate` is undefined, so the runner
 * silently no-ops the lifecycle hook. The facade therefore detects shape B
 * at runtime and unwraps it: when the default export looks like a plugin
 * module (at least one known lifecycle hook is a function on it), the
 * default is promoted — falling back to the namespace so shape A still
 * works unchanged.
 *
 * For 'modules' sandboxes, only the default export is exfiltrated (the
 * SDK's `definePack` builder default-exports the array of modules).
 */
export function generateSandboxFacade(entrypointAbsolutePath: string, kind: 'server' | 'modules'): string {
  // Bun's bundler accepts absolute paths in import specifiers.
  const importPath = JSON.stringify(entrypointAbsolutePath)
  if (kind === 'server') {
    return [
      `import * as __plugin from ${importPath};`,
      `const __default = __plugin && __plugin.default;`,
      `const __isPluginModule = (v) => v && typeof v === 'object' && (`,
      `  typeof v.install === 'function' || typeof v.activate === 'function' ||`,
      `  typeof v.deactivate === 'function' || typeof v.uninstall === 'function' ||`,
      `  typeof v.migrate === 'function'`,
      `);`,
      `globalThis.__plugin_exports = __isPluginModule(__default) ? __default : __plugin;`,
    ].join('\n')
  }
  return [
    `import __default from ${importPath};`,
    `globalThis.__module_pack = __default;`,
  ].join('\n')
}

/**
 * Generate a tiny facade module that imports each module file in
 * `<src>/modules/`, collects the default exports, and re-exports them as a
 * single array. The facade is what gets bundled into `dist/modules/index.js`.
 *
 * Convention: every `.ts` file directly under `<src>/modules/` whose default
 * export is a `PluginModuleDefinition` becomes a registered module.
 */
export function generateModulesFacade(sourceDir: string): string {
  const modulesDir = join(sourceDir, 'modules')
  if (!existsSync(modulesDir)) {
    throw new Error(`Plugin declares modules but ${modulesDir} does not exist`)
  }
  const files = readdirSync(modulesDir)
  const moduleFiles = files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.startsWith('index.'))
  if (moduleFiles.length === 0) {
    throw new Error(`No module files found under ${modulesDir}`)
  }
  const imports = moduleFiles
    .map((file, idx) => `import m${idx} from './modules/${file.replace(/\.(tsx?|m?js)$/, '')}'`)
    .join('\n')
  const defaultExport = `export default [${moduleFiles.map((_, idx) => `m${idx}`).join(', ')}]`
  return `${imports}\n${defaultExport}\n`
}
