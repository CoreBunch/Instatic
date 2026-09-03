import { useEffect, type KeyboardEvent, type MouseEvent } from 'react'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import type { SiteExplorerSectionId } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { SiteExplorerTreeSection, type SiteExplorerInlineRenameTarget } from './SiteExplorerTreeSection'
import type { SiteExplorerDndState } from './SiteExplorerDndScope'
import type {
  SiteExplorerStructuralSectionModel,
  SiteExplorerTreeFolder,
  SiteExplorerTreeItem,
  SiteExplorerTreeSectionModel,
} from './siteExplorerModel'
import type { SiteExplorerContextTarget, SiteExplorerAnySectionModel, SiteExplorerSectionGroup } from './siteExplorerPanelTypes'

/**
 * How long the New page button's attention cue stays armed — covers the three
 * pulse iterations (see `.actionAttention` in SiteExplorerPanel.module.css)
 * plus the static-ring duration under reduced motion.
 */
const NEW_PAGE_ATTENTION_MS = 3200

interface SiteExplorerPanelSectionsProps {
  /** Which group of sections to render — `site` (pages/templates/components)
   *  or `code` (styles/scripts). The other group's sections are omitted. */
  sectionGroup: SiteExplorerSectionGroup
  explorerDnd: SiteExplorerDndState
  pageTreeModel: SiteExplorerStructuralSectionModel<SiteExplorerContextTarget> | null
  templateTreeModel: SiteExplorerTreeSectionModel<SiteExplorerContextTarget> | null
  componentTreeModel: SiteExplorerTreeSectionModel<SiteExplorerContextTarget> | null
  styleTreeModel: SiteExplorerStructuralSectionModel<SiteExplorerContextTarget> | null
  scriptTreeModel: SiteExplorerStructuralSectionModel<SiteExplorerContextTarget> | null
  normalPageCount: number
  templatePageCount: number
  componentCount: number
  styleCount: number
  scriptCount: number
  inlineRenameTargetForSection: (sectionId: SiteExplorerSectionId) => SiteExplorerInlineRenameTarget | null
  selectedItemIdsForSection: (sectionId: SiteExplorerSectionId) => readonly string[]
  onCreatePage: () => void
  onCreateTemplate: () => void
  onCreateComponent: () => void
  onCreateStyle: () => void
  onCreateScript: () => void
  onCreateFolder: (sectionId: SiteExplorerSectionId) => void
  onRenameItem: (item: SiteExplorerTreeItem<SiteExplorerContextTarget>) => void
  onRenameFolder: (sectionId: SiteExplorerSectionId, folder: SiteExplorerTreeFolder) => void
  onCommitInlineRename: (value: string) => void
  onCancelInlineRename: () => void
  onOpenItem: (
    model: SiteExplorerAnySectionModel,
    item: SiteExplorerTreeItem<SiteExplorerContextTarget>,
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  onContextMenuItem: (
    model: SiteExplorerAnySectionModel,
    item: SiteExplorerTreeItem<SiteExplorerContextTarget>,
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  onKeyDownItem: (
    model: SiteExplorerAnySectionModel,
    item: SiteExplorerTreeItem<SiteExplorerContextTarget>,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void
  onContextMenuFolder: (
    sectionId: SiteExplorerSectionId,
    folder: SiteExplorerTreeFolder,
    event: MouseEvent<HTMLButtonElement>,
  ) => void
  onKeyDownFolder: (
    sectionId: SiteExplorerSectionId,
    folder: SiteExplorerTreeFolder,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void
}

export function SiteExplorerPanelSections({
  sectionGroup,
  explorerDnd,
  pageTreeModel,
  templateTreeModel,
  componentTreeModel,
  styleTreeModel,
  scriptTreeModel,
  normalPageCount,
  templatePageCount,
  componentCount,
  styleCount,
  scriptCount,
  inlineRenameTargetForSection,
  selectedItemIdsForSection,
  onCreatePage,
  onCreateTemplate,
  onCreateComponent,
  onCreateStyle,
  onCreateScript,
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
}: SiteExplorerPanelSectionsProps) {
  // Transient pulse on the New page button, armed by `revealNewPageButton`
  // (the dashboard onboarding "Create your first page" CTA). Cleared here —
  // after the CSS animation has played — so the cue never re-fires when the
  // user later toggles panels or tabs.
  const newPageAttention = useEditorStore((state) => state.newPageAttention)
  useEffect(() => {
    if (!newPageAttention) return
    const timer = setTimeout(() => {
      useEditorStore.getState().clearNewPageAttention()
    }, NEW_PAGE_ATTENTION_MS)
    return () => clearTimeout(timer)
  }, [newPageAttention])

  return (
    <>
      {sectionGroup === 'site' && pageTreeModel && (
        <SiteExplorerTreeSection
          title="Pages"
          count={normalPageCount}
          actionLabel="New page"
          actionIcon={FilePlusSolidIcon}
          actionTestId="site-explorer-new-page"
          actionAttention={newPageAttention}
          onAction={onCreatePage}
          model={pageTreeModel}
          dropTarget={explorerDnd.target}
          inlineRenameTarget={inlineRenameTargetForSection('pages')}
          selectedItemIds={selectedItemIdsForSection('pages')}
          onCreateFolder={() => onCreateFolder('pages')}
          onRenameItem={onRenameItem}
          onRenameFolder={(folder) => onRenameFolder('pages', folder)}
          onCommitInlineRename={onCommitInlineRename}
          onCancelInlineRename={onCancelInlineRename}
          onOpenItem={(item, event) => onOpenItem(pageTreeModel, item, event)}
          onContextMenuItem={(item, event) => onContextMenuItem(pageTreeModel, item, event)}
          onKeyDownItem={(item, event) => onKeyDownItem(pageTreeModel, item, event)}
          onContextMenuFolder={(folder, event) => onContextMenuFolder('pages', folder, event)}
          onKeyDownFolder={(folder, event) => onKeyDownFolder('pages', folder, event)}
        />
      )}

      {sectionGroup === 'site' && templateTreeModel && (
        <SiteExplorerTreeSection
          title="Templates"
          count={templatePageCount}
          actionLabel="New template"
          actionIcon={FilePlusSolidIcon}
          onAction={onCreateTemplate}
          model={templateTreeModel}
          dropTarget={explorerDnd.target}
          inlineRenameTarget={inlineRenameTargetForSection('templates')}
          selectedItemIds={selectedItemIdsForSection('templates')}
          onCreateFolder={() => onCreateFolder('templates')}
          onRenameItem={onRenameItem}
          onRenameFolder={(folder) => onRenameFolder('templates', folder)}
          onCommitInlineRename={onCommitInlineRename}
          onCancelInlineRename={onCancelInlineRename}
          onOpenItem={(item, event) => onOpenItem(templateTreeModel, item, event)}
          onContextMenuItem={(item, event) => onContextMenuItem(templateTreeModel, item, event)}
          onKeyDownItem={(item, event) => onKeyDownItem(templateTreeModel, item, event)}
          onContextMenuFolder={(folder, event) => onContextMenuFolder('templates', folder, event)}
          onKeyDownFolder={(folder, event) => onKeyDownFolder('templates', folder, event)}
        />
      )}

      {sectionGroup === 'site' && componentTreeModel && (
        <SiteExplorerTreeSection
          title="Components"
          count={componentCount}
          actionLabel="New component"
          actionIcon={FilePlusSolidIcon}
          onAction={onCreateComponent}
          model={componentTreeModel}
          dropTarget={explorerDnd.target}
          inlineRenameTarget={inlineRenameTargetForSection('components')}
          selectedItemIds={selectedItemIdsForSection('components')}
          onCreateFolder={() => onCreateFolder('components')}
          onRenameItem={onRenameItem}
          onRenameFolder={(folder) => onRenameFolder('components', folder)}
          onCommitInlineRename={onCommitInlineRename}
          onCancelInlineRename={onCancelInlineRename}
          onOpenItem={(item, event) => onOpenItem(componentTreeModel, item, event)}
          onContextMenuItem={(item, event) => onContextMenuItem(componentTreeModel, item, event)}
          onKeyDownItem={(item, event) => onKeyDownItem(componentTreeModel, item, event)}
          onContextMenuFolder={(folder, event) => onContextMenuFolder('components', folder, event)}
          onKeyDownFolder={(folder, event) => onKeyDownFolder('components', folder, event)}
        />
      )}

      {sectionGroup === 'code' && styleTreeModel && (
        <SiteExplorerTreeSection
          title="Styles"
          count={styleCount}
          actionLabel="New stylesheet"
          actionIcon={PaintBucketSolidIcon}
          onAction={onCreateStyle}
          model={styleTreeModel}
          dropTarget={explorerDnd.target}
          inlineRenameTarget={inlineRenameTargetForSection('styles')}
          selectedItemIds={selectedItemIdsForSection('styles')}
          onCreateFolder={() => onCreateFolder('styles')}
          onRenameItem={onRenameItem}
          onRenameFolder={(folder) => onRenameFolder('styles', folder)}
          onCommitInlineRename={onCommitInlineRename}
          onCancelInlineRename={onCancelInlineRename}
          onOpenItem={(item, event) => onOpenItem(styleTreeModel, item, event)}
          onContextMenuItem={(item, event) => onContextMenuItem(styleTreeModel, item, event)}
          onKeyDownItem={(item, event) => onKeyDownItem(styleTreeModel, item, event)}
          onContextMenuFolder={(folder, event) => onContextMenuFolder('styles', folder, event)}
          onKeyDownFolder={(folder, event) => onKeyDownFolder('styles', folder, event)}
        />
      )}

      {sectionGroup === 'code' && scriptTreeModel && (
        <SiteExplorerTreeSection
          title="Scripts"
          count={scriptCount}
          actionLabel="New script"
          actionIcon={CodeIcon}
          onAction={onCreateScript}
          model={scriptTreeModel}
          dropTarget={explorerDnd.target}
          inlineRenameTarget={inlineRenameTargetForSection('scripts')}
          selectedItemIds={selectedItemIdsForSection('scripts')}
          onCreateFolder={() => onCreateFolder('scripts')}
          onRenameItem={onRenameItem}
          onRenameFolder={(folder) => onRenameFolder('scripts', folder)}
          onCommitInlineRename={onCommitInlineRename}
          onCancelInlineRename={onCancelInlineRename}
          onOpenItem={(item, event) => onOpenItem(scriptTreeModel, item, event)}
          onContextMenuItem={(item, event) => onContextMenuItem(scriptTreeModel, item, event)}
          onKeyDownItem={(item, event) => onKeyDownItem(scriptTreeModel, item, event)}
          onContextMenuFolder={(folder, event) => onContextMenuFolder('scripts', folder, event)}
          onKeyDownFolder={(folder, event) => onKeyDownFolder('scripts', folder, event)}
        />
      )}
    </>
  )
}
