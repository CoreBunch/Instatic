import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import {
  TreeChevron,
  TreeIconSlot,
  TreeLabel,
  TreeLabelGroup,
  TreeMeta,
  TreeRow,
  treeDropStyles,
} from '@site/ui/Tree'
import type { SiteExplorerSectionId } from '@core/page-tree'
import type { SiteExplorerTreeFolder, SiteExplorerTreeItem } from './siteExplorerModel'
import type { SiteExplorerDragData, SiteExplorerDropData, SiteExplorerDropPosition } from './useSiteExplorerDnd'
import styles from './SiteExplorerPanel.module.css'

interface ExplorerFolderRowProps {
  folder: SiteExplorerTreeFolder
  sectionId: SiteExplorerSectionId
  depth: number
  rootIndex: number
  itemCount: number
  expanded: boolean
  renameActive: boolean
  renameValue: string
  onToggle: () => void
  onRename: (folder: SiteExplorerTreeFolder) => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
  onContextMenu: (folder: SiteExplorerTreeFolder, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (folder: SiteExplorerTreeFolder, event: KeyboardEvent<HTMLButtonElement>) => void
  dropPosition: SiteExplorerDropPosition | null
}

export function ExplorerFolderRow({
  folder,
  sectionId,
  depth,
  rootIndex,
  itemCount,
  expanded,
  renameActive,
  renameValue,
  onToggle,
  onRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  onKeyDown,
  dropPosition,
}: ExplorerFolderRowProps) {
  const draggable = useDraggable({
    id: `site-explorer-drag-folder:${sectionId}:${folder.id}`,
    disabled: renameActive,
    data: {
      kind: 'siteExplorerFolder',
      sectionId,
      folderId: folder.id,
      label: folder.name,
      icon: FolderGlyphIcon,
    } satisfies SiteExplorerDragData,
  })
  const droppable = useDroppable({
    id: `site-explorer-drop-folder:${sectionId}:${folder.id}`,
    data: {
      kind: 'siteExplorerFolder',
      sectionId,
      folderId: folder.id,
      rootIndex,
      itemCount,
    } satisfies SiteExplorerDropData,
  })

  function setRowRef(node: HTMLDivElement | null) {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  return (
    <TreeRow
      ref={setRowRef}
      depth={depth}
      dragging={draggable.isDragging}
      className={cn(
        dropPosition === 'before' && treeDropStyles.dropBefore,
        dropPosition === 'after' && treeDropStyles.dropAfter,
        dropPosition === 'inside' && treeDropStyles.dropInside,
      )}
      data-drop-position={dropPosition ?? undefined}
      {...(renameActive ? undefined : draggable.attributes)}
      {...(renameActive ? undefined : draggable.listeners)}
      role="treeitem"
      aria-label={folder.name}
      aria-level={depth + 1}
      aria-expanded={expanded}
    >
      {renameActive ? (
        <>
          <TreeChevron expanded={expanded} />
          <TreeIconSlot icon={FolderGlyphIcon} iconSize={12} />
          <InlineRenameInput
            value={renameValue}
            ariaLabel={`Rename ${folder.name}`}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
          {itemCount > 0 && <TreeMeta>{itemCount}</TreeMeta>}
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          align="start"
          className={styles.treeRowButton}
          aria-label={folder.name}
          onClick={onToggle}
          onContextMenu={(event) => onContextMenu(folder, event)}
          onDoubleClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRename(folder)
          }}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              event.stopPropagation()
              onRename(folder)
              return
            }
            onKeyDown(folder, event)
          }}
        >
          <TreeChevron expanded={expanded} />
          <TreeIconSlot icon={FolderGlyphIcon} iconSize={12} />
          <TreeLabelGroup>
            <TreeLabel>{folder.name}</TreeLabel>
            {itemCount > 0 && <TreeMeta>{itemCount}</TreeMeta>}
          </TreeLabelGroup>
        </Button>
      )}
    </TreeRow>
  )
}

