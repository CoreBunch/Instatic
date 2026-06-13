import { useRef, useState } from 'react'
import {
  useDndMonitor,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { IconComponent } from 'pixel-art-icons/types'
import {
  SITE_EXPLORER_SECTION_IDS,
  isHomePage,
  type DecorativeSiteExplorerSectionId,
  type ExplorerPathChangePlan,
  type SiteExplorerSectionId,
  type SiteDocument,
  type StructuralSiteExplorerSectionId,
  parentPathForPath,
  sameStructuralParent,
  compareStructuralRows,
  structuralRowsForSection,
} from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { getDragPoint, getEventPoint } from '@admin/lib/dndPointer'

interface Point {
  x: number
  y: number
}

interface DropRect {
  top: number
  height: number
}

export type SiteExplorerDragData =
  | {
    kind: 'siteExplorerItem'
    sectionId: SiteExplorerSectionId
    itemId: string
    itemIds: string[]
    label: string
    icon?: IconComponent
  }
  | {
    kind: 'siteExplorerFolder'
    sectionId: SiteExplorerSectionId
    folderId: string
    label: string
    icon?: IconComponent
  }

export type SiteExplorerDropData =
  | {
    kind: 'siteExplorerRoot'
    sectionId: SiteExplorerSectionId
    parentFolderId: null
    index: number
  }
  | {
    kind: 'siteExplorerItem'
    sectionId: SiteExplorerSectionId
    itemId: string
    parentFolderId: string | null
    index: number
  }
  | {
    kind: 'siteExplorerFolder'
    sectionId: SiteExplorerSectionId
    folderId: string
    rootIndex: number
    itemCount: number
  }

export type SiteExplorerDropPosition = 'before' | 'after' | 'inside'

export interface SiteExplorerDropTarget {
  drag: SiteExplorerDragData
  drop: SiteExplorerDropData
  position: SiteExplorerDropPosition
}

interface UseSiteExplorerDndOptions {
  enabled: boolean
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSectionId(value: unknown): value is SiteExplorerSectionId {
  return SITE_EXPLORER_SECTION_IDS.some((sectionId) => sectionId === value)
}

function isStructuralSection(sectionId: SiteExplorerSectionId): sectionId is StructuralSiteExplorerSectionId {
  return sectionId === 'pages' || sectionId === 'styles' || sectionId === 'scripts'
}

function isDecorativeSection(sectionId: SiteExplorerSectionId): sectionId is DecorativeSiteExplorerSectionId {
  return sectionId === 'templates' || sectionId === 'components'
}

function readDragData(value: unknown): SiteExplorerDragData | null {
  if (!isRecord(value) || !isSectionId(value.sectionId)) return null
  const label = typeof value.label === 'string' ? value.label : null
  const icon = typeof value.icon === 'function' ? value.icon as IconComponent : undefined

  if (value.kind === 'siteExplorerItem' && typeof value.itemId === 'string' && label) {
    const itemIds = Array.isArray(value.itemIds)
      ? value.itemIds.filter((id): id is string => typeof id === 'string')
      : [value.itemId]
    return {
      kind: 'siteExplorerItem',
      sectionId: value.sectionId,
      itemId: value.itemId,
      itemIds: itemIds.length > 0 ? itemIds : [value.itemId],
      label,
      icon,
    }
  }

  if (value.kind === 'siteExplorerFolder' && typeof value.folderId === 'string' && label) {
    return {
      kind: 'siteExplorerFolder',
      sectionId: value.sectionId,
      folderId: value.folderId,
      label,
      icon,
    }
  }

  return null
}

function readDropData(value: unknown): SiteExplorerDropData | null {
  if (!isRecord(value) || !isSectionId(value.sectionId)) return null

  if (
    value.kind === 'siteExplorerRoot'
    && value.parentFolderId === null
    && typeof value.index === 'number'
  ) {
    return {
      kind: 'siteExplorerRoot',
      sectionId: value.sectionId,
      parentFolderId: null,
      index: value.index,
    }
  }

  if (
    value.kind === 'siteExplorerItem'
    && typeof value.itemId === 'string'
    && (typeof value.parentFolderId === 'string' || value.parentFolderId === null)
    && typeof value.index === 'number'
  ) {
    return {
      kind: 'siteExplorerItem',
      sectionId: value.sectionId,
      itemId: value.itemId,
      parentFolderId: value.parentFolderId,
      index: value.index,
    }
  }

  if (
    value.kind === 'siteExplorerFolder'
    && typeof value.folderId === 'string'
    && typeof value.rootIndex === 'number'
    && typeof value.itemCount === 'number'
  ) {
    return {
      kind: 'siteExplorerFolder',
      sectionId: value.sectionId,
      folderId: value.folderId,
      rootIndex: value.rootIndex,
      itemCount: value.itemCount,
    }
  }

  return null
}

function itemIndexInParent(
  sectionId: DecorativeSiteExplorerSectionId,
  itemId: string,
  parentFolderId: string | null,
): number {
  if (parentFolderId === null) return rootEntryIndex(sectionId, 'item', itemId)

  const site = useEditorStore.getState().site
  if (!site) return -1
  return site.explorer[sectionId].items
    .filter((item) => item.parentFolderId === parentFolderId)
    .sort((a, b) => a.order - b.order)
    .findIndex((item) => item.id === itemId)
}

function rootEntryIndex(
  sectionId: DecorativeSiteExplorerSectionId,
  kind: 'folder' | 'item',
  id: string,
): number {
  const site = useEditorStore.getState().site
  if (!site) return -1
  const section = site.explorer[sectionId]
  const entries = [
    ...section.folders.map((folder) => ({
      kind: 'folder' as const,
      id: folder.id,
      order: folder.order,
    })),
    ...section.items
      .filter((item) => !item.parentFolderId)
      .map((item) => ({
        kind: 'item' as const,
        id: item.id,
        order: item.order,
      })),
  ].sort((a, b) => a.order - b.order)

  return entries.findIndex((entry) => entry.kind === kind && entry.id === id)
}

function adjustedIndex(
  currentIndex: number,
  targetIndex: number,
  sameParent: boolean,
): number {
  if (!sameParent || currentIndex === -1 || currentIndex >= targetIndex) return targetIndex
  return Math.max(0, targetIndex - 1)
}

function isPinnedHomepage(itemId: string): boolean {
  const site = useEditorStore.getState().site
  return Boolean(site?.pages.some((page) => page.id === itemId && isHomePage(page)))
}

function handleItemDrop(
  active: Extract<SiteExplorerDragData, { kind: 'siteExplorerItem' }>,
  target: SiteExplorerDropTarget,
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void,
) {
  const over = target.drop
  if (active.sectionId !== over.sectionId) return
  if (isStructuralSection(active.sectionId)) {
    handleStructuralItemDrop(active, target, onStructuralPathPlan)
    return
  }
  if (!isDecorativeSection(active.sectionId)) return

  const state = useEditorStore.getState()
  const draggedIds = active.itemIds
  if (draggedIds.length === 0) return

  if (over.kind === 'siteExplorerRoot') {
    const currentIndex = itemIndexInParent(active.sectionId, active.itemId, null)
    const nextUiIndex = adjustedIndex(currentIndex, over.index, currentIndex !== -1)
    state.moveExplorerItems(
      active.sectionId,
      draggedIds,
      null,
      nextUiIndex,
    )
    return
  }

  if (over.kind === 'siteExplorerFolder') {
    if (target.position === 'inside') {
      state.moveExplorerItems(active.sectionId, draggedIds, over.folderId, over.itemCount)
      return
    }

    const currentParent = state.site?.explorer[active.sectionId].items
      .find((item) => item.id === active.itemId)
      ?.parentFolderId ?? null
    const sameParent = currentParent === null
    const currentIndex = itemIndexInParent(active.sectionId, active.itemId, null)
    const targetIndex = over.rootIndex + (target.position === 'after' ? 1 : 0)
    const nextUiIndex = adjustedIndex(currentIndex, targetIndex, sameParent)
    state.moveExplorerItems(
      active.sectionId,
      draggedIds,
      null,
      nextUiIndex,
    )
    return
  }

  if (over.itemId === active.itemId) return
  if (over.sectionId === 'pages' && isPinnedHomepage(over.itemId)) return
  const currentParent = state.site?.explorer[active.sectionId].items
    .find((item) => item.id === active.itemId)
    ?.parentFolderId ?? null
  const sameParent = currentParent === over.parentFolderId
  const currentIndex = itemIndexInParent(active.sectionId, active.itemId, over.parentFolderId)
  const targetIndex = over.index + (target.position === 'after' ? 1 : 0)
  const nextUiIndex = adjustedIndex(currentIndex, targetIndex, sameParent)
  state.moveExplorerItems(
    active.sectionId,
    draggedIds,
    over.parentFolderId,
    nextUiIndex,
  )
}

function handleStructuralItemDrop(
  active: Extract<SiteExplorerDragData, { kind: 'siteExplorerItem' }>,
  target: SiteExplorerDropTarget,
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void,
) {
  const sectionId = active.sectionId
  if (!isStructuralSection(sectionId)) return
  const over = target.drop
  const state = useEditorStore.getState()
  const nextParentPath = structuralNextParentPath(over, target.position)
  const currentParentPath = structuralItemParentPath(state.site, sectionId, active.itemId)
  if (!sameStructuralParent(currentParentPath, nextParentPath)) {
    onStructuralPathPlan(state.previewMoveExplorerItem(sectionId, active.itemId, nextParentPath))
    return
  }

  const currentIndex = structuralRowIndexInParent(state.site, sectionId, {
    kind: 'item',
    id: active.itemId,
    ...(currentParentPath ? { parentPath: currentParentPath } : {}),
  })
  const targetIndex = structuralTargetIndex(over, target.position)
  state.moveStructuralExplorerRow(
    sectionId,
    { kind: 'item', id: active.itemId, ...(currentParentPath ? { parentPath: currentParentPath } : {}) },
    adjustedIndex(currentIndex, targetIndex, currentIndex !== -1),
  )
}

function handleFolderDrop(
  active: Extract<SiteExplorerDragData, { kind: 'siteExplorerFolder' }>,
  target: SiteExplorerDropTarget,
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void,
) {
  const over = target.drop
  if (active.sectionId !== over.sectionId) return
  if (isStructuralSection(active.sectionId)) {
    handleStructuralFolderDrop(active, target, onStructuralPathPlan)
    return
  }
  if (!isDecorativeSection(active.sectionId)) return

  if (over.kind === 'siteExplorerItem' && over.parentFolderId !== null) return
  if (over.kind === 'siteExplorerRoot') return
  if (over.kind === 'siteExplorerFolder' && active.folderId === over.folderId) return

  const currentIndex = rootEntryIndex(active.sectionId, 'folder', active.folderId)
  const targetIndex = over.kind === 'siteExplorerFolder'
    ? over.rootIndex + (target.position === 'after' ? 1 : 0)
    : over.index + (target.position === 'after' ? 1 : 0)
  const nextUiIndex = adjustedIndex(currentIndex, targetIndex, currentIndex !== -1)
  useEditorStore.getState().moveExplorerFolder(
    active.sectionId,
    active.folderId,
    nextUiIndex,
  )
}

function handleStructuralFolderDrop(
  active: Extract<SiteExplorerDragData, { kind: 'siteExplorerFolder' }>,
  target: SiteExplorerDropTarget,
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void,
) {
  const sectionId = active.sectionId
  if (!isStructuralSection(sectionId)) return
  const over = target.drop
  if (over.kind === 'siteExplorerFolder' && active.folderId === over.folderId) return

  const state = useEditorStore.getState()
  const currentParentPath = parentPathForPath(active.folderId)
  const nextParentPath = structuralNextParentPath(over, target.position)
  if (!sameStructuralParent(currentParentPath, nextParentPath)) {
    onStructuralPathPlan(state.previewMoveExplorerFolder(sectionId, active.folderId, nextParentPath))
    return
  }

  const currentIndex = structuralRowIndexInParent(state.site, sectionId, {
    kind: 'folder',
    id: active.folderId,
    ...(currentParentPath ? { parentPath: currentParentPath } : {}),
  })
  const targetIndex = structuralTargetIndex(over, target.position)
  state.moveStructuralExplorerRow(
    sectionId,
    { kind: 'folder', id: active.folderId, ...(currentParentPath ? { parentPath: currentParentPath } : {}) },
    adjustedIndex(currentIndex, targetIndex, currentIndex !== -1),
  )
}

function handleExplorerDrop(
  active: SiteExplorerDragData,
  target: SiteExplorerDropTarget | null,
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void,
) {
  if (!target) return

  if (active.kind === 'siteExplorerItem') {
    handleItemDrop(active, target, onStructuralPathPlan)
  } else {
    handleFolderDrop(active, target, onStructuralPathPlan)
  }
}

function structuralNextParentPath(
  over: SiteExplorerDropData,
  position: SiteExplorerDropPosition,
): string | undefined {
  if (over.kind === 'siteExplorerRoot') return undefined
  if (over.kind === 'siteExplorerFolder') {
    return position === 'inside' ? over.folderId : parentPathForPath(over.folderId)
  }
  return over.parentFolderId ?? undefined
}

function structuralTargetIndex(
  over: SiteExplorerDropData,
  position: SiteExplorerDropPosition,
): number {
  if (over.kind === 'siteExplorerRoot') return over.index
  if (over.kind === 'siteExplorerFolder') {
    return position === 'inside'
      ? over.itemCount
      : over.rootIndex + (position === 'after' ? 1 : 0)
  }
  return over.index + (position === 'after' ? 1 : 0)
}

function structuralItemParentPath(
  site: SiteDocument | null,
  sectionId: StructuralSiteExplorerSectionId,
  itemId: string,
): string | undefined {
  if (!site) return undefined
  if (sectionId === 'pages') {
    const page = site.pages.find((candidate) => candidate.id === itemId)
    return page ? parentPathForPath(page.slug) : undefined
  }
  const file = site.files.find((candidate) => candidate.id === itemId)
  return file ? parentPathForPath(file.path) : undefined
}

function structuralRowIndexInParent(
  site: SiteDocument | null,
  sectionId: StructuralSiteExplorerSectionId,
  row: { kind: 'folder' | 'item'; id: string; parentPath?: string },
): number {
  if (!site) return -1
  return structuralRowsForSection(site, sectionId)
    .filter((entry) => sameStructuralParent(entry.parentPath, row.parentPath))
    .sort(compareStructuralRows)
    .findIndex((entry) => entry.kind === row.kind && entry.id === row.id)
}

function positionForRect(rect: DropRect, point: Point | null): 'before' | 'after' {
  if (!point) return 'before'
  return point.y > rect.top + rect.height / 2 ? 'after' : 'before'
}

function folderPositionForRect(rect: DropRect, point: Point | null): SiteExplorerDropPosition {
  if (!point) return 'inside'
  const edgeBand = Math.max(8, Math.min(12, rect.height * 0.3))
  const offset = point.y - rect.top
  if (offset <= edgeBand) return 'before'
  if (offset >= rect.height - edgeBand) return 'after'
  return 'inside'
}

function resolveDropTarget(
  drag: SiteExplorerDragData | null,
  event: DragMoveEvent | DragEndEvent,
  point: Point | null,
): SiteExplorerDropTarget | null {
  if (!drag || !event.over) return null
  const drop = readDropData(event.over.data.current)
  if (!drop || drag.sectionId !== drop.sectionId) return null
  if (drag.kind === 'siteExplorerItem' && drag.sectionId === 'pages' && isPinnedHomepage(drag.itemId)) return null

  if (drop.kind === 'siteExplorerRoot') {
    return { drag, drop, position: 'after' }
  }

  if (drop.kind === 'siteExplorerFolder') {
    if (drag.kind === 'siteExplorerFolder') {
      if (drag.folderId === drop.folderId) return null
      return {
        drag,
        drop,
        position: isStructuralSection(drag.sectionId)
          ? folderPositionForRect(event.over.rect, point)
          : positionForRect(event.over.rect, point),
      }
    }
    return { drag, drop, position: folderPositionForRect(event.over.rect, point) }
  }

  if (
    drag.kind === 'siteExplorerFolder'
    && drop.parentFolderId !== null
    && !isStructuralSection(drag.sectionId)
  ) return null
  if (drag.kind === 'siteExplorerItem' && drop.itemId === drag.itemId) return null
  if (drop.sectionId === 'pages' && isPinnedHomepage(drop.itemId)) return null
  return { drag, drop, position: positionForRect(event.over.rect, point) }
}

export function useSiteExplorerDnd({ enabled, onStructuralPathPlan }: UseSiteExplorerDndOptions) {
  const startPointRef = useRef<Point | null>(null)
  const latestTargetRef = useRef<SiteExplorerDropTarget | null>(null)
  const [active, setActive] = useState<SiteExplorerDragData | null>(null)
  const [target, setTarget] = useState<SiteExplorerDropTarget | null>(null)

  function setResolvedTarget(next: SiteExplorerDropTarget | null) {
    latestTargetRef.current = next
    setTarget(next)
  }

  function resetDragState() {
    startPointRef.current = null
    latestTargetRef.current = null
    setActive(null)
    setTarget(null)
  }

  useDndMonitor({
    onDragStart(event: DragStartEvent) {
      if (!enabled) return
      const drag = readDragData(event.active.data.current)
      if (!drag) return
      startPointRef.current = getEventPoint(event.activatorEvent)
      latestTargetRef.current = null
      setActive(drag)
      setTarget(null)
    },
    onDragMove(event: DragMoveEvent) {
      if (!enabled) return
      const drag = readDragData(event.active.data.current)
      const point = getDragPoint(event, startPointRef.current)
      setResolvedTarget(resolveDropTarget(drag, event, point))
    },
    onDragEnd(event: DragEndEvent) {
      if (!enabled) return
      const drag = readDragData(event.active.data.current)
      const point = getDragPoint(event, startPointRef.current)
      const finalTarget = latestTargetRef.current ?? resolveDropTarget(drag, event, point)
      if (drag) handleExplorerDrop(drag, finalTarget, onStructuralPathPlan)
      resetDragState()
    },
    onDragCancel(_event: DragCancelEvent) {
      if (!enabled) return
      resetDragState()
    },
  })

  return { active, target }
}
