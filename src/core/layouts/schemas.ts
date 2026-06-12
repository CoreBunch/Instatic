/**
 * Saved Layouts — TypeBox schemas and derived types.
 *
 * A saved layout is a named, self-contained snapshot of a page subtree:
 * the flat node map (rooted at `rootNodeId`) plus every style rule the
 * captured nodes referenced at save time. The shape deliberately mirrors
 * the editor clipboard payload — inserting a layout uses the same
 * snapshot-paste engine as paste (fresh node ids, scoped classes cloned
 * with remapped scope, framework classes re-matched by name, regular
 * classes reused or re-imported).
 *
 * Storage is in `data_rows` where `table_id = 'layouts'`. The adapter
 * `savedLayoutFromRow` / `savedLayoutToCells` in `@core/data/layoutFromRow`
 * handles the round-trip.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof Schema>`.
 * Constraint #269: this file must NOT import from editor/ or editor-store/.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  PageNodeSchema,
  StyleRuleSchema,
  parsePageNode,
  parseStyleRule,
  reindexNodeParents,
  type PageNode,
  type StyleRule,
} from '@core/page-tree'

// ---------------------------------------------------------------------------
// SavedLayout — top-level saved-layout document
// ---------------------------------------------------------------------------

export const SavedLayoutSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  /** Root of the captured subtree — must resolve inside `nodes`. */
  rootNodeId: Type.String({ minLength: 1 }),
  /** Flat map of every node in the captured subtree. */
  nodes: Type.Record(Type.String(), PageNodeSchema),
  /**
   * Style rules referenced by any captured node, snapshotted at save time so
   * the layout stays insertable even if a referenced class is later deleted
   * from the site.
   */
  classes: Type.Record(Type.String(), StyleRuleSchema),
  /** Falls back to Date.now() for missing or non-numeric values — handled by parser */
  createdAt: Type.Number(),
})

export type SavedLayout = Static<typeof SavedLayoutSchema>

// ---------------------------------------------------------------------------
// parseSavedLayout — tolerant parser
// ---------------------------------------------------------------------------

/**
 * Tolerant parser for a SavedLayout. Handles:
 *   - nodes: parsed via parsePageNode; structurally invalid nodes are dropped
 *     from the snapshot rather than failing the whole layout
 *   - classes: parsed via parseStyleRule; invalid entries silently dropped
 *   - createdAt: falls back to Date.now() for missing/invalid timestamps
 *
 * Returns null when required fields (id, name, rootNodeId) are invalid or when
 * rootNodeId is not found in the parsed nodes map.
 */
export function parseSavedLayout(raw: unknown): SavedLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.name !== 'string' || r.name.length === 0) return null
  if (typeof r.rootNodeId !== 'string' || r.rootNodeId.length === 0) return null
  if (!r.nodes || typeof r.nodes !== 'object' || Array.isArray(r.nodes)) return null

  const nodes: Record<string, PageNode> = {}
  for (const rawNode of Object.values(r.nodes as Record<string, unknown>)) {
    try {
      const node = parsePageNode(rawNode, 'node')
      nodes[node.id] = node
    } catch (_err) {
      // Tolerant drop: a node missing a required field is omitted from the
      // snapshot rather than rejecting the whole layout.
    }
  }
  if (!nodes[r.rootNodeId]) return null

  const classes: Record<string, StyleRule> = {}
  if (r.classes && typeof r.classes === 'object' && !Array.isArray(r.classes)) {
    for (const rawClass of Object.values(r.classes as Record<string, unknown>)) {
      const cls = parseStyleRule(rawClass)
      if (cls) classes[cls.id] = cls
    }
  }

  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()

  // Derive the parentId index from the children arrays — never trust a stored
  // parentId value.
  reindexNodeParents(nodes)

  return {
    id: r.id,
    name: r.name,
    rootNodeId: r.rootNodeId,
    nodes,
    classes,
    createdAt,
  }
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * Derive the storage slug from a saved-layout name.
 * Converts to lower-kebab-case; falls back to 'layout' on empty input.
 */
export function layoutSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
  return slug || 'layout'
}

/**
 * Validate a saved-layout name: non-empty after trimming and unique within the
 * site. Uniqueness is judged on the DERIVED SLUG (names are stored as
 * `data_rows.slug` via `layoutSlugFromName`), so "Hero!" and "Hero?" — distinct
 * strings, identical slugs — count as duplicates.
 *
 * @param selfId  When renaming, the layout's own id — excluded from the
 *                duplicate check so renaming to the current name is allowed.
 * @returns A human-readable reason string, or null when the name is valid.
 */
export function layoutNameError(
  name: string,
  existing: ReadonlyArray<{ id: string; name: string }>,
  selfId?: string,
): string | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'Layout name is required.'
  const slug = layoutSlugFromName(trimmed)
  const duplicate = existing.find((l) => l.id !== selfId && layoutSlugFromName(l.name) === slug)
  if (duplicate) {
    return duplicate.name === trimmed
      ? `Another layout is already named "${trimmed}".`
      : `"${trimmed}" conflicts with the existing layout "${duplicate.name}" — both store as "${slug}".`
  }
  return null
}
