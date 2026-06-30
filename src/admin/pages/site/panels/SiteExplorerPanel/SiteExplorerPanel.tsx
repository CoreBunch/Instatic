import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { SiteFile } from '@core/files/schemas'
import type { ExplorerPathChangePlan, Page, SiteExplorerSectionId, StructuralSiteExplorerSectionId } from '@core/page-tree'
import { createUniquePageSlug, pagePublicPath, isHomePage } from '@core/page-tree'
import { templateTargetLabel } from '@core/templates'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { SiteCreateDialog, buildScriptPath, buildStylePath, slugifySiteItemName, type SiteCreatePayload, type SiteCreateKind } from '@admin/shared/dialogs/SiteCreateDialog'
import type { ExplorerContextMenuItem } from '@site/explorer-actions'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog'
import { useVCDeletionConfirm } from '@admin/shared/dialogs/VCDeletionConfirmDialog'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import {
  buildSiteExplorerTreeSection,
  buildStructuralExplorerTreeSection,
  type SiteExplorerTreeFolder,
  type SiteExplorerTreeItem,
} from './siteExplorerModel'
import type { SiteExplorerInlineRenameTarget } from './SiteExplorerTreeSection'
import { SiteExplorerDndScope, type SiteExplorerDndState } from './SiteExplorerDndScope'
import { bulkDeleteConfirmDescription, bulkDeleteConfirmLabel, bulkDeleteConfirmTitle, bulkWrapLabel, fileName, groupSiteFiles, keyboardMenuPosition, pathFromRenameInput } from './siteExplorerPanelUtils'
import { useSiteExplorerSelection, type SiteExplorerMenuSelection } from './siteExplorerSelection'
import { SiteExplorerContextMenu, type SiteExplorerContextMenuState } from './SiteExplorerContextMenu'
import { SiteExplorerPathConfirmDialog } from './SiteExplorerPathConfirmDialog'
import { SiteExplorerPanelSections } from './SiteExplorerPanelSections'
import type { SiteExplorerAnySectionModel, SiteExplorerContextTarget, SiteExplorerSectionGroup } from './siteExplorerPanelTypes'
import styles from './SiteExplorerPanel.module.css'

interface SiteExplorerPanelProps {
  /** Which group of sections to show — `site` (pages/templates/components)
   *  or `code` (styles/scripts). A single instance serves both Explorer tabs,
   *  switching this prop, so DnD + selection state stay shared. */
  sectionGroup: SiteExplorerSectionGroup
  organizationDndEnabled?: boolean
}

type ContextMenuState = SiteExplorerContextMenuState<SiteExplorerContextTarget>

const EMPTY_FILES: SiteFile[] = []

function renameValueForTarget(target: SiteExplorerContextTarget): string {
  if (target.kind === 'page') return target.title
  if (target.kind === 'component') return target.name
  if (target.kind === 'folder') return target.name
  return fileName(target.path)
}

function folderTarget(sectionId: SiteExplorerSectionId, folder: SiteExplorerTreeFolder): SiteExplorerContextTarget {
  return { kind: 'folder', sectionId, id: folder.id, name: folder.name }
}

function isStructuralSection(sectionId: SiteExplorerSectionId): sectionId is StructuralSiteExplorerSectionId {
  return sectionId === 'pages' || sectionId === 'styles' || sectionId === 'scripts'
}

