/**
 * Page mutation actions: addPage, deletePage, renamePage, duplicatePage,
 * reorderPages, convertPageToTemplate, convertTemplateToPage.
 */

import {
  type Page,
  addPage,
  deletePage,
  renamePage,
  reorderPages,
  duplicatePage,
  reconcileSiteExplorerInPlace,
} from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'
import { clearCanvasSelectionDraft } from '../selectionSlice'

type PageActions = Pick<
  SiteSlice,
  | 'addPage'
  | 'deletePage'
  | 'renamePage'
  | 'duplicatePage'
  | 'reorderPages'
  | 'convertPageToTemplate'
  | 'convertTemplateToPage'
  | 'setPageAccess'
>

export function createPageActions({
  get,
  set,
  mutateSite,
}: SiteSliceHelpers): PageActions {
  return {
    addPage: (title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = addPage(p, title, slug ?? title)
        reconcileSiteExplorerInPlace(p)
        return true
      })
      set((state) => {
        state.activePageId = newPage.id
        clearCanvasSelectionDraft(state)
      })
      return newPage
    },

    deletePage: (pageId) => {
      const deleted = mutateSite((p) => {
        if (!p.pages.some((page) => page.id === pageId)) return false
        deletePage(p, pageId)
        reconcileSiteExplorerInPlace(p)
        return true
      })
      const { site, activePageId } = get()
      if (deleted && activePageId === pageId && site) {
        set((state) => { state.activePageId = site.pages[0]?.id ?? null })
      }
    },

    renamePage: (pageId, title, slug) => {
      mutateSite((p) => {
        const page = p.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        renamePage(p, pageId, title, slug)
        return true
      })
    },

    duplicatePage: (sourcePageId, title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = duplicatePage(p, sourcePageId, title, slug)
        reconcileSiteExplorerInPlace(p)
        return true
      })
      return newPage
    },

    reorderPages: (fromIndex, toIndex) => {
      mutateSite((p) => {
        if (fromIndex === toIndex) return false
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= p.pages.length ||
          toIndex >= p.pages.length
        ) {
          return false
        }
        reorderPages(p, fromIndex, toIndex)
        return true
      })
    },

    convertPageToTemplate: (pageId, config) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        page.template = config
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    convertTemplateToPage: (pageId) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        const hadTemplate = page.template !== undefined
        const hadDynamicBindings = Object.values(page.nodes).some(
          (node) => node.dynamicBindings !== undefined,
        )
        if (!hadTemplate && !hadDynamicBindings) return false
        delete page.template
        for (const node of Object.values(page.nodes)) {
          delete node.dynamicBindings
        }
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    setPageAccess: (pageId, access) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return false
        // Mirror parsePageAccess: a public level (or an empty groups list) is
        // stored as the ABSENCE of the field so published snapshots stay lean
        // and parse back as public. A groups level with at least one id
        // persists the restriction.
        const groups = access.groups ?? []
        if (access.level === 'public' || groups.length === 0) {
          if (page.access === undefined) return false
          delete page.access
        } else {
          page.access = { level: 'groups', groups }
        }
        return true
      })
    },
  }
}
