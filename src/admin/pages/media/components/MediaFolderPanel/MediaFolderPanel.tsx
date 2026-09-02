/**
 * MediaFolderPanel — the folder tree shown in the Media sidebar.
 *
 * Uses the same `Tree*` primitives (`TreeContainer`, `TreeRow`, `TreeChevron`,
 * `TreeIconSlot`, `TreeLabel`) that the DOM panel and the rest of the editor
 * trees share, so the visual language (row height, density-aware sizing,
 * selection / hover / focus states) matches one-to-one.
 *
 * Operations supported here:
 *   - Select a folder / pseudo-folder.
 *   - Expand / collapse subtrees.
 *   - Inline create (opens a small input row under the active parent).
 *   - Rename / delete via the existing ExplorerItemContextMenu.
 */
import { useState, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { EmptyState } from '@ui/components/EmptyState'
import { cn } from '@ui/cn'
import { canDeleteMedia, canWriteMedia } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { EraserSolidIcon } from 'pixel-art-icons/icons/eraser-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import type { IconComponent } from 'pixel-art-icons/types'
import {
  ExplorerItemContextMenu,
  ExplorerRenameDialog,
} from '@site/explorer-actions'
import {
  TreeChevron,
  TreeContainer,
  TreeIconSlot,
  TreeLabel,
  TreeLabelGroup,
  TreeMeta,
  TreeRow,
  treeDropStyles,
} from '@admin/pages/site/ui/Tree'
import { flattenFolderTree, type MediaFolderNode } from '../../utils/folderTree'
import { writeMediaFolderDragData } from '../../utils/mediaDragDrop'
import {
  FOLDER_ALL,
  FOLDER_TRASH,
  type FolderSelection,
  type UseMediaWorkspaceResult,
} from '../../hooks/useMediaWorkspace'
import { useMediaDnd } from '../../hooks/useMediaDnd'
import {
  SMART_LARGE_FILES,
  SMART_MISSING_ALT,
  SMART_MISSING_TITLE,
  SMART_RECENTLY_REPLACED,
  SMART_UNTAGGED,
  type SmartFolderId,
  smartFolderPredicate,
} from '../../utils/smartFolders'
import styles from './MediaFolderPanel.module.css'

interface SmartFolderDescriptor {
  id: SmartFolderId
  label: string
  icon: IconComponent
  description: string
}

const SMART_FOLDERS: SmartFolderDescriptor[] = [
  {
    id: SMART_MISSING_ALT,
    label: 'Missing alt text',
    icon: WarningDiamondSolidIcon,
    description: 'Image assets without a written alt text.',
  },
  {
    id: SMART_MISSING_TITLE,
    label: 'Missing title',
    icon: CircleAlertSolidIcon,
    description: 'Image assets with no title — the filename leaks into the UI.',
  },
  {
    id: SMART_UNTAGGED,
    label: 'Untagged',
    icon: EraserSolidIcon,
    description: 'Assets with no tags assigned.',
  },
  {
    id: SMART_LARGE_FILES,
    label: 'Large files',
    icon: BoxStackSolidIcon,
    description: 'Assets larger than 1 MiB — likely page-weight offenders.',
  },
  {
    id: SMART_RECENTLY_REPLACED,
    label: 'Recently replaced',
    icon: ReloadIcon,
    description: 'Assets whose binary has been swapped via "Replace file".',
  },
]

interface MediaFolderPanelProps {
  workspace: UseMediaWorkspaceResult
}

interface ContextMenuState {
  x: number
  y: number
  folderId: string
}

interface RenameState {
  folderId: string
  initialValue: string
}

export function MediaFolderPanel({ workspace }: MediaFolderPanelProps) {
  const currentUser = useCurrentAdminUser()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  const [createUnder, setCreateUnder] = useState<string | null | undefined>(undefined)
  const [createName, setCreateName] = useState('')
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const canWrite = canWriteMedia(currentUser)
  const canDelete = canDeleteMedia(currentUser)
  const canManageFolders = canWrite || canDelete
  const dnd = useMediaDnd(workspace, canWrite)

  function toggleExpanded(folderId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function isSelected(target: FolderSelection): boolean {
    return workspace.folderSelection === target
  }

  function startCreate(parentId: string | null) {
    if (!canWrite) return
    setCreateUnder(parentId)
    setCreateName('')
    if (parentId !== null) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.add(parentId)
        return next
      })
    }
  }

  async function commitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canWrite) return
    const name = createName.trim()
    if (!name || createUnder === undefined) return
    const folder = await workspace.createFolder(name, createUnder)
    if (folder) workspace.setFolderSelection(folder.id)
    setCreateUnder(undefined)
    setCreateName('')
  }

  function cancelCreate() {
    setCreateUnder(undefined)
    setCreateName('')
  }

  function openContextMenu(folderId: string, event: MouseEvent<HTMLDivElement>) {
    if (!canManageFolders) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, folderId })
  }

  function handleKeyboardMenu(folderId: string, event: KeyboardEvent<HTMLDivElement>) {
    if (!canManageFolders) return
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setContextMenu({
      folderId,
      x: rect.left + Math.min(rect.width - 8, 24),
      y: rect.top + Math.min(rect.height - 8, 24),
    })
  }

  function handleFolderDragStart(folderId: string, event: DragEvent<HTMLDivElement>) {
    if (!canWrite) {
      event.preventDefault()
      return
    }
    writeMediaFolderDragData(event.dataTransfer, folderId)
    setDraggingFolderId(folderId)
  }

  function handleFolderDragEnd() {
    setDraggingFolderId(null)
    dnd.clearDropTarget()
  }

  const rows = flattenFolderTree(workspace.folderTree, expanded)
  const renameFolder = renameState ? workspace.folderById.get(renameState.folderId) ?? null : null
  const allAssetCount = workspace.assets.length

  return (
    <div className={styles.root} data-testid="media-folder-panel">
      <div className={styles.sectionHeader}>
        <span className={styles.sectionLabel}>Library</span>
      </div>
      <TreeContainer ariaLabel="Media library" className={styles.tree}>
        <SentinelRow
          label="All files"
          icon={ImagesSolidIcon}
          selected={isSelected(FOLDER_ALL)}
          onSelect={() => workspace.setFolderSelection(FOLDER_ALL)}
          meta={allAssetCount}
          dropActive={dnd.isDropTarget(null)}
          onDragOver={(event) => dnd.handleDragOver(event, null)}
          onDragLeave={dnd.handleDragLeave}
          onDrop={(event) => void dnd.handleDrop(event, null)}
        />
        {SMART_FOLDERS.map((descriptor) => {
          const count = workspace.assets.filter(smartFolderPredicate(descriptor.id)).length
          return (
            <SentinelRow
              key={descriptor.id}
              label={descriptor.label}
              icon={descriptor.icon}
              selected={isSelected(descriptor.id)}
              onSelect={() => workspace.setFolderSelection(descriptor.id)}
              title={descriptor.description}
              meta={count}
            />
          )
        })}
      </TreeContainer>

      <div className={styles.sectionHeader}>
        <span className={styles.sectionLabel}>Folders</span>
        {canWrite && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            tooltip="New folder"
            aria-label="New root folder"
            onClick={() => startCreate(null)}
          >
            <PlusIcon size={13} />
          </Button>
        )}
      </div>

      {createUnder === null && (
        <CreateRow
          depth={0}
          value={createName}
          onValueChange={setCreateName}
          onSubmit={commitCreate}
          onCancel={cancelCreate}
        />
      )}

      {rows.length === 0 && createUnder === undefined ? (
        <EmptyState
          compact
          plain
          title="No folders yet"
          description={canWrite ? 'Click + to create your first folder.' : 'No folders have been created yet.'}
        />
      ) : (
        <TreeContainer ariaLabel="Folder tree" className={styles.tree}>
          {rows.map((node) => (
            <FolderRowItem
              key={node.folder.id}
              node={node}
              expanded={expanded.has(node.folder.id)}
              hasChildren={node.children.length > 0}
              selected={workspace.folderSelection === node.folder.id}
              dragging={draggingFolderId === node.folder.id}
              dropActive={dnd.isDropTarget(node.folder.id)}
              onSelect={() => workspace.setFolderSelection(node.folder.id)}
              onToggle={() => toggleExpanded(node.folder.id)}
              onContextMenu={openContextMenu}
              onKeyDown={handleKeyboardMenu}
              onDragStart={handleFolderDragStart}
              onDragEnd={handleFolderDragEnd}
              onDragOver={dnd.handleDragOver}
              onDragLeave={dnd.handleDragLeave}
              onDrop={(event) => void dnd.handleDrop(event, node.folder.id)}
              showCreateChild={createUnder === node.folder.id}
              createValue={createName}
              onCreateValueChange={setCreateName}
              onCommitCreate={commitCreate}
              onCancelCreate={cancelCreate}
              canDrag={canWrite}
            />
          ))}
        </TreeContainer>
      )}

      <div className={styles.sectionHeader}>
        <span className={styles.sectionLabel}>System</span>
      </div>
      <TreeContainer ariaLabel="System folders" className={styles.tree}>
        <SentinelRow
          label="Trash"
          icon={TrashSolidIcon}
          selected={isSelected(FOLDER_TRASH)}
          onSelect={() => workspace.setFolderSelection(FOLDER_TRASH)}
        />
      </TreeContainer>

      {contextMenu && (
        <ExplorerItemContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Folder options"
          onClose={() => setContextMenu(null)}
          onRename={() => {
            if (!canWrite) return
            const folder = workspace.folderById.get(contextMenu.folderId)
            if (folder) setRenameState({ folderId: folder.id, initialValue: folder.name })
            setContextMenu(null)
          }}
          onDelete={() => {
            if (!canDelete) return
            const folderId = contextMenu.folderId
            setContextMenu(null)
            void workspace.deleteFolder(folderId)
          }}
          showRename={canWrite}
          showDelete={canDelete}
          extraItems={canWrite ? [
            {
              label: 'New subfolder',
              icon: <PlusIcon size={13} />,
              action: () => {
                const folderId = contextMenu.folderId
                setContextMenu(null)
                startCreate(folderId)
              },
            },
          ] : []}
        />
      )}

      {renameFolder && renameState && (
        <ExplorerRenameDialog
          title="Rename folder"
          fieldLabel="Name"
          initialValue={renameState.initialValue}
          onCancel={() => setRenameState(null)}
          onRename={async (payload) => {
            if (!canWrite) return
            await workspace.renameFolder(renameFolder.id, payload.value)
            setRenameState(null)
          }}
        />
      )}
    </div>
  )
}

