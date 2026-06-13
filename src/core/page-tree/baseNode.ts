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
  moduleId: Type.String(),

  // Resolved property values for this node's module.
  // Shape validated against ModuleDefinition.schema at runtime.
  // Keys are FLAT — no dot-path nesting.
  props: withFallback(Type.Record(Type.String(), Type.Unknown()), {}),

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
 * Throws `Error('<path>.<field>: …')` when a required field (id, moduleId,
 * children) is absent or the wrong type; returns the normalised BaseNode
 * otherwise. `parentId` is intentionally omitted — it is recomputed by
 * `reindexNodeParents` after the whole tree is parsed.
 */
export function parseBaseNodeFields(r: Record<string, unknown>, path: string): BaseNode {
  const id = requireStringField(r, 'id', path)
  const moduleId = requireStringField(r, 'moduleId', path)
  const rawChildren = requireArrayField(r, 'children', path)

  const propBindings = parsePropBindings(r.propBindings)
  // Inline styles — same tolerant bag parser as props/class styles. Dropped
  // when missing or empty so nodes without inline styles stay lean.
  const inlineStyles = parseStylesBag(r.inlineStyles)

  return {
    id,
    moduleId,
    props: parseStylesBag(r.props),
    breakpointOverrides: parseBreakpointStylesBag(r.breakpointOverrides),
    children: onlyStrings(rawChildren),
    classIds: Array.isArray(r.classIds) ? onlyStrings(r.classIds) : [],
    ...(typeof r.label === 'string' ? { label: r.label } : {}),
    ...(typeof r.locked === 'boolean' ? { locked: r.locked } : {}),
    ...(typeof r.hidden === 'boolean' ? { hidden: r.hidden } : {}),
    ...(propBindings !== undefined ? { propBindings } : {}),
    ...(Object.keys(inlineStyles).length > 0 ? { inlineStyles } : {}),
  }
}
