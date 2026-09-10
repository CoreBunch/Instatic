import { useEditorLocale } from '@site/localization'
import { ExplorerItemContextMenu, type ExplorerContextMenuItem } from '@site/explorer-actions'
import { bulkDeleteLabel, bulkSelectionLabel } from './siteExplorerPanelUtils'
import type { SiteExplorerMenuSelection } from './siteExplorerSelection'

interface SiteExplorerContextMenuTarget {
  kind: 'page' | 'component' | 'file' | 'folder'
}

export interface SiteExplorerContextMenuState<TTarget extends SiteExplorerContextMenuTarget> {
  x: number
  y: number
  target: TTarget
  selection?: SiteExplorerMenuSelection
}

interface SiteExplorerContextMenuProps<TTarget extends SiteExplorerContextMenuTarget> {
  menu: SiteExplorerContextMenuState<TTarget>
  pageCount: number
  extraItems: ExplorerContextMenuItem[]
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}

export function SiteExplorerContextMenu<TTarget extends SiteExplorerContextMenuTarget>({
  menu,
  pageCount,
  extraItems,
  onClose,
  onRename,
  onDelete,
}: SiteExplorerContextMenuProps<TTarget>) {
  const { isTranslation } = useEditorLocale()
  const isBulk = Boolean(menu.selection && menu.selection.itemIds.length > 1)

  return (
    <ExplorerItemContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel="Site item options"
      headerLabel={menu.selection && isBulk
        ? bulkSelectionLabel(menu.selection.sectionId, menu.selection.itemIds.length)
        : undefined}
      showRename={!isBulk}
      renameDisabled={isTranslation && menu.target.kind !== 'page'}
      deleteLabel={menu.selection && isBulk
        ? bulkDeleteLabel(menu.selection.sectionId, menu.selection.itemIds.length)
        : undefined}
      deleteDisabled={isTranslation || (!isBulk && menu.target.kind === 'page' && pageCount <= 1)}
      extraItems={extraItems}
      onClose={onClose}
      onRename={onRename}
      onDelete={onDelete}
    />
  )
}
