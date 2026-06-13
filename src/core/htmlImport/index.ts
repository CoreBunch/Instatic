/**
 * src/core/htmlImport — HTML → PageNode importer.
 *
 * Public API:
 *
 *   importHtml(source)   — parse → harvest → strip → walk; the single entry point.
 *   parseHtml(source)    — DOMParser wrapper (browser / test polyfill).
 *   stripUnsafe(doc)     — mutates doc in place, returns StripReport.
 *   collectStyleCss(doc) — concatenated CSS of every <style> block (pre-strip).
 *   harvestInlineStyles  — per-element inline style="…" bags (pre-strip).
 *   extractInlineStyles  — one element's inline declarations as a camelCase bag.
 *   walkAndMap(doc)      — maps doc.body element children to PageNodes.
 *   HTML_TO_MODULE_RULES — declarative element → module mapping table.
 *
 * Types:
 *   ImportFragment  — { nodes, rootIds, body? } flat NodeTree fragment plus optional body attributes.
 *   ImportResult    — ImportFragment + stripped (StripReport) + styleCss (raw <style> CSS).
 *   StripReport     — counts of dropped constructs (scripts, inline handlers).
 *   ImportRule      — shape of a single rule in HTML_TO_MODULE_RULES.
 *
 * All imports into this module from outside go through this barrel.
 * Internal files import each other via relative paths.
 */

export type {  ImportFragment, ImportResult } from './walkAndMap'

export { parseHtml } from './parseHtml'
export { stripUnsafe } from './stripUnsafe'
export { walkAndMap, importHtml } from './walkAndMap'

export { normalizeImportedText } from './text'
