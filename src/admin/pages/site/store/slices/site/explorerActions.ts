import {
  buildDeleteExplorerPathPlan,
  buildMoveExplorerFolderPlan,
  buildMoveExplorerItemPlan,
  buildRenameExplorerFolderPlan,
  commitExplorerPathPlan as commitExplorerPathPlanToSite,
  createExplorerFolder as createExplorerFolderInOrganization,
  createUniquePageSlug,
  deleteExplorerFolder as deleteExplorerFolderInOrganization,
  findHomePage,
  moveExplorerFolder as moveExplorerFolderInOrganization,
  moveExplorerItem as moveExplorerItemInOrganization,
  moveExplorerItems as moveExplorerItemsInOrganization,
  reconcileSiteExplorerInPlace,
  renameExplorerFolder as renameExplorerFolderInOrganization,
  renamePage as renamePageInSite,
  wrapExplorerItemsInFolder as wrapExplorerItemsInFolderInOrganization,
  sameStructuralParent,
  compareStructuralRows,
  structuralRowsForSection,
} from '@core/page-tree'
import type {
  SiteDocument,
  SiteExplorerSectionId,
  StructuralSiteExplorerSectionId,
} from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

type ExplorerActions = Pick<
  SiteSlice,
  | 'createExplorerFolder'
  | 'renameExplorerFolder'
  | 'deleteExplorerFolder'
  | 'moveExplorerFolder'
  | 'moveExplorerItem'
  | 'moveExplorerItems'
  | 'wrapExplorerItemsInFolder'
  | 'previewRenameExplorerFolder'
  | 'previewMoveExplorerFolder'
  | 'previewMoveExplorerItem'
  | 'previewDeleteExplorerFolder'
  | 'commitExplorerPathChange'
  | 'toggleStructuralExplorerFolder'
  | 'moveStructuralExplorerRow'
  | 'setPageAsHomepage'
>

export function createExplorerActions({
  get,
  mutateSite,
  mutateSiteState,
}: SiteSliceHelpers): ExplorerActions {
  return {
    createExplorerFolder: (sectionId, name, parentPath) => {
      if (isStructuralSection(sectionId)) {
        let folderPath = ''
        mutateSite((site) => {
          reconcileSiteExplorerInPlace(site)
          folderPath = uniqueStructuralFolderPath(site, sectionId, name, parentPath)
          site.explorer[sectionId].emptyFolders.push(folderPath)
          return true
        })
        return folderPath
      }

      let folderId = ''
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        folderId = createExplorerFolderInOrganization(site.explorer, sectionId, name)
        return true
      })
      return folderId
    },

    renameExplorerFolder: (sectionId, folderId, name) => {
      mutateSite((site) => {
        const folder = site.explorer[sectionId].folders.find((candidate) => candidate.id === folderId)
        if (!folder) return false
        const nextName = name.trim() || 'Folder'
        if (folder.name === nextName) return false
        renameExplorerFolderInOrganization(site.explorer, sectionId, folderId, nextName)
        return true
      })
    },

    deleteExplorerFolder: (sectionId, folderId) => {
      mutateSite((site) => {
        if (!site.explorer[sectionId].folders.some((folder) => folder.id === folderId)) return false
        deleteExplorerFolderInOrganization(site.explorer, sectionId, folderId)
        return true
      })
    },

    moveExplorerFolder: (sectionId, folderId, nextIndex) => {
      mutateSite((site) => {
        const folders = site.explorer[sectionId].folders
        const currentIndex = folders.findIndex((folder) => folder.id === folderId)
        if (currentIndex === -1) return false
        moveExplorerFolderInOrganization(site.explorer, sectionId, folderId, nextIndex)
        return true
      })
    },

    moveExplorerItem: (sectionId, itemId, parentFolderId, nextIndex) => {
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        const item = site.explorer[sectionId].items.find((candidate) => candidate.id === itemId)
        if (!item) return false
        moveExplorerItemInOrganization(site.explorer, sectionId, itemId, parentFolderId, nextIndex)
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    moveExplorerItems: (sectionId, itemIds, parentFolderId, nextIndex) => {
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        moveExplorerItemsInOrganization(site.explorer, sectionId, itemIds, parentFolderId, nextIndex)
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    wrapExplorerItemsInFolder: (sectionId, itemIds, name) => {
      let folderId: string | null = null
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        folderId = wrapExplorerItemsInFolderInOrganization(site.explorer, sectionId, itemIds, name)
        if (!folderId) return false
        reconcileSiteExplorerInPlace(site)
        return true
      })
      return folderId
    },

    previewRenameExplorerFolder: (sectionId, folderPath, nextFolderPath) =>
      buildRenameExplorerFolderPlan(requireSite(get().site), { sectionId, folderPath, nextFolderPath }),

    previewMoveExplorerFolder: (sectionId, folderPath, nextParentPath) =>
      buildMoveExplorerFolderPlan(requireSite(get().site), { sectionId, folderPath, nextParentPath }),

    previewMoveExplorerItem: (sectionId, itemId, nextParentPath) =>
      buildMoveExplorerItemPlan(requireSite(get().site), { sectionId, itemId, nextParentPath }),

    previewDeleteExplorerFolder: (sectionId, folderPath) =>
      buildDeleteExplorerPathPlan(requireSite(get().site), { sectionId, folderPath }),

    commitExplorerPathChange: (plan) => {
      mutateSiteState((state, site) => {
        commitExplorerPathPlanToSite(site, state.siteRuntime, plan)
        reconcileSiteExplorerInPlace(site)
        if (plan.kind === 'delete') {
          const deletedIds = new Set(plan.deletedItems.map((item) => item.id))
          if (plan.sectionId === 'pages' && state.activePageId && deletedIds.has(state.activePageId)) {
            state.activePageId = site.pages[0]?.id ?? null
            state.activeDocument = null
          }
          if (
            (plan.sectionId === 'styles' || plan.sectionId === 'scripts')
            && state.activeEditorFileId
            && deletedIds.has(state.activeEditorFileId)
          ) {
            state.activeEditorFileId = null
          }
        }
        return true
      })
    },

    toggleStructuralExplorerFolder: (sectionId, folderPath) => {
      mutateSite((site) => {
        const path = normalizeStructuralPath(folderPath)
        if (!path) return false
        const expanded = site.explorer[sectionId].expandedFolders
        const index = expanded.indexOf(path)
        if (index === -1) {
          expanded.push(path)
        } else {
          expanded.splice(index, 1)
        }
        return true
      })
    },

    moveStructuralExplorerRow: (sectionId, row, nextIndex) => {
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        const siblings = structuralRowsForSection(site, sectionId)
          .filter((entry) => sameStructuralParent(entry.parentPath, row.parentPath))
          .sort(compareStructuralRows)
        const currentIndex = siblings.findIndex((entry) => entry.kind === row.kind && entry.id === row.id)
        if (currentIndex === -1) return false
        const [target] = siblings.splice(currentIndex, 1)
        if (!target) return false
        siblings.splice(clampIndex(nextIndex, siblings.length), 0, target)
        const parentPath = row.parentPath
        site.explorer[sectionId].rowOrder = [
          ...site.explorer[sectionId].rowOrder.filter((entry) => !sameStructuralParent(entry.parentPath, parentPath)),
          ...siblings.map((entry, order) => ({
            kind: entry.kind,
            id: entry.id,
            ...(parentPath ? { parentPath } : {}),
            order,
          })),
        ]
        return true
      })
    },

    setPageAsHomepage: (pageId) => {
      mutateSite((site) => {
        const target = site.pages.find((page) => page.id === pageId)
        if (!target) return false
        const currentHome = findHomePage(site.pages)
        if (currentHome?.id === target.id) return false

        if (currentHome) {
          const slugSource = site.pages.filter((page) => page.id !== currentHome.id && page.id !== target.id)
          currentHome.slug = createUniquePageSlug(currentHome.title, slugSource)
        }
        renamePageInSite(site, target.id, target.title, 'index')
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },
  }
}

