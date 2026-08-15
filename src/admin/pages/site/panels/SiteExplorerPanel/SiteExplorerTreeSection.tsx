import { Fragment, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { IconComponent } from 'pixel-art-icons/types'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { cn } from '@ui/cn'
import {
  TreeContainer,
  treeDropStyles,
} from '@site/ui/Tree'
import type { SiteExplorerSectionId } from '@core/page-tree'
import type {
  SiteExplorerStructuralEntry,
  SiteExplorerStructuralSectionModel,
  SiteExplorerTreeFolder,
  SiteExplorerTreeItem,
  SiteExplorerTreeSectionModel,
} from './siteExplorerModel'
import type {
  SiteExplorerDropData,
  SiteExplorerDropPosition,
  SiteExplorerDropTarget,
} from './useSiteExplorerDnd'
import { ExplorerFolderRow, ExplorerItemRow } from './SiteExplorerTreeRows'
import styles from './SiteExplorerPanel.module.css'

export interface SiteExplorerInlineRenameTarget {
  kind: 'item' | 'folder'
  sectionId: SiteExplorerSectionId
  id: string
  value: string
}

interface SiteExplorerTreeSectionProps<TTarget> {
  title: string
  count: number
  actionLabel: string
  actionIcon: IconComponent
  /** `data-testid` for the section's primary action button (e.g. tour anchors). */
  actionTestId?: string
  model: SiteExplorerTreeSectionModel<TTarget> | SiteExplorerStructuralSectionModel<TTarget>
  dropTarget: SiteExplorerDropTarget | null
  inlineRenameTarget: SiteExplorerInlineRenameTarget | null
  selectedItemIds: readonly string[]
  onAction: () => void
  onCreateFolder: () => void
  onRenameItem: (item: SiteExplorerTreeItem<TTarget>) => void
  onRenameFolder: (folder: SiteExplorerTreeFolder) => void
  onCommitInlineRename: (value: string) => void
  onCancelInlineRename: () => void
  onOpenItem: (item: SiteExplorerTreeItem<TTarget>, event: MouseEvent<HTMLButtonElement>) => void
  onContextMenuItem: (item: SiteExplorerTreeItem<TTarget>, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDownItem: (item: SiteExplorerTreeItem<TTarget>, event: KeyboardEvent<HTMLButtonElement>) => void
  onContextMenuFolder: (folder: SiteExplorerTreeFolder, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDownFolder: (folder: SiteExplorerTreeFolder, event: KeyboardEvent<HTMLButtonElement>) => void
  emptyLabel?: string
}

export function SiteExplorerTreeSection<TTarget>({
  title,
  count,
  actionLabel,
  actionIcon,
  actionTestId,
  model,
  dropTarget,
  inlineRenameTarget,
  selectedItemIds,
  onAction,
  onCreateFolder,
  onRenameItem,
  onRenameFolder,
  onCommitInlineRename,
  onCancelInlineRename,
  onOpenItem,
  onContextMenuItem,
  onKeyDownItem,
  onContextMenuFolder,
  onKeyDownFolder,
  emptyLabel = 'None yet',
}: SiteExplorerTreeSectionProps<TTarget>) {
  const [expandedFolderIds, setExpandedFolderIds] = useState(() => new Set(initialExpandedFolderIds(model)))
  const ActionIcon = actionIcon
  const hasRows = model.pinnedItems.length > 0 || model.rootEntries.length > 0
  const rootDrop = useDroppable({
    id: `site-explorer-drop-root:${model.sectionId}`,
    disabled: hasRows,
    data: {
      kind: 'siteExplorerRoot',
      sectionId: model.sectionId,
      parentFolderId: null,
      index: model.rootEntries.length,
    } satisfies SiteExplorerDropData,
  })
  const rootDropActive = !hasRows && isRootDropActive(dropTarget, model.sectionId, 0)

  function toggleFolder(folderId: string) {
    setExpandedFolderIds((current) => {
      const next = new Set(current)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }

  return (
    <section className={styles.section} aria-labelledby={`site-section-${title.toLowerCase()}`}>
      <div className={styles.sectionHeader}>
        <h2 id={`site-section-${title.toLowerCase()}`} className={styles.sectionTitle}>
          {title}
        </h2>
        <span className={styles.sectionCount}>{count}</span>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`New ${title.toLowerCase()} folder`}
          tooltip={`New ${title.toLowerCase()} folder`}
          onClick={onCreateFolder}
        >
          <FolderGlyphIcon size={13} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={actionLabel}
          tooltip={actionLabel}
          onClick={onAction}
          data-testid={actionTestId}
        >
          <ActionIcon size={13} />
        </Button>
      </div>

      <TreeContainer
        ariaLabel={title}
        className={cn(styles.treeRows, rootDropActive && treeDropStyles.dropRoot)}
        containerRef={rootDrop.setNodeRef}
      >
        {!hasRows ? (
          <EmptyState
            compact
            title={emptyLabel}
            className={styles.sectionEmpty}
          />
        ) : (
          <>
            {model.pinnedItems.map((item) => (
              <ExplorerItemRow
                key={item.id}
                item={item}
                sectionId={model.sectionId}
                depth={0}
                index={0}
                parentFolderId={null}
                dropPosition={dropPositionForItem(dropTarget, model.sectionId, item.id)}
                renameActive={isInlineRenaming(inlineRenameTarget, 'item', model.sectionId, item.id)}
                renameValue={inlineRenameTarget?.value ?? item.label}
                selected={selectedItemIds.includes(item.id)}
                selectedItemIds={selectedItemIds}
                onOpen={onOpenItem}
                onRename={onRenameItem}
                onCommitRename={onCommitInlineRename}
                onCancelRename={onCancelInlineRename}
                onContextMenu={onContextMenuItem}
                onKeyDown={onKeyDownItem}
              />
            ))}

            <RootDropGap
              sectionId={model.sectionId}
              index={0}
              active={isRootDropActive(dropTarget, model.sectionId, 0)}
            />

            {model.kind === 'structural' ? model.rootEntries.map((entry, rootIndex) => (
              <Fragment key={structuralEntryKey(entry)}>
                {renderStructuralEntry(entry, {
                  depth: 0,
                  index: rootIndex,
                  model,
                  expandedFolderIds,
                  dropTarget,
                  inlineRenameTarget,
                  selectedItemIds,
                  toggleFolder,
                  onOpenItem,
                  onRenameItem,
                  onCommitInlineRename,
                  onCancelInlineRename,
                  onContextMenuItem,
                  onKeyDownItem,
                  onRenameFolder,
                  onContextMenuFolder,
                  onKeyDownFolder,
                })}
                <RootDropGap
                  sectionId={model.sectionId}
                  index={rootIndex + 1}
                  active={isRootDropActive(dropTarget, model.sectionId, rootIndex + 1)}
                />
              </Fragment>
            )) : model.rootEntries.map((entry, rootIndex) => {
              if (entry.kind === 'item') {
                return (
                  <Fragment key={entry.item.id}>
                    <ExplorerItemRow
                      item={entry.item}
                      sectionId={model.sectionId}
                      depth={0}
                      index={rootIndex}
                      parentFolderId={null}
                      dropPosition={dropPositionForItem(dropTarget, model.sectionId, entry.item.id)}
                      renameActive={isInlineRenaming(inlineRenameTarget, 'item', model.sectionId, entry.item.id)}
                      renameValue={inlineRenameTarget?.value ?? entry.item.label}
                      selected={selectedItemIds.includes(entry.item.id)}
                      selectedItemIds={selectedItemIds}
                      onOpen={onOpenItem}
                      onRename={onRenameItem}
                      onCommitRename={onCommitInlineRename}
                      onCancelRename={onCancelInlineRename}
                      onContextMenu={onContextMenuItem}
                      onKeyDown={onKeyDownItem}
                    />
                    <RootDropGap
                      sectionId={model.sectionId}
                      index={rootIndex + 1}
                      active={isRootDropActive(dropTarget, model.sectionId, rootIndex + 1)}
                    />
                  </Fragment>
                )
              }

              const expanded = expandedFolderIds.has(entry.folder.id)
              return (
                <Fragment key={entry.folder.id}>
                  <ExplorerFolderRow
                    folder={entry.folder}
                    sectionId={model.sectionId}
                    depth={0}
                    rootIndex={rootIndex}
                    itemCount={entry.items.length}
                    expanded={expanded}
                    dropPosition={dropPositionForFolder(dropTarget, model.sectionId, entry.folder.id)}
                    renameActive={isInlineRenaming(inlineRenameTarget, 'folder', model.sectionId, entry.folder.id)}
                    renameValue={inlineRenameTarget?.value ?? entry.folder.name}
                    onToggle={() => toggleFolder(entry.folder.id)}
                    onRename={onRenameFolder}
                    onCommitRename={onCommitInlineRename}
                    onCancelRename={onCancelInlineRename}
                    onContextMenu={onContextMenuFolder}
                    onKeyDown={onKeyDownFolder}
                  />
                  {expanded && entry.items.map((item, index) => (
                    <ExplorerItemRow
                      key={item.id}
                      item={item}
                      sectionId={model.sectionId}
                      depth={1}
                      index={index}
                      parentFolderId={entry.folder.id}
                      dropPosition={dropPositionForItem(dropTarget, model.sectionId, item.id)}
                      renameActive={isInlineRenaming(inlineRenameTarget, 'item', model.sectionId, item.id)}
                      renameValue={inlineRenameTarget?.value ?? item.label}
                      selected={selectedItemIds.includes(item.id)}
                      selectedItemIds={selectedItemIds}
                      onOpen={onOpenItem}
                      onRename={onRenameItem}
                      onCommitRename={onCommitInlineRename}
                      onCancelRename={onCancelInlineRename}
                      onContextMenu={onContextMenuItem}
                      onKeyDown={onKeyDownItem}
                    />
                  ))}
                  <RootDropGap
                    sectionId={model.sectionId}
                    index={rootIndex + 1}
                    active={isRootDropActive(dropTarget, model.sectionId, rootIndex + 1)}
                  />
                </Fragment>
              )
            })}
          </>
        )}
      </TreeContainer>
    </section>
  )
}

interface RootDropGapProps {
  sectionId: SiteExplorerSectionId
  index: number
  active: boolean
}

function RootDropGap({ sectionId, index, active }: RootDropGapProps) {
  const { setNodeRef } = useDroppable({
    id: `site-explorer-drop-root-gap:${sectionId}:${index}`,
    data: {
      kind: 'siteExplorerRoot',
      sectionId,
      parentFolderId: null,
      index,
    } satisfies SiteExplorerDropData,
  })

  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={cn(treeDropStyles.rootDropGap, active && treeDropStyles.rootDropGapActive)}
    />
  )
}

interface StructuralRenderOptions<TTarget> {
  depth: number
  index: number
  model: SiteExplorerStructuralSectionModel<TTarget>
  expandedFolderIds: ReadonlySet<string>
  dropTarget: SiteExplorerDropTarget | null
  inlineRenameTarget: SiteExplorerInlineRenameTarget | null
  selectedItemIds: readonly string[]
  toggleFolder: (folderId: string) => void
  onOpenItem: (item: SiteExplorerTreeItem<TTarget>, event: MouseEvent<HTMLButtonElement>) => void
  onRenameItem: (item: SiteExplorerTreeItem<TTarget>) => void
  onCommitInlineRename: (value: string) => void
  onCancelInlineRename: () => void
  onContextMenuItem: (item: SiteExplorerTreeItem<TTarget>, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDownItem: (item: SiteExplorerTreeItem<TTarget>, event: KeyboardEvent<HTMLButtonElement>) => void
  onRenameFolder: (folder: SiteExplorerTreeFolder) => void
  onContextMenuFolder: (folder: SiteExplorerTreeFolder, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDownFolder: (folder: SiteExplorerTreeFolder, event: KeyboardEvent<HTMLButtonElement>) => void
}

function renderStructuralEntry<TTarget>(
  entry: SiteExplorerStructuralEntry<TTarget>,
  options: StructuralRenderOptions<TTarget>,
): ReactNode {
  if (entry.kind === 'item') {
    return (
      <ExplorerItemRow
        item={entry.item}
        sectionId={options.model.sectionId}
        depth={options.depth}
        index={options.index}
        parentFolderId={parentFolderIdForDepth(options.depth, entry.item.path)}
        dropPosition={dropPositionForItem(options.dropTarget, options.model.sectionId, entry.item.id)}
        renameActive={isInlineRenaming(options.inlineRenameTarget, 'item', options.model.sectionId, entry.item.id)}
        renameValue={options.inlineRenameTarget?.value ?? entry.item.label}
        selected={options.selectedItemIds.includes(entry.item.id)}
        selectedItemIds={options.selectedItemIds}
        onOpen={options.onOpenItem}
        onRename={options.onRenameItem}
        onCommitRename={options.onCommitInlineRename}
        onCancelRename={options.onCancelInlineRename}
        onContextMenu={options.onContextMenuItem}
        onKeyDown={options.onKeyDownItem}
      />
    )
  }

  const expanded = options.expandedFolderIds.has(entry.folder.id)
  const itemCount = structuralFolderItemCount(entry)
  return (
    <Fragment>
      <ExplorerFolderRow
        folder={entry.folder}
        sectionId={options.model.sectionId}
        depth={options.depth}
        rootIndex={options.index}
        itemCount={itemCount}
        expanded={expanded}
        dropPosition={dropPositionForFolder(options.dropTarget, options.model.sectionId, entry.folder.id)}
        renameActive={isInlineRenaming(options.inlineRenameTarget, 'folder', options.model.sectionId, entry.folder.id)}
        renameValue={options.inlineRenameTarget?.value ?? entry.folder.name}
        onToggle={() => options.toggleFolder(entry.folder.id)}
        onRename={options.onRenameFolder}
        onCommitRename={options.onCommitInlineRename}
        onCancelRename={options.onCancelInlineRename}
        onContextMenu={options.onContextMenuFolder}
        onKeyDown={options.onKeyDownFolder}
      />
      {expanded && entry.landingItem && (
        <ExplorerItemRow
          item={entry.landingItem}
          sectionId={options.model.sectionId}
          depth={options.depth + 1}
          index={0}
          parentFolderId={entry.folder.id}
          dropPosition={dropPositionForItem(options.dropTarget, options.model.sectionId, entry.landingItem.id)}
          renameActive={isInlineRenaming(options.inlineRenameTarget, 'item', options.model.sectionId, entry.landingItem.id)}
          renameValue={options.inlineRenameTarget?.value ?? entry.landingItem.label}
          selected={options.selectedItemIds.includes(entry.landingItem.id)}
          selectedItemIds={options.selectedItemIds}
          onOpen={options.onOpenItem}
          onRename={options.onRenameItem}
          onCommitRename={options.onCommitInlineRename}
          onCancelRename={options.onCancelInlineRename}
          onContextMenu={options.onContextMenuItem}
          onKeyDown={options.onKeyDownItem}
        />
      )}
      {expanded && entry.children.map((child, index) => (
        <Fragment key={structuralEntryKey(child)}>
          {renderStructuralEntry(child, {
            ...options,
            depth: options.depth + 1,
            index: index + (entry.landingItem ? 1 : 0),
          })}
        </Fragment>
      ))}
    </Fragment>
  )
}

function initialExpandedFolderIds<TTarget>(
  model: SiteExplorerTreeSectionModel<TTarget> | SiteExplorerStructuralSectionModel<TTarget>,
): string[] {
  if (model.kind === 'structural') {
    if (model.expandedFolderPaths.length > 0) return model.expandedFolderPaths
    const ids: string[] = []
    for (const entry of model.rootEntries) collectStructuralFolderIds(entry, ids)
    return ids
  }
  return model.folders.map((folder) => folder.id)
}

function structuralEntryKey<TTarget>(entry: SiteExplorerStructuralEntry<TTarget>): string {
  return entry.kind === 'folder' ? `folder:${entry.folder.path}` : `item:${entry.item.id}`
}

function collectStructuralFolderIds<TTarget>(entry: SiteExplorerStructuralEntry<TTarget>, ids: string[]): void {
  if (entry.kind === 'item') return
  ids.push(entry.folder.id)
  for (const child of entry.children) collectStructuralFolderIds(child, ids)
}

function parentFolderIdForDepth(depth: number, path: string): string | null {
  if (depth === 0) return null
  const index = path.lastIndexOf('/')
  return index === -1 ? null : path.slice(0, index)
}

function structuralFolderItemCount<TTarget>(
  entry: Extract<SiteExplorerStructuralEntry<TTarget>, { kind: 'folder' }>,
): number {
  let count = entry.landingItem ? 1 : 0
  for (const child of entry.children) {
    count += child.kind === 'folder' ? structuralFolderItemCount(child) : 1
  }
  return count
}

function isInlineRenaming(
  target: SiteExplorerInlineRenameTarget | null,
  kind: SiteExplorerInlineRenameTarget['kind'],
  sectionId: SiteExplorerSectionId,
  id: string,
): boolean {
  return target?.kind === kind && target.sectionId === sectionId && target.id === id
}

function dropPositionForFolder(
  dropTarget: SiteExplorerDropTarget | null,
  sectionId: SiteExplorerSectionId,
  folderId: string,
): SiteExplorerDropPosition | null {
  if (dropTarget?.drop.kind !== 'siteExplorerFolder') return null
  if (dropTarget.drop.sectionId !== sectionId || dropTarget.drop.folderId !== folderId) return null
  return dropTarget.position
}

function dropPositionForItem(
  dropTarget: SiteExplorerDropTarget | null,
  sectionId: SiteExplorerSectionId,
  itemId: string,
): SiteExplorerDropPosition | null {
  if (dropTarget?.drop.kind !== 'siteExplorerItem') return null
  if (dropTarget.drop.sectionId !== sectionId || dropTarget.drop.itemId !== itemId) return null
  return dropTarget.position
}

function isRootDropActive(
  dropTarget: SiteExplorerDropTarget | null,
  sectionId: SiteExplorerSectionId,
  index: number,
): boolean {
  if (dropTarget?.drop.kind !== 'siteExplorerRoot') return false
  return dropTarget.drop.sectionId === sectionId && dropTarget.drop.index === index
}
