/**
 * Build a nested folder tree from the flat list returned by the server.
 *
 * Returns root folders only; each node carries its children. Sorting is by
 * (sortOrder asc, name asc, case-insensitive) at every level. Folders whose
 * declared parent has been deleted out from under them — shouldn't happen
 * given the cascading FK, but defensive — are hoisted to the root rather
 * than dropped.
 */
import type { CmsMediaFolder } from '@core/persistence/cmsMedia'

export interface MediaFolderNode {
  folder: CmsMediaFolder
  children: MediaFolderNode[]
  depth: number
}

function compareFolders(a: CmsMediaFolder, b: CmsMediaFolder): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function childFoldersForParent(
  folders: CmsMediaFolder[],
  parentId: string | null,
): CmsMediaFolder[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort(compareFolders)
}

export function isFolderDescendant(
  folders: CmsMediaFolder[],
  folderId: string,
  possibleDescendantId: string,
): boolean {
  const byParent = new Map<string | null, CmsMediaFolder[]>()
  for (const folder of folders) {
    const bucket = byParent.get(folder.parentId) ?? []
    bucket.push(folder)
    byParent.set(folder.parentId, bucket)
  }

  const stack = [...(byParent.get(folderId) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next) continue
    if (next.id === possibleDescendantId) return true
    stack.push(...(byParent.get(next.id) ?? []))
  }
  return false
}

export function buildFolderTree(folders: CmsMediaFolder[]): MediaFolderNode[] {
  const byId = new Map<string, CmsMediaFolder>()
  for (const folder of folders) byId.set(folder.id, folder)

  const childMap = new Map<string | null, CmsMediaFolder[]>()
  for (const folder of folders) {
    const parentKey = folder.parentId !== null && byId.has(folder.parentId)
      ? folder.parentId
      : null
    const bucket = childMap.get(parentKey) ?? []
    bucket.push(folder)
    childMap.set(parentKey, bucket)
  }

  function build(parentKey: string | null, depth: number): MediaFolderNode[] {
    const bucket = childMap.get(parentKey)
    if (!bucket) return []
    return bucket
      .slice()
      .sort(compareFolders)
      .map((folder) => ({
        folder,
        depth,
        children: build(folder.id, depth + 1),
      }))
  }

  return build(null, 0)
}

/**
 * Flatten the tree into the depth-first ordering used by the sidebar's
 * keyboard navigation. Each entry carries the depth so the row renderer
 * can indent appropriately.
 */
export function flattenFolderTree(
  nodes: MediaFolderNode[],
  expanded: ReadonlySet<string> | null = null,
): MediaFolderNode[] {
  const result: MediaFolderNode[] = []
  function walk(node: MediaFolderNode) {
    result.push(node)
    if (expanded === null || expanded.has(node.folder.id)) {
      for (const child of node.children) walk(child)
    }
  }
  for (const node of nodes) walk(node)
  return result
}