function renamedFolderPath(
  sectionId: StructuralSiteExplorerSectionId,
  currentPath: string,
  nextName: string,
): string {
  const index = currentPath.lastIndexOf('/')
  const parentPath = index === -1 ? '' : currentPath.slice(0, index)
  const segment = nextName
    .trim()
    .toLowerCase()
    .replace(sectionId === 'pages' ? /[^a-z0-9-]+/g : /[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-folder'
  return parentPath ? `${parentPath}/${segment}` : segment
}

export function SiteExplorerPanel({
  sectionGroup,
  organizationDndEnabled = false,
}: SiteExplorerPanelProps) {
  const site = useEditorStore((s) => s.site)
  const activePageId = useEditorStore((s) => s.activePageId)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const activeEditorFileId = useEditorStore((s) => s.activeEditorFileId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)
  const addPage = useEditorStore((s) => s.addPage)
  const renamePage = useEditorStore((s) => s.renamePage)
  const deletePage = useEditorStore((s) => s.deletePage)
  const convertPageToTemplate = useEditorStore((s) => s.convertPageToTemplate)
  const convertTemplateToPage = useEditorStore((s) => s.convertTemplateToPage)
  const createVisualComponent = useEditorStore((s) => s.createVisualComponent)
  const renameVisualComponent = useEditorStore((s) => s.renameVisualComponent)
  const deleteVisualComponent = useEditorStore((s) => s.deleteVisualComponent)
  const createFile = useEditorStore((s) => s.createFile)
  const renameFile = useEditorStore((s) => s.renameFile)
  const deleteFile = useEditorStore((s) => s.deleteFile)
  const openInEditor = useEditorStore((s) => s.openInEditor)
  const createExplorerFolder = useEditorStore((s) => s.createExplorerFolder)
  const renameExplorerFolder = useEditorStore((s) => s.renameExplorerFolder)
  const deleteExplorerFolder = useEditorStore((s) => s.deleteExplorerFolder)
  const wrapExplorerItemsInFolder = useEditorStore((s) => s.wrapExplorerItemsInFolder)
  const previewRenameExplorerFolder = useEditorStore((s) => s.previewRenameExplorerFolder)
  const previewDeleteExplorerFolder = useEditorStore((s) => s.previewDeleteExplorerFolder)
  const commitExplorerPathChange = useEditorStore((s) => s.commitExplorerPathChange)
  const setPageAsHomepage = useEditorStore((s) => s.setPageAsHomepage)
  const confirmVCDeletion = useVCDeletionConfirm()
  const confirmDelete = useConfirmDelete()
  const [createKind, setCreateKind] = useState<SiteCreateKind | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineRenameTarget, setInlineRenameTarget] = useState<SiteExplorerContextTarget | null>(null)
  const [templateSettingsTarget, setTemplateSettingsTarget] = useState<Page | null>(null)
  const [pathConfirmPlan, setPathConfirmPlan] = useState<ExplorerPathChangePlan | null>(null)
  const explorerSelection = useSiteExplorerSelection<SiteExplorerContextTarget>()

  const files = site?.files ?? EMPTY_FILES
  const fileBuckets = groupSiteFiles(files)

  function handleCreate({ name, slug }: SiteCreatePayload) {
    if (!createKind) return

    try {
      if (createKind === 'page') {
        const page = addPage(name, slug ?? slugifySiteItemName(name))
        openPageInCanvas(page.id)
      } else if (createKind === 'component') {
        const vcId = createVisualComponent(name)
        setActiveDocument({ kind: 'visualComponent', vcId })
      } else if (createKind === 'style') {
        const fileId = createFile(buildStylePath(name), 'style', '')
        openInEditor(fileId)
      } else {
        const fileId = createFile(buildScriptPath(name), 'script', '')
        openInEditor(fileId)
      }
      setCreateKind(null)
    } catch (err) {
      console.error('[SiteExplorerPanel] create site item error:', err)
    }
  }

  const pages = site?.pages ?? []
  const normalPages = pages.filter((page) => !page.template)
  const templatePages = pages.filter((page) => page.template)
  const components = site?.visualComponents ?? []

  function pageForTarget(target: SiteExplorerContextTarget): Page | null {
    if (target.kind !== 'page') return null
    return pages.find((page) => page.id === target.id) ?? null
  }

  function openContextMenu(
    target: SiteExplorerContextTarget,
    event: MouseEvent<HTMLButtonElement>,
    selection?: SiteExplorerMenuSelection,
  ) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, target, selection })
  }

  function openKeyboardContextMenu(
    target: SiteExplorerContextTarget,
    event: KeyboardEvent<HTMLButtonElement>,
    selection?: SiteExplorerMenuSelection,
  ) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ ...keyboardMenuPosition(event.currentTarget), target, selection })
  }

  function inlineRenameSectionTarget(sectionId: SiteExplorerSectionId): SiteExplorerInlineRenameTarget | null {
    if (!inlineRenameTarget) return null
    if (inlineRenameTarget.kind === 'folder') {
      if (inlineRenameTarget.sectionId !== sectionId) return null
      return {
        kind: 'folder',
        sectionId,
        id: inlineRenameTarget.id,
        value: inlineRenameTarget.name,
      }
    }
    if (inlineRenameTarget.kind === 'page') {
      const page = pageForTarget(inlineRenameTarget)
      const targetSectionId: SiteExplorerSectionId = page?.template ? 'templates' : 'pages'
      if (targetSectionId !== sectionId) return null
    } else if (inlineRenameTarget.kind === 'component') {
      if (sectionId !== 'components') return null
    } else {
      const file = files.find((candidate) => candidate.id === inlineRenameTarget.id)
      if (!file) return null
      const targetSectionId: SiteExplorerSectionId | null = file.type === 'style'
        ? 'styles'
        : file.type === 'script'
          ? 'scripts'
          : null
      if (targetSectionId !== sectionId) return null
    }

    return {
      kind: 'item',
      sectionId,
      id: inlineRenameTarget.id,
      value: renameValueForTarget(inlineRenameTarget),
    }
  }

  function startInlineRename(target: SiteExplorerContextTarget) {
    setInlineRenameTarget(target)
    setContextMenu(null)
  }

  function handleInlineRename(value: string) {
    if (!inlineRenameTarget) return

    try {
      if (inlineRenameTarget.kind === 'page') {
        renamePage(inlineRenameTarget.id, value)
      } else if (inlineRenameTarget.kind === 'component') {
        renameVisualComponent(inlineRenameTarget.id, value)
      } else if (inlineRenameTarget.kind === 'folder') {
        if (isStructuralSection(inlineRenameTarget.sectionId)) {
          const nextFolderPath = renamedFolderPath(inlineRenameTarget.sectionId, inlineRenameTarget.id, value)
          setPathConfirmPlan(previewRenameExplorerFolder(inlineRenameTarget.sectionId, inlineRenameTarget.id, nextFolderPath))
        } else {
          renameExplorerFolder(inlineRenameTarget.sectionId, inlineRenameTarget.id, value)
        }
      } else {
        renameFile(inlineRenameTarget.id, pathFromRenameInput(inlineRenameTarget.path, value))
      }
      setInlineRenameTarget(null)
    } catch (err) {
      console.error('[SiteExplorerPanel] rename site item error:', err)
    }
  }

  function handleDelete(target: SiteExplorerContextTarget) {
    if (target.kind === 'page') {
      confirmDelete({
        title: 'Delete page?',
        description: `This will remove "${target.title}" from the site tree.`,
        confirmLabel: 'Delete page',
        alwaysConfirm: true,
        commit: () => deletePage(target.id),
      })
    } else if (target.kind === 'component') {
      confirmVCDeletion({
        vcId: target.id,
        commit: () => {
          deleteVisualComponent(target.id)
          if (activeDocument?.kind === 'visualComponent' && activeDocument.vcId === target.id) {
            setActiveDocument(null)
          }
        },
      })
    } else if (target.kind === 'folder') {
      if (isStructuralSection(target.sectionId)) {
        setPathConfirmPlan(previewDeleteExplorerFolder(target.sectionId, target.id))
      } else {
        deleteExplorerFolder(target.sectionId, target.id)
      }
    } else {
      deleteFile(target.id)
    }
    setContextMenu(null)
  }

  function handleConfirmPathChange() {
    if (!pathConfirmPlan) return
    try {
      commitExplorerPathChange(pathConfirmPlan)
      setPathConfirmPlan(null)
    } catch (err) {
      console.error('[SiteExplorerPanel] commit explorer path change error:', err)
    }
  }

  function handleDeleteContext(menu: ContextMenuState) {
    const selection = menu.selection
    if (!selection || selection.itemIds.length <= 1) {
      handleDelete(menu.target)
      return
    }

    if (menu.target.kind === 'folder') {
      handleDelete(menu.target)
      return
    }

    setContextMenu(null)
    confirmDelete({
      title: bulkDeleteConfirmTitle(selection.sectionId, selection.itemIds.length),
      description: bulkDeleteConfirmDescription(selection.sectionId, selection.itemIds.length),
      confirmLabel: bulkDeleteConfirmLabel(selection.sectionId, selection.itemIds.length),
      commit: () => {
        if (menu.target.kind === 'page') {
          for (const pageId of selection.itemIds) deletePage(pageId)
        } else if (menu.target.kind === 'file') {
          for (const fileId of selection.itemIds) deleteFile(fileId)
        } else {
          for (const vcId of selection.itemIds) deleteVisualComponent(vcId)
          if (activeDocument?.kind === 'visualComponent' && selection.itemIds.includes(activeDocument.vcId)) {
            setActiveDocument(null)
          }
        }
        explorerSelection.clearSelection()
      },
    })
  }

  function handleWrapSelectionInFolder(selection: SiteExplorerMenuSelection) {
    if (selection.sectionId !== 'templates' && selection.sectionId !== 'components') return
    const folderId = wrapExplorerItemsInFolder(selection.sectionId, selection.itemIds, 'New folder')
    setContextMenu(null)
    if (!folderId) return
    setInlineRenameTarget({ kind: 'folder', sectionId: selection.sectionId, id: folderId, name: 'New folder' })
    explorerSelection.setSelectionForIds(selection.sectionId, selection.itemIds)
  }

  function handleCreateTemplate() {
    const slug = createUniquePageSlug('Post Template', pages)
    const page = addPage('Post Template', slug)
    openPageInCanvas(page.id)
    setTemplateSettingsTarget(page)
  }

  function handleSaveTemplateSettings(payload: TemplateSettingsPayload) {
    if (!templateSettingsTarget) return
    renamePage(templateSettingsTarget.id, payload.title, payload.slug)
    convertPageToTemplate(templateSettingsTarget.id, payload.template)
    setTemplateSettingsTarget(null)
    openPageInCanvas(templateSettingsTarget.id)
  }

  function templateMenuItems(target: SiteExplorerContextTarget) {
    const page = pageForTarget(target)
    if (!page) return []

    if (page.template) {
      return [
        {
          label: 'Template settings',
          icon: <FileTextSolidIcon size={13} />,
          action: () => {
            setTemplateSettingsTarget(page)
            setContextMenu(null)
          },
        },
        {
          label: 'Convert to page',
          icon: <FileTextSolidIcon size={13} />,
          action: () => {
            convertTemplateToPage(page.id)
            setContextMenu(null)
          },
        },
      ]
    }

    return [{
      label: 'Use as template',
      icon: <FileTextSolidIcon size={13} />,
      action: () => {
        setTemplateSettingsTarget(page)
        setContextMenu(null)
      },
    }]
  }

  function pageMenuItems(target: SiteExplorerContextTarget) {
    const page = pageForTarget(target)
    if (!page) return []

    return [
      ...(!page.template && !isHomePage(page) ? [{
        label: 'Set as homepage',
        icon: <GlobeSolidIcon size={13} />,
        action: () => {
          setPageAsHomepage(page.id)
          setContextMenu(null)
        },
      }] : []),
      {
        label: 'Open in new tab',
        icon: <ExternalLinkSolidIcon size={13} />,
        action: () => {
          window.open(pagePublicPath(page.slug), '_blank', 'noopener,noreferrer')
          setContextMenu(null)
        },
      },
      ...templateMenuItems(target),
    ]
  }

  function contextMenuItems(menu: ContextMenuState): ExplorerContextMenuItem[] {
    const selection = menu.selection
    if (selection && selection.itemIds.length > 1) {
      const wrappableIds = wrappableSelectionIds(selection)
      return wrappableIds.length > 0
        ? [{
          label: bulkWrapLabel(selection.sectionId, wrappableIds.length),
          icon: <FolderGlyphIcon size={13} />,
          action: () => handleWrapSelectionInFolder({ sectionId: selection.sectionId, itemIds: wrappableIds }),
        }]
        : []
    }

    const items = pageMenuItems(menu.target)
    if (!selection) return items

    const wrappableIds = wrappableSelectionIds(selection)
    if (wrappableIds.length === 0) return items

    return [
      ...items,
      {
        label: 'Wrap in folder',
        icon: <FolderGlyphIcon size={13} />,
        action: () => handleWrapSelectionInFolder({ sectionId: selection.sectionId, itemIds: wrappableIds }),
      },
    ]
  }

  function wrappableSelectionIds(selection: SiteExplorerMenuSelection) {
    if (selection.sectionId !== 'templates' && selection.sectionId !== 'components') return []
    return selection.itemIds
  }

  function handleCreateFolder(sectionId: SiteExplorerSectionId) {
    const folderId = createExplorerFolder(sectionId, 'New folder')
    setInlineRenameTarget({ kind: 'folder', sectionId, id: folderId, name: 'New folder' })
  }

  function openExplorerItem(
    model: SiteExplorerAnySectionModel,
    item: SiteExplorerTreeItem<SiteExplorerContextTarget>,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    const selectionOnly = explorerSelection.updateSelectionForItem(model, item, event)
    if (selectionOnly) return

    const target = item.target
    if (target.kind === 'page') {
      openPageInCanvas(target.id)
    } else if (target.kind === 'component') {
      setActiveDocument({ kind: 'visualComponent', vcId: target.id })
    } else if (target.kind === 'file') {
      openInEditor(target.id)
    }
  }

  function contextMenuForItem(
    model: SiteExplorerAnySectionModel,
    item: SiteExplorerTreeItem<SiteExplorerContextTarget>,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    const selection = explorerSelection.menuSelectionForItem(model, item)
    if (item.pinned) {
      explorerSelection.clearSelection()
    } else {
      explorerSelection.setSelectionForIds(model.sectionId, selection.itemIds)
    }
    openContextMenu(item.target, event, selection)
  }

  function renameExplorerItem(item: SiteExplorerTreeItem<SiteExplorerContextTarget>) {
    startInlineRename(item.target)
  }

  function keyboardContextMenuForItem(
    model: SiteExplorerAnySectionModel,
    item: SiteExplorerTreeItem<SiteExplorerContextTarget>,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    const selection = explorerSelection.menuSelectionForItem(model, item)
    if (item.pinned) {
      explorerSelection.clearSelection()
    } else {
      explorerSelection.setSelectionForIds(model.sectionId, selection.itemIds)
    }
    openKeyboardContextMenu(item.target, event, selection)
  }

  function renameExplorerFolderTarget(sectionId: SiteExplorerSectionId, folder: SiteExplorerTreeFolder) {
    startInlineRename(folderTarget(sectionId, folder))
  }

  const pageTreeModel = site
    ? buildStructuralExplorerTreeSection<SiteExplorerContextTarget>(
      'pages',
      site.explorer.pages,
      normalPages.map((page) => ({
        id: page.id,
        label: page.title,
        path: page.slug,
        meta: pagePublicPath(page.slug),
        icon: FileTextSolidIcon,
        active: page.id === activePageId && activeDocument?.kind !== 'visualComponent',
        pinned: isHomePage(page),
        ariaLabel: `Open page ${page.title}`,
        target: { kind: 'page', id: page.id, title: page.title, slug: page.slug },
      })),
    )
    : null
  const templateTreeModel = site
    ? buildSiteExplorerTreeSection<SiteExplorerContextTarget>(
      'templates',
      site.explorer.templates.folders,
      site.explorer.templates.items,
      templatePages.map((page) => ({
        id: page.id,
        label: page.title,
        meta: templateTargetLabel(page),
        icon: FileTextSolidIcon,
        active: page.id === activePageId && activeDocument?.kind !== 'visualComponent',
        ariaLabel: `Open template ${page.title}`,
        target: { kind: 'page', id: page.id, title: page.title, slug: page.slug },
      })),
    )
    : null
  const componentTreeModel = site
    ? buildSiteExplorerTreeSection<SiteExplorerContextTarget>(
      'components',
      site.explorer.components.folders,
      site.explorer.components.items,
      components.map((component) => ({
        id: component.id,
        label: component.name,
        meta: `${component.params.length} props`,
        icon: BracesIcon,
        active: activeDocument?.kind === 'visualComponent' && activeDocument.vcId === component.id,
        ariaLabel: `Open component ${component.name}`,
        target: { kind: 'component', id: component.id, name: component.name },
      })),
    )
    : null
  const styleTreeModel = site
    ? buildStructuralExplorerTreeSection<SiteExplorerContextTarget>(
      'styles',
      site.explorer.styles,
      fileBuckets.styles.map((file) => ({
        id: file.id,
        label: fileName(file.path),
        path: file.path,
        meta: file.path,
        icon: PaintBucketSolidIcon,
        active: activeEditorFileId === file.id,
        ariaLabel: `Open ${fileName(file.path)}`,
        target: { kind: 'file', id: file.id, path: file.path },
      })),
    )
    : null
  const scriptTreeModel = site
    ? buildStructuralExplorerTreeSection<SiteExplorerContextTarget>(
      'scripts',
      site.explorer.scripts,
      fileBuckets.scripts.map((file) => ({
        id: file.id,
        label: fileName(file.path),
        path: file.path,
        meta: file.path,
        icon: CodeIcon,
        active: activeEditorFileId === file.id,
        ariaLabel: `Open ${fileName(file.path)}`,
        target: { kind: 'file', id: file.id, path: file.path },
      })),
    )
    : null

  function renderPanel(explorerDnd: SiteExplorerDndState) {
    return (
      <div className={styles.panelBody} data-testid="site-explorer-panel">
        {!site ? (
          <SkeletonBlock minHeight={160} ariaLabel="Loading site" />
        ) : (
          <SiteExplorerPanelSections
            sectionGroup={sectionGroup}
            explorerDnd={explorerDnd}
            pageTreeModel={pageTreeModel}
            templateTreeModel={templateTreeModel}
            componentTreeModel={componentTreeModel}
            styleTreeModel={styleTreeModel}
            scriptTreeModel={scriptTreeModel}
            normalPageCount={normalPages.length}
            templatePageCount={templatePages.length}
            componentCount={components.length}
            styleCount={fileBuckets.styles.length}
            scriptCount={fileBuckets.scripts.length}
            inlineRenameTargetForSection={inlineRenameSectionTarget}
            selectedItemIdsForSection={(sectionId) => explorerSelection.selectedItemIdsForSection(sectionId)}
            onCreatePage={() => setCreateKind('page')}
            onCreateTemplate={handleCreateTemplate}
            onCreateComponent={() => setCreateKind('component')}
            onCreateStyle={() => setCreateKind('style')}
            onCreateScript={() => setCreateKind('script')}
            onCreateFolder={handleCreateFolder}
            onRenameItem={renameExplorerItem}
            onRenameFolder={renameExplorerFolderTarget}
            onCommitInlineRename={handleInlineRename}
            onCancelInlineRename={() => setInlineRenameTarget(null)}
            onOpenItem={openExplorerItem}
            onContextMenuItem={contextMenuForItem}
            onKeyDownItem={keyboardContextMenuForItem}
            onContextMenuFolder={(sectionId, folder, event) => openContextMenu(folderTarget(sectionId, folder), event)}
            onKeyDownFolder={(sectionId, folder, event) => openKeyboardContextMenu(folderTarget(sectionId, folder), event)}
          />
        )}
        {createKind && (
          <SiteCreateDialog
            kind={createKind}
            pages={pages}
            onCancel={() => setCreateKind(null)}
            onCreate={handleCreate}
          />
        )}
        {contextMenu && (
          <SiteExplorerContextMenu
            menu={contextMenu}
            pageCount={pages.length}
            extraItems={contextMenuItems(contextMenu)}
            onClose={() => setContextMenu(null)}
            onRename={() => startInlineRename(contextMenu.target)}
            onDelete={() => handleDeleteContext(contextMenu)}
          />
        )}
        {templateSettingsTarget && (
          <TemplateSettingsDialog
            page={templateSettingsTarget}
            pages={pages}
            onCancel={() => setTemplateSettingsTarget(null)}
            onSave={handleSaveTemplateSettings}
          />
        )}
        {pathConfirmPlan && (
          <SiteExplorerPathConfirmDialog
            plan={pathConfirmPlan}
            onCancel={() => setPathConfirmPlan(null)}
            onConfirm={handleConfirmPathChange}
          />
        )}
      </div>
    )
  }

  return (
    <SiteExplorerDndScope
      enabled={organizationDndEnabled}
      onStructuralPathPlan={setPathConfirmPlan}
    >
      {renderPanel}
    </SiteExplorerDndScope>
  )
}
