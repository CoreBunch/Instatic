/**
 * BaseNode — shared structural base for both page-flat-map nodes (PageNode)
 * and Visual Component tree nodes (VCNode).
 *
 * Lives in its own module (rather than inside `page-tree/types.ts`) so that
 * `visualComponents/schemas.ts` can import this base without pulling in the
 * full Site / page-tree type graph — which would create the cycle
 * `page-tree/types ↔ visualComponents/{types,schemas}`.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static, withFallback } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import {
  onlyStrings,
  parseBreakpointStylesBag,
  parseStylesBag,
  requireArrayField,
  requireStringField,
} from './parseHelpers'

// ---------------------------------------------------------------------------
// PropBinding — used by both BaseNode (propBindings field) and VCNodeSchema
// ---------------------------------------------------------------------------

/** Maps prop key → { paramId } for render-time VC parameter substitution. */
const PropBindingSchema = Type.Object({ paramId: Type.String() })

// ---------------------------------------------------------------------------
// BaseNodeSchema — shared structural schema for PageNode and VCNode
//
// `PageNodeSchema` (in `./schemas`) extends this with an optional
// `dynamicBindings` field for template data-binding on page-level nodes.
//
// `VCNodeSchema` (in `src/core/visualComponents/schemas.ts`) is a direct
// re-export of this schema — VCNode === BaseNode. VC trees use the same flat
// `children: string[]` flat-ID map as Page trees.
//
// The shared base eliminates `as unknown as PageNode` / `as unknown as VCNode`
// casts when tree-walking functions need to operate on nodes from either context.
// ---------------------------------------------------------------------------