function requireSite(site: SiteDocument | null): SiteDocument {
  if (!site) throw new Error('[SiteExplorer] Site document is not initialized')
  return site
}

function isStructuralSection(sectionId: SiteExplorerSectionId): sectionId is StructuralSiteExplorerSectionId {
  return sectionId === 'pages' || sectionId === 'styles' || sectionId === 'scripts'
}

function uniqueStructuralFolderPath(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  name: string,
  parentPath: string | undefined,
): string {
  const base = structuralFolderPath(sectionId, name, parentPath)
  let candidate = base
  let suffix = 2
  while (structuralPathInUse(site, sectionId, candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function structuralFolderPath(
  sectionId: StructuralSiteExplorerSectionId,
  name: string,
  parentPath: string | undefined,
): string {
  const segment = name
    .trim()
    .toLowerCase()
    .replace(sectionId === 'pages' ? /[^a-z0-9-]+/g : /[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-folder'
  const parent = parentPath ? normalizeStructuralPath(parentPath) : ''
  return parent ? `${parent}/${segment}` : segment
}

function structuralPathInUse(
  site: SiteDocument,
  sectionId: StructuralSiteExplorerSectionId,
  path: string,
): boolean {
  const section = site.explorer[sectionId]
  if (
    section.emptyFolders.includes(path)
    || section.expandedFolders.includes(path)
    || section.rowOrder.some((entry) => entry.kind === 'folder' && entry.id === path)
  ) {
    return true
  }

  if (sectionId === 'pages') {
    return site.pages.some((page) =>
      !page.template
      && page.slug !== 'index'
      && (page.slug === path || page.slug.startsWith(`${path}/`))
    )
  }

  const type = sectionId === 'styles' ? 'style' : 'script'
  return site.files.some((file) =>
    file.type === type
    && (!file.generated || file.ejected)
    && (file.path === path || file.path.startsWith(`${path}/`))
  )
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(index, max))
}

function normalizeStructuralPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, '')
}
