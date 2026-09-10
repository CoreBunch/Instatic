/** Projects shared and localized CRDT documents back into the visible editor site. */
import type { Page, SiteDocument, SiteShell } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { encodeCollabDocId, metaMap, parseCollabDocId, projectComponentDoc, projectLayoutDoc, projectLocalizationDoc, projectPageDoc, projectSiteDoc, type CollabDocSet } from '@core/collab'
import { projectSiteLocale } from '@core/localization'
import { pageToCells } from '@core/data/pageFromRow'
import { visualComponentToCells } from '@core/data/componentFromRow'
import { savedLayoutToCells } from '@core/data/layoutFromRow'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import { validateSite } from '@core/persistence/validate'
import type { EditorStoreApi } from '@site/store/types'
import { pruneCanvasSelectionDraft } from '../selectionSlice'

interface CollabProjectionContext {
  getStoreApi(): EditorStoreApi | null
  getDocs(): CollabDocSet
  onAligned(site: SiteDocument): void
  bindLocaleDocsForRow(site: SiteDocument, kind: 'page' | 'component' | 'layout', rowId: string): void
  bindDocThroughProvider(docId: string): void
}

export function createCollabProjector(context: CollabProjectionContext): (docId: string) => void {
  function rowFromDoc(docId: string): Page | VisualComponent | SavedLayout | null {
    const docs = context.getDocs()
    const parsed = parseCollabDocId(docId)
    if (!parsed || parsed.kind === 'site' || parsed.localeId) return null
    const doc = docs.get(docId)
    if (!doc) return null
    if (parsed.kind === 'page') {
      const page = projectPageDoc(doc, parsed.rowId)
      return page.rootNodeId ? page : null
    }
    if (parsed.kind === 'component') {
      const vc = projectComponentDoc(doc, parsed.rowId)
      return vc.tree.rootNodeId ? vc : null
    }
    const layout = projectLayoutDoc(doc, parsed.rowId)
    return layout.rootNodeId ? layout : null
  }

  function mergeSharedRowContext(site: SiteDocument, row: Page | VisualComponent | SavedLayout, kind: 'page' | 'component' | 'layout'): SiteDocument {
    const docs = context.getDocs()
    if (!site.localization) return site
    const tableId = kind === 'page' ? 'pages' : kind === 'component' ? 'components' : 'layouts'
    const cells = kind === 'page' ? { ...pageToCells(row as Page), templateEnabled: (row as Page).template?.enabled === true }
      : kind === 'component' ? visualComponentToCells(row as VisualComponent) : savedLayoutToCells(row as SavedLayout)
    const policy = site.localization.fieldLocalizations[tableId] ?? {}
    const sharedValues = Object.fromEntries(Object.entries(cells).filter(([key]) => key === 'body' || policy[key] !== 'localized'))
    const previous = site.localization.rows[row.id]
    const localizations = { ...previous?.localizations }
    // A row may arrive after its locale docs. Read those already-synced docs now.
    for (const locale of site.locales ?? []) {
      const id = encodeCollabDocId({ kind, rowId: row.id, localeId: locale.id })
      const doc = docs.get(id)
      if (doc && metaMap(doc).has('slug')) localizations[locale.id] = projectLocalizationDoc(doc)
    }
    return { ...site, localization: { ...site.localization, rows: {
      ...site.localization.rows,
      [row.id]: { tableId, sharedCells: { ...previous?.sharedCells, ...sharedValues }, localizations },
    } } }
  }

  function projectCurrentLocale(site: SiteDocument): SiteDocument {
    return site.localeId && site.localization ? projectSiteLocale(site, site.localeId) : site
  }

  function projectDocIntoStore(docId: string): void {
    const api = context.getStoreApi()
    const docs = context.getDocs()
    if (!api) return
    const state = api.getState()
    const site = state.site
    if (!site) return
    const parsed = parseCollabDocId(docId)
    if (!parsed) return

    if (parsed.localeId) {
      const doc = docs.get(docId)
      const localizationContext = site.localization
      const previous = localizationContext?.rows[parsed.rowId]
      if (!doc || !localizationContext || !previous || !metaMap(doc).has('slug')) return
      const localization = projectLocalizationDoc(doc)
      const nextSite = projectCurrentLocale({ ...site, localization: { ...localizationContext, rows: {
        ...localizationContext.rows,
        [parsed.rowId]: { ...previous, localizations: { ...previous.localizations, [parsed.localeId]: localization } },
      } } })
      context.onAligned(nextSite)
      api.setState((draft) => { draft.site = nextSite; pruneCanvasSelectionDraft(draft) })
      return
    }

    if (parsed.kind === 'site') {
      const doc = docs.get(docId)
      if (!doc) return
      const projected = projectSiteDoc(doc)
      if (Object.keys(projected.shell).length === 0) return
      // The projected shell is untyped wire data — validate it before it enters
      // the store, exactly like the HTTP load path (validateSite) and the relay's
      // persist path both do. `validateSite` is tolerant of individual malformed
      // entries (drops bad style rules / conditions / files rather than
      // rejecting the whole shell), so one corrupt rule from any source can't
      // crash a panel. `id`/`updatedAt` are non-collaborative — inject them like
      // the persist path. If the shell is not yet coherent (mid-sync), skip this
      // tick; the next projection re-runs once it is.
      let shell: SiteShell
      try {
        shell = validateSite({
          ...projected.shell,
          id: 'default',
          updatedAt:
            typeof projected.shell.updatedAt === 'number' ? projected.shell.updatedAt : Date.now(),
        })
      } catch (err) {
        console.warn('[collabBinding] projected shell failed validation — projection skipped:', err)
        return
      }
      let contextSite = site
      const byId = {
        pages: new Map(site.pages.map((p) => [p.id, p])),
        components: new Map(site.visualComponents.map((vc) => [vc.id, vc])),
        layouts: new Map(site.layouts.map((l) => [l.id, l])),
      }
      const assemble = <T extends { id: string }>(
        ids: readonly string[],
        existing: Map<string, T>,
        kind: 'page' | 'component' | 'layout',
      ): T[] => {
        const rows: T[] = []
        for (const id of ids) {
          const known = existing.get(id)
          if (known) {
            rows.push(known)
            continue
          }
          const rowDocId = encodeCollabDocId({ kind, rowId: id })
          const fresh = rowFromDoc(rowDocId)
          if (fresh) {
            contextSite = mergeSharedRowContext(contextSite, fresh, kind)
            context.bindLocaleDocsForRow(site, kind, id)
            rows.push(fresh as unknown as T)
            continue
          }
          // A peer created this row — its doc isn't bound here yet. Bind it;
          // the whenSynced hook re-projects the site once content arrives.
          context.bindDocThroughProvider(rowDocId)
        }
        return rows
      }
      const nextSite: SiteDocument = {
        ...site,
        ...shell,
        pages: assemble(projected.rosters.pages, byId.pages, 'page'),
        visualComponents: assemble(projected.rosters.components, byId.components, 'component'),
        layouts: assemble(projected.rosters.layouts, byId.layouts, 'layout'),
      }
      nextSite.localization = contextSite.localization
      if (projected.shell.conditions === undefined) delete nextSite.conditions
      const packageJson = clonePackageJson(nextSite.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(nextSite.runtime)
      const alignedSite = projectCurrentLocale({ ...nextSite, packageJson, runtime: siteRuntime })
      context.onAligned(alignedSite)
      api.setState((draft) => {
        draft.site = alignedSite
        draft.packageJson = packageJson
        draft.siteRuntime = siteRuntime
        if (!nextSite.pages.some((p) => p.id === draft.activePageId)) {
          draft.activePageId = nextSite.pages[0]?.id ?? null
        }
        // A roster change can drop the whole document the selection lives in (a
        // peer deleted the page, or an undo removed it). Prune AFTER site +
        // activePageId land, since the pruner resolves the active tree from them.
        pruneCanvasSelectionDraft(draft)
      })
      return
    }

    const row = rowFromDoc(docId)
    const collection =
      parsed.kind === 'page' ? 'pages' : parsed.kind === 'component' ? 'visualComponents' : 'layouts'
    const rows = site[collection] as Array<{ id: string }>
    const index = rows.findIndex((r) => r.id === parsed.rowId)
    if (!row) {
      if (index === -1) return
      const nextRows = rows.filter((r) => r.id !== parsed.rowId)
      const nextSite = { ...site, [collection]: nextRows } as SiteDocument
      context.onAligned(nextSite)
      api.setState((draft) => {
        draft.site = nextSite
        pruneCanvasSelectionDraft(draft)
      })
      return
    }
    const nextRows = index === -1 ? [...rows, row] : rows.map((r, i) => (i === index ? row : r))
    const nextSite = projectCurrentLocale(mergeSharedRowContext({ ...site, [collection]: nextRows } as SiteDocument, row, parsed.kind))
    context.bindLocaleDocsForRow(nextSite, parsed.kind, parsed.rowId)
    context.onAligned(nextSite)
    api.setState((draft) => {
      draft.site = nextSite
      // The freshly projected row may have lost nodes — a peer deleted them, or a
      // Y.UndoManager undo reverted their creation. Prune by tree-membership, the
      // same way a local delete does: survivors keep their selection, dead ids
      // (including descendants swept with a subtree) drop out, and an inline-edit
      // session on a vanished node is closed. `pruneCanvasSelectionDraft` reads
      // the ACTIVE tree, so it self-limits to the doc the user is looking at.
      pruneCanvasSelectionDraft(draft)
    })
  }
  return projectDocIntoStore
}