export const BaseNodeSchema = Type.Object({
  // Unique ID — generated with nanoid()
  id: Type.String(),

  // References a ModuleDefinition in the registry.
  // Format: "namespace.module-name" — e.g. "base.text"
  //
  // Empty string `""` for DOM-native nodes (which use `tag`/`attributes`/
  // `textContent` instead). The discriminant is `!node.moduleId` — see
  // `isDomNode()`. Kept as a required string so existing code that accesses
  // `node.moduleId` doesn't need null guards.
  moduleId: withFallback(Type.String(), '' as string),

  // Resolved property values for this node's module.
  // Shape validated against ModuleDefinition.schema at runtime.
  // Keys are FLAT — no dot-path nesting.
  // Only meaningful when `moduleId` is present (module-based nodes).
  props: withFallback(Type.Record(Type.String(), Type.Unknown()), {}),

  // ── DOM-native fields (used when moduleId is absent) ──────────────────
  //
  // When `moduleId` is absent, the node stores actual HTML structure:
  //   - `tag` — the HTML tag name (e.g. "h1", "div", "section")
  //   - `attributes` — HTML attributes as key→string pairs (e.g. { class: "hero", "data-x": "1" })
  //   - `textContent` — leaf text content (only when the node has no element children)
  //
  // The publisher serialises these directly to HTML without calling a module
  // render() function. See `renderNode.ts` for the DOM-native branch.
  tag: Type.Optional(Type.String()),
  attributes: Type.Optional(Type.Record(Type.String(), Type.String())),
  textContent: Type.Optional(Type.String()),

  // Per-breakpoint prop overrides — shallow-merged on top of props when
  // rendering at a given breakpoint. Key is Breakpoint.id.
  breakpointOverrides: withFallback(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
    {},
  ),

  // Ordered array of child node IDs.
  // Only meaningful when ModuleDefinition.canHaveChildren === true.
  // All children are in a single default slot (multi-slot deferred post-MVP).
  // Strict (no fallback): non-array children throw SiteValidationError at load
  // time (mirrors validatePageNode assertArray behaviour — Constraint #230).
  children: Type.Array(Type.String()),

  // Denormalised pointer to this node's parent — `null` for the root node (and
  // for a freshly-created, not-yet-inserted node). It is a DERIVED CACHE of the
  // `children` arrays (which remain the structural source of truth): every tree
  // mutation that changes parentage updates it, and every load/parse/compose
  // entry point recomputes it via `reindexNodeParents`. It exists so `getParent`
  // is O(1) instead of scanning every node — see selectors.getParent.
  //
  // Optional at the schema level so persisted data predating this field, and
  // transient detached nodes, still validate; the runtime invariant (enforced
  // by reindex on every load and by every mutation) guarantees it is fully and
  // consistently populated for any tree that has entered the system.
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),

  // Optional user-facing label — overrides the module name in the DOM tree panel
  label: Type.Optional(Type.String()),

  // When true, cannot be selected or moved in the editor
  locked: Type.Optional(Type.Boolean()),

  // When true, hidden on the canvas (still present in the tree)
  hidden: Type.Optional(Type.Boolean()),

  // Ordered class IDs from the site's class registry.
  // Applied as the referenced user-facing class names on the element.
  // Later classes in the array win in cascade order.
  // Empty array when no classes are applied.
  classIds: withFallback(Type.Array(Type.String()), []),

  // Per-node inline styles — emitted by the publisher as a literal
  // `style="…"` attribute on the node's root element. This is the editor's
  // "inline style" layer: an independent style source that coexists with
  // `classIds` and, like a real HTML inline style, is BASE-ONLY (it cannot be
  // breakpoint- or condition-scoped). Keys are camelCase CSS property names
  // (same shape as a StyleRule's `styles` bag). Absent / empty when the node
  // has no inline styles. Values are sanitised at the publish boundary.
  inlineStyles: Type.Optional(Type.Record(Type.String(), Type.Unknown())),

  // Prop bindings for render-time parameter substitution.
  // Maps prop key → { paramId } (stable VCParam.id reference).
  // When present, the renderer substitutes instanceProps[param.name] for
  // the bound prop key at render time (Contribution #619 §4 Option β).
  // Optional — absent on all standard Page nodes and unbound VC nodes.
  //
  // Per-entry lenience: use parsePropBindings() when parsing raw node data —
  // it filters invalid entries rather than failing the whole field. The
  // schema here reflects the validated type; the helper does the filtering.
  propBindings: Type.Optional(Type.Record(Type.String(), PropBindingSchema)),

  // ── Module overlay (HTML-first unified node model) ────────────────────
  //
  // When present, this node carries BOTH the canonical HTML structure
  // (`tag`/`attributes`/`textContent`) AND a module overlay that provides
  // structured editing UX (property panel controls, inline edit, picker).
  //
  // The HTML fields are the source of truth for publishing and canvas
  // rendering. The overlay is purely additive — it maps props ↔ HTML
  // fields via the module's `htmlContract` so editing a prop updates the
  // HTML and vice versa. This enables lossless round-trip editing between
  // IDE/LLM-generated HTML and the CMS visual editor.
  //
  // A node with `moduleOverlay` has `moduleId === ''` (the legacy
  // discriminant stays empty so `isDomNode()` returns true — the publisher
  // and canvas treat it as a DOM-native node that happens to have an
  // overlay). The overlay's `moduleId` is the real module reference.
  //
  // Absent on pure DOM-native nodes (no module claims them) and on
  // legacy-format nodes that haven't been migrated yet (those still use
  // the top-level `moduleId` + `props` fields).
  moduleOverlay: Type.Optional(Type.Object({
    moduleId: Type.String(),
    props: withFallback(Type.Record(Type.String(), Type.Unknown()), {}),
  })),
})

export type BaseNode = Static<typeof BaseNodeSchema>

// ---------------------------------------------------------------------------
// parsePropBindings — sibling helper for per-entry-lenient propBindings parsing
//
// Replaces the Zod `.catch({}).transform((map) => {...}).optional()` chain.
// Call this when parsing raw node data (page-tree and VC node deserialization)
// to silently drop entries that don't match PropBindingSchema, rather than
// failing the whole field.
// ---------------------------------------------------------------------------

/**
 * Parse and filter a raw propBindings map. Invalid entries are silently
 * dropped; returns `undefined` when no valid entries remain.
 *
 * Use this at the raw-data parsing layer (page-tree/pageNode and
 * visualComponents/schemas) instead of relying on schema-level transforms.
 */
