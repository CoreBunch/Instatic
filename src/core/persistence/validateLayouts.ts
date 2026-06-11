/**
 * Saved-layout validation at the persistence boundary — Constraint #230: ALL
 * site data loaded from storage MUST be validated before reaching the store.
 *
 * `validateSavedLayouts(rawLayouts): SavedLayout[]`
 *   Tolerant LOAD path: parse each raw layout via `parseSavedLayout`, drop
 *   incoherent trees, dedupe by name, sanitize richtext props. Never throws.
 *
 * `validateSavedLayoutsForPartialWrite(rawChanged, existing, keptIds)`
 *   Strict WRITE path mirroring `validateVisualComponentsForPartialWrite`:
 *   only the changed layouts pay parse + tree-invariant + sanitize costs; the
 *   id/name identity rules run against the merged post-save roster.
 */

import { assertValidNodeTree } from '@core/page-tree'
import { layoutNameError, parseSavedLayout, type SavedLayout } from '@core/layouts'
import {
  SiteValidationError,
  sanitizeNodeProps,
  siteValidationErrorFromTreeInvariant,
} from './validationShared'

/**
 * Parse and validate an array of raw SavedLayout objects (loaded via
 * `savedLayoutFromRow` from `data_rows where table_id = 'layouts'`).
 *
 * Steps:
 *   1. Parse each via `parseSavedLayout` — silently drops malformed entries.
 *   2. Drop layouts whose snapshot tree is incoherent (root missing, dangling
 *      child ids, cycles).
 *   3. Deduplicate by name (first-wins; empty names dropped).
 *   4. Sanitize richtext-keyed props in snapshot nodes (XSS — Constraint #299).
 *
 * Layouts are self-contained snapshots: VC refs inside them are intentionally
 * NOT stripped against the current VC roster here — the insert flow resolves
 * refs at insertion time. Never throws — malformed data is silently dropped.
 */
export function validateSavedLayouts(rawLayouts: unknown[]): SavedLayout[] {
  const parsed: SavedLayout[] = rawLayouts.flatMap((item) => {
    const layout = parseSavedLayout(item)
    if (!layout) return []
    try {
      assertValidNodeTree(layout, 'site.layouts[]')
    } catch {
      return []
    }
    return [layout]
  })

  const seenNames = new Set<string>()
  const deduped = parsed.filter((layout) => {
    if (layoutNameError(layout.name, []) !== null) return false
    if (seenNames.has(layout.name)) return false
    seenNames.add(layout.name)
    return true
  })
  sanitizeLayoutNodeRichtextProps(deduped)
  return deduped
}

/**
 * Strict write-boundary validation for a PARTIAL saved-layout save. Only the
 * changed layouts are parsed and tree-checked; the id/name identity rules run
 * against the POST-SAVE roster (`existing` with rows missing from `keptIds`
 * removed and the changed batch merged over it by id).
 *
 * Returns the parsed CHANGED layouts only (what the caller writes).
 */
export function validateSavedLayoutsForPartialWrite(
  rawChangedLayouts: unknown[],
  existing: SavedLayout[],
  keptIds: ReadonlySet<string>,
): SavedLayout[] {
  const parsed: SavedLayout[] = []
  for (let i = 0; i < rawChangedLayouts.length; i++) {
    const layout = parseSavedLayout(rawChangedLayouts[i])
    if (!layout) {
      throw new SiteValidationError('invalid saved layout', `site.layouts[${i}]`)
    }
    try {
      assertValidNodeTree(layout, `site.layouts[${i}]`)
    } catch (err) {
      throw siteValidationErrorFromTreeInvariant(err, `site.layouts[${i}]`)
    }
    parsed.push({ ...layout, name: layout.name.trim() })
  }

  const changedById = new Map(parsed.map((layout) => [layout.id, layout]))
  const merged: SavedLayout[] = [
    ...existing.filter((layout) => keptIds.has(layout.id) && !changedById.has(layout.id)),
    ...parsed,
  ]
  const seenIds = new Set<string>()
  for (let i = 0; i < merged.length; i++) {
    const layout = merged[i]
    if (seenIds.has(layout.id)) {
      throw new SiteValidationError(`duplicate saved layout id "${layout.id}"`, `site.layouts[${i}].id`)
    }
    seenIds.add(layout.id)
    const nameError = layoutNameError(layout.name, merged, layout.id)
    if (nameError) {
      throw new SiteValidationError(nameError, `site.layouts[${i}].name`)
    }
  }
  sanitizeLayoutNodeRichtextProps(parsed)
  return parsed
}

/** Sanitize richtext-keyed props on every layout snapshot node. */
function sanitizeLayoutNodeRichtextProps(layouts: SavedLayout[]): void {
  for (const layout of layouts) {
    for (const node of Object.values(layout.nodes)) sanitizeNodeProps(node)
  }
}