interface SentinelRowProps {
  label: string
  icon: IconComponent
  selected: boolean
  onSelect: () => void
  /** Optional hover tooltip (used by smart-folder rows for their description). */
  title?: string
  /** Optional right-aligned count badge (used by smart-folder rows). */
  meta?: number
  dropActive?: boolean
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
}

function SentinelRow({
  label,
  icon,
  selected,
  onSelect,
  title,
  meta,
  dropActive = false,
  onDragOver,
  onDragLeave,
  onDrop,
}: SentinelRowProps) {
  const ariaLabel = meta !== undefined
    ? meta === 1 ? `${label} — 1 asset` : `${label} — ${meta} assets`
    : label
  return (
    <TreeRow
      depth={0}
      selected={selected}
      className={cn(dropActive && treeDropStyles.dropInside)}
      role="treeitem"
      aria-selected={selected}
      aria-label={ariaLabel}
      tabIndex={0}
      title={title}
      onClick={onSelect}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      data-testid={`media-folder-row-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <TreeChevron visible={false} />
      <TreeIconSlot icon={icon} />
      <TreeLabelGroup>
        <TreeLabel>{label}</TreeLabel>
      </TreeLabelGroup>
      {meta !== undefined && <TreeMeta>{meta}</TreeMeta>}
    </TreeRow>
  )
}

interface FolderRowItemProps {
  node: MediaFolderNode
  expanded: boolean
  hasChildren: boolean
  selected: boolean
  dragging: boolean
  dropActive: boolean
  onSelect: () => void
  onToggle: () => void
  onContextMenu: (folderId: string, event: MouseEvent<HTMLDivElement>) => void
  onKeyDown: (folderId: string, event: KeyboardEvent<HTMLDivElement>) => void
  onDragStart: (folderId: string, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>, targetFolderId: string | null) => void
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  showCreateChild: boolean
  createValue: string
  onCreateValueChange: (value: string) => void
  onCommitCreate: (event: FormEvent<HTMLFormElement>) => Promise<void> | void
  onCancelCreate: () => void
  canDrag: boolean
}

function FolderRowItem({
  node,
  expanded,
  hasChildren,
  selected,
  dragging,
  dropActive,
  onSelect,
  onToggle,
  onContextMenu,
  onKeyDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  showCreateChild,
  createValue,
  onCreateValueChange,
  onCommitCreate,
  onCancelCreate,
  canDrag,
}: FolderRowItemProps) {
  return (
    <>
      <TreeRow
        depth={node.depth}
        selected={selected}
        dragging={dragging}
        className={cn(dropActive && treeDropStyles.dropInside)}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={node.folder.name}
        tabIndex={0}
        draggable={canDrag}
        onDragStart={(event) => onDragStart(node.folder.id, event)}
        onDragEnd={onDragEnd}
        onDragOver={(event) => onDragOver(event, node.folder.id)}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={(event) => {
          event.stopPropagation()
          onSelect()
          if (hasChildren) onToggle()
        }}
        onKeyDown={(event) => {
          onKeyDown(node.folder.id, event)
          if (event.defaultPrevented) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect()
          } else if (event.key === 'ArrowRight' && hasChildren && !expanded) {
            event.preventDefault()
            onToggle()
          } else if (event.key === 'ArrowLeft' && hasChildren && expanded) {
            event.preventDefault()
            onToggle()
          }
        }}
        onContextMenu={(event) => onContextMenu(node.folder.id, event)}
      >
        <TreeChevron
          expanded={expanded}
          visible={hasChildren}
          onClick={(event: MouseEvent<HTMLSpanElement>) => {
            event.stopPropagation()
            if (hasChildren) onToggle()
          }}
        />
        <TreeIconSlot icon={FolderGlyphIcon} />
        <TreeLabelGroup>
          <TreeLabel>{node.folder.name}</TreeLabel>
        </TreeLabelGroup>
      </TreeRow>
      {showCreateChild && (
        <CreateRow
          depth={node.depth + 1}
          value={createValue}
          onValueChange={onCreateValueChange}
          onSubmit={onCommitCreate}
          onCancel={onCancelCreate}
        />
      )}
    </>
  )
}

interface CreateRowProps {
  depth: number
  value: string
  onValueChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> | void
  onCancel: () => void
}

function CreateRow({ depth, value, onValueChange, onSubmit, onCancel }: CreateRowProps) {
  return (
    <form
      className={styles.createRow}
      onSubmit={(event) => void onSubmit(event)}
      style={{ paddingLeft: `${8 + depth * 12 + 18}px` } as React.CSSProperties}
    >
      <FolderGlyphIcon size={12} />
      <Input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder="Folder name"
        autoFocus
        aria-label="New folder name"
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
      />
    </form>
  )
}
