import type { IconComponent } from 'pixel-art-icons/types'
import type {
  StructuralExplorerRowOrder,
  StructuralExplorerSection,
  StructuralSiteExplorerSectionId,
  SiteExplorerFolder,
  SiteExplorerItemPlacement,
  SiteExplorerSectionId,
} from '@core/page-tree'

export interface SiteExplorerTreeItem<TTarget> {
  id: string
  label: string
  meta?: string
  icon: IconComponent
  active: boolean
  pinned?: boolean
  ariaLabel: string
  target: TTarget
}

export interface SiteExplorerTreeFolder {
  id: string
  name: string
}

export interface SiteExplorerTreeSectionModel<TTarget> {
  kind: 'decorative'
  sectionId: SiteExplorerSectionId
  folders: SiteExplorerTreeFolder[]
  pinnedItems: SiteExplorerTreeItem<TTarget>[]
  rootEntries: Array<
    | { kind: 'folder'; folder: SiteExplorerTreeFolder; items: SiteExplorerTreeItem<TTarget>[] }
    | { kind: 'item'; item: SiteExplorerTreeItem<TTarget> }
  >
  rootItems: SiteExplorerTreeItem<TTarget>[]
  folderItems: Array<{
    folder: SiteExplorerTreeFolder
    items: SiteExplorerTreeItem<TTarget>[]
  }>
}

interface SiteExplorerStructuralItem<TTarget> extends SiteExplorerTreeItem<TTarget> {
  path: string
}

interface SiteExplorerStructuralFolder extends SiteExplorerTreeFolder {
  path: string
}

export type SiteExplorerStructuralEntry<TTarget> =
  | {
    kind: 'folder'
    folder: SiteExplorerStructuralFolder
    landingItem?: SiteExplorerStructuralItem<TTarget>
    children: SiteExplorerStructuralEntry<TTarget>[]
    empty: boolean
  }
  | { kind: 'item'; item: SiteExplorerStructuralItem<TTarget> }

export interface SiteExplorerStructuralSectionModel<TTarget> {
  kind: 'structural'
  sectionId: StructuralSiteExplorerSectionId
  expandedFolderPaths: string[]
  pinnedItems: SiteExplorerStructuralItem<TTarget>[]
  rootEntries: SiteExplorerStructuralEntry<TTarget>[]
}

export function buildSiteExplorerTreeSection<TTarget>(
  sectionId: SiteExplorerSectionId,
  folders: readonly SiteExplorerFolder[],
  placements: readonly SiteExplorerItemPlacement[],
  items: readonly SiteExplorerTreeItem<TTarget>[],
): SiteExplorerTreeSectionModel<TTarget> {
  const itemById = new Map(items.map((item) => [item.id, item]))
  const placementById = new Map(placements.map((placement) => [placement.id, placement]))
  const sortedFolders = [...folders]
    .sort((a, b) => a.order - b.order)
    .map((folder) => ({ id: folder.id, name: folder.name }))
  const folderIds = new Set(sortedFolders.map((folder) => folder.id))
  const pinnedItems = items.filter((item) => item.pinned)
  const pinnedIds = new Set(pinnedItems.map((item) => item.id))
  const orderedItems = placements
    .filter((placement) => itemById.has(placement.id) && !pinnedIds.has(placement.id))
    .sort((a, b) => a.order - b.order)
    .map((placement) => itemById.get(placement.id)!)

  for (const item of items) {
    if (pinnedIds.has(item.id)) continue
    if (!placementById.has(item.id)) orderedItems.push(item)
  }

  const rootItems: SiteExplorerTreeItem<TTarget>[] = []
  const byFolder = new Map<string, SiteExplorerTreeItem<TTarget>[]>()
  for (const folder of sortedFolders) byFolder.set(folder.id, [])

  for (const item of orderedItems) {
    const parentFolderId = placementById.get(item.id)?.parentFolderId
    if (parentFolderId && folderIds.has(parentFolderId)) {
      byFolder.get(parentFolderId)!.push(item)
    } else {
      rootItems.push(item)
    }
  }

  const rootEntries = [
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      order: folder.order,
      folder: { id: folder.id, name: folder.name },
      items: byFolder.get(folder.id) ?? [],
    })),
    ...rootItems.map((item) => ({
      kind: 'item' as const,
      order: placementById.get(item.id)?.order ?? Number.MAX_SAFE_INTEGER,
      item,
    })),
  ]
    .sort((a, b) => a.order - b.order)
    .map((entry) => {
      if (entry.kind === 'folder') {
        return {
          kind: 'folder' as const,
          folder: entry.folder,
          items: entry.items,
        }
      }
      return {
        kind: 'item' as const,
        item: entry.item,
      }
    })

  return {
    kind: 'decorative',
    sectionId,
    folders: sortedFolders,
    pinnedItems,
    rootEntries,
    rootItems,
    folderItems: sortedFolders.map((folder) => ({
      folder,
      items: byFolder.get(folder.id) ?? [],
    })),
  }
}