interface ExplorerItemRowProps<TTarget> {
  item: SiteExplorerTreeItem<TTarget>
  sectionId: SiteExplorerSectionId
  depth: number
  index: number
  parentFolderId: string | null
  onOpen: (item: SiteExplorerTreeItem<TTarget>, event: MouseEvent<HTMLButtonElement>) => void
  renameActive: boolean
  renameValue: string
  selected: boolean
  selectedItemIds: readonly string[]
  onRename: (item: SiteExplorerTreeItem<TTarget>) => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
  onContextMenu: (item: SiteExplorerTreeItem<TTarget>, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (item: SiteExplorerTreeItem<TTarget>, event: KeyboardEvent<HTMLButtonElement>) => void
  dropPosition: SiteExplorerDropPosition | null
}

export function ExplorerItemRow<TTarget>({
  item,
  sectionId,
  depth,
  index,
  parentFolderId,
  onOpen,
  renameActive,
  renameValue,
  selected,
  selectedItemIds,
  onRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  onKeyDown,
  dropPosition,
}: ExplorerItemRowProps<TTarget>) {
  const draggable = useDraggable({
    id: `site-explorer-drag-item:${sectionId}:${item.id}`,
    disabled: item.pinned === true || renameActive,
    data: {
      kind: 'siteExplorerItem',
      sectionId,
      itemId: item.id,
      itemIds: selected ? [...selectedItemIds] : [item.id],
      label: item.label,
      icon: item.icon,
    } satisfies SiteExplorerDragData,
  })
  const droppable = useDroppable({
    id: `site-explorer-drop-item:${sectionId}:${item.id}`,
    disabled: item.pinned === true,
    data: {
      kind: 'siteExplorerItem',
      sectionId,
      itemId: item.id,
      parentFolderId,
      index,
    } satisfies SiteExplorerDropData,
  })

  function setRowRef(node: HTMLDivElement | null) {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  return (
    <TreeRow
      ref={setRowRef}
      depth={depth}
      selected={selected || item.active}
      dragging={draggable.isDragging}
      className={cn(
        dropPosition === 'before' && treeDropStyles.dropBefore,
        dropPosition === 'after' && treeDropStyles.dropAfter,
        dropPosition === 'inside' && treeDropStyles.dropInside,
      )}
      data-drop-position={dropPosition ?? undefined}
      {...(item.pinned || renameActive ? undefined : draggable.attributes)}
      {...(item.pinned || renameActive ? undefined : draggable.listeners)}
      role="treeitem"
      aria-label={item.ariaLabel}
      aria-selected={selected}
      aria-level={depth + 1}
      data-pinned={item.pinned ? 'true' : undefined}
    >
      {renameActive ? (
        <>
          <TreeChevron visible={false} />
          <TreeIconSlot icon={item.icon} iconSize={12} />
          <InlineRenameInput
            value={renameValue}
            ariaLabel={`Rename ${item.label}`}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          align="start"
          className={styles.treeRowButton}
          aria-label={item.ariaLabel}
          aria-current={item.active ? 'page' : undefined}
          onClick={(event) => onOpen(item, event)}
          onContextMenu={(event) => onContextMenu(item, event)}
          onDoubleClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRename(item)
          }}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              event.stopPropagation()
              onRename(item)
              return
            }
            onKeyDown(item, event)
          }}
        >
          <TreeChevron visible={false} />
          <TreeIconSlot icon={item.icon} iconSize={12} />
          <TreeLabelGroup>
            <TreeLabel>{item.label}</TreeLabel>
            {item.meta && <TreeMeta>{item.meta}</TreeMeta>}
          </TreeLabelGroup>
        </Button>
      )}
    </TreeRow>
  )
}

interface InlineRenameInputProps {
  value: string
  ariaLabel: string
  onCommit: (value: string) => void
  onCancel: () => void
}

function InlineRenameInput({
  value,
  ariaLabel,
  onCommit,
  onCancel,
}: InlineRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function commit() {
    const trimmed = inputRef.current?.value.trim() ?? ''
    if (!trimmed) {
      onCancel()
      return
    }
    onCommit(trimmed)
  }

  return (
    <Input
      ref={inputRef}
      fieldSize="xs"
      autoFocus
      defaultValue={value}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          commit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={ariaLabel}
      className={styles.inlineRenameInput}
    />
  )
}
