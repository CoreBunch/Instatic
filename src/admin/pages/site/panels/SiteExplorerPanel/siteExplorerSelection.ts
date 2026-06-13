import { useState, type MouseEvent } from 'react'
import type { SiteExplorerSectionId } from '@core/page-tree'
import type {
  SiteExplorerStructuralEntry,
  SiteExplorerStructuralSectionModel,
  SiteExplorerTreeItem,
  SiteExplorerTreeSectionModel,
} from './siteExplorerModel'

interface SiteExplorerSelectionState {
  sectionId: SiteExplorerSectionId | null
  itemIds: string[]
}

export interface SiteExplorerMenuSelection {
  sectionId: SiteExplorerSectionId
  itemIds: string[]
}

const EMPTY_EXPLORER_SELECTION: SiteExplorerSelectionState = { sectionId: null, itemIds: [] }

type SiteExplorerAnySectionModel<TTarget> =
  | SiteExplorerTreeSectionModel<TTarget>
  | SiteExplorerStructuralSectionModel<TTarget>

export function useSiteExplorerSelection<TTarget>() {
  const [selection, setSelection] = useState<SiteExplorerSelectionState>(EMPTY_EXPLORER_SELECTION)

  function selectedItemIdsForSection(sectionId: SiteExplorerSectionId): string[] {
    return selection.sectionId === sectionId ? selection.itemIds : []
  }

  function setSelectionForIds(sectionId: SiteExplorerSectionId, itemIds: string[]) {
    setSelection(itemIds.length > 0 ? { sectionId, itemIds } : EMPTY_EXPLORER_SELECTION)
  }

  function clearSelection() {
    setSelection(EMPTY_EXPLORER_SELECTION)
  }

  function updateSelectionForItem(
    model: SiteExplorerAnySectionModel<TTarget>,
    item: SiteExplorerTreeItem<TTarget>,
    event: MouseEvent<HTMLButtonElement>,
  ): boolean {
    if (item.pinned) {
      clearSelection()
      return false
    }

    if (event.shiftKey) {
      const anchorId = selection.sectionId === model.sectionId
        ? selection.itemIds[selection.itemIds.length - 1] ?? null
        : null
      setSelectionForIds(model.sectionId, rangeSelectionIds(model, anchorId, item.id))
      return true
    }

    if (event.metaKey || event.ctrlKey) {
      const currentIds = selection.sectionId === model.sectionId ? selection.itemIds : []
      const nextIds = currentIds.includes(item.id)
        ? currentIds.filter((id) => id !== item.id)
        : [...currentIds, item.id]
      setSelectionForIds(model.sectionId, nextIds)
      return true
    }

    setSelectionForIds(model.sectionId, [item.id])
    return false
  }

  function menuSelectionForItem(
    model: SiteExplorerAnySectionModel<TTarget>,
    item: SiteExplorerTreeItem<TTarget>,
  ): SiteExplorerMenuSelection {
    const selectedIds = selection.sectionId === model.sectionId ? selection.itemIds : []
    return {
      sectionId: model.sectionId,
      itemIds: selectedIds.includes(item.id) ? selectedIds : [item.id],
    }
  }

  return {
    selection,
    selectedItemIdsForSection,
    setSelectionForIds,
    clearSelection,
    updateSelectionForItem,
    menuSelectionForItem,
  }
}

function selectableItemIds<TTarget>(model: SiteExplorerAnySectionModel<TTarget>): string[] {
  const ids: string[] = []
  for (const item of model.pinnedItems) {
    if (!item.pinned) ids.push(item.id)
  }
  if (model.kind === 'structural') {
    for (const entry of model.rootEntries) collectStructuralEntryItemIds(entry, ids)
    return ids
  }
  for (const entry of model.rootEntries) {
    if (entry.kind === 'item') {
      if (!entry.item.pinned) ids.push(entry.item.id)
      continue
    }
    for (const item of entry.items) {
      if (!item.pinned) ids.push(item.id)
    }
  }
  return ids
}

function collectStructuralEntryItemIds<TTarget>(
  entry: SiteExplorerStructuralEntry<TTarget>,
  ids: string[],
): void {
  if (entry.kind === 'item') {
    if (!entry.item.pinned) ids.push(entry.item.id)
    return
  }
  if (entry.landingItem && !entry.landingItem.pinned) ids.push(entry.landingItem.id)
  for (const child of entry.children) collectStructuralEntryItemIds(child, ids)
}

function rangeSelectionIds<TTarget>(
  model: SiteExplorerAnySectionModel<TTarget>,
  anchorId: string | null,
  targetId: string,
): string[] {
  const ids = selectableItemIds(model)
  const targetIndex = ids.indexOf(targetId)
  if (targetIndex === -1) return []
  const anchorIndex = anchorId ? ids.indexOf(anchorId) : -1
  if (anchorIndex === -1) return [targetId]
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return ids.slice(start, end + 1)
}