function parsePropBindings(
  raw: unknown,
): Record<string, { paramId: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, { paramId: string }> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (compiledCheck(PropBindingSchema, v)) {
      out[k] = v
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// parseBaseNodeFields — the single tolerant parser for the shared BaseNode shape
//
// Both PageNode and VCNode are structurally BaseNode. This is the ONE place
// that normalises a persisted node's shared fields:
//   - id / moduleId / children are required (throws `<path>.<field>: …`)
//   - props / breakpointOverrides / classIds / inlineStyles / propBindings
//     get their tolerant `withFallback` defaults via the shared parseHelpers
//     primitives, so a fix to that tolerance lands once for pages and VCs.
//
// `parsePageNode` (in ./pageNode) layers the page-only `dynamicBindings` field
// on top; `parseVCNode` (in visualComponents/schemas) uses it as-is, converting
// a thrown required-field error into a `null` drop.
// ---------------------------------------------------------------------------

/**
 * Parse the shared BaseNode fields from an already-narrowed record `r`.
 * Throws `Error('<path>.<field>: …')` when a required field (id, children)
 * is absent or the wrong type; returns the normalised BaseNode
 * otherwise. `parentId` is intentionally omitted — it is recomputed by
 * `reindexNodeParents` after the whole tree is parsed.
 */
export function parseBaseNodeFields(r: Record<string, unknown>, path: string): BaseNode {
  const id = requireStringField(r, 'id', path)
  const rawChildren = requireArrayField(r, 'children', path)

  const propBindings = parsePropBindings(r.propBindings)
  // Inline styles — same tolerant bag parser as props/class styles. Dropped
  // when missing or empty so nodes without inline styles stay lean.
  const inlineStyles = parseStylesBag(r.inlineStyles)

  // moduleId is optional — empty string means DOM-native node (uses tag/attributes/textContent)
  const rawModuleId = r.moduleId
  const moduleId = typeof rawModuleId === 'string' && rawModuleId.length > 0 ? rawModuleId : ''

  // DOM-native fields — only meaningful when moduleId is empty (or when the
  // node uses the new unified model: moduleId === '' + moduleOverlay).
  const tag = typeof r.tag === 'string' ? r.tag : undefined
  const textContent = typeof r.textContent === 'string' ? r.textContent : undefined
  const attributes = parseStringRecord(r.attributes)

  // Module overlay — present on unified HTML-first nodes that carry both
  // canonical HTML structure and a module reference for structured editing.
  const moduleOverlay = parseModuleOverlay(r.moduleOverlay)

  return {
    id,
    moduleId,
    props: parseStylesBag(r.props),
    breakpointOverrides: parseBreakpointStylesBag(r.breakpointOverrides),
    children: onlyStrings(rawChildren),
    classIds: Array.isArray(r.classIds) ? onlyStrings(r.classIds) : [],
    ...(tag !== undefined ? { tag } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(typeof r.label === 'string' ? { label: r.label } : {}),
    ...(typeof r.locked === 'boolean' ? { locked: r.locked } : {}),
    ...(typeof r.hidden === 'boolean' ? { hidden: r.hidden } : {}),
    ...(propBindings !== undefined ? { propBindings } : {}),
    ...(Object.keys(inlineStyles).length > 0 ? { inlineStyles } : {}),
    ...(moduleOverlay !== undefined ? { moduleOverlay } : {}),
  }
}

// ---------------------------------------------------------------------------
// DOM-native helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw value into a `Record<string, string>` or `undefined`.
 * Used for the DOM-native `attributes` field. Non-string values are coerced
 * to strings; non-object values yield `undefined`.
 */
function parseStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v
    } else if (v !== null && v !== undefined) {
      out[k] = String(v)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Parse a raw `moduleOverlay` value into the validated shape or `undefined`.
 *
 * The overlay must be an object with a non-empty `moduleId` string and an
 * optional `props` record. Invalid shapes are silently dropped (return
 * `undefined`) so a corrupted overlay never breaks page loading.
 */
function parseModuleOverlay(raw: unknown):
  | { moduleId: string; props: Record<string, unknown> }
  | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const moduleId = typeof obj.moduleId === 'string' ? obj.moduleId : ''
  if (!moduleId) return undefined
  const props = parseStylesBag(obj.props)
  return { moduleId, props }
}

/**
 * Returns `true` when the node is DOM-native (empty `moduleId`, has a `tag`).
 * DOM-native nodes are serialised directly to HTML by the publisher instead
 * of going through a module `render()` function.
 */
export function isDomNode(node: Pick<BaseNode, 'moduleId' | 'tag'>): boolean {
  return !node.moduleId && !!node.tag
}

/**
 * HTML void elements — tags that cannot have children and are self-closing.
 * Shared by the publisher (renderNode.ts) and the DnD validation logic so
 * both surfaces agree on which DOM-native tags can accept children.
 */
export const VOID_HTML_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Returns `true` when a DOM-native node with the given tag can have element
 * children. Void elements (`br`, `img`, `input`, etc.) cannot.
 */
export function domCanHaveChildren(tag: string): boolean {
  return !VOID_HTML_ELEMENTS.has(tag)
}