export function buildStructuralExplorerTreeSection<TTarget>(
  sectionId: StructuralSiteExplorerSectionId,
  section: StructuralExplorerSection,
  items: readonly SiteExplorerStructuralItem<TTarget>[],
): SiteExplorerStructuralSectionModel<TTarget> {
  const pinnedItems = items.filter((item) => item.pinned)
  const pinnedIds = new Set(pinnedItems.map((item) => item.id))
  const unpinnedItems = items.filter((item) => !pinnedIds.has(item.id))
  const folderByPath = new Map<string, Extract<SiteExplorerStructuralEntry<TTarget>, { kind: 'folder' }>>()
  const rootEntries: SiteExplorerStructuralEntry<TTarget>[] = []

  function ensureFolder(path: string): Extract<SiteExplorerStructuralEntry<TTarget>, { kind: 'folder' }> {
    const existing = folderByPath.get(path)
    if (existing) return existing
    const parent = parentPathForPath(path)
    const folder = {
      kind: 'folder' as const,
      folder: { id: path, path, name: basename(path) },
      children: [],
      empty: section.emptyFolders.includes(path),
    }
    folderByPath.set(path, folder)
    if (parent) {
      ensureFolder(parent).children.push(folder)
    } else {
      rootEntries.push(folder)
    }
    return folder
  }

  for (const path of section.emptyFolders) ensureFolder(path)
  for (const item of unpinnedItems) {
    const parent = parentPathForPath(item.path)
    if (parent) ensureFolder(parent)
  }

  for (const item of unpinnedItems) {
    const folderForItemPath = folderByPath.get(item.path)
    if (folderForItemPath) {
      folderForItemPath.landingItem = item
      continue
    }

    const parent = parentPathForPath(item.path)
    const entry = { kind: 'item' as const, item }
    if (parent) {
      ensureFolder(parent).children.push(entry)
    } else {
      rootEntries.push(entry)
    }
  }

  return {
    kind: 'structural',
    sectionId,
    expandedFolderPaths: [...section.expandedFolders],
    pinnedItems,
    rootEntries: orderStructuralEntries(rootEntries, section.rowOrder, undefined),
  }
}

function orderStructuralEntries<TTarget>(
  entries: readonly SiteExplorerStructuralEntry<TTarget>[],
  rowOrder: readonly StructuralExplorerRowOrder[],
  parentPath: string | undefined,
): SiteExplorerStructuralEntry<TTarget>[] {
  const orderByKey = new Map(
    rowOrder
      .filter((entry) => (entry.parentPath ?? '') === (parentPath ?? ''))
      .map((entry) => [`${entry.kind}:${entry.id}`, entry.order]),
  )

  return entries
    .map((entry) => {
      if (entry.kind === 'item') return entry
      return {
        ...entry,
        children: orderStructuralEntries(entry.children, rowOrder, entry.folder.path),
      }
    })
    .sort((left, right) =>
      structuralEntryOrder(left, orderByKey) - structuralEntryOrder(right, orderByKey)
      || structuralEntryLabel(left).localeCompare(structuralEntryLabel(right))
    )
}

function structuralEntryOrder<TTarget>(
  entry: SiteExplorerStructuralEntry<TTarget>,
  orderByKey: ReadonlyMap<string, number>,
): number {
  const key = entry.kind === 'folder'
    ? `folder:${entry.folder.path}`
    : `item:${entry.item.id}`
  return orderByKey.get(key) ?? Number.POSITIVE_INFINITY
}

function structuralEntryLabel<TTarget>(entry: SiteExplorerStructuralEntry<TTarget>): string {
  return entry.kind === 'folder' ? entry.folder.name : entry.item.label
}

function parentPathForPath(path: string): string | undefined {
  const index = path.lastIndexOf('/')
  return index === -1 ? undefined : path.slice(0, index)
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}
