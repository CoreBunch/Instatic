/**
 * ESM → global handoff shim — the ONE rewriter both QuickJS sandboxes share.
 *
 * QuickJS has no module loader, so a plugin bundle (or a hand-authored
 * single-file fixture) must be flattened from ESM into a plain script that
 * hands its exports to a `globalThis.<globalName>` the bootstrap reads. Two
 * sandboxes consume this:
 *
 *   - the full-plugin worker (`pluginWorker.ts`), global `__plugin_exports` —
 *     wants the whole exports object, because plugin lifecycle hooks are named
 *     exports (`export function activate(api) { … }`);
 *   - the canvas module-pack VM (`modulePackVm.ts`), global `__module_pack` —
 *     wants only the default export value (an array of module definitions, or
 *     a factory function returning one) assigned directly.
 *
 * Export forms handled — the union of every shape Bun's bundler and plugin
 * authors emit (previously split across two diverging private copies):
 *
 *   - `export default <expr>`               — direct default export
 *   - `export default function/class …`     — default declaration
 *   - `export function/const/let <name> …`  — named declarations
 *   - `export { a as default, b, c }`       — re-export / mixed default+named
 *     blocks (Bun emits this for default re-export facades)
 *
 * `unwrapDefault` selects the global's SHAPE — the single legitimate
 * difference between the two bootstraps. Everything else (which forms are
 * recognised) is identical, so a bundle that loads as a plugin also loads as a
 * module pack.
 */

export function wrapEsmAsGlobal(
  source: string,
  globalName: string,
  options: { unwrapDefault?: boolean } = {},
): string {
  // If the source already targets the bridge's global, it came pre-flattened
  // from the SDK bundler — pass through untouched.
  if (source.includes(globalName)) return source

  // Anchored regexes match `export` at the start of a (possibly indented)
  // line. Each export form is rewritten to a property on a local `__exports`
  // object; the global handoff at the end picks the shape.
  let transformed = source
    .replace(
      /^([ \t]*)export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      '$1__exports.$3 = $2function $3',
    )
    .replace(
      /^([ \t]*)export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm,
      '$1__exports.$2 =',
    )
    .replace(
      /^([ \t]*)export\s+let\s+([A-Za-z_$][\w$]*)\s*=/gm,
      '$1__exports.$2 =',
    )
    .replace(
      /^([ \t]*)export\s+default\s+/gm,
      '$1__exports.default = ',
    )

  // Rewrite `export { foo as default[, bar, …] }` blocks into one assignment
  // per entry: `as default` → `__exports.default`, bare names → same-name
  // properties. Anything unparseable falls through; the QuickJS eval then
  // surfaces a clear SyntaxError to the caller.
  transformed = transformed.replace(
    /^([ \t]*)export\s*\{([^}]*)\}\s*;?/gm,
    (_match, indent: string, body: string) => {
      const assigns: string[] = []
      for (const rawEntry of body.split(',')) {
        const entry = rawEntry.trim()
        if (!entry) continue
        const asMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        if (asMatch) {
          assigns.push(`${indent}__exports.${asMatch[2]} = ${asMatch[1]};`)
          continue
        }
        const bareMatch = entry.match(/^([A-Za-z_$][\w$]*)$/)
        if (bareMatch) {
          assigns.push(`${indent}__exports.${bareMatch[1]} = ${bareMatch[1]};`)
        }
      }
      return assigns.join('\n')
    },
  )

  const handoff = options.unwrapDefault
    ? `globalThis.${globalName} = __exports.default;`
    : `globalThis.${globalName} = __exports;`

  // The prelude shares the first physical line with the source's first line
  // (and the handoff comes after it) so wrapping adds ZERO line offset —
  // QuickJS stack traces from the wrapped eval (filename `plugin:<id>` /
  // `module-pack:<id>`) report the same line numbers as the bundle the
  // author shipped.
  return `;(function () { const __exports = {}; ${transformed}\n${handoff}\n})();\n`
}
