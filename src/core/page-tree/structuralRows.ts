/**
 * Structural row enumeration — the ONE answer to "which rows does a
 * structural explorer section contain, and how are they ordered?". Shared by
 * the explorer panel's DnD hook (current-index lookup) and the store's
 * reorder action (target-index math) so the two can never disagree.
 */

import type { SiteDocument } from './siteDocument'
import type { StructuralSiteExplorerSectionId } from './siteExplorer'
import { isHomePage } from './slugs'
import { addFolderPrefixes, optionalParentPath, parentPathForPath } from './explorerPaths'

// explorer panel's DnD hook (current-index lookup) and the store's
// reorder action (target-index math) so the two can never disagree.
// ---------------------------------------------------------------------------

export interface StructuralExplorerRow {
  kind: 'folder' | 'item'
  id: string
  parentPath?: string
  /** Persisted order from the section rowOrder; +Infinity when unordered. */
  order: number
  /** Position in the section's natural enumeration — the stable tie-break. */
  naturalOrder: number
}

/**
 * Enumerate every row of a structural section: items (non-template,
 * non-home pages, or non-generated files of the section's type) plus every
 * folder implied by their paths and the persisted empty folders, each
 * stamped with its persisted `order` and natural position.
 */
export function structuralRowsForSection(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
): StructuralExplorerRow[] {
  const rows: Array<Omit<StructuralExplorerRow, 'order' | 'naturalOrder'>> = []
  const folders = new Set(site.explorer[sectionId].emptyFolders)

  if (sectionId === 'pages') {
    for (const page of site.pages) {
      if (page.template || isHomePage(page)) continue
      rows.push({ kind: 'item', id: page.id, ...optionalParentPath(parentPathForPath(page.slug)) })
      addFolderPrefixes(folders, page.slug)
    }
  } else {
    const type = sectionId === 'styles' ? 'style' : 'script'
    for (const file of site.files) {
      if (file.type !== type || (file.generated && !file.ejected)) continue
      rows.push({ kind: 'item', id: file.id, ...optionalParentPath(parentPathForPath(file.path)) })
      addFolderPrefixes(folders, file.path)
    }
  }

  for (const folderPath of folders) {
    rows.push({ kind: 'folder', id: folderPath, ...optionalParentPath(parentPathForPath(folderPath)) })
  }

  const orderByKey = new Map(
    site.explorer[sectionId].rowOrder.map((entry) => [structuralRowKey(entry), entry.order]),
  )
  return rows.map((row, naturalOrder) => ({
    ...row,
    order: orderByKey.get(structuralRowKey(row)) ?? Number.POSITIVE_INFINITY,
    naturalOrder,
  }))
}

/** Identity of a row within its section: kind + parent + id. */
export function structuralRowKey(row: { kind: 'folder' | 'item'; id: string; parentPath?: string }): string {
  return `${row.kind}:${row.parentPath ?? ''}:${row.id}`
}

/** Parent-path equality where `undefined` and `''` both mean the root. */
export function sameStructuralParent(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '') === (right ?? '')
}

/** Persisted order first, natural enumeration second, id as final tie-break. */
export function compareStructuralRows(left: StructuralExplorerRow, right: StructuralExplorerRow): number {
  return left.order - right.order
    || left.naturalOrder - right.naturalOrder
    || left.id.localeCompare(right.id)
}
